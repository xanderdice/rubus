/**
 * Pull-based reader over the agent's bus.
 *
 * The DOM view is one way to consume an agent; this is the other, and it needs
 * no DOM at all. You ask for the next chunk and you get whatever the model has
 * produced since you last asked:
 *
 *     agent.run('arregla el bug');            // sin await
 *     let chunk;
 *     while ((chunk = await agent.read())) {
 *         process.stdout.write(chunk.text);
 *     }
 *
 * Design decisions worth knowing:
 *
 *  · **Coalescing, not per-token.** Ollama emits a token at a time. Handing
 *    those over one by one would make the consumer do a round trip per token
 *    for no benefit, so a read returns everything buffered since the previous
 *    one. Read in a tight loop and you get near-per-token; read every 200ms and
 *    you get 200ms worth. Either way nothing is lost or duplicated.
 *
 *  · **Text and events are separate.** `text` is exactly what the model wrote —
 *    no framing, no decoration — because that is what a caller wants to pipe
 *    somewhere. Everything else the agent did (tool calls, results, diffs,
 *    steps) arrives as structured `events`, with a ready-made human-readable
 *    line in `event.line` for consumers that just want to print it all.
 *
 *  · **Backpressure is bounded, not infinite.** A consumer that stops reading
 *    must not grow the buffer without limit, so the text buffer is capped and
 *    drops from the middle, and the event queue drops the oldest. Both report
 *    what they dropped rather than lying about it.
 */

import { EV } from '../core/bus.js';
import { deferred } from '../core/util.js';

const MAX_TEXT_CHARS = 2_000_000;
const MAX_EVENTS = 5000;

/** Events that carry no useful information to an external consumer. */
const SKIP = new Set([EV.CHAT_DELTA, EV.CHAT_THINK, EV.CHAT_START, EV.LOG, EV.CONTEXT]);

export class AgentStream {
    constructor(bus, { includeLogs = false } = {}) {
        this.bus = bus;
        this.includeLogs = includeLogs;

        this._text = '';
        this._thinking = '';
        this._events = [];
        this._dropped = { text: 0, events: 0 };

        this._state = 'idle';
        /** True once the current run ended and nothing is left to hand over. */
        this._finished = false;
        this._closed = false;
        this._waiter = null;

        this._off = [];
        this._subscribe();
    }

    _subscribe() {
        const on = (ev, fn) => this._off.push(this.bus.on(ev, fn));

        on(EV.CHAT_DELTA, ({ text }) => { this._pushText('_text', text); this._wake(); });
        on(EV.CHAT_THINK, ({ text }) => { this._pushText('_thinking', text); this._wake(); });

        this._off.push(this.bus.onAny((name, payload) => {
            if (SKIP.has(name)) return;
            if (name === EV.LOG && !this.includeLogs) return;

            if (name === EV.STATE) {
                this._state = payload.to;
                // A new run re-arms a stream that had already ended, so the
                // same `while (await read())` loop works for the next task.
                if (payload.to === 'exploring' || payload.to === 'planning') this._finished = false;
            }

            this._pushEvent({ type: name, at: Date.now(), line: formatEvent(name, payload), ...payload });

            if (name === EV.DONE || name === EV.ERROR) this._finished = true;
            this._wake();
        }));
    }

    _pushText(field, text) {
        if (!text) return;
        this[field] += text;
        if (this[field].length > MAX_TEXT_CHARS) {
            const overflow = this[field].length - MAX_TEXT_CHARS;
            this[field] = this[field].slice(overflow);
            this._dropped.text += overflow;
        }
    }

    _pushEvent(ev) {
        this._events.push(ev);
        if (this._events.length > MAX_EVENTS) {
            this._dropped.events += this._events.length - MAX_EVENTS;
            this._events.splice(0, this._events.length - MAX_EVENTS);
        }
    }

    _wake() {
        const w = this._waiter;
        if (!w) return;
        this._waiter = null;
        clearTimeout(w.timer);
        w.resolve();
    }

    get pending() {
        return this._text.length > 0 || this._thinking.length > 0 || this._events.length > 0;
    }

