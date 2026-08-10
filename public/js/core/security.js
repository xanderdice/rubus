/**
 * The part of the harness that assumes the model is wrong.
 *
 * Two jobs:
 *
 *  1. Every path a tool touches is resolved against the workspace root and
 *     rejected if it lands outside. This is enforced here, not in the prompt —
 *     a prompt rule is a suggestion, and `../../../Windows/System32` is exactly
 *     the kind of thing a confused 8B model emits when it loses track of cwd.
 *
 *  2. Shell commands are graded, not trusted. The grade decides whether the
 *     command runs unattended, asks the user first, or never runs at all.
 *     Grading is conservative by construction: a chain is only as safe as its
 *     least safe link, and anything unrecognised is NOT safe.
 */

// paths.js lives under platform/ because it encodes the OS path dialect, but
// it is pure — no fs, no globals — so core/ may depend on it.
import * as P from '../platform/paths.js';

export const RISK = Object.freeze({
    SAFE: 'safe',           // read-only inspection — may run unattended
    CAUTION: 'caution',     // ordinary side effects — ask first
    DANGEROUS: 'dangerous', // destructive or outward-facing — ask loudly
    BLOCKED: 'blocked'      // never, whatever the user or the model says
});

/**
 * Read-only commands. Matched against the *head* of each link in a chain, so
 * `git status --porcelain` matches `git status` but `git statusx` does not.
 */
const SAFE_COMMANDS = [
    'git status', 'git diff', 'git log', 'git show', 'git branch', 'git remote -v',
    'git ls-files', 'git rev-parse', 'git describe', 'git blame', 'git stash list',
    'ls', 'dir', 'pwd', 'cd', 'tree', 'whoami', 'hostname', 'date',
    'cat', 'type', 'head', 'tail', 'wc', 'find', 'where', 'which',
    'echo', 'grep', 'rg', 'findstr', 'sort', 'diff', 'fc',
    'node --version', 'node -v', 'npm --version', 'npm -v', 'npm ls', 'npm list',
    'python --version', 'python -V', 'py --version', 'pip list', 'pip --version',
    'dotnet --version', 'java -version', 'go version', 'cargo --version',
    'rustc --version', 'tsc --version', 'deno --version', 'bun --version',
    'node --check', 'python -m py_compile', 'tsc --noEmit',
    'ollama list', 'ollama ps'
];

/** Ordinary work: builds, tests, installs. Real side effects, no gunfire. */
const CAUTION_COMMANDS = [
    'npm test', 'npm run', 'npm ci', 'npm install', 'npm i', 'npx',
    'yarn', 'pnpm', 'bun run', 'bun install',
    'python', 'py', 'pytest', 'pip install',
    'node', 'deno run', 'tsc', 'go build', 'go test', 'go run',
    'cargo build', 'cargo test', 'cargo run', 'dotnet build', 'dotnet test', 'dotnet run',
    'make', 'gradle', 'mvn', 'msbuild',
    'mkdir', 'md', 'copy', 'cp', 'move', 'mv', 'ren', 'rename', 'touch',
    'git add', 'git commit', 'git checkout', 'git switch', 'git restore',
    'git stash', 'git merge', 'git rebase', 'git init', 'git tag'
];

/** Allowed, but the user has to look at it first. */
const DANGEROUS_PATTERNS = [
    { re: /\brm\b/i, why: 'borra archivos' },
    { re: /\bdel\b|\berase\b/i, why: 'borra archivos' },
    { re: /\brmdir\b|\brd\b/i, why: 'borra carpetas' },
    { re: /\bgit\s+push\b/i, why: 'publica cambios en un remoto' },
    { re: /\bgit\s+reset\s+--hard\b/i, why: 'descarta cambios locales de forma irreversible' },
    { re: /\bgit\s+clean\b/i, why: 'borra archivos no rastreados' },
    { re: /\bnpm\s+publish\b|\byarn\s+publish\b/i, why: 'publica un paquete' },
    { re: /\bcurl\b|\bwget\b|\bInvoke-WebRequest\b|\biwr\b/i, why: 'descarga contenido de la red' },
    { re: /\bssh\b|\bscp\b|\bftp\b/i, why: 'abre una conexión remota' },
    { re: /\bkill\b|\btaskkill\b|\bStop-Process\b/i, why: 'mata procesos del sistema' },
    { re: /\bchmod\b|\bchown\b|\bicacls\b|\btakeown\b/i, why: 'cambia permisos' },
    { re: /\bdocker\b|\bkubectl\b/i, why: 'controla contenedores o clústeres' },
    { re: />\s*[^|\s]/, why: 'redirige la salida y puede sobrescribir un archivo' }
];

