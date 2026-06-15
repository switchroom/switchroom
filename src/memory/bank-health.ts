/**
 * Hindsight bank-health inspection over the REST API.
 *
 * The MCP endpoint (memory.config.url, e.g. http://127.0.0.1:18888/mcp/)
 * is what agents talk to; the same server also exposes a REST surface at
 * the URL root (/v1/default/banks/...) which is the only way to inspect a
 * bank's ingest pipeline from the outside: document list with per-document
 * extracted-fact counts, bank statistics, and mental models with refresh
 * timestamps.
 *
 * Built for the 2026-06-10 incident class: conversations were retained
 * (documents stored) but fact extraction silently produced ZERO memory
 * units for days (consumer OAuth quota wall / shm exhaustion), so agents
 * "remembered" nothing from that window while every health surface stayed
 * green. A document with memory_unit_count === 0 is the durable, queryable
 * fingerprint of that failure — recoverable via the /reprocess endpoint.
 *
 * All functions are best-effort with short timeouts and never throw;
 * callers (doctor, web dashboard) render the failure reason.
 */

export interface BankDocumentSummary {
  id: string;
  createdAt: string;
  textLength: number;
  memoryUnitCount: number;
}

export interface BankMentalModelSummary {
  id: string;
  name: string;
  lastRefreshedAt: string | null;
  createdAt: string | null;
  /** Length of the rendered content (0 when absent). */
  contentLength: number;
  /** First ~200 chars of content — enough for corruption fingerprinting. */
  contentHead: string;
  /**
   * The recall question this model answers — hindsight's `source_query`. This
   * is the "why" of a model: the operator reads it and knows what the model is
   * FOR without opening its content. Empty string when absent.
   */
  sourceQuery: string;
  /** Refresh trigger mode (`full` | `incremental` | …) from `trigger.mode`. */
  refreshMode: string | null;
}

/**
 * Full detail for one mental model — the content the operator actually wants
 * to read, plus its provenance (how many source facts it was synthesized
 * from, by type). Fetched on demand per-model so the memory-health list stays
 * light: the list carries summaries; the operator expands one model to pull
 * its full text + provenance.
 */
export interface MentalModelDetail {
  id: string;
  name: string;
  /** The recall question this model answers (the "why"). */
  sourceQuery: string;
  /** The rendered content injected into the agent's context on recall. */
  content: string;
  lastRefreshedAt: string | null;
  createdAt: string | null;
  refreshMode: string | null;
  /**
   * Count of the source facts this model was synthesized FROM, keyed by fact
   * type (observation, directives, world, opinion, experience, mental-models).
   * This is the provenance — it makes "how memory works" concrete: e.g.
   * `{ observation: 24, directives: 11, "mental-models": 3 }`.
   */
  basedOnCounts: Record<string, number>;
  /** Sum of basedOnCounts — total source facts behind this model. */
  totalSourceFacts: number;
}

export interface BankHealth {
  bankId: string;
  ok: boolean;
  reason?: string;
  /** From /stats */
  totalDocuments: number;
  totalFacts: number;
  pendingOperations: number;
  /** From /documents */
  newestDocumentAt: string | null;
  /** Documents stored but with zero extracted facts (the extraction-gap fingerprint). */
  unextractedDocuments: BankDocumentSummary[];
  /** From /mental-models */
  mentalModels: BankMentalModelSummary[];
}

/** Derive the REST base URL from the configured MCP URL (strip /mcp/ suffix). */
export function hindsightRestBase(mcpUrl: string): string {
  return mcpUrl.replace(/\/mcp\/?$/, "").replace(/\/$/, "");
}

const DOCUMENTS_PAGE_LIMIT = 500;

