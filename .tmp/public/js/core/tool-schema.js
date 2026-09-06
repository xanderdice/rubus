/**
 * Tool argument validation.
 *
 * The rule this file implements: **be strict about what a tool receives, and
 * generous about how the model spells it.** A missing required argument is an
 * error the model must fix. A `file_path` where the schema says `path`, or the
 * string `"3"` where it says integer, is not — that is noise, and bouncing it
 * back costs a round trip that a weak model may well fail again.
 *
 * So: coerce types, remap near-miss key names, drop unknown extras with a
 * warning, and only refuse when the call is genuinely unusable.
 */

/** Common aliases, checked before the fuzzy matcher. */
const ALIASES = {
    path: ['file_path', 'filepath', 'filename', 'file', 'file_name', 'target', 'ruta', 'archivo', 'dir', 'directory', 'folder'],
    content: ['text', 'data', 'body', 'file_content', 'new_content', 'contenido', 'source', 'code'],
    old_text: ['old', 'old_string', 'search', 'find', 'from', 'original', 'target_text'],
    new_text: ['new', 'new_string', 'replace', 'replacement', 'to', 'result'],
    query: ['q', 'search', 'pattern', 'text', 'term', 'busqueda', 'search_term', 'keyword'],
    command: ['cmd', 'shell', 'script', 'comando', 'run'],
    summary: ['result', 'message', 'description', 'resumen', 'text'],
    thought: ['thinking', 'reasoning', 'idea', 'note', 'pensamiento']
};

export function validateArgs(spec, rawArgs) {
    const params = spec.params || {};
    const errors = [];
    const warnings = [];
    const args = {};

    const incoming = { ...(rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) };

    // Ollama occasionally nests the real arguments one level deep.
    if (Object.keys(incoming).length === 1) {
        const only = Object.keys(incoming)[0];
        if (['args', 'arguments', 'parameters', 'params', 'input'].includes(only)
            && incoming[only] && typeof incoming[only] === 'object') {
            Object.assign(incoming, incoming[only]);
            delete incoming[only];
            warnings.push('argumentos desanidados');
        }
    }

    // Map whatever came in onto the names the tool actually declares.
    const claimed = new Set();
    for (const key of Object.keys(params)) {
        if (key in incoming) { claimed.add(key); continue; }

        const alias = (ALIASES[key] || []).find(a => a in incoming && !claimed.has(a));
        if (alias) {
            incoming[key] = incoming[alias];
            delete incoming[alias];
            claimed.add(key);
            warnings.push(`"${alias}" interpretado como "${key}"`);
            continue;
        }

        const near = Object.keys(incoming).find(k =>
            !claimed.has(k) && !(k in params) && editDistance(k.toLowerCase(), key.toLowerCase()) <= 2
        );
        if (near) {
            incoming[key] = incoming[near];
            delete incoming[near];
            claimed.add(key);
            warnings.push(`"${near}" interpretado como "${key}"`);
        }
    }

    for (const [key, def] of Object.entries(params)) {
        const present = key in incoming && incoming[key] !== null && incoming[key] !== undefined;

        if (!present) {
            if (def.required) {
                errors.push(`falta el parámetro obligatorio "${key}" (${def.type}): ${def.description || ''}`.trim());
            } else if (def.default !== undefined) {
                args[key] = def.default;
            }
            continue;
        }

        const coerced = coerce(incoming[key], def, key);
        if (coerced.error) { errors.push(coerced.error); continue; }
        if (coerced.warning) warnings.push(coerced.warning);

        if (def.required && typeof coerced.value === 'string' && !coerced.value.trim()) {
            errors.push(`"${key}" no puede estar vacío`);
            continue;
        }
        if (def.enum && !def.enum.includes(coerced.value)) {
            errors.push(`"${key}" debe ser uno de: ${def.enum.join(', ')} (recibido: ${coerced.value})`);
            continue;
        }
        if (def.type === 'integer' || def.type === 'number') {
            if (def.min !== undefined && coerced.value < def.min) coerced.value = def.min;
            if (def.max !== undefined && coerced.value > def.max) coerced.value = def.max;
        }

        args[key] = coerced.value;
    }

    for (const key of Object.keys(incoming)) {
        if (!(key in params)) warnings.push(`parámetro desconocido "${key}" ignorado`);
    }

    return { ok: errors.length === 0, args, errors, warnings };
}

