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
 * compose only emits them when the source exists. NOTE: a missing `:ro`
 * bind source does NOT make `docker compose up` hard-fail — Docker silently
 * auto-creates the missing SOURCE as a root-owned directory (the 2026-06-23
 * fleet outage). The real backstops are assertPlausibleHostHome (below, at
 * generation time) and the pre-flight bind-source validator the deploy path
 * runs before `up` (see src/cli/preflight-mounts.ts).
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

import { existsSync, mkdirSync, readFileSync, lstatSync, readlinkSync, chmodSync } from "node:fs";
import { join, isAbsolute, dirname, resolve } from "node:path";
import type { SwitchroomConfig, AgentConfig, AgentBindMount } from "../config/schema.js";
import { isValidTimezone } from "../config/schema.js";
import { DEFAULT_DOCKER_SOCKET_PATH } from "./docker-socket.js";

/**
 * In-container filesystem roots that are NEVER a valid HOST home. The
 * compose generator bakes `homePrefix` as the leading segment of every
 * host-path bind source; if it resolves to one of these, Docker auto-creates
 * empty root-owned dirs on the host and the fleet dies (start.sh missing →
 * exec 127; broker EISDIR / SQLite "unable to open"). The 2026-06-23 outage
 * used `/state/agent/home` (the agent container's HOME); the 2026-06-11/12
 * outages used `/host-home` (hostd's mount point). Both — and the whole class
 * — are caught here.
 */
const CONTAINER_ROOT_PREFIXES = [
  "/host-home", // hostd's in-container mount point of the host home (2026-06-11/12)
  "/state",     // agent/singleton container state root, incl. /state/agent/home (2026-06-23)
  "/run",       // container runtime dir — never a host home
  // NOTE: deliberately NOT /tmp — tests (and some tooling) legitimately use a
  // mkdtemp dir under /tmp as a fake homeDir, and no real fleet uses /tmp as a
  // host home. The actual poison vectors are the container-state roots above.
];

/**
 * Refuse to bake an implausible host-home prefix into bind-mount sources.
 * Allows the legacy literal `"${HOME}"` placeholder (resolved by docker at
 * `up` time on the host) and any absolute path NOT under a known in-container
 * root. Rejects the whole container-root class (generalizes the original
 * `/host-home`-only guard that the 2026-06-23 `/state/agent/home` poison
 * sailed through). Throws with the recovery path.
 */
export function assertPlausibleHostHome(homePrefix: string): void {
  if (homePrefix === "${HOME}") return; // legacy placeholder, resolved on host at up-time
  const bad =
    !isAbsolute(homePrefix) ||
    CONTAINER_ROOT_PREFIXES.some(
      (p) => homePrefix === p || homePrefix.startsWith(p + "/"),
    );
  if (!bad) return;
  throw new Error(
    `compose: refusing to generate — the host-home prefix resolved to "${homePrefix}", ` +
    `which is not a real host path (it looks like an in-container root). Emitting it as a ` +
    `bind-mount source would make docker auto-create empty dirs on the host and crash the ` +
    `fleet (start.sh missing → exec 127; broker EISDIR / SQLite "unable to open").\n\n` +
    `Cause: a deploy ran inside a container without SWITCHROOM_HOST_HOME set to the real ` +
    `host home (so it fell back to the container's HOME). Recovery: run \`switchroom apply\` ` +
    `once from the HOST shell (not via an agent / a helper container), which regenerates the ` +
    `compose with correct host paths and re-bakes a correct SWITCHROOM_HOST_HOME into the fleet.`,
  );
}
import { scheduleNeedsCronSession } from "../scheduler/cron-routing.js";
import { applyDefaultTier } from "../scheduler/tier-selector.js";
import { resolveMainModel } from "./scaffold.js";
import { isClaudeModel } from "../../telegram-plugin/gateway/model-command.js";
import { resolveAgentConfig } from "../config/merge.js";
import { resolveTimezone } from "../config/timezone.js";
import { getBundledSkillsPoolDir } from "./reconcile-default-skills.js";
import { loadHostCapabilities } from "../setup/host-capabilities.js";
import type { VoiceEngine } from "../setup/gpu-detect.js";
import { AGENT_UID_MIN, AGENT_UID_MAX, allocateAgentUid } from "./agent-uid.js";
import { GRANTS_DB_DIRNAME, GRANTS_DB_CONTAINER_DIR } from "../vault/grants-db-path.js";
import {
  SCRATCH_CONTAINER_DIR,
  agentScratchHostDir,
  ensureAgentScratchDir,
  resolveScratchConfig,
  scratchEnv,
  scratchVolumeAvailable,
} from "./scratch.js";

// UID derivation lives in agent-uid.ts (a leaf module) so scaffold.ts can
// import it without a compose ↔ scaffold cycle (compose.ts imports
// resolveMainModel from scaffold.ts above). Re-exported here because every
// pre-existing consumer (brokers, kernel, apply, doctor) imports these
// symbols from compose.js.
export { AGENT_UID_MIN, AGENT_UID_MAX, allocateAgentUid };

/** Resource defaults by profile category. RFC §"Resource limits as foot-guns". */
export interface ResourceDefaults {
  memLimit: string;
  cpus: number;
  /** Optional — when set, emitted as `mem_reservation` (cgroup memory.low). */
  memReservation?: string;
  /** Optional — when set, emitted as `pids_limit` (cgroup pids.max). */
  pidsLimit?: number;
  /**
   * Size of the container's RAM-backed `/tmp`, emitted as
   * `tmpfs: - /tmp:size=<this>,mode=1777`. Always resolved (falls back to
   * `DEFAULT_TMP_SIZE`) by `resolveResourceDefaults`.
   */
  tmpSize: string;
}

/**
 * Fleet-wide default size of the per-agent `/tmp` tmpfs — what every agent
 * gets without a `resources.tmp_size` override at any cascade layer.
 *
 * Hard-coded at the emit site as `1g` until 2026-07-27, when the root-tier
 * `overlord` container was measured at 90% of its 1.0 GiB `/tmp` (917M used,
 * ~150M free) purely from concurrently-running sub-agents — 785M of it repo
 * clones plus `bunx` toolchain caches (vitest, typescript). A fan-out of
 * several workers/reviewers exhausts 1 GiB routinely, and a full /tmp fails
 * clones and installs with confusing ENOSPC errors.
 *
 * 2 GiB is safe as a *default* because a tmpfs is a ceiling, not a
 * reservation: it consumes host RAM only for pages actually written, so an
 * idle agent's footprint is unchanged. Those pages are charged against the
 * container's `mem_limit` cgroup, so an agent that raises this AND intends to
 * fill it should raise `resources.memory` too.
 */
export const DEFAULT_TMP_SIZE = "2g";

// Per-profile defaults. Settings:
//   - memLimit       hard cap (cgroup memory.max)
//   - memReservation soft floor (cgroup memory.low) — kernel protects at
//                    least this much from reclaim under host-wide
//                    pressure (Coolify co-tenants, build jobs, etc.).
//                    Sized to ~10-30% of memLimit per profile — enough
//                    to keep the agent's idle working set RAM-resident
//                    without over-committing the host.
//   - pidsLimit      cgroup pids.max — prevents fork bombs / runaway
//                    test or build workers. Sized generously: a typical
//                    agent at idle uses ~30 PIDs, `npm test`-style
//                    workloads can spike to 200+. Caps are conservative
//                    multiples of typical peak. klanker (the dedicated
//                    test runner) gets the highest cap.
//   - cpus           CPU quota (Docker `cpus`).
//   - tmpSize        size of the RAM-backed /tmp. Uniform across profiles
//                    today (DEFAULT_TMP_SIZE); per-profile values are
//                    possible here, and `resources.tmp_size` overrides it
//                    at any cascade layer.
//
// These are starting points; operators override per-agent via the
// schema's `resources` block (PR #1190). memLimit is a hard cap
// (cgroup memory.max), NOT a reservation — agents won't OOM-kill unless
// they actually hit the ceiling. Raised 2026-06-25 after the 2026-06-24
// incident where the 1.5g default cap OOM-killed the claude process
// mid-turn during in-container bun+vitest builds. Worst-case total under
// a 9-agent fleet (1 klanker + 8 conversational): 8 + 8×3 = 32 GB hard
// cap; 4 + 8×0.256 = ~6 GB protected from reclaim. Well under the 60 GB
// host capacity; overlord and other per-agent overrides are set separately
// in switchroom.yaml and are not reflected here.
const RESOURCE_BY_PROFILE: Record<string, ResourceDefaults> = {
  klanker: {
    memLimit: "8g",
    memReservation: "4g",
    pidsLimit: 2000,
    cpus: 2.0,
    tmpSize: DEFAULT_TMP_SIZE,
  },
  // Conversational profiles — clerk, finn, carrie, coach, etc.
  conversational: {
    memLimit: "3g",
    memReservation: "256m",
    pidsLimit: 500,
    cpus: 1.0,
    tmpSize: DEFAULT_TMP_SIZE,
  },
  // Lightweight profiles.
  lightweight: {
    memLimit: "1g",
    memReservation: "128m",
    pidsLimit: 500,
    cpus: 0.5,
    tmpSize: DEFAULT_TMP_SIZE,
  },
  // Coding/worker/researcher.
  coding: {
    memLimit: "4g",
    memReservation: "512m",
    pidsLimit: 1000,
    cpus: 2.0,
    tmpSize: DEFAULT_TMP_SIZE,
  },
  // Catch-all default.
  default: {
    memLimit: "3g",
    memReservation: "256m",
    pidsLimit: 500,
    cpus: 1.0,
    tmpSize: DEFAULT_TMP_SIZE,
  },
};

/**
 * Operator override shape — matches the snake_case keys in the
 * `resources` schema field. Resolved into camelCase `ResourceDefaults`
 * by `resolveResourceDefaults`. All fields optional: an unset field
 * falls back to the per-profile default.
 */
export interface ResourceOverrides {
  memory?: string;
  memory_reservation?: string;
  pids_limit?: number;
  cpus?: number;
  tmp_size?: string;
}

/**
 * Resolve resource limits for an agent.
 *
 * Precedence (highest wins, per-field):
 *   1. Operator override on `agent.resources.<field>` (cascaded by
 *      `mergeAgentConfig` from defaults / profile / per-agent layers).
 *   2. Agent-name special-case: `klanker` → klanker profile defaults.
 *      Preserved for backward compatibility — the canonical fleet's
 *      klanker hits this when its YAML doesn't override.
 *   3. The agent's `extends:` profile entry in RESOURCE_BY_PROFILE.
 *   4. The `default` profile entry.
 *
 * Per-field merge: an override that sets only `memory` keeps the
 * profile's `cpus` and any default `memReservation` / `pidsLimit`.
 * This matches the schema description for the `resources` field.
 */
/**
 * Cheap-cron (L4 refinement): headroom for the second (cron) claude session.
 * Applied ONLY to agents that actually run one (a context:fresh / cheap-model
 * cron entry — none in the fleet today), and ONLY where the operator hasn't
 * pinned an explicit value (we never override an explicit sizing). RFC §4.
 */
const CRON_SESSION_MEM_BUMP_MIB = 512;
const CRON_SESSION_PIDS_BUMP = 128;

/** Parse a docker mem string ("1.5g", "256m", "512") to MiB; null if unparseable. */
export function parseMemToMib(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([gmk]?)b?$/i.exec(s.trim());
  if (!m) return null;
  const n = parseFloat(m[1]!);
  const unit = (m[2] || "m").toLowerCase();
  const mult = unit === "g" ? 1024 : unit === "k" ? 1 / 1024 : 1;
  return Math.round(n * mult);
}

function bumpMem(s: string, addMib: number): string {
  const mib = parseMemToMib(s);
  return mib == null ? s : `${mib + addMib}m`;
}

export function resolveResourceDefaults(
  agentName: string,
  profile: string | undefined,
  overrides?: ResourceOverrides | undefined,
  opts?: { cronSession?: boolean },
): ResourceDefaults {
  let base: ResourceDefaults;
  if (agentName === "klanker") {
    base = RESOURCE_BY_PROFILE.klanker!;
  } else if (profile && RESOURCE_BY_PROFILE[profile]) {
    base = RESOURCE_BY_PROFILE[profile]!;
  } else {
    base = RESOURCE_BY_PROFILE.default!;
  }
  const merged: ResourceDefaults = { ...base };
  if (overrides) {
    if (overrides.memory !== undefined) merged.memLimit = overrides.memory;
    if (overrides.cpus !== undefined) merged.cpus = overrides.cpus;
    if (overrides.memory_reservation !== undefined) {
      merged.memReservation = overrides.memory_reservation;
    }
    if (overrides.pids_limit !== undefined) {
      merged.pidsLimit = overrides.pids_limit;
    }
    if (overrides.tmp_size !== undefined) {
      merged.tmpSize = overrides.tmp_size;
    }
  }
  // Cron-session headroom — only when the operator left the field to defaults.
  if (opts?.cronSession) {
    if (overrides?.memory === undefined) {
      merged.memLimit = bumpMem(merged.memLimit, CRON_SESSION_MEM_BUMP_MIB);
    }
    if (overrides?.pids_limit === undefined && merged.pidsLimit !== undefined) {
      merged.pidsLimit = merged.pidsLimit + CRON_SESSION_PIDS_BUMP;
    }
  }
  return merged;
}

/**
 * sec WS6-F4 (#1419): UID collision is a HARD FAIL at compose
 * generation, not a doctor warning.
 *
 * `allocateAgentUid` is a hash mod 999, so two agent names can map to
 * the same UID. Pre-#1419 this was only an advisory `doctor` check —
 * `apply` would silently emit a compose file where the colliding pair
 * share a UID, collapsing per-agent file-ownership isolation (each
 * can read/write the other's credentials, vault socket, scaffold).
 * That's a silent isolation failure reachable with zero operator
 * intent, so the right posture is fail-closed: refuse to generate
 * compose until the operator renames a collider. Deterministic
 * allocation is preserved (no name→UID persisted map, no chown-sweep
 * migration risk); the operator picks the rename.
 */
