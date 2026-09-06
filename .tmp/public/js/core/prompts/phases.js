/**
 * The per-turn instructions.
 *
 * These are the messages placed LAST in the prompt, after all the reference
 * material, because that is the position a small model actually reads. Each one
 * states the task, the format, and the stop condition — in that order, and
 * without hedging. Any sentence in here that could be read two ways is a bug.
 */

import { planToText, stepToText, MAX_STEPS } from '../plan.js';
import { truncateMiddle } from '../util.js';

export function exploreInstruction(task) {
    return [
        'TAREA DEL USUARIO:',
        task,
        '',
        'Antes de planificar nada, reconoce el terreno.',
        '',
        'Usa las herramientas de lectura para averiguar dónde está el código que hay que tocar.',
        'Máximo 6 llamadas. NO puedes modificar nada todavía.',
        '',
        'Cuando ya sepas lo suficiente, llama a finish_step con un "summary" que contenga',
        'exactamente estas cuatro secciones:',
        '',
        '  ARCHIVOS RELEVANTES: rutas, una por línea, con una frase de qué hace cada una',
        '  CÓMO FUNCIONA AHORA: 2-4 frases',
        '  QUÉ HAY QUE CAMBIAR: 2-4 frases',
        '  RIESGOS: lo que se puede romper, o "ninguno evidente"',
        '',
        'finish_step aquí significa "he terminado de explorar", no "he arreglado el problema".'
    ].join('\n');
}

export function planInstruction(task, findings) {
    return [
        'TAREA DEL USUARIO:',
        task,
        '',
        findings ? `LO QUE HAS AVERIGUADO EXPLORANDO:\n${truncateMiddle(findings, 4000)}\n` : '',
        'Ahora escribe el plan.',
        '',
        'Responde con UN objeto JSON y nada más:',
        '',
        '{',
        '  "goal": "una frase con el objetivo global",',
        '  "steps": [',
        '    {',
        '      "title": "frase corta en imperativo",',
        '      "description": "qué hay que hacer exactamente, con nombres reales de archivos y funciones",',
        '      "files": ["ruta/relativa.js"],',
        '      "tools": ["read_file", "edit_file"],',
        '      "verify": "cómo se comprueba que este paso concreto quedó bien"',
        '    }',
        '  ]',
        '}',
        '',
        'Requisitos del plan:',
        `  · entre 1 y ${MAX_STEPS} pasos; para una tarea pequeña, UN paso;`,
        '  · cada "verify" debe ser comprobable de verdad (un comando, un archivo que debe',
        '    contener algo concreto, un test que debe pasar). No vale "el código es correcto";',
        '  · "files" con rutas relativas que EXISTEN, o que este mismo plan va a crear;',
        '  · nada de pasos de relleno ("analizar", "revisar", "planificar").',
        '',
        'Sin texto fuera del JSON. Sin ```.'
    ].filter(Boolean).join('\n');
}

export function planRepairInstruction(errors, previous) {
    return [
        'El plan que has devuelto no es válido.',
        '',
        'PROBLEMAS:',
        ...errors.map(e => `  - ${e}`),
        '',
        previous ? `LO QUE DEVOLVISTE:\n${truncateMiddle(previous, 1500)}\n` : '',
        'Devuelve el plan corregido: un único objeto JSON con "goal" y "steps".',
        'Nada de texto alrededor, nada de ```. Corrige sólo lo señalado.'
    ].filter(Boolean).join('\n');
}

export function actInstruction({ plan, step, attempt, lastFailure }) {
    const rows = [
        planToText(plan, { current: step.id }),
        '',
        '────────────────────────────────────',
        stepToText(step),
        '────────────────────────────────────'
    ];

    if (attempt > 1) {
        rows.push(
            '',
            `⚠ Este es el intento ${attempt} de este paso. Los anteriores fallaron.`,
            'No repitas el mismo enfoque: cambia de estrategia.'
        );
    }

    if (lastFailure) {
        rows.push('', 'LO ÚLTIMO QUE FALLÓ:', truncateMiddle(lastFailure, 1500));
    }

    rows.push(
        '',
        'Ejecuta SÓLO este paso. Una herramienta por turno.',
        'Cuando se cumpla el criterio de éxito, llama a finish_step.'
    );

    return rows.join('\n');
}

