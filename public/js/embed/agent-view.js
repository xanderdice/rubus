/**
 * The renderer for the embeddable agent: turns bus events into DOM inside a
 * host-supplied element.
 *
 * Self-contained on purpose. An app that embeds the agent should not have to
 * adopt Rubus's stylesheet, its markup or its icon sprite, so this file
 * injects one small scoped style block (once, per document) and builds
 * everything with plain elements. Class names are prefixed `ac-` so they cannot
 * collide with the host's CSS.
 *
 * It renders EVERYTHING the agent does — every tool call with its arguments,
 * every result, every file change, every phase and step boundary — because the
 * whole point of embedding this is to be able to watch it work.
 */

import { EV } from '../core/bus.js';
import { STATE } from '../core/engine.js';
import { ProgressStrip } from '../ui/progress.js';
import { StreamWriter } from '../ui/stream-writer.js';

const STYLE_ID = 'agentcoder-embed-style';

const CSS = `
.ac-root{--ac-fg:#8fa6b1;--ac-hot:#eafaff;--ac-dim:#5d717c;--ac-line:rgba(143,216,232,.18);
  --ac-ok:#7ee0a5;--ac-bad:#ff786e;--ac-warn:#ffc478;--ac-plan:#b2a4ff;--ac-bg:#070d13;
  display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;
  background:var(--ac-bg);color:var(--ac-fg);
  font:12px/1.6 ui-monospace,"Cascadia Mono",Consolas,Menlo,monospace}
.ac-scroll{flex:1;min-height:0;overflow-y:auto;padding:10px 12px}
.ac-bar{display:flex;align-items:center;gap:8px;flex:0 0 auto;height:24px;padding:0 10px;
  border-top:1px solid rgba(255,196,120,.3);background:rgba(255,196,120,.08);color:var(--ac-warn);font-size:11px}
.ac-bar[hidden]{display:none}
.ac-spin{width:9px;height:9px;border:1px solid currentColor;border-top-color:transparent;
  border-radius:50%;animation:ac-spin .8s linear infinite;flex:0 0 auto}
@keyframes ac-spin{to{transform:rotate(360deg)}}
.ac-prog{flex:0 0 auto;border-top:1px solid var(--ac-line);background:rgba(143,216,232,.05);
  padding:3px 10px;max-height:126px;overflow-y:auto}
.ac-prog[hidden]{display:none}
.ac-prog-row{display:flex;align-items:center;gap:7px;height:19px;font-size:10px;white-space:nowrap}
.ac-prog-spin{flex:0 0 auto;width:9px;height:9px;border:1.5px solid rgba(143,216,232,.28);
  border-top-color:rgba(143,216,232,1);border-radius:50%;animation:ac-spin .7s linear infinite}
.ac-prog-text{flex:0 0 auto;color:var(--ac-hot)}
.ac-prog-bar{flex:0 0 auto;width:110px;height:4px;border:1px solid var(--ac-line);border-radius:2px;
  overflow:hidden;background:rgba(0,0,0,.35)}
.ac-prog-bar[hidden]{display:none}
.ac-prog-fill{display:block;height:100%;width:0;background:rgba(143,216,232,.95);transition:width .18s linear}
.ac-prog-detail{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--ac-dim);
  direction:rtl;text-align:left}
.ac-prog-time{flex:0 0 auto;color:rgba(143,216,232,.85);font-variant-numeric:tabular-nums}
.ac-prog-done .ac-prog-spin{animation:none;border-color:var(--ac-ok);border-top-color:var(--ac-ok)}
.ac-prog-done .ac-prog-text{color:var(--ac-ok)}
.ac-bar-phase{text-transform:uppercase;letter-spacing:.1em;font-size:10px}
.ac-bar-detail{color:var(--ac-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.ac-bar-clock{font-variant-numeric:tabular-nums}
.ac-msg{margin-bottom:9px;padding:7px 9px;border-left:2px solid var(--ac-line);
  background:rgba(143,216,232,.04);white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
.ac-msg.user{border-left-color:rgba(143,216,232,.6);background:rgba(143,216,232,.09);color:var(--ac-hot)}
.ac-msg.err{border-left-color:var(--ac-bad);background:rgba(255,120,110,.08);color:var(--ac-bad)}
.ac-msg.note{border-left-color:rgba(178,164,255,.6);background:rgba(178,164,255,.07);font-size:11px}
.ac-who{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--ac-dim);margin-bottom:3px}
.ac-banner{display:flex;align-items:center;gap:8px;margin:13px 0 7px;color:var(--ac-dim);
  font-size:9px;letter-spacing:.14em;text-transform:uppercase}
.ac-banner::after{content:"";flex:1;height:1px;background:var(--ac-line)}
.ac-banner.step{color:var(--ac-plan)}
.ac-banner.ok{color:var(--ac-ok)}
.ac-banner.bad{color:var(--ac-bad)}
.ac-act{margin-bottom:4px;padding:4px 8px;border-left:2px solid var(--ac-line);background:rgba(0,0,0,.22);font-size:11px}
.ac-act.ok{border-left-color:rgba(126,224,165,.55)}
.ac-act.err{border-left-color:var(--ac-bad);background:rgba(255,120,110,.07)}
.ac-act-head{display:flex;align-items:center;gap:6px}
.ac-st{width:11px;text-align:center;flex:0 0 auto;color:var(--ac-dim)}
.ac-st.run{animation:ac-pulse 1s ease-in-out infinite}
.ac-st.ok{color:var(--ac-ok)}.ac-st.err{color:var(--ac-bad)}
@keyframes ac-pulse{0%,100%{opacity:1}50%{opacity:.3}}
.ac-name{color:var(--ac-hot);flex:0 0 auto}
.ac-target{color:var(--ac-dim);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ac-ms{color:var(--ac-dim);font-size:9px;flex:0 0 auto}
.ac-res{margin:3px 0 0 17px;line-height:1.5}
.ac-act.err .ac-res{color:var(--ac-bad)}
.ac-det{margin:3px 0 0 17px}
.ac-det>summary{color:var(--ac-dim);font-size:10px;cursor:pointer}
.ac-det pre{margin:4px 0 0;padding:6px 8px;border:1px solid var(--ac-line);background:rgba(0,0,0,.35);
  color:var(--ac-dim);font-size:10px;white-space:pre-wrap;max-height:300px;overflow:auto}
.ac-diff{display:flex;gap:7px;align-items:center;margin-bottom:4px;padding:5px 9px;font-size:11px;
  border-left:2px solid rgba(255,196,120,.6);background:rgba(255,196,120,.07)}
.ac-diff b{color:var(--ac-hot);font-weight:400;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ac-add{color:var(--ac-ok)}.ac-del{color:var(--ac-bad)}
.ac-plan{margin:8px 0;padding:8px 10px;border:1px solid rgba(178,164,255,.35);background:rgba(178,164,255,.06)}
.ac-plan-goal{color:var(--ac-hot);margin-bottom:6px}
.ac-plan-step{display:flex;gap:7px;padding:2px 0;font-size:11px}
.ac-plan-step .m{width:14px;flex:0 0 auto;color:var(--ac-dim);text-align:center}
.ac-plan-step.done .m{color:var(--ac-ok)}
.ac-plan-step.failed .m{color:var(--ac-bad)}
.ac-plan-step.running{color:var(--ac-hot)}
.ac-done{margin:14px 0 8px;padding:9px 11px;border:1px solid rgba(126,224,165,.45);background:rgba(126,224,165,.07)}
.ac-done.bad{border-color:rgba(255,196,120,.5);background:rgba(255,196,120,.07)}
.ac-done-h{color:var(--ac-ok);text-transform:uppercase;letter-spacing:.1em;font-size:11px;
  display:flex;gap:8px;align-items:center}
.ac-done.bad .ac-done-h{color:var(--ac-warn)}
.ac-done-h span{margin-left:auto;color:var(--ac-dim);text-transform:none;letter-spacing:0;font-size:10px}
.ac-done-b{margin-top:5px;font-size:11px}
.ac-think{margin-bottom:5px;border:1px dashed rgba(178,164,255,.3);background:rgba(178,164,255,.04)}
.ac-think[open]{border-color:rgba(178,164,255,.6);background:rgba(178,164,255,.08)}
.ac-think[open]>summary{color:rgba(178,164,255,1)}
.ac-think>summary{padding:3px 8px;font-size:9px;letter-spacing:.1em;text-transform:uppercase;
  color:rgba(178,164,255,.85);cursor:pointer}
.ac-think div{padding:6px 9px;color:var(--ac-dim);font-size:11px;white-space:pre-wrap;max-height:220px;overflow:auto}
.ac-ask{margin:8px 0;padding:9px 11px;border:1px solid rgba(255,196,120,.55);background:rgba(255,196,120,.09)}
.ac-ask-cmd{margin:6px 0;padding:6px 8px;background:rgba(0,0,0,.35);color:var(--ac-warn);
  white-space:pre-wrap;word-break:break-all}
.ac-ask-btns{display:flex;gap:6px;margin-top:7px}
.ac-btn{padding:3px 10px;border:1px solid var(--ac-line);background:rgba(143,216,232,.07);
  color:var(--ac-fg);font:inherit;font-size:11px;cursor:pointer}
.ac-btn:hover{color:var(--ac-hot);border-color:rgba(143,216,232,.6)}
.ac-btn.go{color:var(--ac-ok);border-color:rgba(126,224,165,.5)}
.ac-btn.no{color:var(--ac-bad);border-color:rgba(255,120,110,.5)}
`;

