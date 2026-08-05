/**
 * Agent self-improvement — the DETERMINISTIC apply-guard (slice 2).
 *
 * This is the SAFETY, in CODE, not in the prompt (RFC §"Gate every apply
 * (incl. T1) behind a per-skill eval before it lands"; job-spec invariant
 * "reversible + audited", kill-clause `no-self-escalation` / `on-leash`).
 * The slice-1 review prompt TELLS the model to self-certify a T1 edit; the
 * apply-guard does NOT trust that. When a self-improve review turn tries to
 * Write/Edit a skill file, the PreToolUse hook calls `decideApply()` here,
 * which ENFORCES — out of process, deterministically — every T1 condition:
 *
 *   1. own-skill   — the target is a skill the agent ALREADY owns (a real
 *                    dir under its own `.claude/skills/`, not a symlinked
 *                    bundled/shared skill). Else → not T1.
 *   2. single-file — the change must be one skill file (the review edits
 *                    one file per write; the guard runs per-write).
 *   3. diff-cap    — changed lines ≤ the configured T1 cap (config.ts).
 *   4. has-evals   — the skill carries `evals/evals.json` (eval-gate.ts).
 *   5. eval-pass   — a FRESH benchmark.json (produced by the review's
 *                    grader subagent + aggregate_benchmark.py, dated after
 *                    the review began) shows the edit passes AND does not
 *                    regress baseline (eval-gate.ts `evalVerdict`).
 *   6. rate-cap    — ≤ N auto-applies/day (rate-limit.ts).
 *
 * If ANY check fails the write is BLOCKED and the change DOWNGRADES to a
 * T2/T3 pending suggestion (pending-queue.ts). An unchecked edit never
 * lands. The classification reuses the slice-1 tier-router so "what makes
 * it not-T1" stays single-sourced.
 *
 * Pure-ish: filesystem reads + (in the eval leg) a spawn of the real
 * aggregate verdict reader. No model, no network. That's what lets the
 * apply / downgrade tests run without a live `claude`.
 */

import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import {
  resolveSelfImproveConfig,
  t1LiveEnabled,
  type SelfImproveConfig,
} from "./config.js";
import { classifyTier } from "./tier-router.js";
import { skillHasEvals, evalVerdict } from "./eval-gate.js";
import { verifyEvalIntegrity } from "./eval-cases.js";
import { appliesToday } from "./rate-limit.js";
import type { ChangeCandidate, Tier } from "./types.js";

/** Segment that marks a skill-bundle write (mirrors skill-validate-pretool). */
export const SKILLS_SEGMENT = "/.claude/skills/";

/** Subdir under the state dir where the review writes per-skill benchmarks. */
export const BENCHMARK_SUBDIR = "self-improve-benchmarks";

/** Where the apply-guard expects the review to have written the benchmark
 *  for a given skill slug. The review prompt/skill points the grader's
 *  aggregate output here so the guard can find + verify it. */
export function benchmarkJsonForSkill(stateDir: string, slug: string): string {
  return join(stateDir, BENCHMARK_SUBDIR, slug, "benchmark.json");
}

/** Parse `<...>/.claude/skills/<slug>/<rel>` from a write target.
 *  Returns null when the path is not a skill-bundle file write. */
export interface SkillTarget {
  /** Absolute path to the skill bundle dir (`<...>/.claude/skills/<slug>`). */
  skillDir: string;
  /** The skill slug. */
  slug: string;
  /** The bundle-relative path (e.g. `SKILL.md`, `scripts/x.sh`). */
  relPath: string;
}

export function parseSkillTarget(filePath: string): SkillTarget | null {
  if (typeof filePath !== "string" || filePath.length === 0) return null;
  const segIdx = filePath.indexOf(SKILLS_SEGMENT);
  if (segIdx < 0) return null;
  const after = filePath.slice(segIdx + SKILLS_SEGMENT.length);
  const segs = after.split("/").filter((s) => s.length > 0);
  if (segs.length < 2) return null; // skills root or a bare slug dir
  const slug = segs[0]!;
  const relPath = segs.slice(1).join("/");
  const skillDir = filePath.slice(0, segIdx + SKILLS_SEGMENT.length) + slug;
  return { skillDir, slug, relPath };
}

