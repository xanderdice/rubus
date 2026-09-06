/**
 * Virtual scrolling for lists that do not fit in the DOM.
 *
 * The explorer can hold hundreds of thousands of files and a long session can
 * produce an unbounded number of chat entries. Rendering those is not slow, it
 * is impossible: a hundred thousand rows is roughly a gigabyte of layout boxes,
 * and the tab dies long before the user notices. So the DOM only ever holds
 * what is on screen plus a small overscan — a few dozen nodes, whatever the
 * list length.
 *
 * ── Why a Fenwick tree ──────────────────────────────────────────────────────
 *
 * Variable row heights need two answers on every scroll event: "how tall is
 * everything before row i" and "which row is at pixel y". A plain prefix-sum
 * array answers the first in O(1) but costs O(n) to update when a measured row
 * turns out taller than estimated — and rows get measured constantly. A Fenwick
 * tree answers both in O(log n) and updates in O(log n), so a million rows cost
 * twenty operations instead of a million.
 *
 * Heights start as estimates and are corrected once a row has actually been
 * rendered and measured. That correction changes the total height and can move
 * everything below it, so the scroller keeps an anchor: the row at the top of
 * the viewport stays put, and the user never sees the content jump under them.
 */

/** Sum tree over row heights: prefix sums and "find the row at y", both O(log n). */
class HeightTree {
    constructor(size, defaultHeight) {
        this.n = size;
        this.def = defaultHeight;
        this.capacity = Math.max(16, size);
        this.tree = new Float64Array(this.capacity + 1);
        this.heights = new Float64Array(this.capacity).fill(defaultHeight);
        // Build in O(n) rather than n inserts of O(log n).
        for (let i = 1; i <= size; i++) {
            this.tree[i] += defaultHeight;
            const parent = i + (i & -i);
            if (parent <= size) this.tree[parent] += this.tree[i];
        }
    }

    /**
     * Append one row in O(log n), amortised O(1) on reallocation.
     *
     * The chat appends constantly. Rebuilding the whole tree per append is
     * O(n) each time and therefore O(n²) over a session — it wedged the tab at
     * a hundred thousand entries. Growing in place is what makes an unbounded
     * transcript actually unbounded.
     */
    push(height) {
        if (this.n === this.capacity) this._reserve(this.capacity * 2);

        const i = this.n + 1;                 // Fenwick is 1-based
        this.heights[this.n] = height;
        this.tree[i] = height;
        // Absorb the children this node covers.
        let span = 1;
        while (span < (i & -i)) { this.tree[i] += this.tree[i - span]; span <<= 1; }
        this.n++;
    }

    _reserve(capacity) {
        const heights = new Float64Array(capacity);
        heights.set(this.heights.subarray(0, this.n));
        const tree = new Float64Array(capacity + 1);
        tree.set(this.tree.subarray(0, this.n + 1));
        this.heights = heights;
        this.tree = tree;
        this.capacity = capacity;
    }

    /** Total height of rows [0, i). */
    prefix(i) {
        let sum = 0;
        for (let x = i; x > 0; x -= x & -x) sum += this.tree[x];
        return sum;
    }

    get total() {
        return this.prefix(this.n);
    }

    height(i) {
        return this.heights[i];
    }

    set(i, value) {
        const delta = value - this.heights[i];
        if (!delta) return false;
        this.heights[i] = value;
        for (let x = i + 1; x <= this.n; x += x & -x) this.tree[x] += delta;
        return true;
    }

    /** Largest i such that prefix(i) <= y. Binary lifting over the tree. */
    indexAt(y) {
        let idx = 0;
        let remaining = y;
        let step = 1 << (31 - Math.clz32(Math.max(1, this.n)));
        for (; step > 0; step >>= 1) {
            const next = idx + step;
            if (next <= this.n && this.tree[next] <= remaining) {
                idx = next;
                remaining -= this.tree[next];
            }
        }
        return Math.min(idx, Math.max(0, this.n - 1));
    }
}

export class VirtualScroller {
    /**
     * @param {object}   opts
     * @param {Element}  opts.viewport      the scrolling element
     * @param {number}   [opts.estimate]    starting row height in px
     * @param {number}   [opts.overscan]    extra rows rendered off-screen
     * @param {function} opts.renderRow     (index) => Element
     * @param {boolean}  [opts.measure]     measure real heights (variable rows)
     */
    constructor({ viewport, estimate = 22, overscan = 6, renderRow, measure = false }) {
        this.viewport = viewport;
        this.estimate = estimate;
        this.overscan = overscan;
        this.renderRow = renderRow;
        this.measure = measure;

        this.count = 0;
        this.tree = new HeightTree(0, estimate);
        this.rendered = new Map();   // index -> element
        this.frame = 0;
        this.stick = true;           // pinned to the bottom
        this.disposed = false;

        // The scrolled area: one element whose height is the whole list, with
        // rows absolutely positioned inside it. No per-row layout cost for the
        // rows that are not there.
        this.spacer = viewport.ownerDocument.createElement('div');
        this.spacer.style.cssText = 'position:relative;width:100%';
        viewport.appendChild(this.spacer);

        // The event only asks for a repaint; `stick` is recomputed inside
        // render() from the real position.
        this._onScroll = () => this.schedule();
        viewport.addEventListener('scroll', this._onScroll, { passive: true });
    }

