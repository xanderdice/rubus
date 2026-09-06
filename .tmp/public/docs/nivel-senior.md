# Programar a nivel sénior con un modelo local

Análisis medido, no opinado. Máquina: RTX 5060 Laptop (8 GB), Core Ultra 9
275HX ×24, 68 GB RAM. Modelo: `qwen3.6:latest` (36B MoE, Q4_K_M, 24 GB).
Fecha: 2026-09-05. Todos los números de aquí salen de ejecutar cosas en esta
máquina; los scripts están en el scratchpad de la sesión.

## Veredicto, en dos frases

**Con una tarea bien enunciada, Rubus + qwen3.6 ya producen código de nivel
sénior**: en la prueba real de abajo el modelo escribió exactamente lo que
escribiría alguien con oficio —`AbortSignal.timeout`, parámetro por defecto,
estilo respetado, llamadas actualizadas, tests en verde— a la primera y sin
reintentos. **Lo que nos separa de «súper experto» no es la inteligencia del
modelo: es el coste por iteración y tres puntos ciegos del arnés.** El coste
decide cuánta verificación y cuántos reintentos puedes permitirte, y los puntos
ciegos deciden qué errores nadie mira.

Y un techo honesto: ningún modelo local de esta clase toma decisiones de diseño
en tareas ambiguas como un sénior. Lo que sí hace, si el arnés lo sujeta, es
ejecutar como un sénior una tarea que un sénior le haya enunciado.

## Lo medido

### El modelo en esta máquina

| | |
|---|---|
| Reparto | **23 % en GPU (6 GB) / 77 % en CPU** |
| Carga en frío | 21 s |
| Generación | **45 tok/s** (sorprendente para 36B: es un MoE con pocos parámetros activos) |
| Prefill sin caché | **~680 tok/s** → un turno de 16k tokens = 24 s |
| Prefill con caché KV | **~10.000 tok/s** → el mismo turno ≈ 1 s |
| Razonamiento (`think`) | +1.700 caracteres y +9 s para una pregunta de una frase |

La generación no es el problema. **El prefill lo es**, y sólo cuando no hay
caché. Toda la optimización de velocidad de este documento se reduce a una
idea: que el prompt de cada turno empiece exactamente igual que el anterior.

### La caché KV, medida con la forma real de los prompts de Rubus

| Escenario | Prefill |
|---|---|
| A · prompt de 11.5k tokens, primera vez | 19,6 s |
| B · el mismo prefijo + un turno más al final | **0,9 s** (el 4 %) |
| C · desaparece un bloque del medio (lo que hace Rubus en el turno 2 de cada paso) | **15,6 s** |

Rubus incluye el mapa del proyecto **sólo en el primer turno** de cada paso
(`includeRepoMap: turn === 1`) para ahorrar contexto. Con caché KV ese ahorro
sale carísimo: al quitar el bloque del medio, el turno 2 vuelve a pagar el
prefill completo. Son ~15 s por paso tirados.

### Una tarea real, de punta a punta

Proyecto sintético de 3 archivos. Tarea: «añade `timeoutMs` opcional (5000) a
`getUser` y `getOrders` con `AbortSignal.timeout`, actualiza la llamada en
`app.js` para pasar 3000, los tests deben seguir pasando». Con los ajustes por
defecto (`thinkInPlan` y `thinkInAct` activados, aprobación automática).

**Resultado: 6 min 39 s, 3/3 pasos, código correcto a la primera, 0 reintentos.**

```
   0–34 s   arranque + primer turno de explorar (prefill en frío)
  34–85 s   explorar: 6 herramientas (lee api.js, app.js, el test)      51 s
  85–168 s  PLANIFICAR: un solo turno                                  83 s
 168–201 s  línea base (npm test, 0,3 s) + primer turno de actuar      33 s
 201–296 s  paso 1: relee api.js y app.js, edita, npm test, edita      95 s
 296–315 s  pasos 2 y 3: "verificar app.js", "ejecutar los tests"      19 s
 315–399 s  REFLEXIONAR: un solo turno                                 84 s
```

16 turnos de modelo, media de 18,7 s, mínimo 2 s, máximo 116 s. Lo que se ve:

- **El 42 % del tiempo son dos turnos de prosa** (planificar y reflexionar),
  ~80 s cada uno: razonamiento largo + salida larga + re-prefill completo
  porque `dropEphemeral()` reescribe el historial justo antes.
- **El paso 1 releyó los dos archivos que explorar acababa de leer** (turnos de
  19 y 12 s). Explorar los lee, se descartan al planificar, y actuar empieza de
  cero. El planificador recibió sólo un resumen en prosa de 4.000 caracteres.
