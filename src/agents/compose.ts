/**
 * Docker Compose generator — Phase 1a.
 *
 * Turns the cascade-resolved switchroom.yaml into a deterministic
 * docker-compose.yml.
 *
 * Determinism: agents are emitted in sorted name order, volumes
 * alphabetised, env keys sorted. Two apply runs against the same
 * inputs AND the same host filesystem state MUST produce a
 * byte-identical output (asserted by the snapshot tests in
 * tests/docker/compose-generator.test.ts). The host-filesystem
 * caveat covers the optional skills/credentials bind mounts (#907)
 * that we only emit when the source dirs actually exist — docker
 * compose `up` hard-fails when a `:ro` bind source is missing.
 *
 * Identity model:
 *   - Each agent gets a deterministic UID in 10001..10999 derived
 *     from a stable hash of its name (allocateAgentUid()).
 *   - Each agent's broker socket dir lives in its OWN named volume,
 *     mounted ONLY into that agent's container. Same for kernel.
 *   - The broker mounts every agent's socket dir under
 *     /run/switchroom/broker/<agent>; per-agent agents mount only
 *     their own dir under /run/switchroom/broker.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SwitchroomConfig, AgentConfig, AgentBindMount } from "../config/schema.js";
import { resolveAgentConfig } from "../config/merge.js";
import { isReservedAgentName } from "../vault/broker/peercred.js";
import { getBundledSkillsPoolDir } from "./reconcile-default-skills.js";

/** UID range reserved for agent containers. 999 slots — practical fleet limit. */
export const AGENT_UID_MIN = 10001;
export const AGENT_UID_MAX = 10999;

/** Resource defaults by profile category. RFC §"Resource limits as foot-guns". */
export interface ResourceDefaults {
  memLimit: string;
  cpus: number;
}

const RESOURCE_BY_PROFILE: Record<string, ResourceDefaults> = {
  klanker: { memLimit: "6g", cpus: 2.0 },
  // Conversational profiles — clerk, finn, carrie, coach, etc.
  conversational: { memLimit: "1.5g", cpus: 1.0 },
  // Lightweight profiles.
  lightweight: { memLimit: "1g", cpus: 0.5 },
  // Coding/worker/researcher.
  coding: { memLimit: "2g", cpus: 2.0 },
  // Catch-all default.
  default: { memLimit: "1.5g", cpus: 1.0 },
};

/**
 * Resolve resource defaults for an agent. Special-cases the agent name
 * "klanker" (matches the canonical fleet's klanker profile), then falls
 * through to the agent's `extends:` profile name, then to "default".
 *
 * Operator overrides at the agent level (resources.mem_limit etc.) win
 * over these defaults — see emitAgentService.
 */
export function resolveResourceDefaults(
  agentName: string,
  profile: string | undefined,
): ResourceDefaults {
  if (agentName === "klanker") return RESOURCE_BY_PROFILE.klanker!;
  if (profile && RESOURCE_BY_PROFILE[profile]) return RESOURCE_BY_PROFILE[profile]!;
  return RESOURCE_BY_PROFILE.default!;
}

/**
 * Allocate a deterministic UID for an agent in [AGENT_UID_MIN, AGENT_UID_MAX].
 *
 * Algorithm: SHA-256 of the agent name, take the first 4 bytes as a
 * uint32, modulo the range size, plus the floor. This is collision-prone
 * by birthday-paradox at large fleets — `checkAgentUidUniqueness` in
 * doctor flags collisions and instructs the operator to rename one of
 * the colliders. With 50 agents the collision probability is ~0.12%; at
 * the canonical ~10-agent fleet it's negligible.
 *
 * Determinism: same name → same UID, always. This matters for
 * compose regeneration after an `add agent` so existing agents' UIDs
 * never shift (which would require a chown sweep over their state).
 */
export function allocateAgentUid(name: string): number {
  // Names reserved by other identity kinds (today: "operator", used for
  // the host-shell broker socket) cannot be used as agent names.
  // Refusing here at allocation rather than letting a same-named agent
  // silently collide with the operator socket — which would forge an
  // identity from the broker's POV.
  if (isReservedAgentName(name)) {
    throw new Error(
      `agent name '${name}' is reserved by switchroom for another identity kind ` +
      `(see vault/broker/peercred.ts:RESERVED_AGENT_NAMES). Pick a different name.`,
    );
  }
  const hash = createHash("sha256").update(name).digest();
  const u32 = hash.readUInt32BE(0);
  const range = AGENT_UID_MAX - AGENT_UID_MIN + 1;
  return AGENT_UID_MIN + (u32 % range);
}

export interface ComposeGeneratorOptions {
  config: SwitchroomConfig;
  /** Image tag — same for every service in a release. */
  imageTag?: string;
  /** Stderr stream for warnings (cap-strip etc.); defaults to process.stderr. */
  warn?: (msg: string) => void;
  /**
   * Build mode. Default `pull` emits `image:` refs pointing at GHCR —
   * the production path; operators run `docker compose pull` and never
   * build locally. `local` instead emits `build:` blocks pointing at
   * the in-repo Dockerfiles — for dev work where the operator wants
   * `docker compose up --build` to use locally-modified Dockerfiles.
   */
  buildMode?: "pull" | "local";
  /**
   * Path to the switchroom checkout root. Required when `buildMode`
   * is `"local"`; the emitted `build.context` is set to this absolute
   * path so a compose file generated under `~/.switchroom/compose/`
   * still references the source tree's `docker/Dockerfile.*`.
   */
  buildContext?: string;
  /**
   * Absolute path to the operator's home directory — baked into every
   * host-path bind mount source at apply time.
   *
   * Why not `${HOME}`: compose interpolates env vars at the time the
   * `docker compose` CLI runs. When the operator runs `sudo docker
   * compose up -d`, sudo strips HOME by default (or sets it to /root),
   * so `${HOME}/.switchroom/...` resolves to `/root/.switchroom/...`
   * — wrong filesystem location, agent containers see empty volumes.
   *
   * Baking the absolute path at apply time eliminates the env-var
   * dependency. Optional for back-compat with callers that haven't
   * been updated yet (defaults to `${HOME}` interpolation).
   */
  homeDir?: string;
  /**
   * Absolute host path to the switchroom.yaml the operator wants the
   * containerised broker / kernel / scheduler to load. Bind-mounted
   * read-only into each of those services at /state/config/switchroom.yaml,
   * with `SWITCHROOM_CONFIG=/state/config/switchroom.yaml` set so they
   * skip the cwd auto-detect that doesn't exist inside the container.
   *
   * Without this, broker boots with `ConfigError: No switchroom.yaml found`
   * and restart-loops — the v0.7 P0 install-path bug. Optional for
   * back-compat; if omitted, broker / kernel get no config mount and
   * scheduler keeps its legacy `~/.switchroom:/state/config:ro` directory
   * mount (back-compat with pre-fix generated compose).
   */
  switchroomConfigPath?: string;
  /**
   * Prefix for `container_name:` values. Defaults to `"switchroom"` —
   * production behavior is unchanged. Setting this to a unique
   * per-test-run value (typical pattern: `phase1c-iso-${process.pid}`)
   * lets phase tests bring up their own broker/kernel/agent fleet
   * without colliding with the production singletons' fixed names on
   * a shared host.
   *
   * Belt-and-braces with `productionFleetIsLive()` skipIf guards in
   * `tests/docker/_prod-snapshot.ts`: even if a test forgets to skip
   * on a host with a live fleet, the parametrized name means it
   * creates `phase1c-iso-NNN-vault-broker` instead of clobbering
   * `switchroom-vault-broker`. Closes the test/prod-clobber regression
   * surfaced when PR #916 un-skipped the destructive docker phase
   * tests.
   *
   * Affects four slots:
   *   `container_name: <prefix>-vault-broker`
   *   `container_name: <prefix>-approval-kernel`
   *   `container_name: <prefix>-<agent-name>` for each agent
   *   `switchroom.fleet: "<prefix>"` label on every service
   *
   * The fleet label parametrization (added 2026-05-10 follow-up to PR
   * #939) lets `productionFleetIsLive()` distinguish a live production
   * fleet from a sibling phase test's fleet running in a parallel
   * vitest fork — the detection filter is `label=switchroom.fleet=
   * switchroom`, which now matches ONLY production. Without this, a
   * phase fleet from one fork looked like production to another fork
   * and produced spurious skip-with-"production-detected" reasons.
   *
   * Does NOT affect compose project name (`name: switchroom` at file
   * scope), service names (`vault-broker:`, `approval-kernel:`, the
   * agent service keys), or socket paths — those stay fixed because
   * the runtime / operator UX depends on them.
   */
  containerNamePrefix?: string;
  /**
   * Host operator UID — baked into the broker service so it knows which
   * UID to chown the operator socket+dir to at bind time. The operator
   * socket lives at `/run/switchroom/broker/operator/sock` inside the
   * broker container, host-bind-mounted at `${homeDir}/.switchroom/
   * broker-operator`. Without the chown, host-shell connects fail
   * because the socket is owned by root (the broker container's UID 0)
   * and the host operator runs as their own UID.
   *
   * Capture at apply time via `process.getuid()` (or `SUDO_UID` when
   * apply runs under sudo). Optional for back-compat: when omitted,
   * the broker skips the operator listener entirely and host-shell CLI
   * verbs continue to fail with "broker unreachable" — the same as
   * pre-fix behavior. Setting it is what turns the host-shell path on.
   */
  operatorUid?: number;
  /**
   * Host path to the bundled-default skills pool directory. Mounted
   * read-only at the same path inside each agent container so the
   * symlinks created by `reconcileAgentDefaultSkills` (which point at
   * this absolute host path — e.g. `<repo>/skills/skill-creator`) keep
   * resolving inside the container.
   *
   * Without this mount, the 10 bundled-default skills (skill-creator,
   * mcp-builder, pdf/docx/xlsx/pptx, webapp-testing, switchroom-cli/
   * status/health) dangle inside the container because their symlink
   * target — the source-repo or npm-package `skills/` dir — isn't
   * mounted. probeSkills surfaces this as "N/M dangling" on the boot
   * card.
   *
   * Defaults to `getBundledSkillsPoolDir()` — same resolver
   * `reconcileAgentDefaultSkills` uses, so the symlink target and the
   * mount source are guaranteed to agree. Tests override with a tmp
   * path (or empty string to suppress emission).
   */
  bundledSkillsPoolDir?: string;
}

