/**
 * The committed CommonMark differential battery for the changelog guard's block
 * parse (`scripts/check-changelog-entry.mjs`).
 *
 * The cases live in `tests/fixtures/commonmark-mask-cases.mjs` — read that file
 * first. This file is the assertion half, and its shape changed with the
 * rewrite. It used to compare `parseSections` against a HARDCODED `guardH2`
 * column, nine of whose rows recorded answers the old approximation got WRONG.
 * That made it a change-detector: improve the guard and nine rows go red for
 * being right. Worse, the `commonmarkH2` column was a set of numbers somebody
 * pasted in from an out-of-tree script, and nothing checked it had not rotted.
 *
 * `commonmark` is now a devDependency, so both columns are DERIVED here, live,
 * from the reference implementation:
 *
 *   1. the rendered `<h2>` list matches the committed `commonmarkH2` — the
 *      table cannot drift from the parser it claims to quote;
 *   2. `parseSections` matches the reference implementation's own level-2
 *      headings, filtered by the documented policy — the guard IS the parser,
 *      modulo that one filter;
 *   3. that filter is exactly the documented policy and nothing more: the rows
 *      where the two columns differ are precisely the rows carrying an indented
 *      or setext heading;
 *   4. the battery still covers the shapes that cost seven review rounds, so
 *      nobody can neuter it by deleting the interesting rows.
 *
 * NON-VACUITY, corrected (review of #4703). This header used to bill assertion 2
 * as the load-bearing one and cite "fails on nine rows against 91bb46b8". The
 * citation is about an implementation that no longer exists — 91bb46b8 was the
 * hand-written approximation — and assertion 2's oracle used to recompute
 * `sourcepos[0][1] === 1 && /^##\s/.test(raw)`, character-for-character the
 * predicate in `analyze`. Two copies of one rule is a DRIFT hazard, not an
 * oracle: the two are edited together, so the test follows the code.
 *
 * Measured, precisely, because the obvious claim is too strong. Relax the
 * guard's anchor to `/^ {0,3}##\s/` and leave the mirror alone: 3 rows red, so
 * a single-site mutation IS caught. Relax it and update the mirror's copy of the
 * predicate in the same edit — what an author actually does — and assertion 2
 * (line ~149) goes green; the 3 rows still red, but only on assertion 3, the
 * committed `guardH2` column. Assertion 2 had stopped constraining anything and
 * the fixture column was silently carrying it.
 *
 * So the oracle is now derived from the SOURCE TEXT and CommonMark's ATX rule
 * (`policyClass`), which no edit to the guard's predicate can bring along.
 * Under that same relaxation, the failing assertion is 2 itself. Assertions 3
 * (the committed column, plus the divergence test) and 4 were sound throughout
 * and remain the backstop.
 */
import { describe, expect, it } from "vitest";
import { Parser, HtmlRenderer } from "commonmark";
import { parseSections } from "../scripts/check-changelog-entry.mjs";
import { CASES } from "./fixtures/commonmark-mask-cases.mjs";

interface MaskCase {
  name: string;
  md: string;
  commonmarkH2: string[];
  guardH2: string[];
  why: string;
}

const cases = CASES as MaskCase[];

/**
 * Every level-2 heading the reference implementation produces, in document
 * order, as its rendered text.
 *
 * Taken from the heading NODES rather than by regexing `<h2>…</h2>` out of the
 * rendered HTML. The regex form silently drops any heading containing inline
 * markup — `## v0.21.0 — \`hostd\` guard` renders as `<h2>… <code>hostd</code>
 * …</h2>`, which `<h2>([^<]*)</h2>` does not match at all. No row in the
 * fixture has one today, so the regex agreed; a row that added one would have
 * made this function under-count and the "diverges ONLY on the documented
 * policy" assertion below fire on a heading the guard had found perfectly well.
 * An oracle that breaks when the corpus grows is not an oracle.
 */
function renderedH2(md: string): string[] {
  const walker = new Parser().parse(md).walker();
  const out: string[] = [];
  let ev;
  let current: string[] | null = null;
  while ((ev = walker.next())) {
    const node = ev.node;
    if (node.type === "heading" && node.level === 2) {
      if (ev.entering) current = [];
      else if (current) {
        out.push(current.join(""));
        current = null;
      }
      continue;
    }
    if (current && ev.entering && typeof node.literal === "string") current.push(node.literal);
  }
  return out;
}

/** Kept honest: the node walk above must agree with the actual rendered HTML. */
function renderedH2ViaHtml(md: string): string[] {
  const html = new HtmlRenderer().render(new Parser().parse(md));
  return [...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1]);
}

