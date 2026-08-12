#!/usr/bin/env node
/**
 * Regenerates `src/hindsight-watch/repaired-fleet.fixture.ts` from live recall
 * logs.
 *
 * This exists because the fixture it writes is the population every recall
 * threshold is judged safe against, and a fixture nobody can reproduce is a
 * fixture nobody can re-derive a threshold from. The 2026-07-27 predecessor
 * had no generator, which is why its successor could only be built by hand.
 *
 * Usage:
 *
 *   node scripts/capture-recall-fixture.mjs \
 *     --root ~/.switchroom/agents \
 *     --from 2026-08-10T00:00:00Z \
 *     --to   2026-08-13T00:00:00Z \
 *     > src/hindsight-watch/repaired-fleet.fixture.ts
 *
 * `--root` defaults to `$HOME/.switchroom/agents`. The window bounds are
 * REQUIRED and are half-open [from, to), so a re-run over the same window
 * against the same logs is byte-identical — the capture is a pure function of
 * the log contents and the bounds, with no "last N rows" cutoff that silently
 * changes meaning as the logs grow.
 *
 * Content: numeric telemetry only. Bank ids are remapped to `agent-NN` /
 * `side-NN`, so no query text, no memory content, and no agent identity
 * reaches the repo. The remap is stable within a run and preserves the
 * structure the reducer depends on (the own bank is matched by id and is not
 * always at index 0).
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}
const ROOT = args.get("root") ?? join(process.env.HOME ?? "", ".switchroom/agents");
const FROM = args.get("from");
const TO = args.get("to");
if (!FROM || !TO) {
  console.error("--from and --to are required (ISO-8601, half-open [from, to))");
  process.exit(2);
}

/** Target row count after sampling. See "Sampling" in the emitted header. */
const TARGET = 260;
/** Rows per window a production tick reads, per agent. */
const WINDOW_ROWS = 200;

function readRows() {
  const out = [];
  for (const agent of readdirSync(ROOT).sort()) {
    const data = join(ROOT, agent, ".claude/plugins/data");
    if (!existsSync(data)) continue;
    for (const plugin of readdirSync(data).sort()) {
      const f = join(data, plugin, "state/recall_log.jsonl");
      if (!existsSync(f)) continue;
      for (const line of readFileSync(f, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let r;
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        // Cache hits are excluded from every SLI denominator by the reducer,
        // so a fixture carrying them would misstate its own n.
        if (r.cache_hit) continue;
        if (typeof r.ts !== "string" || r.ts < FROM || r.ts >= TO) continue;
        out.push({ agent, row: r });
      }
    }
  }
  return out;
}

// The emitted header must never carry the operator's home path — the repo's
// `check-no-pii-secrets` guard rejects it, and rightly: a fixture header is
// documentation, not a machine record of where it was captured.
const DISPLAY_ROOT = "~/.switchroom/agents";

const all = readRows();
if (all.length === 0) {
  console.error(`no rows in [${FROM}, ${TO}) under ${ROOT}`);
  process.exit(1);
}

// ── id remapping ────────────────────────────────────────────────────────────
const agentIds = new Map();
const sideIds = new Map();
const pad = (n) => String(n).padStart(2, "0");
for (const { agent } of all) {
  if (!agentIds.has(agent)) agentIds.set(agent, `agent-${pad(agentIds.size + 1)}`);
}
function mapBank(ownAgent, bankId) {
  // The row's own bank keeps the agent's mapped id; every other bank in the
  // fan-out becomes a stable `side-NN`, so the own-bank match still works.
  if (bankId === ownAgent) return agentIds.get(ownAgent);
  if (agentIds.has(bankId)) return agentIds.get(bankId);
  if (!sideIds.has(bankId)) sideIds.set(bankId, `side-${pad(sideIds.size + 1)}`);
  return sideIds.get(bankId);
}

// ── sampling ────────────────────────────────────────────────────────────────
// Stratified per agent (every k-th row in time order) so each agent keeps its
// share, then the EXTREMES the even sample dropped are forced back in. Without
// that second step a fixture degenerates into comfortable constants and
// validates threshold DIRECTION while claiming threshold SAFETY.
const byAgent = new Map();
for (const r of all) {
  if (!byAgent.has(r.agent)) byAgent.set(r.agent, []);
  byAgent.get(r.agent).push(r);
}
for (const rows of byAgent.values()) rows.sort((a, b) => (a.row.ts < b.row.ts ? -1 : 1));

const keep = new Set();
for (const rows of byAgent.values()) {
  const k = Math.max(1, Math.round(all.length / TARGET));
  for (let i = 0; i < rows.length; i += k) keep.add(rows[i]);
}

const num = (r, f) => (typeof r.row[f] === "number" ? r.row[f] : null);
function forceExtremes(field, cmp, n = 6) {
  const scored = all.filter((r) => num(r, field) !== null).sort(cmp);
  for (const r of scored.slice(0, n)) keep.add(r);
}
forceExtremes("total_elapsed_ms", (a, b) => num(b, "total_elapsed_ms") - num(a, "total_elapsed_ms")); // slowest
forceExtremes("pre_cap_count", (a, b) => num(a, "pre_cap_count") - num(b, "pre_cap_count")); // smallest pools
forceExtremes("injected_score_max", (a, b) => num(a, "injected_score_max") - num(b, "injected_score_max")); // worst scores
for (const r of all.filter((r) => r.row.result_count === 0)) keep.add(r); // zero-memory rows

// Emitted in GLOBAL time order, not grouped by agent: `recall-degradation.
// test.ts` replays contiguous windows across this array, and that replay is
// only meaningful if adjacent entries are adjacent in time.
const sample = [...keep].sort((a, b) => (a.row.ts < b.row.ts ? -1 : 1));

// ── measured properties, for the emitted header ─────────────────────────────
const q = (v, p) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(Math.max(1, Math.ceil(p * s.length)), s.length) - 1];
};
function stats(rows) {
  const lat = rows.map((r) => num(r, "total_elapsed_ms")).filter((x) => x !== null);
  const score = rows.map((r) => num(r, "injected_score_max")).filter((x) => x !== null);
  const pool = rows.map((r) => num(r, "pre_cap_count")).filter((x) => x !== null);
  const dl = rows.map((r) => num(r, "deadline_effective_ms")).filter((x) => x !== null && x > 0);
  return {
    n: rows.length,
    latP50: q(lat, 0.5), latP90: q(lat, 0.9), latP95: q(lat, 0.95), latMax: q(lat, 1),
    scP10: q(score, 0.1), scP50: q(score, 0.5), scP90: q(score, 0.9), scN: score.length,
    poolP10: q(pool, 0.1), poolP50: q(pool, 0.5), poolMin: q(pool, 0),
    dlP50: dl.length ? q(dl, 0.5) : null,
    hits: rows.filter((r) => r.row.deadline_hit === true).length,
    zero: rows.filter((r) => r.row.result_count === 0).length,
    degraded: rows.filter((r) => (r.row.bank_timings ?? []).some((b) => b.bank_id === r.agent && (b.timed_out || b.errored))).length,
  };
}
const full = stats(all);
const samp = stats(sample);

