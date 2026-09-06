# Reglas del proyecto — Rubus

Este archivo se inyecta en todos los prompts del agente cuando se trabaja sobre
este repositorio. (También sirve de ejemplo de cómo escribir uno.)

## Comandos

- app de escritorio: `npm start` compila y la abre · `npm run build` sólo compila
- iterar rápido sin compilar: `npm run dev`
- servidor web: `npm run serve` → http://127.0.0.1:4322
- pruebas del harness: `npm run selftest`
- lint: `npm run lint` (comprueba) · `npm run lint:fix` (corrige)
- prueba real contra un modelo: `npm run headless -- --root <dir> --task "..."`
- `npm run serve` no pasa por el lint y no necesita `npm install`: es la vía
  de escape para arrancar y punto.

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
  ninguna hace falta para el **servidor web**: `npm run serve` en un clon recién
  hecho, sin `npm install`, funciona — el lint se omite con un aviso en vez de
  romper el arranque (ver `scripts/lint.js`), y el trabajo `test` del CI lo
  comprueba corriendo a propósito sin instalar nada.
  La app de **escritorio** sí necesita el CLI de Neutralino, porque hay que
  compilarla. `scripts/desktop.js` baja el framework solo la primera vez.
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

Con una salvedad en la app de escritorio: `Neutralino.storage` sólo acepta
claves que casen `^[a-zA-Z-_0-9]{1,50}# Reglas del proyecto — Rubus

Este archivo se inyecta en todos los prompts del agente cuando se trabaja sobre
este repositorio. (También sirve de ejemplo de cómo escribir uno.)

## Comandos

- app de escritorio: `npm start` compila y la abre · `npm run build` sólo compila
- iterar rápido sin compilar: `npm run dev`
- servidor web: `npm run serve` → http://127.0.0.1:4322
- pruebas del harness: `npm run selftest`
- lint: `npm run lint` (comprueba) · `npm run lint:fix` (corrige)
- prueba real contra un modelo: `npm run headless -- --root <dir> --task "..."`
- `npm run serve` no pasa por el lint y no necesita `npm install`: es la vía
  de escape para arrancar y punto.

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
  ninguna hace falta para el **servidor web**: `npm run serve` en un clon recién
  hecho, sin `npm install`, funciona — el lint se omite con un aviso en vez de
  romper el arranque (ver `scripts/lint.js`), y el trabajo `test` del CI lo
  comprueba corriendo a propósito sin instalar nada.
  La app de **escritorio** sí necesita el CLI de Neutralino, porque hay que
  compilarla. `scripts/desktop.js` baja el framework solo la primera vez.
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
 y lanza `NE_ST_INVSTKY` con cualquier
otra, así que los puntos de `agentcoder.settings.v1` la hacen ilegal. La clave
NO se cambia por eso: se traduce dentro de `platform/neutralino.js`
(`claveNativa()`), que es donde está la limitación, y el resto del proyecto
sigue usando el nombre de siempre. Ahí no había nada que migrar, porque con la
clave ilegal `setData` lanzaba siempre y en el escritorio los ajustes no se
guardaron nunca; el síntoma que se veía era «No se pudo abrir la carpeta»,
porque abrir una carpeta es lo primero que escribe.

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
Es lo que permite que `npm run serve` funcione en una máquina recién clonada.

## La app de escritorio

`npm start` compila y abre; `npm run build` sólo compila. Los dos pasan por
`scripts/desktop.js`, que existe por tres cosas que `neu` no hace:

- **`neu` sale con código 0 aunque falle.** Sin el cliente descargado,
  `neu build --release` escribe `ERRR ENOENT ... public/vendor/neutralino.js`
  y devuelve 0. Encadenado en un script de npm eso es un build roto que se
  reporta como bueno. Por eso el envoltorio comprueba que el ejecutable EXISTA
  y sea más nuevo que el inicio del build, y no mira el código de salida.
- **El framework no está en el repositorio.** `bin/` (15 MB de binarios de
  todas las plataformas) y `public/vendor/neutralino.js` los trae
  `neu update`, y están en `.gitignore`. Si faltan, el envoltorio los baja
  solo: ese era exactamente el estado en que "dejó de funcionar el build".
- **Se lanza lo que se acaba de compilar.** `neu run` no usa `dist/`: arranca
  desde `bin/` y la carpeta `public/` viva. Eso es perfecto para iterar y por
  eso es `npm run dev`, pero "compilar y ejecutar" no puede compilar una cosa
  y abrir otra.

Y un detalle del arranque que costó encontrar: `detectPlatform()` distingue el
shell del navegador por los globales `NL_*`, **no sólo por `NL_TOKEN`**. Con
`tokenSecurity: "one-time"` ese token existe una única vez — el cliente lo
copia a sessionStorage — así que al RECARGAR la ventana la app se daba por
navegador, sondeaba `/api/ping` contra sus propios recursos y terminaba en la
plataforma degradada: abierta, sin acceso al disco y sin un solo error visible.
El rastro queda en `dist/rubus/neutralinojs.log`.

Y la trampa que costó una tarde entera, porque se presentaba como un fallo de
otro sitio: **`tokenSecurity: "one-time"` rompía la aplicación de escritorio**.

La cadena, medida entera: con ese modo el núcleo pone el `NL_TOKEN` real en
`__neutralino_globals.js` **sólo en la primera petición** de ese archivo. El
webview lo pide antes que la página, con su preload, así que cuando el
`<script>` del `<head>` lo ejecuta de verdad recibe `NL_TOKEN=''`. El cliente
hace `g().split('.')[1]`, que sobre una cadena vacía da `undefined`, y abre
`ws://localhost:PUERTO?connectToken=undefined`. El núcleo rechaza, el socket
dispara `error` — y el manejador de `error` del cliente hace
`document.body.innerText = ''` seguido de `document.write(...)`, que con el
documento ya analizado implica un `document.open()`: **borra la página entera**.

