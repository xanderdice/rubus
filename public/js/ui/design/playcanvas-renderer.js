/**
 * El renderer: PlayCanvas dibujando la composición.
 *
 * Implementa el contrato que `core/design/studio.js` espera, y es la única
 * parte del estudio que toca WebGL. El estudio no sabe que PlayCanvas existe:
 * le pasa una composición y recibe `{ok, shaderErrors, stats}`. Esa frontera es
 * la que permite probar toda la lógica sin una tarjeta gráfica, igual que
 * `platform` permite probar el motor sin sistema de archivos.
 *
 * ── Por qué se compone a mano en vez de con el grafo de escena ────────────
 *
 * PlayCanvas trae entidades, cámaras y materiales, y para una escena 3D es lo
 * que hay que usar. Para apilar capas 2D no: cada capa acabaría siendo una
 * entidad con un plano, una cámara ortográfica y un material, para terminar
 * dibujando exactamente un cuadrado a pantalla completa. Aquí se usa la parte
 * de PlayCanvas que corresponde — el dispositivo gráfico, la compilación de
 * shaders, los render targets y `drawQuadWithShader` — y se compone capa a capa
 * sobre un render target, que es como se hace un compositor.
 *
 * ── Los errores de compilación son el producto principal ──────────────────
 *
 * No un efecto secundario. Un shader que no compila es la forma más común de
 * que el modelo se equivoque aquí, y el log del driver es lo único que permite
 * arreglarlo. Por eso se capturan por capa, con su código al lado, en vez de
 * dejar que PlayCanvas los escriba en la consola y se pierdan.
 */

import { wrapFragment, explainCompileError } from '../../core/design/glsl.js';
import { colorToVec3 } from '../../core/design/composition.js';

/** Ruta del motor. Lo trae `npm run setup:design`; puede no estar. */
const MOTOR = '../../../vendor/playcanvas.js';

/** Vertex shader único: un cuadrado a pantalla completa con uv 0..1. */
const VERTEX = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

/** Resolución a la que se mide si la imagen tiene algo. 64×64 sobra. */
const MUESTRA = 64;

let pc = null;
let motorError = '';

/** Carga el motor una vez. No lanza: la ausencia es un estado, no un fallo. */
export async function loadEngine() {
    if (pc) return pc;
    try {
        pc = await import(/* @vite-ignore */ MOTOR);
        return pc;
    } catch (err) {
        motorError = String(err && err.message || err);
        return null;
    }
}

export function engineError() {
    return motorError;
}

export class PlayCanvasRenderer {
    constructor({ canvas, logger } = {}) {
        this.canvas = canvas;
        this.logger = logger;
        this.app = null;
        this.device = null;
        this.time = 0;
        this.animating = false;
        this._rt = [null, null];
        this._size = { width: 0, height: 0 };
        this._shaderCache = new Map();
        /** clave visual -> {tex, usadaEn} para no rehacer el mismo texto. */
        this._textures = new Map();
        this._renderId = 0;
        this._last = null;
        this._raf = 0;
    }

    ready() {
        return !!this.device;
    }

    /** Arranca PlayCanvas sobre el canvas. Devuelve false si no hay motor. */
    async init() {
        const engine = await loadEngine();
        if (!engine) return false;

        this.app = new engine.Application(this.canvas, {
            graphicsDeviceOptions: {
                alpha: false,
                antialias: true,
                // Sin esto, `toDataURL` sobre el canvas de WebGL devuelve una
                // imagen en blanco en cuanto el navegador ha pasado de frame.
                // Exportar es la mitad de lo que se le pide a esta sección.
                preserveDrawingBuffer: true,
                powerPreference: 'high-performance'
            }
        });
        this.app.setCanvasFillMode(engine.FILLMODE_NONE);
        // El bucle de PlayCanvas no hace falta: no hay escena que actualizar y
        // dejarlo corriendo gasta GPU repintando lo mismo. El tiempo lo lleva
        // este renderer cuando hay algo animado.
        this.app.autoRender = false;

        this.device = this.app.graphicsDevice;
        return true;
    }

