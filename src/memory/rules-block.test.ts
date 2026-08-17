import { describe, it, expect } from "vitest";
import {
  RULES_BLOCK_BEGIN,
  RULES_BLOCK_END,
  INDEX_BLOCK_BEGIN,
  INDEX_BLOCK_END,
  RULES_BLOCK_BUDGET_BYTES,
  renderRulesBlock,
  parseRulesBlock,
  renderIndexBlock,
  parseIndexBlock,
  upsertMarkerBlock,
  stripMarkerBlock,
  computeSentinel,
  canonicalizeRules,
  renderedByteLen,
  checkContradiction,
  type Rule,
} from "./rules-block.js";

const GOLDEN_RULES: Rule[] = [
  {
    id: "R-01",
    text: "Never delete a rule without an explicit retire.",
    source: "telegram",
    created_at: "2026-08-17T00:00:00.000Z",
  },
  {
    id: "R-02",
    text: "Always confirm destructive git ops.",
    source: "telegram",
    created_at: "2026-08-17T00:05:00.000Z",
  },
];

// Pinned so implementer-B-class fixtures (doctor/hook tamper + divergence
// tests) never drift when this file's rendering changes — red-team M1
// ordering fix (§F): "pin the byte-exact canonical serialization + a
// golden vector in the shared first step."
const GOLDEN_SENTINEL_HASH =
  "d75143c411152b31424734f75a66c89681c3577979aaae30d655cd97ffb05b7f";
const GOLDEN_BLOCK =
  "<!-- switchroom:rules:begin -->\n" +
  "Standing rules — sanctioned via the `memory rule` tool. Do not hand-edit;\n" +
  "edits made outside the tool break the tamper sentinel below.\n" +
  "\n" +
  "- **R-01** (source: telegram, added 2026-08-17T00:00:00.000Z): Never delete a rule without an explicit retire.\n" +
  "- **R-02** (source: telegram, added 2026-08-17T00:05:00.000Z): Always confirm destructive git ops.\n" +
  "\n" +
  `<!-- switchroom:rules:sentinel sha256=${GOLDEN_SENTINEL_HASH} rules=2 -->\n` +
  "<!-- switchroom:rules:end -->";

describe("rules-block golden vector", () => {
  it("renderRulesBlock produces the exact pinned bytes", () => {
    expect(renderRulesBlock(GOLDEN_RULES)).toBe(GOLDEN_BLOCK);
  });

  it("computeSentinel produces the exact pinned hash + count", () => {
    expect(computeSentinel(GOLDEN_RULES)).toEqual({
      hash: GOLDEN_SENTINEL_HASH,
      count: 2,
    });
  });

  it("canonicalizeRules is stable key order regardless of input order", () => {
    const reversed = [...GOLDEN_RULES].reverse();
    expect(canonicalizeRules(reversed)).toBe(canonicalizeRules(GOLDEN_RULES));
    expect(computeSentinel(reversed)).toEqual(computeSentinel(GOLDEN_RULES));
  });
});

describe("render/parse round-trip", () => {
  it("parseRulesBlock recovers the exact rule fields from a rendered block", () => {
    const rendered = renderRulesBlock(GOLDEN_RULES);
    const parsed = parseRulesBlock(rendered);
    expect(parsed).not.toBeNull();
    expect(parsed!.rules).toEqual(GOLDEN_RULES);
    expect(parsed!.sentinel).toEqual({ hash: GOLDEN_SENTINEL_HASH, count: 2 });
  });

  it("parseRulesBlock returns null when markers are absent (dark no-op case)", () => {
    expect(parseRulesBlock("# --- Yours ---\n\nsome free text\n")).toBeNull();
  });

  it("empty rule set renders and parses back to zero rules", () => {
    const rendered = renderRulesBlock([]);
    const parsed = parseRulesBlock(rendered);
    expect(parsed!.rules).toEqual([]);
    expect(parsed!.sentinel!.count).toBe(0);
  });

  it("index block round-trips model names, sorted", () => {
    const rendered = renderIndexBlock(["orientation", "training-plan-state"]);
    const parsed = parseIndexBlock(rendered);
    expect(parsed).toEqual({ models: ["orientation", "training-plan-state"] });
  });

  it("index block parse returns null when markers absent", () => {
    expect(parseIndexBlock("no markers here")).toBeNull();
  });
});