Eso ocurre de forma asíncrona, cuando `index.html` ya está parseado y `boot.js`
ya ha lanzado su `import()`. El montaje se encontraba un documento vacío y
reventaba en el primer elemento que buscase, con un `Cannot read properties of
null (reading 'ownerDocument')` que señalaba a `VirtualScroller`. No había nada
malo en el scroller: el puente nativo estaba caído.

En el navegador no pasa nunca, y no por suerte: `server.js` sirve
`__neutralino_globals.js` como un stub vacío, así que `NL_PORT` es `undefined`,
el constructor `new WebSocket('ws://127.0.0.1:undefined?...')` **lanza
síncronamente**, y el cliente aborta ANTES de registrar ese manejador — construye
el socket primero y le engancha los listeners después. El error
«Neutralino.init falló» que se ve en la consola de `npm run serve` es justo lo
que inmuniza a `npm run serve`.

Cuatro consecuencias para quien toque esto:

- `tokenSecurity` no puede volver a `one-time`. Hay una prueba que lo fija.
- `boot.js` no monta nada hasta que `nucleoListo()` sabe si el shell conectó
  (evento `ready`, con plazo). No adelantes el `import()` por delante de esa
  espera.
- `protegerDocumento()` intercepta el `document.write` del cliente y cambia el
  código desnudo por una explicación. Hace falta igualmente, porque el mismo
  borrado puede llegar DESPUÉS del arranque con `NE_RT_INVTOKN`.
- Los elementos que la interfaz necesita sí o sí se leen con `must()` de
  `ui/dom.js`, no con `$`, que devuelve null en silencio. El mensaje incluye
  cuántos hijos tiene el `<body>`, que es lo que distingue «falta un elemento»
  de «han borrado el documento».

Para depurar la ventana no hay consola a mano: los fallos de arranque se copian
a `dist/rubus/neutralinojs.log` desde `fatal()`, y eso sólo funciona si el
puente nativo está vivo. Si el log sale vacío ante un fallo evidente, el puente
es el problema. `netstat -ano | grep <puerto>` sin ninguna conexión
`ESTABLISHED` lo confirma en un segundo.

Y la peor de todas, porque no da error: **el núcleo no contesta cuando la carga
JSON no es UTF-8 válido**. `filesystem.readFile` devuelve el contenido como
cadena dentro de un JSON; si los bytes no son UTF-8, el núcleo apunta
`NE_SR_UNBPARS` en su log y se come la respuesta, ni éxito ni error. El cliente
no tiene plazo: guarda la promesa en un mapa por `id` y sólo la salda si llega
un mensaje con ese `id`. Así que la promesa **no se resuelve jamás**.

Medido contra el núcleo 5.5.0 en marcha, con un `.js` de once bytes guardado en
cp1252 (`// versión`, con la ó en 0xF3): `getStats` contesta en 1 ms,
`readBinaryFile` devuelve los bytes en 1 ms, y `readFile` no vuelve nunca — con
la conexión sana antes y después. Un solo archivo así dentro del proyecto
abierto colgaba para siempre el mapa del repositorio, la búsqueda o un
`read_file`, y Cancelar no rescataba, porque `signal.aborted` sólo se mira entre
iteraciones y el `await` de dentro no vuelve. Es un escenario de lo más normal:
cualquier repositorio viejo de Windows con una tilde en un comentario en ANSI.

Dos defensas, y hacen falta las dos:

- **El texto va y viene en binario.** `readText` usa `readBinaryFile` y
  descodifica con `TextDecoder`; `writeText` usa `writeBinaryFile` y codifica
  con `TextEncoder`. Los bytes viajan en base64 y no tienen que sobrevivir a un
  JSON. Lo que no sea UTF-8 sale como U+FFFD, que es lo que `looksBinary()` sabe
  juzgar después. Y en el otro sentido cubre lo mismo: media pareja suplente,
  que es lo que deja un modelo al partir un emoji, también callaba al núcleo.
- **`conPlazo()` envuelve todas las llamadas nativas**, con la única excepción
  deliberada de `showFolderDialog`, que es modal y lo decide la persona. No
  arregla ninguna causa: convierte «colgado para siempre» en un error corriente
  con código `NE_SIN_RESPUESTA`. Que un turno del agente se pueda quedar muerto
  no debería depender de haber previsto por qué.

Si tocas `readText`, la prueba lo caza de una forma poco habitual: Node aborta
el selftest con «Detected unsettled top-level await» señalando la línea.

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
