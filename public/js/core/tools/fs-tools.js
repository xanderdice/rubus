/**
 * Filesystem tools.
 *
 * The guards in `write_file` are the important part of this file. Weak models
 * have two signature failure modes when asked to produce a whole file:
 *
 *   1. They wrap the content in a ```markdown fence.
 *   2. They emit an abbreviated version — the interesting part, plus
 *      `// ... rest of the code unchanged ...` where the other 300 lines were.
 *
 * (1) is silently repaired. (2) is refused outright, because writing it
 * destroys the file and the model has no way to notice: from its point of view
 * the write succeeded. Refusing with a pointed error ("use edit_file") is the
 * only thing that reliably breaks the loop.
 */

import * as P from '../../platform/paths.js';
import { isBinaryPath, looksBinary, isIgnoredDir, MAX_TEXT_BYTES, languageOf } from '../ignore.js';
import { extractSignatures } from '../repo-map.js';
import { summarizeForModel } from '../diff.js';
import { truncate, toolProgress } from '../util.js';

/** `// ... rest of file ...` and its many dialects. */
const ELISION_PATTERNS = [
    /^\s*(?:\/\/|#|--|\/\*|\*)\s*\.{2,}\s*(?:rest|resto|remainder|the rest|el resto)\b/im,
    /^\s*(?:\/\/|#|--|\/\*|\*)\s*(?:rest of|resto del?|remainder of)\b[^\n]{0,60}(?:code|file|archivo|código|unchanged|sin cambios)/im,
    /^\s*(?:\/\/|#|--|\/\*|\*)\s*\.{3}\s*(?:existing|previous|unchanged|igual|same)\b/im,
    /^\s*(?:\/\/|#|--)\s*\[?\s*(?:unchanged|sin cambios|no changes|omitted|omitido)\s*\]?\s*$/im,
    /^\s*\.{3}\s*$/m,
    /<\s*\.\.\.\s*>/,
    /^\s*(?:\/\/|#)\s*TODO:\s*(?:keep|mantener|conservar) (?:the )?(?:rest|resto)/im
];

function detectElision(content) {
    for (const re of ELISION_PATTERNS) {
        const m = content.match(re);
        if (m) return m[0].trim();
    }
    return null;
}

/** Strip a fence the model wrapped the whole file in. */
function unfence(content) {
    const m = String(content).match(/^\s*```[a-zA-Z0-9_+-]*\s*\n([\s\S]*?)\n?```\s*$/);
    return m ? { content: m[1], stripped: true } : { content, stripped: false };
}

export const listDirectory = {
    name: 'list_directory',
    title: 'Listar carpeta',
    description: 'Lista los archivos y carpetas de un directorio del proyecto. Úsalo para orientarte antes de leer nada.',
    readOnly: true,
    mutates: false,
    params: {
        path: {
            type: 'string', required: false, default: '.',
            description: 'Ruta relativa a la raíz del proyecto. "." es la raíz.'
        }
    },
    examples: [{ args: { path: 'src' } }],

    async run(args, ctx) {
        const { abs, rel } = ctx.security.resolvePath(args.path || '.');
        const stat = await ctx.platform.fs.stat(abs);
        if (!stat) return { ok: false, summary: `No existe la ruta "${args.path}".` };
        if (!stat.isDirectory) return { ok: false, summary: `"${args.path}" es un archivo, no una carpeta. Usa read_file.` };

        const entries = await ctx.platform.fs.readDir(abs);
        const visible = entries.filter(e => !(e.isDirectory && isIgnoredDir(e.name)));
        visible.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));

        const shown = visible.slice(0, 200);
        const rows = [];
        for (const e of shown) {
            if (e.isDirectory) { rows.push(`${e.name}/`); continue; }
            const s = await ctx.platform.fs.stat(e.path);
            rows.push(`${e.name}${s ? `  (${s.size} bytes)` : ''}`);
        }
        if (visible.length > shown.length) rows.push(`… y ${visible.length - shown.length} entradas más`);

        const hidden = entries.length - visible.length;
        return {
            ok: true,
            summary: `${visible.length} entradas en ${rel || '.'}`,
            detail: rows.length
                ? `Contenido de ${rel || '.'}/\n${rows.join('\n')}` +
                  (hidden ? `\n(${hidden} carpetas ignoradas: node_modules, .git, build…)` : '')
                : `La carpeta ${rel || '.'} está vacía.`,
            data: { entries: visible.map(e => ({ name: e.name, isDirectory: e.isDirectory, path: P.relative(ctx.root, e.path) })) }
        };
    }
};

export const readFile = {
    name: 'read_file',
    title: 'Leer archivo',
    description: 'Lee un archivo de texto con números de línea. Léelo SIEMPRE antes de modificarlo. En archivos grandes lee sólo el trozo que necesitas con around_line o start_line.',
    readOnly: true,
    mutates: false,
    params: {
        path: { type: 'string', required: true, description: 'Ruta relativa del archivo.' },
        around_line: {
            type: 'integer', required: false, min: 1,
            description: 'Centra la lectura en esta línea (por ejemplo la que te dio search_codebase). Ignora start_line.'
        },
        start_line: { type: 'integer', required: false, default: 1, min: 1, description: 'Primera línea a leer (1 = principio).' },
        max_lines: { type: 'integer', required: false, default: 400, min: 1, max: 3000, description: 'Cuántas líneas leer como máximo.' }
    },
    examples: [{ args: { path: 'src/main.js' } }, { args: { path: 'src/grande.js', around_line: 840 } }],

    async run(args, ctx) {
        const { abs, rel } = ctx.security.resolvePath(args.path);

        // Over HTTP a read is a network round trip, and on a big file it is not
        // instant. Cheap to announce, and it turns a pause into an explanation.
        // The registry closes this handle whichever way we return.
        const prog = toolProgress(ctx)(`Leyendo ${rel}…`, { indeterminate: true });

        const stat = await ctx.platform.fs.stat(abs);
        if (!stat) return { ok: false, summary: `No existe el archivo "${args.path}".`, detail: await suggestNearby(ctx, args.path) };
        if (stat.isDirectory) return { ok: false, summary: `"${args.path}" es una carpeta. Usa list_directory.` };
        if (isBinaryPath(abs)) return { ok: false, summary: `"${args.path}" es un archivo binario y no se puede leer como texto.` };
        if (stat.size > MAX_TEXT_BYTES) {
            return {
                ok: false,
                summary: `"${args.path}" pesa ${Math.round(stat.size / 1024)} KB: demasiado para leerlo.`,
                detail: 'Usa outline_file para ver su estructura, o search_codebase para localizar la línea exacta, y luego read_file con around_line.'
            };
        }

        prog.update(`Leyendo ${rel} (${Math.round(stat.size / 1024)} KB)…`, { indeterminate: true });
        const content = await ctx.platform.fs.readText(abs);
        if (looksBinary(content)) return { ok: false, summary: `"${args.path}" no parece texto.` };

        // The engine compares against this before allowing an edit, so an edit
        // built on a stale read is caught instead of silently clobbering.
        ctx.readCache.set(abs, content);

        const all = content.split(/\r\n|\r|\n/);

        // How many lines fit in what is left of the context. On a small model
        // this is the difference between reading a useful window and blowing
        // the window on one file.
        const budgetLines = budgetedLineCount(ctx, all);
        const asked = args.max_lines || 400;
        const window = Math.max(40, Math.min(asked, budgetLines));

        let start;
        if (args.around_line) {
            // Centre on the line of interest, with more context after it than
            // before: you usually want the body of what you landed on.
            start = Math.max(1, args.around_line - Math.floor(window * 0.35));
        } else {
            start = Math.max(1, args.start_line || 1);
        }
        const end = Math.min(all.length, start - 1 + window);
        const slice = all.slice(start - 1, end);

        const width = String(end).length;
        const numbered = slice.map((l, i) => `${String(start + i).padStart(width, ' ')}| ${l}`).join('\n');

        const parts = [`${rel} (${all.length} líneas, ${languageOf(abs) || 'texto'})`, numbered];

        // A partial read must never look like a whole file, or the model will
        // "fix" the missing half by rewriting it.
        if (start > 1 || end < all.length) {
            const nav = [`[VISTA PARCIAL: líneas ${start}-${end} de ${all.length}.`];
            if (end < all.length) nav.push(`Para seguir: read_file(path="${rel}", start_line=${end + 1}).`);
            if (start > 1) nav.push(`Para lo anterior: read_file(path="${rel}", start_line=${Math.max(1, start - window)}).`);
            nav.push(`Para ver todo el mapa del archivo: outline_file(path="${rel}").]`);
            parts.push('\n' + nav.join(' '));

            if (window < asked) {
                parts.push(`[Se recortó a ${window} líneas por el espacio de contexto disponible.]`);
            }
        }

        return {
            ok: true,
            summary: `Leído ${rel} (líneas ${start}-${end} de ${all.length})`,
            detail: parts.join('\n'),
            data: { path: rel, absolute: abs, totalLines: all.length, from: start, to: end, partial: start > 1 || end < all.length }
        };
    }
};

/**
 * How many lines of this file we can afford right now.
 *
 * Reading a 4000-line file into a 32k window leaves nothing for the plan, the
 * repo map or the conversation, and the model then loses the thread of what it
 * was doing. So the read is sized against what is actually left.
 */
function budgetedLineCount(ctx, lines) {
    const maxTokens = ctx.config.get('context.fileMaxTokens', 3500);
    const usage = ctx.contextUsage ? ctx.contextUsage() : null;

    let tokens = maxTokens;
    if (usage && usage.budget) {
        const free = usage.budget - usage.used;
        // Never let one read eat more than half of what remains.
        tokens = Math.max(400, Math.min(maxTokens, Math.floor(free * 0.5)));
    }

    const sample = lines.slice(0, 200).join('\n');
    const perLine = sample.length ? Math.max(6, sample.length / Math.max(1, Math.min(200, lines.length))) : 40;
    return Math.max(40, Math.floor((tokens * 3.4) / perLine));
}

export const outlineFile = {
    name: 'outline_file',
    title: 'Esquema de un archivo',
    description: 'Muestra el mapa de un archivo — funciones, clases y secciones con su número de línea — sin traer el código. Úsalo en archivos grandes ANTES de read_file para saber qué trozo pedir.',
    readOnly: true,
    mutates: false,
    params: {
        path: { type: 'string', required: true, description: 'Ruta relativa del archivo.' }
    },
    examples: [{ args: { path: 'src/app.js' } }],

    async run(args, ctx) {
        const { abs, rel } = ctx.security.resolvePath(args.path);
        const stat = await ctx.platform.fs.stat(abs);
        if (!stat) return { ok: false, summary: `No existe el archivo "${args.path}".` };
        if (stat.isDirectory) return { ok: false, summary: `"${args.path}" es una carpeta. Usa list_directory.` };
        if (isBinaryPath(abs)) return { ok: false, summary: `"${args.path}" es binario.` };

        const content = await ctx.platform.fs.readText(abs);
        const all = content.split(/\r\n|\r|\n/);
        const lang = languageOf(abs);
        const symbols = extractSignatures(content, lang);

        if (!symbols.length) {
            // No recognisable structure — say so, and give the shape of the
            // file anyway so the model can still target a region.
            const chunk = Math.max(1, Math.ceil(all.length / 10));
            const rows = [];
            for (let i = 0; i < all.length; i += chunk) {
                const first = all.slice(i, i + chunk).find(l => l.trim());
                rows.push(`  L${i + 1}  ${(first || '').trim().slice(0, 90)}`);
            }
            return {
                ok: true,
                summary: `${rel}: ${all.length} líneas, sin símbolos reconocibles (${lang || 'texto plano'})`,
                detail: `${rel} — ${all.length} líneas. No se detectan funciones ni clases; muestra por bloques:\n${rows.join('\n')}\n\n` +
                    `Lee un trozo con read_file(path="${rel}", around_line=<línea>).`,
                data: { path: rel, totalLines: all.length, symbols: 0 }
            };
        }

        // `extractSignatures` returns "firma  ·NN"; split it back out so the
        // line number leads, which is what the model needs to act on.
        const rows = symbols.map(s => {
            const m = s.match(/^(.*)\s+·(\d+)$/);
            return m ? `  L${m[2].padStart(5, ' ')}  ${m[1]}` : `  ${s}`;
        });

        return {
            ok: true,
            summary: `${rel}: ${symbols.length} símbolos en ${all.length} líneas`,
            detail:
                `${rel} — ${all.length} líneas, ${lang || 'texto'}\n${rows.join('\n')}\n\n` +
                `Ahora lee sólo lo que necesites: read_file(path="${rel}", around_line=<la línea de arriba>).`,
            data: { path: rel, totalLines: all.length, symbols: symbols.length }
        };
    }
};

export const writeFile = {
    name: 'write_file',
    title: 'Escribir archivo',
    description: 'Crea un archivo nuevo o reemplaza uno existente POR COMPLETO. Para cambios parciales usa edit_file: es más seguro.',
    readOnly: false,
    mutates: true,
    params: {
        path: { type: 'string', required: true, description: 'Ruta relativa del archivo.' },
        content: { type: 'string', required: true, description: 'Contenido COMPLETO del archivo. Nunca abreviado, nunca con "...".' }
    },
    examples: [{ args: { path: 'src/util.js', content: 'export const x = 1;\n' } }],

    async run(args, ctx) {
        const { abs, rel } = ctx.security.resolvePath(args.path, { write: true });

        const { content: unfenced, stripped } = unfence(args.content);
        let content = unfenced;
        const notes = [];
        if (stripped) notes.push('se eliminó el bloque ``` que envolvía el contenido');

        const elision = detectElision(content);
        if (elision) {
            return {
                ok: false,
                summary: 'Escritura rechazada: el contenido está abreviado.',
                detail:
                    `Encontré "${truncate(elision, 80, '…')}" en el contenido.\n` +
                    `write_file escribe el archivo COMPLETO y destruiría el resto del código.\n` +
                    `Haz una de estas dos cosas:\n` +
                    `  1. Usa edit_file con el fragmento exacto que quieres cambiar (recomendado).\n` +
                    `  2. Vuelve a llamar a write_file con el archivo entero, sin abreviar ninguna parte.`
            };
        }

        const prior = await ctx.platform.fs.stat(abs);
        const before = prior && prior.isFile ? await ctx.platform.fs.readText(abs) : null;

        // A large file replaced by a much smaller one is nearly always a
        // truncated generation, not an intentional rewrite.
        if (before !== null && before.length > 400 && content.length < before.length * 0.45) {
            return {
                ok: false,
                summary: 'Escritura rechazada: el contenido nuevo es mucho más corto que el archivo actual.',
                detail:
                    `El archivo tiene ${before.length} caracteres y estás escribiendo ${content.length} ` +
                    `(${Math.round((content.length / before.length) * 100)}%).\n` +
                    `Eso suele significar que la generación se cortó. Usa edit_file para cambiar sólo lo necesario. ` +
                    `Si de verdad quieres reducir el archivo, hazlo con edit_file paso a paso.`
            };
        }

        if (before !== null && before === content) {
            return { ok: true, summary: `${rel} ya tenía ese contenido exacto; no se escribió nada.`, data: { path: rel, unchanged: true } };
        }

        // Match the file's existing line endings; rewriting a whole CRLF file
        // as LF shows up as a diff on every single line.
        if (before && before.includes('\r\n') && !content.includes('\r\n')) {
            content = content.replace(/\n/g, '\r\n');
            notes.push('finales de línea CRLF conservados');
        }

        await ctx.platform.fs.writeText(abs, content);
        ctx.readCache.set(abs, content);
        ctx.recordDiff(rel, before, content);

        const created = before === null;
        const diff = created ? null : summarizeForModel(rel, before, content, { maxLines: 40 });

        return {
            ok: true,
            summary: created
                ? `Creado ${rel} (${content.split('\n').length} líneas)`
                : `Reescrito ${rel} (+${diff.stats.added} / -${diff.stats.removed})`,
            detail: [created ? `Archivo creado: ${rel}` : diff.text, ...notes.map(n => `nota: ${n}`)].join('\n'),
            data: { path: rel, created, bytes: content.length }
        };
    }
};

export const editFile = {
    name: 'edit_file',
    title: 'Editar archivo',
    description: 'Reemplaza un fragmento EXACTO de un archivo por otro. El fragmento debe existir literalmente y ser único.',
    readOnly: false,
    mutates: true,
    params: {
        path: { type: 'string', required: true, description: 'Ruta relativa del archivo.' },
        old_text: {
            type: 'string', required: true,
            description: 'Texto exacto que hay ahora en el archivo, copiado carácter por carácter. Incluye líneas de contexto suficientes para que sea único.'
        },
        new_text: { type: 'string', required: true, description: 'Texto que lo sustituye. Cadena vacía para borrar el fragmento.' }
    },
    examples: [{ args: { path: 'src/app.js', old_text: 'const PORT = 3000;', new_text: 'const PORT = 8080;' } }],

    async run(args, ctx) {
        const { abs, rel } = ctx.security.resolvePath(args.path, { write: true });

        const stat = await ctx.platform.fs.stat(abs);
        if (!stat || !stat.isFile) {
            return { ok: false, summary: `No existe el archivo "${args.path}". Usa write_file para crearlo.` };
        }

        const before = await ctx.platform.fs.readText(abs);
        const oldText = unfence(args.old_text).content;
        const newText = unfence(args.new_text).content;

        if (oldText === newText) {
            return { ok: false, summary: 'old_text y new_text son idénticos: la edición no haría nada.' };
        }
        if (!oldText) {
            return { ok: false, summary: 'old_text está vacío. Para crear un archivo usa write_file.' };
        }

        const count = countOccurrences(before, oldText);

        if (count === 0) {
            const relaxed = findRelaxed(before, oldText);
            if (relaxed) {
                const after = before.slice(0, relaxed.start) + newText + before.slice(relaxed.end);
                await ctx.platform.fs.writeText(abs, after);
                ctx.readCache.set(abs, after);
                ctx.recordDiff(rel, before, after);
                const d = summarizeForModel(rel, before, after, { maxLines: 40 });
                return {
                    ok: true,
                    summary: `Editado ${rel} (+${d.stats.added} / -${d.stats.removed})`,
                    detail: `${d.text}\nnota: old_text no coincidía exactamente en espacios/indentación; se aplicó igualmente sobre el fragmento equivalente.`,
                    data: { path: rel, fuzzy: true }
                };
            }
            return {
                ok: false,
                summary: `old_text no aparece en ${rel}.`,
                detail: notFoundHelp(before, oldText, rel)
            };
        }

        if (count > 1) {
            return {
                ok: false,
                summary: `old_text aparece ${count} veces en ${rel}; la edición sería ambigua.`,
                detail:
                    `Añade líneas de contexto encima y/o debajo del fragmento hasta que sea único, ` +
                    `y vuelve a llamar a edit_file. No cambies el contenido, sólo amplía el fragmento.`
            };
        }

        const at = before.indexOf(oldText);
        const after = before.slice(0, at) + newText + before.slice(at + oldText.length);

        await ctx.platform.fs.writeText(abs, after);
        ctx.readCache.set(abs, after);
        ctx.recordDiff(rel, before, after);

        const d = summarizeForModel(rel, before, after, { maxLines: 40 });
        return {
            ok: true,
            summary: `Editado ${rel} (+${d.stats.added} / -${d.stats.removed})`,
            detail: d.text,
            data: { path: rel, line: before.slice(0, at).split('\n').length }
        };
    }
};

function countOccurrences(haystack, needle) {
    let n = 0;
    let i = haystack.indexOf(needle);
    while (i >= 0) { n++; i = haystack.indexOf(needle, i + needle.length); }
    return n;
}

/**
 * Second chance for an `old_text` that is right except for whitespace — by far
 * the most common near miss, because the model retypes the fragment from
 * memory and normalises the indentation on the way.
 */
function findRelaxed(haystack, needle) {
    const norm = s => s.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').trim();
    const target = norm(needle);
    if (!target) return null;

    const hay = haystack.split('\n');
    const want = needle.split('\n').length;
    // Try the exact line count first, then one short and one long — a fragment
    // retyped from memory often gains or loses a blank line at an edge.
    const spans = [want, Math.max(1, want - 1), want + 1];

    let match = null;
    for (let i = 0; i < hay.length; i++) {
        // At most one span per start position: spans that differ only by a
        // trailing blank line normalise to the same text and would otherwise
        // look like two matches at the same place.
        let hit = 0;
        for (const span of spans) {
            if (i + span > hay.length) continue;
            if (norm(hay.slice(i, i + span).join('\n')) !== target) continue;
            hit = span;
            break;
        }
        if (!hit) continue;
        if (match) return null; // genuinely ambiguous once relaxed: refuse

        const start = hay.slice(0, i).reduce((n, l) => n + l.length + 1, 0);
        match = { start, end: start + hay.slice(i, i + hit).join('\n').length };
    }
    return match;
}

/** Show the model where it nearly matched, instead of just saying "not found". */
function notFoundHelp(content, oldText, rel) {
    const firstLine = oldText.split('\n')[0].trim();
    if (!firstLine) return 'Copia el fragmento tal cual aparece en el archivo (usa read_file primero).';

    const lines = content.split('\n');
    const hits = [];
    const key = firstLine.replace(/\s+/g, ' ').toLowerCase();

    lines.forEach((l, i) => {
        if (hits.length >= 4) return;
        if (l.replace(/\s+/g, ' ').toLowerCase().includes(key.slice(0, Math.min(40, key.length)))) {
            hits.push(`  ${i + 1}| ${l}`);
        }
    });

    return hits.length
        ? `Líneas parecidas en ${rel}:\n${hits.join('\n')}\n\n` +
          `Copia el texto EXACTO de esas líneas (espacios y tabulaciones incluidos). ` +
          `Si no estás seguro, llama antes a read_file.`
        : `Ninguna línea de ${rel} se parece al fragmento. Llama a read_file para ver el contenido real antes de editar.`;
}

/** When a path does not exist, offer the nearest real names in its folder. */
async function suggestNearby(ctx, requested) {
    try {
        const dir = P.dirname(requested) || '.';
        const { abs } = ctx.security.resolvePath(dir);
        const entries = await ctx.platform.fs.readDir(abs);
        const want = P.basename(requested).toLowerCase();
        const near = entries
            .filter(e => e.name.toLowerCase().includes(want.slice(0, 4)) || want.includes(e.name.toLowerCase().slice(0, 4)))
            .slice(0, 6)
            .map(e => `${dir === '.' ? '' : dir + '/'}${e.name}${e.isDirectory ? '/' : ''}`);
        return near.length ? `¿Querías alguno de estos?\n${near.join('\n')}` : '';
    } catch {
        return '';
    }
}
