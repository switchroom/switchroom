/**
 * Pure cron tier-routing — docs/rfcs/cheap-cron-sessions.md §2–3.
 *
 * Given a schedule entry's (kind, model, context) and the global
 * SWITCHROOM_CHEAP_CRON flag, decide which tier a fire takes, which
 * gateway session a model fire injects into, and (Tier 1) which cheap
 * model the cron session launches at.
 *
 * Total-enumerable by construction:
 *   flag∈{off,on} × kind∈{poll,prompt} × model∈{cheap,opus,custom,unset}
 *   × context∈{fresh,agent,unset}
 * = 48 reachable inputs, pinned by total enumeration in
 * tests/scheduler/cron-routing.test.ts (operator standard
 * `feedback_prove_finite_fsm_not_sample`: prove finite decisions by
 * enumeration, never a sampling property test).
 *
 * Pure: no clock, IO, or env read (the caller resolves the flag once and
 * passes it in) — so the enumeration test needs no mocks.
 */

export type CronTier = "poll" | "cheap" | "main";
export type CronSession = "cron" | "main";

export interface CronRoutingInput {
  kind?: "poll" | "prompt";
  model?: string;
  context?: "fresh" | "agent";
}

export interface CronRouting {
  /** poll → model-free Tier 0; cheap → Tier 1 cron session; main → Tier 2 live session. */
  tier: CronTier;
  /** Gateway session a model fire injects into. null for Tier 0 until it escalates. */
  session: CronSession | null;
  /** Tier 1 only: the model the cheap cron session launches at. */
  cronModel?: string;
  /**
   * True when `model` was a custom/unrecognised id and `context` was unset,
   * so routing conservatively chose Tier 2 (agent). collectScheduleEntries
   * emits a one-time warn for these — the silent-tier-flip guard from §3.1.
   */
  customModelDowngrade: boolean;
}

/** v1 cheap cron-session model. A live session's model is fixed at launch, so this only governs Tier 1. */
export const DEFAULT_CRON_MODEL = "claude-sonnet-4-6";

// Known-cheap model matcher: the Sonnet/Haiku family, by full id or short
// alias. Opus and anything unrecognised are NOT cheap → Tier 2 (conservative).
const CHEAP_MODEL_RE = /(^|[^a-z])(sonnet|haiku)([^a-z]|$)/i;
const OPUS_MODEL_RE = /opus/i;

export function isKnownCheapModel(model: string | undefined): boolean {
  return model !== undefined && CHEAP_MODEL_RE.test(model);
}

/** Reads the kill-switch. The ONLY env read in this module; isolated so the core stays pure. */
export function isCheapCronEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.SWITCHROOM_CHEAP_CRON ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

/** Tier-1 cron-session model: honour an explicit cheap id, else default to sonnet. */
function resolveCronModel(model: string | undefined): string {
  return isKnownCheapModel(model) ? model! : DEFAULT_CRON_MODEL;
}

export function resolveCronRouting(
  input: CronRoutingInput,
  opts: { cheapCronEnabled: boolean },
): CronRouting {
  // Kill-switch: flag off ⟹ exactly today's behaviour. Every fire is a
  // main-session turn; kind/model/context are inert. A `kind: poll` entry
  // fires its escalation prompt as an ordinary turn — disabling the flag can
  // NEVER silently drop a cron.
  if (!opts.cheapCronEnabled) {
    return { tier: "main", session: "main", customModelDowngrade: false };
  }

  const kind = input.kind ?? "prompt";

  // Effective context for the *model* fire (the prompt turn, or a poll's
  // escalation). Explicit wins; else infer from model; else conservative agent.
  let context: "fresh" | "agent";
  let customModelDowngrade = false;
  if (input.context) {
    context = input.context;
  } else if (isKnownCheapModel(input.model)) {
    context = "fresh";
  } else {
    context = "agent";
    // A defined-but-non-cheap, non-opus id is a custom model: we downgraded to
    // Tier 2 to avoid assuming it's cheap. opus→agent and unset→agent are the
    // expected defaults, not downgrades, so they don't warn.
    customModelDowngrade =
      input.model !== undefined &&
      !isKnownCheapModel(input.model) &&
      !OPUS_MODEL_RE.test(input.model);
  }

  if (kind === "poll") {
    // Tier 0: model-free, no session, until a hit escalates. The escalation
    // reuses (context, model) recomputed as a 'prompt' decision below.
    return { tier: "poll", session: null, customModelDowngrade };
  }

  if (context === "fresh") {
    return {
      tier: "cheap",
      session: "cron",
      cronModel: resolveCronModel(input.model),
      customModelDowngrade,
    };
  }
  return { tier: "main", session: "main", customModelDowngrade };
}

/**
 * The routing a Tier-0 poll's escalation takes — it fires the entry's prompt
 * as a model turn, so it reuses the (model, context) decision as a 'prompt'.
 */
export function resolveEscalationRouting(
  input: CronRoutingInput,
  opts: { cheapCronEnabled: boolean },
): CronRouting {
  return resolveCronRouting({ ...input, kind: "prompt" }, opts);
}