export function assertNoAgentUidCollision(config: SwitchroomConfig): void {
  const byUid = new Map<number, string[]>();
  for (const name of Object.keys(config.agents ?? {})) {
    const uid = allocateAgentUid(name);
    const names = byUid.get(uid);
    if (names) names.push(name);
    else byUid.set(uid, [name]);
  }
  const collisions = [...byUid.entries()].filter(([, n]) => n.length > 1);
  if (collisions.length === 0) return;
  const detail = collisions
    .map(([uid, n]) => `  UID ${uid} ← ${n.sort().join(", ")}`)
    .join("\n");
  throw new Error(
    `agent UID collision — refusing to generate compose (sec WS6-F4 / #1419).\n` +
      `These agents hash to the same container UID, which collapses their ` +
      `file-ownership isolation (each could read the other's credentials / ` +
      `vault socket / scaffold):\n${detail}\n` +
      `Rename one agent in each colliding set (the UID is a deterministic ` +
      `hash of the name) and re-run. \`switchroom doctor\` also reports this.`,
  );
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
   * Absolute home path to use for FILESYSTEM probes (`existsSync` /
   * `mkdirSync`) that gate optional bind mounts, as opposed to `homeDir`
   * which is BAKED into mount sources + the agent's `SWITCHROOM_HOST_HOME`.
   *
   * These differ only when `apply` runs INSIDE the hostd container: there
   * `homeDir` is the real HOST home (`SWITCHROOM_HOST_HOME=/home/op`, what the
   * agent must see), but that path does not exist in hostd's own filesystem —
   * the operator's home is bind-mounted at `/host-home`. Probing `homeDir`
   * there returns false and SILENTLY DROPS every conditional mount
   * (mcp-launchers, skills, fleet, credentials, …) → agents recreated by an
   * in-hostd reconcile lose them (the 2026-06-15 marko meta_pages outage).
   * `probeHomeDir` is the container-real home (`homedir()` = `/host-home` in
   * hostd, `/home/op` on the host), so the probes see the bind-mounted dirs.
   * Defaults to `homeDir` for back-compat (on the host they are identical).
   */
  probeHomeDir?: string;
  /**
   * Whether to pre-create the host-side per-agent directories (audit dir,
   * blocked-approvals, schedule.d, personal-skills) that docker would
   * otherwise auto-create as root:root — trapping the agent uid out of
   * writing them (#3084 / #1163). These are FILESYSTEM SIDE EFFECTS, not
   * part of the returned compose string.
   *
   * Defaults to `true` ONLY when the caller has explicitly supplied a home
   * (`homeDir` or `probeHomeDir`). When neither is passed, `probeHome`
   * silently falls back to the ambient `process.env.HOME` — the operator's
   * REAL production state tree — and blindly `mkdirSync`-ing there is the
   * bug in #3127: a full test-suite run created `~/.switchroom/blocked-
   * approvals` (and chmod 1777'd it) in the operator's real `$HOME`.
   * Reads (`existsSync`) against the ambient home are harmless; writes are
   * not. So the pre-create is gated on the caller having told us WHERE the
   * host home actually is. Every production caller (write-compose,
   * docker-fleet) passes `homeDir`, so production behaviour is unchanged;
   * pure compose-string tests that omit it get no writes.
   *
   * Explicit override wins over the default in both directions (a test can
   * force it off even with a tmp homeDir; a caller can force it on).
   */
  precreateHostDirs?: boolean;
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
  /**
   * Set of agent names whose LiteLLM virtual key is confirmed present in the
   * vault. Only agents in this set get LiteLLM routing env injected (gated
   * alongside cascade-resolved `litellm.enabled`). `writeComposeFile` computes
   * it via a broker vault probe so the env is decoupled from mere config
   * intent — a failed/absent provision never yields a key-less proxy route.
   * Omitted ⇒ no agent treated as confirmed (fail-safe). Passed straight to
   * `describeAgents`.
   */
  litellmConfirmedAgents?: Set<string>;
  /**
   * The persisted voice-engine verdict (PR-B1 → PR-B2). Drives whether the
   * `voice-sidecar` STT service is emitted: `local` emits it (GPU present +
   * container toolkit), `cloud` omits it entirely (no service).
   *
   * INJECTABLE so the compose-generator stays pure and the snapshot tests
   * can exercise BOTH branches without shelling out to real hardware. When
   * omitted, the generator reads the persisted verdict from
   * `loadHostCapabilities()` (defaulting to `cloud` if no verdict file
   * exists yet), so production callers Just Work without threading it.
   */
  voiceEngine?: VoiceEngine;
  /**
   * Host-side docker socket path to bind into the `root: true` agent's
   * `:rw` mount (#3648). Resolved ONCE at generation time from the active
   * docker context (`docker context inspect`), so a relocated / rootless
   * daemon socket is bound at its real path instead of a dangling
   * `/var/run/docker.sock`.
   *
   * INJECTABLE so the generator stays pure and snapshot tests never shell
   * out to a real docker daemon. When omitted, the generator resolves it
   * live — but only when the fleet actually contains a root agent, so the
   * common (no-root) path never touches docker.
   */
  dockerSocketPath?: string;
}

/**
 * Reserved fixed loopback/host port for the voice STT sidecar (PR-B2).
 *
 * Picked in the same published-port scheme the rest of the fleet uses
 * (hindsight = 127.0.0.1:18888). 18900 is the next free slot just above
 * the broker/hindsight range. RESERVED — a future singleton must not
 * reuse it, or a `local`-verdict host would collide on bind. The sidecar
 * listens on 8126 inside the container; compose maps host 18900 → 8126.
 *
 * Reachability (reviewer-flagged): the sidecar must be reachable by BOTH
 * `network_mode: host` agents (via 127.0.0.1) AND strict-isolation agents
 * (via `host.docker.internal`/host-gateway). A pure `127.0.0.1:18900`
 * publish is NOT reachable from a strict-isolation peer's bridge network,
 * so we publish on `0.0.0.0:18900` (the host-gateway-reachable interface)
 * and rely on the X-Voice-Token shared secret for safety since the bind
 * is broader than pure loopback. See emitVoiceSidecarService.
 */
export const VOICE_SIDECAR_HOST_PORT = 18900;
/** The sidecar's in-container listen port (matches Dockerfile.voice EXPOSE). */
export const VOICE_SIDECAR_CONTAINER_PORT = 8126;