/** Fed back when the model's output could not be turned into a tool call. */
export function toolRepairInstruction({ problem, availableTools, profile, lastOutput }) {
    const format = profile.nativeTools
        ? 'Usa el mecanismo de tool calling, una sola llamada.'
        : 'Responde con UN objeto JSON: {"tool": "<nombre>", "args": {...}}. Sin ``` y sin texto alrededor.';

    return [
        'Tu última respuesta no se pudo interpretar como una llamada a herramienta.',
        '',
        `PROBLEMA: ${problem}`,
        lastOutput ? `\nLO QUE ESCRIBISTE:\n${truncateMiddle(lastOutput, 700)}` : '',
        '',
        `HERRAMIENTAS VÁLIDAS: ${availableTools.join(', ')}`,
        format,
        '',
        'Vuelve a intentarlo ahora, con una única llamada bien formada.'
    ].filter(Boolean).join('\n');
}

/** Sent after the harness verified a file the model just wrote, and it failed. */
export function verificationFailureInstruction(issues) {
    return [
        '⚠ VERIFICACIÓN AUTOMÁTICA FALLIDA — el archivo que acabas de escribir tiene problemas:',
        '',
        ...issues.map(i => `  · ${i}`),
        '',
        'Arréglalo ahora. Lee el archivo con read_file para ver cómo quedó realmente',
        'y corrígelo con edit_file. No llames a finish_step hasta que esté bien.'
    ].join('\n');
}

export function replanInstruction({ plan, failedStep, failure, remaining }) {
    return [
        'El plan se ha atascado y hay que rehacerlo desde donde está.',
        '',
        planToText(plan, { current: failedStep?.id }),
        '',
        `PASO QUE FALLÓ: ${failedStep ? `${failedStep.id}. ${failedStep.title}` : '(ninguno concreto)'}`,
        '',
        'POR QUÉ FALLÓ:',
        truncateMiddle(failure || 'sin detalle', 2000),
        '',
        'Los pasos marcados [x] YA ESTÁN HECHOS y no se van a repetir: no los incluyas.',
        `Reescribe únicamente los ${remaining} pasos que quedan, teniendo en cuenta lo que has aprendido del fallo.`,
        '',
        'Responde con UN objeto JSON:',
        '{"goal": "el mismo objetivo", "steps": [ ...sólo los pasos que faltan... ]}',
        '',
        'Si el fallo demuestra que el objetivo no se puede conseguir así, propón pasos',
        'que sigan otro camino. Si de verdad no hay camino, devuelve un único paso cuyo',
        '"description" explique el bloqueo y cuyo "verify" sea "informar al usuario".',
        '',
        'Sin texto fuera del JSON.'
    ].join('\n');
}

export function reflectInstruction({ plan, changes, verification }) {
    const changeList = changes.length
        ? changes.map(c => `  · ${c.path} (+${c.added}/-${c.removed})`).join('\n')
        : '  (ningún archivo modificado)';

    return [
        'El trabajo ha terminado. Escribe el informe final para el usuario.',
        '',
        planToText(plan),
        '',
        'ARCHIVOS MODIFICADOS:',
        changeList,
        verification ? `\nVERIFICACIÓN DEL PROYECTO:\n${truncateMiddle(verification, 1200)}` : '',
        '',
        'Formato de la respuesta (texto plano, en español, sin JSON y sin llamar a herramientas):',
        '',
        '1. Una frase con lo que se ha conseguido.',
        '2. Lista de cambios, uno por línea: archivo — qué se cambió y por qué.',
        '3. Qué se ha verificado y con qué (si no se verificó nada, dilo).',
        '4. Qué queda pendiente o qué debería revisar el usuario a mano. Si no hay nada, di "nada pendiente".',
        '',
        'Sé breve y honesto. No digas que funciona si no lo has comprobado.'
    ].filter(Boolean).join('\n');
}

/** Short nudge used when a turn produced neither a tool call nor useful text. */
export function nudgeInstruction(step) {
    return [
        'No has hecho nada en el turno anterior.',
        '',
        `Sigues en el paso ${step.id}: ${step.title}`,
        `Criterio de éxito: ${step.verify}`,
        '',
        'Llama a una herramienta ahora. Si el paso ya está hecho, llama a finish_step.'
    ].join('\n');
}
