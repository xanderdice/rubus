/**
 * Headless driver for the agent engine.
 *
 * Same core the desktop app runs, wired to the Node platform adapter and a
 * terminal renderer instead of the webview. It exists so the state machine can
 * be exercised end to end against a real model without a GUI in the way — and
 * so a regression in the harness shows up as a failed run here rather than as
 * a mangled file in someone's repo.
 *
 *   npm run headless -- --root "C:/proyecto" --task "arregla X"
 *   npm run headless -- --root . --task "..." --auto --yes --model qwen3.6:latest
 *
 * Flags:
 *   --root <dir>    carpeta de trabajo (obligatorio)
 *   --task <texto>  la tarea (obligatorio)
 *   --model <name>  modelo de Ollama; por defecto el que detecte
 *   --auto          aprueba el plan y ejecuta todos los pasos sin preguntar
 *   --yes           aprueba automáticamente los comandos que pidan permiso
 *   --plan-only     genera el plan y sale sin ejecutar nada
 *   --verify <cmd>  comando de verificación tras cada paso (p.ej. "npm test")
 *   --verbose       muestra el razonamiento del modelo y los detalles de tools
 */

import { detectPlatform } from '../platform/index.js';
import { Bus, EV } from '../core/bus.js';
import { Engine, STATE } from '../core/engine.js';
import { planToText } from '../core/plan.js';

const args = parseArgs(process.argv.slice(2));
if (!args.root || !args.task) {
    console.error('Uso: npm run headless -- --root <dir> --task "<tarea>" [--model m] [--auto] [--yes] [--plan-only] [--verbose]');
    process.exit(2);
}

const C = {
    dim: s => `\x1b[2m${s}\x1b[0m`,
    bold: s => `\x1b[1m${s}\x1b[0m`,
    cyan: s => `\x1b[36m${s}\x1b[0m`,
    green: s => `\x1b[32m${s}\x1b[0m`,
    red: s => `\x1b[31m${s}\x1b[0m`,
    yellow: s => `\x1b[33m${s}\x1b[0m`
};

const platform = await detectPlatform();
const bus = new Bus();
const engine = new Engine({ platform, bus });

let streaming = false;
const endStream = () => { if (streaming) { process.stdout.write('\n'); streaming = false; } };

bus.on(EV.STATE, ({ from, to }) => { endStream(); console.log(C.dim(`\n[estado] ${from} → ${to}`)); });
bus.on(EV.OLLAMA, (h) => console.log(h.ok ? C.green(`● Ollama OK (${h.models.length} modelos)`) : C.red(`● Ollama caído: ${h.error}`)));
bus.on(EV.MODEL, ({ model, profile }) => console.log(C.cyan(
    `● Modelo: ${model} — tools nativas: ${profile.nativeTools ? 'sí' : 'no'}, thinking: ${profile.supportsThinking ? 'sí' : 'no'}, ctx máx: ${profile.maxContext || '?'}`
)));

bus.on(EV.CHAT_DELTA, ({ text }) => { streaming = true; process.stdout.write(text); });
if (args.verbose) bus.on(EV.CHAT_THINK, ({ text }) => process.stdout.write(C.dim(text)));

bus.on(EV.TOOL_CALL, ({ name, args: a }) => {
    endStream();
    console.log(C.bold(`\n  ▸ ${name}`) + ' ' + C.dim(compact(a)));
});
bus.on(EV.TOOL_RESULT, (r) => {
    console.log(`    ${r.ok ? C.green('✓') : C.red('✗')} ${r.summary} ${C.dim(`(${r.durationMs}ms)`)}`);
    if (args.verbose && r.detail) console.log(C.dim(indent(String(r.detail).slice(0, 1500), '      ')));
});
bus.on(EV.TOOL_REJECTED, ({ name, reason }) => console.log(C.red(`    ✗ ${name} rechazada: ${reason}`)));

bus.on(EV.DIFF, ({ path, stats }) => console.log(C.yellow(`    ± ${path}  +${stats.added} -${stats.removed}`)));
bus.on(EV.STEP_START, ({ step, index, total, attempt }) =>
    console.log(C.bold(`\n━━ Paso ${index + 1}/${total}: ${step.title}${attempt > 1 ? ` (intento ${attempt})` : ''} ━━`)));
