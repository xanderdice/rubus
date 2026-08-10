/**
 * Killing a command, and meaning it.
 *
 * `child.kill()` looks like it stops the command. It does not, and the gap is
 * not academic: every command in this project runs under a shell
 * (`cmd.exe /d /s /c …`, `/bin/sh -c …`), so the pid we hold belongs to the
 * shell, not to the work. On Windows, killing the shell leaves the actual
 * process — the `npm install`, the test run — orphaned and running.
 *
 * Measured, on the /api/exec route: a heartbeat command kept writing for the
 * full three seconds after the client disconnected and the "kill" had already
 * been called, and would have run to completion. The same pid was used by the
 * timeout and by the Cancel button, so neither of those stopped anything
 * either. The symptom is not an error anywhere — it is a fan that will not
 * stop and a lock file nobody is holding on purpose.
 *
 * Windows has no process groups, so the tree is walked with `taskkill /T`.
 * POSIX has them, so the shell is made a group leader at spawn time and the
 * whole group is signalled at once — which is why the spawn options and the
 * kill live in the same file: they only work as a pair.
 */

import { spawn } from 'node:child_process';

export const isWindows = process.platform === 'win32';

/**
 * How to launch `command` so that it can later be killed as a whole.
 * Spread `options` into the spawn call; do not hand-roll them.
 */
export function shellFor(command) {
    return isWindows
        ? {
            cmd: process.env.ComSpec || 'cmd.exe',
            args: ['/d', '/s', '/c', command],
            options: { windowsVerbatimArguments: true, windowsHide: true }
        }
        : {
            cmd: '/bin/sh',
            args: ['-c', command],
            // Group leader. Without this there is no group to signal, and the
            // kill reaches `sh` only — same orphan as on Windows.
            //
            // The trade: a detached child no longer receives the Ctrl+C sent to
            // our own group, so it has to be killed explicitly. Everything that
            // spawns through here already does, on timeout, on disconnect and
            // on Cancel, and an explicit kill that works beats an implicit one
            // that only covers the interactive case.
            options: { detached: true }
        };
}

/** Kill a child started with `shellFor`, and everything it spawned. */
export function killTree(child) {
    if (!child || !child.pid) return;
    if (child.exitCode !== null || child.signalCode) return;   // already gone

    if (isWindows) {
        // Fire and forget: this is called from a 'close' handler and from a
        // timer, and neither can wait for a process to be reaped.
        try {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref();
        } catch { /* nothing left to kill */ }
        return;
    }

    // A negative pid signals the process group this child leads.
    try {
        process.kill(-child.pid, 'SIGKILL');
    } catch {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }
}