    dispose() {
        this.stopAnimation();
        for (const { tex } of this._textures.values()) { try { tex.destroy(); } catch { /* ya destruida */ } }
        this._textures.clear();
        for (const rt of this._rt) { try { rt?.colorBuffer?.destroy(); rt?.destroy(); } catch { /* ya destruido */ } }
        this._rt = [null, null];
        this._shaderCache.clear();
        try { this.app?.destroy(); } catch { /* ya destruida */ }
        this.app = null;
        this.device = null;
    }

    // ── render ────────────────────────────────────────────────────────────

    /**
     * Dibuja la composición entera.
     * @returns {{ok, shaderErrors, stats, error?}}
     */
    async render(comp) {
        if (!this.device) return { ok: false, error: 'El motor de render no está cargado.', shaderErrors: [], stats: {} };

        this._last = comp;
        this._renderId++;
        this._resize(comp.width, comp.height);

        const shaderErrors = [];
        const device = this.device;

        try {
            this._ensureTargets(comp.width, comp.height);
            const destino = this._rt[0];

            // Fondo. Se pinta como capa, no con un clear, para que el propio
            // fondo pueda participar del blending de la primera capa.
            this._drawSolid(destino, comp.background);

            for (const layer of comp.layers) {
                const err = this._drawLayer(destino, layer, comp);
                if (err) shaderErrors.push(err);
            }

            const final = comp.post.length ? this._applyPost(comp) : destino;
            this._blitToScreen(final);
            this._recogerTexturas();

            const stats = this._measure(comp);
            return { ok: true, shaderErrors, stats };
        } catch (err) {
            this.logger?.error('Fallo renderizando la composición', { error: String(err && err.message || err) });
            return { ok: false, error: String(err && err.message || err), shaderErrors, stats: {} };
        } finally {
            device.updateEnd?.();
        }
    }

    _resize(w, h) {
        if (this._size.width === w && this._size.height === h) return;
        this.canvas.width = w;
        this.canvas.height = h;
        this.app.setCanvasResolution(pc.RESOLUTION_FIXED, w, h);
        this._size = { width: w, height: h };
        // Los render targets viejos ya no valen: se recrean al vuelo.
        for (const rt of this._rt) { try { rt?.colorBuffer?.destroy(); rt?.destroy(); } catch { /* ya */ } }
        this._rt = [null, null];
    }

    _ensureTargets(w, h) {
        for (let i = 0; i < 2; i++) {
            if (this._rt[i]) continue;
            const tex = new pc.Texture(this.device, {
                name: `estudio-rt${i}`,
                width: w, height: h,
                format: pc.PIXELFORMAT_RGBA8,
                mipmaps: false,
                minFilter: pc.FILTER_LINEAR,
                magFilter: pc.FILTER_LINEAR,
                addressU: pc.ADDRESS_CLAMP_TO_EDGE,
                addressV: pc.ADDRESS_CLAMP_TO_EDGE
            });
            this._rt[i] = new pc.RenderTarget({ colorBuffer: tex, depth: false });
        }
    }

    /**
     * Compila y cachea. La caché es por código fuente, así que reordenar capas
     * o cambiar un color no vuelve a compilar nada — que importa porque
     * compilar un shader en WebGL bloquea el hilo unos milisegundos y el
     * estudio redibuja en cada iteración.
     */
    _shader(name, fragment) {
        const clave = `${name}:${hash(fragment)}`;
        if (this._shaderCache.has(clave)) return this._shaderCache.get(clave);

        let entrada;
        try {
            const shader = pc.createShaderFromCode(this.device, VERTEX, fragment, clave, { aPosition: pc.SEMANTIC_POSITION });
            entrada = { shader, log: shader ? '' : 'el shader no se pudo crear' };
        } catch (err) {
            entrada = { shader: null, log: String(err && err.message || err) };
        }

        // WebGL no lanza al compilar: hay que preguntar. Si no se pregunta, un
        // shader roto se dibuja como un cuadrado negro y parece una decisión
        // estética del modelo.
        if (entrada.shader) {
            const problema = compileLog(this.device, entrada.shader);
            if (problema) entrada = { shader: null, log: problema, source: entrada.shader.impl?._fsource || '' };
        }

        this._shaderCache.set(clave, entrada);
        return entrada;
    }

