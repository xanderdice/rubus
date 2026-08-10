/**
 * Audio feedback, tied to what the agent is actually doing.
 *
 * The whole design constraint is that this must cost nothing. An agent run
 * emits thousands of token events per turn, so anything that allocates, touches
 * the DOM, or forces layout per event is disqualified. What is done instead:
 *
 *  · **Web Audio, not <audio> elements.** Each clip is fetched and decoded
 *    exactly once (34 KB for all seven) into an AudioBuffer. Playing one is a
 *    node allocation and a `start()`; mixing happens on the browser's audio
 *    thread, not on the main thread. An `<audio>` per sound would instead mean
 *    a media element, a network fetch and a decode each time.
 *
 *  · **Loops are state, not events.** `thinking` and `typing` are started once
 *    when the model begins emitting that kind of token and stopped when it
 *    stops. Per token the cost is one timestamp write and one boolean test —
 *    the stopping is decided by a single 150 ms watchdog that only runs while a
 *    loop is playing.
 *
 *  · **Failure is silent.** No sound may ever interrupt a run. Everything is
 *    wrapped; the first failure disables audio and logs once.
 *
 *  · **Nothing loads until it is wanted.** Browsers refuse audio before a user
 *    gesture anyway, so the fetch is deferred to the first interaction. With
 *    sound off, not a byte is downloaded.
 */

const CLIPS = {
    thinking: 'media/thinking.mp3',
    typing: 'media/typing.mp3',
    ok: 'media/beep_ok.mp3',
    exec: 'media/beep_exec.mp3',
    warn: 'media/beep_warn.mp3',
    error: 'media/error.mp3',
    critical: 'media/error_critic.mp3'
};

/** Loops stop when their event stream goes quiet for this long. */
const SILENCE_MS = 320;

/**
 * Minimum gap between two plays of the same one-shot.
 *
 * Tuned per sound rather than one global number, because they do different
 * jobs. `exec` is the pulse of the run and fires on every action, so it is
 * allowed to come thick and fast — muting it would flatten exactly the rhythm
 * that makes the agent feel alive. `warn` and the errors are interruptions;
 * hearing the same one twice in a row adds nothing and grates.
 */
const MIN_GAP_MS = { exec: 90, ok: 140, warn: 350, error: 400, critical: 900 };

export class SoundBoard {
    constructor({ enabled = true, volume = 0.5 } = {}) {
        this.enabled = enabled;
        this.volume = volume;

        this.ctx = null;
        this.master = null;
        this.buffers = new Map();
        this.loops = new Map();      // name -> {source, gain}
        this.lastPlayed = new Map(); // name -> timestamp
        this.loading = null;
        this.broken = false;
        this._live = false;

        this.lastTick = { thinking: 0, typing: 0 };
        this.watchdog = null;
    }

    setEnabled(on) {
        this.enabled = !!on;
        this._refreshLive();
        if (!this.enabled) this.stopAll();
    }

    setVolume(v) {
        this.volume = Math.max(0, Math.min(1, v));
        if (this.master) this.master.gain.value = this.volume;
    }

    /**
     * Browsers block audio until the user has interacted, so this is called
     * from the first gesture. Safe to call repeatedly.
     */
    async unlock() {
        if (!this.enabled || this.broken) return;
        try {
            if (!this.ctx) {
                const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
                if (!Ctx) { this.broken = true; this._refreshLive(); return; }
                this.ctx = new Ctx();
                this.master = this.ctx.createGain();
                this.master.gain.value = this.volume;
                this.master.connect(this.ctx.destination);
            }
            if (this.ctx.state === 'suspended') await this.ctx.resume();
            await this._load();
            this._refreshLive();
        } catch {
            this.broken = true;
            this._refreshLive();
        }
    }

    _load() {
        if (this.loading) return this.loading;

        this.loading = (async () => {
            await Promise.all(Object.entries(CLIPS).map(async ([name, url]) => {
                try {
                    const res = await fetch(url);
                    if (!res.ok) return;
                    const bytes = await res.arrayBuffer();
                    // decodeAudioData is callback-based on old Safari; the
                    // promise form is guarded by the surrounding try.
                    this.buffers.set(name, await this.ctx.decodeAudioData(bytes));
                } catch {
                    // A missing clip disables that one sound, not the board.
                }
            }));
        })();

        return this.loading;
    }

    /**
     * Cached, because it is read on every single token.
     *
     * The honest form — `enabled && !broken && ctx && ctx.state === 'running'`
     * — is four property reads, one of them across the AudioContext boundary.
     * At eleven thousand tokens a turn that is measurable, and this feature is
     * not allowed to be measurable. The flag is refreshed at the only moments
     * it can change: enabling, unlocking, breaking.
     */
    _refreshLive() {
        this._live = !!(this.enabled && !this.broken && this.ctx && this.ctx.state === 'running');
    }

    _ready() {
        return this._live;
    }

    /** Fire and forget. Rate-limited per sound. */
    play(name) {
        if (!this._ready()) return;

        const now = performance.now();
        const gap = MIN_GAP_MS[name] ?? 120;
        if (now - (this.lastPlayed.get(name) || -Infinity) < gap) return;

        const buffer = this.buffers.get(name);
        if (!buffer) return;

        try {
            const src = this.ctx.createBufferSource();
            src.buffer = buffer;
            src.connect(this.master);
            src.start();
            this.lastPlayed.set(name, now);
        } catch { /* the audio thread is not worth an exception */ }
    }