describe("sentinel stability under incidental whitespace", () => {
  it("hash is unaffected by surrounding-file reflow (hashes the canonical rule set, not raw bytes)", () => {
    const block = renderRulesBlock(GOLDEN_RULES);
    const reflowed = `some preamble\n\n\n${block}\n\n\ntrailing junk\n`;
    const parsedOriginal = parseRulesBlock(block)!;
    const parsedReflowed = parseRulesBlock(reflowed)!;
    expect(computeSentinel(parsedReflowed.rules)).toEqual(
      computeSentinel(parsedOriginal.rules),
    );
  });
});

describe("upsertMarkerBlock / stripMarkerBlock", () => {
  it("replaces an existing block byte-exactly, leaving surrounding text untouched", () => {
    const before = "above text\n\n<!-- switchroom:rules:begin -->\nOLD\n<!-- switchroom:rules:end -->\n\nbelow text";
    const after = upsertMarkerBlock(
      before,
      RULES_BLOCK_BEGIN,
      RULES_BLOCK_END,
      renderRulesBlock(GOLDEN_RULES),
    );
    expect(after).toBe(
      `above text\n\n${renderRulesBlock(GOLDEN_RULES)}\n\nbelow text`,
    );
  });

  it("appends the block when markers are absent (first-write case)", () => {
    const before = "some yours text";
    const after = upsertMarkerBlock(
      before,
      RULES_BLOCK_BEGIN,
      RULES_BLOCK_END,
      renderRulesBlock(GOLDEN_RULES),
    );
    expect(after).toBe(`some yours text\n\n${renderRulesBlock(GOLDEN_RULES)}\n`);
  });

  it("stripMarkerBlock removes the block and collapses the blank-line seam", () => {
    const withBlock = `above\n\n${renderRulesBlock(GOLDEN_RULES)}\n\nbelow`;
    const stripped = stripMarkerBlock(withBlock, RULES_BLOCK_BEGIN, RULES_BLOCK_END);
    expect(stripped).toBe("above\n\nbelow");
    expect(stripped).not.toContain(RULES_BLOCK_BEGIN);
  });

  it("stripMarkerBlock is a no-op when markers are absent", () => {
    expect(stripMarkerBlock("plain text", RULES_BLOCK_BEGIN, RULES_BLOCK_END)).toBe(
      "plain text",
    );
  });
});

describe("byte budget", () => {
  it("renderedByteLen sums both blocks' UTF-8 byte length", () => {
    const rulesBlock = renderRulesBlock(GOLDEN_RULES);
    const indexBlock = renderIndexBlock(["orientation"]);
    expect(renderedByteLen(rulesBlock, indexBlock)).toBe(
      Buffer.byteLength(rulesBlock, "utf8") + Buffer.byteLength(indexBlock, "utf8"),
    );
  });

  it("RULES_BLOCK_BUDGET_BYTES is the documented 6KB cap", () => {
    expect(RULES_BLOCK_BUDGET_BYTES).toBe(6144);
  });
});

describe("contradiction detection (structural — OQ1 scoping)", () => {
  it("flags an exact normalized duplicate", () => {
    const result = checkContradiction(
      "  Always   confirm destructive git ops.  ",
      GOLDEN_RULES,
    );
    expect(result.duplicateOf).toBe("R-02");
  });

  it("does not flag a merely-similar (non-exact) rule", () => {
    const result = checkContradiction(
      "Confirm before running destructive git commands.",
      GOLDEN_RULES,
    );
    expect(result.duplicateOf).toBeUndefined();
  });
});
