/**
 * Failure-synthesis cron (PR5, RFC §"failure synthesis").
 *
 * This slice is prompt + docs, not new gate/router code — the failure-
 * synthesis NEW-skill proposal deliberately RIDES the existing
 * `synthesized-personal-skill` T2 carve-out (`tier-router.ts`) and the
 * existing `origin: "failure-synthesis"` proposal field (`skill-proposals.ts`,
 * landed in PR2). These tests therefore guard two contracts:
 *
 *   1. Prompt-lint — `reference/prompts/failure-synthesis-cron.md` exists,
 *      routes eval cases through the propose-only `add-eval-case` path (never
 *      a direct `evals.json` write), and carries the PII/secret clause.
 *   2. Store + routing (I6 end-to-end) — a NEW-skill proposal stamped
 *      `origin: "failure-synthesis"` round-trips through the store AND its
 *      corresponding change candidate routes to T2 (one-tap) through
 *      `classifyTier`, while a plain new skill with no carve-out stays T3.
 *      This is the whole point of create/update parity: a failure with no
 *      home skill still binds, at one-tap friction, with the hard floors
 *      intact.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyTier } from "./tier-router.js";
import type { ChangeCandidate } from "./types.js";
import {
  enqueueProposal,
  getProposal,
  type SkillProposal,
} from "./skill-proposals.js";

const PROMPT_PATH = fileURLToPath(
  new URL("../../reference/prompts/failure-synthesis-cron.md", import.meta.url),
);

function readPrompt(): string {
  return readFileSync(PROMPT_PATH, "utf-8");
}

/**
 * Map a persisted proposal to the change candidate the tier-router sees.
 * A NEW (is_new) failure-synthesis proposal ALWAYS carries the
 * `synthesized-personal-skill` kind so it rides the T2 carve-out — that
 * mapping is the "wiring" this test guards end-to-end.
 */
function candidateFor(p: SkillProposal): ChangeCandidate {
  return {
    lesson: p.lesson,
    proposedChange: `add personal skill "${p.skill_slug}" from an observed failure`,
    createsNewSkill: p.is_new,
    ...(p.is_new ? { proposalKind: "synthesized-personal-skill" as const } : {}),
  };
}

describe("failure-synthesis cron — prompt-lint", () => {
  it("the prompt file exists and is non-trivial", () => {
    const md = readPrompt();
    expect(md.length).toBeGreaterThan(500);
    expect(md).toMatch(/failure-synthesis/i);
  });

  it("routes eval cases through add-eval-case, NOT a direct evals.json write", () => {
    const md = readPrompt();
    // The sanctioned propose-only path is present …
    expect(md).toContain("switchroom self-improve add-eval-case");
    // … and the prompt explicitly forbids a direct evals.json write.
    expect(md).toMatch(/never\b[^\n]*evals\.json|evals\.json[^\n]*yourself/i);
    // It must never instruct self-writing the skill either (on-leash).
    expect(md).toMatch(/do NOT (?:create|write)|never self-appl/i);
  });

  it("carries the PII/secret clause mirrored from skill-synthesis-cron", () => {
    const md = readPrompt();
    expect(md).toMatch(/NEVER copy personal data, PII, or secrets/i);
    expect(md).toContain("email addresses, phone numbers, names");
    expect(md).toContain("vault:service/key");
  });

  it("proposes a failure fix as a skill (edit or new), never directive-first", () => {
    const md = readPrompt();
    expect(md).toContain("switchroom self-improve propose-skill");
    expect(md).toMatch(/NEVER directive-first|not[^\n]*directive/i);
  });
});

describe("failure-synthesis cron — store + routing (I6 end-to-end)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "failure-synthesis-"));
  });

  const newSkillInput = {
    skill_slug: "handle-rate-limits",
    is_new: true,
    lesson: "Back off and retry on a 429 instead of hammering the API",
    draft: {
      "SKILL.md":
        "---\nname: handle-rate-limits\ndescription: rate-limit handling\n---\n\n" +
        "1. detect 429\n2. read Retry-After\n3. exponential backoff\n",
    },
    evidence: "failed across 3 sessions",
    origin: "failure-synthesis" as const,
  };

  it("round-trips a failure-synthesis-origin NEW-skill proposal through the store", () => {
    const p = enqueueProposal(dir, newSkillInput);
    const fetched = getProposal(dir, p.id);
    expect(fetched?.origin).toBe("failure-synthesis");
    expect(fetched?.is_new).toBe(true);
    expect(fetched?.skill_slug).toBe("handle-rate-limits");
  });

  it("routes the failure-synthesis NEW-skill proposal to T2 (one-tap)", () => {
    const p = enqueueProposal(dir, newSkillInput);
    const fetched = getProposal(dir, p.id)!;
    const decision = classifyTier(candidateFor(fetched));
    expect(decision.tier).toBe("T2");
    expect(decision.reason).toMatch(/one-tap/);
  });

  it("does NOT lower a plain new skill (no carve-out kind) below T3", () => {
    // Proves it is the `synthesized-personal-skill` carve-out that lowers the
    // tier, NOT the `origin` field — origin is provenance only and must not
    // touch routing. A new skill lacking the carve-out kind stays T3.
    const plain: ChangeCandidate = {
      lesson: newSkillInput.lesson,
      proposedChange: "add a new skill from a failure",
      createsNewSkill: true,
    };
    expect(classifyTier(plain).tier).toBe("T3");
  });

  it("a failure-synthesis EDIT proposal is a same-skill edit candidate, not a new-skill T3", () => {
    const editProposal = enqueueProposal(dir, {
      ...newSkillInput,
      is_new: false,
    });
    const fetched = getProposal(dir, editProposal.id)!;
    const cand = candidateFor(fetched);
    expect(cand.createsNewSkill).toBe(false);
    // An edit candidate never rides the createsNewSkill T3 leg. With no owned-
    // skill target asserted it surfaces as a T2 one-tap suggestion (never T3).
    expect(classifyTier(cand).tier).toBe("T2");
  });
});
