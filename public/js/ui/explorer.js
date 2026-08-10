/**
 * File explorer with pinning.
 *
 * Pinning is the feature that matters here. A pinned file is injected into
 * every prompt, verbatim and budgeted, and is never summarised away — it is how
 * the user says "whatever else you forget, do not forget this interface". The
 * pin toggle therefore lives on every row, not behind a context menu.
 *
 * The tree is flat-rendered from one walk and filtered client-side; a lazy
 * per-directory tree would be more elegant and much less responsive to type in.
 */

import { el, icon, clear, $, toast } from './dom.js';
import { walkFiles } from '../core/walk.js';
import { VirtualScroller } from './virtual-scroller.js';
import * as P from '../platform/paths.js';

export class Explorer {
    constructor({ platform, engine }) {
        this.platform = platform;
        this.engine = engine;
        this.body = $('#explorer-body');
        this.count = $('#explorer-count');
        this.filterInput = $('#explorer-filter');
        this.pinsSection = $('#pins-section');
        this.pinsList = $('#pins-list');

        this.files = [];
        this.dirs = new Set();
        this.expanded = new Set(['']);
        this.filter = '';
        this.rows = [];
        this.dirIndex = null;

        // The body is the scroll viewport; the message and the virtual rows are
        // siblings inside it, so showing one never destroys the other.
        this.empty = el('div', { class: 'empty-msg', hidden: true });
        clear(this.body);
        this.body.appendChild(this.empty);

        // Fixed row height (.tree-row is 21px), so heights never need measuring
        // — the cheapest possible mode.
        this.scroller = new VirtualScroller({
            viewport: this.body,
            estimate: 21,
            overscan: 10,
            renderRow: (i) => this._row(i)
        });

        this.filterInput.addEventListener('input', () => {
            this.filter = this.filterInput.value.trim().toLowerCase();
            this.render();
        });
        $('#btn-explorer-refresh').addEventListener('click', () => this.refresh());
    }

    async refresh() {
        const root = this.engine.config.get('workspace.root', '');
        if (!root) {
            this.files = [];
            this.render();
            return;
        }

        // The old ceiling was 3000 because every row was in the DOM. With
        // virtual scrolling the DOM cost is constant, so the only real limit is
        // how long the walk itself takes — and that reports progress.
        const cap = this.engine.config.get('ui.explorerMaxFiles', 200000);

        try {
            const { files, dirs, truncated } = await walkFiles(this.platform, root, {
                maxFiles: cap,
                onProgress: (p) => this.count.textContent = `${p.files}…`
            });
            this.files = files;
            this.dirs = new Set(dirs.map(d => d.rel));
            this.dirIndex = null;   // rebuilt lazily on the next render
            if (truncated) toast(`Proyecto enorme: se listaron los primeros ${cap.toLocaleString('es')} archivos.`);
        } catch (err) {
            toast(`No se pudo leer la carpeta: ${err.message}`, 'bad');
            this.files = [];
            this.dirIndex = null;
        }
        this.render();
    }

    render() {
        this.renderPins();
        this.count.textContent = String(this.files.length);

        const message = !this.engine.config.get('workspace.root', '')
            ? 'Sin carpeta de trabajo.'
            : !this.files.length ? 'No se encontraron archivos de texto.' : '';

        if (message) { this._showMessage(message); return; }

        this.rows = this.filter ? this._filteredRows() : this._treeRows();

        if (!this.rows.length) { this._showMessage('Sin coincidencias.'); return; }

        this._hideMessage();
        this.scroller.setCount(this.rows.length, { keepScroll: true });
    }

    _showMessage(text) {
        this.empty.textContent = text;
        this.empty.hidden = false;
        this.rows = [];
        this.scroller.setCount(0, { keepScroll: true });
    }

    _hideMessage() {
        this.empty.hidden = true;
    }

