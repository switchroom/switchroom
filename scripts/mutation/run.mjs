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
 *   - A SHRINKING MUTANT SET. The operators only visit `if` statements and
 *     multi-arg calls, so a semantics-preserving refactor — the same branch
 *     rewritten as a ternary, a `&&` chain, a `switch`, a loop guard — yields
 *     FEWER mutants at the same site, and a smaller set of mutants that all
 *     die still reports a clean pass over logic nothing perturbed. Measured on
 *     this repo's one target: rewriting tier 2 of `selectEvictionVictim` as
 *     `findIndex` + `staleIdx >= 0 ? … : …`, with 2338c280's test additions
 *     reverted so the tier is genuinely unasserted, took the run from `4/4` to
 *     `2/2 mutants killed — OK` at exit 0. So each manifest entry records its
 *     expected mutant count (`mutants`) and a mismatch is a hard error — the
 *     same anti-drift shape as `scripts/check-gateway-line-ratchet.mjs`.
 *   - LOST SOURCE. The original text is restored in a `finally`, and the
 *     restore is verified, so an interrupted run cannot leave a mutant on disk.
 *   - A TIMED-OUT MUTANT SCORED AS KILLED. A suite that never finished returned
 *     no verdict. Folding that into `killed` reports green over a mutant that
 *     may be an unnoticed survivor which merely made the suite slow — a green
 *     for a reason unrelated to the assertions, which is the exact defect class
 *     this check exists to refuse. Timeouts go in their own `timedOut` bucket
 *     and the caller must fail on a non-empty one.
 *
 * What "killed" does and does NOT mean. A mutant is killed when the scoped
 * suite goes RED — which includes the suite CRASHING, e.g. `drop-last-arg`
 * producing a `TypeError` before any assertion runs. That is standard
 * mutation-testing semantics and it is the right default (a crash IS the suite
 * noticing), but "killed" is a weaker claim than "asserted": it says a test
 * noticed the change, not that a test describes the behaviour. A green run is
 * evidence the suite is not vacuous; it is not evidence the suite is complete.
 */

import { enumerateMutants } from "./operators.mjs";

/**
 * Classify one `spawnSync` result into the verdict `runMutationTarget` needs.
 *
 * Lives here rather than inline in the caller so it is unit-testable against a
 * REAL timed-out child instead of a hand-built object: the whole point is that
 * `status === 0` is not the only thing that matters, and a test asserting a
 * fabricated `{status: null, error: {code: 'ETIMEDOUT'}}` would be asserting
 * this function's own assumption about Node rather than Node's behaviour.
 *
 * `spawnSync` reports a `timeout:` expiry as `status: null`, `signal:
 * 'SIGTERM'` and `error.code: 'ETIMEDOUT'`. `signal` alone is not enough — a
 * suite that segfaults or is OOM-killed also lands there and IS a kill.
 *
 * @param {{status: number|null, error?: {code?: string}}} r
 * @returns {{passed: boolean, timedOut: boolean}}
 */
export function classifyRun(r) {
  const timedOut = r.error?.code === "ETIMEDOUT";
  return { passed: !timedOut && r.status === 0, timedOut };
}

/**
 * @typedef {object} MutationTargetResult
 * @property {string} file
 * @property {number} total      mutants run
 * @property {number} killed
 * @property {Array<{id,operator,line,original,mutated}>} survivors
 * @property {Array<{id,operator,line,original,mutated}>} timedOut  indeterminate
 *           — neither killed nor survived. `killed + survivors.length +
 *           timedOut.length === total`.
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
 * @param {number} [args.expectedMutants]  Recorded mutant count for this
 *        target. A mismatch (in EITHER direction) is a hard error: it is the
 *        only thing that catches a refactor which moves the logic to a site no
 *        operator visits. Omitted only on ad-hoc `--file` runs, which have no
 *        manifest entry to record it in.
 * @param {() => string} args.readSource
 * @param {(text: string) => void} args.writeSource
 * @param {() => ({passed: boolean, timedOut?: boolean, detail?: string})} args.runTests
 *        `timedOut` outranks `passed`: a run that never finished is
 *        indeterminate, not a verdict. Omit it and every run is a verdict,
 *        which is the pre-existing behaviour for the in-process seams.
 * @param {(msg: string) => void} [args.log]
 * @returns {MutationTargetResult}
 */
