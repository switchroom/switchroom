/**
 * hostd self-bump — the missing lever for a fully agent-driven fleet roll
 * (#2645 item 1).
 *
 * Problem: the rollout verb's stale-CLI preflight (#2542) refuses any roll
 * whose target pin is NEWER than the CLI driving it. hostd's CLI is baked
 * into its image, so it is one release behind EVERY new tag by construction
 * — which made every agent-invoked roll to a fresh release fail with
 * `preflight-stale-cli`, and the only remedy (`switchroom hostd install
 * --tag <target>`) was host-shell-only. Agents worked around it by
 * hand-editing hostd's compose file (the `bak-directroll-*` trail on the
 * operator host) — exactly the improvisation this module retires.
 *
 * Shape of the fix (three phases, two hostd processes):
 *
 *   1. OLD hostd receives the rollout request, detects its own CLI is
 *      older than the pin, and — instead of refusing — tag-bumps its own
 *      compose file, writes a resume marker, spawns a DETACHED SIBLING
 *      helper container (`docker run -d`), and answers `started`. The
 *      helper is a sibling, not a child: `docker compose up -d` on the
 *      hostd project recreates the hostd container, which would SIGKILL
 *      any in-container driver (brick scenario #1 / #2458). A sibling
 *      survives its parent's recreate.
 *   2. The helper pulls the target hostd image and `compose up -d`s the
 *      hostd project. Old hostd dies; new hostd (target CLI) boots.
 *   3. NEW hostd finds the marker at startup, verifies its own version
 *      now satisfies the pin, and spawns the rollout child under the SAME
 *      request_id — audit chain, narration surface and get_status all
 *      continue where they left off.
 *
 * Deliberately a TAG-ONLY bump, not a full `hostd install` template
 * regeneration: regenerating the compose from inside a container gets the
 * host-side facts wrong (host timezone, operator uid via SUDO_UID, the
 * skills symlink target — each a real past incident class), while the
 * on-disk compose is known-good and a version bump only needs the image
 * ref changed. Template drift (a NEW release requiring a new mount, e.g.
 * the #2679 machine-id mount) still needs a host-side
 * `switchroom hostd install` — rare, and surfaced in the roll's warnings.
 *
 * Everything here is pure (string/JSON in-out) so it unit-tests without
 * docker; the daemon wires the side effects.
 */

import { compareReleaseTags } from "../config/release-resolve.js";

/** Marker filename, written under `<homeDir>/.switchroom/hostd/` — the
 *  same bind-mounted dir that survives the hostd container recreate. The
 *  dir is root-owned (agents can only reach their own `<agent>/sock`
 *  subdir), so the marker cannot be forged by an agent. */
export const SELF_BUMP_MARKER_FILENAME = "pending-rollout.json";

/** Helper container name. Fixed (not timestamped) so a stale/stuck helper
 *  from a previous attempt is removable by name before the next spawn. */
export const SELF_BUMP_HELPER_CONTAINER = "switchroom-hostd-selfbump";

/** Helper output log, next to the compose file (bind-mounted, so it
 *  survives the recreate and is readable host-side for debugging). */
export const SELF_BUMP_LOG_FILENAME = "selfbump.log";

/**
 * A marker older than this at resume time is treated as a failed bump
 * (terminal error row, no resume). Bounds the window in which a crashed
 * helper / wedged pull can leave a roll pending; matches the orphan-
 * reconcile age so the two mechanisms can't race to different verdicts.
 */
export const SELF_BUMP_MARKER_MAX_AGE_MS = 15 * 60 * 1000;

/** Resume marker: everything the NEW hostd needs to relaunch the roll the
 *  OLD hostd accepted. Written by hostd only (root), read once at boot. */
export interface PendingRolloutMarker {
  v: 1;
  request_id: string;
  /** Version-assertable target, `vX.Y.Z` (validated at the wire + here). */
  pin: string;
  agents?: string[];
  skip_web?: boolean;
  allow_downgrade?: boolean;
  caller: { kind: "agent"; name: string } | { kind: "operator" };
  /** ISO timestamp the OLD hostd wrote the marker. */
  created_at: string;
  /** The OLD hostd's own CLI version, for the audit trail. */
  prior_hostd_version: string;
  /**
   * Telegram message_id of the rollout progress ("narration") card the OLD
   * hostd already posted, so the resumed narrator EDITS the same card instead
   * of stranding it and re-posting. Optional / best-effort: if the OLD hostd
   * was SIGKILLed before it learned the posted id, this is absent and the
   * resume degrades to a fresh post (today's behaviour — strictly no worse).
   */
  narration_message_id?: number;
}

