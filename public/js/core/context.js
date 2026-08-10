/**
 * Context management — the other half of "the harness is the intelligence".
 *
 * A 32k window sounds like a lot until you put a repo map, project rules, three
 * pinned files and twenty tool observations in it. And weak models do not
 * degrade gracefully when the window fills: they start ignoring the middle,
 * then the plan, then the instruction. So the budget is enforced here, on the
 * way out, rather than hoped for.
 *
 * The allocation, in priority order — earlier items are never dropped to make
 * room for later ones:
 *
 *   1. system prompt        the rules of the game
 *   2. project rules        the user's law, never summarised
 *   3. current instruction  what to do right now
 *   4. repo map             where things are (trimmed, not dropped)
 *   5. pinned files         what the user says matters
 *   6. recent history       the last few turns verbatim
 *   7. older history        compressed into a running summary
 *
 * Everything below the line gets summarised or cut. Nothing above it does.
 */

import { estimateTokens, truncateMiddle, uid } from './util.js';
import { EV } from './bus.js';
import * as P from '../platform/paths.js';
import { samplingFor, shapeMessages } from './model-profiles.js';

export class ContextManager {
    constructor({ config, bus, logger, platform, security, repoMap, projectRules, ollama }) {
        this.config = config;
        this.bus = bus;
        this.logger = logger;
        this.platform = platform;
        this.security = security;
        this.repoMap = repoMap;
        this.projectRules = projectRules;
        this.ollama = ollama;

        /** @type {{id,role,content,toolName?,ephemeral?,tokens}[]} */
        this.history = [];
        this.summary = '';
        this.summarizedCount = 0;
        this.lastUsage = { used: 0, budget: 0 };
        /** The current task, used to rank what the repo map shows. */
        this.focus = '';
    }

    reset() {
        this.history = [];
        this.summary = '';
        this.summarizedCount = 0;
    }

    add(role, content, extra = {}) {
        // An assistant turn that is nothing but a tool call has empty content,
        // and it still has to be recorded — the tool result that follows is
        // orphaned without it.
        if (!content && !extra.toolCalls) return null;
        const entry = { id: uid('msg'), role, content: String(content ?? ''), tokens: estimateTokens(content), ...extra };
        this.history.push(entry);
        return entry;
    }

    addUser(text) { return this.add('user', text); }
    addAssistant(text) { return this.add('assistant', text); }
    addToolResult(name, text, extra = {}) { return this.add('tool', text, { toolName: name, ...extra }); }

    /**
     * Drop everything from a finished step: the detail is already condensed
     * into the step summary, and twenty tool observations per step would fill
     * the window in four steps.
     *
     * Assistant tool-call turns and their results are marked ephemeral
     * together, and must stay that way — dropping one without the other leaves
     * an orphan `tool` message with no preceding `tool_calls`, which several
     * chat templates reject outright.
     */
    dropEphemeral() {
        this.history = this.history.filter(m => !m.ephemeral);
    }

    // ── pinned files ──────────────────────────────────────────────────────

    pins() {
        return this.config.get('workspace.pinned', []) || [];
    }

    pin(rel) {
        const pins = new Set(this.pins());
        pins.add(rel);
        const max = this.config.get('context.maxPinnedFiles', 8);
        this.config.set('workspace.pinned', [...pins].slice(-max));
        return this.pins();
    }

    unpin(rel) {
        this.config.set('workspace.pinned', this.pins().filter(p => p !== rel));
        return this.pins();
    }

    async pinnedBlock(tokenBudget) {
        const pins = this.pins();
        if (!pins.length || tokenBudget < 200) return '';

        const per = Math.floor(tokenBudget / pins.length);
        const blocks = [];

        for (const rel of pins) {
            let abs;
            try { ({ abs } = this.security.resolvePath(rel)); } catch { continue; }
            const stat = await this.platform.fs.stat(abs);
            if (!stat || !stat.isFile) continue;

            let text;
            try { text = await this.platform.fs.readText(abs); } catch { continue; }

            const capped = truncateMiddle(text, per * 3);
            blocks.push(`--- ${rel} ---\n${capped}`);
        }

        return blocks.length
            ? `════ ARCHIVOS FIJADOS POR EL USUARIO ════\n${blocks.join('\n\n')}\n════════════════════════════════════════`
            : '';
    }

