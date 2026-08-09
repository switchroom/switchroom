/**
 * Fleet Health — Layer-0 model-free detector (the nightly sensor).
 *
 * Design: `reference/rfcs/fleet-health.md` (serves `fleet-stays-healthy`,
 * outcome `always-available`). This is the TypeScript port of the validated
 * reference detector (`spec_audit_l0.py`) — same tuned constants, same precise
 * gateway signatures, same `synthetic-` exclusion, same `turn_id` join key.
 *
 * STRICTLY MODEL-FREE: no LLM call, no `claude -p`, zero tokens. It reads only
 * hard artifacts — the structured `turns.jsonl` oracle and precise gateway log
 * signatures — and emits a structured signal digest. Everything here is a pure
 * function over already-read text so it is trivially unit-testable and never
 * touches the network.
 */

import { ROUTE_FIELD_SHIP_TS } from "../../telegram-plugin/gateway/turn-record-status.js";

/** Tuned hang threshold: >6 min (live data p99 = 303 s). Load-bearing —
 *  do not casually change (see RFC "Tuned constants"). */
export const HANG_MS = 360_000;
/** A long turn with few tool calls is a stall (hang); a long turn with many
 *  tool calls is deep work. Load-bearing. */
export const HANG_MAXTOOLS = 2;

/**
 * Silent-no-op windowing floor (unix SECONDS) = 2026-07-13T00:00:00Z, the
 * fast-path ship epoch. The silent-no-op detector was over-counting a stale
 * pre-fix backlog (2026-07-02..07-06). We window the `silent-no-op-candidate`
 * finding — and ONLY that finding — to turns whose `ts` is at/after this floor,
 * so the ledger reflects current reality instead of pre-fix inflation.
 *
 * FIXED epoch, not a rolling window: a rolling window would hide a genuine
 * ongoing rate. This is param-injected into the detectors (never read from
 * `Date.now()` internally) to keep the module a pure function over its inputs.
 *
 * Verify: `date -u -d @1783900800` → Mon Jul 13 00:00:00 UTC 2026.
 */
export const SILENT_NOOP_FLOOR_TS = 1_783_900_800;

/** Options threaded into the turn detectors. Pure inputs only — no clock. */
export interface DetectOptions {
  /** Unix-seconds floor for the silent-no-op finding. Turns with `ts` below
   *  this are NOT flagged as silent-no-ops. Defaults to `SILENT_NOOP_FLOOR_TS`.
   *  Tests pass `0` to assert detector LOGIC independent of the calendar. */
  silentNoopFloorTs?: number;
  /** Unix-seconds cutoff for the honest-`route` field. A row LACKING `route`
   *  whose `ts` is below this predates the field and is aged out of the sev-3
   *  silent-no-op finding (it cannot be classified). A row lacking `route` at/
   *  after this is treated as `route: 'none'` so a regression that drops the
   *  field still surfaces. Defaults to `ROUTE_FIELD_SHIP_TS`. */
  routeFieldShipTs?: number;
}

/** One row of `turns.jsonl` — the structured per-turn oracle. */
export interface TurnRecord {
  ts?: number;
  agent?: string;
  duration_ms?: number;
  tools?: number;
  status?: string;
  turn_id?: string;
  /** The honest delivery route the gateway stamped (`reply` | `stream` |
   *  `flush` | `none`; see `turn-record-status.ts` `computeTurnRoute`). Absent
   *  on legacy rows written before the field shipped — the detector ages those
   *  out via `ROUTE_FIELD_SHIP_TS` rather than mistaking them for silent
   *  no-ops. Lets the silent-no-op check tell a flush-recovered turn
   *  (`route: 'flush'`) from a genuine silent no-op (`route: 'none'`). */
  route?: string;
  /** #3702 — landed backstop message ids the read-back probe never
   *  corroborated (absent on an ordinary row). A `complete` turn carrying this
   *  was called delivered on the Bot API's ack alone. Counted, NOT escalated:
   *  it measures how often that bet is made, and is not itself a failure mode
   *  (escalating it would recreate the phantom `send_failed` cluster the
   *  counter exists to explain). */
  landed_unconfirmed?: number;
}

