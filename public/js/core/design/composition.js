/**
 * La composición: qué hay que dibujar, como estructura de datos.
 *
 * Misma decisión que en `plan.js`, y por los mismos motivos. Un modelo pequeño
 * no puede dibujar, pero sí puede rellenar campos; y una composición que es
 * JSON se puede validar, enseñar en un panel, editar a mano antes de renderizar
 * y — lo que de verdad importa — volver a darle al modelo en el turno siguiente
 * diciéndole «esto es lo que hay ahora, cambia sólo el color del texto».
 * Pedirle en cambio "el código que dibuja el logo" es pedirle que reinvente
 * todo el cuadro en cada iteración, y cada iteración pierde algo.
 *
 * ── Las coordenadas van de 0 a 1 ──────────────────────────────────────────
 *
 * Y no es una preferencia estética. Con píxeles, el modelo tiene que recordar
 * el tamaño del lienzo mientras coloca cada capa, y a los tres o cuatro
 * elementos empieza a sacar cosas fuera del cuadro. Con 0..1, "centrado" es
 * 0.5 y no hay nada que recordar. El renderer multiplica.
 *
 * ── Todo se repara antes de rechazarse ────────────────────────────────────
 *
 * `#fff`, `rgb(20,20,20)`, "rojo", un tamaño en píxeles cuando tocaba fracción,
 * una capa sin `type` que claramente es texto porque trae `text`. Nada de eso
 * merece un viaje de ida y vuelta al modelo: se arregla aquí y se anota, igual
 * que hace el parser de tool calls con las comillas simples.
 */

import { parseLooseJson, extractJsonObjects, stripThinking } from '../toolcall-parser.js';
import { validateShaderBody } from './glsl.js';

export const MAX_LAYERS = 14;
export const MIN_SIZE = 64;
export const MAX_SIZE = 4096;

export const LAYER_TYPES = Object.freeze(['text', 'shape', 'shader', 'gradient']);
export const SHAPES = Object.freeze(['circle', 'ring', 'rect', 'roundrect', 'triangle', 'hexagon', 'star', 'line']);
export const BLENDS = Object.freeze(['normal', 'add', 'multiply', 'screen']);
export const ALIGNS = Object.freeze(['left', 'center', 'right']);
export const EFFECTS = Object.freeze(['bloom', 'vignette', 'grain', 'chromatic', 'scanlines', 'blur', 'pixelate']);

/**
 * El esquema que se le pasa a Ollama como `format`.
 *
 * Plano a propósito, igual que PLAN_SCHEMA: el muestreo con gramática se
 * vuelve bastante menos fiable en modelos pequeños cuanto más se anida. Por eso
 * las capas son todas del mismo tipo de objeto, con campos opcionales, en vez
 * de una unión por `type` — que sería más correcto y funcionaría peor.
 */
export const COMPOSITION_SCHEMA = {
    type: 'object',
    properties: {
        name: { type: 'string' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        background: { type: 'string' },
        palette: { type: 'array', items: { type: 'string' } },
        layers: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    type: { type: 'string' },
                    text: { type: 'string' },
                    shape: { type: 'string' },
                    glsl: { type: 'string' },
                    color: { type: 'string' },
                    color2: { type: 'string' },
                    x: { type: 'number' },
                    y: { type: 'number' },
                    width: { type: 'number' },
                    height: { type: 'number' },
                    rotation: { type: 'number' },
                    opacity: { type: 'number' },
                    blend: { type: 'string' },
                    font: { type: 'string' },
                    size: { type: 'number' },
                    weight: { type: 'string' },
                    letterSpacing: { type: 'number' },
                    align: { type: 'string' },
                    angle: { type: 'number' },
                    thickness: { type: 'number' }
                },
                required: ['type']
            }
        },
        post: {
            type: 'array',
            items: {
                type: 'object',
                properties: { effect: { type: 'string' }, amount: { type: 'number' } },
                required: ['effect']
            }
        }
    },
    required: ['name', 'width', 'height', 'layers']
};

