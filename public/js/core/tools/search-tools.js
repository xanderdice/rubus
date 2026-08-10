/**
 * Codebase search.
 *
 * Literal, case-insensitive substring search — no regex. That is a decision,
 * not a shortcut: weak models write broken regexes constantly, then read the
 * empty result as "the code does not exist" and start inventing. A literal
 * search either finds the string or it does not, and the failure is legible.
 */

import { walkFiles, matchesGlob } from '../walk.js';
import { makeThrottle, toolProgress } from '../util.js';
import { EV } from '../bus.js';
import { MAX_TEXT_BYTES } from '../ignore.js';
import * as P from '../../platform/paths.js';

export const searchCodebase = {
    name: 'search_codebase',
    title: 'Buscar en el código',
    description: 'Busca un texto literal en todos los archivos del proyecto y devuelve archivo, línea y contexto. No admite expresiones regulares.',
    readOnly: true,
    mutates: false,
    params: {
        query: { type: 'string', required: true, description: 'Texto literal a buscar. Sin comodines ni regex.' },
        glob: { type: 'string', required: false, description: 'Filtro opcional de archivos, por ejemplo "*.js" o "src/**".' },
        max_results: { type: 'integer', required: false, default: 30, min: 1, max: 100, description: 'Número máximo de coincidencias.' }
    },
    examples: [{ args: { query: 'function initApp', glob: '*.js' } }],

    async run(args, ctx) {
        const query = String(args.query || '').trim();
        if (query.length < 2) return { ok: false, summary: 'La búsqueda necesita al menos 2 caracteres.' };

        const root = ctx.root;
        const walkTick = makeThrottle(150);
        const walk = toolProgress(ctx)('Listando archivos…', { indeterminate: true });
        const { files, truncated } = await walkFiles(ctx.platform, root, {
            maxFiles: 4000,
            signal: ctx.signal,
            onProgress: (p) => walkTick(() => walk.update(`Listando archivos… ${p.files}`, {
                indeterminate: true, detail: p.current
            }))
        });
        walk.done();
        const pool = files.filter(f => matchesGlob(f.rel, args.glob));

        if (!pool.length) {
            return {
                ok: true,
                summary: `Sin archivos que coincidan con "${args.glob || '*'}".`,
                detail: `No hay ningún archivo que encaje con el filtro. Prueba sin "glob" o usa list_directory para ver la estructura.`,
                data: { matches: [] }
            };
        }

        const needle = query.toLowerCase();
        const limit = args.max_results || 30;
        const matches = [];
        let scanned = 0;
        let filesWithHits = 0;

        // A search over a few thousand files is seconds of silence otherwise,
        // and this one has a real denominator, so it gets a real percentage.
        const tick = makeThrottle(120);
        const started = Date.now();
        const scan = toolProgress(ctx)(`Buscando "${query}"…`, { current: 0, total: pool.length });

        let index = 0;
        for (const f of pool) {
            if (ctx.signal?.aborted) break;
            if (matches.length >= limit) break;

            index++;
            tick(() => scan.update(`Buscando "${query}"… ${matches.length} coincidencias`, {
                current: index, total: pool.length, detail: f.rel
            }));

            const stat = await ctx.platform.fs.stat(f.path);
            if (!stat || stat.size > MAX_TEXT_BYTES) continue;

            let text;
            try { text = await ctx.platform.fs.readText(f.path); } catch { continue; }
            scanned++;
            if (!text.toLowerCase().includes(needle)) continue;

            filesWithHits++;
            const lines = text.split(/\r\n|\r|\n/);
            let hitsHere = 0;
            for (let i = 0; i < lines.length && matches.length < limit; i++) {
                if (!lines[i].toLowerCase().includes(needle)) continue;
                // Cap per file so one generated bundle cannot eat the budget.
                if (++hitsHere > 6) { matches.push({ rel: f.rel, line: 0, text: `… más coincidencias en este archivo` }); break; }
                matches.push({
                    rel: f.rel,
                    line: i + 1,
                    text: lines[i].trim().slice(0, 200),
                    // One line either side. Very often this is enough to decide
                    // whether the hit matters, which saves a whole read_file
                    // round trip — the scarcest thing on a small context.
                    before: i > 0 ? lines[i - 1].trim().slice(0, 120) : '',
                    after: i + 1 < lines.length ? lines[i + 1].trim().slice(0, 120) : ''
                });
            }
        }

        scan.done(`Búsqueda terminada en ${Math.round((Date.now() - started) / 100) / 10}s: ${matches.length} coincidencias en ${scanned} archivos`);

        if (!matches.length) {
            return {
                ok: true,
                summary: `Sin coincidencias para "${query}".`,
                detail:
                    `Buscado en ${scanned} archivos${args.glob ? ` (filtro ${args.glob})` : ''} y no aparece "${query}".\n` +
                    `Ese texto NO existe en el proyecto: no asumas que sí. Prueba con una parte más corta ` +
                    `o mira la estructura con get_project_structure.`,
                data: { matches: [] }
            };
        }

        const grouped = new Map();
        for (const m of matches) {
            if (!grouped.has(m.rel)) grouped.set(m.rel, []);
            grouped.get(m.rel).push(m);
        }

        const detail = [...grouped.entries()]
            .map(([rel, hits]) => {
                const rows = hits.map(h => {
                    if (!h.line) return `    ${h.text}`;
                    const out = [];
                    if (h.before) out.push(`    ${String(h.line - 1).padStart(5)}  ${h.before}`);
                    out.push(`  → ${String(h.line).padStart(5)}  ${h.text}`);
                    if (h.after) out.push(`    ${String(h.line + 1).padStart(5)}  ${h.after}`);
                    return out.join('\n');
                });
                return `${rel}\n${rows.join('\n')}`;
            })
            .join('\n\n');

        const first = matches.find(m => m.line);
        const nav = first
            ? `\n\nPara ver una coincidencia en su contexto: read_file(path="${first.rel}", around_line=${first.line}).`
            : '';

        return {
            ok: true,
            summary: `${matches.length} coincidencias de "${query}" en ${filesWithHits} archivos`,
            detail: detail + nav + (truncated ? '\n\n[el proyecto es grande; la búsqueda se limitó a los primeros 4000 archivos]' : ''),
            data: { matches: matches.map(m => ({ ...m, path: P.join(root, m.rel) })) }
        };
    }
};
