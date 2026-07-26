import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

// @ts-expect-error — plain .mjs guard script, no types
import {
  countReviewRounds,
  evaluateReviewRounds,
  parseGitLogZ,
  REVIEW_ROUND_CAP,
  OVERRIDE_LABEL,
} from "../scripts/check-review-rounds.mjs";

/**
 * The deterministic review-round cap (Ken 2026-07-26).
 *
 * The protocol prose now says blockers/mediums block the merge, lows get
 * filed, and only a behavioural fix earns a re-review. These tests pin the
 * MECHANISM behind it: a PR that has taken more than two `review-fix:` rounds
 * fails the gate, and the only thing that clears it is a durable, PR-visible
 * operator label. Every assertion is on the outcome an engineer sees
 * (pass/fail + the message), not on a code path being reached.
 */

const REPO_ROOT = join(import.meta.dirname, "..");

const roundCommit = (n: number) => `review-fix: address review round ${n} findings`;

describe("check-review-rounds — counting", () => {
  it("counts only commits that answer a review round", () => {
    const commits = [
      "feat(review): add the round cap",
      roundCommit(1),
      "docs: unrelated tweak",
      "review-fix(profiles): tighten the fragment",
      "review-fixture: not a review round", // near-miss must NOT count
    ];
    expect(countReviewRounds(commits)).toBe(2);
  });

  it("counts a commit carrying a Review-Round trailer", () => {
    expect(
      countReviewRounds(["fix(gateway): drop the stale guard\n\nReview-Round: 2"]),
    ).toBe(1);
  });

  it("does not double-count a commit that has both the prefix and the trailer", () => {
    expect(countReviewRounds([`${roundCommit(1)}\n\nReview-Round: 1`])).toBe(1);
  });

  it("parses NUL-separated git log output into whole commit messages", () => {
    const stdout = `${roundCommit(1)}\n\nbody line\n\0feat: something else\n\0`;
    expect(parseGitLogZ(stdout)).toEqual([
      `${roundCommit(1)}\n\nbody line`,
      "feat: something else",
    ]);
  });
});

describe("check-review-rounds — the gate", () => {
  it("passes a PR with zero review rounds", () => {
    const r = evaluateReviewRounds({ commitMessages: ["feat: initial work"] });
    expect(r.ok).toBe(true);
    expect(r.rounds).toBe(0);
  });

  it("passes at the cap (two rounds is normal)", () => {
    const r = evaluateReviewRounds({
      commitMessages: ["feat: work", roundCommit(1), roundCommit(2)],
    });
    expect(r.ok).toBe(true);
    expect(r.rounds).toBe(REVIEW_ROUND_CAP);
  });

  it("FAILS the third round — the loop cannot happen silently", () => {
    const r = evaluateReviewRounds({
      commitMessages: [
        "feat: work",
        roundCommit(1),
        roundCommit(2),
        roundCommit(3),
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.rounds).toBe(3);
  });

  it("names the cap and the remedy in the failure message", () => {
    const r = evaluateReviewRounds({
      commitMessages: [roundCommit(1), roundCommit(2), roundCommit(3)],
    });
    expect(r.message).toContain(`the cap is ${REVIEW_ROUND_CAP}`);
    // The remedy the protocol wants: file the rest, merge.
    expect(r.message).toContain("file the remaining findings as follow-up issues and merge");
    expect(r.message).toContain(OVERRIDE_LABEL);
  });

  it("clears only on the durable operator label, and says it was overridden", () => {
    const commitMessages = [roundCommit(1), roundCommit(2), roundCommit(3)];
    expect(evaluateReviewRounds({ commitMessages, labels: ["bug"] }).ok).toBe(false);
    const overridden = evaluateReviewRounds({
      commitMessages,
      labels: ["bug", OVERRIDE_LABEL.toUpperCase()],
    });
    expect(overridden.ok).toBe(true);
    expect(overridden.overridden).toBe(true);
    expect(overridden.message).toContain("OVERRIDDEN");
  });

  it("an under-cap PR is never marked overridden even when the label is present", () => {
    const r = evaluateReviewRounds({
      commitMessages: [roundCommit(1)],
      labels: [OVERRIDE_LABEL],
    });
    expect(r.ok).toBe(true);
    expect(r.overridden).toBe(false);
  });
});

describe("ci-review-rounds workflow wiring", () => {
  const wf = parseYaml(
    readFileSync(join(REPO_ROOT, ".github/workflows/ci-review-rounds.yml"), "utf-8"),
  ) as Record<string, any>;

  it("runs the gate on PRs, including when a label is added or removed", () => {
    // `on:` parses as the YAML boolean true — quote-free `on` key.
    const on = wf.on ?? wf[true as unknown as string];
    const types: string[] = on.pull_request.types;
    expect(types).toContain("synchronize");
    // Without these, adding the override label would need an empty push.
    expect(types).toContain("labeled");
    expect(types).toContain("unlabeled");
  });

  it("invokes the guard script rather than reimplementing the count inline", () => {
    const run = wf.jobs["review-rounds-run"].steps
      .map((s: Record<string, unknown>) => String(s.run ?? ""))
      .join("\n");
    expect(run).toContain("node scripts/check-review-rounds.mjs");
  });

  it("never hoists `git log -z` into a shell variable (NUL bytes are dropped there)", () => {
    // Caught in this PR's own adversarial review: `VAR="$(git log -z …)"`
    // silently strips the NUL separators, so every commit collapses into one
    // message and the cap can never trip. The script runs git itself.
    const run = wf.jobs["review-rounds-run"].steps
      .map((s: Record<string, unknown>) => String(s.run ?? ""))
      .join("\n");
    expect(run).not.toMatch(/\$\(\s*git log/);
  });

  it("passes the PR range to the script via env, not argv interpolation", () => {
    const step = wf.jobs["review-rounds-run"].steps.find(
      (s: Record<string, unknown>) => String(s.run ?? "").includes("check-review-rounds"),
    );
    expect(Object.keys(step.env)).toEqual(
      expect.arrayContaining(["BASE_SHA", "HEAD_SHA", "REVIEW_ROUNDS_LABELS"]),
    );
    // No `${{ }}` inside the run body — same rule the release workflows carry.
    expect(String(step.run)).not.toContain("${{");
  });

  it("exposes an always-reporting `review-rounds` sentinel that fails on a real failure", () => {
    const sentinel = wf.jobs["review-rounds"];
    // `if: always()` so the context is ruleset-required-safe.
    expect(String(sentinel.if)).toContain("always()");
    const verdict = sentinel.steps.map((s: Record<string, unknown>) => String(s.run ?? "")).join("\n");
    expect(verdict).toContain("failure");
    expect(verdict).toContain("exit 1");
  });
});
