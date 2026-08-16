/**
 * `switchroom apply` — reconcile fleet to switchroom.yaml.
 *
 * Two responsibilities:
 *   1. Scaffold every agent declared in switchroom.yaml (creating the
 *      per-agent workspace under `agents_dir` if missing, refreshing
 *      bootstrap files if present).
 *   2. Generate `~/.switchroom/compose/docker-compose.yml` so the
 *      operator can bring the fleet up with `docker compose up -d`.
 *
 * `apply` does NOT shell out to docker. It deliberately stops at the
 * compose-file artifact so the operator owns the docker invocation
 * (daemon socket, rootless mode, sudo policy, etc.).
 *
 * The systemd path lives behind `switchroom agent` lifecycle verbs
 * (and their `--legacy` flags). `apply` is the docker-first verb.
 */
import { Option, type Command } from "commander";
import chalk from "chalk";
import { accessSync, chmodSync, chownSync, constants as fsConstants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { writeConfigFileSync } from "../util/atomic.js";
import { describeKeyBudget, resolveKeyBudget } from "../litellm/budget.js";
import { mkdir } from "node:fs/promises";
import { spawnSync as childSpawnSync } from "node:child_process";
import readline from "node:readline";
// Example configs are EMBEDDED in the binary (text imports), never read from
// disk: `import.meta.dirname` is the bunfs virtual root under `bun build
// --compile`, so a disk read resolves to `/examples/…` and ENOENTs. The module
// is shared with `switchroom setup`, which had the identical bug (#4163).
import { exampleNames, readEmbeddedExample } from "./embedded-examples.js";
import {
  reloadAuthBroker,
  reloadVaultBroker,
  brokerReloadHint,
  AUTH_BROKER_CONTAINER,
  VAULT_BROKER_CONTAINER,
  type BrokerReloadResult,
} from "./broker-reload.js";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { isVaultReference, parseVaultReference } from "../vault/resolver.js";
import { resolveAgentConfig } from "../config/merge.js";
import {
  migrateVaultLayout,
  inspectVaultLayout,
  formatDivergentRecoveryMessage,
  type MigrationResult,
} from "../vault/migrate-layout.js";
import {
  KNOWN_VAULT_ARTIFACT_NAMES,
  KNOWN_VAULT_ARTIFACT_PATTERNS,
} from "../vault/vault.js";
import { resolvePath } from "../config/loader.js";
import {
  loadConfig,
  resolveAgentsDir,
  findConfigFile,
  ConfigError,
} from "../config/loader.js";
import { scaffoldAgent, alignAgentUid, renderFleetInvariants, toHostHomePath, flushPendingBankOps } from "../agents/scaffold.js";
import { bootstrapBundledSkillsPool } from "./bootstrap-skills-pool.js";
import {
  getGrantsDbDir,
  getGrantsDbPath,
  migrateLegacyGrantsDbLocation,
} from "../vault/grants-db-path.js";
import { renderFleetDefaultsClaudeMd } from "../agents/fleet-defaults.js";
import { refreshAgentConnectionHealth } from "../agents/connection-health.js";
import type { VaultAclResult } from "./doctor-mcp-secrets.js";
import { installUpdatePromptHook } from "./update-prompt-hook.js";
import { resolveSelfInvocation, type SelfInvokeProbe } from "./self-invoke.js";
import { allocateAgentUid } from "../agents/compose.js";
import {
  ensureAgentScratchDirs,
  resolveScratchConfig,
} from "../agents/scratch.js";
import { LITELLM_MASTER_KEY_STATE_BASENAME } from "../litellm/external-spend.js";
import { writeComposeFile, computeComposeContent, parseComposeServiceNames, resolveHostSwitchroomConfigPath, resolveHostHomeForCompose } from "./write-compose.js";
import { getProfilePath } from "../agents/profiles.js";
import { detectInstallType } from "./install-detect.js";
import {
  resolveOperatorUid,
  restoreOperatorOwnership,
} from "./operator-uid.js";
import type { SwitchroomConfig } from "../config/schema.js";
import { captureEvent, captureException } from "../analytics/posthog.js";

/** Stable on-disk path for the generated compose file. */
export const DEFAULT_COMPOSE_PATH = join(
  homedir(),
  ".switchroom",
  "compose",
  "docker-compose.yml",
);

/** Compose project name. Stable across regenerations so
 *  `docker compose -p switchroom ...` consistently targets the same fleet. */
export const COMPOSE_PROJECT = "switchroom";

export interface ApplyOptions {
  buildLocal?: boolean;
  buildContext?: string;
  /**
   * One-shot release-block override for this apply run. When set, this
   * REPLACES the resolved per-agent / root `release` block from the
   * cascade — used by `--channel <c>` / `--pin <p>` CLI flags and by
   * `switchroom update` to pass through its own flag values. Mutually
   * exclusive channel/pin enforced upstream by ReleaseBlock's Zod
   * refinement; this struct mirrors that shape.
   */
  releaseOverride?: { channel?: "dev" | "rc" | "latest"; pin?: string };
  /** Override compose output path (defaults to {@link DEFAULT_COMPOSE_PATH}). */
  outPath?: string;
  /** Optional example name to copy before applying (e.g. "minimal"). */
  example?: string;
  /**
   * When true, skip any prompts (e.g. the sudo-chown explainer in
   * alignAgentUid) and assume yes. Required for CI / `apply` invoked
   * non-interactively. Default: prompts when stdin is a TTY.
   */
  nonInteractive?: boolean;
  /**
   * When true, treat a chown failure during UID alignment as a soft
   * warning instead of a hard error. Default false: an unaligned state
   * dir will silently break the agent on first boot, so we fail loudly
   * unless the operator opts into the unsafe path.
   */
  allowUnaligned?: boolean;
  /**
   * Restrict apply to a single agent — scaffold + UID-align ONLY this
   * agent's state dir, leaving every other agent untouched. Compose is
   * still regenerated for the full fleet so the singletons (broker,
   * kernel, scheduler) match yaml; we just don't touch the other agents'
   * state dirs.
   *
   * Why: a v0.6 → v0.7 cutover that aligns every agent's UID at once
   * will break every agent that's currently running under systemd —
   * systemd-user is uid 1000; the post-align dirs are owned by per-agent
   * UIDs (10001-10999), which kenthompson can no longer execute or
   * write to. The fleet-wide chown is correct after a clean stop, but
   * during a partial cutover where other agents are still systemd-managed,
   * `--only=<name>` is the safe one-at-a-time path.
   *
   * The migration playbook is: stop systemd <name>, `apply --only=<name>`,
   * compose-up <name>, validate, repeat for next agent.
   */
  only?: string;
  /**
   * Skip the per-agent scaffold loop entirely; only (re)generate the
   * compose file. Useful for CI / scripts that need a fresh compose
   * yaml but cannot chown into per-agent state dirs (mode 0700,
   * owned by per-agent UIDs in v0.7+ docker mode). Without this flag,
   * `apply --non-interactive` from a non-root operator silently fails
   * to write start.sh / .mcp.json / settings.json (issue #902).
   */
  composeOnly?: boolean;
  /**
   * Validate-only: run the full compose-regeneration + validation
   * pipeline IN MEMORY (resolve every agent's profile, probe the
   * vault-broker for key-provisioning gaps, compute the would-be
   * compose) and print a report — WITHOUT writing the compose file,
   * persisting anything, or touching any container. Handled by the
   * dedicated {@link runApplyDryRun} path, not by `runApply`.
   *
   * Exists because `rollout --dry-run` only prints the step plan; it
   * never exercises the config-regeneration that actually fails (the
   * v0.17.0 rollout incident: profile-not-found, vault-broker
   * unreachable, and passphrase-needed-for-new-keys all surfaced only
   * once the real apply mutated state). `apply --dry-run` is the
   * pre-flight that catches those BEFORE anything is mutated.
   */
  dryRun?: boolean;
}

export interface ApplyDeps {
  /** stdout writer; defaults to `process.stdout.write`. */
  writeOut?: (s: string) => void;
  /** stderr writer; defaults to `process.stderr.write`. */
  writeErr?: (s: string) => void;
  /**
   * Test-only seam: override the `docker compose` v2 detection. When
   * unset, the real `detectComposeV2()` is invoked. Tests in
   * environments without docker installed pass `() => null` to bypass
   * the preflight gate so they can exercise the orchestrator's actual
   * scaffold/compose logic.
   */
  detectComposeV2?: () => string | null;
}

export interface ApplyResult {
  scaffolded: number;
  agentsTotal: number;
  composePath: string;
  composeBytes: number;
  /**
   * Per-agent scaffold failures collected during the loop. Empty when
   * everything succeeded or when `composeOnly` skipped the loop. The
   * CLI handler exits non-zero when this is non-empty (issue #902 —
   * before the fix, scaffold failures were printed but apply silently
   * exited 0, leaving CI / non-interactive callers with stale state).
   */
  failures: ScaffoldFailure[];
}

export interface ScaffoldFailure {
  agent: string;
  message: string;
}

/**
 * Resolve the effective `litellm.enabled` for an agent: per-agent cascaded
 * value wins, then the top-level fleet default, else false. Mirrors the
 * resolution baked into `compose.ts` so apply-time provisioning and
 * container-env injection agree on which agents are "on".
 */
function effectiveLiteLLMEnabled(
  config: SwitchroomConfig,
  agentResolvedLitellm: { enabled?: boolean } | undefined,
): boolean {
  return (
    agentResolvedLitellm?.enabled ??
    (config as { litellm?: { enabled?: boolean } }).litellm?.enabled ??
    false
  );
}

/**
 * LiteLLM per-agent virtual-key provisioning (opt-in). Extracted from
 * `runApply` so the gate + error handling stay readable. Best-effort: each
 * agent's failure is pushed to `failures` and the loop continues. Pure
 * no-op for agents that aren't opted in.
 *
 * Idempotency lives here, not in the provision module: we read the vault
 * (via the auto-unlocked broker) for an existing `litellm/<agent>/api-key`
 * and skip provisioning when present.
 */
/**
 * Recover the operator vault passphrase for apply-time writes WITHOUT an
 * interactive prompt. The vault-broker's `put` op refuses to introduce a NEW
 * key on the path-as-identity / operator-socket path (server.ts ~1657/~1692);
 * new-key creation requires operator-passphrase attestation (or a write-grant).
 * So a passphrase-less `putViaBroker` of `litellm/<agent>/api-key` is always
 * denied — provisioning would silently fail.
 *
 * Two non-interactive sources, in order:
 *   1. SWITCHROOM_VAULT_PASSPHRASE env (passphrase-host operators / CI).
 *   2. The auto-unlock blob (~/.switchroom/vault-auto-unlock), decrypted with
 *      a key derived from /etc/machine-id — the SAME mechanism the broker uses
 *      to auto-unlock at boot. This is the path on this host (no passphrase in
 *      the env during apply). `readAutoUnlockFile` throws if the blob is
 *      missing/undecryptable; we swallow and return null.
 *
 * Returns null when neither source yields a passphrase (e.g. an interactive
 * passphrase host with no env var) — the caller then records a clear failure
 * rather than blocking apply on a TTY prompt.
 */
export async function resolveOperatorVaultPassphrase(home: string): Promise<string | null> {
  const envPass = process.env.SWITCHROOM_VAULT_PASSPHRASE;
  if (envPass) return envPass;
  try {
    const { readAutoUnlockFile } = await import("../vault/auto-unlock.js");
    const blobPath = join(home, ".switchroom", "vault-auto-unlock");
    const pass = readAutoUnlockFile(blobPath);
    return pass && pass.length > 0 ? pass : null;
  } catch {
    return null;
  }
}

/**
 * @internal exported for the apply-level e2e (src/litellm/provision-apply-e2e.test.ts).
 */

/**
 * Materialize the LiteLLM master key into the auth-broker state dir so the
 * broker can publish `get-external-spend` without every agent holding the
 * key. File mode 0600; path is never mounted into agent containers.
 * Best-effort: failures are warnings (agents just omit the External block).
 */
export function materializeLitellmMasterKeyForBroker(
  masterKey: string,
  home: string = process.env.HOME ?? "/root",
): { ok: true; path: string } | { ok: false; error: string } {
  try {
    const stateDir = join(home, ".switchroom", "state", "auth-broker");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const path = join(stateDir, LITELLM_MASTER_KEY_STATE_BASENAME);
    writeFileSync(path, masterKey.trim() + "\n", { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      /* best-effort */
    }
    return { ok: true, path };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function provisionLiteLLMKeys(
  config: SwitchroomConfig,
  agentNames: string[],
  switchroomConfigPath: string | undefined,
  ctx: {
    writeOut: (s: string) => void;
    writeErr: (s: string) => void;
    failures: ScaffoldFailure[];
    /** Home dir for the auto-unlock blob lookup (defaults to homedir()). */
    home?: string;
  },
): Promise<void> {
  const { writeOut, failures } = ctx;

  // Resolve which agents are opted in before importing anything heavy.
  const optedIn: { name: string; litellm: NonNullable<ReturnType<typeof resolveAgentConfig>["litellm"]> }[] = [];
  for (const name of agentNames) {
    const agentConfig = config.agents[name];
    if (!agentConfig) continue;
    const resolved = resolveAgentConfig(config.defaults, config.profiles, agentConfig);
    if (effectiveLiteLLMEnabled(config, resolved.litellm)) {
      optedIn.push({ name, litellm: resolved.litellm ?? {} });
    }
  }
  // Also check if we need to provision the hindsight service key.
  const needsHindsight =
    (config as { litellm?: { enabled?: boolean } }).litellm?.enabled === true &&
    (config as { memory?: { backend?: string } }).memory?.backend === "hindsight";
  if (optedIn.length === 0 && !needsHindsight) return; // zero-impact when the feature is off
  let brokerKeyMaterialized = false;

  // Lazy imports — only paid for when at least one agent opts in or hindsight is wired.
  const [
    { getViaBrokerStructured, putViaBroker },
    { ensureTeam, ensureKey, validateKey, bindKeyToTeam, updateKeyModels, updateKeyBudget },
    { addAgentSecret },
  ] =
    await Promise.all([
      import("../vault/broker/client.js"),
      import("../litellm/provision.js"),
      import("./telegram-yaml.js"),
    ]);

  // Operator-passphrase attestation is REQUIRED to write a NEW vault key via
  // the broker (the operator socket has no new-key carve-out). Recover it
  // non-interactively (env, else machine-id auto-unlock blob). If we can't,
  // every provision below will fail the write — surface that loudly up front
  // and bail rather than emitting N confusing per-agent denials.
  const passphrase = await resolveOperatorVaultPassphrase(ctx.home ?? homedir());
  if (passphrase === null) {
    // Vault passphrase is unavailable (no SWITCHROOM_VAULT_PASSPHRASE env and
    // machine-id auto-unlock blob is missing or undecryptable). This blocks
    // writing NEW virtual keys. Agents that were already provisioned on a prior
    // interactive apply still have their keys in the vault — a rollout doesn't
    // need to re-provision them, so those are fine to continue past. But an
    // agent that OPTED IN and has NO vault key yet is silently broken: it will
    // never get its routing env. We must NOT report success for those — the old
    // behaviour of a single warning + blanket return hid genuinely-new agents
    // and let the rollout claim success while skipping them (the fail-open bug).
    //
    // So probe each opted-in agent against the broker (a read; no passphrase
    // needed) and split into "already provisioned" (continue quietly) vs.
    // "new, unprovisioned" (surface as a failure the operator can see). First-
    // time provisioning requires an interactive `switchroom apply` with vault
    // access (operator console or SWITCHROOM_VAULT_PASSPHRASE env). Note: adding
    // /etc/machine-id:ro to the hostd compose fixes the root cause (PR #2679).
    const { getViaBrokerStructured } = await import("../vault/broker/client.js");

    const alreadyProvisioned: string[] = [];
    const unprovisionedNew: string[] = [];
    const brokerUnreachable: string[] = [];
    for (const { name } of optedIn) {
      const vaultKey = `litellm/${name}/api-key`;
      const existing = await getViaBrokerStructured(vaultKey);
      if (existing.kind === "ok") {
        alreadyProvisioned.push(name);
      } else if (existing.kind === "unreachable") {
        // #2781: broker unreachable is an environment limitation (hostd's
        // container has no broker socket by construction) — we can't
        // provision OR confirm, so degrade to a warning rather than fail
        // apply. The agent keeps its previous routing env either way.
        brokerUnreachable.push(name);
      } else {
        // kind === "not_found" (genuinely new) or "denied" — this agent is
        // not known-good and must be surfaced, not silently skipped.
        unprovisionedNew.push(name);
      }
    }
    // The hindsight service key uses the SAME idempotent broker probe as the
    // per-agent keys (getViaBrokerStructured is a read — no passphrase needed),
    // identical to the provisioning path at the bottom of this function
    // (litellm/hindsight/api-key). Probe it before declaring it pending, so a
    // fully-provisioned system stops pushing a spurious failures[] entry on
    // every passphrase-less apply/reconcile. `ok` → already provisioned;
    // `unreachable` → degrade (can't verify, don't fail — parity with the
    // agent unreachable path, #2781); `not_found`/`denied` → genuinely pending.
    let hindsightPending = false;
    if (needsHindsight) {
      const h = await getViaBrokerStructured("litellm/hindsight/api-key");
      if (h.kind === "ok") {
        hindsightPending = false;
        writeOut(
          chalk.gray(
            `  ~ litellm/hindsight: key already provisioned (skipped) — unaffected by missing passphrase.\n`,
          ),
        );
      } else if (h.kind === "unreachable") {
        hindsightPending = false;
        ctx.writeErr(
          chalk.yellow(
            `  ! litellm/hindsight: vault-broker unreachable — could not verify the ` +
            `service key; it keeps its previous state.\n`,
          ),
        );
      } else {
        hindsightPending = true;
      }
    }

    if (alreadyProvisioned.length > 0) {
      writeOut(
        chalk.gray(
          `  ~ litellm: ${alreadyProvisioned.length} agent(s) already provisioned ` +
          `(${alreadyProvisioned.join(", ")}) — unaffected by missing passphrase.\n`,
        ),
      );
    }

    if (brokerUnreachable.length > 0) {
      ctx.writeErr(
        chalk.yellow(
          `  ! litellm: vault-broker unreachable — could not verify/provision ` +
          `${brokerUnreachable.length} agent(s) (${brokerUnreachable.join(", ")}); ` +
          `they keep their previous routing env.\n`,
        ),
      );
    }

    if (unprovisionedNew.length === 0 && !hindsightPending) {
      // Nothing genuinely new — the rollout is honestly clean.
      return;
    }

    // Genuinely-new agents (or the hindsight key) need a NEW key we can't write
    // without the passphrase. Surface each as a scaffold failure so the rollout
    // does NOT silently report success (matches the old failures[] behaviour
    // for genuinely-new agents).
    const pendingTargets = [
      ...unprovisionedNew,
      ...(hindsightPending ? ["hindsight (service)"] : []),
    ];
    for (const target of pendingTargets) {
      failures.push({
        agent: target,
        message:
          `litellm.enabled but no vault key exists and the vault passphrase is ` +
          `unavailable (no SWITCHROOM_VAULT_PASSPHRASE env and machine-id ` +
          `auto-unlock blob missing/undecryptable) — cannot provision a new ` +
          `virtual key. Run \`switchroom apply\` interactively (operator console ` +
          `or SWITCHROOM_VAULT_PASSPHRASE env) to provision this agent.`,
      });
    }
    ctx.writeErr(
      chalk.red(
        `  x litellm: vault passphrase unavailable — ${pendingTargets.length} ` +
        `agent(s)/service(s) need a NEW key and were NOT provisioned: ` +
        `${pendingTargets.join(", ")}. These will lack routing env until an ` +
        `interactive apply provisions them.\n`,
      ),
    );
    return;
  }

  const topLevel = (config as { litellm?: {
    base_url?: string;
    admin_key?: string;
    team?: string;
    small_fast_model?: string;
    max_budget?: number;
    soft_budget?: number;
    budget_duration?: string;
  } }).litellm;

  // The fleet's active OAuth account (auth-broker single-active model) — used
  // as the `oauth_account` metadata tag. Best-effort; omitted if unset.
  const oauthAccount = config.auth?.active;

  // Track config-write-back: we batch all secrets[] grants into a single
  // read-modify-write of the host config so we don't thrash the file.
  // NOTE: this read-modify-write is last-writer-wins — no file lock or
  // mtime/etag check. If something else edits switchroom.yaml between our
  // read and write (rare during apply — the operator isn't usually editing
  // concurrently), those edits are clobbered. Acceptable for the apply path;
  // revisit if litellm provisioning ever runs outside the apply lifecycle.
  let pendingConfigEdits = false;
  let configText: string | null = null;
  if (switchroomConfigPath && existsSync(switchroomConfigPath)) {
    try {
      configText = readFileSync(switchroomConfigPath, "utf-8");
    } catch (err) {
      ctx.writeErr(
        chalk.yellow(
          `  ! litellm: could not read config for ACL grants (${(err as Error).message}); ` +
          `keys will be provisioned but agents may lack read-ACL.\n`,
        ),
      );
    }
  }

  for (const { name, litellm } of optedIn) {
    try {
      const baseUrl = litellm.base_url ?? topLevel?.base_url;
      const team = litellm.team ?? topLevel?.team ?? "switchroom";
      const adminKeyRef = litellm.admin_key ?? topLevel?.admin_key;
      // Spend cap for this agent's key. Per-agent overrides the top-level
      // block; absent everywhere ⇒ the conservative default in budget.ts. An
      // UNCAPPED virtual key is a bearer token for the whole upstream account
      // balance, so the default is "capped", not "unlimited".
      const budget = resolveKeyBudget({
        max_budget: litellm.max_budget ?? topLevel?.max_budget,
        soft_budget: litellm.soft_budget ?? topLevel?.soft_budget,
        budget_duration: litellm.budget_duration ?? topLevel?.budget_duration,
      });
      if (!baseUrl || !adminKeyRef) {
        failures.push({
          agent: name,
          message:
            `litellm.enabled but base_url or admin_key is unresolved ` +
            `(base_url=${baseUrl ? "set" : "MISSING"}, admin_key=${adminKeyRef ? "set" : "MISSING"}). ` +
            `Set them on the top-level litellm: block or per-agent.`,
        });
        continue;
      }

      const vaultKey = `litellm/${name}/api-key`;
      const alias = `agent:${name}`;

      const existing = await getViaBrokerStructured(vaultKey);
      if (existing.kind === "unreachable") {
        // #2781: an unreachable broker is an ENVIRONMENT limitation, not a
        // provisioning error — hostd's in-container `switchroom apply` has no
        // broker socket mounted BY CONSTRUCTION, so treating this as a
        // scaffold failure made every hostd reconcile exit 1 (12/12 "failed")
        // and rolled back every config_propose_edit. Degrade to a WARNING,
        // mirroring the "Hindsight unreachable — skipping bank creation"
        // path: the agent keeps whatever routing env its previous provision
        // gave it, and apply exits 0 if nothing else failed. Genuine
        // provisioning errors (bad ref / write denial with the broker
        // reachable) below still land in `failures`.
        ctx.writeErr(
          chalk.yellow(
            `  ! litellm/${name}: vault-broker unreachable (${existing.msg ?? "no detail"}) — ` +
            `skipping key provisioning; agent keeps its previous routing env.\n`,
          ),
        );
        continue;
      }

      // Resolve a `vault:` admin_key via the auto-unlocked broker. Failure is
      // only FATAL on the provisioning path below — an already-provisioned agent
      // whose admin_key ref is momentarily unresolvable keeps its key (validation
      // is skipped), it is NOT reported as a scaffold failure.
      let masterKey: string | null = adminKeyRef;
      let masterKeyErr: string | null = null;
      if (isVaultReference(adminKeyRef)) {
        const refKey = parseVaultReference(adminKeyRef);
        const resolved = await getViaBrokerStructured(refKey);
        if (resolved.kind !== "ok") {
          masterKey = null;
          masterKeyErr =
            `litellm: admin_key vault ref '${adminKeyRef}' did not resolve ` +
            `(${resolved.kind}${"msg" in resolved && resolved.msg ? `: ${resolved.msg}` : ""}).`;
        } else if (resolved.entry.kind !== "string") {
          masterKey = null;
          masterKeyErr = `litellm: admin_key vault ref '${adminKeyRef}' is not a string secret.`;
        } else {
          masterKey = resolved.entry.value;
        }
      }

      if (masterKey && !brokerKeyMaterialized) {
        const mat = materializeLitellmMasterKeyForBroker(
          masterKey,
          ctx.home ?? homedir(),
        );
        brokerKeyMaterialized = true;
        if (!mat.ok) {
          ctx.writeErr(
            chalk.yellow(
              `  ! litellm: could not materialize master key for auth-broker external-spend (${mat.error})\n`,
            ),
          );
        }
      }

      // Idempotency + DB-drift validation (fix): the vault already holds a key.
      // Pre-fix this ALWAYS skipped, blind to the proxy's own state — so a proxy
      // DB reset/restore (without the vault) left every agent 401ing forever.
      // Now: when we have the admin key in hand AND the proxy is reachable,
      // validate the stored key via GET /key/info; an unknown key means DB drift
      // and we re-provision through the same self-healing ensureKey path.
      if (existing.kind === "ok") {
        const storedKey = existing.entry.kind === "string" ? existing.entry.value : null;
        let driftReprovision = false;
        if (storedKey && masterKey) {
          const validation = await validateKey({ baseUrl, masterKey, key: storedKey });
          if (validation.kind === "unknown") {
            // Proxy reachable but the key is NOT recognized (DB drift). Fall
            // through to re-provision (ensureKey self-heals the orphaned alias)
            // and overwrite the stale vault key.
            driftReprovision = true;
            ctx.writeErr(
              chalk.yellow(
                `  ! litellm/${name}: stored virtual key not recognized by the proxy ` +
                `(DB drift) — re-provisioning a fresh key.\n`,
              ),
            );
          } else if (validation.kind === "unreachable") {
            // Availability-safe (#2781): an unreachable/ambiguous proxy never
            // fails the apply — keep the stored key, warn, and move on.
            ctx.writeErr(
              chalk.yellow(
                `  ! litellm/${name}: proxy unreachable during key validation ` +
                `(${validation.detail}) — keeping the stored key unverified.\n`,
              ),
            );
          } else {
            // validation.kind === "valid": the proxy recognizes the key. F1:
            // it may still be UNBOUND (provisioned before the team-binding fix,
            // or via the degraded unbound path) or bound to the WRONG team — so
            // per-team cost tracking silently never aggregates for it, and the
            // pre-fix idempotent skip left it that way FOREVER. Resolve the
            // desired team and re-bind IN PLACE (POST /key/update) — no key
            // deletion/regeneration. Availability-safe + LOUD on failure.
            const boundTeamId = validation.teamId; // string | null
            let desired: Awaited<ReturnType<typeof ensureTeam>> | null = null;
            try {
              desired = await ensureTeam(
                baseUrl,
                masterKey,
                team,
                undefined,
                (m) => ctx.writeErr(chalk.yellow(`  ! litellm/${name}: ${m}\n`)),
              );
            } catch (err) {
              // #2781 parity: a team-resolution error must NOT turn an
              // already-good key into a scaffold failure — keep it, warn, move on.
              ctx.writeErr(
                chalk.yellow(
                  `  ! litellm/${name}: could not resolve team '${team}' to check ` +
                  `key binding (${(err as Error).message}) — keeping the stored key as-is.\n`,
                ),
              );
            }

            // Config is authoritative for team binding: a key bound out-of-band
            // to a DIFFERENT team is re-bound back to the config-declared team
            // on the next apply (announced in the output). One team per cost
            // bucket is the product invariant; change the config to change the
            // binding.
            if (desired && desired.kind === "bound" && boundTeamId !== desired.teamId) {
              const bind = await bindKeyToTeam({ baseUrl, masterKey, key: storedKey, teamId: desired.teamId });
              if (bind.kind === "ok") {
                writeOut(
                  chalk.green(
                    `  + litellm/${name}: re-bound existing key to team '${team}' ` +
                    `(${boundTeamId === null ? "was UNBOUND" : `was team '${boundTeamId}'`}) ` +
                    `— per-team cost tracking now applies\n`,
                  ),
                );
              } else {
                ctx.writeErr(
                  chalk.yellow(
                    `  ! litellm/${name}: key is provisioned but re-bind to team ` +
                    `'${team}' FAILED (${bind.detail}) — per-team cost tracking will ` +
                    `NOT aggregate for this key until re-bound. Manual: POST ` +
                    `${baseUrl}/key/update {"key":"<key>","team_id":"${desired.teamId}"}.\n`,
                  ),
                );
              }
            } else if (desired && desired.kind === "unbound" && boundTeamId === null) {
              // Key UNBOUND and the team_id could not be resolved → stay LOUD
              // every apply so the degradation is never silent (F1 loud fallback).
              ctx.writeErr(
                chalk.yellow(
                  `  ! litellm/${name}: key is provisioned but UNBOUND to any team, ` +
                  `and team '${team}' could not be resolved (${desired.reason}) — ` +
                  `per-team cost tracking will NOT aggregate for this key. Re-run ` +
                  `once the LiteLLM team is resolvable.\n`,
                ),
              );
            } else {
              // Already bound to the desired team, OR bound to some team we
              // couldn't re-resolve (still tracked), OR the lookup threw
              // (warned above) — quiet, honest skip.
              writeOut(chalk.gray(`  ~ litellm/${name}: key already provisioned + validated (skipped)\n`));
            }
          }
        } else {
          // Can't validate (no admin key in hand, or a non-string entry) — keep
          // the pre-fix idempotent skip. Do NOT surface masterKeyErr here: an
          // already-provisioned agent stays good even if its admin_key ref is
          // momentarily unresolvable.
          writeOut(chalk.gray(`  ~ litellm/${name}: key already provisioned (skipped)\n`));
        }

        // Re-cap an EXISTING key. Keys provisioned before spend caps existed
        // are never regenerated (the vault check above short-circuits), so
        // without this heal every pre-existing agent would stay UNCAPPED
        // forever and the feature would protect only new agents. Idempotent —
        // LiteLLM accepts the same budget repeatedly.
        //
        // `soft_budget` is NOT healed: LiteLLM's UpdateKeyRequest does not
        // carry it (see updateKeyBudget), so an existing key can only gain the
        // advisory alert by being regenerated. Said plainly rather than
        // silently pretended.
        if (!driftReprovision && storedKey && masterKey && budget) {
          const cap = await updateKeyBudget({ baseUrl, masterKey, key: storedKey, budget });
          if (cap.kind === "ok") {
            writeOut(
              chalk.gray(
                `  ~ litellm/${name}: spend ${describeKeyBudget(budget)}` +
                `${budget.softBudget != null ? " (soft budget applies to newly generated keys only)" : ""}\n`,
              ),
            );
          } else {
            ctx.writeErr(
              chalk.yellow(
                `  ! litellm/${name}: could NOT apply the spend cap (${cap.detail}) — ` +
                `this key remains UNCAPPED and can spend the whole upstream account ` +
                `balance. Manual: POST ${baseUrl}/key/update ` +
                `{"key":"<key>","max_budget":${budget.maxBudget},"budget_duration":"${budget.budgetDuration}"}.\n`,
              ),
            );
          }
        }

        if (!driftReprovision) {
          // Still ensure the read-ACL is granted (cheap, idempotent).
          if (configText !== null) {
            const after = addAgentSecret(configText, name, vaultKey);
            if (after !== configText) {
              configText = after;
              pendingConfigEdits = true;
            }
          }
          continue;
        }
        // driftReprovision → fall through to the provisioning block below.
      }

      // Provisioning path (genuinely-new agent OR DB-drift re-provision). The
      // admin key MUST resolve here.
      if (!masterKey) {
        failures.push({ agent: name, message: masterKeyErr ?? `litellm: admin_key unresolved` });
        continue;
      }

      // Provision: ensure team (capturing its team_id so the key binds to it
      // for per-team cost/spend tracking), then generate the per-agent key.
      const teamResult = await ensureTeam(
        baseUrl,
        masterKey,
        team,
        undefined,
        (m) => ctx.writeErr(chalk.yellow(`  ! litellm/${name}: ${m}\n`)),
      );
      const teamId = teamResult.kind === "bound" ? teamResult.teamId : undefined;
      const metadata: Record<string, string> = {
        agent: name,
        env: "fleet",
      };
      if (oauthAccount) metadata.oauth_account = oauthAccount;
      const profile = config.agents[name]?.extends;
      if (profile) metadata.profile = profile;
      for (const [k, v] of Object.entries(litellm.tags ?? {})) {
        metadata[k] = v;
      }

      const { key } = await ensureKey({
        baseUrl,
        masterKey,
        alias,
        teamId,
        metadata,
        ...(budget ? { budget } : {}),
        // Surface the orphaned-alias self-heal steps (delete + regenerate) so the
        // operator sees the recovery instead of a silent extra round-trip.
        log: (m) => ctx.writeErr(chalk.gray(`  ~ litellm/${name}: ${m}\n`)),
      });

      // Store the key in the vault via the broker WITH operator-passphrase
      // attestation. The operator socket alone does NOT authorize introducing
      // a new key (server.ts ~1657/~1692 refuse path-as-identity new-key
      // writes) — the passphrase is what flips `passphraseAttested` in the
      // broker, which permits new-key creation AND updates the broker's
      // in-memory secrets so the agent's boot-time `vault get` sees it (a
      // direct vault.enc write would persist but stay invisible until broker
      // reload). Note: the broker's wire `put` cannot carry a per-entry scope
      // ACL — cross-agent isolation is enforced by the agent's standing
      // secrets[] grant added below (the broker get-ACL gates by agent name).
      const put = await putViaBroker(vaultKey, { kind: "string", value: key }, { passphrase });
      if (put.kind !== "ok") {
        failures.push({
          agent: name,
          message:
            `litellm: provisioned key but vault write failed ` +
            `(${put.kind}${"msg" in put && put.msg ? `: ${put.msg}` : ""}).`,
        });
        ctx.writeErr(
          chalk.red(
            `  x litellm/${name}: vault write FAILED — agent will not get routing env.\n`,
          ),
        );
        continue;
      }

      // Grant the agent read-ACL: add the key to its standing secrets[].
      if (configText !== null) {
        const after = addAgentSecret(configText, name, vaultKey);
        if (after !== configText) {
          configText = after;
          pendingConfigEdits = true;
        }
      }

      if (teamId) {
        writeOut(chalk.green(`  + litellm/${name}: provisioned virtual key (team '${team}')\n`));
      } else {
        // F3: ensureTeam could not resolve a team_id, so the key was generated
        // UNBOUND. The pre-fix code printed a green "(team 'switchroom')" here —
        // the config NAME string, always truthy — falsely claiming a binding.
        // Be honest + LOUD: the key exists, but cost tracking will NOT aggregate.
        ctx.writeErr(
          chalk.yellow(
            `  ! litellm/${name}: provisioned virtual key WITHOUT team binding ` +
            `(${teamResult.kind === "unbound" ? teamResult.reason : "team_id unresolved"}) ` +
            `— per-team cost tracking will NOT aggregate for this key.\n`,
          ),
        );
      }
    } catch (err) {
      failures.push({ agent: name, message: `litellm: ${(err as Error).message}` });
    }
  }

  // Flush batched config edits (ACL grants) once.
  if (pendingConfigEdits && configText !== null && switchroomConfigPath) {
    try {
      // Atomic tmp+fsync+rename so a crash/ENOSPC mid-write can never truncate
      // switchroom.yaml when flushing the batched litellm ACL grants. Bind-mount
      // aware (in-place fsync'd fallback on EBUSY); preserves the file's mode.
      let cfgMode = 0o644;
      try {
        cfgMode = statSync(switchroomConfigPath).mode & 0o777;
      } catch {
        /* default 0o644 */
      }
      writeConfigFileSync(switchroomConfigPath, configText, cfgMode);
      writeOut(chalk.gray(`  ~ litellm: granted read-ACL on per-agent keys (updated ${switchroomConfigPath})\n`));
    } catch (err) {
      ctx.writeErr(
        chalk.yellow(
          `  ! litellm: could not write ACL grants to config (${(err as Error).message}).\n`,
        ),
      );
    }
  }

  // Provision the hindsight service key when globally enabled + hindsight backend.
  // The key is stored at litellm/hindsight/api-key, same vault path that
  // startHindsight() reads at container launch time.
  if (needsHindsight) {
    // Provision a per-service virtual key for the hindsight container.
    // Uses the same top-level base_url / admin_key / team as the agent keys.
    const baseUrl = topLevel?.base_url;
    const adminKeyRef = topLevel?.admin_key;
    if (baseUrl && adminKeyRef) {
      const hindsightVaultKey = "litellm/hindsight/api-key";
      try {
        const existing = await getViaBrokerStructured(hindsightVaultKey);
        if (existing.kind === "ok") {
          // The key EXISTS — but existing used to mean "done", and that is
          // exactly how the model allowlist went unmanaged. The allowlist is
          // enforced at request auth and lives only in the proxy's Postgres
          // row, so a DB rebuild reverts it and nothing notices: the affected
          // lane simply stops producing traffic. Reconcile it from the config
          // that declares which lanes hindsight calls, the same way the
          // per-agent branch above reconciles TEAM binding. See
          // src/litellm/key-allowlist.ts.
          const masterKey = await resolveConfigSecret(adminKeyRef, getViaBrokerStructured);
          if (masterKey) {
            await reconcileHindsightKeyAllowlist({
              baseUrl,
              masterKey,
              config,
              validateKey,
              updateKeyModels,
              resolveSecret: (ref) => resolveConfigSecret(ref, getViaBrokerStructured),
              writeOut,
              writeErr: ctx.writeErr,
            });
          } else {
            // Deliberately NOT the "(skipped)" line: the admin key could not be
            // resolved, so the allowlist was never looked at. Reporting an
            // unperformed check as a clean skip is how the original defect
            // stayed invisible.
            ctx.writeErr(
              chalk.yellow(
                `  ! litellm/hindsight: key already provisioned, but the litellm ` +
                  `admin_key (\`${adminKeyRef}\`) could not be resolved — model ` +
                  `allowlist left unverified.\n`,
              ),
            );
          }
        } else {
          // Resolve admin key (may be a vault ref).
          let masterKey = adminKeyRef;
          if (isVaultReference(adminKeyRef)) {
            const resolved = await getViaBrokerStructured(parseVaultReference(adminKeyRef));
            if (resolved.kind === "ok" && resolved.entry.kind === "string") {
              masterKey = resolved.entry.value;
            } else {
              throw new Error(`admin_key vault ref '${adminKeyRef}' did not resolve`);
            }
          }
          const team = topLevel?.team ?? "switchroom";
          const teamResult = await ensureTeam(
            baseUrl,
            masterKey,
            team,
            undefined,
            (m) => ctx.writeErr(chalk.yellow(`  ! litellm/hindsight: ${m}\n`)),
          );
          const teamId = teamResult.kind === "bound" ? teamResult.teamId : undefined;
          const { key } = await ensureKey({
            baseUrl,
            masterKey,
            alias: "service:hindsight",
            teamId,
            metadata: { service: "hindsight", env: "fleet", ...(oauthAccount ? { oauth_account: oauthAccount } : {}) },
            log: (m) => ctx.writeErr(chalk.gray(`  ~ litellm/hindsight: ${m}\n`)),
          });
          const put = await putViaBroker(
            hindsightVaultKey,
            { kind: "string", value: key },
            { passphrase: passphrase! },
          );
          if (put.kind === "ok") {
            if (teamId) {
              writeOut(chalk.green(`  + litellm/hindsight: provisioned virtual key (team '${team}')\n`));
            } else {
              // F3: honest, LOUD degradation instead of a false "(team ...)" claim.
              ctx.writeErr(
                chalk.yellow(
                  `  ! litellm/hindsight: provisioned virtual key WITHOUT team binding ` +
                  `(${teamResult.kind === "unbound" ? teamResult.reason : "team_id unresolved"}) ` +
                  `— per-team cost tracking will NOT aggregate for this key.\n`,
                ),
              );
            }
          } else {
            throw new Error(`vault write failed (${put.kind})`);
          }
        }
      } catch (err) {
        ctx.writeErr(
          chalk.yellow(`  ! litellm/hindsight: key provisioning failed — ${(err as Error).message}\n`),
        );
      }
    }
  }
}

/**
 * Resolve a config secret value — `litellm.admin_key`, or a per-op
 * `hindsight.llm.<op>.api_key` — to the actual secret. A literal is returned
 * as-is; a `vault:<key>` reference is read through the broker. Returns null
 * when it cannot be resolved, so callers degrade to a warning rather than
 * failing an already-provisioned agent (#2781 parity).
 */
export async function resolveConfigSecret(
  ref: string,
  getViaBrokerStructured: typeof import("../vault/broker/client.js").getViaBrokerStructured,
): Promise<string | null> {
  if (!isVaultReference(ref)) return ref;
  const resolved = await getViaBrokerStructured(parseVaultReference(ref));
  if (resolved.kind !== "ok") return null;
  if (resolved.entry.kind !== "string") return null;
  return resolved.entry.value;
}

/**
 * Reconcile the hindsight service key's MODEL ALLOWLIST against the config that
 * declares which model groups hindsight calls.
 *
 * Why this exists: the allowlist is enforced at request auth
 * (`can_key_call_model`) and stored ONLY in the proxy's Postgres token row, so
 * it has no declarative home on the proxy side and a DB rebuild silently
 * reverts it. On 2026-07-26 the `gpt-oss-20b-retain` and
 * `gpt-oss-20b-consolidation` lanes were declared in `switchroom.yaml`, served
 * by the proxy, and absent from the key — every call was rejected at auth and
 * the lanes had ZERO traffic since creation. Not unused: unreachable.
 *
 * Availability-safe throughout. Anything ambiguous (proxy unreachable, key
 * unrecognised, model list unavailable) degrades to a warning and keeps the key
 * exactly as it is; nothing here can delete, regenerate, or truncate.
 *
 * Reconciles ONE KEY PER DISTINCT `api_key` the config names. A
 * `provider: litellm` op presents `hindsight.llm.<op>.api_key`
 * (`HINDSIGHT_API_<OP>_LLM_API_KEY`), while the provisioned key at
 * `litellm/hindsight/api-key` authenticates the claude-code passthrough — two
 * different keys in general, and reconciling only the provisioned one would
 * grant access to a key the failing lane never presents.
 *
 * An op that declares NO `api_key` is a third case, and deliberately NOT
 * reconciled: switchroom emits no global `HINDSIGHT_API_LLM_API_KEY` (see
 * src/cli/setup.ts, where the name is retained only as a legacy no-op), and
 * hindsight reads it as a bare `os.getenv` with no default, so such a lane
 * presents no credential this function can name. Widening the provisioned
 * service key's allowlist on its behalf would grant a key that lane never sends
 * — motion that looks like a fix and changes nothing. It warns instead.
 */
export async function reconcileHindsightKeyAllowlist(args: {
  baseUrl: string;
  masterKey: string;
  config: SwitchroomConfig;
  validateKey: typeof import("../litellm/provision.js").validateKey;
  updateKeyModels: typeof import("../litellm/provision.js").updateKeyModels;
  /** Resolve a literal-or-`vault:` config secret reference. */
  resolveSecret: (ref: string) => Promise<string | null>;
  writeOut: (s: string) => void;
  writeErr: (s: string) => void;
  fetchFn?: import("../litellm/provision.js").FetchFn;
}): Promise<void> {
  const { baseUrl, masterKey, config, writeOut, writeErr } = args;
  const { fetchProxyModels } = await import("../litellm/model-validation.js");
  const { requiredKeyModels, requiredKeyDemands, reconciledAllowlist, classifyAllowlist } =
    await import("../litellm/key-allowlist.js");

  const probe = await fetchProxyModels(baseUrl, masterKey, args.fetchFn);
  if (probe.kind !== "ok") {
    writeErr(
      chalk.yellow(
        `  ! litellm/hindsight: could not read the proxy model list (${probe.msg}) — ` +
          `key model allowlist left unverified.\n`,
      ),
    );
    return;
  }

  const demands = requiredKeyDemands(requiredKeyModels(config, new Set(probe.models)));
  if (demands.length === 0) {
    writeOut(
      chalk.gray(
        `  ~ litellm/hindsight: key already provisioned; no litellm-routed ` +
          `model groups declared (nothing to reconcile)\n`,
      ),
    );
    return;
  }

  // SEQUENTIAL on purpose — do NOT turn this into a `Promise.all`. Two config
  // paths may name different refs that resolve to the SAME key value, and each
  // iteration re-reads that key's current allowlist and writes back a union of
  // it. Run concurrently, both iterations would read the pre-update list and
  // the second write would clobber the first grant with a stale union: a lost
  // update, and a silent one, because the write still reports `ok`.
  for (const demand of demands) {
    const label = `litellm/hindsight (${demand.declaredBy.join(", ")})`;

    // No `api_key` on the op ⇒ UNKNOWN key, not the service key. Reconciling
    // `litellm/hindsight/api-key` here would widen a key this lane never
    // presents, so the grant would read as success while the lane stayed
    // unreachable. Name the missing config instead.
    if (demand.apiKeyRef === null) {
      writeErr(
        chalk.yellow(
          `  ! ${label}: routed through litellm but declares no \`api_key\`, so ` +
            `switchroom cannot tell which virtual key it presents — model ` +
            `allowlist left unverified (the provisioned ` +
            `\`litellm/hindsight/api-key\` is NOT a fallback; it authenticates ` +
            `the claude-code passthrough). Set \`hindsight.llm.<op>.api_key\`.\n`,
        ),
      );
      continue;
    }

    const key = await args.resolveSecret(demand.apiKeyRef);
    if (!key) {
      writeErr(
        chalk.yellow(
          `  ! ${label}: could not resolve the api_key this lane presents ` +
            `(${demand.declaredBy.map((c) => `${c}.api_key`).join(" / ")}) — ` +
            `model allowlist left unverified.\n`,
        ),
      );
      continue;
    }

    const validation = await args.validateKey({ baseUrl, masterKey, key }, args.fetchFn);
    if (validation.kind === "unreachable") {
      // Distinct from `unknown` on purpose. The proxy answered `/v1/models`
      // moments ago, so a failure HERE means the allowlist was never read.
      // Reporting that as a clean "(skipped)" is the same unperformed-check-
      // dressed-as-a-pass that let the original defect hide for weeks.
      writeErr(
        chalk.yellow(
          `  ! ${label}: could not read the key's model allowlist ` +
            `(${validation.detail}) — left unverified.\n`,
        ),
      );
      continue;
    }
    if (validation.kind !== "valid") {
      // `unknown` = DB drift, which the provisioning path owns and reports with
      // the right remedy. Never re-provision from here, and do not say it twice.
      writeOut(
        chalk.gray(
          `  ~ ${label}: the proxy does not recognise this key — allowlist not ` +
            `reconciled (the key-provisioning step owns this)\n`,
        ),
      );
      continue;
    }

    const groups = [...new Set(demand.required.map((r) => r.group))];
    const next = reconciledAllowlist(validation.models, demand.required);
    if (next === null) {
      const posture = classifyAllowlist(validation.models);
      writeOut(
        chalk.gray(
          `  ~ ${label}: key already provisioned + validated ` +
            `(${
              posture === "unrestricted"
                ? "model allowlist unrestricted"
                : posture === "indeterminate"
                  ? "model allowlist delegated to the key's team — not reconciled"
                  : `reaches all ${groups.length} declared model group(s)`
            })\n`,
        ),
      );
      continue;
    }

    const added = next.filter((m) => !validation.models.includes(m));
    const upd = await args.updateKeyModels(
      { baseUrl, masterKey, key, models: next },
      args.fetchFn,
    );
    if (upd.kind === "ok") {
      writeOut(
        chalk.green(
          `  + ${label}: granted key access to ${added.length} declared model ` +
            `group(s) it could NOT reach — ${added.join(", ")}. Every call to ` +
            `${added.length === 1 ? "it" : "them"} was being rejected at auth ` +
            `("key not allowed to access model").\n`,
        ),
      );
    } else {
      writeErr(
        chalk.yellow(
          `  ! ${label}: key CANNOT reach declared model group(s) ` +
            `${added.join(", ")} and the allowlist update FAILED (${upd.detail}) — ` +
            `every call to ${added.length === 1 ? "that lane" : "those lanes"} will be ` +
            `rejected at auth until it is fixed. Manual: POST ${baseUrl}/key/update ` +
            `{"key":"<key>","models":${JSON.stringify(next)}}.\n`,
        ),
      );
    }
  }
}

/**
 * Resolve the directory the broker will bind-mount as the vault parent.
 *
 * Path derivation: the dir we're about to BIND-MOUNT is always the
 * POST-MIGRATION canonical parent (`<home>/.switchroom/vault/`) for
 * default-config operators, regardless of whether their `vault.path`
 * is the legacy or new shape. Custom-path operators (where the
 * migration helper returned `custom-path-skipped`) use
 * `dirname(customVaultPath)`.
 *
 * Pre-#958 this used `dirname(customVaultPath)` unconditionally, which
 * for the legacy configured path `~/.switchroom/vault.enc` resolved
 * to `~/.switchroom/` (parent of the legacy file, NOT the new mount
 * target). The operator's actual `~/.switchroom/` contains many
 * sibling dirs (approvals/, logs/, etc.) and the guard correctly
 * refused to mount because none are in the artifact whitelist —
 * surfaced when self-deploying v0.7.12 against the operator's fleet.
 *
 * @internal exported for testing (#961).
 */
export function resolveVaultBindMountDir(
  homeDir: string,
  ctx: {
    migrationKind: import("../vault/migrate-layout.js").MigrationResult["kind"];
    customVaultPath: string | undefined;
  },
): string {
  const isCustomPath = ctx.migrationKind === "custom-path-skipped";
  if (isCustomPath && ctx.customVaultPath) {
    return dirname(ctx.customVaultPath);
  }
  return join(homeDir, ".switchroom", "vault");
}

/**
 * Read the vault bind-mount dir and report any files outside saveVault's
 * known-artifacts list. The whitelist is sourced from
 * `KNOWN_VAULT_ARTIFACT_NAMES` + `KNOWN_VAULT_ARTIFACT_PATTERNS` in
 * `src/vault/vault.ts` so future write artifacts are picked up
 * without editing two places.
 *
 * Returns one of:
 *   - { kind: "missing" } — dir doesn't exist (treated as success;
 *     compose will create it on first up)
 *   - { kind: "ok" } — every entry is a known artifact
 *   - { kind: "unexpected-files", unknown } — caller refuses to mount
 *     and prints the recovery recipe
 *
 * @internal exported for testing (#961).
 */
export function inspectVaultBindMountDir(
  vaultDir: string,
):
  | { kind: "missing" }
  | { kind: "ok" }
  | { kind: "unexpected-files"; unknown: string[] }
{
  if (!existsSync(vaultDir)) return { kind: "missing" };
  const entries = readdirSync(vaultDir);
  const unknown: string[] = [];
  for (const name of entries) {
    if (KNOWN_VAULT_ARTIFACT_NAMES.has(name)) continue;
    if (KNOWN_VAULT_ARTIFACT_PATTERNS.some((re) => re.test(name))) continue;
    unknown.push(name);
  }
  if (unknown.length > 0) return { kind: "unexpected-files", unknown };
  return { kind: "ok" };
}

/**
 * Walk a value recursively and return true if any string property is a
 * `vault:<key>` reference. Used by the preflight check below so we can
 * fail fast when the config wants vault-resolved secrets but the
 * vault hasn't been initialised yet.
 */
function hasVaultRefs(value: unknown): boolean {
  if (typeof value === "string") return isVaultReference(value);
  if (Array.isArray(value)) return value.some(hasVaultRefs);
  if (value && typeof value === "object") {
    return Object.values(value).some(hasVaultRefs);
  }
  return false;
}

/**
 * Pre-create every host directory that compose will bind-mount.
 *
 * Why: docker auto-creates a missing bind-mount source as an empty
 * directory owned by the dockerd UID (root). On v0.7 installs that
 * tripped twice — operators ended up with root-owned `~/.switchroom/vault`
 * and `~/.switchroom/vault-auto-unlock` stub directories that blocked
 * the real files from landing at the same path. Creating the
 * directories ourselves (as the current shell user) removes the
 * race entirely.
 *
 * The set of paths mirrors the volume mount sources emitted by
 * `generateCompose`. We mkdir directories only — files (vault.enc,
 * vault-auto-unlock blob) are managed by `switchroom setup` / vault
 * commands.
 */
export async function ensureHostMountSources(
  config: SwitchroomConfig,
): Promise<void> {
  // Seed bind sources under the HOST home via the same fail-closed resolver the
  // compose generator uses — NOT bare homedir(). In a container without
  // SWITCHROOM_HOST_HOME this THROWS instead of seeding under the container HOME
  // (the independent autodir vector that ran before compose write, 2026-06-23).
  const home = resolveHostHomeForCompose();
  const dirs = [
    join(home, ".switchroom", "approvals"),
    join(home, ".switchroom", "scheduler"),
    join(home, ".switchroom", "logs"),
    join(home, ".switchroom", "compose"),
    // Host bind for the broker's operator socket. Pre-create so docker
    // doesn't auto-create as root-owned (which would prevent the broker
    // from chowning the dir to the operator UID at bind time, leaving
    // the host-shell unable to connect — the exact failure mode this
    // mount is here to fix).
    join(home, ".switchroom", "broker-operator"),
  ];
  for (const name of Object.keys(config.agents)) {
    dirs.push(join(home, ".switchroom", "agents", name));
    dirs.push(join(home, ".switchroom", "logs", name));
    dirs.push(join(home, ".claude", "projects", name));
    // Pre-create the per-agent audit dir so alignAgentUid's second pass
    // can chown it to the agent UID BEFORE compose mounts it (otherwise
    // generateCompose's mkdirSync would create it as root mid-apply,
    // leaving the audit log unwritable on fresh installs — #1831).
    dirs.push(join(home, ".switchroom", "audit", name));
    // Pre-create the per-agent config-mirror dir IF the operator has
    // opted into versioned personal-skills (~/.switchroom-config exists).
    // Same first-apply rationale as the audit dir (#1846).
    if (existsSync(join(home, ".switchroom-config"))) {
      dirs.push(
        join(home, ".switchroom-config", "agents", name, "personal-skills"),
      );
    }
  }
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }

  // Per-agent scratch dirs on the bulk volume (src/agents/scratch.ts). These
  // are NOT under the operator home — they live on a second device — so they
  // can't join the `dirs` list above. Created here, ahead of the compose
  // write, so docker never auto-creates the bind source as root:root (which
  // would EACCES every cache write from the non-root agent uid). No-op when
  // the volume isn't mounted, which is the whole dev-machine degradation
  // story. Ownership is aligned to `allocateAgentUid` inside the helper —
  // `apply` may be running self-elevated as root here.
  ensureAgentScratchDirs(
    resolveScratchConfig(config),
    Object.keys(config.agents),
  );

  // The auto-unlock blob is bind-mounted at
  // `~/.switchroom/vault-auto-unlock`. If the source path is missing,
  // docker auto-creates it as a root-owned DIRECTORY when the broker
  // starts — which then blocks `switchroom vault broker enable-auto-unlock`
  // from later writing a file at that path. v0.7.1 claimed to close
  // this bug class but only handled the dir-shape case; the file path
  // was still vulnerable on greenfield installs.
  //
  // Pre-create as a 0-byte file owned by the operator. The broker
  // detects empty/undecryptable contents at boot and falls back to
  // interactive unlock cleanly (vault/broker/server.ts:1503-1518).
  // `enable-auto-unlock` later overwrites this placeholder via
  // `writeFileSync` (auto-unlock.ts:199), so no special handoff.
  const autoUnlockPath = join(home, ".switchroom", "vault-auto-unlock");
  if (!existsSync(autoUnlockPath)) {
    writeFileSync(autoUnlockPath, "", { mode: 0o600 });
  }

  // vault-audit.log: same dir-vs-file race. The broker bind-mounts
  // this file (see compose.ts broker volumes) so audit-log writes
  // land on the host, not inside the ephemeral container fs where
  // they'd be lost on recreate and invisible to the host CLI
  // (`switchroom vault audit`) plus the admin-agent :ro mount
  // wired up in #1024. Created mode 0644 because both readers
  // (host operator + the agent UID inside admin agents) need
  // access. Broker writes via root with CAP_DAC_OVERRIDE so
  // mode doesn't matter on the write path.
  const auditLogPath = join(home, ".switchroom", "vault-audit.log");
  if (!existsSync(auditLogPath)) {
    writeFileSync(auditLogPath, "", { mode: 0o644 });
  }

  // vault-grants.db: capability-token grants persisted to a SQLite
  // file inside a DEDICATED directory (`~/.switchroom/vault-broker/`).
  //
  // WHY A DIRECTORY, NOT THE BARE FILE (#3289): the grants DB runs in WAL
  // mode, which writes `-wal`/`-shm` sidecars beside the main file. The old
  // single-file bind mount left those sidecars in the broker's ephemeral
  // overlayfs, so a committed grant sat in the container-local WAL until a
  // rare checkpoint and was LOST on container recreate. Bind-mounting the
  // whole directory keeps the main file AND its sidecars on the host fs.
  //
  // Pre-create the directory (mode 0700 — secrets material, no group/other
  // access) so docker doesn't auto-create a root-owned path at the bind
  // source, then relocate any legacy `~/.switchroom/vault-grants.db` (plus its
  // WAL sidecars) into it. `migrateLegacyGrantsDbLocation` is idempotent and a
  // no-op on greenfield / already-migrated hosts. The broker's `openGrantsDb`
  // runs the SQL migration on first open, so it boots cleanly on a fresh empty
  // directory OR an existing populated DB. Both resolve the path from the
  // shared `grants-db-path` helpers — no duplicated literal.
  //
  // Without this bind mount + pre-create, broker recreates wipe every
  // capability grant — the orphaned `.vault-token` files on disk then fail
  // every `vault get` from inside agent containers. Surfaced 2026-05-24 after
  // the v0.13.31 rollout; WAL-sidecar durability hardened in #3289.
  //
  // UPGRADE-WINDOW CAVEAT: while a PRE-fix broker is still running, it holds
  // the legacy DB open via the old single-file mount. A grant minted between
  // this migration and the broker's recreate (`docker compose up`, which the
  // operator/updater runs after apply) lands in a fresh container-local
  // legacy -wal the new broker never replays and may need re-minting. This
  // window is unavoidable without stopping the broker before apply; apply
  // therefore runs the migration as late as it can — inside the mount-source
  // preparation immediately preceding the compose handoff. The broker's own
  // boot re-runs the same idempotent migration as a second chance.
  const grantsDbDir = getGrantsDbDir(home);
  mkdirSync(grantsDbDir, { recursive: true, mode: 0o700 });
  migrateLegacyGrantsDbLocation(getGrantsDbPath(home));

  // host-control-audit.log: same pattern as vault-audit.log — hostd
  // is the writer (from inside its own container at /host-home),
  // admin agents bind-mount it :ro so `/audit hostd` (#1328) can
  // tail the privileged-verb history from DM. Pre-create here so
  // docker compose `up` doesn't hard-fail on a missing :ro source
  // before hostd has handled its first request.
  const hostdAuditLogPath = join(home, ".switchroom", "host-control-audit.log");
  if (!existsSync(hostdAuditLogPath)) {
    writeFileSync(hostdAuditLogPath, "", { mode: 0o644 });
  }

  // Per-agent vault-grant token file (`<agentDir>/.vault-token`,
  // mode 0600). The broker's mint_grant handler (server.ts ~2222)
  // writes the token at `os.homedir() + .switchroom/agents/<agent>/.vault-token`
  // — inside the broker container that path is `/root/.switchroom/...`
  // and was never bind-mounted out, so fresh mints stranded in the
  // broker's ephemeral filesystem. Operator-side `.vault-token` files
  // either didn't exist or were stale, and `claude mcp list` shows
  // "Failed to connect" for any user-declared MCP that relies on
  // `switchroom vault get <key>` to fetch its API key (e.g. perplexity).
  // Surfaced 2026-05-25 after the v0.13.37 launcher relocation +
  // a fleet-wide `vault grant` cycle showed every minted token
  // missing on the operator side.
  //
  // Fix: pre-create the file (so docker compose `up` doesn't
  // auto-create a directory at this path on a fresh install) and
  // chown to the agent UID so the agent inside the container can
  // read it under its own peercred identity. The broker writes via
  // CAP_DAC_OVERRIDE so its writes succeed regardless of ownership.
  //
  // #3751: this pre-creation is now load-bearing for ownership too, not
  // just to stop docker auto-creating a directory here. mint_grant
  // publishes the token with an IN-PLACE O_TRUNC write (never tmp+rename —
  // the file is a bare-file bind mount in the broker container and rename
  // over it is EBUSY), which preserves THIS inode and therefore the
  // agent-UID ownership set below. The broker only chowns on the path
  // where it had to create the file itself.
  for (const name of Object.keys(config.agents)) {
    const tokenPath = join(home, ".switchroom", "agents", name, ".vault-token");
    if (!existsSync(tokenPath)) {
      writeFileSync(tokenPath, "", { mode: 0o600 });
    }
    // Best-effort chown to the agent UID. allocateAgentUid is the
    // deterministic UID derivation used by every other per-agent
    // file (scaffold, broker chown-after-mint). Swallow EPERM on
    // dev hosts that don't have the permissions — the operator
    // running apply may not be root, and the existing .vault-token
    // is already correctly owned in that case.
    try {
      const uid = allocateAgentUid(name);
      chownSync(tokenPath, uid, uid);
    } catch {
      /* dev / no CAP_CHOWN — leave existing ownership */
    }
  }

  // Fleet directory — lane 1 (release-pinned invariants) and lane 2
  // (operator-owned fleet defaults) of the agent prompt cascade. The
  // dir is bind-mounted `:ro` into every agent at the same host-absolute
  // path (`src/agents/compose.ts`) and reaches the agent's `claude`
  // process via `--add-dir "$HOME/.switchroom/fleet"` set in
  // `profiles/_base/start.sh.hbs`. Claude Code native CLAUDE.md
  // discovery then loads `.md` files in this dir into the system
  // prompt. See epic #1850 + child issue #1852.
  //
  // L1 invariants: rendered from TypeScript constants
  // (TELEGRAM_GUIDANCE, MEMORY_GUIDANCE, SANDBOX_GUIDANCE in
  // scaffold.ts) via `renderFleetInvariants()`. Release-controlled,
  // checksum-restored on drift. Operator reads to know what every
  // agent is told; operator edits get reset on next apply.
  //
  // L2 fleet defaults: canonical content (operating principles,
  // privilege/approval map, concision norm, tool-family catalogue, and
  // the two-layer CLAUDE.md model) rendered from
  // `renderFleetDefaultsClaudeMd()` (src/agents/fleet-defaults.ts).
  // `writeIfMissing` semantics: seeded once, operator edits are preserved
  // across applies. Landed in epic issue #1855.
  const fleetDir = join(home, ".switchroom", "fleet");
  await mkdir(fleetDir, { recursive: true });
  const invariantsPath = join(fleetDir, "switchroom-invariants.md");
  const invariantsCanonical = renderFleetInvariants();
  const invariantsCurrent = existsSync(invariantsPath)
    ? readFileSync(invariantsPath, "utf-8")
    : null;
  if (invariantsCurrent !== invariantsCanonical) {
    writeFileSync(invariantsPath, invariantsCanonical, { mode: 0o644 });
  }
  const fleetClaudePath = join(fleetDir, "CLAUDE.md");
  if (!existsSync(fleetClaudePath)) {
    // writeIfMissing: seed the canonical L2 content once; never clobber an
    // operator-customised file. Opt-in refresh arrives in #1859.
    writeFileSync(fleetClaudePath, renderFleetDefaultsClaudeMd(), {
      mode: 0o644,
    });
  }
}

/**
 * Detect whether `docker compose` (the v2 plugin, not the deprecated
 * `docker-compose` v1 binary) is installed. Returns a friendly error
 * string explaining how to upgrade if it isn't, otherwise null.
 */
export function detectComposeV2(): string | null {
  try {
    const out = execFileSync("docker", ["compose", "version"], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    // v2 output looks like: "Docker Compose version v2.27.0".
    // v1 (`docker-compose`) wouldn't be invoked via this subcommand —
    // `docker compose` exits non-zero if only v1 is on PATH — so any
    // successful return here implies v2.
    if (!/Docker Compose version v?\d/.test(out)) {
      return `\`docker compose version\` returned unexpected output:\n${out.trim()}`;
    }
    return null;
  } catch {
    return (
      "`docker compose` (v2) not found. switchroom requires the Docker " +
      "Compose v2 plugin (the `docker compose` subcommand), not the " +
      "deprecated standalone `docker-compose` v1 binary.\n" +
      "Upgrade: https://docs.docker.com/compose/install/linux/"
    );
  }
}

/**
 * The directed error thrown when `switchroom apply`'s full per-agent
 * scaffold is attempted from *inside* an agent container. This is a dead
 * end by construction — not a bug to work around:
 *
 *   - HOME resolves to the container state dir (`/state/agent/home/
 *     .switchroom`), which has no vault, so the vault-missing preflight
 *     trips; and
 *   - the agent container ships no `docker compose` v2 plugin, so even
 *     with HOME pointed at the host home the compose-v2 preflight trips.
 *
 * A version roll does NOT need an agent to run a full apply: the
 * hostd-driven rollout already runs apply as `--compose-only` (skipping
 * the per-agent scaffold loop deliberately, #902) and each agent refreshes
 * its own per-agent templates from inside its own container on
 * restart-reconcile. So the roll completes without any full apply. This
 * message redirects the caller to that path instead of chasing the bare
 * "vault missing" / "docker compose v2 not found" errors.
 */
export const IN_AGENT_CONTAINER_APPLY_MSG =
  "`switchroom apply`'s full per-agent scaffold cannot run from inside an " +
  "agent container — this is a host/hostd operation by construction " +
  "(no vault at the container HOME, and no `docker compose` v2 plugin " +
  "here).\n" +
  "To roll the fleet to a new version, drive the hostd rollout " +
  "(`mcp__hostd__rollout`): it runs a `--compose-only` apply plus a " +
  "per-agent restart-reconcile, and each agent refreshes its own templates " +
  "on restart — the roll completes without any agent running a full apply.\n" +
  "A full host-side `sudo switchroom apply` is only needed for structural " +
  "changes (compose regeneration / new-agent scaffolding), and is run by " +
  "the operator on the host, never from inside an agent.";

/**
 * Detect that we're executing inside a switchroom agent container, where a
 * full `switchroom apply` is a structural dead end (see
 * IN_AGENT_CONTAINER_APPLY_MSG). Two independent signals, either is enough:
 *
 *   1. The agent-container env markers (`SWITCHROOM_AGENT_NAME` /
 *      `SWITCHROOM_AGENT_ROOT`), set by the agent wrapper; or
 *   2. the structural fingerprint — no vault at the resolved HOME AND no
 *      `docker compose` v2 — which is exactly the shape an agent container
 *      presents even if the env markers are somehow absent.
 */
export function isInAgentContainer(
  vaultPresent: boolean,
  composeV2Present: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.SWITCHROOM_AGENT_NAME || env.SWITCHROOM_AGENT_ROOT) {
    return true;
  }
  return !vaultPresent && !composeV2Present;
}

/**
 * Run the preflight gate. Fail fast (throws) when the config requires
 * vault-resolved secrets but ~/.switchroom/vault.enc is missing, or
 * when `docker compose` v2 is unavailable. Both conditions would have
 * surfaced as cryptic mid-apply / mid-up failures otherwise.
 *
 * When those conditions are actually the fingerprint of an agent
 * container (see isInAgentContainer), throw the DIRECTED
 * IN_AGENT_CONTAINER_APPLY_MSG instead of the bare vault/compose error, so
 * an agent chasing a full apply is pointed at the hostd rollout path
 * rather than a dead end. The genuine host case is unchanged.
 */
export function runApplyPreflight(
  config: SwitchroomConfig,
  opts: { detectComposeV2?: () => string | null } = {},
): void {
  const vaultPath = resolvePath(
    config.vault?.path ?? "~/.switchroom/vault.enc",
  );
  const detect = opts.detectComposeV2 ?? detectComposeV2;
  const vaultMissing = hasVaultRefs(config) && !existsSync(vaultPath);
  const composeErr = detect();

  // If this is an agent container, redirect to the hostd rollout path
  // BEFORE emitting the bare vault/compose errors that mislead the agent
  // into thinking apply is a step it can complete here.
  if (
    (vaultMissing || composeErr) &&
    isInAgentContainer(!vaultMissing, composeErr === null)
  ) {
    throw new Error(IN_AGENT_CONTAINER_APPLY_MSG);
  }

  if (vaultMissing) {
    throw new Error(
      `Config references vault keys (vault:<name>) but ${vaultPath} is missing. ` +
      `Run \`switchroom setup\` first to initialise the vault.`,
    );
  }
  if (composeErr) {
    throw new Error(composeErr);
  }
  // RFC G Phase 3b.5 — best-effort legacy `gdrive:<agent>:refresh_token`
  // detection. Reads vault slots only when SWITCHROOM_VAULT_PASSPHRASE
  // is set in the env (interactive prompts in preflight would block CI).
  // Without the passphrase the check is silently skipped — the agent
  // wrapper (Phase 3b.4) and `auth google account add` (Phase 3b.3
  // stub today) will catch the legacy slots when an operator actually
  // touches Google.
  detectAndReportLegacyGdriveSlots(vaultPath);
}

/**
 * RFC G Phase 3b.5 — print operator-actionable advisory if any legacy
 * RFC D `gdrive:<agent>:refresh_token` slots are present in the vault.
 * Refuses apply only when the operator has the passphrase available
 * AND legacy slots are detected — a mid-`apply` interactive prompt
 * would block CI / scripted invocations.
 *
 * Today: detection-only, prints advisory to stderr. A future Phase
 * 3b.5b will ship the actual interactive `switchroom auth google
 * migrate` verb that reads each legacy slot, prompts the operator to
 * attribute it to a Google account, writes to the new
 * `vault:google:<account>:refresh_token` shape, and deletes the
 * legacy slot. Until that lands, operators can manually use
 * `switchroom drive disconnect` + `auth google account add` to
 * migrate.
 */
function detectAndReportLegacyGdriveSlots(vaultPath: string): void {
  if (!existsSync(vaultPath)) return; // no vault, no slots to migrate
  const passphrase = process.env.SWITCHROOM_VAULT_PASSPHRASE;
  if (!passphrase) return; // best-effort: skip without prompting
  let slotKeys: string[];
  try {
    // Lazy-import to keep the apply hot path free of vault crypto when
    // the passphrase isn't available.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { listSecrets } = require("../vault/vault.js") as typeof import("../vault/vault.js");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { detectLegacyGdriveSlots } = require("../drive/vault-slots.js") as typeof import("../drive/vault-slots.js");
    slotKeys = listSecrets(passphrase, vaultPath);
    const legacy = detectLegacyGdriveSlots(slotKeys);
    if (legacy.length > 0) {
      const lines = [
        "",
        chalk.yellow(`⚠  Legacy RFC D Drive slots detected in vault:`),
        ...legacy.map((agent) => chalk.gray(`     gdrive:${agent}:refresh_token`)),
        chalk.yellow(`   These were created by the v0.6.0 \`switchroom drive connect <agent>\` flow.`),
        chalk.yellow(`   Per RFC G v3 §4.4 + Phase 3b.2c, Google credentials now live in the auth-broker`),
        chalk.yellow(`   under per-account labels (\`google:<email>:...\`) rather than per-agent slots.`),
        "",
        `   To migrate manually for each affected agent:`,
        chalk.cyan(`     1. Note the Google account each \`gdrive:<agent>\` slot was minted for`),
        chalk.cyan(`     2. switchroom drive disconnect <agent>           # revokes Google + clears slot`),
        chalk.cyan(`     3. switchroom auth google account add <email>    # mints new per-account slot`),
        chalk.cyan(`     4. switchroom auth google enable <email> <agent> # writes ACL to switchroom.yaml`),
        "",
        chalk.gray(`   Phase 3b.5b will ship an interactive \`switchroom auth google migrate\` verb`),
        chalk.gray(`   that automates this. \`apply\` is advisory-only for now — does not refuse.`),
        "",
      ];
      for (const line of lines) process.stderr.write(line + "\n");
    }
  } catch (err) {
    // Don't break apply over the legacy-slot check. If we can't open
    // the vault for any reason (wrong passphrase, corrupt file, etc.)
    // the operator's other vault-touching commands will surface a
    // clearer error.
    process.stderr.write(
      chalk.gray(`  (skipping legacy-slot check: ${(err as Error).message})\n`),
    );
  }
}

/**
 * Write `~/.switchroom/install-type.json` so the hostd daemon (and any
 * other reader) can discover how this host's switchroom CLI is
 * installed without re-running the detector on every audit row.
 *
 * `apply` is the canonical cache invalidator: it runs every time the
 * operator changes anything, so a stale cache can only persist across
 * one apply cycle. Idempotent — overwrites unconditionally.
 *
 * Atomic write via `.tmp + renameSync` so a SIGKILL mid-write never
 * leaves a torn JSON on disk. Mode 0o644 (world-readable) so the hostd
 * container can read the bind-mounted host-home copy without needing
 * matching uid.
 *
 * Exported for the apply.test.ts cache-write assertion.
 */
export function writeInstallTypeCache(homeDir: string = homedir()): string {
  const ctx = detectInstallType();
  const dir = join(homeDir, ".switchroom");
  const out = join(dir, "install-type.json");
  const tmp = `${out}.tmp`;
  mkdirSync(dir, { recursive: true });
  const payload = {
    install_type: ctx.install_type,
    detected_at: new Date().toISOString(),
    source_paths: ctx.source_paths,
  };
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o644 });
  renameSync(tmp, out);
  return out;
}

/**
 * Pure orchestrator. Exported for unit tests and the deprecation aliases
 * (`switchroom up`, `switchroom init`) which forward straight to here.
 *
 * Ordering matters: scaffold first (so compose-generation sees a
 * well-formed agents directory), compose write second.
 */
export async function runApply(
  config: SwitchroomConfig,
  options: ApplyOptions,
  deps: ApplyDeps = {},
  switchroomConfigPath?: string,
): Promise<ApplyResult> {
  const writeOut = deps.writeOut ?? ((s) => process.stdout.write(s));
  const writeErr = deps.writeErr ?? ((s) => process.stderr.write(s));

  // Fail-fast on missing prerequisites before we touch anything.
  // Both checks throw with operator-actionable messages; the action
  // wrapper catches and prints them red.
  runApplyPreflight(config, { detectComposeV2: deps.detectComposeV2 });

  // Refresh the install-type cache early so downstream readers (hostd
  // daemon, audit-row population) see up-to-date detection. Fail-soft:
  // a write failure (read-only filesystem etc.) is logged but does not
  // block the apply.
  try {
    writeInstallTypeCache();
  } catch (err) {
    writeErr(
      chalk.gray(
        `  (install-type cache write failed: ${(err as Error).message})\n`,
      ),
    );
  }

  const agentsDir = resolveAgentsDir(config);
  const allAgentNames = Object.keys(config.agents);

  // --only=<name> narrows the scaffold+align loop to a single agent.
  // Compose generation still walks the FULL fleet (all 8 agents are in
  // the YAML; the singletons need to know about each named agent for
  // the per-agent socket volumes). Only the per-agent state-dir touches
  // are scoped.
  if (options.only !== undefined && !allAgentNames.includes(options.only)) {
    throw new Error(
      `apply --only=${options.only}: no such agent in switchroom.yaml. ` +
      `Defined agents: ${allAgentNames.join(", ")}.`,
    );
  }
  const agentNames =
    options.only !== undefined ? [options.only] : allAgentNames;

  writeOut(chalk.bold("\nApplying switchroom config...\n"));
  if (options.only !== undefined) {
    writeOut(
      chalk.gray(
        `  (--only=${options.only}: scaffolding/aligning this agent only; ` +
        `compose still covers all ${allAgentNames.length})\n`,
      ),
    );
  }

  // Shared vault-broker ACL reader for the per-agent connection-health
  // snapshot written below (read by the boot card's probeConnections). Soft-
  // fails to "unreachable" → refreshAgentConnectionHealth then emits zero
  // issues (auth assumed), so a down/locked broker never false-flags an agent.
  const connHealthVaultAclReader = async (key: string): Promise<VaultAclResult> => {
    try {
      const { getViaBrokerStructured } = await import("../vault/broker/client.js");
      const result = await getViaBrokerStructured(key);
      if (result.kind === "ok") {
        return {
          kind: "ok",
          allow: result.entry.scope?.allow ?? [],
          deny: result.entry.scope?.deny ?? [],
        };
      }
      if (result.kind === "not_found") return { kind: "not_found" };
      return { kind: "unreachable", msg: result.msg };
    } catch (err) {
      return { kind: "unreachable", msg: (err as Error).message };
    }
  };

  // Seed the bundled-skills pool if this host has never run `switchroom
  // update` (#4163). Without it the FIRST apply after a `curl … | sh` install
  // scaffolds every agent against an empty pool and skips every bundled skill.
  // Bootstrap-only and soft-failing — see bootstrap-skills-pool.ts.
  if (options.composeOnly !== true) {
    const seed = bootstrapBundledSkillsPool();
    if (seed.status === "seeded") {
      writeOut(
        chalk.gray(
          `  Seeded bundled skills pool (${seed.skills} skills) from ${seed.source}\n`,
        ),
      );
    }
  }

  // ── 1. Scaffold each agent ────────────────────────────────────────
  let scaffolded = 0;
  const failures: ScaffoldFailure[] = [];
  // Sentinel-typed error class so the outer per-agent try/catch can
  // re-raise UID alignment failures without swallowing them as a soft
  // `x ${name}` log line.
  class UidAlignmentAbort extends Error {}
  // composeOnly skips the entire scaffold pass — for CI / scripts that
  // can't chown into per-agent state dirs and only need a fresh
  // compose yaml. Issue #902 / `--compose-only` flag.
  const skipScaffold = options.composeOnly === true;
  for (const name of skipScaffold ? [] : agentNames) {
    const agentConfig = config.agents[name];
    try {
      const result = scaffoldAgent(
        name,
        agentConfig,
        agentsDir,
        config.telegram,
        config,
        undefined,
        switchroomConfigPath,
      );
      const detail =
        result.created.length > 0
          ? `${result.created.length} files created`
          : "up to date";
      writeOut(
        chalk.green(`  + ${name}`) +
          chalk.gray(` (${agentConfig.extends ?? "default"}) — ${detail}\n`),
      );
      // PR C: install the UserPromptSubmit hook that surfaces
      // mid-conversation MCP-originated update_apply outcomes. Fail-soft
      // — a hook install failure should never break apply.
      try {
        installUpdatePromptHook(join(agentsDir, name));
      } catch (hookErr) {
        writeOut(
          chalk.gray(
            `    (update-prompt hook install failed for ${name}: ${(hookErr as Error).message})\n`,
          ),
        );
      }
      // Connection-health snapshot for the boot card's probeConnections
      // (configured-but-unauthed MCP integrations). Computed host-side here
      // because the in-container boot probe can't query the broker. Written
      // BEFORE alignAgentUid so the chown below covers the file. Best-effort
      // (refreshAgentConnectionHealth never throws) — must never break apply.
      await refreshAgentConnectionHealth(config, name, join(agentsDir, name), {
        vaultAclReader: connHealthVaultAclReader,
      });

      // Align per-agent dir ownership with the container UID assigned
      // by compose.ts. Without this the bind-mount lands read-only
      // for the in-container UID and the agent fails on first write.
      try {
        const uid = allocateAgentUid(name);
        alignAgentUid(name, join(agentsDir, name), uid, {
          confirm: !options.nonInteractive,
          writeOut,
        });
      } catch (alignErr) {
        const msg = (alignErr as Error).message;
        if (options.allowUnaligned) {
          writeOut(
            chalk.yellow(
              `    ! could not chown ${name} state dir: ${msg}\n` +
              `      continuing because --allow-unaligned was passed; agent may fail on first write.\n`,
            ),
          );
        } else {
          writeOut(
            chalk.red(
              `    x could not chown ${name} state dir: ${msg}\n` +
              `      The bind-mounted state dir must be owned by the container's UID or the agent will fail on first write.\n` +
              `      Fix: run \`switchroom apply\` from a TTY so it can prompt for sudo, OR run the suggested chown manually, OR re-run with --allow-unaligned to skip this check.\n`,
            ),
          );
          throw new UidAlignmentAbort(
            `UID alignment failed for agent ${name}; aborting apply (pass --allow-unaligned to override).`,
          );
        }
      }
      scaffolded++;
    } catch (err) {
      if (err instanceof UidAlignmentAbort) throw err;
      const message = (err as Error).message;
      writeOut(chalk.red(`  x ${name}: ${message}\n`));
      failures.push({ agent: name, message });
    }
  }
  if (skipScaffold) {
    writeOut(
      chalk.gray(
        `  (--compose-only: skipped per-agent scaffold for ${agentNames.length} agent(s))\n`,
      ),
    );
  }

  // ── 1a. Flush in-flight Hindsight bank ops ───────────────────────
  //
  // scaffoldAgent starts its bank chain (create → read retain_mission → push
  // missions → mental models) fire-and-forget, because scaffoldAgent itself is
  // synchronous. Normally node drains those before exiting, but the vault
  // phases below hard-`process.exit()` on codes 4/5/6 AFTER this point, which
  // would truncate a push mid-flight — a window the retain-mission read (up to
  // 5s per agent) widened. Draining here makes the ordering deterministic
  // instead of dependent on how apply happens to terminate. Bounded: on
  // timeout we carry on, because apply is idempotent and the next run
  // re-pushes. (2026-07-25 re-review L2.)
  if (!skipScaffold) {
    const flushed = await flushPendingBankOps();
    if (!flushed) {
      writeOut(
        chalk.yellow(
          "  ⚠ Hindsight bank updates still in flight after 15s — continuing; re-run apply to retry.\n",
        ),
      );
    }
  }

  // ── 1b. LiteLLM per-agent virtual-key provisioning (opt-in) ───────
  //
  // For each agent whose effective config has `litellm.enabled` true,
  // provision a per-agent LiteLLM virtual key under the "switchroom" team,
  // store it in the vault at `litellm/<agent>/api-key`, and grant the agent
  // read-ACL by adding the key to its standing `secrets[]` (the broker mints
  // the agent's read/rotate ACL from that list — same mechanism linear-agent
  // uses). Idempotent: if the vault already holds the key, we skip. Failures
  // are accumulated into `failures` (non-fatal — provisioning a key must
  // never block the rest of apply). Entirely gated behind `litellm.enabled`,
  // so it's zero-impact when off. See reference/rfcs (litellm) + schema.
  if (!skipScaffold) {
    await provisionLiteLLMKeys(config, agentNames, switchroomConfigPath, {
      writeOut,
      writeErr,
      failures,
      home: homedir(),
    });
  }

  // ── 2. Pre-create host mount sources ──────────────────────────────
  // Why: docker auto-creates a missing bind-mount source as an empty
  // directory owned by ROOT (because dockerd runs as root). That has
  // bitten v0.7 installs twice — root-owned `~/.switchroom/vault` and
  // `~/.switchroom/vault-auto-unlock` stubs that then blocked the user
  // from moving the real files into place. Eagerly mkdir'ing as the
  // current shell user keeps the source dirs operator-owned.
  // Files (vault.enc, vault-auto-unlock blob) are NOT created here —
  // they're written by `switchroom setup` / vault commands and we
  // shouldn't fabricate empty placeholders. If they're missing, the
  // broker handles that gracefully (vault.enc missing => apply
  // preflight already errors; auto-unlock missing => broker falls
  // back to interactive unlock).
  await ensureHostMountSources(config);

  // ── 2b. Re-align per-agent log dir ownership ─────────────────────
  //
  // `ensureHostMountSources` just created `~/.switchroom/logs/<agent>`
  // as the host operator UID (because mkdir runs as the operator).
  // The per-agent scaffold loop above already called `alignAgentUid`,
  // but at that point the log dir didn't exist yet (existsSync gate
  // in scaffold.ts:194 for the log dir), so it was silently skipped — leaving the
  // dir operator-owned. start.sh inside the container runs as the
  // per-agent UID and bind-mounts `~/.switchroom/logs/<agent>` to
  // `/var/log/switchroom`; it then hits "Permission denied" trying
  // to write supervisor logs and the autoaccept / gateway / scheduler
  // sidecars never start. Re-run alignment now that the dir exists.
  // Install-validation finding #21.
  // Iterate `agentNames` (which respects `--only`), NOT
  // `Object.keys(config.agents)` — otherwise `apply --only=<name>`
  // would sudo-chown every agent's state tree on every run, defeating
  // the migration playbook documented on `ApplyOptions.only`.
  //
  // Failure shape: this second pass is non-fatal regardless of
  // `--allow-unaligned`. The first-pass alignAgentUid at line 443
  // aborts on hard chown failure (UidAlignmentAbort), so by the time
  // we reach the second pass the state-dir ownership is already
  // correct — only the log dir is at risk of misalignment, and a
  // log-dir EACCES surfaces visibly on the agent's first boot via
  // start.sh's supervise restart-loop. We always warn so the operator
  // has the actionable breadcrumb if first-boot fails.
  if (!skipScaffold) {
    for (const name of agentNames) {
      try {
        const uid = allocateAgentUid(name);
        alignAgentUid(name, join(agentsDir, name), uid, {
          confirm: !options.nonInteractive,
          writeOut,
        });
      } catch (alignErr) {
        const msg = (alignErr as Error).message;
        writeOut(
          chalk.yellow(
            `    ! post-mount-source UID re-align failed for ${name}: ${msg}\n` +
              `      Agent may fail to write supervisor logs on first boot.\n`,
          ),
        );
      }
    }
  }

  // ── 2c. Vault layout migration (v0.7.12) ─────────────────────────
  //
  // Move the legacy single-file vault layout (~/.switchroom/vault.enc)
  // to a parent-dir layout (~/.switchroom/vault/vault.enc + symlink at
  // the legacy path). Single-file bind mount made atomic-rename
  // impossible inside the broker container (#954), and that blocked
  // op:put rotation (#952 dead-on-arrival). Parent-dir mount fixes
  // both. State machine + flock + recovery message in
  // `src/vault/migrate-layout.ts`.
  //
  // State E (divergence) is fatal: print recovery recipe + exit. If
  // operator follows the recipe and re-runs, state becomes A/D and
  // apply proceeds.
  const vaultPathConfigured = config.vault?.path;
  const customVaultPath = vaultPathConfigured
    ? resolvePath(vaultPathConfigured)
    : undefined;
  const migrationResult = migrateVaultLayout(homedir(), {
    customVaultPath,
  });
  switch (migrationResult.kind) {
    case "no-vault":
      // Fresh install. Nothing to do; broker will fall through to
      // interactive unlock.
      break;
    case "already-migrated":
      // Operator re-ran apply; layout already correct.
      break;
    case "completed-partial":
      writeOut(chalk.green("✓ Completed partial vault layout migration\n"));
      break;
    case "migrated":
      writeOut(chalk.green("✓ Migrated vault to ~/.switchroom/vault/vault.enc\n"));
      writeOut(chalk.gray("  Legacy path is now a symlink for v0.7.10/.11 CLI compatibility (sunset in v0.7.14)\n"));
      break;
    case "custom-path-skipped":
      writeOut(chalk.gray(
        `Skipped vault layout migration: custom vault.path = ${migrationResult.path}\n`,
      ));
      break;
    case "divergent":
      writeErr(formatDivergentRecoveryMessage(migrationResult.details));
      process.exit(4);
  }

  // ── 2d. Post-migration verification (plan v3 §6 invariant) ───────
  //
  // Re-inspect disk state — must report A (fresh install with no
  // vault yet), D (post-migration), or custom-path-skipped before
  // compose-gen runs. Any other state means the migration step
  // didn't converge to a state the broker can serve, which would
  // produce a confusing failure later. Guard with a clear error
  // surfacing what state we landed in.
  const postMigrationInspect = inspectVaultLayout(homedir());
  const acceptable: Array<MigrationResult["kind"]> = [
    "no-vault",
    "already-migrated",
    "custom-path-skipped",
    "migrated",          // dry-run inspect of state-B reports "migrated" too
    "completed-partial", // dry-run inspect of state-C reports the same
  ];
  if (!acceptable.includes(postMigrationInspect.kind)) {
    writeErr(chalk.red(
      `Post-migration verification failed: state is ${postMigrationInspect.kind}\n` +
      `Expected one of: ${acceptable.join(", ")}\n` +
      `This is a switchroom bug — please file an issue with the apply log.\n`,
    ));
    process.exit(5);
  }

  // ── 2e. Vault dir contents guard (plan v3 §3 + R3 round 2) ─────
  //
  // Refuse to bind-mount the vault parent dir if it contains files
  // outside saveVault's known-artifacts list. Prevents docker from
  // bind-mounting unexpected operator content into the broker
  // container (e.g. an editor's swap file, a misplaced backup) AND
  // surfaces operator-side oddities loudly. Whitelist sourced from
  // KNOWN_VAULT_ARTIFACT_NAMES + KNOWN_VAULT_ARTIFACT_PATTERNS in
  // src/vault/vault.ts so future write artifacts are picked up
  // without editing two places.
  //
  const vaultDir = resolveVaultBindMountDir(homedir(), {
    migrationKind: migrationResult.kind,
    customVaultPath,
  });
  const vaultGuardResult = inspectVaultBindMountDir(vaultDir);
  if (vaultGuardResult.kind === "unexpected-files") {
    const unknown = vaultGuardResult.unknown;
    writeErr(chalk.red(
      `Vault directory ${vaultDir} contains unexpected files:\n` +
      unknown.map((n) => `  - ${n}\n`).join("") +
      `Refusing to bind-mount: a docker bind-mount source is the\n` +
      `entire directory, so unexpected files would be visible inside\n` +
      `the broker container. Move them out, then re-run apply.\n` +
      `Known artifacts: vault.enc, vault.enc.bak, vault.enc.tmp,\n` +
      `vault.enc.lock (PID-file flock from saveVault), and\n` +
      `.vault.enc.<pid>.<ms>.tmp (atomicWriteFileSync sibling-tmp).\n`,
    ));
    process.exit(6);
  }

  // ── 3. Generate compose file ──────────────────────────────────────
  const composePath = options.outPath ?? DEFAULT_COMPOSE_PATH;
  // Display-only host path for the operator hints below. When apply runs INSIDE
  // the hostd container, homedir() is the in-container HOME (/host-home), so
  // composePath/DEFAULT_COMPOSE_PATH point at a path no host operator can
  // copy-paste into `docker compose -f …`. Translate to the real host home via
  // SWITCHROOM_HOST_HOME (same helper that fixes baked scaffold paths). The
  // file is still WRITTEN to composePath (the bind-mounted container path) —
  // only the printed strings change. No-op on the host (helper returns input).
  const displayComposePath = toHostHomePath(composePath);
  // Capture the host operator UID so the broker can chown its operator
  // socket at bind time. Under sudo, `process.getuid()` returns 0 (root)
  // — what we actually want is the underlying user's UID, which sudo
  // exposes via SUDO_UID. Fall back to getuid() when SUDO_UID is unset
  // or unparseable. On Windows / non-POSIX, getuid is unavailable; the
  // operator listener simply isn't bound (broker skips when env var
  // is unset).
  const operatorUid: number | undefined = resolveOperatorUid();
  // Generate + write the compose. Release block priority: CLI --channel/--pin
  // override → root `release` → default latest (via resolveImageTag's undefined
  // fallback). Per-agent `release` overrides aren't plumbed through to compose
  // tag selection yet — compose emits one image tag for the whole fleet.
  //
  // Shared with the `agent restart` reconcile path via writeComposeFile so the
  // two can NEVER drift — and so a `release.pin` bump applies on a plain
  // restart, not only via apply (memory `agent-restart-needs-apply-for-pin`).
  const { bytes: composeBytes } = await writeComposeFile({
    config,
    composePath,
    switchroomConfigPath,
    releaseOverride: options.releaseOverride,
    buildMode: options.buildLocal ? "local" : "pull",
    buildContext: options.buildContext,
  });

  // ── 3b. Voice-sidecar token (PR-B2) ───────────────────────────────
  // On a `local` voice verdict the compose emits a `voice-sidecar` service
  // whose env reads `${VOICE_SIDECAR_TOKEN}`. Seed the shared secret in the
  // vault (idempotent) and write it to the compose-adjacent `.env` (0600)
  // so docker's interpolation populates the container env — the secret is
  // never baked into the YAML. No-op on a cloud verdict.
  if (!skipScaffold) {
    const { provisionVoiceSidecarToken } = await import("./voice-sidecar-token.js");
    await provisionVoiceSidecarToken(composePath, homedir(), {
      writeOut,
      writeErr,
      operatorUid,
    });
  }

  writeOut(
    chalk.bold(`\nWrote `) +
      displayComposePath +
      chalk.gray(` (${composeBytes} bytes)\n`),
  );
  writeOut(
    `Bring the fleet up with:\n` +
      `  docker compose -p ${COMPOSE_PROJECT} -f ${displayComposePath} pull && \\\n` +
      `    docker compose -p ${COMPOSE_PROJECT} -f ${displayComposePath} up -d --remove-orphans\n`,
  );
  writeOut(
    chalk.gray(
      `  (If pull returns 401, login to ghcr.io first: see docs/operators/install.md#ghcr-auth)\n`,
    ),
  );

  // Prevention (#1473): a self-elevated (sudo) apply just re-rendered
  // the vault/audit/accounts/compose artifacts AS ROOT (migrateVaultLayout
  // et al.). Restore operator ownership so `switchroom vault …` keeps
  // working instead of silently EACCES-ing (the broker masks it via
  // CAP_DAC_READ_SEARCH). No-op when not elevated or the operator uid
  // is unknown; per-agent dirs are owned by alignAgentUid and untouched.
  if (process.geteuid?.() === 0 && operatorUid !== undefined) {
    const restored = restoreOperatorOwnership(homedir(), operatorUid);
    if (restored.length > 0) {
      writeOut(
        chalk.gray(
          `  Restored operator ownership of ${restored.length} ~/.switchroom path(s)\n`,
        ),
      );
    }
  }

  writeOut(
    chalk.bold(
      `\nDone. Scaffolded ${scaffolded}/${allAgentNames.length} agents.\n`,
    ),
  );

  return {
    scaffolded,
    agentsTotal: allAgentNames.length,
    composePath,
    composeBytes,
    failures,
  };
}

/**
 * Read-only probe of the LiteLLM per-agent (and hindsight-service)
 * virtual-key provisioning state. Mirrors the split that
 * `provisionLiteLLMKeys` computes, but performs NO writes — used by the
 * `apply --dry-run` path to report vault-provisioning gaps before a real
 * apply mutates anything.
 *
 * `passphraseAvailable` reports whether the operator vault passphrase can
 * be recovered non-interactively (env or machine-id auto-unlock blob) — a
 * NEW key can only be provisioned when it is. `unprovisionedNew` are
 * opted-in agents with no key in the vault yet; `brokerUnreachable` are
 * agents we couldn't verify because the broker socket wasn't reachable
 * (an environment limitation, not a hard failure).
 */
export async function probeVaultProvisioning(
  config: SwitchroomConfig,
  agentNames: string[],
  home: string,
): Promise<{
  optedInCount: number;
  passphraseAvailable: boolean;
  alreadyProvisioned: string[];
  unprovisionedNew: string[];
  brokerUnreachable: string[];
  needsHindsight: boolean;
}> {
  const optedIn: string[] = [];
  for (const name of agentNames) {
    const agentConfig = config.agents[name];
    if (!agentConfig) continue;
    const resolved = resolveAgentConfig(config.defaults, config.profiles, agentConfig);
    if (effectiveLiteLLMEnabled(config, resolved.litellm)) optedIn.push(name);
  }
  const needsHindsight =
    (config as { litellm?: { enabled?: boolean } }).litellm?.enabled === true &&
    (config as { memory?: { backend?: string } }).memory?.backend === "hindsight";

  const passphraseAvailable = (await resolveOperatorVaultPassphrase(home)) !== null;

  const alreadyProvisioned: string[] = [];
  const unprovisionedNew: string[] = [];
  const brokerUnreachable: string[] = [];

  if (optedIn.length > 0) {
    const { getViaBrokerStructured } = await import("../vault/broker/client.js");
    for (const name of optedIn) {
      const existing = await getViaBrokerStructured(`litellm/${name}/api-key`);
      if (existing.kind === "ok") alreadyProvisioned.push(name);
      else if (existing.kind === "unreachable") brokerUnreachable.push(name);
      else unprovisionedNew.push(name); // not_found / denied
    }
  }

  return {
    optedInCount: optedIn.length,
    passphraseAvailable,
    alreadyProvisioned,
    unprovisionedNew,
    brokerUnreachable,
    needsHindsight,
  };
}

/**
 * Parse the top-level service names out of a generated compose YAML.
 *
 * Re-exported from `write-compose.ts`, which needs the same parse to attribute
 * a dropped `voice-sidecar` and cannot import from here (cycle).
 */
export { parseComposeServiceNames };

export interface ApplyDryRunResult {
  /** Conditions that would make a real apply exit non-zero. */
  blocking: string[];
  /** Non-fatal advisories (a real apply would still succeed). */
  warnings: string[];
  /** Informational lines (would-change summary, would-provision, etc.). */
  info: string[];
  /** Agent image tag a real apply would bake into the compose. */
  imageTag: string | null;
  /** Agent image tag currently on disk, or null. */
  previousImageTag: string | null;
  /** True when the would-be compose differs from what's on disk. */
  composeChanged: boolean;
  /** Service names present in the new compose but not the old. */
  addedServices: string[];
  /** Service names present in the old compose but not the new. */
  removedServices: string[];
  /** True when a real apply would succeed (no blocking conditions). */
  wouldSucceed: boolean;
}

/**
 * `apply --dry-run` — run the full compose-regeneration + validation
 * pipeline IN MEMORY and report what a real apply would do, WITHOUT
 * writing the compose file, persisting anything, or touching a container.
 *
 * Catches the failure modes that the v0.17.0 rollout surfaced only AFTER
 * the real apply had already started mutating state:
 *   - profile-resolution failures (`Profile not found: default …`);
 *   - vault-broker unreachable (can't verify/provision keys);
 *   - vault passphrase unavailable for NEW keys that need provisioning.
 *
 * Returns a structured result; the CLI handler exits non-zero when
 * `wouldSucceed` is false. Deliberately does NOT call `runApply`,
 * `writeComposeFile`, `scaffoldAgent`, `alignAgentUid`, or any broker
 * reload — every step here is read-only.
 */
export async function runApplyDryRun(
  config: SwitchroomConfig,
  options: ApplyOptions,
  deps: ApplyDeps = {},
  switchroomConfigPath?: string,
): Promise<ApplyDryRunResult> {
  const writeOut = deps.writeOut ?? ((s) => process.stdout.write(s));
  const writeErr = deps.writeErr ?? ((s) => process.stderr.write(s));

  const blocking: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];

  writeOut(
    chalk.bold("\nDry-run: validating switchroom config (no changes will be written)...\n"),
  );

  // ── 1. Preflight (vault present, docker compose v2, agent-container guard)
  try {
    runApplyPreflight(config, { detectComposeV2: deps.detectComposeV2 });
  } catch (err) {
    blocking.push(`preflight: ${(err as Error).message}`);
  }

  const allAgentNames = Object.keys(config.agents ?? {});
  const agentNames =
    options.only !== undefined ? [options.only] : allAgentNames;
  if (options.only !== undefined && !allAgentNames.includes(options.only)) {
    blocking.push(
      `apply --only=${options.only}: no such agent in switchroom.yaml ` +
      `(defined: ${allAgentNames.join(", ") || "none"}).`,
    );
  }

  // ── 2. Profile resolution — the #1 thing rollout --dry-run missed.
  for (const name of agentNames) {
    const agentConfig = config.agents[name];
    if (!agentConfig) continue;
    const profileName = agentConfig.extends ?? "default";
    try {
      getProfilePath(profileName);
      // Also exercise the cascade merge so a malformed profile block fails here.
      resolveAgentConfig(config.defaults, config.profiles, agentConfig);
    } catch (err) {
      blocking.push(
        `profile '${profileName}' for agent '${name}': ${(err as Error).message}`,
      );
    }
  }

  // ── 3. Vault provisioning gaps (broker reachability + new-key passphrase).
  try {
    const probe = await probeVaultProvisioning(config, agentNames, homedir());
    if (probe.alreadyProvisioned.length > 0) {
      info.push(
        `litellm: ${probe.alreadyProvisioned.length} agent(s) already provisioned ` +
        `(${probe.alreadyProvisioned.join(", ")}).`,
      );
    }
    if (probe.brokerUnreachable.length > 0) {
      // #2781: unreachable broker is an environment limitation, not a hard
      // failure — a real apply degrades to a warning and keeps previous env.
      warnings.push(
        `litellm: vault-broker unreachable — could not verify/provision ` +
        `${probe.brokerUnreachable.length} agent(s) ` +
        `(${probe.brokerUnreachable.join(", ")}); they keep their previous routing env.`,
      );
    }
    const pending = [
      ...probe.unprovisionedNew,
      ...(probe.needsHindsight ? ["hindsight (service)"] : []),
    ];
    if (pending.length > 0) {
      if (probe.passphraseAvailable) {
        info.push(
          `litellm: would provision ${pending.length} new virtual key(s) ` +
          `(${pending.join(", ")}) — vault passphrase is available.`,
        );
      } else {
        // Mirrors provisionLiteLLMKeys pushing these to failures[] → exit 1.
        blocking.push(
          `litellm: ${pending.length} agent(s)/service(s) need a NEW vault key ` +
          `(${pending.join(", ")}) but the vault passphrase is unavailable ` +
          `(no SWITCHROOM_VAULT_PASSPHRASE env and machine-id auto-unlock blob ` +
          `missing/undecryptable) — a real apply could not provision them.`,
        );
      }
    }
  } catch (err) {
    warnings.push(`litellm: provisioning probe failed — ${(err as Error).message}`);
  }

  // ── 4. Compute the would-be compose IN MEMORY (no write).
  let imageTag: string | null = null;
  let previousImageTag: string | null = null;
  let composeChanged = false;
  let addedServices: string[] = [];
  let removedServices: string[] = [];
  try {
    const computed = await computeComposeContent({
      config,
      composePath: options.outPath ?? DEFAULT_COMPOSE_PATH,
      switchroomConfigPath,
      releaseOverride: options.releaseOverride,
      buildMode: options.buildLocal ? "local" : "pull",
      buildContext: options.buildContext,
    });
    imageTag = computed.imageTag;
    previousImageTag = computed.previousImageTag;
    composeChanged = computed.previous !== computed.content;
    const newServices = parseComposeServiceNames(computed.content);
    const oldServices = computed.previous
      ? parseComposeServiceNames(computed.previous)
      : [];
    addedServices = newServices.filter((s) => !oldServices.includes(s));
    removedServices = oldServices.filter((s) => !newServices.includes(s));

    if (previousImageTag === null) {
      info.push(`compose: no existing compose on disk — a real apply would create it.`);
    } else if (previousImageTag !== imageTag) {
      info.push(
        `compose: agent image would change ${previousImageTag} → ${imageTag}.`,
      );
    } else {
      info.push(`compose: agent image unchanged (${imageTag}).`);
    }
    if (addedServices.length > 0) {
      info.push(`compose: services added: ${addedServices.join(", ")}.`);
    }
    if (removedServices.length > 0) {
      info.push(`compose: services removed: ${removedServices.join(", ")}.`);
    }
    // An unattributed `services removed: voice-sidecar` reads as intent. When
    // the removal is only a defaulted verdict, say so — and as a WARNING, not
    // an info line, because the operator is about to delete a running service
    // on evidence switchroom does not actually have.
    if (computed.voiceSidecarDrop) {
      warnings.push(`compose: ${computed.voiceSidecarDrop.message}`);
    }
    if (previousImageTag !== null && !composeChanged) {
      info.push(`compose: no change (would be byte-identical to the current file).`);
    }
  } catch (err) {
    blocking.push(`compose generation: ${(err as Error).message}`);
  }

  // ── 5. Report ─────────────────────────────────────────────────────
  for (const line of info) writeOut(chalk.gray(`  ~ ${line}\n`));
  for (const line of warnings) writeErr(chalk.yellow(`  ! ${line}\n`));
  for (const line of blocking) writeErr(chalk.red(`  x ${line}\n`));

  const wouldSucceed = blocking.length === 0;
  writeOut("\n");
  if (wouldSucceed) {
    writeOut(
      chalk.green.bold(
        `Dry-run: a real apply would SUCCEED. ` +
        `${allAgentNames.length} agent(s) validated; nothing was written.\n`,
      ),
    );
  } else {
    writeErr(
      chalk.red.bold(
        `Dry-run: a real apply would FAIL — ${blocking.length} blocking ` +
        `condition(s) above. Nothing was written.\n`,
      ),
    );
  }

  return {
    blocking,
    warnings,
    info,
    imageTag,
    previousImageTag,
    composeChanged,
    addedServices,
    removedServices,
    wouldSucceed,
  };
}