/**
 * Which documented policy class a rendered level-2 heading falls into, decided
 * from its SOURCE LINE and CommonMark's ATX rule — not from the guard.
 *
 * This used to be `columnZeroH2`, and it computed
 * `sourcepos[0][1] === 1 && /^##\s/.test(raw)`: character-for-character the
 * predicate in `check-changelog-entry.mjs` `analyze`. Since `parseSections`
 * builds its list from the same parser's heading nodes and applies exactly that
 * predicate, assertion 2 below compared a value against a copy of the code that
 * produced it and could no longer fail (review of #4703 — the same defect made
 * `scripts/changelog-mask-differential.mjs` score 0/0 under every mutation).
 *
 * These three classes are facts about the TEXT: "1–3 leading spaces before a
 * `#`" (CommonMark renders it, the guard's anchor drops it), "a column-0 ATX
 * level-2 opener per the spec — `##` followed by whitespace or end of line",
 * and "the node exists but its line is neither, so it came from a setext
 * underline". The divergence test below derives the same split independently
 * again, from the raw source lines.
 */
function policyClass(raw: string): "indented" | "atx2" | "setext" {
  if (/^ {1,3}#/.test(raw)) return "indented";
  if (/^##(\s|$)/.test(raw)) return "atx2";
  return "setext";
}

/**
 * The oracle the guard is held to: the reference implementation's own level-2
 * heading nodes, restricted to the ones the documented policy says the guard
 * must REPORT, in the shape the guard reports them (the raw line, trimmed).
 */
function policyExpectedH2(md: string): string[] {
  const src = md.replace(/\r\n/g, "\n").split("\n");
  const walker = new Parser().parse(md.replace(/\r\n/g, "\n")).walker();
  const out: string[] = [];
  let ev;
  while ((ev = walker.next())) {
    if (!ev.entering || ev.node.type !== "heading" || ev.node.level !== 2) continue;
    const raw = src[ev.node.sourcepos[0][0] - 1] ?? "";
    if (policyClass(raw) !== "atx2") continue;
    out.push(raw.trim());
  }
  return out;
}

describe("check-changelog-entry — CommonMark differential battery", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    // 1. The committed reference column is still what the parser renders —
    //    cross-checked against the rendered HTML so the node walk cannot drift.
    expect(renderedH2(c.md)).toEqual(c.commonmarkH2);
    expect(renderedH2ViaHtml(c.md)).toEqual(c.commonmarkH2);

    // 2. The guard agrees with the reference implementation, live, modulo the
    //    documented policy — which is re-derived from the source text rather
    //    than copied off the implementation. See `policyClass`.
    const guard = parseSections(c.md).map((s) => s.heading);
    expect(guard).toEqual(policyExpectedH2(c.md));

    // 3. …and the committed column matches, so a reader of the fixture is not
    //    reading a stale number.
    expect(guard).toEqual(c.guardH2);
  });

  it("diverges from the rendered set ONLY on the documented heading policy", () => {
    // The guard drops headings the reference renders in exactly one situation:
    // the source line is not a column-0 `## ` ATX opener. Any OTHER shortfall
    // would be a fail-open hiding behind the policy.
    for (const c of cases) {
      const rendered = renderedH2(c.md);
      const guard = parseSections(c.md).map((s) => s.heading);
      if (guard.length === rendered.length) continue;
      // Every row that diverges must carry an indented or setext h2 in source.
      const src = c.md.split("\n");
      const offenders = src.filter((l) => /^ {1,3}#{1,6}\s/.test(l) || /^(-{1,}|={1,})\s*$/.test(l));
      expect(offenders.length, `${c.name}: diverges with no indented/setext heading`).toBeGreaterThan(
        0,
      );
      // And the guard may only LOSE headings this way, never invent one.
      expect(guard.length, `${c.name}: guard invented a heading`).toBeLessThan(rendered.length);
    }
  });

  it("keeps covering the shapes that cost seven review rounds", () => {
    // A battery whose interesting rows have been deleted proves nothing.
    expect(cases.length).toBeGreaterThanOrEqual(42);

    // Round 4: `<!-->` / `<!--->` are COMPLETE comments.
    for (const form of ["<!-->", "<!--->"]) {
      const row = cases.find((c) => c.md.includes(`\n${form}\n`));
      expect(row, `no battery row for a line-start ${form}`).toBeTruthy();
    }

    // Round 5: container scoping, in BOTH constructs.
    const container = cases.filter((c) => c.name.startsWith("CONTAINER:"));
    expect(container.length).toBeGreaterThanOrEqual(7);
    expect(
      container.find((c) => c.md.includes("\n  ```yaml\n  key: value\n\n##")),
      "no container row for a fence indented under a bullet",
    ).toBeTruthy();
    expect(
      container.find((c) => c.md.includes("\n- entry\n  <!--\n")),
      "no container row for a comment indented under a bullet",
    ).toBeTruthy();

    // The heading policy, which is now the guard's only divergence, so it has
    // to be pinned from both sides.
    const policy = cases.filter((c) => c.name.startsWith("POLICY:"));
    expect(policy.length).toBeGreaterThanOrEqual(3);
    for (const c of policy) {
      expect(
        parseSections(c.md).length,
        `${c.name}: policy row no longer diverges — is the column-0 anchor still there?`,
      ).toBeLessThan(renderedH2(c.md).length);
    }

    // All seven HTML block types, which the approximation never modelled.
    expect(cases.filter((c) => c.name.startsWith("HTML type ")).length).toBeGreaterThanOrEqual(6);
  });
});
