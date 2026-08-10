/**
 * Getting a tool call out of whatever the model actually said.
 *
 * With native tool calling this file is barely used. Without it — Gemma, and
 * any model that ignores the tools array — the "tool call" arrives as text, and
 * that text is wrong in a small number of very predictable ways:
 *
 *   ```json fences · `<tool_call>` tags · prose wrapped around the object ·
 *   trailing commas · single quotes · Python True/False/None · unquoted keys ·
 *   truncated output with unclosed braces · `{"tool": {...}}` shaped five
 *   different ways
 *
 * Every one of those is recoverable, and recovering it costs nothing, while
 * bouncing it back to the model costs a full round trip and often produces the
 * same mistake again. So the parser is deliberately forgiving about *syntax*
 * and completely unforgiving about *semantics* — a repaired call still has to
 * pass schema validation before anything runs.
 */

const THINK_TAGS = /<(think|thinking|reasoning|scratchpad)>[\s\S]*?<\/\1>/gi;
const OPEN_THINK = /<(think|thinking|reasoning|scratchpad)>[\s\S]*$/i;

/** Remove reasoning blocks, including one left unclosed by a cut-off stream. */
export function stripThinking(text) {
    return String(text ?? '').replace(THINK_TAGS, '').replace(OPEN_THINK, '').trim();
}

/** Strip ```lang fences, keeping the contents. */
export function stripFences(text) {
    const s = String(text ?? '').trim();
    const m = s.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/);
    return m ? m[1].trim() : s;
}

/**
 * Parse JSON, trying progressively more invasive repairs. Returns the parsed
 * value plus the list of repairs applied, so the caller can log what the model
 * got wrong without failing the turn over it.
 */
export function parseLooseJson(input) {
    const repairs = [];
    let text = stripFences(String(input ?? '').trim());
    if (!text) return { ok: false, error: 'vacío', repairs };

    const attempt = (label, transform) => {
        const next = transform(text);
        if (next === text) return null;
        text = next;
        repairs.push(label);
        try { return JSON.parse(text); } catch { return null; }
    };

    try { return { ok: true, value: JSON.parse(text), repairs }; } catch { /* keep going */ }

    let v = attempt('comentarios eliminados', stripJsonComments);
    if (v !== null) return { ok: true, value: v, repairs };

    v = attempt('comas finales eliminadas', s => s.replace(/,(\s*[}\]])/g, '$1'));
    if (v !== null) return { ok: true, value: v, repairs };

    v = attempt('literales de Python convertidos', s =>
        s.replace(/(^|[\s:,[{])True([\s,}\]]|$)/g, '$1true$2')
            .replace(/(^|[\s:,[{])False([\s,}\]]|$)/g, '$1false$2')
            .replace(/(^|[\s:,[{])None([\s,}\]]|$)/g, '$1null$2'));
    if (v !== null) return { ok: true, value: v, repairs };

    v = attempt('claves entrecomilladas', s => s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3'));
    if (v !== null) return { ok: true, value: v, repairs };

    v = attempt('comillas simples convertidas', singleToDoubleQuotes);
    if (v !== null) return { ok: true, value: v, repairs };

    v = attempt('delimitadores cerrados', closeDelimiters);
    if (v !== null) return { ok: true, value: v, repairs };

    return { ok: false, error: 'no es JSON válido ni reparable', repairs, text };
}

function stripJsonComments(s) {
    let out = '';
    let quote = null;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quote) {
            out += c;
            if (c === '\\') { out += s[++i] ?? ''; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'") { quote = c; out += c; continue; }
        if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; out += '\n'; continue; }
        if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; continue; }
        out += c;
    }
    return out;
}

/** Only rewrites quotes acting as delimiters; apostrophes inside strings survive. */
function singleToDoubleQuotes(s) {
    let out = '';
    let quote = null;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quote) {
            if (c === '\\') { out += c + (s[++i] ?? ''); continue; }
            if (c === quote) { out += '"'; quote = null; continue; }
            out += c === '"' ? '\\"' : c;
            continue;
        }
        if (c === "'") { quote = "'"; out += '"'; continue; }
        if (c === '"') { quote = '"'; out += '"'; continue; }
        out += c;
    }
    return out;
}

