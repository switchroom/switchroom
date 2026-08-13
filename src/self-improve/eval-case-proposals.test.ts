/**
 * The eval-case proposal store's on-disk BOUND.
 *
 * `eval-case-proposals.jsonl` is append-only and, since the gateway consults
 * it on every proposal to honour dismissals, it is read per proposal — so it
 * has to be bounded. The hazard the bound must not create: dropping a
 * still-live rejection would silently un-suppress a card the operator already
 * dismissed, so the assertions below check the retained rejection AND the
 * suppression answer that reads it.
 *
 * Run with: npx vitest run src/self-improve/eval-case-proposals.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EVAL_CASE_PROPOSALS_FILE,
  MAX_EVAL_CASE_PROPOSALS,
  enqueueEvalCaseProposal,
  readEvalCaseProposals,
  setEvalCaseProposalStatus,
} from "./eval-case-proposals.js";
import { REJECTION_TTL_MS } from "./skill-proposals.js";
import { isEvalCaseProposalSuppressed } from "../../telegram-plugin/gateway/self-improve-proposal-wiring.js";

const SLUG = "deploy-checklist";
const DIR = "/skills/deploy-checklist";

function fillerLine(dir: string, i: number, createdAt: string): void {
  appendFileSync(
    join(dir, EVAL_CASE_PROPOSALS_FILE),
    JSON.stringify({
      id: `filler-${i}`,
      created_at: createdAt,
      status: "pending",
      skill_slug: SLUG,
      skill_dir: DIR,
      case: { prompt: `filler ${i}` },
      fingerprint: `f${i}`,
      held_out: false,
    }) + "\n",
  );
}

describe("eval-case proposal store — on-disk bound", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eval-case-bound-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("truncates a store grown past the bound but keeps live rejections", () => {
    const path = join(dir, EVAL_CASE_PROPOSALS_FILE);
    const now = new Date().toISOString();
    // The OLDEST line in the file — a naive drop-oldest trim would lose it.
    appendFileSync(
      path,
      JSON.stringify({
        id: "the-rejection",
        created_at: now,
        status: "rejected",
        skill_slug: SLUG,
        skill_dir: DIR,
        case: { prompt: "the dismissed correction" },
        fingerprint: "aaaa1111",
        held_out: false,
      }) + "\n",
    );
    for (let i = 0; i < MAX_EVAL_CASE_PROPOSALS * 3; i++) fillerLine(dir, i, now);

    // The next write compacts the over-grown file in place.
    const fresh = enqueueEvalCaseProposal(dir, {
      skill_slug: SLUG,
      skill_dir: DIR,
      case: { prompt: "brand new correction" },
      fingerprint: "newnew11",
      held_out: false,
    });
    const all = readEvalCaseProposals(dir);
    const lines = readFileSync(path, "utf-8")
      .split("\n")
      .filter((l) => l.trim());

    // Observable 1: the file is bounded.
    expect(lines.length).toBeLessThanOrEqual(MAX_EVAL_CASE_PROPOSALS * 2);
    expect(lines.length).toBeLessThan(MAX_EVAL_CASE_PROPOSALS * 3);
    // Observable 2: the newest records survived.
    expect(all.some((r) => r.id === fresh.id)).toBe(true);
    expect(
      all.some((r) => r.id === `filler-${MAX_EVAL_CASE_PROPOSALS * 3 - 1}`),
    ).toBe(true);
    // Observable 3: the live rejection survived truncation...
    expect(all.some((r) => r.id === "the-rejection")).toBe(true);
    // ...and still answers suppression correctly after compaction.
    expect(
      isEvalCaseProposalSuppressed(dir, {
        skillSlug: SLUG,
        fingerprint: "aaaa1111",
      }),
    ).toBe(true);
    expect(
      isEvalCaseProposalSuppressed(dir, {
        skillSlug: SLUG,
        fingerprint: "zzzz9999",
      }),
    ).toBe(false);
  });

  it("drops rejections that are already past the suppression TTL", () => {
    const path = join(dir, EVAL_CASE_PROPOSALS_FILE);
    const t0 = Date.UTC(2020, 0, 1); // long past REJECTION_TTL_MS
    appendFileSync(
      path,
      JSON.stringify({
        id: "ancient-rejection",
        created_at: new Date(t0).toISOString(),
        status: "rejected",
        skill_slug: SLUG,
        skill_dir: DIR,
        case: { prompt: "ancient" },
        fingerprint: "old00001",
        held_out: false,
      }) + "\n",
    );
    const now = new Date().toISOString();
    for (let i = 0; i < MAX_EVAL_CASE_PROPOSALS * 3; i++) fillerLine(dir, i, now);

    enqueueEvalCaseProposal(dir, {
      skill_slug: SLUG,
      skill_dir: DIR,
      case: { prompt: "trigger" },
      fingerprint: "trig0001",
      held_out: false,
    });

    // Dropping it is lossless: past the TTL it suppressed nothing anyway.
    expect(Date.now() - t0).toBeGreaterThan(REJECTION_TTL_MS);
    expect(
      readEvalCaseProposals(dir).some((r) => r.id === "ancient-rejection"),
    ).toBe(false);
    expect(
      isEvalCaseProposalSuppressed(dir, {
        skillSlug: SLUG,
        fingerprint: "old00001",
      }),
    ).toBe(false);
  });

  it("leaves a store under the bound append-only (no surprise rewrite)", () => {
    const path = join(dir, EVAL_CASE_PROPOSALS_FILE);
    for (let i = 0; i < 5; i++) {
      const p = enqueueEvalCaseProposal(dir, {
        skill_slug: SLUG,
        skill_dir: DIR,
        case: { prompt: `case ${i}` },
        fingerprint: `f${i}`,
        held_out: false,
      });
      setEvalCaseProposalStatus(dir, p.id, "rejected");
    }
    const lines = readFileSync(path, "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    // 5 enqueues + 5 transitions, every line still on disk.
    expect(lines).toHaveLength(10);
    expect(readEvalCaseProposals(dir)).toHaveLength(5);
  });
});
