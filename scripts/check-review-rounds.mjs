#!/usr/bin/env node
/**
 * check-review-rounds — the deterministic cap on adversarial review rounds.
 *
 * Why this exists (Ken 2026-07-26): the old protocol said "fix ALL findings
 * including lows, then re-review the fix". That is a loop generator by
 * construction — an adversarial reviewer always surfaces lows (that is its
 * job), fixing lows produces a new diff, and a new diff earned another
 * re-review. Observed: PRs going FOUR review rounds, the last round's only
 * finding being an inaccurate doc comment. The severity gate in the protocol
 * prose fixes the incentive; this script is the mechanism, because the repo's
 * own rule is "deterministic mechanisms over model-dependent behavior" and
 * prose that says "don't loop" is exactly model-dependent behavior.
 *
 * The artifact it counts: every commit that answers an adversarial review
 * round is subject-prefixed `review-fix:` / `review-fix(scope):` (or carries a
 * `Review-Round:` trailer). That prefix is mandated by the protocol in
 * CLAUDE.md, `profiles/_shared/dev-protocol.md.hbs`, and the bundled
 * `dev-protocol` skill. Rounds are counted from git history on the PR branch —
 * no API call, no reviewer cooperation, no state file to drift.
 *
 * The cap: 2 rounds. A third fix round fails the `review-rounds` check, and
 * the only way past it is the durable, PR-visible `review-cap-override` label
 * (an operator action that leaves a trace), NOT a re-run and not a judgement
 * call by the agent that wrote the commits.
 *
 * Honest limit: the input is a commit-message convention written by the agent
 * under review, so an unprefixed fix commit undercounts. That is a protocol
 * violation, not a supported bypass — the point of the gate is that once a
 * round IS recorded, no amount of agent self-persuasion clears it.
 */

import { execFileSync } from "node:child_process";

export const REVIEW_ROUND_CAP = 2;
export const OVERRIDE_LABEL = "review-cap-override";

/**
 * A commit answers a review round when its subject is `review-fix`-prefixed
 * (Conventional-Commits shaped, optional scope and `!`) or its body carries a
 * `Review-Round:` trailer.
 */
const SUBJECT_RE = /^review-fix(\([^)]*\))?!?:/i;
const TRAILER_RE = /^Review-Round:/im;

/** Count the review-fix rounds recorded in a list of commit messages. */
export function countReviewRounds(commitMessages) {
  return commitMessages.filter((message) => {
    const text = String(message ?? "");
    const subject = text.split("\n", 1)[0].trim();
    return SUBJECT_RE.test(subject) || TRAILER_RE.test(text);
  }).length;
}

/**
 * Evaluate the cap. Pure: no git, no network — so the tests assert the
 * outcome (pass/fail + the message the developer sees), not a code path.
 */
export function evaluateReviewRounds({
  commitMessages = [],
  labels = [],
  cap = REVIEW_ROUND_CAP,
} = {}) {
  const rounds = countReviewRounds(commitMessages);
  const overridden = labels.some(
    (l) => String(l ?? "").trim().toLowerCase() === OVERRIDE_LABEL,
  );

  if (rounds <= cap) {
    return {
      ok: true,
      rounds,
      cap,
      overridden: false,
      message: `check-review-rounds: OK — ${rounds}/${cap} adversarial review rounds recorded.`,
    };
  }

  if (overridden) {
    return {
      ok: true,
      rounds,
      cap,
      overridden: true,
      message:
        `check-review-rounds: OVERRIDDEN — ${rounds} rounds exceeds the cap of ${cap}, ` +
        `allowed by the \`${OVERRIDE_LABEL}\` label on this PR.`,
    };
  }

  return {
    ok: false,
    rounds,
    cap,
    overridden: false,
    message:
      `check-review-rounds: FAIL — ${rounds} adversarial review rounds on this PR; the cap is ${cap}.\n` +
      `Review is bounded on purpose: blockers and mediums block the merge, lows do not.\n` +
      `Do this instead of a third round: file the remaining findings as follow-up issues and merge.\n` +
      `If a third round is genuinely warranted, an operator adds the \`${OVERRIDE_LABEL}\` label to this PR.`,
  };
}

/** Split `git log -z --format=%B` output into individual commit messages. */
export function parseGitLogZ(stdout) {
  return String(stdout ?? "")
    .split("\0")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
}

/**
 * Read the PR's commit messages straight from git.
 *
 * This runs INSIDE the script on purpose. `git log -z` separates commits
 * with NUL, and a shell `VAR="$(git log -z …)"` silently drops NUL bytes —
 * every commit would collapse into one message and the gate would score any
 * PR as a single round, i.e. it would never fire. Capturing the buffer in
 * Node keeps the separators intact.
 */
export function readCommitMessages(baseRef, headRef, exec = execFileSync) {
  const out = exec("git", ["log", "-z", "--format=%B", `${baseRef}..${headRef}`], {
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return parseGitLogZ(out);
}

// ─── CLI ────────────────────────────────────────────────────────────────
// Inputs come from the workflow env:
//   BASE_SHA / HEAD_SHA   — the PR range (git is run here, see above)
//   REVIEW_ROUNDS_LABELS  — newline- or comma-separated PR label names
if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.env.BASE_SHA;
  const head = process.env.HEAD_SHA ?? "HEAD";
  if (!base) {
    console.error("check-review-rounds: BASE_SHA is required (the PR base sha)");
    process.exit(2);
  }
  const result = evaluateReviewRounds({
    commitMessages: readCommitMessages(base, head),
    labels: (process.env.REVIEW_ROUNDS_LABELS ?? "")
      .split(/[\n,]/)
      .map((l) => l.trim())
      .filter(Boolean),
  });
  console.log(result.message);
  process.exit(result.ok ? 0 : 1);
}