- **El plan tuvo 3 pasos donde hacía falta 1.** Los pasos 2 y 3 eran «verificar
  que app.js contiene 3000» y «ejecutar los tests» — relleno que el prompt
  prohíbe explícitamente y que el modelo hizo igual. El verificador ya había
  ejecutado `npm test` tras el paso 1.
- **Los dos `finish_step` largos** (24 s y 46 s) fueron el modelo redactando
  resúmenes con razonamiento activado. El resumen de un paso no necesita
  razonamiento.

Nada de esto es un error del modelo. Todo es coste del arnés.

## Qué cambiar, por rendimiento partido por esfuerzo

### A · Ajustes (hoy, sin tocar código)

1. **`agent.thinkInAct: false`.** El razonamiento en la fase de actuar costó en
   esta ejecución entre 10 y 40 s por turno y no cambió ni una decisión: el
   modelo acertó igual. Se conserva `thinkInPlan`, que es donde deliberar sí
   vale. El proyecto lo dejó activado por observabilidad —ver `config.js`—; en
   esta máquina la factura es demasiado alta para eso.
2. **Reflexionar sin razonamiento y con `num_predict` ~800.** Son 84 s para un
   informe que nadie lee entero. Cabe en 15.

Sólo con el primero, la tarea de arriba pasa de 399 s a 227 s con el mismo
código, medido (ver el A/B al final). El segundo aún no está aplicado.

### B · Arnés (código, en este orden)

3. **Prefijo de prompt estable.** Mantener el mapa del proyecto en TODOS los
   turnos, y moverlo justo detrás del prompt de sistema. Tras el turno 1 está en
   caché y cuesta 0 s de prefill; sólo cuesta 2.600 tokens de los 21.000 de
   presupuesto. Ahorra ~15 s por paso. Es el cambio con mejor relación
   rendimiento/líneas de todo el documento: son tres líneas en `context.js`.

4. **Precargar `step.files` al empezar el paso.** El plan ya dice qué archivos
   toca cada paso; hoy sólo se enseñan como texto («ARCHIVOS PREVISTOS») y el
   modelo gasta sus dos primeros turnos en `read_file`. Inyectarlos como bloque
   en el turno 1 ahorra 2 turnos por paso —en la prueba, 31 s— y además da al
   modelo el contexto correcto sin que tenga que pedirlo.

5. **Que el planificador vea código, no un resumen.** `dropEphemeral()` tira lo
   explorado y `planInstruction` recibe `truncateMiddle(findings, 4000)`: el
   plan se hace sobre la prosa del modelo acerca del código, nunca sobre el
   código. Es la causa más probable de los pasos de relleno: el resumen decía
   «hay un test», y el plan añadió «ejecutar el test». Pasarle los archivos
   leídos (acotados, ~6k tokens) da planes más cortos y mejor apuntados.

6. **Rechazar los pasos de relleno mecánicamente.** El prompt dice «nada de
   pasos de revisar/verificar/ejecutar tests» y el modelo los pone igual. Esa
   es exactamente la clase de regla que este proyecto impone en código y no por
   favor: en `parsePlan`, descartar un paso cuyas herramientas son sólo de
   lectura o `run_terminal_command` y cuyo título casa con
   `/verificar|comprobar|revisar|ejecutar (los )?tests/`. El verificador
   automático ya hace ese trabajo, y mejor.

7. **Lint y typecheck del proyecto objetivo como verificación.** Hoy el
   verificador hace `node --check` (sólo sintaxis) y la suite de tests. Si el
   proyecto tiene `eslint` o `tsconfig.json`, ejecutarlos tras cada mutación
   caza la clase de error que un modelo pequeño produce continuamente y que
   *parsea bien*: variable sin definir, import mal escrito, tipo incompatible.
   Es lo que un editor le grita a un sénior al instante y aquí nadie le grita
   al modelo. **Es la palanca de calidad más grande para tareas medianas**;
   para las pequeñas, la suite basta.

8. **Un turno de autorrevisión antes de aceptar `finish_step`** en pasos que
   hayan mutado algo: enseñarle su propio diff y preguntar «¿algo mal?». Un
   sénior relee su diff; el modelo hoy no. Barato (un turno con caché) y caza
   los errores mientras el contexto está fresco, no al final.

### C · Cómo enunciar las tareas (la parte humana)

La prueba de arriba salió sénior porque la tarea estaba enunciada como un sénior
le encarga algo a alguien de nivel medio: archivos concretos, comportamiento
exacto, criterio de éxito. Con «mejora el manejo de errores del cliente HTTP» el
mismo modelo produciría algo mediocre, y ningún arnés lo arregla. Regla:
**escribe la tarea como escribirías el paso 1 del plan.**

