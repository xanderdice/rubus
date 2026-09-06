# Rubus

Agente de programación local. Corre en tu máquina, contra tus archivos, con un
modelo servido por [Ollama](https://ollama.com). Sin nube, sin claves de API y
sin dependencias en tiempo de ejecución.

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

