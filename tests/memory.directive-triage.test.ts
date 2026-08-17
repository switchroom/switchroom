/**
 * Outcome tests for the directive-triage card generator
 * (carve-M2.md T1/T2, TDD-a/UAT-1; redteam-M2.md §4).
 *
 * These assert what the carve calls out explicitly as the failure classes
 * that matter: completeness (no directive silently vanishes), default-KEEP
 * (a row is never marked retire without a real signal), the rules-block
 * hard rule (Decision 3, enforced here at classification time too), and
 * visual separation (KEEP rows never appear after retirement candidates).
 */
import { describe, expect, it } from "vitest";
import {
  buildDirectiveTriageRows,
  classifyDirective,
  renderDirectiveTriageCard,
  DIRECTIVE_TRIAGE_CATEGORIES,
  type DirectiveTriageOverride,
} from "../src/memory/directive-triage.js";
import {
  RULES_BLOCK_MARKER_TAG,
  type HindsightDirective,
} from "../src/memory/hindsight-directive-admin.js";

function directive(overrides: Partial<HindsightDirective> & { id: string; name: string }): HindsightDirective {
  return {
    priority: 0,
    is_active: true,
    tags: [],
    content: "some guardrail text",
    ...overrides,
  };
}

describe("buildDirectiveTriageRows — completeness (anti-vacuity)", () => {
  it("emits exactly one row per input directive, no drop and no dup", () => {
    const input: HindsightDirective[] = [
      directive({ id: "1", name: "a" }),
      directive({ id: "2", name: "b" }),
      directive({ id: "3", name: "c" }),
      directive({ id: "4", name: "d" }),
      directive({ id: "5", name: "e" }),
    ];
    const rows = buildDirectiveTriageRows(input);

    // Anti-vacuity: the parsed row SET is non-empty and equals the input
    // name set BEFORE any per-row category check — guards a generator that
    // returns [] and would otherwise pass every per-row assertion trivially.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).toHaveLength(input.length);
    expect(rows.map((r) => r.name).sort()).toEqual(input.map((d) => d.name).sort());

    for (const row of rows) {
      expect(DIRECTIVE_TRIAGE_CATEGORIES).toContain(row.category);
    }
  });

  it("never drops a directive even when every row is a distinct category", () => {
    // Keyed by id, not name (M2 redteam LOW) — a name is not unique once a
    // windows-boxes-class reconcile is in flight.
    const overrides = new Map<string, DirectiveTriageOverride>([
      ["1", { category: "disposition", signal: "belongs in disposition_verbosity config" }],
      ["2", { category: "retain-as-memory", signal: "a fact, already held as memory #m-1" }],
      ["3", { category: "rules-block", signal: "standing preference, destined for CLAUDE.md rules block" }],
    ]);
    const input: HindsightDirective[] = [
      directive({ id: "1", name: "disp" }),
      directive({ id: "2", name: "mem" }),
      directive({ id: "3", name: "rb" }),
      directive({ id: "4", name: "keep-me" }),
    ];
    const rows = buildDirectiveTriageRows(input, overrides);
    expect(rows.map((r) => r.name).sort()).toEqual(["disp", "keep-me", "mem", "rb"]);
  });
});

describe("classifyDirective — deterministic supersession signal", () => {
  it("pre-classifies a superseded-by-tagged directive as retire, naming the signal", () => {
    const d = directive({
      id: "1",
      name: "old-rule",
      tags: ["style", "superseded-by:new-rule"],
    });
    const result = classifyDirective(d);
    expect(result.category).toBe("retire");
    expect(result.action).toBe("retire");
    expect(result.supersededBy).toBe("new-rule");
    expect(result.signal).toMatch(/new-rule/);
  });

  it("tag-based signal wins over a conflicting non-rules-block override", () => {
    const d = directive({ id: "1", name: "old-rule", tags: ["superseded-by:new-rule"] });
    const result = classifyDirective(d, {
      category: "reflect-directive",
      signal: "actually keep this one",
    });
    expect(result.category).toBe("retire");
    expect(result.action).toBe("retire");
  });
});

describe("classifyDirective — rules-block wins over the superseded-by tag scan (M2 redteam B1)", () => {
  it("a rules-block OVERRIDE wins over a conflicting superseded-by tag — never comes out 'retire'", () => {
    // Reachable mundanely: DirectiveAdmin.reactivate() leaves a stale
    // superseded-by tag in place, and tags are settable via PATCH/
    // create_directive — so a genuinely rules-block directive can carry
    // BOTH signals at once. The tag scan must NOT win here: a rules-block
    // classification (whether from an override or a persisted marker) is
    // load-bearing for whether the executor's guard fires at all.
    const d = directive({
      id: "1",
      name: "standing-pref",
      tags: ["superseded-by:new-rule"],
    });
    const result = classifyDirective(d, {
      category: "rules-block",
      signal: "standing user preference, destined for CLAUDE.md rules block at M3 flip",
    });
    expect(result.category).toBe("rules-block");
    expect(result.action).toBe("stage-for-m3");
    expect(result.action).not.toBe("retire");
  });

  it("a persisted rules-block MARKER tag wins over a conflicting superseded-by tag, with no override at all", () => {
    const d = directive({
      id: "1",
      name: "standing-pref",
      tags: ["superseded-by:new-rule", RULES_BLOCK_MARKER_TAG],
    });
    const result = classifyDirective(d);
    expect(result.category).toBe("rules-block");
    expect(result.action).toBe("stage-for-m3");
    expect(result.action).not.toBe("retire");
  });

  it("a rules-block override with an EMPTY signal still wins over a conflicting superseded-by tag — fails CLOSED, not open (review low #1)", () => {
    // Every other category's empty-signal override falls through to
    // default-KEEP (fail-safe: "no override" is treated as "no signal at
    // all"). rules-block must NOT take that path — an empty-signal
    // rules-block override falling through here would let the conflicting
    // superseded-by tag win and classify `retire`. Not independently
    // exploitable (DirectiveAdmin's marker-tag chokepoint still refuses
    // the actual deactivate call), but the classifier itself should never
    // assert `retire` for a directive its own caller just called
    // rules-block.
    const d = directive({
      id: "1",
      name: "standing-pref",
      tags: ["superseded-by:new-rule"],
    });
    const result = classifyDirective(d, { category: "rules-block", signal: "   " });
    expect(result.category).toBe("rules-block");
    expect(result.action).toBe("stage-for-m3");
    expect(result.action).not.toBe("retire");
  });
});