/** A plain skill-bundle slug: no traversal, no path separators, no dotfiles. */
const SAFE_SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * Path-safety gate. The apply-guard's "own-skill" contract is meaningless
 * if the bytes land OUTSIDE the bundle, so reject any non-canonical target
 * the review model could craft to escape — `parseSkillTarget` deliberately
 * still RECOGNISES such paths (so the guard engages and blocks rather than
 * the hook waving them through as "not a skill write"), and this function
 * is what turns them into a refusal.
 *
 * Rejects: a slug that isn't a plain bundle name (covers `.` / `..` /
 * separators); any empty / `.` / `..` / null-byte segment in relPath; and,
 * defense-in-depth, any relPath whose resolved absolute path leaves the
 * bundle dir.
 */
export function skillTargetEscapes(target: SkillTarget): boolean {
  if (!SAFE_SLUG.test(target.slug)) return true;
  for (const s of target.relPath.split("/")) {
    if (s === "" || s === "." || s === ".." || s.includes("\0")) return true;
  }
  const base = resolve(target.skillDir);
  const resolved = resolve(target.skillDir, target.relPath);
  return resolved !== base && !resolved.startsWith(base + sep);
}

/**
 * Does the agent OWN this skill? Ownership = a real directory under the
 * agent's own writable `.claude/skills/` (the native-authoring path).
 * Bundled / shared / globally-mounted skills are SYMLINKS into a read-only
 * pool — editing one is never a T1 (it would escape the agent's trust
 * domain → tier-router forces T2). We treat a symlinked skill dir, or a
 * skill dir that does not exist on disk, as NOT owned.
 */
export function ownsSkill(skillDir: string): boolean {
  try {
    const st = lstatSync(skillDir);
    if (st.isSymbolicLink()) return false; // shared/bundled pool symlink
    return st.isDirectory();
  } catch {
    return false; // not on disk → can't own it
  }
}

/**
 * Estimate the changed-line count for a Write/Edit/MultiEdit.
 *
 *   - Write: lines in the new content that differ from the current file
 *     (added + removed, like `diff`). For a brand-new file it's the line
 *     count of the new content.
 *   - Edit: added + removed lines across the single old→new replacement.
 *   - MultiEdit: summed across edits.
 *
 * Deterministic and dependency-free — a line-multiset diff, not an LCS.
 * Good enough for the cap (we only need "is this small"); it never
 * UNDER-counts a large change (a multiset diff is ≥ the true minimal edit
 * for the cap's purpose of catching big writes).
 */
export function estimateChangedLines(
  toolName: string,
  input: Record<string, unknown>,
  filePath: string,
): number {
  const splitLines = (s: string): string[] =>
    s.length === 0 ? [] : s.replace(/\r\n/g, "\n").split("\n");

  const multisetDiff = (before: string[], after: string[]): number => {
    const counts = new Map<string, number>();
    for (const l of before) counts.set(l, (counts.get(l) ?? 0) + 1);
    let added = 0;
    for (const l of after) {
      const c = counts.get(l) ?? 0;
      if (c > 0) counts.set(l, c - 1);
      else added += 1;
    }
    let removed = 0;
    for (const c of counts.values()) removed += c;
    return added + removed;
  };

  const readCurrent = (): string => {
    try {
      return readFileSync(filePath, "utf-8");
    } catch {
      return "";
    }
  };

  if (toolName === "Write") {
    const content = typeof input.content === "string" ? input.content : "";
    return multisetDiff(splitLines(readCurrent()), splitLines(content));
  }

  if (toolName === "Edit") {
    const oldS = typeof input.old_string === "string" ? input.old_string : "";
    const newS = typeof input.new_string === "string" ? input.new_string : "";
    return multisetDiff(splitLines(oldS), splitLines(newS));
  }

  if (toolName === "MultiEdit") {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    let total = 0;
    for (const e of edits) {
      if (!e || typeof e !== "object") continue;
      const ed = e as Record<string, unknown>;
      const oldS = typeof ed.old_string === "string" ? ed.old_string : "";
      const newS = typeof ed.new_string === "string" ? ed.new_string : "";
      total += multisetDiff(splitLines(oldS), splitLines(newS));
    }
    return total;
  }

  return 0;
}

export type ApplyDecision =
  | {
      /** Allow the write to proceed (a verified T1). */
      action: "allow";
      tier: "T1";
      changedLines: number;
      candidatePassRate: number;
      baselinePassRate: number;
      reason: string;
    }
  | {
      /** Block the write and downgrade to a pending suggestion. */
      action: "block";
      /** The tier the downgrade is recorded as (T2 by default; T3 when the
       *  classification floor says so). */
      downgradeTier: Exclude<Tier, "T0" | "T1">;
      /** Operator-facing reason the auto-apply was refused. */
      reason: string;
      /** A change candidate suitable for enqueuePending(). */
      candidate: ChangeCandidate;
    };