/** Resolve the image ref for one of the four service images. */
function resolveImageRef(
  name: "agent" | "broker" | "kernel" | "scheduler",
  imageTag: string,
): string {
  return `ghcr.io/switchroom/switchroom-${name}:${imageTag}`;
}

/**
 * Render the YAML lines for either an `image:` ref (pull mode) or a
 * `build:` block (local mode). Indentation is fixed at 4 spaces — the
 * caller has already emitted `  <service-name>:`.
 */
function emitImageOrBuild(
  lines: string[],
  service: "agent" | "broker" | "kernel" | "scheduler",
  imageTag: string,
  buildMode: "pull" | "local",
  buildContext: string | undefined,
): void {
  if (buildMode === "local") {
    if (!buildContext) {
      throw new Error(
        `compose: buildMode="local" requires buildContext (the absolute path to the switchroom checkout)`,
      );
    }
    lines.push(`    build:`);
    lines.push(`      context: ${buildContext}`);
    lines.push(`      dockerfile: docker/Dockerfile.${service}`);
  } else {
    lines.push(`    image: ${resolveImageRef(service, imageTag)}`);
  }
}

interface AgentServiceData {
  name: string;
  uid: number;
  profile: string | undefined;
  resources: ResourceDefaults;
  /** Capability extras the operator requested AND we stripped. */
  strippedCaps: string[];
  /**
   * Yaml-level `admin: true` flag — when set, surfaces as
   * `SWITCHROOM_AGENT_ADMIN=true` on the agent container so the
   * gateway permits admin slash commands (`/vault`, `/agents`,
   * `/logs`, `/grant`, `/update` etc). Default false.
   */
  admin: boolean;
  /**
   * Operator-declared extra bind-mounts (#1164). ADMIN-ONLY: validated
   * + emitted by `emitAgentService` if and only if `admin === true`.
   * Read directly from the per-agent config — deliberately not
   * cascade-merged, so a profile can't silently grant filesystem reach
   * to every agent that extends it.
   */
  bindMounts: AgentBindMount[];
  /**
   * Operator-declared env vars from the cascade-resolved agent config
   * (`agent.env` block in switchroom.yaml). Propagated into the
   * compose `environment:` block so child processes forked
   * BEFORE start.sh's `export` lines (e.g. the gateway sidecar at
   * `profiles/_base/start.sh.hbs:88`) can see them. Without this
   * route, env vars set in switchroom.yaml are silently lossy for
   * the gateway — they only reach Claude itself via the start.sh
   * exports much later in the boot sequence.
   *
   * Repo/humanizer/channel-derived env stays in `userEnvQuoted` for
   * scaffold.ts only — those are agent-shell-scoped, not container-
   * wide. The schema's user-facing `env:` field is the one that
   * mirrors here.
   */
  userEnv: Record<string, string>;
}

/** Per-agent metadata exposed to doctor checks (and tests). */
export function describeAgents(config: SwitchroomConfig): AgentServiceData[] {
  const out: AgentServiceData[] = [];
  for (const name of Object.keys(config.agents).sort()) {
    const agent = config.agents[name]!;
    const resolved = resolveAgentConfig(config.defaults, config.profiles, agent);
    const profile = agent.extends ?? "default";
    const uid = allocateAgentUid(name);
    const resources = resolveResourceDefaults(name, profile);
    const strippedCaps = readStrippedCaps(agent);
    out.push({
      name,
      uid,
      profile,
      resources,
      strippedCaps,
      admin: agent.admin === true,
      // Per-agent only (no cascade) — see AgentServiceData.bindMounts
      // doc comment for the rationale.
      bindMounts: agent.bind_mounts ? [...agent.bind_mounts] : [],
      // Read user env from the cascade-resolved config so defaults +
      // profile + agent layers all contribute. Empty object when the
      // operator hasn't declared any (the common case).
      userEnv: { ...(resolved.env ?? {}) },
    });
    void resolved;
  }
  return out;
}

/**
 * System paths refused as bind_mount sources, regardless of mode.
 * Prefix-matched against the *normalized* source path: an entry `/etc`
 * rejects `/etc/foo`, `//etc`, `/etc/.`, etc.
 *
 * Mounting any of these inside an agent container is either pointless
 * (the container has its own /proc, /sys, /dev) or a privilege-escalation
 * vector (host `/etc` exposes shadow/passwd; `/var/lib/docker` and the
 * docker socket give root-equivalent host control).
 */
const BIND_MOUNT_SOURCE_DENYLIST = [
  "/",
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/var/run",
  "/boot",
  "/var/lib/docker",
];

/**
 * Container paths refused as bind_mount targets.
 *
 * Two classes:
 *   (1) switchroom-owned container locations — overlaying these breaks
 *       the agent runtime (`/state/*` is the agent's state mount, `/opt/switchroom`
 *       is the bundled CLI, `/run/switchroom/*` is the broker/kernel/hostd
 *       socket mounts, `/var/log/switchroom` is the log mount).
 *   (2) OS-shadow vectors — shadowing `/etc`, `/bin`, etc. inside the
 *       container would let an admin agent surprise itself or future
 *       agents that extend the same profile. Admin-only blast radius,
 *       but cheap to refuse.
 */
