/**
 * Unit suite for the Tier-1 directive⇄rules equivalence check. Runs under
 * `bun test` (this tree is vitest-excluded — see vitest.config.ts) via the
 * `uat/flip/` entry in telegram-plugin/scripts/bun-test-ci.sh; imports the
 * shared `vitest` describe/it/expect that Bun's test runner understands, same
 * as the sibling `uat/runners/*.test.ts`.
 *
 * Each failure mode gets its own case, and the fixtures are built by RENDERING
 * a rule set with the real `renderRulesBlock` then parsing it back with the
 * real `parseRulesBlock`, so the sentinel is genuine and the parser under test
 * is the production one.
 */

import { describe, it, expect } from "vitest";
import {
  compareDirectivesToRules,
  extractKeywords,
  residueDirectives,
  type FlipDirective,
  type DirectiveRuleMapping,
} from "./tier1-equivalence.js";
import {
  renderRulesBlock,
  parseRulesBlock,
  type Rule,
  type ParsedRulesBlock,
} from "../../../src/memory/rules-block.js";

function rule(id: string, text: string): Rule {
  return { id, text, source: "telegram", created_at: "2026-08-18T00:00:00.000Z" };
}

/** Render + parse a rule set so the sentinel count is real and correct. */
function parsed(rules: Rule[]): ParsedRulesBlock {
  const block = renderRulesBlock(rules);
  const p = parseRulesBlock(block);
  if (!p) throw new Error("fixture rules block failed to parse");
  return p;
}

function directive(id: string, name: string, content: string, extra: Partial<FlipDirective> = {}): FlipDirective {
  return { id, name, content, priority: 5, ...extra };
}

describe("compareDirectivesToRules — PASS", () => {
  it("all residue directives mapped to present rules that preserve keywords", () => {
    const directives = [
      directive("d1", "no-exfil", 'Never exfiltrate secrets to "Telegram" chat.'),
      directive("d2", "reply-tool", "You must always call the reply tool."),
    ];
    const rules = [
      rule("R-01", 'Never exfiltrate secrets to "Telegram" chat, ever.'),
      rule("R-02", "You must always call the reply tool to answer."),
    ];
    const mapping: DirectiveRuleMapping = { d1: "R-01", d2: "R-02" };
    const rep = compareDirectivesToRules(directives, parsed(rules), mapping);
    expect(rep.pass).toBe(true);
    expect(rep.missing_from_rules).toEqual([]);
    expect(rep.truncated_or_drifted).toEqual([]);
    expect(rep.unsourced_rules).toEqual([]);
    expect(rep.withinBudget).toBe(true);
    expect(rep.sentinelMatchesCount).toBe(true);
    expect(rep.residueDirectiveCount).toBe(2);
  });

  it("an explicit retired:<reason> satisfies the obligation with no rule", () => {
    const directives = [directive("d1", "stale", "Only use the old API endpoint.")];
    const rules: Rule[] = [];
    const mapping: DirectiveRuleMapping = { d1: "retired: superseded by the new gateway rule R-09" };
    const rep = compareDirectivesToRules(directives, parsed(rules), mapping);
    expect(rep.missing_from_rules).toEqual([]);
    // No rules ⇒ nothing unsourced, budget fine, sentinel count 0 == 0.
    expect(rep.pass).toBe(true);
  });
});

