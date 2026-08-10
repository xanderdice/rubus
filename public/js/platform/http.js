/**
 * HTTP platform adapter — the browser's hands.
 *
 * Implements the same contract as the Neutralino and Node adapters, but every
 * operation is a call to `server.js`. This is what makes the app work as an
 * ordinary web page, served from localhost or from somewhere else entirely.
 *
 * Two details that are not obvious:
 *
 *  · `exec` reads a streaming NDJSON response so the terminal panel fills in
 *    line by line while the command runs, instead of freezing until it exits.
 *    There is a non-streaming fallback for browsers that do not expose
 *    `response.body` — some older Safari builds and a few in-app webviews.
 *
 *  · Ollama is reached through the server, never directly. A page served over
 *    HTTPS cannot call `http://127.0.0.1` (mixed content), Ollama sends no CORS
 *    headers, and when the app is deployed remotely "localhost" means the
 *    server's machine anyway — which is where the model actually is.
 */

import * as P from './paths.js';

export function createHttpPlatform(info, token) {
    const base = '';                 // same origin as the page
    const auth = token ? { Authorization: `Bearer ${token}` } : {};

    async function api(route, payload) {
        let res;
        try {
            res = await fetch(`${base}/api/${route}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...auth },
                body: JSON.stringify(payload || {})
            });
        } catch (err) {
            const e = new Error(`Sin conexión con el servidor de Rubus (${route}).`);
            e.code = 'NO_SERVER';
            throw e;
        }

        if (!res.ok) {
            let message = `${res.status}`;
            try { message = (await res.json()).error || message; } catch { /* respuesta no JSON */ }
            const e = new Error(message);
            e.code = res.status === 401 ? 'UNAUTHORIZED' : res.status === 403 ? 'FORBIDDEN' : 'HTTP';
            e.status = res.status;
            throw e;
        }
        return await res.json();
    }

    const fsApi = {
        async readText(path) {
            return (await api('fs/read', { path })).content;
        },
        async writeText(path, content) {
            await api('fs/write', { path, content });
        },
        async stat(path) {
            try { return (await api('fs/stat', { path })).stat; }
            catch { return null; }
        },
        async exists(path) {
            return (await fsApi.stat(path)) !== null;
        },
        async readDir(path) {
            try { return (await api('fs/list', { path })).entries; }
            catch { return []; }
        },
        async mkdirp(path) {
            await api('fs/mkdir', { path });
        },
        async remove(path) {
            await api('fs/remove', { path });
        }
    };

    async function exec(command, opts = {}) {
        const { cwd, timeoutMs = 120000, onOutput } = opts;
        const started = Date.now();

        let res;
        try {
            res = await fetch(`${base}/api/exec`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...auth },
                body: JSON.stringify({ command, cwd, timeoutMs })
            });
        } catch (err) {
            return { stdout: '', stderr: `Sin conexión con el servidor: ${err.message}`, exitCode: -1, timedOut: false, durationMs: 0 };
        }

        if (!res.ok) {
            let message = `HTTP ${res.status}`;
            try { message = (await res.json()).error || message; } catch { /* no JSON */ }
            return { stdout: '', stderr: message, exitCode: -1, timedOut: false, durationMs: Date.now() - started };
        }

        let stdout = '';
        let stderr = '';
        let exitCode = -1;
        let timedOut = false;

        const handle = (line) => {
            let msg;
            try { msg = JSON.parse(line); } catch { return; }
            if (msg.done) { exitCode = msg.exitCode; timedOut = !!msg.timedOut; return; }
            const text = String(msg.text || '');
            if (msg.stream === 'stderr') stderr += text; else stdout += text;
            if (onOutput) { try { onOutput(msg.stream, text); } catch { /* sólo UI */ } }
        };

        if (res.body && typeof res.body.getReader === 'function') {
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                let nl;
                while ((nl = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    if (line) handle(line);
                }
            }
            if (buf.trim()) handle(buf.trim());
        } else {
            // No streaming body available: take it all at the end. The command
            // still runs correctly, the terminal just fills in at once.
            for (const line of (await res.text()).split('\n')) {
                if (line.trim()) handle(line.trim());
            }
        }

        return {
            stdout,
            stderr: timedOut ? `${stderr}\n[timeout tras ${timeoutMs}ms]`.trim() : stderr,
            exitCode,
            timedOut,
            durationMs: Date.now() - started
        };
    }

    return {
        kind: 'http',
        isWindows: (info.platform || '').startsWith('win'),
        /** Set when the server enforces a hard boundary (remote mode). */
        serverRoot: info.root || '',
        execEnabled: info.execEnabled !== false,
        /** The engine points its Ollama client here instead of at a raw host. */
        ollamaBase: `${base}/api/ollama`,
        token,

        fs: fsApi,
        exec,

        // Children live in the server process; it kills them when the request
        // socket closes, which happens as soon as the fetch is aborted.
        killAll: async () => {},

        storage: {
            async get(key) {
                try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
            },
            async set(key, value) {
                try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* modo privado */ }
            }
        },

        fetch: (...a) => globalThis.fetch(...a),
        cwd: () => info.root || '',
        appPath: () => '',
        home: async () => info.root || '',
        env: async () => '',

        /** Drive letters, so the folder picker can offer somewhere to start. */
        async roots() {
            try { return (await api('fs/roots', {})).roots; } catch { return []; }
        },

        pickDirectory: async () => null,   // no native dialog in a browser
        openExternal: async (url) => { globalThis.open(url, '_blank', 'noopener'); }
    };
}

/**
 * Ask the origin whether an Rubus server is behind it.
 *
 * Returns null when there is none, so the caller can fall back to the degraded
 * browser platform instead of hanging. The token, if any, comes from the URL
 * (`?token=…`) on first visit and is remembered from then on.
 */
export async function probeServer() {
    const stored = readStoredToken();
    const fromUrl = new URLSearchParams(location.search).get('token');
    const token = fromUrl || stored || '';

    let res;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 4000);
        res = await fetch(`/api/ping${token ? `?token=${encodeURIComponent(token)}` : ''}`, {
            signal: ctrl.signal,
            headers: token ? { Authorization: `Bearer ${token}` } : {}
        });
        clearTimeout(timer);
    } catch {
        return null;
    }

    if (!res.ok) return null;

    let info;
    try { info = await res.json(); } catch { return null; }
    if (!info || info.name !== 'agentcoder') return null;

    if (fromUrl) {
        storeToken(fromUrl);
        // Keep the token out of the address bar, history and any copy-paste of
        // the URL; it is already in storage by this point.
        try { history.replaceState(null, '', location.pathname); } catch { /* file:// */ }
    }

    return { info, token: info.needsToken ? token : '' };
}

const TOKEN_KEY = 'agentcoder.token';

function readStoredToken() {
    try { return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || ''; }
    catch { return ''; }
}

function storeToken(token) {
    try { localStorage.setItem(TOKEN_KEY, token); } catch { /* modo privado */ }
}

export function forgetToken() {
    try { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); } catch { /* nada que hacer */ }
}

/** Exposed for the folder picker, which needs a sensible starting point. */
export function defaultStart(platform) {
    return platform.serverRoot || (platform.isWindows ? 'C:/' : '/');
}

export { P };