    // ── composition ───────────────────────────────────────────────────────

    /**
     * Build the message array for one model call.
     *
     * `instruction` is the turn's actual ask and is placed LAST, after all the
     * reference material. Small models weight the end of the prompt far more
     * heavily than the middle; burying the instruction under a repo map is a
     * reliable way to have it ignored.
     */
    async compose({ systemPrompt, instruction, phase, profile, includeRepoMap = true, includePins = true, extraBlocks = [] }) {
        const numCtx = Math.min(
            this.config.get('ollama.numCtx', 32768),
            profile?.maxContext || Number.MAX_SAFE_INTEGER
        );
        const reserve = this.config.get('ollama.numPredict', 3072);
        const budget = Math.floor((numCtx - reserve) * this.config.get('context.budgetRatio', 0.72));

        const rulesBlock = await this.projectRules.block();
        const systemParts = [systemPrompt];
        if (rulesBlock) systemParts.push(rulesBlock);

        let used = estimateTokens(systemParts.join('\n\n')) + estimateTokens(instruction || '');
        const blocks = [];

        for (const b of extraBlocks.filter(Boolean)) {
            blocks.push(b);
            used += estimateTokens(b);
        }

        if (includeRepoMap) {
            const map = await this.repoMap.build({ focus: this.focus || '' });
            if (map.text) {
                const cap = this.config.get('context.repoMapMaxTokens', 2600);
                const text = map.tokens > cap ? truncateMiddle(map.text, cap * 3) : map.text;
                blocks.push(`════ MAPA DEL PROYECTO ════\n${text}\n═══════════════════════════`);
                used += estimateTokens(text);
            }
        }

        if (includePins) {
            const remaining = budget - used;
            const pinBudget = Math.min(Math.floor(remaining * 0.35), this.config.get('context.fileMaxTokens', 3500) * 2);
            const pinned = await this.pinnedBlock(pinBudget);
            if (pinned) { blocks.push(pinned); used += estimateTokens(pinned); }
        }

        const historyBudget = Math.max(600, budget - used);
        const { messages: historyMessages, tokens: historyTokens } = this.selectHistory(historyBudget, profile);

        const messages = [
            { role: 'system', content: systemParts.join('\n\n') },
            ...(blocks.length ? [{ role: 'user', content: blocks.join('\n\n') }] : []),
            ...(this.summary ? [{ role: 'user', content: `════ RESUMEN DE LO QUE YA HA PASADO ════\n${this.summary}\n═══════════════════════════════════════` }] : []),
            ...historyMessages,
            ...(instruction ? [{ role: 'user', content: instruction }] : [])
        ];

        this.lastUsage = {
            used: used + historyTokens,
            budget,
            numCtx,
            files: this.pins().length,
            summarized: this.summarizedCount
        };
        this.bus?.emit(EV.CONTEXT, this.lastUsage);

        return shapeMessages(messages, profile || {});
    }

    /**
     * Newest-first fill, then flip back to chronological order. Truncating from
     * the old end keeps the turn coherent; truncating from the new end would
     * drop the tool result the model is about to reason about.
     */
    selectHistory(budget, profile) {
        const picked = [];
        let tokens = 0;

        for (let i = this.history.length - 1; i >= 0; i--) {
            const m = this.history[i];
            if (tokens + m.tokens > budget && picked.length >= 2) break;
            picked.push(m);
            tokens += m.tokens;
        }
        picked.reverse();

        const nativeTools = profile?.nativeTools;
        const messages = picked.map(m => {
            if (m.role === 'tool') {
                return nativeTools
                    ? { role: 'tool', content: m.content, tool_name: m.toolName }
                    // Models without a tool role read a tool message as a user
                    // turn they are supposed to answer. Labelling it prevents that.
                    : { role: 'user', content: `RESULTADO DE ${m.toolName}:\n${m.content}` };
            }
            // A tool result with no preceding tool_calls turn confuses several
            // chat templates, so the assistant side is replayed in kind.
            if (m.role === 'assistant' && m.toolCalls && nativeTools) {
                return { role: 'assistant', content: m.content || '', tool_calls: m.toolCalls };
            }
            return { role: m.role, content: m.content };
        });

        return { messages, tokens };
    }