describe("compareDirectivesToRules — (a) missing_from_rules", () => {
  it("flags an unmapped active residue directive", () => {
    const directives = [directive("d1", "guard", "Never delete production data.")];
    const rep = compareDirectivesToRules(directives, parsed([]), {});
    expect(rep.pass).toBe(false);
    expect(rep.missing_from_rules).toEqual([{ id: "d1", name: "guard", reason: "unmapped" }]);
  });

  it("flags a directive mapped to a rule id that is not present", () => {
    const directives = [directive("d1", "guard", "Never force-push main.")];
    const rep = compareDirectivesToRules(directives, parsed([rule("R-01", "Never force-push main.")]), {
      d1: "R-99",
    });
    expect(rep.pass).toBe(false);
    expect(rep.missing_from_rules[0]).toMatchObject({ id: "d1", reason: "absent-rule", mappedTo: "R-99" });
    // R-01 is present but nothing sources it ⇒ also unsourced.
    expect(rep.unsourced_rules).toEqual([{ id: "R-01", text: "Never force-push main." }]);
  });

  it("flags an empty retirement reason as missing", () => {
    const directives = [directive("d1", "guard", "Always branch off origin/main.")];
    const rep = compareDirectivesToRules(directives, parsed([]), { d1: "retired:   " });
    expect(rep.pass).toBe(false);
    expect(rep.missing_from_rules[0]).toMatchObject({ id: "d1", reason: "empty-retire-reason" });
  });
});

describe("compareDirectivesToRules — (b) truncated_or_drifted", () => {
  it("flags a rule that drops a directive keyword (a proper noun)", () => {
    const directives = [directive("d1", "scope", 'Never post to "Twitter" without approval.')];
    // rule keeps the modal but drops the quoted proper noun.
    const rep = compareDirectivesToRules(directives, parsed([rule("R-01", "Never post without approval.")]), {
      d1: "R-01",
    });
    expect(rep.pass).toBe(false);
    expect(rep.truncated_or_drifted[0]).toMatchObject({ id: "d1", ruleId: "R-01", truncated: false });
    expect(rep.truncated_or_drifted[0].missingKeywords).toContain("Twitter");
  });

  it("flags a rule that drops a modal (never)", () => {
    const directives = [directive("d1", "scope", "Never send emails automatically.")];
    const rep = compareDirectivesToRules(directives, parsed([rule("R-01", "Send emails automatically.")]), {
      d1: "R-01",
    });
    expect(rep.pass).toBe(false);
    expect(rep.truncated_or_drifted[0].missingKeywords).toContain("never");
  });

  it("flags a rule truncated with an ellipsis", () => {
    const directives = [directive("d1", "scope", "Never delete production data without a backup first.")];
    const rep = compareDirectivesToRules(
      directives,
      parsed([rule("R-01", "Never delete production data without a backup first…")]),
      { d1: "R-01" },
    );
    expect(rep.pass).toBe(false);
    expect(rep.truncated_or_drifted[0].truncated).toBe(true);
  });

  it("flags a rule that is a strict prefix of the directive (cut short)", () => {
    const directives = [directive("d1", "scope", "Always confirm intent before a destructive action")];
    const rep = compareDirectivesToRules(
      directives,
      parsed([rule("R-01", "Always confirm intent before")]),
      { d1: "R-01" },
    );
    expect(rep.pass).toBe(false);
    expect(rep.truncated_or_drifted[0].truncated).toBe(true);
  });
});

describe("compareDirectivesToRules — (c) budget + sentinel", () => {
  it("fails when the rendered block exceeds the 6144B budget", () => {
    // One rule with a ~7000-char body blows the budget on its own.
    const big = rule("R-01", "Never " + "x".repeat(7000));
    const directives = [directive("d1", "big", big.text)];
    const rep = compareDirectivesToRules(directives, parsed([big]), { d1: "R-01" });
    expect(rep.withinBudget).toBe(false);
    expect(rep.renderedBytes).toBeGreaterThan(6144);
    expect(rep.pass).toBe(false);
  });

  it("fails when the sentinel count disagrees with the rule count", () => {
    // Hand-forge a parsed block whose sentinel lies about the count.
    const good = parsed([rule("R-01", "Never force-push main.")]);
    const forged: ParsedRulesBlock = {
      rules: good.rules,
      sentinel: { hash: good.sentinel!.hash, count: 5 },
    };
    const directives = [directive("d1", "guard", "Never force-push main.")];
    const rep = compareDirectivesToRules(directives, forged, { d1: "R-01" });
    expect(rep.sentinelMatchesCount).toBe(false);
    expect(rep.pass).toBe(false);
  });

  it("fails when the block has no sentinel at all", () => {
    const noSentinel: ParsedRulesBlock = { rules: [rule("R-01", "Never x.")], sentinel: null };
    const rep = compareDirectivesToRules([directive("d1", "g", "Never x.")], noSentinel, { d1: "R-01" });
    expect(rep.sentinelCount).toBeNull();
    expect(rep.sentinelMatchesCount).toBe(false);
    expect(rep.pass).toBe(false);
  });
});

