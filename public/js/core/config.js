/**
 * Settings: defaults, persistence, and the reasoning behind the numbers.
 *
 * Most of these values are tuned for models that are bad at this job. Where a
 * default looks timid compared to a cloud agent, that is deliberate — see the
 * comment next to it.
 */

import { deepMerge, deepClone } from './util.js';

/**
 * Bump when a default changes in a way existing users must receive.
 *
 * Saved settings beat DEFAULTS — correct, but it means a changed default never
 * reaches anyone who has already used the app. And there are three stores in
 * play (a JSON file under Node, localStorage in the browser, Neutralino's own),
 * so hand-editing one fixes nothing. A version plus a migration is the only
 * thing that reaches all three.
 */
export const SETTINGS_VERSION = 2;

/** Applied in order to settings saved before the current version. */
const MIGRATIONS = {
    // v2 — reasoning on by default. Anyone upgrading has `false` saved from
    // when it was off, which would leave the UI with nothing to show for the
    // entire run and no hint as to why.
    2: (saved) => {
        saved.agent = saved.agent || {};
        saved.agent.thinkInPlan = true;
        saved.agent.thinkInAct = true;
        return 'razonamiento activado en todas las fases';
    }
};

export const DEFAULTS = {
    settingsVersion: SETTINGS_VERSION,
    ollama: {
        host: 'http://127.0.0.1:11434',
        model: '',
        // 0.15 is low even for coding. Weak models drift into invented APIs
        // very quickly above ~0.4, and every drift costs a repair round trip.
        temperature: 0.15,
        topP: 0.9,
        repeatPenalty: 1.05,
        // Asked for explicitly in the brief. Clamped down at runtime to what
        // the model actually reports so we never silently truncate.
        numCtx: 32768,
        numPredict: 3072,
        requestTimeoutMs: 600000,
        retries: 3,
        keepAlive: '30m'
    },

    agent: {
        // Plan approval is the whole safety model. Auto-approving it turns this
        // into an ordinary autonomous agent, which is precisely what fails on
        // weak models. Off by default; the switch exists for trusted loops.
        autoApprovePlan: false,
        autoApproveSafeTools: true,
        autoRunSteps: false,

        maxStepAttempts: 3,
        maxTurnsPerStep: 14,
        maxToolRepairs: 3,
        maxReplans: 3,
        // One file mutation per turn, then verify. Two edits before a check is
        // how a weak model ends up with a half-migrated file it cannot reason
        // about any more.
        maxMutationsPerTurn: 1,

        /**
         * Reasoning, on by default in every phase.
         *
         * With `think: false` Ollama emits ZERO reasoning tokens — measured:
         * 0 characters against 662 with it on. So switching this off does not
         * "hide" the thinking, it prevents it from existing, and the UI has
         * nothing to show for the whole run. Watching an agent work without
         * seeing why it does what it does is the thing this project is least
         * willing to ship.
         *
         * It is not free. A run measured here went from 138s to 287s, and
         * qwen3.6 can spend its entire output budget deliberating and return
         * nothing at all. That failure is handled rather than avoided: the
         * engine detects a starved turn, retries the phase without thinking,
         * and remembers (`_thinkStarved`) so it stops paying for it. Turn these
         * off if you want speed over insight.
         */
        thinkInPlan: true,
        thinkInAct: true,

        /**
         * How hard to think: 'low' | 'medium' | 'high' | 'on'.
         *
         * Ollama 0.32+ accepts the string levels and models that implement
         * graded reasoning (gpt-oss and friends) honour them. Qwen3.6 accepts
         * them without error but, measured here, does not produce a consistent
         * difference — 2060 / 942 / 1438 characters for low / medium / high,
         * which is sampling noise, not a gradient. 'on' sends the plain boolean
         * for models that only understand that, and the engine falls back to it
         * automatically if a level is rejected.
         */
        thinkLevel: 'on',
        autoVerify: true,
        verifyCommand: '',
        exploreDepth: 2
    },

    context: {
        // Fraction of num_ctx we are willing to fill before summarising.
        budgetRatio: 0.72,
        repoMapMaxTokens: 2600,
        fileMaxTokens: 3500,
        toolResultMaxChars: 6000,
        historyKeepTurns: 8,
        summarizeAt: 0.78,
        maxPinnedFiles: 8
    },

    security: {
        allowShell: true,
        confirmDangerous: true,
        allowOutsideRoot: false,
        extraSafeCommands: [],
        extraBlockedCommands: []
    },

    ui: {
        language: 'es',
        // Only bounded by how long the walk takes: the file panel is virtual,
        // so the DOM cost does not grow with the project.
        explorerMaxFiles: 200000,
        sound: true,
        soundVolume: 0.5,

        /**
         * Spoken output.
         *
         * On by default: this app is used without looking at it, and beeps say
         * that something happened while speech says what. Turn it off if you
         * already run a screen reader — two voices over each other is worse
         * than either alone.
         *
         * verbosity: 'off' silent · 'key' plan, permissions, steps, errors and
         * the final report · 'all' adds narration of every tool call.
         */
        speech: true,
        speechVerbosity: 'key',
        speechVoice: '',
        speechRate: 1.05,
        speechPitch: 1,
        speechVolume: 1,
        bloom: 'soft',
        scanlines: true,
        showThinking: true,
        fontSize: 12
    },

    workspace: {
        root: '',
        pinned: [],
        recent: []
    }
};

