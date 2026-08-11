#!/usr/bin/env node
/**
 * check-parked-turn-start-hermeticity
 *
 * Lint gate for the "a bun test file leaked module-scope gateway state into the
 * next file" class, sibling of `check-agent-state-dir-hermeticity.mjs` and
 * `check-hindsight-bank-hermeticity.mjs`.
 *
 * ── The class ───────────────────────────────────────────────────────────
 *
 * `parkedTurnStarts` (telegram-plugin/gateway/stream-render.ts) is module-scope
 * by design — it mirrors the ONE claude CLI session's ONE queue. `bun test`
 * runs all ~657 telegram-plugin files in ONE process with ONE module registry,
 * so a file that EXITS with an entry still parked has changed global state for
 * every file after it. `gateway/obligation-wiring.ts` folds the parked count
 * into `sessionBusy`, so the leftover makes the obligation sweep treat an idle
 * session as busy for the rest of the run.
 *
 * On 2026-08-11 (#4611) that leak — `tests/queued-card-surface.test.ts` resetting
 * in `beforeEach` only, its last case parking msg 502 and never draining — failed
 * `tests/represent-guard.test.ts`'s "does NOT defer when the session is idle" and
 * ejected two unrelated PRs from the merge queue. It was intermittent only
 * because `bun test` file order is not stable across checkouts.
 *
 * ── What actually closes it ─────────────────────────────────────────────
 *
 * `tests/vitest-setup/parked-turn-start-guard.mjs` registers a global
 * `afterEach` that fails the LEAKING test (and resets the store, so one
 * actionable failure replaces an ~1800-deep cascade). It is loaded with NO
 * per-file opt-in by every `bun test` invocation this repo makes:
 *
 *   bunfig.toml                 `npm run test:bun`, run from the repo root
 *   telegram-plugin/bunfig.toml CI's bun-test-run, via
 *                               telegram-plugin/scripts/bun-test-ci.sh
 *
 * (bun reads the bunfig in its CWD only, never an ancestor's — hence two.)
 *
 * Unlike its siblings this guard has no vitest counterpart: it needs
 * `bun:test`'s lifecycle registry, and the suites that drive the parked store
 * run on the bun side.
 *
 * ── What this lint adds ─────────────────────────────────────────────────
 *
 * The guard is invisible when it works, so deleting either wiring silently
 * un-protects a whole runner and nothing goes red. This gate fails on each of
 * them, by name.
 *
 * Run: `npm run lint:parked-turn-start-hermeticity` (also part of `npm run lint`).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const GUARD_SETUP_FILE = "tests/vitest-setup/parked-turn-start-guard.mjs";
/** The module whose store the guard reads — the guard is dead weight without it. */
export const GUARDED_MODULE = "telegram-plugin/gateway/stream-render.ts";
/** Every bunfig a `bun test` invocation in this repo can pick up, with the
 *  guard path as written from THAT file's directory. */
export const BUNFIGS = [
  { file: "bunfig.toml", preload: `./${GUARD_SETUP_FILE}` },
  { file: "telegram-plugin/bunfig.toml", preload: `../${GUARD_SETUP_FILE}` },
];

/** Quoted string literals inside a config fragment. */
function stringLiterals(text) {
  return [...text.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
}

/**
 * Run the check over a checkout. Pure apart from filesystem reads, so tests can
 * point it at a synthetic tmp repo root.
 */
export function checkRepo(repoRoot) {
  const failures = [];
  const fail = (kind, detail) => failures.push({ kind, detail });

  if (!existsSync(join(repoRoot, GUARD_SETUP_FILE))) {
    fail("missing-guard", `missing guard file: ${GUARD_SETUP_FILE}`);
  }

  // The reset seam is what the guard (and every suite that drives the store)
  // calls. If it is renamed away, the guard silently stops compiling in.
  const guardedPath = join(repoRoot, GUARDED_MODULE);
  if (!existsSync(guardedPath)) {
    fail("missing-seam", `missing guarded module: ${GUARDED_MODULE}`);
  } else {
    const src = readFileSync(guardedPath, "utf8");
    for (const seam of ["__resetParkedTurnStartsForTest", "__parkedTurnStartCountForTest"]) {
      if (!src.includes(`export function ${seam}`)) {
        fail("missing-seam", `${GUARDED_MODULE} no longer exports \`${seam}\``);
      }
    }
  }

  // ── bun wiring ─────────────────────────────────────────────────────────
  for (const { file, preload } of BUNFIGS) {
    const p = join(repoRoot, file);
    if (!existsSync(p)) {
      fail(
        "bun-wiring",
        `missing ${file} — \`bun test\` run from that directory loads no parked-turn-start guard`,
      );
      continue;
    }
    const toml = readFileSync(p, "utf8");
    const m = toml.match(/^\s*preload\s*=\s*(\[[\s\S]*?\]|["'][^"']*["'])/m);
    if (!m) {
      fail("bun-wiring", `${file} has no \`preload\` entry`);
      continue;
    }
    const entries = stringLiterals(m[1]);
    if (!entries.includes(preload)) {
      fail(
        "bun-wiring",
        `${file} \`preload\` does not load ${preload} ` +
          `(found: ${entries.length > 0 ? entries.join(", ") : "<empty>"})`,
      );
    }
  }

  return { ok: failures.length === 0, failures };
}

// ─── CLI entry ───────────────────────────────────────────────────────────────

const isCli =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] && process.argv[1].endsWith("check-parked-turn-start-hermeticity.mjs"));

if (isCli) {
  const result = checkRepo(process.cwd());
  if (result.ok) {
    process.stdout.write(
      `check-parked-turn-start-hermeticity: clean (guard loaded by ${BUNFIGS.length} bunfig preloads)\n`,
    );
    process.exit(0);
  }

  process.stderr.write("check-parked-turn-start-hermeticity: violations:\n\n");
  for (const f of result.failures) process.stderr.write(`  [${f.kind}] ${f.detail}\n`);
  process.stderr.write(
    "\n" +
      "`bun test` runs the whole telegram-plugin suite in ONE process, so a file\n" +
      "that exits with a parked turn-start still in stream-render's module-scope\n" +
      "store makes every later file read the CLI session as busy. #4611 ejected\n" +
      "two PRs from the merge queue that way, with byte-identical retries passing.\n\n" +
      "Restore the wiring:\n\n" +
      "  [bun-wiring]  bunfig.toml (repo root) and telegram-plugin/bunfig.toml:\n" +
      "                  [test]\n" +
      `                  preload = ["./${GUARD_SETUP_FILE}"]   (adjust the\n` +
      "                  relative path per bunfig location)\n",
  );
  process.exit(1);
}