Y usa `.rubus/rules.md`. Se inyecta en todos los prompts, nunca se comprime, y
es donde caben las cosas que un sénior sabe de tu proyecto y el modelo no:
«nunca uses `any`», «los errores se manejan con `Result`, no con excepciones»,
«los tests van en `__tests__/` al lado del archivo».

## Qwen3.6 frente a Gemma4

Sólo hay un modelo instalado: `qwen3.6:latest`. Gemma4 no está, así que no lo
he podido medir, y no voy a inventar sus números.

Lo que sí se puede decir de `qwen3.6:36b` en esta máquina: **es la elección
correcta**, y por una razón que no es obvia. Un dense de 36B sobre 8 GB de VRAM
sería inutilizable (2–4 tok/s); este es un MoE y genera a 45 tok/s con tres
cuartos del modelo en CPU. Tiene tool calling nativo y razonamiento
—`capabilities: tools, thinking`—, que es lo que el arnés explota mejor.
Cambiar a un dense más pequeño (8B, 14B) para ganar velocidad no compensa: ya
vas rápido en generación, y perderías capacidad.

Sobre Gemma4, si lo pruebas: `model-profiles.js` supone que la familia Gemma no
tiene tool calling nativo y la lleva por el protocolo JSON con esquema forzado,
que es más frágil. Pero el perfil es una suposición que `/api/show` corrige:
si Ollama declara `tools`, se usan. Mira eso antes de sacar conclusiones.

## Hardware

Los 8 GB de VRAM sólo duelen en el prefill sin caché. Con el prefijo estable
(B3), el 90 % de los turnos ni lo notan. **El cambio de código B3 vale más que
una GPU de 16 GB para esta carga de trabajo**, y cuesta tres líneas.

No subas `ollama.numCtx` de 32k a 128k «porque el modelo lo admite»: el prefill
escala lineal, y cada turno que pierda la caché costaría dos minutos.

## Plan de implementación sugerido

| Orden | Qué | Esfuerzo | Ganancia |
|---|---|---|---|
| 1 | A1 + A2 (ajustes) | 0 | −40 % de tiempo |
| 2 | B3 prefijo estable | 3 líneas | −15 s por paso |
| 3 | B4 precarga de archivos | ~30 líneas | −2 turnos por paso |
| 4 | B6 rechazar relleno | ~15 líneas + test | planes más cortos |
| 5 | B5 código al planificador | ~40 líneas | planes mejores |
| 6 | B7 lint/typecheck del objetivo | ~80 líneas + tests | calidad en tareas medianas |
| 7 | B8 autorrevisión por paso | ~40 líneas | menos errores tardíos |

Con 1–4 la tarea de prueba bajaría de 6,5 min a ~2,5 min con el mismo código.
Con 6–7, las tareas donde hoy el modelo «parece» acertar y no acierta dejan de
pasar.

## Medición A/B: razonamiento en la fase de actuar

La misma tarea, el mismo modelo, el mismo proyecto restaurado. Única
diferencia: `agent.thinkInAct: false` (el razonamiento sigue activo al
planificar). Código resultante **idéntico** al de la ejecución de arriba,
tests en verde, 0 reintentos.

| Fase | `thinkInAct: true` (defecto) | `thinkInAct: false` | |
|---|---|---|---|
| Actuar, paso 1 (6 herramientas) | 95 s · ~16 s/turno | **28 s · ~4,7 s/turno** | **3,4× más rápido** |
| Reflexionar | 84 s | **28 s** | 3× |
| Planificar (razona en ambos) | 83 s | 127 s | ruido: depende de cuánto delibere |
| **Total** | **399 s** | **227 s** | **−43 %** |

Explorar no es comparable entre las dos (85 s frente a 27 s): en la primera el
modelo cargaba en frío y pagaba el primer prefill; en la segunda estaba
caliente. El dato limpio es el paso de actuar, que es donde se escribe el
código: **el razonamiento lo hizo tres veces más lento y no cambió ni una
línea.**

La variación de planificar (83 s → 127 s con el mismo prompt) es la otra
lección: con `think` activado, la duración de un turno depende de cuánto
decida deliberar el modelo, y eso no es estable de una ejecución a otra. Es el
motivo por el que en `engine.js` existe la escalada por «tokens agotados
razonando». Vale la pena pagarlo en planificar, donde una deliberación larga
puede cambiar el plan. En actuar, la decisión ya está tomada.

**Recomendación firme:** `thinkInAct: false` en esta máquina. Y si
`config.js` sigue defendiendo el valor actual por observabilidad —el argumento
es legítimo—, que sea con este número delante: cuesta el 43 % del tiempo de
cada tarea.
