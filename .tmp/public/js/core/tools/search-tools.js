/**
 * Codebase search.
 *
 * Literal, case-insensitive substring search — no regex. That is a decision,
 * not a shortcut: weak models write broken regexes constantly, then read the
 * empty result as "the code does not exist" and start inventing. A literal
 * search either finds the string or it does not, and the failure is legible.
 *
 * ── Por qué se ordenan los resultados ────────────────────────────────────
 *
 * Los primeros treinta resultados eran los treinta primeros *por orden
 * alfabético de archivo*, porque el recorrido paraba en cuanto llenaba el
 * cupo. Buscar `parsePlan` en un proyecto grande devolvía sus importaciones y
 * sus llamadas y no la definición, que estaba en un archivo que empezaba por
 * "p" y nunca llegaba a leerse. El modelo concluía que la función no existía y
 * se la inventaba: exactamente el fallo que esta herramienta debía evitar.
 *
 * Así que ahora se recogen candidatos de todo el proyecto (con un tope) y se
 * ordenan antes de recortar. Las definiciones van primero, y se marcan, porque
 * "dónde se define esto" es la pregunta que se hace casi siempre.
 */

import { walkFiles, matchesGlob } from '../walk.js';
import { makeThrottle, toolProgress } from '../util.js';
import { MAX_TEXT_BYTES, languageOf } from '../ignore.js';
import { extractSymbols, rankFile } from '../repo-map.js';
import * as P from '../../platform/paths.js';

/**
 * Cuántas coincidencias se recogen antes de ordenar.
 *
 * No es el número que se devuelve, es el número sobre el que se elige. Con el
 * tope en `max_results` el orden no podía arreglar nada, porque los buenos
 * resultados ni se habían leído. Con un cupo amplio se ordena sobre una
 * muestra que sí contiene lo que importa, y sigue estando acotado: un término
 * muy común no recorre el proyecto entero.
 */
const CANDIDATE_BUDGET = 400;

/** Coincidencias por archivo antes de resumir el resto. */
const PER_FILE_HITS = 6;

/** Declaraciones que se siguen buscando después de agotar el cupo. */
const MAX_LATE_DEFS = 20;

/** `parsePlan` sí, `const x = 1` no: sólo un identificador suelto. */
function looksLikeSymbol(query) {
    return /^[A-Za-z_$][\w$]{1,}$/.test(query);
}

/**
 * Las líneas de este archivo que DECLARAN algo relacionado con la búsqueda.
 *
 * Devuelve `line -> 'exact' | 'partial'`. Exacto es el nombre entero: buscando
 * `plan`, `function plan()` es exacto y `function planToText()` es parcial.
 * Los dos suben en el orden, pero no lo mismo — si existe la declaración
 * exacta, es casi siempre la respuesta.
 */