    _draw(target, fragment, name, uniforms = {}, blend = 'normal') {
        const { shader, log, source } = this._shader(name, fragment);
        if (!shader) return { log: log || 'shader inválido', source: source || '' };

        for (const [k, v] of Object.entries(uniforms)) {
            this.device.scope.resolve(k).setValue(v);
        }
        this.device.setBlendState(blendState(blend));
        pc.drawQuadWithShader(this.device, target, shader, undefined, undefined, blend !== 'replace');
        return null;
    }

    _drawSolid(target, color) {
        const frag = `precision highp float;
uniform vec3 uColor;
varying vec2 vUv;
void main() { gl_FragColor = vec4(uColor, 1.0); }`;
        this._draw(target, frag, 'solid', { uColor: colorToVec3(color) }, 'replace');
    }

    /**
     * Una capa. Devuelve null si fue bien, o `{layer, log, glsl}` si el shader
     * de esa capa no compila — que es lo que el estudio necesita para pedirle
     * al modelo que lo arregle.
     */
    _drawLayer(target, layer, comp) {
        const comunes = {
            uOpacity: layer.opacity,
            uTime: this.time,
            uResolution: [comp.width, comp.height],
            uSeed: (layer.id * 37.13) % 100,
            uColorA: colorToVec3(comp.palette[0]),
            uColorB: colorToVec3(comp.palette[1]),
            uColorC: colorToVec3(comp.palette[2])
        };

        if (layer.type === 'shader') {
            const fuente = wrapFragmentWithOpacity(layer.glsl);
            // 'capa' a secas y no `capa${layer.id}`: el hash del código ya
            // distingue un shader de otro, y meter el número de capa hacía que
            // mover una capa de sitio recompilara el MISMO GLSL — justo lo que
            // el comentario de la caché dice que no pasa.
            const fallo = this._draw(target, fuente, 'capa', comunes, layer.blend);
            if (fallo) {
                return {
                    layer: layer.id,
                    log: explainCompileError(fallo.log, layer.glsl, fallo.source),
                    glsl: layer.glsl
                };
            }
            return null;
        }

        if (layer.type === 'gradient') {
            this._draw(target, GRADIENT_FRAG, 'gradient', {
                ...comunes,
                uColor: colorToVec3(layer.color),
                uColor2: colorToVec3(layer.color2),
                uAngle: (layer.rotation + layer.angle) * Math.PI / 180
            }, layer.blend);
            return null;
        }

        if (layer.type === 'shape') {
            this._draw(target, shapeFragment(layer.shape), `shape-${layer.shape}`, {
                ...comunes,
                uColor: colorToVec3(layer.color),
                uCenter: [layer.x, 1 - layer.y],
                uSize: [layer.width, layer.height],
                uThickness: layer.thickness,
                uRotation: layer.rotation * Math.PI / 180,
                uAspect: comp.width / comp.height
            }, layer.blend);
            return null;
        }

        if (layer.type === 'text') {
            const tex = this._textTexture(layer, comp);
            this._draw(target, TEXT_FRAG, 'text', { ...comunes, uTex: tex }, layer.blend);
            return null;
        }

        return null;
    }

