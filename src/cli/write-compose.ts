/**
 * Single source of truth for *generating + writing* the fleet compose file.
 *
 * Extracted from `apply` so that BOTH `switchroom apply` and the
 * `agent restart` reconcile path emit byte-identical compose output — they
 * can never drift. This closes the gotcha behind the v0.14.92 roll
 * (memory `agent-restart-needs-apply-for-pin`): a `release.pin` bump in
 * switchroom.yaml reached the scaffold via `agent restart` but NOT the
 * compose image refs, because restart re-emitted the agent-dir layer only
 * and left the compose (hence the running image) on the old pin. Restart now
 * regenerates the compose, so "edit switchroom.yaml → restart → done" — the
 * promise `reconcileAndRestartAgent`'s own docstring already made — actually
 * holds for image/pin changes too.
 */

import { chownSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { SwitchroomConfig } from "../config/schema.js";
import { generateCompose, assertPlausibleHostHome } from "../agents/compose.js";
import { resolveDockerSocketPath } from "../agents/docker-socket.js";
import { isContainerContext } from "./agent-config.js";
import { resolveImageTag, resolveRelease, type ReleaseBlockShape } from "../config/release-resolve.js";
import { isDockerRuntime } from "../runtime-mode.js";
import { resolveOperatorUid } from "./operator-uid.js";
import { resolveAgentConfig } from "../config/merge.js";
import { VOICE_SIDECAR_SERVICE } from "../agents/singleton-reconcile.js";
import {
  resolveVoiceEngine,
  isDefaultedVoiceEngine,
  type VoiceEngineReason,
  type VoiceEngineResolution,
} from "../setup/host-capabilities.js";

/** Minimal structural view of a broker structured-get result (see
 *  src/vault/broker/client.ts `getViaBrokerStructured`). We branch on `kind`
 *  plus — for kind "denied" — the underlying broker error `code`: the client
 *  rolls LOCKED, DENIED, BAD_REQUEST and INTERNAL all up into "denied", and
 *  only the code distinguishes a transient broker condition (vault LOCKED
 *  during the routine apply/relock window; INTERNAL error) from a genuine
 *  grant/ACL DENIED. Treating them alike would silently strip a routed agent
 *  on every relock — the exact bug class this resolver exists to prevent. */
type BrokerGetResult = { kind: string; code?: string };
type BrokerGetFn = (key: string) => Promise<BrokerGetResult>;

/**
 * Does the on-disk compose already route this agent through the proxy? Parses
 * the agent's service block (`  agent-<name>:`) for `SWITCHROOM_LITELLM: "1"`.
 * Targeted string/regex parse (same posture as `AGENT_IMAGE_TAG_RE` above) —
 * cheaper and less brittle here than a full YAML load of a file we generated.
 */
export function agentHadLiteLLMRouting(
  composeContent: string,
  agentName: string,
): boolean {
  const lines = composeContent.split("\n");
  const header = `  agent-${agentName}:`;
  let i = lines.indexOf(header);
  if (i < 0) return false;
  for (i = i + 1; i < lines.length; i++) {
    const line = lines[i];
    // The block ends at the next service (2-space indent, non-space) or any
    // top-level key (0-indent). Env vars live at deeper indent, so they never
    // trip these guards.
    if (/^ {2}\S/.test(line)) break;
    if (/^\S/.test(line)) break;
    if (/^\s+SWITCHROOM_LITELLM:\s*"1"\s*$/.test(line)) return true;
  }
  return false;
}

/**
 * Probe the vault-broker for which opted-in agents already have a LiteLLM
 * virtual key (`litellm/<agent>/api-key`). Used to gate routing-env injection
 * in `generateCompose`: an opted-in agent with no key in the vault gets NO
 * routing env (it would otherwise boot routing through the proxy with no
 * credential — a silently-broken agent). Decouples env from mere config
 * intent and keeps apply / reconcile / docker-fleet paths consistent
 * (provisioning runs before this probe on the apply path; the reconcile path
 * sees whatever was already provisioned).
 *
 * Two failure modes, deliberately NOT treated alike (the product invariant is
 * that ALL model traffic stays proxy-routed for cost/token tracking; a broker
 * blip must never silently downgrade a routed agent to untracked direct OAuth):
 *
 *   - broker ANSWERED with a definitive "no key for you": `not_found`
 *     (UNKNOWN_KEY — the key isn't there) or a genuine grant/ACL `DENIED` →
 *     the agent legitimately has no usable key → leave it unconfirmed →
 *     routing stripped.
 *   - broker CANNOT answer right now: UNREACHABLE / timed out, client import
 *     failed, vault LOCKED (routine during the apply/relock window), or an
 *     INTERNAL broker error → we do NOT know the key status. Silently
 *     stripping here is the bug: writeComposeFile runs on `agent restart` too,
 *     so a container recreated during a broker blip would boot on untracked
 *     direct OAuth. Instead we PRESERVE the agent's prior verdict baked into
 *     the on-disk compose (`previousCompose`) and emit a loud warning naming
 *     the affected agents. If there is no prior compose (first-ever apply) the
 *     agent stays unconfirmed — it was never routed, so that is the safe
 *     default.
 *
 * Best-effort — never throws. `deps.getKey` is injectable for tests; production
 * callers pass none and it dynamic-imports the real broker client.
 */
export async function resolveLiteLLMConfirmedAgents(
  config: SwitchroomConfig,
  previousCompose: string | null,
  deps?: { getKey?: BrokerGetFn },
): Promise<Set<string>> {
  const confirmed = new Set<string>();
  // Determine opted-in agents (effective enabled = agent ?? top-level ?? false).
  const topEnabled =
    (config as { litellm?: { enabled?: boolean } }).litellm?.enabled ?? false;
  const optedIn: string[] = [];
  for (const name of Object.keys(config.agents ?? {})) {
    const agent = config.agents[name];
    if (!agent) continue;
    const resolved = resolveAgentConfig(config.defaults, config.profiles, agent);
    const enabled = resolved.litellm?.enabled ?? topEnabled;
    if (enabled) optedIn.push(name);
  }
  if (optedIn.length === 0) return confirmed;

  // Resolve the broker getter (injected for tests, else the real client). A
  // failed import means the broker layer is unavailable ⇒ EVERY opted-in agent
  // is "unreachable" (never silently strip the whole fleet — the outer-catch bug).
  let getKey: BrokerGetFn | null = deps?.getKey ?? null;
  if (!getKey) {
    try {
      ({ getViaBrokerStructured: getKey } = await import("../vault/broker/client.js"));
    } catch {
      getKey = null;
    }
  }

  const unreachableAgents: string[] = [];
  for (const name of optedIn) {
    if (!getKey) {
      unreachableAgents.push(name);
      continue;
    }
    try {
      const r = await getKey(`litellm/${name}/api-key`);
      if (r.kind === "ok") {
        confirmed.add(name);
      } else if (r.kind === "unreachable") {
        unreachableAgents.push(name);
      } else if (r.kind === "denied" && r.code !== "DENIED") {
        // The client collapses LOCKED / DENIED / BAD_REQUEST / INTERNAL into
        // kind "denied". Only a genuine grant/ACL DENIED is a definitive "no
        // key for you". LOCKED (the vault relocks routinely during apply) and
        // INTERNAL are transient broker states — and BAD_REQUEST / an absent
        // code means WE (or a protocol skew) are at fault, not the key. All of
        // those mean "status unknown" ⇒ preserve, never silently strip.
        unreachableAgents.push(name);
      }
      // not_found (UNKNOWN_KEY) / denied with code DENIED ⇒ broker answered
      // definitively "no usable key" ⇒ legitimate strip (leave unconfirmed).
    } catch {
      // An unexpected throw from the client is broker-layer trouble, not a
      // "no key" answer — treat it as unreachable (preserve, don't strip).
      unreachableAgents.push(name);
    }
  }

  if (unreachableAgents.length > 0) {
    const preserved: string[] = [];
    const couldNotPreserve: string[] = [];
    for (const name of unreachableAgents) {
      if (previousCompose && agentHadLiteLLMRouting(previousCompose, name)) {
        confirmed.add(name);
        preserved.push(name);
      } else {
        couldNotPreserve.push(name);
      }
    }
    // LOUD warning — naming every affected agent — so a broker blip during an
    // apply/restart is visible in the operator's console, not silent. This
    // INTENTIONALLY repeats on every writeComposeFile invocation while the
    // broker stays unavailable (apply and each agent restart): each run is a
    // separate operator-visible operation whose routing verdict was degraded,
    // and deduping across process invocations would need on-disk state for no
    // real gain.
    console.warn(
      `switchroom: vault-broker unreachable or unable to answer (locked/internal) ` +
      `while resolving LiteLLM key status for ` +
      `${unreachableAgents.length} opted-in agent(s): ${unreachableAgents.join(", ")}. ` +
      `Refusing to silently strip proxy routing (that would boot them on untracked ` +
      `direct OAuth). Re-run \`switchroom apply\` once the broker is back to reconcile.`,
    );
    if (preserved.length > 0) {
      console.warn(
        `switchroom: PRESERVED existing proxy routing from the on-disk compose for: ` +
        `${preserved.join(", ")}.`,
      );
    }
    if (couldNotPreserve.length > 0) {
      console.warn(
        `switchroom: no prior routing verdict on disk for: ${couldNotPreserve.join(", ")} ` +
        `— leaving them unrouted (they were not previously routed).`,
      );
    }
  }
  return confirmed;
}

export interface WriteComposeOpts {
  config: SwitchroomConfig;
  composePath: string;
  /** Bind-mounted switchroom.yaml path baked into broker/kernel/scheduler. */
  switchroomConfigPath: string | undefined;
  /** CLI `--pin`/`--channel` override (apply/update). Restart passes none → uses config.release. */
  releaseOverride?: ReleaseBlockShape | undefined;
  buildMode?: "pull" | "local";
  buildContext?: string | undefined;
}

export interface WriteComposeResult {
  composePath: string;
  imageTag: string;
  bytes: number;
  /** True when the new content differs from what was on disk. */
  changed: boolean;
  /** The agent image tag previously on disk (for drift logging), or null. */
  previousImageTag: string | null;
}

const AGENT_IMAGE_TAG_RE = /image:\s*\S*switchroom-agent:(\S+)/;

/** Container path prefix that the CLI uses for bind-mounted config. */
const CONTAINER_CONFIG_PREFIX = "/state/config/";

/**
 * Translate a raw switchroom.yaml path to a HOST-filesystem path suitable
 * for use as a Docker bind-mount source.
 *
 * Problem: when `switchroom apply` (or `agent restart`) runs inside an agent
 * container, `findConfigFile()` returns `SWITCHROOM_CONFIG` which is the
 * CONTAINER path `/state/config/switchroom.yaml`. Emitting that path verbatim
 * as a bind-mount source causes Docker to auto-create an empty directory at
 * that path on the host. The vault-broker then tries to read it as a file
 * and crashes with EISDIR (2026-06-11 rollback-to-v0.15.3 incident).
 *
 * Fix: when running inside a Docker container AND the config path starts with
 * `/state/config/`, translate it to the host path using the `SWITCHROOM_HOST_HOME`
 * env var that `compose.ts` bakes into every agent container at apply time.
 * The mapping is: `/state/config/<file>` → `<SWITCHROOM_HOST_HOME>/.switchroom/<file>`.
 *
 * If we are in a container context but `SWITCHROOM_HOST_HOME` is not set (e.g.
 * the fleet was generated by a pre-fix version of switchroom), we refuse to
 * proceed rather than emit a broken compose file. The operator can resolve this
 * by running `switchroom apply` once from the HOST (which writes the new env var
 * into the compose, which then makes in-container apply safe).
 *
 * On non-container hosts the path is returned unchanged.
 */
export function resolveHostSwitchroomConfigPath(rawPath: string): string {
  if (!isDockerRuntime()) {
    // Running on the host — the path is already a valid host path.
    return rawPath;
  }
  if (!rawPath.startsWith(CONTAINER_CONFIG_PREFIX)) {
    // Not a container-config path (e.g. operator passed --config /some/host/path
    // explicitly via a bind mount). Trust it — the operator knows what they're doing.
    return rawPath;
  }
  const hostHome = process.env.SWITCHROOM_HOST_HOME;
  if (!hostHome || hostHome.length === 0) {
    throw new Error(
      `switchroom apply: running inside a container but SWITCHROOM_HOST_HOME is not set.\n` +
      `The config path "${rawPath}" is a container-internal path — emitting it as a ` +
      `Docker bind-mount source would cause Docker to create an empty directory at that ` +
      `path on the host, crashing the vault-broker and auth-broker with EISDIR.\n\n` +
      `Recovery: run \`switchroom apply\` once from the HOST (not from inside the container). ` +
      `That will regenerate the compose file with SWITCHROOM_HOST_HOME set, after which ` +
      `in-container apply will work correctly.`,
    );
  }
  // `/state/config/switchroom.yaml` → `<hostHome>/.switchroom/switchroom.yaml`
  const filename = basename(rawPath);
  return join(hostHome, ".switchroom", filename);
}

/**
 * The single, fail-closed resolver for the HOST home that the compose generator
 * (and the mount-source seeder) bake into every bind-mount source. This is the
 * by-construction fix for the 2026-06-23 outage: NEVER silently derive the host
 * home from the container's ambient HOME.
 *
 *   1. SWITCHROOM_HOST_HOME set + non-empty → validate it (assertPlausibleHostHome)
 *      and use it. The blessed path (host shell, hostd) sets this.
 *   2. else, inside a container → THROW (do not fall back to homedir(), which is
 *      the container HOME like /state/agent/home — the poison).
 *   3. else (host shell) → homedir().
 *
 * Replaces the old `process.env.SWITCHROOM_HOST_HOME || homedir()` at the
 * write-compose call site AND the bare homedir() the apply mount-source seeder
 * used — so both vectors fail loud instead of poisoning the fleet.
 */
export function resolveHostHomeForCompose(): string {
  const envHome = process.env.SWITCHROOM_HOST_HOME;
  if (envHome && envHome.trim().length > 0) {
    assertPlausibleHostHome(envHome); // reject an explicitly-wrong value too
    return envHome;
  }
  if (isContainerContext()) {
    throw new Error(
      `switchroom: refusing to deploy — running inside a container but SWITCHROOM_HOST_HOME ` +
      `is not set. Deriving the HOST home from the container's HOME would bake container ` +
      `paths (e.g. /state/agent/home) as bind-mount sources, and Docker would auto-create ` +
      `empty dirs on the host — crashing the whole fleet (the 2026-06-23 outage).\n\n` +
      `Recovery: run \`switchroom apply\`/\`update\` from the HOST shell, or via hostd ` +
      `(both set SWITCHROOM_HOST_HOME). Do NOT deploy via an ad-hoc ` +
      `\`docker run <agent-image> switchroom …\` that mounts the operator home.`,
    );
  }
  return homedir();
}

export interface ComputeComposeResult {
  /** The generated compose YAML content (not yet written to disk). */
  content: string;
  /** The agent image tag baked into `content`. */
  imageTag: string;
  /** Content currently on disk at `composePath`, or null if none. */
  previous: string | null;
  /** The agent image tag previously on disk (for drift logging), or null. */
  previousImageTag: string | null;
  /**
   * Set when this generation DROPS an already-emitted `voice-sidecar` because
   * the voice verdict was defaulted rather than read. Null on every other
   * path — including a genuine `cloud` verdict, a fresh install with no
   * previous compose, and any run that keeps the service.
   */
  voiceSidecarDrop: VoiceSidecarDrop | null;
}

/** Why an already-emitted `voice-sidecar` is about to disappear. */
export interface VoiceSidecarDrop {
  reason: VoiceEngineReason;
  /** The verdict path that was attempted. */
  path: string;
  /** One-line explanation from the read; empty for `no-verdict`. */
  detail: string;
  /** Operator-facing one-liner, identical on every surface. */
  message: string;
}

/** Parse the top-level service names out of a generated compose YAML. */
export function parseComposeServiceNames(compose: string): string[] {
  const lines = compose.split("\n");
  const names: string[] = [];
  let inServices = false;
  for (const line of lines) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    // A new top-level key (column 0, non-space) ends the services block.
    if (inServices && /^\S/.test(line)) break;
    if (!inServices) continue;
    // Service entries are keyed at exactly two-space indent: `  <name>:`.
    const m = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

/**
 * Build the operator-facing line for a defaulted voice verdict that costs a
 * running service. Exported so the dry-run report and the write path render
 * byte-identical text.
 */
export function voiceSidecarDropMessage(r: VoiceEngineResolution): string {
  const why = r.reason === "no-verdict"
    ? `no verdict file at ${r.path}`
    : `the verdict at ${r.path} is ${r.reason} — ${r.detail}`;
  return (
    `voice-sidecar is being REMOVED because ${why}, so the voice engine ` +
    "defaulted to `cloud`. This host is not known to lack a GPU — switchroom " +
    "could not tell. Re-run `switchroom setup` to re-probe before applying, or " +
    "confirm the removal is intended."
  );
}

/**
 * Decide whether this generation silently drops a running `voice-sidecar`.
 *
 * Only fires when ALL of: a previous compose exists and declared the service,
 * the new content does not, and the engine was DEFAULTED rather than read from
 * a verdict. A genuine `cloud` verdict is a deliberate operator state and stays
 * quiet; a fresh install has no previous compose and stays quiet too.
 */
export function detectVoiceSidecarDrop(
  previous: string | null,
  content: string,
  resolution: VoiceEngineResolution,
): VoiceSidecarDrop | null {
  if (!isDefaultedVoiceEngine(resolution)) return null;
  if (previous === null) return null;
  if (!parseComposeServiceNames(previous).includes(VOICE_SIDECAR_SERVICE)) return null;
  if (parseComposeServiceNames(content).includes(VOICE_SIDECAR_SERVICE)) return null;
  return {
    reason: resolution.reason,
    path: resolution.path,
    detail: resolution.detail,
    message: voiceSidecarDropMessage(resolution),
  };
}

/**
 * Generate the compose content IN MEMORY and read the current on-disk
 * compose for comparison — WITHOUT writing anything. Shared by
 * {@link writeComposeFile} (which then persists) and the `apply --dry-run`
 * path (which only reports the would-be diff). Extracting this keeps the
 * two paths byte-identical: a dry-run computes exactly the content a real
 * apply would write.
 */
export async function computeComposeContent(
  opts: Omit<WriteComposeOpts, "buildMode" | "buildContext"> &
    Pick<WriteComposeOpts, "buildMode" | "buildContext">,
): Promise<ComputeComposeResult> {
  const release = resolveRelease({ override: opts.releaseOverride, root: opts.config.release });
  const imageTag = resolveImageTag(release);
  const operatorUid = resolveOperatorUid();

  // Translate container-internal config paths to host paths before baking
  // them into the compose file's bind-mount sources. Without this, running
  // `switchroom apply` from inside a container emits the container path
  // `/state/config/switchroom.yaml` as the bind-mount SOURCE, causing Docker
  // to auto-create that path as an empty directory on the host and crashing
  // the vault-broker / auth-broker with EISDIR. See resolveHostSwitchroomConfigPath.
  const resolvedConfigPath = opts.switchroomConfigPath !== undefined
    ? resolveHostSwitchroomConfigPath(opts.switchroomConfigPath)
    : undefined;

  // Read the compose currently on disk BEFORE resolving key status: the
  // LiteLLM resolver needs it to preserve an agent's prior routing verdict
  // when the broker is unreachable (never silently strip on a broker blip).
  let previous: string | null = null;
  try {
    previous = await readFile(opts.composePath, "utf8");
  } catch {
    previous = null;
  }

  // Which opted-in agents have a LiteLLM key in the vault — gates routing-env
  // injection so a key-less agent never boots a dead proxy route (#litellm).
  const litellmConfirmedAgents = await resolveLiteLLMConfirmedAgents(opts.config, previous);

  // Resolve the voice verdict ONCE here and inject it, rather than letting
  // generateCompose read it again: the drop attribution below must describe
  // the verdict the emitted compose was actually built from, not a second read
  // that could disagree with it.
  const voiceResolution = resolveVoiceEngine();

  const content = generateCompose({
    config: opts.config,
    imageTag,
    litellmConfirmedAgents,
    voiceEngine: voiceResolution.engine,
    buildMode: opts.buildMode ?? "pull",
    buildContext: opts.buildContext,
    // Bake the operator's HOST HOME absolute path into volume sources (avoids
    // `${HOME}` resolving to /root under sudo). Fail-closed resolver: uses
    // SWITCHROOM_HOST_HOME (validated), THROWS inside a container when it's
    // unset (never falls back to the container HOME — the 2026-06-23 poison),
    // and uses homedir() only on a real host shell.
    homeDir: resolveHostHomeForCompose(),
    // Home for FILESYSTEM probes (existsSync/mkdirSync gating optional mounts).
    // Unlike homeDir, this is the CONTAINER-REAL home — `homedir()` is
    // `/host-home` inside hostd (where the operator's dirs are bind-mounted)
    // and `/home/op` on the host. Probing homeDir (the baked host path) inside
    // hostd finds nothing and drops every conditional mount (the 2026-06-15
    // marko meta_pages outage). On the host the two are identical.
    probeHomeDir: homedir(),
    switchroomConfigPath: resolvedConfigPath,
    // Captured for the broker's host-shell operator socket chown.
    operatorUid,
    // #3648: resolve the host docker socket path LIVE at this imperative
    // apply seam (running on the host, where `docker context inspect` is
    // meaningful) and inject it, so a `root: true` agent binds the real
    // rootless/relocated socket. Keeps generateCompose pure/hermetic.
    dockerSocketPath: resolveDockerSocketPath(),
  });

  const previousImageTag = previous ? (AGENT_IMAGE_TAG_RE.exec(previous)?.[1] ?? null) : null;

  // A defaulted verdict that costs a RUNNING service is the one place the
  // reader's deliberate silence on `absent` is wrong. Warn once per process,
  // on every caller of this seam (real apply, dry-run, `agent restart`'s
  // reconcile, doctor drift) — and return it so callers can render it in
  // their own report format instead of scraping stderr.
  const voiceSidecarDrop = detectVoiceSidecarDrop(previous, content, voiceResolution);
  if (voiceSidecarDrop && !_warnedVoiceDrop) {
    _warnedVoiceDrop = true;
    process.stderr.write(`[switchroom] WARNING: ${voiceSidecarDrop.message}\n`);
  }

  return { content, imageTag, previous, previousImageTag, voiceSidecarDrop };
}

/** One-time guard for the voice-sidecar drop warning (mirrors the
 *  host-capabilities reader's own once-per-process memo). */
let _warnedVoiceDrop = false;

/** Test seam: reset the one-time drop warning. */
export function _resetVoiceSidecarDropWarning(): void {
  _warnedVoiceDrop = false;
}

/** Suffix of the compose backup file. */
export const BACKUP_SUFFIX = ".bak";

/** Absolute path of the compose backup for a given compose path. */
export function composeBackupPath(composePath: string): string {
  return composePath + BACKUP_SUFFIX;
}

/** Extract the agent image tag from compose text (null when absent). */
export function composeImageTag(content: string | null): string | null {
  if (!content) return null;
  return AGENT_IMAGE_TAG_RE.exec(content)?.[1] ?? null;
}

/** Read the agent image tag currently recorded in the backup, or null. */
async function readBackupImageTag(composePath: string): Promise<string | null> {
  try {
    return composeImageTag(await readFile(composeBackupPath(composePath), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Should this compose write refresh `<composePath>.bak`?
 *
 * ## Why this is not "always"
 *
 * The old rule was "copy the previous file every time", which produced a
 * backup with ZERO recovery value:
 *
 *   - `writeComposeFile` runs on EVERY `agent restart`, not just `apply`
 *     (`src/cli/agent.ts` — the restart reconcile regenerates the WHOLE-fleet
 *     compose). A staggered roll restarts agents one at a time, so the FIRST
 *     agent's restart backed up the pre-roll compose and the SECOND agent's
 *     restart immediately overwrote that backup with the new (post-bump)
 *     file. By agent 3 of 12 the "backup" was byte-identical to the live
 *     compose — verified on the production host: `cmp docker-compose.yml
 *     docker-compose.yml.bak` matched, same size, same mtime.
 *   - Which is why the operator ended up hand-rolling 27 `docker-compose.yml
 *     .bak-*` files: the built-in backup never held anything they could go
 *     back to.
 *
 * ## The rule
 *
 * `.bak` is defined as *the last compose generated on a different agent image
 * tag than the current one* — i.e. the pre-version-bump compose, which is the
 * only thing worth rolling back to when a roll produces a bad compose.
 *
 * 1. No previous file (first-ever write) → nothing to back up.
 * 2. Previous === next (a no-op regeneration, e.g. agents 2..N of a roll all
 *    rewriting the same already-bumped whole-fleet compose) → keep the older
 *    backup. This alone kills the mid-roll clobber.
 * 3. Previous is ALREADY on the tag we're about to write, and a backup
 *    already exists → the version bump happened on an earlier write; keep
 *    that pre-bump backup rather than replacing it with a same-version one.
 * 4. Otherwise (the tag is genuinely changing, or there is no backup yet) →
 *    take the backup.
 *
 * ## What `.bak` is NOT
 *
 * It is **"the last compose on a different agent image tag"**, which is not
 * the same claim as **"a compose known to work"**. Nothing here health-checks
 * the previous file. Two cases where the distinction bites:
 *
 *   - roll v1 → v2 fails, leaving `.bak` = v1 (good). A second roll v2 → v3
 *     then backs up the v2 compose, so `.bak` now holds the compose of the
 *     build that just failed. The pre-bump copy from the FIRST roll is gone.
 *   - an operator hand-edits a broken compose and applies; the tag moved, so
 *     the broken file becomes the backup on the next bump.
 *
 * This is why {@link restoreComposeBackup} is a best-effort FALLBACK behind
 * `apply --pin <priorPin>` (which regenerates from config and is authoritative)
 * rather than a primary rollback, and why it refuses a backup whose service
 * set no longer matches the fleet. Making `.bak` mean "known good" needs a
 * post-roll health signal to gate the backup on — a separate change, filed
 * rather than half-implemented here.
 *
 * Pure + exported so the clobber case is asserted in tests without docker.
 */
export function shouldBackupCompose(
  previous: string | null,
  next: string,
  existingBackupTag: string | null,
): boolean {
  if (previous === null) return false; // (1)
  if (previous === next) return false; // (2)
  const prevTag = composeImageTag(previous);
  const nextTag = composeImageTag(next);
  // (3) — only skip when we actually HAVE a backup to protect and the tag
  // isn't moving; otherwise a tag-neutral edit on a fresh host would never
  // create a backup at all.
  if (existingBackupTag !== null && prevTag !== null && prevTag === nextTag) return false;
  return true; // (4)
}

/**
 * Top-level service names declared in compose text, in file order.
 *
 * Deliberately a shallow scan rather than a YAML parse: this runs on recovery
 * paths where a partially-corrupt file must degrade to "no services found"
 * (→ refuse the restore) instead of throwing. Service keys are emitted by the
 * generator at exactly one indent level under `services:`.
 */
export function composeServiceNames(content: string): string[] {
  const names: string[] = [];
  let inServices = false;
  let indent: number | null = null;
  for (const raw of content.split("\n")) {
    if (/^\s*(#|$)/.test(raw)) continue;
    const lead = raw.length - raw.trimStart().length;
    if (!inServices) {
      if (/^services:\s*$/.test(raw)) inServices = true;
      continue;
    }
    if (lead === 0) break; // left the services block
    if (indent === null) indent = lead;
    if (lead !== indent) continue; // nested key, not a service
    const m = /^([A-Za-z0-9_.-]+):\s*$/.exec(raw.trim());
    if (m) names.push(m[1]!);
  }
  return names;
}

/** Outcome of a {@link restoreComposeBackup} attempt. */
export interface ComposeRestoreResult {
  restored: boolean;
  /** The agent image tag the restored compose carries (when restored). */
  imageTag?: string | null;
  /** Why the restore did not happen / failed. */
  reason?: string;
}

/**
 * Restore `<composePath>.bak` over `<composePath>`.
 *
 * This is the consumer the backup existed for. Before this, the write-side
 * comment claimed "the health-gated recreate (src/cli/update.ts) can roll
 * back to" the `.bak` — but no such rollback existed anywhere in
 * `src/cli/update.ts` (`grep -n '\.bak\|rollback\|revert'` → nothing). The
 * comment described a mechanism that was never built; this function is that
 * mechanism.
 *
 * ## Coherence gate
 *
 * A backup is only "last known good" for the fleet it was generated FOR. It
 * can be arbitrarily old (rule 3 in {@link shouldBackupCompose} deliberately
 * preserves the pre-bump copy across many writes), so the config may have
 * gained or lost agents since. Restoring it then would silently remove a live
 * agent's service — a far worse outcome than the bad compose it's replacing.
 *
 * So the restore refuses when the backup's service set differs from the
 * service set in the compose currently on disk (which the last write generated
 * from the live config). `opts.expectedServices` overrides that source when
 * the caller has the config's own view.
 *
 * **The gate cannot disable itself.** An earlier draft only ran the comparison
 * `if (expected && expected.length > 0)`, i.e. it silently skipped the check
 * whenever the live compose was missing, empty, or too corrupt to yield a
 * service name — which is precisely the "`apply --pin` failed and left a broken
 * compose" state the only caller invokes this from. The gate switched itself
 * off exactly when it mattered and restored blind. An indeterminate expectation
 * is now a REFUSAL: without a service set to compare against there is no way to
 * know the backup still describes this fleet, and `switchroom apply` host-side
 * is a strictly better recovery than a blind overwrite.
 *
 * There is deliberately no `force` bypass: this function has one caller
 * (hostd's failed-auto-roll recovery), which is unattended, so a bypass would
 * be dead code — and the operator's override already exists and is better
 * (`switchroom apply`, or copying the `.bak` by hand after reading the diff).
 *
 * Uses the same tmp+rename swap as the forward write so a crash mid-restore
 * can't leave a truncated compose. Never throws — callers are recovery paths
 * where a throw is worse than a reported failure.
 */
export async function restoreComposeBackup(
  composePath: string,
  opts: { expectedServices?: string[] } = {},
): Promise<ComposeRestoreResult> {
  const bak = composeBackupPath(composePath);
  let content: string;
  try {
    content = await readFile(bak, "utf8");
  } catch (e) {
    return { restored: false, reason: `no usable compose backup at ${bak} (${(e as Error).message})` };
  }
  if (content.trim() === "") {
    return { restored: false, reason: `compose backup at ${bak} is empty` };
  }

  let expected = opts.expectedServices;
  let expectationSource = "the caller's expected service set";
  if (!expected) {
    expectationSource = `the compose currently at ${composePath}`;
    try {
      expected = composeServiceNames(await readFile(composePath, "utf8"));
    } catch (e) {
      return {
        restored: false,
        reason:
          `cannot verify the compose backup at ${bak}: ${composePath} is ` +
          `unreadable (${(e as Error).message}), so there is no service set to ` +
          `check it against. Refusing to restore — a backup can predate a ` +
          `config change and would then drop or resurrect services. Run ` +
          `\`switchroom apply\` host-side against the intended release.`,
      };
    }
  }
  if (expected.length === 0) {
    return {
      restored: false,
      reason:
        `cannot verify the compose backup at ${bak}: ${expectationSource} ` +
        `declares no services (empty, truncated, or unparseable), so there is ` +
        `no service set to check it against. Refusing to restore — a backup ` +
        `can predate a config change and would then drop or resurrect ` +
        `services. Run \`switchroom apply\` host-side against the intended ` +
        `release.`,
    };
  }
  {
    const have = composeServiceNames(content);
    const missing = expected.filter((s) => !have.includes(s));
    const extra = have.filter((s) => !expected.includes(s));
    if (missing.length > 0 || extra.length > 0) {
      return {
        restored: false,
        reason:
          `compose backup at ${bak} does not match the current fleet ` +
          `(missing: ${missing.join(", ") || "none"}; ` +
          `unknown: ${extra.join(", ") || "none"}). Refusing to restore — it ` +
          `predates a config change and would drop or resurrect services. ` +
          `Re-run \`switchroom apply\` against the intended release instead.`,
      };
    }
  }

  try {
    const tmpPath = composePath + ".restore.tmp";
    await writeFile(tmpPath, content, { encoding: "utf8", mode: 0o600 });
    await rename(tmpPath, composePath);
  } catch (e) {
    return { restored: false, reason: `restore write failed: ${(e as Error).message}` };
  }
  const operatorUid = resolveOperatorUid();
  if (operatorUid !== undefined && process.geteuid?.() === 0) {
    try {
      chownSync(composePath, operatorUid, operatorUid);
    } catch {
      /* best-effort — matches the forward write's tolerance */
    }
  }
  return { restored: true, imageTag: composeImageTag(content) };
}

/** Generate the compose content and write it (mode 0600). Always writes — same as apply. */
export async function writeComposeFile(opts: WriteComposeOpts): Promise<WriteComposeResult> {
  const { content, imageTag, previous, previousImageTag } = await computeComposeContent(opts);
  const operatorUid = resolveOperatorUid();

  await mkdir(dirname(opts.composePath), { recursive: true });
  // Pre-version backup + atomic write. `<composePath>.bak` holds the last
  // compose generated on a DIFFERENT agent image tag than the one being
  // written — see {@link shouldBackupCompose} for why the previous
  // "always copy" rule made the backup worthless. NOTE it means exactly
  // "last compose on a different tag", NOT "known good" — see the caveats on
  // {@link shouldBackupCompose}. Restored by {@link restoreComposeBackup}
  // (hostd's failed-auto-roll recovery falls back to it, service-set gated,
  // only when regenerating compose on the prior pin fails).
  // tmp+rename makes the swap atomic so a crash mid-write never leaves a
  // truncated compose.
  if (shouldBackupCompose(previous, content, await readBackupImageTag(opts.composePath))) {
    try {
      await copyFile(opts.composePath, composeBackupPath(opts.composePath));
    } catch {
      /* best-effort backup — never block the write */
    }
  }
  const tmpPath = opts.composePath + ".tmp";
  await writeFile(tmpPath, content, { encoding: "utf8", mode: 0o600 });
  await rename(tmpPath, opts.composePath);

  // Keep the compose operator-owned when written under sudo. `apply` also
  // does this via its whole-tree restoreOperatorOwnership sweep, but the
  // `agent restart` path doesn't run that sweep — without this, a root-mode
  // restart would leave the compose root-owned and lock the operator out of
  // non-sudo `docker compose` reads. Best-effort (dev/no CAP_CHOWN/raced).
  if (operatorUid !== undefined && process.geteuid?.() === 0) {
    try {
      chownSync(opts.composePath, operatorUid, operatorUid);
    } catch {
      /* best-effort — matches restoreOperatorOwnership's per-path tolerance */
    }
  }

  return {
    composePath: opts.composePath,
    imageTag,
    bytes: Buffer.byteLength(content, "utf8"),
    changed: previous !== content,
    previousImageTag,
  };
}
