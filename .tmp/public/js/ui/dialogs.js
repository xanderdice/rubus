/**
 * The three modal flows: folder picker, model picker, approval gate.
 *
 * The folder picker is hand-rolled rather than always deferring to the native
 * dialog because the native one is unavailable outside the Neutralino shell and
 * awkward over remote sessions. The system dialog is still offered as a button
 * for anyone who prefers it.
 */

import { el, icon, clear, $, $$, openDialog, closeDialog, toast, formatBytes } from './dom.js';
import * as P from '../platform/paths.js';

/* ── folder picker ─────────────────────────────────────────────────────── */

export class FolderPicker {
    constructor({ platform, engine }) {
        this.platform = platform;
        this.engine = engine;
        this.current = '';
        this.resolve = null;

        $('#folder-up').addEventListener('click', () => this.go(P.dirname(this.current) || this.current));
        $('#folder-go').addEventListener('click', () => this.go($('#folder-path').value));
        $('#folder-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.go(e.target.value); });
        $('#folder-confirm').addEventListener('click', () => this.confirm());
        $('#folder-native').addEventListener('click', async () => {
            const dir = await this.platform.pickDirectory('Carpeta del proyecto');
            if (dir) { this.current = dir; this.confirm(); }
        });
    }

    async open() {
        const start = this.engine.config.get('workspace.root', '')
            || this.platform.cwd()
            || (await this.platform.home())
            || (this.platform.isWindows ? 'C:/' : '/');

        openDialog('folder-dialog');
        // Native dialog is Neutralino-only; hide the button when it cannot work.
        $('#folder-native').hidden = typeof this.platform.pickDirectory !== 'function' || this.platform.kind !== 'neutralino';
        await this.renderRecent();
        await this.go(start);
        return new Promise(res => { this.resolve = res; });
    }

    async renderRecent() {
        const box = clear($('#folder-recent'));

        // Over HTTP there is no shell cwd to fall back on, so the drive letters
        // the server reports are the only way to get anywhere from a cold start.
        if (typeof this.platform.roots === 'function') {
            for (const r of await this.platform.roots()) {
                box.appendChild(el('button', {
                    class: 'chip', title: r,
                    onclick: () => this.go(r)
                }, [icon('folder', 'ico ico--sm'), el('span', {}, r)]));
            }
        }

        for (const r of this.engine.config.get('workspace.recent', []) || []) {
            box.appendChild(el('button', {
                class: 'chip', title: r,
                onclick: () => this.go(r)
            }, [icon('folder', 'ico ico--sm'), el('span', {}, P.basename(r) || r)]));
        }
    }

    async go(path) {
        const target = P.normalize(path || '');
        if (!target) return;

        const list = clear($('#folder-list'));
        $('#folder-path').value = target;
        $('#folder-status').textContent = '';

        let entries;
        try {
            entries = await this.platform.fs.readDir(target);
        } catch (err) {
            $('#folder-status').textContent = `No se puede abrir: ${err.message}`;
            return;
        }

        this.current = target;
        const dirs = entries.filter(e => e.isDirectory).sort((a, b) => a.name.localeCompare(b.name));
        const fileCount = entries.length - dirs.length;

        if (!dirs.length) {
            list.appendChild(el('div', { class: 'empty-msg' }, 'Sin subcarpetas.'));
        }
        for (const d of dirs.slice(0, 400)) {
            list.appendChild(el('div', {
                class: 'list-row',
                ondblclick: () => this.go(d.path),
                onclick: () => this.go(d.path)
            }, [icon('folder', 'ico ico--sm'), el('span', {}, d.name)]));
        }

        $('#folder-status').textContent = `${dirs.length} carpetas, ${fileCount} archivos`;
    }

    confirm() {
        const chosen = this.current;
        closeDialog('folder-dialog');
        const done = this.resolve;
        this.resolve = null;
        if (done) done(chosen);
    }
}

/* ── model picker ──────────────────────────────────────────────────────── */

export class ModelPicker {
    constructor({ engine }) {
        this.engine = engine;
        this.resolve = null;
        $('#model-refresh').addEventListener('click', () => this.load());

        for (const btn of $$('#think-levels .think-lvl')) {
            btn.addEventListener('click', () => this.setLevel(btn.dataset.level));
        }
    }

    /**
     * Reasoning effort.
     *
     * 'off' is not a level, it is the two phase switches turned off — Ollama
     * has no "level zero", and `think:false` is what actually stops the model
     * generating reasoning at all.
     */
    async setLevel(level) {
        const cfg = this.engine.config;
        if (level === 'off') {
            cfg.set('agent.thinkInPlan', false).set('agent.thinkInAct', false);
        } else {
            cfg.set('agent.thinkInPlan', true).set('agent.thinkInAct', true).set('agent.thinkLevel', level);
        }
        await cfg.save();
        this.renderLevels();
        toast(level === 'off' ? 'Razonamiento desactivado.' : `Nivel de pensamiento: ${level}`);
    }

    currentLevel() {
        const cfg = this.engine.config;
        const on = cfg.get('agent.thinkInPlan', true) || cfg.get('agent.thinkInAct', true);
        return on ? cfg.get('agent.thinkLevel', 'on') : 'off';
    }

    renderLevels() {
        const active = this.currentLevel();
        for (const btn of $$('#think-levels .think-lvl')) {
            btn.classList.toggle('active', btn.dataset.level === active);
        }

        // Say what the chosen model will actually do with this, rather than
        // implying every model grades its reasoning. Most do not.
        const profile = this.engine.profile;
        const note = $('#think-note');
        if (!profile || !profile.supportsThinking) {
            note.textContent = 'este modelo no razona: el nivel no tendrá efecto';
            note.className = 'think-note warn';
        } else if (active !== 'off' && active !== 'on') {
            note.textContent = 'si el modelo no gradúa el esfuerzo, equivale a "activado"';
            note.className = 'think-note';
        } else {
            note.textContent = '';
            note.className = 'think-note';
        }
    }

