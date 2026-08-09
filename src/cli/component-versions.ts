/**
 * Component version inventory + drift detection (#3919).
 *
 * WHY THIS EXISTS
 *
 * Switchroom is not one artifact. It is a host CLI plus N containerised
 * components spread across THREE docker compose projects and one
 * standalone `docker run` container:
 *
 *   - `switchroom`        — agent fleet + vault-broker + approval-kernel
 *                           + auth-broker + voice sidecar
 *   - `switchroom-hostd`  — hostd daemon, its docker-socket-proxy, and
 *                           the `hindsight-autoheal` sidecar (#2910)
 *   - `switchroom-web`    — dashboard / webhook receiver
 *   - (standalone)        — the hindsight memory singleton
 *   - (host)              — the operator CLI itself
 *
 * Every one of those advances by a DIFFERENT mechanism, and each
 * mechanism has its own failure mode. In July 2026 the operator host
 * ran the fleet on v0.19.28 while:
 *
 *   - the host CLI was on 0.19.23  (nothing ever updates it — `switchroom
 *     update` updated everything except itself)
 *   - `switchroom-web` was on v0.19.26  (`webd install` fails inside the
 *     hostd container when the hostd compose predates the
 *     SWITCHROOM_HOSTD_OPERATOR_UID env; the rollout logs it as a
 *     NON-FATAL warning and carries on)
 *   - `switchroom-hindsight-autoheal` was on v0.19.26  (the self-bump
 *     rewrote only the first hostd image line — fixed in this same PR)
 *
 * Three unrelated bugs, all with the same signature: a component quietly
 * left behind. The reason the drift survived three releases is not that
 * the individual failures were invisible — two of them logged a warning
 * at the time — it is that NOTHING held a standing, checkable answer to
 * "is every component on the same version?". A warning scrolls past
 * once; a deterministic check fires every time you look.
 *
 * This module is that check. It is deliberately:
 *
 *   - ENUMERATIVE, not hardcoded. The component list comes from `docker
 *     ps`, so a component added tomorrow is covered without editing a
 *     list here. (A hardcoded list is how the autoheal sidecar escaped
 *     notice in the first place.)
 *   - PURE at the analysis layer. `detectComponentDrift` is string-in /
 *     verdict-out so it unit-tests without docker.
 *   - NETWORK-FREE. The target version is resolved from local facts, so
 *     `doctor` stays fast and offline-safe. Comparing against the latest
 *     PUBLISHED release is the separate concern of the CLI self-update.
 */

import { compareReleaseTags } from "../config/release-resolve.js";

/** One switchroom component and the version it is currently running. */
export interface ComponentVersion {
  /** Container name (`switchroom-web`) or the literal `"cli (host)"`. */
  name: string;
  kind: "cli" | "container";
  /** `vX.Y.Z`, or null when the ref carries a non-semver tag
   *  (`:latest`, `:sha-abc1234`, a digest pin) or could not be read. */
  version: string | null;
  /** Full image ref, for containers. */
  imageRef?: string;
  /** Non-semver tag or probe error, surfaced verbatim to the operator. */
  detail?: string;
}

/** Verdict for the whole host. */
export interface ComponentDriftReport {
  /** Version everything is expected to be on — see {@link resolveDriftTarget}. */
  target: string | null;
  /** How `target` was chosen, for the operator-facing detail line. */
  targetSource: "release.pin" | "highest-deployed" | "none";
  /** Components strictly older than `target`. THE finding that matters. */
  behind: ComponentVersion[];
  /** Components strictly newer than `target` (mid-roll, or a manual bump). */
  ahead: ComponentVersion[];
  /** Components on `target`. */
  current: ComponentVersion[];
  /** Components whose version could not be compared (floating tag, probe
   *  failure). Reported, never silently dropped. */
  unknown: ComponentVersion[];
}

/** `vX.Y.Z` — the only tag shape the release comparison understands. */
const SEMVER_TAG_RE = /^v\d+\.\d+\.\d+$/;

/**
 * Extract the version tag from an image ref.
 *
 * Returns `{ version }` for a `vX.Y.Z` tag and `{ detail }` for anything
 * else (`:latest`, `:sha-…`, `@sha256:…`) so the caller can report WHY a
 * component is uncomparable instead of dropping it.
 */
export function versionFromImageRef(
  ref: string,
): { version: string | null; detail?: string } {
  const at = ref.indexOf("@");
  const withoutDigest = at >= 0 ? ref.slice(0, at) : ref;
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.indexOf(":", slash + 1);
  if (colon < 0) {
    return { version: null, detail: `image ref has no tag (${ref})` };
  }
  const tag = withoutDigest.slice(colon + 1);
  if (SEMVER_TAG_RE.test(tag)) return { version: tag };
  return { version: null, detail: `non-semver tag "${tag}"` };
}

