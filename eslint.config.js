/**
 * ESLint — las convenciones de AGENTS.md, comprobadas en vez de recordadas.
 *
 * Dos trabajos, y el segundo es el que de verdad importa:
 *
 *  1. Estilo. 4 espacios, comillas simples, punto y coma. Todo eso es
 *     auto-corregible, así que nadie debería volver a pensar en ello ni a
 *     comentarlo en una revisión.
 *
 *  2. **La regla dura.** `public/js/core/**` es el motor y no puede importar
 *     nada del DOM, de Neutralino ni de Node. Esa separación es lo que permite
 *     que `cli/headless.js` ejecute el mismo motor sin interfaz, que es la
 *     única forma de probar el arnés de verdad. Estaba escrita en AGENTS.md y
 *     confiada a la disciplina; aquí pasa a estar comprobada. Un `import`
 *     prohibido o un `document` suelto en core/ ahora es un error, no una
 *     erosión que se descubre el día que headless deja de arrancar.
 *
 * El límite se impone de dos maneras a la vez, porque cada una tapa un agujero
 * de la otra: `no-restricted-imports` para los módulos, y una lista de globales
 * deliberadamente corta para que `no-undef` cace el `window` o el `process` que
 * no pasó por ningún import.
 */

import js from '@eslint/js';
import globals from 'globals';

/**
 * Lo que existe en el navegador Y en Node. Es el único vocabulario que core/
 * tiene permitido dar por hecho — los globales de ECMAScript (Math, JSON,
 * Promise…) los aporta `ecmaVersion` y no hacen falta aquí.
 */
const UNIVERSAL = {
    console: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
    queueMicrotask: 'readonly',
    structuredClone: 'readonly',
    TextEncoder: 'readonly',
    TextDecoder: 'readonly',
    AbortController: 'readonly',
    AbortSignal: 'readonly',
    fetch: 'readonly',
    URL: 'readonly',
    URLSearchParams: 'readonly',
    performance: 'readonly',
    globalThis: 'readonly'
};

/** Formato: lo que dice AGENTS.md, ni más ni menos. Todo auto-corregible. */
const STYLE = {
    indent: ['error', 4, { SwitchCase: 1, flatTernaryExpressions: true }],
    quotes: ['error', 'single', { avoidEscape: true, allowTemplateLiterals: false }],
    semi: ['error', 'always'],
    'comma-dangle': ['error', 'never'],
    'eol-last': ['error', 'always'],
    'no-trailing-spaces': 'error',
    'space-before-blocks': 'error',
    'keyword-spacing': 'error',
    'arrow-spacing': 'error',
    'object-curly-spacing': ['error', 'always']
};

