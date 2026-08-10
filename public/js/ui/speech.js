/**
 * Spoken output.
 *
 * This exists because the app is used without looking at it. The beeps say
 * *that* something happened; speech says *what*. For someone who cannot see the
 * screen, the plan, the permission prompt and the final report are not
 * decoration — they are the only way to know what the agent is about to do to
 * their code, and whether it worked.
 *
 * Four decisions follow from that:
 *
 *  · **Sentence by sentence, while it streams.** Waiting for CHAT_END would
 *    mean sixty seconds of silence and then a wall of speech. Deltas are
 *    accumulated and flushed at sentence boundaries, so the answer is heard as
 *    it is written.
 *
 *  · **Permission prompts interrupt.** Everything else queues politely; a
 *    request to run a shell command cuts the queue, because agreeing to
 *    something you did not hear is the worst failure this app can have.
 *
 *  · **Code is not read aloud.** Fenced blocks, diffs and long paths are
 *    unbearable spoken verbatim. They are summarised — "bloque de código, 12
 *    líneas" — and paths are read by their file name.
 *
 *  · **Nothing is spoken twice.** A screen reader user already has one voice;
 *    this can be turned off entirely, and the DOM stays labelled so their own
 *    reader still works.
 */

/** How much gets spoken. */
export const VERBOSITY = ['off', 'key', 'all'];

/** Sentence enders, including Spanish opening marks handled by the split. */
const SENTENCE_END = /[.!?;:\n]+\s/;

export class SpeechBoard {
    constructor({ enabled = true, rate = 1, pitch = 1, volume = 1, voice = '', verbosity = 'key' } = {}) {
        this.enabled = enabled;
        this.rate = rate;
        this.pitch = pitch;
        this.volume = volume;
        this.voiceName = voice;
        this.verbosity = verbosity;

        this.synth = globalThis.speechSynthesis || null;
        this.voices = [];
        this.pending = '';        // partial sentence being accumulated
        this.broken = !this.synth;

        if (this.synth) {
            this._loadVoices();
            // Voices arrive asynchronously in every browser, and on some they
            // are empty until this fires.
            try { this.synth.addEventListener('voiceschanged', () => this._loadVoices()); } catch { /* older API */ }
        }
    }

    _loadVoices() {
        try { this.voices = this.synth.getVoices() || []; } catch { this.voices = []; }
    }

    /** Voices, Spanish first — this app speaks Spanish. */
    listVoices() {
        if (!this.voices.length) this._loadVoices();
        const score = (v) => (/^es/i.test(v.lang) ? 0 : /^en/i.test(v.lang) ? 1 : 2);
        return [...this.voices].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
    }

    _voice() {
        if (!this.voiceName) {
            return this.voices.find(v => /^es/i.test(v.lang)) || null;
        }
        return this.voices.find(v => v.name === this.voiceName) || null;
    }

    setEnabled(on) {
        this.enabled = !!on;
        if (!this.enabled) this.stop();
    }

    configure({ rate, pitch, volume, voice, verbosity }) {
        if (rate !== undefined) this.rate = rate;
        if (pitch !== undefined) this.pitch = pitch;
        if (volume !== undefined) this.volume = volume;
        if (voice !== undefined) this.voiceName = voice;
        if (verbosity !== undefined) this.verbosity = verbosity;
    }

    get active() {
        return this.enabled && !this.broken && this.verbosity !== 'off';
    }

    /**
     * Say something.
     *
     * @param {string}  text
     * @param {object}  [opts]
     * @param {boolean} [opts.interrupt] cut whatever is queued — for anything
     *   the user must act on.
     * @param {'key'|'all'} [opts.level] minimum verbosity required.
     */
    say(text, { interrupt = false, level = 'key' } = {}) {
        if (!this.active) return;
        if (level === 'all' && this.verbosity !== 'all') return;

        const clean = speakable(text);
        if (!clean) return;

        try {
            if (interrupt) this.synth.cancel();
            const u = new SpeechSynthesisUtterance(clean);
            const v = this._voice();
            if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'es-ES'; }
            u.rate = this.rate;
            u.pitch = this.pitch;
            u.volume = this.volume;
            this.synth.speak(u);
        } catch {
            // A failing voice must never take a run down with it.
            this.broken = true;
        }
    }

    /**
     * Feed streaming tokens; complete sentences are spoken as they close.
     *
     * Cheap per token: a string append and one regex test on the tail. The
     * expensive part only runs when a sentence actually ends.
     */
    stream(text, { level = 'key' } = {}) {
        if (!this.active) return;
        if (level === 'all' && this.verbosity !== 'all') return;

        this.pending += text;
        if (this.pending.length < 12) return;      // nothing worth saying yet
        if (!SENTENCE_END.test(this.pending.slice(-3))) return;

        const chunk = this.pending;
        this.pending = '';
        this.say(chunk, { level });
    }

    /** Speak whatever partial sentence is left over. */
    flush({ level = 'key' } = {}) {
        const rest = this.pending.trim();
        this.pending = '';
        if (rest) this.say(rest, { level });
    }

    stop() {
        this.pending = '';
        try { this.synth && this.synth.cancel(); } catch { /* nothing to cancel */ }
    }
}

