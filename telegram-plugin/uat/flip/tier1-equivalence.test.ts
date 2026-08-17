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
  it("flags a rule that drops a load-bearing named fact (ALL-CAPS party name)", () => {
    // Calibration: an incidental quoted proper noun is illustrative and NOT
    // demanded (see the sibling test below) — but a SHOUTED party name is a
    // guardrail a condensed rule cannot silently drop.
    const directives = [directive("d1", "exec", "The executor is GARY DAVID BROWN, not Ian.")];
    const rep = compareDirectivesToRules(
      directives,
      parsed([rule("R-01", "The executor is the estate trustee, not Ian.")]),
      { d1: "R-01" },
    );
    expect(rep.pass).toBe(false);
    expect(rep.truncated_or_drifted[0]).toMatchObject({ id: "d1", ruleId: "R-01", truncated: false });
    expect(rep.truncated_or_drifted[0].missingKeywords).toContain("GARY DAVID BROWN");
  });

  it("does NOT flag a dropped illustrative token (incidental quoted proper noun)", () => {
    // The OLD gate false-flagged this ("Twitter" dropped); the calibrated gate
    // treats an un-cued quoted proper noun as an illustrative sample. The
    // negation guardrail ("Never") is preserved, so this is a clean condense.
    const directives = [directive("d1", "scope", 'Never post to "Twitter" without approval.')];
    const rep = compareDirectivesToRules(directives, parsed([rule("R-01", "Never post without approval.")]), {
      d1: "R-01",
    });
    expect(rep.truncated_or_drifted).toEqual([]);
    expect(rep.pass).toBe(true);
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
  it("classes negation as a guardrail; quoted samples & proper nouns as illustrative", () => {
    const kws = extractKeywords('Never post to "the public channel" on Twitter — always ask Ken first.');
    const byVal = new Map(kws.map((k) => [k.value.toLowerCase(), k]));
    // negation is a guardrail modal (synonym class `neg`).
    expect(byVal.get("never")).toMatchObject({ kind: "modal", klass: "guardrail", modalClass: "neg" });
    // the quoted phrase is present but illustrative (no verbatim cue precedes it).
    expect(byVal.get("the public channel")).toMatchObject({ kind: "quote", klass: "illustrative" });
    // incidental proper nouns are present but illustrative — never demanded.
    expect(byVal.get("twitter")).toMatchObject({ klass: "illustrative" });
    expect(byVal.get("ken")).toMatchObject({ klass: "illustrative" });
    // bare "always" is emphasis, not an explicit scope phrase ⇒ no universal guardrail.
    expect(kws.some((k) => k.kind === "modal" && k.modalClass === "universal")).toBe(false);
    // "Never" at sentence start is the modal, not double-counted as a proper noun.
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
    // The negation "cannot" is NOT satisfied by the substring "cannon" in the
    // rule — the neg synonym class is word-boundary matched, not substring.
    const directives = [directive("d1", "g", "You cannot deploy on Fridays.")];
    const rep = compareDirectivesToRules(directives, parsed([rule("R-01", "Fire the cannon, deploy on Fridays.")]), {
      d1: "R-01",
    });
    expect(rep.pass).toBe(false);
    expect(rep.truncated_or_drifted[0].missingKeywords).toContain("cannot");
  });
});

// ---------------------------------------------------------------------------
// ADVERSARIAL DROP DETECTION — the acceptance criterion for the calibration.
//
// The calibration exists to stop condensation FALSE POSITIVES. The failure
// mode we refuse to introduce is the inverse: a gate so loose it greenlights a
// genuinely dropped guardrail. These tests pin that boundary with fixtures
// modelled on the real triage directives (lawgpt's executor / deferral-line /
// caveat facts). Each DROP fixture MUST FAIL; each synonym-preserving condense
// MUST PASS. If a future loosening regresses detection, one of these goes red.
// ---------------------------------------------------------------------------

// The lawgpt "defer-to-fiona" deferral line the directive says to emit verbatim.
const DEFERRAL_LINE =
  "This is a Fiona question — raise it with Fiona Jessep at LHPW before acting on any of the above.";
const DEFER_DIRECTIVE =
  `ENFORCEMENT: any legal-analysis response MUST end with exactly: "${DEFERRAL_LINE}" ` +
  "All output channels; without that line the response is failed.";

