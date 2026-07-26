#!/usr/bin/env node
/**
 * check-agent-state-dir-hermeticity
 *
 * Lint gate for the "a unit test wrote into a LIVE agent's state dir" class,
 * sibling of `check-auth-test-hermeticity.mjs` and `check-vault-test-hermeticity.mjs`.
 *
 * ── The class ───────────────────────────────────────────────────────────
 *
 * The gateway's turn-record writer hard-coded `/state/agent/turns.jsonl`.
 * Inside a switchroom agent container that path is the bind-mounted production
 * `~/.switchroom/agents/<name>/turns.jsonl`, so a characterization test that
 * drove the real turn-end funnel appended synthetic rows — stamped with the
 * test's own `SWITCHROOM_AGENT_NAME` — straight into a live agent's production
 * turn record. The fleet-health L0 sensor read them back as real production
 * turns: 267 of 377 live silent-no-op candidates on 2026-07-26 were test
 * fixtures, so the top-priority ledger entry was measuring the test suite.
 *
 * ── What actually closes it ─────────────────────────────────────────────
 *
 * `tests/vitest-setup/agent-state-dir-guard.mjs` points every state-dir env
 * var at a per-process tmpdir when the test process has not chosen one. It is
 * loaded with NO per-file opt-in by BOTH runners:
 *
 *   vitest    `test.setupFiles` in vitest.config.ts
 *   bun test  `[test] preload` in bunfig.toml AND telegram-plugin/bunfig.toml
 *             (bun reads the bunfig in its CWD only, and this repo runs
 *             `bun test` from both directories — `npm run test:bun` from the
 *             root, CI's bun-test-run from telegram-plugin/)
 *
 * ── What this lint adds ─────────────────────────────────────────────────
 *
 * The guard is invisible when it works, so deleting any ONE of those four
 * wirings silently un-protects a whole runner and nothing goes red. This gate
 * fails on each of them, by name. The matching runtime alarms are
 * `tests/agent-state-dir-guard.test.ts` (vitest) and
 * `telegram-plugin/tests/agent-state-dir-preload.test.ts` (bun); this is the
 * fast, dependency-free signal that names the fix.
 *
 * Run: `npm run lint:agent-state-dir-hermeticity` (also part of `npm run lint`).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const GUARD_SETUP_FILE = "tests/vitest-setup/agent-state-dir-guard.mjs";
export const GUARD_CORE_FILE = "tests/vitest-setup/agent-state-dir-guard-core.mjs";
export const VITEST_CONFIG = "vitest.config.ts";
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
 * Run the check over a checkout. Pure apart from filesystem reads, so tests
 * can point it at a synthetic tmp repo root.
 */
export function checkRepo(repoRoot) {
  const failures = [];
  const fail = (kind, detail) => failures.push({ kind, detail });

  for (const f of [GUARD_SETUP_FILE, GUARD_CORE_FILE]) {
    if (!existsSync(join(repoRoot, f))) fail("missing-guard", `missing guard file: ${f}`);
  }

  // ── vitest wiring ──────────────────────────────────────────────────────
  const cfgPath = join(repoRoot, VITEST_CONFIG);
  if (!existsSync(cfgPath)) {
    fail("vitest-wiring", `missing ${VITEST_CONFIG}`);
  } else {
    const cfg = readFileSync(cfgPath, "utf8");
    // vitest accepts `setupFiles: "./x"` and `setupFiles: ["./x", …]`.
    const m = cfg.match(/setupFiles\s*:\s*(\[[\s\S]*?\]|["'`][^"'`]*["'`])/);
    if (!m) {
      fail("vitest-wiring", `${VITEST_CONFIG} has no \`setupFiles\` entry`);
    } else {
      const entries = stringLiterals(m[1]).map((e) => e.replace(/^\.\//, ""));
      if (!entries.includes(GUARD_SETUP_FILE)) {
        fail(
          "vitest-wiring",
          `${VITEST_CONFIG} \`setupFiles\` does not load ${GUARD_SETUP_FILE} ` +
            `(found: ${entries.length > 0 ? entries.join(", ") : "<empty>"})`,
        );
      }
    }
  }

  // ── bun wiring ─────────────────────────────────────────────────────────
  for (const { file, preload } of BUNFIGS) {
    const p = join(repoRoot, file);
    if (!existsSync(p)) {
      fail(
        "bun-wiring",
        `missing ${file} — \`bun test\` run from that directory loads no state-dir guard`,
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
  (process.argv[1] && process.argv[1].endsWith("check-agent-state-dir-hermeticity.mjs"));

if (isCli) {
  const result = checkRepo(process.cwd());
  if (result.ok) {
    process.stdout.write(
      `check-agent-state-dir-hermeticity: clean (guard loaded by vitest setupFiles ` +
        `and ${BUNFIGS.length} bunfig preloads)\n`,
    );
    process.exit(0);
  }

  process.stderr.write("check-agent-state-dir-hermeticity: violations:\n\n");
  for (const f of result.failures) process.stderr.write(`  [${f.kind}] ${f.detail}\n`);
  process.stderr.write(
    "\n" +
      "Unit tests must never write agent state into `/state/agent` — inside an\n" +
      "agent container that is a LIVE agent's bind-mounted state dir, and rows\n" +
      "written there are read back by the fleet-health sensor as that agent's\n" +
      "real production turns (356 foreign rows, 2026-07-26).\n\n" +
      "Restore the wiring:\n\n" +
      `  [vitest-wiring] ${VITEST_CONFIG}:\n` +
      `                    setupFiles: ["./${GUARD_SETUP_FILE}"],\n` +
      "  [bun-wiring]    bunfig.toml (repo root) and telegram-plugin/bunfig.toml:\n" +
      "                    [test]\n" +
      `                    preload = ["./${GUARD_SETUP_FILE}"]   (adjust the\n` +
      "                    relative path per bunfig location)\n",
  );
  process.exit(1);
}
