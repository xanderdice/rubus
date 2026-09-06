/**
 * El estudio: el mismo arnés de siempre, aplicado a imágenes.
 *
 *   IDLE → COMPONIENDO → RENDERIZANDO → VERIFICANDO → LISTO
 *                ↑                          ↓ (no compila / no se ve nada)
 *                └────────── REPARANDO ─────┘
 *
 * La idea que hace que esto funcione con un modelo pequeño es la misma que en
 * `engine.js`: el modelo no declara el éxito. Un shader que no compila y una
 * imagen que sale negra son, desde dentro del modelo, indistinguibles de un
 * trabajo bien hecho — él escribió su JSON y se quedó tan tranquilo. Sólo una
 * comprobación independiente, mirando lo que de verdad salió por la GPU, cierra
 * ese hueco. Y cuando falla, el error del compilador vuelve al modelo traducido
 * a SUS líneas, que es lo que hace que el segundo intento acierte.
 *
 * `renderer` se inyecta igual que `platform` en el motor principal, y por el
 * mismo motivo: aquí dentro no puede haber ni DOM ni WebGL, o esto dejaría de
 * poder probarse sin una tarjeta gráfica. El contrato es corto:
 *
 *   renderer.ready()            -> boolean
 *   renderer.render(comp)       -> {ok, shaderErrors:[{layer,log,glsl}], stats}
 *   renderer.snapshot(fmt)      -> dataURL
 *   renderer.dispose()
 *
 * `stats` trae lo que hace falta para saber si se ve algo: `coverage` (fracción
 * de píxeles que difieren del fondo) y `uniqueColors`.
 */

import { EV } from '../bus.js';
import { uid, isAbort, abortError } from '../util.js';
import { samplingFor, shapeMessages } from '../model-profiles.js';
import {
    COMPOSITION_SCHEMA, parseComposition, compositionToText, createComposition
} from './composition.js';
import {
    designSystemPrompt, composeInstruction, repairInstruction,
    shaderRepairInstruction, refineInstruction, blankInstruction
} from './prompts.js';

export const STUDIO_STATE = Object.freeze({
    IDLE: 'idle',
    COMPOSING: 'composing',
    RENDERING: 'rendering',
    VERIFYING: 'verifying',
    REPAIRING: 'repairing',
    READY: 'ready',
    ERROR: 'error'
});

/**
 * Por debajo de esto la imagen está vacía a efectos prácticos.
 *
 * No es cero: una composición legítima puede ser un punto pequeño sobre un
 * fondo liso. Es el umbral por debajo del cual lo más probable, con diferencia,
 * es que algo haya salido mal — una capa tapando el resto, o un shader negro.
 */
const MIN_COVERAGE = 0.004;

export class DesignStudio {
    constructor({ ollama, config, bus, logger, renderer }) {
        this.ollama = ollama;
        this.config = config;
        this.bus = bus;
        this.logger = logger;
        this.renderer = renderer;

        this.state = STUDIO_STATE.IDLE;
        this.composition = null;
        this.brief = '';
        this.history = [];
        this.abort = null;
        this._corriendo = null;
        /** Perfil del modelo activo; lo pone el panel al montar. */
        this.profile = null;
    }

    setRenderer(renderer) {
        this.renderer = renderer;
    }

    _setState(next) {
        if (this.state === next) return;
        const from = this.state;
        this.state = next;
        this.bus?.emit(EV.DESIGN_STATE, { from, to: next });
    }

    cancel() {
        this.abort?.abort();
        this._setState(STUDIO_STATE.IDLE);
    }

    /** Petición nueva desde cero. */
    async create(brief, { width, height } = {}) {
        this.brief = String(brief || '').trim();
        if (!this.brief) throw new Error('Describe qué quieres que dibuje.');
        if (!this.config.get('ollama.model', '')) throw new Error('Selecciona primero un modelo.');

        this.composition = null;
        return await this._run(composeInstruction(this.brief, { width, height }), { label: this.brief });
    }

    /** Cambio sobre lo que ya hay en pantalla. */
    async refine(peticion) {
        if (!this.composition) return await this.create(peticion);
        const texto = String(peticion || '').trim();
        if (!texto) throw new Error('Di qué quieres cambiar.');
        // El nombre se hereda de lo que ya había, no de la orden: si el modelo
        // devuelve `name` vacío al refinar, la composición pasaba a llamarse
        // "quítale el grano y ponlo más oscuro" y ese es el nombre del PNG.
        return await this._run(refineInstruction(texto, compositionToText(this.composition)),
            { label: this.composition.name || texto });
    }