bus.on(EV.STEP_DONE, ({ step }) => console.log(C.green(`━━ Paso ${step.id} completado: ${step.summary}`)));
bus.on(EV.STEP_FAILED, ({ step, error }) => console.log(C.red(`━━ Paso ${step.id} FALLÓ: ${error}`)));
bus.on(EV.PLAN_UPDATED, ({ plan }) => { endStream(); console.log(C.yellow(`\n[replan r${plan.revision}]\n${planToText(plan)}`)); });
bus.on(EV.CONTEXT, (u) => { if (args.verbose) console.log(C.dim(`    [contexto ${u.used}/${u.budget} tokens]`)); });
bus.on(EV.ERROR, ({ message }) => { endStream(); console.log(C.red(`\n[error] ${message}`)); });
bus.on(EV.LOG, (e) => { if (args.verbose && e.level !== 'debug') console.log(C.dim(`    [${e.level}] ${e.message}`)); });

// Approval gate. Without --yes the run stops on anything that needs a human,
// which is the correct default even headless.
bus.on(EV.APPROVAL, async ({ id, title, detail, command, risk }) => {
    endStream();
    console.log(C.yellow(`\n⚠ ${title} [${risk}]`));
    if (command) console.log(`   ${C.bold(command)}`);
    if (detail) console.log(C.dim(`   ${detail}`));

    if (args.yes) { console.log(C.dim('   → aprobado automáticamente (--yes)')); engine.resolveApproval(id, true); return; }
    const answer = await ask('   ¿Ejecutar? [s/N] ');
    engine.resolveApproval(id, /^s|y/i.test(answer.trim()));
});

// ── run ───────────────────────────────────────────────────────────────────

const init = await engine.init();
if (!init.health.ok) {
    console.error(C.red(`\nOllama no responde en ${init.health.host}. Arranca "ollama serve" y reintenta.`));
    process.exit(1);
}
if (args.model) await engine.setModel(args.model);
if (args.verify) engine.config.set('agent.verifyCommand', args.verify);
await engine.setWorkspace(args.root);

console.log(C.dim(`\nTarea: ${args.task}\n`));
const started = Date.now();

await engine.start(args.task);
endStream();

if (engine.state === STATE.ERROR) process.exit(1);

if (engine.plan) {
    console.log(C.bold('\n══════ PLAN PROPUESTO ══════'));
    console.log(planToText(engine.plan));
    for (const s of engine.plan.steps) {
        console.log(C.dim(`\n  ${s.id}. ${s.description}`));
        if (s.files.length) console.log(C.dim(`     archivos: ${s.files.join(', ')}`));
        console.log(C.dim(`     verificación: ${s.verify}`));
    }
    console.log(C.bold('════════════════════════════\n'));
}

if (args.planOnly) { console.log(C.dim('--plan-only: no se ejecuta nada.')); process.exit(0); }

if (!args.auto) {
    const answer = await ask('¿Aprobar el plan y ejecutarlo? [s/N] ');
    if (!/^s|y/i.test(answer.trim())) { engine.rejectPlan('rechazado desde la consola'); process.exit(0); }
}

await engine.approvePlan();
await engine.runAll();
endStream();

const snap = engine.snapshot();
console.log(C.bold('\n══════ RESULTADO ══════'));
console.log(`Estado: ${snap.state}`);
console.log(`Pasos: ${snap.progress.done}/${snap.progress.total} completados${snap.progress.failed ? `, ${snap.progress.failed} fallidos` : ''}`);
console.log(`Archivos modificados: ${snap.changes.length}`);
for (const c of snap.changes) console.log(`  ± ${c.path}  +${c.added} -${c.removed}`);
console.log(C.dim(`Duración total: ${Math.round((Date.now() - started) / 1000)}s`));

process.exit(snap.progress.failed || snap.state === STATE.ERROR ? 1 : 0);

// ── helpers ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const out = { auto: false, yes: false, planOnly: false, verbose: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--auto') out.auto = true;
        else if (a === '--yes') out.yes = true;
        else if (a === '--plan-only') out.planOnly = true;
        else if (a === '--verbose') out.verbose = true;
        else if (a === '--root') out.root = argv[++i];
        else if (a === '--task') out.task = argv[++i];
        else if (a === '--model') out.model = argv[++i];
        else if (a === '--verify') out.verify = argv[++i];
    }
    return out;
}

function ask(question) {
    return new Promise(resolve => {
        process.stdout.write(question);
        process.stdin.setEncoding('utf8');
        process.stdin.resume();
        process.stdin.once('data', (d) => { process.stdin.pause(); resolve(String(d)); });
    });
}

function compact(obj) {
    const s = JSON.stringify(obj);
    return s.length > 160 ? s.slice(0, 160) + '…' : s;
}

function indent(text, pad) {
    return text.split('\n').map(l => pad + l).join('\n');
}
