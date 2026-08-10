/**
 * The state machine. This is the harness.
 *
 *   IDLE → EXPLORING → PLANNING → AWAITING_APPROVAL → ACTING ⇄ VERIFYING
 *                                                        ↓ (fallo)
 *                                                     REPLANNING
 *                                                        ↓
 *                                                     REFLECTING → DONE
 *
 * Everything the brief asks for that the model cannot be trusted to do itself
 * is enforced by this file, structurally:
 *
 *  · Editing before approval is impossible — the mutating tools are not in the
 *    registry's plan-phase list, and the registry refuses them by phase anyway.
 *  · One tool call per turn is enforced by *executing only the first* call and
 *    telling the model the rest were discarded. Not by asking nicely.
 *  · One mutation per turn follows from that, and every mutation is verified
 *    before the next turn starts — so the model can never build a second edit
 *    on top of a broken first one.
 *  · A step that fails `maxStepAttempts` times does not retry forever; it
 *    triggers a replan of the REMAINING steps only, keeping completed work.
 *  · The step being executed is re-stated at the end of every single prompt,
 *    because a small model forgets which step it is on after about four turns.
 */

import { EV } from './bus.js';
import { uid, deferred, isAbort, abortError, truncateMiddle, estimateTokens, makeThrottle } from './util.js';
import { OllamaClient, OllamaError } from './ollama.js';
import { resolveProfile, samplingFor } from './model-profiles.js';
import { ToolRegistry } from './tools/index.js';
import { RepoMap } from './repo-map.js';
import { ProjectRules } from './project-rules.js';
import { ContextManager } from './context.js';
import { Security } from './security.js';
import { Verifier } from './verify.js';
import { Config } from './config.js';
import { Logger } from './logger.js';
import { parseToolCalls } from './toolcall-parser.js';
import { diffLines } from './diff.js';
import {
    createPlan, parsePlan, applyReplan, currentStep, remainingSteps,
    planProgress, planToText, STEP_STATUS, PLAN_SCHEMA
} from './plan.js';
import { buildSystemPrompt } from './prompts/system.js';
import {
    exploreInstruction, planInstruction, planRepairInstruction, actInstruction,
    toolRepairInstruction, verificationFailureInstruction, replanInstruction,
    reflectInstruction, nudgeInstruction
} from './prompts/phases.js';
import * as P from '../platform/paths.js';

export const STATE = Object.freeze({
    IDLE: 'idle',
    EXPLORING: 'exploring',
    PLANNING: 'planning',
    AWAITING_APPROVAL: 'awaiting_approval',
    ACTING: 'acting',
    VERIFYING: 'verifying',
    REPLANNING: 'replanning',
    REFLECTING: 'reflecting',
    DONE: 'done',
    PAUSED: 'paused',
    ERROR: 'error'
});

export class Engine {
    constructor({ platform, bus }) {
        this.platform = platform;
        this.bus = bus;

        this.config = new Config(platform);
        this.logger = new Logger(bus, platform);
        this.security = new Security(this.config);

        // In a browser the page cannot reach Ollama itself: an HTTPS page may
        // not call http://127.0.0.1 (mixed content), Ollama sends no CORS
        // headers, and when the app is deployed remotely "localhost" is the
        // server's machine anyway. So the HTTP platform hands us a proxy base
        // and the configured host becomes the SERVER's business, not ours.
        this.ollamaProxied = !!platform.ollamaBase;
        this.ollama = new OllamaClient({
            host: platform.ollamaBase || this.config.get('ollama.host'),
            fetch: platform.fetch,
            logger: this.logger
        });
        this.repoMap = new RepoMap({ platform, config: this.config, bus, logger: this.logger });
        this.projectRules = new ProjectRules({ platform, config: this.config, logger: this.logger });
        this.verifier = new Verifier({ platform, config: this.config, security: this.security, logger: this.logger });
        this.registry = new ToolRegistry({ bus, logger: this.logger, config: this.config });
        this.context = new ContextManager({
            config: this.config, bus, logger: this.logger, platform,
            security: this.security, repoMap: this.repoMap,
            projectRules: this.projectRules, ollama: this.ollama
        });

        this.state = STATE.IDLE;
        this.task = '';
        this.plan = null;
        this.findings = '';
        this.changes = new Map();       // rel -> {path, before, after, added, removed}
        this.readCache = new Map();
        this.thinkStreak = 0;
        this.stepFinished = null;
        this.replanCount = 0;
        this.profile = resolveProfile('');
        this.modelInfo = null;
        this.abort = null;
        this.paused = false;
        this._approvals = new Map();
        /** Set when the model refuses native tools, so we stop retrying them. */
        this._forceJsonFallback = false;
        /** Phases where thinking ate the whole output budget; disabled there after. */
        this._thinkStarved = new Set();
    }

    // ── lifecycle ─────────────────────────────────────────────────────────

    async init() {
        await this.config.load();

        for (const note of this.config.describeMigrations()) {
            this.logger.info(`Ajustes migrados — ${note}`);
        }

        // Saved settings beat the defaults in config.js, which is right but
        // silent: editing a default and seeing no change is a confusing hour.
        const overrides = this.config.describeOverrides();
        if (overrides.length) {
            this.logger.info(
                `${overrides.length} ajuste(s) guardados pisan los valores por defecto`,
                overrides.map(o => `${o.path} = ${JSON.stringify(o.saved)} (por defecto ${JSON.stringify(o.default)})`)
            );
        }

        if (!this.ollamaProxied) this.ollama.setHost(this.config.get('ollama.host'));

        const health = await this.ollama.health();
        this.bus.emit(EV.OLLAMA, health);

        if (health.ok) {
            const wanted = this.config.get('ollama.model', '');
            const pick = chooseModel(health.models, wanted);
            if (pick) await this.setModel(pick, { persist: pick !== wanted });
        }

        const root = this.config.get('workspace.root', '');
        if (root) await this.setWorkspace(root, { persist: false });

        return { health, model: this.config.get('ollama.model', ''), root };
    }

