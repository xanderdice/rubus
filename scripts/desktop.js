/**
 * Compila la app de escritorio, y opcionalmente la lanza.
 *
 *   node scripts/desktop.js          compila
 *   node scripts/desktop.js --run    compila y abre la aplicación
 *   node scripts/desktop.js --force-setup   vuelve a bajar el framework
 *
 * ── Por qué esto no es un `neu build` a secas en package.json ─────────────
 *
 * Por tres cosas que `neu` no hace y que convertían "no funciona el build" en
 * media hora de mirar dónde:
 *
 *  1. **`neu` sale con código 0 aunque falle.** Comprobado aquí:
 *     `neu build --release` sin el cliente descargado escribe
 *     `ERRR ENOENT ... public\vendor\neutralino.js` y devuelve 0. Encadenado en
 *     un script de npm, eso es un build roto que se reporta como correcto y una
 *     aplicación que no se abre sin ningún error a la vista. Así que aquí no se
 *     mira el código de salida: se mira si el ejecutable EXISTE y si es más
 *     nuevo que el momento en que empezamos.
 *
 *  2. **El framework no viene en el repositorio.** `bin/` (15 MB de binarios de
 *     todas las plataformas) y `public/vendor/neutralino.js` los trae
 *     `neu update`, y están en `.gitignore` porque son artefactos. Si faltan,
 *     esto los baja solo en vez de fallar: era exactamente el estado en el que
 *     estaba el repositorio cuando "dejó de funcionar el build".
 *
 *  3. **Lo que se lanza es lo que se acaba de compilar.** `neu run` no usa
 *     `dist/`: arranca desde `bin/` y la carpeta `public/` viva. Es perfecto
 *     para iterar — y para eso está `npm run dev` — pero entonces "compilar y
 *     ejecutar" estaría compilando una cosa y ejecutando otra.
 */

import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = nodePath.dirname(fileURLToPath(import.meta.url));
const RAIZ = nodePath.resolve(AQUI, '..');

const args = process.argv.slice(2);
const LANZAR = args.includes('--run');
const FORZAR_SETUP = args.includes('--force-setup');

/** El binario de Neutralino que corresponde a esta máquina. */
function plataforma() {
    const arch = process.arch;
    if (process.platform === 'win32') return { sufijo: 'win_x64.exe', etiqueta: 'Windows x64' };
    if (process.platform === 'darwin') {
        return arch === 'arm64'
            ? { sufijo: 'mac_arm64', etiqueta: 'macOS Apple Silicon' }
            : { sufijo: 'mac_x64', etiqueta: 'macOS Intel' };
    }
    if (arch === 'arm64') return { sufijo: 'linux_arm64', etiqueta: 'Linux arm64' };
    if (arch === 'arm') return { sufijo: 'linux_armhf', etiqueta: 'Linux armhf' };
    return { sufijo: 'linux_x64', etiqueta: 'Linux x64' };
}

async function existe(p) {
    try { return await fs.stat(p); } catch { return null; }
}

/** Nombre del ejecutable, leído de la configuración y no adivinado. */
async function nombreBinario() {
    try {
        const cfg = JSON.parse(await fs.readFile(nodePath.join(RAIZ, 'neutralino.config.json'), 'utf8'));
        return (cfg.cli && cfg.cli.binaryName) || 'app';
    } catch {
        return 'app';
    }
}

/**
 * Ejecuta el CLI de Neutralino heredando la consola.
 *
 * Se llama a su archivo con el Node que ya estamos usando, y no a `npx`: en
 * Windows `npx` es un `.cmd`, y desde la corrección de CVE-2024-27980 Node se
 * niega a lanzar un `.cmd` sin `shell: true`. Con `shell:false` no fallaba de
 * forma visible — `spawnSync` devolvía un `error` que este envoltorio no
 * miraba, así que el build "pasaba" sin haber ejecutado nada. Llamar al
 * archivo directamente evita el shell y de paso usa la versión instalada aquí,
 * no la que npx decida resolver.
 */