const STORAGE_KEY = 'agentcoder.settings.v1';

/** Leaf-by-leaf comparison of the saved settings against DEFAULTS. */
function diffFromDefaults(saved, defaults = DEFAULTS, prefix = '') {
    const out = [];
    for (const [key, value] of Object.entries(saved || {})) {
        const path = prefix ? `${prefix}.${key}` : key;
        const base = defaults ? defaults[key] : undefined;

        if (value && typeof value === 'object' && !Array.isArray(value)) {
            out.push(...diffFromDefaults(value, base || {}, path));
            continue;
        }
        if (JSON.stringify(value) !== JSON.stringify(base)) {
            out.push({ path, saved: value, default: base });
        }
    }
    return out;
}

export class Config {
    constructor(platform) {
        this.platform = platform;
        this.data = deepClone(DEFAULTS);
    }

    async load() {
        const saved = await this.platform.storage.get(STORAGE_KEY);
        this.migrations = [];

        if (saved) {
            const from = Number(saved.settingsVersion) || 1;
            for (let v = from + 1; v <= SETTINGS_VERSION; v++) {
                if (!MIGRATIONS[v]) continue;
                const note = MIGRATIONS[v](saved);
                this.migrations.push(`v${v}: ${note}`);
            }
            saved.settingsVersion = SETTINGS_VERSION;

            this.data = deepMerge(deepClone(DEFAULTS), saved);
            // Persist immediately: a migration that only lives in memory runs
            // again on every start and never actually converges.
            if (this.migrations.length) await this.save();
        }

        this.overrides = saved ? diffFromDefaults(saved) : [];
        return this.data;
    }

    /** Migrations applied on this load, for the startup log. */
    describeMigrations() {
        return this.migrations || [];
    }

    /**
     * Which settings the stored file is overriding, as `path: saved (default X)`.
     *
     * Saved settings win over DEFAULTS, which is correct but invisible: edit a
     * default in this file, restart, and nothing changes — because a value
     * saved months ago is still in force. That is a genuinely confusing hour to
     * lose, so the engine logs this list at startup.
     */
    describeOverrides() {
        return this.overrides || [];
    }

    async save() {
        await this.platform.storage.set(STORAGE_KEY, this.data);
    }

    /** Dotted read: `cfg.get('ollama.model')`. */
    get(path, fallback) {
        const v = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), this.data);
        return v === undefined ? fallback : v;
    }

    /** Dotted write. Persisting is the caller's call so bulk edits cost one write. */
    set(path, value) {
        const keys = path.split('.');
        const last = keys.pop();
        let node = this.data;
        for (const k of keys) {
            if (!node[k] || typeof node[k] !== 'object') node[k] = {};
            node = node[k];
        }
        node[last] = value;
        return this;
    }

    merge(patch) {
        this.data = deepMerge(this.data, patch);
        return this;
    }

    async reset() {
        this.data = deepClone(DEFAULTS);
        await this.save();
    }
}