/**
 * Resolution block printed when one or more agents fail to scaffold.
 * Tells the operator their two real options (sudo or `--compose-only`)
 * so the next step is obvious. Returns the formatted string so the
 * CLI handler can write it directly and tests can pin the shape.
 *
 * NOTE on what's intentionally NOT in this block: dropping
 * `--non-interactive` (i.e. running interactive `switchroom apply`)
 * does NOT fix the post-alignment EACCES. The per-agent loop calls
 * scaffoldAgent BEFORE alignAgentUid, so on a fleet whose state dirs
 * are already mode 0700 owned by the per-agent UID (the v0.7+ steady
 * state), scaffoldAgent fails with EACCES before alignAgentUid's
 * sudo prompt can ever fire. The interactive sudo-prompt path only
 * works on a fresh, pre-alignment fleet — exactly the case the bug
 * doesn't manifest in. Documented here so the next reader doesn't
 * "helpfully" add a misleading "run interactively" resolution back.
 */
export function formatScaffoldFailureResolution(
  failures: ScaffoldFailure[],
  scaffolded: number,
  agentsTotal: number,
): string {
  const fail = failures.length;
  const lines: string[] = [];
  lines.push("");
  lines.push(
    `ERROR: Scaffolded ${scaffolded}/${agentsTotal} agents. ${fail} failed.`,
  );
  lines.push("");
  // #2781: the 0700/privilege-escalation guidance below is only the right
  // diagnosis when at least one failure actually IS a permission failure.
  // Printing it for, e.g., litellm/vault failures misdirected operators at
  // sudo when the problem was elsewhere. Non-permission failures get a
  // generic pointer at the per-agent error lines instead.
  const hasPermissionFailure = failures.some((f) =>
    /EACCES|EPERM|permission denied/i.test(f.message),
  );
  if (!hasPermissionFailure) {
    lines.push(
      `${fail} agent(s) failed to scaffold — see the per-agent error lines above`,
    );
    lines.push("for the specific cause(s).");
    lines.push("");
    return lines.join("\n");
  }
  lines.push(
    "Per-agent state dirs are mode 0700 owned by per-agent UIDs (the v0.7+",
  );
  lines.push(
    "docker model). The operator cannot write into them without privilege",
  );
  lines.push("escalation.");
  lines.push("");
  lines.push("Resolutions:");
  lines.push("  1. Re-run interactively — apply will prompt to escalate via sudo:");
  lines.push("       switchroom apply");
  lines.push("     (Auto-detects unwritable per-agent dirs, prompts before");
  lines.push("     re-execing under sudo, then refreshes start.sh / .mcp.json /");
  lines.push("     settings.json. Avoids the `sudo -E bun /path/to/dist/...`");
  lines.push("     incantation #920 used to require.)");
  lines.push("");
  lines.push("  2. Regenerate compose only, skip per-agent scaffold:");
  lines.push("       switchroom apply --non-interactive --compose-only");
  lines.push("     Use this if you only changed compose-level fields and don't");
  lines.push("     need to refresh per-agent files.");
  lines.push("");
  return lines.join("\n");
}

