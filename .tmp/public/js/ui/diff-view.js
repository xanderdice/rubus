/**
 * Changed-files list plus the full diff viewer.
 *
 * The list accumulates per file across the whole run and always diffs against
 * the ORIGINAL content, not the previous edit — after three passes over one
 * file, "what did the agent do to this file" is the only question worth
 * answering, and a chain of three intermediate diffs does not answer it.
 */

import { el, icon, clear, $, openDialog } from './dom.js';
import { diffLines, toHunks } from '../core/diff.js';

export class DiffView {
    constructor() {
        this.list = $('#side-diffs');
        this.count = $('#diff-count');
        this.changes = new Map(); // path -> {before, after, created}
    }

    clearAll() {
        this.changes.clear();
        this.render();
    }

    record({ path, before, after, created }) {
        const prior = this.changes.get(path);
        this.changes.set(path, {
            path,
            before: prior ? prior.before : before,   // keep the original
            after,
            created: prior ? prior.created : created
        });
        this.render();
    }

    render() {
        clear(this.list);
        this.count.textContent = String(this.changes.size);

        if (!this.changes.size) {
            this.list.appendChild(el('div', { class: 'empty-msg' }, 'Ningún archivo modificado.'));
            return;
        }

        for (const change of this.changes.values()) {
            const { stats } = diffLines(change.before ?? '', change.after ?? '');
            this.list.appendChild(el('div', {
                class: 'diff-file',
                onclick: () => this.open(change.path)
            }, [
                icon(change.created ? 'plus' : 'diff', 'ico ico--sm'),
                el('span', { class: 'path', title: change.path }, change.path),
                change.created ? el('span', { class: 'badge' }, 'nuevo') : null,
                el('span', { class: 'add' }, `+${stats.added}`),
                el('span', { class: 'del' }, `-${stats.removed}`)
            ]));
        }
    }

    open(path) {
        const change = this.changes.get(path);
        if (!change) return;

        const { ops, stats } = diffLines(change.before ?? '', change.after ?? '');
        const hunks = toHunks(ops, 4);

        $('#diff-title').textContent = path;
        $('#diff-stats').textContent = `+${stats.added} / -${stats.removed}`;

        const body = clear($('#diff-body'));

        if (!hunks.length) {
            body.appendChild(el('div', { class: 'empty-msg' }, 'Sin diferencias.'));
        } else {
            for (const h of hunks) {
                body.appendChild(el('div', { class: 'diff-hunk-head' },
                    `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`));
                for (const op of h.ops) {
                    const cls = op.type === 'add' ? 'add' : op.type === 'del' ? 'del' : '';
                    body.appendChild(el('div', { class: `diff-line ${cls}` }, [
                        el('span', { class: 'no' }, op.type === 'add' ? String(op.newNo) : String(op.oldNo ?? '')),
                        el('span', { class: 'txt' }, `${op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' '}${op.text}`)
                    ]));
                }
            }
        }

        openDialog('diff-dialog');
    }
}
