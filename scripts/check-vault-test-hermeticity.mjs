#!/usr/bin/env node
/**
 * check-vault-test-hermeticity
 *
 * Static lint gate (regression-proof, #1561) against the broker-test
 * hermeticity class that caused the 2026-05-20 incident on the
 * operator's shared production-treated host:
 *
 *   `src/vault/broker/server-grants.test.ts:149` exercised the broker's
 *   `mint_grant` path, which writes the token file at
 *   `os.homedir() + "/.switchroom/agents/<agent>/.vault-token"`. Without
 *   a HOME override in the test, `os.homedir()` resolved to the
 *   operator's real home — creating fixture-named agent dirs (`myagent`,
 *   `agent1`, `uat-agent`, …) directly in `~/.switchroom/agents/`, and
 *   the related broker startup path also rewrote
 *   `~/.switchroom/vault/vault.enc` as a fresh empty vault. The live
 *   broker was then permanently locked (real passphrase wouldn't open
 *   the empty file) and the fleet's vault-dependent paths went dark for
 *   hours. Recovery was a manual restore from
 *   `vault.enc.divergent.bak` (the May-11 migration backup).
 *
 *   22 pre-existing fixture-named dirs in `~/.switchroom/agents/`
 *   (a, alice, alpha, b, bob, c, carol, …) proved this had been a
 *   chronic class for weeks before today — silently latent because the
 *   prior contamination wrote to dirs but didn't (until now) overwrite
 *   the live vault.enc.
 *
 * Rule enforced by this lint:
 *
 *   Any test file under `src/vault/**` that LITERALLY references
 *   `os.homedir()` (or a literal `~/.switchroom` string) MUST also set
 *   `process.env.HOME` somewhere in the file (i.e. override HOME to a
 *   tmpdir for the duration of the test). Tests that only construct
 *   paths inside a `mkdtempSync(...)` tmpdir — without ever invoking
 *   `os.homedir()` — are unaffected (they were already hermetic).
 *
 * Belt-and-suspenders rationale: a structural lint gate catches a
 * future test that re-introduces the pattern at CI time, before it can
 * land on the host. It is intentionally narrow — it does not try to
 * detect every possible non-hermetic path, just the proven-load-bearing
 * one. A future runtime-side gate in the broker itself (refuse to
 * start in test mode when HOME isn't a tmpdir) is a follow-up.
 *
 * Usable from both CLI (npm run lint chain) and from vitest tests
 * (import { checkFile, checkRepo } from './check-vault-test-hermeticity.mjs').
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Filenames the static gate must cover. */
const TEST_GLOB_ROOT = "src/vault";
const TEST_SUFFIX = ".test.ts";

/**
 * Path (relative to repo root) of the legacy-offender allowlist.
 * Lines: one repo-relative test path per line; lines starting with `#`
 * and blank lines are ignored. Listed files are EXEMPT from the gate
 * — they're known offenders to be fixed in follow-up work.
 *
 * Mandate: the goal is **zero** entries. Do NOT add new entries to
 * paper over a fresh regression; fix the test instead. Each removed
 * entry is a closed prod-risk.
 */
const ALLOWLIST_PATH = "scripts/check-vault-test-hermeticity-allowlist.txt";

function loadAllowlist(repoRoot) {
  const p = join(repoRoot, ALLOWLIST_PATH);
  if (!existsSync(p)) return new Set();
  const lines = readFileSync(p, "utf8").split("\n");
  const set = new Set();
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.length > 0) set.add(line);
  }
  return set;
}

/**
 * Patterns that resolve to the operator's REAL home (the hermeticity
 * risk surface). Detect substrings; we don't need a full AST — the
 * patterns are unambiguous enough in TypeScript source.
 */