    async setModel(name, { persist = true } = {}) {
        this.config.set('ollama.model', name);
        if (persist) await this.config.save();

        let detail = null;
        try { detail = await this.ollama.show(name); }
        catch (err) { this.logger.warn(`No se pudo consultar el modelo ${name}`, { error: err.message }); }

        this.profile = resolveProfile(name, detail);
        this.modelInfo = detail;
        this._forceJsonFallback = false;

        // Never ask for more context than the model has; Ollama would silently
        // truncate and the agent would lose the plan without any error.
        if (this.profile.maxContext) {
            const wanted = this.config.get('ollama.numCtx', 32768);
            if (wanted > this.profile.maxContext) {
                this.config.set('ollama.numCtx', this.profile.maxContext);
                this.logger.warn(`num_ctx reducido a ${this.profile.maxContext} (máximo del modelo)`);
            }
        }

        this.bus.emit(EV.MODEL, { model: name, profile: this.profile, capabilities: detail?.capabilities || [] });
        this.logger.info(`Modelo activo: ${name}`, {
            nativeTools: this.profile.nativeTools,
            thinking: this.profile.supportsThinking,
            maxContext: this.profile.maxContext
        });
        return this.profile;
    }

    async setWorkspace(root, { persist = true } = {}) {
        const normalized = P.normalize(root);
        this.config.set('workspace.root', normalized);

        const recent = [normalized, ...(this.config.get('workspace.recent', []) || []).filter(r => r !== normalized)].slice(0, 8);
        this.config.set('workspace.recent', recent);
        if (persist) await this.config.save();

        this.repoMap.invalidate();
        this.projectRules.invalidate();
        this.readCache.clear();
        await this.logger.attach(normalized);

        const map = await this.repoMap.build({ force: true });
        const rules = await this.projectRules.load({ force: true });
        this.logger.info(`Carpeta de trabajo: ${normalized}`, { archivos: map.fileCount, reglas: rules.sources });
        return { map, rules };
    }

    // ── run control ───────────────────────────────────────────────────────

    /** Explore → Plan → wait for the user. Never touches a file. */
    async start(task) {
        if (![STATE.IDLE, STATE.DONE, STATE.ERROR].includes(this.state)) {
            throw new Error('Ya hay una tarea en curso. Cancélala antes de empezar otra.');
        }
        if (!this.config.get('workspace.root', '')) throw new Error('Selecciona primero una carpeta de trabajo.');
        if (!this.config.get('ollama.model', '')) throw new Error('Selecciona primero un modelo.');

        this.task = String(task || '').trim();
        if (!this.task) throw new Error('La tarea está vacía.');

        this.abort = new AbortController();
        this.paused = false;
        this.plan = null;
        this.findings = '';
        this.replanCount = 0;
        this.changes.clear();
        this.readCache.clear();
        this.context.reset();
        // Ranks what the repo map shows on a big project: without it the model
        // gets an alphabetical slice that rarely contains the relevant files.
        this.context.focus = this.task;
        this.repoMap.invalidate();
        this.context.addUser(this.task);
        this.bus.emit(EV.CHAT_USER, { id: uid('u'), text: this.task });

        try {
            this._setState(STATE.EXPLORING);
            this.findings = await this._explore();
            // The exploration transcript has done its job; its conclusions are
            // carried into the planning prompt as `findings`, and keeping the
            // raw file dumps around would cost the plan phase its whole budget.
            this.context.dropEphemeral();

            if (this.abort.signal.aborted) return this._cancelled();

            this._setState(STATE.PLANNING);
            this.plan = await this._plan();

            this._setState(STATE.AWAITING_APPROVAL);
            this.bus.emit(EV.PLAN_DRAFT, { plan: this.plan });

            if (this.config.get('agent.autoApprovePlan', false)) {
                await this.approvePlan();
            }
            return this.plan;
        } catch (err) {
            return this._fail(err);
        }
    }

    async approvePlan(editedPlan = null) {
        if (this.state !== STATE.AWAITING_APPROVAL) throw new Error('No hay ningún plan esperando aprobación.');
        if (editedPlan) this.plan = editedPlan;

        this.bus.emit(EV.PLAN_APPROVED, { plan: this.plan });
        this.logger.info('Plan aprobado', { pasos: this.plan.steps.length });
        this._setState(STATE.ACTING);

        if (this.config.get('agent.autoRunSteps', false)) return await this.runAll();
        return this.plan;
    }

    rejectPlan(reason = '') {
        if (this.state !== STATE.AWAITING_APPROVAL) return;
        this.bus.emit(EV.PLAN_REJECTED, { reason });
        this.context.addUser(`El usuario rechazó el plan${reason ? `: ${reason}` : '.'}`);
        this._setState(STATE.IDLE);
    }

    /** Re-plan on demand (the "Replanificar" button), without a failure. */
    async replanNow(reason = 'El usuario pidió replanificar.') {
        if (!this.plan) throw new Error('No hay plan que rehacer.');
        this.abort = this.abort && !this.abort.signal.aborted ? this.abort : new AbortController();
        this._setState(STATE.REPLANNING);
        try {
            await this._replan(currentStep(this.plan), reason);
            this._setState(STATE.AWAITING_APPROVAL);
            this.bus.emit(EV.PLAN_DRAFT, { plan: this.plan });
            return this.plan;
        } catch (err) {
            return this._fail(err);
        }
    }