/**
 * Copy an example switchroom.yaml into cwd. Mirrors the previous
 * `switchroom init --example <name>` behaviour so users (and the
 * `init` deprecation alias) keep working.
 */
function copyExampleConfig(name: string): void {
  if (!/^[a-z0-9_-]+$/.test(name)) {
    throw new Error(
      `Invalid example name: ${name} (must match /^[a-z0-9_-]+$/)`,
    );
  }

  const dest = resolve(process.cwd(), "switchroom.yaml");

  if (existsSync(dest)) {
    console.error(
      chalk.yellow(
        "switchroom.yaml already exists — skipping example copy",
      ),
    );
    return;
  }

  // Embedded, with no disk fallback. The old fallback read
  // `resolve(import.meta.dirname, "../../examples/…")`, which is `/examples/…`
  // inside the compiled binary — it could only ever succeed in a source
  // checkout, so it made dev and release behave differently on the one path
  // where that difference is invisible until a user hits it (#4163).
  const embedded = readEmbeddedExample(name);
  if (embedded === null) {
    throw new Error(
      `Example config not found: ${name}.yaml (available: ${exampleNames().join(", ")})`,
    );
  }
  writeFileSync(dest, embedded, { encoding: "utf8" });
  console.log(chalk.green(`Copied ${name}.yaml -> switchroom.yaml`));
}

