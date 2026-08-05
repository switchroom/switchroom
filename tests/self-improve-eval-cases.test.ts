import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseEvalCase,
  caseFingerprint,
  readEvalsDoc,
  appendEvalCase,
  appendHeldOutCase,
  heldOutPath,
  evalsSha256,
  recordEvalBaseline,
  verifyEvalIntegrity,
  listSkillsWithEvals,
  sweepEvalIntegrity,
  evalsBaselineTrusted,
} from "../src/self-improve/eval-cases.js";
import { evalsJsonPath } from "../src/self-improve/eval-gate.js";

let agentDir: string;
let stateDir: string;
let skillsRoot: string;

function skillDir(slug: string): string {
  return join(skillsRoot, slug);
}
function makeSkill(slug: string): string {
  const d = skillDir(slug);
  mkdirSync(join(d, "evals"), { recursive: true });
  return d;
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "eval-cases-agent-"));
  stateDir = mkdtempSync(join(tmpdir(), "eval-cases-state-"));
  skillsRoot = join(agentDir, ".claude", "skills");
  mkdirSync(skillsRoot, { recursive: true });
});
afterEach(() => {
  for (const d of [agentDir, stateDir]) {
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

describe("parseEvalCase", () => {
  it("rejects a non-object input as not-a-JSON-object", () => {
    for (const bad of [undefined, null, [], "hi", 7]) {
      const r = parseEvalCase(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/object/i);
    }
  });
  it("rejects a missing / empty / whitespace prompt", () => {
    for (const bad of [{}, { prompt: "" }, { prompt: "   " }]) {
      const r = parseEvalCase(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/prompt/i);
    }
  });
  it("accepts a well-formed case and preserves optional fields", () => {
    const r = parseEvalCase({ prompt: "hi", expectations: ["x"], source: "correction" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.case.prompt).toBe("hi");
      expect(r.case.expectations).toEqual(["x"]);
    }
  });
});

describe("caseFingerprint", () => {
  it("is stable across case + whitespace normalization", () => {
    expect(caseFingerprint("Hello  World")).toBe(caseFingerprint("hello world"));
  });
  it("differs for materially different prompts", () => {
    expect(caseFingerprint("tone should be terse")).not.toBe(
      caseFingerprint("tone should be verbose"),
    );
  });
});

describe("appendEvalCase (add-only, dedup, atomic)", () => {
  it("appends the first case and creates a well-formed evals.json", () => {
    const d = makeSkill("s1");
    const r = appendEvalCase(d, "s1", { prompt: "case one" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.total).toBe(1);
      expect(r.index).toBe(0);
    }
    const doc = readEvalsDoc(d);
    expect(doc?.skill_name).toBe("s1");
    expect(doc?.evals.length).toBe(1);
    expect(doc?.evals[0]?.prompt).toBe("case one");
  });

  it("dedups a case with the same normalized prompt", () => {
    const d = makeSkill("s1");
    expect(appendEvalCase(d, "s1", { prompt: "Be terse" }).ok).toBe(true);
    const dup = appendEvalCase(d, "s1", { prompt: "be   terse" });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.duplicate).toBe(true);
    // Still exactly one case on disk — the dup was not appended.
    expect(readEvalsDoc(d)?.evals.length).toBe(1);
  });

  it("rejects an empty-prompt case without writing", () => {
    const d = makeSkill("s1");
    const r = appendEvalCase(d, "s1", { prompt: "" });
    expect(r.ok).toBe(false);
    expect(existsSync(evalsJsonPath(d))).toBe(false);
  });
});

describe("held-out sink", () => {
  it("appends jsonl lines to the state-dir sink (never a skill dir)", () => {
    appendHeldOutCase(stateDir, "s1", { prompt: "held one" });
    appendHeldOutCase(stateDir, "s1", { prompt: "held two" });
    const lines = readFileSync(heldOutPath(stateDir), "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]!);
    expect(first.slug).toBe("s1");
    expect(first.case.prompt).toBe("held one");
    expect(typeof first.at).toBe("string");
  });
});

describe("integrity manifest + baseline", () => {
  it("evalsSha256 is null with no evals, non-null once present", () => {
    const d = makeSkill("s1");
    expect(evalsSha256(d)).toBeNull();
    appendEvalCase(d, "s1", { prompt: "case one" });
    expect(evalsSha256(d)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifyEvalIntegrity: no-evals → missing → ok → drift lifecycle", () => {
    const d = makeSkill("s1");
    // No evals.json yet.
    expect(verifyEvalIntegrity(stateDir, "s1", d)).toBe("no-evals");
    appendEvalCase(d, "s1", { prompt: "case one" });
    // Evals exist but never recorded a baseline.
    expect(verifyEvalIntegrity(stateDir, "s1", d)).toBe("missing");
    recordEvalBaseline(stateDir, "s1", d);
    expect(verifyEvalIntegrity(stateDir, "s1", d)).toBe("ok");
    // Out-of-band edit → drift.
    writeFileSync(
      evalsJsonPath(d),
      JSON.stringify({ skill_name: "s1", evals: [{ name: "t", prompt: "tampered" }] }),
    );
    expect(verifyEvalIntegrity(stateDir, "s1", d)).toBe("drift");
  });
});

describe("sweepEvalIntegrity (Stop-hook self-heal)", () => {
  it("records on first sight, then heals a drifted eval set back to baseline", () => {
    const d = makeSkill("s1");
    appendEvalCase(d, "s1", { prompt: "case one" });
    expect(listSkillsWithEvals(skillsRoot).map((s) => s.slug)).toEqual(["s1"]);

    // First sweep records a baseline — nothing to heal yet.
    const first = sweepEvalIntegrity(skillsRoot, stateDir);
    expect(first.recorded).toContain("s1");
    expect(first.healed).toEqual([]);
    expect(verifyEvalIntegrity(stateDir, "s1", d)).toBe("ok");

    // Tamper out-of-band, then sweep → reverted to the recorded baseline.
    writeFileSync(
      evalsJsonPath(d),
      JSON.stringify({ skill_name: "s1", evals: [{ name: "t", prompt: "tampered" }] }),
    );
    expect(verifyEvalIntegrity(stateDir, "s1", d)).toBe("drift");
    const second = sweepEvalIntegrity(skillsRoot, stateDir);
    expect(second.healed).toContain("s1");
    const reverted = readEvalsDoc(d);
    expect(reverted?.evals[0]?.prompt).toBe("case one");
    expect(verifyEvalIntegrity(stateDir, "s1", d)).toBe("ok");
  });

  // MAJOR 2 (PR #4403 review): a first-sight evals.json appeared OUT OF BAND
  // (never through the sanctioned applier, which records its own baseline). The
  // sweep must NOT silently trust it — it runs the SAME fail-closed PII/secret
  // scan the sanctioned path runs, and QUARANTINES un-clean bytes rather than
  // adopting them as a baseline. This is the deterministic guarantee that pairs
  // with the Bash write-block: even if the command-string heuristic misses an
  // exotic writer, pre-seeded poisoned bytes never become a trusted baseline.
  it("quarantines a poisoned first-sight evals.json instead of trusting it", () => {
    const clean = makeSkill("clean");
    writeFileSync(
      evalsJsonPath(clean),
      JSON.stringify({ skill_name: "clean", evals: [{ prompt: "handle empty input" }] }),
    );
    // Assembled at runtime so no contiguous secret/email literal sits in the
    // source (which would trip scripts/check-no-pii-secrets.mjs); scanForPII
    // still sees the joined value.
    const fakeKey =
      ["sk", "ant", "api03"].join("-") +
      "-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUvWxYz01-AAAAAA";
    const secret = makeSkill("secret");
    writeFileSync(
      evalsJsonPath(secret),
      JSON.stringify({
        skill_name: "secret",
        evals: [{ prompt: "use the key", expected_output: fakeKey }],
      }),
    );
    const fakeEmail = ["alice.example", "example.com"].join("@");
    const pii = makeSkill("pii");
    writeFileSync(
      evalsJsonPath(pii),
      JSON.stringify({
        skill_name: "pii",
        evals: [{ prompt: `email me at ${fakeEmail} please` }],
      }),
    );

    // Helper directly: clean trusted, poisoned not.
    expect(evalsBaselineTrusted(clean)).toBe(true);
    expect(evalsBaselineTrusted(secret)).toBe(false);
    expect(evalsBaselineTrusted(pii)).toBe(false);

    const rep = sweepEvalIntegrity(skillsRoot, stateDir);
    expect(rep.recorded).toEqual(["clean"]);
    expect(rep.quarantined.sort()).toEqual(["pii", "secret"]);

    // The clean one is now a trusted baseline; the poisoned ones remain
    // "missing" — never adopted, so drift-detection can't be defeated by
    // pre-seeding them.
    expect(verifyEvalIntegrity(stateDir, "clean", clean)).toBe("ok");
    expect(verifyEvalIntegrity(stateDir, "secret", secret)).toBe("missing");
    expect(verifyEvalIntegrity(stateDir, "pii", pii)).toBe("missing");
  });

  it("evalsBaselineTrusted is fail-closed on an unreadable evals.json", () => {
    const d = makeSkill("gone");
    // No evals.json written → unreadable → not trusted.
    expect(evalsBaselineTrusted(d)).toBe(false);
  });
});
