/**
 * What the agent pretends does not exist.
 *
 * Shared by the repo map, the search tool, the directory listing and the file
 * explorer so all four agree. They must agree: a model that sees a file in the
 * tree and then cannot find it in search will keep retrying the search.
 */

import * as P from '../platform/paths.js';

export const IGNORED_DIRS = new Set([
    'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target',
    '.next', '.nuxt', '.output', '.svelte-kit', '.vite', '.parcel-cache',
    '.cache', 'coverage', '.nyc_output', '__pycache__', '.pytest_cache',
    '.mypy_cache', '.venv', 'venv', 'env', '.tox', '.gradle', '.idea', '.vs',
    '.vscode', 'bin', 'obj', 'vendor', 'bower_components', 'jspm_packages',
    '.rubus', '.agentcoder', '.terraform', '.serverless', 'Pods', 'DerivedData'
]);

export const BINARY_EXTS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.avif', '.tiff',
    '.mp3', '.wav', '.ogg', '.flac', '.m4a', '.mp4', '.avi', '.mkv', '.mov', '.webm',
    '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.jar', '.war',
    '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.pdb', '.obj', '.o', '.a',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.ttf', '.otf', '.woff', '.woff2', '.eot',
    '.wasm', '.pyc', '.class', '.db', '.sqlite', '.sqlite3',
    '.glb', '.gltf', '.fbx', '.blend', '.basis', '.ktx2', '.dds'
]);

/** Files big enough that reading them is almost certainly a mistake. */
export const MAX_TEXT_BYTES = 1_200_000;

export function isIgnoredDir(name) {
    return IGNORED_DIRS.has(name) || (name.startsWith('.') && name !== '.github' && name !== '.agentcoder');
}

export function isBinaryPath(path) {
    return BINARY_EXTS.has(P.extname(path));
}

/** Cheap sniff for files with no telling extension. */
export function looksBinary(text) {
    if (!text) return false;
    const sample = text.slice(0, 4000);
    // A NUL anywhere is decisive; no text file contains one.
    if (sample.includes('\0')) return true;
    let weird = 0;
    for (let i = 0; i < sample.length; i++) {
        const c = sample.charCodeAt(i);
        if (c < 9 || (c > 13 && c < 32)) weird++;
    }
    return weird / Math.max(1, sample.length) > 0.08;
}

const LANG_BY_EXT = {
    '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
    '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
    '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
    '.java': 'java', '.kt': 'kotlin', '.scala': 'scala', '.cs': 'csharp',
    '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
    '.php': 'php', '.swift': 'swift', '.dart': 'dart', '.lua': 'lua',
    '.sh': 'bash', '.bash': 'bash', '.ps1': 'powershell', '.bat': 'batch', '.cmd': 'batch',
    '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'scss', '.less': 'less',
    '.json': 'json', '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.xml': 'xml',
    '.md': 'markdown', '.sql': 'sql', '.vue': 'vue', '.svelte': 'svelte'
};

export function languageOf(path) {
    return LANG_BY_EXT[P.extname(path)] || '';
}

export function isCodeFile(path) {
    return !!LANG_BY_EXT[P.extname(path)];
}