export default [
    {
        ignores: [
            'node_modules/**',
            'dist/**',
            '.tmp/**',
            'public/vendor/**',   // cliente de Neutralino, generado por `neu update`
            '.rubus/**',
            '.agentcoder/**'
        ]
    },

    js.configs.recommended,

    {
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module'
        },
        rules: {
            ...STYLE,

            // Un `catch (err)` que no usa `err` es ruido, pero `(_err, socket)`
            // documenta la firma del callback. El guion bajo es la señal.
            'no-unused-vars': ['error', {
                args: 'after-used',
                argsIgnorePattern: '^_',
                caughtErrors: 'all',
                caughtErrorsIgnorePattern: '^_'
            }],

            // AGENTS.md: nada de bytes de control literales. `\x1B` sí, el byte
            // crudo no — convierte el archivo en binario y grep lo salta.
            'no-control-regex': 'error',

            eqeqeq: ['error', 'always', { null: 'ignore' }],
            'no-var': 'error',
            'prefer-const': ['error', { destructuring: 'all' }],
            'no-console': 'off'   // el servidor y el CLI hablan por consola
        }
    },

    // ── el motor: sin DOM, sin Node, sin Neutralino ───────────────────────
    {
        files: ['public/js/core/**/*.js'],
        languageOptions: { globals: UNIVERSAL },
        rules: {
            // `no-restricted-imports` sólo mira los `import` estáticos, así que
            // `await import('node:fs')` dentro de core/ pasaba el lint sin una
            // queja — y es la forma natural de cargar algo condicionalmente,
            // justo lo que alguien intentaría aquí. Esto lo cubre por sintaxis.
            'no-restricted-syntax': ['error', {
                selector: 'ImportExpression > Literal[value=/^node:/]',
                message: 'core/ no puede importar Node ni con import() dinámico. Pide la capacidad al objeto `platform`.'
            }, {
                selector: 'ImportExpression > Literal[value=/^(fs|path|child_process|os|http|https|crypto|stream|url)$/]',
                message: 'core/ no puede importar Node ni con import() dinámico. Pide la capacidad al objeto `platform`.'
            }, {
                selector: 'ImportExpression > Literal[value=/platform.(node|neutralino|http|index|kill-tree)[.]js$/]',
                message: 'core/ sólo puede importar platform/paths.js, que es puro.'
            }],
            'no-restricted-imports': ['error', {
                patterns: [
                    {
                        group: ['node:*', 'fs', 'path', 'child_process', 'os', 'http', 'https', 'crypto', 'stream', 'url'],
                        message: 'core/ no puede importar Node. Pide la capacidad al objeto `platform` que recibe el motor.'
                    },
                    {
                        group: ['**/platform/node.js', '**/platform/neutralino.js', '**/platform/http.js', '**/platform/index.js', '**/platform/kill-tree.js'],
                        message: 'core/ sólo puede importar platform/paths.js, que es puro. Las demás son adaptadores concretos: si core elige uno, headless deja de poder ejecutar el mismo motor.'
                    },
                    {
                        group: ['**/ui/**', '**/embed/**'],
                        message: 'core/ no habla con la interfaz: emite eventos por el bus y alguien los escucha.'
                    }
                ]
            }]
        }
    },

    // paths.js es de platform/ por dialecto de rutas, pero es puro: sin fs, sin
    // globales. Por eso core/ puede depender de él, y por eso se comprueba.
    {
        files: ['public/js/platform/paths.js'],
        languageOptions: { globals: UNIVERSAL }
    },

    // ── la interfaz: DOM y nada más ───────────────────────────────────────
    {
        files: [
            'public/js/ui/**/*.js',
            'public/js/embed/**/*.js',
            'public/js/boot.js',
            'public/js/platform/http.js',
            'public/js/platform/neutralino.js'
        ],
        languageOptions: { globals: { ...globals.browser, Neutralino: 'readonly', NL_CWD: 'readonly' } }
    },

    // El detector de plataforma es el único archivo que se ejecuta sin saber
    // todavía dónde está: mira si hay `process` y si hay `window` para decidir.
    // Necesita los dos vocabularios porque su trabajo es precisamente elegir.
    {
        files: ['public/js/platform/index.js'],
        languageOptions: { globals: { ...globals.node, ...globals.browser } }
    },

    // boot.js es ES5 a propósito, y no es nostalgia: es lo que se ejecuta
    // cuando el navegador no ha podido cargar los módulos, para pintar el
    // porqué en la ventana. Un `let` aquí lo convierte en otro error de sintaxis
    // silencioso justo en el archivo cuyo único trabajo es que eso no pase.
    {
        files: ['public/js/boot.js'],
        rules: { 'no-var': 'off', 'prefer-const': 'off' }
    },

    // ── lo que sí es Node ─────────────────────────────────────────────────
    {
        files: [
            'server.js',
            'eslint.config.js',
            'scripts/**/*.js',
            'public/js/cli/**/*.js',
            'public/js/test/**/*.js',
            'public/js/platform/node.js',
            'public/js/platform/kill-tree.js'
        ],
        languageOptions: { globals: { ...globals.node } }
    },

    // El selftest monta DOMs de mentira y adaptadores falsos; necesita ambos
    // vocabularios para poder comprobar código de interfaz sin un navegador.
    {
        files: ['public/js/test/**/*.js'],
        languageOptions: { globals: { ...globals.node, ...globals.browser } }
    }
];
