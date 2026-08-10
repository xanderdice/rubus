/**
 * Shell access.
 *
 * The whitelist lives in core/security.js; this tool is the gate that consults
 * it. Three outcomes: run it, ask the user first, or refuse. There is no fourth
 * outcome where the model talks its way past the gate — the classification runs
 * on the command string, after the model has already spoken, and nothing in the
 * conversation can change the verdict.
 *
 * Output is truncated from the MIDDLE. The head has the command echo and the
 * tail has the error, and those are the two parts that matter; a 4000-line
 * webpack log in between helps nobody and costs the whole context window.
 */

import { RISK } from '../security.js';
import { stripAnsi, truncateMiddle, formatDuration } from '../util.js';
import { EV } from '../bus.js';

export const runTerminalCommand = {
    name: 'run_terminal_command',
    title: 'Ejecutar comando',
    description: 'Ejecuta un comando de terminal en la raíz del proyecto y devuelve su salida. Úsalo para compilar, ejecutar tests o inspeccionar el entorno.',
    readOnly: false,
    mutates: false, // it can, but not through a path we can diff
    params: {
        command: { type: 'string', required: true, description: 'El comando completo, tal cual se escribiría en la terminal.' },
        timeout_seconds: { type: 'integer', required: false, default: 120, min: 1, max: 900, description: 'Tiempo máximo antes de matar el proceso.' }
    },
    examples: [{ args: { command: 'npm test' } }],

    async run(args, ctx) {
        const command = String(args.command || '').trim();
        const verdict = ctx.security.classifyCommand(command);

        if (verdict.risk === RISK.BLOCKED) {
            return {
                ok: false,
                summary: `Comando bloqueado: ${command}`,
                detail: `${verdict.why}\nEste comando no se ejecutará nunca. Busca otra forma de conseguir el objetivo del paso.`
            };
        }

        // Destructive commands always ask, whatever the settings say — that
        // switch controls ordinary side effects (npm install, git commit), not
        // `rm -rf` and `git push`. Read-only commands never ask unless the user
        // has explicitly turned off unattended safe execution.
        const mustAsk = verdict.risk === RISK.DANGEROUS
            ? true
            : verdict.risk === RISK.SAFE
                ? !ctx.config.get('agent.autoApproveSafeTools', true)
                : ctx.config.get('security.confirmDangerous', true);

        if (mustAsk) {
            const approved = await ctx.requestApproval({
                kind: 'command',
                risk: verdict.risk,
                title: verdict.risk === RISK.DANGEROUS ? 'Comando peligroso' : 'Ejecutar comando',
                detail: verdict.why || 'Este comando puede modificar el proyecto.',
                command
            });
            if (!approved) {
                return {
                    ok: false,
                    summary: 'El usuario rechazó el comando.',
                    detail: `No se ejecutó "${command}". No lo vuelvas a proponer en este paso; busca una alternativa o termina el paso explicando el bloqueo.`
                };
            }
        }

        const timeoutMs = (args.timeout_seconds || 120) * 1000;
        ctx.bus.emit(EV.TERMINAL, { stream: 'cmd', text: command, command });

        const result = await ctx.platform.exec(command, {
            cwd: ctx.root,
            timeoutMs,
            onOutput: (stream, text) => ctx.bus.emit(EV.TERMINAL, { stream, text, command })
        });

        const stdout = stripAnsi(result.stdout || '').trim();
        const stderr = stripAnsi(result.stderr || '').trim();
        const cap = ctx.config.get('context.toolResultMaxChars', 6000);

        const parts = [];
        if (stdout) parts.push(`--- stdout ---\n${truncateMiddle(stdout, cap)}`);
        if (stderr) parts.push(`--- stderr ---\n${truncateMiddle(stderr, Math.floor(cap / 2))}`);
        if (!parts.length) parts.push('(sin salida)');

        const ok = result.exitCode === 0;
        parts.push(`--- código de salida: ${result.exitCode}${result.timedOut ? ' (timeout)' : ''} ---`);

        return {
            ok,
            summary: `${command} → exit ${result.exitCode} (${formatDuration(result.durationMs)})`,
            detail: parts.join('\n'),
            data: { exitCode: result.exitCode, timedOut: result.timedOut, stdout, stderr, command }
        };
    }
};
