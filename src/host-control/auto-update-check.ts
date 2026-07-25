/**
 * Auto-update release check (KEN-131, stage 3 of KEN-128).
 *
 * Opt-in via root `release.auto_update: true`. Unlike the legacy
 * `host_control.auto_release_check` digest probe (#1743 — compares the
 * remote `:latest` digest to the LOCAL `:latest` image and then runs
 * `switchroom update` + `restart all`), the auto-update path must drive
 * the EXISTING staggered canary rollout, and `switchroom rollout` needs a
 * concrete, version-assertable `vX.Y.Z` target. A digest can't provide
 * that — and worse, a rollout pulls the `:vX.Y.Z` tag, so the local
 * `:latest` digest never advances and a digest check would re-fire
 * forever after every successful roll.
 *
 * Detection strategy here is therefore VERSION-based:
 *   1. Latest published version ← the npm registry's `latest` dist-tag
 *      for the `switchroom` package. This is the canonical "release is
 *      live" gate (the npm-publish workflow verifies `npm view
 *      switchroom version` post-publish, and the rollout skill checks
 *      the same signal).
 *   2. Currently-deployed version ← the live `release.pin` in
 *      switchroom.yaml (re-read every tick — the rollout persists the
 *      pin after a green canary, which is exactly what stops re-fires).
 *   3. Release available ⇔ latest is STRICTLY newer than the pin
 *      (`compareReleaseTags` — conservative: a sha pin / unorderable
 *      value never triggers an unattended roll) AND the `:vX.Y.Z` agent
 *      image manifest is already pullable (a publish can beat the
 *      docker-images workflow; probing first avoids a canary-fail on a
 *      not-yet-promoted image — the next tick retries).
 *
 * Dependency-injection-shaped like the rest of the watcher stack: the
 * real fetch / config / docker probes are wired in `main.ts`; tests
 * exercise the decision logic with stubs.
 */

import { compareReleaseTags } from "../config/release-resolve.js";
import type { ReleaseCheckResult } from "./release-watcher.js";
import { probeRemoteDigest } from "./release-watcher-shellouts.js";

/** npm registry endpoint for the `latest` dist-tag of the CLI package. */
export const NPM_LATEST_URL = "https://registry.npmjs.org/switchroom/latest";

/** Fetch timeout for the registry round-trip. */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Replace the tag of `imageRef` with `version` (e.g.
 * `ghcr.io/switchroom/switchroom-agent:latest` + `v0.19.2` →
 * `ghcr.io/switchroom/switchroom-agent:v0.19.2`). Registry ports
 * (`host:5000/repo`) are handled: only a colon AFTER the last slash is a
 * tag separator.
 */
export function versionedImageRef(imageRef: string, version: string): string {
  const lastSlash = imageRef.lastIndexOf("/");
  const colon = imageRef.indexOf(":", lastSlash + 1);
  const repo = colon === -1 ? imageRef : imageRef.slice(0, colon);
  return `${repo}:${version}`;
}

/**
 * Default latest-published-version prober: GET the npm registry's
 * `latest` dist-tag document and return its `version` (bare semver,
 * no `v` prefix). Throws on network / shape errors — the watcher
 * surfaces that as a `check_failed` event and retries next tick.
 */
export async function fetchNpmLatestVersion(
  url: string = NPM_LATEST_URL,
): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`npm registry responded ${res.status} for ${url}`);
  }
  const body = (await res.json()) as { version?: unknown };
  if (typeof body.version !== "string" || !/^\d+\.\d+\.\d+$/.test(body.version)) {
    throw new Error(
      `npm registry document at ${url} has no clean semver version field`,
    );
  }
  return body.version;
}

export interface AutoUpdateCheckOptions {
  /**
   * Live view of the fleet's current `release.pin` (re-read per tick —
   * a successful roll persists the new pin, which is what makes the
   * check quiesce). Undefined when the config has no pin (bootstrap:
   * the first auto-roll establishes one). Throws on a malformed config
   * — surfaced as `check_failed`, tick dropped.
   */
  getCurrentPin: () => string | undefined;
  /**
   * Live view of the fleet's current `release.channel` (re-read per tick,
   * like the pin). An operator on a NON-`latest` channel (`dev` / `rc`) has
   * made an explicit release-policy choice that the auto-update path cannot
   * honour: it tracks the npm `latest` dist-tag, and persisting a pin
   * DELETES `release.channel` (schema mutual exclusion — see
   * `setReleasePinInConfig`). Rolling anyway would silently yank a dev/rc
   * fleet onto stable and erase the operator's channel. So a non-`latest`
   * channel suppresses the unattended roll instead.
   */
  getCurrentChannel?: () => string | undefined;
  /**
   * Live view of hostd's durable auto-rollout latch pin, when one is set
   * (a previous unattended roll to that version failed or died mid-flight).
   * The pin never advanced, so `checkFn` would otherwise keep reporting
   * "available" every tick forever — each tick re-entering `applyFn`, being
   * refused by the latch, and appending an `apply_failed` telemetry row.
   * Reporting NOT-available for a latched target quiesces that loop; a
   * newer publish (or a manual roll) clears/supersedes the latch.
   */
  getLatchedPin?: () => string | null;
  /** Agent image ref whose `:vX.Y.Z` sibling must be pullable before a
   *  roll is attempted (tag portion, if any, is replaced). */
  imageRef: string;
  /** Test seam — latest published version (bare semver). Default:
   *  {@link fetchNpmLatestVersion}. */
  fetchLatestVersion?: () => Promise<string>;
  /** Test seam — is the given image ref pullable? Default: `docker
   *  manifest inspect` via {@link probeRemoteDigest}. */
  imageExists?: (imageRef: string) => Promise<boolean>;
  log?: (m: string) => void;
}