    async open() {
        openDialog('model-dialog');
        this.renderLevels();
        await this.load();
        return new Promise(res => { this.resolve = res; });
    }

    async load() {
        const list = clear($('#model-list'));
        list.appendChild(el('div', { class: 'empty-msg' }, 'Consultando Ollama…'));

        const health = await this.engine.ollama.health();
        clear(list);

        if (!health.ok) {
            list.appendChild(el('div', { class: 'empty-msg' },
                `${health.error}\n\nArranca Ollama con "ollama serve" y pulsa Recargar.`));
            return;
        }
        if (!health.models.length) {
            list.appendChild(el('div', { class: 'empty-msg' },
                'Ollama no tiene modelos.\n\nDescarga uno, por ejemplo:\n  ollama pull qwen3.6\n  ollama pull gemma4'));
            return;
        }

        const active = this.engine.config.get('ollama.model', '');
        // Tuned-for models first: this app is built around their failure modes.
        const ranked = [...health.models].sort((a, b) => score(b) - score(a));

        for (const m of ranked) {
            const tools = m.capabilities.includes('tools');
            list.appendChild(el('div', {
                class: `list-row ${m.name === active ? 'active' : ''}`,
                onclick: () => this.pick(m.name)
            }, [
                icon('cpu', 'ico ico--sm'),
                el('span', {}, m.name),
                el('span', { class: 'tags' }, [
                    tools
                        ? el('span', { class: 'tag good', title: 'Tool calling nativo' }, 'tools')
                        : el('span', { class: 'tag warn', title: 'Sin tool calling: se usará el protocolo JSON' }, 'json'),
                    m.capabilities.includes('thinking') ? el('span', { class: 'tag' }, 'think') : null
                ]),
                el('span', { class: 'sub' },
                    `${m.parameterSize || '?'} · ${m.quantization || '?'} · ${formatBytes(m.size)}${m.contextLength ? ` · ${Math.round(m.contextLength / 1024)}k ctx` : ''}`)
            ]));
        }
    }

    async pick(name) {
        closeDialog('model-dialog');
        const done = this.resolve;
        this.resolve = null;
        try {
            await this.engine.setModel(name);
            // Capabilities just changed; the note must follow.
            this.renderLevels();
            toast(`Modelo: ${name}`);
        } catch (err) {
            toast(`No se pudo activar ${name}: ${err.message}`, 'bad');
        }
        if (done) done(name);
    }
}

function score(m) {
    const n = m.name.toLowerCase();
    let s = 0;
    if (/^qwen3\.6/.test(n)) s += 100;
    else if (/^qwen3/.test(n)) s += 80;
    else if (/gemma4/.test(n)) s += 70;
    else if (/gemma/.test(n)) s += 50;
    if (m.capabilities.includes('tools')) s += 20;
    if (/coder|code/.test(n)) s += 15;
    return s;
}

/* ── approval gate ─────────────────────────────────────────────────────── */

export class ApprovalGate {
    constructor({ engine, sound = null }) {
        this.engine = engine;
        this.sound = sound;
        this.queue = [];
        this.active = null;

        $('#approval-allow').addEventListener('click', () => this.answer(true));
        $('#approval-deny').addEventListener('click', () => this.answer(false));

        // Enter approves, Escape rejects — but only while the gate is open, and
        // Escape is wired here rather than in the shared dismissal handler so it
        // resolves the promise instead of leaving the engine hanging.
        document.addEventListener('keydown', (e) => {
            if (!this.active) return;
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.answer(false); }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.answer(true); }
        }, true);
    }

    request(req) {
        this.queue.push(req);
        if (!this.active) this.next();
    }

    next() {
        this.active = this.queue.shift() || null;
        if (!this.active) { closeDialog('approval-dialog'); return; }

        const { title, detail, command, risk } = this.active;
        $('#approval-title').textContent = title || 'Confirmar';
        $('#approval-detail').textContent = detail || '';

        const cmd = $('#approval-command');
        cmd.textContent = command || '';
        cmd.hidden = !command;

        $('#approval-risk').textContent = risk === 'dangerous'
            ? 'Riesgo ALTO: este comando puede borrar datos o afectar a algo fuera del proyecto. Léelo entero antes de aceptar.'
            : 'Se ejecutará en la carpeta de trabajo. Ctrl+Enter acepta, Esc rechaza.';

        const allow = $('#approval-allow');
        allow.className = risk === 'dangerous' ? 'btn btn--danger' : 'btn btn--primary';
        allow.textContent = risk === 'dangerous' ? 'Ejecutar de todas formas' : 'Ejecutar';

        openDialog('approval-dialog');
        // Focus Deny, not Allow: a stray Enter should not run a shell command.
        $('#approval-deny').focus();
    }

    answer(approved) {
        if (!this.active) return;
        // The decision is yours, so it gets its own sound: green light or stop.
        if (this.sound) this.sound.play(approved ? 'exec' : 'warn');
        this.engine.resolveApproval(this.active.id, approved);
        this.active = null;
        this.next();
    }

    /** Cancelling a run must not leave a modal hanging over the UI. */
    reset() {
        for (const q of this.queue) this.engine.resolveApproval(q.id, false);
        this.queue.length = 0;
        if (this.active) { this.engine.resolveApproval(this.active.id, false); this.active = null; }
        closeDialog('approval-dialog');
    }
}