    /** Execute exactly one step. The "Ejecutar Paso" button. */
    async runNextStep() {
        if (!this.plan) throw new Error('No hay plan aprobado.');
        if (this.state === STATE.AWAITING_APPROVAL) throw new Error('Aprueba el plan antes de ejecutarlo.');

        const step = currentStep(this.plan);
        if (!step) return await this._finish();

        this.abort = this.abort && !this.abort.signal.aborted ? this.abort : new AbortController();
        this._setState(STATE.ACTING);

        try {
            const ok = await this._runStep(step);
            if (!ok && step.status === STEP_STATUS.FAILED) {
                if (this.replanCount < this.config.get('agent.maxReplans', 3)) {
                    this._setState(STATE.REPLANNING);
                    await this._replan(step, step.notes[step.notes.length - 1] || 'El paso falló repetidamente.');
                    this._setState(STATE.ACTING);
                } else {
                    this.logger.warn('Límite de replanificaciones alcanzado');
                    return await this._finish({ aborted: true });
                }
            }
            if (!currentStep(this.plan)) return await this._finish();
            return { step, done: false };
        } catch (err) {
            if (isAbort(err)) return this._cancelled();
            return this._fail(err);
        }
    }

    async runAll() {
        while (!this.paused && this.plan && currentStep(this.plan)) {
            if (this.abort?.signal.aborted) return this._cancelled();
            const r = await this.runNextStep();
            if (this.state === STATE.DONE || this.state === STATE.ERROR) return r;
        }
        if (this.paused) this._setState(STATE.PAUSED);
        return this.plan;
    }

    pause() {
        this.paused = true;
        this.bus.emit(EV.STATUS, { text: 'Pausado al terminar el paso actual.' });
    }

    resume() {
        if (!this.paused) return;
        this.paused = false;
        this._setState(STATE.ACTING);
        return this.runAll();
    }

    async cancel() {
        this.paused = true;
        this.abort?.abort();
        for (const d of this._approvals.values()) d.resolve(false);
        this._approvals.clear();
        try { await this.platform.killAll(); } catch { /* nothing running */ }
        this.bus.emit(EV.STATUS, { text: 'Cancelado.' });
        this._setState(STATE.IDLE);
    }

    /** The UI answers an approval request raised by a tool. */
    resolveApproval(id, approved) {
        const d = this._approvals.get(id);
        if (!d) return false;
        this._approvals.delete(id);
        d.resolve(!!approved);
        return true;
    }

    // ── phases ────────────────────────────────────────────────────────────

    async _explore() {
        const tools = this.registry.forPhase('explore', { maxTools: this.profile.maxTools });
        const system = buildSystemPrompt({ phase: 'explore', tools, profile: this.profile });
        const maxTurns = 8;
        const maxBlocked = 2;

        let instruction = exploreInstruction(this.task);
        let findings = '';
        let blocked = 0;
        let lastText = '';

        this.stepFinished = null;
        this.thinkStreak = 0;

        for (let turn = 1; turn <= maxTurns; turn++) {
            if (this.abort.signal.aborted) throw abortError();

            const turnResult = await this._modelTurn({
                phase: 'explore', system, instruction, tools,
                includeRepoMap: turn === 1
            });
            instruction = null;

            const parsed = parseToolCalls(turnResult, tools.map(t => t.name));
            if (parsed.text) lastText = parsed.text;

            if (!parsed.calls.length) {
                // Reaching for a write tool while exploring is the single most
                // common derail: the model spots the fix and goes straight for
                // it. Say no explicitly — silently accepting the prose as
                // findings would leave it believing the edit happened.
                if (parsed.unknown.length) {
                    const attempted = parsed.unknown[0].name;
                    this.logger.warn(`Herramienta no disponible en exploración: ${attempted}`);
                    this.context.add('assistant', turnResult.content || '', { ephemeral: true });

                    if (++blocked > maxBlocked) {
                        findings = lastText;
                        break;
                    }
                    instruction = [
                        `"${attempted}" no está disponible: estás EXPLORANDO, y esta fase es de sólo lectura.`,
                        'No se ha modificado nada. Primero se investiga, luego se propone un plan, el usuario lo aprueba,',
                        'y sólo entonces se toca código. Ese es el orden y no se salta.',
                        `Herramientas disponibles ahora: ${tools.map(t => t.name).join(', ')}.`,
                        'Cuando sepas lo suficiente, llama a finish_step con el resumen de lo que has averiguado.'
                    ].join('\n');
                    continue;
                }

                if (turnResult.parseError) {
                    if (++blocked > maxBlocked) { findings = lastText; break; }
                    instruction = 'Tu última respuesta no se pudo interpretar. Vuelve a intentarlo con UNA llamada a herramienta bien formada.';
                    continue;
                }

                // Plain prose with no call: it is reporting back.
                findings = parsed.text || turnResult.content || '';
                if (findings.trim().length > 40 || turn > 2) break;
                instruction = 'Todavía no has explorado nada. Usa una herramienta de lectura ahora, o llama a finish_step con tus conclusiones.';
                continue;
            }

            const call = parsed.calls[0];
            this.context.add('assistant', assistantTurn(call, parsed, this.profile), {
                toolCalls: nativeShape(call, this.profile),
                ephemeral: true
            });

            const result = await this.registry.execute(call.name, call.args, this._toolContext('explore', null, tools));
            this.context.addToolResult(call.name, formatToolResult(result, this.config), { ephemeral: true });

            // finish_step doubles as "exploration over": a tool-calling model
            // reaches for a terminator tool far more reliably than it switches
            // to prose on request.
            if (this.stepFinished !== null) {
                findings = [this.stepFinished, parsed.text].filter(Boolean).join('\n\n');
                break;
            }

            if (turn === maxTurns - 1) {
                instruction = 'Se acabó el tiempo de exploración. Llama a finish_step ahora con el resumen de lo que sabes.';
            }
        }

        if (!findings) findings = lastText || '(la exploración no produjo un resumen; se planifica con el mapa del proyecto)';
        this.stepFinished = null;
        this.logger.info('Exploración terminada', { tokens: estimateTokens(findings) });
        return findings;
    }

