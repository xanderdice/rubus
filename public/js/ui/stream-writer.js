/**
 * Coalesced text streaming into the DOM.
 *
 * Tokens arrive from Ollama one at a time — a measured run produced 9033
 * separate chunks for a single turn — and the naive handler did this for each
 * one:
 *
 *     const stick = isAtBottom(scroller);   // READ  → forces layout
 *     node.textContent = wholeBuffer;       // WRITE → invalidates it
 *     scroller.scrollTop = ...;             // WRITE → and again
 *
 * Two separate costs, both avoidable:
 *
 *  1. **Layout thrashing.** Reading `scrollHeight` right after a write forces
 *     the browser to lay out synchronously, thousands of times a turn, on the
 *     main thread — the same thread that has to stay responsive.
 *
 *  2. **Quadratic text.** `textContent = wholeBuffer` re-serialises everything
 *     written so far. Over 38k characters in 9k chunks that is ~170 million
 *     character copies for 38k characters of actual content.
 *
 * This class fixes both. Writes are buffered and applied at most once per
 * animation frame, appended to a single Text node with `appendData` (O(chunk),
 * not O(total)), and every scroll position is READ before any write happens in
 * that frame — so a frame costs one layout instead of hundreds.
 *
 * Rendering is capped at the display refresh rate, which is the highest rate a
 * human can perceive anyway. Nothing is dropped: the buffer holds it and the
 * next frame writes it.
 */

/**
 * rAF, with a timer fallback where it does not exist.
 *
 * Resolved per call, deliberately not captured at module load: ES modules are
 * evaluated once and cached, so binding here would freeze whichever
 * implementation happened to exist the first time anything imported this file.
 * That is not hypothetical — it silently pinned the fallback under test.
 */
function raf(fn) {
    return typeof globalThis.requestAnimationFrame === 'function'
        ? globalThis.requestAnimationFrame(fn)
        : setTimeout(() => fn(Date.now()), 16);
}

function caf(id) {
    if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(id);
    else clearTimeout(id);
}

export class StreamWriter {
    /**
     * @param {object}    opts
     * @param {Element}   opts.target      element the text is appended into
     * @param {Element[]} [opts.scrollers] elements to keep pinned to the bottom
     *   while they were already at the bottom. Read before the write, restored
     *   after it.
     * @param {function}  [opts.onFrame]   called once per applied frame with
     *   the total length so far — for live counters, which must not run per
     *   token either.
     */
    constructor({ target, scrollers = [], onFrame = null }) {
        this.target = target;
        this.scrollers = scrollers.filter(Boolean);
        this.onFrame = onFrame;

        this.pending = '';
        this.length = 0;
        this.frame = 0;
        this.frames = 0;      // applied frames, for diagnostics
        this.disposed = false;

        // One Text node for the life of the stream. Appending to it never
        // touches the rest of the document.
        this.textNode = target.ownerDocument.createTextNode('');
        target.appendChild(this.textNode);
    }

    /** Queue text. Cheap: a string concat and possibly one rAF registration. */
    write(text) {
        if (!text || this.disposed) return;
        this.pending += text;
        if (!this.frame) this.frame = raf(() => this._apply());
    }

    _apply() {
        this.frame = 0;
        if (this.disposed || !this.pending) return;

        const chunk = this.pending;
        this.pending = '';

        // ── all reads first ──
        const stick = this.scrollers.map(el => ({
            el,
            atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }));

        // ── then all writes ──
        this.textNode.appendData(chunk);
        this.length += chunk.length;
        this.frames++;

        for (const s of stick) {
            if (s.atBottom) s.el.scrollTop = s.el.scrollHeight;
        }

        if (this.onFrame) {
            try { this.onFrame(this.length); } catch { /* cosmetics only */ }
        }
    }

    /**
     * Apply everything now, synchronously.
     *
     * Needed when a turn ends: rAF does not fire in a hidden tab, and the final
     * render must not wait for the user to come back to it.
     */
    flush() {
        if (this.frame) { caf(this.frame); this.frame = 0; }
        this._apply();
    }

    /** Everything written so far. */
    get text() {
        return this.textNode.data + this.pending;
    }

    /** Replace the streamed text wholesale — used when the final markdown lands. */
    replaceWith(node) {
        this.flush();
        this.textNode.remove();
        if (node) this.target.appendChild(node);
    }

    dispose() {
        if (this.frame) { caf(this.frame); this.frame = 0; }
        this.disposed = true;
        this.pending = '';
    }
}
