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
import { accessSync, constants as fsConstants, copyFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync as childSpawnSync } from "node:child_process";
import readline from "node:readline";
// Embed example configs as text imports so they survive `bun build --compile`.
// `import.meta.dirname` resolves to `/$bunfs/root` inside a compiled binary,
// which means resolve(import.meta.dirname, "../../examples/...") points at a
// path that doesn't exist on the host — apply --example would fail with
// ENOENT. Text imports are bundled into the binary at compile time.
import switchroomExample from "../../examples/switchroom.yaml" with { type: "text" };
import minimalExample from "../../examples/minimal.yaml" with { type: "text" };

/** Embedded example configs, keyed by name. Mirrors files under examples/. */
const EMBEDDED_EXAMPLES: Record<string, string> = {
  switchroom: switchroomExample,
  minimal: minimalExample,
};
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { isVaultReference } from "../vault/resolver.js";
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
import { scaffoldAgent, alignAgentUid } from "../agents/scaffold.js";
import { generateCompose, allocateAgentUid } from "../agents/compose.js";
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
async function ensureHostMountSources(config: SwitchroomConfig): Promise<void> {
  const home = homedir();
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
  }
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }

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
 * Run the preflight gate. Fail fast (throws) when the config requires
 * vault-resolved secrets but ~/.switchroom/vault.enc is missing, or
 * when `docker compose` v2 is unavailable. Both conditions would have
 * surfaced as cryptic mid-apply / mid-up failures otherwise.
 */
export function runApplyPreflight(
  config: SwitchroomConfig,
  opts: { detectComposeV2?: () => string | null } = {},
): void {
  const vaultPath = resolvePath(
    config.vault?.path ?? "~/.switchroom/vault.enc",
  );
  if (hasVaultRefs(config) && !existsSync(vaultPath)) {
    throw new Error(
      `Config references vault keys (vault:<name>) but ${vaultPath} is missing. ` +
      `Run \`switchroom setup\` first to initialise the vault.`,
    );
  }
  const detect = opts.detectComposeV2 ?? detectComposeV2;
  const composeErr = detect();
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
  // Capture the host operator UID so the broker can chown its operator
  // socket at bind time. Under sudo, `process.getuid()` returns 0 (root)
  // — what we actually want is the underlying user's UID, which sudo
  // exposes via SUDO_UID. Fall back to getuid() when SUDO_UID is unset
  // or unparseable. On Windows / non-POSIX, getuid is unavailable; the
  // operator listener simply isn't bound (broker skips when env var
  // is unset).
  const operatorUid: number | undefined = (() => {
    const sudoUid = process.env.SUDO_UID;
    if (sudoUid !== undefined) {
      const parsed = parseInt(sudoUid, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    if (typeof process.getuid === "function") {
      const uid = process.getuid();
      if (uid > 0) return uid;
    }
    return undefined;
  })();
  const composeContent = generateCompose({
    config,
    buildMode: options.buildLocal ? "local" : "pull",
    buildContext: options.buildContext,
    // Bake the operator's HOME absolute path into volume sources at
    // apply time. Avoids `${HOME}` resolving to /root under sudo.
    homeDir: homedir(),
    // Bind-mount the resolved switchroom.yaml directly into the broker,
    // approval-kernel, and scheduler containers so they don't restart-loop
    // on `ConfigError: No switchroom.yaml found` when the operator's
    // config lives outside ~/.switchroom (v0.7 P0 install-path bug).
    switchroomConfigPath,
    // Captured above — turns on the host-shell operator socket.
    operatorUid,
  });
  await mkdir(dirname(composePath), { recursive: true });
  await writeFile(composePath, composeContent, {
    encoding: "utf8",
    mode: 0o600,
  });
  const composeBytes = Buffer.byteLength(composeContent, "utf8");

  writeOut(
    chalk.bold(`\nWrote `) +
      composePath +
      chalk.gray(` (${composeBytes} bytes)\n`),
  );
  writeOut(
    `Bring the fleet up with:\n` +
      `  docker compose -p ${COMPOSE_PROJECT} -f ${composePath} pull && \\\n` +
      `    docker compose -p ${COMPOSE_PROJECT} -f ${composePath} up -d --remove-orphans\n`,
  );
  writeOut(
    chalk.gray(
      `  (If pull returns 401, login to ghcr.io first: see docs/operators/install.md#ghcr-auth)\n`,
    ),
  );

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

  // Prefer embedded examples (works under both `bun run` and `bun build
  // --compile`). Fall back to disk lookup so contributors can add new
  // examples in-tree without rebuilding — only relevant in dev because
  // the compiled binary's `import.meta.dirname` is the bunfs virtual root.
  const embedded = EMBEDDED_EXAMPLES[name];
  if (embedded !== undefined) {
    writeFileSync(dest, embedded, { encoding: "utf8" });
    console.log(chalk.green(`Copied ${name}.yaml -> switchroom.yaml`));
    return;
  }

  const exampleFile = resolve(
    import.meta.dirname,
    `../../examples/${name}.yaml`,
  );
  if (!existsSync(exampleFile)) {
    throw new Error(
      `Example config not found: ${name}.yaml (available: ${Object.keys(EMBEDDED_EXAMPLES).join(", ")})`,
    );
  }
  copyFileSync(exampleFile, dest);
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
 *     under both `bun run dev` and a global install.
 */
export function buildSelfElevateArgv(): string[] {
  const passthrough = process.argv.slice(2);
  return [
    `--preserve-env=${SELF_ELEVATE_PRESERVED_ENV.join(",")}`,
    process.execPath,
    process.argv[1] ?? "",
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
      "--no-doctor",
      "Skip the post-apply doctor sweep that surfaces stale start.sh / unhealthy agents (#929). Default: doctor runs after a successful scaffold so the operator sees whether the v0.7+ post-Phase-4 supervisor block is now in place. `switchroom update` passes this internally to avoid running doctor twice (it has its own doctor step).",
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
        printSudoCmd?: boolean;
        skipSelfElevate?: boolean;
        // Commander auto-coerces --no-doctor → opts.doctor = false; default true.
        doctor?: boolean;
      }) => {
        try {
          if (opts.example) {
            copyExampleConfig(opts.example);
          }

          const parentOpts = program.opts();
          const config = loadConfig(parentOpts.config);
          const switchroomConfigPath =
            parentOpts.config ?? findConfigFile();

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
