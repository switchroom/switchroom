/**
 * Fleet Health — the signal→job-spec mapping, failure-mode taxonomy, and
 * priority scoring. Design: `reference/rfcs/fleet-health.md`.
 *
 * This is the model-free classification layer: it takes the L0 detector's
 * signals (hard artifacts) and (a) classifies each into the RFC's 9-class
 * failure-mode taxonomy, (b) maps it to one of the 23 job specs, and (c)
 * computes `priority_score = severity × frequency × reach × recency`.
 *
 * No model judgment enters any of this — the mapping table is explicit and the
 * scoring is arithmetic, exactly as the RFC specifies.
 */

import type {
  FleetHealthCountingUnit,
  FleetHealthFailureMode,
} from "../web/fleet-health-read.js";
import type { L0Signal, Finding } from "./detect.js";
import { GATEWAY_SIGNAL_NAMES } from "./detect.js";

/** How one L0 signal classifies: its failure mode, severity (1-3), the job
 *  spec it maps to, and the stable dedup-key signature fragment. */
export interface SignalMapping {
  failure_mode: FleetHealthFailureMode;
  severity: number;
  /** `reference/jobs/<slug>.md` id — the join key + GitHub `job:<slug>` label. */
  job_spec: string;
  /** Fragment used to build the dedup key (`<job_spec>:<signature>`). */
  signature: string;
}

/**
 * The explicit signal→job-spec mapping table. Each L0 signal is a hard
 * artifact; here we pin it to the best-fit job spec (derived by reading the 22
 * `reference/jobs/*.md`) and the RFC failure-mode taxonomy.
 *
 * Rationale (also documented in the RFC):
 * - `silent-no-op-candidate` → `know-what-my-agent-is-doing`: a turn that
 *   completed with zero tools while reporting success is the canonical silent
 *   no-op — the operator cannot tell the agent did nothing. severity 3.
 * - `duplicate-delivery-represent` / `reply-delivery-failure` →
 *   `talk-to-agents-from-anywhere`: the answer's delivery to the principal is
 *   the job; a duplicate send or a TERMINALLY failed `sendRichMessage` is a
 *   delivery defect on that job. (The clerk/marko represent-duplicate case the
 *   RFC validated on lands here.) duplicate = severity 2, delivery-failure = 3.
 *   #3931: a retried-and-delivered attempt is not a delivery failure and is
 *   excluded at the log-line level (`status=retry`), not by this mapping.
 * - `hang-long-stalled` / `killed-incomplete-turn` →
 *   `steer-or-queue-mid-flight`: a turn that hangs or is killed mid-flight is
 *   a responsiveness failure on the in-flight-control job. hang = 2, killed = 3
 *   (the job was abandoned incomplete while in progress).
 * - `represent-escalation` → `feel-like-a-colleague`: an obligation escalation
 *   is a UX-friction signal (the gateway had to nudge on the agent's behalf).
 *   severity 1 — informational; on its own it does not open a sev-3 issue.
 */
