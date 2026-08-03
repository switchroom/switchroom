/**
 * Lint guard — HOSTD_TEMPLATE_LAST_CHANGED must move when the hostd compose
 * template's shape moves (#4269).
 *
 * Why this guard exists
 * ---------------------
 * After an agent-invoked rollout, the Done card names the one residual no
 * roll can converge from inside a container: a hostd template regen
 * (`switchroom hostd install --tag <target>`), needed only when a release
 * changed the hostd compose template's mounts/env shape. #4269 made that
 * line DEFINITE — the card compares the roll's from → target window against
 * `HOSTD_TEMPLATE_LAST_CHANGED` (src/config/hostd-template-version.ts) and
 * says "REQUIRED" or "not needed" outright.
 *
 * That is only honest while the constant actually moves with the template.
 * Leaving it to reviewer memory is the exact discipline-over-mechanism
 * failure the dev protocol forbids, so this guard makes it deterministic:
 *
 *   1. It RENDERS the real template (`renderHostdComposeFile`, both the
 *      minimal and the fully-optioned fixture) with fixed inputs, strips
 *      YAML comments/blank lines (wording edits are not shape edits), and
 *      hashes the result.
 *   2. The hash must equal `templateSha256` in
 *      `scripts/hostd-template-baseline.json`, and the constant must equal
 *      the baseline's `lastChanged` (lockstep — neither can drift alone).
 *   3. Best-effort NEVER-SILENT rule (enforced whenever the `origin/main`
 *      copy of the baseline is readable, i.e. in CI): if the hash changed
 *      relative to origin/main, `lastChanged` must be STRICTLY NEWER than
 *      origin/main's — i.e. you cannot change the template's shape and
 *      re-hash the baseline without also bumping the constant.
 *
 * When this guard fails after a deliberate template change:
 *   - bump HOSTD_TEMPLATE_LAST_CHANGED (src/config/hostd-template-version.ts)
 *     to the release tag that will ship your change, and
 *   - update scripts/hostd-template-baseline.json with the same tag and the
 *     new hash this guard prints.
 *
 * Run: `npm run lint:hostd-template-guard` (also part of `npm run lint`).
 * The pure decision lives in `evaluateHostdTemplateGuard()` (unit-tested in
 * tests/check-hostd-template-guard.test.ts); `main()` does the I/O.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { renderHostdComposeFile } from "../src/cli/hostd.js";
import { HOSTD_TEMPLATE_LAST_CHANGED } from "../src/config/hostd-template-version.js";

export const BASELINE_PATH = "scripts/hostd-template-baseline.json";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Canonical fixed inputs — every optional knob exercised once, plus the
 * minimal shape, so a change to EITHER branch of the template moves the
 * hash. Values are synthetic and stable; the imageTag is fixed so a routine
 * release bump never trips the guard.
 */
export function renderCanonicalTemplate(): string {
  const minimal = renderHostdComposeFile({
    hostHome: "/home/operator",
    imageTag: "v0.0.0-guard",
  });
  const full = renderHostdComposeFile({
    hostHome: "/home/operator",
    imageTag: "v0.0.0-guard",
    operatorUid: 1000,
    hostTz: "Etc/UTC",
    skillsTarget: "/home/operator/.switchroom-config/skills",
    dockerSocketPath: "/var/run/docker.sock",
  });
  return `${minimal}\n=== FULL ===\n${full}`;
}

/**
 * Shape-only normalization: drop YAML comment lines and blank lines, and
 * trailing whitespace. A comment/wording edit inside the template literal
 * does not change what a regen would install structurally, so it must not
 * force a constant bump; a mounts/env/image/key edit always survives this
 * normalization and moves the hash.
 */
export function normalizeTemplate(rendered: string): string {
  return rendered
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"))
    .join("\n");
}

export function templateHash(rendered: string): string {
  return createHash("sha256").update(normalizeTemplate(rendered)).digest("hex");
}

export interface HostdTemplateBaseline {
  templateSha256: string;
  lastChanged: string;
}

export interface GuardInput {
  /** sha256 of the normalized canonical render at HEAD. */
  actualHash: string;
  /** HOSTD_TEMPLATE_LAST_CHANGED at HEAD. */
  constant: string;
  /** Parsed baseline file at HEAD. */
  baseline: HostdTemplateBaseline;
  /** Parsed origin/main baseline, when readable (null off-CI / shallow). */
  mainBaseline: HostdTemplateBaseline | null;
}