describe("classifyDirective — an already-inactive directive is never re-retired (M2 redteam M1)", () => {
  it("a superseded-by tag on an INACTIVE directive keeps action:keep, not retire", () => {
    const d = directive({
      id: "1",
      name: "old-rule",
      is_active: false,
      tags: ["superseded-by:new-rule"],
    });
    const result = classifyDirective(d);
    expect(result.action).toBe("keep");
    expect(result.action).not.toBe("retire");
  });

  it("a retire override on an INACTIVE directive keeps action:keep, not retire", () => {
    const d = directive({ id: "1", name: "mechanized", is_active: false });
    const result = classifyDirective(d, {
      category: "retire",
      signal: "mechanized by scaffold.ts:900 — no longer needs a directive",
    });
    expect(result.action).toBe("keep");
    expect(result.action).not.toBe("retire");
  });
});

describe("classifyDirective — default-KEEP (redteam-M2.md §4)", () => {
  it("a directive with no deterministic signal and no override defaults to KEEP", () => {
    const d = directive({ id: "1", name: "plain" });
    const result = classifyDirective(d);
    expect(result.action).toBe("keep");
    expect(result.category).toBe("reflect-directive");
  });

  it("an override with an EMPTY signal is treated as no override — still defaults to KEEP", () => {
    const d = directive({ id: "1", name: "plain" });
    const result = classifyDirective(d, { category: "retire", signal: "   " });
    expect(result.action).toBe("keep");
    expect(result.category).toBe("reflect-directive");
  });

  it("an override with a real signal DOES produce a retire action (retire category)", () => {
    const d = directive({ id: "1", name: "mechanized" });
    const result = classifyDirective(d, {
      category: "retire",
      signal: "mechanized by scaffold.ts:900 — no longer needs a directive",
    });
    expect(result.action).toBe("retire");
    expect(result.category).toBe("retire");
  });
});

describe("classifyDirective — rules-block can NEVER produce action: retire (Decision 3)", () => {
  it("an override naming category rules-block with a real signal still stages, never retires", () => {
    const d = directive({ id: "1", name: "standing-pref" });
    const result = classifyDirective(d, {
      category: "rules-block",
      signal: "standing user preference, destined for CLAUDE.md rules block at M3 flip",
    });
    expect(result.category).toBe("rules-block");
    expect(result.action).toBe("stage-for-m3");
    expect(result.action).not.toBe("retire");
  });
});

describe("renderDirectiveTriageCard — visual separation and defaults", () => {
  it("puts every KEEP/staged row before the retirement candidates, never interleaved", () => {
    const rows = buildDirectiveTriageRows(
      [
        directive({ id: "1", name: "guardrail-1" }),
        directive({ id: "2", name: "old", tags: ["superseded-by:new"] }),
        directive({ id: "3", name: "new" }),
        directive({ id: "4", name: "rb" }),
      ],
      new Map([
        ["4", { category: "rules-block", signal: "destined for rules block" } satisfies DirectiveTriageOverride],
      ]),
    );
    const card = renderDirectiveTriageCard(rows);

    const keepHeaderIdx = card.text.indexOf("## Keep / staged");
    const retireHeaderIdx = card.text.indexOf("## Retirement candidates");
    expect(keepHeaderIdx).toBeGreaterThanOrEqual(0);
    expect(retireHeaderIdx).toBeGreaterThan(keepHeaderIdx);

    // The retired row's name must appear ONLY after the retire header, and
    // every kept/staged row's name must appear ONLY before it.
    const oldIdxInText = card.text.indexOf("**old**");
    expect(oldIdxInText).toBeGreaterThan(retireHeaderIdx);

    for (const name of ["guardrail-1", "new", "rb"]) {
      const idx = card.text.indexOf(`**${name}**`);
      expect(idx).toBeGreaterThan(keepHeaderIdx);
      expect(idx).toBeLessThan(retireHeaderIdx);
    }
  });

  it("shows priority per row (so a reviewer can catch retiring a high-priority guardrail)", () => {
    const rows = buildDirectiveTriageRows([
      directive({ id: "1", name: "high-pri", priority: 20 }),
    ]);
    const card = renderDirectiveTriageCard(rows);
    expect(card.text).toContain("priority 20");
  });

  it("card.rows carries the full row set — completeness holds through rendering too", () => {
    const input = [
      directive({ id: "1", name: "a" }),
      directive({ id: "2", name: "b" }),
    ];
    const rows = buildDirectiveTriageRows(input);
    const card = renderDirectiveTriageCard(rows);
    expect(card.rows).toHaveLength(input.length);
  });
});