    async _plan() {
        const tools = this.registry.forPhase('plan', { maxTools: this.profile.maxTools });
        const system = buildSystemPrompt({ phase: 'plan', tools, profile: this.profile });
        const maxRepairs = this.config.get('agent.maxToolRepairs', 3);

        let instruction = planInstruction(this.task, this.findings);
        let lastRaw = '';

        for (let attempt = 0; attempt <= maxRepairs; attempt++) {
            if (this.abort.signal.aborted) throw abortError();

            const turn = await this._modelTurn({
                phase: 'plan', system, instruction,
                tools: [],                 // planning produces JSON, not tool calls
                format: PLAN_SCHEMA,       // structured output when the model honours it
                includeRepoMap: attempt === 0
            });

            lastRaw = turn.content || '';
            const parsed = parsePlan(lastRaw, { knownTools: this.registry.names(), goalFallback: this.task });

            if (parsed.ok) {
                if (parsed.repairs.length) this.logger.warn('Plan reparado', { repairs: parsed.repairs });
                this.logger.info('Plan generado', { pasos: parsed.plan.steps.length });
                return parsed.plan;
            }

            this.logger.warn(`Plan inválido (intento ${attempt + 1})`, { errors: parsed.errors });
            instruction = planRepairInstruction(parsed.errors, lastRaw);
        }

        // Rather than fail the run, fall back to a single manual step. The user
        // sees it, can edit it, and nothing has been touched yet.
        this.logger.error('El modelo no consiguió producir un plan válido; se usa un plan de un paso.');
        return createPlan(this.task, [{
            title: 'Realizar la tarea solicitada',
            description: this.task,
            files: [],
            tools: ['read_file', 'edit_file'],
            verify: 'El usuario confirma que el cambio es correcto.'
        }]);
    }

    /**
     * Run one step to completion, with retries. Returns true on success.
     * Sets `step.status` to DONE or FAILED before returning.
     */
    async _runStep(step) {
        const maxAttempts = this.config.get('agent.maxStepAttempts', 3);
        const total = this.plan.steps.length;
        const index = this.plan.steps.indexOf(step);

        step.status = STEP_STATUS.RUNNING;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (this.abort.signal.aborted) throw abortError();

            step.attempts = attempt;
            this.bus.emit(EV.STEP_START, { step, index, total, attempt });
            this.stepFinished = null;
            this.thinkStreak = 0;

            const outcome = await this._stepTurnLoop(step, attempt);
            if (this.abort.signal.aborted) throw abortError();

            if (outcome.paused) {
                // Give the attempt back: the step is untouched, not failed.
                step.status = STEP_STATUS.PENDING;
                step.attempts = attempt - 1;
                this._setState(STATE.PAUSED);
                return false;
            }

            if (outcome.finished) {
                this._setState(STATE.VERIFYING);
                const verdict = await this._verifyStep(step, outcome.mutated);
                this._setState(STATE.ACTING);

                if (verdict.ok) {
                    step.status = STEP_STATUS.DONE;
                    step.summary = outcome.summary || verdict.note || 'Paso completado.';
                    this.context.dropEphemeral();
                    this.context.addUser(`✔ Paso ${step.id} completado: ${step.summary}`);
                    this.bus.emit(EV.STEP_DONE, { step, index, summary: step.summary });
                    this.logger.info(`Paso ${step.id} completado`, { intentos: attempt });
                    return true;
                }

                step.notes.push(`Intento ${attempt}: la verificación falló — ${verdict.issues.join(' · ')}`);
                this.context.addUser(verificationFailureInstruction(verdict.issues));
            } else {
                step.notes.push(`Intento ${attempt}: ${outcome.reason}`);
                this.context.addUser(`✖ El paso ${step.id} no se completó: ${outcome.reason}`);
            }

            this.logger.warn(`Paso ${step.id}: intento ${attempt} fallido`, { reason: outcome.reason || 'verificación' });
        }