/** Colores con nombre que un modelo en español escribe sin pensarlo. */
const NAMED = {
    negro: '#000000', blanco: '#ffffff', rojo: '#e5484d', verde: '#30a46c',
    azul: '#0090ff', amarillo: '#ffe629', naranja: '#f76b15', morado: '#8e4ec6',
    violeta: '#8e4ec6', rosa: '#e93d82', gris: '#8b8d98', cian: '#00c2d7',
    dorado: '#ffc53d', plata: '#c1c8cd', turquesa: '#12a594', lima: '#99d52a',
    black: '#000000', white: '#ffffff', red: '#e5484d', green: '#30a46c',
    blue: '#0090ff', yellow: '#ffe629', orange: '#f76b15', purple: '#8e4ec6',
    pink: '#e93d82', gray: '#8b8d98', grey: '#8b8d98', cyan: '#00c2d7', gold: '#ffc53d'
};

/**
 * Cualquier cosa que el modelo llame color, convertida a #rrggbb.
 * Devuelve null si de verdad no se parece a un color.
 */
export function normalizeColor(input, fallback = null) {
    const raw = String(input ?? '').trim().toLowerCase();
    if (!raw) return fallback;

    // Object.hasOwn y no `NAMED[raw]`: con el acceso directo,
    // normalizeColor('constructor') devolvía la función Object y
    // normalizeColor('__proto__') el prototipo, que luego reventaban
    // colorToVec3 con NaN en el vec3.
    if (Object.hasOwn(NAMED, raw)) return NAMED[raw];

    const hex = raw.replace(/^#/, '');
    if (/^[0-9a-f]{3}$/.test(hex)) return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
    if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex}`;
    // 8 dígitos: se descarta el alfa, que en esta capa se expresa con `opacity`.
    if (/^[0-9a-f]{8}$/.test(hex)) return `#${hex.slice(0, 6)}`;

    const rgb = raw.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
    if (rgb) {
        const c = rgb.slice(1, 4).map(v => clamp255(Number(v)));
        return `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`;
    }

    return fallback;
}

function clamp255(n) {
    return Math.max(0, Math.min(255, Math.round(Number.isFinite(n) ? n : 0)));
}

/** Convierte #rrggbb a [0..1, 0..1, 0..1], que es lo que come la GPU. */
export function colorToVec3(hex) {
    const h = (normalizeColor(hex, '#000000') || '#000000').slice(1);
    return [
        parseInt(h.slice(0, 2), 16) / 255,
        parseInt(h.slice(2, 4), 16) / 255,
        parseInt(h.slice(4, 6), 16) / 255
    ];
}

function num(v, fallback, { min = -Infinity, max = Infinity } = {}) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

/**
 * Una fracción del lienzo. Acepta también píxeles: si el modelo dice 512 en un
 * lienzo de 1024, quiere decir la mitad, y discutírselo cuesta un turno.
 */
function fraction(v, fallback, extent) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    if (n > 1.5 && extent > 0) return Math.max(0, Math.min(1, n / extent));
    return Math.max(-1, Math.min(2, n));
}

function pick(value, allowed, fallback) {
    const v = String(value ?? '').trim().toLowerCase();
    return allowed.includes(v) ? v : fallback;
}

/**
 * Deduce el tipo cuando falta o es inventado, a partir de lo que trae la capa.
 * Un objeto con `text` es una capa de texto por mucho que diga `type: "titulo"`.
 */
function inferType(raw) {
    const declarado = pick(raw.type, LAYER_TYPES, null);
    if (declarado) return { type: declarado, repaired: null };

    if (typeof raw.glsl === 'string' && raw.glsl.trim()) return { type: 'shader', repaired: 'shader (traía glsl)' };
    if (typeof raw.text === 'string' && raw.text.trim()) return { type: 'text', repaired: 'text (traía text)' };
    if (raw.shape) return { type: 'shape', repaired: 'shape (traía shape)' };
    if (raw.color2 || raw.angle !== undefined) return { type: 'gradient', repaired: 'gradient (traía color2)' };
    return { type: 'shape', repaired: 'shape (no se pudo deducir)' };
}

