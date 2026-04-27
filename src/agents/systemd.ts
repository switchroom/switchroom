import { execFileSync, execSync } from "node:child_process";
import { writeFileSync, mkdirSync, unlinkSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import type { SwitchroomConfig, ScheduleEntry } from "../config/schema.js";
import { resolveAgentsDir } from "../config/loader.js";
import { usesSwitchroomTelegramPlugin, resolveAgentConfig } from "../config/merge.js";
import { resolveTimezone } from "../config/timezone.js";
import { COMMIT_SHA } from "../build-info.js";

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

export function unitFilePath(name: string): string {
  return resolve(SYSTEMD_USER_DIR, `${unitName(name)}.service`);
}

export function generateUnit(
  name: string,
  agentDir: string,
  useAutoaccept = false,
  gatewayUnitName?: string,
  timezone?: string,
): string {
  const logFile = resolve(agentDir, "service.log");
  const autoacceptExp = resolve(import.meta.dirname, "../../bin/autoaccept.exp");

  const execStart = useAutoaccept
    ? `/usr/bin/script -qfc "/usr/bin/expect -f ${autoacceptExp} ${agentDir}/start.sh" ${logFile}`
    : `/usr/bin/script -qfc "/bin/bash -l ${agentDir}/start.sh" ${logFile}`;

  const afterDeps = ["network-online.target"];
  if (useAutoaccept) afterDeps.push(`${unitName(gatewayUnitName ?? GATEWAY_UNIT_NAME)}.service`);

  // TZ= makes subprocess `date`, `Date.now()`-formatted strings, and
  // anything else that reads the env see the right zone — cheap insurance
  // beyond the UserPromptSubmit hint. SWITCHROOM_TIMEZONE is the canonical
  // source that bin/timezone-hook.sh reads to emit the per-turn context line.
  const tzEnv = timezone
    ? `Environment=TZ=${timezone}\nEnvironment=SWITCHROOM_TIMEZONE=${timezone}\n`
    : "";

  // Stamp the current binary's commit SHA so per-agent "started on X"
  // reporting can show what code the agent launched under, even if the
  // binary has since been updated. `getAgentStartSha` in lifecycle.ts
  // reads this env var back from the running unit via `systemctl show`.
  const shaEnv = COMMIT_SHA
    ? `Environment=SWITCHROOM_AGENT_START_SHA=${COMMIT_SHA}\n`
    : "";

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
# Memory ceiling: MemoryHigh triggers kernel reclaim at 1.5G so the
# process is throttled before hitting the hard ceiling. MemoryMax=2G is
# the hard limit — once hit, the kernel OOM-kills the unit. Combined
# with Restart=on-failure (already set above), this gives automatic
# recovery from memory-growth hangs observed in production (issue #116):
# three klanker hangs in 10h where RSS climbed past 1 GB before the
# process froze — systemd still reported active (running) with no way to
# detect or auto-recover. 2G gives ample headroom above the observed
# 1 GB peak while providing a reliable ceiling.
MemoryHigh=1536M
MemoryMax=2G
WorkingDirectory=${agentDir}
# Optional vault-decrypted env. The "-" prefix makes systemd silently
# skip the file when absent (e.g. pre-"switchroom vault init" or
# agents that don't use the vault). %h resolves to the invoking user's
# home under "systemd --user", so this works without hardcoding paths.
EnvironmentFile=-%h/.switchroom/.env.vault
${tzEnv}${shaEnv}
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

export function generateGatewayUnit(stateDir: string, agentName: string, adminEnabled = false): string {
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
# Give the gateway 45s to drain its long-poll on SIGTERM. The drain
# itself budgets 35s (SHUTDOWN_DRAIN_BUDGET_MS in gateway.ts) plus a
# 5s force-exit safety; the extra 5s is systemd-side headroom before
# SIGKILL. Without enough drain time the OLD process's getUpdates TCP
# socket hasn't FIN'd before the NEW process tries to poll, and both
# 409 against each other. See 2026-04-23 incident in startup-mutex.ts.
TimeoutStopSec=45
WorkingDirectory=${stateDir}
# Optional vault-decrypted env — same rationale as the agent unit.
# "-" prefix = no error if the file is missing; %h resolves to the
# user's home under "systemd --user".
EnvironmentFile=-%h/.switchroom/.env.vault
Environment=PATH=${unitPath}
Environment=SWITCHROOM_CLI_PATH=${switchroomCli}
Environment=TELEGRAM_STATE_DIR=${stateDir}
Environment=SWITCHROOM_AGENT_NAME=${agentName}
${adminEnabled ? `Environment=SWITCHROOM_AGENT_ADMIN=true\n` : ''}
[Install]
WantedBy=default.target
`;
}

// ─── Foreman unit ──────────────────────────────────────────────────────────

/**
 * Generate the systemd user unit for the foreman admin bot.
 *
 * The foreman reads its bot token from ~/.switchroom/foreman/.env and its
 * access list from ~/.switchroom/foreman/access.json. It runs continuously
 * (Restart=always) — it's the entry point for Telegram-only fleet management.
 */
export function generateForemanUnit(): string {
  const pluginDir = resolve(import.meta.dirname, "../../telegram-plugin");
  const foremanEntry = resolve(pluginDir, "foreman/foreman.ts");
  const homeDir = process.env.HOME ?? "/root";
  const foremanDir = resolve(homeDir, ".switchroom", "foreman");
  const logFile = resolve(foremanDir, "foreman.log");
  const bunBin = resolve(homeDir, ".bun/bin/bun");
  const bunBinDir = dirname(bunBin);
  const nodeBinDir = dirname(process.execPath);
  const switchroomCli = resolveSwitchroomCliPath(bunBinDir);
  const unitPath = `${bunBinDir}:${nodeBinDir}:/usr/local/bin:/usr/bin:/bin`;

  return `[Unit]
Description=switchroom foreman (fleet admin bot)
After=network-online.target
Wants=network-online.target
StartLimitBurst=10
StartLimitIntervalSec=60

[Service]
Type=simple
ExecStart=/usr/bin/script -qfc "${bunBin} ${foremanEntry}" ${logFile}
StandardOutput=journal
StandardError=journal
Restart=always
RestartSec=3
TimeoutStopSec=30
WorkingDirectory=${foremanDir}
EnvironmentFile=-%h/.switchroom/.env.vault
Environment=PATH=${unitPath}
Environment=SWITCHROOM_CLI_PATH=${switchroomCli}
Environment=SWITCHROOM_FOREMAN_DIR=${foremanDir}

[Install]
WantedBy=default.target
`;
}

/**
 * Write + enable the foreman unit file.
 * Creates ~/.switchroom/foreman/ if it doesn't exist.
 */
export function installForemanUnit(): void {
  const homeDir = process.env.HOME ?? "/root";
  const foremanDir = resolve(homeDir, ".switchroom", "foreman");
  mkdirSync(foremanDir, { recursive: true });
  const content = generateForemanUnit();
  const unitFileName = "switchroom-foreman";
  installUnit(unitFileName, content);
  daemonReload();
  enableUnits([unitFileName]);
  ensureLinger();
}

/**
 * Returns true if any agent in the config has at least one schedule entry
 * with a non-empty secrets array, OR if vault.broker.enabled is explicitly
 * true. Used to decide whether the broker unit should be installed.
 */
export function shouldInstallBrokerUnit(config: SwitchroomConfig): boolean {
  if (config.vault?.broker?.enabled === true) return true;
  for (const agent of Object.values(config.agents)) {
    const schedule = agent.schedule ?? [];
    if (schedule.some((e) => (e.secrets?.length ?? 0) > 0)) return true;
  }
  return false;
}

export function installAllUnits(config: SwitchroomConfig): void {
  const agentsDir = resolveAgentsDir(config);
  const installedAgents: string[] = [];

  // Install the vault-broker unit when any agent uses secrets or
  // vault.broker.enabled is set.
  //
  // Bug fix (issue #129): the previous call passed `"switchroom-vault-broker"`
  // as the unit name, but `installUnit` wraps that with another `switchroom-`
  // prefix, producing `switchroom-switchroom-vault-broker.service` on disk —
  // which never matched the `switchroom-vault-broker.service` reference used
  // by cron timers' After/Wants. Pass the bare `vault-broker` so the file
  // ends up correctly named.
  if (shouldInstallBrokerUnit(config)) {
    const homeDir = process.env.HOME ?? "/root";
    const bunBinDir = resolve(homeDir, ".bun", "bin");
    const brokerContent = generateBrokerUnit({ homeDir, bunBinDir });
    installUnit("vault-broker", brokerContent);
    // installedAgents holds the OS unit name (with the `switchroom-` prefix
    // that systemctl needs).
    installedAgents.push("switchroom-vault-broker");
  }

  // Every telegram-using agent gets its OWN gateway unit. The gateway
  // process needs its own state dir (for the per-agent bot token in
  // .env and per-agent IPC socket), so one shared gateway cannot cover
  // multiple agents. See resolveGatewayUnitName() for rationale.
  for (const agentName of Object.keys(config.agents)) {
    const agent = config.agents[agentName];
    const agentDir = resolve(agentsDir, agentName);
    const useAutoaccept = usesSwitchroomTelegramPlugin(agent);
    const gwName = useAutoaccept ? `${agentName}-gateway` : undefined;

    // Resolve the full cascade so profile/defaults-provided timezones flow
    // through to the unit's TZ= env. Without this, `generateUnit` would only
    // see the raw per-agent entry and miss the common case of
    // `defaults.timezone` being set once for the fleet.
    const resolved = resolveAgentConfig(config.defaults, config.profiles, agent);
    const timezone = resolveTimezone(config, resolved);

    const content = generateUnit(agentName, agentDir, useAutoaccept, gwName, timezone);
    installUnit(agentName, content);
    installedAgents.push(unitName(agentName));

    if (useAutoaccept && gwName) {
      const stateDir = resolve(agentDir, "telegram");
      // Pass admin flag so the gateway unit includes SWITCHROOM_AGENT_ADMIN=true
      // when the agent is configured with admin:true. The gateway reads this env
      // var to decide whether to intercept slash commands before forwarding to Claude.
      const adminEnabled = resolveAgentConfig(config.defaults, config.profiles, agent).admin === true;
      const gatewayContent = generateGatewayUnit(stateDir, agentName, adminEnabled);
      installUnit(gwName, gatewayContent);
      installedAgents.push(unitName(gwName));
    }
  }

  daemonReload();
  enableUnits(installedAgents);
  ensureLinger();

  // Auto-start the broker if it was just installed (issue #129). Agent and
  // gateway units stay in the enabled-but-not-running state until the user
  // runs `switchroom agent start <name>` — that's deliberate. The broker is
  // a passive infrastructure daemon, so there's no reason not to start it.
  if (installedAgents.includes("switchroom-vault-broker")) {
    startBrokerUnit();
  }
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

/**
 * Start (or restart) the vault-broker user unit.
 *
 * The broker is the only switchroom unit that should auto-start at install
 * time: agent and gateway units are intentionally left in the
 * enabled-but-not-running state until the user runs `switchroom agent start`.
 * The broker, by contrast, is a stateless infrastructure daemon — there is
 * no UX reason to delay starting it. Issue #129 added this so a fresh
 * install ends up with `switchroom-vault-broker.service` actually running,
 * rather than enabled-but-still-needs-manual-start.
 *
 * Best-effort: failure is logged but not fatal (broker can still be started
 * on demand by `switchroom vault broker start`). Skipped on non-Linux where
 * the broker is unsupported anyway.
 */
function startBrokerUnit(): void {
  if (process.platform !== "linux") return;
  try {
    // `restart` instead of `start` so reconciling an already-running broker
    // picks up any unit-file changes (PATH, RestartSec, etc.) on the spot.
    execFileSync(
      "systemctl",
      ["--user", "restart", "switchroom-vault-broker.service"],
      { stdio: "pipe" },
    );
  } catch (err) {
    // Don't surface as an error — the daemon may simply not have a vault to
    // unlock yet (it'll keep crashing until passphrase is pushed). Log on
    // stderr so operators have a breadcrumb.
    process.stderr.write(
      `[switchroom] note: failed to (re)start switchroom-vault-broker.service: ` +
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
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
 *
 * Declares a soft dependency on the vault-broker so the broker has a
 * chance to start before the cron fires. Wants+After rather than Requires
 * so a locked (or absent) broker does not hard-fail the timer.
 */
export function generateTimerServiceUnit(
  agentName: string,
  index: number,
  agentDir: string,
): string {
  const scriptPath = join(agentDir, "telegram", `cron-${index}.sh`);
  return `[Unit]
Description=switchroom scheduled task: ${agentName} #${index}
After=switchroom-vault-broker.service
Wants=switchroom-vault-broker.service

[Service]
Type=oneshot
ExecStart=/bin/bash ${scriptPath}
WorkingDirectory=${agentDir}
`;
}

// ─── Vault broker unit ─────────────────────────────────────────────────────

export interface BrokerUnitOpts {
  homeDir: string;
  bunBinDir: string;
  /**
   * When present, appends `LoadCredentialEncrypted=vault-passphrase:<path>`
   * to the [Service] block so systemd decrypts the credential at start and
   * injects it via $CREDENTIALS_DIRECTORY. The broker reads the file at
   * `$CREDENTIALS_DIRECTORY/vault-passphrase` and calls unlockFromPassphrase()
   * automatically.
   */
  autoUnlock?: { credentialPath: string };
}

/**
 * Generate the systemd user unit for the vault-broker daemon.
 *
 * Type=simple: the in-process sd_notify implementation in
 * `src/vault/broker/server.ts` uses `net.createConnection` (a STREAM
 * socket), but systemd's $NOTIFY_SOCKET is a datagram socket — so the
 * READY=1 message never reaches systemd. Under Type=notify the unit
 * times out and enters a restart loop, killing any held vault unlock
 * state. Until sd_notify is rewritten to use UNIX datagrams, Type=simple
 * is the working configuration: systemd considers the unit started as
 * soon as the ExecStart process is alive. The broker binds both sockets
 * synchronously early in start(), so dependents racing the daemon is a
 * non-issue in practice.
 *
 * No EnvironmentFile: the vault passphrase never touches disk — it is pushed
 * to the unlock socket interactively after the daemon starts.
 */
export function generateBrokerUnit(opts: BrokerUnitOpts): string {
  const { homeDir, bunBinDir, autoUnlock } = opts;
  const switchroomCli = resolve(bunBinDir, "switchroom");
  const nodeBinDir = dirname(process.execPath);
  const unitPath = `${bunBinDir}:${nodeBinDir}:/usr/local/bin:/usr/bin:/bin`;

  const credentialLine = autoUnlock
    ? `LoadCredentialEncrypted=vault-passphrase:${autoUnlock.credentialPath}\n`
    : "";

  return `[Unit]
Description=switchroom vault broker daemon
Documentation=https://github.com/switchroom/switchroom
After=network-online.target

[Service]
Type=simple
ExecStart=${switchroomCli} vault broker start --foreground
Restart=on-failure
RestartSec=2
${credentialLine}# Type=simple — see generateBrokerUnit() for the sd_notify-stream-vs-datagram
# rationale. The hand-rolled sd_notify in the broker is non-functional;
# Type=notify caused a restart loop that destroyed unlock state.
# No EnvironmentFile — the vault passphrase never touches disk.
# Push the passphrase via: switchroom vault broker unlock
Environment=PATH=${unitPath}
Environment=HOME=${homeDir}

[Install]
WantedBy=default.target
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