/** The L0 failure-mode signals emitted from `turns.jsonl`. Kept as stable
 *  string keys so the signal→spec mapping table can join on them. */
export type TurnSignal =
  | "killed-incomplete-turn"
  | "hang-long-stalled"
  | "silent-no-op-candidate"
  // A turn that completed with zero tools BUT whose answer was honestly
  // delivered by a turn-flush / outbox-sweep backstop (route `flush`) after the
  // reply tool was bypassed. Informational (LOW sev) — NOT a silent no-op: the
  // user did receive the answer. This split is what stops the ~131 false
  // sev-3 "silent no-op" flags on flush-recovered turns.
  | "flush-recovered-turn"
  // A turn-flush/backstop send that failed or only partially delivered
  // (turns.jsonl status `send_failed`, new in gateway PR B). Distinct from
  // `killed-incomplete-turn` (process killed mid-run): here the run finished
  // but the answer never fully reached the user (e.g. flood-dropped).
  | "send-failed-delivery";

/** The L0 failure-mode signals emitted from precise gateway log signatures. */
export type GatewaySignal =
  | "duplicate-delivery-represent"
  | "represent-escalation"
  | "reply-delivery-failure";

/** Signals from the standalone config/state sensors — NOT derived from an
 *  agent's turns.jsonl or gateway log. Each sensor reads a hard artifact
 *  (an operator-maintained config file, etc.) and emits a finding when the
 *  invariant it guards is violated. */
export type SensorSignal =
  | "litellm-header-passthrough-misconfig"
  | "litellm-timeout-budget-drift"
  // The live LiteLLM config names a custom callback module (`custom_pacing`)
  // that the live compose does not bind-mount. LiteLLM imports callbacks during
  // startup, so this is a hard crash-loop with no degraded mode.
  | "litellm-callback-mount-missing"
  // The live `switchroom-hindsight` container is running CPU-only
  // (`HostConfig.DeviceRequests` empty) while the host has a PROVABLY usable
  // GPU (nvidia-smi + the nvidia container runtime). Reranker + local
  // embeddings fall to CPU on the interactive recall path — the 2026-07-28
  // incident (#4459) that no green doctor caught.
  | "hindsight-gpu-cpu-on-gpu-host";

export type L0Signal = TurnSignal | GatewaySignal | SensorSignal;

/** A single flagged occurrence with its hard-artifact evidence. */
export interface Finding {
  signal: L0Signal;
  agent: string;
  /** origin_turn_id join key (turns.jsonl / gateway log / transcript). For a
   *  gateway-count signal with no single turn, this is a synthesized pointer. */
  turn_id: string;
  /** A grep-able pointer the operator can jump to. */
  log_pointer: string;
  /** ISO timestamp of the occurrence (from the turn `ts`, if known). */
  ts: string | null;
}

/** The per-agent digest — mirrors the reference detector's JSON output plus
 *  the structured findings the ledger writer consumes. */
export interface AgentScanResult {
  agent: string;
  turns: number;
  status_mix: Record<string, number>;
  findings: Finding[];
  /** Raw gateway signature hit counts (for the digest / escalate decision). */
  gw_hits: Record<GatewaySignal, number>;
  /** #3702 — how many of this agent's turns delivered at least one landed
   *  message id the read-back probe never corroborated (`landed_unconfirmed >
   *  0`). Available on the scan result for a future digest — no consumer reads
   *  `ScanResult.perAgent` yet, so the durable per-turn `landed_unconfirmed`
   *  field on `turns.jsonl` is currently the only way to watch the rate at
   *  which a delivery is called `complete` on the Bot API's ack alone
   *  (surfacing the aggregate is filed as follow-up). Deliberately NOT
   *  part of `escalate` and NOT a `Finding` — an inconclusive probe is not a
   *  failure; it is the measurement that tells us if that assumption ever
   *  breaks. */
  landed_unconfirmed_turns: number;
  escalate: boolean;
}

