/**
 * Settings, generated from a schema.
 *
 * Every control carries a one-line explanation of what it costs you, because
 * most of these are safety/quality trade-offs rather than preferences — turning
 * off "confirmar comandos peligrosos" is not the same kind of choice as picking
 * a theme, and the UI should not present them as if it were.
 */

import { el, clear, $, toast } from './dom.js';
import { DEFAULTS } from '../core/config.js';

const SECTIONS = [
    {
        id: 'model', label: 'Modelo',
        rows: [
            { key: 'ollama.host', type: 'text', label: 'Host de Ollama', help: 'Normalmente http://127.0.0.1:11434', proxyNote: true },
            {
                key: 'ollama.temperature', type: 'range', min: 0, max: 1, step: 0.05, label: 'Temperatura',
                help: 'Con modelos débiles, por encima de 0.3 empiezan a inventar APIs. Recomendado 0.1–0.2.'
            },
            { key: 'ollama.topP', type: 'range', min: 0.1, max: 1, step: 0.05, label: 'top_p' },
            { key: 'ollama.repeatPenalty', type: 'range', min: 1, max: 1.4, step: 0.01, label: 'Penalización de repetición' },
            {
                key: 'ollama.numCtx', type: 'number', min: 4096, max: 262144, step: 4096, label: 'Ventana de contexto',
                help: 'Se recorta automáticamente al máximo real del modelo. Más contexto = más RAM/VRAM.'
            },
            { key: 'ollama.numPredict', type: 'number', min: 256, max: 16384, step: 256, label: 'Tokens máx. de respuesta' },
            { key: 'ollama.keepAlive', type: 'text', label: 'keep_alive', help: 'Cuánto se queda el modelo cargado en memoria tras el último uso.' },
            { key: 'ollama.retries', type: 'number', min: 0, max: 6, step: 1, label: 'Reintentos de red' }
        ]
    },
    {
        id: 'agent', label: 'Agente',
        rows: [
            {
                key: 'agent.autoApprovePlan', type: 'bool', label: 'Aprobar el plan automáticamente',
                help: 'Desactivado, tú revisas cada plan antes de que se toque un archivo. Es la principal protección del sistema.'
            },
            {
                key: 'agent.autoRunSteps', type: 'bool', label: 'Encadenar los pasos sin parar',
                help: 'Con esto desactivado ejecutas paso a paso y puedes revisar entre uno y otro.'
            },
            {
                key: 'agent.autoApproveSafeTools', type: 'bool', label: 'Ejecutar comandos seguros sin preguntar',
                help: 'Sólo afecta a comandos de sólo lectura (git status, ls, node --version…).'
            },
            { key: 'agent.maxStepAttempts', type: 'number', min: 1, max: 6, step: 1, label: 'Intentos por paso', help: 'Al agotarse, se replanifica en vez de insistir.' },
            { key: 'agent.maxTurnsPerStep', type: 'number', min: 4, max: 40, step: 1, label: 'Turnos máx. por paso' },
            { key: 'agent.maxToolRepairs', type: 'number', min: 1, max: 6, step: 1, label: 'Correcciones de formato', help: 'Cuántas veces se le pide al modelo que rehaga una llamada mal formada.' },
            { key: 'agent.maxReplans', type: 'number', min: 0, max: 8, step: 1, label: 'Replanificaciones máx.' },
            { key: 'agent.thinkInPlan', type: 'bool', label: 'Pensar al planificar', help: 'Sólo en modelos con modo thinking. Mejora el plan y lo hace más lento.' },
            { key: 'agent.thinkInAct', type: 'bool', label: 'Pensar al ejecutar', help: 'Suele no compensar: alarga cada turno sin mejorar las ediciones.' },
            { key: 'agent.autoVerify', type: 'bool', label: 'Verificar tras cada cambio', help: 'Balance de delimitadores, node --check, py_compile. Déjalo activado.' },
            {
                key: 'agent.verifyCommand', type: 'text', label: 'Comando de verificación',
                help: 'Se ejecuta al terminar cada paso. Por ejemplo "npm test". Vacío = sólo verificación estructural.'
            }
        ]
    },
    {
        id: 'context', label: 'Contexto',
        rows: [
            { key: 'context.budgetRatio', type: 'range', min: 0.4, max: 0.9, step: 0.02, label: 'Uso máximo del contexto', help: 'Fracción de la ventana que se llena antes de comprimir el historial.' },
            { key: 'context.repoMapMaxTokens', type: 'number', min: 500, max: 12000, step: 100, label: 'Tokens del mapa del proyecto' },
            { key: 'context.fileMaxTokens', type: 'number', min: 500, max: 16000, step: 100, label: 'Tokens por archivo fijado' },
            { key: 'context.toolResultMaxChars', type: 'number', min: 1000, max: 30000, step: 500, label: 'Caracteres por resultado de tool' },
            { key: 'context.historyKeepTurns', type: 'number', min: 2, max: 30, step: 1, label: 'Turnos que se conservan sin comprimir' },
            { key: 'context.maxPinnedFiles', type: 'number', min: 1, max: 20, step: 1, label: 'Archivos fijados máx.' }
        ]
    },
    {
        id: 'security', label: 'Seguridad',
        rows: [
            { key: 'security.allowShell', type: 'bool', label: 'Permitir ejecutar comandos', help: 'Si lo desactivas, el agente no puede compilar ni correr tests.' },
            { key: 'security.confirmDangerous', type: 'bool', label: 'Confirmar comandos con efectos', help: 'Los destructivos (rm, git push, curl…) siempre preguntan, aunque desactives esto.' },
            {
                key: 'security.allowOutsideRoot', type: 'bool', label: 'Permitir salir de la carpeta de trabajo',
                help: 'PELIGROSO. Con esto activado el agente puede leer y escribir en cualquier parte del disco.'
            },
            { key: 'security.extraSafeCommands', type: 'list', label: 'Comandos seguros adicionales', help: 'Uno por línea. Se ejecutarán sin preguntar.' },
            { key: 'security.extraBlockedCommands', type: 'list', label: 'Comandos prohibidos', help: 'Uno por línea. Nunca se ejecutarán.' }
        ]
    },
    {
        id: 'ui', label: 'Interfaz',
        rows: [
            { key: 'ui.showThinking', type: 'bool', label: 'Mostrar el razonamiento del modelo' },
            {
                key: 'ui.sound', type: 'bool', label: 'Sonido',
                help: 'Bucle mientras piensa y mientras escribe; pitidos al actuar y al confirmar, avisos al cancelar y al fallar. Con esto apagado no se descarga ni un byte de audio.'
            },
            { key: 'ui.soundVolume', type: 'range', min: 0, max: 1, step: 0.05, label: 'Volumen de los sonidos' },

            {
                key: 'ui.speech', type: 'bool', label: 'Voz',
                help: 'Lee en voz alta el plan, los permisos, el resultado de cada paso y el informe final. Apágala si ya usas un lector de pantalla: dos voces a la vez es peor que una.'
            },
            {
                key: 'ui.speechVerbosity', type: 'select', options: ['off', 'key', 'all'], label: 'Cuánto narra',
                help: 'off: nada · key: plan, permisos, pasos, errores e informe · all: además cada herramienta que usa.'
            },
            { key: 'ui.speechVoice', type: 'voice', label: 'Voz del sistema', help: 'Las voces las aporta el sistema operativo. En Windows se añaden desde Configuración ▸ Hora e idioma ▸ Voz.' },
            { key: 'ui.speechRate', type: 'range', min: 0.5, max: 2, step: 0.05, label: 'Velocidad' },
            { key: 'ui.speechPitch', type: 'range', min: 0, max: 2, step: 0.1, label: 'Tono' },
            { key: 'ui.speechVolume', type: 'range', min: 0, max: 1, step: 0.05, label: 'Volumen de la voz' },
            { key: '__speechTest', type: 'action', label: 'Probar la voz', action: 'speechTest', buttonText: 'Escuchar' },
            { key: 'ui.bloom', type: 'select', options: ['off', 'soft', 'on'], label: 'Bloom' },
            { key: 'ui.scanlines', type: 'bool', label: 'Líneas de barrido' }
        ]
    }
];