/**
 * True when an image ref identifies a switchroom component whose tag
 * tracks the switchroom release.
 *
 * Keyed on the IMAGE, never on a name allowlist — a hardcoded list is how
 * the `hindsight-autoheal` sidecar escaped notice for three releases, so
 * a component added tomorrow must be covered the day it ships. Two rules,
 * both verified against a live host's `docker ps`:
 *
 *   1. The repository path must end in `/switchroom-<something>`. That
 *      admits every published component
 *      (`ghcr.io/switchroom/switchroom-{agent,web,hostd,hindsight,voice,
 *      auth-broker,kernel,broker}`) and excludes third-party images that
 *      happen to run under a switchroom-prefixed CONTAINER name — e.g.
 *      `switchroom-hostd-docker-proxy` → `ghcr.io/tecnativa/…`,
 *      `switchroom-grafana-fwd` → `alpine/socat`.
 *   2. Requiring the leading `/` also excludes locally-built bare-name
 *      images (`switchroom-uat-runner:local`), which are dev artifacts
 *      with no release tag and would otherwise be permanent `unknown`
 *      noise in every report.
 *
 * `name` is accepted for call-site clarity and future name-based
 * exclusions; the verdict deliberately depends only on the image.
 */
export function isSwitchroomReleaseImage(
  _name: string,
  imageRef: string,
): boolean {
  return /\/switchroom-[a-z0-9-]+(:|@|$)/.test(imageRef);
}

/** Minimal shell seam so the collector unit-tests without docker. */
export type ExecFn = (
  cmd: string,
  args: string[],
) => { status: number; stdout: string };

/**
 * Enumerate running switchroom containers and the version each is on.
 *
 * One `docker ps` — no per-container inspect — so this is cheap enough
 * to run on every `doctor` and every `update --check`. `--filter
 * name=switchroom-` is a prefix match on the container name, which is
 * how every switchroom component is named (`container_name:` is set
 * explicitly in all three compose projects and by `memory setup`).
 *
 * RUNNING containers only (no `-a`). A stopped component is a different
 * finding that doctor's service checks already own, and `-a` would drag
 * in exited one-shots (`switchroom-rollout-helper`) whose tags say
 * nothing about the current release.
 */
