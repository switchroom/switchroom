import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { resolveAgentsDir, loadConfig } from "../config/loader.js";
import type { SwitchroomConfig } from "../config/schema.js";
import { withConfigError, getConfig, getConfigPath } from "./helpers.js";
import { scaffoldAgent, reconcileAgent } from "../agents/scaffold.js";
import { listAvailableProfiles } from "../agents/profiles.js";
import {
  startAgent,
  stopAgent,
  restartAgent,
  gracefulRestartAgent,
  interruptAgent,
  getAgentStatus,
  getAllAgentStatuses,
  attachAgent,
  getAgentLogs,
  writeRestartReasonMarker,
  buildCliRestartReason,
} from "../agents/lifecycle.js";
import { COMMIT_SHA as BUILD_COMMIT } from "../build-info.js";
import {
  generateUnit,
  generateGatewayUnit,
  installUnit,
  uninstallUnit,
  installScheduleTimers,
  enableScheduleTimers,
  daemonReload,
  resolveGatewayUnitName,
  unitFilePath,
} from "../agents/systemd.js";
import { usesSwitchroomTelegramPlugin, resolveAgentConfig } from "../config/merge.js";
import { resolveTimezone } from "../config/timezone.js";
import { detectInFlight, waitUntilIdle } from "../agents/in-flight.js";
import { askYesNo } from "../setup/prompt.js";
import {
  buildAgentStatusReport,
  defaultStatusInputs,
  formatStatusText,
  waitForAgentReady,
  type StatusInputs,
} from "../agents/status.js";
import { createAgent, completeCreation } from "../agents/create-orchestrator.js";

/**
 * Pre-restart preflight check. Verifies the agent's runtime
 * dependencies are in place before allowing a restart — catches
 * problems that would leave the agent unable to start (e.g. missing
 * `expect` binary when dev channels need the autoaccept wrapper).
 *
 * Returns an array of error strings. Empty = all checks passed.
 */
function preflightCheck(
  name: string,
  agentDir: string,
  usesDevChannels: boolean,
): string[] {
  const errors: string[] = [];

  // 1. start.sh exists and is executable
  const startSh = resolve(agentDir, "start.sh");
  if (!existsSync(startSh)) {
    errors.push(`start.sh not found at ${startSh}`);
  }

  // 2. systemd unit exists
  const unitPath = resolve(
    process.env.HOME ?? "/root",
    ".config/systemd/user",
    `switchroom-${name}.service`,
  );
  if (!existsSync(unitPath)) {
    errors.push(
      `systemd unit not found at ${unitPath}. Run: switchroom agent create ${name}`,
    );
  } else if (usesDevChannels) {
    // 3. If using dev channels, the unit MUST use the expect wrapper
    const unitContent = readFileSync(unitPath, "utf-8");
    if (!unitContent.includes("expect")) {
      errors.push(
        `systemd unit is missing the expect autoaccept wrapper — ` +
        `dev channels will hang on the confirmation dialog. ` +
        `Fix: switchroom systemd install (regenerates the unit)`,
      );
    }
  }

  // 4. expect binary exists (if needed)
  if (usesDevChannels) {
    try {
      const { execSync: exec } = require("node:child_process");
      exec("which expect", { stdio: "pipe" });
    } catch {
      errors.push(
        `'expect' binary not found on PATH — required for dev channels. ` +
        `Install: sudo apt install expect`,
      );
    }
  }

  // 5. Bot token file exists and has content
  const envPath = resolve(agentDir, "telegram", ".env");
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, "utf-8");
    if (!envContent.includes("TELEGRAM_BOT_TOKEN=") || envContent.includes("# Set your bot token")) {
      errors.push(
        `telegram/.env is missing TELEGRAM_BOT_TOKEN. ` +
        `Set it or run: switchroom setup`,
      );
    }
  } else {
    errors.push(`telegram/.env not found at ${envPath}`);
  }

  // 6. .claude/settings.json exists
  if (!existsSync(resolve(agentDir, ".claude", "settings.json"))) {
    errors.push(
      `.claude/settings.json not found. Run: switchroom agent reconcile ${name}`,
    );
  }

  // 7. Claude binary on PATH
  try {
    const { execSync: exec } = require("node:child_process");
    exec("which claude", { stdio: "pipe" });
  } catch {
    errors.push(`'claude' binary not found on PATH`);
  }

  return errors;
}

/**
 * Resolve the StatusInputs for a given agent — same Hindsight-URL resolution
 * the `status` command uses inline. Extracted so `start` and `restart` can
 * share the B1 readiness wait without duplicating the config branch.
 */
function buildStatusInputs(
  name: string,
  config: SwitchroomConfig,
  agentsDir: string,
): StatusInputs {
  const agentDir = resolve(agentsDir, name);
  const agentConfig = config.agents[name];

  let hindsightApiUrl: string | null = null;
  let hindsightBankId = name;
  if (config.memory?.backend === "hindsight") {
    const baseUrl =
      (config.memory.config?.url as string | undefined) ??
      "http://localhost:8888/mcp/";
    hindsightApiUrl = baseUrl.endsWith("/mcp/")
      ? baseUrl
      : baseUrl.replace(/\/$/, "") + "/mcp/";
    hindsightBankId = agentConfig?.memory?.collection ?? name;
  }

  return defaultStatusInputs({
    agentName: name,
    agentDir,
    hindsightApiUrl,
    hindsightBankId,
  });
}

/**
 * Wait for the agent to become serveable after a start/restart and print a
 * human-readable line summarising the outcome. Keeps the CLI exit-clean —
 * an agent that never reaches ready still returns control, we just paint
 * the line yellow and list which components are still not ok.
 */
async function printReadyOutcome(
  name: string,
  config: SwitchroomConfig,
  agentsDir: string,
  verb: "Started" | "Restarted",
): Promise<void> {
  const inputs = buildStatusInputs(name, config, agentsDir);
  const result = await waitForAgentReady(inputs);
  const secs = (result.elapsedMs / 1000).toFixed(1);
  if (result.ready) {
    console.log(chalk.green(`${verb} ${name} (ready in ${secs}s)`));
  } else {
    console.log(
      chalk.yellow(
        `${verb} ${name} but not fully ready after ${secs}s — not ready: ${result.notReady.join(", ")}`,
      ),
    );
  }
}