    /**
     * Keep a loop alive. Called on every token of its kind — so it must be
     * cheap: a timestamp write, and a start only on the transition.
     */
    keepLooping(name) {
        if (!this._ready()) return;
        this.lastTick[name] = performance.now();
        if (this.loops.has(name)) return;

        const buffer = this.buffers.get(name);
        if (!buffer) return;

        try {
            const gain = this.ctx.createGain();
            // Fade in: an abruptly starting loop clicks.
            gain.gain.setValueAtTime(0, this.ctx.currentTime);
            gain.gain.linearRampToValueAtTime(1, this.ctx.currentTime + 0.06);
            gain.connect(this.master);

            const src = this.ctx.createBufferSource();
            src.buffer = buffer;
            src.loop = true;
            src.connect(gain);
            src.start();

            this.loops.set(name, { src, gain });
            this._startWatchdog();
        } catch { /* ignored on purpose */ }
    }

    stopLoop(name) {
        if (!this.loops.size) return;   // caso normal en cada token
        const loop = this.loops.get(name);
        if (!loop) return;
        this.loops.delete(name);
        try {
            const t = this.ctx.currentTime;
            loop.gain.gain.cancelScheduledValues(t);
            loop.gain.gain.setValueAtTime(loop.gain.gain.value, t);
            loop.gain.gain.linearRampToValueAtTime(0, t + 0.08);
            loop.src.stop(t + 0.1);
        } catch { /* already stopped */ }
        if (!this.loops.size) this._stopWatchdog();
    }

    /**
     * One timer for all loops, running only while at least one plays.
     *
     * The alternative — a timer per token, or restarting a timeout on every
     * token — would allocate thousands of times per turn for no benefit.
     */
    _startWatchdog() {
        if (this.watchdog) return;
        this.watchdog = setInterval(() => {
            const now = performance.now();
            for (const name of [...this.loops.keys()]) {
                if (now - (this.lastTick[name] || 0) > SILENCE_MS) this.stopLoop(name);
            }
        }, 150);
    }

    _stopWatchdog() {
        clearInterval(this.watchdog);
        this.watchdog = null;
    }

    stopAll() {
        for (const name of [...this.loops.keys()]) this.stopLoop(name);
        this._stopWatchdog();
    }

    dispose() {
        this.stopAll();
        try { this.ctx && this.ctx.close(); } catch { /* already closed */ }
        this.ctx = null;
    }
}

/** Tools whose success is worth confirming: they changed something on disk. */
const MUTATING = new Set(['write_file', 'edit_file']);

/**
 * Map bus events to sounds.
 *
 * The vocabulary, in one line each:
 *
 *   thinking  loops while the model reasons
 *   typing    loops while it writes the answer
 *   exec      SOMETHING IS HAPPENING — any tool, any step, any confirmation
 *             you gave. This is the workhorse and the source of the rhythm.
 *   ok        something landed well: a file changed, a step closed, the task
 *             finished, a plan is ready for you
 *   warn      STOP AND LOOK — cancelled, rejected, denied, paused, or waiting
 *             on your permission
 *   error     a tool or a step failed
 *   critical  the run itself fell over
 *
 * A read and a search beep too, not just a shell command: they are actions, and
 * hearing the agent move through them is what makes a run feel alive rather
 * than silent-until-something-breaks. Bursts are handled by the rate limiter,
 * not by staying quiet.
 *
 * Successful reads still do not get a second sound on their RESULT — the call
 * already announced itself, and doubling every tool would turn rhythm into
 * chatter. Only mutations get the confirmation.
 */
export function wireSound(bus, board, EV) {
    const on = (ev, fn) => bus.on(ev, fn);

    on(EV.CHAT_THINK, () => board.keepLooping('thinking'));
    on(EV.CHAT_DELTA, () => {
        // Answer tokens mean reasoning is over for this turn; do not overlap.
        board.stopLoop('thinking');
        board.keepLooping('typing');
    });
    on(EV.CHAT_END, () => { board.stopLoop('thinking'); board.stopLoop('typing'); });

    // Every action, not just shell commands.
    on(EV.TOOL_CALL, () => board.play('exec'));
    on(EV.TOOL_RESULT, ({ ok, name }) => {
        if (!ok) board.play('error');
        else if (MUTATING.has(name)) board.play('ok');
    });
    on(EV.TOOL_REJECTED, () => board.play('warn'));

    on(EV.STEP_START, () => board.play('exec'));
    on(EV.STEP_DONE, () => board.play('ok'));
    on(EV.STEP_FAILED, () => board.play('error'));

    on(EV.PLAN_DRAFT, () => board.play('ok'));
    on(EV.PLAN_APPROVED, () => board.play('exec'));
    on(EV.PLAN_REJECTED, () => board.play('warn'));
    on(EV.PLAN_UPDATED, () => board.play('warn'));   // replanned: something went wrong

    on(EV.APPROVAL, () => board.play('warn'));
    on(EV.DIFF, () => board.play('ok'));
    on(EV.ERROR, () => board.play('critical'));

    on(EV.DONE, ({ progress }) => {
        board.stopAll();
        board.play(progress && progress.failed ? 'error' : 'ok');
    });

    on(EV.STATE, ({ from, to }) => {
        // Whenever the engine goes quiet, so do the loops — a stream cut off by
        // a cancel never emits CHAT_END.
        if (['idle', 'done', 'error', 'paused', 'awaiting_approval'].includes(to)) {
            board.stopLoop('thinking');
            board.stopLoop('typing');
        }
        // Cancelled or paused mid-work: that is a stop, and it should sound
        // like one. Reaching `idle` from a working state is exactly a cancel.
        const working = ['exploring', 'planning', 'acting', 'verifying', 'replanning', 'reflecting'];
        if (working.includes(from) && (to === 'idle' || to === 'paused')) board.play('warn');
    });
}