function neu(...argv) {
    const cli = nodePath.join(RAIZ, 'node_modules', '@neutralinojs', 'neu', 'bin', 'neu.js');
    const r = spawnSync(process.execPath, [cli, ...argv], { cwd: RAIZ, stdio: 'inherit' });
    if (r.error) {
        fatal(
            `No se pudo ejecutar el CLI de Neutralino: ${r.error.message}`,
            'Si falta, instálalo con: npm install'
        );
    }
    return r;
}

function fatal(mensaje, pista) {
    console.error(`\n  ✗ ${mensaje}\n`);
    if (pista) console.error(`    ${pista}\n`);
    process.exit(1);
}

async function main() {
    const { sufijo, etiqueta } = plataforma();
    const binario = await nombreBinario();

    // ── 1. ¿Está el framework? ────────────────────────────────────────────
    const cliente = nodePath.join(RAIZ, 'public', 'vendor', 'neutralino.js');
    const motor = nodePath.join(RAIZ, 'bin', `neutralino-${sufijo}`);
    const falta = FORZAR_SETUP || !(await existe(cliente)) || !(await existe(motor));

    if (falta) {
        console.log(FORZAR_SETUP
            ? '  ▸ Rebajando el framework de Neutralino…'
            : '  ▸ Falta el framework de Neutralino. Bajándolo (una vez)…');
        neu('update');

        if (!(await existe(cliente))) {
            fatal(
                'No se pudo traer el cliente de Neutralino (public/vendor/neutralino.js).',
                'Comprueba la conexión y vuelve a intentarlo con: npm run setup'
            );
        }
        if (!(await existe(motor))) {
            fatal(
                `No se descargó el binario para ${etiqueta} (bin/neutralino-${sufijo}).`,
                'Comprueba la conexión y vuelve a intentarlo con: npm run setup'
            );
        }
    }

    // ── 2. Compilar ───────────────────────────────────────────────────────
    const destino = nodePath.join(RAIZ, 'dist', binario, `${binario}-${sufijo}`);
    const antes = await existe(destino);
    const empezado = Date.now();

    console.log(`  ▸ Compilando la app de escritorio para ${etiqueta}…`);
    neu('build', '--release');

    // El código de salida de `neu` no sirve: devuelve 0 aunque haya escrito
    // ERRR y no haya generado nada. Lo que sí sirve es el archivo.
    const despues = await existe(destino);
    if (!despues) {
        fatal(
            `El build terminó pero no hay ejecutable en dist/${binario}/.`,
            'Mira el ERRR de arriba: `neu` informa de sus errores por consola pero sale con código 0.'
        );
    }
    if (antes && despues.mtimeMs <= antes.mtimeMs) {
        fatal(
            'El ejecutable no se ha regenerado: el build falló y dejó el anterior.',
            `Es de hace ${Math.round((empezado - despues.mtimeMs) / 1000)} s. Mira el ERRR de arriba.`
        );
    }

    const mb = (despues.size / 1048576).toFixed(1);
    console.log(`  ▸ Listo: dist/${binario}/${binario}-${sufijo} (${mb} MB)`);

    if (!LANZAR) {
        console.log('\n  Para abrirla:  npm start\n  Para iterar sin compilar:  npm run dev\n');
        return;
    }

    // ── 3. Lanzar lo que se acaba de compilar ─────────────────────────────
    console.log('  ▸ Abriendo la aplicación…  (Ctrl+C para cerrarla)\n');

    const app = spawn(destino, [], {
        cwd: nodePath.dirname(destino),
        stdio: 'inherit',
        windowsHide: false
    });

    // Ctrl+C en la terminal tiene que cerrar la ventana, no dejarla huérfana
    // con la consola ya devuelta al usuario.
    const cerrar = () => { try { app.kill(); } catch { /* ya cerrada */ } };
    process.on('SIGINT', cerrar);
    process.on('SIGTERM', cerrar);

    app.on('error', (err) => fatal(`No se pudo abrir la aplicación: ${err.message}`));
    app.on('close', (code) => {
        console.log(`\n  ▸ La aplicación se cerró (código ${code ?? 0}).`);
        process.exit(code || 0);
    });
}

main().catch((err) => fatal(String(err && err.message || err)));
