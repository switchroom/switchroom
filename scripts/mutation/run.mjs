/**
 * Mutation runner — apply/run/restore, with the process boundary injected.
 *
 * Split from `operators.mjs` (pure enumeration) and from
 * `check-mutation-coverage.mjs` (manifest + git diff gate) so the interesting
 * part — "a mutant the tests do not kill is a survivor" — is testable without
 * a repo, a manifest, or a vitest process. `runTests` is the seam.
 *
 * Failure modes it refuses to be silent about, because each one would turn the
 * guard itself vacuous:
 *
 *   - BASELINE RED. If the unmutated tests already fail, every mutant "dies"
 *     for the wrong reason and the check reports a clean pass over a suite that
 *     asserts nothing. Baseline is run first and a red baseline is a hard error.
 *   - NO MUTANTS. A `symbols` entry that no longer names anything (renamed
 *     function, moved file) silently reduces the target to zero mutants, which
 *     also passes. Zero mutants is a hard error, and unmatched symbols are
 *     named.
 *   - LOST SOURCE. The original text is restored in a `finally`, and the
 *     restore is verified, so an interrupted run cannot leave a mutant on disk.
 */

import { enumerateMutants } from "./operators.mjs";

/**
 * @typedef {object} MutationTargetResult
 * @property {string} file
 * @property {number} total      mutants run
 * @property {number} killed
 * @property {Array<{id,operator,line,original,mutated}>} survivors
 * @property {Array<{id,operator,line,allowReason}>} allowed  suppressed sites
 * @property {string[]} missingSymbols
 */

/**
 * Run every mutant for one target.
 *
 * @param {object} args
 * @param {string}   args.file         Repo-relative path (reporting only).
 * @param {string[]} [args.symbols]    Scope mutation to these declarations.
 * @param {string[]} [args.operators]  Restrict the operator set.
 * @param {() => string} args.readSource
 * @param {(text: string) => void} args.writeSource
 * @param {() => ({passed: boolean, detail?: string})} args.runTests
 * @param {(msg: string) => void} [args.log]
 * @returns {MutationTargetResult}
 */
export function runMutationTarget({
  file,
  symbols,
  operators,
  readSource,
  writeSource,
  runTests,
  log = () => {},
}) {
  const original = readSource();
  const { mutants, allowedMutants, missingSymbols } = enumerateMutants(
    file,
    original,
    { symbols, operators },
  );

  if (missingSymbols.length > 0) {
    throw new Error(
      `${file}: manifest names symbol(s) that do not exist: ` +
        `${missingSymbols.join(", ")}. A stale symbol silently reduces the ` +
        `target to zero mutants, which would pass.`,
    );
  }
  if (mutants.length === 0) {
    throw new Error(
      `${file}: enumerated 0 mutants` +
        (allowedMutants.length > 0
          ? ` (${allowedMutants.length} suppressed by mutation-allow)`
          : "") +
        `. A target that produces no mutants asserts nothing.`,
    );
  }

  const baseline = runTests();
  if (!baseline.passed) {
    throw new Error(
      `${file}: BASELINE IS RED — the scoped tests fail before any mutation. ` +
        `Every mutant would "die" for the wrong reason and this check would ` +
        `report a clean pass.\n${baseline.detail ?? ""}`,
    );
  }

  const survivors = [];
  let killed = 0;
  try {
    for (const m of mutants) {
      writeSource(m.source);
      const res = runTests();
      if (res.passed) {
        survivors.push({
          id: m.id,
          operator: m.operator,
          line: m.line,
          original: m.original,
          mutated: m.mutated,
        });
        log(`  SURVIVED  ${file}:${m.line}  ${m.operator}`);
      } else {
        killed++;
        log(`  killed    ${file}:${m.line}  ${m.operator}`);
      }
    }
  } finally {
    writeSource(original);
    if (readSource() !== original) {
      throw new Error(
        `${file}: FAILED TO RESTORE the original source after mutation. ` +
          `Check your working tree before committing.`,
      );
    }
  }

  return {
    file,
    total: mutants.length,
    killed,
    survivors,
    allowed: allowedMutants.map(({ id, operator, line, allowReason }) => ({
      id,
      operator,
      line,
      allowReason,
    })),
    missingSymbols,
  };
}

/** Human-readable report for one target's survivors. */
export function formatSurvivors(result) {
  const lines = [];
  for (const s of result.survivors) {
    lines.push(
      `  ${result.file}:${s.line}  [${s.operator}]\n` +
        `      was: ${truncate(s.original)}\n` +
        `      now: ${truncate(s.mutated)}`,
    );
  }
  return lines.join("\n");
}

function truncate(s, n = 140) {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}
