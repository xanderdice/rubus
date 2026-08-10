/**
 * The tool registry.
 *
 * Two policies live here, and both are enforced in code rather than in the
 * prompt, because a prompt rule is only as strong as the model reading it:
 *
 *  1. **Plan mode is read-only.** A mutating tool called during exploration or
 *     planning is refused by the registry. The model is told why, and the
 *     refusal is a normal tool result it can react to.
 *
 *  2. **The model sees a short list.** Every additional tool is another wrong
 *     choice available, and small models degrade sharply past half a dozen. So
 *     each phase exposes only what that phase can use, ordered by how often it
 *     is the right answer, and truncated to the profile's ceiling.
 */

import { listDirectory, readFile, outlineFile, writeFile, editFile } from './fs-tools.js';
import { searchCodebase } from './search-tools.js';
import { runTerminalCommand } from './shell-tools.js';
import { getProjectStructure, think, finishStep } from './meta-tools.js';
import { validateArgs, toOllamaTool, toProtocolSchema, describeTools } from '../tool-schema.js';
import { EV } from '../bus.js';
import { uid } from '../util.js';

export const ALL_TOOLS = [
    getProjectStructure,
    listDirectory,
    readFile,
    outlineFile,
    searchCodebase,
    editFile,
    writeFile,
    runTerminalCommand,
    finishStep,
    think
];

/**
 * Tools that must never be dropped by the per-profile cap, whatever the
 * ordering says. `finish_step` is the only way a step can end; a Gemma profile
 * capped at six tools would otherwise lose it off the end of the act list and
 * the model would have no legal way to say it was done.
 */
const ESSENTIAL = { act: ['finish_step'], explore: ['finish_step'], plan: [] };

/** Ordered by usefulness in that phase — the head survives truncation. */
const PHASE_TOOLS = {
    // finish_step is exposed while exploring as the "I know enough" terminator.
    // Asking a tool-calling model to stop calling tools and switch to prose is
    // unreliable; giving it a tool that means "done" is not.
    explore: ['read_file', 'search_codebase', 'outline_file', 'list_directory', 'get_project_structure', 'finish_step', 'think'],
    plan: ['read_file', 'search_codebase', 'outline_file', 'list_directory', 'get_project_structure', 'think'],
    act: ['read_file', 'edit_file', 'write_file', 'search_codebase', 'outline_file', 'run_terminal_command', 'finish_step', 'list_directory', 'think']
};

export class ToolRegistry {
    constructor({ bus, logger, config }) {
        this.bus = bus;
        this.logger = logger;
        this.config = config;
        this.byName = new Map(ALL_TOOLS.map(t => [t.name, t]));
    }

    get(name) {
        return this.byName.get(name) || null;
    }

    names() {
        return [...this.byName.keys()];
    }

    /**
     * The tools a phase exposes, capped at `maxTools`.
     *
     * The cap is real — a small model degrades sharply past half a dozen — but
     * it is applied to the optional tools only. Anything in ESSENTIAL is added
     * back afterwards, in its original position, so a tight cap can never take
     * away the model's ability to finish a step.
     */
    forPhase(phase, { maxTools = 8, allowShell = true } = {}) {
        const wanted = PHASE_TOOLS[phase] || PHASE_TOOLS.act;
        const essential = new Set(ESSENTIAL[phase] || []);

        let names = wanted.filter(n => this.byName.has(n));
        if (!allowShell) names = names.filter(n => n !== 'run_terminal_command');

        const cap = Math.max(3, maxTools);
        const optional = names.filter(n => !essential.has(n));
        const keep = new Set([
            ...essential,
            ...optional.slice(0, Math.max(1, cap - essential.size))
        ]);

        return names.filter(n => keep.has(n)).map(n => this.byName.get(n));
    }

    ollamaSchemas(specs) {
        return specs.map(toOllamaTool);
    }

    protocolSchema(specs) {
        return toProtocolSchema(specs);
    }

    describe(specs) {
        return describeTools(specs);
    }

