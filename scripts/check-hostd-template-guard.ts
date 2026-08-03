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
 *   4. FIXTURE-COVERAGE rule (#4274): the fully-optioned fixture must cover
 *      EVERY optional knob of the render input. The fixture is typed
 *      `Required<RenderHostdComposeOptions>` (compile-time: adding a knob
 *      without extending it fails `tsc --noEmit`), and `optionCoverageFailures`
 *      renders-and-diffs to prove each knob is load-bearing (a knob rendering
 *      as a no-op would let a shape change gated on it slip past the hash).
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

import {
  renderHostdComposeFile,
  type RenderHostdComposeOptions,
} from "../src/cli/hostd.js";
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
  // `Required<…>` is the fixture-coverage guarantee (#4274): every optional
  // knob of the render input MUST appear here, or `tsc --noEmit` (part of
  // `npm run lint`, which type-checks scripts/**) fails. So a newly-added
  // optional knob with its own conditional block cannot slip past the hash —
  // the author is forced to extend this fixture in the same PR.
  const full: Required<RenderHostdComposeOptions> = {
    hostHome: "/home/operator",
    imageTag: "v0.0.0-guard",
    operatorUid: 1000,
    hostTz: "Etc/UTC",
    skillsTarget: "/home/operator/.switchroom-config/skills",
    dockerSocketPath: "/var/run/docker.sock",
  };
  return `${minimal}\n=== FULL ===\n${renderHostdComposeFile(full)}`;
}

/**
 * Generic core of the fixture-coverage check: given a probe input and the
 * render function, return the probe's keys that are NOT load-bearing — i.e.
 * omitting the key does not change the render. A non-empty result means a knob
 * whose shape change could slip past the template hash.
 *
 * Pure and render-agnostic so the failure path is unit-testable with a fake
 * renderer that ignores a key (simulating a newly-added, un-exercised knob).
 */
export function unexercisedOptionKeys<T extends Record<string, unknown>>(
  probe: T,
  render: (opts: T) => string,
): string[] {
  const full = render(probe);
  const unexercised: string[] = [];
  for (const key of Object.keys(probe)) {
    const without = { ...probe };
    delete without[key];
    if (render(without) === full) unexercised.push(key);
  }
  return unexercised;
}

/**
 * Runtime companion to the `Required<…>` compile-time guarantee above:
 * enumerates EVERY key of the render input and asserts each one is
 * load-bearing — i.e. omitting it changes the rendered compose file. The
 * `Required<RenderHostdComposeOptions>` type on the probe forces every
 * optional knob to be named here (adding a knob without extending this probe
 * fails `tsc --noEmit`), and the render diff proves each knob's value actually
 * exercises its conditional block rather than rendering as a no-op.
 *
 * This is deliberately SEPARATE from the hashed canonical fixture, so the
 * probe can use non-default values (e.g. a docker socket path distinct from
 * DEFAULT_DOCKER_SOCKET_PATH) without perturbing the baseline hash.
 *
 * Pure (no I/O) — `renderHostdComposeFile` is hermetic — so it is unit-tested
 * directly and also run inside `main()`.
 */
export function optionCoverageFailures(): string[] {
  // Every value is deliberately DISTINCT from its omitted/default render so
  // the diff is observable for each key. `Required<…>` forces the set to stay
  // complete as the option shape grows.
  const probe: Required<RenderHostdComposeOptions> = {
    hostHome: "/home/probe-operator",
    imageTag: "v0.0.0-probe",
    operatorUid: 4242,
    hostTz: "Antarctica/Troll",
    skillsTarget: "/home/probe-operator/.switchroom-config/skills",
    // Intentionally NOT DEFAULT_DOCKER_SOCKET_PATH — otherwise omitting it
    // would render identically (the renderer defaults to that path) and the
    // knob would look un-exercised.
    dockerSocketPath: "/run/probe/docker.sock",
  };
  return unexercisedOptionKeys(probe, renderHostdComposeFile).map(
    (key) =>
      `render option "${key}" is not exercised by the fixture: omitting it ` +
      `does not change renderHostdComposeFile()'s output, so a shape change ` +
      `gated on it could slip past the template hash. Give it a ` +
      `render-affecting value in renderCanonicalTemplate()'s fixture (and in ` +
      `optionCoverageFailures()'s probe).`,
  );
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
  const failures = [
    ...optionCoverageFailures(),
    ...evaluateHostdTemplateGuard({
      actualHash,
      constant: HOSTD_TEMPLATE_LAST_CHANGED,
      baseline,
      mainBaseline: readMainBaseline(),
    }),
  ];
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
