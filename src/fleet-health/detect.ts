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
import { DEFAULT_MAX_FLOOD_SLEEP_MS } from "../../telegram-plugin/retry-api-call.js";

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
  | "reply-delivery-failure"
  // The same `sendRichMessage` rejection, but a later rich send to the SAME
  // chat landed inside the recovery window: one of the gateway's fallback
  // ladders (thread-drop, 429 flood sleep, transport re-attempt, card re-send)
  // put the message in the chat. The user got the answer, so this is not the
  // severity-3 success-theater incident `reply-delivery-failure` describes —
  // it is the recovery mechanism working. Informational counterpart, exactly
  // as `orphaned-db-handle-recovered` is to `orphaned-db-handle`.
  | "reply-delivery-recovered"
  // The gateway's orphaned-DB-fd sweep found a `*.db` handle pointing at a
  // DELETED inode under the state dir. Every row written to that handle since
  // the last checkpoint is gone, and the write path reported success for all of
  // them. `history.db` self-heals in process; `registry.db` and anything else
  // needs a restart — either way a human has to be told, which is what this
  // signal is for. See `telegram-plugin/gateway/orphaned-db-sweep.ts`.
  | "orphaned-db-handle"
  // The same alarm, but the sweep's OWN recovery landed in the same tick: the
  // `history.db` lane reopened and proved the handle durable again, and no
  // lane in that tick was left un-recovered. The rows written before the
  // reopen are still lost, so this stays a reportable event — but the
  // mechanism designed to catch it WORKED, which is not a severity-3
  // data-loss incident. Informational counterpart of `orphaned-db-handle`,
  // exactly as `flush-recovered-turn` is to `silent-no-op-candidate`.
  | "orphaned-db-handle-recovered";

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
  // The live compose declares a passthrough/patch bind mount whose target
  // hard-codes a CPython minor version (`.../python3.13/site-packages/...`) that
  // no longer matches the live image. The mount lands at an inert path and the
  // patch is SILENTLY dropped — no crash, unlike the callback case; the proxy
  // comes up "healthy" on unpatched code. See `passthrough-mount-guard.ts`.
  | "litellm-passthrough-mount-stale"
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
/** The gateway signals matched by a single log LINE. `orphaned-db-handle-recovered`
 *  is deliberately absent: it is not a line signature but a RECLASSIFICATION of
 *  the `orphaned-db-handle` alarm decided by the lines that follow it within the
 *  same sweep tick (see `classifyOrphanedDbTick`). */
export type LineMatchedGatewaySignal = Exclude<
  GatewaySignal,
  "orphaned-db-handle-recovered" | "reply-delivery-recovered"
>;

export const GATEWAY_SIGNATURES: Record<LineMatchedGatewaySignal, RegExp> = {
  "duplicate-delivery-represent": /represent duplicate-send/,
  // #4680 — same attempt-vs-OUTCOME rule as `reply-delivery-failure` above.
  // Four emitter lines carry the literal `obligation escalation`, and a bare
  // substring match counted all four:
  //   escalation-drive.ts:62  delivered + closed         ← terminal outcome
  //   escalation-drive.ts:68  PERMANENTLY undeliverable  ← terminal outcome
  //   escalation-drive.ts:72  send failed … retrying next sweep  ← an ATTEMPT
  //   obligation-wiring.ts:303 deferred — bridge down    ← the SUPPRESSION path
  // The last one is the guard deliberately NOT escalating while the Telegram
  // bridge is down, i.e. the safety mechanism WORKING; counting it reported a
  // healthy suppression as a failure. The retry line is the #3931 shape exactly:
  // one line per attempt, so a nudge that landed on attempt 3 used to book three
  // findings for one obligation. Anchoring on the two mutually-exclusive
  // TERMINAL lines yields exactly one hit per escalated obligation, and keeps
  // the permanently-undeliverable case (a real escalation that never reached the
  // operator) in the ledger rather than dropping coverage.
  "represent-escalation":
    /obligation escalation (?:delivered \+ closed|PERMANENTLY undeliverable)/,
  "reply-delivery-failure": /tg-post method=sendRichMessage[^\n]*status=err(?![a-z])/,
  // Anchored on the sweep's DETECTED line, which is emitted once per tick per
  // incident for EVERY lane (history, registry, unowned) — so the registry
  // alarm, which has no in-process recovery at all, still reaches a human.
  // Deliberately not anchored on the per-lane lines: those change wording as
  // lanes are added, and one signal per incident is the right escalation rate.
  "orphaned-db-handle": /orphaned-db-sweep DETECTED \d+ deleted-inode DB handle/,
};