    /**
     * Index the flat file list into a directory tree, once.
     *
     * The previous renderer scanned every file for every directory it drew,
     * which is quadratic and fine at three thousand files and hopeless at a
     * hundred thousand. This runs once per walk; expanding a folder afterwards
     * is a map lookup.
     */
    _index() {
        const dirs = new Map();   // dirRel -> {dirs:Set, files:[]}
        const at = (rel) => {
            let node = dirs.get(rel);
            if (!node) { node = { dirs: new Set(), files: [] }; dirs.set(rel, node); }
            return node;
        };
        at('');

        for (const f of this.files) {
            const cut = f.rel.lastIndexOf('/');
            const parent = cut < 0 ? '' : f.rel.slice(0, cut);
            at(parent).files.push(f);

            // Register every ancestor so a folder with only sub-folders exists.
            let child = parent;
            while (child) {
                const up = child.lastIndexOf('/');
                const grand = up < 0 ? '' : child.slice(0, up);
                at(grand).dirs.add(child);
                if (!grand) break;
                child = grand;
            }
        }

        for (const node of dirs.values()) {
            node.sorted = [...node.dirs].sort((a, b) => a.localeCompare(b));
            node.files.sort((a, b) => a.rel.localeCompare(b.rel));
        }
        this.dirIndex = dirs;
    }

    /** The visible rows, flattened — only what the expanded state exposes. */
    _treeRows() {
        if (!this.dirIndex) this._index();
        const rows = [];
        const walk = (dir, depth) => {
            const node = this.dirIndex.get(dir);
            if (!node) return;
            for (const d of node.sorted) {
                const open = this.expanded.has(d);
                rows.push({ kind: 'dir', rel: d, depth, open });
                if (open) walk(d, depth + 1);
            }
            for (const f of node.files) rows.push({ kind: 'file', rel: f.rel, depth });
        };
        walk('', 0);
        return rows;
    }

    /** Filtering flattens the tree: you want hits, not the folders around them. */
    _filteredRows() {
        const rows = [];
        for (const f of this.files) {
            if (f.rel.toLowerCase().includes(this.filter)) rows.push({ kind: 'file', rel: f.rel, depth: 0, showPath: true });
        }
        return rows;
    }

    /** Build one row on demand — the virtual scroller asks only for visible ones. */
    _row(index) {
        const row = this.rows[index];
        if (!row) return null;

        if (row.kind === 'dir') {
            return el('div', {
                class: 'tree-row is-dir',
                style: { paddingLeft: `${6 + row.depth * 11}px` },
                title: row.rel,
                onclick: () => {
                    if (this.expanded.has(row.rel)) this.expanded.delete(row.rel);
                    else this.expanded.add(row.rel);
                    this.render();
                }
            }, [
                el('span', { class: 'tree-chev' }, row.open ? '▾' : '▸'),
                icon('folder', 'ico ico--sm'),
                el('span', { class: 'name' }, P.basename(row.rel))
            ]);
        }

        return this._fileRow({ rel: row.rel }, row.depth, !!row.showPath);
    }

    _fileRow(f, depth, showPath) {
        const pinned = this.engine.context.pins().includes(f.rel);
        return el('div', {
            class: `tree-row ${pinned ? 'pinned' : ''}`,
            style: { paddingLeft: `${18 + depth * 11}px` },
            title: f.rel,
            onclick: () => this.togglePin(f.rel)
        }, [
            icon('file', 'ico ico--sm'),
            el('span', { class: 'name' }, showPath ? f.rel : P.basename(f.rel)),
            el('button', {
                class: 'pin-btn',
                title: pinned ? 'Quitar del contexto' : 'Fijar en el contexto del agente',
                onclick: (e) => { e.stopPropagation(); this.togglePin(f.rel); }
            }, [icon('pin', 'ico ico--sm')])
        ]);
    }

    togglePin(rel) {
        const pins = this.engine.context.pins();
        if (pins.includes(rel)) this.engine.context.unpin(rel);
        else {
            const max = this.engine.config.get('context.maxPinnedFiles', 8);
            if (pins.length >= max) {
                toast(`Máximo ${max} archivos fijados. Quita uno antes de añadir otro.`, 'bad');
                return;
            }
            this.engine.context.pin(rel);
        }
        this.engine.config.save();
        this.render();
    }

    renderPins() {
        const pins = this.engine.context.pins();
        this.pinsSection.hidden = pins.length === 0;
        clear(this.pinsList);
        for (const p of pins) {
            this.pinsList.appendChild(el('div', { class: 'pin-row', title: p }, [
                icon('file', 'ico ico--sm'),
                el('span', {}, p),
                el('button', { title: 'Quitar', onclick: () => this.togglePin(p) }, '×')
            ]));
        }
    }
}
