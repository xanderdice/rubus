/**
 * The repo map: a compressed picture of the project that fits in a couple of
 * thousand tokens.
 *
 * This is the single most valuable thing you can put in front of a weak model.
 * Without it the model has two options — ask for a directory listing every few
 * turns (slow, and it forgets between steps), or guess at filenames (it will,
 * and they will not exist). With it, "where does X live" is answered before the
 * question is asked, and invented paths mostly stop happening.
 *
 * Three parts, in order of how much they earn their tokens:
 *
 *   1. conventions — indentation, quotes, module system, how to run the tests.
 *      A dozen lines that stop the model writing code that looks foreign.
 *   2. tree        — where things are.
 *   3. signatures  — what is callable, for the files most likely to matter.
 *
 * Signatures are budgeted last and dropped first, because a file the model
 * actually opens will be read in full anyway.
 */

import * as P from '../platform/paths.js';
import { walkFiles } from './walk.js';
import { isCodeFile, languageOf, MAX_TEXT_BYTES } from './ignore.js';
import { estimateTokens, makeThrottle } from './util.js';
import { EV } from './bus.js';

/** Per-language patterns for "things another file might call". */
const SIGNATURE_RULES = {
    javascript: [
        /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
        /^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
        /^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
        /^\s*class\s+([A-Za-z_$][\w$]*)/,
        /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/,
        /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/,
        /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
        /^\s{2,}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/   // class methods
    ],
    typescript: null, // same as javascript, filled in below
    python: [
        /^\s*def\s+([A-Za-z_]\w*)\s*\(/,
        /^\s*async\s+def\s+([A-Za-z_]\w*)\s*\(/,
        /^\s*class\s+([A-Za-z_]\w*)/
    ],
    go: [
        /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/,
        /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/
    ],
    rust: [
        /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
        /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/,
        /^\s*impl(?:<[^>]*>)?\s+([A-Za-z_]\w*)/
    ],
    java: [
        /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:abstract\s+)?class\s+([A-Za-z_]\w*)/,
        /^\s*(?:public|private|protected)\s+(?:static\s+)?[\w<>\[\],\s]+\s+([A-Za-z_]\w*)\s*\(/,
        /^\s*interface\s+([A-Za-z_]\w*)/
    ],
    csharp: [
        /^\s*(?:public|private|protected|internal)?\s*(?:static\s+|sealed\s+|abstract\s+|partial\s+)*class\s+([A-Za-z_]\w*)/,
        /^\s*(?:public|private|protected|internal)\s+(?:static\s+|async\s+|virtual\s+|override\s+)*[\w<>\[\],\s?]+\s+([A-Za-z_]\w*)\s*\(/
    ],
    php: [/^\s*(?:public|private|protected)?\s*(?:static\s+)?function\s+([A-Za-z_]\w*)/, /^\s*class\s+([A-Za-z_]\w*)/],
    ruby: [/^\s*def\s+([A-Za-z_]\w*[?!]?)/, /^\s*(?:class|module)\s+([A-Za-z_]\w*)/],
    css: [/^\s*([.#][\w-]+(?:\s*[,{])?)/],
    html: [/^\s*<(?:section|main|header|footer|nav|dialog)\b[^>]*id="([\w-]+)"/]
};
SIGNATURE_RULES.typescript = SIGNATURE_RULES.javascript;

/** Files whose name says "start here". */
const ENTRY_HINTS = /^(index|main|app|server|boot|cli|mod|__init__|program|startup)\./i;

export class RepoMap {
    constructor({ platform, config, bus, logger }) {
        this.platform = platform;
        this.config = config;
        this.bus = bus;
        this.logger = logger;
        this.cache = null;
        this.cacheRoot = '';
        this.dirty = true;
    }

    /** Called by the engine after any write, so the next read is fresh. */
    invalidate() {
        this.dirty = true;
    }

    /**
     * @param {object}  opts
     * @param {string}  opts.focus  The task text. On a big repository the map
     *   cannot show everything, so what it shows is ranked by relevance to what
     *   the user actually asked for. Without this, a 3000-file project gives
     *   the model an alphabetical slice that almost never contains the files
     *   the task is about.
     */
    async build({ force = false, signal, focus = '' } = {}) {
        const root = P.normalize(this.config.get('workspace.root', ''));
        if (!root) return emptyMap('No hay carpeta de trabajo seleccionada.');

        // The focus is part of the cache identity: a map built for another task
        // is the wrong map, not a stale one.
        if (!force && !this.dirty && this.cache && this.cacheRoot === root && this.cacheFocus === focus) {
            return this.cache;
        }

        const started = Date.now();
        const pid = `repomap_${started}`;
        const tick = makeThrottle(150);
        const step = (label, extra = {}) => this.bus?.emit(EV.PROGRESS, { id: pid, label, ...extra });

        step('Recorriendo el proyecto…', { indeterminate: true });
        const { files, dirs, truncated } = await walkFiles(this.platform, root, {
            maxFiles: 4000,
            signal,
            onProgress: (p) => tick(() => step(`Recorriendo el proyecto… ${p.files} archivos`, {
                indeterminate: true, detail: p.current
            }))
        });

        step(`Detectando convenciones… (${files.length} archivos)`, { indeterminate: true });
        const conventions = await this.detectConventions(root, files, signal);
        const budget = this.config.get('context.repoMapMaxTokens', 2600);

        const treeText = renderTree(files, dirs, root);
        const header = [
            `PROYECTO: ${P.basename(root) || root}`,
            `RAÍZ: ${root}`,
            `${files.length} archivos${truncated ? '+ (truncado)' : ''}, ${dirs.length} carpetas`
        ].join('\n');

        const fixed = `${header}\n\n${conventions.text}\n\nESTRUCTURA:\n${treeText}`;
        const remaining = budget - estimateTokens(fixed);

        const signatures = remaining > 200
            ? await this.buildSignatures(files, remaining, signal, focus, (done, total, name) =>
                tick(() => step('Extrayendo símbolos…', { current: done, total, detail: name })))
            : '';

        step('Mapa del proyecto listo', { done: true, elapsedMs: Date.now() - started });

        const text = signatures
            ? `${fixed}\n\nSÍMBOLOS PRINCIPALES:\n${signatures}`
            : fixed;

        this.cacheFocus = focus;
        this.cache = {
            text,
            root,
            fileCount: files.length,
            dirCount: dirs.length,
            files: files.map(f => f.rel),
            conventions: conventions.data,
            truncated,
            builtAt: Date.now(),
            buildMs: Date.now() - started,
            tokens: estimateTokens(text)
        };
        this.cacheRoot = root;
        this.dirty = false;

        this.bus?.emit(EV.REPO_MAP, { map: this.cache });
        this.logger?.debug(`repo map: ${files.length} archivos en ${Date.now() - started}ms`, { tokens: this.cache.tokens });
        return this.cache;
    }

    /**
     * Read the project's own conventions off disk rather than asking the model
     * to infer them. Cheap, and it is the difference between code that merges
     * cleanly and code that reformats half the file.
     */
    async detectConventions(root, files, signal) {
        const data = {
            language: '', moduleSystem: '', indent: '', quotes: '', semicolons: null,
            packageManager: '', testCommand: '', buildCommand: '', frameworks: []
        };
        const notes = [];

        const readIf = async (rel) => {
            const f = files.find(x => x.rel.toLowerCase() === rel.toLowerCase());
            if (!f) return null;
            try { return await this.platform.fs.readText(f.path); } catch { return null; }
        };

        const pkgRaw = await readIf('package.json');
        if (pkgRaw) {
            try {
                const pkg = JSON.parse(pkgRaw);
                data.language = 'javascript';
                data.moduleSystem = pkg.type === 'module' ? 'ESM (import/export)' : 'CommonJS (require)';
                if (pkg.scripts) {
                    if (pkg.scripts.test) data.testCommand = 'npm test';
                    if (pkg.scripts.build) data.buildCommand = 'npm run build';
                    const names = Object.keys(pkg.scripts).slice(0, 10);
                    if (names.length) notes.push(`scripts npm: ${names.join(', ')}`);
                }
                const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
                data.frameworks = ['react', 'vue', 'svelte', 'next', 'express', 'fastify', 'vitest', 'jest', 'typescript', 'electron', 'neutralino']
                    .filter(k => Object.keys(deps).some(d => d.includes(k)));
            } catch { notes.push('package.json existe pero no es JSON válido'); }
        }

        if (files.some(f => f.rel === 'requirements.txt' || f.rel === 'pyproject.toml' || f.rel === 'setup.py')) {
            data.language = data.language || 'python';
            data.testCommand = data.testCommand || 'pytest';
        }
        if (files.some(f => f.rel === 'go.mod')) { data.language = data.language || 'go'; data.testCommand = data.testCommand || 'go test ./...'; }
        if (files.some(f => f.rel === 'Cargo.toml')) { data.language = data.language || 'rust'; data.testCommand = data.testCommand || 'cargo test'; }
        if (files.some(f => f.rel === 'tsconfig.json')) notes.push('TypeScript configurado (tsconfig.json)');

        if (files.some(f => f.rel === 'pnpm-lock.yaml')) data.packageManager = 'pnpm';
        else if (files.some(f => f.rel === 'yarn.lock')) data.packageManager = 'yarn';
        else if (files.some(f => f.rel === 'package-lock.json')) data.packageManager = 'npm';

        const editorconfig = await readIf('.editorconfig');
        if (editorconfig) {
            const style = editorconfig.match(/indent_style\s*=\s*(\w+)/i);
            const size = editorconfig.match(/indent_size\s*=\s*(\d+)/i);
            if (style) data.indent = style[1].toLowerCase() === 'tab' ? 'tabulaciones' : `${size ? size[1] : 4} espacios`;
        }

        // Sample real source files: what the code does beats what the config says.
        const sample = files.filter(f => isCodeFile(f.rel) && !f.rel.includes('.min.')).slice(0, 12);
        let tabs = 0, spaces2 = 0, spaces4 = 0, single = 0, double = 0, withSemi = 0, noSemi = 0, esm = 0, cjs = 0;

        for (const f of sample) {
            if (signal?.aborted) break;
            let text;
            try { text = await this.platform.fs.readText(f.path); } catch { continue; }
            const lines = text.split('\n').slice(0, 300);
            for (const l of lines) {
                if (/^\t/.test(l)) tabs++;
                else if (/^ {4}\S/.test(l)) spaces4++;
                else if (/^ {2}\S/.test(l)) spaces2++;
                if (/^\s*(import|export)\s/.test(l)) esm++;
                if (/require\(|module\.exports/.test(l)) cjs++;
                const code = l.trim();
                if (code && !code.startsWith('//') && !code.startsWith('*')) {
                    if (/;\s*$/.test(code)) withSemi++;
                    else if (/[)\w'"\]]\s*$/.test(code) && !/[{,:]$/.test(code)) noSemi++;
                }
            }
            single += (text.match(/'[^'\n]{0,80}'/g) || []).length;
            double += (text.match(/"[^"\n]{0,80}"/g) || []).length;
        }

        if (!data.indent) {
            data.indent = tabs > spaces2 + spaces4 ? 'tabulaciones' : spaces4 >= spaces2 ? '4 espacios' : '2 espacios';
        }
        if (single + double > 10) data.quotes = single > double * 1.3 ? "comillas simples '" : 'comillas dobles "';
        if (withSemi + noSemi > 20) data.semicolons = withSemi > noSemi * 1.5;
        if (!data.moduleSystem && esm + cjs > 3) data.moduleSystem = esm > cjs ? 'ESM (import/export)' : 'CommonJS (require)';

        const rows = [
            data.language && `- lenguaje principal: ${data.language}`,
            data.moduleSystem && `- módulos: ${data.moduleSystem}`,
            data.indent && `- indentación: ${data.indent}`,
            data.quotes && `- cadenas: ${data.quotes}`,
            data.semicolons !== null && `- punto y coma al final de línea: ${data.semicolons ? 'sí' : 'no'}`,
            data.packageManager && `- gestor de paquetes: ${data.packageManager}`,
            data.testCommand && `- tests: ${data.testCommand}`,
            data.buildCommand && `- build: ${data.buildCommand}`,
            data.frameworks.length && `- librerías detectadas: ${data.frameworks.join(', ')}`,
            ...notes.map(n => `- ${n}`)
        ].filter(Boolean);

        return {
            data,
            text: rows.length ? `CONVENCIONES DEL PROYECTO (respétalas):\n${rows.join('\n')}` : 'CONVENCIONES: no detectadas.'
        };
    }

    async buildSignatures(files, tokenBudget, signal, focus = '', onProgress = null) {
        const terms = focusTerms(focus);
        const ranked = [...files]
            .filter(f => isCodeFile(f.rel))
            .map(f => ({ ...f, score: rankFile(f) + focusBonus(f.rel, terms) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 120);

        const out = [];
        let used = 0;

        let seen = 0;
        for (const f of ranked) {
            if (signal?.aborted) break;
            if (used >= tokenBudget) break;

            if (onProgress) onProgress(++seen, ranked.length, f.rel);

            const stat = await this.platform.fs.stat(f.path);
            if (!stat || stat.size > MAX_TEXT_BYTES) continue;

            let text;
            try { text = await this.platform.fs.readText(f.path); } catch { continue; }

            const syms = extractSignatures(text, languageOf(f.rel));
            if (!syms.length) continue;

            const shown = syms.slice(0, 12);
            const block = `${f.rel}\n${shown.map(s => `  ${s}`).join('\n')}` +
                (syms.length > shown.length ? `\n  … +${syms.length - shown.length} más` : '');

            const cost = estimateTokens(block);
            if (used + cost > tokenBudget) break;
            used += cost;
            out.push(block);
        }

        return out.join('\n');
    }
}

/** Words from the task worth matching against paths. */
function focusTerms(focus) {
    if (!focus) return [];
    const stop = new Set([
        'para', 'como', 'esta', 'este', 'esto', 'that', 'this', 'with', 'from', 'have', 'when',
        'donde', 'hacer', 'archivo', 'archivos', 'codigo', 'código', 'funcion', 'función',
        'todos', 'todas', 'debe', 'debes', 'quiero', 'necesito', 'file', 'files', 'code', 'the'
    ]);
    return [...new Set(
        String(focus).toLowerCase()
            .split(/[^a-z0-9_áéíóúñ]+/i)
            .filter(w => w.length >= 4 && !stop.has(w))
    )].slice(0, 12);
}

/** Path mentions the task's words → it is far more likely to be relevant. */
function focusBonus(rel, terms) {
    if (!terms.length) return 0;
    const lower = rel.toLowerCase();
    let bonus = 0;
    for (const t of terms) {
        if (lower.includes(t)) bonus += 60;
        else if (t.length > 5 && lower.includes(t.slice(0, Math.ceil(t.length * 0.7)))) bonus += 25;
    }
    return Math.min(bonus, 180);
}

function rankFile(f) {
    let score = 100 - f.depth * 12;
    if (ENTRY_HINTS.test(P.basename(f.rel))) score += 45;
    if (/\/(test|tests|spec|__tests__)\//i.test(`/${f.rel}`)) score -= 30;
    if (/\.(test|spec)\./i.test(f.rel)) score -= 30;
    if (/\.min\./i.test(f.rel)) score -= 200;
    if (/(^|\/)(src|lib|app|core|source)\//i.test(f.rel)) score += 20;
    return score;
}

export function extractSignatures(text, language) {
    const rules = SIGNATURE_RULES[language];
    if (!rules) return [];

    const seen = new Set();
    const out = [];
    const lines = text.split(/\r\n|\r|\n/);

    for (let i = 0; i < lines.length && out.length < 40; i++) {
        const line = lines[i];
        if (line.length > 300) continue;
        for (const re of rules) {
            const m = line.match(re);
            if (!m || !m[1]) continue;
            const sig = line.trim().replace(/\s*\{\s*$/, '').replace(/\s+/g, ' ').slice(0, 120);
            const key = `${m[1]}@${sig.length}`;
            if (seen.has(key)) break;
            seen.add(key);
            out.push(`${sig}  ·${i + 1}`);
            break;
        }
    }
    return out;
}

/** Indented tree, capped, with big directories collapsed to a count. */
function renderTree(files, dirs, root) {
    const children = new Map();
    const add = (parent, entry) => {
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(entry);
    };

    for (const d of dirs) add(P.dirname(d.rel) === '.' ? '' : P.dirname(d.rel), { name: P.basename(d.rel), rel: d.rel, dir: true });
    for (const f of files) {
        const parent = f.rel.includes('/') ? P.dirname(f.rel) : '';
        add(parent, { name: P.basename(f.rel), rel: f.rel, dir: false });
    }

    const lines = [];
    const MAX_LINES = 220;
    const MAX_PER_DIR = 18;

    const walk = (parent, indent) => {
        if (lines.length >= MAX_LINES) return;
        const kids = (children.get(parent) || []).sort((a, b) =>
            a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1
        );

        const shown = kids.slice(0, MAX_PER_DIR);
        for (const k of shown) {
            if (lines.length >= MAX_LINES) { lines.push(`${indent}…`); return; }
            lines.push(`${indent}${k.name}${k.dir ? '/' : ''}`);
            if (k.dir) walk(k.rel, indent + '  ');
        }
        if (kids.length > shown.length) lines.push(`${indent}… +${kids.length - shown.length} entradas`);
    };

    walk('', '');
    return lines.length ? lines.join('\n') : '(vacío)';
}

function emptyMap(reason) {
    return { text: reason, root: '', fileCount: 0, dirCount: 0, files: [], conventions: {}, truncated: false, builtAt: Date.now(), tokens: 0 };
}
