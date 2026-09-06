/**
 * El panel del estudio: la sección "Diseño".
 *
 * Sólo DOM. Toda la lógica está en `core/design/`, y este archivo no decide
 * nada sobre la composición — la pide, la enseña y enseña también lo que salió
 * mal, que es la mitad del trabajo. Un shader que no compila tiene que
 * VERSE: el log del driver en pantalla es lo que convierte "no funciona" en
 * "falta un punto en el 1.0 de la línea 3".
 */

import { $, el, clear, toast } from '../dom.js';
import { EV } from '../../core/bus.js';
import { DesignStudio, STUDIO_STATE } from '../../core/design/studio.js';
import { compositionToText } from '../../core/design/composition.js';
import { PlayCanvasRenderer, engineError } from './playcanvas-renderer.js';

const TAMANOS = [
    { label: 'Cuadrado 1024', w: 1024, h: 1024 },
    { label: 'Portada 1400', w: 1400, h: 1400 },
    { label: 'Banner 1600×900', w: 1600, h: 900 },
    { label: 'Historia 1080×1920', w: 1080, h: 1920 }
];

export class DesignPanel {
    constructor({ engine, bus }) {
        this.engine = engine;
        this.bus = bus;
        this.renderer = null;
        this.studio = null;
        this.tamano = TAMANOS[0];
        this.mounted = false;
    }

    /** Se monta la primera vez que se abre, no al arrancar la app. */
    async mount() {
        if (this.mounted || this.montando) return;
        // La bandera se pone al TERMINAR, no al empezar: `renderer.init()` puede
        // lanzar de verdad — PlayCanvas construye el dispositivo de forma
        // síncrona y tira "WebGL not supported" cuando getContext devuelve null
        // —, y marcándola antes el estudio quedaba "montado" con el panel vacío
        // y sin forma de reintentar al volver a abrirlo.
        this.montando = true;

        const host = $('#design-body');
        clear(host);

        this.canvas = el('canvas', { class: 'design-canvas', width: 1024, height: 1024 });
        this.estado = el('div', { class: 'design-status' }, 'Describe lo que quieres y pulsa Crear.');
        this.problemas = el('pre', { class: 'design-problems', hidden: true });

        host.append(
            el('div', { class: 'design-stage' }, [this.canvas]),
            this.estado,
            this.problemas
        );

        this.renderer = new PlayCanvasRenderer({ canvas: this.canvas, logger: this.engine.logger });
        const arrancado = await this.renderer.init();

        this.studio = new DesignStudio({
            ollama: this.engine.ollama,
            config: this.engine.config,
            bus: this.bus,
            logger: this.engine.logger,
            renderer: arrancado ? this.renderer : null
        });
        // El perfil decide cómo se le habla a este modelo concreto.
        this.studio.profile = this.engine.profile;
        this.bus.on(EV.MODEL, ({ profile }) => { if (this.studio) this.studio.profile = profile; });

        if (!arrancado) {
            this._sinMotor();
            this.mounted = true;
            this.montando = false;
            return;
        }

        // Algo en pantalla desde el primer momento: un lienzo negro no dice si
        // el motor arrancó o si la página está rota.
        await this.renderer.render(DesignStudio.starter());
        this._wire();
        this.mounted = true;
        this.montando = false;
    }

    /** El estudio se cierra: parar de pintar. */
    hide() {
        // Sin esto el bucle de rAF seguía renderizando a resolución completa —
        // con su getImageData por fotograma — con el panel oculto detrás del
        // chat, gastando GPU en una imagen que nadie está mirando.
        this.renderer?.stopAnimation();
        const btn = $('#design-animate');
        if (btn) btn.classList.remove('active');
    }

    _sinMotor() {
        this.estado.classList.add('bad');
        clear(this.estado);
        this.estado.append(
            el('b', {}, 'Falta el motor de render. '),
            el('span', {}, 'El estudio necesita PlayCanvas, que no viene en el repositorio porque son 3,5 MB. Tráelo con:'),
            el('code', { class: 'design-cmd' }, 'npm run setup:design'),
            el('span', { class: 'dim' }, engineError() ? `Detalle: ${engineError()}` : '')
        );
        // El modelo puede seguir componiendo aunque no se pueda pintar: se
        // enseña el JSON, que ya es útil para ver si entendió la petición.
        this._wire();
    }

