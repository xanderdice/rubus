/**
 * The plan.
 *
 * A plan is a data structure, never prose. That is the load-bearing decision in
 * this whole design: prose plans cannot be validated, cannot be displayed as
 * checkboxes, cannot be edited by the user before approval, and — the part that
 * actually matters — cannot be *re-fed* to the model on turn 14 as "here is the
 * one step you are doing right now". A weak model handed a paragraph will
 * reinterpret it slightly differently every turn. Handed step 3 of 6 with an
 * explicit success criterion, it stays put.
 *
 * The schema below is also given to Ollama as a structured-output constraint,
 * so on a good day the model cannot emit a malformed plan at all. `parsePlan`
 * exists for the other days.
 */

import { uid, nowIso } from './util.js';
import { parseLooseJson, extractJsonObjects, stripThinking } from './toolcall-parser.js';

export const STEP_STATUS = Object.freeze({
    PENDING: 'pending',
    RUNNING: 'running',
    DONE: 'done',
    FAILED: 'failed',
    SKIPPED: 'skipped'
});

export const MAX_STEPS = 12;

/** Structured-output schema handed to Ollama. Keep it flat: nested schemas make
 *  grammar-constrained sampling noticeably less reliable on small models. */
export const PLAN_SCHEMA = {
    type: 'object',
    properties: {
        goal: { type: 'string' },
        steps: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    title: { type: 'string' },
                    description: { type: 'string' },
                    files: { type: 'array', items: { type: 'string' } },
                    tools: { type: 'array', items: { type: 'string' } },
                    verify: { type: 'string' }
                },
                required: ['title', 'description', 'verify']
            }
        }
    },
    required: ['goal', 'steps']
};

export function createPlan(goal, steps = []) {
    return {
        id: uid('plan'),
        goal: String(goal || '').trim(),
        createdAt: nowIso(),
        revision: 1,
        steps: steps.map((s, i) => normalizeStep(s, i))
    };
}

function normalizeStep(raw, index) {
    const s = raw && typeof raw === 'object' ? raw : { title: String(raw || '') };
    return {
        id: index + 1,
        title: clean(s.title) || clean(s.name) || `Paso ${index + 1}`,
        description: clean(s.description) || clean(s.detail) || clean(s.title) || '',
        files: toStringArray(s.files || s.archivos || s.paths),
        tools: toStringArray(s.tools || s.herramientas),
        verify: clean(s.verify) || clean(s.verification) || clean(s.criterio) || '',
        status: STEP_STATUS.PENDING,
        attempts: 0,
        notes: [],
        summary: ''
    };
}

function clean(v) {
    return typeof v === 'string' ? v.trim() : '';
}

function toStringArray(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean).slice(0, 8);
    if (typeof v === 'string') return v.split(/[,\n]/).map(s => s.trim()).filter(Boolean).slice(0, 8);
    return [];
}

/**
 * Turn whatever the model produced into a plan.
 * Returns `{ok, plan, errors, repairs}` — errors are phrased to be pasted
 * straight back into a repair prompt.
 */
export function parsePlan(raw, { knownTools = [], goalFallback = '' } = {}) {
    const text = stripThinking(typeof raw === 'string' ? raw : JSON.stringify(raw));
    if (!text) return { ok: false, errors: ['La respuesta está vacía.'], repairs: [] };

    let parsed = parseLooseJson(text);
    const repairs = [...parsed.repairs];

    if (!parsed.ok) {
        // The plan object may be buried in prose the model could not resist.
        for (const candidate of extractJsonObjects(text)) {
            const attempt = parseLooseJson(candidate);
            if (attempt.ok && attempt.value && (attempt.value.steps || attempt.value.plan)) {
                parsed = attempt;
                repairs.push('objeto extraído de texto libre', ...attempt.repairs);
                break;
            }
        }
    }

    if (!parsed.ok) {
        return {
            ok: false,
            errors: ['La respuesta no es un objeto JSON válido. Devuelve SÓLO el objeto JSON del plan, sin texto alrededor y sin ```.'],
            repairs
        };
    }

    let obj = parsed.value;
    if (obj && obj.plan && typeof obj.plan === 'object') obj = obj.plan;

    const errors = [];
    let steps = obj.steps || obj.pasos || obj.tasks;

    if (!Array.isArray(steps)) {
        return { ok: false, errors: ['Falta el array "steps". El plan debe ser {"goal": "...", "steps": [ ... ]}.'], repairs };
    }

    steps = steps.filter(s => s && (typeof s === 'string' || typeof s === 'object'));
    if (!steps.length) errors.push('El array "steps" está vacío. Un plan necesita al menos un paso.');
    if (steps.length > MAX_STEPS) {
        errors.push(`El plan tiene ${steps.length} pasos; el máximo es ${MAX_STEPS}. Agrupa los pasos pequeños en pasos más grandes.`);
    }

    const plan = createPlan(clean(obj.goal) || clean(obj.objetivo) || goalFallback, steps.slice(0, MAX_STEPS));

    plan.steps.forEach((s, i) => {
        if (!s.description) errors.push(`El paso ${i + 1} ("${s.title}") no tiene "description".`);
        if (!s.verify) errors.push(`El paso ${i + 1} ("${s.title}") no tiene "verify": explica cómo se comprueba que quedó bien.`);

        if (knownTools.length) {
            const bad = s.tools.filter(t => !knownTools.includes(t));
            if (bad.length) {
                s.tools = s.tools.filter(t => knownTools.includes(t));
                repairs.push(`herramientas inexistentes eliminadas del paso ${i + 1}: ${bad.join(', ')}`);
            }
        }

        // Absolute paths in a plan are a sign the model has lost track of the
        // workspace root; strip them to relative so the sandbox does not
        // reject every step later.
        s.files = s.files.map(f => f.replace(/^[a-zA-Z]:[\\/]/, '').replace(/^[\\/]+/, '')).filter(Boolean);
    });

    if (!plan.goal) errors.push('Falta "goal": una frase con el objetivo global.');

    return { ok: errors.length === 0, plan, errors, repairs: [...new Set(repairs)] };
}

