/**
 * UI wiring: subscribe to the bus, render, and drive the engine from buttons.
 *
 * There is exactly one direction of data flow. Buttons call engine methods; the
 * engine emits events; the views render events. No view reads engine internals
 * and the engine never touches the DOM — which is what lets the same core run
 * headless under Node with a terminal renderer instead of this file.
 *
 * The Plan/Act switch is a real gate, not a label. In Plan mode the execute
 * controls are disabled and nothing ever calls `runNextStep`, so the mutating
 * tools stay unreachable — on top of the registry's own phase check.
 */

import { detectPlatform } from '../platform/index.js';
import { Bus, EV } from '../core/bus.js';
import { Engine, STATE } from '../core/engine.js';
import { $, $$, el, clear, toast, wireDialogDismissal, openDialog, isAtBottom, shortTime } from './dom.js';
import { ChatView } from './chat.js';
import { PlanPanel } from './plan-panel.js';
import { Timeline } from './timeline.js';
import { DiffView } from './diff-view.js';
import { Explorer } from './explorer.js';
import { Settings } from './settings.js';
import { ProgressStrip } from './progress.js';
import { SoundBoard, wireSound } from './sound.js';
import { SpeechBoard, wireSpeech } from './speech.js';
import { FolderPicker, ModelPicker, ApprovalGate } from './dialogs.js';
import * as P from '../platform/paths.js';

/** Chat banners that mark the boundary between phases. */
const PHASE_BANNER = {
    [STATE.EXPLORING]: 'EXPLORANDO — leyendo el proyecto, sin modificar nada',
    [STATE.PLANNING]: 'PLANIFICANDO — redactando el plan',
    [STATE.AWAITING_APPROVAL]: 'ESPERANDO TU APROBACIÓN',
    [STATE.REPLANNING]: 'REPLANIFICANDO — algo falló, rehaciendo los pasos que quedan',
    [STATE.REFLECTING]: 'REDACTANDO EL INFORME FINAL'
};

const STATE_LABEL = {
    [STATE.IDLE]: 'inactivo',
    [STATE.EXPLORING]: 'explorando',
    [STATE.PLANNING]: 'planificando',
    [STATE.AWAITING_APPROVAL]: 'esperando aprobación',
    [STATE.ACTING]: 'ejecutando',
    [STATE.VERIFYING]: 'verificando',
    [STATE.REPLANNING]: 'replanificando',
    [STATE.REFLECTING]: 'redactando informe',
    [STATE.DONE]: 'terminado',
    [STATE.PAUSED]: 'pausado',
    [STATE.ERROR]: 'error'
};

/**
 * States where the engine is doing something on its own and the user just
 * waits. Used for the spinner, the pill and the Cancel button.
 *
 * ACTING is deliberately NOT here. It means "the plan is approved and the
 * engine is standing by for you to run a step" — which is precisely when the
 * execute buttons must be ALIVE. Having it in this set is what made approving
 * a plan disable every control, so nothing happened when you pressed Ejecutar.
 * Whether a step is actually running is tracked separately by `this.running`.
 */
const WORKING_STATES = new Set([
    STATE.EXPLORING, STATE.PLANNING, STATE.VERIFYING, STATE.REPLANNING, STATE.REFLECTING
]);

/** Anything that should show the pill as busy, ACTING included. */
const BUSY_STATES = new Set([...WORKING_STATES, STATE.ACTING]);

/** The engine only accepts a new task from these. Mirrors Engine.start(). */
const ACCEPTS_TASK = new Set([STATE.IDLE, STATE.DONE, STATE.ERROR]);

export async function mountApp() {
    const platform = await detectPlatform();
    const bus = new Bus();
    const engine = new Engine({ platform, bus });

    const app = new App({ platform, bus, engine });
    await app.start();
    // Handy from the devtools console; nothing in the app depends on it.
    globalThis.agentcoder = app;
    return app;
}

