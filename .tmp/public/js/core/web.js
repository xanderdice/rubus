/**
 * La red, con la misma desconfianza que la shell.
 *
 * `security.js` clasifica `curl` y `wget` como peligrosos porque "descarga
 * contenido de la red". Darle al modelo una herramienta para leer páginas es
 * exactamente esa capacidad con mejor interfaz, así que se trata igual: se
 * comprueba en código lo que no se le puede pedir por prompt.
 *
 * ── Lo que de verdad hay que impedir ──────────────────────────────────────
 *
 * No es que el modelo lea una página cualquiera de internet: para eso está.
 * Es que la lea de la RED DE DENTRO. Una URL es una cadena, y el modelo la
 * escribe:
 *
 *   http://169.254.169.254/latest/meta-data/iam/security-credentials/
 *   http://127.0.0.1:11434/api/tags        · el propio Ollama
 *   http://192.168.1.1/admin               · el router
 *   http://localhost:8080/actuator/env     · lo que tengas levantado
 *
 * En modo local eso ya es feo. En modo remoto —donde `server.js` hace de proxy
 * y el cliente es cualquiera— es un SSRF con todas las letras: el atacante
 * escribe la URL y el servidor la pide desde DENTRO de tu red. Por eso la
 * comprobación vive aquí, en un módulo puro que usan los dos lados, y el
 * servidor la repite sobre la IP ya resuelta: un nombre público puede apuntar
 * a 127.0.0.1 y el DNS no se lo pregunta a nadie.
 *
 * ── Y lo que se devuelve es texto ─────────────────────────────────────────
 *
 * Nunca HTML. Un modelo pequeño con 32k de contexto no puede permitirse una
 * página de documentación con sus scripts, su navegación y sus banners: son
 * cincuenta mil tokens de los cuales sirven cuatrocientos. `htmlToText` no
 * intenta ser un navegador, intenta que quepa.
 */

/** Nada más grande llega al modelo; el resto se recorta por el medio. */
export const MAX_PAGE_CHARS = 12000;

/** Tope de bytes que se descargan, antes siquiera de convertir a texto. */
export const MAX_FETCH_BYTES = 3 * 1024 * 1024;

/** Buscador por defecto: sin clave de API y sin cuenta. */
export const DEFAULT_SEARCH = 'https://html.duckduckgo.com/html/?q={q}';

/**
 * Nombres que nunca salen de la máquina o de la red local.
 * Se comprueban además de las IPs porque casi nadie escribe `127.0.0.1`.
 */
const HOSTS_INTERNOS = [
    /^localhost$/i,
    /\.localhost$/i,
    /\.local$/i,
    /\.internal$/i,
    /\.home$/i,
    /\.lan$/i,
    /^metadata\.google\.internal$/i
];

/** ¿Es una IPv4 escrita como tal? Devuelve los cuatro octetos o null. */
function ipv4(host) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) return null;
    const o = m.slice(1).map(Number);
    return o.every(n => n >= 0 && n <= 255) ? o : null;
}

/**
 * ¿Esta dirección pertenece a una red que no debería salir de casa?
 *
 * Acepta IPv4, IPv6 y el híbrido `::ffff:10.0.0.1`, que es la forma más fácil
 * de escribir una dirección privada y que parezca IPv6.
 */
