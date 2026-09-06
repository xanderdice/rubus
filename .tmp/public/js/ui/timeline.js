/**
 * The action timeline: every tool call, its arguments, and what came back.
 *
 * This is the audit trail. When the agent does something surprising, this is
 * where you find out what it actually ran — the chat only shows what it chose
 * to say about it. Entries are capped so a long session cannot grow the DOM
 * without bound.
 */

import { el, icon, clear, $, isAtBottom, shortTime } from './dom.js';

const MAX_ITEMS = 400;

export class Timeline {
    constructor() {
        this.root = $('#side-timeline');
        this.count = $('#timeline-count');
        this.items = 0;
        this.pending = new Map(); // callId -> node
    }

    clearAll() {
        clear(this.root);
        this.items = 0;
        this.pending.clear();
        this.count.textContent = '0';
    }

    _push(node) {
        const stick = isAtBottom(this.root);
        this.root.appendChild(node);
        if (++this.items > MAX_ITEMS) {
            this.root.removeChild(this.root.firstChild);
            this.items--;
        }
        this.count.textContent = String(this.items);
        if (stick) this.root.scrollTop = this.root.scrollHeight;
        return node;
    }

    step(text, kind = '') {
        return this._push(el('div', { class: `tl-item step ${kind}` }, [
            el('div', { class: 'tl-icon' }, [icon('chev-r', 'ico ico--sm')]),
            el('div', { class: 'tl-main' }, [el('div', { class: 'tl-name' }, text)]),
            el('div', { class: 'tl-time' }, shortTime())
        ]));
    }

    call({ id, name, args }) {
        const node = this._push(el('div', { class: 'tl-item' }, [
            el('div', { class: 'tl-icon' }, [icon(ICONS[name] || 'chev-r', 'ico ico--sm')]),
            el('div', { class: 'tl-main' }, [
                el('div', { class: 'tl-name' }, name),
                el('div', { class: 'tl-args', title: JSON.stringify(args, null, 2) }, summarizeArgs(name, args))
            ]),
            el('div', { class: 'tl-time' }, shortTime())
        ]));
        this.pending.set(id, node);
        return node;
    }

    result({ id, name, ok, summary, detail, durationMs }) {
        const node = this.pending.get(id);
        this.pending.delete(id);

        const target = node || this.call({ id, name, args: {} });
        target.classList.add(ok ? 'ok' : 'err');

        const main = target.querySelector('.tl-main');
        main.appendChild(el('div', { class: 'tl-result' }, summary || ''));

        if (detail) {
            // Detail is collapsed by default: a `read_file` result is a whole
            // file, and expanding all of them by default makes the panel useless.
            const box = el('details', {}, [
                el('summary', { class: 'tl-args', style: { cursor: 'pointer' } }, 'ver detalle'),
                el('div', { class: 'tl-detail' }, String(detail).slice(0, 20000))
            ]);
            main.appendChild(box);
        }

        const time = target.querySelector('.tl-time');
        if (time && durationMs !== undefined) time.textContent = `${durationMs}ms`;
    }

    rejected({ name, reason }) {
        this._push(el('div', { class: 'tl-item err' }, [
            el('div', { class: 'tl-icon' }, [icon('x-circle', 'ico ico--sm')]),
            el('div', { class: 'tl-main' }, [
                el('div', { class: 'tl-name' }, `${name} (rechazada)`),
                el('div', { class: 'tl-result' }, reason)
            ]),
            el('div', { class: 'tl-time' }, shortTime())
        ]));
    }
}

const ICONS = {
    read_file: 'file',
    write_file: 'edit',
    edit_file: 'edit',
    list_directory: 'folder',
    search_codebase: 'search',
    run_terminal_command: 'terminal',
    get_project_structure: 'map',
    finish_step: 'check',
    think: 'brain'
};

/** One legible line per call: the argument that actually identifies it. */
function summarizeArgs(name, args) {
    if (!args) return '';
    if (args.path) return args.path;
    if (args.command) return args.command;
    if (args.query) return `"${args.query}"${args.glob ? ` en ${args.glob}` : ''}`;
    if (args.summary) return String(args.summary).slice(0, 140);
    if (args.thought) return String(args.thought).slice(0, 140);
    const s = JSON.stringify(args);
    return s === '{}' ? '' : s.slice(0, 140);
}