/** Never. Not with confirmation, not with a flag. */
const BLOCKED_PATTERNS = [
    { re: /\brm\s+(-[a-z]*\s+)*-?[rf]{1,2}\s+[/\\]\s*($|&|\|)/i, why: 'borrado recursivo de la raíz' },
    { re: /\bformat\s+[a-z]:/i, why: 'formatea una unidad' },
    { re: /\bmkfs\b|\bdiskpart\b/i, why: 'destruye sistemas de archivos' },
    { re: /\bdd\s+if=/i, why: 'escritura de bloques en crudo' },
    { re: /\bdel\s+\/[sfq]\s+[a-z]:\\?\s*($|&|\|)/i, why: 'borrado masivo de una unidad' },
    { re: /\bshutdown\b|\breboot\b|\bhalt\b/i, why: 'apaga o reinicia la máquina' },
    { re: /\breg\s+(delete|add)\s+hk(lm|cu|cr)/i, why: 'modifica el registro de Windows' },
    { re: /\bnet\s+user\b|\bnet\s+localgroup\b/i, why: 'modifica cuentas de usuario' },
    { re: /\bbcdedit\b|\bvssadmin\b|\bcipher\s+\/w/i, why: 'toca el arranque o las copias de seguridad' },
    { re: /:\(\)\s*\{.*\}\s*;?\s*:/, why: 'fork bomb' },
    // Remote code execution: fetch something and pipe it into a shell.
    { re: /(curl|wget|iwr|Invoke-WebRequest)[^|]*\|\s*(ba)?sh\b/i, why: 'ejecuta código descargado de internet' },
    { re: /(iwr|Invoke-WebRequest|curl)[^|]*\|\s*(iex|Invoke-Expression)/i, why: 'ejecuta código descargado de internet' },
    { re: /\bSet-ExecutionPolicy\b/i, why: 'baja las defensas de PowerShell' },
    { re: /\bAdd-MpPreference\b|\bSet-MpPreference\b/i, why: 'modifica la configuración del antivirus' }
];

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

export class Security {
    constructor(config) {
        this.config = config;
    }

    get root() {
        return P.normalize(this.config.get('workspace.root', ''));
    }

    /**
     * Turn a model-supplied path into an absolute path we are willing to touch.
     * Throws with a message meant to be fed straight back to the model.
     */
    resolvePath(input, { write = false } = {}) {
        const root = this.root;
        if (!root) throw refuse('No hay carpeta de trabajo seleccionada.');

        const raw = String(input ?? '').trim();
        if (!raw) throw refuse('La ruta está vacía.');
        if (raw.includes('\0')) throw refuse('La ruta contiene caracteres nulos.');

        const abs = P.resolve(root, raw);

        if (!this.config.get('security.allowOutsideRoot', false) && !P.contains(root, abs)) {
            throw refuse(
                `La ruta "${raw}" queda fuera de la carpeta de trabajo (${root}). ` +
                `Usa una ruta relativa dentro del proyecto.`
            );
        }

        const rel = P.relative(root, abs);
        const parts = rel.split('/');

        if (parts.some(seg => WIN_RESERVED.test(seg))) {
            throw refuse(`"${raw}" usa un nombre reservado de Windows.`);
        }

        if (write) {
            // Writing into .git turns a recoverable mistake into a lost repo.
            if (parts[0] === '.git') throw refuse('No se puede escribir dentro de .git.');
            if (parts[0] === '.agentcoder') throw refuse('No se puede escribir en .agentcoder (registros del propio agente).');
            if (parts.includes('node_modules')) throw refuse('No se puede escribir dentro de node_modules.');
        }

        return { abs, rel: rel === '.' ? '' : rel, root };
    }