/** Resolve the image ref for one of the service images. */
function resolveImageRef(
  name: "agent" | "broker" | "kernel" | "scheduler" | "auth-broker" | "voice",
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
  service: "agent" | "broker" | "kernel" | "scheduler" | "auth-broker" | "voice",
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

/**
 * Emit a `logging:` block capping the Docker json-file log driver.
 *
 * `restart: always` services run for weeks; without a cap the json-file
 * sink (distinct from the in-container `service.log`, cf. #739) grows
 * unbounded and fills the host disk. A full disk then breaks every write
 * path fleet-wide — the failure ancestor behind many durability bugs.
 * 10 MB × 3 files bounds each container to ~30 MB of stdout/stderr.
 */
function emitLogging(lines: string[]): void {
  lines.push(`    logging:`);
  lines.push(`      driver: json-file`);
  lines.push(`      options:`);
  lines.push(`        max-size: "10m"`);
  lines.push(`        max-file: "3"`);
}

/**
 * Emit the `voice-sidecar` singleton service (PR-B2) — a local GPU
 * speech-to-text server (faster-whisper) the gateway POSTs voice bytes to
 * when the host's voice verdict is `local`. Caller gates emission on the
 * verdict; this function unconditionally writes the stanza.
 *
 * Key design points (reviewed):
 *  - GPU passthrough via `deploy.resources.reservations.devices` (nvidia,
 *    count 1, capabilities ['gpu']) — the only GPU stanza in this file.
 *  - Reachability: published on `0.0.0.0:<host>:<container>` so BOTH
 *    host-network agents (127.0.0.1) AND strict-isolation agents (via
 *    host.docker.internal/host-gateway) can reach it. A pure 127.0.0.1
 *    publish would be invisible to a strict-isolation peer's bridge net.
 *    The broader bind is made safe by the X-Voice-Token shared secret
 *    (injected below from the vault; the gateway sends it on every /stt).
 *  - Generous healthcheck start_period: the whisper model cold-loads in
 *    30-90s on first boot (and re-loads on recreate), so a tight probe
 *    would flap reconcile/`up`. The /healthz endpoint only 200s once the
 *    model is fully loaded.
 *  - Image-drift reconcile + doctor cover it via SINGLETON_SERVICES
 *    (src/agents/singleton-reconcile.ts), which only manages it on a
 *    `local` verdict.
 */
function emitVoiceSidecarService(
  lines: string[],
  imageTag: string,
  buildMode: "pull" | "local",
  buildContext: string | undefined,
  containerNamePrefix: string,
): void {
  lines.push(`  voice-sidecar:`);
  emitImageOrBuild(lines, "voice", imageTag, buildMode, buildContext);
  lines.push(`    container_name: ${containerNamePrefix}-voice-sidecar`);
  lines.push(`    labels:`);
  lines.push(`      switchroom.role: "voice-sidecar"`);
  lines.push(`      switchroom.fleet: "${containerNamePrefix}"`);
  lines.push(`    restart: always`);
  emitLogging(lines);
  // GPU passthrough — requires the nvidia-container-toolkit on the host
  // (the PR-B1 `containerToolkit` probe; a `local` verdict implies it).
  lines.push(`    deploy:`);
  lines.push(`      resources:`);
  lines.push(`        reservations:`);
  lines.push(`          devices:`);
  lines.push(`            - driver: nvidia`);
  lines.push(`              count: 1`);
  lines.push(`              capabilities: ["gpu"]`);
  // Reachable from both host-net and strict-isolation agents — see the
  // function doc. Publish on all interfaces; the shared-secret header is
  // the access gate, not the bind address.
  //
  // SECURITY NOTE: `0.0.0.0` is a DELIBERATE reachability trade-off — a pure
  // `127.0.0.1` publish is invisible to a strict-isolation peer's bridge
  // network (which reaches host services via host.docker.internal /
  // host-gateway, NOT loopback), so the sidecar would be unreachable for those
  // agents. We therefore bind all interfaces and gate access with the
  // X-Voice-Token shared secret (constant-time compared, fail-closed when
  // unset — see server.py `_authed`). /healthz is intentionally
  // unauthenticated but leaks nothing beyond load state. On a host with a
  // public interface this port IS LAN/WAN-reachable, so operators SHOULD add a
  // host firewall rule restricting :18900 to the docker bridge + loopback
  // (e.g. `iptables -A INPUT -p tcp --dport 18900 ! -s 172.16.0.0/12 -j DROP`,
  // adjusted to the actual docker subnet). Tracked in the PR description.
  lines.push(`    ports:`);
  lines.push(
    `      - "0.0.0.0:${VOICE_SIDECAR_HOST_PORT}:${VOICE_SIDECAR_CONTAINER_PORT}"`,
  );
  // /healthz returns 200 only once the model is loaded. start_period is
  // generous (model cold-load 30-90s) so reconcile/`up` doesn't flap.
  lines.push(`    healthcheck:`);
  // Probe via python3, NOT curl: the sidecar image is distroless-ish and
  // ships no curl, so a curl-based test stays `starting`/`unhealthy`
  // forever. The sidecar runtime IS python3 (docker/voice-sidecar/server.py),
  // so urllib from the stdlib is always present.
  lines.push(
    `      test: ["CMD-SHELL", "python3 -c \\"import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:${VOICE_SIDECAR_CONTAINER_PORT}/healthz',timeout=3).status==200 else 1)\\""]`,
  );
  lines.push(`      interval: 30s`);
  lines.push(`      timeout: 5s`);
  lines.push(`      retries: 3`);
  lines.push(`      start_period: 120s`);
  lines.push(`    stop_grace_period: 10s`);
  lines.push(`    security_opt:`);
  lines.push(`      - "no-new-privileges:true"`);
  lines.push(`    environment:`);
  // Shared-secret auth token — a docker-compose `${...}` interpolation, NOT
  // a literal secret (the secret is NEVER baked into this YAML). At apply
  // time, on a `local` verdict, `switchroom apply` seeds the token in the
  // vault (voice/sidecar-token) if absent and writes it to the
  // compose-adjacent `.env`, which docker reads to populate this var (see
  // src/cli/voice-sidecar-token.ts). The pure-Python sidecar reads it
  // straight from its env (docker/voice-sidecar/server.py) — it has no
  // broker client. The gateway resolves the SAME vault key at use-time and
  // sends it in the X-Voice-Token header.
  lines.push(`      VOICE_SIDECAR_TOKEN: \${VOICE_SIDECAR_TOKEN}`);
  lines.push(`      VOICE_STT_PORT: "${VOICE_SIDECAR_CONTAINER_PORT}"`);
  lines.push(`    volumes:`);
  // Fetch-once model weights persist here across recreate (never baked
  // into the image — size + weight-redistribution licensing).
  lines.push(`      - voice-model-cache:/models`);
  lines.push(``);
}

/**
 * Projected `channels.buzz` values for the compose `environment:` block —
 * present iff the agent declares a `channels.buzz` block at all. The Buzz
 * sidecar (`src/buzz-gateway/`) reads its config from these BUZZ_* env vars
 * (it has no access to the config cascade), exactly like the scheduler reads
 * SWITCHROOM_* vars. The keystone default-off invariant lives in
 * `emitAgentService`: `BUZZ_ENABLED=1` is projected ONLY when `enabled` is
 * true here, so an `enabled:false`/absent block never forks the sidecar, and
 * an agent WITHOUT a `channels.buzz` block projects NOTHING (byte-identical to
 * pre-Buzz compose). The one secret (the agent nsec) is NEVER projected — the
 * sidecar broker-fetches it in-process at boot from `nsecVaultKey`.
 */
interface BuzzServiceData {
  /** Whether `channels.buzz.enabled === true`. Gates BUZZ_ENABLED projection. */
  enabled: boolean;
  mirror: "both" | "origin" | "off";
  /** Telegram chat id an injected turn routes to (BUZZ_CHAT_ID). */
  chatId: string;
  /** Canonical relay URL used VERBATIM as the NIP-42 auth tag (BUZZ_RELAY_URL). */
  relayUrl: string;
  /** Distinct docker-network dial address, when it differs from relayUrl
   *  (BUZZ_RELAY_DIAL_URL). Undefined ⇒ dial relayUrl. */
  relayDialUrl: string | undefined;
  /** HTTP Host header authority for the WS upgrade (BUZZ_RELAY_HOST). */
  relayHost: string | undefined;
  /** Subscribed group UUID / NIP-29 `h` tag (BUZZ_CHANNEL_IDS). */
  channelIds: string;
  operatorPubkey: string;
  authorizedPubkeys: string[];
  /** Vault KEY NAME for the nsec, `{agent}`-substituted (BUZZ_NSEC_VAULT_KEY). */
  nsecVaultKey: string;
  pubkeyNames: Record<string, string>;
}

interface AgentServiceData {
  name: string;
  uid: number;
  profile: string | undefined;
  resources: ResourceDefaults;
  /** Capability extras the operator requested AND we stripped. */
  strippedCaps: string[];
  /**
   * sec WS6-F1 (#1390) / feature #1413. "host" (default) → the
   * pre-#1413 `network_mode: host`. "strict" → the agent joins its
   * OWN dedicated bridge network (no sibling reachability) with host
   * services via `host.docker.internal`. Opt-in; cascade-resolved.
   */
  networkIsolation: "host" | "strict";
  /**
   * Yaml-level `admin: true` flag — when set, surfaces as
   * `SWITCHROOM_AGENT_ADMIN=true` on the agent container so the
   * gateway permits admin slash commands (`/vault`, `/agents`,
   * `/logs`, `/grant`, `/update` etc). Default false.
   */
  admin: boolean;
  /**
   * Yaml-level `root: true` flag — the ROOT-tier debugging agent. When
   * set, `emitAgentService` emits a root-privileged container variant:
   * `user: "0:0"`, no `cap_drop`/`read_only`/`no-new-privileges`
   * hardening, with `/var/run/docker.sock`, the whole `~/.switchroom`
   * tree, and the host root filesystem (`/host`) bind-mounted rw — the
   * same host reach `switchroom-hostd` has, but driven by the
   * interactive `claude` session directly so the operator can debug the
   * fleet from Telegram instead of an SSH root shell. `root === true`
   * ALSO forces `admin === true` (see describeAgents) so every existing
   * admin gate applies. Per-agent only; never cascade-resolved. Default
   * false. See docs/root-agent.md.
   */
  root: boolean;
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
  /**
   * Effective LiteLLM routing config (cascade-resolved agent block fused
   * with the top-level fleet defaults). `emitAgentService` injects
   * `ANTHROPIC_BASE_URL`, `ANTHROPIC_SMALL_FAST_MODEL`, and
   * `SWITCHROOM_LITELLM=1` as system-managed env (authoritative over
   * userEnv) ONLY when `enabled && keyConfirmed` — i.e. the agent opted in
   * AND its virtual key actually exists in the vault. Routing env without a
   * key would make every claude call hit the proxy unauthenticated (a
   * silently-broken agent), so the key-presence gate is load-bearing, not
   * cosmetic. `keyConfirmed` is computed by `writeComposeFile` (broker vault
   * check) and threaded via `ComposeGeneratorOptions.litellmConfirmedAgents`;
   * absent that set, `keyConfirmed` is false (fail-safe: no key → no routing
   * env). The secret key itself is NEVER injected here — start.sh fetches it
   * from the vault at boot. See LiteLLMConfigSchema doc + apply.ts.
   */
  litellm: {
    enabled: boolean;
    keyConfirmed: boolean;
    baseUrl: string | undefined;
    smallFastModel: string;
  };
  /**
   * Cascade-resolved configured DEFAULT model for this agent (via
   * `resolveMainModel`, so `undefined`/"default" → the known-good fleet
   * default and any explicit id/alias passes through). Load-bearing for
   * LiteLLM routing: `emitAgentService` gates `ANTHROPIC_BASE_URL` on the
   * model CLASS — Claude models ride the `<root>/anthropic` raw pass-through
   * (dodges the Opus SSE re-chunk stall), but a non-Claude default (e.g.
   * `model: sr-glm-5`) MUST hit the model-mapped router root, because the
   * pass-through is model-agnostic and always forwards to Anthropic (an sr-*
   * model 4xxs "model not found" there). Same `isClaudeModel` split
   * `src/setup/hindsight.ts` already applies for its subprocess.
   */
  model: string;
  /**
   * Resolved IANA timezone for this agent (e.g. "Australia/Melbourne").
   * Walks the four-step cascade in `resolveTimezone`:
   * agent → profile (via merge) → switchroom.timezone → server detection
   * → "UTC". Always a valid zone string; never undefined.
   *
   * Surfaces in the container `environment:` block as BOTH `TZ` (so
   * `date(1)`, `Intl.DateTimeFormat`, and `node-cron`'s default schedule
   * timezone read the operator-intended zone) AND `SWITCHROOM_TIMEZONE`
   * (so `bin/timezone-hook.sh`'s UserPromptSubmit hint matches without
   * a stale-unit warning).
   *
   * Why both: `TZ` is what every Unix tool already reads, including
   * node-cron via libc. `SWITCHROOM_TIMEZONE` is the explicit name
   * the hook checks so it can distinguish "operator declared zone is
   * X" from "container default happens to be X" (the latter would
   * leave SWITCHROOM_TIMEZONE unset and trigger the in-band warning).
   *
   * Wiring regressed during the v0.6→v0.7 systemd→Docker migration
   * (#906 removed `generateUnit` which used to bake `TZ=` /
   * `SWITCHROOM_TIMEZONE=` into the [Service] block). Restored here
   * via the compose `environment:` block — see #1198.
   */
  timezone: string;
  /**
   * Whether the agent runs under the #725 tmux supervisor (the default)
   * rather than the legacy PTY supervisor. Cascade-resolved from
   * `experimental.legacy_pty`: `true` unless the operator opted out with
   * `experimental.legacy_pty: true`. Surfaces in the container
   * `environment:` block as `SWITCHROOM_TMUX_SUPERVISOR="1"` when true and
   * `"0"` when false — emitted in BOTH cases (never omitted) so the value is
   * always system-authoritative and an operator `env:` override can't smuggle
   * it in on a legacy-PTY agent.
   *
   * This env var is the ENABLER for the gateway's deterministic in-chat
   * `/auth add` flow: `startAccountAuthSession` (telegram-plugin/gateway/
   * auth-add-flow.ts) HARD-REFUSES to launch unless
   * `SWITCHROOM_TMUX_SUPERVISOR === "1"` — the guard shipped without its
   * provisioning, so before this the flow was unreachable on every agent
   * (nothing in the compose render, start.sh, or the container env set it;
   * only docs/tmux-supervisor-fanout.md mentioned it as a systemd line for
   * a unit shape this docker deployment doesn't use). Gated on the SAME
   * `legacy_pty !== true` predicate the rest of the tmux-supervisor surface
   * uses (src/cli/agent.ts:1606, src/agents/lifecycle.ts:397). Because the
   * env value is emitted in both branches ("1"/"0") ahead of the userEnv
   * merge, the flag and the runtime it guards can never disagree — not even
   * when an operator adds a conflicting `env:` override.
   */
  tmuxSupervisor: boolean;
  /**
   * Projected `channels.buzz` config, or `undefined` when the agent declares no
   * `channels.buzz` block. `emitAgentService` projects the BUZZ_* env from this
   * (with BUZZ_ENABLED gated on `enabled`). Undefined ⇒ NO BUZZ_* env at all, so
   * an agent without the block renders byte-identical to pre-Buzz. See
   * BuzzServiceData.
   */
  buzz: BuzzServiceData | undefined;
}

/**
 * Per-agent metadata exposed to doctor checks (and tests).
 *
 * `litellmConfirmedAgents` (optional) is the set of agent names whose LiteLLM
 * virtual key actually exists in the vault — computed by `writeComposeFile`
 * via a broker vault probe. Only agents in this set get routing env injected
 * (gated alongside the cascade-resolved `litellm.enabled`). Omitted ⇒ no agent
 * is treated as key-confirmed (fail-safe: never route through the proxy
 * without a key). Tests pass it explicitly to exercise the on-path.
 */
/**
 * Platform-gated default for an agent whose `network_isolation` is unset
 * (#3637). `network_mode: host` is a Linux-only construct: on Docker
 * Desktop (macOS / Windows) the agent runs inside a LinuxKit VM and
 * `network_mode: host` binds to that VM's network namespace, NOT the
 * operator's real host — so host-loopback services (hindsight
 * `127.0.0.1:18888`) are unreachable and the agent silently fails to boot.
 * On non-Linux platforms default to `strict`, whose
 * `host.docker.internal:host-gateway` wiring reaches host services
 * correctly. Linux keeps the historical `host` default → byte-identical.
 *
 * Only the UNSET default is gated: an operator who explicitly writes
 * `network_isolation: host` on macOS gets exactly what they asked for.
 */
export function defaultNetworkIsolation(
  platform: NodeJS.Platform = process.platform,
): "host" | "strict" {
  return platform === "linux" ? "host" : "strict";
}

export function describeAgents(
  config: SwitchroomConfig,
  litellmConfirmedAgents?: Set<string>,
): AgentServiceData[] {
  const out: AgentServiceData[] = [];
  for (const name of Object.keys(config.agents).sort()) {
    const agent = config.agents[name]!;
    const resolved = resolveAgentConfig(config.defaults, config.profiles, agent);
    const profile = agent.extends ?? "default";
    const uid = allocateAgentUid(name);
    // `resolved.resources` is the cascaded operator override (per-field
    // merge of defaults.resources → profile.resources → agent.resources,
    // see mergeAgentConfig). Unset fields fall back to RESOURCE_BY_PROFILE.
    // Cheap-cron (L4 refinement): give cron-session agents a little headroom
    // for the 2nd claude. Config-derived (a context:fresh/cheap-model entry) —
    // false for every current fleet agent, so resources are unchanged today.
    // Apply the value-gate default (cheap-by-default) like the scaffold +
    // fire path do, so a frequent hint-less cron that routes to a Tier-1
    // session also gets its resource headroom here — the three stay in sync.
    const cronSession = scheduleNeedsCronSession(
      (resolved.schedule ?? []).map((e) =>
        applyDefaultTier({ cron: e.cron, kind: e.kind, model: e.model, context: e.context }),
      ),
      { cheapCronEnabled: true },
    );
    const resources = resolveResourceDefaults(name, profile, resolved.resources, { cronSession });
    const strippedCaps = readStrippedCaps(agent);
    out.push({
      name,
      uid,
      profile,
      resources,
      strippedCaps,
      // sec WS6-F1 / #1413: cascade-resolved opt-in network mode.
      // Explicit value wins; unset falls to the platform-gated default
      // (#3637): "host" on Linux (zero behaviour change vs. pre-#1413),
      // "strict" on Docker-Desktop macOS/Windows where network_mode:host
      // binds the LinuxKit VM's namespace instead of the operator's host.
      networkIsolation:
        resolved.network_isolation ?? defaultNetworkIsolation(),
      // `root: true` is a strictly-higher tier than admin and forces
      // admin semantics on (env, audit-log mounts, hostd MCP wiring,
      // every gateway/broker admin gate) so the root agent needs only
      // the one flag. Per-agent only, mirroring admin (no cascade).
      admin: agent.admin === true || agent.root === true,
      root: agent.root === true,
      // Per-agent only (no cascade) — see AgentServiceData.bindMounts
      // doc comment for the rationale.
      bindMounts: agent.bind_mounts ? [...agent.bind_mounts] : [],
      // Read user env from the cascade-resolved config so defaults +
      // profile + agent layers all contribute. Empty object when the
      // operator hasn't declared any (the common case).
      userEnv: { ...(resolved.env ?? {}) },
      // Effective LiteLLM routing. enabled: per-agent cascaded value wins,
      // then the top-level fleet default, else false (mirrors apply.ts
      // `effectiveLiteLLMEnabled`). keyConfirmed: agent is in the vault-probed
      // confirmed set (omitted set ⇒ false, fail-safe). base_url +
      // small_fast_model fall back to the top-level block; small_fast_model
      // has a hard default so the CLI's fast lane always has a model.
      litellm: {
        enabled:
          resolved.litellm?.enabled ??
          (config as { litellm?: { enabled?: boolean } }).litellm?.enabled ??
          false,
        keyConfirmed: litellmConfirmedAgents?.has(name) ?? false,
        baseUrl:
          resolved.litellm?.base_url ??
          (config as { litellm?: { base_url?: string } }).litellm?.base_url,
        smallFastModel:
          resolved.litellm?.small_fast_model ??
          (config as { litellm?: { small_fast_model?: string } }).litellm
            ?.small_fast_model ??
          "claude-haiku-4-5-20251001",
      },
      // Cascade-resolved configured default model (gates ANTHROPIC_BASE_URL
      // model-class routing in emitAgentService). resolveMainModel maps
      // undefined/"default" → the fleet default and passes explicit ids/aliases
      // (incl. non-Claude sr-*) through unchanged.
      model: resolveMainModel(resolved.model),
      // Resolve once at describe-time so the same value lands in TZ
      // and SWITCHROOM_TIMEZONE in `emitAgentService`. The resolver
      // is pure modulo the server-detection probes, so two consecutive
      // calls return the same string — but consolidating to one call
      // keeps the surface obvious in tests.
      // onUtcFallback: fire a loud warning when no explicit timezone is
      // set at any config layer AND server detection yielded nothing
      // (bare cloud VM / UTC container). This is the non-wizard code
      // path that previously silently baked UTC into every agent. The
      // warning surfaces on `switchroom apply` / `switchroom agent
      // reconcile` — the ops that regenerate the compose file.
      // tmux supervisor is the default; only an explicit
      // `experimental.legacy_pty: true` opts out. Same predicate the
      // inject/lifecycle/agent-log surfaces use — keep them in lockstep so
      // the SWITCHROOM_TMUX_SUPERVISOR env can never disagree with the
      // supervisor the agent actually boots under.
      tmuxSupervisor: resolved.experimental?.legacy_pty !== true,
      // Buzz co-channel projection (deploy switch, default-off keystone). Built
      // ONLY when the agent declares a `channels.buzz` block; absent ⇒ undefined
      // ⇒ emitAgentService projects NO BUZZ_* env (byte-identical to pre-Buzz).
      // Schema defaults are re-applied here because `resolved` is the merged raw
      // cascade (not Zod-parsed), matching how telegramEnabledFlag reads raw
      // channels.telegram. `{agent}` is substituted in the nsec key name.
      buzz: ((): BuzzServiceData | undefined => {
        const raw = resolved.channels?.buzz;
        if (!raw) return undefined;
        return {
          enabled: raw.enabled === true,
          mirror: raw.mirror ?? "both",
          chatId: raw.chat_id ?? "",
          relayUrl: raw.relay_url ?? "",
          relayDialUrl: raw.relay_dial_url,
          relayHost: raw.relay_host,
          channelIds: raw.default_channel_id ?? "",
          operatorPubkey: raw.operator_pubkey ?? "",
          authorizedPubkeys: raw.authorized_pubkeys ?? [],
          nsecVaultKey: (raw.nsec_vault_key ?? "buzz/{agent}-nsec").replace(
            /\{agent\}/g,
            name,
          ),
          pubkeyNames: raw.pubkey_names ?? {},
        };
      })(),
      timezone: resolveTimezone(config, resolved, {
        onUtcFallback: () => {
          console.warn(
            `  ⚠ timezone: no explicit timezone set and server detection resolved to UTC ` +
              `for agent "${name}" — cron schedules and the per-turn time hint will ` +
              `run in UTC. Add \`switchroom.timezone: "Region/City"\` (e.g. ` +
              `"Australia/Melbourne") to switchroom.yaml to silence this warning.`,
          );
        },
      }),
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
 * True when a LiteLLM base URL points at the HOST's loopback interface
 * (localhost / 127.0.0.1 / ::1). Such a proxy is only reachable via the host
 * loopback, NOT through host.docker.internal/host-gateway (which routes to the
 * host's bridge IP) — so a consumer container must join the host network to
 * reach it. Mirrors `isLoopbackHttpUrl` in src/setup/hindsight.ts; kept local
 * to avoid pulling the heavy hindsight module into the compose generator.
 */
export function isLoopbackHttpBase(url: string): boolean {
  try {
    const u = new URL(url.includes("://") ? url : `http://${url}`);
    const h = (u.hostname || "").toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return false;
  }
}

/** The in-container path the config is mounted AT (also the SWITCHROOM_CONFIG
 *  value for containerised services). Never a valid host bind SOURCE. */
export const CONTAINER_CONFIG_PATH = "/state/config/switchroom.yaml";

/**
 * Resolve the HOST bind-mount source for the switchroom.yaml config mount.
 *
 * `switchroomConfigPath` is the path the *running generator* reads its config
 * from. On the host that's the real host path; but when `apply` runs INSIDE a
 * container (the hostd `/update apply` path) it's the in-container path
 * `/state/config/switchroom.yaml` — which is NOT a host path. Emitting it as a
 * bind source makes docker auto-create an empty host directory, so the broker
 * reads a directory and dies with EISDIR (the 2026-06-11 fleet outage).
 *
 * A bind source must live on the host filesystem. Any path under `/state/`
 * (the container-only state tree, including the config-mount target itself)
 * can never be a host source, so it's replaced with the canonical host config
 * `<homePrefix>/.switchroom/switchroom.yaml` — the same `homePrefix` every
 * other mount uses, correct whether the generator runs on the host or in a
 * container. A genuine custom HOST path is passed through untouched. Returns
 * `undefined` when no config path was given (back-compat: no config mount).
 * Pure — no IO.
 */
export function resolveConfigMountSource(
  switchroomConfigPath: string | undefined,
  homePrefix: string,
): string | undefined {
  if (!switchroomConfigPath) return undefined;
  // `/state/...` is the in-container state mount — never a host source.
  if (
    switchroomConfigPath === CONTAINER_CONFIG_PATH ||
    switchroomConfigPath.startsWith("/state/")
  ) {
    return `${homePrefix}/.switchroom/switchroom.yaml`;
  }
  return switchroomConfigPath;
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
 * Does a conditional-mount SOURCE resolve to a real host path? Used to gate
 * optional `:ro` bind mounts (Docker auto-creates a missing source as an empty dir).
 *
 * `existsSync` (which FOLLOWS symlinks) is the common case and handles real
 * dirs + symlinks whose target resolves in this filesystem. But some
 * conditional dirs are symlinks to an ABSOLUTE host path — e.g.
 * `~/.switchroom/skills -> /home/op/.switchroom-config/skills`. When `apply`
 * runs INSIDE hostd, `probeHome` is `/host-home` and the symlink's `/home/op`
 * target is unresolvable there, so plain `existsSync` returns false and the
 * mount is WRONGLY dropped (#2387 — the in-hostd reconcile silently loses the
 * skills mount). Detect that case: if the path is a symlink, resolve its
 * target against `probeHome` (translate a `hostHome`-rooted target to the
 * container-real home) and check THAT. The baked mount SOURCE stays the
 * host-home path, which docker resolves host-side at mount time. On the host
 * (`hostHome === probeHome`) this is identical to `existsSync`.
 *
 * Fallback (#2512): hostd only bind-mounts `~/.switchroom/` into its container
 * (not `~/.switchroom-config/` or other operator dirs). A symlink like
 * `~/.switchroom/skills -> /home/op/.switchroom-config/skills` has a
 * `hostHome`-rooted target, and after translation the target becomes
 * `/host-home/.switchroom-config/skills` — which still doesn't exist inside
 * hostd because that directory isn't mounted there. The translated-existsSync
 * path is a dead end for targets outside the hostd bind tree. If the symlink
 * itself exists AND its target is an absolute path under `hostHome` (meaning
 * it unambiguously refers to something on the host), that is sufficient
 * evidence: docker resolves symlinks host-side at bind-mount time and will
 * find the target. Trust the symlink; don't require the translated target to
 * be probe-resolvable inside the container.
 */
function conditionalMountPresent(
  probePath: string,
  hostHome: string,
  probeHome: string,
): boolean {
  if (existsSync(probePath)) return true;
  try {
    if (!lstatSync(probePath).isSymbolicLink()) return false;
    let target = readlinkSync(probePath);
    if (!isAbsolute(target)) target = resolve(dirname(probePath), target);
    if (hostHome && probeHome && hostHome !== probeHome) {
      if (target.startsWith(hostHome + "/")) {
        // The symlink target is host-rooted, so docker will resolve it on the
        // host at bind-mount time and the mount source is valid. The generator
        // runs inside hostd, which only mounts ~/.switchroom/ and cannot stat
        // the symlink's real host target — so we cannot distinguish a live
        // target from a dangling one from here. "Trust it" is the only workable
        // choice.
        //
        // ACCEPTED TRADEOFF: a symlink whose host target is genuinely missing
        // will cause `docker compose up` to hard-fail (agent can't start)
        // rather than silently drop the mount (agent starts without skills).
        // That's intentional — switchroom apply manages these symlinks, so
        // a dangling target is not a real production state, and a loud failure
        // is preferable to a silent capability loss.
        return true;
      }
    }
    return existsSync(target);
  } catch {
    return false;
  }
}

/**
 * Generate a docker-compose.yml from the cascade. Pure function: no IO,
 * no env reads. Deterministic for byte-identical input.
 */
export function generateCompose(opts: ComposeGeneratorOptions): string {
  const { config } = opts;
  // sec WS6-F4 (#1419): fail-closed before emitting anything if two
  // agents would share a container UID.
  assertNoAgentUidCollision(config);
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
  // Backstop (2026-06-11/12 AND 2026-06-23 fleet outages): `homePrefix` is the
  // leading segment of EVERY host-path bind source, so it MUST be a host path.
  // assertPlausibleHostHome rejects the WHOLE class of in-container roots
  // (/host-home, /state/agent/home, /state/*, /run/*, …), not just the single
  // `/host-home` literal the original guard caught — the 2026-06-23 outage used
  // /state/agent/home, which sailed straight through. Fail loud with the
  // recovery path instead of generating a fleet-killing compose.
  assertPlausibleHostHome(homePrefix);
  // Default container_name prefix matches the compose project name and
  // every operator command in the docs (`docker exec -it switchroom-
  // vault-broker ...`, `journalctl --user -u switchroom-vault-broker`).
  // Tests override this so phase fleets get unique names that can't
  // collide with a production install on the same host.
  const containerNamePrefix = opts.containerNamePrefix ?? "switchroom";
  // Host-control daemon (RFC C, Phase 2). Default-on since the Phase 2
  // default-flip: the schema gives `host_control.enabled` a `.default(true)`
  // and the block itself defaults to `{}`, so an absent block resolves to
  // enabled=true. Use `!== false` semantics here so the compose generator
  // matches the parsed-schema view even on the legacy test/code paths that
  // construct config objects directly (bypassing Zod). Operators who want
  // the legacy systemd-mode behaviour set `host_control: { enabled: false }`
  // explicitly. When enabled, admin agents get an extra bind-mount line
  // for the daemon's per-agent UDS.
  const hostControlEnabled = config.host_control?.enabled !== false;
  // For existsSync() decisions on optional bind-mount sources (#907):
  // emission uses `homePrefix` (which may be the literal "${HOME}" so
  // sudo-bake works), but the existsSync probe must use the real host
  // home. Falls back to process.env.HOME when no homeDir is passed.
  const hostHomeForChecks = opts.homeDir ?? process.env.HOME ?? "";
  // The home to probe with existsSync/mkdirSync. Differs from
  // hostHomeForChecks ONLY for an in-hostd apply: there hostHomeForChecks is
  // the host path (baked for the agent) but the operator's dirs are visible
  // at /host-home, so probing hostHomeForChecks finds nothing and drops every
  // conditional mount. probeHome is the container-real home. Defaults to
  // hostHomeForChecks (identical on the host). See GenerateComposeOpts.probeHomeDir.
  const probeHome = opts.probeHomeDir ?? hostHomeForChecks;
  // Gate the host-side directory pre-create (mkdirSync side effects below) on
  // the caller having explicitly told us where the host home is. When neither
  // `homeDir` nor `probeHomeDir` is passed, `probeHome` falls back to the
  // ambient `process.env.HOME` — the operator's REAL production state tree —
  // and pre-creating dirs there corrupts a running fleet (#3127). Reads stay
  // ambient (harmless); only writes are gated. Explicit `precreateHostDirs`
  // overrides the default in either direction.
  const precreateHostDirs =
    opts.precreateHostDirs ??
    (opts.homeDir !== undefined || opts.probeHomeDir !== undefined);
  // The config mount SOURCE must be a HOST path — docker bind-mounts it off the
  // host filesystem. `opts.switchroomConfigPath` is where the RUNNING generator
  // reads ITS config, which is the in-CONTAINER path `/state/config/
  // switchroom.yaml` when `apply` runs inside a container (the hostd
  // `/update apply` path). Emitting that container path as a bind source made
  // docker auto-create an empty host directory → the brokers read a directory
  // → `EISDIR` crash-loop → every agent stuck "Created" (the 2026-06-11 fleet
  // outage). Sanitise here so no caller — host or container — can poison the
  // mount: a `/state/...` container-only path is replaced with the canonical
  // host config under `homePrefix`, the same prefix every other mount uses.
  const switchroomConfigPath = resolveConfigMountSource(
    opts.switchroomConfigPath,
    homePrefix,
  );
  // Bundled-skills pool dir. Default to the live resolver so production
  // calls Just Work; tests pass an explicit path (or "") to override.
  const bundledSkillsPoolDir = opts.bundledSkillsPoolDir ?? getBundledSkillsPoolDir();

  // Voice-engine verdict (PR-B1 → PR-B2). Injectable for snapshot tests;
  // production reads the persisted verdict. Default `cloud` (no sidecar)
  // when no verdict file exists — fail-safe: never emit a GPU service on a
  // host we haven't confirmed has a usable GPU.
  const voiceEngine: VoiceEngine =
    opts.voiceEngine ?? loadHostCapabilities()?.voice.engine ?? "cloud";

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
  if (probeHome !== "") {
    const idPath = join(probeHome, ".switchroom", "analytics-id");
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
  lines.push("# or `switchroom apply`. To customise an agent, edit");
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
  lines.push(`    restart: always`);
  emitLogging(lines);
  // Liveness probe — bind-presence. The broker creates per-agent
  // socket directories at startup and binds `<dir>/sock` for each
  // configured agent. If at least one bind has happened, the daemon
  // is alive enough to take work; if every bind has gone away, the
  // daemon is wedged or dead and `restart: always` should
  // recycle it. This catches the silent-down failure mode where the
  // broker exits cleanly (compose then sees process-gone) AS WELL AS
  // a hung daemon that's still holding the process slot but stopped
  // listening.
  //
  // Trade-off: an empty fleet (no agents → no per-agent dirs → no
  // sockets) reports unhealthy. Acceptable: a switchroom install
  // without any agents has no business running the broker; an
  // operator who's mid-install has minutes-scale exposure to this.
  // We still do NOT speak the broker's auth'd app protocol here
  // (peercred + audit-log noise). Instead the probe also requires a
  // 0-byte readiness sentinel the broker writes on unlock and
  // unlinks on lock (SWITCHROOM_VAULT_BROKER_READY_PATH). So the
  // health state is `serving AND unlocked` — a LOCKED broker now
  // reads unhealthy. Reporting a locked broker "healthy" is exactly
  // what masked the install-validation 2026-05-17 incident, where a
  // routine `apply` relocked the broker and `docker compose ps`
  // still said healthy (RFC J §2.4 / Phase 4).
  lines.push(`    healthcheck:`);
  lines.push(`      test: ["CMD-SHELL", "ls /run/switchroom/broker/*/sock 2>/dev/null | head -1 | grep -q . && test -f /run/switchroom/broker/.ready"]`);
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
  // Readiness sentinel the broker writes on unlock / unlinks on lock.
  // The healthcheck above tests it so `docker compose ps` reflects
  // unlocked-AND-serving, not just socket bind-presence (RFC J Phase 4).
  lines.push(`      SWITCHROOM_VAULT_BROKER_READY_PATH: /run/switchroom/broker/.ready`);
  // Operator UID — when set, the broker binds an additional listener at
  // /run/switchroom/broker/operator/sock and chowns it to this UID so
  // the host operator's shell can talk to the broker through the bind
  // mount below. See server.bindOperatorListener for the runtime side.
  if (opts.operatorUid !== undefined) {
    lines.push(`      SWITCHROOM_BROKER_OPERATOR_UID: "${opts.operatorUid}"`);
  }
  lines.push(`    volumes:`);
  for (const a of describeAgents(config, opts.litellmConfirmedAgents)) {
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
  // Capability grants DB — bind-mount the host DIRECTORY that holds the
  // grants SQLite file (and its WAL sidecars) into the broker so grants
  // survive container recreate. Without this mount the broker writes to
  // `/root/.switchroom/vault-broker/vault-grants.db` inside the container
  // (which evaporates on every recreate). The token files on disk
  // (`~/.switchroom/agents/<agent>/.vault-token`) persist via the per-agent
  // bind mounts and reference a grant ID that no longer exists in the fresh
  // broker DB — the broker's #1496 fall-through routes the call to the
  // standing schedule.secrets ACL, which usually denies because the granted
  // key isn't in the agent's static config (the whole reason a grant was
  // minted in the first place). Surfaces as `VAULT-BROKER-DENIED [DENIED]:
  // key 'X' not in ACL for agent 'Y'` on every `switchroom vault get` from
  // inside the agent container after a broker recreate.
  //
  // WHY A DIRECTORY, NOT THE BARE FILE (#3289): the grants DB runs in WAL
  // mode, which writes `-wal`/`-shm` sidecars BESIDE the main file. When only
  // the single main file was mounted (pre-#3289), those sidecars landed in the
  // container's ephemeral overlayfs — so a committed grant sat in the
  // container-local WAL until a rare automatic checkpoint and was LOST on
  // container recreate. Mounting the whole `vault-broker` directory keeps the
  // main file AND its sidecars together on the host fs. The in-container path
  // and the host directory are resolved from `grants-db.ts` helpers so no path
  // literal is duplicated.
  //
  // Surfaced 2026-05-24 after the v0.13.31 broker recreate wiped
  // every grant minted earlier the same day (clerk's vg_5e1991 for
  // `ha/access-token`). The doctor probe doesn't catch this — it
  // only inspects path-as-identity ACL, not grant-based access.
  //
  // The directory is pre-created (mode 0700, with the DB migrated in) by
  // `ensureHostMountSources()` (apply.ts) so docker doesn't auto-create a
  // root-owned path at the source. Broker writes via root with
  // CAP_DAC_OVERRIDE so ownership doesn't gate the write path. (Same pattern
  // as vault-audit.log above and host-control-audit.log on hostd.)
  lines.push(`      - ${homePrefix}/.switchroom/${GRANTS_DB_DIRNAME}:${GRANTS_DB_CONTAINER_DIR}`);
  // Per-agent vault-grant token files. The broker's mint_grant
  // handler (server.ts ~2222) writes the minted token at
  // `os.homedir() + .switchroom/agents/<agent>/.vault-token`.
  // Inside the broker container `os.homedir()` is `/root`, so the
  // unmounted default would write to `/root/.switchroom/agents/<agent>/.vault-token`
  // — ephemeral, invisible to both the operator host and the
  // agent containers that need to read the token to authenticate
  // back to the broker. Pre-fix every fresh mint stranded.
  //
  // Bind each per-agent token file at the same path the broker
  // computes, so writes land on the operator's host fs and the
  // agent's per-agent dir mount surfaces them inside the agent
  // container too. Source files are pre-created (mode 0600,
  // owned by the agent UID) by `ensureHostMountSources` in
  // apply.ts so docker doesn't auto-create a root-owned directory
  // here. Broker writes via root with CAP_DAC_OVERRIDE.
  //
  // #3751 — CRITICAL for anything that writes this path from inside the
  // broker container: because this is a BARE-FILE bind (not a directory
  // bind), the destination is a MOUNTPOINT. `rename(2)` over it and
  // `unlink(2)` of it both return EBUSY. mint_grant's tmp+rename publish
  // therefore failed on every single mint until #3751 replaced it with an
  // in-place O_TRUNC write (`vault/broker/write-token-file.ts`); the
  // reaper hit the same wall in #3749 (`reap-token-file.ts`). In-place
  // also preserves the inode, hence the agent-UID ownership and 0600 mode
  // apply.ts set — so no post-write chown is needed on the rewrite path,
  // and the agent keeps reading the file under its own peercred identity.
  for (const a of describeAgents(config, opts.litellmConfirmedAgents)) {
    lines.push(
      `      - ${homePrefix}/.switchroom/agents/${a.name}/.vault-token:/root/.switchroom/agents/${a.name}/.vault-token`,
    );
  }
  // /etc/machine-id passthrough — required so the broker can derive
  // the same machine-bound key the host's `enable-auto-unlock` used
  // to seal the auto-unlock blob. The agent base image (node:22-trixie-slim)
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
  lines.push(`    restart: always`);
  emitLogging(lines);
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
  // the same probe-reachability.
  //
  // DAC_OVERRIDE is needed because /state/approvals is bind-mounted
  // from `~/.switchroom/approvals` on the host — owned by the operator
  // user, mode 0775 — and the kernel runs as root inside the container.
  // Without DAC_OVERRIDE, root-in-container can't open the SQLite db
  // file there for writes (it isn't the owner and "other" doesn't have
  // write). DAC_READ_SEARCH alone is read-only. Install-validation
  // finding #18 (PR adding this comment).
  lines.push(`    cap_add:`);
  lines.push(`      - "CHOWN"`);
  lines.push(`      - "FOWNER"`);
  lines.push(`      - "DAC_READ_SEARCH"`);
  lines.push(`      - "DAC_OVERRIDE"`);
  if (switchroomConfigPath || opts.operatorUid !== undefined) {
    lines.push(`    environment:`);
    if (switchroomConfigPath) {
      lines.push(`      SWITCHROOM_CONFIG: /state/config/switchroom.yaml`);
    }
    // Enables the read-only host operator listener. Gated on the same
    // operatorUid the auth-broker uses; absent ⇒ no operator socket,
    // kernel behaviour unchanged.
    if (opts.operatorUid !== undefined) {
      lines.push(`      SWITCHROOM_KERNEL_OPERATOR_UID: "${opts.operatorUid}"`);
    }
  }
  lines.push(`    volumes:`);
  for (const a of describeAgents(config, opts.litellmConfirmedAgents)) {
    lines.push(`      - kernel-${a.name}-sock:/run/switchroom/kernel/${a.name}`);
  }
  if (switchroomConfigPath) {
    lines.push(`      - ${switchroomConfigPath}:/state/config/switchroom.yaml:ro`);
  }
  // Operator socket — host-mounted bind so host-side `approvalList`
  // (e.g. the web dashboard) can read decision metadata. Mirrors the
  // auth-broker operator bind; only emitted when operatorUid is set so
  // a legacy install doesn't get a confusingly-empty dir. The kernel
  // restricts this socket to the read-only approval_list op.
  if (opts.operatorUid !== undefined) {
    lines.push(
      `      - ${homePrefix}/.switchroom/state/kernel-operator:/run/switchroom/kernel/operator`,
    );
  }
  lines.push(`      - ${homePrefix}/.switchroom/approvals:/state/approvals`);
  lines.push(``);

  // The singleton switchroom-cron service was removed in Phase 4 of
  // the cron-fold-in. Cron now runs in-container as a sibling of the
  // gateway in every agent (see profiles/_base/start.sh.hbs's third
  // supervised sidecar and src/agent-scheduler/). Fires arrive in the
  // agent transcript through the same InboundMessage path Telegram
  // uses, tagged meta.source="cron".

  // ── switchroom-auth-broker (singleton, RFC H §4.1) ─────────────────
  // Sole writer of per-agent <agentDir>/.claude/credentials.json and
  // canonical owner of the OAuth refresh loop for every Anthropic
  // account on the host. Same shape as vault-broker / approval-kernel:
  // per-agent UDS socket at /run/switchroom/auth-broker/<name>/sock,
  // path-as-identity authorization, bind-presence healthcheck.
  const authConsumers = config.auth?.consumers ?? [];
  lines.push(`  switchroom-auth-broker:`);
  emitImageOrBuild(lines, "auth-broker", imageTag, buildMode, buildContext);
  lines.push(`    container_name: ${containerNamePrefix}-auth-broker`);
  lines.push(`    labels:`);
  lines.push(`      switchroom.role: "auth-broker"`);
  lines.push(`      switchroom.fleet: "${containerNamePrefix}"`);
  lines.push(`    restart: always`);
  emitLogging(lines);
  // Bind-presence healthcheck — same probe pattern as vault-broker /
  // approval-kernel (PR #898). Empty-fleet trade-off applies: a
  // switchroom install with zero agents and zero consumers reports
  // unhealthy, which is correct (the broker has nothing to serve).
  lines.push(`    healthcheck:`);
  lines.push(`      test: ["CMD-SHELL", "ls /run/switchroom/auth-broker/*/sock 2>/dev/null | head -1 | grep -q ."]`);
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
  // RFC H §4.1: smallest cap set that lets the broker bind sockets
  // (CHOWN to per-agent UID) and read/write mirror files into per-
  // agent state dirs owned by per-agent UIDs.
  lines.push(`    cap_add:`);
  lines.push(`      - "CHOWN"`);
  lines.push(`      - "FOWNER"`);
  lines.push(`      - "DAC_READ_SEARCH"`);
  lines.push(`      - "DAC_OVERRIDE"`);
  // Operator UID — when set, pass `--operator-uid <N>` so the broker
  // entry binds the operator listener at
  // /run/switchroom/auth-broker/operator/sock and chowns it to <N>.
  // Without this the host operator's `switchroom auth use|add|show` CLI
  // hits "auth-broker unreachable at .../auth-broker-operator/sock" —
  // the bind mount below exists but the socket never gets created.
  // Mirror of vault-broker's pattern (line ~813) but plumbed via flag
  // rather than env var since the broker entry script reads
  // --operator-uid as a flag, not an env (see src/auth/broker/index.ts).
  if (opts.operatorUid !== undefined) {
    lines.push(`    command: ["bun", "/opt/switchroom/dist/auth-broker/index.js", "--operator-uid", "${opts.operatorUid}"]`);
  }
  lines.push(`    environment:`);
  if (switchroomConfigPath) {
    lines.push(`      SWITCHROOM_CONFIG: /state/config/switchroom.yaml`);
  }
  // Internal paths follow vault-broker convention:
  //   /state/accounts  → ~/.switchroom/accounts/
  //   /state/agents    → ~/.switchroom/agents/
  //   /state/auth-broker → ~/.switchroom/state/auth-broker/
  lines.push(`      SWITCHROOM_AUTH_BROKER_STATE_DIR: /state/auth-broker`);
  // LiteLLM root for get-external-spend (OpenRouter cash on /usage).
  // Broker holds the master key in state-dir; agents never see it.
  //
  // Reachability: the broker must connect out to the LiteLLM proxy the
  // same way the hindsight consumer does (see generateHindsightComposeSnippet).
  //   - Loopback base (127.0.0.1/localhost:4010): the proxy is published on
  //     the HOST's loopback interface only (Coolify/socat bind 127.0.0.1).
  //     A bridge container CANNOT reach a 127.0.0.1-bound host port —
  //     host.docker.internal/host-gateway routes to the host's *bridge* IP
  //     (e.g. 10.0.0.1), not to host loopback, so the connection is refused
  //     and get-external-spend silently returns available:false (blank
  //     /usage External row). Join the host network so 127.0.0.1:4010 is
  //     directly reachable, and keep the loopback base URL verbatim.
  //   - Non-loopback base (a real bridge-reachable host/socat name): stay on
  //     the compose bridge and pair host-gateway so a mixed host-socat name
  //     written as host.docker.internal still resolves.
  // extra_hosts / network_mode are only emitted when a base is configured —
  // keeps the zero-litellm fleet compose free of both (network_isolation
  // regression guard).
  let authBrokerNeedsHostGateway = false;
  let authBrokerNeedsHostNetwork = false;
  {
    const llBase =
      (config as { litellm?: { base_url?: string } }).litellm?.base_url;
    if (typeof llBase === "string" && llBase.trim()) {
      const raw = llBase.trim().replace(/\/+$/, "");
      lines.push(`      SWITCHROOM_LITELLM_BASE: ${JSON.stringify(raw)}`);
      if (isLoopbackHttpBase(raw)) {
        authBrokerNeedsHostNetwork = true;
      } else {
        authBrokerNeedsHostGateway = true;
      }
    }
  }
  lines.push(`      SWITCHROOM_ACCOUNTS_DIR: /state/accounts`);
  lines.push(`      SWITCHROOM_AGENTS_DIR: /state/agents`);
  // Operator UID — when set, the broker binds an additional listener at
  // /run/switchroom/auth-broker/operator/sock and chowns it to this UID
  // so `switchroom auth …` from a shell on the host can reach the
  // broker. Mirrors vault-broker's SWITCHROOM_BROKER_OPERATOR_UID
  // env-driven enablement. Without this, the operator-dir bind mount
  // below is unused dead weight.
  if (opts.operatorUid !== undefined) {
    lines.push(`      SWITCHROOM_AUTH_BROKER_OPERATOR_UID: "${opts.operatorUid}"`);
  }
  if (authBrokerNeedsHostNetwork) {
    // Host network stack: 127.0.0.1:4010 (loopback-published LiteLLM) is
    // directly reachable, mirroring the hindsight consumer's proven path.
    // The broker's agent-facing IPC is unix-domain sockets in bind-mounted
    // named volumes, so host networking does not affect how agents reach it.
    lines.push(`    network_mode: host`);
  } else if (authBrokerNeedsHostGateway) {
    lines.push(`    extra_hosts:`);
    lines.push(`      - "host.docker.internal:host-gateway"`);
  }
  lines.push(`    volumes:`);
  // Per-agent socket dir (named volume; agent side mounts the parent).
  for (const a of describeAgents(config, opts.litellmConfirmedAgents)) {
    lines.push(`      - auth-broker-${a.name}-sock:/run/switchroom/auth-broker/${a.name}`);
  }
  // Per-consumer socket dir — same shape, but the consumer container
  // (e.g. hindsight) lives outside the switchroom compose project and
  // bind-mounts the named volume by canonical name.
  for (const c of authConsumers) {
    lines.push(`      - auth-broker-${c.name}-sock:/run/switchroom/auth-broker/${c.name}`);
  }
  // Per-consumer creds mirror (#2578). When a consumer declares
  // `mirror_dir`, the broker actively pushes the effective-account
  // `.credentials.json` there the instant it detects exhaustion (see
  // mirrorAccountToConsumer in src/auth/broker/server.ts). That only
  // reaches the consumer if broker and consumer share a volume: mount
  // it here at the operator-chosen `mirror_dir` path, and the consumer
  // container (e.g. hindsight, started out-of-project) mounts the SAME
  // named volume at its creds-read path. The volume name is canonical
  // (unprefixed, declared below) so the cross-project consumer can
  // reference it. Consumers WITHOUT `mirror_dir` emit nothing here —
  // output is byte-identical to pre-#2578. The broker reads the
  // `mirror_dir` value straight from SWITCHROOM_CONFIG, so no extra env
  // is duplicated.
  for (const c of authConsumers) {
    if (c.mirror_dir) {
      lines.push(`      - consumer-creds-${c.name}:${c.mirror_dir}`);
    }
  }
  // Operator socket — host-mounted bind so `switchroom auth …` from a
  // shell on the host can reach the broker. Path is the operator-
  // socket bind documented in the RFC §4.2. Only emitted when an
  // operator-uid is set (mirrors vault-broker line ~834) — without one
  // the broker doesn't bind an operator listener so the bind mount
  // would just be a confusingly-empty dir on disk.
  if (opts.operatorUid !== undefined) {
    lines.push(
      `      - ${homePrefix}/.switchroom/state/auth-broker-operator:/run/switchroom/auth-broker/operator`,
    );
  }
  if (switchroomConfigPath) {
    lines.push(`      - ${switchroomConfigPath}:/state/config/switchroom.yaml:ro`);
  }
  // Accounts dir (sole writer post-RFC-H), per-agent dirs (mirror writes),
  // and the broker's own state dir.
  lines.push(`      - ${homePrefix}/.switchroom/accounts:/state/accounts`);
  lines.push(`      - ${homePrefix}/.switchroom/agents:/state/agents`);
  lines.push(`      - ${homePrefix}/.switchroom/state/auth-broker:/state/auth-broker`);
  lines.push(``);

  // ── voice-sidecar (singleton, GPU STT — PR-B2) ─────────────────────
  // Emitted ONLY on a `local` voice verdict (GPU present + container
  // toolkit, per PR-B1). On `cloud` we emit nothing — voice-in routes
  // through the OpenAI provider instead.
  if (voiceEngine === "local") {
    emitVoiceSidecarService(
      lines,
      imageTag,
      buildMode,
      buildContext,
      containerNamePrefix,
    );
  }

  // #3648: the host docker socket path a `root: true` agent binds `:rw`.
  // KEPT PURE: this generator never shells out — it defaults to the
  // conventional socket constant and relies on the caller to inject the
  // context-resolved path. Live resolution (`docker context inspect`)
  // happens ONLY at the imperative CLI seams (computeComposeContent,
  // bringUpAgentService), so the compose-generator test path stays
  // hermetic regardless of the host's active docker context (#3648).
  const dockerSocketPath = opts.dockerSocketPath ?? DEFAULT_DOCKER_SOCKET_PATH;

  // Per-agent scratch volume (see ./scratch.ts). Resolved ONCE per generate:
  // the availability probe is a filesystem stat and must not vary between
  // agents inside one compose file. When the operator wrote an explicit
  // `scratch:` block but the volume isn't there, warn — silently degrading a
  // configured knob is how a fleet ends up back at 85% full without anyone
  // noticing. When the block is absent (the single-disk default), stay quiet.
  const scratchCfg = resolveScratchConfig(config);
  if (
    scratchCfg.explicit &&
    scratchCfg.enabled &&
    !scratchVolumeAvailable(scratchCfg.volume)
  ) {
    warn(
      `compose: scratch.volume "${scratchCfg.volume}" does not exist on this host — ` +
      `agent caches stay on the root disk (scratch mount and cache env redirects omitted)`,
    );
  }

  // ── per-agent services ─────────────────────────────────────────────
  for (const a of describeAgents(config, opts.litellmConfirmedAgents)) {
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
      probeHome,
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
      opts.operatorUid,
      voiceEngine,
      precreateHostDirs,
      dockerSocketPath,
      agentScratchHostDir(scratchCfg, a.name),
    );
  }

  // ── volumes ────────────────────────────────────────────────────────
  lines.push(`volumes:`);
  for (const a of describeAgents(config, opts.litellmConfirmedAgents)) {
    lines.push(`  broker-${a.name}-sock:`);
    lines.push(`  kernel-${a.name}-sock:`);
    lines.push(`  auth-broker-${a.name}-sock:`);
  }
  for (const c of authConsumers) {
    // Override the project-prefix so cross-project consumers (e.g. the
    // standalone hindsight container started by `startHindsight()`) can
    // reference the volume by the canonical unprefixed name. Per-agent
    // volumes above don't need this — they're consumed inside this same
    // compose project, so the prefix is invisible.
    lines.push(`  auth-broker-${c.name}-sock:`);
    lines.push(`    name: auth-broker-${c.name}-sock`);
  }
  // Shared creds-mirror volume (#2578) — one per consumer with a
  // `mirror_dir`. Canonical (unprefixed) name so the cross-project
  // consumer container can mount the same volume by name. Absent when
  // no consumer sets `mirror_dir`, keeping legacy output byte-identical.
  //
  // Creation-order note (verified live, docker compose v5.1.3, 2026-07-11):
  // if `startHindsight()`'s docker-run path executes BEFORE the next
  // `apply` of this project, `docker run -v consumer-creds-<name>:…`
  // auto-creates the volume WITHOUT compose labels. `docker compose up`
  // on this project then emits a warning ("already exists but was not
  // created by Docker Compose. Use `external: true`…") but SUCCEEDS with
  // exit 0 and REUSES the existing volume unchanged (labels/CreatedAt
  // untouched) — an explicit `name:` adopts a same-named pre-existing
  // volume rather than erroring. So ordering between `memory setup` and
  // `apply` is safe in both directions; do not re-litigate. (The
  // hindsight compose SNIPPET is stricter — it declares the volume
  // `external: true`, so that path does require this project, or a
  // prior docker run, to have created the volume first.)
  for (const c of authConsumers) {
    if (c.mirror_dir) {
      lines.push(`  consumer-creds-${c.name}:`);
      lines.push(`    name: consumer-creds-${c.name}`);
    }
  }
  // Named volume for the voice sidecar's fetch-once model weights —
  // only declared when the sidecar service is emitted (local verdict).
  // Keeps weights out of the image (size + redistribution licensing).
  if (voiceEngine === "local") {
    lines.push(`  voice-model-cache:`);
  }
  lines.push("");

  // ── networks (sec WS6-F1 / #1413) ──────────────────────────────────
  // One dedicated bridge network per `network_isolation: strict` agent.
  // A network with exactly one attached service gives that agent NO
  // route to sibling agents (true inter-agent isolation); host
  // services are reached via the per-service `host.docker.internal:
  // host-gateway` extra_hosts. Emitted ONLY when at least one agent
  // opted in — a default (all-host) fleet's compose is byte-identical
  // to pre-#1413 (no networks: block at all).
  const strictAgents = describeAgents(config, opts.litellmConfirmedAgents).filter(
    (a) => a.networkIsolation === "strict",
  );
  if (strictAgents.length > 0) {
    lines.push(`networks:`);
    for (const a of strictAgents) {
      lines.push(`  switchroom-net-${a.name}:`);
      lines.push(`    driver: bridge`);
    }
    lines.push("");
  }

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
  probeHome: string,
  switchroomConfigPath: string | undefined,
  containerNamePrefix: string,
  posthog: PosthogRuntimeEnv,
  bundledSkillsPoolDir: string,
  hostControlEnabled: boolean,
  operatorUid: number | undefined,
  voiceEngine: VoiceEngine,
  precreateHostDirs: boolean,
  dockerSocketPath: string,
  /**
   * Host-side per-agent scratch directory, or null when the feature is off
   * (disabled in config, or the bulk volume isn't mounted on this host).
   * Resolved once per generate by the caller so the availability probe can't
   * differ between agents in one file. See ./scratch.ts.
   */
  scratchHostDir: string | null,
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
  // #1413 builds exactly that as an OPT-IN mode (default stays host).
  if (a.networkIsolation === "strict") {
    // Dedicated per-agent bridge network → the agent cannot reach
    // sibling agents (true inter-agent isolation, WS6-F1). Host
    // services (hindsight 127.0.0.1:18888, operator-LAN env) are
    // reached via host.docker.internal:host-gateway instead of the
    // shared host stack. The top-level `networks:` block defines
    // `switchroom-net-<name>` (see the networks section emitter).
    lines.push(`    networks:`);
    lines.push(`      - switchroom-net-${a.name}`);
    lines.push(`    extra_hosts:`);
    lines.push(`      - "host.docker.internal:host-gateway"`);
  } else {
    lines.push(`    network_mode: host`);
  }
  lines.push(`    restart: always`);
  emitLogging(lines);
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
  // ROOT-tier agent: runs as uid 0 so the interactive claude session can
  // write the host root fs (mounted at /host below) and drive docker.sock
  // directly — the "standing root shell over Telegram" the operator chose
  // over a per-action tap. Normal agents stay pinned to their deterministic
  // non-root UID. The brokers chown each per-agent socket to a.uid, but a
  // uid-0 process bypasses file perms and the ACL gates on the bind PATH
  // (path-as-identity in docker mode), so credential fetch still works.
  if (a.root) {
    lines.push(`    user: "0:0"`);
  } else {
    lines.push(`    user: "${a.uid}:${a.uid}"`);
  }
  lines.push(`    mem_limit: ${a.resources.memLimit}`);
  if (a.resources.memReservation !== undefined) {
    lines.push(`    mem_reservation: ${a.resources.memReservation}`);
  }
  if (a.resources.pidsLimit !== undefined) {
    lines.push(`    pids_limit: ${a.resources.pidsLimit}`);
  }
  lines.push(`    cpus: ${a.resources.cpus.toFixed(1)}`);
  // ROOT-tier agent deliberately skips the per-agent hardening
  // (no-new-privileges / cap_drop ALL / read_only). docker.sock already
  // makes it root-on-host, so the hardening would only break the host
  // debugging it exists to do (writing /host, full caps for docker exec)
  // without adding any isolation. Everything else (mem/pids/cpu limits,
  // tmpfs) is unchanged.
  if (!a.root) {
    lines.push(`    security_opt:`);
    lines.push(`      - "no-new-privileges:true"`);
    lines.push(`    cap_drop:`);
    lines.push(`      - "ALL"`);
    // read_only root FS — claude CLI, tini, tmux, node only need writable
    // /tmp (and the explicit /state/* mounts above). tmpfs keeps /tmp
    // RAM-backed and capped so a runaway can't fill the host disk.
    lines.push(`    read_only: true`);
  }
  lines.push(`    tmpfs:`);
  // Size is operator-tunable via `resources.tmp_size` (defaults → profile →
  // per-agent cascade); DEFAULT_TMP_SIZE when unset at every layer.
  lines.push(`      - /tmp:size=${a.resources.tmpSize},mode=1777`);
  lines.push(`    depends_on:`);
  lines.push(`      vault-broker:`);
  lines.push(`        condition: service_started`);
  lines.push(`      approval-kernel:`);
  lines.push(`        condition: service_started`);
  // RFC H §5: agents wait on the auth-broker healthcheck before booting.
  // Without it the agent comes up with stale (or no) credentials.json
  // and claude's first call fails on auth, panicking the boot card.
  lines.push(`      switchroom-auth-broker:`);
  lines.push(`        condition: service_healthy`);
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
    // ── Claude-runtime invariants for a pinned-image, cache-engineered
    //    24/7 fleet (these are fleet-wide truths, not per-agent knobs) ──
    //
    // DISABLE_AUTOUPDATER: the `claude` binary is delivered by the
    // agent image, which is rebuilt/rolled forward deliberately via
    // `switchroom update` (and, for the base, digest-pinned — sec
    // WS9-F4 #1418). An in-container autoupdater silently mutating
    // `claude` underneath a pinned image defeats that pin and the
    // docker-first immutable-image model: the running binary would no
    // longer match the audited/built image. Disabling it is a
    // correctness/supply-chain fix that also removes the periodic
    // update-check network traffic from every agent.
    DISABLE_AUTOUPDATER: "1",
    // CLAUDE_CODE_ATTRIBUTION_HEADER=0: documented to omit the
    // attribution block, which improves prompt-cache hit rate.
    // Switchroom already invests heavily and deliberately in a
    // cache-stable prompt prefix (e.g. bin/timezone-hook.sh rounds the
    // per-turn timestamp to a 900s bucket "so Anthropic's
    // content-addressed cache isn't invalidated every turn"); a
    // volatile attribution header works directly against that existing
    // design. Unknown/renamed env vars are ignored by the runtime, so
    // this is at worst a no-op — never a regression.
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    SWITCHROOM_AGENT_NAME: a.name,
    // Static fallback for the model half of the commit-attribution trailer
    // pair (bin/git-agent-attribution-hook.sh). start.sh exports the more
    // accurate SWITCHROOM_SESSION_MODEL — the model the session actually
    // launched on, including a live `/model` override — but that export only
    // reaches processes descended from `exec claude`. A bare
    // `docker exec <container> git commit` inherits the CONTAINER env, not
    // start.sh's, so without this the model trailer would read "unknown"
    // there. Already resolved through resolveMainModel() upstream
    // (compose.ts:930), so this is the same string the routing class below
    // is baked from.
    SWITCHROOM_AGENT_MODEL: a.model,
    // The agent's profile (its `extends:` value, defaulting to
    // "default"). Read by the LiteLLM `x-litellm-tags` header emitted
    // from start.sh.hbs / cron-session.sh.hbs as `profile:<value>` —
    // without this write the `${SWITCHROOM_AGENT_PROFILE:-default}`
    // expansion always collapsed to "default" (3 reads, 0 writes), so
    // the per-profile spend tag was dead. Must match `profile` resolved
    // in `collectAgentServices` (`agent.extends ?? "default"`).
    SWITCHROOM_AGENT_PROFILE: a.profile ?? "default",
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
    // RFC H §5: in-container path to the auth-broker socket. The
    // named volume mounts the per-agent dir at /run/switchroom/auth-
    // broker (one level shallower than the broker container sees it,
    // mirroring SWITCHROOM_VAULT_BROKER_SOCK). The auth-broker client
    // library reads this env to locate the socket — see
    // src/auth/broker/client.ts:resolveAuthBrokerSocketPath.
    SWITCHROOM_AUTH_BROKER_SOCKET: `/run/switchroom/auth-broker/sock`,
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
    // Per-agent timezone (#1198). Both vars are emitted unconditionally
    // because `resolveTimezone` always returns a valid IANA string
    // (final fallback = "UTC"). `TZ` is the standard Unix env var
    // every tool reads — `date(1)`, `Intl.DateTimeFormat`, `node-cron`'s
    // schedule evaluator. Without it the agent container inherits the
    // Debian base image's `Etc/UTC` and every cron expression fires
    // 10–11 hours off the operator's local clock.
    // `SWITCHROOM_TIMEZONE` is the explicit name `bin/timezone-hook.sh`
    // reads so its UserPromptSubmit hint can distinguish "operator
    // declared zone is X" from "container default happens to be X".
    // Wiring regressed in #906 (systemd→Docker migration); see #1198.
    SWITCHROOM_TIMEZONE: a.timezone,
    TZ: a.timezone,
  };
  // SWITCHROOM_HOST_HOME: baked-in host home directory.
  //
  // When an agent (or a sub-agent it launches) invokes `switchroom apply`
  // from inside the container, the CLI resolves the config file via
  // SWITCHROOM_CONFIG — which is the CONTAINER path `/state/config/
  // switchroom.yaml`. Without a mapping back to the host path, that
  // container path would be emitted verbatim as the bind-mount SOURCE in
  // the regenerated compose file. Docker then auto-creates an empty
  // directory at `/state/config/switchroom.yaml` on the host, the broker
  // tries to read it as a file, and crashes with EISDIR.
  //
  // The fix: bake the host home at apply time so the in-container CLI can
  // translate `/state/config/switchroom.yaml` → `<host-home>/.switchroom/
  // switchroom.yaml`. See `resolveHostSwitchroomConfigPath` in
  // `src/cli/write-compose.ts`. Emitted unconditionally (only set when
  // homeDir is known — the only callers that don't pass homeDir are old
  // tests that don't exercise the container path).
  if (hostHomeForChecks) {
    env.SWITCHROOM_HOST_HOME = hostHomeForChecks;
  }
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
  // SWITCHROOM_AGENT_ROOT: in-container marker that this is the ROOT-tier
  // debugging agent. The scaffold reads it to render the root persona /
  // capability block in CLAUDE.md; emitted before the admin block since
  // root implies admin (a.admin is already true here when a.root).
  if (a.root === true) {
    env.SWITCHROOM_AGENT_ROOT = "true";
  }
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
  // SWITCHROOM_WEBHOOK_RECEIVER_UID: the host operator UID, used by the
  // gateway's webhook ingest server (channels.telegram.webhook_via_gateway)
  // to peercred-gate the dedicated webhook.sock — only this UID (the host
  // web receiver) and the agent's own UID may inject webhook turns. Same
  // operatorUid the broker/kernel/auth-broker operator sockets use; emitted
  // unconditionally when known so enabling the flag needs no re-apply of a
  // different shape. Absent ⇒ gateway allows only self → receiver 503s,
  // surfacing the misconfiguration. See reference/rfcs/webhook-via-gateway-socket.md.
  if (operatorUid !== undefined) {
    env.SWITCHROOM_WEBHOOK_RECEIVER_UID = String(operatorUid);
  }
  // LiteLLM routing env (opt-in, #litellm). Injected ONLY when the agent
  // opted in (litellm.enabled) AND its virtual key actually exists in the
  // vault (keyConfirmed). The key-presence gate is load-bearing: injecting
  // ANTHROPIC_BASE_URL without a key makes every claude call hit the proxy
  // unauthenticated — a silently-broken agent. So a failed/absent provision
  // ⇒ no routing env ⇒ the agent keeps the normal broker-OAuth Anthropic
  // path (degraded-but-working) rather than a dead proxy path.
  //
  // ANTHROPIC_BASE_URL points the `claude` CLI at LiteLLM's **Anthropic
  // pass-through** endpoint (`<root>/anthropic`), NOT the model-mapped
  // `/v1/messages` route. The pass-through raw-forwards the request and
  // streams the upstream SSE bytes natively; the model-mapped route
  // translate→ChatCompletion→re-emit→re-chunks the stream, which stalls
  // long opus responses mid-flight ("API Error: Response stalled
  // mid-stream" — the 2026-07-05 marko incident). claude appends
  // `/v1/messages`, so `<root>/anthropic` → `<root>/anthropic/v1/messages`,
  // exactly the pass-through path. OAuth still rides in Authorization
  // (forwarded upstream unchanged); the virtual key rides in the
  // x-litellm-api-key header start.sh exports — that split is what keeps
  // this subscription-native. SWITCHROOM_LITELLM_BASE keeps the ROOT proxy
  // URL for the two consumers that need the model-mapped/admin surface, NOT
  // the pass-through: start.sh's `/health/liveliness` probe and the
  // gateway's `/model/info` non-Claude (sr-*) model discovery. Set BEFORE
  // the userEnv merge so these system-managed keys are authoritative (the
  // merge only fills env[k] when undefined). base_url is required for the
  // markers to be useful; only emit the set when it resolved.
  if (a.litellm.enabled && a.litellm.keyConfirmed && a.litellm.baseUrl) {
    const root = a.litellm.baseUrl.replace(/\/+$/, "");
    env.SWITCHROOM_LITELLM = "1";
    env.SWITCHROOM_LITELLM_BASE = root;
    // Route by model CLASS (mirror src/setup/hindsight.ts): a Claude default
    // rides the `<root>/anthropic` raw pass-through (dodges the Opus SSE
    // re-chunk stall), but a non-Claude default (e.g. `model: sr-glm-5`) has
    // NO `.session-model-override` carrier, so start.sh's sr-* repoint would
    // never fire — it would 4xx on every call against the model-agnostic
    // pass-through. Point it straight at the model-mapped router root so a
    // persistent sr-* default routes to OpenRouter from the first turn.
    env.ANTHROPIC_BASE_URL = isClaudeModel(a.model) ? `${root}/anthropic` : root;
    env.ANTHROPIC_SMALL_FAST_MODEL = a.litellm.smallFastModel;
  }
  // SWITCHROOM_VOICE_ENGINE: the host's voice-transcription verdict
  // (PR-B1 → PR-B2), resolved ONCE per generator call from
  // host-capabilities.json and threaded down here. The gateway reads it
  // as the FIRST source when picking the STT engine for a voice note —
  // without this propagation the in-container gateway never sees the
  // host verdict file (the constructed in-container `~/.switchroom` view
  // doesn't carry it) and every agent defaults to `cloud`, so the local
  // GPU sidecar is never called even on a GPU host. Emitted
  // unconditionally with the resolved value (`local` or `cloud`) so the
  // gateway honors it deterministically.
  env.SWITCHROOM_VOICE_ENGINE = voiceEngine;
  // SWITCHROOM_TMUX_SUPERVISOR: the enabler for the gateway's deterministic
  // in-chat `/auth add` OAuth flow. `startAccountAuthSession`
  // (telegram-plugin/gateway/auth-add-flow.ts) HARD-REFUSES to launch its
  // tmux pane unless this is exactly "1" — the guard shipped in v0.19.2
  // without any provisioning, so the flow was unreachable on every agent
  // (verified: nothing in the compose render, start.sh, or the container
  // env ever set it; only docs/tmux-supervisor-fanout.md mentioned it as a
  // systemd `Environment=` line for a unit shape this docker deployment
  // doesn't use). Provisioned here, config-derived: "1" whenever the agent
  // runs under the tmux supervisor (the default), "0" when the operator opted
  // out with `experimental.legacy_pty: true`. The value is emitted in BOTH
  // branches (never left unset) so it is ALWAYS system-authoritative: the
  // userEnv merge below only fills keys that are `undefined`, so a system key
  // must actually be set for the merge to protect it. If the legacy_pty case
  // left the key unset, an operator `env: { SWITCHROOM_TMUX_SUPERVISOR: "1" }`
  // override (exactly the interim workaround the design doc suggested) would
  // pass straight through and wrongly launch the tmux auth-add flow on a
  // legacy-PTY agent with no tmux supervisor backing it. Writing "0" here lets
  // the merge protect the legacy case too, and the gateway guard (`!== "1"`)
  // correctly stays refused on "0". Emitted BEFORE the userEnv merge so the
  // system value always wins — the operator can't clobber the runtime contract
  // from yaml in EITHER direction, which is what makes the flag and the
  // runtime it guards genuinely unable to disagree.
  env.SWITCHROOM_TMUX_SUPERVISOR = a.tmuxSupervisor ? "1" : "0";
  // Buzz co-channel env projection (channels.buzz → BUZZ_* container env). This
  // is the Phase-1 deploy switch and the default-off keystone. The whole block
  // is emitted ONLY when the agent declares a `channels.buzz` block (a.buzz set)
  // — an agent WITHOUT the block projects NOTHING here, so its compose is
  // byte-identical to pre-Buzz. Within the block, BUZZ_ENABLED=1 is projected
  // ONLY when enabled === true; an enabled:false/absent block leaves BUZZ_ENABLED
  // unset, so start.sh's `[ "$BUZZ_ENABLED" = "1" ]` guard never forks the
  // sidecar and the channel stays dark by construction. The nsec is deliberately
  // NOT projected — only its vault KEY NAME (the sidecar broker-fetches the
  // secret in-process at boot). Emitted BEFORE the userEnv merge below so these
  // system keys are authoritative (the merge only fills undefined keys).
  if (a.buzz) {
    const b = a.buzz;
    // The keystone gate: BUZZ_ENABLED lands ONLY for an explicitly-enabled block.
    if (b.enabled) env.BUZZ_ENABLED = "1";
    env.BUZZ_MIRROR = b.mirror;
    env.BUZZ_CHAT_ID = b.chatId;
    env.BUZZ_RELAY_URL = b.relayUrl;
    if (b.relayDialUrl) env.BUZZ_RELAY_DIAL_URL = b.relayDialUrl;
    if (b.relayHost) env.BUZZ_RELAY_HOST = b.relayHost;
    env.BUZZ_CHANNEL_IDS = b.channelIds;
    env.BUZZ_OPERATOR_PUBKEY = b.operatorPubkey;
    if (b.authorizedPubkeys.length > 0) {
      env.BUZZ_AUTHORIZED_PUBKEYS = b.authorizedPubkeys.join(",");
    }
    env.BUZZ_NSEC_VAULT_KEY = b.nsecVaultKey;
    const petnames = Object.entries(b.pubkeyNames);
    if (petnames.length > 0) {
      env.BUZZ_PUBKEY_NAMES = petnames.map(([k, v]) => `${k}=${v}`).join(",");
    }
  }
  // Scratch-volume cache redirects. Emitted ONLY when the scratch mount is
  // emitted (below) — the two are one unit: env pointing at a `/scratch` that
  // isn't mounted would break every install in the container, and a mount with
  // no env redirects would be a silently useless empty directory.
  //
  // Placed BEFORE the userEnv merge (which only fills `undefined` keys), so
  // these are authoritative the same way HOME / NPM_CONFIG_PREFIX /
  // SWITCHROOM_* are. An operator who wants the old layout opts out with
  // `scratch.enabled: false` rather than by shadowing individual keys — a
  // half-redirected cache set is worse than either end state.
  if (scratchHostDir !== null) {
    for (const [k, v] of Object.entries(scratchEnv(SCRATCH_CONTAINER_DIR))) {
      env[k] = v;
    }
  }
  // Merge operator-declared env vars from the agent's `env:` block.
  // System-managed keys (HOME, NPM_*, SWITCHROOM_*) win on collision —
  // an operator can't override the runtime contract from yaml. A
  // collision warning would help, but skipped for now (rare in
  // practice; doctor check could add this later).
  for (const [k, v] of Object.entries(a.userEnv)) {
    if (env[k] === undefined) env[k] = v;
  }
  // ENABLE_PROMPT_CACHING_1H: opt in to the 1-hour extended prompt-cache
  // TTL (API beta `extended-cache-ttl-2025-04-11`) for every claude
  // session in the container (KEN-126). Idle-heavy Telegram agents
  // routinely go >5 min between messages, so the default 5-minute cache
  // TTL expires between turns and the next turn re-writes the whole
  // prompt prefix. The claude CLI (verified against the shipped 2.1.219
  // binary) reads this env var as an explicit force-on for the 1h TTL
  // (`FORCE_PROMPT_CACHING_5M` is the opposite override). Without the
  // env, 2.1.219 decides via a remote statsig config
  // (`tengu_prompt_cache_1h_config`, default allowlist
  // `repl_main_thread*`/`sdk`/…) gated on subscription auth AND
  // not-currently-in-overage — i.e. nondeterministic and remotely
  // mutable. Pinning it here makes the behavior deterministic. Cost: on
  // subscription (the switchroom hard constraint) 1h caching has no
  // marginal cost; on API/overage billing 1h cache WRITES bill at 2x
  // base input — which is why this default is applied AFTER the userEnv
  // merge with an undefined-guard, so an operator CAN opt out via
  // `env:` in switchroom.yaml (`ENABLE_PROMPT_CACHING_1H: "0"` or
  // `FORCE_PROMPT_CACHING_5M: "1"` — the CLI checks the 5m force
  // first). Container-wide on purpose: the Tier-1 cheap-cron session (a
  // second interactive claude in the same container) inherits it too —
  // frequent crons (≤60 min cadence) are exactly the sessions whose
  // prompt prefix survives to the next fire only under a 1h TTL.
  if (env.ENABLE_PROMPT_CACHING_1H === undefined) {
    env.ENABLE_PROMPT_CACHING_1H = "1";
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
  // RFC H §5: per-agent auth-broker socket dir. The agent sees the
  // socket at /run/switchroom/auth-broker/sock (its single-agent
  // view), the broker sees /run/switchroom/auth-broker/<name>/sock
  // (its multi-agent view). Same shape vault-broker / approval-kernel
  // use; path-as-identity invariant is enforced by socketPathToName
  // parsing the broker-side path on every connection.
  lines.push(`      - auth-broker-${a.name}-sock:/run/switchroom/auth-broker`);
  // ROOT-tier debugging agent mount set (the operator chose standing
  // root over a per-action tap). These three mounts are the same host
  // reach `switchroom-hostd` has, plus the host root fs so the agent can
  // read/edit any host file without the `docker run -v /:/x` dance —
  // a Telegram-driven replacement for an SSH root shell. NOT routed
  // through the bind_mounts denylist (that gates operator-declared
  // `bind_mounts:` entries; these are framework-injected for the root
  // tier specifically). Only ever emitted for `root: true`.
  if (a.root === true) {
    // docker.sock — manage / exec into / read logs of every other
    // container in the fleet. This alone is root-equivalent on the host.
    // Source path resolved from the active docker context (#3648) so a
    // relocated / rootless daemon socket is bound at its real path; the
    // in-container target stays /var/run/docker.sock (where the agent's
    // docker client looks by default).
    lines.push(`      - ${dockerSocketPath}:/var/run/docker.sock:rw`);
    // The whole ~/.switchroom tree (all agents' scaffolds, logs, configs,
    // the vault, audit logs) at /host-home/.switchroom — mirrors hostd's
    // mount so the root agent can inspect any agent's on-host state.
    lines.push(`      - ${homePrefix}/.switchroom:/host-home/.switchroom:rw`);
    // The host root filesystem at /host — full read/write reach to the
    // host OS (system logs, /etc, Coolify/nginx state, …) so debugging
    // doesn't bottom out at the container boundary.
    //
    // CAVEAT (#3637, Docker Desktop): on macOS/Windows `/` here is the
    // LinuxKit VM's root, NOT the operator's real host filesystem — the
    // root-agent debugging UX assumes a native Linux daemon. Documented,
    // not gated: the root tier is a Linux-host operator affordance.
    lines.push(`      - /:/host:rw`);
  }
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
    // not have it yet, and Docker auto-creates a missing source as an empty dir when a
    // `:ro` source is missing (same pattern as the skills /
    // credentials mounts below).
    if (existsSync(`${probeHome}/.switchroom/vault-audit.log`)) {
      lines.push(
        `      - ${homePrefix}/.switchroom/vault-audit.log:/state/agent/home/.switchroom/vault-audit.log:ro`,
      );
    }
    // Same shape, for the hostd audit log (#1328): admin DMs can run
    // `/audit hostd` to tail the privileged-verb history. Hostd is the
    // sole writer (its own container with --cap-drop=ALL + appendFile);
    // mounting :ro keeps a compromised admin agent from rewriting
    // history. Same existsSync guard as the vault audit log — hostd
    // creates the file lazily on the first privileged-verb request, so
    // a fresh install may not have it yet and compose `up` would
    // cause Docker to auto-create a missing :ro source as an empty dir.
    if (existsSync(`${probeHome}/.switchroom/host-control-audit.log`)) {
      lines.push(
        `      - ${homePrefix}/.switchroom/host-control-audit.log:/state/agent/home/.switchroom/host-control-audit.log:ro`,
      );
    }
  }
  // Host-control daemon socket (#1164 follow-up — RFC C).
  // Mounted for EVERY agent (gated only on `host_control.enabled:
  // true`), NOT just admin agents — that's why it lives outside the
  // `a.admin === true` block above: binding a socket ≠ granting admin.
  // Every privileged verb is still gated server-side in hostd's
  // `checkGate`; the one verb a non-admin agent can reach is a
  // self-scoped `config_propose_edit` (it may only widen its OWN
  // `tools.allow`) so "🔁 Always allow" persists for the whole fleet,
  // not just the 3 admin agents. The daemon binds the per-agent socket
  // at `~/.switchroom/hostd/<name>/sock`, chowns it to the agent UID,
  // and the agent connects via the in-container path
  // `/run/switchroom/hostd/<name>/sock`. Same bind-mount shape the
  // broker uses; identity comes from the host-side bind path so the
  // agent can't forge it.
  //
  // No singleton container in Phase 1 (the daemon lives outside
  // compose); only the per-agent volume here. The agent end is the
  // directory, not the file, so the daemon can bind the socket inside
  // it after starting. existsSync guard on the directory: if the
  // daemon hasn't run yet, the directory will be missing — compose
  // Docker would auto-create a missing source as an empty dir. We bind read-write so
  // the daemon can chown the socket file from the host side; the agent
  // only connects.
  if (hostControlEnabled && existsSync(`${probeHome}/.switchroom/hostd/${a.name}`)) {
    lines.push(
      `      - ${homePrefix}/.switchroom/hostd/${a.name}:/run/switchroom/hostd/${a.name}`,
    );
  }
  // Per-agent scratch volume — the fleet's build/package caches, moved off
  // the root disk onto the operator's bulk device (see ./scratch.ts for the
  // measurements and the full rationale).
  //
  // FRAMEWORK-INJECTED, exactly like the root-tier mount set above and the
  // shared `skills/` mount below, and deliberately NOT routed through the
  // operator-facing `bind_mounts:` denylist immediately below this block.
  // That denylist is an ADMIN-ONLY escalation: `bind_mounts` throws for any
  // agent without `admin: true`. The agents that fill a root disk with npm
  // and uv caches are ordinary non-admin agents, so routing this through
  // `bind_mounts:` would break the fleet for exactly the agents the change
  // exists to fix. Neither source nor target comes from operator yaml here —
  // the framework picks both (`<volume>/<subdir>/<agent>` → `/scratch`), and
  // each agent sees only its OWN directory, never the shared parent.
  //
  // `:rw` by necessity (the whole point is that package managers write here)
  // and exempt from the `read_only: true` root fs the same way every other
  // bind mount is — the daemon applies it before the entrypoint runs.
  //
  // Null when the feature is off, which is the entire degradation story: a
  // single-disk dev machine emits no mount, no env, and byte-identical
  // output to before this landed.
  if (scratchHostDir !== null) {
    // Pre-create host-side so docker doesn't auto-create the bind source as
    // root:root — that is the EACCES trap this feature would otherwise walk
    // straight into, because the container runs as a per-agent non-root uid.
    // Same best-effort shape as the audit / schedule.d pre-creates below.
    // Apply does this authoritatively ahead of the compose write
    // (`ensureHostMountSources` in src/cli/apply.ts); this is the guard for a
    // compose write that did NOT come through apply — e.g. the `agent
    // restart` reconcile path, which shares writeComposeFile. It calls the
    // SAME helper rather than a bare mkdir so that path can't leave a
    // root-owned bind source behind (apply self-elevates to root, and a
    // root:root scratch dir EACCESes every cache write from the agent uid).
    if (precreateHostDirs) {
      ensureAgentScratchDir(scratchHostDir, a.name);
    }
    lines.push(`      - ${scratchHostDir}:${SCRATCH_CONTAINER_DIR}:rw`);
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
  // Blocked-approval surface (#3084 follow-up). When a permission card can't be
  // delivered (Telegram flood ban), the gateway HOLDS the approval — it never
  // auto-denies — and writes a world-readable record here so the operator can
  // see, off-Telegram, that an agent is blocked and until when. This is a
  // SHARED top-level dir (not per-agent /state/agent) because switchroom-web
  // reads every agent's record from one place; the file is 0644 so web's
  // uid-1000 process can actually read it (agent state files are 0600 and are
  // not readable by web — verified on the live box).
  lines.push(`      - ${homePrefix}/.switchroom/blocked-approvals:/state/blocked-approvals:rw`);
  lines.push(`      - ${homePrefix}/.switchroom/agents/${a.name}:${homePrefix}/.switchroom/agents/${a.name}`);
  lines.push(`      - ${homePrefix}/.claude/projects/${a.name}:${homePrefix}/.claude/projects/${a.name}`);
  // Shared read-only `skills/` bind mount (#907). Cron yaml prompts
  // reference `~/.switchroom/skills/...` (calendar, mail, garmin,
  // home-assistant). Mounted at the operator's host path so absolute
  // paths in scaffolded start.sh and yaml prompts Just Work; tilde
  // resolution is fixed by start.sh.hbs's $HOME/.switchroom symlink
  // (#910). existsSync-guarded: Docker auto-creates a missing source as an empty dir on a
  // missing `:ro` source. skills/ is operator-authored, non-secret
  // content (WS6 audit: LOW info-disclosure only) so it stays
  // fleet-wide.
  if (conditionalMountPresent(`${probeHome}/.switchroom/skills`, hostHomeForChecks, probeHome)) {
    lines.push(`      - ${homePrefix}/.switchroom/skills:${homePrefix}/.switchroom/skills:ro`);
  }
  // Operator-declared MCP launcher dir (#1786 follow-up). Operators who
  // declare a user-level MCP server with a `command:` host path (e.g.
  // `defaults.mcp_servers.perplexity.command:
  // /home/<op>/.switchroom/mcp-launchers/perplexity-mcp.sh`) need that
  // launcher to resolve INSIDE the agent container too — otherwise the
  // .mcp.json entry lands (per the scaffold fix) but the launcher
  // ENOENTs at spawn. Mount the operator's `~/.switchroom/mcp-launchers/`
  // at the same host-absolute path so the operator's yaml `command:`
  // value just works in-container. Same-path :ro mount mirrors the
  // skills/ pattern above; existsSync-guarded so dev installs without
  // a launcher dir don't hard-fail compose `up`. Pure-URL MCPs (e.g.
  // notion `type: http`) don't need this mount.
  if (conditionalMountPresent(`${probeHome}/.switchroom/mcp-launchers`, hostHomeForChecks, probeHome)) {
    lines.push(
      `      - ${homePrefix}/.switchroom/mcp-launchers:${homePrefix}/.switchroom/mcp-launchers:ro`,
    );
  }
  // Fleet directory — agent prompt cascade lanes 1 and 2 (epic
  // #1850, issue #1852). Holds `switchroom-invariants.md`
  // (release-pinned) and `CLAUDE.md` (operator-owned fleet defaults).
  // Reaches the agent's `claude` process via `--add-dir` (set in
  // start.sh.hbs), which extends Claude Code's native CLAUDE.md
  // discovery roots. Same-path mount so the operator can edit the
  // file and the agent reads the same bytes. `:ro` because the
  // agent never writes here; `switchroom apply` is the only writer.
  // Created with seeded files by `ensureHostMountSources` in apply.ts,
  // so existsSync is true on every post-apply install.
  if (conditionalMountPresent(`${probeHome}/.switchroom/fleet`, hostHomeForChecks, probeHome)) {
    lines.push(
      `      - ${homePrefix}/.switchroom/fleet:${homePrefix}/.switchroom/fleet:ro`,
    );
  }
  // /etc/localtime passthrough — keep the system clock zone in sync with
  // the resolved per-agent timezone (#1198 follow-up). `TZ` /
  // `SWITCHROOM_TIMEZONE` (emitted in `emitAgentServiceEnv`) already
  // cover everything that reads the `TZ` env var — glibc `date(1)`,
  // Node `Intl`, Python, cron. But statically-linked Go binaries and
  // some Java runtimes ignore `TZ` and read `/etc/localtime` directly,
  // so without this they see the base image's UTC regardless of the
  // operator's declared zone. We CANNOT fix this from inside start.sh:
  // the agent process runs as the unprivileged uid (Dockerfile.agent
  // `USER 10001`, compose `user: <uid>:<uid>`) on a `read_only: true`
  // rootfs with `cap_drop: ALL` + `no-new-privileges`, so `ln -sf
  // /etc/localtime` would be auto-created as an empty dir. A docker-daemon bind mount is
  // applied by the daemon (root) BEFORE the entrypoint and is exempt
  // from the read-only rootfs — the right layer for this. Source is the
  // host's zoneinfo file for the resolved zone. `a.timezone` is IANA-
  // validated on the config-sourced branches, but `resolveTimezone`'s
  // server-detection fallback (`/etc/timezone` contents / `/etc/localtime`
  // symlink tail) is NOT run through `isValidTimezone` — so re-validate
  // here before interpolating into a path, keeping a stray `..` out of
  // the bind source regardless of how the zone was resolved. Only
  // `/etc/localtime` is synced (not `/etc/timezone`); the Go/JVM readers
  // this targets read `/etc/localtime`, and the rest honor `TZ`.
  // existsSync-guarded because Docker auto-creates a missing source as an empty dir; a missing
  // bind source and an exotic host may lack tzdata — when absent we skip
  // and fall back to the env-var path (the cosmetic 95% case). Same host
  // path inside the container, so a plain absolute bind with no
  // `homePrefix` rewrite.
  //
  // LOAD-BEARING IMAGE INVARIANT: this mount is only correct because
  // `docker/Dockerfile.agent` materialises `/etc/localtime` as a plain
  // REGULAR FILE before `USER 10001`. Docker resolves a bind mount's
  // destination path through symlinks in the container rootfs BEFORE
  // mounting, so against stock tzdata (`/etc/localtime ->
  // /usr/share/zoneinfo/Etc/UTC`) this line silently mounted the
  // agent's local zonefile over `/usr/share/zoneinfo/Etc/UTC` instead.
  // `/etc/localtime` then read correct local time by accident while
  // every by-NAME UTC lookup in the tzdata db (Python
  // `zoneinfo.ZoneInfo("UTC")`, `TZ=UTC date`, Go/Java/Rust) returned
  // LOCAL time — a silent multi-hour error, not a cosmetic one.
  // `/usr/share/zoneinfo/UTC` is a symlink to `Etc/UTC` so it was
  // corrupted too. If you ever change the agent image's
  // `/etc/localtime` back to a symlink, this mount becomes actively
  // harmful and must be removed with it. Guarded by
  // `tests/docker/localtime-mount-symlink.test.ts` and by the `tzdata`
  // agent_smoke probe in `src/host-control/server.ts`.
  if (isValidTimezone(a.timezone) && existsSync(`/usr/share/zoneinfo/${a.timezone}`)) {
    lines.push(`      - /usr/share/zoneinfo/${a.timezone}:/etc/localtime:ro`);
  }
  // PER-AGENT credentials mount (sec WS6-F2, #1390). Previously the
  // ENTIRE `~/.switchroom/credentials/` dir was bind-mounted `:ro`
  // into EVERY agent — so a prompt-injected agent could read every
  // credential the operator placed there for any agent/purpose
  // (cross-agent credential exfil reachable from untrusted input).
  // Now scoped to `~/.switchroom/credentials/<name>/`, mirroring the
  // per-agent `audit/<name>` pattern below (and its "never mount the
  // parent" rule). Mounted at BOTH the canonical flat in-container
  // path AND the host-absolute path so existing yaml prompts that
  // reference `~/.switchroom/credentials/<file>` keep resolving — the
  // agent now sees only ITS OWN credentials there. Migration of any
  // pre-existing flat `~/.switchroom/credentials/*` files into per-
  // agent subdirs is surfaced as a loud `doctor` warning (see
  // checkFlatCredentialsMigration) — never a silent break.
  if (conditionalMountPresent(`${probeHome}/.switchroom/credentials/${a.name}`, hostHomeForChecks, probeHome)) {
    lines.push(
      `      - ${homePrefix}/.switchroom/credentials/${a.name}:${homePrefix}/.switchroom/credentials:ro`,
    );
  }
  // Ensure the host-side per-agent audit dir exists before docker
  // compose tries to bind-mount it (docker auto-creates as root, which
  // then traps the agent uid out of writing — pre-creating with the
  // operator's umask sidesteps that).
  if (precreateHostDirs) {
    try {
      mkdirSync(`${probeHome}/.switchroom/audit/${a.name}`, { recursive: true });
    } catch { /* best-effort */ }
  }
  // Same trap, shared dir (#3084 follow-up): the blocked-approval surface is
  // ONE directory written by EVERY agent, and agents run as per-agent non-root
  // uids (AGENT_UID_MIN = 10001). If docker auto-creates this bind source it is
  // root:root 0755 and every agent's write EACCESes — the surface that tells
  // the operator an agent is blocked would be silently empty.
  //
  // Pre-create it sticky-world-writable (1777, the /tmp model): each agent
  // creates and owns its own 0644 <agent>.json, so no agent can modify or
  // delete another's. mkdirSync's `mode` is masked by umask, so chmod explicitly.
  if (precreateHostDirs) {
    try {
      const blockedDir = `${probeHome}/.switchroom/blocked-approvals`;
      mkdirSync(blockedDir, { recursive: true });
      chmodSync(blockedDir, 0o1777);
    } catch { /* best-effort */ }
  }
  // Phase B (switchroom #1163): pre-create the per-agent overlay
  // directory so the agent-config write tools (Phase C) have a writable
  // landing zone. The whole ~/.switchroom/agents/<name>/ tree is already
  // bind-mounted rw at lines above (the dual-mount), so no separate
  // volume entry is needed — just the host-side dir, owned by the
  // operator umask before docker auto-creates it as root.
  if (precreateHostDirs) {
    try {
      mkdirSync(`${probeHome}/.switchroom/agents/${a.name}/schedule.d`, { recursive: true });
    } catch { /* best-effort */ }
  }
  // Agent-config audit log (rw) — the read-only agent-config MCP broker
  // (src/mcp/agent-config/server.ts) appends one JSONL row per tool call
  // to ~/.switchroom/audit/<agent>/agent-config.jsonl. PER-AGENT mount:
  // each agent sees only its own audit subdir, never any other agent's.
  // Critical: do NOT mount the parent ~/.switchroom/audit/ — that would
  // let any agent read every other agent's audit trail.
  lines.push(`      - ${homePrefix}/.switchroom/audit/${a.name}:${homePrefix}/.switchroom/audit/${a.name}:rw`);
  // Config-repo personal-skills slice (#1846, closes JTBD from #1819).
  // PR #1844 (v0.13.50) auto-mirrors personal-skill writes into the
  // operator's git-tracked ~/.switchroom-config/ for durability. But the
  // agent container can't see ~/.switchroom-config/ unless we bind-mount
  // it — without this, the mirror silently no-ops for the dominant
  // (in-container) caller and durability claim is false.
  //
  // PER-AGENT slice: only this agent's own subdir is mounted, never the
  // whole repo. Same isolation invariant as the audit mount above. The
  // mount target inside the container matches `homePrefix` so
  // `resolveConfigSkillsDir` in skill-personal.ts finds it via the
  // default `~/.switchroom-config/` path.
  //
  // Gated on the operator having opted in to versioned personal-skills
  // (i.e. ~/.switchroom-config/ exists). Pre-create the per-agent
  // subdir under operator umask so docker doesn't auto-create as root
  // (the chown sweep in alignAgentUid will fix ownership on next apply).
  if (conditionalMountPresent(`${probeHome}/.switchroom-config`, hostHomeForChecks, probeHome)) {
    if (precreateHostDirs) {
      try {
        mkdirSync(
          `${probeHome}/.switchroom-config/agents/${a.name}/personal-skills`,
          { recursive: true },
        );
      } catch { /* best-effort */ }
    }
    lines.push(
      `      - ${homePrefix}/.switchroom-config/agents/${a.name}/personal-skills:${homePrefix}/.switchroom-config/agents/${a.name}/personal-skills:rw`,
    );
  }
  // webkite binary + cloakbrowser shared Chromium (#TBD). The webkite
  // binary is a private-beta release that lives on the operator's host
  // only (`~/.switchroom/bin/webkite`), never committed to this repo or
  // baked into the agent image. Mount it on the in-container PATH so
  // every agent can spawn `webkite mcp` (the stdio MCP server) without
  // any per-agent install. existsSync-guarded because dev installs
  // without webkite staged should not hard-fail compose `up`.
  //
  // Cloakbrowser's stealth Chromium (~700MB extracted) is shared fleet-
  // wide from `~/.switchroom/cloakbrowser/`, mounted RO onto the image's
  // fixed CLOAKBROWSER_CACHE_DIR (`/opt/switchroom/cloakbrowser-cache`,
  // set in Dockerfile.agent) — one ~700MB copy on disk instead of N.
  //
  // #TBD: this used to shadow `$HOME/.cloakbrowser` from the operator's
  // stray `~/.cloakbrowser`, on the belief that cloakbrowser hardcodes
  // that path. It does NOT — `cloakbrowser/config.py::get_cache_dir()`
  // reads CLOAKBROWSER_CACHE_DIR and only defaults to `~/.cloakbrowser`.
  // The old source also sat OUTSIDE `~/.switchroom/`, which is the only
  // subtree hostd bind-mounts, so the existsSync guard was always false
  // whenever compose was generated from hostd — the mount was silently
  // never emitted and every agent downloaded its own private 697MB copy.
  // Keeping the source under `~/.switchroom/` keeps the probe truthful in
  // both the host-CLI and hostd generation contexts.
  //
  // The target sits under `/opt/switchroom`, which BIND_MOUNT_TARGET_DENYLIST
  // reserves for switchroom-owned image paths — i.e. an operator cannot
  // shadow or redirect this cache from yaml. That's the point.
  //
  // The `:ro` is load-bearing, not incidental: a shared WRITABLE browser
  // cache would let any one agent rewrite a Chromium binary that every
  // other agent then executes as itself. Do not relax it.
  //
  // The cloakbrowser pipx tool itself is baked into the agent image
  // (Dockerfile.agent) so the venv shebang lines resolve in-container.
  if (existsSync(`${probeHome}/.switchroom/bin/webkite`)) {
    lines.push(
      `      - ${homePrefix}/.switchroom/bin/webkite:/usr/local/bin/webkite:ro`,
    );
  }
  if (existsSync(`${probeHome}/.switchroom/cloakbrowser`)) {
    lines.push(
      `      - ${homePrefix}/.switchroom/cloakbrowser:/opt/switchroom/cloakbrowser-cache:ro`,
    );
  }
  // Operator-authored shared webkite config (e.g. defaults.format,
  // proxy rotation file). Optional OVERRIDE — the fleet already ships a
  // baked-in default render config (#2805): Dockerfile.agent bakes
  // docker/webkite/config.toml to /opt/switchroom/webkite/config.toml and
  // start.sh.hbs seeds it to ~/.config/webkite/config.toml (copy-if-absent).
  // When this operator file exists it is bind-mounted RO onto the SAME
  // target, so the file is present at boot and start.sh's copy-if-absent
  // skips — i.e. the operator override wins over the baked default.
  if (existsSync(`${probeHome}/.switchroom/webkite/config.toml`)) {
    lines.push(
      `      - ${homePrefix}/.switchroom/webkite/config.toml:/state/agent/home/.config/webkite/config.toml:ro`,
    );
  }
  // Bundled-skills pool: mount at the same absolute host path so the
  // symlinks created by reconcileAgentDefaultSkills (which target the
  // source-repo or npm-package skills/ dir — e.g.
  // `<repo>/skills/skill-creator`) resolve inside the container.
  // Guard with existsSync because the resolved path may not exist in
  // exotic test setups and Docker auto-creates a missing source as an empty dir on missing
  // `:ro` sources. Skip when the pool path is already covered by the
  // operator skills mount above (no duplicate volume entries).
  // bundledSkillsPoolDir is homedir()-derived (container-real — `/host-home`
  // inside hostd). The mount SOURCE must be the HOST path so the agent
  // (network_mode host, same path in/out) resolves it; and the
  // dedup-vs-skills-mount `startsWith` below must compare host-rooted paths
  // or it mismatches in hostd (`/host-home` vs `/home/op`) and wrongly emits
  // a `/host-home` source (#2383). Translate probeHome→hostHomeForChecks,
  // like every other mount source.
  const bundledSkillsBakeDir =
    probeHome &&
    hostHomeForChecks &&
    probeHome !== hostHomeForChecks &&
    bundledSkillsPoolDir.startsWith(probeHome + "/")
      ? hostHomeForChecks + bundledSkillsPoolDir.slice(probeHome.length)
      : bundledSkillsPoolDir;
  if (
    bundledSkillsPoolDir &&
    existsSync(bundledSkillsPoolDir) &&
    !bundledSkillsBakeDir.startsWith(`${hostHomeForChecks}/.switchroom/skills`)
  ) {
    lines.push(`      - ${bundledSkillsBakeDir}:${bundledSkillsBakeDir}:ro`);
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
