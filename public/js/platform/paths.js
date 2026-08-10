/**
 * Path helpers that behave the same in the webview and under Node.
 *
 * Everything inside the agent speaks ONE dialect: forward slashes, no trailing
 * separator, drive letters upper-cased. Windows paths are converted on the way
 * in and back again only when a native call needs them. Mixing the two is what
 * makes sandbox checks silently pass strings they should have rejected, so the
 * conversion happens here and nowhere else.
 */

const DRIVE_RE = /^([a-zA-Z]):/;

/** True for `C:/x`, `/x` and `//server/share`. */
export function isAbsolute(p) {
    if (!p) return false;
    const s = String(p).replace(/\\/g, '/');
    return DRIVE_RE.test(s) || s.startsWith('/');
}

/** Forward slashes, collapsed `.`/`..`, no trailing slash, upper-case drive. */
export function normalize(p) {
    if (p === undefined || p === null) return '';
    let s = String(p).trim().replace(/\\/g, '/');
    if (!s) return '';

    const unc = s.startsWith('//');
    let drive = '';
    const m = s.match(DRIVE_RE);
    if (m) {
        drive = m[1].toUpperCase() + ':';
        s = s.slice(2);
    }

    const rooted = s.startsWith('/');
    const out = [];
    for (const part of s.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') {
            // A leading `..` on a relative path has to survive: there is no
            // root to clamp it against yet.
            if (out.length && out[out.length - 1] !== '..') out.pop();
            else if (!rooted && !drive) out.push('..');
            continue;
        }
        out.push(part);
    }

    let joined = out.join('/');
    if (drive) return joined ? `${drive}/${joined}` : `${drive}/`;
    if (unc) return `//${joined}`;
    if (rooted) return `/${joined}`;
    return joined;
}

export function join(...parts) {
    const cleaned = parts.filter(x => x !== undefined && x !== null && x !== '');
    if (!cleaned.length) return '';
    return normalize(cleaned.join('/'));
}

/** Resolve `p` against `base` when it is relative. */
export function resolve(base, p) {
    if (isAbsolute(p)) return normalize(p);
    return join(base, p || '.');
}

export function dirname(p) {
    const s = normalize(p);
    const i = s.lastIndexOf('/');
    if (i < 0) return '';
    if (i === 0) return '/';
    if (DRIVE_RE.test(s) && i === 2) return s.slice(0, 3); // `C:/`
    return s.slice(0, i);
}

export function basename(p) {
    const s = normalize(p);
    const i = s.lastIndexOf('/');
    return i < 0 ? s : s.slice(i + 1);
}

export function extname(p) {
    const b = basename(p);
    const i = b.lastIndexOf('.');
    return i <= 0 ? '' : b.slice(i).toLowerCase();
}

/** Case-insensitive on Windows-style paths, which is where this app runs. */
function comparable(p) {
    return normalize(p).replace(/\/+$/, '').toLowerCase();
}

/** True when `child` is `parent` itself or lives underneath it. */
export function contains(parent, child) {
    const a = comparable(parent);
    const b = comparable(child);
    if (!a) return false;
    if (a === b) return true;
    return b.startsWith(a.endsWith('/') ? a : a + '/');
}

/** `child` expressed relative to `parent`, or the absolute path if unrelated. */
export function relative(parent, child) {
    const c = normalize(child);
    if (!contains(parent, child)) return c;
    const a = normalize(parent).replace(/\/+$/, '');
    const rest = c.slice(a.length).replace(/^\/+/, '');
    return rest || '.';
}

/** Backslashes for anything handed to a Windows shell or native API. */
export function toNative(p, windows = true) {
    const s = normalize(p);
    return windows ? s.replace(/\//g, '\\') : s;
}