export interface DecideApplyParams {
  toolName: string;
  input: Record<string, unknown>;
  filePath: string;
  /** Agent state dir (TELEGRAM_STATE_DIR) — for the benchmark + rate-cap. */
  stateDir: string;
  cfg?: SelfImproveConfig;
  now?: () => number;
  /** Test seam: override "is the skill owned" (default = real fs check). */
  ownsSkillFn?: (skillDir: string) => boolean;
  /** Test seam: override the freshness floor (ms). Defaults to the review
   *  context's created_at when one is supplied. */
  freshAfterMs?: number;
}

/** Build the downgrade candidate that the apply-guard hands the queue. */
function downgradeCandidate(
  target: SkillTarget,
  owns: boolean,
  changedLines: number,
  lesson: string,
): ChangeCandidate {
  return {
    lesson,
    proposedChange: `Edit ${target.relPath} in skill "${target.slug}" (auto-apply refused — see reason)`,
    skillSlug: target.slug,
    ownsSkill: owns,
    changedLines,
    multiFile: false,
  };
}

/**
 * THE decision. Given a skill-file write attempted inside a self-improve
 * review turn, decide allow (verified T1) vs block+downgrade.
 *
 * Order mirrors the cheapest-first / most-restrictive-wins shape of the
 * tier-router: ownership → single-file → diff-cap → evals-present →
 * eval-verdict → rate-cap. The FIRST failing check decides the downgrade
 * reason. Only when every check passes does the write land.
 */
