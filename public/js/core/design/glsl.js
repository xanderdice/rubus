/**
 * GLSL escrito por el modelo, comprobado antes de llegar a la GPU.
 *
 * Este archivo es a los shaders lo que `security.js` es a la shell: parte de
 * que el modelo se equivoca y lo comprueba en código, no en el prompt.
 *
 * ── Por qué el modelo NO escribe el shader entero ─────────────────────────
 *
 * Pedirle un fragment shader completo a un modelo de 8B es pedirle que acierte
 * con `precision highp float;`, con las declaraciones de uniforms, con el
 * nombre exacto de `gl_FragColor` y con la firma de `main()`, todo antes de
 * llegar a la parte que de verdad importa. Falla en la ceremonia, no en la
 * idea. Así que aquí sólo escribe el CUERPO — unas líneas que calculan un
 * color a partir de `uv` — y el envoltorio lo pone `wrapFragment()`. Eso quita
 * de golpe la mayoría de los errores de compilación y, de paso, deja mucho
 * menos sitio donde esconder algo raro.
 *
 * ── Qué se rechaza y por qué ──────────────────────────────────────────────
 *
 * Un shader no puede leer tus archivos ni llamar a la red: se ejecuta en la
 * GPU, aislado. El daño que sí puede hacer es colgar el dispositivo con un
 * bucle enorme — Windows lo mata con un TDR y se lleva por delante la pestaña,
 * a veces el escritorio entero. Por eso los bucles tienen que tener un tope
 * literal y pequeño: no es purismo, es que `for (int i = 0; i < 100000; i++)`
 * dentro de un fragment shader a 1024×1024 son cien mil millones de
 * iteraciones y el driver se rinde.
 *
 * El resto de prohibiciones son de contrato: si el modelo declara sus propios
 * uniforms o escribe `main()`, el envoltorio deja de compilar y el error que
 * llega es incomprensible. Es más útil rechazarlo con una frase clara que
 * dejar que la GPU conteste con `ERROR: 0:14: '' : syntax error`.
 */

/**
 * Marca en el envoltorio para saber dónde empieza el código del modelo.
 *
 * Hace falta porque PlayCanvas antepone su propio preámbulo al compilar
 * (#version, defines, extensiones), y su longitud cambia entre versiones. Sin
 * un punto de referencia dentro de la fuente real, "línea 80" no se puede
 * traducir a ninguna línea del shader que escribió el modelo.
 */
export const MARCA_CUERPO = 'RUBUS_CUERPO';

/**
 * Y va como DECLARACIÓN, no como comentario.
 *
 * Un `// RUBUS_CUERPO` parecía lo natural y no funciona: PlayCanvas quita los
 * comentarios antes de mandar la fuente al driver, así que la marca no llegaba
 * y todos los errores caían en el mensaje de reserva. Una variable muerta sí
 * sobrevive al preprocesado, no cuesta nada — el compilador la descarta — y
 * deja el punto de referencia donde hace falta.
 */
const MARCA_GLSL = `float ${MARCA_CUERPO} = 0.0;`;

/** Tope de iteraciones por bucle. Suficiente para raymarching sencillo. */
export const MAX_LOOP_ITERATIONS = 64;

/**
 * Iteraciones totales por píxel (el producto de los bucles anidados).
 *
 * 1024 y no más: a 1024×1024 eso ya es mil millones de vueltas para pintar un
 * fotograma. Da de sobra para lo que se hace aquí — un raymarch de 64 pasos, un
 * kernel de desenfoque de 16×16, un fbm de 8 octavas — y deja fuera el 64×64
 * que parece inocente y son cuatro mil millones.
 */
export const MAX_LOOP_PRODUCT = 1024;

/** Un cuerpo más largo que esto no es un shader, es una equivocación. */
export const MAX_BODY_CHARS = 4000;

/**
 * Lo que el cuerpo puede dar por hecho que existe.
 *
 * Se le enseña al modelo tal cual en el prompt: una lista corta y cerrada da
 * muchísimos menos nombres inventados que "tienes las uniforms habituales".
 */
