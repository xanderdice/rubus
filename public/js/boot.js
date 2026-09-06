/**
 * Boot loader.
 *
 * Not a module script: it dynamic-imports the app so that a syntax error or a
 * missing file becomes a readable message in the window instead of a blank
 * screen and a console nobody is going to open. In a packaged desktop app there
 * is no address bar and no obvious devtools, so an unhandled boot failure is
 * indistinguishable from a crash.
 */

(function boot() {
    'use strict';

    function fatal(title, detail) {
        document.body.innerHTML = '';
        var wrap = document.createElement('div');
        wrap.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
            'background:#04070a;color:#8fa6b1;font:12px ui-monospace,Consolas,monospace;padding:40px;';

        var box = document.createElement('div');
        box.style.cssText = 'max-width:640px;border:1px solid rgba(255,120,110,.5);padding:20px;background:rgba(255,120,110,.05)';

        var h = document.createElement('div');
        h.style.cssText = 'color:#ff786e;letter-spacing:.14em;text-transform:uppercase;margin-bottom:12px';
        h.textContent = title;

        var p = document.createElement('pre');
        p.style.cssText = 'white-space:pre-wrap;line-height:1.7;color:#8fa6b1;margin:0';
        p.textContent = detail;

        box.appendChild(h);
        box.appendChild(p);
        wrap.appendChild(box);
        document.body.appendChild(wrap);

        // En la app empaquetada no hay consola a la vista, así que la única
        // copia de un fallo de arranque está en una ventana que el usuario va a
        // cerrar. Se duplica al log nativo, que ya existe y ya se escribe a
        // disco (`neutralinojs.log`, junto al ejecutable).
        try {
            var anotado = window.Neutralino.debug.log(title + '\n\n' + detail, 'ERROR');
            if (anotado && anotado.catch) anotado.catch(function () { /* el log no puede romper el arranque */ });
        } catch { /* no estamos en el shell */ }
    }

    // Neutralino's client library is injected by the shell as a global. When it
    // is present we must init() before any native call, and we should exit the
    // process when the window closes — otherwise the native core lingers.
    function initNeutralino() {
        if (!window.Neutralino) return false;
        try {
            window.Neutralino.init();
            window.Neutralino.events.on('windowClose', function () {
                try { window.Neutralino.app.exit(); } catch { /* already going */ }
            });
            return true;
        } catch (err) {
            console.error('Neutralino.init falló', err);
            return false;
        }
    }

    var nucleoCaido = false;

    /**
     * Desarma el borrado de página del cliente de Neutralino.
     *
     * `Neutralino.init()` deja armados dos manejadores que, ante un fallo del
     * socket contra el núcleo, hacen `document.body.innerText = ''` y acto
     * seguido `document.write(...)`: NE_CL_IVCTOKN si no consigue conectar, y
     * NE_RT_INVTOKN si el núcleo rechaza el token en cualquier llamada nativa
     * posterior. Con el documento ya analizado ese `write` implica un
     * `document.open()`, así que no añade nada: destruye la página entera.
     *
     * El archivo del cliente no se puede parchear — está en `.gitignore` y
     * `neu update` lo reescribe — así que se intercepta aquí el `write`, que
     * es su último paso, y se cambia un código de error desnudo por una
     * explicación. La página ya está perdida cuando llegamos, porque el
     * `innerText = ''` ocurrió una línea antes; lo que se gana es decir qué ha
     * pasado. Y sirve también DESPUÉS del arranque, que es cuando
     * NE_RT_INVTOKN se lleva por delante una sesión de trabajo entera.
     */
    function protegerDocumento() {
        if (!window.Neutralino) return;

        document.write = function (texto) {
            nucleoCaido = true;
            var codigo = /NE_[A-Z_]+/.exec(String(texto || ''));
            fatal('Se ha perdido la conexión con el núcleo de Neutralino', [
                'El cliente no ha podido hablar con el proceso nativo que da',
                'acceso a los archivos y a la terminal' + (codigo ? ' (' + codigo[0] + ')' : '') + ',',
                'y ha borrado la página al fallar.',
                '',
                'Cierra la ventana y vuelve a abrirla con "npm start". Recargar',
                'no sirve: el token se entrega una sola vez.',
                '',
                'El detalle está en dist/rubus/neutralinojs.log.'
            ].join('\n'));
        };
        document.writeln = document.write;
    }

    /**
     * Espera a que el shell haya conectado con su núcleo antes de montar nada.
     *
     * El cliente de Neutralino, cuando el WebSocket contra el núcleo da error,
     * hace `document.body.innerText = ''` y acto seguido `document.write(...)`
     * — es decir, BORRA el documento — y lo hace de forma asíncrona, cuando
     * index.html ya está parseado y este archivo ya ha lanzado su import().
     * El montaje se encontraba entonces un documento vacío y reventaba en el
     * primer elemento que buscase, con un «Cannot read properties of null»
     * que señalaba a VirtualScroller en lugar de a la causa. Costó una tarde.
     *
     * En el navegador no pasa porque `Neutralino.init()` lanza antes de llegar
     * ahí (no hay NL_PORT, la URL del WebSocket es inválida), así que ese
     * manejador destructivo no se llega a instalar.
     *
     * Se espera al evento `ready`, que el cliente dispara al abrirse el
     * WebSocket. Si no llega y además el documento ha desaparecido bajo
     * nuestros pies, se dice lo que de verdad ha ocurrido.
     */
    var ESPERA_NUCLEO = 6000;

    function nucleoListo(enElShell) {
        if (!enElShell) return Promise.resolve(true);

        return new Promise(function (resolve) {
            var resuelto = false;
            function decidir(conectado) {
                if (resuelto) return;
                resuelto = true;
                resolve(conectado);
            }

            try {
                window.Neutralino.events.on('ready', function () { decidir(true); });
            } catch {
                decidir(true);   // sin eventos no hay nada que esperar; que monte.
                return;
            }
            setTimeout(function () { decidir(false); }, ESPERA_NUCLEO);
        }).then(function (conectado) {
            // Si el interceptor ya explicó lo ocurrido, no lo pisamos.
            if (nucleoCaido) return false;

            // El documento vacío es la firma del borrado: `innerText = ''` deja
            // el body sin un solo hijo. Si sigue entero, lo único que ha pasado
            // es que no vimos el evento; que monte y falle solo si acaso.
            var vaciado = !document.body || document.body.children.length === 0;
            if (conectado || !vaciado) return true;

            fatal('No se pudo conectar con el núcleo de Neutralino', [
                'La ventana ha abierto, pero el cliente no ha conseguido hablar con',
                'el proceso nativo que le da acceso a los archivos y a la terminal,',
                'y ha borrado la página al fallar (NE_CL_IVCTOKN).',
                '',
                'Suele ser un token ya consumido: cierra la ventana y vuelve a',
                'abrirla con "npm start". Recargar la página no sirve, porque el',
                'token se entrega una sola vez.',
                '',
                'Si se repite, el detalle está en dist/rubus/neutralinojs.log.'
            ].join('\n'));
            return false;
        });
    }

    /**
     * Capability gate.
     *
     * Runtime APIs only — deliberately NO syntax probing.
     *
     * The obvious way to test for ES2020 syntax is `new Function('o?.a')`, and
     * it is wrong here: this page ships a strict CSP with `script-src 'self'`,
     * which blocks eval and new Function outright. The probe therefore throws
     * on every modern browser and reports the opposite of the truth. (It did,
     * for exactly one commit.)
     *
     * Syntax support is established the honest way instead: if the browser
     * cannot parse the modules, the dynamic import below rejects with a
     * SyntaxError, and that is reported as "browser too old" there.
     */
    function missingFeatures() {
        var missing = [];

        if (typeof fetch !== 'function') missing.push('fetch');
        if (typeof Promise !== 'function') missing.push('Promise');
        if (typeof Map !== 'function' || typeof Set !== 'function') missing.push('Map / Set');
        if (typeof Symbol !== 'function') missing.push('Symbol');
        if (typeof AbortController !== 'function') missing.push('AbortController');
        if (typeof TextDecoder !== 'function') missing.push('TextDecoder');
        if (typeof globalThis === 'undefined') missing.push('globalThis (ES2020)');
        if (typeof Object.entries !== 'function') missing.push('Object.entries');
        if (typeof Array.prototype.includes !== 'function') missing.push('Array.includes');
        if (!window.localStorage) missing.push('localStorage');
        if (!window.CSS || !CSS.supports || !CSS.supports('display', 'grid')) missing.push('CSS grid');

        return missing;
    }

    var TOO_OLD = [
        'Rubus se ejecuta sin compilador ni empaquetador: es JavaScript',
        'moderno tal cual, y necesita un navegador de 2020 en adelante',
        '(Chrome 80+, Firefox 74+, Safari 13.1+, Edge 80+, o cualquier versión',
        'actual de Chrome/Firefox/Safari/Edge en móvil).',
        '',
        'Actualiza el navegador, o usa la aplicación de escritorio.'
    ].join('\n');

    window.addEventListener('error', function (e) {
        console.error('[boot] error no capturado', e.error || e.message);
    });
    window.addEventListener('unhandledrejection', function (e) {
        console.error('[boot] promesa rechazada', e.reason);
    });

    var missing = missingFeatures();
    if (missing.length) {
        fatal('Navegador no compatible', [
            'A este navegador le faltan funciones que la aplicación necesita:',
            '',
            '  · ' + missing.join('\n  · '),
            '',
            TOO_OLD
        ].join('\n'));
        return;
    }

    // La red de seguridad, puesta antes de que el cliente pueda fallar.
    protegerDocumento();

    nucleoListo(initNeutralino())
        .then(function (seguir) {
            if (!seguir) return undefined;   // ya se ha explicado en pantalla
            return import('./ui/app.js').then(function (mod) { return mod.mountApp(); });
        })
        .catch(function (err) {
            // A SyntaxError here means the browser could not PARSE the modules,
            // which is the "too old" case the feature check cannot see without
            // eval. Anything else is a genuine load or startup failure.
            var isSyntax = err && (err.name === 'SyntaxError'
                || /unexpected token|unexpected identifier|invalid or unexpected/i.test(String(err.message || '')));

            if (isSyntax) {
                fatal('Navegador no compatible', [
                    'Este navegador no puede interpretar el código de la aplicación:',
                    '',
                    '  ' + String((err && err.message) || err),
                    '',
                    TOO_OLD
                ].join('\n'));
                return;
            }

            fatal('No se pudo arrancar Rubus', [
                String((err && err.message) || err),
                '',
                (err && err.stack) || '',
                '',
                'Comprueba que la carpeta public/js está completa y que la página',
                'se sirve con "npm run serve" (http://127.0.0.1:4322) o desde el shell',
                'de escritorio con "npm start".'
            ].join('\n'));
        });
})();