/**
 * Every signal `detectGatewayFindings` can emit — the line-matched ones plus
 * the splits it derives. #4680 rule 3 folds these findings by event identity
 * (the `origin=` turn id) instead of one per log line, so this is also the
 * authoritative set of signals whose ledger COUNTING UNIT is `gateway-event`
 * (see `countingUnitFor` in `mapping.ts`).
 *
 * #4682 M2 — this is a `Record<GatewaySignal, true>`, not a list, and that is
 * load-bearing. A hand-written array satisfies `readonly GatewaySignal[]` while
 * MISSING a member, and nothing else in the codebase would object: a DERIVED
 * signal (one excluded from `LineMatchedGatewaySignal`, as
 * `orphaned-db-handle-recovered` is) needs no `GATEWAY_SIGNATURES` entry, so
 * tsc stays green and `countingUnitFor` silently hands the new signal the
 * `log-line` unit it was never counted in — re-arming the exact false
 * "Verified count-drop" auto-close the guard exists to stop. A `Record` keyed
 * by the union makes an omission a compile error.
 */
const GATEWAY_SIGNAL_MEMBERS: Record<GatewaySignal, true> = {
  "duplicate-delivery-represent": true,
  "represent-escalation": true,
  "reply-delivery-failure": true,
  "reply-delivery-recovered": true,
  "orphaned-db-handle": true,
  "orphaned-db-handle-recovered": true,
};

export const GATEWAY_SIGNAL_NAMES: readonly GatewaySignal[] = Object.keys(
  GATEWAY_SIGNAL_MEMBERS,
) as GatewaySignal[];

/** Zeroed `gw_hits` accumulator — derived from the same exhaustive record, so a
 *  new gateway signal cannot be counted under a key that does not exist. */
function emptyGwHits(): Record<GatewaySignal, number> {
  const out = {} as Record<GatewaySignal, number>;
  for (const name of GATEWAY_SIGNAL_NAMES) out[name] = 0;
  return out;
}

/** The sweep's in-process recovery line, logged by `attemptHistoryReopen` the
 *  moment the reopened `history.db` handle passes its post-reopen writer
 *  self-check (`orphaned-db-sweep.ts:279`). `reopened` is the first-detection
 *  verb; `recovered` is the sticky-failure retry verb, which fires on a tick
 *  with no DETECTED line at all and so never pairs with an alarm here. */
const ORPHANED_DB_RECOVERED_RE =
  /orphaned-db-sweep reopened history\.db — writes are durable again/;

/** Any `orphaned-db-sweep` line. The emitter logs an alarm and every lane line
 *  for one tick synchronously (`runOrphanedDbSweepTick`, no `await` between
 *  :210 and :251), so the FIRST sweep line after an alarm is that alarm's own
 *  tick reporting its history lane. This is the tick boundary — a property of
 *  the log's CONTENT, not of how many lines happen to follow. */
const ORPHANED_DB_SWEEP_LINE_RE = /orphaned-db-sweep /;

/** Each `fd=<n> <target>` pair the DETECTED line interpolates
 *  (`orphaned-db-sweep.ts:213-214`). The target may carry a trailing
 *  ` (deleted)`, which `\S+` naturally stops before. */
const ORPHANED_DB_ALARM_TARGET_RE = /\bfd=\d+ (\S+)/g;

/** The handle COUNT the alarm declares — the same `\d+` the
 *  `orphaned-db-handle` signature already requires, so it is present on every
 *  line that reaches here. `orphaned-db-sweep.ts:211-217` writes
 *  `DETECTED ${orphans.length}` and then exactly one `fd=` pair per orphan, so
 *  count and pair list are 1:1 BY CONSTRUCTION and any inequality means the
 *  list we are reading is not the list the emitter wrote. */
