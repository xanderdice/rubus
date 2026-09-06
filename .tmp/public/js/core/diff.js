/**
 * Line diff — for the diff viewer, for the timeline summary, and for the short
 * "what changed" line the model sees after every write.
 *
 * That last consumer is why this exists instead of just showing the new file:
 * handing a weak model the whole file back after each edit both burns context
 * and invites it to "helpfully" rewrite untouched regions. A diff says exactly
 * what happened and nothing else.
 *
 * Plain LCS is quadratic, so the common prefix and suffix are trimmed first
 * (which is nearly all of a typical edit) and the remaining window is capped.
 * Past the cap the change is reported as one replaced block — still correct,
 * just less pretty, and nothing downstream depends on minimality.
 */

import { lines } from './util.js';

const LCS_CELL_CAP = 4_000_000; // ~2000x2000 lines

export function diffLines(before, after) {
    const a = lines(before ?? '');
    const b = lines(after ?? '');

    // A trailing newline produces a final empty element in both arrays; keeping
    // it would report a phantom change on files that only differ elsewhere.
    if (a.length && a[a.length - 1] === '' && b.length && b[b.length - 1] === '') {
        a.pop(); b.pop();
    }

    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;

    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

    const midA = a.slice(start, endA);
    const midB = b.slice(start, endB);

    const ops = [];
    for (let i = 0; i < start; i++) ops.push({ type: 'ctx', text: a[i], oldNo: i + 1, newNo: i + 1 });

    if (midA.length * midB.length > LCS_CELL_CAP) {
        midA.forEach((t, i) => ops.push({ type: 'del', text: t, oldNo: start + i + 1, newNo: null }));
        midB.forEach((t, i) => ops.push({ type: 'add', text: t, oldNo: null, newNo: start + i + 1 }));
    } else {
        let oldNo = start + 1;
        let newNo = start + 1;
        for (const op of lcsDiff(midA, midB)) {
            if (op.type === 'ctx') ops.push({ ...op, oldNo: oldNo++, newNo: newNo++ });
            else if (op.type === 'del') ops.push({ ...op, oldNo: oldNo++, newNo: null });
            else ops.push({ ...op, oldNo: null, newNo: newNo++ });
        }
    }

    for (let i = 0; i < a.length - endA; i++) {
        ops.push({ type: 'ctx', text: a[endA + i], oldNo: endA + i + 1, newNo: endB + i + 1 });
    }

    const added = ops.filter(o => o.type === 'add').length;
    const removed = ops.filter(o => o.type === 'del').length;
    return { ops, stats: { added, removed, changed: added + removed } };
}

function lcsDiff(a, b) {
    const n = a.length;
    const m = b.length;
    if (!n) return b.map(text => ({ type: 'add', text }));
    if (!m) return a.map(text => ({ type: 'del', text }));

    // dp[i][j] = length of the LCS of a[i:] and b[j:]
    const dp = new Uint32Array((n + 1) * (m + 1));
    const w = m + 1;
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i * w + j] = a[i] === b[j]
                ? dp[(i + 1) * w + (j + 1)] + 1
                : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
        }
    }

    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { out.push({ type: 'ctx', text: a[i] }); i++; j++; }
        else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) { out.push({ type: 'del', text: a[i] }); i++; }
        else { out.push({ type: 'add', text: b[j] }); j++; }
    }
    while (i < n) out.push({ type: 'del', text: a[i++] });
    while (j < m) out.push({ type: 'add', text: b[j++] });
    return out;
}

/** Group ops into hunks with `context` unchanged lines around each change. */
export function toHunks(ops, context = 3) {
    const interesting = [];
    ops.forEach((op, i) => { if (op.type !== 'ctx') interesting.push(i); });
    if (!interesting.length) return [];

    const ranges = [];
    let lo = Math.max(0, interesting[0] - context);
    let hi = Math.min(ops.length - 1, interesting[0] + context);
    for (const idx of interesting.slice(1)) {
        if (idx - context <= hi + 1) {
            hi = Math.min(ops.length - 1, idx + context);
        } else {
            ranges.push([lo, hi]);
            lo = Math.max(0, idx - context);
            hi = Math.min(ops.length - 1, idx + context);
        }
    }
    ranges.push([lo, hi]);

    return ranges.map(([from, to]) => {
        const slice = ops.slice(from, to + 1);
        const firstOld = slice.find(o => o.oldNo !== null);
        const firstNew = slice.find(o => o.newNo !== null);
        return {
            oldStart: firstOld ? firstOld.oldNo : 0,
            oldLines: slice.filter(o => o.type !== 'add').length,
            newStart: firstNew ? firstNew.newNo : 0,
            newLines: slice.filter(o => o.type !== 'del').length,
            ops: slice
        };
    });
}

const SIGIL = { ctx: ' ', add: '+', del: '-' };

export function toUnified(path, before, after, { context = 3 } = {}) {
    const { ops, stats } = diffLines(before, after);
    if (!stats.changed) return { text: '', stats };

    const hunks = toHunks(ops, context);
    const head = `--- a/${path}\n+++ b/${path}`;
    const body = hunks.map(h =>
        `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n` +
        h.ops.map(o => SIGIL[o.type] + o.text).join('\n')
    ).join('\n');

    return { text: `${head}\n${body}`, stats, hunks };
}

/**
 * A diff small enough to hand back to the model after an edit. Long runs of
 * added lines are elided: the model wrote them, it does not need them read back.
 */
export function summarizeForModel(path, before, after, { maxLines = 60 } = {}) {
    const { ops, stats } = diffLines(before, after);
    if (!stats.changed) return { text: `Sin cambios en ${path}.`, stats };

    const hunks = toHunks(ops, 2);
    const out = [`${path}: +${stats.added} / -${stats.removed}`];
    let budget = maxLines;

    for (const h of hunks) {
        if (budget <= 0) { out.push('… (más cambios omitidos)'); break; }
        out.push(`@@ línea ${h.newStart} @@`);
        for (const op of h.ops) {
            if (budget-- <= 0) { out.push('…'); break; }
            out.push(SIGIL[op.type] + op.text);
        }
    }
    return { text: out.join('\n'), stats };
}