    /**
     * El texto se pinta en un canvas 2D y sube como textura.
     *
     * PlayCanvas sabe dibujar texto, pero con fuentes MSDF que hay que generar
     * y empaquetar como assets. Para un logo eso significaría o meter una
     * fuente en el repositorio o no poder usar la que el usuario quiera. El
     * canvas 2D del navegador ya tiene todas las del sistema, con su kerning y
     * su hinting, y sale de aquí como una textura más.
     */
    _textTexture(layer, comp) {
        // Cacheada por su aspecto, y ese es el arreglo de una fuga seria: antes
        // se creaba una textura del tamaño COMPLETO del lienzo por capa de
        // texto y por render, y sólo se soltaban en dispose(), al que no llama
        // nadie. Pulsar "Animar" en un logo de 1024×1024 con dos textos son
        // ~8 MB de GPU por fotograma: la pestaña se cae en segundos.
        // JSON.stringify y no un separador exótico: no hay que elegir un
        // carácter que el texto del usuario no pueda contener, y no invita a
        // meter un byte de control en el código para hacer de separador —
        // que es justo lo que había aquí.
        const clave = JSON.stringify([
            layer.text, layer.font, layer.weight, layer.align, layer.color,
            layer.size, layer.letterSpacing, layer.rotation, layer.x, layer.y,
            comp.width, comp.height
        ]);

        const guardada = this._textures.get(clave);
        if (guardada) {
            guardada.usadaEn = this._renderId;
            return guardada.tex;
        }

        const c = document.createElement('canvas');
        c.width = comp.width;
        c.height = comp.height;
        const g = c.getContext('2d');

        const px = Math.max(8, layer.size * comp.height);
        const familia = FONTS[layer.font] || layer.font || 'sans-serif';
        const peso = { normal: '400', bold: '700', black: '900' }[layer.weight] || '700';
        g.font = `${peso} ${px}px ${familia}`;
        g.textBaseline = 'middle';
        g.textAlign = layer.align;
        g.fillStyle = layer.color;

        g.translate(layer.x * comp.width, layer.y * comp.height);
        if (layer.rotation) g.rotate(layer.rotation * Math.PI / 180);

        // El espaciado entre letras se hace a mano: `letterSpacing` del canvas
        // 2D es reciente y no está en todos los webviews donde esto corre.
        const espaciado = layer.letterSpacing * px;
        if (Math.abs(espaciado) < 0.01) {
            g.fillText(layer.text, 0, 0);
        } else {
            const letras = [...layer.text];
            const anchos = letras.map(ch => g.measureText(ch).width + espaciado);
            const total = anchos.reduce((a, b) => a + b, 0) - espaciado;
            let x = layer.align === 'center' ? -total / 2 : layer.align === 'right' ? -total : 0;
            const previo = g.textAlign;
            g.textAlign = 'left';
            letras.forEach((ch, i) => { g.fillText(ch, x, 0); x += anchos[i]; });
            g.textAlign = previo;
        }

        const tex = new pc.Texture(this.device, {
            name: `texto-${layer.id}`,
            width: c.width, height: c.height,
            format: pc.PIXELFORMAT_RGBA8,
            mipmaps: false,
            minFilter: pc.FILTER_LINEAR,
            magFilter: pc.FILTER_LINEAR,
            addressU: pc.ADDRESS_CLAMP_TO_EDGE,
            addressV: pc.ADDRESS_CLAMP_TO_EDGE
        });
        tex.setSource(c);
        this._textures.set(clave, { tex, usadaEn: this._renderId });
        return tex;
    }

    /**
     * Suelta las texturas de texto que este render ya no ha usado.
     *
     * Sin esto la caché sería una fuga más lenta: refinar veinte veces un logo
     * deja veinte textos viejos en memoria de vídeo. Se recoge después de
     * dibujar, no antes, porque hasta que no termina el render no se sabe
     * cuáles siguen haciendo falta.
     */
    _recogerTexturas() {
        for (const [clave, entrada] of this._textures) {
            if (entrada.usadaEn === this._renderId) continue;
            try { entrada.tex.destroy(); } catch { /* ya destruida */ }
            this._textures.delete(clave);
        }
    }

    /** Cadena de post-proceso, saltando entre los dos render targets. */
    _applyPost(comp) {
        let origen = 0;
        for (const efecto of comp.post) {
            const destino = 1 - origen;
            this._draw(this._rt[destino], POST[efecto.effect] || POST.vignette, `post-${efecto.effect}`, {
                uTex: this._rt[origen].colorBuffer,
                uAmount: efecto.amount,
                uResolution: [comp.width, comp.height],
                uTime: this.time
            }, 'replace');
            origen = destino;
        }
        return this._rt[origen];
    }

