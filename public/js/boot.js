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
    }

    // Neutralino's client library is injected by the shell as a global. When it
    // is present we must init() before any native call, and we should exit the
    // process when the window closes — otherwise the native core lingers.
    function initNeutralino() {
        if (!window.Neutralino) return false;
        try {
            window.Neutralino.init();
            window.Neutralino.events.on('windowClose', function () {
                try { window.Neutralino.app.exit(); } catch (e) { /* already going */ }
            });
            return true;
        } catch (err) {
            console.error('Neutralino.init falló', err);
            return false;
        }
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
        'AgentCoder se ejecuta sin compilador ni empaquetador: es JavaScript',
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

    initNeutralino();

    import('./ui/app.js')
        .then(function (mod) { return mod.mountApp(); })
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

            fatal('No se pudo arrancar AgentCoder', [
                String((err && err.message) || err),
                '',
                (err && err.stack) || '',
                '',
                'Comprueba que la carpeta public/js está completa y que la página',
                'se sirve con "npm start" (http://127.0.0.1:4322) o desde el shell',
                'de escritorio con "npm run dev".'
            ].join('\n'));
        });
})();