const ORPHANED_DB_ALARM_COUNT_RE = /DETECTED (\d+) deleted-inode DB handle/;

/**
 * The lanes an alarm line names, as basenames. Returns `null` when the line's
 * target list is not provably COMPLETE — either nothing parsed at all, or fewer
 * pairs parsed than the line's own count declares. An emitter format change, a
 * truncated line, or an interleaved write must fail toward the alarm, never
 * silently downgrade a data-loss record.
 *
 * #4682 B1 follow-up — reading the pairs and ignoring the count made the
 * verdict depend on the alarm line arriving INTACT. A short `write()` on the
 * supervisor's stderr for an alarm line over `PIPE_BUF` (reachable precisely
 * when many fds are orphaned — the worst incident) drops the tail of the list,
 * and a surviving `history.db` pair then launders a real `registry.db` loss
 * down to severity 1. The count is at the HEAD of the line, so it survives
 * exactly the truncations that eat the list.
 */
function orphanedDbAlarmLanes(alarmLine: string): string[] | null {
  const names: string[] = [];
  for (const m of alarmLine.matchAll(ORPHANED_DB_ALARM_TARGET_RE)) {
    const target = m[1]!;
    names.push(target.slice(target.lastIndexOf("/") + 1));
  }
  if (names.length === 0) return null;
  const declared = ORPHANED_DB_ALARM_COUNT_RE.exec(alarmLine)?.[1];
  if (declared === undefined || names.length !== Number(declared)) return null;
  return names;
}

/**
 * Lane lines that state, in this tick, that a lane was left UN-recovered. They
 * veto a `recovered` verdict no matter what the alarm line's own list said.
 *
 * Deliberately only the two lanes the emitter logs AFTER the history lane and
 * ONLY from inside an alarm's own `orphans.length > 0` block: registry
 * (`orphaned-db-sweep.ts:231-238`) and unowned (`:242-251`). The sticky
 * closed-history line (`:255-264`) and `FAILED to reopen` (`:285`) are
 * excluded on purpose — both also fire from the retry path on a tick with NO
 * DETECTED line, so vetoing on them would let a LATER, unrelated tick flip an
 * earlier recovered alarm, which is the log-growth dependence #4682 B1 removed.
 * This tick's own failed reopen is already caught by the first-sweep-line rule
 * below, so nothing is lost by excluding them.
 */
const ORPHANED_DB_LANE_VETO_RE =
  /orphaned-db-sweep found (?:an orphaned registry\.db handle|orphaned handle\(s\) on )/;

/**
 * Decide whether an `orphaned-db-sweep DETECTED` alarm at `alarmIdx` was
 * RECOVERED inside its own sweep tick.
 *
 * #4682 B1 — the verdict is derived from the tick's CONTENT, never from how
 * many lines follow it. The previous line-count lookahead made the answer
 * position-dependent: the identical alarm+reopen pair classified `recovered`
 * while it sat at the log tail and `unrecovered` once twelve lines of ordinary
 * traffic had accumulated behind it. Sweeps are five minutes apart, so the next
 * alarm is essentially never inside a dozen lines and the verdict effectively
 * tracked WHEN the scan ran. That is fatal downstream: the two verdicts carry
 * different signatures, so a flip migrates the finding between dedup_keys and
 * empties the old one, which the ledger reads as a fix-to-zero.
 *
 * Two content-derived facts settle it:
 *
 * 1. WHICH LANES the tick hit is stated by the alarm line itself — it declares
 *    a handle COUNT and then interpolates one `fd=` pair per orphaned target
 *    (`orphaned-db-sweep.ts:211-217`). `history.db*` (including `-wal`/`-shm`,
 *    matching the emitter's own `startsWith('history.db')` lane test at :219)
 *    is the only lane with an in-process recovery. An alarm naming
 *    `registry.db` or an unowned file is unrecoverable silent loss, full stop.
 *    Count and pair list are 1:1 by construction, so `orphanedDbAlarmLanes`
 *    cross-checks them and refuses to answer from a list it cannot prove
 *    COMPLETE — a truncated alarm can no longer launder a hidden `registry.db`
 *    down to severity 1 on the strength of a surviving `history.db` pair.
 * 2. WHETHER the history lane recovered is stated by the first `orphaned-db-sweep`
 *    line after the alarm. The emitter reaches its history lane with no `await`
 *    after the alarm and always logs exactly one of: reopened-and-proved-durable,
 *    no-reopen-wired, or FAILED-to-reopen. Only the first is a recovery; anything
 *    else — including running out of log — keeps the alarm.
 * 3. Belt and braces: any registry/unowned lane line between this alarm and the
 *    NEXT alarm vetoes a recovery outright (`ORPHANED_DB_LANE_VETO_RE`). Those
 *    lines are emitted only from inside an alarm's own block, so the scan window
 *    is bounded by the log's CONTENT (the next DETECTED line, or EOF) and never
 *    by a line count — no position-dependence is reintroduced. It exists so an
 *    intact "rows … are LOST" line in the tick is never overruled by whatever
 *    the alarm line happens to say, whatever the emitter's format becomes.
 */
