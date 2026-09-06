/**
 * ESLint, enganchado a `npm start` y a `npm run build`.
 *
 * Por qué un envoltorio y no `eslint --fix` a secas en el script de npm:
 *
 *  · **`npm start` tiene que funcionar en un clon recién hecho.** Es una
 *    promesa explícita del proyecto (ver AGENTS.md) y el motivo de que no haya
 *    dependencias en tiempo de ejecución. Si `prestart` fuese `eslint --fix`,
 *    clonar y arrancar fallaría con "eslint: not found" antes de servir nada.
 *    Aquí, si ESLint no está instalado se dice y se sigue. El lint es una
 *    comodidad del que desarrolla, no un requisito para ejecutar el programa.
 *
 *  · **`npx eslint` no sirve para esto.** Si el paquete falta, npx se lo baja
 *    de la red — en mitad de un arranque, sin avisar, y fallando en una máquina
 *    sin conexión. Aquí se importa la API de ESLint: si está, se usa; si no,
 *    no pasa nada.
 *
 *  · **Arrancar y construir quieren cosas distintas.** Al arrancar, los errores
 *    que queden se avisan pero no bloquean: tienes que poder levantar la app
 *    justo para depurar aquello de lo que el lint se queja. Al construir sí
 *    bloquean, porque una release no debería llevar código que no pasa el lint.
 *
 *   node scripts/lint.js            comprueba, no toca nada, no bloquea
 *   node scripts/lint.js --fix      corrige lo corregible, no bloquea
 *   node scripts/lint.js --strict   sale con código ≠ 0 si queda algún error
 */

const args = process.argv.slice(2);
const fix = args.includes('--fix');
const strict = args.includes('--strict');

let ESLint;
try {
    ({ ESLint } = await import('eslint'));
} catch (err) {
    // Cualquier otro fallo de import es un problema real y no se traga.
    if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    console.log('  ▸ lint:    ESLint no está instalado; se omite. (npm install)');
    process.exit(0);
}

const eslint = new ESLint({ fix });

let results;
try {
    results = await eslint.lintFiles(['.']);
} catch (err) {
    // Un config roto no puede impedir arrancar la aplicación.
    console.error(`  ▸ lint:    no se pudo ejecutar (${err.message})`);
    process.exit(strict ? 1 : 0);
}

if (fix) await ESLint.outputFixes(results);

const corregidos = results.filter(r => r.output !== undefined).length;
const errores = results.reduce((n, r) => n + r.errorCount, 0);
const avisos = results.reduce((n, r) => n + r.warningCount, 0);

if (errores || avisos) {
    const formatter = await eslint.loadFormatter('stylish');
    console.log(await formatter.format(results));
}

// Una línea cuando todo está bien: el banner del servidor viene justo detrás y
// no debería llegar precedido de media pantalla de nada.
const partes = [];
if (corregidos) partes.push(`${corregidos} archivo(s) corregidos`);
if (errores) partes.push(`${errores} error(es)`);
if (avisos) partes.push(`${avisos} aviso(s)`);
console.log(`  ▸ lint:    ${partes.length ? partes.join(', ') : 'sin problemas'}`);

if (errores && strict) {
    console.error('\n  ✗ Quedan errores de lint. La construcción se detiene aquí.');
    console.error('    Corrígelos, o ejecuta `npm run lint:fix` para lo que sea automático.\n');
    process.exit(1);
}
