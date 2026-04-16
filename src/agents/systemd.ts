import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, unlinkSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import type { SwitchroomConfig, ScheduleEntry } from "../config/schema.js";
import { resolveAgentsDir } from "../config/loader.js";
import { usesSwitchroomTelegramPlugin } from "../config/merge.js";

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

export function generateUnit(name: string, agentDir: string, useAutoaccept = false): string {
  const logFile = resolve(agentDir, "service.log");
  const autoacceptExp = resolve(import.meta.dirname, "../../bin/autoaccept.exp");

  // When using dev channels (forked plugin), use expect to handle the
  // interactive confirmation prompts. TIOCSTI-based keystroke injection
  // is disabled on Ubuntu 24.04+ kernels, so expect is the reliable
  // approach. It's standard on every Linux distro (apt install expect).
  //
  // We wrap the expect invocation in `script` so systemd still gets a
  // single log file with the full output.
  const execStart = useAutoaccept
    ? `/usr/bin/script -qfc "/usr/bin/expect -f ${autoacceptExp} ${agentDir}/start.sh" ${logFile}`
    : `/usr/bin/script -qfc "/bin/bash -l ${agentDir}/start.sh" ${logFile}`;

  return `[Unit]
Description=switchroom agent: ${name}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
StandardOutput=journal
StandardError=journal
Restart=on-failure
RestartSec=15
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

export function installAllUnits(config: SwitchroomConfig): void {
  const agentsDir = resolveAgentsDir(config);

  for (const agentName of Object.keys(config.agents)) {
    const agentDir = resolve(agentsDir, agentName);
    const useAutoaccept = usesSwitchroomTelegramPlugin(config.agents[agentName]);
    const content = generateUnit(agentName, agentDir, useAutoaccept);
    installUnit(agentName, content);
  }

  daemonReload();
}

export function daemonReload(): void {
  try {
    execSync("systemctl --user daemon-reload", { stdio: "pipe" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to reload systemd user daemon: ${message}`);
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
  const desc = prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
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
  if (existsSync(SYSTEMD_USER_DIR)) {
    for (const file of readdirSync(SYSTEMD_USER_DIR)) {
      if (!file.startsWith(prefix)) continue;
      const match = file.match(new RegExp(`^${prefix}(\\d+)\\.(timer|service)$`));
      if (match && parseInt(match[1], 10) >= schedule.length) {
        const stale = resolve(SYSTEMD_USER_DIR, file);
        // Stop the timer before removing
        try {
          execSync(`systemctl --user stop ${file}`, { stdio: "pipe" });
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
      execSync(`systemctl --user enable --now ${timerName}`, { stdio: "pipe" });
    } catch { /* best effort */ }
  }
}
