/**
 * Node platform adapter.
 *
 * This exists so the whole agent engine can be driven headless — see
 * `cli/headless.js`. That is not a side quest: a state machine that only
 * runs inside a webview cannot be tested, and an untested harness is exactly
 * the thing this project cannot afford, because the harness is where all the
 * intelligence lives.
 *
 * Only `./index.js` may import this, and only behind a runtime check — the
 * `node:` specifiers below are fatal in a browser.
 */

import { promises as nodefs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import * as P from './paths.js';
import { shellFor, killTree } from './kill-tree.js';

/** Un agente que se presenta como tal. Muchos sitios lo agradecen. */
const UA = 'Mozilla/5.0 (compatible; Rubus/0.1; +https://github.com/xanderdice/rubus)';
const MAX_WEB_BYTES = 3 * 1024 * 1024;

export function createNodePlatform() {
    const isWindows = process.platform === 'win32';
    const running = new Set();

    const fs = {
        async readText(path) {
            return await nodefs.readFile(path, 'utf8');
        },
        async writeText(path, content) {
            const dir = P.dirname(path);
            if (dir) await nodefs.mkdir(dir, { recursive: true });
            await nodefs.writeFile(path, content, 'utf8');
        },
        async stat(path) {
            try {
                const s = await nodefs.stat(path);
                return {
                    isFile: s.isFile(),
                    isDirectory: s.isDirectory(),
                    size: s.size,
                    mtimeMs: s.mtimeMs
                };
            } catch {
                return null;
            }
        },
        async exists(path) {
            return (await fs.stat(path)) !== null;
        },
        async readDir(path) {
            let entries;
            try {
                entries = await nodefs.readdir(path, { withFileTypes: true });
            } catch {
                return [];
            }
            return entries.map(e => ({
                name: e.name,
                path: P.join(path, e.name),
                isDirectory: e.isDirectory()
            }));
        },
        async mkdirp(path) {
            await nodefs.mkdir(path, { recursive: true });
        },
        async remove(path) {
            await nodefs.rm(path, { recursive: true, force: true });
        }
    };

    function exec(command, opts = {}) {
        const { cwd, timeoutMs = 120000, onOutput, signal } = opts;
        const started = Date.now();

        return new Promise((resolve) => {
            // Cancelled before we even spawned. Starting the command anyway and
            // killing it a millisecond later is a real `npm install` that
            // briefly touches the disk for no reason at all.
            if (signal?.aborted) {
                resolve({ stdout: '', stderr: '', exitCode: -1, timedOut: false, aborted: true, durationMs: 0 });
                return;
            }

            const shell = shellFor(command);

            let child;
            try {
                child = spawn(shell.cmd, shell.args, { cwd: cwd || process.cwd(), ...shell.options });
            } catch (err) {
                resolve({
                    stdout: '', stderr: String(err && err.message || err),
                    exitCode: -1, timedOut: false, aborted: false, durationMs: Date.now() - started
                });
                return;
            }

            running.add(child);
            let stdout = '';
            let stderr = '';
            let timedOut = false;
            let aborted = false;
            let settled = false;

            // The whole tree, not just the shell — otherwise "timed out" is a
            // label on a process that is still running. See kill-tree.js.
            const timer = setTimeout(() => {
                timedOut = true;
                killTree(child);
            }, timeoutMs);

            // Cancel has to reach the command, not just the agent. Without this
            // the Cancel button stopped the turn loop and left the `npm test`
            // it had launched running to completion, holding the CPU and the
            // lock files of a task nobody was waiting for any more.
            const onAbort = () => { aborted = true; killTree(child); };
            signal?.addEventListener('abort', onAbort, { once: true });

            child.stdout.on('data', (b) => {
                const t = b.toString();
                stdout += t;
                if (onOutput) { try { onOutput('stdout', t); } catch { /* caller's problem */ } }
            });
            child.stderr.on('data', (b) => {
                const t = b.toString();
                stderr += t;
                if (onOutput) { try { onOutput('stderr', t); } catch { /* caller's problem */ } }
            });

            const finish = (exitCode) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                running.delete(child);
                resolve({
                    stdout,
                    stderr: timedOut ? `${stderr}\n[timed out after ${timeoutMs}ms]`.trim() : stderr,
                    exitCode: exitCode === null ? -1 : exitCode,
                    timedOut,
                    aborted,
                    durationMs: Date.now() - started
                });
            };

            child.on('error', (err) => { stderr += String(err.message || err); finish(-1); });
            child.on('close', (code) => finish(code));
        });
    }

    /** Everything we started, and everything it started. The Cancel button. */
    async function killAll() {
        for (const child of [...running]) {
            killTree(child);
            running.delete(child);
        }
    }

    // Settings live next to the user's profile so headless runs and the
    // desktop app can be pointed at the same configuration if wanted.
    const storeFile = P.join(P.normalize(os.homedir()), '.agentcoder/settings.json');
    const storage = {
        async get(key) {
            try {
                const all = JSON.parse(await nodefs.readFile(storeFile, 'utf8'));
                return key in all ? all[key] : null;
            } catch {
                return null;
            }
        },
        async set(key, value) {
            let all = {};
            try { all = JSON.parse(await nodefs.readFile(storeFile, 'utf8')); } catch { /* first write */ }
            all[key] = value;
            await nodefs.mkdir(P.dirname(storeFile), { recursive: true });
            await nodefs.writeFile(storeFile, JSON.stringify(all, null, 2), 'utf8');
        }
    };

    /**
     * Salida a internet. Directa: en Node no hay CORS y el propio proceso es
     * el que tiene la red. La validación de la URL ya la hizo core/web.js.
     */
    async function webFetch(url, { timeoutMs = 20000, signal } = {}) {
        const ctrl = new AbortController();
        const onAbort = () => ctrl.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await globalThis.fetch(url, {
                redirect: 'follow',
                signal: ctrl.signal,
                headers: { 'User-Agent': UA, 'Accept-Language': 'es,en;q=0.8' }
            });
            const body = (await res.text()).slice(0, MAX_WEB_BYTES);
            return { ok: true, status: res.status, contentType: res.headers.get('content-type') || '', body, url: res.url };
        } catch (err) {
            return { ok: false, error: signal?.aborted ? 'cancelado' : String(err && err.message || err) };
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        }
    }

    return {
        kind: 'node',
        isWindows,
        fs,
        exec,
        killAll,
        webFetch,
        storage,
        fetch: (...a) => globalThis.fetch(...a),
        cwd: () => P.normalize(process.cwd()),
        appPath: () => P.normalize(process.cwd()),
        home: async () => P.normalize(os.homedir()),
        env: async (name) => process.env[name] || '',
        pickDirectory: async () => null,
        openExternal: async () => {}
    };
}