/** Close whatever a truncated stream left open, discarding a dangling key. */
function closeDelimiters(s) {
    const stack = [];
    let quote = null;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (quote) {
            if (c === '\\') { i++; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '"') { quote = '"'; continue; }
        if (c === '{' || c === '[') stack.push(c);
        else if (c === '}' || c === ']') stack.pop();
    }

    let out = s;
    // Finish a string the stream cut in half, then drop whatever dangles after
    // it: a bare separator, or a key that never got a value.
    if (quote) out += quote;
    out = out.replace(/,\s*$/, '');
    out = out.replace(/:\s*$/, ': null');
    out = out.replace(/([{[,])\s*"[^"]*"\s*$/, '$1');
    out = out.replace(/,\s*$/, '');

    while (stack.length) out += stack.pop() === '{' ? '}' : ']';
    return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Every balanced `{...}` in the text, outermost first, in order. */
export function extractJsonObjects(text) {
    const s = String(text ?? '');
    const found = [];
    for (let i = 0; i < s.length; i++) {
        if (s[i] !== '{') continue;
        const end = matchBrace(s, i);
        if (end < 0) continue;
        found.push(s.slice(i, end + 1));
        i = end; // outermost only; nested objects come along inside the parent
    }
    return found;
}

function matchBrace(s, start) {
    let depth = 0;
    let quote = null;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (quote) {
            if (c === '\\') { i++; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'") { quote = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (!depth) return i; }
    }
    return -1;
}

/**
 * Coerce one of the many shapes a model might use into `{name, args}`.
 * Returns null when the object plainly is not a tool call.
 */
export function normalizeCallShape(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

    // {"function": {"name": ..., "arguments": {...}}}
    if (obj.function && typeof obj.function === 'object') {
        const inner = normalizeCallShape(obj.function);
        if (inner) return inner;
    }

    const name = firstString(obj, ['tool', 'name', 'tool_name', 'toolName', 'action', 'function_name', 'recipient_name']);
    if (!name) return null;

    let args = firstObject(obj, ['args', 'arguments', 'parameters', 'params', 'input', 'action_input', 'tool_input']);

    // Some models flatten the arguments next to the name instead of nesting.
    if (!args) {
        const rest = { ...obj };
        for (const k of ['tool', 'name', 'tool_name', 'toolName', 'action', 'function_name', 'recipient_name', 'thought', 'reasoning', 'function']) {
            delete rest[k];
        }
        args = Object.keys(rest).length ? rest : {};
    }

    if (typeof args === 'string') {
        const parsed = parseLooseJson(args);
        args = parsed.ok && parsed.value && typeof parsed.value === 'object' ? parsed.value : { _raw: args };
    }

    return { name: String(name).trim(), args: args || {} };
}

function firstString(obj, keys) {
    for (const k of keys) if (typeof obj[k] === 'string' && obj[k].trim()) return obj[k];
    return null;
}

function firstObject(obj, keys) {
    for (const k of keys) {
        if (obj[k] && (typeof obj[k] === 'object' || typeof obj[k] === 'string')) return obj[k];
    }
    return null;
}

/**
 * Pull tool calls out of a model turn.
 *
 * @param {object} turn        `{content, toolCalls}` as returned by OllamaClient
 * @param {string[]} knownTools Names that exist. A candidate naming something
 *                              else is reported as `unknown` rather than being
 *                              silently dropped, so the engine can say why.
 * @returns {{calls, unknown, text, repairs, strategy}}
 */
export function parseToolCalls(turn, knownTools = []) {
    const known = new Set(knownTools);
    const repairs = [];

    // 1. Native. Nothing to guess.
    if (turn.toolCalls && turn.toolCalls.length) {
        const calls = [];
        const unknown = [];
        for (const tc of turn.toolCalls) {
            const shaped = { name: String(tc.name || '').trim(), args: tc.args || {}, source: 'native' };
            if (!shaped.name) continue;
            (known.size === 0 || known.has(shaped.name) ? calls : unknown).push(shaped);
        }
        if (calls.length || unknown.length) {
            return { calls, unknown, text: stripThinking(turn.content || ''), repairs, strategy: 'native' };
        }
    }

    const content = stripThinking(turn.content || '');
    if (!content) return { calls: [], unknown: [], text: '', repairs, strategy: 'none' };

    const candidates = [];
    const push = (raw, strategy) => { if (raw && raw.trim()) candidates.push({ raw, strategy }); };

    // 2. Qwen-style tags, including one the stream cut short.
    for (const m of content.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/gi)) push(m[1], 'tag');
    if (!candidates.length) {
        const open = content.match(/<tool_call>([\s\S]*)$/i);
        if (open) push(open[1], 'tag-unclosed');
    }

    // 3. Fenced blocks.
    if (!candidates.length) {
        for (const m of content.matchAll(/```(?:json|tool_code|tool|js)?\s*\n?([\s\S]*?)```/gi)) push(m[1], 'fence');
    }

    // 4. The whole turn as one object, then any balanced object inside it.
    if (!candidates.length) {
        const trimmed = content.trim();
        if (trimmed.startsWith('{')) push(trimmed, 'whole');
        for (const raw of extractJsonObjects(content)) push(raw, 'embedded');
    }

    // 5. Line protocol, for models that refuse JSON entirely. Appended rather
    //    than gated on `candidates.length`: an embedded `{...}` may well parse
    //    as JSON and still not be a tool call, and this is the fallback for
    //    exactly that case.
    const nameLine = content.match(/^\s*(?:TOOL|HERRAMIENTA)\s*[:=]\s*([A-Za-z_][\w]*)/im);
    if (nameLine) {
        const argsLine = content.match(/^\s*(?:ARGS|ARGUMENTS|PARAMS)\s*[:=]\s*(\{[\s\S]*)/im);
        push(JSON.stringify({
            tool: nameLine[1],
            args: argsLine ? tryParse(argsLine[1]) : {}
        }), 'lines');
    }

    const calls = [];
    const unknown = [];
    let strategy = 'none';

    for (const { raw, strategy: how } of candidates) {
        const parsed = parseLooseJson(raw);
        if (!parsed.ok) continue;
        repairs.push(...parsed.repairs);

        // A model may answer with a bare array of calls.
        const items = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
        for (const item of items) {
            const shaped = normalizeCallShape(item);
            if (!shaped || !shaped.name) continue;
            shaped.source = how;
            if (known.size === 0 || known.has(shaped.name)) { calls.push(shaped); strategy = how; }
            else unknown.push(shaped);
        }
        if (calls.length) break; // first block that yields a real call wins
    }

    return {
        calls,
        unknown,
        text: calls.length ? stripCallSyntax(content) : content,
        repairs: [...new Set(repairs)],
        strategy: calls.length ? strategy : 'none'
    };
}

function tryParse(s) {
    const r = parseLooseJson(s);
    return r.ok ? r.value : {};
}

/** Remove the machinery from the prose so the chat pane shows only the message. */
function stripCallSyntax(text) {
    return text
        .replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/gi, '')
        .replace(/```(?:json|tool_code|tool)?\s*\n?[\s\S]*?```/gi, '')
        .trim();
}