function coerce(value, def, key) {
    const type = def.type || 'string';

    switch (type) {
        case 'string': {
            if (typeof value === 'string') return { value };
            if (typeof value === 'number' || typeof value === 'boolean') {
                return { value: String(value), warning: `"${key}" convertido a texto` };
            }
            if (Array.isArray(value)) {
                return { value: value.join('\n'), warning: `"${key}" era una lista, se unió por líneas` };
            }
            if (value && typeof value === 'object') {
                return { error: `"${key}" debe ser texto, no un objeto` };
            }
            return { value: String(value) };
        }

        case 'integer':
        case 'number': {
            const n = typeof value === 'number' ? value : Number(String(value).trim());
            if (!Number.isFinite(n)) return { error: `"${key}" debe ser un número (recibido: ${JSON.stringify(value)})` };
            const v = type === 'integer' ? Math.trunc(n) : n;
            return { value: v, warning: typeof value === 'number' ? undefined : `"${key}" convertido a número` };
        }

        case 'boolean': {
            if (typeof value === 'boolean') return { value };
            const s = String(value).trim().toLowerCase();
            if (['true', '1', 'yes', 'si', 'sí', 'y'].includes(s)) return { value: true, warning: `"${key}" convertido a booleano` };
            if (['false', '0', 'no', 'n'].includes(s)) return { value: false, warning: `"${key}" convertido a booleano` };
            return { error: `"${key}" debe ser true o false` };
        }

        case 'array': {
            if (Array.isArray(value)) return { value: value.map(String) };
            if (typeof value === 'string') {
                const parts = value.includes('\n') ? value.split('\n') : value.split(',');
                return {
                    value: parts.map(s => s.trim()).filter(Boolean),
                    warning: `"${key}" era texto, se dividió en lista`
                };
            }
            return { error: `"${key}" debe ser una lista` };
        }

        default:
            return { value };
    }
}

/** Bounded Levenshtein; only used on short identifier names. */
function editDistance(a, b) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > 2) return 99;
    const prev = new Array(b.length + 1);
    const cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        cur[0] = i;
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
}

const JSON_TYPE = { integer: 'integer', number: 'number', boolean: 'boolean', array: 'array', string: 'string' };

/** OpenAI-style function schema, for models with native tool calling. */
export function toOllamaTool(spec) {
    const properties = {};
    const required = [];

    for (const [key, def] of Object.entries(spec.params || {})) {
        const p = { type: JSON_TYPE[def.type] || 'string', description: def.description || '' };
        if (def.enum) p.enum = def.enum;
        if (def.type === 'array') p.items = { type: 'string' };
        properties[key] = p;
        if (def.required) required.push(key);
    }

    return {
        type: 'function',
        function: {
            name: spec.name,
            description: spec.description,
            parameters: { type: 'object', properties, required }
        }
    };
}

/**
 * A JSON schema that admits exactly one tool call, for models without native
 * tools. Constraining `tool` to an enum is what stops Gemma inventing tool
 * names — it becomes physically impossible, not merely discouraged.
 *
 * `args` stays a free-form object: a discriminated union per tool would be more
 * precise, but grammar-constrained sampling gets unreliable with large anyOf
 * blocks, and validateArgs already catches whatever comes through.
 */
export function toProtocolSchema(specs) {
    return {
        type: 'object',
        properties: {
            tool: { type: 'string', enum: specs.map(s => s.name) },
            args: { type: 'object' }
        },
        required: ['tool', 'args']
    };
}

/** Compact, readable tool docs for the system prompt. */
export function describeTools(specs) {
    return specs.map(spec => {
        const params = Object.entries(spec.params || {}).map(([k, d]) => {
            const flag = d.required ? 'obligatorio' : `opcional${d.default !== undefined ? `, por defecto ${JSON.stringify(d.default)}` : ''}`;
            return `    - ${k} (${d.type}, ${flag}): ${d.description || ''}`;
        });

        const example = spec.examples && spec.examples[0];
        const lines = [
            `● ${spec.name}${spec.readOnly ? '' : '  [MODIFICA ARCHIVOS]'}`,
            `    ${spec.description}`,
            ...params
        ];
        if (example) lines.push(`    ejemplo: ${JSON.stringify({ tool: spec.name, args: example.args })}`);
        return lines.join('\n');
    }).join('\n\n');
}