export class Settings {
    constructor({ engine, onApply, speech = null, onAction = null }) {
        this.engine = engine;
        this.onApply = onApply || (() => {});
        this.speech = speech;
        this.onAction = onAction;
        this.nav = $('#prefs-nav');
        this.body = $('#prefs-body');
        this.section = 'model';

        $('#prefs-reset').addEventListener('click', async () => {
            await this.engine.config.reset();
            this.render();
            this.onApply();
            toast('Ajustes restaurados.');
        });
    }

    render() {
        clear(this.nav);
        for (const s of SECTIONS) {
            this.nav.appendChild(el('div', {
                class: `nav-item ${s.id === this.section ? 'active' : ''}`,
                onclick: () => { this.section = s.id; this.render(); }
            }, s.label));
        }
        this.nav.appendChild(el('div', {
            class: `nav-item ${this.section === 'project' ? 'active' : ''}`,
            onclick: () => { this.section = 'project'; this.render(); }
        }, 'Proyecto'));

        clear(this.body);
        if (this.section === 'project') { this._renderProject(); return; }

        const section = SECTIONS.find(s => s.id === this.section);
        const group = el('div', { class: 'prefs-group' }, [el('h3', {}, section.label)]);
        for (const row of section.rows) group.appendChild(this._row(row));
        this.body.appendChild(group);
    }