const TAG_RE = /^v\d+\.\d+\.\d+$/;

function tagNewer(a: string, b: string): boolean {
  // strictly a > b, both already TAG_RE-validated.
  const pa = a.slice(1).split(".").map(Number);
  const pb = b.slice(1).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return false;
}

/** Pure decision — returns the list of failures (empty ⇒ pass). */
export function evaluateHostdTemplateGuard(input: GuardInput): string[] {
  const { actualHash, constant, baseline, mainBaseline } = input;
  const failures: string[] = [];

  if (!TAG_RE.test(constant)) {
    failures.push(
      `HOSTD_TEMPLATE_LAST_CHANGED (${JSON.stringify(constant)}) is not a ` +
        `clean release tag (vX.Y.Z) — the Done-card comparison needs one.`,
    );
  }
  if (constant !== baseline.lastChanged) {
    failures.push(
      `HOSTD_TEMPLATE_LAST_CHANGED (${constant}) != ${BASELINE_PATH} ` +
        `lastChanged (${baseline.lastChanged}) — the constant and the ` +
        `baseline move in lockstep; update both in the same PR.`,
    );
  }
  if (actualHash !== baseline.templateSha256) {
    failures.push(
      `the hostd compose template's SHAPE changed: canonical render hashes ` +
        `to ${actualHash}, baseline says ${baseline.templateSha256}. If the ` +
        `mounts/env/compose shape genuinely changed, a host-side ` +
        `\`switchroom hostd install\` is now REQUIRED for the release that ` +
        `ships this — bump HOSTD_TEMPLATE_LAST_CHANGED ` +
        `(src/config/hostd-template-version.ts) to that release tag and set ` +
        `${BASELINE_PATH} to {"templateSha256": "${actualHash}", ` +
        `"lastChanged": "<that tag>"}.`,
    );
  }
  if (
    mainBaseline !== null &&
    baseline.templateSha256 !== mainBaseline.templateSha256 &&
    !(
      TAG_RE.test(baseline.lastChanged) &&
      TAG_RE.test(mainBaseline.lastChanged) &&
      tagNewer(baseline.lastChanged, mainBaseline.lastChanged)
    )
  ) {
    failures.push(
      `the template hash changed relative to origin/main ` +
        `(${mainBaseline.templateSha256} → ${baseline.templateSha256}) but ` +
        `lastChanged did not move FORWARD (${mainBaseline.lastChanged} → ` +
        `${baseline.lastChanged}). A shape change without a constant bump ` +
        `would make the rollout Done card lie about the hostd regen — bump ` +
        `HOSTD_TEMPLATE_LAST_CHANGED to the release tag that will ship this ` +
        `change.`,
    );
  }
  return failures;
}

function readMainBaseline(): HostdTemplateBaseline | null {
  try {
    const raw = execFileSync(
      "git",
      ["show", `origin/main:${BASELINE_PATH}`],
      { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const parsed = JSON.parse(raw) as HostdTemplateBaseline;
    if (typeof parsed.templateSha256 !== "string" || typeof parsed.lastChanged !== "string") {
      return null;
    }
    return parsed;
  } catch {
    // Shallow checkout / no origin — the lockstep + hash rules still bind;
    // CI (fetch-depth: 0) enforces the never-silent rule.
    return null;
  }
}

function main(): void {
  let baseline: HostdTemplateBaseline;
  try {
    baseline = JSON.parse(
      readFileSync(resolve(repoRoot, BASELINE_PATH), "utf-8"),
    ) as HostdTemplateBaseline;
  } catch (e) {
    process.stderr.write(
      `check-hostd-template-guard: cannot read ${BASELINE_PATH}: ` +
        `${(e as Error).message}\n`,
    );
    process.exit(1);
  }
  const actualHash = templateHash(renderCanonicalTemplate());
  const failures = evaluateHostdTemplateGuard({
    actualHash,
    constant: HOSTD_TEMPLATE_LAST_CHANGED,
    baseline,
    mainBaseline: readMainBaseline(),
  });
  if (failures.length > 0) {
    process.stderr.write(
      `check-hostd-template-guard: FAIL\n` +
        failures.map((f) => `  - ${f}`).join("\n") +
        "\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `check-hostd-template-guard: OK (template ${actualHash.slice(0, 12)}…, ` +
      `last changed ${HOSTD_TEMPLATE_LAST_CHANGED})\n`,
  );
}

// Only run main() when executed directly (bun scripts/check-hostd-template-guard.ts),
// not when imported by the vitest suite.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
