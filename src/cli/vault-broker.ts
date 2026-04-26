/**
 * CLI: `switchroom vault broker <subcommand>`
 *
 * Subcommands:
 *   start [--foreground]  Start the broker daemon. With --foreground, runs
 *                         in-process (used by systemd Type=notify). Without,
 *                         spawns detached and exits.
 *   stop                  Send lock RPC, then SIGTERM to the PID in the
 *                         PID file (~/.switchroom/vault-broker.pid).
 *   status                Print JSON broker status. Exit 0=unlocked,
 *                         1=locked, 2=not running.
 *   unlock                Interactive passphrase prompt → push to unlock
 *                         socket. Prints "unlocked OK" or "unlock failed:".
 *   lock                  Send lock RPC. Prints "locked" or error.
 */

import type { Command } from "commander";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { loadConfig } from "../config/loader.js";
import { resolvePath } from "../config/loader.js";
import {
  statusViaBroker,
  lockViaBroker,
  unlockViaBroker,
  resolveBrokerSocketPath,
} from "../vault/broker/client.js";
import { VaultBroker, registerShutdownHandlers } from "../vault/broker/server.js";

const DEFAULT_PID_FILE = "~/.switchroom/vault-broker.pid";
const DEFAULT_SOCKET_PATH = "~/.switchroom/vault-broker.sock";

function getSocketPath(configPath?: string): string {
  try {
    const config = loadConfig(configPath);
    return resolvePath(config.vault?.broker?.socket ?? DEFAULT_SOCKET_PATH);
  } catch {
    return resolvePath(DEFAULT_SOCKET_PATH);
  }
}

function getConfigPath(configPath?: string): string | undefined {
  return configPath;
}

function getVaultPath(configPath?: string): string {
  try {
    const config = loadConfig(configPath);
    return resolvePath(config.vault?.path ?? "~/.switchroom/vault.enc");
  } catch {
    return resolvePath("~/.switchroom/vault.enc");
  }
}

async function promptPassphrase(): Promise<string> {
  const { createInterface } = await import("node:readline");
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("stdin is not a TTY — cannot prompt for passphrase"));
      return;
    }

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    process.stdout.write("Vault passphrase: ");
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();

    let input = "";
    const onData = (data: Buffer) => {
      const char = data.toString("utf8");
      if (char === "\n" || char === "\r") {
        stdin.setRawMode(false);
        stdin.removeListener("data", onData);
        rl.close();
        process.stdout.write("\n");
        resolve(input);
      } else if (char === "") {
        stdin.setRawMode(false);
        stdin.removeListener("data", onData);
        rl.close();
        process.stdout.write("\n");
        reject(new Error("Aborted"));
      } else if (char === "" || char === "\b") {
        if (input.length > 0) input = input.slice(0, -1);
      } else {
        input += char;
      }
    };
    stdin.on("data", onData);
  });
}

export function registerVaultBrokerCommand(vaultCmd: Command, program: Command): void {
  const broker = vaultCmd
    .command("broker")
    .description("Manage the vault-broker daemon");

  // ── start ─────────────────────────────────────────────────────────────────
  broker
    .command("start")
    .description(
      "Start the vault-broker daemon. --foreground runs in-process (used by systemd).",
    )
    .option("--foreground", "Run in-process (for systemd Type=notify)")
    .action(async (opts: { foreground?: boolean }) => {
      const parentOpts = program.opts();
      const socketPath = getSocketPath(parentOpts.config);
      const configPath = getConfigPath(parentOpts.config);
      const vaultPath = getVaultPath(parentOpts.config);

      if (opts.foreground) {
        // In-process mode: start the broker and keep the process alive.
        const brokerInstance = new VaultBroker();
        registerShutdownHandlers(brokerInstance);

        try {
          await brokerInstance.start(socketPath, configPath, vaultPath);
          console.log(`[vault-broker] Listening on ${socketPath}`);
          // Process stays alive — kept by the open server sockets.
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[vault-broker] Failed to start: ${msg}`);
          process.exit(1);
        }
      } else {
        // Detached mode: spawn a background process and exit.
        const self = process.argv[1];
        const args = ["vault", "broker", "start", "--foreground"];
        if (parentOpts.config) args.unshift("--config", parentOpts.config);

        const child = spawn(process.execPath, [self, ...args], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
        console.log(`vault-broker started (pid ${child.pid})`);
        process.exit(0);
      }
    });

  // ── stop ──────────────────────────────────────────────────────────────────
  broker
    .command("stop")
    .description("Stop the vault-broker daemon (lock + SIGTERM)")
    .action(async () => {
      const parentOpts = program.opts();
      const socket = resolveBrokerSocketPath({
        socket: getSocketPath(parentOpts.config),
      });

      // Send lock RPC first (best-effort)
      await lockViaBroker({ socket });

      // Read PID file and send SIGTERM
      const pidPath = resolvePath(DEFAULT_PID_FILE);
      if (!existsSync(pidPath)) {
        console.error("vault-broker PID file not found — is the daemon running?");
        process.exit(1);
      }
      const pid = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
      if (isNaN(pid) || pid <= 0) {
        console.error("Invalid PID file contents");
        process.exit(1);
      }
      try {
        process.kill(pid, "SIGTERM");
        console.log(`vault-broker (pid ${pid}) stopped`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to stop broker: ${msg}`);
        process.exit(1);
      }
    });

  // ── status ────────────────────────────────────────────────────────────────
  broker
    .command("status")
    .description(
      "Print broker status as JSON. Exit 0=unlocked, 1=locked, 2=not running.",
    )
    .action(async () => {
      const parentOpts = program.opts();
      const socket = getSocketPath(parentOpts.config);

      const status = await statusViaBroker({ socket });
      if (status === null) {
        console.log(JSON.stringify({ running: false }));
        process.exit(2);
      }
      console.log(JSON.stringify({ running: true, ...status }));
      process.exit(status.unlocked ? 0 : 1);
    });

  // ── unlock ────────────────────────────────────────────────────────────────
  broker
    .command("unlock")
    .description("Prompt for passphrase and push to the broker unlock socket")
    .action(async () => {
      const parentOpts = program.opts();
      const socket = getSocketPath(parentOpts.config);

      let passphrase: string;
      try {
        passphrase = await promptPassphrase();
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      const result = await unlockViaBroker(passphrase, { socket });
      // Zero the passphrase variable (best-effort)
      passphrase = "";

      if (result.ok) {
        console.log("unlocked OK");
      } else {
        console.error(`unlock failed: ${result.msg ?? "unknown error"}`);
        process.exit(1);
      }
    });

  // ── lock ──────────────────────────────────────────────────────────────────
  broker
    .command("lock")
    .description("Send lock command to the broker")
    .action(async () => {
      const parentOpts = program.opts();
      const socket = getSocketPath(parentOpts.config);

      const ok = await lockViaBroker({ socket });
      if (ok) {
        console.log("locked");
      } else {
        console.error("lock failed — is the broker running?");
        process.exit(1);
      }
    });
}
