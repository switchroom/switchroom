/**
 * Cache-hit telemetry for switchroom agents.
 *
 * Each long-lived agent process writes a session JSONL (one line per
 * SDK event) under `$CLAUDE_CONFIG_DIR/projects/<sanitized-cwd>/`. Every
 * `assistant` line carries a `message.usage` object with the
 * Anthropic-billed token counts, including cache_read_input_tokens and
 * cache_creation_input_tokens (sometimes split into ephemeral_1h /
 * ephemeral_5m). Aggregating those across the last N turns lets us
 * answer the practical question "is this agent's prefix cache actually
 * being hit?" without an external observability stack.
 *
 * Two pure functions: `readTurnUsages(jsonlPath, lastN)` streams the
 * file line-by-line and emits one `TurnUsage` per assistant line that
 * carries usage; `summarizeCache(turns)` rolls those into a
 * `CacheStats` ratio block. Streaming matters because production JSONLs
 * routinely exceed 10MB on long-lived agents — `readFileSync` +
 * `JSON.parse(line)` per line is fine, but loading the whole file as
 * one string is not.
 *
 * Defensive parsing throughout: malformed lines, missing usage,
 * unexpected sub-objects all decay to zero rather than throwing. The
 * CLI surfaces these aggregates and the per-agent `status` extension
 * surfaces a one-line summary; either path must keep working when the
 * JSONL has the occasional sub-agent attachment line or partial flush.
 */

import { existsSync, readFileSync } from "node:fs";

export interface TurnUsage {
  /** usage.cache_read_input_tokens — tokens served from cache (cheap). */
  cacheRead: number;
  /** usage.cache_creation_input_tokens — tokens written to cache. */
  cacheCreate: number;
  /** usage.cache_creation.ephemeral_1h_input_tokens — long-TTL slice of cacheCreate. */
  ephemeral1h: number;
  /** usage.cache_creation.ephemeral_5m_input_tokens — short-TTL slice of cacheCreate. */
  ephemeral5m: number;
  /** Plain (non-cached) input tokens. */
  input: number;
  /** Output tokens for the assistant turn. */
  output: number;
  /** Wall-clock timestamp parsed from the line (ms epoch); 0 if missing. */
  ts: number;
}

export interface CacheStats {
  turnsAnalyzed: number;
  /** sumRead / (sumRead + sumCreate). 0 when no usage data found. */
  hitRate: number;
  avgCreatePerTurn: number;
  avgReadPerTurn: number;
  /**
   * ephemeral_1h / (ephemeral_1h + ephemeral_5m). 0 when neither slice is
   * present (older Claude Code versions before the 1h ephemeral split).
   */
  ttl1hShare: number;
  /** ms epoch of the first analyzed turn, or null if none. */
  firstTurnTs: number | null;
  /** ms epoch of the last analyzed turn, or null if none. */
  lastTurnTs: number | null;
}

/**
 * Stream the JSONL line-by-line and return up to the last `lastN`
 * assistant turns that carry a `message.usage` object. Returns `[]` for
 * a missing file. Lines that fail JSON.parse, or that lack the
 * assistant + usage shape, are silently skipped. The caller decides
 * whether an empty result is interesting (the CLI omits the cache block
 * entirely).
 *
 * Why pluck the last N? A long-lived agent produces tens of thousands
 * of lines per week — averaging the whole history would smear over
 * stale Claude Code versions, prefix changes, model migrations, etc.
 * The last 20 turns are the relevant operational signal.
 */
export function readTurnUsages(jsonlPath: string, lastN: number): TurnUsage[] {
  if (!existsSync(jsonlPath)) return [];
  if (lastN <= 0) return [];

  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf-8");
  } catch {
    return [];
  }

  // Walk the file once, keep the most recent `lastN` matching turns in
  // a ring buffer. Avoids holding the entire turn list when the file is
  // large; we only care about the tail.
  const ring: TurnUsage[] = new Array<TurnUsage>(lastN);
  let count = 0;

  // Split on "\n" — JSONL files use LF. A final empty trailing line is
  // ignored by the parse-then-skip path below.
  const lines = raw.split("\n");
  for (const line of lines) {
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const turn = extractTurnUsage(obj);
    if (!turn) continue;
    ring[count % lastN] = turn;
    count++;
  }

  if (count === 0) return [];

  // Reconstruct the tail in chronological order. When count <= lastN we
  // just take the prefix; otherwise the ring needs to be unwound from
  // the next slot to wrap around.
  const out: TurnUsage[] = [];
  if (count <= lastN) {
    for (let i = 0; i < count; i++) out.push(ring[i]);
  } else {
    const start = count % lastN;
    for (let i = 0; i < lastN; i++) {
      out.push(ring[(start + i) % lastN]);
    }
  }
  return out;
}

/**
 * Extract a TurnUsage from a single parsed JSONL line, or null if the
 * line is not an assistant turn with a usage block. Handles BOTH
 * billing shapes Anthropic emits:
 *
 *   1. Flat:  usage.cache_creation_input_tokens = N
 *   2. Split: usage.cache_creation = { ephemeral_1h_input_tokens,
 *                                      ephemeral_5m_input_tokens }
 *
 * Newer Claude Code emits BOTH simultaneously (the flat number = sum of
 * the two ephemeral slices). We treat the flat number as authoritative
 * for cacheCreate and the split as informational for ttl1hShare.
 */
