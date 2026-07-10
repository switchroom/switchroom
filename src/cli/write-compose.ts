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
import { isContainerContext } from "./agent-config.js";
import { resolveImageTag, resolveRelease, type ReleaseBlockShape } from "../config/release-resolve.js";
import { isDockerRuntime } from "../runtime-mode.js";
import { resolveOperatorUid } from "./operator-uid.js";
import { resolveAgentConfig } from "../config/merge.js";

/** Minimal structural view of a broker structured-get result (see
 *  src/vault/broker/client.ts `getViaBrokerStructured`). We only branch on
 *  `kind` here, so a `{ kind }`-only shape keeps this decoupled + testable. */
type BrokerGetResult = { kind: string };
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
 *   - key genuinely NOT FOUND (broker answered `not_found`/`denied`) → the
 *     agent legitimately has no key → leave it unconfirmed → routing stripped.
 *   - broker UNREACHABLE / timed out (or the client import failed) → we do NOT
 *     know the key status. Silently stripping here is the bug: writeComposeFile
 *     runs on `agent restart` too, so a container recreated during a broker
 *     blip would boot on untracked direct OAuth. Instead we PRESERVE the
 *     agent's prior verdict baked into the on-disk compose (`previousCompose`)
 *     and emit a loud warning naming the affected agents. If there is no prior
 *     compose (first-ever apply) the agent stays unconfirmed — it was never
 *     routed, so that is the safe default.
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
      }
      // not_found / denied ⇒ broker answered "no key" ⇒ legitimate strip
      // (leave out of the confirmed set).
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
    // apply/restart is visible in the operator's console, not silent.
    console.warn(
      `switchroom: vault-broker unreachable while resolving LiteLLM key status for ` +
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

  const content = generateCompose({
    config: opts.config,
    imageTag,
    litellmConfirmedAgents,
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
  });

  const previousImageTag = previous ? (AGENT_IMAGE_TAG_RE.exec(previous)?.[1] ?? null) : null;

  return { content, imageTag, previous, previousImageTag };
}

/** Generate the compose content and write it (mode 0600). Always writes — same as apply. */
export async function writeComposeFile(opts: WriteComposeOpts): Promise<WriteComposeResult> {
  const { content, imageTag, previous, previousImageTag } = await computeComposeContent(opts);
  const operatorUid = resolveOperatorUid();

  await mkdir(dirname(opts.composePath), { recursive: true });
  // Last-known-good backup + atomic write. If a deploy regenerates a bad
  // compose, `<composePath>.bak` is the prior file the health-gated recreate
  // (src/cli/update.ts) can roll back to. tmp+rename makes the swap atomic so a
  // crash mid-write never leaves a truncated compose. Backup only when the
  // prior content actually parsed as a real file (skip first-ever-write).
  if (previous !== null) {
    try {
      await copyFile(opts.composePath, opts.composePath + ".bak");
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
