/**
 * Buscar y leer en internet.
 *
 * Existe porque el modelo lo pedía a gritos: en su propio razonamiento se leía
 * «There is NO google_search or browse_website tool listed», y a partir de ahí
 * hacía lo peor que puede hacer un modelo pequeño — inventarse la firma de la
 * API que no podía consultar. Un agente que no puede leer la documentación la
 * recuerda mal, y recordar mal se parece mucho a mentir.
 *
 * Dos herramientas y no una, porque son dos cosas:
 *
 *   search_web  descubre DÓNDE está la respuesta. Devuelve título, URL y un
 *               fragmento — muchas veces con eso basta y no hace falta abrir
 *               nada, que en un contexto de 32k es la diferencia entre poder
 *               seguir y no.
 *   fetch_url   lee UNA página y la devuelve como texto, nunca como HTML.
 *
 * ── Se pide permiso, como con la shell ────────────────────────────────────
 *
 * Salir a la red es un efecto hacia fuera: manda una consulta con lo que el
 * modelo haya decidido escribir a un servidor de un tercero. `security.js`
 * clasifica `curl` como peligroso por esto mismo, y sería incoherente que la
 * versión cómoda no pasara por ninguna puerta. Así que se rige por el mismo
 * `approvalPolicy` que todo lo demás: en 'auto' sale y lo deja anotado, en
 * 'manual' pregunta una vez por dominio.
 */

import { approvalPolicy } from '../config.js';
import { truncateMiddle, toolProgress } from '../util.js';
import {
    validateUrl, buildSearchUrl, htmlToText, extractTitle,
    parseSearchResults, DEFAULT_SEARCH, MAX_PAGE_CHARS
} from '../web.js';

/** Un dominio aprobado lo está para toda la ejecución, no para cada página. */
function dominiosAprobados(ctx) {
    if (!ctx._webApproved) ctx._webApproved = new Map();
    return ctx._webApproved;
}

/**
 * Puerta común. Devuelve null si se puede seguir, o un resultado de error.
 *
 * El permiso es POR DOMINIO y no por URL: leer ocho páginas de la
 * documentación de React son ocho diálogos si se pregunta por cada una, y el
 * octavo ya nadie lo lee.
 */
async function permitir(ctx, host, para) {
    const policy = approvalPolicy(ctx.config);
    const cache = dominiosAprobados(ctx);

    if (cache.has(host)) {
        return cache.get(host) ? null : rechazado(host);
    }

    if (policy.auto) {
        cache.set(host, true);
        // Sin diálogo, pero con rastro: lo que sale de tu máquina hacia fuera
        // se anota, igual que un comando destructivo sin confirmar.
        ctx.logger?.info(`Salida a internet sin confirmar: ${host} (${para})`);
        return null;
    }

    const ok = !!(await ctx.requestApproval({
        kind: 'web',
        risk: 'caution',
        title: 'Salir a internet',
        detail:
            `El agente quiere conectarse a ${host} para ${para}.\n\n` +
            'Se enviará la consulta a ese servidor y se leerá su respuesta. ' +
            'Se pregunta una vez por dominio y por ejecución.',
        command: host
    }));

    cache.set(host, ok);
    return ok ? null : rechazado(host);
}

function rechazado(host) {
    return {
        ok: false,
        summary: `Sin permiso para conectarse a ${host}.`,
        detail: 'El usuario ha rechazado esa conexión. No vuelvas a intentarlo con ese dominio: resuelve el paso con lo que hay en el proyecto, o termina explicando qué te falta.'
    };
}

/** Pide una URL usando la plataforma. Nunca lanza. */
async function traer(ctx, url, { timeoutMs = 20000 } = {}) {
    if (typeof ctx.platform.webFetch !== 'function') {
        return { ok: false, error: 'Esta plataforma no puede salir a internet.' };
    }
    return await ctx.platform.webFetch(url, { timeoutMs, signal: ctx.signal });
}

