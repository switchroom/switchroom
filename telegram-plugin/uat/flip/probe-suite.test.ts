/**
 * Unit suite for the Tier-2 probe-suite parser/loader. Runs under `bun test`
 * via the `uat/flip/` entry in telegram-plugin/scripts/bun-test-ci.sh. Pure —
 * parses JSON strings + loads the two SHIPPED suites from disk (no network).
 */

import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseProbeSuite, loadProbeSuite, compileProbePattern } from "./probe-suite.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const GOOD = JSON.stringify({
  agent: "kdogg",
  probes: [
    { id: "p1", directiveId: "d1", kind: "positive", prompt: "q?", passPattern: "no record", passFlags: "i" },
    { id: "p2", directiveId: "", kind: "liveness", prompt: "hi", passPattern: "[a-z]+" },
  ],
});

describe("parseProbeSuite — happy path", () => {
  it("parses agent + probes and defaults passFlags", () => {
    const s = parseProbeSuite(GOOD);
    expect(s.agent).toBe("kdogg");
    expect(s.probes).toHaveLength(2);
    expect(compileProbePattern(s.probes[0]).flags).toContain("i");
    // liveness probe: no explicit flags → compile still defaults to "i".
    expect(compileProbePattern(s.probes[1]).test("hello")).toBe(true);
  });
});

describe("parseProbeSuite — validation", () => {
  const bad = (doc: unknown, needle: string): void => {
    expect(() => parseProbeSuite(JSON.stringify(doc))).toThrow(needle);
  };

  it("rejects non-JSON", () => {
    expect(() => parseProbeSuite("{not json")).toThrow(/not valid JSON/);
  });
  it("rejects missing agent", () => bad({ probes: [] }, '"agent"'));
  it("rejects non-array probes", () => bad({ agent: "a", probes: {} }, '"probes"'));
  it("rejects a bad kind", () =>
    bad({ agent: "a", probes: [{ id: "x", directiveId: "d", kind: "wat", prompt: "p", passPattern: "y" }] }, "kind"));
  it("rejects an uncompilable regex", () =>
    bad(
      { agent: "a", probes: [{ id: "x", directiveId: "d", kind: "positive", prompt: "p", passPattern: "([" }] },
      "not a valid regex",
    ));
  it("rejects duplicate probe ids", () =>
    bad(
      {
        agent: "a",
        probes: [
          { id: "dup", directiveId: "d", kind: "positive", prompt: "p", passPattern: "y" },
          { id: "dup", directiveId: "d", kind: "negative", prompt: "p", passPattern: "y" },
        ],
      },
      "duplicate probe id",
    ));
  it("requires directiveId for a non-liveness probe", () =>
    bad(
      { agent: "a", probes: [{ id: "x", directiveId: "", kind: "positive", prompt: "p", passPattern: "y" }] },
      "directiveId",
    ));
  it("allows empty directiveId for a liveness probe", () => {
    const s = parseProbeSuite(
      JSON.stringify({ agent: "a", probes: [{ id: "x", directiveId: "", kind: "liveness", prompt: "p", passPattern: "y" }] }),
    );
    expect(s.probes[0].kind).toBe("liveness");
  });
});

describe("shipped suites load + validate", () => {
  it("kdogg.probes.json parses and links the no-confabulation directive", () => {
    const s = loadProbeSuite(path.join(HERE, "probes", "kdogg.probes.json"));
    expect(s.agent).toBe("kdogg");
    // 2 positive + 1 negative control, all linked to the one active directive.
    const kinds = s.probes.map((p) => p.kind).sort();
    expect(kinds).toEqual(["negative", "positive", "positive"]);
    for (const p of s.probes) {
      expect(p.directiveId).toBe("117fee25-bad7-4b15-9f4b-713ebf7da4a5");
      // every passPattern must compile
      expect(() => compileProbePattern(p)).not.toThrow();
    }
  });

  it("test-harness.probes.json is a single transport-only liveness probe", () => {
    const s = loadProbeSuite(path.join(HERE, "probes", "test-harness.probes.json"));
    expect(s.agent).toBe("test-harness");
    expect(s.probes).toHaveLength(1);
    expect(s.probes[0].kind).toBe("liveness");
    expect(s.probes[0].directiveId).toBe("");
  });
});
