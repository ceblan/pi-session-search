# pi-session-search

pi-session-search es un paquete/extension para **pi** que indexa sesiones pasadas (archivadas y activas) y expone herramientas para **buscar**, **listar** y **leer** conversaciones históricas.

## Visión general

Convierte sesiones JSONL de pi en un índice consultable: por defecto **FTS5** (keywords) y opcionalmente **híbrido** (FTS5 + embeddings semánticos) para recuperación de contexto.

## Componentes principales

Se divide en: (1) entrypoint de extensión pi, (2) dos índices intercambiables (FTS / híbrido), (3) parser JSONL y (4) lector paginado de conversaciones.

- Extensión pi: `src/index.ts`
- Configuración: `src/config.ts`
- Embedders: `src/embedder.ts`
- Índice FTS5: [[src/fts-index.ts#FtsSessionIndex]]
- Índice híbrido: [[src/session-index.ts#SessionIndex]]
- Parser JSONL: [[src/parser.ts#parseSession]] y [[src/parser.ts#discoverSessionFiles]]
- Lector de conversación: [[src/reader.ts#readSessionConversation]]
- Utilidades: [[src/utils.ts#buildSummary]] y helpers relacionados
- Observational Memory (OM): [[om#Observational Memory]] — extracción/fold ([[src/om.ts]]), store de embeddings ([[src/om-embeddings.ts]]), formato de salida ([[src/om-format.ts]])

## Documentación interna

Sección transversal que agrupa documentación de las herramientas internas del proyecto (tracker de commits, etc.).

- [[om]] — integración Observational Memory (extracción, esquema, tools, backfill)
- [[last-commit]] — tracking del último commit revisado por el documentator
- [[sqlite-tests]] — regresiones de apertura, concurrencia y rollback

## Directorios y artefactos persistentes

El paquete guarda configuración e índices bajo `~/.pi/session-search/`, tal como define [[src/config.ts#getConfigPath]] y [[src/config.ts#getIndexDir]].

- Config: `~/.pi/session-search/config.json`
- Índices: `~/.pi/session-search/index/`
  - Modo FTS-only: `sessions-fts.db`
  - Modo híbrido: `session-index.json` (metadatos + embeddings) y `hybrid-fts.db` (side-car FTS)
  - Memorias OM: tabla `om_memories` dentro de esas DBs + vectores en `om-embeddings.db` (fichero propio, fingerprinted por embedder) — ver [[om#Observational Memory]]

Las DBs SQLite usan WAL (`journal_mode=WAL`): junto a cada `.db` pueden aparecer ficheros transitorios `-wal`/`-shm`, y la conversión la aplica [[src/utils.ts#openIndexDb]] en cada apertura.

## Flujo de trabajo (end-to-end)

En ejecución normal, la extensión arranca un índice (FTS o híbrido), sincroniza sesiones desde disco y expone herramientas al agente para recuperar contexto.

1. **Inicio de sesión en pi** (`session_start` en `src/index.ts`): carga configuración con [[src/config.ts#loadConfig]].
2. Selecciona el índice:
   - Si hay `config.embedder`: crea embedder con [[src/embedder.ts#createEmbedder]] y usa [[src/session-index.ts#SessionIndex]].
   - Si no hay embedder: usa [[src/fts-index.ts#FtsSessionIndex]].
3. `load()` del índice (abre DBs y/o carga JSON persistente).
4. **Sync incremental** inicial en background (`sync()`): descubre archivos con [[src/parser.ts#discoverSessionFiles]], parsea con [[src/parser.ts#parseSession]] y actualiza el índice.
5. **Sync periódico**: cada ~5 minutos (jitter ±25% por proceso, para evitar que sesiones concurrentes sincronicen en manada) se ejecuta `sync()` para incorporar nuevas sesiones/cambios.
6. Antes de que arranque el agente (`before_agent_start`): se inyecta un *primer* con sesiones recientes (si el índice ya está listo) usando utilidades como [[src/utils.ts#formatRelativeDate]] y [[src/utils.ts#pathToSlug]].
7. Durante la sesión, el agente usa:
   - `session_search` para búsqueda
   - `session_list` para navegación
   - `session_read` para leer conversaciones

## Configuración

La configuración es opcional; si no existe `config.json`, el sistema opera en modo FTS-only. Cuando se configura un embedder, se habilita búsqueda híbrida.

### Archivo de configuración

El esquema está definido por la interfaz `Config` en `src/config.ts`.

- `extraSessionDirs: string[]` — directorios adicionales a escanear además de `~/.pi/agent/sessions/`.
- `extraArchiveDirs: string[]` — directorios adicionales a escanear además de `~/.pi/agent/sessions-archive/`.
- `embedder?: EmbedderConfig` — si existe, activa el índice híbrido con embeddings.

La lectura/escritura se realiza con [[src/config.ts#loadConfig]] y [[src/config.ts#saveConfig]].

### Embedders soportados

La factoría [[src/embedder.ts#createEmbedder]] soporta varios proveedores mediante `EmbedderConfig`.

- `openai` — OpenAI `/v1/embeddings` (por defecto `text-embedding-3-small`, 512 dims)
- `mistral` — Mistral `/v1/embeddings` (por defecto `mistral-embed`, 1024 dims)
- `bedrock` — AWS Bedrock Titan embeddings v2 (requiere AWS profile/region)
- `ollama` — Ollama local vía `POST /api/embed` (por defecto `nomic-embed-text`)
- `openai-compatible` — cualquier endpoint compatible con OpenAI (requiere `baseUrl`)

Variables de entorno relevantes (usadas como *fallback* cuando no se pone `apiKey` en config):

- `OPENAI_API_KEY`
- `MISTRAL_API_KEY`

## Herramientas y comandos expuestos en pi

El entrypoint en `src/index.ts` registra comandos interactivos (slash commands) y herramientas (tools) para el agente.

### Comandos

Comandos slash disponibles para el usuario dentro de una sesión pi.

- `/session-embeddings-setup` — asistente UI para crear/guardar `config.json` con embedder y directorios extra.
- `/session-sync` — fuerza una sincronización incremental inmediata (`sync()`).
- `/session-reindex` — fuerza un rebuild completo (`rebuild()`).

### Tools

Herramientas expuestas al agente para búsqueda y lectura de sesiones históricas.

- `session_search(query, limit?)` — búsqueda semántica o híbrida (si hay embedder) o keyword-only (FTS), devolviendo sesiones con score y summary.
- `session_list(project?, after?, before?, archived?, limit?)` — lista sesiones filtrando por proyecto (slug o cwd), rango temporal y archivado.
- `session_read(session, offset?, limit?, include_tools?)` — lee una conversación desde un `.jsonl` o desde un UUID; soporta paginación.

### Inyección automática de contexto (primer)

En el hook `before_agent_start`, la extensión compone una lista de sesiones recientes (por proyecto si puede derivarse desde el `cwd`) y la añade al `systemPrompt`. Esto usa `list()` del índice y funciones como [[src/utils.ts#truncate]] y [[src/utils.ts#formatRelativeDate]].

## Modelo de datos: ParsedSession

El parser construye un objeto `ParsedSession` (ver tipos en `src/parser.ts`) que resume un `.jsonl` completo en metadatos + texto útil para indexación.

Campos relevantes:

- Identidad y contexto: `id`, `file`, `cwd`, `projectSlug`, `archived`, `startedAt`, `endedAt`, `name?`
- Señales de recuperación: `userMessages`, `assistantText` (truncado), `compactionSummaries`, `branchSummaries`, `filesModified`
- Métricas: `userMessageCount`, `assistantMessageCount`, `totalCost`, `totalTokens`
- Auditoría: `toolCalls` (conteo por herramienta), `filesRead`, `filesModified`

El `projectSlug` se deriva del nombre del directorio contenedor del `.jsonl` (si empieza por `--...--`), y se presenta como ruta humana con [[src/utils.ts#slugToProject]].

## Indexación y sincronización

Ambos índices implementan operaciones similares: `load()`, `sync()`, `rebuild()`, `search()`, `list()`, `get()` y `size()`, pero difieren en su backend y señales.

### Regla de background: unref() obligatorio

Todos los timers de background DEBEN hacer `unref()`: pi sale en print mode drenando el event loop, y un handle activo cuelga el proceso para siempre.

Detalle: aplica al interval de sync creado en `startIndex`, al timeout de la carrera de sync inicial y a los timers de limpieza de status. Verificado el 2026-09-22 tras el upgrade a pi 0.87.0 (commit `5c19dbc`).

### Descubrimiento de sesiones

La función [[src/parser.ts#discoverSessionFiles]] escanea recursivamente directorios por defecto y extra (`sessions` y `sessions-archive`), filtrando `.jsonl` y excluyendo `pins.json` y `active-sessions.json`.

### Detección de movimientos vs cambios

Ambos índices usan el UUID de sesión para correlacionar archivos aunque cambien de ruta (p.ej. mover de activo → archive). Para evitar parseos completos al detectar movimientos, se usa [[src/parser.ts#readSessionId]] que lee solo la primera línea del JSONL.

- **Movimiento**: cambia la ruta, pero el tamaño del fichero (`sizeBytes`) no cambia → se actualiza metadata sin reindexar contenido.
- **Cambio real**: cambia el tamaño del fichero → se reparsea y reindexa.

### Resúmenes

Los resúmenes mostrados por las herramientas se generan con [[src/utils.ts#buildSummary]], que combina nombre (o primer mensaje), proyecto, métricas, modelos y un top de tool calls.

## Búsqueda

Hay dos modos según el índice activo.

### Modo FTS-only (SQLite FTS5)

[[src/fts-index.ts#FtsSessionIndex]] guarda cada sesión como una fila en una tabla virtual FTS5 (`sessions`) y ejecuta `MATCH` con ranking BM25.

- El campo indexado `content` se construye con [[src/fts-index.ts#buildContent]].
- La query del usuario se sanitiza y transforma con [[src/fts-index.ts#toFtsQuery]]:
  - elimina caracteres especiales de sintaxis FTS
  - convierte términos en `"term"`
  - junta términos con AND implícito (más preciso que OR)

El score de BM25 (donde menor es mejor) se normaliza a un score aproximado 0..1 para presentación.

### Modo híbrido (embeddings + FTS)

[[src/session-index.ts#SessionIndex]] mantiene:

- Un índice JSON (`session-index.json`) que almacena embedding por sesión (en base64) y metadatos.
- Un side-car FTS (`hybrid-fts.db`) que permite ranking keyword para fusión.

En búsqueda:

1. Se calcula embedding del query con `embedder.embed()`.
2. Se rankean sesiones por **cosine similarity**.
3. Se rankean sesiones por FTS (BM25) en el side-car.
4. Se fusionan ambos rankings con **Reciprocal Rank Fusion (RRF)** con `k=60`.

Los embeddings se serializan de forma compacta con [[src/session-index.ts#encodeEmbedding]] y se reconstruyen con [[src/session-index.ts#decodeEmbedding]].

## Lectura de conversaciones (session_read)

La función [[src/reader.ts#readSessionConversation]] formatea un `.jsonl` como texto legible, soportando paginación (`offset`, `limit`) y la opción `includeTools` para incluir resultados de herramientas.

Incluye:

- mensajes de usuario y asistente (solo bloques `text`)
- cambios de modelo (`model_change`)
- renombres (`session_info`)
- resúmenes de compaction y branch_summary
- (opcional) tool results truncados

## Consideraciones de seguridad y robustez

El tool `session_read` en `src/index.ts` incluye un *path traversal guard*: solo permite leer archivos dentro de las raíces permitidas (directorios default + extras configurados). Esto evita que el agente lea rutas arbitrarias por input malicioso.

Además, varios módulos son tolerantes a errores:

- Parser ignora líneas JSON inválidas y devuelve `null` si falta header.
- El índice ignora archivos sin `stat()` o sin UUID.
- El embedder en batch puede devolver `null` por item; el index salta embeddings fallidos.

### Concurrencia multi-proceso en las DBs SQLite

Toda sesión de pi abierta monta esta extensión sobre los mismos ficheros SQLite; con sesiones que viven días en paneles, conviven 10-15 procesos escribiendo el mismo índice. Reglas de apertura y transacción obligatorias:

Incidente 2026-11-14: un escritor atascado en PENDING más lectores con SHARED abandonados formaron un standoff permanente que rompía el init de toda sesión nueva ("database is locked").

- Apertura SIEMPRE con [[src/utils.ts#openIndexDb]]: `busy_timeout=30000` + `journal_mode=WAL`. WAL permite lectores durante un commit ordinario, pero sigue habiendo un único escritor; no elimina todos los posibles errores `SQLITE_BUSY`.
- Las seis transacciones de escritura usan [[src/utils.ts#withTransaction]] con `BEGIN IMMEDIATE`: reserva el escritor antes de las lecturas internas de FTS5. Con `BEGIN` diferido, la promoción de lectura a escritura puede fallar sin esperar el timeout.
- El cuerpo es síncrono. Si falla el cuerpo o `COMMIT`, se intenta `ROLLBACK` y se propaga el error original. Si falla la reserva inicial, el cuerpo no se ejecuta.
- WAL es persistente. Si falla la configuración de la conexión (incluida la conversión desde rollback), se cierra y se propaga el error: no se continúa silenciosamente sin WAL. Los locks heredados aún pueden impedir el inicio hasta que se liberen.

Las regresiones en [[sqlite-tests#Pruebas de SQLite]] cubren archivos temporales, dos conexiones y un escritor en un worker independiente; no usan las DBs del usuario.

Una recarga activa el código nuevo, pero no libera conexiones de otros procesos. Si los locks heredados impiden migrar a WAL, hay que cerrar sus procesos antes de reintentar; no renombrar ni sustituir una DB SQLite mientras siga en uso.

## Referencia por módulo

Esta sección resume la responsabilidad de cada archivo TypeScript en `src/`.

### `src/index.ts` (extensión pi)

Orquesta el ciclo de vida de la extensión: carga configuración, inicializa el índice (FTS u híbrido), ejecuta sync inicial y periódico, registra comandos y tools, y añade un primer de sesiones recientes antes de empezar el agente.

### `src/config.ts` (config e índices)

Gestiona rutas persistentes (`config.json` e `index/`) y ofrece [[src/config.ts#loadConfig]]/[[src/config.ts#saveConfig]] para leer/escribir configuración.

### `src/embedder.ts` (proveedores de embeddings)

Define interfaces `Embedder`/`EmbedderConfig` y construye implementaciones concretas con [[src/embedder.ts#createEmbedder]]. Incluye:

- OpenAI-compatible via `fetch` a `/v1/embeddings` (batching)
- AWS Bedrock con SDK (import dinámico)
- Ollama local (batch con tolerancia a errores)

### `src/parser.ts` (descubrimiento + parse JSONL)

Implementa descubrimiento recursivo de `.jsonl` con [[src/parser.ts#discoverSessionFiles]], lectura rápida de UUID con [[src/parser.ts#readSessionId]] y parse completo con [[src/parser.ts#parseSession]] para extraer señales de recuperación.

### `src/fts-index.ts` (índice keyword-only)

Implementa [[src/fts-index.ts#FtsSessionIndex]], que usa SQLite FTS5 como backend principal y expone búsqueda BM25, listados y sync incremental basado en `sizeBytes` + movimientos.

### `src/session-index.ts` (índice híbrido)

Implementa [[src/session-index.ts#SessionIndex]], que combina embeddings (persistidos en JSON) con un side-car FTS5 para fusión de rankings (RRF). Optimiza almacenamiento eliminando campos pesados del `ParsedSession` antes de persistir.

### `src/reader.ts` (renderizado de conversación)

Implementa [[src/reader.ts#readSessionConversation]] para convertir JSONL en un transcript legible con paginación y opcionalmente tool results truncados.

### `src/utils.ts` (helpers)

Incluye utilidades de presentación y normalización: [[src/utils.ts#truncate]], [[src/utils.ts#slugToProject]], [[src/utils.ts#pathToSlug]], [[src/utils.ts#formatRelativeDate]] y el resumen de sesión [[src/utils.ts#buildSummary]]. Además, [[src/utils.ts#openIndexDb]] y [[src/utils.ts#withTransaction]] centralizan el acceso SQLite (WAL, espera entre escritores y rollback ante errores).