export function isPrivateAddress(address) {
    const raw = String(address ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (!raw) return true;

    const v4 = ipv4(raw);
    if (v4) {
        const [a, b] = v4;
        if (a === 0 || a === 127) return true;                     // esta máquina
        if (a === 10) return true;                                 // privada
        if (a === 172 && b >= 16 && b <= 31) return true;          // privada
        if (a === 192 && b === 168) return true;                   // privada
        if (a === 169 && b === 254) return true;                   // enlace local y metadatos de nube
        if (a === 100 && b >= 64 && b <= 127) return true;         // CGNAT
        if (a === 192 && b === 0) return true;                     // IETF
        if (a === 198 && (b === 18 || b === 19)) return true;       // pruebas de rendimiento
        if (a >= 224) return true;                                  // multicast y reservadas
        return false;
    }

    // IPv4 embebida en IPv6, en sus dos formas.
    //
    // La segunda no es rebuscada: `new URL()` NORMALIZA el host, así que
    // `[::ffff:127.0.0.1]` llega aquí convertido en `::ffff:7f00:1` y la forma
    // con puntos no se ve nunca desde validateUrl. Comprobar sólo la legible
    // dejaba pasar el localhost escrito así, que es justo como lo escribiría
    // alguien que sabe lo que hace.
    const conPuntos = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(raw);
    if (conPuntos) return isPrivateAddress(conPuntos[1]);

    const enHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(raw);
    if (enHex) {
        const alto = parseInt(enHex[1], 16);
        const bajo = parseInt(enHex[2], 16);
        return isPrivateAddress(`${alto >> 8}.${alto & 255}.${bajo >> 8}.${bajo & 255}`);
    }

    if (raw.includes(':')) {
        if (raw === '::' || raw === '::1') return true;             // sin especificar / esta máquina
        if (/^f[cd][0-9a-f]{2}:/.test(raw)) return true;            // únicas locales (fc00::/7)
        if (/^fe[89ab][0-9a-f]:/.test(raw)) return true;            // enlace local (fe80::/10)
        return false;
    }

    return false;   // no es una IP literal: lo decide el nombre
}

/**
 * Valida una URL escrita por el modelo.
 *
 * Devuelve `{ok, url, host}` o `{ok:false, reason}` con un motivo redactado
 * para que el modelo pueda corregirlo por sí mismo en el turno siguiente.
 */
export function validateUrl(input) {
    const raw = String(input ?? '').trim();
    if (!raw) return { ok: false, reason: 'La URL está vacía.' };

    // Sin esquema casi siempre significa "www.algo.com": se asume https en vez
    // de rechazarlo, porque rechazarlo cuesta un turno entero para nada.
    const conEsquema = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;

    let url;
    try { url = new URL(conEsquema); }
    catch { return { ok: false, reason: `"${raw}" no es una URL válida.` }; }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, reason: `Sólo se admiten http y https, no "${url.protocol}".` };
    }
    if (url.username || url.password) {
        return { ok: false, reason: 'No se admiten URLs con usuario y contraseña dentro.' };
    }

    const host = url.hostname.toLowerCase();
    if (!host) return { ok: false, reason: 'La URL no tiene servidor.' };

    if (HOSTS_INTERNOS.some(re => re.test(host))) {
        return { ok: false, reason: `"${host}" es un nombre de la red local. Esta herramienta sólo llega a internet.` };
    }
    if (isPrivateAddress(host)) {
        return { ok: false, reason: `${host} es una dirección de red privada o local, y no se puede pedir desde aquí.` };
    }

    return { ok: true, url: url.href, host, origin: url.origin };
}

/** La URL de búsqueda, con la consulta ya codificada. */
export function buildSearchUrl(query, endpoint = DEFAULT_SEARCH) {
    const q = encodeURIComponent(String(query ?? '').trim());
    return String(endpoint).includes('{q}')
        ? String(endpoint).replace('{q}', q)
        : `${endpoint}${endpoint.includes('?') ? '&' : '?'}q=${q}`;
}

/** Entidades HTML que aparecen de verdad. No hace falta la tabla entera. */
const ENTIDADES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–',
    mdash: '—', hellip: '…', laquo: '«', raquo: '»', ldquo: '"', rdquo: '"',
    lsquo: '‘', rsquo: '’', eacute: 'é', aacute: 'á', iacute: 'í',
    oacute: 'ó', uacute: 'ú', ntilde: 'ñ', copy: '©', reg: '®', deg: '°'
};

export function decodeEntities(text) {
    return String(text ?? '')
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
        .replace(/&([a-z]+);/gi, (m, name) => ENTIDADES[name.toLowerCase()] ?? m);
}