export const PROVIDED = Object.freeze({
    varyings: ['vUv'],
    uniforms: ['uTime', 'uResolution', 'uSeed', 'uColorA', 'uColorB', 'uColorC'],
    locals: ['uv', 'color', 'alpha'],
    helpers: ['hash11', 'hash21', 'noise2', 'fbm2', 'sdCircle', 'sdBox', 'rot2', 'palette3']
});

/**
 * Palabras que no pueden aparecer en el cuerpo, con el motivo en el idioma del
 * que va a leerlo — que es el modelo, en su turno de reparación.
 */
const FORBIDDEN = [
    { re: /\bvoid\s+main\b/, why: 'no escribas main(): el envoltorio ya lo pone. Escribe sólo el cuerpo.' },
    { re: /\bgl_FragColor\b|\bgl_FragData\b/, why: 'no asignes gl_FragColor: asigna a `color` (vec3) y opcionalmente a `alpha` (float).' },
    { re: /^\s*#/m, why: 'no se admiten directivas de preprocesador (#define, #include, #extension).' },
    { re: /\b(uniform|attribute|varying|precision)\b/, why: 'no declares uniforms ni varyings: usa las que ya existen.' },
    { re: /\bwhile\b|\bdo\b/, why: 'no se admite while/do: su número de vueltas no se puede acotar. Usa for con un tope literal.' },
    { re: /\btexture(2D|Cube|3D)?\s*\(/, why: 'no hay texturas disponibles en un shader de capa.' },
    { re: /\bdFdx\b|\bdFdy\b|\bfwidth\b/, why: 'las derivadas necesitan una extensión que no está activada.' }
];

/** Longitud máxima de un identificador antes de que huela a ofuscación. */
const MAX_IDENT = 64;

/**
 * Comprueba el cuerpo de un shader de capa.
 * @returns {{ok: boolean, errors: string[], warnings: string[], stats: object}}
 */
export function validateShaderBody(source) {
    const body = String(source ?? '');
    const errors = [];
    const warnings = [];

    if (!body.trim()) {
        return { ok: false, errors: ['El shader está vacío.'], warnings, stats: {} };
    }
    if (body.length > MAX_BODY_CHARS) {
        errors.push(`El shader ocupa ${body.length} caracteres; el máximo es ${MAX_BODY_CHARS}.`);
    }

    const limpio = stripComments(body);

    for (const { re, why } of FORBIDDEN) {
        if (re.test(limpio)) errors.push(why);
    }

    const balance = checkBraces(limpio);
    if (!balance.ok) errors.push(balance.message);

    // Se valida sobre el cuerpo SIN comentarios, pero el envoltorio envuelve el
    // cuerpo CRUDO. Un /* sin cerrar desaparecía aquí y en la GPU se comía el
    // resto del envoltorio: el shader acababa sin gl_FragColor y con main() sin
    // cerrar, y el modelo recibía un diagnóstico de tipos que no tenía nada que
    // ver. Es más barato decírselo con estas palabras.
    const abre = body.split('/*').length - 1;
    const cierra = body.split('*/').length - 1;
    if (abre > cierra) errors.push('Hay un comentario /* sin cerrar. Ciérralo con */ o quítalo.');

    const loops = checkLoops(limpio);
    errors.push(...loops.errors);
    warnings.push(...loops.warnings);

    // Asignar a `color` es el único contrato de salida. Sin eso el shader
    // compila y pinta negro, que es el fallo más difícil de diagnosticar
    // mirando el resultado: parece que "no hizo nada".
    if (!/\bcolor\s*(\.[xyzrgb]{1,3})?\s*(=|\+=|-=|\*=|\/=)/.test(limpio)) {
        errors.push('El shader nunca asigna a `color`. Tiene que terminar con un color: por ejemplo `color = vec3(uv.x, uv.y, 0.5);`.');
    }

    const largos = new RegExp(`[A-Za-z_][A-Za-z0-9_]{${MAX_IDENT},}`, 'g');
    for (const ident of limpio.match(largos) || []) {
        warnings.push(`El identificador "${ident.slice(0, 20)}…" es absurdamente largo.`);
    }

    return {
        ok: errors.length === 0,
        errors,
        warnings,
        stats: { chars: body.length, loops: loops.count, maxIterations: loops.product }
    };
}

/** Comentarios fuera, para que ningún `while` comentado dispare una alarma. */
export function stripComments(src) {
    let out = '';
    let i = 0;
    while (i < src.length) {
        if (src[i] === '/' && src[i + 1] === '/') {
            while (i < src.length && src[i] !== '\n') i++;
            continue;
        }
        if (src[i] === '/' && src[i + 1] === '*') {
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ''; i++; }
            i += 2;
            continue;
        }
        out += src[i++];
    }
    return out;
}

function checkBraces(src) {
    let depth = 0;
    for (const c of src) {
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth < 0) return { ok: false, message: 'Hay una llave "}" de más.' }; }
    }
    if (depth > 0) return { ok: false, message: `Faltan ${depth} llave(s) por cerrar: el shader está incompleto.` };
    return { ok: true };
}

