/**
 * AgentCoder as a component you can drop into another app.
 *
 *   import { createAgent } from './js/embed/agent.js';
 *
 *   const agent = await createAgent({
 *       ollamaUrl: 'http://127.0.0.1:11434',   // dónde vive Ollama
 *       model:     'qwen3.6:latest',           // qué modelo usar
 *       workspace: 'C:/proyectos/mi-app',      // sobre qué carpeta trabaja
 *       output:    document.getElementById('salida')   // dónde se ve todo
 *   });
 *
 *   await agent.run('arregla el test que falla');
 *
 * Everything the agent does — cada herramienta, cada resultado, cada archivo
 * tocado, cada fase — se va escribiendo dentro de `output` mientras ocurre. Si
 * no pasas `output`, funciona igual y te suscribes con `agent.on(...)`.
 *
 * The whole engine is reused unchanged: this file is a facade over the same
 * Engine + Bus the desktop app drives, so there is exactly one implementation
 * of the agent and no second thing to keep in sync.
 */

import { detectPlatform } from '../platform/index.js';
import { Bus, EV } from '../core/bus.js';
import { Engine, STATE } from '../core/engine.js';
import { attachView } from './agent-view.js';
import { AgentStream, formatEvent } from './agent-stream.js';

/**
 * @typedef {object} AgentConfig
 * @property {string}  [ollamaUrl]        p.ej. 'http://127.0.0.1:11434'. Se
 *   ignora cuando la página se sirve desde server.js: allí Ollama va por el
 *   proxy del servidor, porque un navegador no puede llamar a localhost desde
 *   una página https ni saltarse CORS.
 * @property {string}  [model]            nombre exacto del modelo de Ollama.
 * @property {string}  [workspace]        carpeta del proyecto.
 * @property {Element} [output]           dónde renderizar. Totalmente opcional:
 *   sin él el componente no toca el DOM y se consume con `agent.read()`.
 * @property {string}  [input]            tarea inicial; se lanza sola.
 * @property {function}[onApproval]       (peticion) => boolean|Promise<boolean>
 *   para decidir los permisos por código.
 * @property {number}  [approvalTimeoutMs] Sin vista ni onApproval, cuánto se
 *   espera a que respondas con approveRequest() antes de rechazar. 120000 por
 *   defecto; 0 para esperar indefinidamente.
 * @property {boolean} [includeLogs]      incluir los logs internos en read().
 * @property {boolean} [autoApprovePlan]  por defecto true en modo embebido.
 * @property {boolean} [autoRunSteps]     por defecto true en modo embebido.
 * @property {boolean} [autoApproveCommands] por defecto false: los comandos
 *   con efectos siguen preguntando, y la pregunta se dibuja en el output.
 * @property {string}  [verifyCommand]    p.ej. 'npm test'.
 * @property {object}  [settings]         parches sueltos sobre la config.
 * @property {function}[onEvent]          (nombre, payload) para cada evento.
 * @property {object}  [platform]         adaptador propio; si no, autodetecta.
 */

/**
 * Build an agent. Async because it probes the platform, Ollama and the model.
 * @param {AgentConfig} config
 */