    _row(row) {
        const cfg = this.engine.config;
        const value = cfg.get(row.key, dig(DEFAULTS, row.key));
        const valueLabel = el('span', { class: 'val' });

        // Served over HTTP, Ollama is reached through the server, so this
        // setting belongs to whoever launched it — editing it here would do
        // nothing and quietly mislead.
        if (row.proxyNote && this.engine.ollamaProxied) {
            return el('div', { class: 'row' }, [
                el('label', {}, ['Host de Ollama', el('small', {},
                    'Lo decide el servidor (server.js --ollama …). Desde el navegador se accede a través de él.')]),
                el('input', { type: 'text', value: String(value ?? ''), disabled: true }),
                el('span', { class: 'val' }, 'proxy')
            ]);
        }

        const commit = async (v) => {
            cfg.set(row.key, v);
            await cfg.save();
            this.onApply();
        };

        let control;
        switch (row.type) {
            case 'bool':
                control = el('input', {
                    type: 'checkbox', checked: !!value,
                    onchange: (e) => commit(e.target.checked)
                });
                break;

            case 'range':
                control = el('input', {
                    type: 'range', min: row.min, max: row.max, step: row.step, value: String(value),
                    oninput: (e) => { valueLabel.textContent = e.target.value; },
                    onchange: (e) => commit(Number(e.target.value))
                });
                valueLabel.textContent = String(value);
                break;

            case 'number':
                control = el('input', {
                    type: 'number', min: row.min, max: row.max, step: row.step, value: String(value),
                    onchange: (e) => commit(clampNum(Number(e.target.value), row))
                });
                break;

            case 'select':
                control = el('select', { onchange: (e) => commit(e.target.value) },
                    row.options.map(o => el('option', { value: o, selected: o === value }, o)));
                break;

            case 'list':
                control = el('textarea', {
                    rows: 3, spellcheck: false,
                    value: (value || []).join('\n'),
                    onchange: (e) => commit(e.target.value.split('\n').map(s => s.trim()).filter(Boolean))
                });
                break;

            case 'voice': {
                // Voices come from the OS and arrive asynchronously; an empty
                // list here means the browser has not published them yet, not
                // that there are none.
                const speech = this.speech;
                const voices = speech ? speech.listVoices() : [];
                control = el('select', { onchange: (e) => commit(e.target.value) }, [
                    el('option', { value: '', selected: !value }, voices.length
                        ? 'automática (primera en español)'
                        : 'no hay voces instaladas'),
                    ...voices.map(v => el('option', {
                        value: v.name,
                        selected: v.name === value
                    }, `${v.name} — ${v.lang}${v.localService ? '' : ' (en la nube)'}`))
                ]);
                valueLabel.textContent = `${voices.length} voces`;
                break;
            }

            case 'action':
                control = el('button', {
                    class: 'btn',
                    onclick: () => this.onAction && this.onAction(row.action)
                }, row.buttonText || 'Ejecutar');
                break;

            default:
                control = el('input', {
                    type: 'text', value: String(value ?? ''),
                    onchange: (e) => commit(e.target.value)
                });
        }

        return el('div', { class: 'row' }, [
            el('label', {}, [row.label, row.help ? el('small', {}, row.help) : null]),
            control,
            valueLabel
        ]);
    }