    _blitToScreen(rt) {
        this._draw(null, BLIT_FRAG, 'blit', { uTex: rt.colorBuffer }, 'replace');
    }

    /**
     * ¿Se ve algo?
     *
     * La comprobación estructural del estudio necesita un número, y este es el
     * equivalente gráfico de `checkBalance`: no dice si la imagen es bonita,
     * dice si hay imagen. Un shader que salió negro, una capa opaca tapando
     * todo o un texto del color del fondo dan todos lo mismo aquí — cobertura
     * casi cero — y los tres son fallos reales que el modelo no puede ver.
     */
    _measure(comp) {
        // Reutilizado: a 60 fps, crear un canvas por fotograma es basura que
        // el recolector tiene que barrer en mitad de la animación.
        if (!this._muestra) {
            this._muestra = document.createElement('canvas');
            this._muestra.width = MUESTRA;
            this._muestra.height = MUESTRA;
        }
        const g = this._muestra.getContext('2d', { willReadFrequently: true });
        g.clearRect(0, 0, MUESTRA, MUESTRA);
        g.drawImage(this.canvas, 0, 0, MUESTRA, MUESTRA);

        const datos = g.getImageData(0, 0, MUESTRA, MUESTRA).data;
        const fondo = colorToVec3(comp.background).map(v => v * 255);

        let distintos = 0;
        const colores = new Set();
        for (let i = 0; i < datos.length; i += 4) {
            const d = Math.abs(datos[i] - fondo[0]) + Math.abs(datos[i + 1] - fondo[1]) + Math.abs(datos[i + 2] - fondo[2]);
            if (d > 24) distintos++;
            colores.add((datos[i] >> 3 << 10) | (datos[i + 1] >> 3 << 5) | (datos[i + 2] >> 3));
        }

        return {
            coverage: distintos / (MUESTRA * MUESTRA),
            uniqueColors: colores.size,
            width: comp.width,
            height: comp.height
        };
    }

    // ── animación y exportación ───────────────────────────────────────────

    /** Sólo tiene sentido con capas de shader: son las que leen uTime. */
    startAnimation() {
        if (this.animating || !this._last) return;
        this.animating = true;
        const inicio = performance.now();
        const paso = () => {
            if (!this.animating) return;
            this.time = (performance.now() - inicio) / 1000;
            this.render(this._last);
            this._raf = requestAnimationFrame(paso);
        };
        this._raf = requestAnimationFrame(paso);
    }

    stopAnimation() {
        this.animating = false;
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = 0;
    }

    /** PNG listo para descargar. */
    snapshot(type = 'image/png') {
        return this.canvas.toDataURL(type);
    }
}

// ── shaders de las capas ──────────────────────────────────────────────────

/** El envoltorio común, más la opacidad de la capa aplicada al final. */
function wrapFragmentWithOpacity(body) {
    return wrapFragment(body).replace(
        'gl_FragColor = vec4(clamp(color, 0.0, 1.0), clamp(alpha, 0.0, 1.0));',
        'gl_FragColor = vec4(clamp(color, 0.0, 1.0), clamp(alpha, 0.0, 1.0) * uOpacity);'
    ).replace('uniform vec3  uColorC;', 'uniform vec3  uColorC;\nuniform float uOpacity;');
}

const GRADIENT_FRAG = `precision highp float;
uniform vec3 uColor;
uniform vec3 uColor2;
uniform float uAngle;
uniform float uOpacity;
varying vec2 vUv;
void main() {
    vec2 d = vec2(cos(uAngle), sin(uAngle));
    float t = clamp(dot(vUv - 0.5, d) + 0.5, 0.0, 1.0);
    gl_FragColor = vec4(mix(uColor, uColor2, t), uOpacity);
}`;

const TEXT_FRAG = `precision highp float;
uniform sampler2D uTex;
uniform float uOpacity;
varying vec2 vUv;
void main() {
    vec4 t = texture2D(uTex, vec2(vUv.x, 1.0 - vUv.y));
    gl_FragColor = vec4(t.rgb, t.a * uOpacity);
}`;

