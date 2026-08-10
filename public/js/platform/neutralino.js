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
        const { cwd, timeoutMs = 120000, onOutput } = opts;
        const started = Date.now();

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
        const timer = setTimeout(async () => {
            timedOut = true;
            if (id !== null) {
                try { await NL().os.updateSpawnedProcess(id, 'exit'); } catch { /* already gone */ }
                running.delete(id);
            }
            settle({ exitCode: -1 });
        }, timeoutMs);

        try {
            const proc = await NL().os.spawnProcess(command, cwd ? P.toNative(cwd, isWindows) : undefined);
            id = proc.id;
            running.set(id, job);
        } catch (err) {
            clearTimeout(timer);
            return {
                stdout: '', stderr: String(err && err.message || err),
                exitCode: -1, timedOut: false, durationMs: Date.now() - started
            };
        }

        const { exitCode } = await done;
        return {
            stdout,
            stderr: timedOut ? `${stderr}\n[timed out after ${timeoutMs}ms]`.trim() : stderr,
            exitCode,
            timedOut,
            durationMs: Date.now() - started
        };
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
