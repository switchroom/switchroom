/**
 * The Memory v2 M3 directive-flip UAT GATE.
 *
 * Combines the deterministic checks into one per-agent verdict and one process
 * exit code, so the flip UAT is `&&`-chainable in CI without parsing prose:
 *
 *   - Tier-1 equivalence ({@link EquivalenceReport} from `tier1-equivalence.ts`)
 *     — the migrated rules carry every directive guardrail, nothing dropped /
 *     truncated / invented, and the block fits the 6144B budget with a correct
 *     sentinel.
 *   - recall_log injection delta ({@link DirectiveInjectionDelta} from
 *     `recall-log.ts`) — after the flip the recall hook injects ZERO
 *     directives (the volume the flip was supposed to remove actually left the
 *     prompt). Optional: absent when the caller runs the gate PRE-flip (Tier-1
 *     only), present once there's a postflip window to diff.
 *   - Tier-2 behavioural probes — the mtcute probe runner is NOT built here
 *     (out of scope for the deterministic half). A typed seam
 *     ({@link Tier2ProbeResults}) is left so wiring it later is additive: the
 *     gate already folds a `tier2` result into the verdict when one is present.
 *
 * Everything here is PURE: callers do the IO (read the bank, parse the rules
 * block, tail recall_log, run probes) and hand this module the structured
 * results. That keeps the verdict logic unit-testable with fixtures.
 */

import type { EquivalenceReport } from "./tier1-equivalence.js";
import type { DirectiveInjectionDelta } from "./recall-log.js";

// ---------------------------------------------------------------------------
// Tier-2 seam — DO NOT build the probe runner here (out of scope).
// ---------------------------------------------------------------------------

/**
 * TODO(Tier-2): result envelope the (not-yet-built) mtcute behavioural probe
 * runner will produce — a baseline-vs-postflip diff proving the flipped agent
 * still HONOURS each migrated guardrail in live conversation (the model-in-the-
 * loop half the deterministic checks can't cover).
 *
 * This interface is a placeholder shape so the gate can fold Tier-2 in
 * additively once the runner exists. Only `pass` is load-bearing today; the
 * rest are indicative and WILL change when the runner is designed. Nothing in
 * this PR produces a value of this type.
 */
export interface Tier2ProbeResults {
  /** Overall behavioural verdict. */
  pass: boolean;
  /** Per-guardrail probe outcomes (shape TBD by the probe runner). */
  probes?: ReadonlyArray<{
    directiveId: string;
    /** The guardrail still held under probing. */
    held: boolean;
    detail?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export interface GateInput {
  agent: string;
  /** Deterministic Tier-1 equivalence result (always required). */
  tier1: EquivalenceReport;
  /** recall_log before/after diff. Omit when running pre-flip. */
  recallLog?: DirectiveInjectionDelta;
  /** Tier-2 behavioural probe results. Omit until the probe runner exists. */
  tier2?: Tier2ProbeResults | null;
}

export interface GateCheck {
  name: string;
  pass: boolean;
  /** One-line human explanation for the report. */
  detail: string;
  /** True when the check was not run (no input supplied) — informational, not
   *  a failure. A skipped check never flips the verdict. */
  skipped?: boolean;
}

export interface GateVerdict {
  agent: string;
  pass: boolean;
  checks: GateCheck[];
}

/** Evaluate one agent's flip gate from its structured inputs. A check that was
 *  not supplied (recallLog / tier2 omitted) is recorded as `skipped` and does
 *  NOT fail the verdict — the gate fails only on a check that ran and failed. */
export function evaluateGate(input: GateInput): GateVerdict {
  const checks: GateCheck[] = [];
  const t = input.tier1;

  // Tier-1 — break out each sub-contract so the report pinpoints the breach.
  checks.push({
    name: "tier1: no missing guardrails",
    pass: t.missing_from_rules.length === 0,
    detail:
      t.missing_from_rules.length === 0
        ? "every active residue directive maps to a present rule or an explicit retirement"
        : `${t.missing_from_rules.length} directive(s) unmapped/absent: ${t.missing_from_rules
            .map((m) => `${m.id}(${m.reason})`)
            .join(", ")}`,
  });
  checks.push({
    name: "tier1: no drift/truncation",
    pass: t.truncated_or_drifted.length === 0,
    detail:
      t.truncated_or_drifted.length === 0
        ? "every mapped rule preserves its directive's keywords and is not truncated"
        : `${t.truncated_or_drifted.length} rule(s) drifted: ${t.truncated_or_drifted
            .map((d) => `${d.ruleId}[${d.truncated ? "truncated" : d.missingKeywords.join("/")}]`)
            .join(", ")}`,
  });
  checks.push({
    name: "tier1: no unsourced rules",
    pass: t.unsourced_rules.length === 0,
    detail:
      t.unsourced_rules.length === 0
        ? "every rule traces to a directive source"
        : `${t.unsourced_rules.length} invented rule(s): ${t.unsourced_rules.map((r) => r.id).join(", ")}`,
  });
  checks.push({
    name: "tier1: within 6144B budget",
    pass: t.withinBudget,
    detail: `${t.renderedBytes}B / ${t.budgetBytes}B`,
  });
  checks.push({
    name: "tier1: sentinel count matches",
    pass: t.sentinelMatchesCount,
    detail: `sentinel=${t.sentinelCount ?? "none"} rules=${t.ruleCount}`,
  });

  // recall_log — postflip injection must be fully suppressed.
  if (input.recallLog) {
    const d = input.recallLog;
    checks.push({
      name: "recall_log: directives suppressed postflip",
      pass: d.postflipFullySuppressed,
      detail: d.postflipFullySuppressed
        ? `injection volume ${d.baseline.maxDirectiveCount}→0 (delta ${d.volumeDelta}) over ${d.postflip.rowCount} postflip row(s)`
        : `still injecting postflip: max ${d.postflip.maxDirectiveCount}, residual ids ${d.residualIds.join(", ") || "(none)"}`,
    });
  } else {
    checks.push({
      name: "recall_log: directives suppressed postflip",
      pass: true,
      skipped: true,
      detail: "no postflip window supplied (pre-flip run) — check skipped",
    });
  }

  // Tier-2 — behavioural probes (seam; only folded in when supplied).
  if (input.tier2 !== undefined && input.tier2 !== null) {
    checks.push({
      name: "tier2: behavioural probes hold",
      pass: input.tier2.pass,
      detail: input.tier2.pass
        ? "all migrated guardrails held under probing"
        : "one or more guardrails failed a behavioural probe",
    });
  } else {
    checks.push({
      name: "tier2: behavioural probes hold",
      pass: true,
      skipped: true,
      detail: "probe runner not wired (Tier-2 out of scope for this gate) — check skipped",
    });
  }

  const pass = checks.every((c) => c.pass);
  return { agent: input.agent, pass, checks };
}

export interface GateRun {
  verdicts: GateVerdict[];
  /** 0 when every agent passed, 1 otherwise — the process exit code. */
  exitCode: number;
}

/** Evaluate the gate across several agents and derive the process exit code. */
export function runGate(inputs: readonly GateInput[]): GateRun {
  const verdicts = inputs.map(evaluateGate);
  const exitCode = verdicts.every((v) => v.pass) ? 0 : 1;
  return { verdicts, exitCode };
}