function formatUptime(timestamp: string | null): string {
  if (!timestamp) return "\u2014";
  const start = new Date(timestamp).getTime();
  if (isNaN(start)) return "\u2014";
  const seconds = Math.floor((Date.now() - start) / 1000);
  if (seconds <= 0) return "\u2014";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function statusColor(status: string): string {
  switch (status) {
    case "running":
    case "active":
      return chalk.green(status);
    case "stopped":
    case "inactive":
    case "dead":
      return chalk.red(status);
    case "failed":
      return chalk.red(status);
    default:
      return chalk.yellow(status);
  }
}

function printTable(
  headers: string[],
  rows: string[][],
  widths: number[]
): void {
  const headerLine = headers
    .map((h, i) => chalk.bold(h.padEnd(widths[i])))
    .join("  ");
  console.log(`  ${headerLine}`);

  for (const row of rows) {
    const line = row.map((cell, i) => cell.padEnd(widths[i])).join("  ");
    console.log(`  ${line}`);
  }
}

/**
 * Synthesize a human-readable topic name fallback from an agent's
 * CLI name. `health-coach` → `Health Coach`. The schema requires
 * `topic_name` on every agent; when `--profile` is used to create a
 * yaml entry from scratch there's no place for the user to provide
 * one, so we derive a reasonable default. Users can edit later.
 *
 * Exported for tests.
 */
export function synthesizeTopicName(name: string): string {
  return name
    .split(/[-_]+/)
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

/**
 * Write a new agent entry into switchroom.yaml. Preserves surrounding
 * comments + formatting via yaml's Document API. Creates the
 * `agents:` map if missing (it shouldn't be, but defensive). Throws
 * if the agent already exists — caller should guard with its own
 * existence check.
 *
 * Exported for tests.
 */
export function writeAgentEntryToConfig(
  configPath: string,
  name: string,
  profile: string,
): void {
  if (!existsSync(configPath)) {
    throw new Error(`switchroom.yaml not found at ${configPath}`);
  }
  const raw = readFileSync(configPath, "utf-8");
  const doc = YAML.parseDocument(raw);

  let agents = doc.get("agents") as YAML.YAMLMap | null;
  if (!agents) {
    agents = new YAML.YAMLMap();
    doc.set("agents", agents);
  }
  if (agents.has(name)) {
    throw new Error(
      `Agent "${name}" already exists in ${configPath}. Use updateAgentExtendsInConfig to change its profile.`,
    );
  }

  const entry = new YAML.YAMLMap();
  entry.set("extends", profile);
  entry.set("topic_name", synthesizeTopicName(name));
  agents.set(name, entry);

  writeFileSync(configPath, doc.toString(), "utf-8");
}

/**
 * Add or overwrite an `extends:` field on an existing agent entry in
 * switchroom.yaml. Only used when the yaml entry exists but has no
 * extends field and the user passed --profile — we write it in rather
 * than refusing the explicit CLI intent. Caller is responsible for
 * confirming the agent exists and does not already have a different
 * extends value.
 *
 * Exported for tests.
 */
export function updateAgentExtendsInConfig(
  configPath: string,
  name: string,
  profile: string,
): void {
  const raw = readFileSync(configPath, "utf-8");
  const doc = YAML.parseDocument(raw);
  const agents = doc.get("agents") as YAML.YAMLMap | null;
  if (!agents || !agents.has(name)) {
    throw new Error(
      `Agent "${name}" not found in ${configPath}; cannot update extends.`,
    );
  }
  const agentNode = agents.get(name) as YAML.YAMLMap;
  agentNode.set("extends", profile);
  writeFileSync(configPath, doc.toString(), "utf-8");
}

/**
 * Remove an agent entry from switchroom.yaml. No-ops silently if the
 * agent is not present (e.g. it was never written or already removed).
 * Used by rollback in the creation orchestrator to undo a partial write.
 *
 * Exported for tests.
 */
export function removeAgentFromConfig(configPath: string, name: string): void {
  if (!existsSync(configPath)) return;
  const raw = readFileSync(configPath, "utf-8");
  const doc = YAML.parseDocument(raw);
  const agents = doc.get("agents") as YAML.YAMLMap | null;
  if (!agents || !agents.has(name)) return;
  agents.delete(name);
  writeFileSync(configPath, doc.toString(), "utf-8");
}

/**
 * Reconcile the agent's scaffolded state against switchroom.yaml, then
 * restart it. This is the single codepath every `switchroom agent
 * restart` invocation goes through — the CLI entry point thin-wraps
 * this so we can unit-test "restart always reconciles first, and skips
 * restart if reconcile fails" without booting commander.
 *
 * Why reconcile before every restart? Restart was historically a
 * pure `systemctl restart` — which meant hand-patched systemd units
 * (and any other scaffold-owned artifact) survived across restarts.
 * That silently rotted: the next `switchroom systemd install` or
 * `agent reconcile` would wipe the hand-patch with no warning. By
 * folding reconcile into restart, every restart picks up template
 * changes and regenerates scaffold files from the canonical config,
 * making the framework self-healing. Ken's manual `EnvironmentFile=`
 * patches can now live in the template itself (generateUnit /
 * generateGatewayUnit), and operators can edit switchroom.yaml
 * → restart → done, no extra commands to remember.
 *
 * If reconcile fails, we do NOT proceed to restart — a broken config
 * shouldn't be applied on top of a working process.
 *
 * Exported for tests. `deps` lets tests inject reconcile/restart stubs
 * so the sequencing assertion doesn't require real fs/systemctl.
 */
export interface ReconcileAndRestartDeps {
  reconcileAgent: typeof reconcileAgent;
  restartAgent: typeof restartAgent;
  gracefulRestartAgent: typeof gracefulRestartAgent;
  /** Regenerate + diff + install systemd units. Skippable in tests. */
  regenerateSystemdUnits?: (
    name: string,
    config: SwitchroomConfig,
    agentsDir: string,
  ) => string[];
}

export interface ReconcileAndRestartOpts {
  graceful?: boolean;
  /** Suppress stdout logging (tests). */
  silent?: boolean;
}

/**
 * Re-render the agent's systemd unit (and its telegram gateway unit
 * when applicable), write them if they differ from disk, and
 * daemon-reload. Returns the list of unit paths that changed.
 *
 * This is what makes the self-healing loop work for the systemd layer
 * specifically: templates can evolve (e.g. adding `EnvironmentFile=-`)
 * and every restart picks them up without the operator having to
 * remember to run `switchroom systemd install`.
 */
export function regenerateSystemdUnitsForAgent(
  name: string,
  config: SwitchroomConfig,
  agentsDir: string,
): string[] {
  const agentConfig = config.agents[name];
  if (!agentConfig) return [];

  const agentDir = resolve(agentsDir, name);
  const useAutoaccept = usesSwitchroomTelegramPlugin(agentConfig);
  const gwName = resolveGatewayUnitName(config, name);

  const resolved = resolveAgentConfig(config.defaults, config.profiles, agentConfig);
  const timezone = resolveTimezone(config, resolved);

  const changed: string[] = [];

  const desiredUnit = generateUnit(name, agentDir, useAutoaccept, gwName, timezone);
  const agentUnitPath = unitFilePath(name);
  const currentUnit = existsSync(agentUnitPath) ? readFileSync(agentUnitPath, "utf-8") : "";
  if (currentUnit !== desiredUnit) {
    installUnit(name, desiredUnit);
    changed.push(agentUnitPath);
  }

  if (useAutoaccept && gwName) {
    const stateDir = resolve(agentDir, "telegram");
    const adminEnabled = resolved.admin === true;
    const desiredGw = generateGatewayUnit(stateDir, name, adminEnabled);
    const gwUnitPath = unitFilePath(gwName);
    const currentGw = existsSync(gwUnitPath) ? readFileSync(gwUnitPath, "utf-8") : "";
    if (currentGw !== desiredGw) {
      installUnit(gwName, desiredGw);
      changed.push(gwUnitPath);
    }
  }

  if (changed.length > 0) {
    // Re-read disk so systemd picks up the new ExecStart / Environment /
    // EnvironmentFile directives before the next `restart` fires.
    daemonReload();
  }

  return changed;
}

export async function reconcileAndRestartAgent(
  name: string,
  config: SwitchroomConfig,
  agentsDir: string,
  configPath: string | undefined,
  opts: ReconcileAndRestartOpts = {},
  deps: ReconcileAndRestartDeps = {
    reconcileAgent,
    restartAgent,
    gracefulRestartAgent,
    regenerateSystemdUnits: regenerateSystemdUnitsForAgent,
  },
): Promise<{ reconciled: boolean; restarted: boolean; waitingForTurn?: boolean; changes: string[] }> {
  const log = opts.silent ? () => {} : (msg: string) => console.log(msg);
  const agentConfig = config.agents[name];
  if (!agentConfig) {
    throw new Error(`Agent "${name}" is not defined in switchroom.yaml`);
  }

  // Reconcile first. If this throws, we stop here — never restart on
  // top of a broken config.
  const result = deps.reconcileAgent(
    name,
    agentConfig,
    agentsDir,
    config.telegram,
    config,
    configPath,
  );

  // Also regenerate systemd units. reconcileAgent intentionally only
  // touches in-agent-dir files; the systemd unit template lives at a
  // different layer (per-user ~/.config/systemd/user/). Without this
  // step, template changes like the vault `EnvironmentFile=-` directive
  // wouldn't propagate until the operator remembered to run
  // `switchroom systemd install` — defeating the whole self-healing
  // point of restart=reconcile+restart.
  const unitChanges = deps.regenerateSystemdUnits
    ? deps.regenerateSystemdUnits(name, config, agentsDir)
    : [];

  const allChanges = [...result.changes, ...unitChanges];

  if (allChanges.length === 0) {
    log(chalk.gray(`  ${name}: already in sync`));
  } else {
    log(chalk.green(`  ${name}: reconciled (${allChanges.length} file${allChanges.length === 1 ? "" : "s"})`));
    for (const f of allChanges) {
      log(chalk.gray(`    - ${f}`));
    }
  }

  if (opts.graceful) {
    try {
      const r = await deps.gracefulRestartAgent(name);
      return {
        reconciled: true,
        restarted: r.restartedImmediately,
        waitingForTurn: r.waitingForTurn,
        changes: allChanges,
      };
    } catch (err) {
      // Gateway IPC is the path graceful restart depends on. If the socket
      // is missing or unresponsive, the gateway itself is wedged — exactly
      // the case where the user most needs `restart` to work. Fall back to
      // a direct systemctl bounce, which restartAgent does for both the
      // gateway and the agent service together. See switchroom#71.
      const msg = err instanceof Error ? err.message : String(err);
      log(
        chalk.yellow(
          `  ${name}: graceful path unavailable (${msg}) — falling back to direct restart`,
        ),
      );
      deps.restartAgent(name);
      return { reconciled: true, restarted: true, changes: allChanges };
    }
  }

  deps.restartAgent(name);
  return { reconciled: true, restarted: true, changes: allChanges };
}

export function registerAgentCommand(program: Command): void {
  const agent = program
    .command("agent")
    .description("Manage individual agents");

  // switchroom agent list
  agent
    .command("list")
    .description("List all agents with their status")
    .option("--json", "Output as JSON")
    .action(
      withConfigError(async (opts: { json?: boolean }) => {
        const config = getConfig(program);
        const statuses = getAllAgentStatuses(config);
        const agentNames = Object.keys(config.agents);

        if (agentNames.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify({ agents: [] }));
          } else {
            console.log(chalk.yellow("No agents defined in switchroom.yaml"));
          }
          return;
        }

        if (opts.json) {
          const data = agentNames.map((name) => {
            const agentConfig = config.agents[name];
            const status = statuses[name];
            return {
              name,
              status: status?.active ?? "unknown",
              uptime: formatUptime(status?.uptime ?? null),
              extends: agentConfig.extends ?? "default",
              topic_name: agentConfig.topic_name,
              topic_emoji: agentConfig.topic_emoji,
            };
          });
          console.log(JSON.stringify({ agents: data }, null, 2));
          return;
        }

        const headers = ["Name", "Status", "Uptime", "Template", "Topic"];
        const widths = [16, 10, 12, 15, 20];

        const rows = agentNames.map((name) => {
          const agentConfig = config.agents[name];
          const status = statuses[name];
          const topicDisplay = [
            agentConfig.topic_name,
            agentConfig.topic_emoji,
          ]
            .filter(Boolean)
            .join(" ");

          return [
            name,
            statusColor(status?.active ?? "unknown"),
            formatUptime(status?.uptime ?? null),
            agentConfig.extends ?? "default",
            topicDisplay,
          ];
        });

        console.log();
        printTable(headers, rows, widths);
        console.log();
      })
    );

  // switchroom agent status <name>
  //
  // Single-command answer to "is my agent alive and healthy?" — rolls up
  // Claude PID + uptime, gateway PID, Hindsight reachability + bank
  // presence, Telegram polling state, and last inbound/outbound message
  // timestamps. Exit code 0 iff every check passes; 1 if any check
  // fails. Stable `key: value` output so shell scripts can grep it.
  agent
    .command("status <name>")
    .description("Show health status for a single agent (PID, polling, Hindsight, last messages)")
    .option("--json", "Output as JSON")
    .action(
      withConfigError(async (name: string, opts: { json?: boolean }) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);
        const agentConfig = config.agents[name];
        if (!agentConfig) {
          console.error(
            chalk.red(`Agent "${name}" is not defined in switchroom.yaml`),
          );
          process.exit(1);
        }

        const agentDir = resolve(agentsDir, name);

        // Hindsight MCP URL is only relevant if the agent actually uses
        // Hindsight. When memory.backend !== "hindsight" we pass null so
        // the probe is skipped and the check reports "not configured".
        let hindsightApiUrl: string | null = null;
        let hindsightBankId = name;
        if (config.memory?.backend === "hindsight") {
          const baseUrl = (config.memory.config?.url as string | undefined)
            ?? "http://localhost:8888/mcp/";
          // Normalize to end in /mcp/
          hindsightApiUrl = baseUrl.endsWith("/mcp/")
            ? baseUrl
            : baseUrl.replace(/\/$/, "") + "/mcp/";
          hindsightBankId = agentConfig.memory?.collection ?? name;
        }

        const inputs = defaultStatusInputs({
          agentName: name,
          agentDir,
          hindsightApiUrl,
          hindsightBankId,
        });

        const report = await buildAgentStatusReport(inputs);

        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(formatStatusText(report));
        }

        if (report.overallState === "fail") {
          process.exit(1);
        }
      }),
    );

  // switchroom agent create <name> [--profile <profile>]
  //
  // Two entry points into the same scaffold step:
  //
  //   1. YAML-first — the user edits switchroom.yaml to add an agent
  //      with `extends: <profile>`, then runs `agent create` with no
  //      --profile flag. The existing "not defined in yaml" error fires
  //      with a hint about --profile if the entry is missing.
  //
  //   2. CLI-first (one-shot) — the user runs
  //      `agent create <name> --profile <profile>` for a fresh agent.
  //      We validate the profile against the filesystem, write a new
  //      entry into switchroom.yaml (`extends: <profile>`, plus the
  //      required topic_name fallback), reload the config, and scaffold.
  //
  //   If the name already exists in yaml AND --profile is passed:
  //     - matching extends → proceed silently
  //     - differing extends → error (don't silently mutate)
  //     - no extends in yaml → warn, then add the extends line
  //       (additive-only — safer than refusing the explicit CLI intent)
  agent
    .command("create <name>")
    .description("Scaffold a new agent directory (optionally from a profile)")
    .option(
      "--profile <profile>",
      "Profile to extend from (e.g. 'health-coach', 'coding'). " +
      "Writes the entry into switchroom.yaml if it doesn't exist yet."
    )
    .action(
      withConfigError(async (name: string, opts: { profile?: string }) => {
        const configPath = getConfigPath(program);
        let config = getConfig(program);
        let agentConfig = config.agents[name];

        // If the user passed --profile, validate it against the
        // filesystem profiles/ directory before we touch yaml.
        if (opts.profile) {
          const available = listAvailableProfiles();
          if (!available.includes(opts.profile)) {
            console.error(
              chalk.red(`Unknown profile: "${opts.profile}"`)
            );
            console.error(
              chalk.gray(`  Valid profiles: ${available.join(", ")}`)
            );
            process.exit(1);
          }
        }

        if (!agentConfig) {
          if (!opts.profile) {
            console.error(
              chalk.red(`Agent "${name}" is not defined in switchroom.yaml`)
            );
            console.error(
              chalk.gray(
                `  Hint: pass --profile <profile> to scaffold a new agent ` +
                `in one shot (or add the entry to switchroom.yaml manually).`
              )
            );
            const existing = Object.keys(config.agents);
            if (existing.length > 0) {
              console.error(
                chalk.gray(`  Existing agents: ${existing.join(", ")}`)
              );
            }
            process.exit(1);
          }

          // Fresh agent, --profile supplied — write the entry to yaml.
          writeAgentEntryToConfig(configPath, name, opts.profile!);
          console.log(
            chalk.green(
              `  Added agent "${name}" to ${configPath} with extends: ${opts.profile}`
            )
          );

          // Reload config after writing so scaffoldAgent sees the new entry.
          config = loadConfig(configPath);
          agentConfig = config.agents[name];
          if (!agentConfig) {
            // Shouldn't happen — if it does, surface loudly rather than
            // silently scaffold against stale in-memory config.
            console.error(
              chalk.red(
                `Internal error: wrote agent "${name}" to yaml but config ` +
                `reload did not pick it up. Inspect ${configPath} and retry.`
              )
            );
            process.exit(1);
          }
        } else if (opts.profile) {
          // Agent already exists in yaml; reconcile --profile against
          // the existing extends: value.
          const existingExtends = agentConfig.extends;
          if (!existingExtends) {
            console.log(
              chalk.yellow(
                `  Agent "${name}" exists in switchroom.yaml without an extends: ` +
                `field. Writing extends: ${opts.profile}.`
              )
            );
            updateAgentExtendsInConfig(configPath, name, opts.profile);
            config = loadConfig(configPath);
            agentConfig = config.agents[name];
          } else if (existingExtends !== opts.profile) {
            console.error(
              chalk.red(
                `Agent "${name}" is already configured with profile ` +
                `"${existingExtends}". Edit switchroom.yaml or drop --profile.`
              )
            );
            process.exit(1);
          }
          // existingExtends === opts.profile → proceed silently.
        }

        const agentsDir = resolveAgentsDir(config);

        console.log(chalk.bold(`\nScaffolding agent: ${name}\n`));
        scaffoldAgent(
          name,
          agentConfig,
          agentsDir,
          config.telegram,
          config,
          undefined,
          getConfigPath(program),
        );

        // Also generate and install the systemd unit
        const agentDir = resolve(agentsDir, name);
        // Effective switchroom-plugin flag is driven by channels.telegram.plugin.
        // This mirrors usesSwitchroomTelegramPlugin() in src/config/merge.ts.
        const useAutoaccept = agentConfig.channels?.telegram?.plugin === "switchroom";
        const gwName = resolveGatewayUnitName(config, name);
        const unitContent = generateUnit(name, agentDir, useAutoaccept, gwName);
        installUnit(name, unitContent);

        // Install this agent's dedicated gateway unit. Each telegram-using
        // agent has its own bot token in its own state dir, so each gets
        // its own gateway process. Without this, only `switchroom systemd
        // install` would install the gateway — running `switchroom agent
        // create` on its own would leave the new bot silent.
        if (useAutoaccept && gwName) {
          const stateDir = resolve(agentDir, "telegram");
          const resolved = resolveAgentConfig(config.defaults, config.profiles, agentConfig);
          const adminEnabled = resolved.admin === true;
          const gatewayContent = generateGatewayUnit(stateDir, name, adminEnabled);
          installUnit(gwName, gatewayContent);
        }

        // Install schedule timers if the agent has any
        const schedule = agentConfig.schedule ?? [];
        if (schedule.length > 0) {
          installScheduleTimers(name, agentDir, schedule);
          daemonReload();
          enableScheduleTimers(name, schedule.length);
          console.log(chalk.green(`  ${schedule.length} scheduled timer(s) installed`));
        }

        console.log(chalk.green(`  Agent "${name}" scaffolded at ${agentDir}`));
        console.log(chalk.green(`  Systemd unit installed: switchroom-${name}.service`));
        console.log(chalk.gray(`\n  Start with: switchroom agent start ${name}\n`));
      })
    );

  // switchroom agent start <name|all>
  agent
    .command("start <name>")
    .description("Start an agent (or 'all' to start all agents)")
    .option("--force", "Skip preflight checks and start anyway")
    .action(
      withConfigError(async (name: string, opts: { force?: boolean }) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);
        const names =
          name === "all" ? Object.keys(config.agents) : [name];

        for (const n of names) {
          if (!config.agents[n]) {
            console.error(chalk.red(`Agent "${n}" is not defined in switchroom.yaml`));
            continue;
          }

          if (!opts.force) {
            const agentDir = resolve(agentsDir, n);
            const usesDevChannels =
              config.agents[n].channels?.telegram?.plugin !== "official";
            const errors = preflightCheck(n, agentDir, usesDevChannels);
            if (errors.length > 0) {
              console.error(chalk.red(`\n  Preflight failed for ${n}:\n`));
              for (const e of errors) {
                console.error(chalk.red(`    ✗ ${e}`));
              }
              console.error(
                chalk.gray(`\n  Fix the issues above, or use --force to skip preflight.\n`)
              );
              continue;
            }
          }

          try {
            startAgent(n);
            await printReadyOutcome(n, config, agentsDir, "Started");
          } catch (err) {
            console.error(
              chalk.red(`Failed to start ${n}: ${(err as Error).message}`)
            );
          }
        }
      })
    );

  // switchroom agent stop <name|all>
  agent
    .command("stop <name>")
    .description("Stop an agent (or 'all' to stop all agents)")
    .action(
      withConfigError(async (name: string) => {
        const config = getConfig(program);
        const names =
          name === "all" ? Object.keys(config.agents) : [name];

        for (const n of names) {
          if (!config.agents[n]) {
            console.error(chalk.red(`Agent "${n}" is not defined in switchroom.yaml`));
            continue;
          }
          try {
            stopAgent(n);
            console.log(chalk.green(`Stopped ${n}`));
          } catch (err) {
            console.error(
              chalk.red(`Failed to stop ${n}: ${(err as Error).message}`)
            );
          }
        }
      })
    );

  // switchroom agent interrupt <name>
  agent
    .command("interrupt <name>")
    .description("Send SIGINT to abort the agent's current turn without restarting")
    .action(
      withConfigError(async (name: string) => {
        const config = getConfig(program);
        if (!config.agents[name]) {
          console.error(chalk.red(`Agent "${name}" is not defined in switchroom.yaml`));
          return;
        }
        try {
          const { pid } = interruptAgent(name);
          console.log(chalk.green(`Sent SIGINT to ${name} (PID ${pid}) — current turn should abort`));
        } catch (err) {
          console.error(chalk.red((err as Error).message));
        }
      })
    );

  // switchroom agent restart <name|all>
  agent
    .command("restart <name>")
    .description("Restart an agent (or 'all' to restart all agents)")
    .option("--force", "Skip preflight + in-flight checks and restart anyway")
    .option(
      "--wait",
      "Wait (up to 5 min) for in-flight work to finish instead of prompting"
    )
    .option(
      "--wait-timeout <ms>",
      "Override --wait timeout in milliseconds (default 300000)"
    )
    .option("--graceful-restart", "Wait for active turn to complete before restarting (via gateway IPC)")
    .action(
      withConfigError(
        async (
          name: string,
          opts: { force?: boolean; wait?: boolean; waitTimeout?: string; gracefulRestart?: boolean }
        ) => {
          const config = getConfig(program);
          const agentsDir = resolveAgentsDir(config);
          const names =
            name === "all" ? Object.keys(config.agents) : [name];

          let sawAbort = false;

          for (const n of names) {
            if (!config.agents[n]) {
              console.error(chalk.red(`Agent "${n}" is not defined in switchroom.yaml`));
              continue;
            }

            const agentDir = resolve(agentsDir, n);

            // Preflight: verify runtime dependencies before restart.
            // Catches problems (missing expect, broken unit, missing
            // token) that would leave the agent unable to start.
            if (!opts.force) {
              const usesDevChannels =
                config.agents[n].channels?.telegram?.plugin !== "official";
              const errors = preflightCheck(n, agentDir, usesDevChannels);
              if (errors.length > 0) {
                console.error(chalk.red(`\n  Preflight failed for ${n}:\n`));
                for (const e of errors) {
                  console.error(chalk.red(`    ✗ ${e}`));
                }
                console.error(
                  chalk.gray(
                    `\n  Fix the issues above, or use --force to skip preflight.\n`
                  )
                );
                continue;
              }
            }

            // In-flight check: is the agent currently mid-turn? Killing
            // it will lose whatever work the model + tools have in
            // progress. --force skips; --wait polls; otherwise prompt.
            if (!opts.force) {
              const activity = detectInFlight({ agentDir });
              if (activity.busy) {
                const timeoutMs = opts.waitTimeout
                  ? Number(opts.waitTimeout)
                  : 5 * 60 * 1000;

                console.log(
                  chalk.yellow(`\n  ${n} appears to be mid-turn:`)
                );
                console.log(
                  chalk.gray(
                    `    sessions=${activity.activeSessions}  sub-agents=${activity.activeSubagents}`
                  )
                );
                for (const d of activity.details.slice(0, 5)) {
                  console.log(chalk.gray(`    - ${d}`));
                }
                if (activity.lastActivityMs > 0) {
                  const ageSec = Math.round(
                    (Date.now() - activity.lastActivityMs) / 1000
                  );
                  console.log(
                    chalk.gray(`    last activity: ${ageSec}s ago`)
                  );
                }
                console.log();

                if (opts.wait) {
                  console.log(
                    chalk.gray(
                      `  Waiting up to ${Math.round(timeoutMs / 1000)}s for ${n} to go idle...`
                    )
                  );
                  const final = await waitUntilIdle({
                    agentDir,
                    timeoutMs,
                  });
                  if (final.busy) {
                    console.error(
                      chalk.red(
                        `  Timed out waiting for ${n} to go idle. Skipping restart — pass --force to override.`
                      )
                    );
                    sawAbort = true;
                    continue;
                  }
                  console.log(chalk.green(`  ${n} went idle — restarting.`));
                } else {
                  const proceed = await askYesNo(
                    `Kill in-flight work and restart ${n} anyway?`,
                    false
                  );
                  if (!proceed) {
                    console.log(
                      chalk.gray(
                        `  Aborted restart of ${n}. Re-run with --wait to wait, or --force to skip the check.`
                      )
                    );
                    sawAbort = true;
                    continue;
                  }
                }
              }
            }

            try {
              // Stamp the restart reason so the next greeting card can
              // surface it. `cli: deploying <sha> <subject>` when the
              // running build's commit differs from HEAD, `cli: restart`
              // otherwise. Written BEFORE the systemctl restart so the
              // file is on disk by the time the next agent boots.
              const reason = buildCliRestartReason({ buildCommit: BUILD_COMMIT });
              // preserveExisting: keep the gateway-written "user: /restart
              // from chat" (or similar) marker if it's fresh, so the next
              // greeting shows the real user-facing attribution rather
              // than being overwritten by the downstream CLI.
              writeRestartReasonMarker(n, reason, { preserveExisting: true });

              // Reconcile + restart in one call. If reconcile throws, we
              // never reach the restart — a broken config must not be
              // applied on top of a running process. See
              // reconcileAndRestartAgent for the full rationale.
              const res = await reconcileAndRestartAgent(
                n,
                config,
                agentsDir,
                getConfigPath(program),
                { graceful: opts.gracefulRestart },
              );

              if (opts.gracefulRestart) {
                if (res.restarted) {
                  await printReadyOutcome(n, config, agentsDir, "Restarted");
                } else if (res.waitingForTurn) {
                  console.log(chalk.yellow(`Restart scheduled for ${n} (waiting for current turn to complete)`));
                }
              } else {
                await printReadyOutcome(n, config, agentsDir, "Restarted");
              }
            } catch (err) {
              console.error(
                chalk.red(`Failed to restart ${n}: ${(err as Error).message}`)
              );
            }
          }

          if (sawAbort) {
            process.exitCode = 1;
          }
        }
      )
    );

  // switchroom agent attach <name>
  agent
    .command("attach <name>")
    .description("Attach to an agent's tmux session")
    .action(
      withConfigError(async (name: string) => {
        const config = getConfig(program);

        if (!config.agents[name]) {
          console.error(chalk.red(`Agent "${name}" is not defined in switchroom.yaml`));
          process.exit(1);
        }

        // attachAgent must exec (replace process), so this won't return on success
        attachAgent(name);
      })
    );

  // switchroom agent logs <name>
  agent
    .command("logs <name>")
    .description("Show agent logs")
    .option("-f, --follow", "Follow log output")
    .action(
      withConfigError(async (name: string, opts: { follow?: boolean }) => {
        const config = getConfig(program);

        if (!config.agents[name]) {
          console.error(chalk.red(`Agent "${name}" is not defined in switchroom.yaml`));
          process.exit(1);
        }

        getAgentLogs(name, opts.follow ?? false);
      })
    );

  // switchroom agent reconcile <name|all>
  agent
    .command("reconcile <name>")
    .description(
      "Re-apply switchroom.yaml to an existing agent (rewrites .mcp.json + settings.json + start.sh + CLAUDE.md)"
    )
    .option("--restart", "Restart the agent after reconciling")
    .option("--graceful-restart", "Wait for active turn to complete before restarting")
    .option(
      "--preserve-claude-md",
      "Opt out of regenerating CLAUDE.md — use if you have hand-edits you don't want to migrate to CLAUDE.custom.md yet"
    )
    .action(
      withConfigError(async (name: string, opts: { restart?: boolean; gracefulRestart?: boolean; preserveClaudeMd?: boolean }) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);
        const configPath = getConfigPath(program);

        const names = name === "all" ? Object.keys(config.agents) : [name];
        let totalChanges = 0;
        let agentsTouched = 0;

        for (const n of names) {
          const agentConfig = config.agents[n];
          if (!agentConfig) {
            console.error(
              chalk.red(`Agent "${n}" is not defined in switchroom.yaml`)
            );
            continue;
          }
          try {
            const result = reconcileAgent(
              n,
              agentConfig,
              agentsDir,
              config.telegram,
              config,
              configPath,
              { preserveClaudeMd: opts.preserveClaudeMd },
            );
            if (result.changes.length === 0) {
              console.log(chalk.gray(`  ${n}: already in sync`));
            } else {
              agentsTouched++;
              totalChanges += result.changes.length;
              console.log(chalk.green(`  ${n}: reconciled (${result.changes.length} file${result.changes.length === 1 ? "" : "s"})`));

              // Categorize and display changes by reload semantics
              const { changesBySemantics } = result;
              if (changesBySemantics) {
                const { hot, staleTillRestart, restartRequired } = changesBySemantics;

                if (restartRequired.length > 0) {
                  console.log(chalk.yellow("\n  Changed (restart REQUIRED, MCP/settings/launch):"));
                  for (const f of restartRequired) {
                    console.log(chalk.yellow(`    - ${f}`));
                  }
                }

                if (staleTillRestart.length > 0) {
                  console.log(chalk.yellow("\n  Changed (STALE until restart, stable prefix):"));
                  for (const f of staleTillRestart) {
                    console.log(chalk.yellow(`    - ${f}`));
                  }
                }

                if (hot.length > 0) {
                  console.log(chalk.green("\n  Changed (HOT, active next turn, no restart needed):"));
                  for (const f of hot) {
                    console.log(chalk.green(`    - ${f}`));
                  }
                }

                // If only hot changes, suppress restart suggestion
                const needsRestart = restartRequired.length > 0 || staleTillRestart.length > 0;
                if (!needsRestart && hot.length > 0) {
                  console.log(chalk.green("\n  (no restart needed, changes active next turn)"));
                } else if (needsRestart && !opts.restart && !opts.gracefulRestart) {
                  console.log(chalk.gray(`\nRestart: switchroom agent restart ${n}`));
                  console.log(chalk.gray(`  (Or add --restart / --graceful-restart to this reconcile)`));
                }
              } else {
                // Fallback if changesBySemantics not available (shouldn't happen)
                for (const f of result.changes) {
                  console.log(chalk.gray(`    - ${f}`));
                }
              }
            }

            if ((opts.restart || opts.gracefulRestart) && result.changes.length > 0) {
              try {
                // Summarise the files that changed (at most 3) so the
                // greeting's Restarted row is meaningful rather than
                // "reconcile: 7 files".
                const files = result.changes;
                const head = files.slice(0, 3).join(", ");
                const tail = files.length > 3 ? `, +${files.length - 3} more` : "";
                const reason = `reconcile: ${head}${tail}`;
                // Same cooperative race guard — gateway /reconcile may
                // have pre-seeded a user-attributed marker.
                writeRestartReasonMarker(n, reason, { preserveExisting: true });
                if (opts.gracefulRestart) {
                  const restartResult = await gracefulRestartAgent(n);
                  if (restartResult.restartedImmediately) {
                    console.log(chalk.green(`  ${n}: restarted immediately (no active turn)`));
                  } else if (restartResult.waitingForTurn) {
                    console.log(chalk.yellow(`  ${n}: restart scheduled (waiting for current turn to complete)`));
                  }
                } else {
                  restartAgent(n);
                  console.log(chalk.green(`  ${n}: restarted`));
                }
              } catch (err) {
                console.error(
                  chalk.red(`  ${n}: restart failed: ${(err as Error).message}`)
                );
              }
            }
          } catch (err) {
            console.error(
              chalk.red(`  ${n}: ${(err as Error).message}`)
            );
          }
        }

        if (totalChanges === 0 && agentsTouched === 0) {
          console.log(chalk.gray("\nNothing to do."));
        } else {
          console.log(
            chalk.bold(
              `\nReconciled ${agentsTouched} agent(s), ${totalChanges} file(s) changed.`
            )
          );
          if (!opts.restart) {
            console.log(
              chalk.gray(
                "  Tip: pass --restart to apply changes immediately, or run `switchroom agent restart <name>`."
              )
            );
          }
        }
      })
    );

  // switchroom agent grant <name> <tool>
  agent
    .command("grant <name> <tool>")
    .description(
      "Add a tool name (or 'all') to an agent's tools.allow in switchroom.yaml, then reconcile"
    )
    .option("--no-restart", "Skip restarting the agent after granting")
    .action(
      withConfigError(async (name: string, tool: string, opts: { restart?: boolean }) => {
        const configPath = getConfigPath(program);
        if (!existsSync(configPath)) {
          console.error(chalk.red(`switchroom.yaml not found at ${configPath}`));
          process.exit(1);
        }

        // Mutate the YAML in place, preserving comments where possible
        const raw = readFileSync(configPath, "utf-8");
        const doc = YAML.parseDocument(raw);
        const agents = doc.get("agents") as YAML.YAMLMap | null;
        if (!agents || !agents.has(name)) {
          console.error(chalk.red(`Agent "${name}" is not defined in switchroom.yaml`));
          process.exit(1);
        }
        const agentNode = agents.get(name) as YAML.YAMLMap;

        let tools = agentNode.get("tools") as YAML.YAMLMap | null;
        if (!tools) {
          tools = new YAML.YAMLMap();
          agentNode.set("tools", tools);
        }
        let allow = tools.get("allow") as YAML.YAMLSeq | null;
        if (!allow) {
          allow = new YAML.YAMLSeq();
          tools.set("allow", allow);
        }
        const existingAllow = (allow.toJSON() as string[]) ?? [];
        if (existingAllow.includes(tool)) {
          console.log(chalk.gray(`  ${name}: ${tool} already allowed`));
        } else {
          allow.add(tool);
          writeFileSync(configPath, doc.toString(), "utf-8");
          console.log(chalk.green(`  ${name}: granted ${tool}`));
        }

        // Reload + reconcile
        const config = loadConfig(configPath);
        const agentsDir = resolveAgentsDir(config);
        const result = reconcileAgent(
          name,
          config.agents[name],
          agentsDir,
          config.telegram,
          config,
          configPath,
        );
        if (result.changes.length > 0) {
          console.log(chalk.green(`  ${name}: reconciled (${result.changes.length} file(s))`));
          if (opts.restart !== false) {
            try {
              restartAgent(name);
              console.log(chalk.green(`  ${name}: restarted`));
            } catch (err) {
              console.error(chalk.red(`  ${name}: restart failed: ${(err as Error).message}`));
            }
          }
        } else {
          console.log(chalk.gray(`  ${name}: already in sync`));
        }
      })
    );

  // switchroom agent dangerous <name>
  agent
    .command("dangerous <name>")
    .description(
      "Enable full tool access for an agent (sets tools.allow: [all] in switchroom.yaml). Reconciles + restarts."
    )
    .option("--off", "Disable: clear tools.allow")
    .option("--no-restart", "Skip restarting the agent")
    .action(
      withConfigError(async (name: string, opts: { off?: boolean; restart?: boolean }) => {
        const configPath = getConfigPath(program);
        if (!existsSync(configPath)) {
          console.error(chalk.red(`switchroom.yaml not found at ${configPath}`));
          process.exit(1);
        }

        const raw = readFileSync(configPath, "utf-8");
        const doc = YAML.parseDocument(raw);
        const agents = doc.get("agents") as YAML.YAMLMap | null;
        if (!agents || !agents.has(name)) {
          console.error(chalk.red(`Agent "${name}" is not defined in switchroom.yaml`));
          process.exit(1);
        }
        const agentNode = agents.get(name) as YAML.YAMLMap;

        if (opts.off) {
          const tools = agentNode.get("tools") as YAML.YAMLMap | null;
          if (tools && tools.has("allow")) {
            tools.set("allow", new YAML.YAMLSeq());
            writeFileSync(configPath, doc.toString(), "utf-8");
            console.log(chalk.yellow(`  ${name}: dangerous mode OFF (tools.allow cleared)`));
          } else {
            console.log(chalk.gray(`  ${name}: dangerous mode was already off`));
          }
        } else {
          let tools = agentNode.get("tools") as YAML.YAMLMap | null;
          if (!tools) {
            tools = new YAML.YAMLMap();
            agentNode.set("tools", tools);
          }
          const allowSeq = new YAML.YAMLSeq();
          allowSeq.add("all");
          tools.set("allow", allowSeq);
          writeFileSync(configPath, doc.toString(), "utf-8");
          console.log(chalk.red(`  ${name}: dangerous mode ON — every built-in tool pre-approved`));
          console.log(chalk.gray(`    (tools.allow: [all] expands to Bash, Read, Write, Edit, WebFetch, ...)`));
        }

        // Reload + reconcile
        const config = loadConfig(configPath);
        const agentsDir = resolveAgentsDir(config);
        const result = reconcileAgent(
          name,
          config.agents[name],
          agentsDir,
          config.telegram,
          config,
          configPath,
        );
        if (result.changes.length > 0) {
          console.log(chalk.green(`  ${name}: reconciled (${result.changes.length} file(s))`));
          if (opts.restart !== false) {
            try {
              restartAgent(name);
              console.log(chalk.green(`  ${name}: restarted`));
            } catch (err) {
              console.error(chalk.red(`  ${name}: restart failed: ${(err as Error).message}`));
            }
          }
        } else {
          console.log(chalk.gray(`  ${name}: already in sync`));
        }
      })
    );

  // switchroom agent permissions <name>
  agent
    .command("permissions <name>")
    .description("Show the current permissions.allow list for an agent")
    .action(
      withConfigError(async (name: string) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);
        const settingsPath = resolve(
          agentsDir,
          name,
          ".claude",
          "settings.json",
        );
        if (!existsSync(settingsPath)) {
          console.error(
            chalk.red(`Agent "${name}" not found at ${settingsPath}`)
          );
          process.exit(1);
        }
        const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        const allow: string[] = settings.permissions?.allow ?? [];
        const deny: string[] = settings.permissions?.deny ?? [];
        const defaultMode: string | undefined = settings.permissions?.defaultMode;

        console.log(chalk.bold(`\nPermissions for ${name}\n`));
        if (defaultMode) {
          console.log(chalk.cyan(`  defaultMode: ${defaultMode}`));
        }
        console.log(chalk.bold(`\n  allow (${allow.length})`));
        for (const t of allow) console.log(chalk.green(`    + ${t}`));
        if (deny.length > 0) {
          console.log(chalk.bold(`\n  deny (${deny.length})`));
          for (const t of deny) console.log(chalk.red(`    - ${t}`));
        }
        console.log();
      })
    );

  // switchroom agent destroy <name>
  agent
    .command("destroy <name>")
    .description("Remove an agent's directory and systemd unit")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(
      withConfigError(async (name: string, opts: { yes?: boolean }) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);
        const agentDir = resolve(agentsDir, name);

        if (!opts.yes) {
          process.stdout.write(
            chalk.yellow(
              `Destroy agent "${name}"? This removes ${agentDir} and the systemd unit. [y/N] `
            )
          );
          const response = await new Promise<string>((resolve) => {
            process.stdin.setEncoding("utf-8");
            process.stdin.once("data", (data) => resolve(data.toString().trim()));
          });
          if (response.toLowerCase() !== "y") {
            console.log("Aborted.");
            return;
          }
        }

        // Stop the agent first
        try {
          stopAgent(name);
        } catch {
          // may already be stopped
        }

        // Remove systemd unit
        try {
          uninstallUnit(name);
          console.log(chalk.green(`  Removed systemd unit: switchroom-${name}.service`));
        } catch (err) {
          console.error(
            chalk.red(`  Failed to remove unit: ${(err as Error).message}`)
          );
        }

        // Remove agent directory
        if (existsSync(agentDir)) {
          rmSync(agentDir, { recursive: true, force: true });
          console.log(chalk.green(`  Removed directory: ${agentDir}`));
        } else {
          console.log(chalk.gray(`  Directory not found: ${agentDir}`));
        }

        console.log(chalk.green(`\nAgent "${name}" destroyed.`));
      })
    );

  // switchroom agent bootstrap <name>
  //
  // One-shot: scaffold + OAuth + start. For Phase 2 testing the OAuth URL is
  // printed to stdout and the code is pasted from stdin. Phase 3 replaces this
  // terminal stub with the foreman bot relay.
  agent
    .command("bootstrap <name>")
    .description(
      "Scaffold, authenticate, and start an agent in one flow. " +
      "Prints the OAuth URL to stdout and reads the code from stdin."
    )
    .requiredOption("--profile <profile>", "Profile to extend (e.g. health-coach)")
    .option(
      "--bot-token <token>",
      "BotFather token for the agent's Telegram bot " +
      "(alternative: set SWITCHROOM_BOT_TOKEN env var to avoid leaking token into shell history)"
    )
    .option("--rollback-on-fail", "Remove scaffold dir if auth fails (default: keep for retry)")
    .action(
      withConfigError(async (
        name: string,
        opts: { profile: string; botToken?: string; rollbackOnFail?: boolean },
      ) => {
        const configPath = getConfigPath(program);

        // Resolve bot token: flag takes precedence, then env var.
        const botToken = opts.botToken ?? process.env.SWITCHROOM_BOT_TOKEN;
        if (!botToken) {
          console.error(
            chalk.red(
              "Error: --bot-token is required (or set SWITCHROOM_BOT_TOKEN env var)."
            )
          );
          process.exit(1);
        }

        console.log(chalk.bold(`\nBootstrapping agent: ${name}\n`));
        console.log(chalk.gray(`  Profile:   ${opts.profile}`));
        console.log(chalk.gray(`  Config:    ${configPath}`));
        console.log();

        // ── Step 1: createAgent ───────────────────────────────────────────
        let creationResult: Awaited<ReturnType<typeof createAgent>>;
        try {
          creationResult = await createAgent({
            name,
            profile: opts.profile,
            telegramBotToken: botToken,
            configPath,
            rollbackOnFail: opts.rollbackOnFail ?? false,
          });
        } catch (err) {
          console.error(chalk.red(`Bootstrap failed: ${(err as Error).message}`));
          process.exit(1);
        }

        const { loginUrl, sessionName, agentDir } = creationResult;
        console.log(chalk.green(`  Agent scaffolded at ${agentDir}`));
        console.log(chalk.green(`  Auth session: ${sessionName}`));

        if (loginUrl) {
          console.log(chalk.bold(`\n  Open this URL in your browser to authenticate:\n`));
          console.log(chalk.cyan(`  ${loginUrl}\n`));
        } else {
          console.log(
            chalk.yellow(
              `\n  Auth session started but no URL yet. ` +
              `Check: tmux attach -t ${sessionName}\n`
            )
          );
        }

        // ── Step 2: Read code from stdin (Phase 2 terminal stub) ──────────
        process.stdout.write(chalk.bold("  Paste the browser code here: "));
        const code = await new Promise<string>((resolve) => {
          process.stdin.setEncoding("utf-8");
          let buf = "";
          process.stdin.on("data", (chunk) => {
            buf += chunk.toString();
            const newlineIdx = buf.indexOf("\n");
            if (newlineIdx !== -1) {
              process.stdin.removeAllListeners("data");
              resolve(buf.slice(0, newlineIdx).trim());
            }
          });
        });

        if (!code) {
          console.error(chalk.red("No code entered. Aborting."));
          console.log(
            chalk.gray(
              `  Retry auth later with: switchroom auth code ${name} <code>`
            )
          );
          process.exit(1);
        }

        // ── Step 3: completeCreation ──────────────────────────────────────
        console.log(chalk.gray(`\n  Submitting code…`));
        let completionResult: Awaited<ReturnType<typeof completeCreation>>;
        try {
          completionResult = await completeCreation(name, code, { configPath });
        } catch (err) {
          console.error(chalk.red(`Completion failed: ${(err as Error).message}`));
          process.exit(1);
        }

        const { outcome, started } = completionResult;

        if (outcome.kind !== "success") {
          console.error(chalk.red(`\n  Auth failed (${outcome.kind}).`));
          if (outcome.paneTailText) {
            console.error(chalk.gray(`  Pane output: ${outcome.paneTailText}`));
          }
          console.log(
            chalk.yellow(
              `\n  Retry with: switchroom auth code ${name} <code>\n` +
              `  Or restart the auth flow: switchroom auth reauth ${name}\n`
            )
          );
          process.exit(1);
        }

        if (started) {
          console.log(chalk.bold.green(`\n  Agent "${name}" is online!\n`));
        } else {
          console.log(
            chalk.yellow(
              `\n  OAuth saved, but agent start failed. ` +
              `Start with: switchroom agent start ${name}\n`
            )
          );
        }
      })
    );
}