        step.status = STEP_STATUS.FAILED;
        this.bus.emit(EV.STEP_FAILED, { step, index, error: step.notes[step.notes.length - 1] || 'desconocido' });
        return false;
    }

    /** The inner turn loop for one attempt at one step. */
    async _stepTurnLoop(step, attempt) {
        const allowShell = this.config.get('security.allowShell', true);
        const tools = this.registry.forPhase('act', { maxTools: this.profile.maxTools, allowShell });
        const system = buildSystemPrompt({ phase: 'act', tools, profile: this.profile });
        const maxTurns = this.config.get('agent.maxTurnsPerStep', 14);

        const mutated = new Set();
        let repairs = 0;
        let idleTurns = 0;
        let instruction = actInstruction({
            plan: this.plan, step, attempt,
            lastFailure: attempt > 1 ? step.notes[step.notes.length - 1] : ''
        });

        for (let turn = 1; turn <= maxTurns; turn++) {
            if (this.abort.signal.aborted) throw abortError();
            // Pausing is not a failure. Flagged separately so the attempt is
            // not counted against the step — otherwise pausing three times
            // would mark a perfectly healthy step as failed.
            if (this.paused && turn > 1) return { finished: false, paused: true, reason: 'pausado por el usuario', mutated: [...mutated] };

            if (this.context.needsSummary(this.profile)) {
                await this.context.summarize({ model: this.config.get('ollama.model'), profile: this.profile, signal: this.abort.signal });
            }

            const turnResult = await this._modelTurn({
                phase: 'act', system, tools,
                // Every turn ends with the current step restated. ~40 tokens
                // that stop the model wandering into a different step.
                instruction: instruction || stepReminder(step),
                includeRepoMap: turn === 1
            });
            instruction = null;

            const parsed = parseToolCalls(turnResult, tools.map(t => t.name));

            if (!parsed.calls.length) {
                if (parsed.unknown.length) {
                    repairs++;
                    const bad = parsed.unknown[0].name;
                    this.context.add('assistant', turnResult.content || '', { ephemeral: true });
                    instruction = toolRepairInstruction({
                        problem: `"${bad}" no es una herramienta que exista.`,
                        availableTools: tools.map(t => t.name), profile: this.profile
                    });
                } else if (repairs < this.config.get('agent.maxToolRepairs', 3)) {
                    repairs++;
                    this.context.add('assistant', turnResult.content || '', { ephemeral: true });
                    instruction = toolRepairInstruction({
                        problem: turnResult.parseError
                            ? `El sistema no pudo interpretar tu llamada (${turnResult.parseError}).`
                            : 'No había ninguna llamada a herramienta en tu respuesta.',
                        availableTools: tools.map(t => t.name),
                        profile: this.profile,
                        lastOutput: turnResult.content
                    });
                } else if (++idleTurns >= 2) {
                    return { finished: false, reason: `el modelo dejó de llamar herramientas tras ${repairs} intentos de corrección`, mutated: [...mutated] };
                } else {
                    instruction = nudgeInstruction(step);
                }
                if (repairs > this.config.get('agent.maxToolRepairs', 3)) {
                    return { finished: false, reason: 'el modelo no produjo llamadas válidas', mutated: [...mutated] };
                }
                continue;
            }

            repairs = 0;
            idleTurns = 0;

            const call = parsed.calls[0];
            const discarded = parsed.calls.length - 1;

            this.context.add('assistant', assistantTurn(call, parsed, this.profile), {
                toolCalls: nativeShape(call, this.profile),
                ephemeral: true
            });

            const ctx = this._toolContext('act', step, tools);
            const result = await this.registry.execute(call.name, call.args, ctx);

            let observation = formatToolResult(result, this.config);
            if (discarded > 0) {
                observation += `\n\n[Se descartaron ${discarded} llamada(s) adicionales del mismo turno. Una por turno.]`;
            }

            // The mutation is verified before the model gets another turn, so it
            // can never stack a second edit on a file it already broke.
            const touched = result.data && result.data.path && result.ok && isMutating(call.name);
            if (touched) {
                mutated.add(result.data.path);
                const check = await this.verifier.checkFile(result.data.path);
                if (!check.ok) {
                    observation += `\n\n${verificationFailureInstruction(check.issues)}`;
                } else if (check.inconclusive) {
                    observation += `\n\n[verificación estructural OK; ${check.note}]`;
                } else {
                    observation += `\n\n[verificación automática OK (${check.level})]`;
                }
            }

            // Paired with the assistant turn above: both ephemeral, so a
            // completed step leaves only its summary behind.
            this.context.addToolResult(call.name, observation, { ephemeral: true });

            if (this.stepFinished !== null) {
                return { finished: true, summary: this.stepFinished, mutated: [...mutated] };
            }
        }

        return { finished: false, reason: `se agotaron los ${maxTurns} turnos sin completar el paso`, mutated: [...mutated] };
    }

    async _verifyStep(step, mutatedPaths) {
        if (!this.config.get('agent.autoVerify', true)) return { ok: true, issues: [], note: 'verificación desactivada' };

        const issues = [];
        for (const rel of mutatedPaths) {
            const check = await this.verifier.checkFile(rel);
            if (!check.ok) issues.push(...check.issues);
        }
        if (issues.length) return { ok: false, issues };

        const project = await this.verifier.projectCheck({ signal: this.abort.signal });
        if (project.ran && !project.ok) {
            return {
                ok: false,
                issues: [`El comando de verificación "${project.command}" falló (exit ${project.exitCode}):\n${truncateMiddle(project.output, 1500)}`]
            };
        }

        const note = project.ran
            ? `verificado con "${project.command}"`
            : mutatedPaths.length
                ? `${mutatedPaths.length} archivo(s) verificados estructuralmente`
                : 'sin cambios en disco que verificar';

        return { ok: true, issues: [], note };
    }

    async _replan(failedStep, failure) {
        this.replanCount++;
        this.bus.emit(EV.STATUS, { text: `Replanificando (${this.replanCount})…` });

        const tools = this.registry.forPhase('plan', { maxTools: this.profile.maxTools });
        const system = buildSystemPrompt({ phase: 'plan', tools, profile: this.profile });
        const pending = remainingSteps(this.plan).length;

        const instruction = replanInstruction({
            plan: this.plan, failedStep, failure, remaining: Math.max(1, pending)
        });

        const turn = await this._modelTurn({ phase: 'plan', system, instruction, tools: [], format: PLAN_SCHEMA });
        const parsed = parsePlan(turn.content || '', { knownTools: this.registry.names(), goalFallback: this.plan.goal });

        if (!parsed.plan || !parsed.plan.steps.length) {
            this.logger.error('La replanificación no produjo pasos válidos', { errors: parsed.errors });
            // Skip the failed step rather than looping on it forever.
            if (failedStep) failedStep.status = STEP_STATUS.SKIPPED;
            return this.plan;
        }

        this.plan = applyReplan(this.plan, parsed.plan.steps, {
            reason: truncateMiddle(String(failure || ''), 400)
        });

        this.bus.emit(EV.PLAN_UPDATED, { plan: this.plan, reason: failure });
        this.logger.info('Plan revisado', { revision: this.plan.revision, pasos: this.plan.steps.length });
        this.context.addUser(`El plan se ha revisado tras el fallo. Plan actual:\n${planToText(this.plan)}`);
        return this.plan;
    }

    async _finish({ aborted = false } = {}) {
        this._setState(STATE.REFLECTING);

        const changes = [...this.changes.values()].map(c => ({ path: c.path, added: c.added, removed: c.removed }));
        const project = await this.verifier.projectCheck({ signal: this.abort?.signal });

        const system = buildSystemPrompt({ phase: 'reflect', tools: [], profile: this.profile });
        const instruction = reflectInstruction({
            plan: this.plan,
            changes,
            verification: project.ran ? `${project.command} → exit ${project.exitCode}\n${project.output}` : ''
        });

        let summary = '';
        try {
            const turn = await this._modelTurn({ phase: 'reflect', system, instruction, tools: [], stream: true, includeRepoMap: false });
            summary = (turn.content || '').trim();
        } catch (err) {
            if (isAbort(err)) return this._cancelled();
            summary = fallbackSummary(this.plan, changes);
            this.logger.warn('No se pudo generar el informe final', { error: err.message });
        }

        if (!summary) summary = fallbackSummary(this.plan, changes);

        const progress = planProgress(this.plan);
        this._setState(STATE.DONE);
        this.bus.emit(EV.DONE, { summary, changed: changes, progress, aborted });
        this.logger.info('Tarea terminada', { ...progress, archivos: changes.length });
        await this.logger.flush();

        return { summary, changes, progress };
    }

    // ── model plumbing ────────────────────────────────────────────────────

    /**
     * One call to the model, with the context assembled and the response
     * streamed to the UI. Handles the tools-not-supported downgrade in place.
     */
    async _modelTurn({ phase, system, instruction, tools = [], format = null, includeRepoMap = true, stream = true, escalate = 0 }) {
        const model = this.config.get('ollama.model');
        const useNative = this.profile.nativeTools && !this._forceJsonFallback && tools.length > 0;

        const messages = await this.context.compose({
            systemPrompt: system,
            instruction,
            phase,
            profile: this.profile,
            includeRepoMap
        });

        // Without native tools the response must still be one tool call, so it
        // gets the same treatment as the plan: a schema it cannot escape.
        const effectiveFormat = format || (tools.length && !useNative ? this.registry.protocolSchema(tools) : null);

        const chatId = uid('a');
        this.bus.emit(EV.CHAT_START, { id: chatId, phase });

        // Thinking is off on an escalated retry (it is what ate the budget) and
        // stays off for that phase for the rest of the run — a phase whose
        // prompt makes this model over-deliberate once will do it every time,
        // and paying the escalation round trip on each attempt is exactly the
        // "insisting on what just failed" the harness is supposed to prevent.
        const thinkAllowed = this.profile.supportsThinking
            && escalate === 0
            && !this._thinkStarved.has(phase);

        const wantsThinking = thinkAllowed
            && (phase === 'plan' ? this.config.get('agent.thinkInPlan', true) : this.config.get('agent.thinkInAct', false));

        // A level ('low'/'medium'/'high') where the model takes one, a plain
        // boolean otherwise. `_noThinkLevels` is set once a model rejects a
        // level, so the downgrade is paid at most once per session.
        const level = this.config.get('agent.thinkLevel', 'on');
        const think = wantsThinking
            ? (level !== 'on' && !this._noThinkLevels ? level : true)
            : this.profile.supportsThinking ? false : undefined;

        const options = samplingFor(this.profile, phase, this.config);
        if (escalate > 0) options.num_predict = Math.min(16384, options.num_predict * 2);

        /**
         * The single longest silence in the whole system.
         *
         * Between sending the request and the first token, Ollama loads the
         * model if it is cold and then prefills the prompt — tens of seconds on
         * a 36B, and absolutely nothing comes back during it. Reporting it as an
         * open, ticking operation is the difference between "it is working" and
         * "it is hung", and no amount of spinner elsewhere substitutes for it.
         */
        const waitId = `model_${chatId}`;
        const genId = `gen_${chatId}`;
        const askedAt = Date.now();
        const genTick = makeThrottle(200);
        let firstToken = 0;
        let genChars = 0;
        let genOpen = false;

        const gotFirstToken = () => {
            if (firstToken) return;
            firstToken = Date.now();
            this.bus.emit(EV.PROGRESS, {
                id: waitId, done: true, elapsedMs: firstToken - askedAt,
                label: `${model} respondiendo`
            });
            // A second row covers the generation itself. Closing the first one
            // at the first token and stopping there leaves the tail of the
            // stream uncovered — and Ollama can take seconds after the last
            // visible token to send its final chunk, which measured as the only
            // remaining unexplained pause in a run.
            genOpen = true;
            this.bus.emit(EV.PROGRESS, { id: genId, label: `${model} generando…`, indeterminate: true });
        };

        const closeGen = () => {
            if (!genOpen) return;
            genOpen = false;
            this.bus.emit(EV.PROGRESS, { id: genId, done: true, elapsedMs: Date.now() - (firstToken || askedAt) });
        };

        /**
         * Reasoning and answer are counted apart and labelled apart.
         *
         * "generando…" for both is a wasted signal: on these models the
         * reasoning phase is frequently the longer one by far, and knowing
         * *which* of the two is running tells you whether the model is still
         * deciding or already writing.
         */
        let thinkChars = 0;
        const countChars = (t, kind) => {
            if (kind === 'think') thinkChars += t.length; else genChars += t.length;
            genTick(() => this.bus.emit(EV.PROGRESS, {
                id: genId,
                label: genChars
                    ? `${model} escribiendo… ${genChars} caracteres`
                    : `${model} razonando… ${thinkChars} caracteres`,
                detail: genChars && thinkChars ? `${thinkChars} de razonamiento` : '',
                indeterminate: true
            }));
        };

        this.bus.emit(EV.PROGRESS, {
            id: waitId,
            label: `Consultando a ${model}…`,
            detail: `${phase} · ${estimateTokens(JSON.stringify(messages))} tokens de entrada`,
            indeterminate: true
        });

        const call = () => this.ollama.chat({
            model,
            messages,
            tools: useNative ? this.registry.ollamaSchemas(tools) : undefined,
            format: effectiveFormat,
            think,
            options,
            keepAlive: this.config.get('ollama.keepAlive', '30m'),
            signal: this.abort.signal,
            retries: this.config.get('ollama.retries', 3),
            timeoutMs: this.config.get('ollama.requestTimeoutMs', 600000),
            onDelta: stream
                ? (t) => { gotFirstToken(); countChars(t, 'out'); this.bus.emit(EV.CHAT_DELTA, { id: chatId, text: t }); }
                : (t) => { gotFirstToken(); countChars(t || '', 'out'); },
            onThinking: (t) => { gotFirstToken(); countChars(t, 'think'); this.bus.emit(EV.CHAT_THINK, { id: chatId, text: t }); }
        });

        let result;
        try {
            result = await call();
            // A turn can finish without ever emitting a token — an empty
            // generation, or a non-streaming call. Both indicators must close
            // regardless, or they spin forever over work that already ended.
            gotFirstToken();
            closeGen();
        } catch (err) {
            this.bus.emit(EV.PROGRESS, { id: waitId, done: true, elapsedMs: Date.now() - askedAt });
            closeGen();
            // The model claims tools it does not have. Downgrade once, remember,
            // and retry — rather than failing the whole run over a capability lie.
            if (err instanceof OllamaError && err.kind === 'no-tools' && useNative) {
                this.logger.warn('El modelo rechazó tool calling nativo; se cambia al protocolo JSON.');
                this._forceJsonFallback = true;
                this.profile = { ...this.profile, nativeTools: false, forceJsonProtocol: true };
                this.bus.emit(EV.MODEL, { model, profile: this.profile, capabilities: this.modelInfo?.capabilities || [] });
                return await this._modelTurn({ phase, system, instruction, tools, format, includeRepoMap, stream });
            }
            if (err instanceof OllamaError && err.kind === 'no-think') {
                // Two different failures wear the same error. If a LEVEL was
                // sent, the model may simply not grade its reasoning — retry
                // with the plain boolean before concluding it cannot think at
                // all, which would silently cost the user every explanation.
                if (typeof think === 'string' && !this._noThinkLevels) {
                    this._noThinkLevels = true;
                    this.logger.warn(`El modelo no acepta nivel de pensamiento "${think}"; se usa activado/desactivado.`);
                } else {
                    this.profile = { ...this.profile, supportsThinking: false };
                }
                return await this._modelTurn({ phase, system, instruction, tools, format, includeRepoMap, stream });
            }
            // The model emitted a tool call Ollama could not parse. That is a
            // bad turn, not a dead run: hand back an empty result and let the
            // caller's repair loop ask for a well-formed call. Throwing here
            // would kill the whole task over one malformed generation.
            if (err instanceof OllamaError && err.kind === 'parse') {
                this.logger.warn('Ollama no pudo interpretar la salida del modelo', { error: err.message });
                this.bus.emit(EV.CHAT_END, { id: chatId, text: '', usage: null, phase });
                return { content: '', thinking: '', toolCalls: [], usage: null, parseError: err.message };
            }
            throw err;
        }

        // Budget exhaustion, not a bad answer.
        //
        // A reasoning model can spend every one of its num_predict tokens on
        // thinking and return an empty message with done_reason "length". The
        // callers all read "no content" as "malformed output" and ask again —
        // identically — which reproduces it exactly, four times, at a minute a
        // go. Detect it here and change something before retrying: thinking off,
        // budget doubled. One escalation only, then let the caller handle it.
        const starved = result.usage?.doneReason === 'length'
            && !(result.content || '').trim()
            && !(result.toolCalls || []).length;

        if (starved && escalate === 0) {
            this._thinkStarved.add(phase);
            this.logger.warn(
                `El modelo agotó los ${result.usage.completionTokens} tokens de salida razonando y no respondió nada. ` +
                'Reintentando sin "thinking" y con el doble de presupuesto.',
                { phase }
            );
            this.bus.emit(EV.CHAT_END, { id: chatId, text: '', usage: result.usage, phase });
            return await this._modelTurn({ phase, system, instruction, tools, format, includeRepoMap, stream, escalate: 1 });
        }

        if (starved) {
            this.logger.error(
                'El modelo sigue sin producir respuesta dentro del presupuesto de tokens. ' +
                'Sube "Tokens máx. de respuesta" en Ajustes o desactiva "Pensar al planificar".',
                { phase, completionTokens: result.usage.completionTokens }
            );
        }

        this.bus.emit(EV.CHAT_END, { id: chatId, text: result.content, thinking: result.thinking, usage: result.usage, phase });

        if (result.usage) {
            this.logger.debug(`turno ${phase}`, {
                prompt: result.usage.promptTokens,
                salida: result.usage.completionTokens,
                ms: result.usage.totalMs
            });
        }

        return result;
    }

    _toolContext(phase, step, tools) {
        return {
            platform: this.platform,
            config: this.config,
            security: this.security,
            bus: this.bus,
            logger: this.logger,
            repoMap: this.repoMap,
            root: this.config.get('workspace.root', ''),
            phase,
            stepId: step ? step.id : null,
            availableTools: tools.map(t => t.name),
            readCache: this.readCache,
            signal: this.abort?.signal,
            // Lets the file tools size their output against what is actually
            // left of the window instead of a fixed constant.
            contextUsage: () => this.context.usage(),

            thinkStreak: this.thinkStreak,
            setThinkStreak: (n) => { this.thinkStreak = n; },
            setStepFinished: (s) => { this.stepFinished = s; },

            recordDiff: (rel, before, after) => this._recordDiff(rel, before, after),
            requestApproval: (req) => this._requestApproval(req)
        };
    }

    _recordDiff(rel, before, after) {
        const { stats } = diffLines(before ?? '', after ?? '');
        const prior = this.changes.get(rel);
        this.changes.set(rel, {
            path: rel,
            // Keep the ORIGINAL "before" across repeated edits to one file, so
            // the final diff shows the whole change, not just the last touch.
            before: prior ? prior.before : before,
            after,
            added: stats.added,
            removed: stats.removed
        });
        this.repoMap.invalidate();
        this.bus.emit(EV.DIFF, { path: rel, before, after, stats, created: before === null });
    }

    _requestApproval(req) {
        // Nothing to ask when the run is already being torn down.
        if (this.abort?.signal.aborted) return Promise.resolve(false);

        const id = uid('appr');
        const d = deferred();
        this._approvals.set(id, d);
        this.bus.emit(EV.APPROVAL, { id, ...req });
        return d.promise;
    }

    // ── state helpers ─────────────────────────────────────────────────────

    _setState(next) {
        const from = this.state;
        if (from === next) return;
        this.state = next;
        this.bus.emit(EV.STATE, { from, to: next });
    }

    _cancelled() {
        this._setState(STATE.IDLE);
        this.bus.emit(EV.STATUS, { text: 'Ejecución cancelada.' });
        return { cancelled: true };
    }

    _fail(err) {
        if (isAbort(err)) return this._cancelled();
        const message = err && err.message ? err.message : String(err);
        this.logger.error('Fallo del agente', { error: message, stack: err && err.stack });
        this._setState(STATE.ERROR);
        this.bus.emit(EV.ERROR, { message, detail: err && err.detail });
        return { error: message };
    }

    snapshot() {
        return {
            state: this.state,
            task: this.task,
            plan: this.plan,
            progress: planProgress(this.plan),
            changes: [...this.changes.values()],
            context: this.context.usage(),
            model: this.config.get('ollama.model', ''),
            profile: this.profile,
            root: this.config.get('workspace.root', '')
        };
    }
}