    /**
     * Grade a shell command. A chain (`a && b`, `a | b`, `a; b`) is graded link
     * by link and takes the worst grade of any link — the model does not get to
     * launder a dangerous command by attaching it to a safe one.
     */
    classifyCommand(command) {
        const cmd = String(command ?? '').trim();
        if (!cmd) return { risk: RISK.BLOCKED, why: 'Comando vacío.' };

        if (!this.config.get('security.allowShell', true)) {
            return { risk: RISK.BLOCKED, why: 'La ejecución de comandos está desactivada en Ajustes.' };
        }

        for (const pat of [...BLOCKED_PATTERNS, ...customPatterns(this.config.get('security.extraBlockedCommands', []))]) {
            if (pat.re.test(cmd)) return { risk: RISK.BLOCKED, why: `Bloqueado: ${pat.why}.` };
        }

        // Command substitution can hide anything at all inside a safe-looking
        // wrapper, so it never qualifies for unattended execution.
        const hasSubstitution = /\$\(|`|\$\{/.test(cmd);

        let worst = RISK.SAFE;
        const reasons = [];
        for (const link of splitChain(cmd)) {
            const grade = this.classifyLink(link);
            if (grade.why) reasons.push(grade.why);
            worst = worseOf(worst, grade.risk);
        }
        if (hasSubstitution) {
            worst = worseOf(worst, RISK.CAUTION);
            reasons.push('contiene sustitución de comandos');
        }

        return { risk: worst, why: reasons.filter(Boolean).join('; ') };
    }

    classifyLink(link) {
        const s = link.trim();
        if (!s) return { risk: RISK.SAFE };

        for (const pat of DANGEROUS_PATTERNS) {
            if (pat.re.test(s)) return { risk: RISK.DANGEROUS, why: pat.why };
        }

        const extraSafe = (this.config.get('security.extraSafeCommands', []) || [])
            .map(x => String(x).toLowerCase().trim())
            .filter(Boolean);

        const lower = s.toLowerCase();
        if ([...SAFE_COMMANDS, ...extraSafe].some(p => startsWithCommand(lower, p))) {
            return { risk: RISK.SAFE };
        }
        if (CAUTION_COMMANDS.some(p => startsWithCommand(lower, p))) {
            return { risk: RISK.CAUTION };
        }

        return { risk: RISK.CAUTION, why: `"${firstWord(s)}" no está en la lista de comandos conocidos` };
    }
}

function refuse(message) {
    const e = new Error(message);
    e.code = 'SECURITY';
    e.userFacing = true;
    return e;
}

function customPatterns(list) {
    return (list || []).map(x => ({ re: new RegExp(String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), why: `coincide con una regla del usuario (${x})` }));
}

/** Split on shell operators, ignoring anything inside quotes. */
export function splitChain(cmd) {
    const out = [];
    let buf = '';
    let quote = null;
    for (let i = 0; i < cmd.length; i++) {
        const c = cmd[i];
        if (quote) {
            buf += c;
            if (c === quote && cmd[i - 1] !== '\\') quote = null;
            continue;
        }
        if (c === '"' || c === "'") { quote = c; buf += c; continue; }
        if (c === ';' || c === '\n') { out.push(buf); buf = ''; continue; }
        if ((c === '&' || c === '|') && cmd[i + 1] === c) { out.push(buf); buf = ''; i++; continue; }
        if (c === '|') { out.push(buf); buf = ''; continue; }
        buf += c;
    }
    out.push(buf);
    return out.filter(s => s.trim());
}

/** `git status --porcelain` starts with `git status`; `gitx status` does not. */
function startsWithCommand(lower, prefix) {
    if (!lower.startsWith(prefix)) return false;
    const next = lower[prefix.length];
    return next === undefined || next === ' ' || next === '\t';
}

function firstWord(s) {
    return s.trim().split(/\s+/)[0] || s;
}

const ORDER = { [RISK.SAFE]: 0, [RISK.CAUTION]: 1, [RISK.DANGEROUS]: 2, [RISK.BLOCKED]: 3 };
function worseOf(a, b) {
    return ORDER[b] > ORDER[a] ? b : a;
}