class App {
    constructor({ platform, bus, engine }) {
        this.platform = platform;
        this.bus = bus;
        this.engine = engine;

        this.mode = 'plan';
        this.running = false;
        this.termLines = 0;
        this.logLines = 0;

        /** Everything the activity bar needs, updated from bus events. */
        this.activity = { phase: '', step: '', turn: 0, action: '', waiting: '', tokens: null, startedAt: 0 };
        this.activityTimer = null;
        /** One row per operation in flight — the antidote to a blank wait. */
        this.progress = new ProgressStrip($('#progress'));
        this.sound = new SoundBoard();
        this.speech = new SpeechBoard();
        this.runStartedAt = 0;

        this.chat = new ChatView();
        this.plan = new PlanPanel({ onChange: () => {} });
        this.timeline = new Timeline();
        this.diffs = new DiffView();
        this.explorer = new Explorer({ platform, engine });
        this.settings = new Settings({
            engine,
            onApply: () => this.applyPreferences(),
            speech: this.speech,
            onAction: (what) => {
                if (what !== 'speechTest') return;
                // Speak with the settings as they stand right now, so you can
                // hear a rate or voice change before committing to it.
                this.applyPreferences();
                this.speech.say(
                    'Hola. Soy AgentCoder. Así sonaré al leerte el plan, los permisos y el resultado de cada paso.',
                    { interrupt: true }
                );
            }
        });
        this.folderPicker = new FolderPicker({ platform, engine });
        this.modelPicker = new ModelPicker({ engine });
        this.approvals = new ApprovalGate({ engine, sound: this.sound });
    }