/**
 * Build the auto-update `checkFn`. Returns `available: true` with
 * `version: "vX.Y.Z"` ONLY when the published version is strictly newer
 * than the live pin (or no pin exists yet) AND the pinned agent image is
 * already pullable.
 */
export function makeAutoUpdateCheck(
  opts: AutoUpdateCheckOptions,
): () => Promise<ReleaseCheckResult> {
  const log = opts.log ?? (() => {});
  const fetchLatest = opts.fetchLatestVersion ?? fetchNpmLatestVersion;
  const imageExists =
    opts.imageExists ??
    (async (ref: string) => {
      const probe = await probeRemoteDigest(ref);
      // A transient registry ERROR and a genuinely missing manifest both
      // yield digest=null and are treated identically — fail-CLOSED (defer,
      // never roll on ambiguity; the next tick retries). Log the probe
      // error so an operator can tell the two apart in hostd's stderr.
      if (probe.digest === null && probe.error) {
        log(
          `auto-update: manifest probe for ${ref} returned no digest ` +
            `(missing image OR registry error — deferring either way): ` +
            probe.error,
        );
      }
      return probe.digest !== null;
    });
  // The watcher ticks every few minutes forever; a suppression reason that
  // holds indefinitely (non-latest channel, latched failed pin) must not
  // reprint on every tick. Log once per distinct reason instead.
  let lastSuppressed = "";
  const logOnce = (key: string, m: string): void => {
    if (lastSuppressed === key) return;
    lastSuppressed = key;
    log(m);
  };
  return async () => {
    const latest = `v${(await fetchLatest()).trim().replace(/^v/, "")}`;
    const channel = opts.getCurrentChannel?.();
    if (channel !== undefined && channel !== "latest") {
      logOnce(
        `channel:${channel}`,
        `auto-update: release.channel is "${channel}" (not "latest") — the ` +
          `auto-update path tracks the npm latest dist-tag and persisting a ` +
          `pin would delete your channel, so no unattended roll will happen. ` +
          `Remove release.channel (or set it to "latest") to enable it. ` +
          `Latest published: ${latest}`,
      );
      return { available: false, version: latest };
    }
    const latched = opts.getLatchedPin?.() ?? null;
    if (latched !== null && latched === latest) {
      logOnce(
        `latch:${latched}`,
        `auto-update: ${latest} is latched from a previous unattended roll ` +
          `that failed or died mid-flight — not re-reporting it as available. ` +
          `Fix the cause and roll manually (\`switchroom rollout --pin ` +
          `${latest}\`), or wait for a newer release.`,
      );
      return { available: false, version: latest };
    }
    const pin = opts.getCurrentPin();
    if (pin !== undefined) {
      const cmp = compareReleaseTags(latest, pin);
      if (cmp === null) {
        // Unorderable pin (sha-… / channel-ish garbage). An explicit
        // non-semver pin is an operator decision — never fight it
        // unattended.
        log(
          `auto-update: current release.pin "${pin}" is not a vX.Y.Z tag — ` +
            `skipping unattended roll (latest published: ${latest})`,
        );
        return { available: false, version: latest };
      }
      if (cmp <= 0) return { available: false, version: latest };
    }
    const target = versionedImageRef(opts.imageRef, latest);
    if (!(await imageExists(target))) {
      // Publish beat the image build — retry next tick, roll nothing.
      log(
        `auto-update: ${latest} is published but ${target} is not pullable ` +
          `yet (docker-images workflow may still be building) — deferring`,
      );
      return { available: false, version: latest };
    }
    return { available: true, version: latest };
  };
}

/** What the release watcher should do, resolved from config (pure —
 *  unit-testable so "default OFF ⇒ behaviour unchanged" is asserted,
 *  not assumed). */
export type ReleaseWatcherMode =
  /** No watcher at all (both knobs off — the default). */
  | { mode: "off" }
  /** Legacy #1743 digest watcher: `switchroom update` + `restart all`. */
  | { mode: "legacy" }
  /** KEN-131 auto-update: version check → staggered canary rollout. */
  | { mode: "auto_update" };

/**
 * Resolve which watcher (if any) hostd should run. `release.auto_update`
 * wins over `host_control.auto_release_check.enabled` when both are set —
 * the canary rollout path is a strict safety superset of the legacy
 * update+restart-all path, so an operator who opted into both gets the
 * safer pipeline.
 */
export function resolveReleaseWatcherMode(config: {
  release?: { auto_update?: boolean };
  host_control?: { auto_release_check?: { enabled?: boolean } };
}): ReleaseWatcherMode {
  if (config.release?.auto_update === true) return { mode: "auto_update" };
  if (config.host_control?.auto_release_check?.enabled === true) {
    return { mode: "legacy" };
  }
  return { mode: "off" };
}
