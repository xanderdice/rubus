/**
 * Ollama client.
 *
 * Beyond the obvious (stream NDJSON, accumulate, report usage) this layer does
 * three things that matter specifically for weak local models:
 *
 *  - **Structured outputs.** Ollama can constrain generation to a JSON schema.
 *    For plan generation and for the no-native-tools path that converts "the
 *    model probably emits valid JSON" into "the model cannot emit anything
 *    else". It is the single highest-leverage trick available here.
 *
 *  - **Capability probing.** `think` must only be sent to models that advertise
 *    thinking, and `tools` only to models that advertise tools — otherwise
 *    Ollama returns a 400 and the turn is wasted. Capabilities are read once
 *    per model and cached.
 *
 *  - **Downgrade on refusal.** If a model rejects `tools` anyway, the error is
 *    caught, recorded, and the caller is told to fall back to the JSON tool
 *    protocol rather than retrying the same failing request three times.
 */

import { withRetry, isAbort, abortError } from './util.js';

export class OllamaError extends Error {
    constructor(message, { status = 0, body = '', kind = 'unknown' } = {}) {
        super(message);
        this.name = 'OllamaError';
        this.status = status;
        this.body = body;
        this.kind = kind; // 'offline' | 'missing-model' | 'no-tools' | 'no-think' | 'http' | 'unknown'
    }
}

export class OllamaClient {
    constructor({ host, fetch: fetchImpl, logger } = {}) {
        this.host = (host || 'http://127.0.0.1:11434').replace(/\/+$/, '');
        this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
        this.logger = logger;
        this._showCache = new Map();
    }

    setHost(host) {
        const next = (host || '').replace(/\/+$/, '');
        if (next && next !== this.host) {
            this.host = next;
            this._showCache.clear();
        }
    }

    async _json(path, body, { signal, timeoutMs = 20000 } = {}) {
        const ctrl = new AbortController();
        const onAbort = () => ctrl.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);