describe("tier1 calibration — STILL FAILS on a genuinely dropped guardrail", () => {
  it("drops a negation entirely: 'never send without approval' → 'send after review' ⇒ FAIL", () => {
    const directives = [directive("d1", "confirm-external", "Never send letters to solicitors without Ken's approval.")];
    const rep = compareDirectivesToRules(
      directives,
      parsed([rule("R-01", "Send letters to solicitors after review.")]),
      { d1: "R-01" },
    );
    expect(rep.pass).toBe(false);
    expect(rep.truncated_or_drifted[0].missingKeywords).toContain("never");
  });

  it("drops a named load-bearing fact: executor 'GARY DAVID BROWN' ⇒ FAIL", () => {
    const directives = [
      directive("d1", "gary-executor", "Executor of George's estate is GARY DAVID BROWN via the s17 chain."),
    ];
    const rep = compareDirectivesToRules(
      directives,
      parsed([rule("R-01", "Executor of George's estate is the appointed representative via the s17 chain.")]),
      { d1: "R-01" },
    );
    expect(rep.pass).toBe(false);
    expect(rep.truncated_or_drifted[0].missingKeywords).toContain("GARY DAVID BROWN");
  });

  it("drops the required-verbatim deferral line ⇒ FAIL", () => {
    const directives = [directive("d1", "defer-to-fiona", DEFER_DIRECTIVE)];
    const rep = compareDirectivesToRules(
      directives,
      // rule paraphrases the obligation but omits the exact required wording.
      parsed([rule("R-01", "Never give legal advice; end legal-analysis by pointing to the solicitor.")]),
      { d1: "R-01" },
    );
    expect(rep.pass).toBe(false);
    expect(rep.truncated_or_drifted[0].missingKeywords.some((k) => k.includes("Fiona Jessep at LHPW"))).toBe(true);
  });

  it("drops a case-caveat number 'S CAV 2026 00037' ⇒ FAIL", () => {
    const directives = [
      directive("d1", "caveat", "Ian filed probate caveat S CAV 2026 00037, now cancelled; he holds no office."),
    ];
    const rep = compareDirectivesToRules(
      directives,
      parsed([rule("R-01", "Ian filed a probate caveat, now cancelled; he holds no office.")]),
      { d1: "R-01" },
    );
    expect(rep.pass).toBe(false);
    expect(rep.truncated_or_drifted[0].missingKeywords).toContain("CAV 2026 00037");
  });

  it("truncates mid-guardrail (strict prefix cut) ⇒ FAIL", () => {
    const directives = [
      directive("d1", "no-ian", "Never call Ian the executor without a documentary grant of probate."),
    ];
    const rep = compareDirectivesToRules(
      directives,
      parsed([rule("R-01", "Never call Ian the executor without a documentary")]),
      { d1: "R-01" },
    );
    expect(rep.pass).toBe(false);
    expect(rep.truncated_or_drifted[0].truncated).toBe(true);
  });

  it("truncates mid-guardrail (ellipsis) ⇒ FAIL", () => {
    const directives = [directive("d1", "defer-to-fiona", DEFER_DIRECTIVE)];
    const rep = compareDirectivesToRules(
      directives,
      parsed([rule("R-01", `Never give legal advice; end with: "${DEFERRAL_LINE}"…`)]),
      { d1: "R-01" },
    );
    expect(rep.pass).toBe(false);
    expect(rep.truncated_or_drifted[0].truncated).toBe(true);
  });
});

describe("tier1 calibration — now PASSES real synonym-preserving condensations", () => {
  it("negation synonym: directive 'don't' → rule 'NEVER' preserves the guardrail ⇒ PASS", () => {
    const directives = [directive("d1", "confirm-external", "Don't send letters to solicitors without Ken's approval.")];
    const rep = compareDirectivesToRules(
      directives,
      parsed([rule("R-01", "NEVER send letters to solicitors without approval; draft for review only.")]),
      { d1: "R-01" },
    );
    expect(rep.truncated_or_drifted).toEqual([]);
    expect(rep.pass).toBe(true);
  });

  it("exclusivity synonym: directive 'only' → rule 'sole/alone' preserves scope ⇒ PASS", () => {
    const directives = [directive("d1", "fiona-facts", "Include only documented facts visible on paper.")];
    const rep = compareDirectivesToRules(
      directives,
      parsed([rule("R-01", "Include documented facts visible on paper exclusively.")]),
      { d1: "R-01" },
    );
    expect(rep.truncated_or_drifted).toEqual([]);
    expect(rep.pass).toBe(true);
  });

  it("preserves the deferral line + named facts verbatim ⇒ PASS", () => {
    const directives = [
      directive("d1", "defer-to-fiona", DEFER_DIRECTIVE),
      directive("d2", "gary-executor", "Executor is GARY DAVID BROWN; caveat S CAV 2026 00037 cancelled."),
    ];
    const rep = compareDirectivesToRules(
      directives,
      parsed([
        rule("R-01", `Never give legal advice. End any legal-analysis with exactly: "${DEFERRAL_LINE}"`),
        rule("R-02", "Executor is GARY DAVID BROWN; the caveat S CAV 2026 00037 is cancelled — Ian holds no office."),
      ]),
      { d1: "R-01", d2: "R-02" },
    );
    expect(rep.truncated_or_drifted).toEqual([]);
    expect(rep.pass).toBe(true);
  });

  it("drops an ILLUSTRATIVE example code (e.g. AG779131P) without flagging ⇒ PASS", () => {
    const directives = [
      directive("d1", "evidence", "Cite an instrument or ledger number (e.g. AG779131P, TR10399) inline with each claim."),
    ];
    const rep = compareDirectivesToRules(
      directives,
      parsed([rule("R-01", "Cite an instrument or ledger number inline with every claim.")]),
      { d1: "R-01" },
    );
    expect(rep.truncated_or_drifted).toEqual([]);
    expect(rep.pass).toBe(true);
  });

  it("drops an ILLUSTRATIVE sample toast (un-cued quote) without flagging ⇒ PASS", () => {
    const directives = [
      directive("d1", "toast", 'Add a per-button toast, e.g. ack_text "✓ Code fix — starting", for instant feedback.'),
    ];
    const rep = compareDirectivesToRules(
      directives,
      parsed([rule("R-01", "Add a per-button ack_text toast for instant feedback on every callback button.")]),
      { d1: "R-01" },
    );
    expect(rep.truncated_or_drifted).toEqual([]);
    expect(rep.pass).toBe(true);
  });
});
