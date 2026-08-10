/**
 * AgentCoder server — `npm start`.
 *
 * Serves the app AND gives it hands. In the Neutralino desktop shell the page
 * talks to the filesystem through the native API; in a browser it cannot, so
 * this process exposes the same three capabilities over HTTP — files, shell,
 * Ollama — and `public/js/platform/http.js` implements the platform contract
 * against them.
 *
 * ── Read this before exposing it to a network ────────────────────────────
 *
 * An endpoint that reads files and runs shell commands IS remote code
 * execution. That is the whole point of the program, and it is fine while it
 * listens on loopback, where anyone who can reach it could already run `node`
 * themselves. It stops being fine the moment it is reachable from elsewhere.
 *
 * So the defaults are deliberately timid and remote access is opt-in with
 * conditions that cannot be skipped:
 *
 *   local  (default)   127.0.0.1 only. No token. Full filesystem, same trust
 *                      as the user's own shell.
 *   remote (--host …)  Requires --root, which becomes a HARD boundary enforced
 *                      here, server-side, and requires a bearer token — one is
 *                      generated and printed if you do not supply it.
 *
 * The client-side sandbox in core/security.js still applies, but it is a
 * usability guard, not a security boundary: the client is untrusted from this
 * process's point of view, so every path is re-checked here.
 *
 * ── Orden de arranque ────────────────────────────────────────────────────
 *
 * Escuchar → abrir el navegador → comprobar Ollama. En ese orden y no en otro:
 * que Ollama esté caído no es motivo para no levantar la aplicación. La
 * interfaz sirve igual para navegar el proyecto, y lo más probable es que el
 * usuario esté arrancando `ollama serve` en la otra terminal justo ahora. Así
 * que la comprobación informa, no bloquea.
 *
 *   node server.js
 *   node server.js --port 4322 --root C:/proyectos --host 0.0.0.0 --token secreto
 *   node server.js --no-open        (no abrir el navegador)
 *   node server.js --no-exec        (sin shell)
 */

import http from 'node:http';
import { promises as fs, createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import nodePath from 'node:path';
import * as P from './public/js/platform/paths.js';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const PUBLIC = nodePath.join(HERE, 'public');

/** 4322 on purpose: 3000/8080 collide with whatever else you are running. */
const DEFAULT_PORT = 4322;

const args = parseArgs(process.argv.slice(2));

const PORT = Number(args.port || process.env.PORT || DEFAULT_PORT);
const HOST = args.host || process.env.HOST || '127.0.0.1';
const OLLAMA = (args.ollama || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const EXEC_ENABLED = !args['no-exec'];

const isLoopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
const ROOT = args.root ? P.normalize(nodePath.resolve(args.root)) : '';

let TOKEN = args.token || process.env.AGENTCODER_TOKEN || '';

if (!isLoopback) {
    if (!ROOT) {
        console.error(
            '\n  ✗ Para escuchar en ' + HOST + ' hace falta --root <carpeta>.\n\n' +
            '    En modo remoto la carpeta es un límite duro: el servidor no servirá\n' +
            '    ni escribirá nada fuera de ella. Sin ese límite estarías publicando\n' +
            '    tu disco entero y una shell en internet.\n\n' +
            '    Ejemplo:  node server.js --host 0.0.0.0 --root C:/proyectos/mi-app\n'
        );
        process.exit(2);
    }
    if (!TOKEN) {
        TOKEN = randomBytes(24).toString('base64url');
        console.log('\n  ⚠ Sin --token: se ha generado uno para esta sesión.\n');
    }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) out[key] = true;
        else { out[key] = next; i++; }
    }
    return out;
}

function json(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store'
    });
    res.end(text);
}