// ── helpers ───────────────────────────────────────────────────────────────

const MUTATING = new Set(['write_file', 'edit_file']);
function isMutating(name) {
    return MUTATING.has(name);
}

/** Restate the current step at the end of every prompt. Cheap, and it works. */
function stepReminder(step) {
    return `PASO ACTUAL — ${step.id}. ${step.title}\nCriterio de éxito: ${step.verify}\nSiguiente acción: UNA herramienta. Si ya está hecho, finish_step.`;
}

/** Shape a parsed call back into the wire format, for native-tool history. */
function nativeShape(call, profile) {
    if (!profile.nativeTools) return undefined;
    return [{ function: { name: call.name, arguments: call.args } }];
}

/**
 * What the assistant turn looks like in history.
 *
 * This must be either the model's own words or the wire-format tool call —
 * never a synthesised stand-in. An earlier version wrote a readable placeholder
 * (`→ read_file`) when the model produced a bare tool call with no prose, and
 * the model, seeing that in its own history, started *typing* `→ finish_step`
 * as plain text instead of calling anything. A weak model imitates whatever it
 * finds in the assistant role, so nothing may go there that it should not copy.
 */
function assistantTurn(call, parsed, profile) {
    if (profile.nativeTools) return parsed.text || '';
    return [parsed.text, JSON.stringify({ tool: call.name, args: call.args })].filter(Boolean).join('\n');
}