const SEMVER_PIN_RE = /^v\d+\.\d+\.\d+$/;

/**
 * True when the daemon's own CLI is strictly older than the target pin —
 * i.e. the roll would be refused by the CLI-side `preflight-stale-cli`
 * guard (#2542) and hostd must refresh itself first. Mirrors
 * `shouldRefuseStaleCli`: conservative, only a clean semver-vs-semver
 * comparison triggers (dev/sha/unparseable → false → normal path, where
 * the CLI-side guard remains the backstop).
 */
export function needsSelfBump(
  ownVersion: string | undefined,
  pin: string,
): boolean {
  if (!ownVersion) return false;
  const cmp = compareReleaseTags(
    `v${ownVersion.trim().replace(/^v/, "")}`,
    `v${pin.trim().replace(/^v/, "")}`,
  );
  return cmp !== null && cmp < 0;
}

/**
 * Tag-bump the hostd compose yaml: rewrite EVERY `image:` line that
 * references a `switchroom-hostd` image to the target pin, preserving the
 * registry/owner prefix as-is (forks / GHCR mirrors keep working).
 *
 * ALL matches, not just the first (#3919). The hostd compose project has
 * carried a SECOND service on the hostd image since #2910 — the
 * `hindsight-autoheal` sidecar. The original implementation used a
 * non-global regex with `String.replace`, which rewrites only the first
 * match, so every self-bump advanced the `hostd` service and silently left
 * `hindsight-autoheal` on the prior tag. Observed on the operator host:
 * `switchroom-hostd` on v0.19.28 while `switchroom-hindsight-autoheal` was
 * still on v0.19.26, two releases after the sidecar last saw a host-side
 * `hostd install`. Nothing surfaced the split because the self-bump reports
 * only the (correctly bumped) hostd ref.
 *
 * Returns the rewritten yaml plus the old and new image refs, or null when
 * no such image line is found (hand-mangled compose — caller refuses and
 * points at host-side `hostd install`). `oldImageRef` is the ref of the
 * FIRST matched line (the `hostd` service in a generated compose) so the
 * caller's audit line is unchanged; `bumpedCount` reports how many lines
 * were actually rewritten.
 */
export function bumpHostdComposeImageTag(
  yaml: string,
  pin: string,
): {
  yaml: string;
  oldImageRef: string;
  newImageRef: string;
  bumpedCount: number;
} | null {
  const re = /^(\s*image:\s*)(\S*switchroom-hostd):(\S+)[ \t]*$/gm;
  const matches = [...yaml.matchAll(re)];
  if (matches.length === 0) return null;
  const first = matches[0];
  const oldImageRef = `${first[2]}:${first[3]}`;
  const newImageRef = `${first[2]}:${pin}`;
  return {
    // Rewrite every match, preserving each line's own registry/owner
    // prefix — a fork could legitimately mirror the two services from
    // different registries and we must not collapse them onto one.
    yaml: yaml.replace(re, (_m, indent: string, repo: string) => `${indent}${repo}:${pin}`),
    oldImageRef,
    newImageRef,
    bumpedCount: matches.length,
  };
}

/** Serialize a marker (pretty-printed — it's an operator-debuggable file). */
export function encodePendingRolloutMarker(m: PendingRolloutMarker): string {
  return JSON.stringify(m, null, 2) + "\n";
}

/**
 * Parse + validate a marker file's contents. Returns null on ANY shape
 * problem — a malformed/forged/torn marker degrades to "no resume" (the
 * orphan-reconcile sweep then reports the stranded roll) rather than
 * letting unvalidated data reach a spawn argv.
 */
