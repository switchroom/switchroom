/**
 * Mutation operators — the pure half of the targeted mutation harness.
 *
 * Given a source file's text, enumerate the small, deterministic set of
 * source edits that reproduce the two defect shapes v0.21.8 shipped (see
 * `scripts/check-mutation-coverage.mjs` for the incident write-up). Each
 * mutant is a complete alternative source text; applying and running the
 * scoped tests is the runner's job (`run.mjs`), which keeps this module
 * trivially unit-testable with no filesystem or subprocess anywhere near it.
 *
 * Three operators, chosen because each is the literal edit a human reviewer
 * made by hand on a real incident — not a textbook mutation catalogue:
 *
 *   force-false   `if (C)` → `if (false && (C))`
 *                 The guard is neutralised while C's side effects are kept.
 *                 This is the exact edit that survived all 76 tests in #4663
 *                 (`git show 2338c280`), proving the tier-2 age bound in
 *                 `selectEvictionVictim` was load-bearing but unasserted.
 *
 *   force-true    `if (C)` → `if (true || (C))`
 *                 The mirror: the guard always fires. This is the edit that
 *                 exposed the untested `--dry-run` gate recorded at
 *                 `src/cli/rollout.test.ts:3027`.
 *
 *   drop-last-arg `f(a, b)` → `f(a, undefined)`
 *                 A value production is dropped at the call site. This is the
 *                 #4670 shape: production passed `reconcileEnv` positionally
 *                 to `runSwitchroom(args, extraEnv)` while every test asserted
 *                 a MIRROR of that variable handed to an injected seam, so
 *                 deleting the real argument left the suite green
 *                 (`src/host-control/server.ts:298-317` documents this in
 *                 prose; `tests/host-control/config-propose-edit.test.ts:1439`
 *                 is the test that finally pinned it).
 *
 * Deliberately NOT included: arithmetic/relational operator swaps, literal
 * bumps, statement deletion. They are the bulk of a general mutation suite,
 * they generate the bulk of the equivalent mutants, and neither incident had
 * that shape. A narrow guard that runs beats a broad one that gets disabled.
 */

import ts from "typescript";

/** Operator ids, in the order mutants are emitted for a given site. */
export const OPERATORS = ["force-false", "force-true", "drop-last-arg"];

/**
 * Inline escape hatch for a KNOWN-equivalent mutant — one whose survival is a
 * deliberate, argued property of the code rather than a coverage hole.
 * `src/util/log-rotation.ts:641` is the canonical example: `if (false) return
 * null;` there survives all 47 scoped tests and the comment argues at length
 * why the branch is inert.
 *
 * A reason is MANDATORY. `// mutation-allow:` with nothing after it does not
 * suppress anything — an escape hatch you can take without saying why is how a
 * guard stops guarding.
 *
 * Matched against raw line text, so a hit INSIDE a string or template literal
 * is rejected (see `literalSpans`): the text `"// mutation-allow: x"` sitting
 * in a fixture, a log-line template, or a test's inline source must not
 * suppress a real adjacent site. That is a silent no-op of the guard, which is
 * exactly the failure mode this whole check exists to make impossible.
 *
 * The `m` flag is load-bearing despite matching one line at a time. `text` is
 * split on "\n", so on a CRLF file every candidate line ends in a stray "\r".
 * `\r` is a JS line terminator, so `.` will not consume it and a non-multiline
 * `$` will not match before it — `(\S.*)$` fails outright and the hatch stops
 * suppressing ANYTHING, silently, on that file. Failing closed (a suppressed
 * mutant reappears as a survivor) makes it merely confusing rather than
 * dangerous, and the repo is LF-only today, but "the hatch quietly changes
 * meaning with the line ending" is not a property to leave in a guard.
 */
const ALLOW_RE = /\/\/\s*mutation-allow:\s*(\S.*)$/m;

/** Argument node kinds `drop-last-arg` will replace with `undefined`.
 *  Restricted to value-shaped arguments: dropping a callback or an inline
 *  literal is either a type error or a trivially-killed no-op, and both are
 *  noise. */
const DROPPABLE_ARG_KINDS = new Set([
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.PropertyAccessExpression,
  ts.SyntaxKind.ElementAccessExpression,
  ts.SyntaxKind.ObjectLiteralExpression,
]);

function scriptKindFor(fileName) {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".ts")) return ts.ScriptKind.TS;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

/**
 * Spans of the named declarations, so a manifest entry can mutate one function
 * inside a 6000-line module (`src/host-control/server.ts` is 6060 lines — an
 * unscoped run there is hundreds of mutants and hours of CI).
 *
 * Matches function declarations, class methods, and `const x = () => {}` /
 * `const x = function () {}` bindings by their declared name.
 */
