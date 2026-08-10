/**
 * The one channel between core/ and ui/.
 *
 * The engine never touches the DOM and the UI never calls into the engine's
 * internals; everything crosses here. That is what makes the headless harness
 * possible — it subscribes to the same events and prints them.
 *
 * Handlers are isolated: a throw in one listener must not abort an agent step.
 */

export class Bus {
    constructor() {
        this._handlers = new Map();
        this._any = [];
    }

    on(event, handler) {
        if (!this._handlers.has(event)) this._handlers.set(event, new Set());
        this._handlers.get(event).add(handler);
        return () => this.off(event, handler);
    }

    once(event, handler) {
        const off = this.on(event, (...args) => { off(); handler(...args); });
        return off;
    }

    off(event, handler) {
        this._handlers.get(event)?.delete(handler);
    }

    /** Fires for every event; the timeline and the log file both use this. */
    onAny(handler) {
        this._any.push(handler);
        return () => {
            const i = this._any.indexOf(handler);
            if (i >= 0) this._any.splice(i, 1);
        };
    }

    emit(event, payload) {
        for (const h of this._handlers.get(event) || []) {
            try { h(payload, event); } catch (err) { reportListenerError(event, err); }
        }
        for (const h of this._any) {
            try { h(event, payload); } catch (err) { reportListenerError(event, err); }
        }
    }

    clear() {
        this._handlers.clear();
        this._any.length = 0;
    }
}

function reportListenerError(event, err) {
    // Console only. Routing this back through the bus would recurse on the
    // very listener that is already failing.
    console.error(`[bus] listener de "${event}" falló:`, err);
}

/**
 * Every event the engine can emit. Keeping the names in one frozen object means
 * a typo in the UI is a `undefined` subscription you notice, not a silent miss.
 */
export const EV = Object.freeze({
    STATE: 'state',                   // {from, to}
    STATUS: 'status',                 // {text}
    LOG: 'log',                       // {level, message, data}

    CHAT_USER: 'chat:user',           // {id, text}
    CHAT_START: 'chat:start',         // {id, phase}
    CHAT_DELTA: 'chat:delta',         // {id, text}
    CHAT_THINK: 'chat:think',         // {id, text}
    CHAT_END: 'chat:end',             // {id, text, usage}

    PLAN_DRAFT: 'plan:draft',         // {plan}
    PLAN_UPDATED: 'plan:updated',     // {plan, reason}
    PLAN_APPROVED: 'plan:approved',   // {plan}
    PLAN_REJECTED: 'plan:rejected',   // {reason}

    STEP_START: 'step:start',         // {step, index, total, attempt}
    STEP_DONE: 'step:done',           // {step, index, summary}
    STEP_FAILED: 'step:failed',       // {step, index, error}

    TOOL_CALL: 'tool:call',           // {id, name, args, stepId}
    TOOL_RESULT: 'tool:result',       // {id, name, ok, summary, detail, durationMs}
    TOOL_REJECTED: 'tool:rejected',   // {id, name, reason}

    DIFF: 'diff',                     // {path, before, after, unified, stats}
    TERMINAL: 'terminal',             // {stream, text, command}

    APPROVAL: 'approval',             // {id, kind, title, detail, command?}
    CONTEXT: 'context',               // {used, budget, files, summarized}

    /**
     * Fine-grained "I am doing something right now".
     *
     * {id, label, current?, total?, pct?, indeterminate?, done?, elapsedMs?}
     *
     * Exists because the honest answer to "is it hung?" cannot be a blinking
     * cursor. Every operation that can take longer than about a second — the
     * repo walk, a codebase search, reading a big file, and above all waiting
     * for the model's first token — opens one of these and closes it. `id` is
     * stable for the duration so the UI updates in place instead of printing a
     * hundred lines.
     */
    PROGRESS: 'progress',
    REPO_MAP: 'repomap',              // {map}

    MODEL: 'model',                   // {model, profile, capabilities}
    OLLAMA: 'ollama',                 // {ok, host, error?, models?}
    ERROR: 'error',                   // {message, detail}
    DONE: 'done'                      // {summary, changed}
});
