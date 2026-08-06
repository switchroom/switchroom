/**
 * The thing being measured: one `POST /v1/default/banks/{bank}/memories/recall`.
 *
 * This is the READ path. The harness never calls `retain`, never PATCHes a
 * memory, and never touches `/observations` — the only endpoint reached from
 * here is the recall endpoint, and the only verb is POST-as-query (Hindsight's
 * recall takes a body, so it cannot be a GET).
 *
 * One honest caveat, recorded here rather than buried: a recall is `@audited`
 * server-side (`hindsight_api/api/http.py:4118`, tag `v0.8.6`), so an instance
 * with audit logging enabled for the `recall` action appends one audit row per
 * call. That is the endpoint's normal behaviour under any caller — the harness
 * adds no mutation of its own, and no `memory_units` / `reflections` row is
 * created, updated or deleted by a recall.
 */

/** Stable id of the query set below; recorded in `BenchConfig.querySet`. */
export const QUERY_SET_ID = "generic-v1";

/**
 * The replayed query set.
 *
 * Deliberately **bank-agnostic and fixed**: the sweep compares banks against
 * each other, so a per-bank query list would confound bank size with query
 * difficulty and make the whole x-axis meaningless. These are ordinary
 * multi-word natural-language queries — the shape an agent's auto-recall
 * actually sends — with no bank-specific proper nouns.
 *
 * A cell replays them round-robin, so two runs of the same cell issue the exact
 * same sequence of queries in the same order. That is what makes AC1 (±10 % p95
 * across repeated runs) a statement about the SYSTEM rather than about which
 * queries the sampler happened to draw.
 *
 * The consequence to be honest about: after the warm-up pass the query
 * embeddings and the pages those queries touch are warm, so these numbers are a
 * warm-cache measurement. That is the right choice for a regression instrument
 * (it isolates the change under test from cache luck) and the wrong one for
 * predicting a cold agent's first recall of the day.
 */
export const RECALL_QUERIES: readonly string[] = [
  "what did we decide about the deployment process",
  "open issues that are still blocked",
  "postgres configuration and tuning decisions",
  "how does authentication work here",
  "what went wrong in the last incident",
  "preferences about how to write reports",
  "recent changes to the build pipeline",
  "who is responsible for the review process",
  "outstanding follow-up work and commitments",
  "container restart and rollout procedure",
  "why was that approach rejected",
  "measurement results and benchmark numbers",
  "scheduling and cron behaviour",
  "known limitations of the current design",
  "what changed in the most recent release",
  "error handling and retry behaviour",
  "naming conventions used in this project",
  "cost and quota considerations",
  "notes about testing and coverage",
  "security constraints that must not be crossed",
];

export interface RecallOptions {
  apiUrl: string;
  timeoutMs: number;
  budget: string;
  maxTokens: number;
  /** Ask for the arm-attribution trace. NEVER set on a latency sample. */
  trace?: boolean;
  fetchImpl?: typeof fetch;
}

/** One recall call's outcome. `ms` is only meaningful when `ok` is true. */
export interface RecallSample {
  ok: boolean;
  /** Wall-clock ms from just before `fetch` to after the body is fully read. */
  ms: number;
  /** Result count, for a sanity check that the call did real work. */
  results: number;
  error?: string;
  /** Present only on a traced call. */
  trace?: unknown;
}

/** Hindsight REST base from an MCP-or-REST URL, mirroring `hindsightRestBase`. */
export function restBase(url: string): string {
  return url.replace(/\/mcp\/?$/, "").replace(/\/$/, "");
}

/**
 * Issue one recall and time it.
 *
 * The timer stops after the response BODY is fully consumed, not after headers.
 * A recall's body carries the result set, so header-only timing would
 * systematically under-report exactly the cells (high concurrency, large bank)
 * where the server is slowest to stream — i.e. it would flatter the number the
 * epic exists to move.
 *
 * Never throws: a failure is a `RecallSample` with `ok: false`, because a cell
 * that errors half its calls is a RESULT (recorded as `errors`), not a crash.
 */
export async function recallOnce(bank: string, query: string, opts: RecallOptions): Promise<RecallSample> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${restBase(opts.apiUrl)}/v1/default/banks/${encodeURIComponent(bank)}/memories/recall`;
  const body = JSON.stringify({
    query,
    types: ["world", "experience"],
    budget: opts.budget,
    max_tokens: opts.maxTokens,
    trace: opts.trace === true,
  });
  const started = performance.now();
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    const text = await res.text();
    const ms = performance.now() - started;
    if (!res.ok) return { ok: false, ms, results: 0, error: `HTTP ${res.status}` };
    let parsed: { results?: unknown[]; trace?: unknown };
    try {
      parsed = JSON.parse(text) as { results?: unknown[]; trace?: unknown };
    } catch {
      return { ok: false, ms, results: 0, error: "unparseable JSON body" };
    }
    const results = Array.isArray(parsed.results) ? parsed.results.length : 0;
    return opts.trace === true
      ? { ok: true, ms, results, trace: parsed.trace }
      : { ok: true, ms, results };
  } catch (e) {
    return {
      ok: false,
      ms: performance.now() - started,
      results: 0,
      error: (e as Error).name === "TimeoutError" ? `timeout >${opts.timeoutMs}ms` : (e as Error).message,
    };
  }
}