function formatToolResult(result, config) {
    const cap = config.get('context.toolResultMaxChars', 6000);
    const head = result.ok ? `OK — ${result.summary}` : `ERROR — ${result.summary}`;
    const body = result.detail ? `\n${truncateMiddle(String(result.detail), cap)}` : '';
    return `${head}${body}`;
}

function fallbackSummary(plan, changes) {
    const p = planProgress(plan);
    const rows = changes.length
        ? changes.map(c => `  · ${c.path} (+${c.added}/-${c.removed})`).join('\n')
        : '  (ningún archivo modificado)';
    return `Pasos completados: ${p.done}/${p.total}${p.failed ? ` (${p.failed} fallidos)` : ''}.\n\nArchivos modificados:\n${rows}`;
}

/** Prefer a model the harness is actually tuned for. */
function chooseModel(models, wanted) {
    if (!models || !models.length) return '';
    const names = models.map(m => m.name);
    if (wanted && names.includes(wanted)) return wanted;

    const byPriority = [
        n => /^qwen3\.6/i.test(n),
        n => /qwen3.*(coder|instruct)/i.test(n),
        n => /^qwen3/i.test(n),
        n => /gemma4/i.test(n),
        n => /gemma/i.test(n),
        n => models.find(m => m.name === n)?.capabilities?.includes('tools')
    ];

    for (const test of byPriority) {
        const hit = names.find(test);
        if (hit) return hit;
    }
    return names[0];
}
