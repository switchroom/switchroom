// Behavioural e2e tests for the vault broker against real systemd.
// To run: INTEGRATION=1 bun run test:vitest -- tests/integration/vault-broker-e2e
// Skipped without INTEGRATION=1 or on non-Linux or without user systemd.
//
// Uses `systemd-run --user --unit=switchroom-<agent>-cron-<i> --wait` to place
// the cron script in the correct cgroup (switchroom-<agent>-cron-<i>.service)
// without writing permanent unit files to ~/.config/systemd/user. This
// exercises the cgroup-based ACL end-to-end against a real systemd instance.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";

// ─── Gate conditions ──────────────────────────────────────────────────────────

const INTEGRATION = process.env.INTEGRATION === "1";
const IS_LINUX = process.platform === "linux";

function systemdAvailable(): boolean {
  try {
    execFileSync("systemctl", ["--user", "--version"], { stdio: "ignore", timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

function systemdRunAvailable(): boolean {
  try {
    execFileSync("systemd-run", ["--version"], { stdio: "ignore", timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

const SKIP = !INTEGRATION || !IS_LINUX || !systemdAvailable() || !systemdRunAvailable();
const SKIP_REASON = !INTEGRATION
  ? "set INTEGRATION=1 to run"
  : !IS_LINUX
  ? "Linux only"
  : !systemdAvailable()
  ? "no user-level systemd detected"
  : !systemdRunAvailable()
  ? "systemd-run not available"
  : "";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BROKER_ENTRY = join(import.meta.dirname, "../../src/vault/broker/server.ts");

/**
 * Build a minimal switchroom.yaml for the test agent, with the given schedule
 * secrets for cron-0.
 */
function makeConfig(
  tmpDir: string,
  agentName: string,
  agentsDir: string,
  cronSecrets: string[],
): string {
  const configObj = {
    switchroom: { version: 1, agents_dir: agentsDir },
    telegram: { bot_token: "123:TEST", forum_chat_id: "-1001" },
    vault: {
      path: join(tmpDir, "vault.enc"),
      broker: {
        socket: join(tmpDir, "vault-broker.sock"),
        enabled: true,
      },
    },
    agents: {
      [agentName]: {
        topic_name: "Test",
        schedule: [
          { cron: "0 8 * * *", prompt: "test", secrets: cronSecrets },
        ],
      },
    },
  };
  const configPath = join(tmpDir, "switchroom.yaml");
  // JSON is valid YAML
  writeFileSync(configPath, JSON.stringify(configObj, null, 2));
  return configPath;
}

/**
 * Build a minimal vault file containing { test_key_a: "VALUE_A" } at
 * vaultPath using a known passphrase.
 */
function makeVault(vaultPath: string, passphrase: string): void {
  const script = `
    import { createVault, setStringSecret } from ${JSON.stringify(
      join(import.meta.dirname, "../../src/vault/vault.ts"),
    )};
    createVault(${JSON.stringify(passphrase)}, ${JSON.stringify(vaultPath)});
    setStringSecret(${JSON.stringify(passphrase)}, ${JSON.stringify(vaultPath)}, "test_key_a", "VALUE_A");
  `;
  const scriptPath = join(vaultPath + ".setup.mts");
  writeFileSync(scriptPath, script);
  execFileSync("bun", ["run", scriptPath], { stdio: "pipe" });
}

/**
 * Write the cron script that systemd-run will execute via /bin/bash.
 * The script uses bun to run a TypeScript client against the broker.
 */
function makeCronScript(
  agentsDir: string,
  agentName: string,
  socketPath: string,
): string {
  const cronDir = join(agentsDir, agentName, "telegram");
  mkdirSync(cronDir, { recursive: true });
  const cronPath = join(cronDir, "cron-0.sh");

  const clientTs = join(import.meta.dirname, "../../src/vault/broker/client.ts");
  const protocolTs = join(import.meta.dirname, "../../src/vault/broker/protocol.ts");

  const script = `#!/bin/bash
BUN=$(command -v bun)
if [ -z "$BUN" ]; then
  echo "bun not found" >&2
  exit 1
fi

exec "$BUN" --eval '
import { getViaBroker } from ${JSON.stringify(clientTs)};
import { encodeRequest, decodeResponse } from ${JSON.stringify(protocolTs)};
import * as net from "node:net";

const SOCKET = ${JSON.stringify(socketPath)};

// Try the high-level client first
const result = await getViaBroker("test_key_a", { socket: SOCKET, timeoutMs: 3000 });
if (result !== null) {
  process.stdout.write(String((result as any).value) + "\\n");
  process.exit(0);
}

// High-level client returned null — do a raw request to distinguish DENIED from down.
// Use data + newline framing (NOT the end event) because the broker does not
// close the connection after responding; the response always ends with "\\n".
const resp = await new Promise<any>((resolve) => {
  const client = net.createConnection({ path: SOCKET });
  let buf = "";
  const timer = setTimeout(() => { client.destroy(); resolve(null); }, 3000);
  client.on("data", (c: Buffer) => {
    buf += c.toString("utf8");
    const nl = buf.indexOf("\\n");
    if (nl !== -1) {
      clearTimeout(timer);
      client.destroy();
      try { resolve(decodeResponse(buf.slice(0, nl))); } catch { resolve(null); }
    }
  });
  client.on("error", (e: Error) => {
    clearTimeout(timer);
    process.stderr.write("broker not running: " + e.message + "\\n");
    resolve(null);
  });
  client.on("connect", () => {
    client.write(encodeRequest({ v: 1, op: "get", key: "test_key_a" }));
    // Do NOT call end() — broker keeps the connection open after responding.
  });
});

if (resp && resp.ok === false) {
  if (resp.code === "DENIED") {
    process.stderr.write("ACL DENIED: " + resp.msg + "\\n");
    process.exit(2);
  }
  if (resp.code === "LOCKED") {
    process.stderr.write("broker LOCKED: " + resp.msg + "\\n");
    process.exit(3);
  }
  process.stderr.write("broker error " + resp.code + ": " + resp.msg + "\\n");
  process.exit(4);
}

process.stderr.write("broker not running or key missing\\n");
process.exit(1);
'
`;
  writeFileSync(cronPath, script, { mode: 0o755 });
  return cronPath;
}

/**
 * Start the broker subprocess pointing at the given socket and config.
 * Returns the child process once the socket file exists (or after 5s timeout).
 */
async function startBroker(
  configPath: string,
  socketPath: string,
  vaultPath: string,
): Promise<ChildProcess> {
  const child = spawn(
    "bun",
    [
      "--eval",
      `
import { VaultBroker } from ${JSON.stringify(BROKER_ENTRY)};
const broker = new VaultBroker();
await broker.start(
  ${JSON.stringify(socketPath)},
  ${JSON.stringify(configPath)},
  ${JSON.stringify(vaultPath)},
);
process.on("SIGTERM", () => { broker.stop(); process.exit(0); });
process.on("SIGINT",  () => { broker.stop(); process.exit(0); });
      `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  // Drain the broker's stdout/stderr pipes so they don't fill the OS buffer
  // and stall the subprocess. The data is dropped — broker logging is
  // useful for manual debugging only.
  child.stderr?.on("data", () => {});
  child.stdout?.on("data", () => {});

  const deadline = Date.now() + 5000;
  while (!existsSync(socketPath)) {
    if (Date.now() > deadline) {
      child.kill("SIGTERM");
      throw new Error(`Broker socket never appeared at ${socketPath}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 200));
  return child;
}

/**
 * Unlock the broker by sending the passphrase to the unlock socket.
 */
async function unlockBroker(socketPath: string, passphrase: string): Promise<void> {
  const unlockSocketPath = socketPath.replace(/\.sock$/, ".unlock.sock");

  await new Promise<void>((resolve, reject) => {
    const client = net.createConnection({ path: unlockSocketPath });
    let buf = "";
    client.on("data", (c) => { buf += c.toString(); });
    client.on("end", () => {
      if (buf.trim() === "OK") resolve();
      else reject(new Error(`Broker unlock failed: ${buf.trim()}`));
    });
    client.on("error", (e) => reject(e));
    client.on("connect", () => {
      client.write(passphrase + "\n");
      client.end();
    });
  });
}

/**
 * Run the cron script via `systemd-run --user --unit=<unitBase> --wait`,
 * placing it in the switchroom-<agent>-cron-<i>.service cgroup.
 *
 * systemd-run creates a transient unit (no permanent unit file needed) and
 * --wait blocks until the unit completes, returning its exit status.
 *
 * Returns { success, stdout, stderr } captured from the unit's journal.
 */
async function runCronViaSystemdRun(
  agentName: string,
  cronPath: string,
  agentDir: string,
  timeoutMs = 15000,
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  // The unit base name must match what peercred will find in /proc/<pid>/cgroup.
  // systemd-run will create: switchroom-<agent>-cron-0.service
  const unitBase = `switchroom-${agentName}-cron-0`;

  // Capture stdout/stderr via the journal. systemd-run --wait exits with the
  // unit's exit code (non-zero on failure).
  let stdout = "";
  let stderr = "";
  let success = false;

  // Pass PATH so bun is findable inside the transient unit
  const bunDir = join(process.env.HOME ?? "/root", ".bun", "bin");
  const augmentedPath = [bunDir, process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"].join(":");

  try {
    const result = execFileSync(
      "systemd-run",
      [
        "--user",
        `--unit=${unitBase}`,
        "--wait",
        "--collect",
        `--setenv=PATH=${augmentedPath}`,
        "--property=WorkingDirectory=" + agentDir,
        "/bin/bash",
        cronPath,
      ],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    // execFileSync with encoding returns string; stdout is captured
    stdout = typeof result === "string" ? result : "";
    success = true;
  } catch (e: any) {
    // Non-zero exit or timeout — unit failed
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
    success = false;
  }

  // Also pull from journalctl for stderr output (script writes to stderr which
  // goes to the journal, not to systemd-run's captured stdout).
  try {
    const journalOut = execFileSync(
      "journalctl",
      [
        "--user",
        "--unit", `${unitBase}.service`,
        "--since", "30 seconds ago",
        "--no-pager",
        "-o", "cat",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 },
    );
    const journalStr = typeof journalOut === "string" ? journalOut : "";
    stdout += journalStr;
    stderr += journalStr;
  } catch {
    // journal unavailable — not fatal
  }

  return { success, stdout, stderr };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("vault-broker e2e (systemd)", () => {
  let tmpDir: string;
  let broker: ChildProcess | null;
  let socketPath: string;
  let configPath: string;
  let vaultPath: string;
  let agentsDir: string;
  // Each test gets a unique agent name so the systemd unit name
  // (`switchroom-<agent>-cron-0.service`) and the journalctl scope are
  // disjoint. Otherwise output from a prior test bleeds into the next
  // test's captured journal and breaks `not.toContain(VALUE)` assertions.
  let AGENT: string;
  const PASSPHRASE = "e2e-test-passphrase-not-real";
  let agentCounter = 0;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sw-vault-broker-e2e-"));
    agentsDir = join(tmpDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    socketPath = join(tmpDir, "vault-broker.sock");
    vaultPath = join(tmpDir, "vault.enc");
    broker = null;
    AGENT = `e2eagent${++agentCounter}-${process.pid}`;
  });

  afterEach(async () => {
    if (broker) {
      broker.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        broker!.on("close", () => resolve());
        setTimeout(resolve, 1000);
      });
      broker = null;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it.skipIf(SKIP)(
    `prerequisite check passes (${SKIP_REASON || "all conditions met"})`,
    () => {
      expect(INTEGRATION).toBe(true);
      expect(IS_LINUX).toBe(true);
    },
  );

  it.skipIf(SKIP)(
    "allowed key (happy path) — cgroup identity grants access via systemd-run",
    async () => {
      configPath = makeConfig(tmpDir, AGENT, agentsDir, ["test_key_a"]);
      makeVault(vaultPath, PASSPHRASE);

      const agentDir = join(agentsDir, AGENT);
      mkdirSync(agentDir, { recursive: true });
      const cronPath = makeCronScript(agentsDir, AGENT, socketPath);

      // Start and unlock the broker
      broker = await startBroker(configPath, socketPath, vaultPath);
      await unlockBroker(socketPath, PASSPHRASE);

      // Run via systemd-run — places process in switchroom-e2eagent-cron-0.service cgroup
      const { success, stdout, stderr } = await runCronViaSystemdRun(AGENT, cronPath, agentDir);

      expect(success).toBe(true);
      // The value should appear in the captured output
      const combined = stdout + stderr;
      expect(combined).toContain("VALUE_A");
    },
    25000,
  );

  it.skipIf(SKIP)(
    "disallowed key — secrets:[] causes ACL DENIED, no value leaks",
    async () => {
      // cron's secrets list is empty — test_key_a is NOT declared
      configPath = makeConfig(tmpDir, AGENT, agentsDir, []);
      makeVault(vaultPath, PASSPHRASE);

      const agentDir = join(agentsDir, AGENT);
      mkdirSync(agentDir, { recursive: true });
      const cronPath = makeCronScript(agentsDir, AGENT, socketPath);

      broker = await startBroker(configPath, socketPath, vaultPath);
      await unlockBroker(socketPath, PASSPHRASE);

      const { success, stdout, stderr } = await runCronViaSystemdRun(AGENT, cronPath, agentDir);

      // The cron script exits 2 on DENIED — systemd-run returns non-zero
      expect(success).toBe(false);
      // Value must never appear in output
      const combined = stdout + stderr;
      expect(combined).not.toContain("VALUE_A");
      // Output should mention denial
      expect(combined.toLowerCase()).toMatch(/denied|acl/);
    },
    25000,
  );

  it.skipIf(SKIP)(
    "broker stopped — cron exits non-zero, does not silently fall through",
    async () => {
      // Do NOT start the broker
      configPath = makeConfig(tmpDir, AGENT, agentsDir, ["test_key_a"]);
      makeVault(vaultPath, PASSPHRASE);

      const agentDir = join(agentsDir, AGENT);
      mkdirSync(agentDir, { recursive: true });
      const cronPath = makeCronScript(agentsDir, AGENT, socketPath);

      // Socket does not exist
      expect(existsSync(socketPath)).toBe(false);

      const { success, stdout, stderr } = await runCronViaSystemdRun(AGENT, cronPath, agentDir);

      // Must exit non-zero — broker is not running
      expect(success).toBe(false);
      // Must not silently succeed with a value
      const combined = stdout + stderr;
      expect(combined).not.toContain("VALUE_A");
      // Output must mention the failure
      expect(combined.length).toBeGreaterThan(0);
    },
    25000,
  );
});