/**
 * Turn agent output into something worth hearing.
 *
 * Read verbatim, a reply full of code fences and paths is unusable: every
 * slash, brace and semicolon gets pronounced. This keeps the prose and replaces
 * the rest with a short description.
 */
export function speakable(text) {
    let s = String(text ?? '');
    if (!s.trim()) return '';

    // Code blocks → a count, not the code.
    s = s.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_m, code) => {
        const lines = code.trim().split('\n').length;
        return ` (bloque de código, ${lines} ${lines === 1 ? 'línea' : 'líneas'}) `;
    });

    s = s
        .replace(/`([^`\n]+)`/g, '$1')                       // inline code: keep the word
        .replace(/^\s*[#>*\-=_]{3,}\s*$/gm, ' ')             // rules and separators
        .replace(/[*_#]+/g, '')                              // markdown emphasis
        .replace(/[═─━│┌┐└┘·•▸▾●◐✓✗±→←]/g, ' ')             // box drawing and icons
        // A path is read by its file name; the directories are noise aloud.
        .replace(/(?:[A-Za-z]:)?[\w.-]*(?:[/\\][\w.-]+){2,}/g, (p) => p.split(/[/\\]/).pop())
        .replace(/\s{2,}/g, ' ')
        .trim();

    return s;
}

/**
 * Wire the bus to speech.
 *
 * What gets said, and why that list:
 *   · the plan            — you are about to approve it
 *   · permission prompts  — interrupting, because you must decide
 *   · step results        — progress you cannot see
 *   · errors              — the thing you most need to know
 *   · the final report    — the answer itself, streamed sentence by sentence
 *
 * Tool-by-tool narration is behind verbosity 'all': useful when learning what
 * the agent does, exhausting once you trust it.
 */
export function wireSpeech(bus, speech, EV) {
    const on = (ev, fn) => bus.on(ev, fn);

    // The report at the end is the answer; speak it as it is written.
    let speakingPhase = '';
    on(EV.CHAT_START, ({ phase }) => { speakingPhase = phase; });
    on(EV.CHAT_DELTA, ({ text }) => {
        if (speakingPhase === 'reflect') speech.stream(text);
    });
    on(EV.CHAT_END, ({ phase }) => { if (phase === 'reflect') speech.flush(); });

    on(EV.PLAN_DRAFT, ({ plan }) => {
        const steps = plan.steps.map(s => `${s.id}. ${s.title}`).join('. ');
        speech.say(`Plan propuesto: ${plan.goal}. ${plan.steps.length} pasos. ${steps}. Pulsa aprobar para ejecutarlo.`);
    });

    on(EV.APPROVAL, ({ command, title, risk }) => {
        speech.say(
            `Atención. ${risk === 'dangerous' ? 'Comando peligroso' : title || 'Permiso'}. ` +
            `${command ? `Comando: ${command}.` : ''} Aceptar o rechazar.`,
            { interrupt: true }
        );
    });

    on(EV.STEP_START, ({ step, index, total }) =>
        speech.say(`Paso ${index + 1} de ${total}. ${step.title}`));
    on(EV.STEP_DONE, ({ step }) => speech.say(`Paso ${step.id} completado. ${step.summary}`));
    on(EV.STEP_FAILED, ({ step, error }) => speech.say(`Paso ${step.id} falló. ${error}`, { interrupt: true }));

    on(EV.TOOL_CALL, ({ name, args }) => speech.say(describeCall(name, args), { level: 'all' }));
    on(EV.TOOL_RESULT, ({ ok, summary }) => { if (!ok) speech.say(`Error. ${summary}`); });

    on(EV.DIFF, ({ path, stats }) =>
        speech.say(`Modificado ${path.split('/').pop()}, ${stats.added} añadidas, ${stats.removed} borradas`, { level: 'all' }));

    on(EV.ERROR, ({ message }) => speech.say(`Error grave. ${message}`, { interrupt: true }));

    on(EV.DONE, ({ progress, changed }) => {
        speech.flush();
        speech.say(
            `Terminado. ${progress.done} de ${progress.total} pasos` +
            `${progress.failed ? `, ${progress.failed} fallidos` : ''}. ` +
            `${changed.length} ${changed.length === 1 ? 'archivo modificado' : 'archivos modificados'}.`
        );
    });

    on(EV.STATE, ({ to }) => {
        if (to === 'awaiting_approval') speech.say('Esperando tu aprobación.');
        if (to === 'idle') speech.stop();
    });
}

function describeCall(name, args = {}) {
    const file = (p) => String(p || '').split(/[/\\]/).pop();
    switch (name) {
        case 'read_file': return `Leyendo ${file(args.path)}`;
        case 'outline_file': return `Analizando la estructura de ${file(args.path)}`;
        case 'write_file': return `Escribiendo ${file(args.path)}`;
        case 'edit_file': return `Editando ${file(args.path)}`;
        case 'search_codebase': return `Buscando ${args.query}`;
        case 'list_directory': return `Listando ${file(args.path) || 'la carpeta'}`;
        case 'run_terminal_command': return `Ejecutando ${args.command}`;
        case 'get_project_structure': return 'Leyendo la estructura del proyecto';
        case 'finish_step': return '';
        case 'think': return '';
        default: return name;
    }
}