/**
 * Precise gateway log signatures. Precision-filtered so a `getUpdates` network
 * blip never counts as a delivery failure — the reply-delivery pattern matches
 * ONLY a `sendRichMessage` non-ok status. Regex sources match the reference
 * detector's `grep -E` patterns exactly, except where noted below.
 *
 * #3931 — `reply-delivery-failure` is an OUTCOME signal, not an attempt signal.
 * The `tg-post` transformer runs below the retry policy and logs one line per
 * POST attempt, so a 429 that was slept and retried SUCCESSFULLY used to emit a
 * matching `status=err` line and escalate a reply the operator had already
 * received — a severity-3 alert on a delivered message. The transformer now
 * labels a failure the policy is about to retry `status=retry`
 * (`telegram-plugin/shared/bot-runtime.ts`, `willRetryTelegramFailure` in
 * `telegram-plugin/retry-api-call.ts`), so only terminal failures carry
 * `status=err`. The `(?![a-z])` guard makes that structural rather than
 * incidental: it pins the match to the exact token `err`, so no future
 * `err<suffix>` tier can silently re-enter this signal.
 */
export const GATEWAY_SIGNATURES: Record<GatewaySignal, RegExp> = {
  "duplicate-delivery-represent": /represent duplicate-send/,
  "represent-escalation": /obligation escalation/,
  "reply-delivery-failure": /tg-post method=sendRichMessage[^\n]*status=err(?![a-z])/,
};

/** Parse `turns.jsonl` text into records, silently skipping malformed lines
 *  (a corrupt line must never crash the scan — RFC: defensive).
 *
 *  "Malformed" is not only unparseable JSON: a line that parses to a
 *  NON-OBJECT (`null`, `7`, `"x"`, `[…]`) is skipped too. Every downstream
 *  consumer dereferences fields off the record, and `null.agent` /
 *  `null.turn_id` throws a TypeError that `scanAgent`'s caller
 *  (`src/fleet-health/scan.ts`) converts into a whole-agent `skipped[]` —
 *  i.e. one junk byte on disk would silently erase that agent from the health
 *  board. Skipping the row here keeps the crash-proof contract literal. */
