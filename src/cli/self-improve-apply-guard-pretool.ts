/**
 * PreToolUse hook — agent self-improvement APPLY-GUARD (RFC
 * `reference/rfcs/agent-self-improvement.md`, slice 2).
 *
 * Fires on Write / Edit / MultiEdit. It is a NO-OP on a normal turn: it
 * only acts when a self-improve review is pending (the Stop hook dropped a
 * review-context marker at injection time — see
 * `src/self-improve/review-context.ts`) AND the target is a skill-bundle
 * file. In that case it ENFORCES the T1 conditions deterministically,
 * out-of-process — the safety lives in CODE, not in the review prompt the
 * model could ignore:
 *
 *   own-skill ∧ single-file ∧ diff-cap ∧ evals.json present ∧ evals pass
 *   (no baseline regression) ∧ under the daily auto-apply cap
 *
 * If every check passes the write is ALLOWED (and one auto-apply is
 * recorded against the daily cap). If ANY check fails the write is
 * BLOCKED and the change is DOWNGRADED to a T2/T3 pending suggestion
 * (`src/self-improve/pending-queue.ts`) — an unchecked edit never lands.
 *
 * Ordering vs the advisory skill-validate-pretool linter: this hook is a
 * SEPARATE PreToolUse entry. Claude Code runs all matching PreToolUse
 * hooks; the first `decision:"block"` wins. The linter is advisory (only
 * blocks the byte-cap), so this guard's block is authoritative for the
 * self-improve path.
 *
 * Claude Code PreToolUse protocol (v1), mirrors skill-validate-pretool:
 *   Input:  JSON on stdin — { session_id, tool_name, tool_input, ... }
 *   Output: exit 0 + empty stdout                       → allow.
 *           exit 0 + {"decision":"block","reason":...}  → block.
 *
 * Fail-OPEN on anything that is NOT a deliberate guard decision (stdin
 * parse error, no marker, non-skill write, missing state dir): a quality
 * loop's guard must never be the reason a legitimate, non-review write
 * fails. The only blocks are the explicit downgrade refusals.
 *
 * Bundled to a self-contained `.mjs` at build time (like
 * skill-validate-pretool / self-improve-stop) because it imports the
 * src/self-improve/* modules, none of which resolve from the raw .mjs
 * hooks dir inside the agent image.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { selfImproveEnabled } from "../self-improve/config.js";
import {
  readReviewContext,
  type ReviewContext,
} from "../self-improve/review-context.js";
import {
  decideApply,
  parseSkillTarget,
} from "../self-improve/apply-guard.js";
import { recordAutoApply } from "../self-improve/rate-limit.js";
import { enqueuePending } from "../self-improve/pending-queue.js";

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function allow(): never {
  process.exit(0);
}

function block(reason: string): never {
  const safe = String(reason)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .slice(0, 300);
  process.stdout.write(JSON.stringify({ decision: "block", reason: safe }));
  process.exit(0);
}

/** Agent state dir — set by start.sh; same fallback as self-improve-stop. */
function resolveStateDir(): string {
  return (
    process.env.TELEGRAM_STATE_DIR ??
    join(homedir(), ".claude", "channels", "telegram")
  );
}

function main(): void {
  // Opt-out kill switch (RFC: ships on by default, per-agent disable).
  if (!selfImproveEnabled()) allow();

  const raw = readStdin().trim();
  if (!raw) allow();

  let event: { tool_name?: unknown; tool_input?: unknown };
  try {
    event = JSON.parse(raw);
  } catch {
    allow(); // Claude protocol error — not ours to police.
  }

  const toolName = typeof event.tool_name === "string" ? event.tool_name : "";
  if (!EDIT_TOOLS.has(toolName)) allow();

  const input =
    event.tool_input && typeof event.tool_input === "object"
      ? (event.tool_input as Record<string, unknown>)
      : {};
  const filePath = typeof input.file_path === "string" ? input.file_path : "";
  if (!filePath) allow();

  // Only a skill-bundle write is in scope.
  if (!parseSkillTarget(filePath)) allow();

  const stateDir = resolveStateDir();

  // The marker is the seam: NO pending review → this is a normal turn, the
  // apply-guard stays out of the way entirely (advisory linter still runs).
  let ctx: ReviewContext | null = null;
  try {
    ctx = readReviewContext(stateDir);
  } catch {
    ctx = null;
  }
  if (!ctx) allow();

  // A review is pending — ENFORCE. Freshness floor = the review's start, so
  // a stale benchmark from a prior edit can't wave a new edit through.
  let freshAfterMs: number | undefined;
  const t = Date.parse(ctx.created_at);
  if (Number.isFinite(t)) freshAfterMs = t;

  let decision;
  try {
    decision = decideApply({
      toolName,
      input,
      filePath,
      stateDir,
      freshAfterMs,
    });
  } catch {
    // A guard failure must not silently let an unchecked edit land:
    // fail-CLOSED for the apply path. Downgrade to a proposal and block.
    safeDowngrade(stateDir, ctx, filePath, "apply-guard internal error");
    block(
      "self-improve apply-guard: internal error evaluating the edit — " +
        "downgraded to a pending proposal, write blocked (fail-closed).",
    );
  }

  if (decision.action === "allow") {
    // Record the auto-apply against the daily cap BEFORE the write lands —
    // the edit is about to be applied by Claude Code on our allow.
    try {
      recordAutoApply(stateDir);
    } catch {
      /* cap accounting best-effort; never block a verified T1 on it */
    }
    allow();
  }

  // Block + downgrade to the pending queue.
  let capNote = "";
  try {
    const q = enqueuePending(stateDir, {
      tier: decision.downgradeTier,
      lesson: decision.candidate.lesson,
      proposed_change: decision.candidate.proposedChange,
      tier_reason: decision.reason,
      skill_slug: decision.candidate.skillSlug,
      triggered_by: (ctx.signals ?? []).map((s) => s.kind),
      // Present only on the net-growth-cap downgrade; the one-tap card
      // renders the before/after byte counts when they're set.
      bytes_before: decision.bytesBefore,
      bytes_after: decision.bytesAfter,
    });
    if (!q.ok) {
      // Queue full — the proposal is dropped; surface it rather than lose
      // the lesson silently. The write stays blocked regardless.
      capNote = ` (pending queue full ${q.outstanding}/${q.cap} — proposal not recorded)`;
    }
  } catch {
    /* queue best-effort — still block the unchecked write */
  }
  block(`self-improve apply-guard: ${decision.reason}${capNote}`);
}

/** Best-effort downgrade used only on the fail-closed internal-error path. */
function safeDowngrade(
  stateDir: string,
  ctx: ReviewContext,
  filePath: string,
  reason: string,
): void {
  try {
    const target = parseSkillTarget(filePath);
    enqueuePending(stateDir, {
      tier: "T2",
      lesson: target
        ? `Bind the recurring lesson into skill "${target.slug}"`
        : "self-improve review edit (guard error)",
      proposed_change: filePath,
      tier_reason: reason,
      skill_slug: target?.slug,
      triggered_by: (ctx.signals ?? []).map((s) => s.kind),
    });
  } catch {
    /* nothing to do */
  }
}

main();