const PHASE_BANNER = {
    [STATE.EXPLORING]: 'explorando — leyendo el proyecto, sin modificar nada',
    [STATE.PLANNING]: 'planificando',
    [STATE.AWAITING_APPROVAL]: 'esperando aprobación del plan',
    [STATE.REPLANNING]: 'replanificando tras un fallo',
    [STATE.REFLECTING]: 'redactando el informe final'
};

const WORKING = new Set([STATE.EXPLORING, STATE.PLANNING, STATE.VERIFYING, STATE.REPLANNING, STATE.REFLECTING]);

function injectStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.appendChild(style);
}

function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
}

/**
 * Attach a renderer to `host`, driven by `bus`.
 * Returns `{ destroy }`; the caller owns the element.
 */
export function attachView({ host, bus, engine, showThinking = true }) {
    injectStyle(host.ownerDocument || document);

    host.classList.add('ac-root');
    host.textContent = '';

    const scroll = h('div', 'ac-scroll');

    // One row per operation in flight, above the summary bar. Same reasoning as
    // the standalone app: the summary says which phase, this says what it is
    // actually blocked on right now — and during a cold model load that is the
    // only thing distinguishing "thinking" from "hung".
    const progressHost = h('div', 'ac-prog');
    progressHost.hidden = true;
    const progress = new ProgressStrip(progressHost, { prefix: 'ac-' });

    const bar = h('div', 'ac-bar');
    bar.hidden = true;
    const spin = h('i', 'ac-spin');
    const barPhase = h('span', 'ac-bar-phase', 'trabajando');
    const barDetail = h('span', 'ac-bar-detail');
    const barClock = h('span', 'ac-bar-clock', '0s');
    bar.append(spin, barPhase, barDetail, barClock);
    host.append(scroll, progressHost, bar);

    const actions = new Map();
    const streams = new Map();
    let timer = null;
    let startedAt = 0;
    let runStartedAt = 0;
    let stepLabel = '';
    let turn = 0;

    const atBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
    const add = (node) => {
        const stick = atBottom();
        scroll.appendChild(node);
        if (stick) scroll.scrollTop = scroll.scrollHeight;
        return node;
    };

    const banner = (text, kind = '') => add(h('div', `ac-banner ${kind}`, text));

    let waiting = '';

    function tick() {
        const s = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
        barClock.textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
        barDetail.textContent = [stepLabel, turn ? `turno ${turn}` : '', waiting]
            .filter(Boolean).join(' · ');
    }

    function startBar(phase) {
        barPhase.textContent = phase;
        if (!startedAt) startedAt = Date.now();
        if (!runStartedAt) runStartedAt = Date.now();
        bar.hidden = false;
        if (!timer) timer = setInterval(tick, 1000);
        tick();
    }

    function stopBar() {
        clearInterval(timer);
        timer = null;
        startedAt = 0;
        waiting = '';
        bar.hidden = true;
        progress.clearAll();
    }

    const off = [];
    const on = (ev, fn) => off.push(bus.on(ev, fn));

    on(EV.PROGRESS, (p) => {
        progress.apply(p);
        if (!p.done && p.label) waiting = p.label;
        else if (p.done && waiting === p.label) waiting = '';
        tick();
    });

    on(EV.CHAT_USER, ({ text }) => {
        const box = add(h('div', 'ac-msg user'));
        box.append(h('div', 'ac-who', 'tú'), h('div', null, text));
    });

    on(EV.STATE, ({ from, to }) => {
        if (PHASE_BANNER[to] && from !== to) banner(PHASE_BANNER[to]);
        if (WORKING.has(to) || to === STATE.ACTING) startBar(PHASE_BANNER[to] ? to : 'ejecutando');
        else stopBar();
    });

    on(EV.CHAT_START, ({ id }) => {
        const wrap = h('div', 'ac-msg');
        const think = document.createElement('details');
        think.className = 'ac-think';
        think.hidden = true;
        const thinkSum = h('summary', null, 'razonamiento del modelo');
        const thinkBody = h('div');
        think.append(thinkSum, thinkBody);
        const body = h('div');
        wrap.append(h('div', 'ac-who', 'agente'), think, body);
        const startedAt = Date.now();
        streams.set(id, {
            wrap, body, think, thinkBody, thinkSum, thinkOpened: false, startedAt,
            // Same reasoning as the standalone chat: per-token DOM writes cost a
            // forced layout and a full re-serialisation each. Coalesced to one
            // update per animation frame.
            out: new StreamWriter({ target: body, scrollers: [scroll] }),
            reason: new StreamWriter({
                target: thinkBody,
                scrollers: [thinkBody, scroll],
                onFrame: (len) => {
                    thinkSum.textContent =
                        `● pensando… ${len} caracteres · ${Math.round((Date.now() - startedAt) / 1000)}s`;
                }
            })
        });
        add(wrap);
    });
    on(EV.CHAT_DELTA, ({ id, text }) => {
        const s = streams.get(id);
        if (!s) return;
        s.out.write(text);
    });
    on(EV.CHAT_THINK, ({ id, text }) => {
        const s = streams.get(id);
        if (!s || !showThinking) return;

        s.reason.write(text);
        s.think.hidden = false;

        // Open it while it streams. Reasoning is routinely the longest stretch
        // of a turn — twenty thousand characters is normal — and leaving it
        // inside a closed <details> means the user watches nothing during
        // precisely the part where the most is happening. It folds away again
        // in CHAT_END, so the finished transcript stays readable.
        if (!s.thinkOpened) { s.think.open = true; s.thinkOpened = true; }
        // Header and scrolling happen in the writer's frame callback, once per
        // frame instead of once per token.
    });
    on(EV.CHAT_END, ({ id, text }) => {
        const s = streams.get(id);
        if (!s) return;
        streams.delete(id);

        // rAF does not fire in a hidden tab; the finished turn must render
        // without waiting for the user to come back.
        s.out.flush();
        s.reason.flush();
        const streamed = s.out.text;
        const reasoned = s.reason.text;
        const final = (text ?? streamed) || '';
        s.out.dispose();
        s.reason.dispose();

        // Fold the reasoning away now that it is over; it stays one click away,
        // labelled with how much there was and how long it took.
        if (s.thinkOpened) {
            s.think.open = false;
            const secs = Math.round((Date.now() - s.startedAt) / 1000);
            s.thinkSum.textContent = `razonamiento del modelo · ${reasoned.length} caracteres · ${secs}s`;
        }

        // A turn that was only a tool call has no prose; an empty bubble for it
        // is pure noise next to the action entry that follows.
        if (!final.trim() && !reasoned.trim()) s.wrap.remove();
        else if (final.trim()) s.body.textContent = final;
    });

    on(EV.TOOL_CALL, ({ id, name, args }) => {
        turn++;
        const node = h('div', 'ac-act');
        const st = h('span', 'ac-st run', '·');
        const head = h('div', 'ac-act-head');
        head.append(st, h('span', 'ac-name', name), h('span', 'ac-target', describeArgs(args)), h('span', 'ac-ms'));
        node.append(head);
        actions.set(id, { node, st, head });
        add(node);
        tick();
    });

    on(EV.TOOL_RESULT, ({ id, ok, summary, detail, durationMs }) => {
        const a = actions.get(id);
        if (!a) return;
        actions.delete(id);
        a.node.classList.add(ok ? 'ok' : 'err');
        a.st.className = `ac-st ${ok ? 'ok' : 'err'}`;
        a.st.textContent = ok ? '✓' : '✗';
        a.head.querySelector('.ac-ms').textContent = fmtMs(durationMs);
        if (summary) a.node.append(h('div', 'ac-res', summary));
        if (detail) {
            const text = String(detail);
            if (text.length > 200 || text.includes('\n')) {
                const d = document.createElement('details');
                d.className = 'ac-det';
                d.append(h('summary', null, `ver salida (${text.split('\n').length} líneas)`), h('pre', null, text.slice(0, 40000)));
                a.node.append(d);
            } else {
                a.node.append(h('div', 'ac-res', text));
            }
        }
    });

    on(EV.TOOL_REJECTED, ({ name, reason }) => {
        const node = h('div', 'ac-act err');
        const head = h('div', 'ac-act-head');
        head.append(h('span', 'ac-st err', '✗'), h('span', 'ac-name', name), h('span', 'ac-target', 'rechazada'));
        node.append(head, h('div', 'ac-res', reason));
        add(node);
    });

    on(EV.DIFF, ({ path, stats, created }) => {
        const node = h('div', 'ac-diff');
        node.append(
            h('b', null, path),
            created ? h('span', null, 'nuevo') : h('span', null, ''),
            h('span', 'ac-add', `+${stats.added}`),
            h('span', 'ac-del', `-${stats.removed}`)
        );
        add(node);
    });

    const renderPlan = (plan, title) => {
        const box = h('div', 'ac-plan');
        box.append(h('div', 'ac-plan-goal', `${title}: ${plan.goal}`));
        const mark = { pending: '·', running: '»', done: '✓', failed: '✗', skipped: '–' };
        for (const s of plan.steps) {
            const row = h('div', `ac-plan-step ${s.status}`);
            row.append(h('span', 'm', mark[s.status] || '·'), h('span', null, `${s.id}. ${s.title}`));
            box.append(row);
        }
        add(box);
    };

    on(EV.PLAN_DRAFT, ({ plan }) => renderPlan(plan, 'Plan propuesto'));
    on(EV.PLAN_UPDATED, ({ plan }) => renderPlan(plan, `Plan revisado (r${plan.revision})`));

    on(EV.STEP_START, ({ step, index, total, attempt }) => {
        stepLabel = `paso ${index + 1}/${total}`;
        turn = 0;
        banner(`paso ${index + 1}/${total} · ${step.title}${attempt > 1 ? ` (intento ${attempt})` : ''}`, 'step');
        startBar('ejecutando');
    });
    on(EV.STEP_DONE, ({ step }) => banner(`✓ paso ${step.id} — ${step.summary}`, 'ok'));
    on(EV.STEP_FAILED, ({ step, error }) => banner(`✗ paso ${step.id} — ${error}`, 'bad'));

    on(EV.APPROVAL, ({ id, title, detail, command, risk }) => {
        const box = h('div', 'ac-ask');
        box.append(h('div', null, `⚠ ${title}`));
        if (command) box.append(h('div', 'ac-ask-cmd', command));
        if (detail) box.append(h('div', null, detail));

        const btns = h('div', 'ac-ask-btns');
        const yes = h('button', `ac-btn ${risk === 'dangerous' ? 'no' : 'go'}`, 'Ejecutar');
        const no = h('button', 'ac-btn', 'Rechazar');
        const answer = (v) => {
            engine.resolveApproval(id, v);
            btns.remove();
            box.append(h('div', null, v ? '→ aprobado' : '→ rechazado'));
        };
        yes.onclick = () => answer(true);
        no.onclick = () => answer(false);
        btns.append(yes, no);
        box.append(btns);
        add(box);
    });

    on(EV.ERROR, ({ message }) => {
        stopBar();
        add(h('div', 'ac-msg err', message));
    });

    on(EV.DONE, ({ summary, changed, progress }) => {
        stopBar();
        const failed = progress.failed > 0;
        const box = h('div', `ac-done ${failed ? 'bad' : ''}`);
        const head = h('div', 'ac-done-h');
        head.append(
            h('b', null, failed ? 'Terminado con fallos' : 'Terminado'),
            h('span', null, fmtMs(runStartedAt ? Date.now() - runStartedAt : 0))
        );
        box.append(head, h('div', 'ac-done-b', summary || ''),
            h('div', 'ac-done-b', `${progress.done}/${progress.total} pasos · ${changed.length} archivo(s) modificado(s)`));
        add(box);
        runStartedAt = 0;
    });

    return {
        element: host,
        note: (text) => add(h('div', 'ac-msg note', text)),
        clear: () => {
            // Cancel queued frames before the nodes go, or a pending callback
            // fires against detached elements.
            for (const s of streams.values()) { s.out.dispose(); s.reason.dispose(); }
            scroll.textContent = ''; actions.clear(); streams.clear();
        },
        destroy() {
            for (const unsub of off) unsub();
            off.length = 0;
            for (const s of streams.values()) { s.out.dispose(); s.reason.dispose(); }
            streams.clear();
            clearInterval(timer);
            progress.destroy();
            host.textContent = '';
            host.classList.remove('ac-root');
        }
    };
}

function describeArgs(args) {
    if (!args) return '';
    if (args.path) return args.path + (args.around_line ? `  ~L${args.around_line}` : args.start_line > 1 ? `  L${args.start_line}+` : '');
    if (args.command) return args.command;
    if (args.query) return `"${args.query}"`;
    if (args.summary) return String(args.summary).slice(0, 110);
    if (args.thought) return String(args.thought).slice(0, 110);
    const s = JSON.stringify(args);
    return s === '{}' ? '' : s.slice(0, 110);
}

function fmtMs(ms) {
    if (!ms && ms !== 0) return '';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}