// ── emit ────────────────────────────────────────────────────────────────────
const j = (x) => JSON.stringify(x);
const lines = [];
lines.push(`/**
 * A REAL healthy-fleet sample, captured from the live logs over the half-open
 * window **${FROM} → ${TO}**. The last row in it is
 * \`${sample[sample.length - 1].row.ts}\` — the window is the BOUND, not a claim
 * that traffic ran to its end.
 *
 * ## Regenerating
 *
 * \`\`\`
 * node scripts/capture-recall-fixture.mjs \\
 *   --root ${DISPLAY_ROOT} \\
 *   --from ${FROM} --to ${TO} \\
 *   > src/hindsight-watch/repaired-fleet.fixture.ts
 * \`\`\`
 *
 * Deterministic for a given window and a given set of logs. It is NOT
 * reproducible from a different host, and the logs rotate — re-running this in
 * a year against the same bounds will produce fewer rows or none. Treat a
 * regeneration as a NEW capture: re-derive the thresholds from the new
 * distribution and update the guard assertions in \`recall-degradation.test.ts\`
 * to match, rather than editing constants to keep this file green.
 *
 * ## Why this exists alongside \`healthy-fleet.fixture.ts\`
 *
 * \`healthy-fleet.fixture.ts\` is the 2026-07-27 capture, and its own header says
 * what to do next: *"re-run the capture against the live logs once recall is
 * repaired, and re-derive the thresholds from the new distribution rather than
 * editing constants to keep this file green."* This is that capture.
 *
 * The 2026-07-27 fixture was conditioned ("no bank timed out, errored, or hit
 * the shared deadline") because a repaired fleet did not exist to sample. That
 * proxy is honest about score and pool and MISLEADING about latency: its p95 of
 * 8037 ms is right-censored at the then-8 s per-bank wall, i.e. that population
 * was itself running AT the wall. It is a picture of recall that survived, not
 * of recall that was fast.
 *
 * This capture needs no conditioning, because the fleet is genuinely healthy:
 * over the full ${full.n}-row window, ${full.degraded} row(s) had a degraded own bank and
 * ${full.hits} row(s) hit the deadline. So the tails here are the real tails of a
 * working fleet, which is what a latency threshold has to be safe against.
 *
 * ## Measured properties of the full window (n=${full.n}), which this sample tracks
 *
 *   wall time    p50 ${full.latP50} ms   p90 ${full.latP90} ms   p95 ${full.latP95} ms   max ${full.latMax} ms
 *   injected     p10 ${full.scP10}  p50 ${full.scP50}  p90 ${full.scP90}   (n=${full.scN} scored)
 *   pool         p10 ${full.poolP10}      p50 ${full.poolP50}      min ${full.poolMin}
 *   zero-memory  ${full.zero}/${full.n}
 *   own-bank degraded  ${full.degraded}/${full.n}
 *   deadline_effective_ms  p50 ${full.dlP50}   deadline_hit  ${full.hits}/${full.n}
 *
 * ## Sampling
 *
 * Stratified per agent (every k-th row in time order) down to ~${TARGET} rows, then
 * the EXTREMES the even sample dropped are forced back in — the zero-result
 * rows, the smallest candidate pools, the slowest recalls, the lowest scores.
 * That step is not cosmetic: the 2026-07-27 fixture's header records that its
 * predecessor was a flat set of constants with no tails, and that a tail-less
 * fixture "validated threshold DIRECTION while its name claimed threshold
 * SAFETY". n=${samp.n} after tail preservation, and the sample's p95 (${samp.latP95} ms) is
 * ${samp.latP95 >= full.latP95 ? "slightly CONSERVATIVE against" : "below"} the full window's ${full.latP95} ms.
 *
 * Rows are emitted in GLOBAL time order and each carries its \`ts\`, so a
 * contiguous replay across the array is a replay in time. Note the sample is
 * ${samp.n} of ${full.n} rows, so N adjacent entries here span roughly
 * ${(full.n / samp.n).toFixed(1)}× the wall-clock of N adjacent rows in the raw log.
 *
 * Content: numeric telemetry only. Bank ids are remapped to \`agent-NN\` /
 * \`side-NN\` — no query text, no memory content, no agent identity. The remap
 * preserves the structure the reducer depends on (the own bank is matched by
 * id, and is not always at index 0).
 *
 * @generated by scripts/capture-recall-fixture.mjs — do not hand-edit
 */

export interface RepairedFixtureRow {
  ts: string;
  agent: string;
  bank_id: string;
  result_count: number | null;
  total_elapsed_ms: number | null;
  pre_cap_count: number | null;
  overlap_dropped: number | null;
  injected_score_max: number | null;
  deadline_hit: boolean | null;
  deadline_effective_ms: number | null;
  bank_timings: Array<{
    bank_id: string;
    elapsed_ms: number | null;
    timed_out: boolean;
    errored: boolean;
  }>;
}

/** Rows a production tick reads per agent — the replay window size. */
export const REPAIRED_FLEET_WINDOW_ROWS = ${WINDOW_ROWS};

export const REPAIRED_FLEET_ROWS: RepairedFixtureRow[] = [`);

