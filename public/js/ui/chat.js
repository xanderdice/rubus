/**
 * The chat transcript.
 *
 * Streaming detail worth knowing: tokens arrive one at a time and re-rendering
 * Markdown on every token is both slow and visually unstable (a half-typed
 * `**bold` flickers). So a streaming message writes plain text into a text node
 * and only runs the Markdown pass once, when the turn ends.
 */

import { $, el, icon, clear, isAtBottom, shortTime } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { StreamWriter } from './stream-writer.js';
import { VirtualScroller } from './virtual-scroller.js';

const PHASE_LABEL = {
    explore: 'explorando',
    plan: 'planificando',
    act: 'ejecutando',
    reflect: 'informe',
    summarize: 'comprimiendo'
};

/**
 * Entries that keep a live DOM node because they can still change: a tool call
 * waiting for its result, a stream waiting for its final markdown. Anything
 * older is frozen to a string.
 */
const HOT_ENTRIES = 300;

/** Hard ceiling on stored entries. Beyond this the oldest are dropped. */
const MAX_ENTRIES = 50000;

/** How many to discard at once when the ceiling is hit. */
const TRIM_BLOCK = 5000;

export class ChatView {
    constructor() {
        this.scroll = $('#chat-scroll');
        this.list = $('#chat-messages');
        this.welcome = $('#chat-welcome');
        this.streams = new Map();   // id -> {body, think, out: StreamWriter, reason: StreamWriter}
        this.actions = new Map();   // callId -> {node, status, result, detailBox}
        this.showThinking = true;

        /** Every entry, as data. Only the visible slice is ever in the DOM. */
        this.items = [];
        this.dropped = 0;

        // The old #chat-messages container is no longer where entries live; the
        // scroller owns its own spacer inside the same viewport.
        if (this.list) this.list.remove();

        this.scroller = new VirtualScroller({
            viewport: this.scroll,
            estimate: 64,       // a typical entry; corrected once measured
            overscan: 4,
            measure: true,      // chat rows are all different heights
            renderRow: (i) => this._renderRow(i)
        });
    }

    _stick() {
        // Only auto-scroll when the user is already at the bottom; yanking the
        // view away while they are reading an earlier message is maddening.
        return isAtBottom(this.scroll);
    }

    _scroll(wasAtBottom) {
        if (wasAtBottom) this.scroll.scrollTop = this.scroll.scrollHeight;
    }

    _hideWelcome() {
        if (this.welcome && !this.welcome.hidden) this.welcome.hidden = true;
    }

    /**
     * Hand a finished node to the virtual list.
     *
     * Nodes are NOT put in the document here. The scroller mounts only what is
     * on screen, so the transcript length stops mattering: fifty nodes are in
     * the DOM whether there are ten entries or ten million.
     *
     * Recent entries keep their node object because they are still mutable —
     * a tool call gets its result, a stream gets its final markdown. Once an
     * entry falls out of that hot window it is frozen to an HTML string and the
     * node is dropped, which is roughly a tenth of the memory and is what makes
     * a very long session survivable.
     */
    _push(node) {
        const item = { node, html: null };
        this.items.push(item);
        this._cool();
        this.scroller.grow(1);
        return node;
    }

    _cool() {
        const hot = this.items.length - HOT_ENTRIES;
        for (let i = Math.max(0, hot - 32); i < hot; i++) {
            const item = this.items[i];
            if (!item || !item.node) continue;
            item.html = item.node.outerHTML;
            item.node = null;
        }

        // Hard ceiling on the data itself. Objects are cheap next to DOM nodes
        // but not free, and "millions" has to mean bounded, not merely smaller.
        // Trim in blocks, never one at a time. Dropping a single entry per push
        // once over the ceiling means rebuilding the height tree on every
        // message — quadratic, and it wedged the tab at scale. Letting the list
        // overshoot by a block and then cutting the block amortises it away.
        if (this.items.length >= MAX_ENTRIES + TRIM_BLOCK) {
            this.items.splice(0, TRIM_BLOCK);
            this.dropped += TRIM_BLOCK;
            // shrinkFront, not setCount: the latter throws away every measured
            // height and the whole transcript would jump.
            this.scroller.shrinkFront(TRIM_BLOCK);
        }
    }