function readBody(req, limitBytes = 32 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > limitBytes) { reject(new Error('cuerpo demasiado grande')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

async function readJson(req) {
    const raw = await readBody(req);
    if (!raw.length) return {};
    try { return JSON.parse(raw.toString('utf8')); }
    catch { throw httpError(400, 'El cuerpo no es JSON válido.'); }
}

function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}

/**
 * Resolve a client-supplied path against the server's boundary.
 *
 * In remote mode ROOT is absolute law. In local mode there is no boundary —
 * the user is on their own machine — but the path is still normalised so the
 * rest of the code only ever sees one dialect.
 */
function resolvePath(input) {
    const raw = String(input ?? '').trim();
    if (!raw) throw httpError(400, 'Falta la ruta.');
    if (raw.includes('\0')) throw httpError(400, 'Ruta inválida.');

    const abs = ROOT ? P.resolve(ROOT, raw) : P.normalize(nodePath.resolve(raw));

    if (ROOT && !P.contains(ROOT, abs)) {
        throw httpError(403, `Fuera del límite del servidor (${ROOT}).`);
    }
    return abs;
}

/** Constant-time-ish compare so the token cannot be probed byte by byte. */
function tokenOk(given) {
    if (!TOKEN) return true;
    const a = Buffer.from(String(given || ''));
    const b = Buffer.from(TOKEN);
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

function authorize(req, url) {
    if (!TOKEN) return true;
    const header = req.headers.authorization || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    return tokenOk(bearer || url.searchParams.get('token'));
}

/* ── static files ────────────────────────────────────────────────────────── */

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4'
};

async function serveStatic(req, res, pathname) {
    // The Neutralino shell serves this virtual file to hand the page its port
    // and token. Under this server there is no shell, so answer with an empty
    // script and let the platform detector fall through to the HTTP adapter.
    if (pathname === '/__neutralino_globals.js') {
        res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' });
        res.end('/* servido por server.js: sin shell nativo */\n');
        return;
    }

    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = nodePath.join(PUBLIC, rel);

    // Traversal guard: the resolved path must stay under public/.
    if (!file.startsWith(PUBLIC)) { json(res, 403, { error: 'prohibido' }); return; }

    let stat;
    try { stat = await fs.stat(file); } catch { json(res, 404, { error: 'no encontrado', path: rel }); return; }
    if (stat.isDirectory()) { json(res, 404, { error: 'no encontrado', path: rel }); return; }

    res.writeHead(200, {
        'Content-Type': TYPES[nodePath.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        // The app is developed live; a cached module is a confusing bug report.
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });

    // Same trap as the proxy: a bare `.pipe()` leaves 'error' unhandled, and a
    // reload part-way through a file would then take the process down.
    try {
        await pipeline(createReadStream(file), res);
    } catch (err) {
        if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && err.code !== 'EPIPE') {
            console.error(`[static ${rel}]`, err.message);
        }
        if (!res.writableEnded) res.end();
    }
}

/* ── filesystem API ──────────────────────────────────────────────────────── */

const fsRoutes = {
    async list({ path }) {
        const abs = resolvePath(path);
        let entries;
        try { entries = await fs.readdir(abs, { withFileTypes: true }); }
        catch (err) { if (err.code === 'ENOENT') return { entries: [] }; throw err; }
        return {
            entries: entries.map(e => ({
                name: e.name,
                path: P.join(P.normalize(abs), e.name),
                isDirectory: e.isDirectory()
            }))
        };
    },

    async read({ path }) {
        const abs = resolvePath(path);
        try {
            return { content: await fs.readFile(abs, 'utf8') };
        } catch (err) {
            // A missing file is an ordinary answer, not a server fault. Left as
            // a 500 it fills the log with stack traces for things like the
            // agent's own "does my log file exist yet?" check.
            if (err.code === 'ENOENT') throw httpError(404, `No existe: ${path}`);
            if (err.code === 'EISDIR') throw httpError(400, `Es una carpeta, no un archivo: ${path}`);
            if (err.code === 'EACCES' || err.code === 'EPERM') throw httpError(403, `Sin permiso para leer: ${path}`);
            throw err;
        }
    },

    async write({ path, content }) {
        const abs = resolvePath(path);
        await fs.mkdir(nodePath.dirname(abs), { recursive: true });
        await fs.writeFile(abs, String(content ?? ''), 'utf8');
        return { ok: true };
    },

    async stat({ path }) {
        const abs = resolvePath(path);
        try {
            const s = await fs.stat(abs);
            return { stat: { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs } };
        } catch {
            return { stat: null };
        }
    },

    async mkdir({ path }) {
        await fs.mkdir(resolvePath(path), { recursive: true });
        return { ok: true };
    },

    async remove({ path }) {
        await fs.rm(resolvePath(path), { recursive: true, force: true });
        return { ok: true };
    },

    /** Drive letters / roots, for the folder picker in the browser. */
    async roots() {
        if (ROOT) return { roots: [ROOT] };
        if (process.platform !== 'win32') return { roots: ['/'] };
        const found = [];
        for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
            try { await fs.access(`${letter}:\\`); found.push(`${letter}:/`); } catch { /* no such drive */ }
        }
        return { roots: found.length ? found : ['C:/'] };
    }
};

