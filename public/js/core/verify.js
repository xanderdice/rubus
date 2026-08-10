/**
 * Verification.
 *
 * The agent does not get to declare success. After every mutation the harness
 * checks the file itself, and after every step it checks the step's own success
 * criterion. This is where "the model is unreliable" stops being a slogan: a
 * weak model that has just written a file with an unclosed brace will tell you
 * confidently that the step is done, and only an independent check catches it.
 *
 * Three levels, cheapest first, and each one is optional depending on what the
 * machine actually has installed:
 *
 *   structure  — delimiter balance, conflict markers, leftover `...` elisions,
 *                JSON parse. Instant, no tooling, catches most truncation.
 *   toolchain  — `node --check`, `python -m py_compile`, `tsc --noEmit`.
 *                Real parsers. Probed once and cached.
 *   project    — the repo's own test/build command, when there is one.
 *
 * An inconclusive check is reported as inconclusive, never as a pass. Telling a
 * model "verified" when nothing was verified is worse than saying nothing.
 */

import * as P from '../platform/paths.js';
import { languageOf } from './ignore.js';
import { truncateMiddle, stripAnsi } from './util.js';

const CONFLICT_RE = /^(<{7}|={7}|>{7})/m;

const ELISION_RE = /^\s*(?:\/\/|#|--)\s*\.{2,}\s*(?:rest|resto|remainder|existing|unchanged|sin cambios)/im;

export class Verifier {
    constructor({ platform, config, security, logger }) {
        this.platform = platform;
        this.config = config;
        this.security = security;
        this.logger = logger;
        this._toolchain = null;
    }

    /** One probe per session for which checkers exist on this machine. */
    async toolchain() {
        if (this._toolchain) return this._toolchain;

        const probe = async (cmd) => {
            try {
                const r = await this.platform.exec(cmd, { cwd: this.config.get('workspace.root', '') || undefined, timeoutMs: 8000 });
                return r.exitCode === 0;
            } catch { return false; }
        };

        this._toolchain = {
            node: await probe('node --version'),
            python: (await probe('python --version')) ? 'python' : (await probe('py --version')) ? 'py' : null,
            tsc: await probe('npx --no-install tsc --version')
        };
        this.logger?.debug('Herramientas de verificación disponibles', this._toolchain);
        return this._toolchain;
    }

    /**
     * Check one file. `content` is passed in when the caller already has it, to
     * avoid a re-read straight after a write.
     */
    async checkFile(rel, content = null) {
        const issues = [];
        let level = 'structure';

        let abs;
        try { ({ abs } = this.security.resolvePath(rel)); }
        catch (err) { return { ok: false, level, issues: [err.message], inconclusive: false }; }

        let text = content;
        if (text === null) {
            const stat = await this.platform.fs.stat(abs);
            if (!stat || !stat.isFile) return { ok: false, level, issues: [`${rel} no existe después de la edición.`], inconclusive: false };
            try { text = await this.platform.fs.readText(abs); }
            catch (err) { return { ok: false, level, issues: [`No se puede releer ${rel}: ${err.message}`], inconclusive: false }; }
        }

        if (!text.trim()) issues.push(`${rel} quedó vacío.`);
        if (CONFLICT_RE.test(text)) issues.push(`${rel} contiene marcadores de conflicto (<<<<<<< / ======= / >>>>>>>).`);
        if (ELISION_RE.test(text)) issues.push(`${rel} contiene un comentario de omisión ("... resto del código"): falta código real.`);

        const lang = languageOf(rel);

        if (P.extname(rel) === '.json') {
            try { JSON.parse(text); }
            catch (err) { issues.push(`${rel} no es JSON válido: ${err.message}`); }
        } else if (lang) {
            const bal = checkBalance(text, lang);
            if (!bal.ok) issues.push(`${rel}: ${bal.message}`);
        }

        if (issues.length) return { ok: false, level, issues, inconclusive: false };

        const deeper = await this.toolchainCheck(rel, abs, lang);
        if (deeper) {
            level = 'toolchain';
            if (deeper.inconclusive) return { ok: true, level: 'structure', issues: [], inconclusive: true, note: deeper.note };
            if (!deeper.ok) return { ok: false, level, issues: deeper.issues, inconclusive: false };
        }

        return { ok: true, level, issues: [], inconclusive: false };
    }

    async toolchainCheck(rel, abs, lang) {
        const tc = await this.toolchain();
        const root = this.config.get('workspace.root', '');
        const ext = P.extname(rel);

        if (tc.node && ['.js', '.mjs', '.cjs'].includes(ext)) {
            const r = await this.platform.exec(`node --check "${P.toNative(abs, this.platform.isWindows)}"`, { cwd: root, timeoutMs: 20000 });
            if (r.exitCode === 0) return { ok: true, issues: [] };

            const err = stripAnsi(`${r.stderr}\n${r.stdout}`).trim();
            // `--check` parses as CommonJS unless the file says otherwise, so an
            // ESM file in a CJS package trips it. That is a false positive, not
            // a syntax error — report it as inconclusive.
            if (/Cannot use import statement outside a module|Unexpected token 'export'|await is only valid/i.test(err)) {
                return { ok: true, inconclusive: true, note: 'node --check no puede validar este archivo (ESM en paquete CommonJS).' };
            }
            return { ok: false, issues: [`node --check falló en ${rel}:\n${truncateMiddle(err, 900)}`] };
        }

        if (tc.python && ext === '.py') {
            const r = await this.platform.exec(
                `${tc.python} -m py_compile "${P.toNative(abs, this.platform.isWindows)}"`,
                { cwd: root, timeoutMs: 25000 }
            );
            if (r.exitCode === 0) return { ok: true, issues: [] };
            return { ok: false, issues: [`py_compile falló en ${rel}:\n${truncateMiddle(stripAnsi(`${r.stderr}\n${r.stdout}`).trim(), 900)}`] };
        }

        if (lang === 'typescript') {
            // Deliberately not run per-file: `tsc` on one file of a project
            // reports hundreds of phantom errors from missing imports. The
            // project-level check below is the right place for TypeScript.
            return null;
        }

        return null;
    }

    /** The project's own check — configured command, or the detected default. */
    async projectCheck({ signal, onOutput } = {}) {
        const explicit = (this.config.get('agent.verifyCommand', '') || '').trim();
        const root = this.config.get('workspace.root', '');
        if (!root) return { ran: false, reason: 'sin carpeta de trabajo' };

        const command = explicit;
        if (!command) return { ran: false, reason: 'no hay comando de verificación configurado' };

        const verdict = this.security.classifyCommand(command);
        if (verdict.risk === 'blocked') return { ran: false, reason: `comando bloqueado: ${verdict.why}` };

        const r = await this.platform.exec(command, { cwd: root, timeoutMs: 300000, onOutput });
        const out = stripAnsi(`${r.stdout}\n${r.stderr}`).trim();

        return {
            ran: true,
            ok: r.exitCode === 0,
            command,
            exitCode: r.exitCode,
            output: truncateMiddle(out, 4000)
        };
    }
}

/**
 * Delimiter balance with string and comment awareness.
 *
 * Not a parser — it will not catch a missing semicolon or a misspelled keyword.
 * It catches the failure that actually happens: generation stopped halfway and
 * left three functions open. That is worth the forty lines.
 */
export function checkBalance(text, lang) {
    const cStyle = ['javascript', 'typescript', 'java', 'csharp', 'c', 'cpp', 'go', 'rust', 'php', 'swift', 'kotlin', 'scala', 'dart', 'css', 'scss', 'less', 'json', 'vue', 'svelte'].includes(lang);
    const hashComment = ['python', 'ruby', 'bash', 'yaml', 'toml'].includes(lang);
    if (!cStyle && !hashComment) return { ok: true };

    const stack = [];
    const pairs = { '(': ')', '[': ']', '{': '}' };
    const closers = { ')': '(', ']': '[', '}': '{' };

    let i = 0;
    let line = 1;
    let quote = null;
    let quoteLine = 0;

    while (i < text.length) {
        const c = text[i];
        const next = text[i + 1];
        if (c === '\n') line++;

        if (quote) {
            if (c === '\\') { i += 2; continue; }
            // `${` inside a template literal leaves string mode and re-enters
            // it when the matching `}` is popped — otherwise the brace opened
            // here is never closed and every template looks unbalanced.
            if (quote === '`' && c === '$' && next === '{') {
                stack.push({ ch: '{', line, template: true });
                quote = null;
                i += 2;
                continue;
            }
            if (c === quote) { quote = null; }
            // An unterminated single-quoted string on one line is a lexer
            // error in C-like languages, but an apostrophe in a comment or a
            // Python docstring is not. Bail out of the string at end of line.
            else if (c === '\n' && quote !== '`') { quote = null; }
            i++;
            continue;
        }

        if (cStyle && c === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
        if (cStyle && c === '/' && next === '*') {
            i += 2;
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') line++; i++; }
            i += 2;
            continue;
        }
        if (hashComment && c === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }

        if (c === '"' || c === "'" || (cStyle && c === '`')) {
            // Python triple quotes: skip the whole block in one go.
            if (hashComment && text.slice(i, i + 3) === c.repeat(3)) {
                const close = text.indexOf(c.repeat(3), i + 3);
                if (close < 0) return { ok: false, message: `cadena triple sin cerrar abierta en la línea ${line}` };
                for (let k = i; k < close; k++) if (text[k] === '\n') line++;
                i = close + 3;
                continue;
            }
            quote = c;
            quoteLine = line;
            i++;
            continue;
        }

        if (pairs[c]) { stack.push({ ch: c, line }); i++; continue; }
        if (closers[c]) {
            const top = stack.pop();
            if (!top) return { ok: false, message: `"${c}" de más en la línea ${line} (no hay ningún "${closers[c]}" abierto)` };
            if (top.ch !== closers[c]) {
                return { ok: false, message: `"${c}" en la línea ${line} cierra un "${top.ch}" abierto en la línea ${top.line}` };
            }
            if (top.template) quote = '`'; // back inside the template literal
            i++;
            continue;
        }

        i++;
    }

    if (quote) return { ok: false, message: `cadena sin cerrar abierta en la línea ${quoteLine}` };
    if (stack.length) {
        const open = stack[stack.length - 1];
        return {
            ok: false,
            message: `falta cerrar "${open.ch}" abierto en la línea ${open.line} (${stack.length} delimitador${stack.length > 1 ? 'es' : ''} sin cerrar). El archivo parece incompleto.`
        };
    }
    return { ok: true };
}
