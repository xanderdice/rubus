/**
 * The "it is working, here is what it is doing" strip.
 *
 * One row per open operation, updated in place, with a bar when there is a real
 * denominator and a spinner when there is not. Rows carry their own clock,
 * because the number that answers "is it stuck?" is the one that keeps moving.
 *
 * The clock is the point. A spinner proves the browser is repainting; an
 * elapsed counter next to "Consultando a qwen3.6:latest… 14s" proves the *agent*
 * is alive and tells you what it is blocked on. During a cold model load that
 * one line is the only thing standing between the user and the conclusion that
 * the app has hung.
 */

import { el, clear } from './dom.js';

/** Nothing is shown for operations that finish faster than the eye can see. */
const MIN_VISIBLE_MS = 180;

export class ProgressStrip {
    /**
     * @param {Element} host       container to render into
     * @param {object}  [opts]
     * @param {string}  [opts.prefix] CSS class prefix, so the embeddable
     *   component can ship its own scoped styles without colliding.
     */
    constructor(host, { prefix = '' } = {}) {
        this.host = host;
        this.p = prefix;
        this.rows = new Map();   // id -> {node, label, detail, startedAt, bar, text, time}
        this.timer = null;
    }

    cls(name) {
        return this.p ? `${this.p}${name}` : name;
    }

    /** Feed it an EV.PROGRESS payload. */
    apply({ id, label, detail, current, total, indeterminate, done, elapsedMs }) {
        if (!id) return;

        if (done) {
            this._remove(id, label, elapsedMs);
            return;
        }

        let row = this.rows.get(id);
        if (!row) {
            row = this._create(id);
            this.rows.set(id, row);
        }

        // `detailText`, never `detail`: `row.detail` is the DOM node. Storing
        // the string under the same key replaced the element with a primitive,
        // and the next `row.detail.textContent = …` threw TypeError in strict
        // mode — silently, inside a bus listener — which left every row with no
        // bar and a frozen clock. Exactly the "looks hung" this file exists to
        // prevent.
        if (label !== undefined) row.label = label;
        if (detail !== undefined) row.detailText = detail;

        const known = Number.isFinite(total) && total > 0 && !indeterminate;
        row.known = known;
        if (known) {
            row.pct = Math.max(0, Math.min(100, Math.round((current / total) * 100)));
            row.counts = `${current}/${total}`;
        } else {
            row.pct = null;
            row.counts = '';
        }

        this._paint(row);
        this._start();
    }

    _create(id) {
        const spinner = el('span', { class: this.cls('prog-spin') });
        const text = el('span', { class: this.cls('prog-text') });
        const detail = el('span', { class: this.cls('prog-detail') });
        const time = el('span', { class: this.cls('prog-time') });
        const fill = el('i', { class: this.cls('prog-fill') });
        const bar = el('span', { class: this.cls('prog-bar'), hidden: true }, [fill]);

        const node = el('div', { class: this.cls('prog-row'), dataset: { prog: id } }, [
            spinner, text, bar, detail, time
        ]);

        this.host.appendChild(node);
        this.host.hidden = false;
        return { id, node, text, detail, time, bar, fill, startedAt: Date.now(), label: '', detailText: '' };
    }

    _paint(row) {
        row.text.textContent = row.label || '';

        const extra = row.detailText || '';
        row.detail.textContent = row.known
            ? `${row.counts}${extra ? ` · ${extra}` : ''}`
            : extra;

        row.bar.hidden = !row.known;
        if (row.known) row.fill.style.width = `${row.pct}%`;

        this._tickRow(row);
    }

    _tickRow(row) {
        const secs = (Date.now() - row.startedAt) / 1000;
        // Below a second the number is noise; above it, it is the whole point.
        row.time.textContent = secs < 1 ? '' : secs < 60
            ? `${secs.toFixed(0)}s`
            : `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
    }

    _remove(id, label, elapsedMs) {
        const row = this.rows.get(id);
        if (!row) return;
        this.rows.delete(id);

        const lived = Date.now() - row.startedAt;
        const finish = () => {
            row.node.remove();
            if (!this.rows.size) {
                this.host.hidden = true;
                this._stop();
            }
        };

        // An operation that was never really visible should not flash a
        // completion line; one that took a while earns a moment of "done".
        if (lived < MIN_VISIBLE_MS) { finish(); return; }

        row.node.classList.add(this.cls('prog-done').trim());
        if (label) row.text.textContent = label;
        if (elapsedMs) row.time.textContent = `${(elapsedMs / 1000).toFixed(1)}s`;
        row.bar.hidden = true;
        setTimeout(finish, 700);
    }

    _start() {
        if (this.timer) return;
        // 4 Hz: fast enough that the seconds counter never looks frozen, slow
        // enough to be free.
        this.timer = setInterval(() => {
            for (const row of this.rows.values()) this._tickRow(row);
        }, 250);
    }

    _stop() {
        clearInterval(this.timer);
        this.timer = null;
    }

    clearAll() {
        clear(this.host);
        this.rows.clear();
        this.host.hidden = true;
        this._stop();
    }

    destroy() {
        this._stop();
    }
}