    _drain(extra = {}) {
        const chunk = {
            text: this._text,
            thinking: this._thinking,
            events: this._events,
            state: this._state,
            done: this._finished,
            ...extra
        };
        if (this._dropped.text || this._dropped.events) {
            chunk.dropped = { ...this._dropped };
            this._dropped = { text: 0, events: 0 };
        }
        this._text = '';
        this._thinking = '';
        this._events = [];
        return chunk;
    }

    /**
     * Next chunk of the run.
     *
     * @param {object} [opts]
     * @param {number} [opts.timeoutMs] Give up waiting and return an empty
     *   chunk instead of blocking. Useful for a polling UI loop.
     * @returns {Promise<object|null>} `null` when the run has finished and
     *   everything has been handed over — that is the end of the loop.
     */
    async read({ timeoutMs = 0 } = {}) {
        if (this._closed) return null;
        if (this.pending) return this._drain();
        if (this._finished) return null;

        const d = deferred();
        const w = { resolve: d.resolve, timer: null };
        if (timeoutMs > 0) {
            w.timer = setTimeout(() => { this._waiter = null; d.resolve(); }, timeoutMs);
        }
        this._waiter = w;
        await d.promise;

        if (this._closed) return null;
        if (this.pending) return this._drain();
        if (this._finished) return null;
        return this._drain({ timedOut: true });   // woke on timeout, nothing new
    }

    /** `for await (const chunk of agent.stream())` */
    async *[Symbol.asyncIterator]() {
        for (;;) {
            const chunk = await this.read();
            if (chunk === null) return;
            yield chunk;
        }
    }

    /** Only the model's words, concatenated, until the run ends. */
    async readAllText() {
        let out = '';
        for await (const chunk of this) out += chunk.text;
        return out;
    }

    close() {
        this._closed = true;
        for (const off of this._off) off();
        this._off.length = 0;
        this._wake();
    }
}

/**
 * One readable line per event, so a consumer that only prints can still see
 * everything the agent did without knowing the event schema.
 */
export function formatEvent(name, p = {}) {
    switch (name) {
        case EV.CHAT_USER: return `» ${p.text}`;
        case EV.CHAT_END: return '';
        case EV.STATE: return `── ${p.to}`;
        case EV.STATUS: return p.text || '';
        case EV.PLAN_DRAFT:
        case EV.PLAN_UPDATED:
            return `plan (${p.plan.steps.length} pasos): ${p.plan.goal}\n` +
                p.plan.steps.map(s => `   ${s.id}. ${s.title}`).join('\n');
        case EV.PLAN_APPROVED: return 'plan aprobado';
        case EV.PLAN_REJECTED: return `plan rechazado${p.reason ? `: ${p.reason}` : ''}`;
        case EV.STEP_START: return `── paso ${p.index + 1}/${p.total}: ${p.step.title}${p.attempt > 1 ? ` (intento ${p.attempt})` : ''}`;
        case EV.STEP_DONE: return `✓ paso ${p.step.id}: ${p.summary}`;
        case EV.STEP_FAILED: return `✗ paso ${p.step.id}: ${p.error}`;
        case EV.TOOL_CALL: return `▸ ${p.name} ${compact(p.args)}`;
        case EV.TOOL_RESULT: return `  ${p.ok ? '✓' : '✗'} ${p.summary}`;
        case EV.TOOL_REJECTED: return `  ✗ ${p.name} rechazada: ${p.reason}`;
        case EV.DIFF: return `± ${p.path} +${p.stats.added} -${p.stats.removed}`;
        case EV.TERMINAL: return p.stream === 'cmd' ? `$ ${p.command}` : '';
        case EV.APPROVAL: return `⚠ permiso [${p.risk}]: ${p.command || p.title} — responde con approveRequest("${p.id}", true|false)`;
        case EV.ERROR: return `ERROR: ${p.message}`;
        case EV.DONE: return `── terminado: ${p.progress.done}/${p.progress.total} pasos, ${p.changed.length} archivo(s)`;
        case EV.MODEL: return `modelo: ${p.model}`;
        case EV.OLLAMA: return p.ok ? `ollama ok (${p.models.length} modelos)` : `ollama caído: ${p.error}`;
        default: return '';
    }
}

function compact(args) {
    if (!args) return '';
    const s = JSON.stringify(args);
    return s.length > 120 ? s.slice(0, 120) + '…' : s;
}
