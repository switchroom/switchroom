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

import type { FleetHealthFailureMode } from "../web/fleet-health-read.js";
import type { L0Signal, Finding } from "./detect.js";

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