interface FetchOpts {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

async function getJson<T>(
  url: string,
  opts?: FetchOpts,
): Promise<{ ok: true; data: T } | { ok: false; reason: string }> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  // Generous default: the documents endpoint pages 500 rows and the server
  // may be mid-extraction (exactly when an operator runs doctor) — observed
  // >5s under reprocess load on an otherwise healthy instance.
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` };
    return { ok: true, data: (await resp.json()) as T };
  } catch (err) {
    clearTimeout(timeout);
    if ((err as Error).name === "AbortError") return { ok: false, reason: "Timeout" };
    return { ok: false, reason: String((err as Error).message ?? err) };
  }
}

/**
 * Inspect one bank's health: stats, document recency + extraction gaps,
 * and mental-model freshness. Never throws; an unreachable/erroring
 * server yields `{ ok: false, reason }` with zeroed counters.
 */
export async function inspectBankHealth(
  mcpUrl: string,
  bankId: string,
  opts?: FetchOpts,
): Promise<BankHealth> {
  const base = hindsightRestBase(mcpUrl);
  const bank = encodeURIComponent(bankId);
  const empty: BankHealth = {
    bankId,
    ok: false,
    totalDocuments: 0,
    totalFacts: 0,
    pendingOperations: 0,
    newestDocumentAt: null,
    unextractedDocuments: [],
    mentalModels: [],
  };

  const stats = await getJson<{
    total_documents?: number;
    total_nodes?: number;
    pending_operations?: number;
  }>(`${base}/v1/default/banks/${bank}/stats`, opts);
  if (!stats.ok) return { ...empty, reason: stats.reason };

  const docs = await getJson<{
    items?: Array<{
      id?: string;
      created_at?: string;
      text_length?: number;
      memory_unit_count?: number;
    }>;
  }>(
    `${base}/v1/default/banks/${bank}/documents?limit=${DOCUMENTS_PAGE_LIMIT}`,
    opts,
  );
  if (!docs.ok) return { ...empty, reason: docs.reason };

  const models = await getJson<{
    items?: Array<{
      id?: string;
      name?: string;
      last_refreshed_at?: string | null;
      created_at?: string | null;
      content?: string | null;
      source_query?: string | null;
      trigger?: { mode?: string | null } | null;
    }>;
  }>(`${base}/v1/default/banks/${bank}/mental-models`, opts);
  if (!models.ok) return { ...empty, reason: models.reason };

  const docItems = docs.data.items ?? [];
  let newestDocumentAt: string | null = null;
  const unextracted: BankDocumentSummary[] = [];
  for (const d of docItems) {
    const createdAt = d.created_at ?? "";
    if (createdAt && (!newestDocumentAt || createdAt > newestDocumentAt)) {
      newestDocumentAt = createdAt;
    }
    if ((d.memory_unit_count ?? 0) === 0 && d.id) {
      unextracted.push({
        id: d.id,
        createdAt,
        textLength: d.text_length ?? 0,
        memoryUnitCount: 0,
      });
    }
  }
  unextracted.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return {
    bankId,
    ok: true,
    totalDocuments: stats.data.total_documents ?? docItems.length,
    totalFacts: stats.data.total_nodes ?? 0,
    pendingOperations: stats.data.pending_operations ?? 0,
    newestDocumentAt,
    unextractedDocuments: unextracted,
    mentalModels: (models.data.items ?? [])
      .filter((m): m is { id: string; name: string; last_refreshed_at?: string | null; created_at?: string | null; content?: string | null; source_query?: string | null; trigger?: { mode?: string | null } | null } =>
        typeof m?.id === "string" && typeof m?.name === "string",
      )
      .map((m) => ({
        id: m.id,
        name: m.name,
        lastRefreshedAt: m.last_refreshed_at ?? null,
        createdAt: m.created_at ?? null,
        contentLength: (m.content ?? "").length,
        contentHead: (m.content ?? "").slice(0, 200),
        sourceQuery: m.source_query ?? "",
        refreshMode: m.trigger?.mode ?? null,
      })),
  };
}

/**
 * Fetch one mental model's full detail (content + provenance) by id. Used by
 * the dashboard's on-demand "view model" expander — the operator clicks a
 * model to read what it actually knows and where it came from. The bank-health
 * list endpoint deliberately truncates content (corruption fingerprint only);
 * this is how the full text is pulled, one model at a time. Never throws.
 */
export async function getMentalModelDetail(
  mcpUrl: string,
  bankId: string,
  modelId: string,
  opts?: FetchOpts,
): Promise<{ ok: true; model: MentalModelDetail } | { ok: false; reason: string }> {
  const base = hindsightRestBase(mcpUrl);
  const bank = encodeURIComponent(bankId);
  const id = encodeURIComponent(modelId);
  const res = await getJson<{
    id?: string;
    name?: string;
    source_query?: string | null;
    content?: string | null;
    last_refreshed_at?: string | null;
    created_at?: string | null;
    trigger?: { mode?: string | null } | null;
    reflect_response?: { based_on?: Record<string, unknown[]> | null } | null;
  }>(`${base}/v1/default/banks/${bank}/mental-models/${id}`, opts);
  if (!res.ok) return res;

  const m = res.data;
  const basedOn = m.reflect_response?.based_on ?? {};
  const basedOnCounts: Record<string, number> = {};
  let totalSourceFacts = 0;
  for (const [type, facts] of Object.entries(basedOn)) {
    const n = Array.isArray(facts) ? facts.length : 0;
    basedOnCounts[type] = n;
    totalSourceFacts += n;
  }

  return {
    ok: true,
    model: {
      id: m.id ?? modelId,
      name: m.name ?? modelId,
      sourceQuery: m.source_query ?? "",
      content: m.content ?? "",
      lastRefreshedAt: m.last_refreshed_at ?? null,
      createdAt: m.created_at ?? null,
      refreshMode: m.trigger?.mode ?? null,
      basedOnCounts,
      totalSourceFacts,
    },
  };
}

/** Days between an ISO timestamp and now (fractional, >= 0). */
export function ageDays(iso: string | null, now: Date = new Date()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (now.getTime() - t) / 86_400_000);
}

/**
 * Mental models whose content is a persisted LLM-failure message rather than
 * real synthesis. Observed live 2026-06-10: a refresh during an OAuth quota
 * wall stored the literal error ("You're out of extra usage · resets 3am
 * (UTC)") as the model's content — which then gets injected into every agent
 * turn until the next successful refresh. Fingerprint: tiny content matching
 * a quota/limit phrase, or empty content on a model that HAS refreshed.
 */
export function corruptedMentalModels(
  models: BankMentalModelSummary[],
): BankMentalModelSummary[] {
  const failurePhrase = /out of (extra )?usage|hit your (usage |session )?limit|resets \d|quota exceeded|rate.?limit/i;
  return models.filter((m) => {
    if (m.contentLength === 0) return m.lastRefreshedAt !== null;
    return m.contentLength < 300 && failurePhrase.test(m.contentHead);
  });
}

/** Mental models whose last refresh (or creation, if never refreshed) is older than `staleDays`. */
export function staleMentalModels(
  models: BankMentalModelSummary[],
  staleDays = 7,
  now: Date = new Date(),
): BankMentalModelSummary[] {
  return models.filter((m) => {
    const age = ageDays(m.lastRefreshedAt ?? m.createdAt, now);
    return age !== null && age > staleDays;
  });
}

/**
 * Unextracted documents newer than `withinDays` — the actionable extraction
 * gap. Documents under `minTextLength` are excluded: a trivial retain (a
 * one-line ack, a handoff stub) can legitimately yield zero facts, and
 * flagging it would leave the check permanently red. A real conversation
 * that extracted nothing is always well above this floor.
 */
export function recentUnextracted(
  docs: BankDocumentSummary[],
  withinDays = 30,
  now: Date = new Date(),
  minTextLength = 1000,
): BankDocumentSummary[] {
  return docs.filter((d) => {
    if (d.textLength < minTextLength) return false;
    const age = ageDays(d.createdAt, now);
    return age !== null && age <= withinDays;
  });
}