/**
 * Cada `for` tiene que declarar cuántas vueltas da, con un número escrito.
 *
 * Un bucle cuyo tope depende de una uniform no se puede acotar leyendo el
 * código, y el compilador de GLSL ES tampoco puede desenrollarlo. Es la única
 * forma que tiene esto de colgar la máquina, así que es la única regla de aquí
 * que no es de estilo.
 */
export function checkLoops(src) {
    const errors = [];
    const warnings = [];
    let count = 0;
    /** Iteraciones del cuerpo entero: los hermanos suman, los hijos multiplican. */
    let product = 0;
    /** Bucles todavía abiertos por encima del actual, con su nivel de llave. */
    const abiertos = [];

    const nivelEn = (hasta) => {
        let d = 0;
        for (let i = 0; i < hasta; i++) {
            if (src[i] === '{') d++;
            else if (src[i] === '}') d--;
        }
        return d;
    };

    const re = /\bfor\s*\(([^)]*)\)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        count++;
        const cabecera = m[1];
        const tope = cabecera.match(/([<>])=?\s*([0-9]+)\s*(;|\))/);

        if (!tope) {
            errors.push(
                `El bucle "for (${cabecera.trim().slice(0, 40)})" no tiene un tope numérico escrito. ` +
                'Pon un número literal, por ejemplo `for (int i = 0; i < 16; i++)`.'
            );
            continue;
        }

        // Un bucle que cuenta HACIA ATRÁS lleva sus vueltas en la
        // inicialización, no en la comparación. Leyendo sólo el lado derecho,
        // `for (int i = 100000; i > 0; i--)` daba 0: pasaba el tope y contaba
        // como una vuelta. El bucle que se rechaza escrito hacia arriba se
        // colaba entero escrito hacia abajo — justo lo que esto debe impedir.
        const desde = cabecera.match(/=\s*([0-9]+)\s*;/);
        if (tope[1] === '>' && !desde) {
            errors.push(
                `El bucle "for (${cabecera.trim().slice(0, 40)})" cuenta hacia atrás sin un número literal de partida. ` +
                'Pon uno, por ejemplo `for (int i = 16; i > 0; i--)`.'
            );
            continue;
        }

        const vueltas = Math.max(Number(tope[2]), desde ? Number(desde[1]) : 0);
        if (vueltas > MAX_LOOP_ITERATIONS) {
            errors.push(`El bucle da ${vueltas} vueltas; el máximo es ${MAX_LOOP_ITERATIONS}. Con más, la GPU deja de responder.`);
            continue;
        }

        // Multiplicar TODOS los bucles del cuerpo contaba tres seguidos de 16
        // —48 vueltas reales— como 4096: rechazaba un shader barato y encima le
        // hablaba al modelo de un anidamiento que no existía. Sólo multiplica
        // lo que de verdad está dentro de otro.
        const nivel = nivelEn(m.index);
        while (abiertos.length && abiertos[abiertos.length - 1].nivel >= nivel) abiertos.pop();
        const padres = abiertos.reduce((a, b) => a * b.vueltas, 1);
        if (abiertos.length) product -= padres;   // el padre ya se contó suelto
        product += padres * Math.max(1, vueltas);
        abiertos.push({ nivel, vueltas: Math.max(1, vueltas) });
    }

    product = product || 1;

    if (product > MAX_LOOP_PRODUCT) {
        errors.push(
            `Los bucles suman ${product} iteraciones por píxel; el máximo es ${MAX_LOOP_PRODUCT}. ` +
            'Reduce las vueltas o quita un nivel de anidamiento.'
        );
    }
    if (count > 6) warnings.push(`${count} bucles en un shader de capa es mucho; puede ir lento a resolución alta.`);

    return { errors, warnings, count, product };
}