/** Compact rendering for prompts. */
export function planToText(plan, { current = null, includeDone = true } = {}) {
    if (!plan) return '(sin plan)';
    const mark = {
        [STEP_STATUS.PENDING]: '[ ]',
        [STEP_STATUS.RUNNING]: '[»]',
        [STEP_STATUS.DONE]: '[x]',
        [STEP_STATUS.FAILED]: '[!]',
        [STEP_STATUS.SKIPPED]: '[-]'
    };

    const rows = plan.steps
        .filter(s => includeDone || s.status !== STEP_STATUS.DONE)
        .map(s => {
            const head = `${mark[s.status]} ${s.id}. ${s.title}${s.id === current ? '   ← PASO ACTUAL' : ''}`;
            if (s.status === STEP_STATUS.DONE && s.summary) return `${head}\n      hecho: ${s.summary}`;
            return head;
        });

    return `OBJETIVO: ${plan.goal}\n\nPLAN:\n${rows.join('\n')}`;
}

/** Everything the model needs to execute exactly one step. */
export function stepToText(step) {
    const rows = [
        `PASO ${step.id}: ${step.title}`,
        '',
        `QUÉ HAY QUE HACER:`,
        step.description
    ];
    if (step.files.length) rows.push('', `ARCHIVOS PREVISTOS: ${step.files.join(', ')}`);
    if (step.tools.length) rows.push(`HERRAMIENTAS PREVISTAS: ${step.tools.join(', ')}`);
    rows.push('', `CRITERIO DE ÉXITO: ${step.verify}`);
    if (step.notes.length) {
        rows.push('', 'INTENTOS ANTERIORES DE ESTE PASO (no repitas los mismos errores):');
        for (const n of step.notes.slice(-3)) rows.push(`  - ${n}`);
    }
    return rows.join('\n');
}

export function currentStep(plan) {
    return plan?.steps.find(s => s.status === STEP_STATUS.PENDING || s.status === STEP_STATUS.RUNNING) || null;
}

export function remainingSteps(plan) {
    return plan?.steps.filter(s => s.status === STEP_STATUS.PENDING || s.status === STEP_STATUS.RUNNING) || [];
}

export function planProgress(plan) {
    if (!plan) return { done: 0, total: 0, failed: 0 };
    return {
        done: plan.steps.filter(s => s.status === STEP_STATUS.DONE).length,
        failed: plan.steps.filter(s => s.status === STEP_STATUS.FAILED).length,
        total: plan.steps.length
    };
}

/**
 * Splice a revised tail onto a plan.
 *
 * Completed steps are immutable — they describe work that exists on disk, and
 * letting a replan rewrite history is how an agent ends up redoing an edit it
 * already made. Only the pending tail is replaced.
 */
export function applyReplan(plan, newSteps, { reason = '' } = {}) {
    const done = plan.steps.filter(s => s.status === STEP_STATUS.DONE || s.status === STEP_STATUS.SKIPPED);
    const nextId = done.length;

    const tail = newSteps.slice(0, MAX_STEPS - done.length).map((s, i) => ({
        ...normalizeStep(s, nextId + i),
        id: nextId + i + 1
    }));

    return {
        ...plan,
        revision: plan.revision + 1,
        replanReason: reason,
        steps: [...done, ...tail]
    };
}
