/**
 * The plan panel.
 *
 * Editable before approval, read-only after. That is the point of the whole
 * plan-first design: the user gets to fix a bad step *before* it touches the
 * disk, which is far cheaper than reviewing a diff afterwards. Titles and
 * descriptions are contenteditable while the plan is a draft, and the edits are
 * read straight back out of the DOM when Approve is pressed.
 */

import { el, icon, clear, $ } from './dom.js';
import { STEP_STATUS } from '../core/plan.js';

const MARK = {
    [STEP_STATUS.PENDING]: '·',
    [STEP_STATUS.RUNNING]: '»',
    [STEP_STATUS.DONE]: '✓',
    [STEP_STATUS.FAILED]: '✗',
    [STEP_STATUS.SKIPPED]: '–'
};

export class PlanPanel {
    constructor({ onChange } = {}) {
        this.root = $('#side-plan');
        this.count = $('#plan-count');
        this.plan = null;
        this.editable = false;
        this.onChange = onChange || (() => {});
    }

    setPlan(plan, { editable = false } = {}) {
        this.plan = plan;
        this.editable = editable;
        this.render();
    }

    setEditable(editable) {
        this.editable = editable;
        this.render();
    }

    /** Read the user's edits back out of the DOM. */
    collect() {
        if (!this.plan) return null;
        const steps = this.plan.steps.map(step => {
            const node = this.root.querySelector(`[data-step="${step.id}"]`);
            if (!node) return step;
            const title = node.querySelector('.step-title')?.textContent.trim();
            const description = node.querySelector('.step-desc')?.textContent.trim();
            return {
                ...step,
                title: title || step.title,
                description: description || step.description
            };
        });
        return { ...this.plan, steps };
    }

    render() {
        clear(this.root);
        if (!this.plan) {
            this.count.textContent = '0';
            this.root.appendChild(el('div', { class: 'empty-msg' },
                'Todavía no hay plan. Describe una tarea y el agente propondrá uno.'));
            return;
        }

        const done = this.plan.steps.filter(s => s.status === STEP_STATUS.DONE).length;
        this.count.textContent = `${done}/${this.plan.steps.length}`;

        this.root.appendChild(el('div', { class: 'plan-goal' }, [
            el('b', {}, 'Objetivo'),
            document.createTextNode(this.plan.goal),
            this.plan.revision > 1
                ? el('div', { class: 'plan-revision' }, `revisión ${this.plan.revision}${this.plan.replanReason ? ` — ${this.plan.replanReason}` : ''}`)
                : null
        ]));

        for (const step of this.plan.steps) this.root.appendChild(this._renderStep(step));

        if (this.editable) {
            this.root.appendChild(el('div', { class: 'panel-foot' }, [
                el('button', {
                    class: 'btn btn--sm',
                    onclick: () => this._addStep()
                }, [icon('plus'), 'Añadir paso']),
                el('span', { class: 'dim' }, 'los textos son editables')
            ]));
        }
    }

    _renderStep(step) {
        const canEdit = this.editable && step.status === STEP_STATUS.PENDING;

        // The number is rendered outside the editable region on purpose: with
        // it inside, `collect()` would read "2. Título" back as the title and
        // the prefix would accumulate on every edit round trip.
        const title = el('div', {
            class: 'step-title',
            contentEditable: canEdit ? 'true' : 'false',
            spellcheck: false,
            oninput: () => this.onChange()
        }, step.title);

        const desc = el('div', {
            class: 'step-desc',
            contentEditable: canEdit ? 'true' : 'false',
            spellcheck: false,
            oninput: () => this.onChange()
        }, step.description);

        const meta = el('div', { class: 'step-meta' });
        if (step.files.length) {
            meta.appendChild(el('span', { class: 'k' }, 'archivos: '));
            for (const f of step.files) meta.appendChild(el('span', { class: 'file' }, f));
            meta.appendChild(el('br'));
        }
        if (step.tools.length) {
            meta.appendChild(el('span', { class: 'k' }, 'herramientas: '));
            meta.appendChild(document.createTextNode(step.tools.join(', ')));
            meta.appendChild(el('br'));
        }
        meta.appendChild(el('span', { class: 'k' }, 'verificación: '));
        meta.appendChild(document.createTextNode(step.verify || '—'));

        const node = el('div', {
            class: `step ${step.status}`,
            dataset: { step: String(step.id) }
        }, [
            el('div', { class: 'step-head' }, [
                el('span', { class: 'step-mark', title: step.status }, MARK[step.status] || '·'),
                el('span', { class: 'step-num' }, `${step.id}.`),
                title,
                canEdit ? el('div', { class: 'step-actions' }, [
                    el('button', {
                        class: 'ibtn', title: 'Eliminar paso',
                        onclick: () => this._removeStep(step.id)
                    }, [icon('trash', 'ico ico--sm')])
                ]) : null
            ]),
            desc,
            meta
        ]);

        if (step.summary && step.status === STEP_STATUS.DONE) {
            node.appendChild(el('div', { class: 'step-meta' }, [
                el('span', { class: 'k' }, 'hecho: '),
                document.createTextNode(step.summary)
            ]));
        }
        for (const note of step.notes.slice(-2)) {
            node.appendChild(el('div', { class: 'step-note' }, note));
        }

        return node;
    }

    _addStep() {
        const current = this.collect();
        const id = current.steps.length + 1;
        current.steps.push({
            id,
            title: 'Paso nuevo',
            description: 'Describe qué hay que hacer.',
            files: [], tools: [],
            verify: 'Cómo se comprueba que quedó bien.',
            status: STEP_STATUS.PENDING,
            attempts: 0, notes: [], summary: ''
        });
        this.plan = current;
        this.render();
        this.onChange();
    }

    _removeStep(id) {
        const current = this.collect();
        current.steps = current.steps
            .filter(s => s.id !== id)
            .map((s, i) => ({ ...s, id: i + 1 }));
        this.plan = current;
        this.render();
        this.onChange();
    }
}