const BIND_MOUNT_TARGET_DENYLIST = [
  // switchroom-owned (must not be overridable from yaml)
  "/state",
  "/run/switchroom",
  "/var/log/switchroom",
  "/opt/switchroom",
  // OS-shadow vectors
  "/",
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/lib",
  "/lib64",
  "/usr/lib",
];

/** Exact source paths refused regardless of prefix-matching. */
const BIND_MOUNT_EXACT_SOURCE_DENY = new Set(["/var/run/docker.sock"]);

/**
 * Normalize an absolute POSIX-style path for denylist comparison.
 *   - Collapses runs of `/` to a single `/` (so `//etc` → `/etc`).
 *   - Collapses `.` segments (so `/etc/.` → `/etc`, `/./etc` → `/etc`).
 *   - Strips a trailing `/` (so `/etc/` → `/etc`), unless the input is
 *     the literal `/`.
 *
 * Caller must reject `..` segments BEFORE calling this; we intentionally
 * do not resolve `..` (resolving would mask the original intent — an
 * input that pre-resolution contains `/..` should error, not silently
 * normalize). Pure — no IO. Does NOT follow symlinks; that's a
 * documented limitation (see docs/configuration.md § bind_mounts).
 */
export function normalizeBindMountPath(p: string): string {
  // Collapse repeated slashes.
  let out = p.replace(/\/+/g, "/");
  // Strip "/." segments. Iteration handles `/./.` cases.
  out = out.replace(/(\/)\.(?=\/|$)/g, "$1").replace(/\/+/g, "/");
  // Strip trailing slash unless the whole path is the root.
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/**
 * Validate one entry from an agent's `bind_mounts:` list. Returns the
 * resolved (source, target, mode) on success; throws a descriptive
 * Error on rejection. Pure — no IO.
 *
 * Callers MUST also check the owning agent's `admin === true` before
 * calling this; the admin gate is upstream (in emitAgentService).
 *
 * Note on symlinks: this validator is textual. If `source` points at
 * a host path that is itself a symlink to a denylisted directory
 * (e.g. `/home/me/proj → /etc`), the textual denylist will pass but
 * Docker will resolve the symlink at mount time and the agent ends up
 * with /etc anyway. Admin-trusted: the operator who set `admin: true`
 * is the same principal who controls host filesystem layout. See the
 * docs caveat at `docs/configuration.md` § bind_mounts.
 */
export function resolveBindMount(
  agentName: string,
  entry: AgentBindMount,
): { source: string; target: string; mode: "ro" | "rw" } {
  const rawSource = entry.source;
  if (typeof rawSource !== "string" || rawSource.length === 0) {
    throw new Error(
      `compose: agent "${agentName}" bind_mount has empty source`,
    );
  }
  if (!rawSource.startsWith("/")) {
    throw new Error(
      `compose: agent "${agentName}" bind_mount source "${rawSource}" must be an absolute path ` +
      `(tilde-expansion is not performed; pass the literal absolute path)`,
    );
  }
  // `..` rejected before normalization — see normalizeBindMountPath
  // docstring for the rationale (we don't want to silently resolve
  // `/etc/../foo` to `/foo`; the caller's intent was ambiguous).
  if (
    rawSource.includes("/../") ||
    rawSource.endsWith("/..") ||
    rawSource === "/.."
  ) {
    throw new Error(
      `compose: agent "${agentName}" bind_mount source "${rawSource}" contains '..' — refuse ambiguous paths`,
    );
  }
  const source = normalizeBindMountPath(rawSource);
  if (BIND_MOUNT_EXACT_SOURCE_DENY.has(source)) {
    throw new Error(
      `compose: agent "${agentName}" bind_mount source "${rawSource}" is denylisted ` +
      `(host docker socket — would grant root-equivalent control of the host)`,
    );
  }
  for (const deny of BIND_MOUNT_SOURCE_DENYLIST) {
    if (source === deny || source.startsWith(deny === "/" ? "/" : deny + "/")) {
      // The "/" entry would otherwise match every absolute path; only
      // refuse the literal "/" as source. A path like "/home/x" passes —
      // it merely *starts* with "/" but the denylist intent is "the
      // root itself".
      if (deny === "/" && source !== "/") continue;
      throw new Error(
        `compose: agent "${agentName}" bind_mount source "${rawSource}" is under denylisted system path "${deny}"`,
      );
    }
  }
  const rawTarget = entry.target ?? rawSource;
  if (!rawTarget.startsWith("/")) {
    throw new Error(
      `compose: agent "${agentName}" bind_mount target "${rawTarget}" must be an absolute path`,
    );
  }
  if (
    rawTarget.includes("/../") ||
    rawTarget.endsWith("/..") ||
    rawTarget === "/.."
  ) {
    throw new Error(
      `compose: agent "${agentName}" bind_mount target "${rawTarget}" contains '..' — refuse ambiguous paths`,
    );
  }
  const target = normalizeBindMountPath(rawTarget);
  for (const deny of BIND_MOUNT_TARGET_DENYLIST) {
    if (target === deny || target.startsWith(deny === "/" ? "/" : deny + "/")) {
      if (deny === "/" && target !== "/") continue;
      throw new Error(
        `compose: agent "${agentName}" bind_mount target "${rawTarget}" is under denylisted container path "${deny}" ` +
        `(switchroom-owned mount or OS-shadow vector — pick a different target)`,
      );
    }
  }
  const mode = entry.mode ?? "ro";
  // Emit the *normalized* paths so the generated compose is byte-stable
  // across textually-equivalent inputs (e.g. `//foo` and `/foo`).
  return { source, target, mode };
}

/** Capability-add escape hatch — we strip these in Docker mode (RFC). */
function readStrippedCaps(agent: AgentConfig): string[] {
  // The schema does not currently declare cap_add; an operator might
  // still smuggle it via settings_raw. We grep the raw settings for it.
  const raw = (agent.settings_raw ?? {}) as Record<string, unknown>;
  const caps = raw.cap_add;
  if (Array.isArray(caps)) return caps.map(String);
  return [];
}

/**
 * Generate a docker-compose.yml from the cascade. Pure function: no IO,
 * no env reads. Deterministic for byte-identical input.
 */
export function generateCompose(opts: ComposeGeneratorOptions): string {
  const { config } = opts;
  const imageTag = opts.imageTag ?? "latest";
  const warn = opts.warn ?? ((m: string) => process.stderr.write(m + "\n"));
  const buildMode = opts.buildMode ?? "pull";
  const buildContext = opts.buildContext;
  // homePrefix is the leading segment of every host-path bind source.
  // When the caller passes homeDir we bake an absolute path so compose
  // interpolation under sudo can't mis-resolve HOME to /root. Default
  // preserves the older `${HOME}` shape for callers that haven't been
  // updated.
  const homePrefix = opts.homeDir ?? "${HOME}";
  // Default container_name prefix matches the compose project name and
  // every operator command in the docs (`docker exec -it switchroom-
  // vault-broker ...`, `journalctl --user -u switchroom-vault-broker`).
  // Tests override this so phase fleets get unique names that can't
  // collide with a production install on the same host.
  const containerNamePrefix = opts.containerNamePrefix ?? "switchroom";
  // Host-control daemon (RFC C, Phase 1) — opt-in via top-level
  // host_control.enabled. When false (default) compose emits the
  // same shape as before; when true, admin agents get an extra
  // bind-mount line for the daemon's per-agent UDS.
  const hostControlEnabled = config.host_control?.enabled === true;
  // For existsSync() decisions on optional bind-mount sources (#907):
  // emission uses `homePrefix` (which may be the literal "${HOME}" so
  // sudo-bake works), but the existsSync probe must use the real host
  // home. Falls back to process.env.HOME when no homeDir is passed.
  const hostHomeForChecks = opts.homeDir ?? process.env.HOME ?? "";
  const switchroomConfigPath = opts.switchroomConfigPath;
  // Bundled-skills pool dir. Default to the live resolver so production
  // calls Just Work; tests pass an explicit path (or "") to override.
  const bundledSkillsPoolDir = opts.bundledSkillsPoolDir ?? getBundledSkillsPoolDir();

  // Resolve the host's analytics distinct ID once per generator call. The
  // CLI persists this at ~/.switchroom/analytics-id (see
  // src/analytics/posthog.ts:getDistinctId). Threading it through to the
  // agent container means runtime events merge with the same user's CLI
  // events in PostHog (same distinctId, different `source` property).
  //
  // If the file doesn't exist (fresh install before any CLI invocation
  // wrote it), we skip emitting the env var — the gateway's
  // analytics-posthog.ts falls back to a per-agent UUID at
  // /state/agent/analytics-id. Determinism: if the file is present, its
  // contents are stable across runs by design.
  let resolvedAnalyticsId: string | null = null;
  if (hostHomeForChecks !== "") {
    const idPath = join(hostHomeForChecks, ".switchroom", "analytics-id");
    if (existsSync(idPath)) {
      try {
        const raw = readFileSync(idPath, "utf-8").trim();
        if (raw !== "") resolvedAnalyticsId = raw;
      } catch {
        // Non-fatal — gateway will fall back.
      }
    }
  }
  // Operator opt-out — surfaced from the host env so a single
  // SWITCHROOM_TELEMETRY_DISABLED=1 in the operator's shell propagates
  // fleet-wide.
  const telemetryDisabled = process.env.SWITCHROOM_TELEMETRY_DISABLED;
  const posthogKeyOverride = process.env.SWITCHROOM_POSTHOG_KEY;
  const posthogHostOverride = process.env.SWITCHROOM_POSTHOG_HOST;
  if (buildMode === "local" && !buildContext) {
    throw new Error(
      `compose: buildMode="local" requires buildContext (the absolute path to the switchroom checkout)`,
    );
  }

  const lines: string[] = [];
  lines.push("# generated by switchroom — do not edit by hand.");
  lines.push("# Manual edits will be overwritten on the next `switchroom agent add`");
  lines.push("# (or future `switchroom reconcile`). To customise an agent, edit");
  lines.push("# switchroom.yaml and re-run the regenerating command.");
  lines.push("");
  lines.push(`# image tag: ${imageTag}`);
  lines.push("");
  // Top-level project name — belt-and-braces collision protection. A
  // Coolify-managed (or any other) compose stack on the same host can't
  // accidentally claim our service/container names because compose
  // namespaces by project; pinning the name at file scope means
  // `docker compose -f <path> ...` invocations always target the same
  // project even when the operator forgets `-p switchroom`.
  lines.push(`name: switchroom`);
  lines.push("");
  lines.push(`services:`);

  // ── vault-broker (singleton) ───────────────────────────────────────
  lines.push(`  vault-broker:`);
  emitImageOrBuild(lines, "broker", imageTag, buildMode, buildContext);
  lines.push(`    container_name: ${containerNamePrefix}-vault-broker`);
  // Fleet labels for ad-hoc selection (e.g. `docker ps --filter label=switchroom.role=agent`).
  lines.push(`    labels:`);
  lines.push(`      switchroom.role: "broker"`);
  lines.push(`      switchroom.fleet: "${containerNamePrefix}"`);
  lines.push(`    restart: unless-stopped`);
  // Liveness probe — bind-presence. The broker creates per-agent
  // socket directories at startup and binds `<dir>/sock` for each
  // configured agent. If at least one bind has happened, the daemon
  // is alive enough to take work; if every bind has gone away, the
  // daemon is wedged or dead and `restart: unless-stopped` should
  // recycle it. This catches the silent-down failure mode where the
  // broker exits cleanly (compose then sees process-gone) AS WELL AS
  // a hung daemon that's still holding the process slot but stopped
  // listening.
  //
  // Trade-off: an empty fleet (no agents → no per-agent dirs → no
  // sockets) reports unhealthy. Acceptable: a switchroom install
  // without any agents has no business running the broker; an
  // operator who's mid-install has minutes-scale exposure to this.
  // We do NOT speak the broker's app protocol here — that requires
  // peercred-checked auth and would generate audit-log noise on
  // every healthcheck tick. Bind-presence is the right level.
  lines.push(`    healthcheck:`);
  lines.push(`      test: ["CMD-SHELL", "ls /run/switchroom/broker/*/sock 2>/dev/null | head -1 | grep -q ."]`);
  lines.push(`      interval: 30s`);
  lines.push(`      timeout: 5s`);
  lines.push(`      retries: 3`);
  lines.push(`      start_period: 20s`);
  lines.push(`    user: "0:0"`);
  lines.push(`    stop_grace_period: 10s`);
  lines.push(`    security_opt:`);
  lines.push(`      - "no-new-privileges:true"`);
  lines.push(`    cap_drop:`);
  lines.push(`      - "ALL"`);
  // Broker needs:
  //  - CHOWN + FOWNER: take ownership of per-agent socket dirs
  //    (created at startup) and chmod sockets to 0660 owned by the
  //    agent's UID.
  //  - DAC_READ_SEARCH: bypass DAC checks to read the operator-owned
  //    vault files. Broker runs as UID 0 so it can chown sockets, but
  //    `cap_drop: ALL` strips DAC_OVERRIDE / DAC_READ_SEARCH — without
  //    re-adding it, root can't read 0600 files owned by the operator's
  //    UID (which is what `setup` writes for vault.enc and
  //    `enable-auto-unlock` writes for vault-auto-unlock). Verified
  //    against a v0.7.3 test cutover: without this cap the broker
  //    boots, hits "Permission denied" on `/state/vault-auto-unlock`,
  //    logs `auto-unlock decrypt failed (io)`, and falls back to
  //    interactive unlock — i.e. auto-unlock is silently broken under
  //    docker.
  //  - DAC_OVERRIDE: bypass DAC checks for WRITE access to the vault
  //    dir (post-v0.7.12 op:put rotation). Without it, broker can
  //    READ the operator-owned vault dir (DAC_READ_SEARCH) but
  //    rejects mkdir/write into it because the host dir is mode 0700
  //    owned by the operator UID and the broker's container-root UID
  //    isn't recognized as the owner. Caught when self-deploying
  //    v0.7.12 against the operator's fleet: ms_graph_token.py
  //    succeeded reading the token but EACCES'd on writing the
  //    rotated value via `op:put`. The cap is consistent with the
  //    broker's existing trust posture (it already holds the
  //    passphrase + decrypted secrets in memory; allowing write is
  //    not an expansion of access, just of operations).
  lines.push(`    cap_add:`);
  lines.push(`      - "CHOWN"`);
  lines.push(`      - "FOWNER"`);
  lines.push(`      - "DAC_READ_SEARCH"`);
  lines.push(`      - "DAC_OVERRIDE"`);
  lines.push(`    environment:`);
  if (switchroomConfigPath) {
    lines.push(`      SWITCHROOM_CONFIG: /state/config/switchroom.yaml`);
  }
  // Vault file path inside the container. Set explicitly so the broker
  // does NOT fall back to its `~/.switchroom/vault.enc` default — which
  // would resolve `~` against the container's HOME (/root) instead of
  // the operator's HOME on the host.
  // Broker's vault path. Always reads `/state/vault/vault.enc` —
  // the parent dir is bind-mounted from the host's resolved
  // `vault.path` parent (default `~/.switchroom/vault/`). v0.7.11
  // mounted the file directly which made atomic-rename impossible
  // (cross-fs single-file bind mount, EBUSY); v0.7.12 mounts the
  // parent dir so saveVault's write-temp-then-rename works.
  lines.push(`      SWITCHROOM_VAULT_PATH: /state/vault/vault.enc`);
  lines.push(`      SWITCHROOM_VAULT_BROKER_AUTO_UNLOCK_PATH: /state/vault-auto-unlock`);
  // Operator UID — when set, the broker binds an additional listener at
  // /run/switchroom/broker/operator/sock and chowns it to this UID so
  // the host operator's shell can talk to the broker through the bind
  // mount below. See server.bindOperatorListener for the runtime side.
  if (opts.operatorUid !== undefined) {
    lines.push(`      SWITCHROOM_BROKER_OPERATOR_UID: "${opts.operatorUid}"`);
  }
  lines.push(`    volumes:`);
  for (const a of describeAgents(config)) {
    lines.push(`      - broker-${a.name}-sock:/run/switchroom/broker/${a.name}`);
  }
  // Operator listener bind — only emitted when operatorUid is set so a
  // legacy install (no operatorUid → no operator listener) doesn't get
  // an unused bind that just confuses operators staring at the compose
  // file. Both ends of the path-as-identity contract live here:
  //   host: ${homePrefix}/.switchroom/broker-operator
  //   container: /run/switchroom/broker/operator
  // peercred.socketPathToIdentity recognises the container path and
  // returns {kind: "operator"}; the broker chowns the socket to
  // operatorUid at bind time. The dir is auto-created by docker on
  // bind-mount setup; no host-side mkdir required.
  if (opts.operatorUid !== undefined) {
    lines.push(
      `      - ${homePrefix}/.switchroom/broker-operator:/run/switchroom/broker/operator`,
    );
  }
  if (switchroomConfigPath) {
    lines.push(`      - ${switchroomConfigPath}:/state/config/switchroom.yaml:ro`);
  }
  // Vault parent directory mounted RW. v0.7.12 layout: vault file
  // lives at `~/.switchroom/vault/vault.enc`, parent dir is
  // bind-mounted at `/state/vault/`. atomicWriteFileSync's write-
  // temp-then-rename pattern works because temp file lands in the
  // same fs as the destination.
  //
  // v0.7.11 (and earlier) mounted the FILE directly (`~/.switchroom/
  // vault.enc:/state/vault.enc:ro`). That had two problems:
  //   1. Single-file bind mount + atomic-rename = EBUSY (cross-fs
  //      rename to a bind-mount target fails). Surfaced as #954.
  //   2. RO precluded broker-driven rotation (#952's op:put). Both
  //      fixed by switching to a parent-dir RW mount.
  //
  // The v0.7.0 install bug — docker auto-creating an empty root-
  // owned `~/.switchroom/vault/` on the host — is avoided by
  // ensuring the directory exists with the operator's UID before
  // compose runs. `switchroom apply`'s migrateVaultLayout step
  // creates the directory with mode 0700 and moves the existing
  // vault file into it, so docker never has to create an empty
  // vault dir.
  //
  // Broker reads `/state/vault/vault.enc` (see SWITCHROOM_VAULT_PATH
  // env above). The parent-dir guard at apply time refuses to mount
  // if the dir contains anything other than the canonical vault
  // file + saveVault's known artifacts (lockfile, sibling-tmp, etc).
  lines.push(`      - ${homePrefix}/.switchroom/vault:/state/vault:rw`);
  // Auto-unlock blob (encrypted with /etc/machine-id-derived key).
  // Mounted read-only — the broker only ever reads the blob; rotation
  // is performed by the host CLI (`switchroom vault broker enable-auto-unlock`)
  // followed by a `docker compose restart vault-broker`. Compose treats
  // a missing source as an empty directory — the broker detects that
  // and falls back to the interactive unlock flow, so operators who
  // never enabled auto-unlock are unaffected.
  lines.push(`      - ${homePrefix}/.switchroom/vault-auto-unlock:/state/vault-auto-unlock:ro`);
  // Audit log — bind-mount the host file into the broker so deny/
  // allow events the broker writes land on the host fs. Without this
  // mount the broker writes to `/root/.switchroom/vault-audit.log`
  // inside the container (which evaporates on recreate and is
  // unreachable to both the host CLI `switchroom vault audit` and
  // the admin-agent :ro mount wired in #1024). The host file is
  // pre-created at mode 0644 by `ensureHostMountSources()` so docker
  // doesn't auto-create a directory at the source path. Writable
  // because broker appends; broker runs as root with CAP_DAC_OVERRIDE
  // so file ownership/mode doesn't gate the write path. See #1025.
  lines.push(`      - ${homePrefix}/.switchroom/vault-audit.log:/root/.switchroom/vault-audit.log`);
  // /etc/machine-id passthrough — required so the broker can derive
  // the same machine-bound key the host's `enable-auto-unlock` used
  // to seal the auto-unlock blob. The agent base image (node:22-bookworm-slim)
  // ships without /etc/machine-id; without this mount the broker
  // errors out "Cannot derive machine-bound key: neither /etc/machine-id
  // nor /var/lib/dbus/machine-id is readable" and falls back to
  // interactive unlock. Mount the FILE (not the /etc dir) so we don't
  // shadow the rest of /etc inside the broker image.
  lines.push(`      - /etc/machine-id:/etc/machine-id:ro`);
  lines.push(``);

  // ── approval-kernel (singleton) ────────────────────────────────────
  lines.push(`  approval-kernel:`);
  emitImageOrBuild(lines, "kernel", imageTag, buildMode, buildContext);
  lines.push(`    container_name: ${containerNamePrefix}-approval-kernel`);
  lines.push(`    labels:`);
  lines.push(`      switchroom.role: "kernel"`);
  lines.push(`      switchroom.fleet: "${containerNamePrefix}"`);
  lines.push(`    restart: unless-stopped`);
  // Mirror the broker's bind-presence healthcheck — same failure-mode
  // surface (kernel binds per-agent sockets at
  // /run/switchroom/kernel/<agent>/sock; silently exits or hangs the
  // same way) and same empty-fleet trade-off documented above.
  lines.push(`    healthcheck:`);
  lines.push(`      test: ["CMD-SHELL", "ls /run/switchroom/kernel/*/sock 2>/dev/null | head -1 | grep -q ."]`);
  lines.push(`      interval: 30s`);
  lines.push(`      timeout: 5s`);
  lines.push(`      retries: 3`);
  lines.push(`      start_period: 20s`);
  lines.push(`    user: "0:0"`);
  lines.push(`    stop_grace_period: 10s`);
  lines.push(`    security_opt:`);
  lines.push(`      - "no-new-privileges:true"`);
  lines.push(`    cap_drop:`);
  lines.push(`      - "ALL"`);
  // Kernel mirrors broker: it owns per-agent socket dirs and must chown
  // sockets to the agent UID after bind().
  //
  // DAC_READ_SEARCH is needed by the healthcheck probe (PR #898) — it
  // runs `ls /run/switchroom/kernel/*/sock` as root, but per-agent
  // socket dirs are mode 0700 owned by the agent UID after bind. With
  // `cap_drop: ALL` and only CHOWN + FOWNER, root cannot read into
  // those dirs, so the probe always fails. Broker already has this
  // cap (for vault file reads); adding it here gives both singletons
  // the same probe-reachability. Read-only DAC bypass — strictly less
  // powerful than DAC_OVERRIDE which also bypasses write checks.
  lines.push(`    cap_add:`);
  lines.push(`      - "CHOWN"`);
  lines.push(`      - "FOWNER"`);
  lines.push(`      - "DAC_READ_SEARCH"`);
  if (switchroomConfigPath) {
    lines.push(`    environment:`);
    lines.push(`      SWITCHROOM_CONFIG: /state/config/switchroom.yaml`);
  }
  lines.push(`    volumes:`);
  for (const a of describeAgents(config)) {
    lines.push(`      - kernel-${a.name}-sock:/run/switchroom/kernel/${a.name}`);
  }
  if (switchroomConfigPath) {
    lines.push(`      - ${switchroomConfigPath}:/state/config/switchroom.yaml:ro`);
  }
  lines.push(`      - ${homePrefix}/.switchroom/approvals:/state/approvals`);
  lines.push(``);

  // The singleton switchroom-cron service was removed in Phase 4 of
  // the cron-fold-in. Cron now runs in-container as a sibling of the
  // gateway in every agent (see profiles/_base/start.sh.hbs's third
  // supervised sidecar and src/agent-scheduler/). Fires arrive in the
  // agent transcript through the same InboundMessage path Telegram
  // uses, tagged meta.source="cron".

  // ── per-agent services ─────────────────────────────────────────────
  for (const a of describeAgents(config)) {
    if (a.strippedCaps.length > 0) {
      warn(`compose: stripping cap_add ${JSON.stringify(a.strippedCaps)} from agent "${a.name}" (Docker mode forbids capability extras; see RFC §security)`);
    }
    emitAgentService(
      lines,
      a,
      imageTag,
      buildMode,
      buildContext,
      homePrefix,
      hostHomeForChecks,
      switchroomConfigPath,
      containerNamePrefix,
      {
        analyticsId: resolvedAnalyticsId,
        telemetryDisabled,
        posthogKeyOverride,
        posthogHostOverride,
      },
      bundledSkillsPoolDir,
      hostControlEnabled,
    );
  }

  // ── volumes ────────────────────────────────────────────────────────
  lines.push(`volumes:`);
  for (const a of describeAgents(config)) {
    lines.push(`  broker-${a.name}-sock:`);
    lines.push(`  kernel-${a.name}-sock:`);
  }
  lines.push("");

  return lines.join("\n");
}

interface PosthogRuntimeEnv {
  /** Host-resolved distinct ID from ~/.switchroom/analytics-id, or null
   *  if the file is missing/empty — gateway falls back to a per-agent UUID. */
  analyticsId: string | null;
  /** Verbatim value of process.env.SWITCHROOM_TELEMETRY_DISABLED on the
   *  host. Normalised to "1" before emission so the gateway's truthy check
   *  doesn't depend on operator casing. */
  telemetryDisabled: string | undefined;
  /** Optional PostHog key override (host env). */
  posthogKeyOverride: string | undefined;
  /** Optional PostHog host override (host env). */
  posthogHostOverride: string | undefined;
}

function emitAgentService(
  lines: string[],
  a: AgentServiceData,
  imageTag: string,
  buildMode: "pull" | "local",
  buildContext: string | undefined,
  homePrefix: string,
  hostHomeForChecks: string,
  switchroomConfigPath: string | undefined,
  containerNamePrefix: string,
  posthog: PosthogRuntimeEnv,
  bundledSkillsPoolDir: string,
  hostControlEnabled: boolean,
): void {
  lines.push(`  agent-${a.name}:`);
  emitImageOrBuild(lines, "agent", imageTag, buildMode, buildContext);
  lines.push(`    container_name: ${containerNamePrefix}-${a.name}`);
  lines.push(`    labels:`);
  lines.push(`      switchroom.role: "agent"`);
  lines.push(`      switchroom.fleet: "${containerNamePrefix}"`);
  lines.push(`      switchroom.agent: "${a.name}"`);
  // Share the host's network namespace.
  //
  // Scaffolded `start.sh` and the env baked into it reach a number of
  // host-local endpoints by their host-side address: Hindsight at
  // 127.0.0.1:18888 (host-loopback), the operator's LAN devices for
  // user-declared env vars (HA at 192.168.x.x, NAS, smart-home gear),
  // and the host's resolver for any DNS. With the default bridge
  // network those are unreachable from inside the container —
  // `127.0.0.1` is the container's own loopback, and the LAN is on the
  // host side of the bridge. v0.7.0 → v0.7.3 emitted no network config
  // and the agent silently failed: hindsight wait-loop timed out, MCP
  // servers errored at startup, telegram polling never began.
  // `network_mode: host` puts the agent on the host's network stack —
  // identical semantics to the v0.6 systemd-era model. Tradeoff:
  // network isolation between agents goes away (they can reach each
  // other and any host service), but the previous trust model already
  // assumed shared-host operation. Future work: a strict-isolation
  // mode that puts agents on a custom network and routes hindsight
  // through an explicit `extra_hosts` entry for `host.docker.internal`.
  lines.push(`    network_mode: host`);
  lines.push(`    restart: unless-stopped`);
  lines.push(`    init: false`);
  // PTY allocation — claude's interactive mode requires a TTY at stdin
  // (the alt-screen UI, autoaccept-poll keystrokes, and the `--print`
  // fallback's stdin check). Without these the container boots, claude
  // detects "no TTY → fall back to --print", immediately errors
  // "Input must be provided either through stdin or as a prompt
  // argument when using --print", tini exits, and the container
  // restarts forever. Equivalent to `docker run -it`. v0.6's systemd
  // path got the PTY for free via the tmux ExecStart wrapper; under
  // docker we ask compose for it directly.
  lines.push(`    tty: true`);
  lines.push(`    stdin_open: true`);
  lines.push(`    stop_grace_period: 45s`);
  lines.push(`    user: "${a.uid}:${a.uid}"`);
  lines.push(`    mem_limit: ${a.resources.memLimit}`);
  lines.push(`    cpus: ${a.resources.cpus.toFixed(1)}`);
  lines.push(`    security_opt:`);
  lines.push(`      - "no-new-privileges:true"`);
  lines.push(`    cap_drop:`);
  lines.push(`      - "ALL"`);
  // read_only root FS — claude CLI, tini, tmux, node only need writable
  // /tmp (and the explicit /state/* mounts above). tmpfs keeps /tmp
  // RAM-backed and capped so a runaway can't fill the host disk.
  lines.push(`    read_only: true`);
  lines.push(`    tmpfs:`);
  lines.push(`      - /tmp:size=256m,mode=1777`);
  lines.push(`    depends_on:`);
  lines.push(`      vault-broker:`);
  lines.push(`        condition: service_started`);
  lines.push(`      approval-kernel:`);
  lines.push(`        condition: service_started`);
  lines.push(`    environment:`);
  // env keys MUST be sorted for byte determinism.
  const env: Record<string, string> = {
    // Per-agent persistent HOME — lives at ~/.switchroom/agents/<name>/home
    // on the host (inside the existing /state/agent bind mount, no extra
    // volume needed). The container's ImageConfig.User is a numeric UID
    // with no /etc/passwd entry, so HOME defaults to "/" which is on the
    // read-only root fs — every tool that writes to ~/.config, ~/.cache,
    // ~/.local, ~/.gitconfig fails outright. Pointing HOME at the bind
    // mount lets `gh auth login`, `git config --global`, `pip install
    // --user`, shell history, ssh keys, and similar persist across
    // container restarts.
    HOME: "/state/agent/home",
    // npm global installs (`npm install -g foo`) land here so they (a)
    // don't fail on the read-only /usr/local prefix and (b) survive
    // restart. PATH adjustment that puts this on the search path lives
    // in profiles/_base/start.sh.hbs.
    NPM_CONFIG_PREFIX: "/state/agent/home/.npm-global",
    // Make `pip install foo` Just Work for agents. Two env vars:
    //   PIP_USER=1                 — install to ~/.local (writable +
    //                                persistent via Layer 1) instead of
    //                                /usr/local site-packages (read-only).
    //   PIP_BREAK_SYSTEM_PACKAGES=1 — Debian 12 marks the system Python
    //                                as PEP 668 "externally-managed",
    //                                so pip refuses even `pip install
    //                                --user` by default with a confusing
    //                                "externally-managed-environment"
    //                                error. The override is explicit +
    //                                visible in `printenv`.
    // Without both, an agent's first `pip install polars / pandas /
    // numpy / claude-sdk` fails with either that error or "Read-only
    // file system" — neither recoverable from a tool-call retry loop.
    // With both, packages land in ~/.local/lib and survive container
    // restart via the /state/agent bind mount.
    PIP_BREAK_SYSTEM_PACKAGES: "1",
    PIP_USER: "1",
    SWITCHROOM_AGENT_NAME: a.name,
    // Belt-and-braces in-container marker for the agent-config CLI's
    // isContainerContext() probe (the primary signal is /.dockerenv,
    // but a second independent check is the point of writing `||`).
    SWITCHROOM_CONTAINER: "1",
    // Broker / kernel socket paths inside the agent container. The
    // per-agent volume is mounted at `/run/switchroom/broker` (and
    // `/run/switchroom/kernel`) — directly at the parent dir, NOT
    // at the broker-side `/run/switchroom/broker/<agent>` subdir
    // (compose.ts:370 vs compose.ts:607). So from inside the agent
    // the socket is at `/run/switchroom/broker/sock`, one level
    // shallower than the broker container sees it.
    //
    // Two pre-fix bugs were stacked:
    //   1. The path values here were `/run/switchroom/broker/<name>
    //      /sock` — the broker's view, which does not exist inside
    //      the agent container at all.
    //   2. The broker env NAME was `SWITCHROOM_BROKER_SOCKET` — but
    //      the broker CLIENT (`src/vault/broker/client.ts:293`) and
    //      the secret-guard hook (`telegram-plugin/hooks/secret-
    //      guard-pretool.mjs:36`) both read
    //      `SWITCHROOM_VAULT_BROKER_SOCK`. So clients silently fell
    //      through to the `~/.switchroom/vault-broker.sock` legacy
    //      fallback (a dangling symlink inside the container) and
    //      reported "broker not running" even when the broker was
    //      up and the socket was bound at the correct in-container
    //      path. Operator-visible on 2026-05-10 as klanker's
    //      "VAULT-BROKER-DENIED" after the test-clobber incident
    //      restored the broker container.
    // Kernel side already used the correct env name (matches
    // `src/vault/approvals/client.ts:60`) but had the same wrong
    // path value. Both fixed here.
    SWITCHROOM_VAULT_BROKER_SOCK: `/run/switchroom/broker/sock`,
    SWITCHROOM_KERNEL_SOCKET: `/run/switchroom/kernel/sock`,
    SWITCHROOM_RUNTIME: "docker",
    // tini's process-group signal mode. Default tini forwards signals
    // ONLY to its single direct child — under our process tree that's
    // tmux (or start.sh→tmux post-exec) at PID 7. The gateway sidecar
    // and other backgrounded sidecars (autoaccept-poll, agent-scheduler)
    // share PGID=7 with tmux but are NOT direct children of tini, so
    // a SIGTERM from `docker stop` / `docker compose up -d --remove-
    // orphans` reaches tmux only — the gateway gets SIGKILL'd after
    // stop_grace_period without ever running its shutdown handler.
    //
    // The handler matters: it writes /state/agent/telegram/clean-
    // shutdown.json with a fresh timestamp + reason (the SIGTERM
    // fallback is "systemctl: external restart" — see clean-shutdown-
    // marker.ts:139), and the next gateway boot reads that marker to
    // resolve restartReason as 'graceful' instead of 'crash'. Without
    // this env, every raw `docker compose up -d` recreate boots as
    // crash + notifies the fleet (CC-equivalent to the bug PR #1141
    // fixed for `switchroom update` specifically — that one uses
    // `docker exec` to stamp the marker BEFORE the recreate, this one
    // makes the in-gateway shutdown handler reliable so any graceful
    // container stop self-attributes).
    //
    // TINI_KILL_PROCESS_GROUP=1 routes signals to the pgrp of tini's
    // direct child via kill(-pgid, sig). Verified pgrp tree on
    // 2026-05-13 (gymbro container): tmux client + supervisor bashes
    // + bun gateway + bun scheduler + bun autoaccept all share PGID=7
    // — they all get SIGTERM together. Claude (PGID=20, separate
    // session via tmux server) is unaffected, which is correct: it
    // doesn't write the marker and gets SIGKILL'd at grace-period
    // expiry like before.
    TINI_KILL_PROCESS_GROUP: "1",
  };
  // PostHog runtime telemetry — opt-out honoured, distinct-ID propagated
  // from the host CLI so CLI + runtime events merge under the same user.
  // See docs/posthog.md (Switchroom Runtime dashboard section).
  if (posthog.analyticsId != null) {
    env.SWITCHROOM_ANALYTICS_ID = posthog.analyticsId;
  }
  if (
    posthog.telemetryDisabled === "1"
    || posthog.telemetryDisabled === "true"
  ) {
    env.SWITCHROOM_TELEMETRY_DISABLED = "1";
  }
  if (posthog.posthogKeyOverride && posthog.posthogKeyOverride !== "") {
    env.SWITCHROOM_POSTHOG_KEY = posthog.posthogKeyOverride;
  }
  if (posthog.posthogHostOverride && posthog.posthogHostOverride !== "") {
    env.SWITCHROOM_POSTHOG_HOST = posthog.posthogHostOverride;
  }
  // SWITCHROOM_CONFIG: the in-container telegram-plugin gateway daemon
  // (forked as a sidecar by start.sh's docker preamble) shells out to
  // the switchroom CLI for handoff / vault / topic operations and
  // passes `--config $SWITCHROOM_CONFIG` so the in-container CLI finds
  // the right yaml regardless of cwd. The yaml is bind-mounted below.
  // Same env+mount pattern broker/kernel/scheduler already use.
  if (switchroomConfigPath) {
    env.SWITCHROOM_CONFIG = "/state/config/switchroom.yaml";
  }
  // SWITCHROOM_AGENT_ADMIN: gateway gates `/agents`, `/logs`, `/grant`,
  // `/vault`, `/update` etc. on this env var being `"true"`. The agent
  // schema's `admin: true` flag must surface here — otherwise the
  // yaml field is silently a no-op. The gateway reads it at
  // `telegram-plugin/gateway/gateway.ts:514`.
  if (a.admin === true) {
    env.SWITCHROOM_AGENT_ADMIN = "true";
    // Note: grant-mgmt RPCs (list_grants, mint_grant, revoke_grant)
    // for admin agents are handled by the broker on the existing
    // per-agent socket via a server-side allowlist check
    // (`src/vault/broker/server.ts` reads `config.agents[name].admin`
    // before denying). #1020 originally tried to route them through
    // the operator socket via a bind-mount + env var here, but the
    // host operator socket's 0600/owner-only perms blocked the
    // agent UID from connecting (#1021). #1021 Design B moves the
    // gate into the broker; the agent-side env/mount are no longer
    // needed.
  }
  // Merge operator-declared env vars from the agent's `env:` block.
  // System-managed keys (HOME, NPM_*, SWITCHROOM_*) win on collision —
  // an operator can't override the runtime contract from yaml. A
  // collision warning would help, but skipped for now (rare in
  // practice; doctor check could add this later).
  for (const [k, v] of Object.entries(a.userEnv)) {
    if (env[k] === undefined) env[k] = v;
  }
  for (const k of Object.keys(env).sort()) {
    lines.push(`      ${k}: ${JSON.stringify(env[k])}`);
  }
  lines.push(`    volumes:`);
  // Per-agent volumes — each volume mounted into EXACTLY this agent's
  // container. The doctor check `checkAgentSocketMounts` asserts the
  // invariant on every regenerated compose.
  lines.push(`      - broker-${a.name}-sock:/run/switchroom/broker`);
  lines.push(`      - kernel-${a.name}-sock:/run/switchroom/kernel`);
  if (a.admin === true) {
    // Admin agents need read access to the host operator's vault
    // audit log so the bot's `/vault audit <agent>` Recent-denials
    // section (#969 P2b) can render. The bot reads from
    // `${HOME}/.switchroom/vault-audit.log` (homedir-relative); the
    // agent container's HOME is `/state/agent/home`, so the host
    // file gets mounted there as a read-only file bind. Non-admin
    // agents stay isolated.
    //
    // The bot only consumes this for read-only rendering; the
    // broker is the sole writer (running in its own container with
    // its own append-only access). Mounting :ro protects the file
    // even from a fully-compromised admin agent.
    //
    // Gated on `existsSync` because the audit log is created lazily
    // by the broker on the first ACL decision — fresh installs may
    // not have it yet, and docker compose `up` hard-fails when a
    // `:ro` source is missing (same pattern as the skills /
    // credentials mounts below).
    if (existsSync(`${hostHomeForChecks}/.switchroom/vault-audit.log`)) {
      lines.push(
        `      - ${homePrefix}/.switchroom/vault-audit.log:/state/agent/home/.switchroom/vault-audit.log:ro`,
      );
    }
    // Host-control daemon socket (#1164 follow-up — RFC C).
    // ADMIN-ONLY and gated on `host_control.enabled: true`. The
    // daemon (a systemd user unit on the host) binds the per-agent
    // socket at `~/.switchroom/hostd/<name>/sock`, chowns it to the
    // agent UID, and the agent connects via the in-container path
    // `/run/switchroom/hostd/<name>/sock`. Same bind-mount shape
    // the broker uses; identity comes from the host-side bind
    // path so the agent can't forge it.
    //
    // No singleton container in Phase 1 (the daemon lives outside
    // compose); only the per-agent volume here. The agent end is
    // the directory, not the file, so the daemon can bind the
    // socket inside it after starting. existsSync guard on the
    // directory: if the daemon hasn't run yet, the directory will
    // be missing — compose `up` would hard-fail on a missing :ro
    // source. We bind read-write so the daemon can chown the
    // socket file from the host side; the agent only connects.
    if (hostControlEnabled && existsSync(`${hostHomeForChecks}/.switchroom/hostd/${a.name}`)) {
      lines.push(
        `      - ${homePrefix}/.switchroom/hostd/${a.name}:/run/switchroom/hostd/${a.name}`,
      );
    }
  }
  // Operator-declared extra bind-mounts (#1164). ADMIN-ONLY: emitting
  // anything for a non-admin agent is a hard error — bind_mounts is the
  // escape hatch that lets an agent dogfood / self-modify host source
  // trees, so silently dropping the entries would mask a misconfigured
  // privilege grant.
  if (a.bindMounts.length > 0) {
    if (!a.admin) {
      throw new Error(
        `compose: agent "${a.name}" declares bind_mounts but is not admin: true. ` +
        `bind_mounts is an admin-only escalation (see issue #1164 and the bind_mounts ` +
        `schema doc). Either set admin: true on this agent or remove bind_mounts.`,
      );
    }
    for (const entry of a.bindMounts) {
      const { source, target, mode } = resolveBindMount(a.name, entry);
      // Match the existing :ro / no-suffix convention used by the
      // skills/credentials mounts above. `:rw` is omitted because docker's
      // default is read-write — being explicit would diverge from the
      // surrounding lines and add noise.
      const suffix = mode === "ro" ? ":ro" : "";
      lines.push(`      - ${source}:${target}${suffix}`);
    }
  }
  // Dual mounts — the same host directory is bound BOTH at the canonical
  // container path (`/state/agent`, `/state/.claude`, `/var/log/switchroom`)
  // AND at the original host path. Why both:
  //   - `/state/*` paths are baked into the Dockerfile (Dockerfile.agent's
  //     CMD is `/state/agent/start.sh`; tini ENTRYPOINT calls into it).
  //     Removing the canonical paths would break the existing v0.7.0
  //     image without rebuilding it.
  //   - Same-path mounts let scaffolded start.sh / settings.json (which
  //     bake the absolute host path of agentDir at scaffold time) Just
  //     Work inside the container. The host path in `cd "$agentDir"`
  //     resolves to the same file the bind mount points at.
  // Dual-mount is the smallest viable fix that unblocks v0.7.0 installs
  // without an image rebuild + republish.
  lines.push(`      - ${homePrefix}/.switchroom/agents/${a.name}:/state/agent`);
  lines.push(`      - ${homePrefix}/.claude/projects/${a.name}:/state/.claude`);
  lines.push(`      - ${homePrefix}/.switchroom/logs/${a.name}:/var/log/switchroom`);
  lines.push(`      - ${homePrefix}/.switchroom/agents/${a.name}:${homePrefix}/.switchroom/agents/${a.name}`);
  lines.push(`      - ${homePrefix}/.claude/projects/${a.name}:${homePrefix}/.claude/projects/${a.name}`);
  // Shared read-only bind mounts for skills + credentials (#907). Cron
  // yaml prompts widely reference `~/.switchroom/skills/...` (calendar,
  // mail, garmin, home-assistant) and `~/.switchroom/credentials/...`.
  // Mounted at the operator's host path so absolute paths in scaffolded
  // start.sh and yaml prompts Just Work; tilde resolution is fixed by
  // start.sh.hbs's $HOME/.switchroom symlink (see #910). Conditional on
  // existsSync because docker compose `up` hard-fails when a `:ro`
  // source is missing — many operators keep all secrets in vault and
  // never create a `credentials/` dir at all.
  if (existsSync(`${hostHomeForChecks}/.switchroom/skills`)) {
    lines.push(`      - ${homePrefix}/.switchroom/skills:${homePrefix}/.switchroom/skills:ro`);
  }
  if (existsSync(`${hostHomeForChecks}/.switchroom/credentials`)) {
    lines.push(`      - ${homePrefix}/.switchroom/credentials:${homePrefix}/.switchroom/credentials:ro`);
  }
  // Ensure the host-side per-agent audit dir exists before docker
  // compose tries to bind-mount it (docker auto-creates as root, which
  // then traps the agent uid out of writing — pre-creating with the
  // operator's umask sidesteps that).
  try {
    mkdirSync(`${hostHomeForChecks}/.switchroom/audit/${a.name}`, { recursive: true });
  } catch { /* best-effort */ }
  // Agent-config audit log (rw) — the read-only agent-config MCP broker
  // (src/mcp/agent-config/server.ts) appends one JSONL row per tool call
  // to ~/.switchroom/audit/<agent>/agent-config.jsonl. PER-AGENT mount:
  // each agent sees only its own audit subdir, never any other agent's.
  // Critical: do NOT mount the parent ~/.switchroom/audit/ — that would
  // let any agent read every other agent's audit trail.
  lines.push(`      - ${homePrefix}/.switchroom/audit/${a.name}:${homePrefix}/.switchroom/audit/${a.name}:rw`);
  // Bundled-skills pool: mount at the same absolute host path so the
  // symlinks created by reconcileAgentDefaultSkills (which target the
  // source-repo or npm-package skills/ dir — e.g.
  // `<repo>/skills/skill-creator`) resolve inside the container.
  // Guard with existsSync because the resolved path may not exist in
  // exotic test setups and docker compose `up` hard-fails on missing
  // `:ro` sources. Skip when the pool path is already covered by the
  // operator skills mount above (no duplicate volume entries).
  if (
    bundledSkillsPoolDir &&
    existsSync(bundledSkillsPoolDir) &&
    !bundledSkillsPoolDir.startsWith(`${hostHomeForChecks}/.switchroom/skills`)
  ) {
    lines.push(`      - ${bundledSkillsPoolDir}:${bundledSkillsPoolDir}:ro`);
  }
  // switchroom.yaml file mount (read-only) — the in-container gateway
  // daemon needs `--config $SWITCHROOM_CONFIG` to talk to the
  // switchroom CLI for handoff / topic / vault grants. SWITCHROOM_CONFIG
  // is set above; it points here.
  if (switchroomConfigPath) {
    lines.push(`      - ${switchroomConfigPath}:/state/config/switchroom.yaml:ro`);
  }
  lines.push(`      - ${homePrefix}/.switchroom/logs/${a.name}:${homePrefix}/.switchroom/logs/${a.name}`);
  lines.push(``);
  void imageTag;
}