// ─── Self-elevation (#920) ────────────────────────────────────────────────
//
// Per-agent state dirs are mode 0700 owned by per-agent UIDs in the
// v0.7+ docker model. `apply` needs to write start.sh / .mcp.json /
// settings.json into them, so it has to run as root. Pre-fix, the
// operator was told to invoke `sudo -E switchroom apply` — which has
// three failure modes in practice:
//
//   1. sudo-rs strips `-E`. HOME doesn't propagate, CLI looks for
//      config in /root/.switchroom/.
//   2. sudo's secure PATH excludes ~/.bun/bin; the `switchroom`
//      symlink isn't found.
//   3. The `#!/usr/bin/env bun` shebang fails — bun isn't on root's
//      PATH either.
//
// The escape valve is `sudo HOME=$HOME PATH=... bun /path/to/dist/cli/
// switchroom.js apply --non-interactive`, which is hostile to remember.
//
// Self-elevation flips this: when `apply` detects it can't write to a
// per-agent dir, it re-execs itself under sudo with the right argv0,
// HOME preserved, and a `--skip-self-elevate` guard to prevent loops.

/**
 * Find the operator's per-agent dirs that we'd need to write into.
 * Returns ones we currently lack write access to.
 *
 * Pre-check, not post-fail: we need to know BEFORE invoking the
 * scaffold loop whether to escalate, because scaffoldAgent fails with
 * EACCES partway through and leaves the fleet in a half-applied
 * state.
 */