const BLIT_FRAG = `precision highp float;
uniform sampler2D uTex;
varying vec2 vUv;
void main() { gl_FragColor = vec4(texture2D(uTex, vUv).rgb, 1.0); }`;

/** Las formas son SDF: se ven nítidas a cualquier resolución de exportación. */
function shapeFragment(shape) {
    const cuerpos = {
        circle: 'float d = length(p) - 1.0;',
        rect: 'vec2 q = abs(p) - 1.0; float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);',
        roundrect: 'vec2 q = abs(p) - 0.8; float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.2;',
        ring: 'float d = abs(length(p) - 1.0) - uThickness * 10.0;',
        line: 'float d = abs(p.y) - uThickness * 10.0;',
        triangle: [
            'float k = sqrt(3.0);',
            'vec2 q = vec2(abs(p.x) - 1.0, -p.y - 0.5);',
            'if (q.x + k * q.y > 0.0) q = vec2(q.x - k * q.y, -k * q.x - q.y) / 2.0;',
            'q.x -= clamp(q.x, -2.0, 0.0);',
            'float d = -length(q) * sign(q.y);'
        ].join('\n    '),
        hexagon: [
            'vec3 k = vec3(-0.866025404, 0.5, 0.577350269);',
            'vec2 q = abs(p);',
            'q -= 2.0 * min(dot(k.xy, q), 0.0) * k.xy;',
            'q -= vec2(clamp(q.x, -k.z, k.z), 1.0);',
            'float d = length(q) * sign(q.y);'
        ].join('\n    '),
        star: [
            'float a = atan(p.x, p.y) + 3.14159;',
            'float seg = 6.28318 / 5.0;',
            'float r = cos(floor(0.5 + a / seg) * seg - a) * length(p);',
            'float d = r - 0.5;'
        ].join('\n    ')
    };

    return `precision highp float;
uniform vec3  uColor;
uniform vec2  uCenter;
uniform vec2  uSize;
uniform float uThickness;
uniform float uRotation;
uniform float uAspect;
uniform float uOpacity;
varying vec2 vUv;

void main() {
    vec2 p = (vUv - uCenter);
    p.x *= uAspect;
    float c = cos(uRotation), s = sin(uRotation);
    p = mat2(c, -s, s, c) * p;
    p /= max(vec2(0.0001), vec2(uSize.x * uAspect, uSize.y) * 0.5);

    ${cuerpos[shape] || cuerpos.circle}

    // El suavizado se saca de la derivada del propio campo, así que el borde
    // mide un píxel exacto tanto a 512 como a 4096.
    float px = fwidth(d) + 1e-6;
    float a = 1.0 - smoothstep(-px, px, d);
    if (a <= 0.001) discard;
    gl_FragColor = vec4(uColor, a * uOpacity);
}`;
}

// ── post-proceso ──────────────────────────────────────────────────────────

const cabeceraPost = `precision highp float;
uniform sampler2D uTex;
uniform float uAmount;
uniform float uTime;
uniform vec2 uResolution;
varying vec2 vUv;
`;