export const searchWeb = {
    name: 'search_web',
    title: 'Buscar en internet',
    description: 'Busca en internet y devuelve títulos, URLs y un fragmento de cada resultado. Úsalo para encontrar documentación, mensajes de error o el uso correcto de una API.',
    readOnly: true,
    mutates: false,
    params: {
        query: { type: 'string', required: true, description: 'Qué buscar. Escríbelo como lo escribirías en un buscador.' },
        max_results: { type: 'integer', required: false, default: 6, min: 1, max: 15, description: 'Cuántos resultados devolver.' }
    },
    examples: [{ args: { query: 'playcanvas ShaderMaterial vertexGLSL example' } }],

    async run(args, ctx) {
        const query = String(args.query || '').trim();
        if (query.length < 2) return { ok: false, summary: 'La búsqueda necesita al menos dos caracteres.' };

        const endpoint = ctx.config.get('tools.searchEndpoint', DEFAULT_SEARCH);
        const url = buildSearchUrl(query, endpoint);
        const check = validateUrl(url);
        if (!check.ok) return { ok: false, summary: `El buscador configurado no vale: ${check.reason}` };

        const veto = await permitir(ctx, check.host, `buscar "${truncateMiddle(query, 80)}"`);
        if (veto) return veto;

        const prog = toolProgress(ctx)(`Buscando "${query}"…`, { indeterminate: true });
        const res = await traer(ctx, check.url);
        prog.done();

        if (!res.ok) {
            return {
                ok: false,
                summary: `No se pudo buscar: ${res.error}`,
                detail: 'Puede que no haya conexión. Si el paso se puede resolver con lo que ya hay en el proyecto, hazlo así; si no, dilo y termina el paso.'
            };
        }

        const resultados = parseSearchResults(res.body, { limit: args.max_results || 6 });

        if (!resultados.length) {
            // Se distingue "no hay nada" de "no he sabido leer la respuesta":
            // esto es raspado de HTML y el día que cambie el formato, el
            // síntoma sería idéntico al de una consulta sin resultados.
            const parece = /result__a|result__snippet/i.test(res.body);
            return {
                ok: true,
                summary: parece ? `Sin resultados para "${query}".` : 'El buscador respondió algo que no se pudo interpretar.',
                detail: parece
                    ? 'Prueba con otras palabras, más concretas o en inglés — la documentación técnica casi siempre está en inglés.'
                    : `Se recibieron ${res.body.length} caracteres del buscador pero no traían resultados reconocibles. ` +
                      'Puede que el formato haya cambiado, o que haya una página intermedia. Usa fetch_url con una URL que ya conozcas.',
                data: { results: [] }
            };
        }

        const filas = resultados.map((r, i) =>
            `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${truncateMiddle(r.snippet, 300)}` : ''}`
        );

        return {
            ok: true,
            summary: `${resultados.length} resultado(s) para "${query}"`,
            detail: `${filas.join('\n\n')}\n\nAbre el que parezca útil con fetch_url. Muchas veces el fragmento ya basta.`,
            data: { results: resultados }
        };
    }
};

export const fetchUrl = {
    name: 'fetch_url',
    title: 'Leer una página web',
    description: 'Descarga una página y devuelve su texto, sin HTML. Úsalo para leer documentación o una respuesta concreta que hayas encontrado con search_web.',
    readOnly: true,
    mutates: false,
    params: {
        url: { type: 'string', required: true, description: 'La dirección completa, empezando por https://' },
        max_chars: { type: 'integer', required: false, default: MAX_PAGE_CHARS, min: 500, max: 40000, description: 'Cuánto texto devolver como máximo.' }
    },
    examples: [{ args: { url: 'https://developer.mozilla.org/en-US/docs/Web/API/AbortController' } }],

    async run(args, ctx) {
        const check = validateUrl(args.url);
        if (!check.ok) {
            return {
                ok: false,
                summary: 'URL no válida.',
                detail: `${check.reason}\nUsa una dirección pública completa, por ejemplo https://developer.mozilla.org/…`
            };
        }

        const veto = await permitir(ctx, check.host, `leer ${truncateMiddle(check.url, 100)}`);
        if (veto) return veto;

        const prog = toolProgress(ctx)(`Leyendo ${check.host}…`, { indeterminate: true });
        const res = await traer(ctx, check.url, { timeoutMs: 30000 });
        prog.done();

        if (!res.ok) {
            return {
                ok: false,
                summary: `No se pudo leer ${check.host}: ${res.error}`,
                detail: 'Comprueba la dirección, o prueba con otro resultado de la búsqueda.'
            };
        }

        if (res.status >= 400) {
            return {
                ok: false,
                summary: `${check.host} respondió ${res.status}.`,
                detail: res.status === 404
                    ? 'Esa página no existe. Busca la dirección correcta con search_web en vez de adivinarla.'
                    : `El servidor devolvió ${res.status}. Puede que pida sesión o que esté bloqueando peticiones automáticas.`
            };
        }

        const esHtml = /text\/html|application\/xhtml/i.test(res.contentType || '');
        const texto = esHtml
            ? htmlToText(res.body, { maxChars: args.max_chars || MAX_PAGE_CHARS })
            : truncateMiddle(res.body, args.max_chars || MAX_PAGE_CHARS);
        const titulo = esHtml ? extractTitle(res.body) : '';

        if (!texto.trim()) {
            return {
                ok: false,
                summary: `${check.host} no devolvió texto legible.`,
                detail: 'La página puede estar generada por JavaScript, que aquí no se ejecuta. Busca una versión en texto plano, el README del repositorio, o la documentación oficial.'
            };
        }

        return {
            ok: true,
            summary: `${titulo || check.host} — ${texto.length} caracteres`,
            detail: `${titulo ? `TÍTULO: ${titulo}\n` : ''}URL: ${check.url}\n\n${texto}`,
            data: { url: check.url, title: titulo, chars: texto.length, status: res.status }
        };
    }
};
