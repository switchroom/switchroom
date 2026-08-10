/**
 * Host-CLI self-heal for an agent-initiated roll (#4585).
 *
 * ## The dead end this removes
 *
 * The host-CLI-first gate (#4571) refuses a roll whose target is newer than
 * the HOST operator CLI, and names the install command derived from
 * `~/.switchroom/host-cli.json`. On the host shell that is actionable. On the
 * agent path it is not: `mcp__hostd__rollout(pin=…)` self-bumps hostd, then
 * stops with `failedStep: preflight-host-cli-stale` and a remedy the caller
 * cannot perform. The roll dead-ends until a human reaches a terminal.
 *
 * The judgement call — "should this fleet go to this pin" — already happened
 * when the operator tapped the approval card. What remains is mechanical and
 * verifiable: fetch the release binary, check it against that release's
 * `switchroom-checksums.txt`, prove it runs, atomically swap it in, keep the
 * outgoing binary for rollback, assert the new one reports the target.
 *
 * ## Why a short-lived helper container, not a hostd mount
 *
 * The obvious shape is to bind the host bindir into hostd rw and do the swap
 * in-process. Two things rule it out:
 *
 *  1. **It could not land itself.** hostd's compose file is written host-side
 *     by `switchroom hostd install`; a new mount only appears after an
 *     operator runs that ON THE HOST — which is precisely the human-at-a-
 *     terminal step this change exists to delete. A helper container is
 *     spawned by code that ships INSIDE the hostd image, so it works on the
 *     first roll that carries it (hostd self-bumps to the target image before
 *     the rollout child ever spawns, #2645).
 *  2. **It would be a standing privilege.** A permanent rw mount of a `$PATH`
 *     directory in a long-lived, agent-reachable daemon is a strictly larger
 *     surface than a mount that exists for the ~30 seconds of the swap.
 *
 * The helper is the same mechanism `self-bump.ts` already uses for hostd's own
 * image bump, minus the docker socket: this one gets a bindir and nothing
 * else. It cannot touch the fleet, the vault or the config.
 *
 * ## Scope, honestly
 *
 * Only a `static-binary` install can be healed this way — replacing one file
 * IS the whole update for it. An `npm i -g` install (the reference host's
 * nvm-prefix case) needs npm against the operator's own prefix and owner, so
 * it still refuses, now with a message that says an OPERATOR must run the
 * command rather than addressing the agent as though it could.
 */

import type { DockerRunner } from "./deploy-version-guard.js";
import type { HostCliStamp } from "./host-cli-stamp.js";
import {
  parseHostCliUpgradeResult,
  type HostCliUpgradeResult,
} from "./host-cli-upgrade.js";

/** Where the host CLI's install PREFIX is mounted inside the helper. */
export const HEAL_PREFIX_MOUNT = "/hostcli";

/** Helper container name. Fixed so a stale one is removable before a respawn. */
export const HEAL_HELPER_CONTAINER = "switchroom-hostcli-heal";

/** The hostd container whose image the helper is run from. */
export const HOSTD_CONTAINER_NAME = "switchroom-hostd";

/**
 * Wall-clock budget for the whole heal, including the ~100MB binary + asset
 * payload download. Deliberately generous: killing a legitimately slow
 * download would strand the roll at exactly the refusal it is trying to
 * clear. Override with `SWITCHROOM_HOST_CLI_HEAL_TIMEOUT_MS`.
 */
export const HOST_CLI_HEAL_TIMEOUT_MS = (() => {
  const raw = process.env.SWITCHROOM_HOST_CLI_HEAL_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 10 * 60 * 1000;
})();

export type HostCliHealPlan =
  | { action: "skip"; reason: string }
  | {
      action: "heal";
      /** HOST path of the install prefix to bind (`dirname(installDir)`). */
      prefixHostPath: string;
      /** In-helper path of the binary, under {@link HEAL_PREFIX_MOUNT}. */
      containerBinaryPath: string;
      /** Version currently installed, for the rollback archive's name. */
      from: string;
      /** Target release tag, `vX.Y.Z`. */
      target: string;
    };

/**
 * Decide whether this roll can heal the host CLI itself. Pure.
 *
 * Every "no" is a reason string the refusal message can quote, because the
 * failure mode this whole area exists to kill is a silent one.
 */