export const SIGNAL_MAP: Record<L0Signal, SignalMapping> = {
  "silent-no-op-candidate": {
    failure_mode: "silent-no-op",
    severity: 3,
    job_spec: "know-what-my-agent-is-doing",
    signature: "silent-no-op:completed-zero-tools",
  },
  "flush-recovered-turn": {
    // A zero-tool turn whose answer WAS delivered via a turn-flush / outbox
    // backstop (route `flush`). It is the honest counterpart to
    // `silent-no-op-candidate` on the same job — the operator wants to know it
    // happened (the reply tool was bypassed), but the user did receive the
    // answer, so it is informational, not a delivery failure. severity 1.
    failure_mode: "drift",
    severity: 1,
    job_spec: "know-what-my-agent-is-doing",
    signature: "flush-recovered:completed-zero-tools-route-flush",
  },
  "duplicate-delivery-represent": {
    failure_mode: "duplicate",
    severity: 2,
    job_spec: "talk-to-agents-from-anywhere",
    signature: "represent-duplicate-send:reply-tool-not-called",
  },
  "reply-delivery-failure": {
    // #3931 — a TERMINAL send failure only. The `tg-post` transformer labels an
    // attempt the retry policy is about to repeat `status=retry`, so a 429 that
    // succeeded on retry no longer lands here. Severity 3 is only honest under
    // that rule: before it, this signal opened sev-3 issues about replies the
    // operator had already read.
    failure_mode: "success-theater",
    severity: 3,
    job_spec: "talk-to-agents-from-anywhere",
    signature: "reply-delivery-failure:sendRichMessage-err",
  },
  "reply-delivery-recovered": {
    // #4730 — the same rejection, but a later rich send to the SAME chat landed
    // inside the send stack's own recovery window, so one of the gateway's
    // fallback ladders delivered it (thread-drop, 429 flood sleep, backstop
    // re-attempt, card re-send). #3931's `status=err` = OUTCOME contract only
    // holds for sends routed through the retry policy — `willRetryTelegramFailure`
    // returns `false` whenever the attempt context is absent
    // (`retry-api-call.ts:207`), so every ladder outside that policy logged a
    // recovered send as terminal. 12 of the fleet's 16 recorded occurrences
    // provably delivered. Severity 1, informational: the operator still sees the
    // rejection (a rising rate is real signal about the wire), but a reply they
    // already read must not open a severity-3 lost-reply issue. Exactly the
    // split `orphaned-db-handle-recovered` makes, and for the same reason.
    failure_mode: "drift",
    severity: 1,
    job_spec: "talk-to-agents-from-anywhere",
    signature: "reply-delivery-recovered:sendRichMessage-err-then-ok",
  },
  "orphaned-db-handle": {
    // The gateway held a `*.db` handle onto a DELETED inode: every INSERT
    // through it reported success and none of the rows were on disk. That is
    // `success-theater` in its purest form — the 2026-08-10 incident ran 3h06m
    // logging a successful insert every time. severity 3: `history.db` is the
    // durable record the fleet's own delivery accounting and restart recovery
    // read back, and the `registry.db` lane has NO in-process recovery, so the
    // alarm is the only thing standing between the operator and silent loss.
    // Maps to `survive-reboots-and-real-life`: the promise this breaks is that
    // what happened before the restart is still there after it.
    failure_mode: "success-theater",
    severity: 3,
    job_spec: "survive-reboots-and-real-life",
    signature: "orphaned-db-handle:deleted-inode-writes",
  },
  "orphaned-db-handle-recovered": {
    // #4680 — the same alarm, but the sweep reopened `history.db` in the same
    // tick and proved the new handle durable (the 2026-08-12 occurrence
    // recovered in 20ms), with no lane left un-recovered. The rows written
    // before the reopen are still gone, so the operator is still told — but a
    // guard that fired and self-healed is not the silent-loss incident severity
    // 3 describes, and booking it as one is exactly the success-theater
    // inversion this ledger exists to avoid. severity 1, informational: the
    // same split `flush-recovered-turn` makes against `silent-no-op-candidate`.
    // Anything left un-recovered in the tick (registry.db, an unowned handle, a
    // FAILED reopen) stays `orphaned-db-handle` at severity 3.
    failure_mode: "drift",
    severity: 1,
    job_spec: "survive-reboots-and-real-life",
    signature: "orphaned-db-handle:recovered-in-tick",
  },
  "hang-long-stalled": {
    failure_mode: "partial",
    severity: 2,
    job_spec: "steer-or-queue-mid-flight",
    signature: "hang:long-stalled-turn",
  },
  "killed-incomplete-turn": {
    failure_mode: "missed-trigger",
    severity: 3,
    job_spec: "steer-or-queue-mid-flight",
    signature: "killed:incomplete-turn",
  },
  "send-failed-delivery": {
    // A backstop send that failed/partially delivered — the user asked and the
    // agent answered, but the answer never fully landed. That is a delivery
    // failure of the talk-to-agents contract, akin to reply-delivery-failure.
    failure_mode: "success-theater",
    severity: 3,
    job_spec: "talk-to-agents-from-anywhere",
    signature: "send-failed:turn-flush-backstop",
  },
  "represent-escalation": {
    failure_mode: "drift",
    severity: 1,
    job_spec: "feel-like-a-colleague",
    signature: "represent:obligation-escalation",
  },
  "litellm-header-passthrough-misconfig": {
    // The LiteLLM proxy's `forward_client_headers_to_llm_api` flag scoped
    // beyond the Claude allowlist (global, or a non-Claude/`*-openrouter`
    // group) forwards the subscription OAuth token to a third party — a
    // constraint violation of the "keep my subscription honest" contract.
    // Highest severity: a single misconfig is a live credential-leak surface.
    failure_mode: "constraint-violation",
    severity: 3,
    job_spec: "keep-my-subscription-honest",
    signature: "litellm-header-passthrough:oauth-leak-scope",
  },
  "litellm-callback-mount-missing": {
    // The live config names a custom callback module the live compose does not
    // mount. LiteLLM resolves callbacks during startup, so the proxy aborts its
    // lifespan and crash-loops — every proxy-routed agent turn fails.
    // severity 3 (the ceiling): this is a total outage of the shared proxy, not
    // a degraded lane. It shipped exactly this way on 2026-08-09, when a Coolify
    // redeploy regenerated the compose from `docker_compose_raw` and dropped the
    // pacer mount that had only ever been hand-added to the generated file.
    failure_mode: "constraint-violation",
    severity: 3,
    job_spec: "fleet-stays-healthy",
    signature: "litellm-callback-mount:missing-bind",
  },
  "litellm-passthrough-mount-stale": {
    // The live compose declares a passthrough/patch shadow mount whose target
    // hard-codes a CPython minor version the live image no longer ships, so the
    // mount lands at an inert path and the patch is silently dropped. Unlike the
    // callback case this does NOT crash the proxy — it comes up "healthy" while
    // running unpatched code, which is why it needs a standing sensor rather than
    // an outage to surface it. `constraint-violation`: the deploy has quietly
    // broken the mount-version invariant the pacer's passthrough metering
    // depends on. severity 3 — a silent correctness defect on the shared proxy
    // that no health check would otherwise catch. Scope: this covers a mount
    // pinned to the WRONG python version, NOT a passthrough mount removed from
    // the compose entirely — removal has no config anchor to test against and
    // stays uncovered (tracked separately in #4558).
    failure_mode: "constraint-violation",
    severity: 3,
    job_spec: "fleet-stays-healthy",
    signature: "litellm-passthrough-mount:stale-python-version",
  },
  "litellm-timeout-budget-drift": {
    // A per-deployment `timeout` in the live LiteLLM config no longer matches
    // the tier switchroom derived its client budgets from
    // (`src/litellm/timeout-budget.ts`). Classic `drift`: nothing errors at
    // apply time, but every client budget on that lane is now computed from a
    // stale number, so the router's fallback hop can be cut off mid-flight.
    // severity 3 — this exact defect class ran undetected on the retain lane
    // (client 204s vs a 290s chain) and turned every failover into a
    // guaranteed error, i.e. dropped memories, for as long as nobody noticed.
    failure_mode: "drift",
    severity: 3,
    job_spec: "fleet-stays-healthy",
    signature: "litellm-timeout-budget:tier-drift",
  },
  "hindsight-gpu-cpu-on-gpu-host": {
    // The live hindsight container is CPU-only on a host with a PROVABLY usable
    // GPU. Classic `drift`: nothing errors, the container is "healthy", but the
    // reranker and local embeddings run on CPU on the interactive recall path —
    // 5-9s recalls with deadline hits. It ran undetected through a green doctor
    // for an unknown length of time (#4459), which is exactly why it earns a
    // standing nightly sensor. severity 3 — a real, measured recall-latency
    // degradation of the whole memory layer, not an informational drift.
    failure_mode: "drift",
    severity: 3,
    job_spec: "fleet-stays-healthy",
    signature: "hindsight-gpu:cpu-only-on-gpu-host",
  },
};