describe("compareDirectivesToRules — (d) unsourced_rules", () => {
  it("flags a rule with no directive mapping to it", () => {
    const directives = [directive("d1", "g", "Never x.")];
    const rules = [rule("R-01", "Never x."), rule("R-02", "An invented rule with no directive source.")];
    const rep = compareDirectivesToRules(directives, parsed(rules), { d1: "R-01" });
    expect(rep.pass).toBe(false);
    expect(rep.unsourced_rules).toEqual([
      { id: "R-02", text: "An invented rule with no directive source." },
    ]);
  });
});

describe("residue filtering", () => {
  it("excludes non-residue categories and inactive directives from the obligation", () => {
    const directives = [
      directive("d1", "keep", "Never x.", { category: "reflect-directive" }),
      directive("d2", "drop", "y.", { category: "retain-as-memory" }),
      directive("d3", "gone", "z.", { category: "rules-block", isActive: false }),
    ];
    expect(residueDirectives(directives).map((d) => d.id)).toEqual(["d1"]);
    // d2/d3 need no rule; only d1 must be mapped.
    const rep = compareDirectivesToRules(directives, parsed([rule("R-01", "Never x.")]), { d1: "R-01" });
    expect(rep.pass).toBe(true);
    expect(rep.residueDirectiveCount).toBe(1);
  });

  it("treats a directive with no category as active residue (caller pre-filtered)", () => {
    const rep = compareDirectivesToRules([directive("d1", "g", "Never x.")], parsed([]), {});
    expect(rep.missing_from_rules[0].reason).toBe("unmapped");
  });
});

describe("extractKeywords — the fixed tokenizer", () => {
  it("captures quoted phrases, modals, and proper nouns; skips stopwords", () => {
    const kws = extractKeywords('Never post to "the public channel" on Twitter — always ask Ken first.');
    const values = kws.map((k) => k.value.toLowerCase());
    expect(values).toContain("the public channel"); // quoted phrase, verbatim
    expect(values).toContain("never");
    expect(values).toContain("always");
    expect(values).toContain("twitter");
    expect(values).toContain("ken");
    // "Never"/"Always" at sentence start are modals, not double-counted as proper nouns.
    expect(kws.filter((k) => k.value.toLowerCase() === "never").length).toBe(1);
  });

  it("captures the don't modal with its apostrophe stem", () => {
    const kws = extractKeywords("Don't ever run destructive commands.");
    expect(kws.some((k) => k.kind === "modal" && k.value.toLowerCase().startsWith("don"))).toBe(true);
  });

  it("is stateless across calls — a prior call cannot make a later don't be missed", () => {
    // Regression: a module-level /g regex used with .test() persists lastIndex,
    // so a first call that matches "don't" mid-string would advance past
    // position 0 and make this second call (with "Don't" at position 0) miss.
    extractKeywords("You should never do this; don't do it either.");
    const kws = extractKeywords("Don't run destructive commands.");
    expect(kws.some((k) => k.kind === "modal" && k.value.toLowerCase().startsWith("don"))).toBe(true);
  });

  it("word-boundary matches modals so a substring does not satisfy", () => {
    // 'must' as a directive keyword is not satisfied by 'mustard' in the rule.
    const directives = [directive("d1", "g", "You must comply.")];
    const rep = compareDirectivesToRules(directives, parsed([rule("R-01", "Pass the mustard, comply.")]), {
      d1: "R-01",
    });
    expect(rep.truncated_or_drifted[0].missingKeywords).toContain("must");
  });
});