export function planHostCliHeal(opts: {
  stamp: HostCliStamp | undefined;
  target: string;
  /** Only the hostd path heals; on the host shell the operator IS the fix. */
  hostdCtx: boolean;
}): HostCliHealPlan {
  const { stamp, target, hostdCtx } = opts;
  if (!hostdCtx) {
    return {
      action: "skip",
      reason:
        "not running in hostd context — on the host shell the operator can run " +
        "the install command directly",
    };
  }
  if (!stamp) return { action: "skip", reason: "no host-cli.json stamp to act on" };
  if (!/^v\d+\.\d+\.\d+$/.test(target)) {
    return { action: "skip", reason: `target "${target}" is not a vX.Y.Z release tag` };
  }
  if (stamp.installKind !== "static-binary") {
    return {
      action: "skip",
      reason:
        `the host CLI is a ${stamp.installKind} install — only a static-binary ` +
        `install can be replaced by swapping one file, so an operator must run ` +
        `the upgrade host-side`,
    };
  }
  const path = stamp.path;
  if (!path.startsWith("/") || path.includes("/..")) {
    return { action: "skip", reason: `recorded host CLI path "${path}" is not a plain absolute path` };
  }
  const installDir = path.slice(0, path.lastIndexOf("/"));
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name !== "switchroom") {
    return { action: "skip", reason: `recorded host CLI path "${path}" is not named \`switchroom\`` };
  }
  const prefixHostPath = installDir.slice(0, installDir.lastIndexOf("/"));
  const dirName = installDir.slice(installDir.lastIndexOf("/") + 1);
  // `<prefix>/<dir>/switchroom` is the shape `install.sh` produces
  // (/usr/local/bin, ~/.local/bin). The PREFIX is what gets bound, because the
  // shipped-asset payload lives at `<prefix>/share/switchroom` — binding only
  // the bindir would install the payload into the helper's own throwaway
  // filesystem and report success. A binary directly at `/switchroom` has no
  // prefix to bind and is refused rather than mounting host `/`.
  if (prefixHostPath.length === 0 || dirName.length === 0) {
    return {
      action: "skip",
      reason:
        `recorded host CLI path "${path}" has no install prefix to bind — ` +
        `refusing to mount the host root`,
    };
  }
  return {
    action: "heal",
    prefixHostPath,
    containerBinaryPath: `${HEAL_PREFIX_MOUNT}/${dirName}/switchroom`,
    from: stamp.version,
    target,
  };
}

/**
 * argv for `docker run` of the heal helper.
 *
 * Detached (`-d`) then waited on, mirroring `self-bump.ts`: a foreground
 * `docker run` needs an attach hijack through the docker-socket-proxy, while
 * `create` + `wait` + `logs` are plain allowlisted calls. Not `--rm`, so the
 * logs (and the result sentinel) survive long enough to be read.
 *
 * The mount set is the whole privilege of this container: ONE host directory,
 * no docker socket, no `~/.switchroom`.
 */
export function healHelperArgs(opts: {
  plan: Extract<HostCliHealPlan, { action: "heal" }>;
  helperImage: string;
  containerName?: string;
}): string[] {
  const { plan, helperImage } = opts;
  return [
    "run",
    "-d",
    "--name",
    opts.containerName ?? HEAL_HELPER_CONTAINER,
    "--label",
    "switchroom.hostcli-heal=true",
    "-v",
    `${plan.prefixHostPath}:${HEAL_PREFIX_MOUNT}:rw`,
    helperImage,
    "switchroom",
    "host-cli-upgrade",
    "--binary",
    plan.containerBinaryPath,
    "--pin",
    plan.target,
    "--from",
    plan.from,
  ];
}

/**
 * The image to run the helper from: whatever the running hostd container was
 * created from.
 *
 * NOT a hardcoded `ghcr.io/switchroom/switchroom-hostd:<pin>`: forks and GHCR
 * mirrors exist (`bumpHostdComposeImageTag` preserves per-line registry
 * prefixes for exactly that reason), and the running image is guaranteed
 * present locally so `docker run` returns without a multi-hundred-MB pull.
 * It is also guaranteed to carry a CLI at or past the target — the roll would
 * already have been refused by `shouldRefuseStaleCli` otherwise — which is
 * what makes `switchroom host-cli-upgrade` present in it.
 */
