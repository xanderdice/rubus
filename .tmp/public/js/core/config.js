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
export const SETTINGS_VERSION = 3;

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
    },

    // v3 — la aprobación pasa a ser automática por defecto.
    //
    // Los `autoApprovePlan: false` / `autoRunSteps: false` guardados vienen de
    // cuando ese era el valor por defecto, no de una decisión de nadie, y si se
    // quedan pisan el modo nuevo para siempre: el usuario cambiaría a 'auto' y
    // no pasaría nada. Se borran para que el modo mande. Quien de verdad
    // quiera pararse en cada paso tiene ahora un ajuste que lo dice con esas
    // palabras, y esta migración se anuncia en el arranque.
    3: (saved) => {
        saved.agent = saved.agent || {};
        saved.agent.approvalMode = 'auto';
        delete saved.agent.autoApprovePlan;
        delete saved.agent.autoRunSteps;
        return 'aprobación automática por defecto (cámbialo a «manual» en Ajustes si prefieres revisar cada paso)';
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
        /**
         * Un solo interruptor para toda la fricción: 'auto' | 'manual'.
         *
         * En 'auto' (por defecto) el agente no se para a pedir permiso: aprueba
         * su plan, encadena los pasos y ejecuta los comandos ordinarios. En
         * 'manual' pregunta en cada punto de control, que es como se comportaba
         * antes.
         *
         * En 'auto' eso incluye los comandos destructivos y los orientados al
         * exterior — `rm`, `git push`, `curl`, `docker`…—. Es una decisión
         * tomada a sabiendas, no un descuido, y quien la quiera a medias tiene
         * `security.confirmDestructive: true`: automático para todo lo demás y
         * un diálogo sólo para lo que no se deshace.
         *
         * Lo único que no depende de este ajuste es la lista de BLOQUEADOS de
         * `security.js` — `rm -rf /`, fork bombs, `curl | sh`, formatear una
         * unidad. Eso no es un diálogo que se pueda quitar: es una lista de
         * cosas que no se ejecutan.
         *
         * Y en 'auto' la verificación con el comando de tests DETECTADO del
         * repositorio también se ejecuta sin preguntar. Sobre tu propio
         * proyecto es lo que quieres; sobre un repositorio clonado y no
         * revisado es ejecutar su `scripts.test` sin verlo. Con 'manual'
         * vuelve a preguntar una vez, y `verifyCommandAuto: false` lo apaga.
         */
        approvalMode: 'auto',

        /**
         * Afinado fino, opcional. Deliberadamente NO están en DEFAULTS: así
         * `config.get(...)` devuelve el valor derivado de `approvalMode` salvo
         * que alguien los fije a propósito, y quien los fija (el componente
         * embebido, o el usuario en Ajustes) sigue mandando sobre el modo.
         *
         *   agent.autoApprovePlan   bool
         *   agent.autoRunSteps      bool
         */
        autoApproveSafeTools: true,

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

        /**
         * Con `verifyCommand` vacío, usar el comando de tests que el mapa del
         * proyecto ya ha detectado (`npm test`, `pytest`, `cargo test`…).
         *
         * Activado por defecto, y es el ajuste que más cambia lo que significa
         * "paso completado". Sin él la verificación se queda en lo estructural:
         * comprueba que el archivo sigue siendo JavaScript, no que siga
         * funcionando. Un modelo débil produce código que parsea perfectamente
         * y está mal continuamente, y esa es justo la clase de fallo que sólo
         * cazan los tests del propio proyecto.
         *
         * Sólo se ejecutan comandos de una lista cerrada (ver verify.js) y sólo
         * después de un paso que haya tocado algún archivo. Desactívalo si tu
         * suite tarda demasiado como para correrla entre pasos.
         */
        verifyCommandAuto: true,

        /**
         * Recordar entre ejecuciones, en `<proyecto>/.rubus/memory.md`.
         *
         * Sin esto el arnés es amnésico: vuelve a tropezar con el mismo paso
         * que ya falló ayer y a proponer el comando que ya le rechazaste. Se
         * escribe al terminar, se lee al explorar y al planificar, tiene tope
         * duro por los dos lados y es un archivo de texto que puedes corregir
         * o borrar — una memoria que sólo entiende el programa es una memoria
         * que nadie puede arreglar cuando aprende algo falso.
         */
        memory: true,
        exploreDepth: 2
    },

    /** Qué herramientas ve el modelo, más allá de las de siempre. */
    tools: {
        /**
         * Buscar y leer en internet.
         *
         * Activado: sin esto el modelo se inventa las firmas de las APIs que no
         * puede consultar, que es peor que no saberlas. Apágalo si trabajas sin
         * red, o si prefieres que el agente no hable con nadie de fuera — el
         * resto del programa funciona igual y las dos herramientas
         * desaparecen de su lista en vez de fallar al llamarlas.
         */
        web: true,

        /**
         * Buscador. `{q}` se sustituye por la consulta ya codificada.
         *
         * DuckDuckGo porque no pide clave ni cuenta, que es la única opción
         * compatible con "cero dependencias y sin configurar nada". Si tienes
         * una instancia de SearXNG, ponla aquí y deja de raspar HTML ajeno:
         * https://searx.midominio.org/search?q={q}
         */
        searchEndpoint: 'https://html.duckduckgo.com/html/?q={q}'
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
        /**
         * Preguntar antes de lo que no se deshace: 'segun-modo' | 'siempre' | 'nunca'.
         *
         * Tres estados y no una casilla, porque son tres cosas distintas y la
         * casilla sólo sabía decir dos. Al ser un booleano ausente de DEFAULTS,
         * Ajustes lo dibujaba DESMARCADO —"no confirmar"— mientras el motor, en
         * modo manual, sí preguntaba: la interfaz decía lo contrario de lo que
         * hacía. Y ponerlo en DEFAULTS como `false` habría roto el modo manual
         * de verdad. 'segun-modo' es el estado que faltaba.
         */
        confirmDestructive: 'segun-modo',
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

/**
 * Qué se pregunta y qué no, resuelto en un solo sitio.
 *
 * Existe porque la decisión estaba repartida entre cuatro ajustes leídos en
 * tres archivos, y para responder "¿esto va a pararse a preguntar?" había que
 * juntarlos mentalmente. Con un modo maestro eso deja de ser posible de
 * responder a ojo, así que se responde aquí.
 *
 * Lo que NO aparece aquí es la lista de BLOQUEADOS: no hay ninguna clave que
 * la levante, y no debe haberla. Un diálogo se puede saltar; `rm -rf /` no
 * tiene una versión buena.
 */
/**
 * Los tres estados de "¿pregunto antes de un rm?", más los booleanos que
 * pudiera haber guardados de antes de que esto fuera un selector.
 */
function confirmDestructive(config, auto) {
    const v = config.get('security.confirmDestructive', 'segun-modo');
    if (v === true || v === 'siempre') return false;
    if (v === false || v === 'nunca') return true;
    return auto;
}

export function approvalPolicy(config) {
    const auto = config.get('agent.approvalMode', 'auto') !== 'manual';
    return {
        auto,
        /** Aprobar el plan sin enseñárselo al usuario. */
        plan: !!config.get('agent.autoApprovePlan', auto),
        /** Encadenar los pasos en lugar de ir uno a uno. */
        steps: !!config.get('agent.autoRunSteps', auto),
        /** Comandos de sólo lectura (git status, ls…). */
        safeCommands: !!config.get('agent.autoApproveSafeTools', true),
        /** Comandos con efectos ordinarios (npm install, git commit…). */
        cautionCommands: auto ? true : !config.get('security.confirmDangerous', true),
        /**
         * Comandos que no se deshacen (rm, git push, curl…).
         *
         * Separado de `cautionCommands` a propósito: "ejecuta `npm install` sin
         * molestarme pero pregúntame antes de un `git push`" es una postura
         * razonable y muy común, y con un solo interruptor no se puede decir.
         * `security.confirmDestructive` no está en DEFAULTS: sin fijarlo manda
         * el modo, y fijándolo mandas tú.
         */
        dangerousCommands: confirmDestructive(config, auto),
        /** El comando de tests detectado del repositorio. */
        verifyCommand: auto
    };
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