    /** Called by the scroller for whatever is on screen. */
    _renderRow(index) {
        const item = this.items[index];
        if (!item) return null;

        // A voided entry still occupies an index; it must measure as zero so it
        // takes up no space.
        if (item.void) {
            const gone = document.createElement('div');
            gone.style.height = '0';
            return gone;
        }

        if (item.node) return item.node;

        // Rebuild a frozen entry. Static by then — no listeners to restore.
        const holder = document.createElement('div');
        holder.innerHTML = item.html || '';
        const node = holder.firstElementChild;
        return node || null;
    }

    clearAll() {
        // Cancel any queued frame before the nodes go away, or a pending
        // callback fires against detached elements.
        for (const s of this.streams.values()) { s.out.dispose(); s.reason.dispose(); }
        this.items = [];
        this.dropped = 0;
        this.scroller.setCount(0);
        this.streams.clear();
        this.actions.clear();
        if (this.welcome) this.welcome.hidden = false;
    }

    /** How many entries exist versus how many are actually in the document. */
    stats() {
        return { entries: this.items.length, dropped: this.dropped, domNodes: this.scroller.domNodes };
    }

    addUser(text) {
        this._hideWelcome();
        return this._push(el('div', { class: 'msg msg--user' }, [
            el('div', { class: 'msg-head' }, [icon('edit', 'ico ico--sm'), 'tú', el('span', { class: 'phase' }, shortTime())]),
            el('div', { class: 'msg-body' }, text)
        ]));
    }

    addSystem(text, kind = 'system') {
        this._hideWelcome();
        return this._push(el('div', { class: `msg msg--${kind}` }, [
            el('div', { class: 'msg-body', html: renderMarkdown(text) })
        ]));
    }

    addError(text) {
        this._hideWelcome();
        return this._push(el('div', { class: 'msg msg--error' }, [
            el('div', { class: 'msg-head' }, [icon('warn', 'ico ico--sm'), 'error']),
            el('div', { class: 'msg-body' }, text)
        ]));
    }

    /** Open a streaming assistant message. */
    start(id, phase) {
        this._hideWelcome();

        const body = el('div', { class: 'msg-body typing' });
        const thinkBody = el('div', { class: 'thinking-body' });
        const think = el('details', { class: 'thinking', hidden: true }, [
            el('summary', {}, 'razonamiento del modelo'),
            thinkBody
        ]);

        const wrap = el('div', { class: 'msg msg--agent' }, [
            el('div', { class: 'msg-head' }, [
                icon('brain', 'ico ico--sm'),
                'agente',
                el('span', { class: 'phase' }, PHASE_LABEL[phase] || phase || '')
            ]),
            think,
            body
        ]);

        const startedAt = Date.now();
        const summary = think.querySelector('summary');

        const s = {
            wrap, body, think, thinkBody, summary, thinkTouched: false, startedAt,

            // Answer tokens. Pinned to the chat scroller only.
            out: new StreamWriter({ target: body, scrollers: [this.scroll] }),

            // Reasoning tokens. Pinned to its own box AND the chat scroller,
            // and it owns the live header — all of it once per frame.
            reason: new StreamWriter({
                target: thinkBody,
                scrollers: [thinkBody, this.scroll],
                onFrame: (len) => {
                    summary.textContent =
                        `● pensando… ${len} caracteres · ${Math.round((Date.now() - startedAt) / 1000)}s`;
                }
            })
        };

        this.streams.set(id, s);
        this._push(wrap);
        // Remember where it landed: end() may need to collapse the row to
        // nothing, and the scroller works in indices.
        s.index = this.items.length - 1;
        s.item = this.items[s.index];
        return wrap;
    }

    delta(id, text) {
        const s = this.streams.get(id);
        if (!s) return;
        // Buffered into the next animation frame. See StreamWriter: doing this
        // per token cost a forced layout and a full re-serialisation of the
        // message, thousands of times per turn.
        s.out.write(text);
    }

