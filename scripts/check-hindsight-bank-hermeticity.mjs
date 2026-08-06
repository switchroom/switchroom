#!/usr/bin/env node
/**
 * check-hindsight-bank-hermeticity
 *
 * Lint gate for the "a test run minted banks in the LIVE Hindsight" class,
 * sibling of `check-agent-state-dir-hermeticity.mjs`,
 * `check-auth-test-hermeticity.mjs` and `check-vault-test-hermeticity.mjs`.
 *
 * ── The class ───────────────────────────────────────────────────────────
 *
 * On 2026-07-30T23:51-23:55Z a harness/parity sweep minted ELEVEN throwaway
 * banks in the fleet's live Hindsight — `probe`, `general`, `gamma`,
 * `test-agent`, `memory-agent`, five `parity-*`, and `clerk`. All are
 * switchroom test-fixture agent names. They landed in production because the
 * fleet endpoint is a fixed localhost port (18888) that every agent container
 * also exports as `HINDSIGHT_API_URL`, so a test process reaches it by
 * default.
 *
 * `clerk` collided with a live agent. Agent `clerk` writes to the bank
 * `assistant` (86,240 facts); the empty decoy `clerk` bank held a warning
 * annotation in its `mission` saying so, precisely so nobody would mistake it
 * for lost memory. The sweep erased that annotation, and a week later an agent
 * read the empty bank and reported clerk's memory as lost.
 *
 * Hindsight auto-creates a bank on miss and returns zeros
 * (`get_or_create_bank_profile` in engine/retain/bank_utils.py,
 * `ensure_bank_exists` in engine/retain/fact_storage.py) — there is no
 * missing-bank error. So deleting a stray does not fix it: the next lookup of
 * that name recreates it. Only stopping the request works.
 *
 * ── What actually closes it ─────────────────────────────────────────────
 *
 * `tests/vitest-setup/hindsight-bank-guard.mjs` scrubs the ambient Hindsight
 * URL env vars and rejects any `fetch` to a fleet Hindsight origin. It is
 * loaded with NO per-file opt-in by BOTH runners:
 *
 *   vitest    `test.setupFiles` in vitest.config.ts
 *   bun test  `[test] preload` in bunfig.toml AND telegram-plugin/bunfig.toml
 *             (bun reads the bunfig in its CWD only, and this repo runs
 *             `bun test` from both directories)
 *
 * ── What this lint adds ─────────────────────────────────────────────────
 *
 * The guard is invisible when it works, so deleting any ONE of those four
 * wirings silently un-protects a whole runner and nothing goes red. This gate
 * fails on each of them, by name. It additionally pins the fleet-port list
 * against `src/setup/hindsight.ts`: if someone repoints the fleet's default
 * API/UI port and forgets the guard, the guard would stop covering the new
 * port while still passing every one of its own tests.
 *
 * The matching runtime alarm is `tests/hindsight-bank-guard.test.ts`; this is
 * the fast, dependency-free signal that names the fix.
 *
 * Run: `npm run lint:hindsight-bank-hermeticity` (also part of `npm run lint`).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const GUARD_SETUP_FILE = "tests/vitest-setup/hindsight-bank-guard.mjs";
export const GUARD_CORE_FILE = "tests/vitest-setup/hindsight-bank-guard-core.mjs";
export const VITEST_CONFIG = "vitest.config.ts";
export const HINDSIGHT_SETUP_SRC = "src/setup/hindsight.ts";

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
 * The fleet port constants the guard must cover, read from the TS source.
 *
 * API port only. `HINDSIGHT_DEFAULT_UI_PORT` exposes no bank-write surface and
 * its value (9999) is a common ad-hoc dev port, so guarding it would trade
 * this leak for false positives — see `FLEET_HINDSIGHT_PORTS` in the core.
 */
export function fleetPortsFromSource(source) {
  const ports = [];
  for (const name of ["HINDSIGHT_DEFAULT_API_PORT"]) {
    const m = source.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
    if (m) ports.push({ name, port: m[1] });
  }
  return ports;
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
        `missing ${file} — \`bun test\` run from that directory loads no Hindsight bank guard`,
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

  // ── fleet-port coverage ────────────────────────────────────────────────
  // The guard duplicates the fleet ports as literals (it is loaded by plain
  // node, with no TS pipeline). A repoint in src/ that is not mirrored here
  // leaves the new port unguarded while every guard test still passes.
  const corePath = join(repoRoot, GUARD_CORE_FILE);
  const srcPath = join(repoRoot, HINDSIGHT_SETUP_SRC);
  if (existsSync(corePath) && existsSync(srcPath)) {
    const core = readFileSync(corePath, "utf8");
    const m = core.match(/FLEET_HINDSIGHT_PORTS\s*=\s*(\[[\s\S]*?\])/);
    const guarded = m ? stringLiterals(m[1]) : [];
    if (!m) {
      fail("fleet-ports", `${GUARD_CORE_FILE} has no \`FLEET_HINDSIGHT_PORTS\` array`);
    }
    for (const { name, port } of fleetPortsFromSource(readFileSync(srcPath, "utf8"))) {
      if (!guarded.includes(port)) {
        fail(
          "fleet-ports",
          `${HINDSIGHT_SETUP_SRC} \`${name}\` is ${port}, which is not in ` +
            `${GUARD_CORE_FILE} \`FLEET_HINDSIGHT_PORTS\` ` +
            `(guarded: ${guarded.length > 0 ? guarded.join(", ") : "<empty>"})`,
        );
      }
    }
  }

  return { ok: failures.length === 0, failures };
}

// ─── CLI entry ───────────────────────────────────────────────────────────────

const isCli =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] && process.argv[1].endsWith("check-hindsight-bank-hermeticity.mjs"));

if (isCli) {
  const result = checkRepo(process.cwd());
  if (result.ok) {
    process.stdout.write(
      `check-hindsight-bank-hermeticity: clean (guard loaded by vitest setupFiles ` +
        `and ${BUNFIGS.length} bunfig preloads; fleet ports covered)\n`,
    );
    process.exit(0);
  }

  process.stderr.write("check-hindsight-bank-hermeticity: violations:\n\n");
  for (const f of result.failures) process.stderr.write(`  [${f.kind}] ${f.detail}\n`);
  process.stderr.write(
    "\n" +
      "Tests must never reach the FLEET's Hindsight. Hindsight auto-creates a\n" +
      "bank on miss, so one stray request mints a bank in production — on\n" +
      "2026-07-30 a harness sweep minted 11, one named `clerk`, colliding with\n" +
      "a live agent and destroying the annotation that documented where that\n" +
      "agent's memory actually lives.\n\n" +
      "Restore the wiring:\n\n" +
      `  [vitest-wiring] ${VITEST_CONFIG}:\n` +
      `                    setupFiles: ["./${GUARD_SETUP_FILE}"],\n` +
      "  [bun-wiring]    bunfig.toml (repo root) and telegram-plugin/bunfig.toml:\n" +
      "                    [test]\n" +
      `                    preload = ["./${GUARD_SETUP_FILE}"]   (adjust the\n` +
      "                    relative path per bunfig location)\n" +
      `  [fleet-ports]   mirror the port into FLEET_HINDSIGHT_PORTS in\n` +
      `                    ${GUARD_CORE_FILE}\n`,
  );
  process.exit(1);
}