function normalizeLayer(raw, index, comp, repairs, errors) {
    const src = raw && typeof raw === 'object' ? raw : { text: String(raw ?? '') };
    const { type, repaired } = inferType(src);
    if (repaired) repairs.push(`capa ${index + 1}: tipo deducido como ${repaired}`);

    const layer = {
        id: index + 1,
        type,
        x: fraction(src.x, 0.5, comp.width),
        y: fraction(src.y, 0.5, comp.height),
        rotation: num(src.rotation, 0, { min: -360, max: 360 }),
        opacity: num(src.opacity, 1, { min: 0, max: 1 }),
        blend: pick(src.blend, BLENDS, 'normal'),
        color: normalizeColor(src.color, '#ffffff')
    };

    if (type === 'text') {
        layer.text = String(src.text ?? '').slice(0, 200);
        if (!layer.text.trim()) errors.push(`La capa ${index + 1} es de texto pero no trae texto.`);
        layer.font = String(src.font || 'sans').trim().slice(0, 60);
        layer.size = fraction(src.size, 0.12, comp.height);
        layer.weight = pick(src.weight, ['normal', 'bold', 'black'], 'bold');
        layer.letterSpacing = num(src.letterSpacing, 0, { min: -0.5, max: 1 });
        layer.align = pick(src.align, ALIGNS, 'center');
    }

    if (type === 'shape') {
        layer.shape = pick(src.shape, SHAPES, 'circle');
        // Sólo se avisa de lo que el modelo escribió MAL, no de lo que no
        // escribió: el aviso se le enseña al usuario tal cual, y "forma
        // 'undefined' no existe" es ruido, no información.
        const pedida = String(src.shape ?? '').trim().toLowerCase();
        if (pedida && !SHAPES.includes(pedida)) {
            repairs.push(`capa ${index + 1}: la forma "${src.shape}" no existe, se usa circle`);
        }
        layer.width = fraction(src.width, 0.3, comp.width);
        layer.height = fraction(src.height, layer.width, comp.height);
        layer.thickness = num(src.thickness, 0.02, { min: 0.001, max: 0.5 });
    }

    if (type === 'gradient') {
        layer.color2 = normalizeColor(src.color2, '#000000');
        layer.angle = num(src.angle, 90, { min: 0, max: 360 });
    }

    if (type === 'shader') {
        layer.glsl = String(src.glsl ?? '');
        const check = validateShaderBody(layer.glsl);
        layer.shaderOk = check.ok;
        layer.shaderErrors = check.errors;
        if (!check.ok) {
            // No se descarta la capa: el estudio la usa para pedir una
            // reparación con el error delante, que es lo que la arregla.
            errors.push(`La capa ${index + 1} (shader) no es válida:\n  - ${check.errors.join('\n  - ')}`);
        }
        for (const w of check.warnings) repairs.push(`capa ${index + 1}: ${w}`);
    }

    return layer;
}

export function createComposition(raw = {}) {
    const repairs = [];
    const errors = [];

    const comp = {
        name: String(raw.name || 'Sin título').trim().slice(0, 80),
        width: Math.round(num(raw.width, 1024, { min: MIN_SIZE, max: MAX_SIZE })),
        height: Math.round(num(raw.height, 1024, { min: MIN_SIZE, max: MAX_SIZE })),
        background: normalizeColor(raw.background, '#0b0e12'),
        palette: [],
        layers: [],
        post: []
    };

    const paleta = Array.isArray(raw.palette) ? raw.palette : [];
    comp.palette = paleta.map(c => normalizeColor(c)).filter(Boolean).slice(0, 6);
    // El shader siempre recibe tres colores, existan o no en la paleta: un
    // uniform sin valor es negro, y "mi degradado sale negro" es un rato
    // perdido buscando en el sitio equivocado.
    while (comp.palette.length < 3) {
        comp.palette.push(comp.palette[comp.palette.length - 1] || '#ffffff');
    }

    const capas = Array.isArray(raw.layers) ? raw.layers : [];
    if (!capas.length) errors.push('La composición no tiene ninguna capa: no habría nada que dibujar.');
    if (capas.length > MAX_LAYERS) {
        repairs.push(`se descartaron ${capas.length - MAX_LAYERS} capas por encima del máximo de ${MAX_LAYERS}`);
    }
    comp.layers = capas.slice(0, MAX_LAYERS).map((l, i) => normalizeLayer(l, i, comp, repairs, errors));

    const post = Array.isArray(raw.post) ? raw.post : [];
    for (const p of post.slice(0, 6)) {
        const effect = pick(p && p.effect, EFFECTS, null);
        if (!effect) {
            repairs.push(`efecto "${p && p.effect}" no existe, se descarta`);
            continue;
        }
        comp.post.push({ effect, amount: num(p.amount, 0.5, { min: 0, max: 1 }) });
    }

    return { comp, repairs, errors };
}