    _renderProject() {
        const rules = this.engine.projectRules.cache;
        const root = this.engine.config.get('workspace.root', '');

        const group = el('div', { class: 'prefs-group' }, [
            el('h3', {}, 'Reglas del proyecto'),
            el('p', { class: 'dim', style: { lineHeight: '1.7', marginBottom: '10px' } },
                'Un archivo del repositorio que se inyecta en TODOS los prompts y nunca se comprime. ' +
                'Es el sitio para poner los comandos de build/test, las convenciones y las prohibiciones. ' +
                'Se busca en: .rubus/rules.md, AGENTS.md, AGENT.md, CLAUDE.md, .cursorrules.')
        ]);

        if (!root) {
            group.appendChild(el('div', { class: 'empty-msg' }, 'Selecciona primero una carpeta de trabajo.'));
        } else if (rules && rules.sources.length) {
            group.appendChild(el('div', { class: 'row' }, [
                el('label', {}, ['Archivo activo', el('small', {}, `${rules.tokens} tokens en cada prompt`)]),
                el('span', {}, rules.sources.join(', ')),
                el('span', {})
            ]));
            group.appendChild(el('pre', {
                style: { marginTop: '10px', maxHeight: '300px', overflow: 'auto', padding: '9px', border: '1px solid var(--line)', background: 'rgba(0,0,0,.3)', whiteSpace: 'pre-wrap' }
            }, rules.text));
        } else {
            group.appendChild(el('div', { class: 'row' }, [
                el('label', {}, ['Sin archivo de reglas', el('small', {}, 'El agente trabaja sólo con lo que deduce del código.')]),
                el('button', {
                    class: 'btn',
                    onclick: async () => {
                        try {
                            const r = await this.engine.projectRules.createTemplate();
                            toast(r.created ? `Creado ${r.path}` : 'Ya existía AGENTS.md');
                            await this.engine.projectRules.load({ force: true });
                            this.render();
                        } catch (err) { toast(err.message, 'bad'); }
                    }
                }, 'Crear AGENTS.md'),
                el('span', {})
            ]));
        }

        this.body.appendChild(group);

        const map = this.engine.repoMap.cache;
        if (map) {
            this.body.appendChild(el('div', { class: 'prefs-group' }, [
                el('h3', {}, 'Mapa del proyecto'),
                el('div', { class: 'row' }, [
                    el('label', {}, ['Tamaño', el('small', {}, 'Lo que ve el modelo al empezar cada fase')]),
                    el('span', {}, `${map.fileCount} archivos · ${map.tokens} tokens · ${map.buildMs}ms`),
                    el('span', {})
                ]),
                el('pre', {
                    style: { marginTop: '10px', maxHeight: '340px', overflow: 'auto', padding: '9px', border: '1px solid var(--line)', background: 'rgba(0,0,0,.3)', whiteSpace: 'pre-wrap', fontSize: '11px' }
                }, map.text)
            ]));
        }
    }
}

function dig(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function clampNum(n, row) {
    if (!Number.isFinite(n)) return row.min ?? 0;
    if (row.min !== undefined) n = Math.max(row.min, n);
    if (row.max !== undefined) n = Math.min(row.max, n);
    return n;
}