const POST = {
    bloom: `${cabeceraPost}
void main() {
    vec3 base = texture2D(uTex, vUv).rgb;
    vec3 suma = vec3(0.0);
    vec2 paso = 2.5 / uResolution;
    for (int x = -4; x <= 4; x++) {
        for (int y = -4; y <= 4; y++) {
            vec3 s = texture2D(uTex, vUv + vec2(float(x), float(y)) * paso).rgb;
            suma += max(s - 0.55, 0.0);
        }
    }
    gl_FragColor = vec4(base + suma / 81.0 * uAmount * 6.0, 1.0);
}`,

    vignette: `${cabeceraPost}
void main() {
    vec3 c = texture2D(uTex, vUv).rgb;
    float d = distance(vUv, vec2(0.5)) * 1.414;
    gl_FragColor = vec4(c * (1.0 - smoothstep(0.35, 1.0, d) * uAmount), 1.0);
}`,

    grain: `${cabeceraPost}
float h21(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
}
void main() {
    vec3 c = texture2D(uTex, vUv).rgb;
    float n = h21(vUv * uResolution + uTime) - 0.5;
    gl_FragColor = vec4(c + n * uAmount * 0.35, 1.0);
}`,

    chromatic: `${cabeceraPost}
void main() {
    vec2 d = (vUv - 0.5) * uAmount * 0.02;
    gl_FragColor = vec4(
        texture2D(uTex, vUv + d).r,
        texture2D(uTex, vUv).g,
        texture2D(uTex, vUv - d).b,
        1.0);
}`,

    scanlines: `${cabeceraPost}
void main() {
    vec3 c = texture2D(uTex, vUv).rgb;
    float l = sin(vUv.y * uResolution.y * 1.5) * 0.5 + 0.5;
    gl_FragColor = vec4(c * (1.0 - l * uAmount * 0.5), 1.0);
}`,

    blur: `${cabeceraPost}
void main() {
    vec2 paso = uAmount * 3.0 / uResolution;
    vec3 s = vec3(0.0);
    for (int x = -3; x <= 3; x++) {
        for (int y = -3; y <= 3; y++) {
            s += texture2D(uTex, vUv + vec2(float(x), float(y)) * paso).rgb;
        }
    }
    gl_FragColor = vec4(s / 49.0, 1.0);
}`,

    pixelate: `${cabeceraPost}
void main() {
    float n = mix(uResolution.x, 24.0, uAmount);
    vec2 q = floor(vUv * n) / n + 0.5 / n;
    gl_FragColor = vec4(texture2D(uTex, q).rgb, 1.0);
}`
};

// ── utilidades ────────────────────────────────────────────────────────────

const FONTS = {
    sans: 'system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    mono: 'ui-monospace, Consolas, "Courier New", monospace',
    display: 'Impact, "Arial Black", system-ui, sans-serif'
};

function blendState(modo) {
    const B = pc.BlendState;
    if (modo === 'replace') return B.NOBLEND;
    if (modo === 'add') {
        return new B(true, pc.BLENDEQUATION_ADD, pc.BLENDMODE_SRC_ALPHA, pc.BLENDMODE_ONE);
    }
    if (modo === 'multiply') {
        return new B(true, pc.BLENDEQUATION_ADD, pc.BLENDMODE_DST_COLOR, pc.BLENDMODE_ZERO);
    }
    if (modo === 'screen') {
        return new B(true, pc.BLENDEQUATION_ADD, pc.BLENDMODE_ONE, pc.BLENDMODE_ONE_MINUS_SRC_COLOR);
    }
    return B.ALPHABLEND;
}

/**
 * El error de compilación de verdad.
 *
 * PlayCanvas deja en el log del PROGRAMA un genérico "Fragment shader is not
 * compiled", que no le dice nada a nadie. El mensaje que sirve —
 * `'esto_no_existe' : undeclared identifier` — está en el log del objeto
 * shader, y hay que ir a buscarlo ahí. Es la diferencia entre que el modelo
 * pueda arreglar su shader en el siguiente turno y que dé palos de ciego.
 *
 * El NUL final es cosa de ANGLE y hay que quitarlo: un byte de control se cuela
 * después en el prompt y en el registro, donde no pinta nada.
 */
function compileLog(device, shader) {
    const gl = device.gl;
    const impl = shader.impl;
    if (!gl || !impl) return '';

    // Sin regex, y el NUL escrito como escape: un byte de control literal
    // convierte este archivo en binario para grep y para el diff (AGENTS.md).
    const limpio = (s) => String(s || '').split('\u0000').join('').trim();

    for (const parte of [impl.glFragmentShader, impl.glVertexShader]) {
        if (parte && !gl.getShaderParameter(parte, gl.COMPILE_STATUS)) {
            return limpio(gl.getShaderInfoLog(parte)) || 'el shader no compiló';
        }
    }
    if (impl.glProgram && !gl.getProgramParameter(impl.glProgram, gl.LINK_STATUS)) {
        return limpio(gl.getProgramInfoLog(impl.glProgram)) || 'el programa no enlazó';
    }
    return '';
}

/** Hash barato y estable para cachear shaders por su código. */
function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}