    /** Renderiza otra vez lo que ya hay, sin pasar por el modelo. */
    async rerender() {
        if (!this.composition) throw new Error('No hay ninguna composición.');
        this._setState(STUDIO_STATE.RENDERING);
        const out = await this.renderer.render(this.composition);
        this._setState(out.ok ? STUDIO_STATE.READY : STUDIO_STATE.ERROR);
        return out;
    }

    /**
     * El ciclo completo: pedir, parsear, renderizar, comprobar y reparar.
     *
     * Los tres tipos de fallo se tratan distinto a propósito, porque tienen
     * arreglos distintos: el JSON malformado se repara con el error de parseo,
     * el shader roto con el log del compilador traducido, y la imagen vacía con
     * el diagnóstico de cobertura. Mandar los tres como "prueba otra vez"
     * reproduce el mismo fallo tres veces, que es exactamente lo que este
     * proyecto existe para no hacer.
     */
    async _run(instruction, { label }) {
        // Dos ejecuciones a la vez se pisaban y ganaba la MÁS VIEJA: las dos
        // escribían `this.composition` y `this.state`, y el AbortController
        // vivía en un único campo. Un doble clic en Crear bastaba.
        if (this._corriendo) {
            this.abort?.abort();
            await this._corriendo.catch(() => {});
        }
        const promesa = this._runInterno(instruction, { label });
        this._corriendo = promesa;
        try { return await promesa; } finally { if (this._corriendo === promesa) this._corriendo = null; }
    }

    async _runInterno(instruction, { label }) {
        this.abort = new AbortController();
        const maxIntentos = this.config.get('design.maxRepairs', 3);

        let instruccion = instruction;
        let ultimoRaw = '';

        try {
            for (let intento = 0; intento <= maxIntentos; intento++) {
                if (this.abort.signal.aborted) throw abortError();

                this._setState(intento === 0 ? STUDIO_STATE.COMPOSING : STUDIO_STATE.REPAIRING);
                const turno = await this._ask(instruccion);
                ultimoRaw = turno.content || '';

                const parsed = parseComposition(ultimoRaw, { nameFallback: label });
                if (parsed.repairs.length) {
                    this.logger?.info('Composición reparada al vuelo', { repairs: parsed.repairs });
                }

                if (!parsed.ok) {
                    this.logger?.warn(`Composición inválida (intento ${intento + 1})`, { errors: parsed.errors });
                    instruccion = repairInstruction(parsed.errors, ultimoRaw);
                    continue;
                }

                const comp = parsed.composition;
                this.bus?.emit(EV.DESIGN_COMPOSITION, { composition: comp, repairs: parsed.repairs });

                if (!this.renderer?.ready()) {
                    // Sin motor no se puede verificar nada, pero la composición
                    // es válida y vale la pena devolverla: el panel la enseña
                    // como JSON y el usuario ve que el modelo hizo su parte.
                    this.composition = comp;
                    this._setState(STUDIO_STATE.READY);
                    return { ok: true, composition: comp, rendered: false, reason: 'no hay motor de render disponible' };
                }

                this._setState(STUDIO_STATE.RENDERING);
                const out = await this.renderer.render(comp);

                this._setState(STUDIO_STATE.VERIFYING);
                const verdict = this._verify(comp, out);

                if (verdict.ok) {
                    this.composition = comp;
                    this.history.push({ at: Date.now(), label, composition: comp });
                    this._setState(STUDIO_STATE.READY);
                    this.bus?.emit(EV.DESIGN_DONE, { composition: comp, stats: out.stats });
                    return { ok: true, composition: comp, rendered: true, stats: out.stats };
                }

                this.logger?.warn(`El render no pasó la comprobación (intento ${intento + 1})`, { issues: verdict.issues });
                instruccion = verdict.instruction;
                // Se conserva la última composición aunque esté mal: si se
                // agotan los intentos, enseñar algo roto es más útil que no
                // enseñar nada, y el panel avisa de que no pasó la comprobación.
                this.composition = comp;
            }

            this._setState(STUDIO_STATE.ERROR);
            return { ok: false, composition: this.composition, error: `No se consiguió una composición válida en ${maxIntentos + 1} intentos.` };
        } catch (err) {
            if (isAbort(err)) { this._setState(STUDIO_STATE.IDLE); return { cancelled: true }; }
            this._setState(STUDIO_STATE.ERROR);
            this.logger?.error('Fallo del estudio', { error: err.message });
            return { ok: false, error: err.message };
        }
    }

