/**
 * OM output rendering — provenance-labeled formats for om_memory_search and
 * om_memory_resolve (decisión 6 del plan B-híbrida). Footer pattern inspired
 * by pi-blackhole's render-summary.ts OM_FOOTER_BASIC.
 *
 * Presentation rules:
 *  - [relevance] and timestamp only on observations (reflections don't have
 *    them in the OM model — nothing like "null"/"undefined" is printed).
 *  - "Aparece en N sesiones" is always shown (N=1 included — confirms uniqueness).
 *  - Hits are labeled by provenance so they can't be confused with the
 *    "session index hits" of session_search.
 */

import type { OmMemoryHit, OmIndexStats, OmSessionInfo } from "./om";
import { truncate } from "./utils";

// @lat: [[om#Observational Memory#Tools om_memory_search y om_memory_resolve]]
export const OM_SEARCH_FOOTER = `----
Memorias OM indexadas desde los JSONL de sesión (pi-blackhole). Los ids [hex] se resuelven con om_memory_resolve; el contexto conversacional completo con session_read. Si la sesión es la actual, el drill-down entry-level (#N:path) lo da el tool recall de pi-blackhole.
----`;

/** Spanish thousands separator (13.504). */
export function formatNum(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function sesionesLabel(n: number): string {
  return n === 1 ? "1 sesión" : `${formatNum(n)} sesiones`;
}

function sessionLine(session: OmSessionInfo | undefined, sessionId: string): string {
  if (!session) return `Sesión: (no indexada) · ID: ${sessionId}`;
  const title = session.name || truncate(session.firstUserMessage ?? "", 60);
  const date = (session.startedAt ?? "").split("T")[0];
  return `Sesión: "${truncate(title, 80)}" (${date}) · Proyecto: ${session.projectSlug} · ID: ${sessionId}`;
}

function fuentesSuffix(sourceEntryIds: string[]): string {
  if (sourceEntryIds.length === 0) return "";
  const shown = sourceEntryIds.slice(0, 3).join(", ");
  return ` · Fuentes: ${shown}${sourceEntryIds.length > 3 ? "…" : ""}`;
}

/** One om_memory_search hit. */
export function formatMemoryHit(hit: OmMemoryHit, index: number): string {
  const { row, recurrence } = hit;
  const parts = [`### ${index}. [${row.memoryId}] ${row.kind}`];
  if (row.kind === "observation" && row.relevance) parts.push(`[${row.relevance}]`);
  parts.push(`[${row.status}]`);
  let header = parts.join(" ");
  if (row.kind === "observation" && row.timestamp) header += ` — ${row.timestamp}`;

  const lines = [header, truncate(row.content, 400) || "(sin contenido)"];
  lines.push(sessionLine(hit.session, row.sessionId));
  lines.push(`Aparece en ${sesionesLabel(recurrence)}${fuentesSuffix(row.sourceEntryIds)}`);
  lines.push(`→ om_memory_resolve("${row.memoryId}") · session_read("${row.sessionId}")`);
  return lines.join("\n");
}

/**
 * Full om_memory_search output: provenance header + hits + footer.
 * `hybrid` selects the provenance tag (FTS+embeddings vs FTS-only).
 */
export function formatMemorySearchOutput(
  hits: OmMemoryHit[],
  query: string,
  opts: { hybrid: boolean; stats: OmIndexStats },
): string {
  const tag = opts.hybrid
    ? "OM memory hits (índice FTS+embeddings de pi-session-search)"
    : "OM memory hits (índice FTS de pi-session-search)";
  const header =
    `${tag} — ${hits.length} memorias para "${query}" ` +
    `(${formatNum(opts.stats.active)} memorias activas indexadas en ${formatNum(opts.stats.sessionsWithOm)} sesiones):`;
  const body = hits.map((h, i) => formatMemoryHit(h, i + 1)).join("\n\n");
  return `${header}\n\n${body}\n\n${OM_SEARCH_FOOTER}`;
}

/** Full om_memory_resolve output (light: rows + recurrence + follow-ups). */
export function formatMemoryResolve(memoryId: string, hits: OmMemoryHit[]): string {
  const first = hits[0].row;
  const recurrence = hits[0].recurrence;

  let header = `Memory ${memoryId} — ${first.kind}`;
  if (first.kind === "observation" && first.relevance) header += ` [${first.relevance}]`;
  header += ` — aparece en ${sesionesLabel(recurrence)}:`;

  // Same content hash ⇒ same content; capped fallbacks may differ — show the
  // longest non-empty one.
  const content = hits.map((h) => h.row.content).reduce((a, b) => (b.length > a.length ? b : a), "");

  const lines = [header, "", "Contenido:", `"${content || "(contenido no disponible — sesión original no accesible)"}"`, "", "Presencia:"];
  hits.forEach((hit, i) => {
    const { row } = hit;
    const statusLabel = row.status === "dropped" ? "[dropped en esta sesión]" : "[active]";
    // §5.2: "name" (date) · project · [status] · observada ts · fuentes: … · ID: last
    let line = `${i + 1}. `;
    if (hit.session) {
      const title = hit.session.name || truncate(hit.session.firstUserMessage ?? "", 60);
      const date = (hit.session.startedAt ?? "").split("T")[0];
      line += `"${truncate(title, 80)}" (${date}) · ${hit.session.projectSlug}`;
    } else {
      line += "(no indexada)";
    }
    line += ` · ${statusLabel}`;
    if (row.kind === "observation" && row.timestamp) line += ` · observada ${row.timestamp}`;
    if (row.sourceEntryIds.length > 0) {
      const shown = row.sourceEntryIds.slice(0, 3).join(", ");
      line += ` · fuentes: ${shown}${row.sourceEntryIds.length > 3 ? "…" : ""}`;
    }
    line += ` · ID: ${row.sessionId}`;
    lines.push(line);
  });

  lines.push("");
  lines.push(
    `Follow-ups: session_read("<ID>") para el contexto completo de cada sesión. Si alguna es la sesión actual, recall("${memoryId}") (pi-blackhole) da la evidencia entry-level.`,
  );
  return lines.join("\n");
}

/** om_memory_resolve not-found message (with re-sync hint). */
export function formatMemoryNotFound(memoryId: string): string {
  return `No se encontró la memoria "${memoryId}". Puede pertenecer a una sesión aún no sincronizada; prueba /session-sync.`;
}
