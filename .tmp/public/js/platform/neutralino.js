/**
 * Neutralino platform adapter — the desktop shell's half of the contract in
 * `./index.js`. Nothing in core/ imports this file directly; it is handed in.
 *
 * Two things here are less obvious than they look:
 *
 *  - `exec` goes through spawnProcess, not execCommand. execCommand cannot be
 *    cancelled and has no timeout, so one `npm install` that hangs would wedge
 *    the agent forever with no way back. spawnProcess gives us an id we can
 *    kill, and streams output while it runs, which is what feeds the terminal
 *    panel line by line instead of in one lump at the end.
 *
 *  - Neutralino's filesystem calls reject with codes (NE_FS_NOPATHE and
 *    friends) rather than errno strings. They are translated to plain Errors
 *    with a `.code` so core/ never has to know which shell it is running in.
 */

import * as P from './paths.js';

const NL = () => globalThis.Neutralino;

function wrap(err, path) {
    const code = err && (err.code || err.name) || 'NE_UNKNOWN';
    const msg = (err && (err.message || err.msg)) || String(err);
    const e = new Error(path ? `${msg} (${path})` : msg);
    e.code = code;
    return e;
}

const MISSING = new Set(['NE_FS_NOPATHE', 'NE_FS_FILRDER', 'NE_FS_NOTFOUND']);