export function classifyOrphanedDbTick(
  lines: readonly string[],
  alarmIdx: number,
): "recovered" | "unrecovered" {
  const lanes = orphanedDbAlarmLanes(lines[alarmIdx] ?? "");
  // Incomplete target list, or any lane without an in-process recovery.
  if (lanes === null || !lanes.every((n) => n.startsWith("history.db"))) {
    return "unrecovered";
  }
  let verdict: "recovered" | "unrecovered" | null = null;
  for (let j = alarmIdx + 1; j < lines.length; j++) {
    const line = lines[j];
    if (!line || !ORPHANED_DB_SWEEP_LINE_RE.test(line)) continue;
    // The next alarm ends this tick — its lane lines are not ours to read.
    if (GATEWAY_SIGNATURES["orphaned-db-handle"].test(line)) break;
    // An un-recovered lane anywhere in THIS tick settles it, alarm line or not.
    if (ORPHANED_DB_LANE_VETO_RE.test(line)) return "unrecovered";
    // The first sweep line after the alarm IS this tick's history-lane verdict.
    verdict ??= ORPHANED_DB_RECOVERED_RE.test(line) ? "recovered" : "unrecovered";
    if (verdict === "unrecovered") return "unrecovered";
  }
  // `null` — the log ended before the lane reported: we cannot prove a recovery.
  return verdict ?? "unrecovered";
}

/**
 * Any `tg-post` line for a rich send, whatever its status. This is the set the
 * recovery scan walks: the failing line and every later ATTEMPT on the same
 * chat are all members, so an episode is read from the emitter's own attempt
 * stream rather than from arbitrary neighbouring log traffic.
 */
const TG_POST_RICH_LINE_RE = /tg-post method=sendRichMessage /;

/** The `status=` field of a `tg-post` line. Same `(?![a-z])` token pinning as
 *  `GATEWAY_SIGNATURES["reply-delivery-failure"]`, so `ok` can never match a
 *  future `ok<suffix>` tier. */
const TG_POST_STATUS_RE = /\bstatus=(ok|benign|retry|err)(?![a-z])/;

/** The chat the send was addressed to. `-` when the method carries no
 *  `chat_id` (`bot-runtime.ts:153`), which is never true of `sendRichMessage`
 *  but is handled rather than assumed. */
const TG_POST_CHAT_RE = /\bchat=(-?\d+)\b/;

/**
 * How long after a rejected rich send a later successful rich send to the SAME
 * chat still counts as THAT send's recovery.
 *
 * Derived, not invented: `DEFAULT_MAX_FLOOD_SLEEP_MS` is the ceiling on how
 * long `createRetryApiCall` will park in-process before re-attempting
 * (`retry-api-call.ts:662` throws `FLOOD_WAIT_ACTIVE` rather than sleep past
 * it), and it is the slowest of the gateway's recovery ladders by a wide
 * margin — the observed thread-drop recovery took 554ms and the observed
 * edit-flood-fuse deferral ~40s. A gap wider than the send stack's own maximum
 * recovery wait is a different delivery episode, not a recovery, so the window
 * moves automatically if that ceiling ever does.
 */
