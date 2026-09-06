/**
 * Trae el motor de PlayCanvas a `public/vendor/`. Opcional, y sin dependencias.
 *
 *   npm run setup:design
 *
 * ── Por qué esto no rompe la regla de "cero dependencias" ─────────────────
 *
 * Porque no es una dependencia de ejecución del programa: es un recurso del
 * estudio de diseño, que es una sección concreta. `npm start` arranca igual sin
 * él, el agente funciona igual, y el panel de diseño se explica solo cuando
 * falta en lugar de romperse. Es el mismo trato que tiene `public/vendor/` con
 * el cliente de Neutralino, que también vive ahí y también lo trae otro
 * comando.
 *
 * ── Por qué se descarga en vez de venir en el repositorio ─────────────────
 *
 * Son casi dos megas de JavaScript minificado. Meterlos en git significa que
 * cada `git log -p` los arrastra, cada clon los baja aunque nunca abras el
 * estudio, y cada actualización es un diff de una línea de dos megas. Se baja
 * una vez y se queda ignorado.
 *
 * ── Por qué la versión está clavada y se comprueba ────────────────────────
 *
 * Este script descarga código de internet y lo deja donde el navegador lo va a
 * ejecutar. Eso es exactamente lo que `security.js` bloquea cuando lo intenta
 * el modelo, así que aquí, que lo pide el usuario, al menos se hace con las
 * condiciones que uno querría: versión exacta (nada de "latest", que cambia
 * bajo los pies), origen oficial, y el tamaño y el hash a la vista para que
 * puedas compararlos con los de npm si te importa.
 */

import { createWriteStream, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

/** Clavada a propósito. Súbela a mano y vuelve a mirar el hash. */
const VERSION = '2.21.4';
const URL_MOTOR = `https://unpkg.com/playcanvas@${VERSION}/build/playcanvas.mjs`;

const AQUI = nodePath.dirname(fileURLToPath(import.meta.url));
const RAIZ = nodePath.resolve(AQUI, '..');
// Se guarda como .js, no como .mjs, y no es un capricho: AGENTS.md prohíbe
// los .mjs en este proyecto ("todo es .js, la misma extensión en el navegador
// y en Node"), y el servidor sólo declara el MIME de .js — un .mjs sale como
// application/octet-stream y el navegador se niega a ejecutarlo como módulo.
const DESTINO = nodePath.join(RAIZ, 'public', 'vendor', 'playcanvas.js');

/** Por debajo de esto no es el motor, es una página de error disfrazada. */
const MINIMO_BYTES = 300_000;

async function main() {
    const forzar = process.argv.includes('--force');

    if (!forzar) {
        const ya = await fs.stat(DESTINO).catch(() => null);
        if (ya && ya.size > MINIMO_BYTES) {
            console.log(`  ▸ PlayCanvas ya está en public/vendor/ (${Math.round(ya.size / 1024)} KB). Usa --force para rebajarlo.`);
            return;
        }
    }

    console.log(`  ▸ Descargando PlayCanvas ${VERSION}…`);
    console.log(`    ${URL_MOTOR}`);

    const res = await fetch(URL_MOTOR, { redirect: 'follow' });
    if (!res.ok) {
        console.error(`\n  ✗ La descarga devolvió HTTP ${res.status}.\n    Comprueba tu conexión, o baja el archivo a mano y déjalo en:\n    ${DESTINO}\n`);
        process.exit(1);
    }

    await fs.mkdir(nodePath.dirname(DESTINO), { recursive: true });

    // A un archivo temporal primero: si la descarga se corta a la mitad, es
    // mejor no tener nada que tener medio motor que el navegador intentará
    // ejecutar y fallará con un error de sintaxis en la línea 40.000.
    const temporal = `${DESTINO}.parcial`;
    await pipeline(Readable.fromWeb(res.body), createWriteStream(temporal));

    const datos = await fs.readFile(temporal);
    if (datos.length < MINIMO_BYTES) {
        await fs.rm(temporal, { force: true });
        console.error(`\n  ✗ Lo descargado ocupa ${datos.length} bytes: eso no es el motor.\n`);
        process.exit(1);
    }
    if (!datos.includes(Buffer.from('export'))) {
        await fs.rm(temporal, { force: true });
        console.error('\n  ✗ El archivo descargado no parece un módulo ESM.\n');
        process.exit(1);
    }

    await fs.rename(temporal, DESTINO);

    const sha = createHash('sha256').update(datos).digest('hex');
    console.log(`  ▸ Guardado en public/vendor/playcanvas.js (${Math.round(datos.length / 1024)} KB)`);
    console.log(`  ▸ sha256: ${sha}`);
    console.log('\n  Listo. Abre el estudio con el botón "Diseño" de la barra superior.\n');
}

main().catch((err) => {
    console.error('\n  ✗ No se pudo traer PlayCanvas:', err.message, '\n');
    process.exit(1);
});