function safeChar(code) {
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

/**
 * HTML a texto legible.
 *
 * No es un navegador y no lo pretende. Tira lo que nunca ayuda —script, style,
 * nav, footer, svg—, conserva los saltos de bloque para que el resultado no
 * sea un párrafo de mil líneas, y respeta el contenido de `pre` y `code`
 * porque en documentación técnica el ejemplo de código ES la respuesta.
 */
export function htmlToText(html, { maxChars = MAX_PAGE_CHARS } = {}) {
    let s = String(html ?? '');

    // Fuera lo que no es contenido, con su contenido dentro.
    s = s.replace(/<(script|style|noscript|template|svg|iframe|canvas)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    // Barras de navegación y pies: en documentación son la mitad del HTML.
    s = s.replace(/<(nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');

    // Los bloques dejan salto; el resto desaparece sin dejar hueco.
    s = s.replace(/<\/(p|div|section|article|h[1-6]|li|tr|pre|blockquote|table)>/gi, '\n');
    s = s.replace(/<(br|hr)\s*\/?>/gi, '\n');
    s = s.replace(/<li\b[^>]*>/gi, '\n· ');
    s = s.replace(/<h([1-6])\b[^>]*>/gi, '\n\n');
    s = s.replace(/<[^>]+>/g, '');

    s = decodeEntities(s);

    // Espacios: se colapsan dentro de la línea, pero no se juntan párrafos.
    // El espacio duro va escrito como \u00a0 y no como carácter: literal es un
    // "espacio irregular" que en el editor no se distingue de uno normal.
    s = s.replace(/[ \t\u00a0]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    if (s.length <= maxChars) return s;
    // Por el medio: la cabecera dice de qué va y el final suele traer el
    // ejemplo o las notas, y lo de en medio es índice y relleno.
    const mitad = Math.floor((maxChars - 60) / 2);
    return `${s.slice(0, mitad)}\n\n… [${s.length - mitad * 2} caracteres omitidos] …\n\n${s.slice(-mitad)}`;
}

/** El `<title>` de la página, si lo hay. */
export function extractTitle(html) {
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ''));
    return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

/**
 * Saca los resultados del HTML del buscador.
 *
 * DuckDuckGo envuelve cada enlace en un redirector propio
 * (`/l/?uddg=<url codificada>`), así que hay que desenvolverlo o el modelo
 * recibe veinte URLs de duckduckgo.com y ninguna sirve.
 *
 * Esto es raspado, con lo que eso implica: el día que cambien el HTML, deja de
 * encontrar resultados. Por eso la herramienta distingue "cero resultados" de
 * "no he sabido leer la respuesta" — son dos problemas distintos y el segundo
 * no es culpa de la consulta.
 */
export function parseSearchResults(html, { limit = 8 } = {}) {
    const s = String(html ?? '');
    const salida = [];
    const vistas = new Set();

    const enlaces = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const fragmentos = [...s.matchAll(/<a\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)]
        .map(m => limpiar(m[1]));

    let m;
    let i = 0;
    while ((m = enlaces.exec(s)) !== null && salida.length < limit) {
        const url = desenvolver(m[1]);
        const titulo = limpiar(m[2]);
        i++;
        if (!url || !titulo) continue;

        const check = validateUrl(url);
        if (!check.ok) continue;                       // resultado a una IP interna: fuera
        if (vistas.has(check.url)) continue;
        vistas.add(check.url);

        salida.push({ title: titulo, url: check.url, snippet: fragmentos[i - 1] || '' });
    }

    return salida;
}

function limpiar(html) {
    return decodeEntities(String(html).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/** `//duckduckgo.com/l/?uddg=https%3A%2F%2Fx.com%2F` → `https://x.com/`. */
function desenvolver(href) {
    const raw = String(href || '').trim();
    if (!raw) return '';
    const uddg = /[?&]uddg=([^&]+)/.exec(raw);
    if (uddg) {
        try { return decodeURIComponent(uddg[1]); } catch { return ''; }
    }
    if (raw.startsWith('//')) return `https:${raw}`;
    return raw;
}