/** The full set of 23 job-spec slugs the ledger carries a record for. Kept
 *  here so the writer can seed all 23 records (empty ones score 0). */
export const ALL_JOB_SPECS: readonly string[] = [
  "act-in-my-tools-with-an-identity",
  "approve-what-my-agent-can-touch",
  "crons-use-the-model-only-when-it-earns-it",
  "deliver-files-i-can-open",
  "extend-without-forking",
  "feel-like-a-colleague",
  "fleet-stays-healthy",
  "get-better-the-longer-they-run",
  "get-from-zero-to-a-working-fleet",
  "give-each-agent-its-own-workspace",
  "idempotent-update-and-restart",
  "keep-my-subscription-honest",
  "know-what-my-agent-is-doing",
  "operate-the-fleet-from-telegram",
  "remember-across-sessions",
  "restart-and-know-what-im-running",
  "run-a-fleet-of-specialists",
  "see-my-whole-fleet-from-one-screen",
  "share-auth-across-the-fleet",
  "steer-or-queue-mid-flight",
  "survive-reboots-and-real-life",
  "talk-to-agents-from-anywhere",
  "track-plan-quota-live",
];

export function mapSignal(signal: L0Signal): SignalMapping {
  return SIGNAL_MAP[signal];
}

const GATEWAY_SIGNAL_SET: ReadonlySet<string> = new Set(GATEWAY_SIGNAL_NAMES);

