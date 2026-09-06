/**
 * Per-model behaviour.
 *
 * The two target models fail in different ways and need different handling:
 *
 *   Qwen3.6  — has native tool calling and a thinking mode. Its failure mode is
 *              verbosity: it will happily emit three tool calls at once, narrate
 *              a plan it then ignores, and leak `<tool_call>` tags into prose.
 *              So: native tools on, thinking on only while planning, and the
 *              engine takes the FIRST call and discards the rest.
 *
 *   Gemma4   — no native tool calling and, in most Gemma chat templates, no
 *              system role. Its failure mode is format drift: prose wrapped
 *              around JSON, markdown fences, invented keys. So: system prompt
 *              folded into the first user message, and every turn constrained
 *              by a JSON schema so it physically cannot emit prose.
 *
 * A profile is a *starting guess* from the model name. Whatever Ollama reports
 * in `capabilities` overrides it — the name is a hint, the probe is the truth.
 */

const BASE = {
    id: 'generic',
    label: 'Modelo genérico',
    nativeTools: false,
    supportsThinking: false,
    mergeSystemIntoUser: false,
    forceJsonProtocol: true,
    temperature: 0.15,
    topP: 0.9,
    repeatPenalty: 1.05,
    numPredict: 3072,
    // How many tools to put in front of the model at once. Every extra tool is
    // another wrong answer it can pick; weak models degrade fast past ~8.
    maxTools: 8,
    promptAddendum: ''
};

const PROFILES = [
    {
        id: 'qwen3',
        label: 'Qwen 3.x',
        match: (name, family) => /qwen\s*3/i.test(name) || /^qwen3/i.test(family) || /qwen3.*moe/i.test(family),
        nativeTools: true,
        supportsThinking: true,
        mergeSystemIntoUser: false,
        forceJsonProtocol: false,
        temperature: 0.15,
        topP: 0.9,
        repeatPenalty: 1.05,
        numPredict: 4096,
        maxTools: 8,
        promptAddendum: [
            'FORMATO (Qwen):',
            '- Emite EXACTAMENTE UNA llamada a herramienta por turno. Si emites varias, sólo se ejecutará la primera y el resto se descartará.',
            '- No escribas etiquetas <tool_call> dentro de texto normal. Usa el mecanismo de herramientas.',
            '- No repitas el plan en cada turno. Ya está en el contexto.'
        ].join('\n')
    },
    {
        id: 'gemma',
        label: 'Gemma',
        match: (name, family) => /gemma/i.test(name) || /gemma/i.test(family),
        nativeTools: false,
        supportsThinking: false,
        // Most Gemma chat templates have no system turn; Ollama papers over it
        // by prepending, but folding it in ourselves is deterministic.
        mergeSystemIntoUser: true,
        forceJsonProtocol: true,
        temperature: 0.1,
        topP: 0.9,
        repeatPenalty: 1.08,
        numPredict: 2560,
        maxTools: 6,
        promptAddendum: [
            'FORMATO (Gemma):',
            '- Tu respuesta COMPLETA debe ser un único objeto JSON. Nada antes, nada después.',
            '- Prohibido: ```json, explicaciones, disculpas, saludos, texto fuera del JSON.',
            '- Si necesitas explicar algo, ponlo dentro del campo correspondiente del JSON.',
            '- No inventes nombres de herramientas ni de parámetros: usa exactamente los de la lista.'
        ].join('\n')
    },
    {
        id: 'llama',
        label: 'Llama',
        match: (name, family) => /llama/i.test(name) || /llama/i.test(family),
        nativeTools: true,
        supportsThinking: false,
        forceJsonProtocol: false,
        temperature: 0.15,
        maxTools: 7
    },
    {
        id: 'mistral',
        label: 'Mistral / Devstral',
        match: (name, family) => /mistral|devstral|codestral/i.test(name) || /mistral/i.test(family),
        nativeTools: true,
        supportsThinking: false,
        forceJsonProtocol: false,
        temperature: 0.15,
        maxTools: 8
    },
    {
        id: 'deepseek',
        label: 'DeepSeek',
        match: (name, family) => /deepseek/i.test(name) || /deepseek/i.test(family),
        nativeTools: true,
        supportsThinking: true,
        forceJsonProtocol: false,
        temperature: 0.2,
        maxTools: 8
    }
];