    async start() {
        wireDialogDismissal();
        this.wireEvents();
        this.wireControls();

        wireSound(this.bus, this.sound, EV);
        wireSpeech(this.bus, this.speech, EV);

        // Escape silences the voice without stopping the agent. Someone who
        // cannot see the screen needs a way out of a long report that does not
        // also cancel the work — and it must not fire while a dialog is open,
        // where Escape already means "close".
        addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (document.querySelector('.backdrop:not([hidden])')) return;
            this.speech.stop();
        });
        // Browsers refuse audio before a user gesture, so the clips are not
        // even fetched until there has been one. With sound off, never.
        const unlock = () => this.sound.unlock();
        addEventListener('pointerdown', unlock, { once: true, passive: true });
        addEventListener('keydown', unlock, { once: true, passive: true });

        const init = await this.engine.init();
        this.applyPreferences();

        this.announceBackend();

        if (!init.health.ok) {
            this.chat.addSystem(
                `**Ollama no responde** en \`${init.health.host}\`.\n\n` +
                'Arráncalo con `ollama serve` y descarga un modelo:\n\n' +
                '```\nollama pull qwen3.6\n```\n\n' +
                'Después pulsa el chip del modelo arriba a la derecha para elegirlo.'
            );
        }

        if (init.root) await this.explorer.refresh();
        this.refreshChips();
        this.updateControls();
    }

    /**
     * Say plainly which backend is in play. The four cases behave very
     * differently and the difference is invisible otherwise — "nothing happens
     * when I press send" has a different cause in each one.
     */
    announceBackend() {
        const warn = $('#welcome-warn');
        const p = this.platform;

        if (p.needsToken) {
            warn.hidden = false;
            warn.textContent =
                'Este servidor pide un token de acceso. Abre la URL que imprimió el servidor al arrancar ' +
                '(incluye ?token=…), o vuelve a lanzarlo sin --token si estás en local.';
            return;
        }

        if (p.degraded) {
            warn.hidden = false;
            warn.textContent =
                'Sin backend: no hay acceso a archivos ni a la terminal. Arranca el servidor con ' +
                '"npm start" y abre http://127.0.0.1:4322, o usa la app de escritorio con "npm run dev".';
            return;
        }

        if (p.kind === 'http') {
            const bits = [`servidor en ${location.host}`];
            if (p.serverRoot) bits.push(`limitado a ${p.serverRoot}`);
            if (!p.execEnabled) bits.push('shell desactivada');

            // Deliberately NOT a chat message: posting to the chat hides the
            // welcome panel, and the three onboarding steps are the most
            // useful thing on screen for someone who just ran `npm start`.
            warn.hidden = false;
            warn.className = 'welcome-warn welcome-warn--info';
            warn.textContent = `Conectado por HTTP (${bits.join(' · ')}). Ollama va a través del servidor.`;
        }
    }

    // ── engine events ─────────────────────────────────────────────────────

    wireEvents() {
        const on = (ev, fn) => this.bus.on(ev, fn);

        on(EV.STATE, ({ from, to }) => {
            const pill = $('#status-state');
            pill.textContent = STATE_LABEL[to] || to;
            pill.className = 'state-pill ' + (
                to === STATE.ERROR ? 'bad'
                    : to === STATE.DONE ? 'ok'
                        : to === STATE.AWAITING_APPROVAL ? 'wait'
                            : BUSY_STATES.has(to) ? 'busy' : ''
            );

            // Phase banners in the chat, so the transcript reads as a narrative
            // instead of a pile of tool calls.
            if (PHASE_BANNER[to] && from !== to) this.chat.banner(PHASE_BANNER[to], 'phase');

            this.activity.phase = STATE_LABEL[to] || to;
            if (WORKING_STATES.has(to)) this.startActivity();
            else if (to !== STATE.ACTING) this.stopActivity();

            this.updateControls();
            this.refreshChips();
        });

        on(EV.STATUS, ({ text }) => { $('#status-message').textContent = text; });

        on(EV.CONTEXT, (u) => { this.activity.tokens = u; });

        on(EV.PROGRESS, (p) => {
            this.progress.apply(p);
            // The strip says what is happening; the summary bar says what is
            // being waited on, so a long model call is legible even if the user
            // is scrolled away from the strip.
            if (!p.done && p.label) this.activity.waiting = p.label;
            else if (p.done && this.activity.waiting === p.label) this.activity.waiting = '';
            this.renderActivity();
        });

        on(EV.CHAT_USER, ({ text }) => this.chat.addUser(text));
        on(EV.CHAT_START, ({ id, phase }) => this.chat.start(id, phase));
        on(EV.CHAT_DELTA, ({ id, text }) => this.chat.delta(id, text));
        on(EV.CHAT_THINK, ({ id, text }) => this.chat.thinking(id, text));
        on(EV.CHAT_END, ({ id, text, usage }) => this.chat.end(id, text, usage));

        on(EV.PLAN_DRAFT, ({ plan }) => {
            this.plan.setPlan(plan, { editable: true });
            this.selectTab('plan');
            this.chat.addSystem(
                `**Plan propuesto** — ${plan.steps.length} paso${plan.steps.length === 1 ? '' : 's'}. ` +
                (this.mode === 'act'
                    ? 'Revísalo en el panel de la derecha (los textos son editables) y pulsa **Aprobar plan**.'
                    : 'Estás en **modo Plan**: cambia a **Act** arriba para poder ejecutarlo.')
            );
        });
        on(EV.PLAN_UPDATED, ({ plan, reason }) => {
            this.plan.setPlan(plan, { editable: false });
            this.timeline.step(`Plan revisado (r${plan.revision})`, 'err');
            this.chat.addSystem(`**Plan revisado** tras un fallo.\n\n${String(reason || '').slice(0, 400)}`);
        });
        on(EV.PLAN_APPROVED, ({ plan }) => this.plan.setPlan(plan, { editable: false }));

        on(EV.STEP_START, ({ step, index, total, attempt }) => {
            this.plan.render();
            const label = `PASO ${index + 1}/${total} · ${step.title}${attempt > 1 ? `  (intento ${attempt})` : ''}`;
            this.timeline.step(label);
            this.chat.banner(label, attempt > 1 ? 'retry' : 'step');
            this.activity.step = `paso ${index + 1}/${total}`;
            this.activity.turn = 0;
            $('#status-step').textContent = `paso ${index + 1}/${total}`;
            this.renderActivity();
        });
        on(EV.STEP_DONE, ({ step }) => {
            this.plan.render();
            this.chat.banner(`✓ paso ${step.id} completado — ${step.summary}`, 'ok');
        });
        on(EV.STEP_FAILED, ({ step, error }) => {
            this.plan.render();
            this.timeline.step(`Paso ${step.id} falló: ${error}`, 'err');
            this.chat.banner(`✗ paso ${step.id} falló — ${error}`, 'bad');
        });

        // Every tool call goes to BOTH the chat and the timeline. The timeline
        // is the filterable audit trail; the chat is where people are looking.
        on(EV.TOOL_CALL, (c) => {
            this.timeline.call(c);
            this.chat.action(c);
            this.activity.turn++;
            this.activity.action = `${c.name}`;
            this.renderActivity();
        });
        on(EV.TOOL_RESULT, (r) => {
            this.timeline.result(r);
            this.chat.actionResult(r);
            this.activity.action = '';
            this.renderActivity();
        });
        on(EV.TOOL_REJECTED, (r) => {
            this.timeline.rejected(r);
            this.chat.actionRejected(r);
        });

        on(EV.DIFF, (d) => {
            this.diffs.record(d);
            this.chat.addDiff(d, (path) => this.diffs.open(path));
            $('#status-changes').textContent = `${this.diffs.changes.size} archivo${this.diffs.changes.size === 1 ? '' : 's'} modificado${this.diffs.changes.size === 1 ? '' : 's'}`;
            this.explorer.refresh();
        });

        on(EV.TERMINAL, (t) => this.appendTerminal(t));
        on(EV.LOG, (e) => this.appendLog(e));

        on(EV.APPROVAL, (req) => this.approvals.request(req));

        on(EV.CONTEXT, (u) => {
            const pct = u.budget ? Math.round((u.used / u.budget) * 100) : 0;
            const chip = $('#chip-context');
            chip.querySelector('span').textContent = `${fmtTokens(u.used)} / ${fmtTokens(u.budget)}`;
            chip.title = `Contexto: ${u.used} de ${u.budget} tokens usables (ventana ${u.numCtx}). ${pct}%` +
                (u.summarized ? ` · ${u.summarized} mensajes comprimidos` : '');
        });

        on(EV.OLLAMA, (h) => {
            const chip = $('#chip-ollama');
            chip.className = `chip chip--static chip--dot ${h.ok ? 'ok' : 'bad'}`;
            chip.querySelector('span').textContent = h.ok ? `ollama · ${h.models.length}` : 'ollama caído';
            chip.title = h.ok ? `${h.host} — ${h.models.length} modelos` : h.error;
        });

        on(EV.MODEL, ({ model, profile }) => {
            const chip = $('#chip-model');
            chip.querySelector('span').textContent = model || 'sin modelo';
            chip.title = [
                `Modelo: ${model}`,
                `Perfil: ${profile.label}`,
                `Tool calling nativo: ${profile.nativeTools ? 'sí' : 'no (protocolo JSON forzado)'}`,
                `Modo thinking: ${profile.supportsThinking ? 'sí' : 'no'}`,
                profile.maxContext ? `Contexto máximo: ${profile.maxContext}` : ''
            ].filter(Boolean).join('\n');
        });

        on(EV.ERROR, ({ message }) => {
            this.chat.addError(message);
            toast(message, 'bad');
        });

        on(EV.DONE, ({ changed, progress }) => {
            this.plan.render();
            this.stopActivity();
            $('#status-step').textContent = `${progress.done}/${progress.total} pasos`;

            this.chat.finished({
                summaryLine: progress.failed
                    ? `Se completaron ${progress.done} de ${progress.total} pasos; ${progress.failed} quedaron sin resolver.`
                    : 'Todos los pasos del plan se completaron y verificaron.',
                elapsedMs: this.runStartedAt ? Date.now() - this.runStartedAt : 0,
                steps: `${progress.done}/${progress.total} pasos`,
                files: `${changed.length} archivo${changed.length === 1 ? '' : 's'} modificado${changed.length === 1 ? '' : 's'}`,
                failed: progress.failed > 0
            });

            if (changed.length) this.selectTab('diffs');
        });
    }

    // ── live activity ─────────────────────────────────────────────────────

    /**
     * The "is it working or has it hung?" indicator.
     *
     * A single 36B turn can take 90 seconds with no output at all, so a static
     * spinner is not enough — the clock has to keep moving and the text has to
     * say which phase, which step and which tool. The timer is the only piece
     * of polling in the app, and it stops the moment the run does.
     */
    startActivity() {
        if (!this.runStartedAt) this.runStartedAt = Date.now();
        if (!this.activity.startedAt) this.activity.startedAt = Date.now();
        $('#activity').hidden = false;
        if (this.activityTimer) return;
        this.activityTimer = setInterval(() => this.renderActivity(), 1000);
        this.renderActivity();
    }

    stopActivity() {
        clearInterval(this.activityTimer);
        this.activityTimer = null;
        this.activity.startedAt = 0;
        this.activity.action = '';
        $('#activity').hidden = true;
    }

    renderActivity() {
        const a = this.activity;
        $('#activity-phase').textContent = a.phase || 'trabajando';

        const bits = [];
        if (a.step) bits.push(a.step);
        if (a.turn) bits.push(`turno ${a.turn}`);
        if (a.action) bits.push(a.action);
        // What it is blocked on beats what it is nominally doing.
        if (a.waiting) bits.push(a.waiting);
        $('#activity-detail').textContent = bits.join(' · ');

        const t = a.tokens;
        $('#activity-meta').textContent = t && t.budget
            ? `ctx ${Math.round((t.used / t.budget) * 100)}%`
            : '';

        const secs = a.startedAt ? Math.round((Date.now() - a.startedAt) / 1000) : 0;
        $('#activity-clock').textContent = secs < 60
            ? `${secs}s`
            : `${Math.floor(secs / 60)}m ${secs % 60}s`;
    }

    // ── controls ──────────────────────────────────────────────────────────

    wireControls() {
        /**
         * Immediate feedback on what YOU pressed.
         *
         * Engine events already narrate the agent; these narrate the user. A
         * button that makes a sound the instant it is pressed feels answered,
         * and it also tells you the click registered — which matters most for
         * Cancel, where the engine may take a second to actually stop.
         */
        const click = (sel, sound, handler) => {
            $(sel).addEventListener('click', () => { this.sound.play(sound); handler(); });
        };
        click('#btn-send', 'exec', () => this.send());
        $('#composer-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this.sound.play('exec');
                this.send();
            }
        });
        $('#composer-input').addEventListener('input', (e) => {
            // Grow with the text, up to the CSS max-height.
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(190, e.target.scrollHeight)}px`;
        });

        click('#btn-approve', 'exec', () => this.approve());
        click('#btn-step', 'exec', () => this.runStep());
        click('#btn-run-all', 'exec', () => this.runAll());
        click('#btn-replan', 'exec', () => this.replan());
        click('#btn-pause', 'warn', () => { this.engine.pause(); this.updateControls(); });
        click('#btn-cancel', 'warn', () => this.cancel());

        click('#chip-root', 'exec', () => this.pickRoot());
        click('#btn-pick-root', 'exec', () => this.pickRoot());
        click('#chip-model', 'exec', () => this.modelPicker.open());
        click('#btn-settings', 'exec', () => { this.settings.render(); openDialog('settings-dialog'); });

        for (const btn of $$('#mode-switch .mode')) {
            btn.addEventListener('click', () => this.setMode(btn.dataset.mode));
        }
        for (const tab of $$('#side-tabs .panel-tab')) {
            tab.addEventListener('click', () => this.selectTab(tab.dataset.tab));
        }
    }

    setMode(mode) {
        this.mode = mode;
        for (const btn of $$('#mode-switch .mode')) {
            const on = btn.dataset.mode === mode;
            btn.classList.toggle('active', on);
            btn.setAttribute('aria-selected', String(on));
        }
        this.updateControls();
        if (mode === 'act' && this.engine.state === STATE.AWAITING_APPROVAL) {
            toast('Modo Act: ya puedes aprobar y ejecutar el plan.');
        }
    }

    selectTab(name) {
        for (const tab of $$('#side-tabs .panel-tab')) tab.classList.toggle('active', tab.dataset.tab === name);
        for (const id of ['plan', 'timeline', 'diffs', 'terminal', 'logs']) {
            $(`#side-${id}`).hidden = id !== name;
        }
    }

    async send() {
        const input = $('#composer-input');
        const task = input.value.trim();
        if (!task) return;

        if (!this.engine.config.get('workspace.root', '')) {
            toast('Elige primero una carpeta de trabajo.', 'bad');
            await this.pickRoot();
            return;
        }
        if (!this.engine.config.get('ollama.model', '')) {
            toast('Elige primero un modelo.', 'bad');
            await this.modelPicker.open();
            return;
        }
        if (BUSY_STATES.has(this.engine.state)) {
            toast('Hay una tarea en curso. Cancélala antes de empezar otra.', 'bad');
            return;
        }

        input.value = '';
        input.style.height = 'auto';

        this.timeline.clearAll();
        this.diffs.clearAll();
        this.runStartedAt = Date.now();
        this.activity = { phase: '', step: '', turn: 0, action: '', waiting: '', tokens: null, startedAt: 0 };
        $('#status-changes').textContent = '0 archivos modificados';

        try {
            await this.engine.start(task);
        } catch (err) {
            this.chat.addError(err.message);
            toast(err.message, 'bad');
        }
        this.updateControls();
    }

    async approve() {
        if (this.mode !== 'act') { toast('Cambia a modo Act para ejecutar el plan.', 'bad'); return; }
        const edited = this.plan.collect();
        try {
            await this.engine.approvePlan(edited);
            toast('Plan aprobado. Pulsa "Ejecutar paso" o "Ejecutar todo".');
        } catch (err) {
            toast(err.message, 'bad');
        }
        this.updateControls();
    }

    async runStep() {
        await this._drive(() => this.engine.runNextStep());
    }

    async runAll() {
        await this._drive(() => this.engine.runAll());
    }

    /**
     * Run one of the engine's long operations with the activity indicator on.
     * ACTING is not an autonomous phase, so the bar would never appear for
     * step execution unless it is switched on from here.
     */
    async _drive(fn) {
        if (this.running) return;
        this.running = true;
        this.startActivity();
        this.updateControls();
        try {
            await fn();
        } catch (err) {
            this.chat.addError(err.message);
        } finally {
            this.running = false;
            if (this.engine.state !== STATE.DONE) this.stopActivity();
            this.updateControls();
        }
    }

    async replan() {
        if (this.running) return;
        this.running = true;
        this.updateControls();
        try { await this.engine.replanNow(); }
        catch (err) { toast(err.message, 'bad'); }
        finally { this.running = false; this.updateControls(); }
    }

    async cancel() {
        this.approvals.reset();
        await this.engine.cancel();
        this.running = false;
        this.updateControls();
    }

    updateControls() {
        const s = this.engine.state;
        const hasPlan = !!this.engine.plan;
        const hasPending = hasPlan && this.engine.plan.steps.some(x => x.status === 'pending' || x.status === 'running');
        const actMode = this.mode === 'act';

        // Is the engine mid-operation right now? That is `running` (a step in
        // flight, driven from here) or one of the autonomous phases.
        const inFlight = this.running || WORKING_STATES.has(s);

        // A plan is approved and waiting for you to advance it.
        const readyToRun = actMode && hasPending && !inFlight
            && (s === STATE.ACTING || s === STATE.PAUSED);

        $('#btn-approve').disabled = !(s === STATE.AWAITING_APPROVAL && actMode);
        $('#btn-step').disabled = !readyToRun;
        $('#btn-run-all').disabled = !readyToRun;
        $('#btn-replan').disabled = !(hasPlan && !inFlight);
        $('#btn-pause').disabled = !this.running;
        $('#btn-cancel').disabled = !(inFlight || s === STATE.AWAITING_APPROVAL || readyToRun);
        // Mirrors the engine's own guard, so the button is never enabled for a
        // call that would immediately throw.
        $('#btn-send').disabled = !ACCEPTS_TASK.has(s);

        this.hintNextAction(s, { actMode, readyToRun, hasPending });
    }

    /**
     * Say what the app is waiting for. Disabled buttons with no explanation are
     * the reason "no hace nada" is a reasonable thing to conclude.
     */
    hintNextAction(s, { actMode, readyToRun, hasPending }) {
        const hint = $('#run-hint');
        if (!hint) return;

        let text = '';
        if (s === STATE.AWAITING_APPROVAL && !actMode) {
            text = 'Plan listo. Cambia a modo Act (arriba) para poder aprobarlo y ejecutarlo.';
        } else if (s === STATE.AWAITING_APPROVAL) {
            text = 'Revisa el plan en el panel derecho — los textos son editables — y pulsa «Aprobar plan».';
        } else if (readyToRun) {
            text = 'Plan aprobado. Pulsa «Ejecutar paso» para avanzar de uno en uno, o «Ejecutar todo».';
        } else if (s === STATE.ACTING && !hasPending) {
            text = 'Todos los pasos están hechos.';
        } else if (s === STATE.PAUSED) {
            text = 'Pausado. Pulsa «Ejecutar paso» o «Ejecutar todo» para continuar.';
        } else if (this.running || WORKING_STATES.has(s)) {
            text = '';   // the live activity indicator is already saying it
        }

        hint.textContent = text;
        hint.hidden = !text;
    }

    // ── chips + panels ────────────────────────────────────────────────────

    refreshChips() {
        const root = this.engine.config.get('workspace.root', '');
        const chip = $('#chip-root');
        chip.querySelector('span').textContent = root ? (P.basename(root) || root) : 'sin carpeta';
        chip.title = root || 'Elegir carpeta de trabajo';
        $('#status-message').textContent = root ? root : 'elige una carpeta de trabajo';
    }

    async pickRoot() {
        const dir = await this.folderPicker.open();
        if (!dir) return;
        try {
            const { map, rules } = await this.engine.setWorkspace(dir);
            await this.explorer.refresh();
            this.refreshChips();
            this.chat.addSystem(
                `**Carpeta de trabajo:** \`${dir}\`\n\n` +
                `${map.fileCount} archivos, ${map.dirCount} carpetas. ` +
                (rules.sources.length
                    ? `Reglas cargadas de \`${rules.sources.join(', ')}\`.`
                    : 'Sin archivo de reglas — créalo desde Ajustes ▸ Proyecto para que el agente respete tus convenciones.')
            );
        } catch (err) {
            toast(`No se pudo abrir la carpeta: ${err.message}`, 'bad');
        }
    }

    appendTerminal({ stream, text, command }) {
        const box = $('#side-terminal');
        const stick = isAtBottom(box);

        if (stream === 'cmd') {
            box.appendChild(el('div', { class: 'term-line cmd' }, command));
        } else {
            // Terminal output arrives in arbitrary chunks, not lines. Appending
            // to the last node keeps a progress bar on one line instead of
            // producing a thousand of them.
            const last = box.lastElementChild;
            if (last && last.classList.contains(stream)) last.textContent += text;
            else box.appendChild(el('div', { class: `term-line ${stream}` }, text));
        }

        if (++this.termLines > 1200) {
            while (box.children.length > 900) box.removeChild(box.firstChild);
            this.termLines = box.children.length;
        }
        if (stick) box.scrollTop = box.scrollHeight;
    }

    appendLog(entry) {
        const box = $('#side-logs');
        const stick = isAtBottom(box);
        box.appendChild(el('div', { class: `log-line ${entry.level}` }, [
            el('span', { class: 'lvl' }, entry.level),
            el('span', { class: 'msg' }, `${shortTime(new Date(entry.t))} ${entry.message}`)
        ]));
        if (++this.logLines > 800) {
            while (box.children.length > 600) box.removeChild(box.firstChild);
            this.logLines = box.children.length;
        }
        if (stick) box.scrollTop = box.scrollHeight;
    }

    applyPreferences() {
        const cfg = this.engine.config;
        document.body.dataset.bloom = cfg.get('ui.bloom', 'soft');
        document.body.classList.toggle('no-scanlines', !cfg.get('ui.scanlines', true));
        this.chat.showThinking = cfg.get('ui.showThinking', true);
        this.sound.setEnabled(cfg.get('ui.sound', true));
        this.sound.setVolume(cfg.get('ui.soundVolume', 0.5));

        this.speech.setEnabled(cfg.get('ui.speech', true));
        this.speech.configure({
            verbosity: cfg.get('ui.speechVerbosity', 'key'),
            voice: cfg.get('ui.speechVoice', ''),
            rate: cfg.get('ui.speechRate', 1.05),
            pitch: cfg.get('ui.speechPitch', 1),
            volume: cfg.get('ui.speechVolume', 1)
        });
        // When proxied, the host setting belongs to the server, not to us.
        if (!this.engine.ollamaProxied) this.engine.ollama.setHost(cfg.get('ollama.host'));
    }
}

function fmtTokens(n) {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0);
}
