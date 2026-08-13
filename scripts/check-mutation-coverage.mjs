#!/usr/bin/env node
/**
 * Targeted mutation check — makes "did anything actually assert this?" a
 * command instead of a review ritual.
 *
 * Why this script exists
 * ----------------------
 * Release v0.21.8 shipped two PRs whose tests constrained nothing. Neither was
 * caught by CI; both were caught by a human running mutations BY HAND during
 * review, and one of them only after the release:
 *
 *   1. #4663 (`ca7d9b69`) — gateway approval-outcome eviction. Tier 2 of
 *      `selectEvictionVictim` (the age bound on `APPROVAL_OUTCOME_PROTECTION_MS`)
 *      was load-bearing and unasserted: neutralising the condition entirely left
 *      all 76 tests green. Tiers 2 and 3 pick the SAME index whenever the queue
 *      is in `ts`-ascending order, and every fixture was in order, so no test
 *      could tell them apart. Fixed in `2338c280` by adding the out-of-order
 *      case that discriminates them.
 *
 *   2. #4670 (`22e0a4d5`) — hostd `config_propose_edit`. The tests asserted the
 *      `env` argument handed to the injected `runReconcile` SEAM. Production
 *      never calls that seam: it calls the default closure, which passes the
 *      same variable POSITIONALLY to `runSwitchroom(args, extraEnv)` and ignores
 *      its own `env` parameter. Two independent references to one variable, so
 *      deleting the real spawn's argument left every seam-asserting test green.
 *      `src/host-control/server.ts:298-317` documents this; the test that
 *      finally pinned it is `tests/host-control/config-propose-edit.test.ts:1439`,
 *      which injects no seam and reads the variable out of the child's own
 *      environment.
 *
 * Two in one release is a pattern, and the pattern is not a code shape a linter
 * can see. NOTE for anyone reaching for `no-constant-condition`: neither
 * incident ever COMMITTED an `if (false && …)`. That string appears in this
 * repo only inside prose comments describing a mutation a reviewer applied
 * (`git show 2338c280`, `src/util/log-rotation.ts:641`,
 * `src/cli/rollout.test.ts:3027`) — a dead-guard lint would have been green
 * through both incidents. The defect is a MISSING ASSERTION, which is only
 * observable by perturbing production and watching the suite fail to notice.
 * So this automates exactly the perturbation the reviewers ran.
 *
 * What it does
 * ------------
 * For each entry in `scripts/mutation-targets.json` whose `file` or `tests`
 * the PR touched: enumerate a small set of source mutations (see
 * `scripts/mutation/operators.mjs`), apply each one, run only that entry's
 * scoped suite, and fail if any mutant leaves the suite green.
 *
 * Cost control — the reason this is worth having in `bun lint` at all:
 *   - CURATED targets, not "every changed file". Full mutation testing is far
 *     too slow for PR CI and drowns in equivalent mutants.
 *   - SYMBOL-SCOPED. `src/host-control/server.ts` is 6060 lines; entries name
 *     the function, not the module.
 *   - DIFF-GATED. A PR that touches no target runs nothing at all. The one
 *     shipped target costs ~7s (4 mutants x ~1.7s scoped vitest).
 *   - THREE operators, each the literal edit a reviewer made on a real
 *     incident. No general mutation catalogue, no equivalent-mutant swamp.
 *
 * Usage
 * -----
 *   node scripts/check-mutation-coverage.mjs            # diff-gated (CI)
 *   node scripts/check-mutation-coverage.mjs --all      # every target
 *   node scripts/check-mutation-coverage.mjs --base main
 *
 * Ad-hoc (the reviewer tool this replaces the ritual with):
 *   node scripts/check-mutation-coverage.mjs --file src/foo.ts \
 *        --symbol bar --tests tests/foo.test.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runMutationTarget, formatSurvivors } from "./mutation/run.mjs";
import { arm, disarm, recover, SENTINEL_NAME } from "./mutation/restore-sentinel.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(REPO, "scripts", "mutation-targets.json");
const SENTINEL = join(REPO, SENTINEL_NAME);

/** Per-mutant wall-clock ceiling. A `force-true` on a loop guard can spin;
 *  a timeout is a KILL (the suite did not pass), never a survivor. */
const MUTANT_TIMEOUT_MS = 120_000;

function parseArgs(argv) {
  const out = { all: false, base: null, file: null, symbols: [], tests: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") out.all = true;
    else if (a === "--base") out.base = argv[++i];
    else if (a === "--file") out.file = argv[++i];
    else if (a === "--symbol") out.symbols.push(argv[++i]);
    else if (a === "--tests") out.tests.push(argv[++i]);
  }
  return out;
}

