# Observational Memory

Integración index-time con las memorias OM que pi-blackhole persiste en los JSONL de sesión: extracción, fold, persistencia FTS + embeddings, búsqueda híbrida y backfill selectivo.

La integración es **composición pura**: pi-blackhole escribe custom entries `om.*` y snapshots `om.folded` en los JSONL en el momento de grabarse; pi-session-search los extrae durante su sync habitual (re-ingesta por `sizeBytes`). pi-blackhole no requiere ningún cambio.

## Extracción y fold

[[src/om.ts#extractOmMemories]] pliega todos los entries OM de una sesión en filas deduplicadas, en una pasada whole-file y en orden de fichero.

- **Dos fuentes, una dedup**: custom entries (`om.observations.recorded`, `om.reflections.recorded`) y snapshots de compaction (`om.folded` en `entry.details`, ambas formas —directa y anidada— vía [[src/om.ts#unwrapMemoryDetails]]). Los ids son hash de contenido estables → first-valid-wins por id hace imposible duplicar.
- **Tombstones sesión-locales**: `om.observations.dropped` marca `status:"dropped"` solo en esa sesión; el mismo id puede estar activo en otra (espejo de `fold.ts` de pi-blackhole).
- **Guards estrictos vendored** de `pi-blackhole/src/om/ledger/types.ts`: lo inválido o desconocido se ignora (degrada a invisible, nunca crash).
- Divergencia aceptada: fold por fichero completo (incluye ramas abandonadas), no por rama.
- El parser la invoca como pasada separada tras el bucle principal, con guarda barata `raw.includes("om.")` ([[src/parser.ts#parseSession]]) — el ~84 % de sesiones sin OM no pagan la segunda pasada. Reflexiones nunca tienen `relevance` ni `timestamp` (modelo OM): se persisten como `''`.

## Esquema de persistencia

Tabla FTS5 `om_memories` (9 columnas; solo `content` indexado) creada con `IF NOT EXISTS` en `sessions-fts.db` (modo FTS) y en `hybrid-fts.db` (modo híbrido).

El resto de columnas son UNINDEXED scan-filter (`WHERE kind/status/relevance/session_id` — trivial a ~14 K filas). La DDL y el mapeo fila↔SQL viven en [[src/om.ts]] (`OM_TABLE_DDL`, `omRowToParams`, `dbRowToOmMemory`). Una fila por `(session_id, memory_id)`. Reflexiones persisten `relevance`/`timestamp` como `''` (modelo OM: no los tienen).

Embeddings en fichero propio `om-embeddings.db` ([[src/om-embeddings.ts#OmEmbeddingStore]]): si `hybrid-fts.db` se borra/regenera, los vectores sobreviven. pi-session-search es único escritor de las tres DBs.

## Embeddings de memorias y fingerprint

Un vector por `memory_id` distinto (hash de contenido), no por fila: ids compartidos entre sesiones reusan vector. Cada fila registra `model`/`dims` (fingerprint del embedder activo, [[src/om-embeddings.ts#omEmbedderFingerprint]]).

Regla anti-mezcla de espacios vectoriales: una fila es **stale** si su `(model, dims)` no coincide con el fingerprint activo → se trata como missing y se re-embebe con `INSERT OR REPLACE`. `loadAll(fp)` solo carga el fingerprint activo, así que la caché coseno nunca mezcla modelos. GC best-effort de vectores huérfanos al final de `sync()` cuando hubo remociones.

## Búsqueda híbrida RRF

[[src/session-index.ts#SessionIndex#searchMemories]] fusiona coseno (sobre caché perezosa de vectores OM, ~23,5 MB heap) y BM25 con Reciprocal Rank Fusion k=60 por fila (`session_id:memory_id`); recurrencia = `COUNT(DISTINCT session_id)` anotada después.

En [[src/fts-index.ts#FtsSessionIndex#searchMemories]] (sin embedder por construcción) degrada a BM25 puro con el mismo contrato de salida. Filtros estructurados (kind/relevance/status/session) vía [[src/om.ts#buildOmFilterClause]]; `status:"active"` por defecto — las dropped se indexan por valor histórico pero quedan ocultas salvo `status:"all"`.

## Tools om_memory_search y om_memory_resolve

`om_memory_search` busca hechos/decisiones OM en cualquier sesión (filtros kind/relevance/status/session); `om_memory_resolve` resuelve un id hex-12 a todas las sesiones que lo contienen. Registrados en [[src/index.ts]].

Salida **etiquetada por procedencia** ([[src/om-format.ts]]): cabecera `OM memory hits (índice FTS+embeddings de pi-session-search)` (o `índice FTS` en modo sin embedder) para distinguirse de los session hits de `session_search`; `[relevance]`/`timestamp` solo en observations; `Aparece en N sesiones` siempre (N=1 incluido); follow-ups `om_memory_resolve(id)` y `session_read(sessionId)`; footer que apunta al `recall` entry-level de pi-blackhole para la sesión actual.

## Backfill y reconcile

`/session-om-backfill` → [[src/session-index.ts#SessionIndex#syncOmBackfill]] (y homónimo FTS) puebla `om_memories` + `om_embeddings` sin re-embeber sesiones; [[src/session-index.ts#SessionIndex#reconcileOmEmbeddings]] mantiene los vectores al día.

Detección con [[src/om.ts#scanFileForOm]] (chunks 64 KB, early-exit, falsos positivos inocuos), reparse selectivo forzado, upsert de filas y embedding por id distinto (reanudable vía `missingIds`). El comando imprime conteos de verificación (filas, obs/ref, dropped, ids distintos, recurrentes, vectores).

El reconcile usa **puerta por conjunto** (DISTINCT ids no vacíos → `missingIds`; una igualdad de cardinalidades podría ocultar huérfano + faltante): re-embebe stales **desde `om_memories.content`** (texto más largo por id; sin reparsear ficheros — el sync incremental no re-parsea sesiones sin cambios de `sizeBytes`). Ids solo-vacíos se saltan y reportan. Wiring fire-and-forget tras el sync inicial, en el sync periódico y en `/session-sync`.

## Persistencia JSON con doble cap

`stripHeavyFields` conserva `omMemories` con doble cap ([[src/om.ts#capOmMemories]]): 8 K chars/memoria + **16 K agregado DURO por sesión**; metadata siempre íntegra; cualquier corte pone `omContentCapped: true`.

El agregado se llena por prioridad (reflexiones → critical/high → medium → low, desempate por recencia). La prioridad decide *qué* se conserva, no exime del cap: en la frontera se trunca parcial y fuera se vacía (`content:""`).

[[src/session-index.ts#SessionIndex#populateFtsFromIndex]] (rebuild del sidecar desde el JSON) repuebla `om_memories` y **re-parsea dirigido** los ficheros con `omContentCapped` para restaurar contenido verbatim; si el fichero desapareció, cae a las filas capeadas (resolve/recurrencia/filtros siguen funcionando). Sin este camino, las memorias desaparecerían silenciosamente del FTS tras un rebuild.
