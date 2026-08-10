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
  archivos no existen hasta que el usuario aprueba el plan; el registro las
  rechaza por fase.
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

## Comandos

| | |
|---|---|
| `npm start` | servidor + navegador en http://127.0.0.1:4322 |
| `npm run selftest` | pruebas del arnés, sin dependencias ni framework |
| `npm run dev` | app de escritorio (antes: `npm run setup`) |
| `npm run headless -- --root <dir> --task "..."` | el mismo motor sin interfaz |

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