export function createNeutralinoPlatform() {
    const isWindows = (globalThis.NL_OS || '').toLowerCase() === 'windows';

    /** Live spawned processes, so a cancel can reach in and kill them. */
    const running = new Map();

    NL().events.on('spawnedProcess', (evt) => {
        const d = evt && evt.detail;
        if (!d) return;
        const job = running.get(d.id);
        if (!job) return;
        if (d.action === 'stdOut') job.push('stdout', d.data);
        else if (d.action === 'stdErr') job.push('stderr', d.data);
        else if (d.action === 'exit') job.finish(Number(d.data));
    });

    const fs = {
        async readText(path) {
            try {
                return await NL().filesystem.readFile(P.toNative(path, isWindows));
            } catch (err) {
                throw wrap(err, path);
            }
        },

        async writeText(path, content) {
            const dir = P.dirname(path);
            if (dir) await fs.mkdirp(dir);
            try {
                await NL().filesystem.writeFile(P.toNative(path, isWindows), content);
            } catch (err) {
                throw wrap(err, path);
            }
        },

        async stat(path) {
            try {
                const s = await NL().filesystem.getStats(P.toNative(path, isWindows));
                return {
                    isFile: !!s.isFile,
                    isDirectory: !!s.isDirectory,
                    size: Number(s.size) || 0,
                    mtimeMs: Number(s.modifiedAt) || 0
                };
            } catch (err) {
                if (MISSING.has(err && err.code)) return null;
                throw wrap(err, path);
            }
        },

        async exists(path) {
            return (await fs.stat(path)) !== null;
        },

        async readDir(path) {
            let raw;
            try {
                raw = await NL().filesystem.readDirectory(P.toNative(path, isWindows));
            } catch (err) {
                if (MISSING.has(err && err.code)) return [];
                throw wrap(err, path);
            }
            return (raw || [])
                // Neutralino lists `.` and `..` on some platforms; nobody wants them.
                .filter(e => e.entry !== '.' && e.entry !== '..')
                .map(e => ({
                    name: e.entry,
                    path: P.join(path, e.entry),
                    isDirectory: e.type === 'DIRECTORY'
                }));
        },

        async mkdirp(path) {
            try {
                await NL().filesystem.createDirectory(P.toNative(path, isWindows));
            } catch (err) {
                // Already there is the expected outcome most of the time.
                if (await fs.exists(path)) return;
                throw wrap(err, path);
            }
        },

        async remove(path) {
            try {
                await NL().filesystem.remove(P.toNative(path, isWindows));
            } catch (err) {
                if (MISSING.has(err && err.code)) return;
                throw wrap(err, path);
            }
        }
    };

    /**
     * Run a shell command. Resolves with whatever was produced even when the
     * command fails or times out — a non-zero exit is data the agent has to
     * read, not an exception it has to survive.
     */
    async function exec(command, opts = {}) {
        const { cwd, timeoutMs = 120000, onOutput, signal } = opts;
        const started = Date.now();

        if (signal?.aborted) {
            return { stdout: '', stderr: '', exitCode: -1, timedOut: false, aborted: true, durationMs: 0 };
        }

        let id = null;
        let stdout = '';
        let stderr = '';
        let settle;
        const done = new Promise(res => { settle = res; });

        const job = {
            push(stream, data) {
                const text = String(data ?? '');
                if (stream === 'stdout') stdout += text; else stderr += text;
                if (onOutput) { try { onOutput(stream, text); } catch { /* UI only */ } }
            },
            finish(exitCode) {
                if (id !== null) running.delete(id);
                clearTimeout(timer);
                settle({ exitCode });
            }
        };

        let timedOut = false;
        let aborted = false;
        let killed = false;

        /**
         * Stop the process. Callable before it has a pid, and callable twice —
         * both happen, and the pair is the whole subtlety here. `spawnProcess`
         * is awaited, so a cancel can land while the process is being created:
         * `stop()` then runs with `id === null`, kills nothing, and the spawn
         * completes a moment later into a process nobody is going to stop. So
         * the caller checks again once there IS a pid, and `killed` is what
         * keeps that second call from being a no-op OR a double kill.
         */
        const stop = async () => {
            if (id !== null && !killed) {
                killed = true;
                try { await NL().os.updateSpawnedProcess(id, 'exit'); } catch { /* already gone */ }
                running.delete(id);
            }
            settle({ exitCode: -1 });
        };

        const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);

        // Cancel has to reach the command. Without it the button stops the
        // agent and leaves the build it started running behind the window.
        const onAbort = () => { aborted = true; stop(); };
        signal?.addEventListener('abort', onAbort, { once: true });

        try {
            const proc = await NL().os.spawnProcess(command, cwd ? P.toNative(cwd, isWindows) : undefined);
            id = proc.id;
            running.set(id, job);
        } catch (err) {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            return {
                stdout: '', stderr: String(err && err.message || err),
                exitCode: -1, timedOut: false, aborted: false, durationMs: Date.now() - started
            };
        }

        // Cancelled or timed out WHILE spawning: the earlier `stop()` had no pid
        // to kill. Now there is one. Not guarded by `aborted`, which is already
        // true in that case — guarded by `killed`, inside `stop()`.
        if (signal?.aborted || timedOut) {
            aborted = aborted || !!signal?.aborted;
            stop();
        }

        const { exitCode } = await done;
        signal?.removeEventListener('abort', onAbort);
        return {
            stdout,
            stderr: timedOut ? `${stderr}\n[timed out after ${timeoutMs}ms]`.trim() : stderr,
            exitCode,
            timedOut,
            aborted,
            durationMs: Date.now() - started
        };
    }

    /**
     * Internet desde la app de escritorio.
     *
     * Se intenta primero con fetch, y casi siempre falla: el webview de
     * Neutralino sirve la app desde un origen `http://localhost:puerto`, así
     * que CORS aplica igual que en cualquier navegador y ni MDN ni el buscador
     * mandan cabeceras que lo permitan. Aquí, a diferencia del navegador, hay
     * un plan B — la app tiene shell — y curl viene de serie en Windows 10+,
     * macOS y Linux.
     */
    async function webFetch(url, { timeoutMs = 20000, signal } = {}) {
        try {
            const res = await globalThis.fetch(url, { redirect: 'follow', signal });
            const body = await res.text();
            return { ok: true, status: res.status, contentType: res.headers.get('content-type') || '', body, url: res.url };
        } catch { /* casi seguro CORS: se pasa a curl */ }

        const segundos = Math.max(1, Math.round(timeoutMs / 1000));
        const cmd = `curl -sSL --max-time ${segundos} --max-filesize 3000000 -A "Rubus/0.1" "${url.replace(/"/g, '')}"`;
        const r = await exec(cmd, { timeoutMs: timeoutMs + 5000, signal });

        if (r.aborted) return { ok: false, error: 'cancelado' };
        if (r.exitCode !== 0) {
            return {
                ok: false,
                error: /not recognized|no se reconoce|not found/i.test(r.stderr || '')
                    ? 'el webview bloquea la petición por CORS y no hay curl para el plan B. Arranca con "npm start" en su lugar.'
                    : (r.stderr || '').trim().slice(0, 200) || `curl salió con ${r.exitCode}`
            };
        }
        return { ok: true, status: 200, contentType: /<html/i.test(r.stdout) ? 'text/html' : '', body: r.stdout, url };
    }

    /** Kill every child we started. Used by the Cancel button. */
    async function killAll() {
        for (const id of [...running.keys()]) {
            try { await NL().os.updateSpawnedProcess(id, 'exit'); } catch { /* already gone */ }
            running.delete(id);
        }
    }

    const storage = {
        async get(key) {
            try {
                const raw = await NL().storage.getData(key);
                return raw ? JSON.parse(raw) : null;
            } catch {
                return null; // NE_ST_NOSTKEX on first run
            }
        },
        async set(key, value) {
            await NL().storage.setData(key, JSON.stringify(value));
        }
    };

    return {
        kind: 'neutralino',
        isWindows,
        fs,
        exec,
        killAll,
        webFetch,
        storage,
        fetch: (...a) => globalThis.fetch(...a),
        cwd: () => P.normalize(globalThis.NL_CWD || '.'),
        appPath: () => P.normalize(globalThis.NL_PATH || '.'),
        async home() {
            try { return P.normalize(await NL().os.getPath('documents')); }
            catch { return P.normalize(globalThis.NL_CWD || '.'); }
        },
        async env(name) {
            try { return await NL().os.getEnv(name); } catch { return ''; }
        },
        async pickDirectory(title) {
            try {
                const dir = await NL().os.showFolderDialog(title || 'Carpeta de trabajo');
                return dir ? P.normalize(dir) : null;
            } catch { return null; }
        },
        async openExternal(url) {
            try { await NL().os.open(url); } catch { /* nothing we can do */ }
        }
    };
}