export function findUnwritableAgentDirs(
  config: SwitchroomConfig,
  opts: { only?: string },
): string[] {
  const agentsDir = resolveAgentsDir(config);
  const targets = opts.only
    ? [opts.only]
    : Object.keys(config.agents ?? {});
  const unwritable: string[] = [];
  for (const name of targets) {
    const startSh = join(agentsDir, name, "start.sh");
    if (!existsSync(startSh)) continue; // fresh agent; alignAgentUid will chown
    try {
      accessSync(startSh, fsConstants.W_OK);
    } catch {
      unwritable.push(name);
    }
  }
  return unwritable;
}

/**
 * Env vars the CLI consults that must survive the re-exec under sudo.
 * Single source of truth so adding a new var doesn't drift between the
 * doc-comment, the argv builder, and the test assertion.
 */
export const SELF_ELEVATE_PRESERVED_ENV = [
  "HOME",              // ~/.switchroom resolution
  "SWITCHROOM_CONFIG", // override of the default config path
  "PATH",              // so child shell-outs find their tools
  "SWITCHROOM_HOST_HOME", // host home baked into compose bind sources — MUST
                          // survive the sudo boundary, else the resolver throws
                          // (or, pre-fix, the fallback poisoned the fleet). #2026-06-23
  "SWITCHROOM_HOSTD_CONTEXT", // marks the blessed hostd deploy path
] as const;

