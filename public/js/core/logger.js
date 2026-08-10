/**
 * Session log.
 *
 * Two consumers with different needs: the UI wants the last few hundred lines
 * cheaply, and a post-mortem wants everything including the raw model output.
 * So the ring buffer stays in memory and the full record is appended to
 * `<root>/.rubus/logs/<session>.jsonl` in batches — one write per line
 * would make a chatty step cost hundreds of filesystem round trips.
 */

import { nowIso, uid } from './util.js';
import { EV } from './bus.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
    constructor(bus, platform, { level = 'info', memoryLimit = 2000 } = {}) {
        this.bus = bus;
        this.platform = platform;
        this.level = level;
        this.memoryLimit = memoryLimit;
        this.entries = [];
        this.sessionId = uid('sess');
        this.file = null;
        this._queue = [];
        this._flushing = false;
        this._timer = null;
    }

    /** Point the log at a workspace. Called again whenever the root changes. */
    async attach(root) {
        if (!root || this.platform.degraded) { this.file = null; return; }
        try {
            const dir = `${root}/.rubus/logs`;
            await this.platform.fs.mkdirp(dir);
            this.file = `${dir}/${this.sessionId}.jsonl`;
        } catch {
            this.file = null; // logging must never take the app down
        }
    }

    debug(message, data) { this._write('debug', message, data); }
    info(message, data) { this._write('info', message, data); }
    warn(message, data) { this._write('warn', message, data); }
    error(message, data) { this._write('error', message, data); }

    _write(level, message, data) {
        if (LEVELS[level] < LEVELS[this.level]) return;

        const entry = { t: nowIso(), level, message, data: safe(data) };
        this.entries.push(entry);
        if (this.entries.length > this.memoryLimit) {
            this.entries.splice(0, this.entries.length - this.memoryLimit);
        }

        this.bus.emit(EV.LOG, entry);
        if (this.file) {
            this._queue.push(JSON.stringify(entry));
            this._schedule();
        }
    }

    _schedule() {
        if (this._timer) return;
        this._timer = setTimeout(() => { this._timer = null; this.flush(); }, 400);
    }

    async flush() {
        if (this._flushing || !this.file || !this._queue.length) return;
        this._flushing = true;
        const batch = this._queue.splice(0, this._queue.length);
        try {
            let existing = '';
            try { existing = await this.platform.fs.readText(this.file); } catch { /* first batch */ }
            await this.platform.fs.writeText(this.file, existing + batch.join('\n') + '\n');
        } catch {
            // Disk full, path gone, permissions — none of it is worth
            // interrupting an agent run for. The memory buffer still has it.
            this.file = null;
        } finally {
            this._flushing = false;
        }
    }

    tail(n = 200) {
        return this.entries.slice(-n);
    }
}

/** Strip anything that would blow up JSON.stringify or bloat the log. */
function safe(data) {
    if (data === undefined || data === null) return undefined;
    if (typeof data === 'string') return data.length > 8000 ? data.slice(0, 8000) + '…' : data;
    try {
        const s = JSON.stringify(data);
        return s.length > 8000 ? JSON.parse(JSON.stringify(data, replacer(8000))) : data;
    } catch {
        return String(data);
    }
}

function replacer(limit) {
    return (_key, value) => (typeof value === 'string' && value.length > limit ? value.slice(0, limit) + '…' : value);
}