/** The unit every issue written before #4680 was counted in. A prior ledger
 *  carries no `counting_unit` field, so this is what its absence means. */
export const LEGACY_COUNTING_UNIT: FleetHealthCountingUnit = "log-line";

/**
 * The unit this signal's ledger `frequency` counts in.
 *
 * #4680 rule 3 folds gateway findings by event identity, so a gateway signal's
 * frequency counts distinct affected TURNS wherever the log line carries an
 * `origin=`/`tid=` turn id, and falls back to one finding per line where it
 * does not (`detectGatewayFindings`). `gateway-event` names that folded unit —
 * it is not a promise that every line was folded, only that the count is NOT
 * comparable with a pre-#4680 `log-line` count. Every non-gateway signal is one
 * finding per artifact.
 *
 * This exists so `buildLedger` can tell a genuine count DROP (someone fixed
 * the defect) from a change of RULER (the same defect, measured differently).
 * The two are indistinguishable from the number alone, and conflating them
 * makes the sensor post "Verified count-drop" on a live GitHub issue nobody
 * touched — the exact success-theater inversion the ledger exists to catch.
 */
export function countingUnitFor(signal: L0Signal): FleetHealthCountingUnit {
  return GATEWAY_SIGNAL_SET.has(signal) ? "gateway-event" : "log-line";
}

/**
 * Signals that are RECLASSIFICATIONS of one another: the same detected
 * artifact, sorted into a different severity by its OUTCOME. A finding can move
 * between the members of a group when the detector's classifier changes, or
 * when a real occurrence's outcome differs from the last one's.
 *
 * #4682 B1 — this is what the counting-unit guard cannot see. That guard
 * compares a prior issue with THIS scan's issue under the SAME dedup_key, but
 * a reclassification does not shrink a key's count: it EMPTIES the key and
 * fills a sibling. The old key then falls to `buildLedger`'s close-on-zero
 * path, which is otherwise the honest "someone fixed it" path, and gh-sync
 * comments "Verified count-drop … Closed by the Fleet Health sensor." on a
 * defect that was merely re-filed. Zero occurrences really is zero, so the
 * close itself is correct — the CLAIM attached to it is not.
 */
