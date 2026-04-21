import { execFileSync, execSync } from "node:child_process";
import { writeFileSync, mkdirSync, unlinkSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import type { SwitchroomConfig, ScheduleEntry } from "../config/schema.js";
import { resolveAgentsDir } from "../config/loader.js";
import { usesSwitchroomTelegramPlugin } from "../config/merge.js";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeUnitDescription(s: string): string {
  // systemd unit files disallow newlines in single-line values and treat
  // `%` as a specifier. Strip both so descriptions can't break unit parsing.
  return s.replace(/[\r\n]+/g, " ").replace(/%/g, "%%");
}

const SYSTEMD_USER_DIR = resolve(
  process.env.HOME ?? "/root",
  ".config/systemd/user"
);

function unitName(name: string): string {
  return `switchroom-${name}`;
}

function unitFilePath(name: string): string {
  return resolve(SYSTEMD_USER_DIR, `${unitName(name)}.service`);
}

export function generateUnit(name: string, agentDir: string, useAutoaccept = false, gatewayUnitName?: string): string {
  const logFile = resolve(agentDir, "service.log");
  const autoacceptExp = resolve(import.meta.dirname, "../../bin/autoaccept.exp");

  const execStart = useAutoaccept
    ? `/usr/bin/script -qfc "/usr/bin/expect -f ${autoacceptExp} ${agentDir}/start.sh" ${logFile}`
    : `/usr/bin/script -qfc "/bin/bash -l ${agentDir}/start.sh" ${logFile}`;

  const afterDeps = ["network-online.target"];
  if (useAutoaccept) afterDeps.push(`${unitName(gatewayUnitName ?? GATEWAY_UNIT_NAME)}.service`);

  return `[Unit]
Description=switchroom agent: ${name}
After=${afterDeps.join(" ")}
Wants=network-online.target
StartLimitBurst=5
StartLimitIntervalSec=120

[Service]
Type=simple
ExecStart=${execStart}
StandardOutput=journal
StandardError=journal
Restart=on-failure
RestartSec=5
WorkingDirectory=${agentDir}

[Install]
WantedBy=default.target
`;
}

export function installUnit(name: string, unitContent: string): void {
  mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
  writeFileSync(unitFilePath(name), unitContent, { mode: 0o644 });
}

export function uninstallUnit(name: string): void {
  const path = unitFilePath(name);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

const GATEWAY_UNIT_NAME = "gateway";

/**
 * Resolve the gateway unit name for a specific agent.
 *
 * Each telegram-using agent gets its own dedicated gateway unit
 * (`switchroom-<agent>-gateway.service`) pointing at its own state dir
 * with its own bot token. Agents that don't use the switchroom-telegram
 * plugin return undefined — they have no gateway dependency.
 *
 * Earlier implementations returned a single shared gateway name (the
 * first telegram-using agent's), which silently broke every agent
 * after the first: their bot token was in a state dir no gateway
 * was watching, so Telegram polling never started. The multi-agent
 * case is exactly what switchroom is for, so the one-gateway-per-agent
 * model is the correct default.
 */
export function resolveGatewayUnitName(
  config: SwitchroomConfig,
  agentName?: string,
): string | undefined {
  if (agentName !== undefined) {
    const agent = config.agents[agentName];
    if (!agent) return undefined;
    if (!usesSwitchroomTelegramPlugin(agent)) return undefined;
    return `${agentName}-gateway`;
  }
  // Legacy no-arg form — preserved for callers that still want the
  // historical "first telegram agent's gateway" default.
  const first = Object.keys(config.agents).find(
    (name) => usesSwitchroomTelegramPlugin(config.agents[name]),
  );
  return first ? `${first}-gateway` : GATEWAY_UNIT_NAME;
}

/**
 * Generate the systemd unit for an agent's telegram gateway.
 *
 * `agentName` is required and used for two things:
 *   1. the unit description (so `systemctl status` says which agent it's for),
 *   2. the `SWITCHROOM_AGENT_NAME` env var, which the gateway reads via
 *      getMyAgentName() to decide whether `/restart`, `/reconcile`, etc.
 *      target the agent the bot is bound to.
 *
 * Without SWITCHROOM_AGENT_NAME, the gateway falls back to basename(cwd),
 * which is literally the string "telegram" (because WorkingDirectory is
 * `.../<agent>/telegram`). Every self-targeting command then resolves to
 * an agent named "telegram", which doesn't exist, and the switchroom CLI
 * exits non-zero — silently, since the command is spawned detached. This
 * was the production bug that prompted this function's signature change.
 */
/**
 * Decide which `switchroom` CLI binary the gateway should invoke when
 * it shells out for slash-command actions (/restart, /auth reauth,
 * /reconcile, etc.).
 *
 * Historically we pointed at `~/.bun/bin/switchroom` (installed by
 * `bun install -g switchroom-ai`). That file has `#!/usr/bin/env node`
 * as its shebang, so on bun-only hosts without node on PATH the binary
 * ENOENTs silently and every gateway CLI invocation fails with no
 * Telegram-facing signal (see reference/restart-and-know-what-im-running.md
 * "silent respawn" anti-pattern).
 *
 * Resolution order:
 *   1. `node` is on PATH → packaged CLI at `<bunBinDir>/switchroom`.
 *      No wrapper needed; preserves behaviour for hosts that ship node.
 *   2. `node` missing AND the repo-local wrapper exists at
 *      `scripts/switchroom-cli-wrapper.sh` → the wrapper (which invokes
 *      the CLI through bun). This is the bun-only host path.
 *   3. Otherwise → packaged CLI as before, and trust the operator to
 *      install node. We never silently omit the env var.
 *
 * The detection runs at unit-generation time (scaffold / reconcile).
 * Reconciling on a host that has since installed node flips back to
 * the packaged path.
 */
export interface ResolveCliOpts {
  /** Override for `hasNodeOnPath()` — tests inject a fixed value. */
  nodeAvailable?: boolean;
  /** Override for existsSync(wrapper) — tests inject a fixed value. */
  wrapperExists?: boolean;
}

export function resolveSwitchroomCliPath(bunBinDir: string, opts: ResolveCliOpts = {}): string {
  const packagedCli = resolve(bunBinDir, "switchroom");
  const wrapper = resolve(import.meta.dirname, "../../scripts/switchroom-cli-wrapper.sh");
  const nodeAvailable = opts.nodeAvailable ?? hasNodeOnPath();
  if (nodeAvailable) return packagedCli;
  const wrapperExists = opts.wrapperExists ?? existsSync(wrapper);
  if (wrapperExists) return wrapper;
  return packagedCli;
}

function hasNodeOnPath(): boolean {
  try {
    // `command -v node` is POSIX-portable and doesn't execute node; it
    // just checks PATH. execSync throws non-zero, which maps to
    // "node not found".
    execSync("command -v node", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function generateGatewayUnit(stateDir: string, agentName: string): string {
  const pluginDir = resolve(import.meta.dirname, "../../telegram-plugin");
  const gatewayEntry = resolve(pluginDir, "gateway/gateway.ts");
  const logFile = resolve(stateDir, "gateway.log");
  const homeDir = process.env.HOME ?? "/root";
  const bunBin = resolve(homeDir, ".bun/bin/bun");
  const bunBinDir = dirname(bunBin);
  const nodeBinDir = dirname(process.execPath);
  const switchroomCli = resolveSwitchroomCliPath(bunBinDir);
  const unitPath = `${bunBinDir}:${nodeBinDir}:/usr/local/bin:/usr/bin:/bin`;
  const desc = agentName ? `switchroom telegram gateway (${agentName})` : "switchroom telegram gateway";

  return `[Unit]
Description=${desc}
After=network-online.target
Wants=network-online.target
StartLimitBurst=10
StartLimitIntervalSec=60

[Service]
Type=simple
ExecStart=/usr/bin/script -qfc "${bunBin} ${gatewayEntry}" ${logFile}
StandardOutput=journal
StandardError=journal
Restart=always
RestartSec=3
WorkingDirectory=${stateDir}
Environment=PATH=${unitPath}
Environment=SWITCHROOM_CLI_PATH=${switchroomCli}
Environment=TELEGRAM_STATE_DIR=${stateDir}
Environment=SWITCHROOM_AGENT_NAME=${agentName}

[Install]
WantedBy=default.target
`;
}

export function installAllUnits(config: SwitchroomConfig): void {
  const agentsDir = resolveAgentsDir(config);
  const installedAgents: string[] = [];

  // Every telegram-using agent gets its OWN gateway unit. The gateway
  // process needs its own state dir (for the per-agent bot token in
  // .env and per-agent IPC socket), so one shared gateway cannot cover
  // multiple agents. See resolveGatewayUnitName() for rationale.
  for (const agentName of Object.keys(config.agents)) {
    const agent = config.agents[agentName];
    const agentDir = resolve(agentsDir, agentName);
    const useAutoaccept = usesSwitchroomTelegramPlugin(agent);
    const gwName = useAutoaccept ? `${agentName}-gateway` : undefined;

    const content = generateUnit(agentName, agentDir, useAutoaccept, gwName);
    installUnit(agentName, content);
    installedAgents.push(unitName(agentName));

    if (useAutoaccept && gwName) {
      const stateDir = resolve(agentDir, "telegram");
      const gatewayContent = generateGatewayUnit(stateDir, agentName);
      installUnit(gwName, gatewayContent);
      installedAgents.push(unitName(gwName));
    }
  }

  daemonReload();
  enableUnits(installedAgents);
  ensureLinger();
}

export function daemonReload(): void {
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe" });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
    const message = stderr || (err instanceof Error ? err.message : String(err));
    throw new Error(`Failed to reload systemd user daemon: ${message}`);
  }
}

function enableUnits(unitNames: string[]): void {
  if (unitNames.length === 0) return;
  const services = unitNames.map((n) => `${n}.service`);
  try {
    execFileSync("systemctl", ["--user", "enable", ...services], { stdio: "pipe" });
  } catch {
    // non-fatal — units are installed but won't auto-start on boot
  }
}

function ensureLinger(): void {
  const user = process.env.USER ?? process.env.LOGNAME;
  if (!user) return;
  try {
    execFileSync("loginctl", ["enable-linger", user], { stdio: "pipe" });
  } catch {
    // non-fatal — may need sudo; services still work for logged-in sessions
  }
}

// ─── Scheduled task timers ─────────────────────────────────────────────────

const DOW_MAP: Record<string, string> = {
  "0": "Sun", "7": "Sun", "1": "Mon", "2": "Tue", "3": "Wed",
  "4": "Thu", "5": "Fri", "6": "Sat",
};

// Convert a standard 5-field cron expression to a systemd OnCalendar
// value. Supports: exact values, wildcards, ranges (1-5), step values,
// and comma-separated lists.
//
// Examples:
//   "0 8 * * *"     → "*-*-* 08:00:00"
//   "0 8 * * 1-5"   → "Mon..Fri *-*-* 08:00:00"
//   "30 9 * * 0,6"  → "Sat,Sun *-*-* 09:30:00"
export function cronToOnCalendar(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression (expected 5 fields): ${cron}`);
  }
  const [minute, hour, dom, month, dow] = parts;

  // Day-of-week → systemd format
  let dowPrefix = "";
  if (dow !== "*") {
    const converted = dow.split(",").map(segment => {
      const range = segment.match(/^(\d)-(\d)$/);
      if (range) {
        const from = DOW_MAP[range[1]] ?? range[1];
        const to = DOW_MAP[range[2]] ?? range[2];
        return `${from}..${to}`;
      }
      return DOW_MAP[segment] ?? segment;
    }).join(",");
    dowPrefix = `${converted} `;
  }

  // Month
  const monthPart = month === "*" ? "*" : month.padStart(2, "0");

  // Day-of-month
  const domPart = dom === "*" ? "*" : dom.padStart(2, "0");

  // Hour — handle */N step
  let hourPart: string;
  const hourStep = hour.match(/^\*\/(\d+)$/);
  if (hourStep) {
    hourPart = `00/${hourStep[1]}`;
  } else {
    hourPart = hour === "*" ? "*" : hour.padStart(2, "0");
  }

  // Minute — handle */N step
  let minutePart: string;
  const minStep = minute.match(/^\*\/(\d+)$/);
  if (minStep) {
    minutePart = `00/${minStep[1]}`;
  } else {
    minutePart = minute === "*" ? "*" : minute.padStart(2, "0");
  }

  return `${dowPrefix}*-${monthPart}-${domPart} ${hourPart}:${minutePart}:00`;
}

/**
 * Generate a systemd .timer unit for a scheduled task.
 */
export function generateTimerUnit(
  agentName: string,
  index: number,
  cronExpr: string,
  prompt: string,
): string {
  const onCalendar = cronToOnCalendar(cronExpr);
  const truncated = prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
  const desc = sanitizeUnitDescription(truncated);
  return `[Unit]
Description=switchroom scheduled: ${agentName} #${index} — ${desc}

[Timer]
OnCalendar=${onCalendar}
Persistent=true
RandomizedDelaySec=30

[Install]
WantedBy=timers.target
`;
}

/**
 * Generate a systemd .service unit for a scheduled task (oneshot).
 */
export function generateTimerServiceUnit(
  agentName: string,
  index: number,
  agentDir: string,
): string {
  const scriptPath = join(agentDir, "telegram", `cron-${index}.sh`);
  return `[Unit]
Description=switchroom scheduled task: ${agentName} #${index}

[Service]
Type=oneshot
ExecStart=/bin/bash ${scriptPath}
WorkingDirectory=${agentDir}
`;
}

/**
 * Timer unit file path for a scheduled task.
 */
function timerFilePath(agentName: string, index: number): string {
  return resolve(SYSTEMD_USER_DIR, `switchroom-${agentName}-cron-${index}.timer`);
}

function timerServiceFilePath(agentName: string, index: number): string {
  return resolve(SYSTEMD_USER_DIR, `switchroom-${agentName}-cron-${index}.service`);
}

/**
 * Install timer + service units for all scheduled tasks of an agent.
 * Also removes stale timers that no longer have a corresponding
 * schedule entry (e.g. user removed a schedule from switchroom.yaml).
 */
export function installScheduleTimers(
  agentName: string,
  agentDir: string,
  schedule: ScheduleEntry[],
): void {
  mkdirSync(SYSTEMD_USER_DIR, { recursive: true });

  // Write current timers
  for (let i = 0; i < schedule.length; i++) {
    const entry = schedule[i];
    const timerContent = generateTimerUnit(agentName, i, entry.cron, entry.prompt);
    const serviceContent = generateTimerServiceUnit(agentName, i, agentDir);
    writeFileSync(timerFilePath(agentName, i), timerContent, { mode: 0o644 });
    writeFileSync(timerServiceFilePath(agentName, i), serviceContent, { mode: 0o644 });
  }

  // Remove stale timers (indices beyond current schedule length)
  const prefix = `switchroom-${agentName}-cron-`;
  const staleRegex = new RegExp(`^${escapeRegex(prefix)}(\\d+)\\.(timer|service)$`);
  if (existsSync(SYSTEMD_USER_DIR)) {
    for (const file of readdirSync(SYSTEMD_USER_DIR)) {
      if (!file.startsWith(prefix)) continue;
      const match = file.match(staleRegex);
      if (match && parseInt(match[1], 10) >= schedule.length) {
        const stale = resolve(SYSTEMD_USER_DIR, file);
        // Stop the timer before removing — argv array, not shell.
        try {
          execFileSync("systemctl", ["--user", "stop", file], { stdio: "pipe" });
        } catch { /* may not be running */ }
        unlinkSync(stale);
      }
    }
  }
}

/**
 * Enable and start all schedule timers for an agent.
 */
export function enableScheduleTimers(agentName: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const timerName = `switchroom-${agentName}-cron-${i}.timer`;
    try {
      execFileSync("systemctl", ["--user", "enable", "--now", timerName], { stdio: "pipe" });
    } catch { /* best effort */ }
  }
}
