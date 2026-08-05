/**
 * Agent self-improvement — shared types (RFC
 * `reference/rfcs/agent-self-improvement.md`, slice 1).
 *
 * The job (`reference/jobs/get-better-the-longer-they-run.md`): when an
 * agent is corrected, or finds a path it will reuse, that lesson should
 * bind on every future run without re-teaching — and without the agent
 * manufacturing skills/crons. Slice 1 builds the foundational vertical:
 * a cheap deterministic GATE on the turn-end Stop hook, a forked review
 * (routed through `inject_inbound`, not `claude -p`), a blast-radius
 * TIER router, an eval gate on T1, and a per-agent pending-suggestions
 * queue for everything heavier.
 *
 * These are pure, dependency-light types so the gate / router / queue /
 * eval-gate modules stay unit-testable without the gateway, the broker,
 * or a live `claude` process.
 */

/** A normalised conversation message, shape-compatible with the Claude
 *  Code transcript (`{role, content}`) the Stop hook reads. `content`
 *  is the flattened text — the gate works on text, not tool payloads. */
export interface TurnMessage {
  role: "user" | "assistant" | string;
  /** Flattened text of the message (list-content shapes are joined). */
  text: string;
}

/** The kinds of deterministic learning signal the gate detects. */
export type LearningSignalKind =
  /** Operator said "no / wrong / that's not it / I told you …". */
  | "operator-correction"
  /** The same manual fix (e.g. an identical Edit) recurred. */
  | "repeated-manual-fix"
  /** A standing directive ("always do X") the agent did not honour. */
  | "directive-not-bound";

/** One detected signal with the evidence that tripped it. */
export interface LearningSignal {
  kind: LearningSignalKind;
  /** Short human-readable reason (goes into the forked-review prompt). */
  reason: string;
  /** How many occurrences were counted (≥ threshold when it trips). */
  occurrences: number;
  /** A short verbatim excerpt of the triggering text (capped). */
  evidence: string;
}

/** Result of running the gate over a finished turn. */
export interface GateResult {
  /** True iff at least one signal crossed the repetition threshold. */
  tripped: boolean;
  /** Every signal at/above threshold (empty when not tripped). */
  signals: LearningSignal[];
}

/** Blast-radius tier for a candidate self-improvement change. */
export type Tier =
  /** Nothing to do (most turns). */
  | "T0"
  /** Small, reversible edit to a skill the agent already owns → auto. */
  | "T1"
  /** Medium / shared-skill → propose (one-tap), do not auto-apply. */
  | "T2"
  /** New cron / new skill / cross-agent / irreversible → ask explicitly. */
  | "T3";

/**
 * A candidate change the forked review proposes. The router consumes
 * this to assign a tier; the eval gate consumes it before a T1 lands.
 */
export interface ChangeCandidate {
  /** The lesson, in one line (operator-readable). */
  lesson: string;
  /** The smallest change that makes the lesson bind. */
  proposedChange: string;
  /** Target skill slug, when the change edits a skill the agent owns. */
  skillSlug?: string;
  /** True iff `skillSlug` names a skill in the agent's OWN writable dir. */
  ownsSkill?: boolean;
  /** Estimated changed-line count for the edit (single skill file). */
  changedLines?: number;
  /** True iff the change touches more than one skill file. */
  multiFile?: boolean;
  /** True iff the change creates a NEW skill (vs editing an existing one). */
  createsNewSkill?: boolean;
  /**
   * Provenance of the candidate. `synthesized-personal-skill` marks a
   * proposal produced by the weekly skill-synthesis cron (#2670): a NEW
   * *personal* skill in the agent's OWN reversible workspace. Such a
   * proposal is carved out to T2 (one-tap) rather than T3 (explicit ask)
   * — the operator tap still authorizes the write, so `no-self-escalation`
   * holds; only the friction (one tap vs ask) changes. Any non-personal
   * blast radius (cron / cross-agent / shared / irreversible) ignores this
   * hint and stays T3 per the hard floors above.
   *
   * DELIBERATELY REUSED by failure-synthesis: a NEW skill drafted from an
   * observed failure (RFC §"failure synthesis") sets the SAME
   * `synthesized-personal-skill` kind so it rides this exact T2 carve-out
   * with zero tier-router changes. The tier hint says only "personal, own,
   * reversible → one-tap"; it carries no provenance. WHERE the draft came
   * from (skill- vs failure-synthesis) lives on the proposal's `origin`
   * field (`SkillProposal.origin` in skill-proposals.ts), not here.
   */
  proposalKind?: "synthesized-personal-skill";
  /** True iff the change creates / edits a cron schedule. */
  touchesCron?: boolean;
  /** True iff the change reaches another agent. */
  crossAgent?: boolean;
  /** True iff the change is not cleanly reversible (git/validator can't undo). */
  irreversible?: boolean;
}