    /**
     * Validate and run one call. Never throws: every failure comes back as a
     * result the model can read and correct, which is the whole point — an
     * exception here would end the step, and a bad argument should not.
     */
    async execute(name, rawArgs, ctx) {
        const callId = uid('call');
        const spec = this.byName.get(name);
        const started = Date.now();

        if (!spec) {
            const suggestion = nearestName(name, this.names());
            const result = {
                ok: false,
                summary: `No existe la herramienta "${name}".`,
                detail: `Herramientas disponibles en esta fase: ${ctx.availableTools.join(', ')}.` +
                    (suggestion ? ` ¿Querías decir "${suggestion}"?` : '')
            };
            this.bus.emit(EV.TOOL_REJECTED, { id: callId, name, reason: result.summary });
            return { ...result, callId, durationMs: 0 };
        }

        // Policy 1: the read-only phases really are read-only.
        if (spec.mutates && ctx.phase !== 'act') {
            const result = {
                ok: false,
                summary: `"${name}" no se puede usar en modo Plan.`,
                detail: 'Estás en una fase de sólo lectura: primero se investiga y se propone un plan, y sólo después de que el usuario lo apruebe se modifica código. Usa read_file, search_codebase o list_directory.'
            };
            this.bus.emit(EV.TOOL_REJECTED, { id: callId, name, reason: result.summary });
            return { ...result, callId, durationMs: 0 };
        }

        if (!ctx.availableTools.includes(name)) {
            const result = {
                ok: false,
                summary: `"${name}" no está disponible en esta fase.`,
                detail: `Puedes usar: ${ctx.availableTools.join(', ')}.`
            };
            this.bus.emit(EV.TOOL_REJECTED, { id: callId, name, reason: result.summary });
            return { ...result, callId, durationMs: 0 };
        }

        const validation = validateArgs(spec, rawArgs);
        if (!validation.ok) {
            const result = {
                ok: false,
                summary: `Argumentos inválidos para ${name}.`,
                detail: `${validation.errors.map(e => `- ${e}`).join('\n')}\n\nVuelve a llamar a ${name} con los parámetros correctos.`,
                validation
            };
            this.bus.emit(EV.TOOL_REJECTED, { id: callId, name, reason: validation.errors.join('; ') });
            return { ...result, callId, durationMs: Date.now() - started };
        }

        this.bus.emit(EV.TOOL_CALL, { id: callId, name, args: validation.args, stepId: ctx.stepId, phase: ctx.phase });
        this.logger?.info(`tool ${name}`, validation.args);

        /**
         * Progress handles, auto-closed.
         *
         * A tool has many return paths and forgetting to close a progress entry
         * on one of them leaves a spinner turning over work that finished —
         * which is worse than showing nothing, because it is a lie. So the
         * registry hands out the handles and closes whatever is still open when
         * `run` returns, however it returns.
         */
        const opened = new Set();
        const progress = (label, extra = {}) => {
            const id = uid('prog');
            opened.add(id);
            this.bus.emit(EV.PROGRESS, { id, label, ...extra });
            return {
                id,
                update: (nextLabel, more = {}) => this.bus.emit(EV.PROGRESS, { id, label: nextLabel, ...more }),
                done: (nextLabel) => {
                    if (opened.delete(id)) this.bus.emit(EV.PROGRESS, { id, done: true, label: nextLabel });
                }
            };
        };
        const runCtx = { ...ctx, progress };

        let result;
        try {
            result = await spec.run(validation.args, runCtx);
        } catch (err) {
            // Sandbox refusals are already phrased for the model; anything else
            // gets a generic wrapper so a stack trace never reaches the prompt.
            const msg = err && err.userFacing
                ? err.message
                : `Error interno ejecutando ${name}: ${err && err.message ? err.message : String(err)}`;
            this.logger?.error(`tool ${name} lanzó una excepción`, { error: String(err && err.stack || err) });
            result = { ok: false, summary: msg };
        } finally {
            for (const id of opened) this.bus.emit(EV.PROGRESS, { id, done: true });
            opened.clear();
        }

        result = result || { ok: false, summary: `${name} no devolvió resultado.` };
        result.callId = callId;
        result.durationMs = Date.now() - started;
        result.validation = validation;

        if (validation.warnings.length) {
            result.detail = [result.detail, `nota: ${validation.warnings.join('; ')}`].filter(Boolean).join('\n');
        }

        // Anything that is not `think` counts as progress.
        if (name !== 'think') ctx.setThinkStreak(0);

        this.bus.emit(EV.TOOL_RESULT, {
            id: callId,
            name,
            ok: result.ok,
            summary: result.summary,
            detail: result.detail,
            durationMs: result.durationMs,
            stepId: ctx.stepId
        });

        return result;
    }
}

function nearestName(name, candidates) {
    const target = String(name || '').toLowerCase().replace(/[^a-z]/g, '');
    let best = null;
    let bestScore = 0;
    for (const c of candidates) {
        const s = c.replace(/[^a-z]/g, '');
        let shared = 0;
        for (const ch of new Set(target)) if (s.includes(ch)) shared++;
        const score = shared / Math.max(target.length, s.length, 1);
        if (score > bestScore) { bestScore = score; best = c; }
    }
    return bestScore > 0.55 ? best : null;
}