    _wire() {
        $('#design-run').onclick = () => this._crear();
        $('#design-refine').onclick = () => this._refinar();
        $('#design-animate').onclick = () => this._animar();
        $('#design-export').onclick = () => this._exportar();
        $('#design-json').onclick = () => this._verJson();

        const input = $('#design-input');
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                this.studio?.composition ? this._refinar() : this._crear();
            }
        });

        const sel = $('#design-size');
        clear(sel);
        for (const t of TAMANOS) sel.append(el('option', { value: `${t.w}x${t.h}` }, t.label));
        sel.onchange = () => {
            const [w, h] = sel.value.split('x').map(Number);
            this.tamano = { w, h };
        };

        this.bus.on(EV.DESIGN_STATE, ({ to }) => this._estado(to));
        this.bus.on(EV.DESIGN_COMPOSITION, ({ repairs }) => {
            if (repairs?.length) this._problemas('Se corrigió al vuelo:\n  · ' + repairs.join('\n  · '), 'warn');
        });
    }

    _estado(to) {
        const texto = {
            [STUDIO_STATE.COMPOSING]: 'Componiendo…',
            [STUDIO_STATE.RENDERING]: 'Renderizando…',
            [STUDIO_STATE.VERIFYING]: 'Comprobando que se vea algo…',
            [STUDIO_STATE.REPAIRING]: 'No cuadró: pidiendo una corrección…',
            [STUDIO_STATE.READY]: 'Listo.',
            [STUDIO_STATE.ERROR]: 'No se pudo.',
            [STUDIO_STATE.IDLE]: ''
        }[to];
        if (texto !== undefined) this._decir(texto, to === STUDIO_STATE.ERROR ? 'bad' : '');
        $('#design-run').disabled = ![STUDIO_STATE.IDLE, STUDIO_STATE.READY, STUDIO_STATE.ERROR].includes(to);
    }

    _decir(texto, clase = '') {
        this.estado.className = `design-status ${clase}`;
        this.estado.textContent = texto;
    }

    _problemas(texto, clase = '') {
        this.problemas.hidden = !texto;
        this.problemas.className = `design-problems ${clase}`;
        this.problemas.textContent = texto || '';
    }

    async _crear() {
        const brief = $('#design-input').value.trim();
        if (!brief) { toast('Describe qué quieres que dibuje.'); return; }
        this._problemas('');
        try {
            const r = await this.studio.create(brief, { width: this.tamano.w, height: this.tamano.h });
            this._resultado(r);
        } catch (err) { this._decir(err.message, 'bad'); }
    }

    async _refinar() {
        const texto = $('#design-input').value.trim();
        if (!texto) { toast('Di qué quieres cambiar.'); return; }
        this._problemas('');
        try {
            const r = await this.studio.refine(texto);
            this._resultado(r);
        } catch (err) { this._decir(err.message, 'bad'); }
    }

    _resultado(r) {
        if (!r || r.cancelled) return;
        if (!r.ok) {
            this._decir(r.error || 'No se pudo componer.', 'bad');
            if (r.composition) this._problemas(compositionToText(r.composition), 'warn');
            return;
        }
        if (!r.rendered) {
            this._decir(`Composición lista, pero sin render (${r.reason}).`, 'warn');
            this._problemas(compositionToText(r.composition), 'warn');
            return;
        }
        const cobertura = (r.stats?.coverage * 100 || 0).toFixed(1);
        this._decir(`Listo — ${r.composition.layers.length} capas, ${cobertura}% del lienzo con contenido.`);
        $('#design-input').value = '';
        $('#design-input').placeholder = 'Ahora pide un cambio: "más oscuro", "quita el aro", "añade grano"…';
    }

    _animar() {
        if (!this.renderer?.ready()) return;
        const btn = $('#design-animate');
        if (this.renderer.animating) {
            this.renderer.stopAnimation();
            btn.classList.remove('active');
        } else {
            this.renderer.startAnimation();
            btn.classList.add('active');
        }
    }

    _exportar() {
        if (!this.renderer?.ready()) { toast('No hay nada renderizado.'); return; }
        // La animación se para antes: exportar un fotograma a medio dibujar es
        // la clase de fallo que sólo se ve al abrir el PNG.
        const animaba = this.renderer.animating;
        this.renderer.stopAnimation();

        const nombre = (this.studio.composition?.name || 'rubus').replace(/[^\w-]+/g, '-').toLowerCase();
        const a = el('a', { href: this.renderer.snapshot(), download: `${nombre}.png` });
        document.body.append(a);
        a.click();
        a.remove();
        toast(`Exportado ${nombre}.png`);

        if (animaba) this.renderer.startAnimation();
    }

    _verJson() {
        const comp = this.studio?.composition;
        if (!comp) { toast('Todavía no hay composición.'); return; }
        this._problemas(JSON.stringify(comp, null, 2));
    }
}