/* ── exec API ────────────────────────────────────────────────────────────── */

/**
 * Streams NDJSON as the command runs: `{stream,text}` lines then a final
 * `{done:true,exitCode}`. Same shape the Ollama client already knows how to
 * read, so the browser side reuses that parser and the terminal panel fills in
 * live instead of in one lump at the end.
 */
async function execRoute(req, res, body) {
    if (!EXEC_ENABLED) { json(res, 403, { error: 'La ejecución de comandos está desactivada (--no-exec).' }); return; }

    const command = String(body.command || '').trim();
    if (!command) { json(res, 400, { error: 'Falta el comando.' }); return; }

    const cwd = body.cwd ? resolvePath(body.cwd) : (ROOT || process.cwd());
    const timeoutMs = Math.min(Number(body.timeoutMs) || 120000, 900000);

    res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no'
    });

    const isWindows = process.platform === 'win32';
    const shell = isWindows
        ? { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
        : { cmd: '/bin/sh', args: ['-c', command] };

    const started = Date.now();
    let child;
    try {
        child = spawn(shell.cmd, shell.args, { cwd, windowsVerbatimArguments: isWindows, windowsHide: true });
    } catch (err) {
        res.end(JSON.stringify({ done: true, exitCode: -1, stderr: String(err.message || err) }) + '\n');
        return;
    }

    // Same reasoning as the proxy: a write to a socket the client already
    // closed emits 'error', and an unhandled one would end the process.
    res.on('error', () => { try { child.kill('SIGKILL'); } catch { /* ya murió */ } });

    const send = (obj) => {
        if (res.writableEnded) return;
        try { res.write(JSON.stringify(obj) + '\n'); } catch { /* cliente desconectado */ }
    };

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* ya murió */ } }, timeoutMs);

    // If the client hangs up, kill the child. Otherwise an abandoned `npm
    // install` keeps running with nobody reading it.
    req.on('close', () => { try { child.kill('SIGKILL'); } catch { /* ya murió */ } });

    child.stdout.on('data', (b) => send({ stream: 'stdout', text: b.toString() }));
    child.stderr.on('data', (b) => send({ stream: 'stderr', text: b.toString() }));
    child.on('error', (err) => send({ stream: 'stderr', text: String(err.message || err) }));
    child.on('close', (code) => {
        clearTimeout(timer);
        send({ done: true, exitCode: code === null ? -1 : code, timedOut, durationMs: Date.now() - started });
        res.end();
    });
}

/* ── Ollama proxy ────────────────────────────────────────────────────────── */

/**
 * Why proxy instead of letting the page call Ollama directly:
 *
 *  · Served over HTTPS, a browser blocks `http://127.0.0.1` as mixed content.
 *  · Ollama sends no CORS headers, so a cross-origin call fails anyway.
 *  · Deployed remotely, "localhost" means the SERVER's machine, which is where
 *    the model actually lives.
 */