    thinking(id, text) {
        const s = this.streams.get(id);
        if (!s || !this.showThinking) return;

        s.reason.write(text);
        s.think.hidden = false;

        // Open while it streams. Reasoning is often the longest stretch of a
        // turn, and hiding it behind a closed <details> means the user stares
        // at nothing during precisely the part where the most is happening.
        // It collapses again in end(), so the finished transcript stays tidy.
        if (!s.thinkTouched) { s.think.open = true; s.thinkTouched = true; }
        // The header and the scrolling now happen inside the writer's frame
        // callback, once per frame rather than once per token.
    }

    /** Close a streaming message; renders Markdown and drops empty turns. */
    end(id, text, usage) {
        const s = this.streams.get(id);
        if (!s) return;
        this.streams.delete(id);

        // Force out anything still queued for the next frame. rAF does not run
        // in a hidden tab, and the finished turn must not wait for the user to
        // switch back to it.
        s.out.flush();
        s.reason.flush();

        const streamed = s.out.text;
        const reasoned = s.reason.text;
        const final = (text ?? streamed) || '';
        s.body.classList.remove('typing');

        s.out.dispose();
        s.reason.dispose();

        // Fold the reasoning away now that it is over; it stays one click away.
        if (s.thinkTouched) {
            s.think.open = false;
            const secs = ((Date.now() - (s.startedAt || Date.now())) / 1000).toFixed(0);
            if (s.summary) s.summary.textContent = `razonamiento del modelo · ${reasoned.length} caracteres · ${secs}s`;
        }

        // A turn that was nothing but a tool call has no prose. Showing an
        // empty bubble for it is pure noise — the timeline has the tool call.
        // Voided rather than spliced out: removing the element alone would
        // leave the scroller holding an empty row that still takes up space.
        if (!final.trim() && !reasoned.trim()) {
            s.wrap.remove();
            if (s.item) { s.item.node = null; s.item.html = ''; s.item.void = true; }
            this.scroller.invalidate(s.index);
            return;
        }

        if (final.trim()) s.body.innerHTML = renderMarkdown(final);
        else s.body.remove();

        // The markdown pass changed the height; the scroller has to re-measure.
        this.scroller.schedule();

        if (usage && usage.completionTokens) {
            const head = s.wrap.querySelector('.msg-head');
            head?.appendChild(el('span', { class: 'phase' },
                `${usage.promptTokens}→${usage.completionTokens} tok`));
        }
    }

    /**
     * A phase / step banner. These are the spine of the transcript: without
     * them a long run is an undifferentiated wall of tool calls and you cannot
     * tell where step 2 ended and step 3 began.
     */
    banner(text, kind = '') {
        this._hideWelcome();
        return this._push(el('div', { class: `chat-banner ${kind}` }, [
            el('span', { class: 'chat-banner-text' }, text)
        ]));
    }

    /**
     * A tool call, rendered the moment it starts and updated in place when the
     * result arrives.
     *
     * Everything the agent does lands here. The side panels still exist for
     * filtering and for the full audit trail, but the chat is where people
     * actually look, and an action that only shows up in another tab may as
     * well not have been reported.
     */
    action({ id, name, args }) {
        this._hideWelcome();

        const status = el('span', { class: 'act-status running' }, '·');
        const target = el('span', { class: 'act-target' }, describeArgs(name, args));
        const result = el('div', { class: 'act-result', hidden: true });
        const detailBox = el('div', { class: 'act-detail-wrap' });

        const node = el('div', { class: 'msg msg--action', dataset: { call: id } }, [
            el('div', { class: 'act-head' }, [
                status,
                icon(TOOL_ICON[name] || 'chev-r', 'ico ico--sm'),
                el('span', { class: 'act-name' }, name),
                target,
                el('span', { class: 'act-time' })
            ]),
            result,
            detailBox
        ]);

        this.actions.set(id, { node, status, result, detailBox });
        return this._push(node);
    }

