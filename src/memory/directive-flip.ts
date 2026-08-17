/**
 * Directive-flip orchestrator — Memory v2 M3 (Surface-A), carve-M3.md §9 T-C.
 *
 * The flip itself is a per-agent config change: set
 * `memory.inject_directives: false` (which plumbs to
 * `HINDSIGHT_INJECT_DIRECTIVES=false`) so `recall.py`'s directive-injection
 * guard stops re-injecting the `<active_directives>` block on every turn once
 * the CLAUDE.md rules block carries the same guarantees. This module owns the
 * PRECONDITION check for that flip — the deterministic readiness gate — plus
 * the operator-facing preflight text. It never mutates switchroom.yaml (that
 * is an operator-gated edit); it decides "is this agent safe to flip yet?" and
 * says exactly why not when it isn't.
 *
 * ## The binding gate is the rules-block byte budget, NOT MAX_DIRECTIVES
 *
 * A flipped agent's directives move into the rules block, which has a HARD
 * 6144-byte budget ({@link RULES_BLOCK_BUDGET_BYTES}, rules-block.ts). The
 * MAX_DIRECTIVES=30 count cap is a DIFFERENT, looser constraint — an agent can
 * sit under 30 directives and still blow the byte budget (long directive
 * bodies), or carry a few very short ones. Flipping an over-budget agent would
 * force its migrated rules to be truncated to fit, silently dropping a
 * guardrail — a correctness bug. So this gate measures the actual post-triage
 * residue BYTES and refuses the flip when they exceed the budget. Measure at
 * flip time against live bank state ({@link measureLiveResidue}) — never a
 * stale artifact row.
 *
 * ## Two-flag ordering
 *
 * `memory.rules_block` (M1) must be ON before `memory.inject_directives` (M3)
 * goes OFF: turning injection off before the rules-block toolchain exists would
 * leave the agent with neither surface carrying its guardrails. This gate
 * refuses the flip unless rules_block is already enabled.
 */

import {
  buildDirectiveTriageRows,
  type DirectiveTriageRow,
} from "./directive-triage.js";
import {
  measureDirectiveResidue,
  type DirectiveResidueMeasurement,
} from "./directive-residue.js";
import type { DirectiveAdmin, HindsightDirective } from "./hindsight-directive-admin.js";
import { RULES_BLOCK_BUDGET_BYTES } from "./rules-block.js";

export interface FlipReadinessOptions {
  /** Whether the agent's `memory.rules_block` (M1) flag is already enabled. */
  rulesBlockEnabled: boolean;
}

export interface FlipReadiness {
  agent: string;
  ready: boolean;
  /** Blocking reasons, empty iff `ready`. Human-readable, one per blocker. */
  reasons: string[];
  residueBytes: number;
  budgetBytes: number;
  residueDirectiveCount: number;
}

/**
 * Decide whether an agent is safe to flip (inject_directives → false).
 *
 * Pure and deterministic — the two hard preconditions are:
 *   1. rules_block (M1) is already enabled (two-flag ordering), and
 *   2. the measured residue fits the rules-block byte budget (≤ 6144B).
 *
 * The byte gate is `>` budget, so exactly-6144B is READY and 6145B is not:
 * the budget is inclusive, matching `renderedByteLen`'s own boundary.
 */
export function evaluateFlipReadiness(
  measurement: DirectiveResidueMeasurement,
  opts: FlipReadinessOptions,
): FlipReadiness {
  const reasons: string[] = [];

  if (!opts.rulesBlockEnabled) {
    reasons.push(
      "memory.rules_block (M1) is not enabled — enable the rules-block " +
        "toolchain and migrate the directives into the block BEFORE flipping " +
        "inject_directives off (two-flag ordering; flipping first strips every " +
        "guardrail).",
    );
  }

  if (measurement.residueBytes > RULES_BLOCK_BUDGET_BYTES) {
    reasons.push(
      `directive residue is ${measurement.residueBytes}B, over the ` +
        `${RULES_BLOCK_BUDGET_BYTES}B rules-block budget (` +
        `${measurement.residueDirectiveCount} active residue directive(s)). ` +
        "Triage the directive set down — retire stale rules or shorten bodies — " +
        "until the residue fits, then re-check. The budget, not MAX_DIRECTIVES, " +
        "is the binding gate.",
    );
  }

  return {
    agent: measurement.agent,
    ready: reasons.length === 0,
    reasons,
    residueBytes: measurement.residueBytes,
    budgetBytes: RULES_BLOCK_BUDGET_BYTES,
    residueDirectiveCount: measurement.residueDirectiveCount,
  };
}

/**
 * Measure an agent's live post-triage residue from the bank's CURRENT
 * directive set, so the readiness gate runs against reality at flip time
 * rather than a stale `m2-residue.md` row.
 *
 * Untriaged ceiling (no overrides): every directive keeps by default and every
 * rules-block-marked directive stages for M3 — both categories count into the
 * residue. That is the conservative worst case: if the agent fits UNTRIAGED, it
 * certainly fits after any triage that only ever retires. (ziggy is the canary
 * precisely because it fits untriaged.)
 */
export async function measureLiveResidue(
  admin: DirectiveAdmin,
  agent: string,
): Promise<DirectiveResidueMeasurement> {
  const directives = await admin.list();
  const rows: DirectiveTriageRow[] = buildDirectiveTriageRows(directives);
  const byId = new Map<string, HindsightDirective>(directives.map((d) => [d.id, d]));
  return measureDirectiveResidue(agent, rows, byId);
}

/**
 * The exact per-agent switchroom.yaml stanza the operator applies to flip an
 * agent. Kept here (not inlined in the CLI) so the readiness command and any
 * future config-edit proposer render byte-identical guidance.
 */
export function flipConfigStanza(agent: string): string {
  return [
    `# ${agent} — Memory v2 M3 Surface-A flip (suppress <active_directives>)`,
    "memory:",
    "  rules_block: true        # M1 must already be on (checked)",
    "  inject_directives: false # M3: stop re-injecting migrated directives",
  ].join("\n");
}