    /** El agente no declara el éxito: se mira lo que salió. */
    _verify(comp, out) {
        const issues = [];

        const fallos = (out.shaderErrors || []).filter(Boolean);
        if (fallos.length) {
            return {
                ok: false,
                issues: fallos.map(f => `capa ${f.layer}: ${String(f.log).split('\n')[0]}`),
                instruction: shaderRepairInstruction(fallos, compositionToText(comp))
            };
        }

        if (!out.ok) {
            return {
                ok: false,
                issues: [out.error || 'el render falló'],
                instruction: repairInstruction([out.error || 'El render falló sin decir por qué.'], null)
            };
        }

        const stats = out.stats || {};
        const coverage = Number(stats.coverage);
        if (Number.isFinite(coverage) && coverage < MIN_COVERAGE) {
            const diagnostico = `sólo el ${(coverage * 100).toFixed(2)}% de los píxeles se diferencia del fondo`;
            issues.push(diagnostico);
            return { ok: false, issues, instruction: blankInstruction(diagnostico, compositionToText(comp)) };
        }

        return { ok: true, issues: [] };
    }

    async _ask(instruction) {
        const model = this.config.get('ollama.model');
        const profile = this.profile || {};
        const chatId = uid('design');

        this.bus?.emit(EV.DESIGN_DELTA, { id: chatId, reset: true });

        return await this.ollama.chat({
            model,
            // shapeMessages, como en todo el resto del proyecto. Este era el
            // único sitio que hablaba con Ollama sin pasar por aquí, y en Gemma
            // —cuya plantilla no tiene turno de sistema— eso significaba perder
            // el prompt ENTERO con el esquema y los ejemplos: el modelo recibía
            // la petición a pelo y no tenía forma de saber qué formato devolver.
            messages: shapeMessages([
                { role: 'system', content: designSystemPrompt() },
                { role: 'user', content: instruction }
            ], profile),
            // Igual que el plan: un esquema del que el modelo no puede salirse
            // es más eficaz que cualquier cantidad de "devuelve sólo JSON".
            format: COMPOSITION_SCHEMA,
            // `false` sólo si el modelo sabe pensar; si no, se omite. Mandar
            // `think` a un modelo sin esa capacidad es un 400 de Ollama, y el
            // motor lleva desde siempre haciéndolo así.
            think: profile.supportsThinking ? false : undefined,
            options: {
                ...samplingFor(profile, 'plan', this.config),
                // Un logo idéntico cada vez no sirve; tampoco uno delirante.
                temperature: this.config.get('design.temperature', 0.45)
            },
            keepAlive: this.config.get('ollama.keepAlive', '30m'),
            signal: this.abort.signal,
            retries: this.config.get('ollama.retries', 3),
            timeoutMs: this.config.get('ollama.requestTimeoutMs', 600000),
            onDelta: (t) => this.bus?.emit(EV.DESIGN_DELTA, { id: chatId, text: t })
        });
    }

    /** Composición de arranque, para que el panel nunca esté en blanco. */
    static starter() {
        return createComposition({
            name: 'Rubus',
            width: 1024,
            height: 1024,
            background: '#0b0e12',
            palette: ['#8fd8e8', '#b2a4ff', '#7ee0a5'],
            layers: [
                { type: 'gradient', color: '#101820', color2: '#05070a', angle: 90 },
                { type: 'shape', shape: 'ring', x: 0.5, y: 0.46, width: 0.44, thickness: 0.008, color: '#8fd8e8', opacity: 0.7 },
                { type: 'text', text: 'RUBUS', x: 0.5, y: 0.46, size: 0.13, color: '#f2f7fa', weight: 'black', letterSpacing: 0.24 },
                { type: 'text', text: 'ESTUDIO', x: 0.5, y: 0.6, size: 0.03, color: '#8fd8e8', letterSpacing: 0.5 }
            ],
            post: [{ effect: 'vignette', amount: 0.4 }, { effect: 'grain', amount: 0.08 }]
        }).comp;
    }
}
