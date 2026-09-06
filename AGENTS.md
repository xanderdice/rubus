# Reglas del proyecto — Rubus

Este archivo se inyecta en todos los prompts del agente cuando se trabaja sobre
este repositorio. (También sirve de ejemplo de cómo escribir uno.)

## Comandos

- arrancar: `npm start` → http://127.0.0.1:4322 (pasa el lint con `--fix` antes)
- pruebas del harness: `npm run selftest`
- lint: `npm run lint` (comprueba) · `npm run lint:fix` (corrige)
- app de escritorio: `npm run dev` (requiere `npm run setup` la primera vez)
- prueba real contra un modelo: `npm run headless -- --root <dir> --task "..."`
- `npm run serve` es lo mismo que `start` **sin** lint, para cuando quieras
  arrancar y punto.

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
- 4 espacios de indentación, comillas simples, punto y coma al final. Esto ya no
  hay que recordarlo: lo impone `eslint.config.js` y lo corrige `--fix`.
- **Cero dependencias en tiempo de ejecución.** Eso no ha cambiado y no va a
  cambiar: lo que se sirve al navegador y lo que ejecuta `server.js` son
  módulos nativos y código de este repositorio, nada más.
  Las devDependencies son tres — el CLI de Neutralino, ESLint y `globals` —, y
  todas son opcionales para *ejecutar* el programa. `npm start` en un clon
  recién hecho, sin `npm install`, sigue funcionando: el lint se omite con un
  aviso en vez de romper el arranque (ver `scripts/lint.js`). Esa propiedad la
  comprueba el trabajo `test` del CI, que corre a propósito sin instalar nada.
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

## Salida a internet

`search_web` y `fetch_url`. Existen porque el modelo las pedía en su propio
razonamiento —«There is NO google_search or browse_website tool listed»— y
cuando no puede consultar una API se la inventa, que es peor que no saberla.

Lo que hay que tener presente al tocar esto:

- **La validación de la URL es la herramienta.** Está en `core/web.js`, es pura
  y la usan los dos lados. Lo que impide no es que el modelo lea internet: es
  que lea la red de DENTRO — `169.254.169.254`, el propio Ollama en
  `127.0.0.1:11434`, el router. En modo remoto eso sería un SSRF con el
  servidor pidiendo por ti desde dentro de tu red.
- **El servidor vuelve a comprobarlo, y sobre la IP resuelta.** Un nombre
  público puede apuntar a `127.0.0.1` y el DNS no se lo pregunta a nadie:
  `localtest.me` lo hace hoy mismo. Por eso `/api/web` resuelve el host antes
  de pedir nada, y sigue las redirecciones a mano — un 302 hacia dentro se
  saltaría cualquier comprobación hecha sólo sobre la primera URL.
- **Se devuelve texto, nunca HTML.** Una página de documentación entera son
  cincuenta mil tokens de los que sirven cuatrocientos.
- **Se pide permiso una vez por DOMINIO**, no por página: leer ocho páginas de
  la misma documentación son ocho diálogos si se pregunta por cada una, y el
  octavo ya nadie lo lee. En modo automático no pregunta pero lo anota.
- El buscador por defecto es DuckDuckGo por HTML, o sea **raspado**: el día que
  cambien el formato dejará de encontrar resultados. Por eso la herramienta
  distingue «cero resultados» de «no he sabido leer la respuesta» — son dos
  problemas distintos y el segundo no se arregla reformulando la consulta.
  Con `tools.searchEndpoint` se puede apuntar a una instancia de SearXNG.

## El estudio de diseño

Una sección aparte, con su propio arnés y la misma tesis: el modelo no dibuja,
describe una composición en JSON y otro la pinta.

- `public/js/core/design/` es puro y se prueba sin GPU. `glsl.js` es a los
  shaders lo que `security.js` es a la shell: el modelo escribe sólo el CUERPO
  del fragment shader y se comprueba antes de mandarlo al driver. La regla que
  no es negociable son los bucles — tienen que llevar un tope literal y pequeño,
  porque un `for` sin acotar en un fragment shader cuelga la GPU y Windows se
  lleva la pestaña por delante con el TDR.
- `public/js/ui/design/` es lo único que toca WebGL. El estudio recibe el
  renderer inyectado igual que el motor recibe `platform`, y por el mismo
  motivo: si la lógica dependiera de PlayCanvas, no habría forma de probarla.
- **El modelo no declara el éxito.** Un shader que no compila y un lienzo que
  sale negro son indistinguibles de un trabajo bien hecho desde dentro del
  modelo. Se comprueban las dos cosas — el log del compilador y la cobertura de
  píxeles — y el fallo vuelve traducido a SUS líneas. Ese turno de reparación es
  lo que hace que esto funcione con un modelo pequeño; si lo tocas, tiene prueba
  en el selftest.
- PlayCanvas no está en el repositorio: lo baja `npm run setup:design` a
  `public/vendor/`, que está en `.gitignore`. Se guarda como `.js` y no como
  `.mjs` — el servidor sólo declara el MIME de `.js`, y un `.mjs` sale como
  `application/octet-stream` y el navegador se niega a ejecutarlo como módulo.
  Sin el motor, el estudio lo dice y el resto de la aplicación no se entera.

## Estructura — la regla dura

`public/js/core/**` es el motor y **no puede** importar nada del DOM, de
Neutralino ni de Node. Recibe un objeto `platform` y habla con la interfaz sólo
por el bus de eventos. Esa separación es lo que permite que `public/js/cli/headless.js`
ejecute el mismo motor sin interfaz; si se rompe, se pierde la única forma de
probar el harness de verdad.

`public/js/ui/**` es lo contrario: sólo DOM, nunca lógica de agente.