async function ollamaProxy(req, res, pathname) {
    const target = OLLAMA + pathname.replace(/^\/api\/ollama/, '');

    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') body = await readBody(req);

    // When the browser gives up on a generation — a cancelled run, a reload, a
    // retry — stop generating too. Without this, Ollama keeps burning GPU on a
    // response nobody will ever read, and the next request queues behind it.
    //
    // The listener goes on `res`, NOT on `req`. An IncomingMessage emits
    // 'close' as soon as its body has been fully consumed, which for a POST is
    // immediately — so listening there aborts every generation before it
    // starts. (It did. Every chat request failed instantly while /api/tags,
    // being a GET with no body, kept working, which made it look like a
    // problem with POST bodies.)
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableEnded) abort.abort(); });

    let upstream;
    try {
        upstream = await fetch(target, {
            method: req.method,
            headers: { 'Content-Type': req.headers['content-type'] || 'application/json' },
            body,
            signal: abort.signal
        });
    } catch (err) {
        if (abort.signal.aborted) { if (!res.writableEnded) res.end(); return; }
        json(res, 502, {
            error: `No se puede contactar con Ollama en ${OLLAMA}. ¿Está corriendo "ollama serve"?`,
            detail: String(err && err.message || err)
        });
        return;
    }

    res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no'
    });

    if (!upstream.body) { res.end(Buffer.from(await upstream.arrayBuffer())); return; }

    // Streamed straight through: token-by-token output must not be buffered.
    //
    // `pipeline` rather than `.pipe()`, and this is not a style preference: a
    // bare pipe leaves the 'error' event on `res` unhandled, so a client that
    // disconnects mid-generation raises an uncaught exception and takes the
    // WHOLE SERVER down with it. It did exactly that, once, and the symptom was
    // "everything worked until suddenly nothing did".
    try {
        await pipeline(Readable.fromWeb(upstream.body), res);
    } catch (err) {
        // A client hanging up is routine; anything else is worth a line.
        if (!abort.signal.aborted && err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && err.code !== 'EPIPE') {
            console.error('[proxy ollama] stream interrumpido:', err.message);
        }
        if (!res.writableEnded) res.end();
    }
}

/* ── router ──────────────────────────────────────────────────────────────── */

const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
    catch { json(res, 400, { error: 'URL inválida' }); return; }

    const pathname = decodeURIComponent(url.pathname);

    try {
        if (!pathname.startsWith('/api/')) {
            if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'método no permitido' }); return; }
            await serveStatic(req, res, pathname);
            return;
        }

        // /api/ping is deliberately open: the client uses it to discover
        // whether a backend exists at all, and whether it needs a token.
        if (pathname === '/api/ping') {
            json(res, 200, {
                ok: true,
                name: 'agentcoder',
                version: '0.1.0',
                mode: isLoopback ? 'local' : 'remote',
                root: ROOT || null,
                execEnabled: EXEC_ENABLED,
                needsToken: !!TOKEN,
                authorized: authorize(req, url),
                platform: process.platform,
                ollama: OLLAMA
            });
            return;
        }

        if (!authorize(req, url)) { json(res, 401, { error: 'Token inválido o ausente.' }); return; }

        if (pathname.startsWith('/api/ollama')) { await ollamaProxy(req, res, pathname); return; }

        if (pathname === '/api/exec') {
            if (req.method !== 'POST') { json(res, 405, { error: 'usa POST' }); return; }
            await execRoute(req, res, await readJson(req));
            return;
        }

        const fsMatch = pathname.match(/^\/api\/fs\/([a-z]+)$/);
        if (fsMatch && fsRoutes[fsMatch[1]]) {
            if (req.method !== 'POST') { json(res, 405, { error: 'usa POST' }); return; }
            json(res, 200, await fsRoutes[fsMatch[1]](await readJson(req)));
            return;
        }

        json(res, 404, { error: `Ruta desconocida: ${pathname}` });
    } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error(`[${req.method} ${pathname}]`, err);
        if (!res.headersSent) json(res, status, { error: err.message || 'error interno' });
        else res.end();
    }
});

server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

/**
 * Last line of defence.
 *
 * Every known crash path is handled above; this is for the unknown ones. A
 * long agent run can be twenty minutes of work, and losing the server halfway
 * through loses all of it — with a symptom ("Failed to fetch") that points at
 * the browser rather than at the real culprit. Staying up with a loud log line
 * is strictly better than dying quietly.
 */