export function parsePendingRolloutMarker(
  raw: string,
): PendingRolloutMarker | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (typeof o.request_id !== "string" || o.request_id.length === 0) return null;
  if (typeof o.pin !== "string" || !SEMVER_PIN_RE.test(o.pin)) return null;
  if (typeof o.created_at !== "string" || !Number.isFinite(Date.parse(o.created_at))) {
    return null;
  }
  if (typeof o.prior_hostd_version !== "string") return null;
  const caller = o.caller as Record<string, unknown> | null;
  if (typeof caller !== "object" || caller === null) return null;
  if (caller.kind === "agent") {
    if (typeof caller.name !== "string" || caller.name.length === 0) return null;
  } else if (caller.kind !== "operator") {
    return null;
  }
  if (o.agents !== undefined) {
    if (
      !Array.isArray(o.agents) ||
      o.agents.length === 0 ||
      !o.agents.every((a) => typeof a === "string" && /^[\w-]+$/.test(a))
    ) {
      return null;
    }
  }
  if (o.skip_web !== undefined && typeof o.skip_web !== "boolean") return null;
  if (o.allow_downgrade !== undefined && typeof o.allow_downgrade !== "boolean") {
    return null;
  }
  // Best-effort field: a malformed narration id must NEVER null the whole
  // marker (that would block the resume). Drop only this field and keep going.
  const narrationIdValid =
    typeof o.narration_message_id === "number" &&
    Number.isInteger(o.narration_message_id) &&
    o.narration_message_id > 0;
  return {
    v: 1,
    request_id: o.request_id,
    pin: o.pin,
    ...(o.agents !== undefined ? { agents: o.agents as string[] } : {}),
    ...(o.skip_web !== undefined ? { skip_web: o.skip_web as boolean } : {}),
    ...(o.allow_downgrade !== undefined
      ? { allow_downgrade: o.allow_downgrade as boolean }
      : {}),
    ...(narrationIdValid
      ? { narration_message_id: o.narration_message_id as number }
      : {}),
    caller:
      caller.kind === "agent"
        ? { kind: "agent", name: caller.name as string }
        : { kind: "operator" },
    created_at: o.created_at,
    prior_hostd_version: o.prior_hostd_version,
  };
}

/** True when the marker is young enough to resume. */
export function isMarkerFresh(
  marker: PendingRolloutMarker,
  nowMs: number,
): boolean {
  const created = Date.parse(marker.created_at);
  if (!Number.isFinite(created)) return false;
  return nowMs - created < SELF_BUMP_MARKER_MAX_AGE_MS;
}

/**
 * argv for the detached sibling helper (`docker <argv...>`).
 *
 * The helper mounts ONLY the docker socket and the hostd compose dir (at
 * its identical HOST path, so the `-f` path the compose CLI reads matches
 * the path dockerd resolves bind sources against — no translation layer to
 * poison, cf. the 2026-06-23 container-HOME deploy incident). It pulls
 * first (old hostd keeps serving through the download), then `up -d`,
 * logging to `selfbump.log` in the same dir. `sleep 2` gives the OLD hostd
 * time to flush the `started` response to the caller before the recreate
 * SIGTERMs it.
 *
 * The helper runs the CURRENTLY-RUNNING (old) hostd image, NOT the target:
 * the old image is guaranteed local (the running container pins it), so
 * `docker run -d` returns in well under a second — running the TARGET
 * image here would make `run -d` synchronously pull a multi-GB image and
 * blow the caller's wire timeout before the `started` response ever lands.
 * The target image is fetched by the script's own `compose pull`, async to
 * the response. The old image carries the same docker CLI + compose plugin
 * the script needs.
 *
 * The script PROPAGATES the pull/up exit status as the container's exit
 * code — the daemon's `docker wait` watcher keys on it to detect a failed
 * bump while the old hostd is still alive (a trailing bare `echo` would
 * mask every failure as exit 0 and leave the fleet-mutation lock held
 * forever).
 */
export function selfBumpHelperArgs(opts: {
  /** HOST path of `~/.switchroom/hostd` (compose file + log live here). */
  hostdDirHostPath: string;
  /** Image to RUN the helper from — the currently-running (old) hostd
   *  image ref, guaranteed local. */
  helperImage: string;
  /** Target image ref, for the log line only (the bumped compose file is
   *  what actually names it to `compose pull`). */
  targetImage: string;
}): string[] {
  const composePath = `${opts.hostdDirHostPath}/docker-compose.yml`;
  const logPath = `${opts.hostdDirHostPath}/${SELF_BUMP_LOG_FILENAME}`;
  const script =
    `sleep 2; ` +
    `echo \"selfbump $(date -u) -> ${opts.targetImage}\" >> \"${logPath}\" 2>&1; ` +
    `docker compose -p switchroom-hostd -f \"${composePath}\" pull >> \"${logPath}\" 2>&1 && ` +
    `docker compose -p switchroom-hostd -f \"${composePath}\" up -d >> \"${logPath}\" 2>&1; ` +
    `rc=$?; echo \"selfbump done rc=$rc\" >> \"${logPath}\" 2>&1; exit $rc`;
  return [
    "run",
    "-d",
    "--rm",
    "--name",
    SELF_BUMP_HELPER_CONTAINER,
    "--label",
    "switchroom.hostd-selfbump=true",
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock",
    "-v",
    `${opts.hostdDirHostPath}:${opts.hostdDirHostPath}`,
    "--entrypoint",
    "/bin/sh",
    opts.helperImage,
    "-c",
    script,
  ];
}