/**
 * Build the sudo argv that re-execs this process under root with the
 * same arguments + a `--skip-self-elevate` guard. Exposed for tests
 * and for `--print-sudo-cmd`.
 *
 * Notes on the cross-flavour sudo dance:
 *   - sudo-rs ignores `-E` (warns and proceeds without preservation).
 *     Both sudo and sudo-rs accept `--preserve-env=VAR1,VAR2,...` so
 *     we use that uniformly. Preserved set is in
 *     SELF_ELEVATE_PRESERVED_ENV.
 *   - process.execPath is the absolute path to bun/node, so sudo's
 *     secure PATH doesn't matter for the interpreter.
 *   - process.argv[1] is the absolute path to dist/cli/switchroom.js
 *     under both `bun run dev` and a global install — but NOT under a
 *     `bun build --compile` static binary, where it is the virtual
 *     `/$bunfs/root/...` bundle path and process.execPath is the binary
 *     itself. Forwarding the bunfs path there makes sudo run
 *     `switchroom /$bunfs/root/switchroom-linux-amd64 apply` and
 *     commander rejects it as an unknown command (#3963). The split is
 *     resolved by {@link resolveSelfInvocation}.
 */
export function buildSelfElevateArgv(probe: SelfInvokeProbe = {}): string[] {
  const passthrough = process.argv.slice(2);
  const self = resolveSelfInvocation(probe);
  return [
    `--preserve-env=${SELF_ELEVATE_PRESERVED_ENV.join(",")}`,
    self.command,
    ...self.prefixArgs,
    ...passthrough,
    "--skip-self-elevate",
  ];
}