export async function createAgent(config = {}) {
    const platform = config.platform || await detectPlatform();
    const bus = new Bus();
    const engine = new Engine({ platform, bus });

    // init() loads persisted settings and picks a model, so the caller's
    // overrides have to land after it or they would be overwritten.
    const health = await engine.init();

    if (config.ollamaUrl && !engine.ollamaProxied) {
        engine.config.set('ollama.host', config.ollamaUrl);
        engine.ollama.setHost(config.ollamaUrl);
    }

    // Embedded, the host app is the operator: stopping to ask it to press a
    // button makes no sense. Commands with side effects still ask, because
    // that answer belongs to a human.
    engine.config
        .set('agent.autoApprovePlan', config.autoApprovePlan ?? true)
        .set('agent.autoRunSteps', config.autoRunSteps ?? true)
        .set('agent.autoApproveSafeTools', true);

    if (config.verifyCommand !== undefined) engine.config.set('agent.verifyCommand', config.verifyCommand);
    if (config.settings) engine.config.merge(config.settings);

    if (config.model) {
        await engine.setModel(config.model, { persist: false });
    }
    if (config.workspace) {
        await engine.setWorkspace(config.workspace, { persist: false });
    }

    let view = null;
    if (config.output) {
        view = attachView({ host: config.output, bus, engine });
    }

    // The stream is always available: it costs nothing until read from, and it
    // is what makes `output` genuinely optional rather than nominally optional.
    const stream = new AgentStream(bus, { includeLogs: !!config.includeLogs });

    if (config.onEvent) bus.onAny(config.onEvent);

    /**
     * Who answers a permission request.
     *
     * Order matters. Without an answerer the engine waits forever on a promise
     * nobody will resolve, and the run looks hung — which is exactly the
     * failure mode to avoid when there is no UI on screen.
     */
    if (config.autoApproveCommands) {
        bus.on(EV.APPROVAL, ({ id }) => engine.resolveApproval(id, true));
    } else if (config.onApproval) {
        bus.on(EV.APPROVAL, async (req) => {
            try { engine.resolveApproval(req.id, !!(await config.onApproval(req))); }
            catch { engine.resolveApproval(req.id, false); }
        });
    } else if (!view) {
        // No view and no callback: the request goes out on the stream and the
        // consumer answers with approveRequest(). A consumer that ignores it
        // would hang the run, so there is a deadline — refusing late is
        // recoverable, waiting forever is not.
        const waitMs = config.approvalTimeoutMs ?? 120000;
        bus.on(EV.APPROVAL, ({ id, command }) => {
            if (waitMs <= 0) return;   // 0 = esperar indefinidamente, bajo tu riesgo
            setTimeout(() => {
                // resolveApproval returns false when the request is already
                // answered, which is how we avoid overriding the consumer.
                if (!engine.resolveApproval(id, false)) return;
                bus.emit(EV.STATUS, {
                    text: `Permiso no respondido en ${Math.round(waitMs / 1000)}s; comando rechazado: ${command || ''}. ` +
                        `Responde con agent.approveRequest(id, true) o usa autoApproveCommands.`
                });
            }, waitMs);
        });
    }

    const agent = {
        engine,
        bus,
        platform,
        view,
        stream,

        /**
         * Lo que el modelo ha devuelto desde la lectura anterior.
         *
         *   agent.run('…');                       // sin await
         *   let c;
         *   while ((c = await agent.read())) {
         *       process.stdout.write(c.text);     // tokens tal cual
         *       for (const e of c.events) console.log(e.line);
         *   }
         *
         * Devuelve `null` cuando la tarea ha terminado y no queda nada por
         * entregar: ese es el final del bucle. Lanzar otra tarea lo rearma.
         * Con `{timeoutMs}` no bloquea: vuelve con un trozo vacío.
         */
        read: (opts) => stream.read(opts),

        /** `for await (const chunk of agent.stream)` — el mismo flujo, iterado. */
        readAllText: () => stream.readAllText(),

        /** `{ok, models}` de Ollama tal y como se vio al arrancar. */
        health: health.health,

        /** ¿Está el agente listo para recibir una tarea? */
        get ready() {
            return !!engine.config.get('ollama.model', '') && !!engine.config.get('workspace.root', '');
        },

        get state() { return engine.state; },
        get plan() { return engine.plan; },

        /** Suscribirse a un evento del bus. Devuelve la función para cancelar. */
        on: (event, handler) => bus.on(event, handler),
        onAny: (handler) => bus.onAny(handler),

        /**
         * Lanzar una tarea. Con autoApprovePlan+autoRunSteps (por defecto)
         * resuelve cuando ha terminado del todo. Si desactivas la aprobación
         * automática, resuelve con el plan y tú decides.
         */
        async run(task) {
            const problem = preflight(engine);
            if (problem) throw new Error(problem);

            await engine.start(task);

            // Not auto-approved: hand the plan back and wait for the host.
            if (engine.state === STATE.AWAITING_APPROVAL) {
                return { state: engine.state, plan: engine.plan, snapshot: engine.snapshot() };
            }
            return { state: engine.state, snapshot: engine.snapshot() };
        },

        async approve(editedPlan) { return await engine.approvePlan(editedPlan || null); },
        reject(reason) { return engine.rejectPlan(reason); },
        async step() { return await engine.runNextStep(); },
        async runAll() { return await engine.runAll(); },
        async replan(reason) { return await engine.replanNow(reason); },
        pause() { engine.pause(); },
        resume() { return engine.resume(); },
        async cancel() { return await engine.cancel(); },

        /** Responder a una petición de permiso (EV.APPROVAL). */
        approveRequest: (id, ok) => engine.resolveApproval(id, ok),

        setModel: (name) => engine.setModel(name, { persist: false }),
        setWorkspace: (dir) => engine.setWorkspace(dir, { persist: false }),
        listModels: () => engine.ollama.listModels(),

        snapshot: () => engine.snapshot(),
        /** Registro completo de la sesión, para depurar. */
        logs: (n = 300) => engine.logger.tail(n),

        async destroy() {
            try { await engine.cancel(); } catch { /* nada en marcha */ }
            stream.close();
            if (view) view.destroy();
            bus.clear();
        }
    };

    // Iterating the agent itself is the obvious thing to try, so make it work.
    agent[Symbol.asyncIterator] = () => stream[Symbol.asyncIterator]();

    if (view && !agent.ready) {
        view.note(preflight(engine) || 'Falta configurar el modelo o la carpeta de trabajo.');
    }

    if (config.input) {
        // Deliberately not awaited: createAgent should resolve as soon as the
        // agent exists, so the host can render and wire buttons while the first
        // task runs. Errors go to the bus, which the view already shows.
        agent.run(config.input).catch(err => bus.emit(EV.ERROR, { message: err.message }));
    }

    return agent;
}

/** The specific reason a run cannot start, phrased for a human. */
function preflight(engine) {
    if (!engine.config.get('workspace.root', '')) {
        return 'No hay carpeta de trabajo: pasa `workspace` en la configuración.';
    }
    if (!engine.config.get('ollama.model', '')) {
        return 'No hay modelo seleccionado: pasa `model`, o comprueba que Ollama está corriendo y tiene modelos descargados.';
    }
    return '';
}

export { EV, STATE, AgentStream, formatEvent };