    _atBottom(slack = 40) {
        const v = this.viewport;
        return v.scrollHeight - v.scrollTop - v.clientHeight < slack;
    }

    /** Replace the whole list. Heights reset to the estimate. */
    setCount(count, { keepScroll = false } = {}) {
        const wasAtBottom = this.stick;
        this.count = count;
        this.tree = new HeightTree(count, this.estimate);
        this._clearRows();
        this.schedule();
        if (!keepScroll && wasAtBottom) this.scrollToEnd();
    }

    /** Append n rows, keeping measured heights of everything already there. */
    grow(by = 1) {
        for (let i = 0; i < by; i++) this.tree.push(this.estimate);
        this.count += by;
        this.schedule();
    }

    /** Drop the oldest n rows, keeping the heights of what survives. */
    shrinkFront(by) {
        if (by <= 0) return;
        const keep = Math.max(0, this.count - by);
        const next = new HeightTree(keep, this.estimate);
        for (let i = 0; i < keep; i++) next.set(i, this.tree.height(by + i));
        this.tree = next;
        this.count = keep;
        this._clearRows();
        this.schedule();
    }

    /** Re-render a single row in place (its content changed). */
    invalidate(index) {
        const node = this.rendered.get(index);
        if (node) { node.remove(); this.rendered.delete(index); }
        this.schedule();
    }

    scrollToEnd() {
        this.stick = true;
        this.schedule();
        // The height is only correct after the pending render, so pin again
        // once it has run.
        this._pinAfterRender = true;
    }

    schedule() {
        if (this.frame || this.disposed) return;
        this.frame = raf(() => { this.frame = 0; this.render(); });
    }

    render() {
        if (this.disposed) return;

        const v = this.viewport;

        /**
         * Re-derive "pinned to the bottom" from the actual position, here,
         * every time — do not trust the scroll event alone.
         *
         * Scroll events are asynchronous. A render that lands between the user
         * moving the wheel and the event arriving would see a stale `stick` and
         * yank them back down, which during streaming reads as "I cannot scroll
         * up while it is writing". Deriving it from the DOM is self-correcting:
         * whatever the event says, the position is the truth.
         */
        if (!this._pinAfterRender) this.stick = this._atBottom();

        const total = this.tree.total;
        this.spacer.style.height = `${total}px`;

        if (this.stick && total > v.clientHeight) v.scrollTop = total;

        const top = Math.max(0, v.scrollTop);
        const bottom = top + v.clientHeight;

        let first = this.count ? this.tree.indexAt(top) : 0;
        first = Math.max(0, first - this.overscan);

        // Walk forward until the window is covered.
        let last = first;
        let y = this.tree.prefix(first);
        while (last < this.count && y < bottom) { y += this.tree.height(last); last++; }
        last = Math.min(this.count - 1, last + this.overscan);

        // Drop what fell outside the window.
        for (const [index, node] of this.rendered) {
            if (index < first || index > last) { node.remove(); this.rendered.delete(index); }
        }

        // Add what came into it.
        const anchorIndex = first;
        const anchorBefore = this.tree.prefix(anchorIndex);
        let corrected = false;

        for (let i = first; i <= last && i < this.count; i++) {
            let node = this.rendered.get(i);
            if (!node) {
                node = this.renderRow(i);
                if (!node) continue;
                node.style.position = 'absolute';
                node.style.left = '0';
                node.style.right = '0';
                this.spacer.appendChild(node);
                this.rendered.set(i, node);
            }
            node.style.top = `${this.tree.prefix(i)}px`;
        }

        // Measure after every write, never interleaved with them: one layout
        // for the whole batch instead of one per row.
        if (this.measure) {
            for (const [i, node] of this.rendered) {
                const real = node.offsetHeight;
                if (real > 0 && Math.abs(real - this.tree.height(i)) > 0.5) {
                    this.tree.set(i, real);
                    corrected = true;
                }
            }
        }

        if (corrected) {
            // Heights above the viewport changed, so the content would slide
            // under the user. Put the anchor row back where it was.
            const anchorAfter = this.tree.prefix(anchorIndex);
            const drift = anchorAfter - anchorBefore;
            if (drift && !this.stick) v.scrollTop += drift;

            this.spacer.style.height = `${this.tree.total}px`;
            for (const [i, node] of this.rendered) node.style.top = `${this.tree.prefix(i)}px`;
            if (this.stick) v.scrollTop = this.tree.total;
        }

        if (this._pinAfterRender) {
            this._pinAfterRender = false;
            v.scrollTop = this.tree.total;
        }
    }

    _clearRows() {
        for (const node of this.rendered.values()) node.remove();
        this.rendered.clear();
    }

    /** How many nodes are actually in the document — for tests and diagnostics. */
    get domNodes() {
        return this.rendered.size;
    }

    dispose() {
        this.disposed = true;
        if (this.frame) caf(this.frame);
        this.viewport.removeEventListener('scroll', this._onScroll);
        this._clearRows();
        this.spacer.remove();
    }
}

// Resolved per call, not captured at module load: ES modules evaluate once, so
// binding here would freeze whichever implementation existed on first import.
function raf(fn) {
    return typeof globalThis.requestAnimationFrame === 'function'
        ? globalThis.requestAnimationFrame(fn)
        : setTimeout(() => fn(Date.now()), 16);
}

function caf(id) {
    if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(id);
    else clearTimeout(id);
}

export { HeightTree };
