/**
 * Tools that act on the agent rather than on the project.
 *
 * `think` and `finish_step` look like filler. They are not:
 *
 *  - Without `think`, a model in forced-JSON mode has no legal way to say
 *    "I need a moment" — every turn must be a tool call — so it invents an
 *    edit instead. Giving it a no-op is cheaper than the edit it would have
 *    made up. The engine caps consecutive uses so it cannot stall.
 *
 *  - Without `finish_step`, nothing marks a step complete. Weak models either
 *    keep editing past the point of done, or stop replying at all and the turn
 *    loop has to time out. An explicit terminator makes completion an event.
 */

export const getProjectStructure = {
    name: 'get_project_structure',
    title: 'Estructura del proyecto',
    description: 'Devuelve el árbol del proyecto y las funciones/clases principales de cada archivo. Úsalo al principio para orientarte.',
    readOnly: true,
    mutates: false,
    params: {
        refresh: { type: 'boolean', required: false, default: false, description: 'true para volver a escanear el disco en vez de usar la caché.' }
    },
    examples: [{ args: {} }],

    async run(args, ctx) {
        const map = await ctx.repoMap.build({ force: !!args.refresh, signal: ctx.signal });
        return {
            ok: true,
            summary: `${map.fileCount} archivos, ${map.dirCount} carpetas`,
            detail: map.text,
            data: { fileCount: map.fileCount, dirCount: map.dirCount }
        };
    }
};

export const think = {
    name: 'think',
    title: 'Pensar',
    description: 'Anota un razonamiento sin tocar nada. Úsalo sólo cuando necesites decidir entre opciones; no cuenta como progreso.',
    readOnly: true,
    mutates: false,
    params: {
        thought: { type: 'string', required: true, description: 'Qué estás razonando y qué vas a hacer a continuación.' }
    },
    examples: [{ args: { thought: 'El archivo usa CommonJS, así que la importación nueva debe ser require, no import.' } }],

    async run(args, ctx) {
        const n = (ctx.thinkStreak || 0) + 1;
        ctx.setThinkStreak(n);

        if (n >= 3) {
            return {
                ok: false,
                summary: 'Demasiados "think" seguidos.',
                detail: 'Has usado think 3 veces sin hacer nada. Actúa ahora con una herramienta real, o llama a finish_step si ya has terminado.'
            };
        }
        return {
            ok: true,
            summary: 'Anotado.',
            detail: `Razonamiento anotado. Ahora ejecuta una acción real (te quedan ${3 - n} "think" antes de que se bloquee).`
        };
    }
};

export const finishStep = {
    name: 'finish_step',
    title: 'Terminar paso',
    description: 'Declara que el paso actual está completo. Llámalo SÓLO cuando el criterio de verificación del paso ya se cumple.',
    readOnly: true,
    mutates: false,
    params: {
        summary: { type: 'string', required: true, description: 'Qué has hecho en este paso, en una o dos frases.' }
    },
    examples: [{ args: { summary: 'Añadido el parámetro `timeout` a fetchUser() y actualizada su llamada en api.js.' } }],

    async run(args, ctx) {
        // The engine reads this after the tool returns and breaks the turn loop.
        ctx.setStepFinished(String(args.summary || '').trim());
        return { ok: true, summary: 'Paso marcado como completado.', detail: args.summary, data: { finished: true } };
    }
};