    actionResult({ id, name, ok, summary, detail, durationMs }) {
        const entry = this.actions.get(id);
        // A result with no matching call (replayed history, race on cancel):
        // render it standalone rather than dropping it on the floor.
        if (!entry) {
            this.action({ id, name, args: {} });
            return this.actionResult({ id, name, ok, summary, detail, durationMs });
        }
        this.actions.delete(id);

        entry.node.classList.add(ok ? 'ok' : 'err');
        entry.status.className = `act-status ${ok ? 'ok' : 'err'}`;
        entry.status.textContent = ok ? '✓' : '✗';

        entry.result.hidden = false;
        entry.result.textContent = summary || '';

        const time = entry.node.querySelector('.act-time');
        if (time && durationMs !== undefined) time.textContent = fmtMs(durationMs);

        if (detail) {
            const text = String(detail);
            const long = text.length > 220 || text.includes('\n');
            if (long) {
                entry.detailBox.appendChild(el('details', { class: 'act-detail' }, [
                    el('summary', {}, `ver salida (${text.split('\n').length} líneas)`),
                    el('pre', {}, text.slice(0, 40000))
                ]));
            } else {
                entry.detailBox.appendChild(el('div', { class: 'act-detail-inline' }, text));
            }
        }

        // The row just got taller. The scroller re-measures on its next frame
        // and repositions everything below it, keeping the bottom pinned if it
        // already was.
        this.scroller.schedule();
        return entry.node;
    }

    /** A refused call — wrong tool, bad arguments, blocked command. */
    actionRejected({ name, reason }) {
        this._hideWelcome();
        return this._push(el('div', { class: 'msg msg--action err' }, [
            el('div', { class: 'act-head' }, [
                el('span', { class: 'act-status err' }, '✗'),
                icon('x-circle', 'ico ico--sm'),
                el('span', { class: 'act-name' }, name),
                el('span', { class: 'act-target' }, 'rechazada')
            ]),
            el('div', { class: 'act-result' }, reason)
        ]));
    }

    /** A file changed on disk. Clicking it opens the diff. */
    addDiff({ path, stats, created }, onOpen) {
        this._hideWelcome();
        return this._push(el('div', {
            class: 'msg msg--diff',
            onclick: () => onOpen && onOpen(path)
        }, [
            icon(created ? 'plus' : 'diff', 'ico ico--sm'),
            el('span', { class: 'd-path' }, path),
            created ? el('span', { class: 'd-new' }, 'nuevo') : null,
            el('span', { class: 'd-add' }, `+${stats.added}`),
            el('span', { class: 'd-del' }, `-${stats.removed}`),
            el('span', { class: 'd-open' }, 'ver diff')
        ]));
    }

    /** The unmistakable end-of-run marker. */
    finished({ summaryLine, elapsedMs, steps, files, failed }) {
        this._hideWelcome();
        return this._push(el('div', { class: `chat-done ${failed ? 'bad' : ''}` }, [
            el('div', { class: 'chat-done-head' }, [
                icon(failed ? 'warn' : 'check', 'ico'),
                el('b', {}, failed ? 'Terminado con fallos' : 'Terminado'),
                el('span', { class: 'chat-done-time' }, fmtMs(elapsedMs))
            ]),
            el('div', { class: 'chat-done-body' }, summaryLine),
            el('div', { class: 'chat-done-stats' }, `${steps} · ${files}`)
        ]));
    }
}

const TOOL_ICON = {
    read_file: 'file',
    outline_file: 'list',
    write_file: 'edit',
    edit_file: 'edit',
    list_directory: 'folder',
    search_codebase: 'search',
    run_terminal_command: 'terminal',
    get_project_structure: 'map',
    finish_step: 'check',
    think: 'brain'
};

/** The one argument that identifies the call, on one line. */
function describeArgs(name, args) {
    if (!args) return '';
    if (args.path) {
        const range = args.start_line && args.start_line > 1 ? `  L${args.start_line}+` : '';
        return args.path + range;
    }
    if (args.command) return args.command;
    if (args.query) return `"${args.query}"${args.glob ? `  en ${args.glob}` : ''}`;
    if (args.summary) return String(args.summary).slice(0, 120);
    if (args.thought) return String(args.thought).slice(0, 120);
    const s = JSON.stringify(args);
    return s === '{}' ? '' : s.slice(0, 120);
}

function fmtMs(ms) {
    if (ms === undefined || ms === null) return '';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}