function symbolSpans(sourceFile, symbols) {
  const wanted = new Set(symbols);
  const spans = [];
  const found = new Set();
  const visit = (node) => {
    let name;
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isVariableDeclaration(node) ||
      ts.isPropertyDeclaration(node)
    ) {
      name = node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
    }
    if (name && wanted.has(name)) {
      spans.push([node.getStart(sourceFile), node.getEnd()]);
      found.add(name);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  const missing = symbols.filter((s) => !found.has(s));
  return { spans, missing };
}

/** Absolute `[start, end)` spans of every string / template literal, so an
 *  `// mutation-allow:` that is really just literal CONTENT cannot suppress a
 *  site. */
function literalSpans(sourceFile) {
  const spans = [];
  const visit = (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateLiteral(node) ||
      ts.isRegularExpressionLiteral(node)
    ) {
      spans.push([node.getStart(sourceFile), node.getEnd()]);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return spans;
}

/** Splice `replacement` over `[start, end)` of `text`. */
function splice(text, start, end, replacement) {
  return text.slice(0, start) + replacement + text.slice(end);
}

/**
 * Enumerate every mutant for `text`.
 *
 * @param {string} fileName  Used only to pick the TS/JS script kind.
 * @param {string} text      Source.
 * @param {{symbols?: string[], operators?: string[]}} [opts]
 *        `symbols` scopes mutation to the named declarations (default: whole
 *        file). `operators` restricts the operator set (default: all).
 * @returns {{mutants: Array<{id, operator, line, original, mutated, source, allowed, allowReason}>,
 *            missingSymbols: string[]}}
 *        `mutants` excludes `mutation-allow`-suppressed sites; those are
 *        reported separately on each entry only when `allowed` is true, which
 *        the enumerator never emits — they are filtered here so a caller
 *        cannot forget to.
 */
export function enumerateMutants(fileName, text, opts = {}) {
  const operators = new Set(opts.operators ?? OPERATORS);
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(fileName),
  );

  let spans = null;
  let missingSymbols = [];
  if (opts.symbols && opts.symbols.length > 0) {
    const r = symbolSpans(sourceFile, opts.symbols);
    spans = r.spans;
    missingSymbols = r.missing;
  }
  const inScope = (pos) =>
    spans === null || spans.some(([s, e]) => pos >= s && pos < e);

  const lines = text.split("\n");
  const lineStarts = sourceFile.getLineStarts();
  const literals = literalSpans(sourceFile);
  const inLiteral = (pos) => literals.some(([s, e]) => pos >= s && pos < e);
  /** A site is suppressed by `// mutation-allow: <reason>` on its own line or
   *  the line immediately above it — provided the text is real source and not
   *  the contents of a string or template literal. */
  const allowanceFor = (lineNo /* 1-based */) => {
    for (const idx of [lineNo - 1, lineNo - 2]) {
      const candidate = lines[idx];
      const m = candidate?.match(ALLOW_RE);
      if (!m) continue;
      const abs = (lineStarts[idx] ?? 0) + m.index;
      if (inLiteral(abs)) continue;
      return m[1].trim();
    }
    return null;
  };

  const sites = [];
  const visit = (node) => {
    if (ts.isIfStatement(node) && inScope(node.getStart(sourceFile))) {
      const cond = node.expression;
      sites.push({
        start: cond.getStart(sourceFile),
        end: cond.getEnd(),
        original: cond.getText(sourceFile),
        variants: [
          ["force-false", (c) => `false && (${c})`],
          ["force-true", (c) => `true || (${c})`],
        ],
      });
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const args = node.arguments ?? [];
      const last = args[args.length - 1];
      if (
        args.length >= 2 &&
        last &&
        DROPPABLE_ARG_KINDS.has(last.kind) &&
        inScope(node.getStart(sourceFile))
      ) {
        sites.push({
          start: last.getStart(sourceFile),
          end: last.getEnd(),
          original: last.getText(sourceFile),
          variants: [["drop-last-arg", () => "undefined"]],
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  // Deterministic order: source position, then operator order. CI output that
  // reorders run-to-run is output nobody reads.
  sites.sort((a, b) => a.start - b.start);

  const mutants = [];
  const allowed = [];
  for (const site of sites) {
    const line = sourceFile.getLineAndCharacterOfPosition(site.start).line + 1;
    const allowReason = allowanceFor(line);
    for (const [operator, apply] of site.variants) {
      if (!operators.has(operator)) continue;
      const entry = {
        id: `${operator}@${line}`,
        operator,
        line,
        original: site.original,
        mutated: apply(site.original),
        source: splice(text, site.start, site.end, apply(site.original)),
      };
      if (allowReason) allowed.push({ ...entry, allowReason });
      else mutants.push(entry);
    }
  }
  return { mutants, allowedMutants: allowed, missingSymbols };
}