/** Files changed against the PR base, or null when no base is resolvable
 *  (push to main, local run, merge-queue ref). Null means "run everything". */
function changedFiles(base) {
  const ref = base ?? process.env.GITHUB_BASE_REF ?? null;
  if (!ref) return null;
  for (const spec of [`origin/${ref}...HEAD`, `${ref}...HEAD`]) {
    const r = spawnSync("git", ["diff", "--name-only", spec], {
      cwd: REPO,
      encoding: "utf8",
    });
    if (r.status === 0) {
      return new Set(r.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
    }
  }
  console.warn(
    `check-mutation-coverage: could not diff against "${ref}" — running ALL targets`,
  );
  return null;
}

function makeVitestRunner(testPaths) {
  return () => {
    const r = spawnSync(
      join(REPO, "node_modules", ".bin", "vitest"),
      ["run", "--reporter=dot", ...testPaths],
      {
        cwd: REPO,
        encoding: "utf8",
        timeout: MUTANT_TIMEOUT_MS,
        env: { ...process.env, CI: "1" },
      },
    );
    return {
      passed: r.status === 0,
      detail: `${r.stdout ?? ""}\n${r.stderr ?? ""}`.slice(-4000),
    };
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // Recover from a previous run that was killed mid-mutant, BEFORE reading any
  // source. Skipping this would make the next run mutate an already-mutated
  // file and then "restore" the mutant as if it were pristine.
  const recovered = recover(SENTINEL);
  if (recovered) {
    console.warn(
      `check-mutation-coverage: a previous run was killed — ` +
        (recovered.restored
          ? `RESTORED ${recovered.file}`
          : `${recovered.file} was already clean`),
    );
  }

  let targets;
  if (args.file) {
    if (args.tests.length === 0) {
      console.error("--file requires at least one --tests <path>");
      process.exit(2);
    }
    targets = [
      { file: args.file, symbols: args.symbols, tests: args.tests, why: "ad-hoc" },
    ];
  } else {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
    targets = manifest.targets;
    if (!args.all) {
      const changed = changedFiles(args.base);
      if (changed) {
        const before = targets.length;
        targets = targets.filter(
          (t) => changed.has(t.file) || t.tests.some((p) => changed.has(p)),
        );
        console.log(
          `check-mutation-coverage: ${targets.length}/${before} target(s) touched by this diff`,
        );
      }
    }
  }

  if (targets.length === 0) {
    console.log("check-mutation-coverage: no targets to run — OK");
    return;
  }

  let failed = false;
  for (const t of targets) {
    const abs = join(REPO, t.file);
    arm(SENTINEL, { file: t.file, path: abs, original: readFileSync(abs, "utf8") });
    console.log(
      `\ncheck-mutation-coverage: ${t.file}` +
        (t.symbols?.length ? ` [${t.symbols.join(", ")}]` : " [whole file]"),
    );
    let result;
    try {
      result = runMutationTarget({
        file: t.file,
        symbols: t.symbols,
        readSource: () => readFileSync(abs, "utf8"),
        writeSource: (text) => writeFileSync(abs, text, "utf8"),
        runTests: makeVitestRunner(t.tests),
        log: (m) => console.log(m),
      });
    } catch (err) {
      // A stale symbol, a red baseline or a zero-mutant target are HARD
      // failures, not survivors: each one would otherwise let the check report
      // a clean pass over logic it never actually perturbed. Report the cause
      // and keep going, so one broken entry does not hide another's survivors.
      failed = true;
      console.error(`\n  ${err instanceof Error ? err.message : err}`);
      continue;
    } finally {
      disarm(SENTINEL);
    }
    for (const a of result.allowed) {
      console.log(
        `  allowed   ${t.file}:${a.line}  ${a.operator} — ${a.allowReason}`,
      );
    }
    if (result.survivors.length > 0) {
      failed = true;
      console.error(
        `\n  ${result.survivors.length}/${result.total} mutant(s) SURVIVED in ${t.file}:\n` +
          `${formatSurvivors(result)}\n\n` +
          `  Each survivor is production logic no test distinguishes: the code was\n` +
          `  changed and "${t.tests.join(" ")}" stayed green. Why this target is\n` +
          `  curated: ${t.why}\n\n` +
          `  Fix by adding an assertion that FAILS on the mutated behaviour. If a\n` +
          `  survivor is genuinely equivalent (the mutation cannot change any\n` +
          `  observable), suppress it with "// mutation-allow: <reason>" on or above\n` +
          `  the line and argue the equivalence — the reason is mandatory.`,
      );
    } else {
      console.log(`  ${result.killed}/${result.total} mutants killed — OK`);
    }
  }

  if (failed) process.exit(1);
}

main();
