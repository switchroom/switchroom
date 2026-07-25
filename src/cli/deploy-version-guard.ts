/**
 * Downgrade guard for the singleton-container installers (`webd install`,
 * `hostd install`).
 *
 * The web + hostd containers are SEPARATE compose projects that don't
 * self-heal on a pin change, so `rollout` / `update` refresh them by
 * shelling out to `webd install --tag <X>` / `hostd install --tag <X>`.
 * The tag is whatever the orchestrator resolved from `release.pin`.
 *
 * The hazard (real incident 2026-06-15/16): multiple agents share one host
 * and one mutable `release.pin`. Agent A ships a web-only follow-up and
 * deploys web at vNEW; minutes later agent B's `rollout` reads an older pin
 * (vOLD) and its web-refresh step `webd install --tag vOLD` blindly
 * `docker compose up`s — silently REVERTING A's newer web. The installers
 * had ZERO check against the running container's version.
 *
 * This guard makes a deploy refuse to go BACKWARDS: if the running
 * container is already on a newer `vX.Y.Z` than the requested tag, the
 * install is skipped (a no-op success, not an error — so `update`'s
 * fatal-on-nonzero handling and `rollout`'s non-fatal handling both stay
 * clean) unless `--allow-downgrade` is passed. Only a clear semver
 * downgrade is blocked; a channel / `sha-…` / `latest` tag on either side
 * is unorderable and always proceeds.
 */

import { spawnSync } from "node:child_process";
import { compareReleaseTags } from "../config/release-resolve.js";

export type DockerRunner = (args: string[]) => {
  ok: boolean;
  stdout: string;
  stderr: string;
};

/**
 * Wall-clock budget for the `docker inspect` probe in {@link defaultRunner}.
 *
 * The docker CLI has NO client-side request timeout, so against an
 * unresponsive dockerd an unbounded `spawnSync` blocks FOREVER. That is
 * load-bearing on the rollout path: {@link deployedImageTag} is the
 * `refresh-web` step's skew probe, called in-process by `executeRollout`, so
 * a hang here strands hostd's `fleetMutationInFlight` latch — and does it
 * AFTER every agent has already rolled. Kept in sync in spirit with
 * `ROLLOUT_PROBE_TIMEOUT_MS` (`src/cli/rollout.ts`); a healthy daemon answers
 * an inspect in milliseconds, and the rollout executor threads in its own
 * bounded runner anyway (see `createRolloutDeps`). Duplicated rather than
 * imported to keep this module free of a cycle back into rollout.ts.
 *
 * A timeout surfaces as a non-zero/`null` status → `ok: false` → the same
 * "unknown tag" path an absent container already takes. Fails closed.
 */
export const DOCKER_INSPECT_TIMEOUT_MS = 60 * 1000;

const defaultRunner: DockerRunner = (args) => {
  const r = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: DOCKER_INSPECT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/**
 * The image tag a running container was created from, or null when the
 * container is absent / unreadable / its ref has no parseable tag.
 *
 * `docker inspect -f '{{.Config.Image}}'` yields e.g.
 * `ghcr.io/switchroom/switchroom-web:v0.15.34` → `v0.15.34`. Digest refs
 * (`…@sha256:…`) and bare `registry:port/img` (no tag) yield null.
 */
export function deployedImageTag(
  container: string,
  run: DockerRunner = defaultRunner,
): string | null {
  const r = run(["inspect", "-f", "{{.Config.Image}}", container]);
  if (!r.ok) return null;
  const ref = r.stdout.trim();
  if (!ref) return null;
  // A digest pin has no human tag.
  const noDigest = ref.split("@")[0];
  const colon = noDigest.lastIndexOf(":");
  if (colon < 0) return null;
  const tag = noDigest.slice(colon + 1);
  // A colon with a `/` after it was a `registry:port/…` separator, not a tag.
  return tag && !tag.includes("/") ? tag : null;
}

export interface DowngradeCheck {
  /** true → the caller should SKIP the deploy (it would revert a newer build). */
  skip: boolean;
  /** The currently-running tag (null if not deployed / unknown). */
  running: string | null;
  /** Operator-facing explanation, set only when `skip` is true. */
  message?: string;
}

/**
 * Decide whether installing `targetTag` into `container` would DOWNGRADE a
 * newer running build and should therefore be skipped. Pure decision +
 * docker read; no side effects. Blocks ONLY a clear `vX.Y.Z` →
 * older-`vX.Y.Z` move; `allowDowngrade` forces through; anything
 * unorderable proceeds.
 */
export function checkDowngrade(opts: {
  container: string;
  targetTag: string;
  allowDowngrade?: boolean;
  run?: DockerRunner;
}): DowngradeCheck {
  const running = deployedImageTag(opts.container, opts.run);
  if (opts.allowDowngrade) return { skip: false, running };
  const cmp = compareReleaseTags(opts.targetTag, running);
  if (cmp !== null && cmp < 0) {
    return {
      skip: true,
      running,
      message:
        `Skipping ${opts.container} deploy — it is already on ${running}, newer than the ` +
        `requested ${opts.targetTag}.\n` +
        `     Refusing to downgrade: this guards against a concurrent rollout/update ` +
        `reverting a newer build.\n` +
        `     To force the downgrade, re-run with --allow-downgrade.`,
    };
  }
  return { skip: false, running };
}