export function parseTurns(text: string): TurnRecord[] {
  const out: TurnRecord[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      out.push(parsed as TurnRecord);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/**
 * Keep only the rows that BELONG to the agent whose `turns.jsonl` this is.
 *
 * A row carries the `agent` its gateway stamped at write time. Normally that is
 * the owning agent, but foreign rows can land in the file: `emitTurnRecord`
 * used to hard-code `/state/agent/turns.jsonl`, so any test that drove the real
 * turn-end funnel INSIDE an agent container appended rows stamped with the
 * test's own `SWITCHROOM_AGENT_NAME` into that agent's production record. Those
 * rows are deliberately synthetic (zero tools, instant completion) — exactly
 * the shape the silent-no-op detector flags. On 2026-07-26 they were 267 of the
 * 377 live silent-no-op candidates across the fleet, i.e. the top-priority
 * ledger entry was mostly test fixtures.
 *
 * The rule is deterministic and TOTAL — total in the literal sense: it is
 * defined for every value `parseTurns` can hand it, and it never throws.
 * `parseTurns` does no shape validation beyond "is an object" (a corrupt line
 * must never crash the scan), so `agent` can be any JSON value. Only a STRING
 * `agent` can attribute a row to another agent; anything else (missing, number,
 * array, object, null) is unattributable and is KEPT — dropping it would be a
 * guess, and throwing on it would be worse than both. A thrown TypeError here
 * propagates out of `scanAgent` into `src/fleet-health/scan.ts`'s catch, which
 * pushes the WHOLE agent into `skipped[]` — one junk row would erase every real
 * finding for that agent from the ledger, which is the same "health board lies"
 * failure this filter exists to prevent.
 *
 * So: a row whose `agent` is a string that does not match the scanned agent is
 * not that agent's production signal and never enters findings or the status
 * mix. Every other row is kept.
 *
 * The write-side path fix (`resolveTurnsJsonlPath`) stops NEW foreign rows;
 * this keeps the ones already on disk — and any future cross-attribution — out
 * of the ledger without rewriting operator state.
 */
export function ownedTurns(
  agent: string,
  turns: readonly TurnRecord[],
): TurnRecord[] {
  const slug = agent.trim().toLowerCase();
  return turns.filter((t) => {
    // Type-guard, not an optional chain: `t.agent` is typed `string | undefined`
    // but arrives unvalidated from JSON.parse, so `?.trim()` is a TypeError
    // waiting on `{"agent":123}`.
    const raw: unknown = t?.agent;
    if (typeof raw !== "string") return true;
    const owner = raw.trim().toLowerCase();
    return owner === "" || owner === slug;
  });
}

function isoFromTs(ts: number | undefined): string | null {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  // turns.jsonl `ts` is unix seconds.
  return new Date(ts * 1000).toISOString();
}

/**
 * Run the turns.jsonl detectors over one agent's parsed turns. Pure — returns
 * the flagged findings. Mirrors the reference detector's three turn checks.
 *
 * Rows attributed to a DIFFERENT agent are dropped first (`ownedTurns`): they
 * are never this agent's production signal. The filter lives here, in the
 * finding producer, so no caller can route around it.
 */
export function detectTurnFindings(
  agent: string,
  turns: TurnRecord[],
  opts: DetectOptions = {},
): Finding[] {
  const findings: Finding[] = [];
  const silentNoopFloorTs = opts.silentNoopFloorTs ?? SILENT_NOOP_FLOOR_TS;
  const routeFieldShipTs = opts.routeFieldShipTs ?? ROUTE_FIELD_SHIP_TS;
  for (const t of ownedTurns(agent, turns)) {
    // Same unvalidated-JSON hazard as `ownedTurns`: `turn_id` is typed
    // `string | undefined` but a row on disk can carry any JSON value, and
    // `tid.includes(...)` below would throw on a number — erasing the whole
    // agent from the ledger via scan.ts's catch.
    const tid = typeof t.turn_id === "string" ? t.turn_id : "?";
    const st = t.status;
    const tl = typeof t.tools === "number" ? t.tools : 0;
    const dur = typeof t.duration_ms === "number" ? t.duration_ms : 0;
    const synthetic = tid.includes("synthetic-"); // gateway-injected, not a real job
    const route = typeof t.route === "string" ? t.route : undefined;
    const ts = isoFromTs(t.ts);

    // send_failed (gateway PR B): the run finished but the answer did not fully
    // reach the user. Its own signal — NOT the process-killed catch-all below
    // (which would corrupt `killed-incomplete-turn`'s "killed mid-run" meaning).
    if (st === "send_failed") {
      findings.push({
        signal: "send-failed-delivery",
        agent,
        turn_id: tid,
        log_pointer: `turns.jsonl:${tid} status=send_failed`,
        ts,
      });
    } else if (st !== "complete" && st !== "no_reply") {
      findings.push({
        signal: "killed-incomplete-turn",
        agent,
        turn_id: tid,
        log_pointer: `turns.jsonl:${tid} status=${st}`,
        ts,
      });
    }
    // tuned hang: long AND stalled — long+productive is deep work.
    if (dur > HANG_MS && tl <= HANG_MAXTOOLS) {
      findings.push({
        signal: "hang-long-stalled",
        agent,
        turn_id: tid,
        log_pointer: `turns.jsonl:${tid} ${Math.floor(dur / 1000)}s tools=${tl}`,
        ts,
      });
    }
    // completed, zero tools, real (non-synthetic), inside the fixed window.
    // This shape used to ALL score as `silent-no-op-candidate` (sev-3). The
    // honest `route` field now splits it: a flush-recovered turn (the answer
    // reached the user via a backstop) is NOT a silent no-op. Rows lacking a
    // `ts` are dropped (real gateway rows always carry `ts`).
    if (
      st === "complete" &&
      tl === 0 &&
      !synthetic &&
      t.ts != null &&
      t.ts >= silentNoopFloorTs
    ) {
      if (route === "flush") {
        // Answer delivered by a turn-flush / outbox-sweep backstop after the
        // reply tool was bypassed. Informational (LOW sev) — the user got it.
        findings.push({
          signal: "flush-recovered-turn",
          agent,
          turn_id: tid,
          log_pointer: `turns.jsonl:${tid} tools=0 route=flush`,
          ts,
        });
      } else if (route === "reply" || route === "stream") {
        // Delivered honestly via reply/stream — not a no-op, no finding.
      } else if (route === "none") {
        // Nothing reached the user. Genuine silent no-op — by construction rare;
        // a nonzero count means a real delivery invariant broke. sev-3.
        findings.push({
          signal: "silent-no-op-candidate",
          agent,
          turn_id: tid,
          log_pointer: `turns.jsonl:${tid} tools=0 route=none`,
          ts,
        });
      } else {
        // Legacy row: no `route` field. Age out the stale pre-route backlog
        // (predates the field) so it stops scoring sev-3; but a field-less row
        // AT/AFTER the ship epoch is a regression (the gateway dropped the
        // field) — treat it as `none` so it still surfaces.
        if (t.ts >= routeFieldShipTs) {
          findings.push({
            signal: "silent-no-op-candidate",
            agent,
            turn_id: tid,
            log_pointer: `turns.jsonl:${tid} tools=0`,
            ts,
          });
        }
      }
    }
  }
  return findings;
}

/**
 * Run the precise gateway signatures over one agent's gateway log text. Returns
 * both the per-signature hit counts and one Finding per matched line (so the
 * ledger gets real log pointers). `logName` is only used to build the pointer.
 */
export function detectGatewayFindings(
  agent: string,
  logText: string,
  logName = `logs/${agent}/gateway-supervisor.log`,
): { findings: Finding[]; gw_hits: Record<GatewaySignal, number> } {
  const findings: Finding[] = [];
  const gw_hits: Record<GatewaySignal, number> = {
    "duplicate-delivery-represent": 0,
    "represent-escalation": 0,
    "reply-delivery-failure": 0,
  };
  const lines = logText.split("\n");
  for (const [name, re] of Object.entries(GATEWAY_SIGNATURES) as [
    GatewaySignal,
    RegExp,
  ][]) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      if (re.test(line)) {
        gw_hits[name] += 1;
        findings.push({
          signal: name,
          agent,
          turn_id: extractTurnId(line) ?? `${agent}:gw#${i + 1}`,
          log_pointer: `${logName}:${i + 1}`,
          ts: extractTs(line),
        });
      }
    }
  }
  return { findings, gw_hits };
}

