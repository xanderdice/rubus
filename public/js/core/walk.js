/**
 * Breadth-first walk over a project tree, with the ignore rules applied and
 * hard caps on everything. Shared by the repo map, search and the explorer.
 *
 * The caps are not politeness. A user who points the agent at `C:\` should get
 * a truncated answer in two seconds, not a frozen window.
 */

import * as P from '../platform/paths.js';
import { isIgnoredDir, isBinaryPath } from './ignore.js';

export async function walkFiles(platform, root, {
    maxFiles = 4000,
    maxDepth = 12,
    includeBinary = false,
    signal,
    onDir,
    /** Called as the walk advances, throttled by the caller. */
    onProgress
} = {}) {
    const files = [];
    const dirs = [];
    let truncated = false;

    const queue = [{ path: P.normalize(root), depth: 0 }];

    while (queue.length) {
        if (signal?.aborted) break;
        const { path, depth } = queue.shift();

        let entries;
        try { entries = await platform.fs.readDir(path); } catch { continue; }
        if (onDir) onDir(path, entries);

        // Over HTTP each readDir is a round trip, so a deep tree takes real
        // seconds. Reporting the folder being scanned is the difference
        // between "working" and "frozen".
        if (onProgress) onProgress({ dirs: dirs.length, files: files.length, current: P.relative(root, path) || '.' });

        for (const e of entries) {
            if (e.isDirectory) {
                if (isIgnoredDir(e.name) || depth >= maxDepth) continue;
                dirs.push({ path: e.path, rel: P.relative(root, e.path), depth: depth + 1 });
                queue.push({ path: e.path, depth: depth + 1 });
                continue;
            }
            if (!includeBinary && isBinaryPath(e.name)) continue;
            if (files.length >= maxFiles) { truncated = true; continue; }
            files.push({ path: e.path, rel: P.relative(root, e.path), name: e.name, depth });
        }
    }

    files.sort((a, b) => a.rel.localeCompare(b.rel));
    dirs.sort((a, b) => a.rel.localeCompare(b.rel));
    return { files, dirs, truncated };
}

/**
 * Minimal glob: `*` (not across `/`), `**` (across `/`), `?`, and `{a,b}`.
 * Deliberately small — a full matcher is more surface than this needs, and the
 * model mostly writes `*.js` or `src/**`.
 */
export function globToRegExp(pattern) {
    let out = '';
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '*') {
            if (pattern[i + 1] === '*') {
                out += '.*';
                i++;
                if (pattern[i + 1] === '/') i++;
            } else {
                out += '[^/]*';
            }
        } else if (c === '?') out += '[^/]';
        else if (c === '{') {
            const close = pattern.indexOf('}', i);
            if (close < 0) { out += '\\{'; continue; }
            out += `(${pattern.slice(i + 1, close).split(',').map(escapeLiteral).join('|')})`;
            i = close;
        } else out += escapeLiteral(c);
    }
    return new RegExp(`^${out}$`, 'i');
}

function escapeLiteral(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function matchesGlob(rel, pattern) {
    if (!pattern) return true;
    const re = globToRegExp(pattern);
    // `*.js` should match `src/a.js` too: users mean "any .js", not "at root".
    return re.test(rel) || re.test(P.basename(rel)) || globToRegExp(`**/${pattern}`).test(rel);
}
