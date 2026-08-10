/** Small shared helpers. No imports, no state, no platform. */

export function uid(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        if (signal) {
            if (signal.aborted) { clearTimeout(t); reject(abortError()); return; }
            signal.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
        }
    });
}

export function abortError(message = 'Operación cancelada') {
    const e = new Error(message);
    e.name = 'AbortError';
    return e;
}

export function isAbort(err) {
    return !!err && (err.name === 'AbortError' || err.code === 20);
}

export function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
}

/**
 * Cheap token estimate. Deliberately pessimistic: code tokenises worse than
 * prose, and a context overflow costs a whole failed turn, while over-reserving
 * costs a few hundred tokens of headroom.
 */
export function estimateTokens(text) {
    if (!text) return 0;
    const s = typeof text === 'string' ? text : JSON.stringify(text);
    return Math.ceil(s.length / 3.4);
}

export function truncate(text, max, tail = '\n… [recortado]') {
    if (!text || text.length <= max) return text || '';
    return text.slice(0, Math.max(0, max - tail.length)) + tail;
}

/** Keep the head and the tail; the middle of a long file is the throwaway part. */
export function truncateMiddle(text, max) {
    if (!text || text.length <= max) return text || '';
    const half = Math.floor((max - 40) / 2);
    return `${text.slice(0, half)}\n… [${text.length - half * 2} caracteres omitidos] …\n${text.slice(-half)}`;
}

export function lines(text) {
    return String(text ?? '').split(/\r\n|\r|\n/);
}

export function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stripAnsi(s) {
    // eslint-disable-next-line no-control-regex
    return String(s ?? '').replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

export function nowIso() {
    return new Date().toISOString();
}

export function formatDuration(ms) {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60000);
    return `${m}m ${Math.round((ms % 60000) / 1000)}s`;
}

export function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
}

export function deepClone(o) {
    return o === undefined ? o : JSON.parse(JSON.stringify(o));
}

/** Recursive merge of plain objects; arrays and scalars are replaced wholesale. */
export function deepMerge(base, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch ?? base;
    const out = Array.isArray(base) ? [...base] : { ...(base || {}) };
    for (const [k, v] of Object.entries(patch)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
            out[k] = deepMerge(out[k], v);
        } else {
            out[k] = v;
        }
    }
    return out;
}

export function debounce(fn, ms) {
    let t = null;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

/** Retry with exponential backoff and jitter. `shouldRetry` decides per error. */
export async function withRetry(fn, { retries = 3, baseMs = 500, maxMs = 8000, signal, shouldRetry = () => true, onRetry } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (signal?.aborted) throw abortError();
        try {
            return await fn(attempt);
        } catch (err) {
            if (isAbort(err)) throw err;
            lastErr = err;
            if (attempt === retries || !shouldRetry(err)) break;
            const wait = Math.min(maxMs, baseMs * 2 ** attempt) * (0.7 + Math.random() * 0.6);
            if (onRetry) onRetry(attempt + 1, err, Math.round(wait));
            await sleep(wait, signal);
        }
    }
    throw lastErr;
}

/**
 * Rate-limit progress reporting.
 *
 * A walk over 4000 files would otherwise emit 4000 events and spend more time
 * repainting than working. Leading edge fires immediately so the user sees the
 * operation start at once; the rest are capped.
 */
export function makeThrottle(ms = 120) {
    let last = 0;
    return (fn) => {
        const now = Date.now();
        if (now - last < ms) return false;
        last = now;
        fn();
        return true;
    };
}

/**
 * A tool's progress reporter, or a silent stand-in.
 *
 * The registry always injects `ctx.progress`, but tools are also called
 * directly — from tests, and from anything embedding a single tool. Reporting
 * is a convenience, never a dependency: a missing channel must not turn a
 * working tool into a crash.
 */
const SILENT_PROGRESS = { id: '', update() {}, done() {} };
export function toolProgress(ctx) {
    return typeof ctx?.progress === 'function' ? ctx.progress : () => SILENT_PROGRESS;
}

/** Resolve a promise externally — used for approval gates the UI answers. */
export function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}