/** Best-effort turn_id extraction from a gateway log line (origin_turn_id
 *  form `<digits>:_#<digits>`). Returns null if the line carries none. */
export function extractTurnId(line: string): string | null {
  const m = line.match(/\d+:_#\d+/);
  return m ? m[0] : null;
}

/** Best-effort ISO-timestamp extraction from a gateway log line. Gateway lines
 *  are prefixed with an ISO-8601 timestamp; return it if present. */
export function extractTs(line: string): string | null {
  const m = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/);
  return m ? m[0] : null;
}

/**
 * Full L0 scan for one agent over the two artifact texts. The gateway signals
 * that gate escalation match the reference detector exactly: killed/hang/silent
 * no-op, plus duplicate-delivery and reply-delivery-failure (represent-escalation
 * is informational and does NOT by itself escalate).
 */
export function scanAgent(
  agent: string,
  turnsText: string,
  gatewayText: string,
  opts: DetectOptions = {},
): AgentScanResult {
  // Foreign-attributed rows are dropped up front so the turn COUNT and the
  // status mix describe this agent too, not just the findings.
  const turns = ownedTurns(agent, parseTurns(turnsText));
  const status_mix: Record<string, number> = {};
  for (const t of turns) {
    const st = t.status ?? "unknown";
    status_mix[st] = (status_mix[st] ?? 0) + 1;
  }
  const turnFindings = detectTurnFindings(agent, turns, opts);
  const { findings: gwFindings, gw_hits } = detectGatewayFindings(
    agent,
    gatewayText,
  );
  const findings = [...turnFindings, ...gwFindings];

  const escalate =
    turnFindings.some(
      (f) =>
        f.signal === "killed-incomplete-turn" ||
        f.signal === "hang-long-stalled" ||
        f.signal === "silent-no-op-candidate" ||
        f.signal === "send-failed-delivery",
    ) ||
    gw_hits["duplicate-delivery-represent"] > 0 ||
    gw_hits["reply-delivery-failure"] > 0;

  const landed_unconfirmed_turns = turns.filter(
    (t) => (t.landed_unconfirmed ?? 0) > 0,
  ).length;

  return {
    agent,
    turns: turns.length,
    status_mix,
    findings,
    gw_hits,
    landed_unconfirmed_turns,
    escalate,
  };
}
