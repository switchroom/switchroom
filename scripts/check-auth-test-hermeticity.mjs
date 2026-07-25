#!/usr/bin/env node
/**
 * check-auth-test-hermeticity
 *
 * Lint gate for the auth-broker live-probe flake class (#3612), sibling of
 * `check-vault-test-hermeticity.mjs`.
 *
 * ── The class ───────────────────────────────────────────────────────────
 *
 * `AuthBroker` awaits a LIVE quota probe inside request paths that the
 * broker test harnesses deadline at 3s:
 *
 *   markExhaustedAndRoll (src/auth/broker/server.ts)
 *     → nextHealthyAccountLive → probeAndCacheOne → fetchQuota
 *
 * `fetchQuota`'s default abort is 10s (src/auth/quota.ts). A broker
 * constructed in a unit test without the `_testFetchQuota` seam is
 * therefore latency-bound on api.anthropic.com — green when the runner's
 * egress fails fast, `Error: rpc timeout` when it doesn't. It went red on
 * main twice (PR #3609, PR #3613); both fixes were per-file, and the class
 * regrew because nothing stopped the next construction.
 *
 * ── What actually closes it ─────────────────────────────────────────────
 *
 * `tests/vitest-setup/auth-net-guard.mjs`, wired as `test.setupFiles` in
 * vitest.config.ts, replaces `globalThis.fetch` with a rejecting stub for
 * every vitest test file that can reach `fetchQuota` — no per-file opt-in,
 * so a NEW broker test is hermetic the day it lands.
 *
 * ── What this lint adds ─────────────────────────────────────────────────
 *
 * The guard is invisible when it works, so two things could silently
 * un-protect the suites. This gate fails on both:
 *
 *   1. WIRING — `test.setupFiles` in vitest.config.ts no longer loads the
 *      guard, or the guard/core files are gone. (The runtime alarm for
 *      this is src/auth/broker/net-hermeticity.test.ts; this is the fast,
 *      dependency-free signal that names the fix.)
 *
 *   2. COVERAGE GAP — a test file that CAN reach `fetchQuota` sits in
 *      vitest.config.ts's `exclude` list (i.e. it runs under `bun test`,
 *      or not at all). A vitest setup file never loads for those, so such
 *      a file is outside the guard entirely and must prove hermeticity
 *      another way (inject `fetchImpl` / `_testFetchQuota`, or take an
 *      allowlist entry with a justification).
 *
 * Reachability is decided by `shouldGuardSource` from the guard's own core
 * module — the lint and the runner share ONE implementation, so they can
 * never disagree about which files must be hermetic. It is not a grep for
 * a marker string in the test files: a file is flagged because it
 * constructs an `AuthBroker` or calls `fetchQuota`, i.e. because it has a
 * real path to the network, and it is cleared because the runner provably
 * loads a guard for it.
 *
 * Allowlist: `scripts/check-auth-test-hermeticity-allowlist.txt`
 * (shrink-to-zero, same convention as the vault gate).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

const GUARD_SETUP_FILE = "tests/vitest-setup/auth-net-guard.mjs";
const GUARD_CORE_FILE = "tests/vitest-setup/auth-net-guard-core.mjs";
const VITEST_CONFIG = "vitest.config.ts";
const ALLOWLIST_PATH = "scripts/check-auth-test-hermeticity-allowlist.txt";
const TEST_SUFFIX = ".test.ts";
// Only skip what can never hold a first-party vitest suite. `dist/` is
// build output; dot-dirs (notably `.claude/worktrees/`, stale sub-agent
// checkout copies) are skipped in the walk. Nothing else is skipped: a
// reachable test hiding in an unexpected directory is exactly what this
// gate exists to find.
const SKIP_DIRS = new Set(["node_modules", "dist"]);

function toPosix(p) {
  return p.split(sep).join("/");
}

function loadAllowlist(repoRoot) {
  const p = join(repoRoot, ALLOWLIST_PATH);
  if (!existsSync(p)) return new Set();
  const set = new Set();
  for (const raw of readFileSync(p, "utf8").split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.length > 0) set.add(line);
  }
  return set;
}

/** Every `*.test.ts` in the checkout, repo-relative and posix-normalised. */
function findTestFiles(repoRoot) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        walk(p);
      } else if (e.isFile() && p.endsWith(TEST_SUFFIX)) {
        out.push(toPosix(relative(repoRoot, p)));
      }
    }
  };
  try {
    if (statSync(repoRoot).isDirectory()) walk(repoRoot);
  } catch {
    /* nothing to scan */
  }
  return out.sort();
}

/**
 * Is the guard loaded by vitest? Reads the `setupFiles` entry out of
 * vitest.config.ts textually — the config is a TS module this plain-node
 * script cannot import, so the check is: a `setupFiles` array exists and
 * one of its entries resolves to the guard file.
 */
