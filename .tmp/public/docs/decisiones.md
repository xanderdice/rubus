# Decisiones de diseño

Por qué el harness está construido así. Cada apartado responde a un fallo
concreto y observado de los modelos locales pequeños, no a una preferencia.

---

## 1. El plan es una estructura de datos, no un texto

Un plan en prosa no se puede validar, ni mostrar como casillas, ni editar antes
de aprobarlo. Pero el motivo de verdad es otro: en el turno 14 hay que poder
decirle al modelo **«estás en el paso 3 de 6, el criterio es este»**. Un párrafo
lo reinterpreta ligeramente distinto cada vez que lo lee; `{id: 3, verify: "..."}`
no.

Se genera con *structured outputs* de Ollama, así que en el caso normal el
modelo **no puede** producir un plan malformado. `parsePlan()` existe para los
demás casos, y devuelve errores redactados para pegárselos de vuelta.

## 2. Los pasos completados son inmutables

Al replanificar se sustituye sólo la cola pendiente. Si una replanificación
pudiera reescribir el pasado, el agente rehace ediciones que ya están en disco y
entra en bucle. `applyReplan()` conserva `done` y `skipped` tal cual.

## 3. Una llamada por turno, y se ejecuta la primera

No se le pide al modelo que emita una sola llamada: se le permite emitir las que
quiera y **se descartan todas menos la primera**, diciéndoselo. Pedirlo no
funciona; hacerlo sí. Como consecuencia gratuita, nunca hay más de una
modificación de archivo por turno, y por tanto nunca se apila una edición sobre
un archivo que quedó roto en la anterior.

## 4. El paso actual se repite al final de cada prompt

Unos 40 tokens (`stepReminder()`), pegados después de todo el material de
referencia. Los modelos pequeños ponderan muchísimo más el final del prompt que
el medio; enterrar la instrucción bajo un mapa del repositorio es la forma más
fiable de que la ignoren.

## 5. `write_file` rechaza lo que huele a truncado

Dos comprobaciones, y las dos son destructivas si fallan:

- **Elisiones.** `// ... resto del código igual ...` y sus dialectos. El modelo
  cree que ha escrito el archivo; en realidad lo ha borrado.
- **Encogimiento.** Contenido nuevo por debajo del 45 % del actual en un archivo
  de más de 400 caracteres. Casi siempre es una generación cortada.

En ambos casos se rechaza y se le manda a `edit_file`. Rechazar es la única
respuesta que rompe el bucle: desde el punto de vista del modelo la escritura
había funcionado.

## 6. `search_codebase` no acepta expresiones regulares

Los modelos débiles escriben regex rotas constantemente, leen el «0 resultados»
como «eso no existe en el código» y empiezan a inventar. Una búsqueda literal o
encuentra la cadena o no, y el fallo es legible. Además el mensaje de «sin
coincidencias» dice explícitamente *«ese texto NO existe: no asumas que sí»*.

## 7. Fases de sólo lectura impuestas en el registro, no en el prompt

Las herramientas que modifican archivos no están en la lista de la fase de
exploración ni en la de planificación, y `ToolRegistry.execute()` las rechaza
además por fase. Una regla en el prompt es una sugerencia. Esto no.

Cuando el modelo lo intenta igualmente —lo intenta— recibe una explicación del
orden correcto y se le recuerda que no se ha modificado nada. Tratar el intento
como «conclusiones» le dejaría creyendo que la edición ocurrió.

## 8. `finish_step` también cierra la exploración

Pedirle a un modelo con tool calling que **deje** de llamar herramientas y pase
a prosa es poco fiable. Darle una herramienta que significa «he terminado» sí lo
es. Por eso `finish_step` está expuesta durante la exploración, donde significa
«ya sé bastante», con el resumen en `summary`.

## 9. Nada sintético en el rol `assistant`

Una versión anterior escribía un marcador legible (`→ read_file`) cuando el
modelo emitía una llamada sin prosa. El modelo lo vio en su propio historial y
empezó a **escribir** `→ finish_step` como texto plano en vez de llamar a nada.

Un modelo débil imita lo que encuentra en el rol de asistente. Ahí sólo puede ir
lo que dijo él o el formato real de la llamada.

## 10. La verificación no la declara el modelo

Tras cada escritura, el harness comprueba el archivo: balance de delimitadores
con conciencia de cadenas y comentarios, marcadores de conflicto, elisiones
residuales, `JSON.parse` para `.json`, y después `node --check` o `py_compile` si
están instalados. Al cerrar el paso, además, el comando de verificación del
proyecto.

Un resultado no concluyente se informa como no concluyente. Decirle «verificado»
cuando no se verificó nada es peor que no decir nada.

