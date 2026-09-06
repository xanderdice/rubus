/** Tiny DOM helpers. No framework — the UI is a few thousand nodes at most. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Build an element. `props` sets properties (not attributes) except for a few
 * special keys, so `el('div', {className, dataset, onclick})` works as expected.
 */
export function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'class') node.className = v;
        else node[k] = v;
    }
    for (const c of [].concat(children)) {
        if (c === null || c === undefined || c === false) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
}

/** `<svg class="ico"><use href="#i-x"/></svg>` — the sprite pattern, as a node. */
export function icon(name, cls = 'ico') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', cls);
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.appendChild(use);
    return svg;
}

export function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
}

export function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

let toastTimer = null;
export function toast(message, kind = '') {
    const node = $('#toast');
    if (!node) return;
    node.textContent = message;
    node.className = `toast show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.className = 'toast'; }, kind === 'bad' ? 6000 : 3200);
}

export function openDialog(id) {
    const d = document.getElementById(id);
    if (d) d.hidden = false;
    return d;
}

export function closeDialog(id) {
    const d = document.getElementById(id);
    if (d) d.hidden = true;
}

/** Wire every `[data-close="dialog-id"]` and backdrop click, once. */
export function wireDialogDismissal() {
    document.addEventListener('click', (e) => {
        const closer = e.target.closest('[data-close]');
        if (closer) { closeDialog(closer.dataset.close); return; }
        // A click on the backdrop itself (not the dialog) dismisses it, except
        // for the approval gate — that one requires an explicit answer.
        if (e.target.classList.contains('backdrop') && e.target.id !== 'approval-dialog') {
            e.target.hidden = true;
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const open = $$('.backdrop:not([hidden])').filter(d => d.id !== 'approval-dialog');
        if (open.length) { open[open.length - 1].hidden = true; e.stopPropagation(); }
    });
}

/** True when the element is scrolled to (or very near) the bottom. */
export function isAtBottom(node, slack = 60) {
    return node.scrollHeight - node.scrollTop - node.clientHeight < slack;
}

export function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
    return `${(n / 1073741824).toFixed(1)} GB`;
}

/**
 * Wall-clock time, formatted cheaply.
 *
 * `toLocaleTimeString` builds an Intl formatter on every call — around 50µs,
 * which is invisible once and dominant when it runs per chat entry: it was 95%
 * of the cost of appending four thousand messages. The formatter is built once
 * and reused, and the result is memoised per second, since that is the
 * resolution being displayed anyway.
 */
let timeFormatter = null;
let lastSecond = -1;
let lastStamp = '';

export function shortTime(d = new Date()) {
    const secs = Math.floor(d.getTime() / 1000);
    if (secs === lastSecond) return lastStamp;

    if (!timeFormatter) {
        try {
            timeFormatter = new Intl.DateTimeFormat('es', {
                hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
            });
        } catch {
            timeFormatter = { format: (x) => x.toTimeString().slice(0, 8) };
        }
    }

    lastSecond = secs;
    lastStamp = timeFormatter.format(d);
    return lastStamp;
}
