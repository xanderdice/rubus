/**
 * Platform selection.
 *
 * The core takes a platform object and never asks where it came from. The
 * contract is small on purpose — five things (fs, exec, storage, fetch, a few
 * path lookups) — because every capability added here is one more thing that
 * has to behave identically in a webview and under Node.
 *
 *   fs.readText(path)            -> string
 *   fs.writeText(path, content)  -> void
 *   fs.stat(path)                -> {isFile,isDirectory,size,mtimeMs} | null
 *   fs.exists(path)              -> boolean
 *   fs.readDir(path)             -> [{name, path, isDirectory}]
 *   fs.mkdirp(path)              -> void
 *   fs.remove(path)              -> void
 *   exec(command, {cwd, timeoutMs, onOutput})
 *                                -> {stdout, stderr, exitCode, timedOut, durationMs}
 *   killAll()                    -> void
 *   storage.get(key) / storage.set(key, value)
 *   fetch, cwd(), appPath(), home(), env(name), pickDirectory(), openExternal()
 *
 * `exec` resolves on failure instead of throwing: a non-zero exit code is a
 * fact the agent has to reason about, not an exception it has to survive.
 */

/**
 * A platform with no hands: a browser with no AgentCoder server behind it and
 * no native shell. Every capability refuses with an explanation rather than
 * failing obscurely, because this is the state a user lands in when they open
 * index.html directly, and the fix needs to be in the error message.
 */
function createBrowserPlatform() {
    const nope = (what) => async () => {
        const e = new Error(
            `${what} no está disponible: no hay backend. Arranca el servidor con ` +
            `"npm start" y abre http://127.0.0.1:4322, o usa la app de escritorio con "npm run dev".`
        );
        e.code = 'NO_NATIVE';
        throw e;
    };

    return {
        kind: 'browser',
        isWindows: /win/i.test(globalThis.navigator?.platform || ''),
        degraded: true,
        fs: {
            readText: nope('Leer archivos'),
            writeText: nope('Escribir archivos'),
            stat: async () => null,
            exists: async () => false,
            readDir: async () => [],
            mkdirp: nope('Crear carpetas'),
            remove: nope('Borrar archivos')
        },
        execEnabled: false,
        exec: async (command) => ({
            stdout: '',
            stderr: `No se puede ejecutar "${command}": no hay backend. Arranca "npm start".`,
            exitCode: -1,
            timedOut: false,
            durationMs: 0
        }),
        killAll: async () => {},
        storage: {
            async get(key) {
                try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
            },
            async set(key, value) {
                try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
            }
        },
        fetch: (...a) => globalThis.fetch(...a),
        cwd: () => '',
        appPath: () => '',
        home: async () => '',
        env: async () => '',
        pickDirectory: async () => null,
        openExternal: async (url) => { globalThis.open(url, '_blank', 'noopener'); }
    };
}

/**
 * Pick an adapter for wherever this code woke up.
 *
 * Order matters:
 *   1. Node        — the headless harness imports this same module.
 *   2. Neutralino  — the desktop shell, native API, no server needed.
 *   3. HTTP        — an ordinary browser with server.js behind the origin.
 *   4. degraded    — a browser with nothing behind it. Reads nothing, runs
 *                    nothing, and says so instead of failing silently.
 */
export async function detectPlatform() {
    const isNode = typeof process !== 'undefined'
        && process.versions
        && process.versions.node
        && typeof globalThis.window === 'undefined';

    if (isNode) {
        const { createNodePlatform } = await import('./node.js');
        return createNodePlatform();
    }

    if (globalThis.Neutralino && globalThis.NL_TOKEN) {
        const { createNeutralinoPlatform } = await import('./neutralino.js');
        return createNeutralinoPlatform();
    }

    // file:// has no origin to probe, and the fetch would throw on every load.
    if (location.protocol !== 'file:') {
        const { probeServer, createHttpPlatform } = await import('./http.js');
        const found = await probeServer();
        if (found) {
            if (found.info.needsToken && !found.info.authorized) {
                return { ...createBrowserPlatform(), needsToken: true, serverInfo: found.info };
            }
            return createHttpPlatform(found.info, found.token);
        }
    }

    return createBrowserPlatform();
}