/** Static guess from the model name and Ollama's family string. */
export function guessProfile(modelName = '', family = '') {
    const hit = PROFILES.find(p => p.match(modelName, family));
    return { ...BASE, ...(hit || {}) };
}

/**
 * Final profile: the name-based guess, corrected by what the model actually
 * advertises. `capabilities` comes from /api/show, so it is authoritative.
 */
export function resolveProfile(modelName, showDetail = null, overrides = {}) {
    const family = showDetail?.family || '';
    const profile = guessProfile(modelName, family);
    const caps = showDetail?.capabilities || [];

    if (caps.length) {
        profile.nativeTools = caps.includes('tools');
        profile.supportsThinking = caps.includes('thinking');
        profile.forceJsonProtocol = !profile.nativeTools;
    }

    profile.model = modelName;
    profile.family = family;
    profile.parameterSize = showDetail?.parameterSize || '';
    profile.quantization = showDetail?.quantization || '';
    profile.maxContext = showDetail?.contextLength || 0;

    // A generic model with tools still needs the "one call per turn" rule; it
    // is the single most common way a weak model derails a step.
    if (profile.nativeTools && !profile.promptAddendum) {
        profile.promptAddendum = 'FORMATO: emite exactamente UNA llamada a herramienta por turno.';
    }

    return { ...profile, ...overrides };
}

/**
 * Gemma-style templates lose a leading system turn. Folding it into the first
 * user message costs nothing on models that do support system, so this is only
 * applied where the profile asks for it.
 */
export function shapeMessages(messages, profile) {
    if (!profile.mergeSystemIntoUser) return messages;

    const systems = messages.filter(m => m.role === 'system').map(m => m.content);
    if (!systems.length) return messages;

    const rest = messages.filter(m => m.role !== 'system');
    const firstUser = rest.findIndex(m => m.role === 'user');
    const preamble = systems.join('\n\n');

    if (firstUser < 0) return [{ role: 'user', content: preamble }, ...rest];

    const out = [...rest];
    out[firstUser] = {
        ...out[firstUser],
        content: `${preamble}\n\n---\n\n${out[firstUser].content}`
    };
    return out;
}

/** Sampling options for a phase. Planning gets a touch more room than editing. */
export function samplingFor(profile, phase, config) {
    const base = {
        temperature: config.get('ollama.temperature', profile.temperature),
        top_p: config.get('ollama.topP', profile.topP),
        repeat_penalty: config.get('ollama.repeatPenalty', profile.repeatPenalty),
        num_ctx: config.get('ollama.numCtx', 32768),
        num_predict: config.get('ollama.numPredict', profile.numPredict)
    };

    if (profile.maxContext) base.num_ctx = Math.min(base.num_ctx, profile.maxContext);

    // Editing is the phase where invention hurts most; planning benefits from a
    // little exploration. Small deltas — these models fall apart above ~0.4.
    if (phase === 'act') base.temperature = Math.min(base.temperature, 0.12);
    if (phase === 'summarize') { base.temperature = 0.1; base.num_predict = 900; }

    if (phase === 'plan') {
        base.temperature = Math.max(base.temperature, 0.2);
        // Thinking tokens come out of the SAME num_predict budget as the answer.
        // A reasoning model asked for a plan will happily deliberate for three
        // thousand tokens and then have nothing left to answer with, which
        // arrives as an empty response with done_reason "length". Give the plan
        // turn real headroom so that is rare, and see the escalation in
        // Engine._modelTurn for when it happens anyway.
        if (profile.supportsThinking) base.num_predict = Math.max(base.num_predict, 6144);
    }

    return base;
}