const RECLASSIFICATION_GROUPS: readonly (readonly L0Signal[])[] = [
  ["orphaned-db-handle", "orphaned-db-handle-recovered"],
  ["silent-no-op-candidate", "flush-recovered-turn"],
  // #4730 — the existing `reply-delivery-failure` cluster is mostly recovered
  // sends, so this scan MOVES those findings to the sibling key. Without the
  // group the old key's drop to (near) zero reads as "someone fixed it" and
  // gh-sync closes the issue with a "Verified count-drop" claim it cannot
  // support — the exact false auto-close #4682 B1 documents.
  ["reply-delivery-failure", "reply-delivery-recovered"],
];

/** dedup_key → the dedup_keys its findings can reclassify into. Derived from
 *  `SIGNALS` via `mapSignal`, so a signature or job-spec edit cannot leave a
 *  stale hand-written key behind. */
const SIBLING_DEDUP_KEYS: ReadonlyMap<string, readonly string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const group of RECLASSIFICATION_GROUPS) {
    const keys = group.map((s) => {
      const map = mapSignal(s);
      return `${map.job_spec}:${map.signature}`;
    });
    for (const key of keys) m.set(key, keys.filter((k) => k !== key));
  }
  return m;
})();

/** The dedup_keys `key`'s findings can reclassify into. Empty for a signal
 *  with no sibling. */
export function siblingDedupKeys(key: string): readonly string[] {
  return SIBLING_DEDUP_KEYS.get(key) ?? [];
}

/** The stable dedup key for a finding: `<job_spec>:<signature>`. One GitHub
 *  issue per key (updated, never re-created). */
export function dedupKeyFor(finding: Finding): string {
  const m = mapSignal(finding.signal);
  return `${m.job_spec}:${m.signature}`;
}

/**
 * Frequency factor: `log10(1 + count)` so a 282-count issue meaningfully
 * outranks a 20-count one without swamping the other three factors (RFC).
 */
export function frequencyFactor(count: number): number {
  return Math.log10(1 + Math.max(0, count));
}

/**
 * Recency factor: 1.0 within 24h of `now`, decaying linearly to 0.1 at the
 * scan-window edge (`windowDays`, default 30). A failure fixed a month ago
 * sinks; a fresh one floats — this is what closes the loop after a fix (RFC).
 * `newestIso` null (no occurrences) → 0.
 */
export function recencyFactor(
  newestIso: string | null,
  now: Date = new Date(),
  windowDays = 30,
): number {
  if (!newestIso) return 0;
  const newest = Date.parse(newestIso);
  if (!Number.isFinite(newest)) return 0;
  const ageMs = now.getTime() - newest;
  const dayMs = 86_400_000;
  if (ageMs <= dayMs) return 1.0;
  const windowMs = windowDays * dayMs;
  if (ageMs >= windowMs) return 0.1;
  // linear from 1.0 (at 24h) down to 0.1 (at window edge).
  const frac = (ageMs - dayMs) / (windowMs - dayMs);
  return 1.0 - frac * 0.9;
}

/** Reach factor: number of distinct agents exhibiting the issue (RFC uses
 *  `|reach|` directly — a fleet-wide failure outweighs a one-agent quirk). */
export function reachFactor(reachCount: number): number {
  return Math.max(1, reachCount);
}

/** The per-issue priority contribution: severity × frequency × reach × recency.
 *  Exactly the RFC formula. */
export function issuePriority(
  severity: number,
  frequency: number,
  reachCount: number,
  newestIso: string | null,
  now: Date = new Date(),
  windowDays = 30,
): number {
  return (
    severity *
    frequencyFactor(frequency) *
    reachFactor(reachCount) *
    recencyFactor(newestIso, now, windowDays)
  );
}
