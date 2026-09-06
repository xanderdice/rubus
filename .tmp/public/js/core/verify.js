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
import { approvalPolicy } from './config.js';
import { truncateMiddle, stripAnsi } from './util.js';

const CONFLICT_RE = /^(<{7}|={7}|>{7})/m;

const ELISION_RE = /^\s*(?:\/\/|#|--)\s*\.{2,}\s*(?:rest|resto|remainder|existing|unchanged|sin cambios)/im;

/**
 * Comandos de test que estamos dispuestos a PROPONER sin que el usuario los
 * haya escrito. Proponer, no ejecutar: ver `authorize()`.
 *
 * La lista es cerrada a propósito, pero conviene ser muy claro sobre lo que
 * NO consigue. `npm test` no es un comando: es una indirección a
 * `scripts.test` del package.json **del repositorio que estamos analizando**,
 * que es contenido no auditado. Lo mismo `pytest` con sus conftest.py, o
 * `cargo test` con su build.rs. Filtrar la cadena no filtra lo que se ejecuta.
 *
 * Por eso la lista es sólo el primer filtro. El segundo depende de
 * `agent.approvalMode`: en 'manual' se pregunta una vez por comando, en 'auto'
 * se ejecuta y se avisa en el registro. Es una decisión del usuario, tomada a
 * sabiendas, no un descuido — pero conviene tenerla presente al tocar esto,
 * porque en 'auto' esta lista es lo único que hay entre el agente y el
 * `scripts.test` de un repositorio que quizá nadie ha leído.
 */
const AUTO_VERIFY_ALLOWED = new Set([
    'npm test', 'pnpm test', 'yarn test', 'bun test',
    'pytest', 'go test ./...', 'cargo test', 'dotnet test'
]);

export class Verifier {
    constructor({ platform, config, security, logger, repoMap = null }) {
        this.platform = platform;
        this.config = config;
        this.security = security;
        this.logger = logger;
        // Read-only, and never rebuilt from here: the map is invalidated after
        // every write, so asking it to build would re-walk the whole project
        // on every single verification.
        this.repoMap = repoMap;
        this._toolchain = null;
        this._announced = '';
        /** command -> true|false, una sola pregunta por comando y sesión. */
        this._authorized = new Map();
        /**
         * Estado de la suite ANTES de tocar nada: 'ok' | 'red' | null.
         *
         * Sin esto la verificación no distingue "lo has roto tú" de "ya estaba
         * roto": un repositorio con los tests en rojo por algo ajeno — faltan
         * dependencias, hace falta una base de datos, un test inestable —
         * convertía en fallo todos los pasos que tocaran un archivo, cada uno
         * reintentado tres veces ejecutando la suite entera. Verificar es
         * detectar una regresión, y una regresión no existe sin una línea base.
         */
        this._baseline = null;
    }

    /**
     * Olvida lo aprendido de un proyecto o de una tarea.
     *
     * Las dos cosas que guarda el verificador entre llamadas caducan, y no
     * hacerlo caducar hace daño en los dos sentidos: una línea base 'red'
     * medida en la tarea anterior desactiva la verificación para siempre, y una
     * 'ok' medida en OTRO proyecto hace que el primer fallo del nuevo se
     * atribuya al agente. La autorización tampoco puede sobrevivir a un cambio
     * de carpeta: se dio para el `npm test` de aquel repositorio, no para el
     * script de este.
     */
    reset({ keepAuthorizations = false } = {}) {
        this._baseline = null;
        this._announced = '';
        if (!keepAuthorizations) this._authorized.clear();
    }

    /**
     * Pregunta una vez por comando antes de ejecutar algo que el usuario no ha
     * escrito. Lo que él configuró a mano no pasa por aquí: ya lo autorizó al
     * escribirlo.
     */
    async authorize(command, source, requestApproval) {
        if (source !== 'detectado') return true;
        if (this._authorized.has(command)) return this._authorized.get(command);

        // En modo automático no se pregunta, pero se dice — una vez, y con el
        // comando delante. Es tu proyecto y su `npm test` es tuyo; el caso que
        // este aviso cubre es el otro, el repositorio que clonaste sin mirar,
        // donde `scripts.test` es código de un desconocido. Cambia a 'manual'
        // para que vuelva a preguntar, o apaga `verifyCommandAuto`.
        if (approvalPolicy(this.config).verifyCommand) {
            this._authorized.set(command, true);
            this.logger?.warn(
                `Se ejecutará "${command}" para verificar, detectado en el repositorio y sin preguntar ` +
                '(aprobación automática). Ese comando ejecuta el script de test del propio proyecto: ' +
                'si no lo has revisado, pon la aprobación en «manual» en Ajustes.'
            );
            return true;
        }

        if (typeof requestApproval !== 'function') {
            // Nadie a quien preguntar. Ejecutar código del repositorio por
            // omisión es exactamente lo que no debe pasar.
            this._authorized.set(command, false);
            this.logger?.warn(`No se ejecuta "${command}": es un comando detectado y no hay quien lo apruebe.`);
            return false;
        }

        const ok = !!(await requestApproval({
            kind: 'command',
            risk: 'caution',
            title: 'Verificar con los tests del proyecto',
            detail:
                `Rubus ha detectado que este proyecto se prueba con "${command}" y quiere ejecutarlo ` +
                'después de cada paso que modifique un archivo, para comprobar que el cambio no rompe nada.\n\n' +
                'Ojo: ese comando ejecuta el script de test DEL PROPIO REPOSITORIO. Si no lo has revisado, ' +
                'estás ejecutando código de terceros. Se pregunta una sola vez por ejecución.',
            command
        }));

        this._authorized.set(command, ok);
        if (!ok) this.logger?.info(`Verificación con "${command}" rechazada; sólo se comprobará la estructura.`);
        return ok;
    }

    /**
     * Ejecuta la suite ANTES del primer cambio para saber de qué color estaba.
     * Se llama una vez por tarea, justo antes de empezar a actuar.
     */
    async captureBaseline({ signal, requestApproval } = {}) {
        if (this._baseline) return this._baseline;
        if (!this.config.get('agent.autoVerify', true)) return null;

        const { command, source } = this.resolveCommand();
        if (!command) return null;

        // La misma puerta que projectCheck. Sin esto, un comando que el usuario
        // metió en «Comandos prohibidos» — cuya ayuda promete que no se ejecuta
        // nunca — sí se ejecutaba aquí, porque la línea base se saltaba el
        // clasificador entero.
        if (this.security.classifyCommand(command).risk === 'blocked') return null;
        if (!await this.authorize(command, source, requestApproval)) return null;

        const r = await this.runCommand(command, { signal });
        if (r.aborted || signal?.aborted) return null;

        this._baseline = r.ok ? 'ok' : 'red';
        if (this._baseline === 'red') {
            this.logger?.warn(
                `"${command}" ya fallaba ANTES de empezar (exit ${r.exitCode}). ` +
                'La verificación de proyecto queda desactivada para esta tarea: con la suite en rojo de ' +
                'partida no se puede distinguir una regresión de un fallo que ya estaba. Se seguirá ' +
                'comprobando la estructura de cada archivo.'
            );
        } else {
            this.logger?.info(`Línea base: "${command}" pasa. Un fallo a partir de ahora es una regresión.`);
        }
        return this._baseline;
    }

    /**
     * Which command verifies this project, and where it came from.
     *
     * What the user configured always wins. Otherwise the repo map has already
     * worked out how this project runs its tests while building the tree — that
     * detection was sitting there unused, and an agent that never runs the
     * tests is an agent whose "step completed" means "the braces balance".
     */
    resolveCommand() {
        const explicit = (this.config.get('agent.verifyCommand', '') || '').trim();
        if (explicit) return { command: explicit, source: 'configurado' };

        if (!this.config.get('agent.verifyCommandAuto', true)) {
            return { command: '', source: 'ninguno' };
        }

        const detected = (this.repoMap?.cache?.conventions?.testCommand || '').trim();
        if (!detected) return { command: '', source: 'ninguno' };
        if (!AUTO_VERIFY_ALLOWED.has(detected)) {
            return { command: '', source: 'ninguno', rejected: detected };
        }
        return { command: detected, source: 'detectado' };
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

    /**
     * The project's own check: its test command, run at the workspace root.
     *
     * This is the only verification level that can catch a change that parses
     * perfectly and is wrong. The structural checks answer "is this still
     * JavaScript"; only this one answers "does it still work".
     *
     * Cancellable: `signal` reaches `platform.exec`, which kills the command's
     * whole process tree. An aborted run reports `ran: false`, never a failure —
     * the user stopping the agent is not the step being broken.
     */
    async projectCheck({ signal, onOutput, requestApproval } = {}) {
        const root = this.config.get('workspace.root', '');
        if (!root) return { ran: false, reason: 'sin carpeta de trabajo' };

        const { command, source, rejected } = this.resolveCommand();
        if (!command) {
            return {
                ran: false,
                reason: rejected
                    ? `el comando detectado ("${rejected}") no está en la lista de comandos que se ejecutan solos`
                    : 'no hay comando de verificación'
            };
        }

        // La suite ya estaba en rojo cuando llegamos. Volver a ejecutarla en
        // cada paso sólo gasta minutos para reportar el mismo fallo ajeno.
        if (this._baseline === 'red') {
            return { ran: false, reason: `"${command}" ya fallaba antes de empezar; no se puede medir una regresión`, command };
        }

        const verdict = this.security.classifyCommand(command);
        if (verdict.risk === 'blocked') return { ran: false, reason: `comando bloqueado: ${verdict.why}`, command };

        if (!await this.authorize(command, source, requestApproval)) {
            return { ran: false, reason: `el usuario no autorizó ejecutar "${command}"`, command };
        }

        // Una vez por comando, no una por paso: el usuario debe saber que algo
        // está ejecutando su suite en su nombre, pero no quince veces.
        if (this._announced !== command) {
            this._announced = command;
            this.logger?.info(
                source === 'detectado'
                    ? `Verificación de proyecto: "${command}" (detectado del repositorio y autorizado por ti)`
                    : `Verificación de proyecto: "${command}" (configurado)`
            );
        }

        const r = await this.runCommand(command, { signal, onOutput });
        if (r.aborted) return { ran: false, reason: 'verificación cancelada', command };

        return { ...r, source };
    }

    /** Ejecuta el comando y normaliza el resultado. Sin políticas, sólo I/O. */
    async runCommand(command, { signal, onOutput } = {}) {
        const root = this.config.get('workspace.root', '');
        const r = await this.platform.exec(command, { cwd: root, timeoutMs: 300000, onOutput, signal });

        if (r.aborted || signal?.aborted) return { ran: false, aborted: true, command };

        const out = stripAnsi(`${r.stdout}\n${r.stderr}`).trim();
        return {
            ran: true,
            ok: r.exitCode === 0,
            command,
            exitCode: r.exitCode,
            durationMs: r.durationMs,
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