/**
 * Envuelve el cuerpo en un fragment shader completo.
 *
 * Los ayudantes van dentro a propósito, no en una librería aparte: un modelo
 * pequeño usa lo que tiene delante en el prompt y se inventa lo que no, y
 * `noise2` es lo primero que intenta llamar cuando le pides "algo orgánico".
 * Dárselo hecho es más barato que corregirlo después.
 */
export function wrapFragment(body) {
    return `precision highp float;

uniform float uTime;
uniform vec2  uResolution;
uniform float uSeed;
uniform vec3  uColorA;
uniform vec3  uColorB;
uniform vec3  uColorC;

varying vec2 vUv;

float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    return fract(p * (p + p));
}

float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(hash21(i + vec2(0.0, 0.0)), hash21(i + vec2(1.0, 0.0)), u.x),
        mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
        u.y);
}

float fbm2(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
        v += a * noise2(p);
        p *= 2.02;
        a *= 0.5;
    }
    return v;
}

float sdCircle(vec2 p, float r) { return length(p) - r; }

float sdBox(vec2 p, vec2 b) {
    vec2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

mat2 rot2(float a) { return mat2(cos(a), -sin(a), sin(a), cos(a)); }

vec3 palette3(float t) {
    return t < 0.5 ? mix(uColorA, uColorB, t * 2.0) : mix(uColorB, uColorC, (t - 0.5) * 2.0);
}

void main() {
    vec2 uv = vUv;
    vec3 color = vec3(0.0);
    float alpha = 1.0;
    ${MARCA_GLSL}
${indent(body)}

    gl_FragColor = vec4(clamp(color, 0.0, 1.0), clamp(alpha, 0.0, 1.0));
}
`;
}

function indent(body) {
    return String(body ?? '')
        .split('\n')
        .map(l => (l.trim() ? `    ${l}` : ''))
        .join('\n');
}

/**
 * Traduce el error del compilador a algo sobre lo que el modelo pueda actuar.
 *
 * El driver numera las líneas del shader ENVUELTO, y el modelo sólo conoce las
 * suyas. Decirle "error en la línea 78" cuando su cuerpo tiene nueve líneas es
 * garantizar que la siguiente reparación sea peor que la anterior.
 */
export function explainCompileError(rawLog, body, compiledSource = '') {
    // Medido sobre la fuente REALMENTE compilada, no sobre nuestro envoltorio:
    // PlayCanvas le antepone un preámbulo propio cuyo tamaño no controlamos.
    const fuente = String(compiledSource || wrapFragment(body));
    const marca = fuente.split('\n').findIndex(l => l.includes(MARCA_CUERPO));
    const desplazamiento = marca >= 0 ? marca + 1 : 0;
    const cuerpo = String(body ?? '').split('\n');

    const filas = [];
    for (const linea of String(rawLog ?? '').split('\n')) {
        const m = linea.match(/^\s*(?:ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/i);
        if (!m) {
            if (linea.trim()) filas.push(linea.trim());
            continue;
        }
        const enCuerpo = Number(m[1]) - desplazamiento;
        const texto = cuerpo[enCuerpo - 1];
        filas.push(
            enCuerpo >= 1 && enCuerpo <= cuerpo.length
                ? `línea ${enCuerpo} de tu shader ("${(texto || '').trim()}"): ${m[2]}`
                : `${m[2]} (el compilador señala una línea del envoltorio, así que revisa los tipos: casi siempre es mezclar float con vec)`
        );
    }
    return filas.length ? filas.join('\n') : String(rawLog || 'el shader no compiló y el driver no dijo por qué');
}
