# Rubus

Agente de programación local. Corre en tu máquina, contra tus archivos, con un
modelo servido por [Ollama](https://ollama.com). Sin nube, sin claves de API y
sin dependencias en tiempo de ejecución.

```bash
npm start
```

Abre <http://127.0.0.1:4322>. Necesitas Node 18+ y `ollama serve` en marcha con
algún modelo descargado (`ollama pull qwen3.6`). Si Ollama no está, la app
arranca igual: sirve para navegar el proyecto y avisa de lo que falta.

## La idea

Los modelos locales que caben en un portátil son malos siguiendo instrucciones
largas. Se saltan pasos, inventan rutas, escriben un archivo a medias y dicen
que han terminado. La respuesta habitual es un prompt más largo, y no funciona.

Aquí la fiabilidad no vive en el prompt sino en el arnés, en `public/js/core/`,
y está impuesta por código, no pedida por favor:

- **Explorar → planificar → aprobar → actuar.** Las herramientas que modifican
  archivos no existen hasta que el plan está aprobado; el registro las rechaza
  por fase. La aprobación es automática por defecto: pon `Aprobación` en
  «manual» en Ajustes si prefieres revisar el plan y cada paso, o marca
  `Confirmar comandos destructivos` para tenerlo todo automático **menos** lo
  que no se deshace. La lista de comandos prohibidos (`rm -rf /`, fork bombs,
  `curl | sh`) no se ejecuta en ningún modo.
- **Una llamada a herramienta por turno.** Si el modelo emite tres, se ejecuta
  la primera y se le dice que las demás se descartaron.
- **Cada modificación se verifica antes del siguiente turno**, así que el modelo
  nunca construye una edición encima de un archivo que acaba de romper.
- **El plan es una estructura de datos**, no un párrafo: se valida, se enseña
  como una lista de pasos, el usuario lo edita antes de aprobarlo, y el paso
  actual se le repite al modelo al final de cada prompt.
- **`write_file` se niega a escribir contenido abreviado.** Un
  `// ... resto del código ...` destruiría el archivo y el modelo no tiene forma
  de darse cuenta.
- **Se ejecutan los tests del propio proyecto**, no sólo comprobaciones
  estructurales. Rubus detecta cómo se prueba tu repositorio (`npm test`,
  `pytest`, `cargo test`…) y lo ejecuta después de cada paso que toque un
  archivo. Comprobar que el código sigue pareciendo código es fácil; esto
  comprueba que sigue funcionando.
- **Puede consultar documentación.** `search_web` y `fetch_url` le dan
  acceso a internet, que es la diferencia entre mirar la firma de una API y
  recordarla mal. Las URLs hacia la red local están bloqueadas en el cliente y
  otra vez en el servidor, sobre la IP ya resuelta; se pide permiso una vez por
  dominio. Se apaga entero desde Ajustes.
- **Recuerda entre ejecuciones.** Lo que falló, cuánto costó y qué comandos
  rechazaste se anotan en `.rubus/memory.md` y se releen al planificar la
  siguiente tarea. Es un archivo de texto: léelo, corrígelo o bórralo.

## Estudio de diseño

Una segunda sección, en el botón «Diseño» de la barra superior: le pides un
logotipo o una portada y el mismo modelo local compone la imagen — texto,
formas, degradados, **shaders GLSL** escritos por él y post-proceso (bloom,
grano, aberración cromática, escaneado). Se renderiza con PlayCanvas y se
exporta a PNG.

```bash
npm run setup:design
```

Trae el motor (3,5 MB) a `public/vendor/`. No viene en el repositorio y el
resto de la aplicación funciona sin él.

Lo interesante no es que el modelo escriba shaders: es que casi siempre los
escribe mal la primera vez. Así que el shader se valida antes de llegar a la
GPU, el error del compilador se traduce a las líneas que el modelo escribió, y
se comprueba que la imagen renderizada tenga algo dentro — un lienzo negro y un
trabajo perfecto son lo mismo visto desde el modelo. Con eso, un 8B local
acierta al segundo intento lo que no acertaba nunca.

## Comandos

| | |
|---|---|
| `npm start` | lint con auto-fix, servidor y navegador en http://127.0.0.1:4322 |
| `npm run serve` | lo mismo sin lint, para arrancar y punto |
| `npm run selftest` | pruebas del arnés, sin dependencias ni framework |
| `npm run lint` / `npm run lint:fix` | comprobar / corregir |
| `npm run setup:design` | trae PlayCanvas para el estudio de diseño |
| `npm run dev` | app de escritorio (antes: `npm run setup`) |
| `npm run build` | release; el lint bloquea si queda algún error |
| `npm run headless -- --root <dir> --task "..."` | el mismo motor sin interfaz |

`npm start` pasa ESLint con `--fix` antes de levantar el servidor, y lo que no
puede corregir lo avisa **sin** bloquear el arranque: tienes que poder levantar
la app justo para depurar aquello de lo que el lint se queja. En `npm run build`
sí bloquea, porque una release no debería llevar código que no pasa el lint.

Si clonas y ejecutas `npm start` sin instalar nada, el lint se omite con un
aviso y el servidor arranca igual. ESLint es una comodidad del que desarrolla,
no un requisito para ejecutar el programa.

Además del estilo, la configuración hace cumplir la regla de arquitectura del
proyecto: `public/js/core/**` no puede importar Node ni tocar el DOM. Es lo que
permite que el mismo motor corra headless, y ahora es un error de lint en vez de
una cuestión de disciplina.

## Reglas del proyecto

Un archivo del repositorio que se inyecta en todos los prompts y nunca se
comprime — el sitio para los comandos de build, las convenciones y las
prohibiciones. Se busca, en orden: `.rubus/rules.md`, `AGENTS.md`, `AGENT.md`,
`CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md`.

## Exponerlo a una red

Por defecto escucha solo en `127.0.0.1` y no pide contraseña, porque quien
llegue ahí ya podía ejecutar `node` en tu máquina. Fuera de loopback la cosa
cambia — este servidor lee archivos y ejecuta comandos, que es ejecución remota
de código — así que exige las dos cosas y no se puede saltar:

```bash
node server.js --host 0.0.0.0 --root C:/proyectos/mi-app --token secreto
```

`--root` pasa a ser un límite duro verificado en el servidor, no en el cliente.
Sin `--token` se genera uno y se imprime. Úsalo solo en redes de confianza y
detrás de HTTPS si sale de tu LAN. `--no-exec` desactiva la shell.

## Contribuir

Lee [AGENTS.md](AGENTS.md) antes de tocar nada: están ahí las reglas duras
(nada de TypeScript, cero dependencias, `core/` no puede importar DOM ni Node) y
las trampas concretas del servidor y del arnés que ya costaron una depuración.

Todo cambio en el parser de llamadas, en la seguridad, en el validador de
argumentos o en el verificador necesita una prueba en
`public/js/test/selftest.js` que falle sin el cambio.

## Licencia

Apache-2.0. Ver [LICENSE](LICENSE).