/**
 * Lo que dijera el modelo, convertido en composición.
 * Devuelve `{ok, composition, errors, repairs}` con los errores redactados para
 * pegárselos tal cual en el turno de reparación.
 */
export function parseComposition(raw, { nameFallback = '' } = {}) {
    const text = stripThinking(typeof raw === 'string' ? raw : JSON.stringify(raw));
    if (!text.trim()) return { ok: false, errors: ['La respuesta está vacía.'], repairs: [] };

    let parsed = parseLooseJson(text);
    const repairs = [...(parsed.repairs || [])];

    if (!parsed.ok) {
        for (const candidato of extractJsonObjects(text)) {
            const intento = parseLooseJson(candidato);
            if (intento.ok && intento.value && (intento.value.layers || intento.value.capas)) {
                parsed = intento;
                repairs.push('objeto extraído de texto libre', ...(intento.repairs || []));
                break;
            }
        }
    }

    if (!parsed.ok) {
        return {
            ok: false,
            errors: ['La respuesta no es JSON válido. Devuelve SÓLO el objeto de la composición, sin texto alrededor y sin ```.'],
            repairs
        };
    }

    let obj = parsed.value;
    if (obj && obj.composition && typeof obj.composition === 'object') obj = obj.composition;
    if (obj && obj.layers === undefined && Array.isArray(obj.capas)) obj = { ...obj, layers: obj.capas };
    if (obj && !obj.name && nameFallback) obj = { ...obj, name: nameFallback };

    const { comp, repairs: r2, errors } = createComposition(obj || {});
    return { ok: errors.length === 0, composition: comp, errors, repairs: [...new Set([...repairs, ...r2])] };
}

/** Resumen corto para volver a metérselo al modelo en la iteración siguiente. */
export function compositionToText(comp) {
    if (!comp) return '(sin composición)';
    const extras = (l) => {
        const partes = [];
        if (l.rotation) partes.push(`girada ${l.rotation}°`);
        if (l.opacity !== 1) partes.push(`opacidad ${l.opacity}`);
        if (l.blend !== 'normal') partes.push(`fusión ${l.blend}`);
        return partes.length ? `, ${partes.join(', ')}` : '';
    };

    const filas = comp.layers.map(l => {
        const pos = `en (${l.x.toFixed(2)}, ${l.y.toFixed(2)})`;
        if (l.type === 'text') {
            const tipo = [`fuente ${l.font}`, l.weight, `alineado ${l.align}`];
            if (l.letterSpacing) tipo.push(`espaciado ${l.letterSpacing}`);
            return `  ${l.id}. texto "${l.text}" ${pos}, ${l.color}, tamaño ${l.size.toFixed(3)}, ${tipo.join(', ')}${extras(l)}`;
        }
        if (l.type === 'shape') {
            return `  ${l.id}. forma ${l.shape} ${pos}, ${l.color}, ancho ${l.width.toFixed(3)}, ` +
                `alto ${l.height.toFixed(3)}, grosor ${l.thickness}${extras(l)}`;
        }
        if (l.type === 'gradient') return `  ${l.id}. degradado ${l.color} → ${l.color2} a ${l.angle}°${extras(l)}`;

        // El shader va ENTERO, no resumido a "(9 líneas)".
        //
        // Este texto es lo único que el modelo ve de la composición actual
        // cuando le pides "más oscuro", y su respuesta REEMPLAZA la composición
        // entera. Con el cuerpo escondido no podía devolver un shader que no
        // había visto: cada refinado borraba el shader anterior y lo sustituía
        // por otro inventado desde cero. Lo mismo valía, en menor medida, para
        // todos los campos que esta función se dejaba fuera.
        const cuerpo = String(l.glsl || '').split('\n').map(x => `        ${x}`).join('\n');
        return `  ${l.id}. shader ${pos}${extras(l)}${l.shaderOk === false ? ' — NO COMPILA' : ''}\n` +
            `      glsl: |\n${cuerpo}`;
    });
    const post = comp.post.length ? comp.post.map(p => `${p.effect} ${p.amount}`).join(', ') : 'ninguno';
    return [
        `COMPOSICIÓN "${comp.name}" — ${comp.width}×${comp.height}`,
        `fondo ${comp.background} · paleta ${comp.palette.join(' ')}`,
        'CAPAS (de atrás hacia delante):',
        ...filas,
        `POST: ${post}`
    ].join('\n');
}