## 11. Presupuesto de contexto por prioridades

El orden es fijo, y lo de arriba nunca cede sitio a lo de abajo:

1. system prompt
2. **reglas del proyecto** — nunca se comprimen
3. la instrucción del turno
4. mapa del proyecto (se recorta, no se elimina)
5. archivos fijados por el usuario
6. historial reciente, literal
7. historial antiguo, comprimido

La selección del historial se llena desde el final hacia atrás y luego se
invierte: recortar por el extremo antiguo mantiene el turno coherente, recortar
por el nuevo tiraría justamente el resultado de herramienta sobre el que el
modelo va a razonar.

## 12. Dos protocolos de herramientas

- **Con tool calling nativo** (Qwen3.6): se usa el mecanismo de Ollama.
- **Sin él** (Gemma4): se fuerza un esquema JSON con `tool` restringido a un
  `enum` de los nombres reales. El modelo no puede inventar una herramienta
  porque el muestreo no se lo permite.

Si un modelo dice tener tools y luego las rechaza, se detecta el 400, se baja al
protocolo JSON y se reintenta — una vez, y se recuerda.

## 13. Los errores del modelo no matan la ejecución

Cuando Ollama no consigue interpretar la tool call que el modelo generó,
devuelve un error a mitad del stream (`XML syntax error…`). Reintentar la misma
petición reproduce el fallo. Se clasifica como `parse`, se convierte en un turno
vacío y el bucle de reparación pide una llamada bien formada. Un turno malo no
es una tarea perdida.

## 14. Quedarse sin tokens no es lo mismo que responder mal

Un modelo con *thinking* puede gastarse los 3.072 tokens de `num_predict`
razonando y devolver un mensaje **vacío** con `done_reason: "length"`. Leído sin
cuidado eso parece «respuesta malformada», y el que llama vuelve a pedir lo
mismo — idéntico — cuatro veces, a un minuto por intento. Es exactamente el
bucle que este proyecto existe para evitar, y lo tuvo durante un rato.

Ahora se distingue: si la respuesta viene vacía **y** truncada por longitud, se
reintenta una sola vez cambiando algo (thinking apagado, presupuesto al doble) y
esa fase se queda sin thinking el resto de la sesión. Truncado **con** contenido
parcial no escala: la reparación de JSON del parser suele rescatarlo.

## 15. Una cadena de comandos vale lo que su eslabón más peligroso

`git status && rm -rf build` se clasifica como `dangerous`, no como `safe`. El
troceado respeta las comillas, y la sustitución de comandos (`$(...)`, backticks)
baja automáticamente el grado: puede esconder cualquier cosa dentro de algo que
parece inofensivo.

## 16. Cuatro entornos, un solo motor

`core/` recibe un objeto `platform` con siete métodos y nunca pregunta de dónde
salió. Hay cuatro implementaciones: Neutralino (API nativa), HTTP (contra
`server.js`), Node (para el arnés sin interfaz) y una degradada que se limita a
explicar por qué no puede hacer nada.

Añadir el modo navegador — servidor, proxy, adaptador, picker de carpetas — no
tocó **ni una línea** de `core/`. Ese es el rendimiento de la frontera.

## 17. El servidor no puede morirse

Un `.pipe(res)` pelado deja el evento `error` sin manejar. Un cliente que corta
la respuesta a media generación provoca entonces una excepción no capturada que
**tumba el proceso entero** — y el síntoma que ve el usuario es «Failed to
fetch», que apunta al navegador en vez de al servidor que acaba de morir en
silencio. Pasó, y costó encontrarlo.

Ahora: `pipeline()` con captura en el proxy y en los estáticos, manejador de
`error` en el stream de exec, y una red de seguridad de proceso
(`uncaughtException` / `unhandledRejection`) que registra y continúa. Una
ejecución del agente son veinte minutos de trabajo; perder el servidor a la
mitad lo pierde todo.

Segunda trampa del mismo arreglo: el «el cliente se fue» va en `res`, **nunca en
`req`**. Un `IncomingMessage` emite `close` en cuanto se consume su cuerpo, así
que en un POST salta de inmediato y aborta la generación antes de empezar. Los
GET seguían funcionando, lo que hacía parecer que el problema era el cuerpo de
los POST.

## 18. `core/` no conoce el DOM

Es lo que permite que `public/js/cli/headless.js` ejecute exactamente el mismo motor
sin interfaz. No es un detalle de estilo: una máquina de estados que sólo
funciona dentro de un webview no se puede probar, y un harness sin probar es
justo lo que este proyecto no se puede permitir, porque toda la inteligencia
está en el harness.