export function resolveHelperImage(docker: DockerRunner): string | null {
  const r = docker(["inspect", "--format", "{{.Config.Image}}", HOSTD_CONTAINER_NAME]);
  if (!r.ok) return null;
  const ref = r.stdout.trim().split("\n")[0]?.trim() ?? "";
  return ref.length > 0 ? ref : null;
}

export interface HostCliHealOutcome {
  ok: boolean;
  /** Version proven on disk after the swap, when it succeeded. */
  version?: string;
  /** One line for the roll's warnings / the refusal message. */
  message: string;
}

/**
 * Run the heal: spawn the helper, wait for it, read its verdict.
 *
 * Never throws — a heal that cannot run degrades to the pre-existing refusal
 * with the reason appended, which is strictly more informative than the
 * refusal alone. The helper container is always removed.
 */
export function runHostCliHeal(opts: {
  plan: Extract<HostCliHealPlan, { action: "heal" }>;
  docker: DockerRunner;
  containerName?: string;
  log?: (line: string) => void;
}): HostCliHealOutcome {
  const { plan, docker } = opts;
  const name = opts.containerName ?? HEAL_HELPER_CONTAINER;
  const log = opts.log ?? (() => {});
  const image = resolveHelperImage(docker);
  if (!image) {
    return {
      ok: false,
      message:
        `could not resolve the image of the running \`${HOSTD_CONTAINER_NAME}\` ` +
        `container, so there is no image to run the upgrade helper from`,
    };
  }
  // A helper stranded by an earlier attempt would make `run --name` fail.
  docker(["rm", "-f", name]);
  log(
    `↻ host CLI ${plan.from} → ${plan.target}: running the upgrade helper ` +
      `(${image}, binding ${plan.prefixHostPath})\n`,
  );
  const started = docker(healHelperArgs({ plan, helperImage: image, containerName: name }));
  if (!started.ok) {
    return {
      ok: false,
      message: `could not start the upgrade helper: ${oneLine(started.stderr) || "docker run failed"}`,
    };
  }
  try {
    return waitForHelper(docker, name, plan);
  } catch (err) {
    // Total by construction: a heal that blows up must degrade to the
    // pre-existing refusal (with the reason attached), never take the roll
    // down a path its callers do not handle.
    return { ok: false, message: `the upgrade helper could not be waited on: ${(err as Error).message}` };
  } finally {
    try {
      docker(["rm", "-f", name]);
    } catch {
      /* the helper is labelled `switchroom.hostcli-heal=true` for cleanup */
    }
  }
}

function waitForHelper(
  docker: DockerRunner,
  name: string,
  plan: Extract<HostCliHealPlan, { action: "heal" }>,
): HostCliHealOutcome {
  const waited = docker(["wait", name]);
  const logs = docker(["logs", name]);
  const blob = `${logs.stdout}\n${logs.stderr}`;
  const parsed: HostCliUpgradeResult | null = parseHostCliUpgradeResult(blob);
  if (!waited.ok) {
    return {
      ok: false,
      message:
        `waiting on the upgrade helper failed (${oneLine(waited.stderr) || "docker wait failed"})` +
        (parsed?.error ? `; helper reported: ${parsed.error}` : ""),
    };
  }
  const code = waited.stdout.trim().split("\n").pop()?.trim() ?? "";
  if (code !== "0" || !parsed || !parsed.ok) {
    return {
      ok: false,
      message:
        `the upgrade helper exited ${code || "?"}: ` +
        (parsed?.error ?? (oneLine(blob) || "no diagnostic on stdout/stderr")),
    };
  }
  if (!parsed.version) {
    return { ok: false, message: "the upgrade helper reported success without a version" };
  }
  return {
    ok: true,
    version: parsed.version,
    message: `host CLI upgraded ${plan.from} → ${parsed.version} at ${plan.containerBinaryPath.replace(HEAL_PREFIX_MOUNT, plan.prefixHostPath)}`,
  };
}

/** Collapse a stderr/log blob into one bounded line for a warning. */
function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 400 ? `${flat.slice(0, 397)}...` : flat;
}