function extractTurnUsage(obj: unknown): TurnUsage | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.type !== "assistant") return null;

  const message = o.message as Record<string, unknown> | undefined;
  if (!message) return null;
  const usage = message.usage as Record<string, unknown> | undefined;
  if (!usage) return null;

  const cacheRead = numField(usage, "cache_read_input_tokens");
  const cacheCreateFlat = numField(usage, "cache_creation_input_tokens");
  const input = numField(usage, "input_tokens");
  const output = numField(usage, "output_tokens");

  let ephemeral1h = 0;
  let ephemeral5m = 0;
  const cc = usage.cache_creation as Record<string, unknown> | undefined;
  if (cc && typeof cc === "object") {
    ephemeral1h = numField(cc, "ephemeral_1h_input_tokens");
    ephemeral5m = numField(cc, "ephemeral_5m_input_tokens");
  }

  // If the line carried only the split (some older shapes) reconstruct
  // the flat from the parts. If neither is present, cacheCreate stays 0
  // and the turn still counts as analyzed (e.g. a cold hit-only turn).
  const cacheCreate =
    cacheCreateFlat > 0 ? cacheCreateFlat : ephemeral1h + ephemeral5m;

  // Reject a line that has zero of every signal we care about — likely
  // an attachment / tool_use sub-line rather than a real assistant
  // turn. Without this guard we'd inflate `turnsAnalyzed` with empty
  // entries from sub-agent transcripts.
  if (cacheRead === 0 && cacheCreate === 0 && input === 0 && output === 0) {
    return null;
  }

  let ts = 0;
  const tsRaw = o.timestamp;
  if (typeof tsRaw === "string") {
    const parsed = Date.parse(tsRaw);
    if (!isNaN(parsed)) ts = parsed;
  } else if (typeof tsRaw === "number") {
    ts = tsRaw;
  }

  return {
    cacheRead,
    cacheCreate,
    ephemeral1h,
    ephemeral5m,
    input,
    output,
    ts,
  };
}

function numField(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  if (typeof v === "number" && isFinite(v) && v >= 0) return v;
  return 0;
}

/**
 * Roll a list of TurnUsage entries into a single CacheStats. Empty
 * input → all-zero stats with `turnsAnalyzed: 0`.
 *
 * `hitRate` divides cache_read by (cache_read + cache_create) — the
 * fraction of total cache-eligible input that came from the cache
 * rather than being re-written. The remaining input_tokens (plain,
 * non-cached) are deliberately excluded: they can't be cached at all,
 * so including them in the denominator would understate hit rate when
 * the prompt has a small uncacheable suffix.
 */
export function summarizeCache(turns: TurnUsage[]): CacheStats {
  if (turns.length === 0) {
    return {
      turnsAnalyzed: 0,
      hitRate: 0,
      avgCreatePerTurn: 0,
      avgReadPerTurn: 0,
      ttl1hShare: 0,
      firstTurnTs: null,
      lastTurnTs: null,
    };
  }

  let sumRead = 0;
  let sumCreate = 0;
  let sum1h = 0;
  let sum5m = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for (const t of turns) {
    sumRead += t.cacheRead;
    sumCreate += t.cacheCreate;
    sum1h += t.ephemeral1h;
    sum5m += t.ephemeral5m;
    if (t.ts > 0) {
      if (firstTs === null || t.ts < firstTs) firstTs = t.ts;
      if (lastTs === null || t.ts > lastTs) lastTs = t.ts;
    }
  }

  const cacheTotal = sumRead + sumCreate;
  const hitRate = cacheTotal > 0 ? sumRead / cacheTotal : 0;
  const ttlTotal = sum1h + sum5m;
  const ttl1hShare = ttlTotal > 0 ? sum1h / ttlTotal : 0;

  return {
    turnsAnalyzed: turns.length,
    hitRate,
    avgCreatePerTurn: sumCreate / turns.length,
    avgReadPerTurn: sumRead / turns.length,
    ttl1hShare,
    firstTurnTs: firstTs,
    lastTurnTs: lastTs,
  };
}

/**
 * Format a CacheStats as a stable `key: value` text block. Each key is
 * a short stable identifier so shell scripts can `| grep ^cache_hit_rate:`
 * reliably. Window timestamps are emitted in ISO 8601 (Z) so they sort
 * lexicographically and round-trip through `date -d`.
 *
 * The agent name is passed in (rather than baked into CacheStats) so
 * the same struct can back the `status` line surface and the
 * standalone `perf` command without duplicating fields.
 */
export function formatCacheStatsText(agentName: string, stats: CacheStats): string {
  const lines: string[] = [];
  lines.push(`agent: ${agentName}`);
  lines.push(`turns_analyzed: ${stats.turnsAnalyzed}`);
  lines.push(`cache_hit_rate: ${stats.hitRate.toFixed(3)}`);
  lines.push(`avg_create_per_turn: ${Math.round(stats.avgCreatePerTurn)}`);
  lines.push(`avg_read_per_turn: ${Math.round(stats.avgReadPerTurn)}`);
  lines.push(`ttl_1h_share: ${stats.ttl1hShare.toFixed(3)}`);
  lines.push(`window: ${formatWindow(stats.firstTurnTs, stats.lastTurnTs)}`);
  return lines.join("\n");
}

function formatWindow(firstMs: number | null, lastMs: number | null): string {
  const fmt = (ms: number | null): string =>
    ms === null ? "—" : new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
  return `${fmt(firstMs)} .. ${fmt(lastMs)}`;
}