export function collectContainerComponents(exec: ExecFn): ComponentVersion[] {
  const r = exec("docker", [
    "ps",
    "--filter",
    "name=switchroom-",
    "--format",
    "{{.Names}}\t{{.Image}}",
  ]);
  if (r.status !== 0) return [];
  const out: ComponentVersion[] = [];
  for (const line of r.stdout.split("\n")) {
    const [name, imageRef] = line.trim().split("\t");
    if (!name || !imageRef) continue;
    if (!isSwitchroomReleaseImage(name, imageRef)) continue;
    const { version, detail } = versionFromImageRef(imageRef);
    out.push({
      name,
      kind: "container",
      version,
      imageRef,
      ...(detail ? { detail } : {}),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Normalize a bare `0.19.23` to the canonical `v0.19.23`. */
export function normalizeSemverTag(v: string | undefined): string | null {
  if (!v) return null;
  const tag = `v${v.trim().replace(/^v/, "")}`;
  return SEMVER_TAG_RE.test(tag) ? tag : null;
}

/**
 * Choose the version every component is expected to be on.
 *
 * `release.pin` wins when present: it is the operator's declared intent
 * and is what compose / `webd install` / `hostd install` all resolve
 * their tags from, so a component off the pin is unambiguously drifted.
 *
 * With no pin (a floating `channel:` install) there is no declared
 * target, so fall back to the HIGHEST version actually deployed on the
 * host. That is still a real finding: if one component reached vX and
 * another did not, something failed to advance it. It cannot detect
 * "the whole host is behind the published release" — that is the CLI
 * self-update's job, which does consult the network.
 */
export function resolveDriftTarget(
  components: readonly ComponentVersion[],
  releasePin: string | undefined,
): { target: string | null; targetSource: ComponentDriftReport["targetSource"] } {
  const pin = normalizeSemverTag(releasePin);
  if (pin) return { target: pin, targetSource: "release.pin" };
  let highest: string | null = null;
  for (const c of components) {
    if (!c.version) continue;
    if (highest === null) {
      highest = c.version;
      continue;
    }
    const cmp = compareReleaseTags(c.version, highest);
    if (cmp !== null && cmp > 0) highest = c.version;
  }
  return highest
    ? { target: highest, targetSource: "highest-deployed" }
    : { target: null, targetSource: "none" };
}

/**
 * Bucket every component against the target. Pure — no I/O.
 */
export function detectComponentDrift(
  components: readonly ComponentVersion[],
  releasePin: string | undefined,
): ComponentDriftReport {
  const { target, targetSource } = resolveDriftTarget(components, releasePin);
  const report: ComponentDriftReport = {
    target,
    targetSource,
    behind: [],
    ahead: [],
    current: [],
    unknown: [],
  };
  for (const c of components) {
    if (!c.version || !target) {
      report.unknown.push(c);
      continue;
    }
    const cmp = compareReleaseTags(c.version, target);
    if (cmp === null) report.unknown.push(c);
    else if (cmp < 0) report.behind.push(c);
    else if (cmp > 0) report.ahead.push(c);
    else report.current.push(c);
  }
  return report;
}

/**
 * What is known about the HOST operator CLI when the inventory is taken from
 * inside a container.
 *
 * `observedVersion` is what the host CLI recorded about itself in
 * `~/.switchroom/host-cli.json` (`host-cli-stamp.ts`) — the only way a
 * container can learn it, since hostd mounts `~/.switchroom` and nothing else.
 */
export interface HostCliObservation {
  /** True when the process taking the inventory runs inside a container. */
  inContainer: boolean;
  /** Semver from the stamp (`v`-prefixed or bare), when one exists. */
  observedVersion?: string;
}

/**
 * The `cli (host)` row. Pure, so the honesty rule is unit-asserted (#4571).
 *
 * On the host shell the running process IS the host CLI, so its own version
 * is authoritative. Inside a container it is NOT: `SWITCHROOM_VERSION` there
 * is the hostd/agent IMAGE's bundled CLI, and reporting that as `cli (host)`
 * is what let the real host binary drift five releases behind the fleet while
 * every check said the host CLI was fine. In a container the STAMPED version
 * wins; with no stamp the row is `unknown` — reported, never guessed.
 */
export function hostCliComponent(
  cliVersion: string,
  observation: HostCliObservation = { inContainer: false },
): ComponentVersion {
  if (observation.inContainer) {
    const stamped = normalizeSemverTag(observation.observedVersion);
    if (stamped) {
      return {
        name: "cli (host)",
        kind: "cli",
        version: stamped,
        detail: "observed via the host CLI stamp (~/.switchroom/host-cli.json)",
      };
    }
    return {
      name: "cli (host)",
      kind: "cli",
      version: null,
      detail:
        "not observable from inside a container and no host-cli.json stamp " +
        "found — run any switchroom command on the host to record it",
    };
  }
  const version = normalizeSemverTag(cliVersion);
  return {
    name: "cli (host)",
    kind: "cli",
    version,
    ...(version ? {} : { detail: `unparseable CLI version "${cliVersion}"` }),
  };
}

/**
 * Collect the full inventory: the host CLI plus every running container.
 *
 * `cliVersion` is the running CLI's own version (`SWITCHROOM_VERSION`).
 * It is passed in rather than imported so the caller controls the seam
 * and tests stay hermetic. `observation` decides whether that version can
 * honestly stand in for the HOST CLI — see {@link hostCliComponent}.
 */
export function collectComponents(
  cliVersion: string,
  exec: ExecFn,
  observation: HostCliObservation = { inContainer: false },
): ComponentVersion[] {
  return [hostCliComponent(cliVersion, observation), ...collectContainerComponents(exec)];
}

/**
 * One-line-per-component operator summary. Shared by `doctor` and
 * `update --check` so the two can never describe the host differently.
 */
export function formatComponentDrift(report: ComponentDriftReport): string {
  const lines: string[] = [];
  if (!report.target) {
    lines.push(
      "Component versions: no comparable version found (no release.pin and no semver-tagged component).",
    );
  } else {
    const src =
      report.targetSource === "release.pin"
        ? "release.pin"
        : "highest deployed version (no release.pin set)";
    lines.push(`Component versions — target ${report.target} (from ${src}):`);
  }
  for (const c of report.behind) {
    lines.push(`  BEHIND   ${c.name} — ${c.version} (target ${report.target})`);
  }
  for (const c of report.ahead) {
    lines.push(`  ahead    ${c.name} — ${c.version}`);
  }
  for (const c of report.unknown) {
    lines.push(`  unknown  ${c.name} — ${c.detail ?? "version not readable"}`);
  }
  for (const c of report.current) {
    lines.push(`  ok       ${c.name} — ${c.version}`);
  }
  return lines.join("\n");
}