for (const { agent, row } of sample) {
  const timings = (row.bank_timings ?? []).map(
    (b) =>
      `      { bank_id: ${j(mapBank(agent, b.bank_id))}, elapsed_ms: ${
        typeof b.elapsed_ms === "number" ? b.elapsed_ms : null
      }, timed_out: ${Boolean(b.timed_out)}, errored: ${Boolean(b.errored)} },`,
  );
  lines.push(`  {
    ts: ${j(row.ts)},
    agent: ${j(agentIds.get(agent))},
    bank_id: ${j(mapBank(agent, row.bank_id ?? agent))},
    result_count: ${typeof row.result_count === "number" ? row.result_count : null},
    total_elapsed_ms: ${typeof row.total_elapsed_ms === "number" ? row.total_elapsed_ms : null},
    pre_cap_count: ${typeof row.pre_cap_count === "number" ? row.pre_cap_count : null},
    overlap_dropped: ${typeof row.overlap_dropped === "number" ? row.overlap_dropped : null},
    injected_score_max: ${typeof row.injected_score_max === "number" ? row.injected_score_max : null},
    deadline_hit: ${typeof row.deadline_hit === "boolean" ? row.deadline_hit : null},
    deadline_effective_ms: ${
      typeof row.deadline_effective_ms === "number" ? row.deadline_effective_ms : null
    },
    bank_timings: [${timings.length ? `\n${timings.join("\n")}\n    ` : ""}],
  },`);
}
lines.push("];");
process.stdout.write(lines.join("\n") + "\n");