export const REPLY_DELIVERY_RECOVERY_WINDOW_MS = DEFAULT_MAX_FLOOD_SLEEP_MS;

/** Millisecond instant of a gateway log line, or null when it carries no
 *  parseable timestamp. Goes through `extractTs` so the UTC-by-convention
 *  normalisation (#4622) applies here too — reading the raw match with
 *  `Date.parse` would misdate a designator-less line by the host's offset. */
function lineInstantMs(line: string): number | null {
  const iso = extractTs(line);
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Decide whether a rejected `sendRichMessage` at `failIdx` was RECOVERED by a
 * later rich send that landed in the same chat.
 *
 * #4730 — `status=err` was specified (#3931, `bot-runtime.ts:131-140`) to mean
 * a TERMINAL outcome: an attempt the retry policy will repeat is labelled
 * `status=retry` instead. That contract holds only for sends routed through
 * `createRetryApiCall`, because `willRetryTelegramFailure` returns `false` the
 * moment `_getTgAttemptContext()` is empty (`retry-api-call.ts:207`). Several
 * of the gateway's recovery ladders sit ABOVE or OUTSIDE that policy and are
 * therefore invisible to it:
 *
 *   - the THREAD_NOT_FOUND thread-drop ladder, which the policy hands OFF to
 *     the caller by design (`retry-api-call.ts:693-702` rethrows
 *     `THREAD_NOT_FOUND`; `outbound-send-path.ts:575-586` drops the thread and
 *     re-sends) — 4 occurrences, one observed recovering in 554ms;
 *   - the edit-flood-fuse deferral, which re-issues the send on a later tick,
 *     off the async chain the attempt context lives on — observed recovering
 *     in ~40s;
 *   - `runBackstopDelivery`'s bounded in-turn re-attempt, above the policy;
 *   - the queued-card re-send after `queued card send failed`
 *     (`stream-render.ts:393`).
 *
 * Of the 16 `status=err` rich sends on the live fleet's gateway logs, 12
 * provably delivered — the detector was paging the operator about replies they
 * had already read, which is the success-theater inversion the ledger exists
 * to avoid.
 *
 * The verdict is derived from the log's CONTENT and its own timestamps, never
 * from how many lines follow — the position-dependence #4682 B1 removed from
 * `classifyOrphanedDbTick`. Two facts settle it:
 *
 * 1. WHICH sends are candidates is stated by the line itself: `chat=<id>` is
 *    the only identity a `tg-post` line carries (`bot-runtime.ts:170` — the
 *    `origin=` tag would come from `withTgPostTags`, which is exported and
 *    imported but never CALLED, so no production line carries one). Only a
 *    later rich send to the SAME chat can be this send's recovery.
 * 2. WHETHER it recovered is stated by that send's status: the first `status=ok`
 *    within `REPLY_DELIVERY_RECOVERY_WINDOW_MS` is the landing. `err`/`retry`/
 *    `benign` attempts in between are further attempts in the same episode and
 *    are skipped; running out of window, or out of log, keeps the failure.
 *
 * A failing line with no parseable chat or timestamp is UNRECOVERED: an
 * unprovable recovery must fail toward the alarm, never away from it.
 *
 * Deliberately NOT cleared: a `chat not found` rejection whose only later
 * delivery is to a DIFFERENT chat (the operator-DM fallback). The send to the
 * addressed chat really did fail terminally and the routing really is broken —
 * the user being reachable elsewhere does not make that a non-event.
 */
export function classifyReplyDeliveryEpisode(
  lines: readonly string[],
  failIdx: number,
): "recovered" | "unrecovered" {
  const failLine = lines[failIdx] ?? "";
  const chat = TG_POST_CHAT_RE.exec(failLine)?.[1];
  if (chat === undefined) return "unrecovered";
  const failMs = lineInstantMs(failLine);
  if (failMs === null) return "unrecovered";

  for (let j = failIdx + 1; j < lines.length; j++) {
    const line = lines[j];
    if (!line) continue;
    // The window is closed by the FIRST datable line past it, whatever that
    // line is about — not by the first same-chat rich send past it. A gateway
    // log is append-ordered (the same property `detectGatewayFindings` relies
    // on when it advances a folded finding to the newest line), so every line
    // after this one is later still. Bounding on any line keeps the scan
    // O(window) instead of O(log): a chat whose recovery never arrives would
    // otherwise walk the remaining ~2.5M lines once per failure. An undatable
    // line cannot be placed inside or outside the window, so it neither ends
    // the episode nor extends it.
    const ms = lineInstantMs(line);
    if (ms !== null && ms - failMs > REPLY_DELIVERY_RECOVERY_WINDOW_MS) break;
    if (!TG_POST_RICH_LINE_RE.test(line)) continue;
    if (TG_POST_CHAT_RE.exec(line)?.[1] !== chat) continue;
    if (ms === null) continue;
    if (TG_POST_STATUS_RE.exec(line)?.[1] === "ok") return "recovered";
  }
  return "unrecovered";
}

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
      // A message id LANDED on a backstop path. `landed_unconfirmed` is written
      // only by `runBackstopDelivery`'s read-back accounting
      // (`turn-record-status.ts:255-269`): it counts ids Telegram ACKED that the
      // read-back probe could not re-confirm. Its presence is therefore hard,
      // positive evidence that a send left the gateway and the Bot API took it —
      // which is exactly the fact "silent no-op" denies. Whatever `route` says
      // (or fails to say), such a turn is a backstop delivery, not silence.
      const landedBackstop =
        typeof t.landed_unconfirmed === "number" && t.landed_unconfirmed > 0;
      if (route === "flush" || (landedBackstop && route !== "reply" && route !== "stream")) {
        // Answer delivered by a turn-flush / outbox-sweep backstop after the
        // reply tool was bypassed. Informational (LOW sev) — the user got it.
        findings.push({
          signal: "flush-recovered-turn",
          agent,
          turn_id: tid,
          log_pointer: `turns.jsonl:${tid} tools=0 route=${route ?? "-"} landed_unconfirmed=${t.landed_unconfirmed ?? 0}`,
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
        //
        // #4730 — the epoch alone was not enough. `ROUTE_FIELD_SHIP_TS` is a
        // hand-written literal (2026-07-31T00:00:00Z), but the field reached
        // each agent at ITS OWN container restart, hours later: the earliest
        // real `route` row fleet-wide carries ts 1785492486 (+10.1h) and the
        // last agent's first is 1785524964 (+19.2h). Every field-less row in
        // that gap is a legacy row being read as a regression. The gate above
        // settles those deterministically — all five recorded occurrences carry
        // `landed_unconfirmed: 1` — so the constant no longer has to be exactly
        // right for the detector to be honest.
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
 * the per-signature hit counts and the findings the ledger aggregates (with real
 * log pointers). `logName` is only used to build the pointer.
 *
 * A finding is one EVENT, not one log line. Where a matched line carries an
 * `origin=`/`tid=` origin-turn id, every line for that (signal, origin) pair
 * folds into ONE finding: the ledger's `frequency` then counts distinct
 * affected turns, which is what its priority scoring means by "how often".
 * Lines with no origin id keep their old one-finding-per-line behaviour — there
 * is no identity to fold on, and guessing one would merge unrelated events.
 *
 * The folded finding carries the NEWEST line's timestamp and pointer, not the
 * first's. A gateway log is append-ordered, and `buildLedger` both windows
 * (`withinWindow`) and ranks (`recencyFactor`) on `Finding.ts` — pinning the
 * oldest line would let a cluster that is still happening age out of the scan
 * window, which is the "the board lies" failure this detector exists to
 * prevent. The pointer moves with it, so the operator lands on live evidence.
 *
 * `gw_hits` stays a RAW line count on purpose: it is the digest's
 * signature-frequency readout and the input to the escalate decision, and both
 * want "how noisy was the log", not "how many distinct turns".
 */
export function detectGatewayFindings(
  agent: string,
  logText: string,
  logName = `logs/${agent}/gateway-supervisor.log`,
): { findings: Finding[]; gw_hits: Record<GatewaySignal, number> } {
  const findings: Finding[] = [];
  const gw_hits = emptyGwHits();
  const lines = logText.split("\n");
  /** (signal, origin) → index of that event's finding in `findings`. */
  const eventIndex = new Map<string, number>();
  for (const [name, re] of Object.entries(GATEWAY_SIGNATURES) as [
    LineMatchedGatewaySignal,
    RegExp,
  ][]) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      if (re.test(line)) {
        // The orphaned-DB alarm splits on what the REST of its sweep tick did:
        // an in-process reopen that proved the handle durable again is the
        // mechanism working, not a severity-3 data-loss incident.
        const signal: GatewaySignal =
          name === "orphaned-db-handle" &&
          classifyOrphanedDbTick(lines, i) === "recovered"
            ? "orphaned-db-handle-recovered"
            : // #4730 — a rejected rich send that a later rich send to the same
              // chat recovered inside the send stack's own recovery window is
              // the fallback ladder WORKING, not a lost reply. Same split, same
              // reasoning as the orphaned-DB one above.
              name === "reply-delivery-failure" &&
                classifyReplyDeliveryEpisode(lines, i) === "recovered"
              ? "reply-delivery-recovered"
              : name;
        gw_hits[signal] += 1;
        const origin = extractTurnId(line);
        const pointer = `${logName}:${i + 1}`;
        const ts = extractTs(line);
        if (origin !== null) {
          const eventKey = `${signal}|${origin}`;
          const at = eventIndex.get(eventKey);
          if (at !== undefined) {
            // Same event, later line: advance the evidence to the newest one
            // rather than booking a second occurrence. `log_pointer` and `ts`
            // move together or not at all — a newest line with no parseable
            // timestamp must not leave a pointer at line N describing evidence
            // whose `ts` came from an earlier line, because `withinWindow` and
            // `buildLedger`'s recency then age on a `ts` the pointer disowns.
            const prev = findings[at]!;
            if (ts !== null || prev.ts === null) {
              findings[at] = { ...prev, log_pointer: pointer, ts };
            }
            continue;
          }
          eventIndex.set(eventKey, findings.length);
        }
        findings.push({
          signal,
          agent,
          turn_id: origin ?? `${agent}:gw#${i + 1}`,
          log_pointer: pointer,
          ts,
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

/**
 * ISO-8601 instant, with the zone designator captured separately so a
 * designator-less match can be told apart from a `Z` or an explicit offset.
 */
const ISO_TS_RE =
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?/;

/**
 * Best-effort ISO-timestamp extraction from a gateway log line, ALWAYS returned
 * as a zoned instant.
 *
 * Gateway lines are prefixed with an ISO-8601 timestamp by
 * `telegram-plugin/stderr-timestamps.ts:29-31`, which stamps
 * `new Date().toISOString()` — UTC with a literal `Z`, always. Verified against
 * the 12 live `gateway-supervisor.log` files on the dev host: ~2.5M timestamp
 * matches, every one `YYYY-MM-DDTHH:MM:SS.mmmZ`, none without. The shell-side
 * stamps that reach the same log agree — `profiles/_base/start.sh.hbs:2456` and
 * `docker/hindsight-autoheal.sh:110` both use `date -u …Z`.
 *
 * The designator stays OPTIONAL in the match, deliberately: a log-format change
 * that dropped it must not silently stop dating findings (the same
 * keep-the-signal posture as `ledger.withinWindow`'s undatable fallback). But a
 * designator-less string is no longer returned as-is — `Date.parse` reads that
 * as LOCAL time, so on this fleet's +10:00 host every such finding would be
 * misdated by ten hours, skewing `recencyFactor` and able to shift a finding
 * across `buildLedger`'s window boundary (#4622). Every producer in this repo
 * writes UTC, so a designator-less line is UTC BY CONVENTION, and it is
 * normalised here at the producer rather than left for each consumer to guess.
 *
 * An EXPLICIT offset (`+10:00`) is preserved untouched — it already names its
 * zone, and appending `Z` to it would invent a ten-hour error.
 */
export function extractTs(line: string): string | null {
  const m = line.match(ISO_TS_RE);
  if (!m) return null;
  return m[1] ? m[0] : `${m[0]}Z`;
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