const HOME_RESOLUTION_PATTERNS = [
  /\bos\.homedir\s*\(/,         // `os.homedir(`
  /\bhomedir\s*\(/,             // bare `homedir(` (imported as named)
  /["']~\/\.switchroom/,        // literal "~/.switchroom" or '~/.switchroom'
];

/**
 * Patterns that prove the test overrides HOME to a tmpdir — the
 * mitigation. Any of these in the file marks the test as hermetic.
 *
 * The `=` here is intentional (assignment, not equality). We allow both
 * `process.env.HOME = ...` and the destructuring/spread forms.
 *
 * NOTE: `process.env.HOME = tmpDir` does NOT actually isolate anything —
 * `os.homedir()` is cached by the Node/bun runtime at process start and
 * does not reread `process.env.HOME` afterward (confirmed empirically).
 * The reliable override honored by `resolveAgentsDir()` (which the
 * broker's mint_grant/revoke_grant token-write paths call) is
 * `process.env.SWITCHROOM_AGENTS_DIR`. Kept HOME here for legacy-pattern
 * detection so old offenders still get flagged if they lose their (inert)
 * mitigation comment; new tests should use SWITCHROOM_AGENTS_DIR instead.
 */
const HOME_OVERRIDE_PATTERNS = [
  /\bprocess\.env\.HOME\s*=/,                // direct assignment (legacy — does not actually isolate os.homedir())
  /\bprocess\.env\.SWITCHROOM_AGENTS_DIR\s*=/, // the reliable override honored by resolveAgentsDir()
  /\bsetEnv\s*\(\s*["']HOME["']/,            // a helper like setEnv("HOME", ...)
];

/**
 * Inspect one file's source. Pure — takes the source text + the file
 * path (for the error message) and returns a verdict.
 *
 * Returns `{ ok: true }` when the file is either irrelevant (no
 * home-resolution patterns) or correctly mitigated. Returns
 * `{ ok: false, file, matched }` with the matched home-resolution
 * substring when the file resolves HOME but doesn't override it.
 */
/**
 * Strip TS/JS line + block comments so the pattern matchers don't
 * fire on documentation text like `// the broker writes to
 * ~/.switchroom/...`. We DO want to detect literal strings, so this is
 * a comments-only strip — not a strings-only strip — and is a regex
 * approximation (good enough; the lint is best-effort gating, not a
 * compiler). Order matters: strip block comments first so the line-
 * comment pass doesn't false-match a `//` inside a block-comment body.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

export function checkFile(filePath, source) {
  // Allow opt-out via an explicit per-file marker, for cases where the
  // test is INTENTIONALLY exercising the resolution path (e.g., a future
  // dedicated regression test for the broker's own homedir guard). The
  // marker must be a comment so it's grep-visible to reviewers.
  // (The marker is checked BEFORE the comment strip so it remains
  // grep-visible while still working as an opt-out.)
  if (/SWITCHROOM_HERMETICITY_LINT:\s*allow-real-home/.test(source)) {
    return { ok: true, file: filePath, reason: "explicit opt-out marker" };
  }

  // Pattern matching uses the comment-stripped source so doc text and
  // `//`-prose can describe the patterns without false-flagging.
  const stripped = stripComments(source);

  const homeMatch = HOME_RESOLUTION_PATTERNS.find((re) => re.test(stripped));
  if (!homeMatch) {
    return { ok: true, file: filePath, reason: "no real-home resolution" };
  }

  const mitigated = HOME_OVERRIDE_PATTERNS.some((re) => re.test(stripped));
  if (mitigated) {
    return { ok: true, file: filePath, reason: "HOME override present" };
  }

  const matchedText =
    stripped.match(homeMatch)?.[0] ?? "(unknown home-resolution pattern)";
  return { ok: false, file: filePath, matched: matchedText };
}

/** Walk `src/vault/` and return every `*.test.ts` file. */
function findVaultTestFiles(repoRoot) {
  const root = join(repoRoot, TEST_GLOB_ROOT);
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
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        walk(p);
      } else if (e.isFile() && p.endsWith(TEST_SUFFIX)) {
        out.push(p);
      }
    }
  };
  try {
    if (statSync(root).isDirectory()) walk(root);
  } catch {
    // src/vault/ missing → nothing to check
  }
  return out;
}

/**
 * Run the check over an entire repo checkout. Returns `{ ok, failures }`
 * where `failures` is the list of `checkFile` failure objects. Pure
 * apart from filesystem reads — useful from vitest tests by passing a
 * tmp repo root.
 */
export function checkRepo(repoRoot) {
  const files = findVaultTestFiles(repoRoot);
  const allowlist = loadAllowlist(repoRoot);
  const failures = [];
  const allowed = [];
  for (const file of files) {
    const rel = relative(repoRoot, file);
    const source = readFileSync(file, "utf8");
    const v = checkFile(file, source);
    if (!v.ok) {
      if (allowlist.has(rel)) {
        allowed.push({ ...v, relPath: rel });
      } else {
        failures.push(v);
      }
    }
  }
  return {
    ok: failures.length === 0,
    failures,
    allowed,
    scanned: files.length,
    allowlistSize: allowlist.size,
  };
}

// ─── CLI entry ───────────────────────────────────────────────────────────────

const isCli =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] && process.argv[1].endsWith("check-vault-test-hermeticity.mjs"));

if (isCli) {
  const repoRoot = process.cwd();
  const result = checkRepo(repoRoot);
  if (result.ok) {
    const allowed = result.allowed.length;
    const allowedSuffix = allowed > 0
      ? ` — ${allowed} legacy offender${allowed === 1 ? "" : "s"} on the shrink-to-zero allowlist (${ALLOWLIST_PATH})`
      : "";
    process.stdout.write(
      `check-vault-test-hermeticity: clean (${result.scanned} vault test files scanned)${allowedSuffix}\n`,
    );
    process.exit(0);
  }

  process.stderr.write(
    "check-vault-test-hermeticity: hermeticity violations:\n\n",
  );
  for (const f of result.failures) {
    process.stderr.write(
      `  ${relative(repoRoot, f.file)}\n` +
      `    matched ${JSON.stringify(f.matched)} but no \`process.env.HOME = …\` override\n`,
    );
  }
  process.stderr.write(
    "\n" +
    "Each flagged test resolves the operator's REAL home through `os.homedir()`\n" +
    "(or a literal `~/.switchroom` string) without an isolation override.\n" +
    "On a shared production-treated host this corrupts `~/.switchroom/agents/`\n" +
    "and, transitively, `vault/vault.enc` — incident 2026-05-20. Fix: in the\n" +
    "test's `beforeEach` (BEFORE `broker.start()`), set SWITCHROOM_AGENTS_DIR\n" +
    "to a tmpdir — this is the override actually honored by resolveAgentsDir()\n" +
    "(unlike `process.env.HOME`, which os.homedir() does not reread after\n" +
    "process start):\n\n" +
    "    const prevAgentsDirEnv = process.env.SWITCHROOM_AGENTS_DIR;\n" +
    "    process.env.SWITCHROOM_AGENTS_DIR = path.join(tmpDir, \"agents\");\n\n" +
    "and restore in `afterEach`. If the test is INTENTIONALLY exercising the\n" +
    "real-home resolution (rare — usually a dedicated guard regression test),\n" +
    "add a comment containing `SWITCHROOM_HERMETICITY_LINT: allow-real-home`\n" +
    "to opt out per-file with a reviewer-visible justification.\n",
  );
  process.exit(1);
}
