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
 * Status contract: `warn` for a behind CONTAINER, `ok` when converged,
 * `skip` when nothing is comparable. Container skew is a real finding but
 * not a broken install — and containers legitimately sit behind `target`
 * transiently mid-roll (release.pin is bumped before every container has
 * advanced), so failing on any container-behind would turn doctor RED for
 * a healthy host during a normal roll. Those stay `warn`.
 *
 * The ONE exception is the host CLI binary itself (`cli (host)`): it is a
 * single artifact that `switchroom update` converges in-band, so a
 * *behind* host binary is never a transient mid-roll state — it is the
 * exact silent-drift bug this module exists to catch (v0.19.38 rolled to
 * every container while `/usr/local/bin/switchroom` stayed on v0.19.33 and
 * the hindsight-watch cron ran retired code for 12 h). That single case
 * is `fail`, so doctor goes RED and the drift can no longer hide behind a
 * warning. A current or ahead host CLI stays green. See
 * `hostCliBehindStatus()` for the scoped rule.
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
  type HostCliObservation,
} from "./component-versions.js";
import { classifyComponent, remediationFor } from "./component-scope.js";
import {
  observeHostCli,
  readHostCliStamp,
  type HostCliStamp,
} from "./host-cli-stamp.js";

export interface ComponentVersionCheckOpts {
  /** Test seam — replace the `docker ps` shellout. */
  exec?: ExecFn;
  /** Test seam — override the running CLI's version. */
  cliVersion?: string;
  /**
   * Test seam — what is known about the HOST CLI. Production derives it:
   * in a container the running CLI is NOT the host CLI, so the stamp is
   * consulted instead of `SWITCHROOM_VERSION` (#4571).
   */
  hostCli?: HostCliObservation;
  /**
   * Test seam — the host CLI's install record, used to render the `cli` row's
   * `fix:`. `undefined` reads the real stamp (production); `null` means
   * "explicitly no stamp", which is how a test pins the generic remediation
   * without depending on whether the machine running it has one.
   */
  hostCliStamp?: HostCliStamp | null;
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
function fixFor(
  c: ComponentVersion,
  target: string,
  hostCli: HostCliStamp | undefined,
): string {
  return remediationFor(classifyComponent(c), target, hostCli);
}

/**
 * The status for a *behind* component. Scoped-fail rule (see the module
 * header): only the host CLI binary drifting behind `target` is a `fail`;
 * every containerised component stays `warn` because it can legitimately
 * lag mid-roll. Keyed on `kind === "cli"`, the field `collectComponents`
 * stamps on the host entry — never on a container — so a container can
 * never trip the fail path even if its name were to change.
 */
export function hostCliBehindStatus(c: ComponentVersion): "fail" | "warn" {
  return c.kind === "cli" ? "fail" : "warn";
}

export function runComponentVersionChecks(
  config: SwitchroomConfig,
  opts: ComponentVersionCheckOpts = {},
): CheckResult[] {
  const exec = opts.exec ?? defaultExec;
  // `null` is the explicit "no stamp" seam; `undefined` means "read the real one".
  const hostCliStamp =
    opts.hostCliStamp === undefined
      ? readHostCliStamp()
      : (opts.hostCliStamp ?? undefined);
  const components = collectComponents(
    opts.cliVersion ?? SWITCHROOM_VERSION,
    exec,
    opts.hostCli ?? observeHostCli(),
  );
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
    const status = hostCliBehindStatus(c);
    results.push({
      name: `component behind: ${c.name}`,
      status,
      detail:
        status === "fail"
          ? // #4571 — this used to promise "self-heals in-band via `switchroom
            // update`". That is false for an `npm i -g` install:
            // `self-update-cli` returns early for anything that is not a
            // static binary, so the self-heal timer skipped this host's CLI
            // every tick while it drifted five releases. The `fix:` below
            // carries the command derived from the actual install.
            `on ${c.version}, expected ${report.target} (${src}) — the host CLI must never trail the fleet: it drives \`apply\`, \`vault\`, \`doctor\` and the next roll`
          : `on ${c.version}, expected ${report.target} (${src})`,
      fix: fixFor(c, report.target, hostCliStamp),
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