export function decideApply(p: DecideApplyParams): ApplyDecision {
  const cfg = p.cfg ?? resolveSelfImproveConfig();
  const now = p.now ?? Date.now;

  const target = parseSkillTarget(p.filePath);
  // Not a skill-bundle file → the guard should not have been asked; treat
  // as a non-T1 downgrade with a generic candidate (the hook only calls us
  // for skill writes, so this is defensive).
  if (!target) {
    return {
      action: "block",
      downgradeTier: "T2",
      reason: "write target is not an own-skill bundle file",
      candidate: {
        lesson: "self-improve review attempted a non-skill write",
        proposedChange: p.filePath,
        multiFile: false,
      },
    };
  }

  // Path-safety BEFORE any ownership/eval decision: a crafted slug or
  // relPath (".." traversal, separators, null bytes) could make the bytes
  // land outside the bundle while the guard reasons about the legit skill.
  // Refuse deterministically.
  if (skillTargetEscapes(target)) {
    return {
      action: "block",
      downgradeTier: "T2",
      reason: `skill write path escapes the bundle (slug="${target.slug}", rel="${target.relPath}") — refused`,
      candidate: {
        lesson: `Bind the recurring lesson into skill "${target.slug}"`,
        proposedChange: `Edit ${target.relPath} in skill "${target.slug}" (path escapes bundle — refused)`,
        skillSlug: target.slug,
        ownsSkill: false,
        changedLines: 0,
        multiFile: false,
      },
    };
  }

  const owns = (p.ownsSkillFn ?? ownsSkill)(target.skillDir);
  const changedLines = estimateChangedLines(p.toolName, p.input, p.filePath);
  const lesson = `Bind the recurring lesson into skill "${target.slug}"`;

  // (1) own-skill — and let the tier-router be the single source of truth
  //     for "is this even a T1 shape". If the router says anything but T1,
  //     downgrade with the router's reason (this captures own-skill +
  //     diff-cap + multi-file in one place).
  const routed = classifyTier(
    {
      lesson,
      proposedChange: "skill edit",
      skillSlug: target.slug,
      ownsSkill: owns,
      changedLines,
      multiFile: false,
    },
    cfg,
  );
  if (routed.tier !== "T1") {
    return {
      action: "block",
      downgradeTier: routed.tier === "T3" ? "T3" : "T2",
      reason: `not a T1 auto-apply: ${routed.reason}`,
      candidate: downgradeCandidate(target, owns, changedLines, lesson),
    };
  }

  // (4) has-evals — a T1 with no evals.json must NOT auto-apply.
  if (!skillHasEvals(target.skillDir)) {
    return {
      action: "block",
      downgradeTier: "T2",
      reason: `skill "${target.slug}" has no evals/evals.json — can't measure the edit; downgraded to a proposal`,
      candidate: downgradeCandidate(target, owns, changedLines, lesson),
    };
  }

  // (5) eval-pass — a FRESH benchmark.json from the review's grader run
  //     must exist and clear evalVerdict. Missing / stale / failing → block.
  const benchPath = benchmarkJsonForSkill(p.stateDir, target.slug);
  if (!existsSync(benchPath)) {
    return {
      action: "block",
      downgradeTier: "T2",
      reason: `no eval result for skill "${target.slug}" — the per-skill eval did not run/pass; downgraded to a proposal`,
      candidate: downgradeCandidate(target, owns, changedLines, lesson),
    };
  }
  // Freshness: the benchmark must post-date the start of this review (so a
  // stale benchmark from a prior, different edit can't wave a new edit
  // through). When `freshAfterMs` is given, enforce it.
  if (typeof p.freshAfterMs === "number") {
    let mtime = 0;
    try {
      mtime = statSync(benchPath).mtimeMs;
    } catch {
      mtime = 0;
    }
    if (mtime < p.freshAfterMs) {
      return {
        action: "block",
        downgradeTier: "T2",
        reason: `eval result for "${target.slug}" is stale (predates this review) — re-run evals; downgraded to a proposal`,
        candidate: downgradeCandidate(target, owns, changedLines, lesson),
      };
    }
  }
  const verdict = evalVerdict(benchPath, cfg);
  if (!verdict.pass) {
    return {
      action: "block",
      downgradeTier: "T2",
      reason: `eval gate blocked the edit to "${target.slug}": ${verdict.reason}`,
      candidate: downgradeCandidate(target, owns, changedLines, lesson),
    };
  }

  // (5b) eval-integrity — the verdict above trusts the skill's evals.json,
  //      so refuse to silent-apply on an eval set that has DRIFTED from its
  //      last sanctioned state (an out-of-band edit to evals.json).
  //      HONESTY (RFC amendment MJ1): this is defense-in-depth, tamper-
  //      EVIDENT — NOT a cryptographic boundary. The manifest lives in the
  //      agent-writable state dir; a model that also rewrites it defeats the
  //      check. The HARD backstop is the T1-live gate below (default OFF).
  //      "missing" (never recorded / first sight) and "no-evals" are not
  //      drift, so only an explicit "drift" blocks here.
  if (verifyEvalIntegrity(p.stateDir, target.slug, target.skillDir) === "drift") {
    return {
      action: "block",
      downgradeTier: "T2",
      reason: `eval set for "${target.slug}" drifted from its recorded baseline (out-of-band edit) — refusing to auto-apply on unverified evals; downgraded to a proposal`,
      candidate: downgradeCandidate(target, owns, changedLines, lesson),
    };
  }

  // (6) rate-cap — ≤ N auto-applies/day.
  const used = appliesToday(p.stateDir, now);
  if (used >= cfg.maxAutoAppliesPerDay) {
    return {
      action: "block",
      downgradeTier: "T2",
      reason: `daily auto-apply cap reached (${used}/${cfg.maxAutoAppliesPerDay}) — downgraded to a proposal`,
      candidate: downgradeCandidate(target, owns, changedLines, lesson),
    };
  }

  // (7) T1-live gate — THE hard backstop (RFC amendment invariant + MJ1).
  //     Even a fully-verified T1 does NOT land SILENTLY unless the operator
  //     has explicitly opted in with SWITCHROOM_SELF_IMPROVE_T1_LIVE=1.
  //     Default OFF: every otherwise-allowable auto-apply is downgraded to a
  //     T2 one-tap proposal, so the operator sees and approves it. This is
  //     what makes a tampered eval (the manifest is only tamper-EVIDENT,
  //     not a boundary) unable to cause a silent auto-apply. Flipping this
  //     ON is deliberately NOT part of the eval-case PR.
  if (!t1LiveEnabled()) {
    return {
      action: "block",
      downgradeTier: "T2",
      reason: `verified T1 for "${target.slug}", but silent auto-apply is disabled (SWITCHROOM_SELF_IMPROVE_T1_LIVE unset) — surfacing as a one-tap proposal`,
      candidate: downgradeCandidate(target, owns, changedLines, lesson),
    };
  }

  // All checks pass AND silent-apply is opted in — a verified, small,
  // reversible, eval-passing, under-cap edit to an owned skill. Let it land.
  return {
    action: "allow",
    tier: "T1",
    changedLines,
    candidatePassRate: verdict.candidatePassRate,
    baselinePassRate: verdict.baselinePassRate,
    reason: `verified T1: ${changedLines} changed line${changedLines === 1 ? "" : "s"} to owned skill "${target.slug}", evals ${verdict.candidatePassRate.toFixed(2)} ≥ baseline ${verdict.baselinePassRate.toFixed(2)}, ${used + 1}/${cfg.maxAutoAppliesPerDay} today`,
  };
}