function checkWiring(repoRoot) {
  const problems = [];
  for (const f of [GUARD_SETUP_FILE, GUARD_CORE_FILE]) {
    if (!existsSync(join(repoRoot, f))) problems.push(`missing guard file: ${f}`);
  }
  const cfgPath = join(repoRoot, VITEST_CONFIG);
  if (!existsSync(cfgPath)) {
    problems.push(`missing ${VITEST_CONFIG}`);
    return problems;
  }
  const cfg = readFileSync(cfgPath, "utf8");
  // vitest accepts both `setupFiles: "./x"` and `setupFiles: ["./x"]`.
  // Match either, so a legal config never trips a false wiring failure.
  const m = cfg.match(/setupFiles\s*:\s*(\[[\s\S]*?\]|["'`][^"'`]*["'`])/);
  if (!m) {
    problems.push(`${VITEST_CONFIG} has no \`setupFiles\` entry`);
    return problems;
  }
  const entries = [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((e) =>
    e[1].replace(/^\.\//, ""),
  );
  if (!entries.includes(GUARD_SETUP_FILE)) {
    problems.push(
      `${VITEST_CONFIG} \`setupFiles\` does not load ${GUARD_SETUP_FILE} ` +
        `(found: ${entries.length > 0 ? entries.join(", ") : "<empty>"})`,
    );
  }
  return problems;
}

/**
 * Convert one vitest `exclude` glob to a RegExp over repo-relative posix
 * paths. `**` spans separators; a `**` + `/` segment is OPTIONAL so
 * `**` + `/src/x.test.ts` matches `src/x.test.ts` at the repo root (that
 * is how vitest resolves it, and getting it wrong makes this gate silently
 * inert — pinned by tests/check-auth-test-hermeticity.test.ts). A single
 * `*` does not cross a separator.
 */
function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") { out += "(?:.*/)?"; i += 2; } else { out += ".*"; i += 1; }
      } else {
        out += "[^/]*";
      }
    } else if (".+^${}()|[]\\?".includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Predicate: "vitest does not run this file", i.e. it matches one of the
 * `exclude` globs in vitest.config.ts. Those files run under `bun test`
 * (or not at all) and a vitest setup file never loads for them — so the
 * guard cannot protect them, whatever the file itself looks like.
 *
 * Glob support is deliberately minimal — see `globToRegExp`.
 */
function makeVitestExcludedPredicate(repoRoot) {
  const cfgPath = join(repoRoot, VITEST_CONFIG);
  if (!existsSync(cfgPath)) return () => false;
  const cfg = readFileSync(cfgPath, "utf8");
  const m = cfg.match(/\bexclude\s*:\s*\[([\s\S]*?)\n\s*\]/);
  if (!m) return () => false;
  const globs = [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((e) => e[1]);
  const regexes = globs.map(globToRegExp);
  return (rel) => regexes.some((re) => re.test(rel));
}

/**
 * Run the check over a checkout. Pure apart from filesystem reads, so
 * tests can point it at a synthetic tmp repo root.
 */
export async function checkRepo(repoRoot) {
  const wiring = checkWiring(repoRoot);
  const failures = wiring.map((detail) => ({ kind: "wiring", detail }));

  let shouldGuardSource;
  const corePath = join(repoRoot, GUARD_CORE_FILE);
  if (existsSync(corePath)) {
    ({ shouldGuardSource } = await import(pathToFileURL(corePath).href));
  }

  const allowlist = loadAllowlist(repoRoot);
  const isVitestExcluded = makeVitestExcludedPredicate(repoRoot);
  const files = findTestFiles(repoRoot);
  const allowed = [];
  let reachable = 0;

  if (shouldGuardSource) {
    for (const rel of files) {
      let source;
      try {
        source = readFileSync(join(repoRoot, rel), "utf8");
      } catch {
        continue;
      }
      if (!shouldGuardSource(source)) continue;
      reachable += 1;
      if (!isVitestExcluded(rel)) continue; // vitest-run → covered by the guard
      const entry = {
        kind: "outside-vitest",
        file: rel,
        detail:
          "reaches `fetchQuota` but is excluded from the vitest run " +
          "(vitest.config.ts `exclude`), so the setup-file guard never loads " +
          "for it",
      };
      if (allowlist.has(rel)) allowed.push(entry);
      else failures.push(entry);
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    allowed,
    scanned: files.length,
    reachable,
    allowlistSize: allowlist.size,
  };
}

// ─── CLI entry ───────────────────────────────────────────────────────────────

const isCli =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] && process.argv[1].endsWith("check-auth-test-hermeticity.mjs"));

if (isCli) {
  const result = await checkRepo(process.cwd());
  if (result.ok) {
    const suffix =
      result.allowed.length > 0
        ? ` — ${result.allowed.length} on the shrink-to-zero allowlist (${ALLOWLIST_PATH})`
        : "";
    process.stdout.write(
      `check-auth-test-hermeticity: clean (${result.reachable} of ${result.scanned} ` +
        `test files can reach fetchQuota; all guarded)${suffix}\n`,
    );
    process.exit(0);
  }

  process.stderr.write("check-auth-test-hermeticity: hermeticity violations:\n\n");
  for (const f of result.failures) {
    process.stderr.write(`  [${f.kind}] ${f.file ? `${f.file}: ` : ""}${f.detail}\n`);
  }
  process.stderr.write(
    "\n" +
      "Auth-broker unit tests must never reach api.anthropic.com. `AuthBroker`\n" +
      "force-probes candidate accounts through `fetchQuota` (10s default abort)\n" +
      "inside request paths the harnesses deadline at 3s, so an unguarded test is\n" +
      "a pure-latency CI coin flip — `Error: rpc timeout` (#3609, #3612, #3613).\n\n" +
      "Fixes, in order of preference:\n\n" +
      `  [wiring]         restore the guard in ${VITEST_CONFIG}:\n` +
      `                     setupFiles: ["./${GUARD_SETUP_FILE}"],\n` +
      "  [outside-vitest] inject the seam in the bun-run file itself —\n" +
      "                     `fetchQuota({ …, fetchImpl })` or\n" +
      "                     `new AuthBroker(cfg, { …, _testFetchQuota })`\n" +
      `                   — or add the path to ${ALLOWLIST_PATH} with a\n` +
      "                     one-line justification.\n",
  );
  process.exit(1);
}