export function runMutationTarget({
  file,
  symbols,
  operators,
  expectedMutants,
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
  if (expectedMutants != null && mutants.length !== expectedMutants) {
    throw new Error(
      `${file}: MUTANT COUNT DRIFTED — the manifest records ${expectedMutants}, ` +
        `enumeration produced ${mutants.length}` +
        (allowedMutants.length > 0
          ? ` (+${allowedMutants.length} suppressed by mutation-allow)`
          : "") +
        `. A SHRINK is the dangerous direction and the reason this is checked: the ` +
        `operators only visit \`if\` statements and multi-arg calls, so rewriting the ` +
        `same branch as a ternary, an \`&&\`, a \`switch\` or a loop guard removes ` +
        `mutants from the site while every remaining mutant still dies — a clean pass ` +
        `over logic the check never perturbed. A GROWTH is usually benign but is not ` +
        `assumed. Either way: re-read the target, confirm the logic is still covered, ` +
        `and update "mutants" in scripts/mutation-targets.json in the SAME commit.`,
    );
  }

  const baseline = runTests();
  if (baseline.timedOut) {
    throw new Error(
      `${file}: BASELINE TIMED OUT — the scoped tests did not finish before any ` +
        `mutation was applied. Nothing below can be trusted: every mutant would ` +
        `time out too. The admission criteria require a hermetic, fast suite; ` +
        `see scripts/mutation-targets.json.\n${baseline.detail ?? ""}`,
    );
  }
  if (!baseline.passed) {
    throw new Error(
      `${file}: BASELINE IS RED — the scoped tests fail before any mutation. ` +
        `Every mutant would "die" for the wrong reason and this check would ` +
        `report a clean pass.\n${baseline.detail ?? ""}`,
    );
  }

  const survivors = [];
  const timedOut = [];
  let killed = 0;
  try {
    for (const m of mutants) {
      writeSource(m.source);
      const res = runTests();
      if (res.timedOut) {
        // INDETERMINATE, and kept out of both counts on purpose. The suite
        // neither passed nor asserted anything — it never finished. Scoring it
        // a kill (the original behaviour) turns "the mutation made the suite
        // slow" into a green verdict over a mutant nothing may have noticed,
        // which is a green for a reason unrelated to the assertions; scoring
        // it a survivor accuses a suite that may cover the behaviour perfectly
        // well. So it is neither, and the caller must fail on it.
        timedOut.push({
          id: m.id,
          operator: m.operator,
          line: m.line,
          original: m.original,
          mutated: m.mutated,
        });
        log(`  TIMED OUT ${file}:${m.line}  ${m.operator}`);
      } else if (res.passed) {
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
    timedOut,
    allowed: allowedMutants.map(({ id, operator, line, allowReason }) => ({
      id,
      operator,
      line,
      allowReason,
    })),
    missingSymbols,
  };
}

/** Human-readable `file:line [operator] was:/now:` block for a list of
 *  mutants — survivors or timeouts, both need the same rendering. */
export function formatMutants(file, mutants) {
  const lines = [];
  for (const s of mutants) {
    lines.push(
      `  ${file}:${s.line}  [${s.operator}]\n` +
        `      was: ${truncate(s.original)}\n` +
        `      now: ${truncate(s.mutated)}`,
    );
  }
  return lines.join("\n");
}

/** Human-readable report for one target's survivors. */
export function formatSurvivors(result) {
  return formatMutants(result.file, result.survivors);
}

function truncate(s, n = 140) {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}