/**
 * Print one-line confirmation prompt and read a single y/n answer.
 * Resolves `true` on yes, `false` otherwise. Closes the readline
 * interface after.
 *
 * Caller must check process.stdin.isTTY before invoking — readline
 * silently hangs on non-TTY input. The check lives at the call site
 * because the right fallback (auto-confirm vs auto-decline vs error)
 * depends on context.
 */
async function confirmYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const ans: string = await new Promise((res) => {
      rl.question(question, res);
    });
    return /^y(es)?$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}

/**
 * Re-exec the current invocation under sudo. Never returns on success;
 * exits the parent with whatever the child returned.
 *
 * If sudo isn't installed, prints a clean error pointing the operator
 * at `--compose-only` (the no-elevation escape) and exits 1. spawnSync
 * does NOT throw on ENOENT — it sets `result.error.code === "ENOENT"`
 * — so the missing-sudo path is detected post-call, not via try/catch.
 */
export function reexecUnderSudo(): never {
  const args = buildSelfElevateArgv();
  const result = childSpawnSync("sudo", args, { stdio: "inherit" });
  const errCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (errCode === "ENOENT") {
    process.stderr.write(
      chalk.red(
        "\nERROR: sudo not found on PATH. Re-run as root, or use\n" +
        "       `switchroom apply --compose-only` to skip the per-agent\n" +
        "       scaffold refresh entirely (compose file still regenerates).\n",
      ),
    );
    process.exit(1);
  }
  if (result.error) {
    process.stderr.write(
      chalk.red(
        `\nERROR: failed to spawn sudo: ${result.error.message}\n`,
      ),
    );
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

export function registerApplyCommand(program: Command): void {
  program
    .command("apply")
    .description(
      "Apply switchroom.yaml: scaffold every agent and (re)generate the compose file. Run `docker compose -f <path> up -d` afterwards to bring the fleet up.",
    )
    .option(
      "--build-local [context]",
      "Dev-only: emit `build:` blocks instead of GHCR `image:` refs so `docker compose up --build` rebuilds from in-tree Dockerfiles. Optional context path (defaults to cwd).",
    )
    .option(
      "-o, --out <path>",
      `Override compose output path (default: ${DEFAULT_COMPOSE_PATH}).`,
    )
    .option(
      "--example <name>",
      "Copy an example config into cwd before applying (e.g., 'switchroom' or 'minimal').",
    )
    .option(
      "--non-interactive",
      "Skip prompts (e.g. sudo-chown explainer for UID alignment). Use in CI / scripts.",
    )
    .option(
      "--allow-unaligned",
      "Treat UID-alignment chown failures as warnings instead of hard errors. Unsafe: an unaligned state dir will break the agent on first write. Use only if you know you'll fix ownership out-of-band.",
    )
    .option(
      "--only <agent>",
      "Restrict scaffold + UID-alignment to a single agent (compose still covers the full fleet). Use during a v0.6 → v0.7 cutover to migrate agents one at a time without breaking the systemd-managed siblings.",
    )
    .option(
      "--compose-only",
      "Skip the per-agent scaffold loop entirely; only (re)generate the compose file. Use in CI / scripts that can't chown into per-agent state dirs (mode 0700, owned by per-agent UIDs in v0.7+ docker mode). The full apply still runs preflight + emits compose; only the start.sh / .mcp.json / settings.json refresh is skipped.",
    )
    .option(
      "--dry-run",
      "Validate only: run the full compose-regeneration + validation pipeline IN MEMORY (resolve every agent's profile, probe the vault-broker for key-provisioning gaps, compute the would-be compose) and print a report — without writing the compose file, persisting anything, or touching a container. Exits non-zero if a real apply would fail (e.g. a profile can't resolve). Use as a pre-flight before a `rollout`/`update` (which only print the step plan, not the config-regeneration that actually fails).",
    )
    .option(
      "--no-doctor",
      "Skip the post-apply doctor sweep that surfaces stale start.sh / unhealthy agents (#929). Default: doctor runs after a successful scaffold so the operator sees whether the v0.7+ post-Phase-4 supervisor block is now in place. `switchroom update` passes this internally to avoid running doctor twice (it has its own doctor step).",
    )
    .addOption(
      new Option(
        "--channel <c>",
        "Override the resolved `release` block for this apply run: " +
        "follow the named channel pointer (dev|rc|latest). Mutually " +
        "exclusive with --pin.",
      ).choices(["dev", "rc", "latest"]).conflicts("pin"),
    )
    .addOption(
      new Option(
        "--pin <p>",
        "Override the resolved `release` block for this apply run: " +
        "pin to a specific build (sha-<7-40 hex> or v<semver>). " +
        "Mutually exclusive with --channel.",
      ).conflicts("channel"),
    )
    .option(
      "--print-sudo-cmd",
      "Print the sudo invocation that `apply` would re-exec itself with when escalation is needed, then exit. Operators who want to script the escalation themselves (CI, custom orchestration) can capture this. Note: tokens are space-separated and not shell-quoted; re-quote arguments if pasting into a shell.",
    )
    // Recursion guard set during the re-exec under sudo. Hidden from
    // --help output via Option.hideHelp() — only the elevation logic
    // sets it; operators have no reason to type it.
    .addOption(
      new Option("--skip-self-elevate").default(false).hideHelp(),
    )
    .action(
      async (opts: {
        buildLocal?: boolean | string;
        out?: string;
        example?: string;
        nonInteractive?: boolean;
        allowUnaligned?: boolean;
        only?: string;
        composeOnly?: boolean;
        dryRun?: boolean;
        printSudoCmd?: boolean;
        skipSelfElevate?: boolean;
        channel?: "dev" | "rc" | "latest";
        pin?: string;
        // Commander auto-coerces --no-doctor → opts.doctor = false; default true.
        doctor?: boolean;
      }) => {
        try {
          if (opts.example) {
            copyExampleConfig(opts.example);
          }

          const parentOpts = program.opts();
          const config = loadConfig(parentOpts.config);
          // Translate container-internal config paths to host paths before
          // baking into compose bind-mount sources. When `switchroom apply`
          // runs from inside an agent container, SWITCHROOM_CONFIG is the
          // container path `/state/config/switchroom.yaml`. Emitting that
          // verbatim as a bind-mount source makes Docker auto-create an
          // empty directory at that host path, crashing broker + auth-broker
          // with EISDIR (2026-06-11 v0.15.3 rollback incident).
          const switchroomConfigPath = resolveHostSwitchroomConfigPath(
            parentOpts.config ?? findConfigFile(),
          );

          // ─── Self-elevation pre-check (#920) ────────────────────
          //
          // Detect upfront whether we'd EACCES partway through the
          // scaffold loop, and either re-exec under sudo (after a
          // confirmation prompt) or print actionable guidance.
          // --compose-only skips the per-agent loop entirely so it
          // never needs escalation; --print-sudo-cmd just prints
          // and exits.
          if (opts.printSudoCmd) {
            const argv = ["sudo", ...buildSelfElevateArgv()];
            process.stdout.write(argv.join(" ") + "\n");
            process.exit(0);
          }

          // ─── Dry-run (validate-only) ────────────────────────────
          //
          // Runs the full compose-regeneration + validation pipeline in
          // memory and reports what a real apply would do, WITHOUT
          // writing the compose, persisting anything, self-elevating, or
          // touching a container. Handled here — before the sudo
          // pre-check — because it is entirely read-only and must never
          // escalate. Exits non-zero when a real apply would fail.
          if (opts.dryRun) {
            const dry = await runApplyDryRun(
              config,
              {
                buildLocal: !!opts.buildLocal,
                buildContext:
                  typeof opts.buildLocal === "string" ? opts.buildLocal : process.cwd(),
                outPath: opts.out,
                only: opts.only,
                releaseOverride: opts.channel
                  ? { channel: opts.channel }
                  : opts.pin
                    ? { pin: opts.pin }
                    : undefined,
                dryRun: true,
              },
              {},
              switchroomConfigPath,
            );
            await captureEvent("apply_dry_run", {
              agents_total: Object.keys(config.agents ?? {}).length,
              would_succeed: dry.wouldSucceed,
              blocking: dry.blocking.length,
              warnings: dry.warnings.length,
            });
            process.exit(dry.wouldSucceed ? 0 : 1);
          }
          if (
            !opts.skipSelfElevate
            && !opts.composeOnly
            && process.geteuid?.() !== 0
          ) {
            const unwritable = findUnwritableAgentDirs(config, {
              only: opts.only,
            });
            if (unwritable.length > 0) {
              const summary =
                `apply needs to refresh per-agent scaffolds, but ${unwritable.length}/${
                  Object.keys(config.agents ?? {}).length
                } agents have state dirs the operator can't write to ` +
                `(mode 0700 owned by per-agent UIDs — v0.7+ docker model).\n` +
                `Affected: ${unwritable.slice(0, 5).join(", ")}${
                  unwritable.length > 5 ? `, +${unwritable.length - 5} more` : ""
                }\n`;
              process.stderr.write(chalk.yellow(summary));
              // TTY guard — readline silently hangs on non-TTY input
              // (cron, ssh -T, piped scripts). When stdin is not a TTY
              // we can't prompt, so default to auto-elevate (the
              // operator clearly meant for `apply` to refresh scaffolds
              // since they ran it; --non-interactive is the explicit
              // form of the same intent).
              const canPrompt =
                !opts.nonInteractive && process.stdin.isTTY === true;
              const proceed = canPrompt
                ? await confirmYesNo(
                    `Re-exec under sudo to refresh them? [Y/n] `,
                  )
                : true;
              if (!proceed) {
                process.stderr.write(
                  chalk.gray(
                    "Skipping. Re-run with --compose-only to regenerate compose " +
                    "without touching per-agent files.\n",
                  ),
                );
                process.exit(0);
              }
              reexecUnderSudo(); // never returns
            }
          }

          const buildLocal = !!opts.buildLocal;
          const buildContext =
            typeof opts.buildLocal === "string"
              ? opts.buildLocal
              : process.cwd();

          // Build the release override from CLI flags. Mutual exclusion
          // is enforced by commander's `.conflicts(...)` above, so we
          // never see both set here.
          const releaseOverride: ApplyOptions["releaseOverride"] | undefined =
            opts.channel
              ? { channel: opts.channel }
              : opts.pin
                ? { pin: opts.pin }
                : undefined;
          // Defensive: validate --pin shape early (commander's choices()
          // already covers --channel). Mirror the regex from
          // ReleaseBlock so a malformed pin fails fast at the CLI layer
          // rather than landing as a bogus image tag.
          if (opts.pin && !/^(sha-[0-9a-f]{7,40}|v\d+\.\d+\.\d+)$/.test(opts.pin)) {
            console.error(
              chalk.red(
                `--pin "${opts.pin}" is invalid. Expected sha-<7-40 hex> or v<semver>.`,
              ),
            );
            process.exit(2);
          }
          const result = await runApply(
            config,
            {
              buildLocal,
              buildContext: buildLocal ? buildContext : undefined,
              outPath: opts.out,
              example: opts.example,
              nonInteractive: opts.nonInteractive ?? false,
              allowUnaligned: opts.allowUnaligned ?? false,
              only: opts.only,
              composeOnly: opts.composeOnly ?? false,
              releaseOverride,
            },
            {},
            switchroomConfigPath,
          );

          await captureEvent("apply_completed", {
            agents_total: result.agentsTotal,
            agents_scaffolded: result.scaffolded,
            agents_failed: result.failures.length,
            build_local: buildLocal,
            compose_only: opts.composeOnly ?? false,
            example: opts.example ?? null,
          });

          // Issue #902: surface partial scaffold failures with a
          // resolution block + non-zero exit. Pre-fix behaviour was
          // silent exit 0 even when 0/N agents scaffolded.
          if (result.failures.length > 0) {
            process.stderr.write(
              chalk.red(
                formatScaffoldFailureResolution(
                  result.failures,
                  result.scaffolded,
                  result.agentsTotal,
                ),
              ),
            );
            process.exit(1);
          }

          // Hot-reload the running brokers so config edits take effect without
          // a container restart: the auth-broker for Microsoft/Google account
          // ACLs, the vault-broker for secret-ACLs / agent-`admin` / approval
          // posture. apply is the chokepoint every config edit flows through,
          // so this is the durable catch-all (the targeted `auth microsoft
          // enable/disable` verbs also self-trigger). Best-effort + idempotent:
          // a SIGHUP only swaps the broker's in-memory config — it does NOT
          // manage container lifecycle (bringing the fleet up still defers to
          // `docker compose up`, by design). Silent when a broker isn't running
          // (fresh setup) or docker is unreachable (in-container apply); only a
          // genuine docker error is surfaced.
          const brokerReloads: Array<[string, BrokerReloadResult]> = [
            [AUTH_BROKER_CONTAINER, reloadAuthBroker()],
            [VAULT_BROKER_CONTAINER, reloadVaultBroker()],
          ];
          for (const [name, reload] of brokerReloads) {
            if (reload.ok) {
              process.stdout.write(
                chalk.gray(`  ↻ ${name} hot-reloaded (config now live)\n`),
              );
            } else if (reload.reason === "error") {
              const hint = brokerReloadHint(reload, name);
              if (hint) process.stderr.write(chalk.yellow(`  ⚠ ${hint}\n`));
            }
          }

          // Post-apply doctor sweep (#929). Surfaces the stale-start.sh
          // diagnostic from #911 so an operator running `apply` directly
          // (not via `switchroom update`) sees whether the v0.7+
          // supervisor block is present after the scaffold refresh.
          // Informational only — does NOT change apply's exit code.
          // Skipped on --compose-only (no scaffold to verify) and
          // --no-doctor (`update` passes this so doctor doesn't run
          // twice — `update` calls it as its own step 5).
          if (
            (opts.doctor ?? true)
            && !opts.composeOnly
          ) {
            // Lazy import for startup-perf — doctor.ts is large
            // (~1500 lines) and transitively pulls runDockerChecks,
            // probeHindsight, manifest drift loaders. Apply paths
            // that DON'T need doctor (--no-doctor, --compose-only)
            // shouldn't pay that import cost. Not for circular-import
            // avoidance — doctor.ts has no dependency on apply.ts.
            const { checkAgents, printSection } = await import("./doctor.js");
            const results = checkAgents(config, switchroomConfigPath ?? "");
            const hasNoise = results.some(
              (r) => r.status === "warn" || r.status === "fail",
            );
            if (hasNoise) {
              printSection("Agent health", results);
              process.stderr.write(
                chalk.gray(
                  "\n(Doctor findings are informational; apply succeeded. " +
                  "Run `switchroom doctor` for the full sweep.)\n",
                ),
              );
            }
          }
        } catch (err) {
          await captureException(err, { action: "apply" });
          if (err instanceof ConfigError) {
            console.error(chalk.red(`Config error: ${err.message}`));
            if (err.details) {
              for (const d of err.details) {
                console.error(chalk.gray(d));
              }
            }
            process.exit(1);
          }
          console.error(
            chalk.red(`switchroom apply failed: ${(err as Error).message}`),
          );
          process.exit(1);
        }
      },
    );
}
