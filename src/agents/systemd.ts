import { execFileSync, execSync } from "node:child_process";
import { writeFileSync, mkdirSync, unlinkSync, existsSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import type { SwitchroomConfig, ScheduleEntry } from "../config/schema.js";
import { resolveAgentsDir, resolvePath } from "../config/loader.js";
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
  // Closes #472 finding #20 — system reboot races the agent service
  // against the vault-broker unit. Without explicit ordering the agent
  // boots before the broker is ready, vault env vars are empty, bot
  // tokens absent, and the MCP server fails to connect. The cron-timer
  // unit at this same file already pulls in this dep; mirror it for the
  // main agent unit. Wants= is a soft dep so the agent can still boot
  // if the broker is intentionally not running on this host. Appended
  // last so the existing After= prefix substring assertions in tests
  // (and any operator scripts that grep the unit) keep matching.
  afterDeps.push("switchroom-vault-broker.service");
  const wantsDeps = ["network-online.target", "switchroom-vault-broker.service"];

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
Wants=${wantsDeps.join(" ")}
StartLimitBurst=5
StartLimitIntervalSec=120

[Service]
Type=simple
ExecStart=${execStart}
StandardOutput=journal
StandardError=journal
Restart=on-failure
RestartSec=5
# Cgroup-wide kill so restart actually kills claude (issue #361).
# ExecStart wraps claude in \`script -qfc\` for PTY allocation (autoaccept
# needs a TTY). The PTY layer detaches claude from the unit cgroup, so a
# plain SIGTERM to the ExecStart PID only kills \`script\`; claude survives
# and the Apr 17 incident showed the same PID running 12 days after the
# service "restarted". KillMode=control-group sends SIGTERM to every
# process in the cgroup (including detached descendants), waits
# TimeoutStopSec, then SIGKILL if anything is still alive.
KillMode=control-group
KillSignal=SIGTERM
SendSIGKILL=yes
TimeoutStopSec=15
# Memory ceiling: MemoryHigh triggers kernel reclaim at 6G so the
# process is throttled before hitting the hard ceiling. MemoryMax=8G is
# the hard limit — once hit, the kernel OOM-kills the unit. Combined
# with Restart=on-failure (already set above), this gives automatic
# recovery from memory-growth hangs observed in production (issue #116):
# three klanker hangs in 10h where RSS climbed past 1 GB before the
# process froze — systemd still reported active (running) with no way to
# detect or auto-recover. 8G gives ample headroom for memory-intensive
# workloads while providing a reliable ceiling; 6G soft-throttle kicks
# in before the hard kill so the kernel reclaims pages gradually first.
MemoryHigh=6G
MemoryMax=8G
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
# Spread restart attempts across a 5s window so a fleet-wide crash
# doesn't produce a synchronized thundering herd of claude processes
# coming back at the same instant. The [Unit] section's start-limit
# above caps the absolute rate; this adds jitter inside that envelope.
RandomizedDelaySec=5
# Cgroup-wide kill so restart actually kills the gateway process (issue #361).
# Same script PTY cgroup-escape issue as the agent unit — see generateUnit().
KillMode=control-group
KillSignal=SIGTERM
SendSIGKILL=yes
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
# Same jitter rationale as the gateway unit: smear restart timing within
# the StartLimitBurst envelope so a host-wide crash doesn't produce a
# synchronized restart wave.
RandomizedDelaySec=5
# Cgroup-wide kill so restart actually kills the foreman process (issue #361).
# Same script PTY cgroup-escape issue as the agent unit — see generateUnit().
KillMode=control-group
KillSignal=SIGTERM
SendSIGKILL=yes
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
 * Returns true when the broker unit should be installed: BOTH
 * `vault.broker.enabled === true` AND at least one agent in the fleet
 * has a non-empty `schedule[i].secrets` array.
 *
 * #207 (Phase 1C): the previous gate was an OR — `enabled` alone (without
 * any cron consumer) installed an inert broker unit. Now we require an
 * actual cron consumer, so the broker only runs when something needs it.
 *
 * The conjunction also guarantees the un-install path: when the last
 * `secrets[]` declaration is removed from config, reconcile sees the gate
 * flip to false and removes the unit. Per the `restart = reconcile +
 * restart` contract (PR #59), no separate un-install handler is needed.
 *
 * Operator note: if you previously relied on `enabled=true` alone (e.g.
 * to spin up a broker for interactive vault access without a cron),
 * you now also need at least one schedule entry with a non-empty
 * `secrets:`. The simplest workaround is to declare a benign cron entry
 * that references the keys you want available.
 */
export function shouldInstallBrokerUnit(config: SwitchroomConfig): boolean {
  if (config.vault?.broker?.enabled !== true) return false;
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
  // Cache the gate result — it iterates all agents + schedules, and we
  // consult it twice (un-install branch + install branch).
  const wantBroker = shouldInstallBrokerUnit(config);

  if (!wantBroker) {
    // #207: un-install the broker unit if it exists on disk but the gate
    // flipped to false (e.g. the last schedule[i].secrets entry was just
    // removed from config). Per the `restart = reconcile + restart`
    // contract (PR #59), reconcile is responsible for converging to the
    // declared state in BOTH directions.
    const brokerUnitPath = resolve(SYSTEMD_USER_DIR, "switchroom-vault-broker.service");
    if (existsSync(brokerUnitPath)) {
      // Stop before disable+remove so the running daemon doesn't outlive
      // the unit file (which would leave systemd in a confused state).
      try {
        execFileSync("systemctl", ["--user", "stop", "switchroom-vault-broker.service"], { stdio: "pipe" });
      } catch { /* may not be running */ }
      try {
        execFileSync("systemctl", ["--user", "disable", "switchroom-vault-broker.service"], { stdio: "pipe" });
      } catch { /* may not be enabled */ }
      // Race guard: existsSync → unlinkSync is not atomic. If something
      // else removes the file between the two calls (rare but possible
      // during concurrent reconcile), unlinkSync would throw and skip
      // daemonReload, leaving systemd's loaded units inconsistent with
      // disk. Swallow the ENOENT and continue.
      try {
        unlinkSync(brokerUnitPath);
      } catch { /* file already gone — daemon-reload will still fix systemd's view */ }
      daemonReload();
    }
  }
  if (wantBroker) {
    const homeDir = process.env.HOME ?? "/root";
    const bunBinDir = resolve(homeDir, ".bun", "bin");
    // Auto-unlock is now done by the broker process itself reading
    // ~/.config/switchroom/auto-unlock.bin (machine-bound, AES-GCM). The
    // unit template no longer needs LoadCredentialEncrypted= for the default
    // path — that's reserved for power users running the broker as a system
    // unit (option A in issue #540), opted into explicitly via a future flag.
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

  // Install the bridge-watchdog .service + .timer alongside the agent
  // units (issue #406). Generating these from the CLI guarantees the
  // service file pins Environment=PATH so the script can locate the
  // `switchroom` CLI under ~/.bun/bin and route restarts through the
  // reconcile-bearing CLI verb instead of the raw-systemctl fallback.
  installWatchdogUnits();

  daemonReload();
  enableUnits(installedAgents);
  // Enable the watchdog .timer separately — enableUnits appends ".service"
  // to every name, which would mangle a .timer. Only enable the timer when
  // at least one agent unit was installed (nothing to watchdog otherwise).
  if (Object.keys(config.agents).length > 0) {
    enableWatchdogTimer();
  }
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
 * Enable and start the bridge-watchdog timer.
 *
 * Separated from `enableUnits` because that helper unconditionally appends
 * ".service" to every name — passing `switchroom-watchdog` through it would
 * try to enable a non-existent `switchroom-watchdog.service` (sans .timer)
 * and skip the timer entirely.
 *
 * Idempotent: `systemctl enable --now` on an already-enabled-and-running
 * timer is a no-op, so this is safe to call on every reconcile pass.
 * Best-effort error handling matches `enableUnits` — install succeeded;
 * a failed enable is recoverable by the operator.
 */
function enableWatchdogTimer(): void {
  try {
    execFileSync(
      "systemctl",
      ["--user", "enable", "--now", `${WATCHDOG_TIMER_NAME}.timer`],
      { stdio: "pipe" },
    );
  } catch {
    // non-fatal — timer is installed but won't fire until manually enabled
  }
}

/**
 * Stop, disable, and remove the bridge-watchdog .service + .timer units.
 *
 * Counterpart to `installWatchdogUnits` — called from
 * `switchroom systemd uninstall` so removing the agent fleet doesn't leave
 * an orphan watchdog timer firing every 60s against agents that no longer
 * exist. Idempotent: each step swallows "already gone / not running"
 * errors so it's safe to call when the units were never installed.
 */
export function uninstallWatchdogUnits(): void {
  // Stop the timer first so it can't re-fire the .service mid-uninstall.
  try {
    execFileSync(
      "systemctl",
      ["--user", "stop", `${WATCHDOG_TIMER_NAME}.timer`],
      { stdio: "pipe" },
    );
  } catch { /* may not be running */ }
  try {
    execFileSync(
      "systemctl",
      ["--user", "disable", `${WATCHDOG_TIMER_NAME}.timer`],
      { stdio: "pipe" },
    );
  } catch { /* may not be enabled */ }

  for (const path of [watchdogTimerFilePath(), watchdogServiceFilePath()]) {
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch { /* file already gone — daemon-reload will sync systemd's view */ }
    }
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
   * to the [Service] block. Reserved for the system-unit deployment mode
   * (issue #540) where the broker runs as root and systemd materializes the
   * credential via its own keystore. The default user-unit deployment uses
   * the broker's machine-bound auto-unlock (see src/vault/auto-unlock.ts)
   * and does NOT pass this option — the broker reads + decrypts the blob
   * itself with no systemd-creds plumbing.
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
  const bunBin = resolve(bunBinDir, "bun");
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
ExecStart=${bunBin} ${switchroomCli} vault broker start --foreground
Restart=on-failure
RestartSec=2
# Cgroup-wide kill for consistency with agent/gateway units (issue #361).
# The broker doesn't use the script PTY wrapper but may spawn subprocesses;
# control-group kill ensures a clean slate on every restart.
KillMode=control-group
KillSignal=SIGTERM
SendSIGKILL=yes
TimeoutStopSec=15
${credentialLine}# Type=simple — see generateBrokerUnit() for the sd_notify-stream-vs-datagram
# rationale. The hand-rolled sd_notify in the broker is non-functional;
# Type=notify caused a restart loop that destroyed unlock state.
# No EnvironmentFile — the vault passphrase never touches disk.
# Push the passphrase via: switchroom vault broker unlock
# ExecStart invokes bun explicitly so the unit works on bun-only installs
# where /usr/bin/env node is not resolvable (issue #285).
Environment=PATH=${unitPath}
Environment=HOME=${homeDir}

[Install]
WantedBy=default.target
`;
}

// ─── Bridge watchdog units ─────────────────────────────────────────────────
//
// The bridge watchdog (`bin/bridge-watchdog.sh`) runs on a periodic systemd
// user timer. It restarts agents whose Telegram bridge has disconnected or
// whose journal output has been silent for too long (issue #116).
//
// Issue #406: previously this unit was hand-installed by operators, which
// meant it shipped without `Environment=PATH=...`. user-systemd's default
// PATH (`/usr/local/bin:/usr/bin:/bin`) doesn't include `~/.bun/bin`, so
// `command -v switchroom` failed inside the unit and the script's "rare"
// fallback to raw `systemctl --user restart` ran on every fire — silently
// skipping the reconcile pass that the project contract requires for every
// lifecycle transition. Generating the unit from the CLI lets us pin
// `Environment=PATH=<bunBinDir>:<nodeBinDir>:/usr/local/bin:/usr/bin:/bin`
// exactly the way the agent/gateway/foreman/broker units already do.

const WATCHDOG_SERVICE_NAME = "switchroom-watchdog";
const WATCHDOG_TIMER_NAME = "switchroom-watchdog";
// Default cadence: every 60s with a small randomized delay. Matches what
// hand-installed deployments use today; cheap enough that more frequent
// firing isn't worth the wakeups.
const WATCHDOG_TIMER_INTERVAL_SEC = 60;
const WATCHDOG_TIMER_RANDOM_DELAY_SEC = 5;

function watchdogServiceFilePath(): string {
  return resolve(SYSTEMD_USER_DIR, `${WATCHDOG_SERVICE_NAME}.service`);
}

function watchdogTimerFilePath(): string {
  return resolve(SYSTEMD_USER_DIR, `${WATCHDOG_TIMER_NAME}.timer`);
}

/**
 * Generate the bridge-watchdog .service unit.
 *
 * Type=oneshot: the watchdog is a single sweep that exits when done. The
 * .timer unit re-fires it on a cadence.
 *
 * Environment=PATH is pinned (issue #406) so the script can locate the
 * `switchroom` CLI installed by `bun install -g`. Without it, the script's
 * `command -v switchroom` check fails and the fallback systemctl-restart
 * path bypasses reconcile.
 */
export function generateWatchdogServiceUnit(): string {
  const homeDir = process.env.HOME ?? "/root";
  const bunBin = resolve(homeDir, ".bun/bin/bun");
  const bunBinDir = dirname(bunBin);
  const nodeBinDir = dirname(process.execPath);
  const localBinDir = resolve(homeDir, ".local/bin");
  const scriptPath = resolve(import.meta.dirname, "../../bin/bridge-watchdog.sh");
  // PATH order mirrors generateGatewayUnit/generateForemanUnit: package
  // manager bin first, then node-bundled bin, then local user bin, then
  // standard system bins.
  const unitPath = `${bunBinDir}:${nodeBinDir}:${localBinDir}:/usr/local/bin:/usr/bin:/bin`;

  return `[Unit]
Description=switchroom bridge watchdog
Documentation=https://github.com/switchroom/switchroom

[Service]
Type=oneshot
ExecStart=/bin/bash ${scriptPath}
StandardOutput=journal
StandardError=journal
# PATH is pinned here so the watchdog script can locate the \`switchroom\`
# CLI (installed under ~/.bun/bin by \`bun install -g\`). Without this,
# \`command -v switchroom\` fails inside the user-systemd environment and
# the script's fallback systemctl-restart path bypasses reconcile — the
# project contract is that all agent lifecycle transitions go through
# the CLI so config reconciliation always runs (issue #406).
Environment=PATH=${unitPath}
`;
}

/**
 * Generate the bridge-watchdog .timer unit. Re-fires the .service every
 * WATCHDOG_TIMER_INTERVAL_SEC seconds.
 *
 * OnUnitActiveSec re-arms relative to the last completion (not the last
 * start) — the right semantics for a sweep that may take longer than the
 * cadence under load. RandomizedDelaySec spreads load across the cadence
 * so timers don't all fire at the same wall clock instant on a host that
 * runs multiple switchroom timers.
 */
export function generateWatchdogTimerUnit(): string {
  return `[Unit]
Description=switchroom bridge watchdog timer
Documentation=https://github.com/switchroom/switchroom

[Timer]
OnBootSec=${WATCHDOG_TIMER_INTERVAL_SEC}
OnUnitActiveSec=${WATCHDOG_TIMER_INTERVAL_SEC}
RandomizedDelaySec=${WATCHDOG_TIMER_RANDOM_DELAY_SEC}
AccuracySec=1s
Unit=${WATCHDOG_SERVICE_NAME}.service

[Install]
WantedBy=timers.target
`;
}

/**
 * Write the bridge-watchdog .service and .timer to the systemd user dir.
 * Idempotent: safe to call from `installAllUnits` on every reconcile.
 *
 * Does NOT call `daemonReload` or `enableUnits` — those are batched in
 * `installAllUnits` so a single reconcile incurs one daemon-reload.
 */
export function installWatchdogUnits(): void {
  mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
  writeFileSync(watchdogServiceFilePath(), generateWatchdogServiceUnit(), { mode: 0o644 });
  writeFileSync(watchdogTimerFilePath(), generateWatchdogTimerUnit(), { mode: 0o644 });
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
