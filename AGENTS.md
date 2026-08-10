# Reglas del proyecto — Rubus

Este archivo se inyecta en todos los prompts del agente cuando se trabaja sobre
este repositorio. (También sirve de ejemplo de cómo escribir uno.)

## Comandos

- arrancar: `npm start` → http://127.0.0.1:4322
- pruebas del harness: `npm run selftest`
- app de escritorio: `npm run dev` (requiere `npm run setup` la primera vez)
- prueba real contra un modelo: `npm run headless -- --root <dir> --task "..."`

## Convenciones

- JavaScript ESM (`import`/`export`), sin transpilar y sin bundler. **Nada de
  TypeScript y ningún archivo `.mjs`**: todo es `.js`, la misma extensión en el
  navegador y en Node (lo permite `"type": "module"`). Un solo tipo de archivo,
  sin paso de build, depurable tal cual con las devtools o con `node`.
  (`.mjs` sí aparece en `ignore.js`, `verify.js` y `devserver.js`, pero ahí
  describe archivos de *otros* proyectos sobre los que trabaja el agente.)
- **Nunca metas bytes de control literales en el código.** Usa `\0`, `\x1B`,
  ``. Un byte crudo convierte el archivo en binario: grep lo salta, el diff
  es ilegible y el editor lo estropea sin avisar.
- 4 espacios de indentación, comillas simples, punto y coma al final.
- Sin dependencias en tiempo de ejecución. La única devDependency es el CLI de Neutralino.
- Comentarios en inglés; textos de interfaz y mensajes al modelo en español.
- Comenta el **porqué**, no el qué. Si un valor o una decisión parece rara, explica
  qué fallo concreto la motivó.

## El nombre: Rubus por fuera, `agentcoder` en el almacenamiento

El proyecto se llamaba AgentCoder. Todo lo que **ve** el usuario dice ya Rubus:
títulos, banner, prompts, README, binario. Lo que **persiste** conserva el
nombre viejo a propósito, y no es un renombrado a medias:

- `agentcoder.settings.v1` (localStorage) y `~/.agentcoder/settings.json`
- `agentcoder.token` (localStorage) y `AGENTCODER_TOKEN`
- `applicationId: dev.agentcoder.app` — Neutralino guarda por ese identificador
- `name: 'agentcoder'` en `/api/ping`, que es el apretón de manos del cliente

Cambiar cualquiera de esos no renombra un dato: lo abandona. El usuario abre la
app y se encuentra los ajustes por defecto, sin ningún mensaje que lo explique.
Si algún día se cambian, hace falta una migración que lea el valor viejo y
escriba el nuevo, igual que `SETTINGS_VERSION` en `config.js`.

Dos excepciones, porque ahí no se pierde nada:

- Los registros se escriben en `<proyecto>/.rubus/logs/`. Son desechables.
- Las reglas de proyecto se buscan primero en `.rubus/rules.md` y después en
  `.agentcoder/rules.md`, que se sigue leyendo para no dejar mudo a un
  repositorio que ya tenía uno.

## Estructura — la regla dura

`public/js/core/**` es el motor y **no puede** importar nada del DOM, de
Neutralino ni de Node. Recibe un objeto `platform` y habla con la interfaz sólo
por el bus de eventos. Esa separación es lo que permite que `public/js/cli/headless.js`
ejecute el mismo motor sin interfaz; si se rompe, se pierde la única forma de
probar el harness de verdad.

`public/js/ui/**` es lo contrario: sólo DOM, nunca lógica de agente.

`server.js` no tiene dependencias y no las tendrá: sólo módulos nativos de Node.
Es lo que permite que `npm start` funcione en una máquina recién clonada.

## Al tocar el servidor

- **Nunca uses `.pipe(res)` pelado.** Usa `pipeline()` con captura. Un `error`
  sin manejar en una respuesta tumba el proceso entero, y el síntoma aparece en
  el navegador ("Failed to fetch"), no donde está la causa.
- El evento de "el cliente se fue" va en `res`, no en `req`: un
  `IncomingMessage` emite `close` en cuanto se consume el cuerpo del POST.
- Cualquier ruta nueva que acepte una ruta de archivo pasa por `resolvePath()`.
  El sandbox del cliente es comodidad; el del servidor es la seguridad real.

## Al tocar el harness

- Todo cambio en el parser de tool calls, en la seguridad, en el validador de
  argumentos o en el verificador necesita una prueba en `public/js/test/selftest.js`.
- No relajes las protecciones de `write_file` (elisiones, contenido truncado)
  para que un modelo concreto pase: existen porque destruyen archivos.
- No metas texto sintético en el rol `assistant` del historial. El modelo imita
  lo que encuentra ahí.
- Antes de dar por bueno un cambio en el motor, ejecútalo de verdad:
  `npm run selftest` y una tarea real en modo headless.