process.on('uncaughtException', (err) => {
    console.error('\n[servidor] excepción no capturada — se continúa:\n', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('\n[servidor] promesa rechazada sin manejar — se continúa:\n', reason);
});

/* ── arranque ────────────────────────────────────────────────────────────── */

/**
 * Open the app in the default browser.
 *
 * Detached and unref'd: the launcher must not become a child this process has
 * to wait on, or Ctrl+C on the server would leave it hanging. Failure is
 * ignored on purpose — a headless box has no browser, and that is not an error
 * worth stopping the server for. The URL is always printed anyway.
 */
function openBrowser(url) {
    const byPlatform = {
        // The empty "" is the window title `start` expects; without it the URL
        // is swallowed as the title and nothing opens.
        win32: ['cmd', ['/c', 'start', '""', url]],
        darwin: ['open', [url]]
    };
    const [cmd, cmdArgs] = byPlatform[process.platform] || ['xdg-open', [url]];

    try {
        spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        return true;
    } catch {
        return false;
    }
}

/**
 * Is Ollama up, and does it have anything usable?
 *
 * Runs AFTER the server is listening, never before. Ollama being down is not a
 * reason to refuse to start: the UI is perfectly useful for browsing the
 * project, and the user may well be starting Ollama in the other terminal
 * right now. So this reports, it does not gate.
 */
async function checkOllama() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);

    try {
        const res = await fetch(`${OLLAMA}/api/tags`, { signal: ctrl.signal });
        if (!res.ok) return { ok: false, reason: `respondió HTTP ${res.status}` };
        const data = await res.json();
        return { ok: true, models: (data.models || []).map(m => m.name) };
    } catch (err) {
        return { ok: false, reason: err.name === 'AbortError' ? 'no respondió en 5s' : 'no hay nada escuchando' };
    } finally {
        clearTimeout(timer);
    }
}

/** Models this harness is actually tuned for, best first. */
function pickSuggested(models) {
    const rank = (n) => /^qwen3\.6/i.test(n) ? 0 : /^qwen3/i.test(n) ? 1 : /gemma4/i.test(n) ? 2 : /gemma/i.test(n) ? 3 : 9;
    return [...models].sort((a, b) => rank(a) - rank(b))[0];
}

server.listen(PORT, HOST, async () => {
    const shown = isLoopback ? '127.0.0.1' : HOST;
    const url = `http://${shown}:${PORT}${TOKEN ? `/?token=${TOKEN}` : ''}`;

    console.log('');
    console.log('  AgentCoder');
    console.log(`  ▸ http://${shown}:${PORT}`);
    console.log(`  ▸ modo:   ${isLoopback ? 'local (sólo esta máquina)' : 'REMOTO — accesible desde la red'}`);
    console.log(`  ▸ raíz:   ${ROOT || 'sin límite (elige la carpeta desde la app)'}`);
    console.log(`  ▸ shell:  ${EXEC_ENABLED ? 'activada' : 'desactivada (--no-exec)'}`);
    if (TOKEN) {
        console.log('');
        console.log(`  ▸ token:  ${TOKEN}`);
        console.log(`    Ábrelo con:  ${url}`);
    }
    if (!isLoopback) {
        console.log('');
        console.log('  ⚠ Este servidor lee archivos y ejecuta comandos. Expuesto a una red');
        console.log('    hostil es ejecución remota de código. Úsalo sólo en redes de confianza');
        console.log('    y detrás de HTTPS si sale de tu LAN.');
    }

    // The front end comes up first. Only a remote listener is left alone — there
    // the browser belongs to whoever connects, not to this machine.
    console.log('');
    if (args['no-open'] || !isLoopback) {
        console.log(`  ▸ abre la app en:  ${url}`);
    } else if (openBrowser(url)) {
        console.log('  ▸ abriendo el navegador…');
    } else {
        console.log(`  ▸ no se pudo abrir el navegador. Ábrelo tú:  ${url}`);
    }

    // …and only then do we go looking for Ollama.
    const ollama = await checkOllama();
    if (ollama.ok && ollama.models.length) {
        const suggested = pickSuggested(ollama.models);
        console.log(`  ▸ ollama: ${OLLAMA} — ${ollama.models.length} modelo(s), se usará "${suggested}"`);
    } else if (ollama.ok) {
        console.log(`  ▸ ollama: ${OLLAMA} — conectado, pero SIN MODELOS`);
        console.log('            descarga uno:  ollama pull qwen3.6');
    } else {
        console.log(`  ▸ ollama: ${OLLAMA} — NO DISPONIBLE (${ollama.reason})`);
        console.log('            arráncalo en otra terminal:  ollama serve');
        console.log('            la app funciona igual; recarga la página cuando esté listo.');
    }

    console.log('');
    console.log('  Ctrl+C para parar.');
    console.log('');
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n  ✗ El puerto ${PORT} ya está ocupado.\n    Prueba: node server.js --port ${PORT + 1}\n`);
        process.exit(1);
    }
    console.error(err);
    process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { console.log('\n  parando…'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500); });
}
