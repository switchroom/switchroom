import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderRulesBlock, type Rule } from "./rules-block.js";

/**
 * Memory v2 M3 (Surface-A) — cross-language format lock.
 *
 * The Python directive-injection guard (`recall.py: rules_block_present`)
 * decides whether to SUPPRESS the `<active_directives>` block by grepping
 * CLAUDE.md for the rules-block markers plus at least one `- **R-…` rule line.
 * That grep is only correct while it matches the bytes `renderRulesBlock`
 * actually writes. TS and Python live in different toolchains, so nothing but
 * a shared fixture keeps them from drifting apart silently — a format change
 * on the TS side (rename a marker, reshape the rule line) would leave the
 * Python guard matching stale bytes and either never suppressing (token waste
 * persists) or, worse, mis-detecting an empty block as populated.
 *
 * This test pins the fixture the Python format-lock test consumes
 * (`vendor/hindsight-memory/scripts/tests/fixtures/rules-block.golden.md`) to
 * the live `renderRulesBlock` output. If the TS writer changes, THIS test goes
 * red first — regenerate the fixture, and the Python test then re-verifies the
 * grep still matches the new shape.
 */

// The exact rule set the committed fixture was generated from. Kept in lockstep
// with the generator so the sentinel hash stays deterministic.
const GOLDEN_RULES: Rule[] = [
  {
    id: "R-01",
    text: "Always end replies to the user with a one-line summary.",
    source: "reflect-directive",
    created_at: "2026-08-17T00:00:00.000Z",
  },
  {
    id: "R-02",
    text: "Never send email without explicit user approval.",
    source: "reflect-directive",
    created_at: "2026-08-17T00:00:00.000Z",
  },
];

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "vendor",
  "hindsight-memory",
  "scripts",
  "tests",
  "fixtures",
  "rules-block.golden.md",
);

describe("M3 rules-block golden fixture ↔ renderRulesBlock (Python format lock)", () => {
  it("the committed fixture is byte-identical to renderRulesBlock output", () => {
    const fixture = readFileSync(FIXTURE_PATH, "utf8").replace(/\n$/, "");
    expect(
      fixture,
      "vendor/…/fixtures/rules-block.golden.md drifted from renderRulesBlock — " +
        "regenerate it (renderRulesBlock(GOLDEN_RULES)) so the Python guard's " +
        "grep stays matched to the real rule-line shape",
    ).toBe(renderRulesBlock(GOLDEN_RULES));
  });

  it("the fixture carries the marker + at least one `- **R-` rule line the Python guard greps for", () => {
    const fixture = readFileSync(FIXTURE_PATH, "utf8");
    expect(fixture).toContain("<!-- switchroom:rules:begin -->");
    expect(fixture).toContain("<!-- switchroom:rules:end -->");
    // The exact anchor the Python regex (`^- \*\*R-`, MULTILINE) keys on.
    expect(fixture).toMatch(/^- \*\*R-/m);
    // The empty-block placeholder must NOT be what Python matches on.
    expect(fixture).not.toContain("\n(none)\n");
  });
});