        let res;
        try {
            res = await this.fetch(`${this.host}${path}`, {
                method: body ? 'POST' : 'GET',
                headers: body ? { 'Content-Type': 'application/json' } : undefined,
                body: body ? JSON.stringify(body) : undefined,
                signal: ctrl.signal
            });
        } catch (err) {
            if (signal?.aborted) throw abortError();
            throw new OllamaError(
                `No se puede contactar con Ollama en ${this.host}. ¿Está corriendo "ollama serve"?`,
                { kind: 'offline' }
            );
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        }

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw classifyHttp(res.status, text);
        }
        return await res.json();
    }

    /** `{ok, models}` — never throws, so the UI can render an offline state. */
    async health({ signal } = {}) {
        try {
            const data = await this._json('/api/tags', null, { signal, timeoutMs: 6000 });
            return { ok: true, host: this.host, models: (data.models || []).map(normalizeTag) };
        } catch (err) {
            return { ok: false, host: this.host, error: err.message, kind: err.kind || 'offline', models: [] };
        }
    }

    async listModels({ signal } = {}) {
        const data = await this._json('/api/tags', null, { signal });
        return (data.models || []).map(normalizeTag);
    }

    /** Capabilities + real context length. Cached: it is a slow call. */
    async show(model, { signal } = {}) {
        if (this._showCache.has(model)) return this._showCache.get(model);

        const data = await this._json('/api/show', { model }, { signal, timeoutMs: 30000 });
        const info = data.model_info || {};
        const ctxKey = Object.keys(info).find(k => k.endsWith('.context_length'));

        const detail = {
            model,
            capabilities: data.capabilities || [],
            family: (data.details && data.details.family) || '',
            parameterSize: (data.details && data.details.parameter_size) || '',
            quantization: (data.details && data.details.quantization_level) || '',
            contextLength: ctxKey ? Number(info[ctxKey]) || 0 : 0,
            template: data.template || ''
        };
        this._showCache.set(model, detail);
        return detail;
    }

    async supports(model, capability, { signal } = {}) {
        try {
            const d = await this.show(model, { signal });
            return d.capabilities.includes(capability);
        } catch {
            return false;
        }
    }

    /**
     * One chat turn.
     *
     * Returns `{content, thinking, toolCalls, usage, raw}`. `onDelta` /
     * `onThinking` stream tokens for the UI; nothing downstream depends on
     * them, so a throwing callback cannot break the turn.
     */
    async chat({
        model,
        messages,
        tools,
        format,
        think,
        options = {},
        keepAlive,
        signal,
        onDelta,
        onThinking,
        retries = 3,
        timeoutMs = 600000
    }) {
        const body = {
            model,
            messages,
            stream: true,
            options: {
                temperature: 0.15,
                top_p: 0.9,
                repeat_penalty: 1.05,
                ...options
            }
        };
        if (tools && tools.length) body.tools = tools;
        if (format) body.format = format;
        if (think !== undefined && think !== null) body.think = think;
        if (keepAlive) body.keep_alive = keepAlive;

        return await withRetry(
            (attempt) => this._chatOnce(body, { signal, onDelta, onThinking, timeoutMs, attempt }),
            {
                retries,
                baseMs: 800,
                signal,
                // A 400 means the request itself is wrong; repeating it verbatim
                // is guaranteed to fail again. Only transport faults retry.
                shouldRetry: (err) => err instanceof OllamaError
                    ? ['offline', 'http-5xx'].includes(err.kind)
                    : true,
                onRetry: (n, err, wait) => this.logger?.warn(
                    `Reintento ${n} contra Ollama en ${wait}ms`, { error: err.message }
                )
            }
        );
    }

    async _chatOnce(body, { signal, onDelta, onThinking, timeoutMs }) {
        const ctrl = new AbortController();
        const onAbort = () => ctrl.abort();
        signal?.addEventListener('abort', onAbort, { once: true });

        // Reset on every token: the ceiling is for a stalled stream, not for a
        // slow one. A 27B model on CPU legitimately takes minutes to finish.
        let idleTimer = null;
        const resetIdle = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => ctrl.abort(), timeoutMs);
        };
        resetIdle();

        let res;
        try {
            res = await this.fetch(`${this.host}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: ctrl.signal
            });
        } catch (err) {
            clearTimeout(idleTimer);
            signal?.removeEventListener('abort', onAbort);
            if (signal?.aborted) throw abortError();
            throw new OllamaError(`Sin conexión con Ollama (${this.host}).`, { kind: 'offline' });
        }

        if (!res.ok) {
            clearTimeout(idleTimer);
            signal?.removeEventListener('abort', onAbort);
            const text = await res.text().catch(() => '');
            throw classifyHttp(res.status, text);
        }

        let content = '';
        let thinking = '';
        const toolCalls = [];
        let usage = null;
        let raw = null;

        try {
            for await (const chunk of readNdjson(res, () => resetIdle())) {
                // Ollama reports a failure to parse the model's own tool-call
                // output as an error mid-stream ("XML syntax error…"). That is
                // a malformed generation, not a broken server: retrying the
                // identical request reproduces it. Mark it so the engine can
                // treat it as a bad turn and ask the model to try again.
                if (chunk.error) throw new OllamaError(String(chunk.error), { kind: classifyStreamError(chunk.error) });
                raw = chunk;

                const msg = chunk.message;
                if (msg) {
                    if (msg.content) {
                        content += msg.content;
                        if (onDelta) { try { onDelta(msg.content); } catch { /* UI only */ } }
                    }
                    if (msg.thinking) {
                        thinking += msg.thinking;
                        if (onThinking) { try { onThinking(msg.thinking); } catch { /* UI only */ } }
                    }
                    if (Array.isArray(msg.tool_calls)) {
                        for (const tc of msg.tool_calls) toolCalls.push(tc);
                    }
                }

                if (chunk.done) {
                    usage = {
                        promptTokens: chunk.prompt_eval_count || 0,
                        completionTokens: chunk.eval_count || 0,
                        totalMs: Math.round((chunk.total_duration || 0) / 1e6),
                        doneReason: chunk.done_reason || ''
                    };
                }
            }
        } catch (err) {
            if (signal?.aborted) throw abortError();
            if (isAbort(err)) {
                throw new OllamaError(
                    `Ollama dejó de responder (sin tokens durante ${Math.round(timeoutMs / 1000)}s).`,
                    { kind: 'offline' }
                );
            }
            throw err;
        } finally {
            clearTimeout(idleTimer);
            signal?.removeEventListener('abort', onAbort);
        }

        return { content, thinking, toolCalls: toolCalls.map(normalizeToolCall), usage, raw };
    }
}

/**
 * Read a streaming NDJSON body line by line.
 *
 * Falls back to reading the whole body when the browser does not expose
 * `response.body` as a stream — older Safari builds and several in-app
 * webviews. The turn still works, it just arrives all at once instead of
 * token by token, so the chat stops typing and starts appearing.
 */
async function* readNdjson(res, onData) {
    if (!res.body || typeof res.body.getReader !== 'function') {
        const text = await res.text();
        onData?.();
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try { yield JSON.parse(trimmed); } catch { /* línea parcial */ }
        }
        return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            onData?.();
            buf += decoder.decode(value, { stream: true });

            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                try { yield JSON.parse(line); }
                catch { /* a partial line at a chunk edge; the next read completes it */ }
            }
        }
        const tail = buf.trim();
        if (tail) { try { yield JSON.parse(tail); } catch { /* truncated tail */ } }
    } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
    }
}

/**
 * Ollama reports "this model can't do that" as a plain 400 with prose. The
 * caller needs to distinguish those from real faults, because the response is
 * to change strategy, not to retry.
 */
function classifyHttp(status, text) {
    const lower = (text || '').toLowerCase();

    if (lower.includes('does not support tools') || lower.includes('tools are not supported')) {
        return new OllamaError('El modelo no soporta tool calling nativo.', { status, body: text, kind: 'no-tools' });
    }
    if (lower.includes('does not support thinking') || lower.includes('thinking is not supported')) {
        return new OllamaError('El modelo no soporta modo "thinking".', { status, body: text, kind: 'no-think' });
    }
    if (status === 404 || lower.includes('not found, try pulling')) {
        return new OllamaError(
            `El modelo no está descargado. Ejecuta "ollama pull <modelo>".`,
            { status, body: text, kind: 'missing-model' }
        );
    }
    if (status >= 500) {
        return new OllamaError(`Ollama devolvió ${status}. ${trim(text)}`, { status, body: text, kind: 'http-5xx' });
    }
    return new OllamaError(`Ollama devolvió ${status}. ${trim(text)}`, { status, body: text, kind: 'http' });
}

/** Distinguish "the model produced garbage" from "the server broke". */
function classifyStreamError(message) {
    const s = String(message || '').toLowerCase();
    return /syntax error|unable to parse|invalid character|unexpected end|failed to parse|tool call/.test(s)
        ? 'parse'
        : 'http';
}

function trim(s) {
    const t = String(s || '').trim();
    return t.length > 300 ? t.slice(0, 300) + '…' : t;
}

function normalizeTag(m) {
    const d = m.details || {};
    return {
        name: m.name || m.model,
        size: m.size || 0,
        family: d.family || '',
        parameterSize: d.parameter_size || '',
        quantization: d.quantization_level || '',
        contextLength: Number(d.context_length) || 0,
        capabilities: m.capabilities || []
    };
}

/** Ollama sometimes hands back `arguments` as a JSON string instead of an object. */
function normalizeToolCall(tc) {
    const fn = tc.function || tc;
    let args = fn.arguments;
    if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = { _raw: args }; }
    }
    return { name: fn.name, args: args || {}, source: 'native' };
}