    // ── summarization ─────────────────────────────────────────────────────

    needsSummary(profile) {
        const numCtx = Math.min(this.config.get('ollama.numCtx', 32768), profile?.maxContext || Number.MAX_SAFE_INTEGER);
        const threshold = numCtx * this.config.get('context.summarizeAt', 0.78);
        const total = this.history.reduce((n, m) => n + m.tokens, 0);
        return total > threshold * 0.6 && this.history.length > this.config.get('context.historyKeepTurns', 8) * 2;
    }

    /**
     * Fold the older half of the conversation into a compact note. Runs on the
     * same local model, so the prompt is written to be answerable by a weak one:
     * fixed sections, hard length cap, no open-ended "summarise this".
     */
    async summarize({ model, profile, signal }) {
        const keep = this.config.get('context.historyKeepTurns', 8);
        if (this.history.length <= keep + 2) return false;

        const old = this.history.slice(0, this.history.length - keep);
        const recent = this.history.slice(this.history.length - keep);

        const transcript = old.map(m => {
            const who = m.role === 'tool' ? `HERRAMIENTA ${m.toolName}` : m.role.toUpperCase();
            return `[${who}] ${truncateMiddle(m.content, 1200)}`;
        }).join('\n\n');

        const prompt = [
            'Comprime este historial de una sesión de programación en notas breves.',
            '',
            'Formato EXACTO de tu respuesta (sin nada más):',
            'ARCHIVOS TOCADOS: (lista de rutas y qué se hizo en cada una)',
            'DECISIONES: (decisiones técnicas tomadas y por qué)',
            'HECHOS DEL CÓDIGO: (cosas descubiertas del proyecto que hay que recordar)',
            'ERRORES: (qué falló y cómo se resolvió, o si sigue sin resolver)',
            'PENDIENTE: (lo que aún no se ha hecho)',
            '',
            'Máximo 25 líneas en total. Sin relleno, sin repetir código, sin disculpas.',
            '',
            '--- HISTORIAL ---',
            transcript
        ].join('\n');

        try {
            const res = await this.ollama.chat({
                model,
                messages: shapeMessages([
                    { role: 'system', content: 'Comprimes historiales técnicos. Respondes sólo con el formato pedido.' },
                    { role: 'user', content: prompt }
                ], profile),
                options: samplingFor(profile, 'summarize', this.config),
                think: profile.supportsThinking ? false : undefined,
                keepAlive: this.config.get('ollama.keepAlive', '30m'),
                signal,
                retries: 1,
                timeoutMs: 180000
            });

            const text = (res.content || '').trim();
            if (!text) return false;

            this.summary = this.summary
                ? `${this.summary}\n\n--- más reciente ---\n${text}`
                : text;

            // The running summary is itself capped: two rounds of compression is
            // plenty, and an unbounded summary just relocates the problem.
            if (estimateTokens(this.summary) > 1200) this.summary = truncateMiddle(this.summary, 3600);

            this.summarizedCount += old.length;
            this.history = recent;
            this.logger?.info(`Historial comprimido: ${old.length} mensajes → ${estimateTokens(text)} tokens`);
            return true;
        } catch (err) {
            // A failed summary is not a failed step; carry on with a hard trim.
            this.logger?.warn('No se pudo resumir el historial', { error: String(err && err.message || err) });
            this.history = recent;
            return false;
        }
    }

    usage() {
        return this.lastUsage;
    }
}

/** Read a file for injection into a prompt, budgeted and line-numbered. */
export async function fileBlock(platform, security, rel, maxTokens) {
    try {
        const { abs } = security.resolvePath(rel);
        const stat = await platform.fs.stat(abs);
        if (!stat || !stat.isFile) return '';
        const text = await platform.fs.readText(abs);
        const capped = truncateMiddle(text, maxTokens * 3);
        return `--- ${P.normalize(rel)} ---\n${capped}`;
    } catch {
        return '';
    }
}