Desde ahora esa regla **está comprobada, no sólo escrita**. `eslint.config.js`
le da a `core/` un vocabulario de globales deliberadamente corto (lo que existe
en el navegador y en Node a la vez) y una lista de imports prohibidos, así que
un `node:fs`, un `../platform/node.js` o un `document` suelto en el motor son un
error de lint, no una erosión que se descubre el día que headless deja de
arrancar. Si necesitas una capacidad del sistema en `core/`, pídesela al objeto
`platform`; si el lint te lo impide, el lint tiene razón.

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

## Aprobación: 'auto' por defecto

`agent.approvalMode` es el único interruptor de la fricción, y `approvalPolicy()`
en `config.js` es el único sitio donde se decide qué se pregunta. Antes estaba
repartido en cuatro ajustes leídos desde tres archivos y no se podía responder
"¿esto va a pararse?" mirando a un solo lugar.

En `'auto'` el agente aprueba su plan, encadena los pasos y ejecuta los comandos
ordinarios y la verificación detectada sin diálogos. En `'manual'` pregunta en
cada punto. Los ajustes finos (`autoApprovePlan`, `autoRunSteps`) siguen
existiendo y **ganan** al modo, pero ya no están en `DEFAULTS`: si estuvieran,
`config.get` nunca devolvería el valor derivado y el modo no serviría de nada.
Por eso la migración v3 los borra de los ajustes guardados.

En `'auto'` eso incluye los comandos **destructivos** (`rm`, `git push`,
`curl`, `docker`…) y la verificación con el comando de tests **detectado** del
repositorio. Las dos cosas se decidieron a sabiendas, no por descuido, y las dos
dejan un aviso en el registro en lugar de un diálogo: sin diálogo no quiere
decir sin rastro, porque la primera pregunta después de un susto siempre es
«¿qué ejecutó exactamente?».

Hay tres frenos, y conviene no quitarlos por simplificar:

- **La lista de BLOQUEADOS de `security.js` no la levanta ningún modo.**
  `rm -rf /`, fork bombs, `curl | sh`, formatear una unidad. No hay clave de
  configuración que los habilite y no debe haberla: un diálogo se puede saltar,
  pero `rm -rf /` no tiene una versión buena.
- **`security.confirmDestructive`** es la postura intermedia, y es la más común
  de las tres: automático para todo menos para lo que no se deshace. Por eso
  `dangerousCommands` va separado de `cautionCommands` en la política — con un
  solo interruptor no se podría decir.
- **El aviso del registro** cuando un destructivo corre sin confirmar, con el
  comando y el motivo por el que se graduó así.

## Verificación y memoria

Dos cosas que cambian lo que significa "paso completado", y conviene saber que
están ahí antes de depurar algo raro:

- **Verificación de proyecto automática.** Con `agent.verifyCommand` vacío se usa
  el comando de tests que el mapa del proyecto ya había detectado. Tres cosas
  que no se pueden quitar sin reabrir un agujero:

  1. **La lista cerrada de `verify.js` NO es la protección.** `npm test` es una
     indirección a `scripts.test` del repositorio analizado, o sea código sin
     auditar; `pytest` carga conftest.py; `cargo test` ejecuta build.rs.
     Filtrar la cadena no filtra lo que se ejecuta. En `approvalMode: 'manual'`
     la protección es que un comando **detectado** pasa por `requestApproval`
     una vez por ejecución; en `'auto'` (el defecto) se ejecuta y sólo se avisa.
     Un comando que el usuario escribió a mano no pregunta nunca: ya lo autorizó
     al escribirlo.
  2. **La línea base.** `captureBaseline()` ejecuta la suite antes del primer
     cambio. Sin eso, un repositorio con los tests ya en rojo por algo ajeno
     convierte en fallo todos los pasos, cada uno reintentado tres veces
     ejecutando la suite entera. Si ya estaba roja, la verificación de proyecto
     se desactiva para esa tarea y se dice por qué.
  3. **"Tocó algo" incluye la consola.** El gate de `_verifyStep` mira
     `mutatedPaths` **o** `ranCommands`: un paso resuelto con un codemod o un
     formateador no pasa por `write_file` y cambia el repositorio igual.
     `_finish` verifica siempre.

  Si añades un ecosistema a la lista, acuérdate del caso `npm init`: su script
  `test` por defecto es `exit 1`, y darlo por bueno hace fallar todos los pasos
  de cualquier proyecto sin tests.
- **Memoria entre ejecuciones** en `<proyecto>/.rubus/memory.md`, escrita al
  terminar y leída al explorar y al planificar. Se deriva del plan, **no la
  redacta el modelo**: si alguna vez te tienta pedirle que escriba sus propias
  lecciones, lo que sale son autoelogios genéricos que gastan contexto. Se apaga
  con `agent.memory`.
  El archivo invita a editarlo, así que `record()` conserva el preámbulo — todo
  lo que haya por encima de la primera entrada `##`. Sin eso, una nota del
  usuario en la cabecera desaparecía en la siguiente ejecución, en silencio y
  justo después de haberle prometido que podía editarlo. Y el tope de tokens del
  bloque recorta la entrada, no la descarta: un memory.md editado a mano con un
  bloque enorme se comía la ventana entera.

## Al tocar el harness

- Todo cambio en el parser de tool calls, en la seguridad, en el validador de
  argumentos o en el verificador necesita una prueba en `public/js/test/selftest.js`.
- No relajes las protecciones de `write_file` (elisiones, contenido truncado)
  para que un modelo concreto pase: existen porque destruyen archivos.
- No metas texto sintético en el rol `assistant` del historial. El modelo imita
  lo que encuentra ahí.
- Antes de dar por bueno un cambio en el motor, ejecútalo de verdad:
  `npm run selftest` y una tarea real en modo headless.