function symbolLines(text, rel, needle) {
    const lang = languageOf(rel);
    if (!lang) return null;

    const out = new Map();
    // Sin tope: la declaración puede estar en la línea 900 de un archivo largo,
    // y no encontrarla ahí es justo el caso que esta función existe para cubrir.
    for (const s of extractSymbols(text, lang, { limit: 2000 })) {
        const name = s.name.toLowerCase();
        if (name === needle) out.set(s.line, 'exact');
        else if (name.includes(needle)) out.set(s.line, 'partial');
    }
    return out.size ? out : null;
}

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
                detail: 'No hay ningún archivo que encaje con el filtro. Prueba sin "glob" o usa list_directory para ver la estructura.',
                data: { matches: [] }
            };
        }

        const needle = query.toLowerCase();
        const limit = args.max_results || 30;
        const symbolish = looksLikeSymbol(query);
        const candidates = [];
        const extraByFile = new Map();
        let scanned = 0;
        let filesWithHits = 0;
        let budgetHit = false;
        let defsFound = 0;
        /** Archivos demasiado grandes para leerlos. No se pueden dar por vistos. */
        let saltados = 0;

        // A search over a few thousand files is seconds of silence otherwise,
        // and this one has a real denominator, so it gets a real percentage.
        const tick = makeThrottle(120);
        const started = Date.now();
        const scan = toolProgress(ctx)(`Buscando "${query}"…`, { current: 0, total: pool.length });

        let index = 0;
        for (const f of pool) {
            if (ctx.signal?.aborted) break;

            // Alcanzado el cupo se deja de recoger usos, pero NO se deja de
            // buscar declaraciones. Cortar aquí del todo era el mismo fallo de
            // antes movido de 30 a 400: con ochenta archivos que mencionan el
            // símbolo, el que lo declara puede caer detrás del corte y volvemos
            // a apuntar al primero por alfabeto. Una declaración es cara de
            // encontrar y barata de guardar; un uso más, al revés.
            if (candidates.length >= CANDIDATE_BUDGET) {
                budgetHit = true;
                if (!symbolish || defsFound >= MAX_LATE_DEFS) break;
            }

            index++;
            tick(() => scan.update(`Buscando "${query}"… ${candidates.length} coincidencias`, {
                current: index, total: pool.length, detail: f.rel
            }));

            const stat = await ctx.platform.fs.stat(f.path);
            if (!stat) continue;
            if (stat.size > MAX_TEXT_BYTES) { saltados++; continue; }

            let text;
            try { text = await ctx.platform.fs.readText(f.path); } catch { continue; }
            scanned++;
            if (!text.toLowerCase().includes(needle)) continue;

            filesWithHits++;

            // Which lines of this file DECLARE something, and what. Only worth
            // computing for a file that already matched, and only when the
            // query could name a symbol at all.
            const defs = symbolish ? symbolLines(text, f.rel, needle) : null;
            const fileScore = rankFile(f);

            // Pasado el cupo sólo interesan las declaraciones.
            if (budgetHit && !defs) continue;

            const lines = text.split(/\r\n|\r|\n/);
            let hitsHere = 0;
            for (let i = 0; i < lines.length; i++) {
                if (!lines[i].toLowerCase().includes(needle)) continue;
                const def = defs ? defs.get(i + 1) : undefined;
                if (budgetHit && !def) continue;
                // Sólo cuenta lo hallado DESPUÉS del cupo: si no, veinte
                // coincidencias parciales previas agotaban el margen y el
                // escaneo tardío no llegaba a mirar ni un archivo.
                if (def && budgetHit) defsFound++;
                if (++hitsHere > PER_FILE_HITS && !def) {
                    extraByFile.set(f.rel, (extraByFile.get(f.rel) || 0) + 1);
                    continue;
                }
                candidates.push({
                    rel: f.rel,
                    line: i + 1,
                    text: lines[i].trim().slice(0, 200),
                    // One line either side. Very often this is enough to decide
                    // whether the hit matters, which saves a whole read_file
                    // round trip — the scarcest thing on a small context.
                    before: i > 0 ? lines[i - 1].trim().slice(0, 120) : '',
                    after: i + 1 < lines.length ? lines[i + 1].trim().slice(0, 120) : '',
                    definition: !!def,
                    exactDefinition: def === 'exact',
                    score: fileScore
                        + (def === 'exact' ? 1000 : def ? 400 : 0)
                });
            }
        }

        // Best first, and stable within a file so a group still reads top to
        // bottom. The cut to `limit` happens AFTER this, which is the whole
        // point: what gets dropped is now the least relevant, not the last
        // alphabetically.
        candidates.sort((a, b) => (b.score - a.score) || a.rel.localeCompare(b.rel) || (a.line - b.line));
        const matches = candidates.slice(0, limit);

        // Lo que se queda fuera por el recorte, contado por archivo.
        //
        // Sin esto el resumen anunciaba coincidencias en diez archivos, el
        // detalle mostraba dos, y no había ninguna nota: el modelo leía que ya
        // había visto todas las apariciones y daba el archivo por revisado.
        // Una cuenta que no cuadra con lo que se muestra es peor que no darla.
        const cortadosPorArchivo = new Map();
        for (const c of candidates.slice(limit)) {
            cortadosPorArchivo.set(c.rel, (cortadosPorArchivo.get(c.rel) || 0) + 1);
        }
        const recortados = candidates.length - matches.length;

        scan.done(`Búsqueda terminada en ${Math.round((Date.now() - started) / 100) / 10}s: ${matches.length} coincidencias en ${scanned} archivos`);

        if (!matches.length) {
            return {
                ok: true,
                summary: `Sin coincidencias para "${query}".`,
                detail:
                    `Buscado en ${scanned} archivos${args.glob ? ` (filtro ${args.glob})` : ''} y no aparece "${query}".\n` +
                    // La frase categórica es el producto de esta herramienta y
                    // sólo vale si de verdad se ha mirado todo. Con archivos sin
                    // abrir por su tamaño, afirmarla es afirmar de más — y el
                    // modelo, al leer "no existe", se pone a inventar.
                    (saltados
                        ? `OJO: ${saltados} archivo(s) eran demasiado grandes para leerlos, así que esto NO ` +
                          'descarta que el texto esté ahí. Búscalo con un glob que los incluya, o mira su esquema con outline_file.'
                        : 'Ese texto NO existe en el proyecto: no asumas que sí. Prueba con una parte más corta ' +
                          'o mira la estructura con get_project_structure.'),
                data: { matches: [] }
            };
        }

        // Groups keep the ranked order: the file holding the definition leads.
        const grouped = new Map();
        for (const m of matches) {
            if (!grouped.has(m.rel)) grouped.set(m.rel, []);
            grouped.get(m.rel).push(m);
        }

        const detail = [...grouped.entries()]
            .map(([rel, hits]) => {
                const rows = [...hits]
                    .sort((a, b) => a.line - b.line)
                    .map(h => {
                        const out = [];
                        if (h.before) out.push(`    ${String(h.line - 1).padStart(5)}  ${h.before}`);
                        // The arrow says "this is your line"; the tag says "and
                        // this is the one that declares it", which is the answer
                        // to the question actually being asked most of the time.
                        out.push(`  → ${String(h.line).padStart(5)}  ${h.text}${h.definition ? '     ← DEFINICIÓN' : ''}`);
                        if (h.after) out.push(`    ${String(h.line + 1).padStart(5)}  ${h.after}`);
                        return out.join('\n');
                    });
                const extra = (extraByFile.get(rel) || 0) + (cortadosPorArchivo.get(rel) || 0);
                if (extra) rows.push(`    … y ${extra} coincidencia(s) más en este archivo`);
                return `${rel}\n${rows.join('\n')}`;
            })
            .join('\n\n');

        // Point at the definition when there is one: it is where the model
        // should read, and saying so saves it choosing wrong.
        const best = matches.find(m => m.exactDefinition) || matches.find(m => m.definition) || matches[0];
        const nav = `\n\nPara ver ${best.definition ? 'la definición' : 'una coincidencia'} en su contexto: ` +
            `read_file(path="${best.rel}", around_line=${best.line}).`;

        const notas = [];
        if (truncated) notas.push('[el proyecto es grande; la búsqueda se limitó a los primeros 4000 archivos]');
        if (recortados > 0) {
            const archivosOcultos = cortadosPorArchivo.size;
            notas.push(
                `[se muestran ${matches.length} de ${candidates.length} coincidencias` +
                (archivosOcultos ? `; hay ${recortados} más en ${archivosOcultos} archivo(s)` : '') +
                '. Sube max_results o acota la búsqueda si necesitas verlas.]'
            );
        }
        if (budgetHit) {
            notas.push(
                `[hay más de ${CANDIDATE_BUDGET} coincidencias de "${query}"; se muestran las ${matches.length} más relevantes. ` +
                'Si buscabas algo concreto, usa un texto más largo o filtra con glob.]'
            );
        }

        const defs = matches.filter(m => m.definition).length;
        const resumidas = [...extraByFile.values()].reduce((a, b) => a + b, 0);
        const totalVistas = candidates.length + resumidas;

        // Los archivos que de verdad se enseñan, no los que llegaron a tener
        // una coincidencia: eso último anunciaba diez y mostraba dos.
        const archivosMostrados = grouped.size;

        return {
            ok: true,
            summary: `${matches.length} coincidencias de "${query}" en ${archivosMostrados} archivo(s)` +
                (defs ? ` (${defs} ${defs > 1 ? 'definiciones' : 'definición'})` : '') +
                // `totalVistas` y no `candidates.length`: los candidatos no
                // incluyen lo que se resumió por PER_FILE_HITS, así que la cifra
                // de "encontradas" salía por debajo de las que el propio detalle
                // anunciaba archivo por archivo.
                (recortados > 0 ? `, de ${totalVistas} encontradas en ${filesWithHits} archivo(s)` : ''),
            detail: detail + nav + (notas.length ? `\n\n${notas.join('\n')}` : ''),
            data: { matches: matches.map(m => ({ ...m, path: P.join(root, m.rel) })) }
        };
    }
};
