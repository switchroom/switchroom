/**
 * `switchroom doctor` section: component version drift (#3919).
 *
 * The bug this section exists to make impossible: a switchroom component
 * silently left on an old release. It happened three times at once on the
 * reference host (host CLI two-plus releases behind, `switchroom-web` and
 * `switchroom-hindsight-autoheal` each two behind a v0.19.28 fleet) from
 * three unrelated causes, and survived three releases because the only
 * evidence was a warning that scrolled past during a roll.
 *
 * Deterministic check beats remembering to look. See
 * `component-versions.ts` for the inventory + comparison rules; this
 * module is only the doctor row mapping.
 *
 * Status contract: `warn` for a behind component, `ok` when converged,
 * `skip` when nothing is comparable. Never `fail` — version skew is a
 * real finding but it is not a broken install, and this section must not
 * change doctor's exit code for an otherwise-healthy host.
 */

import { spawnSync } from "node:child_process";

import type { SwitchroomConfig } from "../config/schema.js";
import type { CheckResult } from "./doctor.js";
import { SWITCHROOM_VERSION } from "./resolve-version.js";
import {
  collectComponents,
  detectComponentDrift,
  type ComponentVersion,
  type ExecFn,
} from "./component-versions.js";
import { classifyComponent, remediationFor } from "./component-scope.js";

export interface ComponentVersionCheckOpts {
  /** Test seam — replace the `docker ps` shellout. */
  exec?: ExecFn;
  /** Test seam — override the running CLI's version. */
  cliVersion?: string;
}

const defaultExec: ExecFn = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: 10_000 });
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
};

/**
 * The remediation for a given drifted component.
 *
 * Delegates to the SHARED owner→command mapping (#3928). It used to be a
 * private name-keyed `if` ladder here, which meant doctor and `rollout`
 * each carried their own idea of which mechanism owns which component —
 * the duplication that let `switchroom-hindsight-autoheal` sit outside
 * the roll's scope while doctor knew perfectly well how to fix it.
 */
function fixFor(c: ComponentVersion, target: string): string {
  return remediationFor(classifyComponent(c), target);
}

export function runComponentVersionChecks(
  config: SwitchroomConfig,
  opts: ComponentVersionCheckOpts = {},
): CheckResult[] {
  const exec = opts.exec ?? defaultExec;
  const components = collectComponents(opts.cliVersion ?? SWITCHROOM_VERSION, exec);
  const report = detectComponentDrift(components, config.release?.pin);

  if (!report.target) {
    return [
      {
        name: "component versions",
        status: "skip",
        detail:
          "no release.pin set and no semver-tagged switchroom container running — nothing to compare.",
      },
    ];
  }

  const results: CheckResult[] = [];
  const src =
    report.targetSource === "release.pin"
      ? `release.pin ${report.target}`
      : `${report.target} (highest deployed — no release.pin set)`;

  if (report.behind.length === 0) {
    results.push({
      name: "component versions",
      status: "ok",
      detail: `all ${report.current.length} comparable component(s) on ${src}`,
    });
  }
  for (const c of report.behind) {
    results.push({
      name: `component behind: ${c.name}`,
      status: "warn",
      detail: `on ${c.version}, expected ${report.target} (${src})`,
      fix: fixFor(c, report.target),
    });
  }
  for (const c of report.ahead) {
    results.push({
      name: `component ahead: ${c.name}`,
      status: "warn",
      detail: `on ${c.version}, ahead of ${src} — a roll may be mid-flight, or release.pin is stale`,
    });
  }
  for (const c of report.unknown) {
    results.push({
      name: `component version unknown: ${c.name}`,
      status: "skip",
      detail: c.detail ?? "version not readable",
    });
  }
  return results;
}
