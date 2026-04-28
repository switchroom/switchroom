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
import { readFileSync, existsSync, mkdirSync, chmodSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { loadConfig } from "../config/loader.js";
import { resolvePath } from "../config/loader.js";
import {
  statusViaBroker,
  lockViaBroker,
  unlockViaBroker,
  resolveBrokerSocketPath,
} from "../vault/broker/client.js";
import { VaultBroker, registerShutdownHandlers } from "../vault/broker/server.js";
import { openVault } from "../vault/vault.js";

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

function getAutoUnlockCredPath(configPath?: string): string {
  const fallback = "~/.config/credstore.encrypted/vault-passphrase";
  try {
    const config = loadConfig(configPath);
    return resolvePath(config.vault?.broker?.autoUnlockCredentialPath ?? fallback);
  } catch {
    return resolvePath(fallback);
  }
}

/**
 * Read the vault passphrase, masking input when stdin is a TTY.
 *
 * TTY path  — raw mode, no echo. Ctrl-C aborts with exit 130.
 * Pipe path — read the first line from stdin (for scripted use-cases such as
 *             `echo "passphrase" | switchroom vault broker unlock`).
 *
 * Rejects with a clear error when the passphrase is empty.
 */
export async function promptPassphrase(): Promise<string> {
  // ── Non-TTY: piped passphrase ────────────────────────────────────────────
  if (!process.stdin.isTTY) {
    const { createInterface } = await import("node:readline");
    return new Promise((resolve, reject) => {
      const rl = createInterface({ input: process.stdin, terminal: false });
      let settled = false;
      rl.once("line", (line) => {
        settled = true;
        rl.close();
        const passphrase = line.trimEnd();
        if (!passphrase) {
          reject(new Error("Empty passphrase — aborting"));
          return;
        }
        resolve(passphrase);
      });
      rl.once("close", () => {
        if (!settled) {
          // stdin closed without emitting any line (empty pipe)
          reject(new Error("Empty passphrase — aborting"));
        }
      });
    });
  }

  // ── TTY: masked interactive prompt ──────────────────────────────────────
  return new Promise((resolve, reject) => {
    process.stdout.write("Vault passphrase: ");
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();

    let input = "";
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.removeListener("data", onData);
    };

    const onData = (data: Buffer) => {
      const char = data.toString("utf8");
      if (char === "\n" || char === "\r") {
        // Enter — accept input
        cleanup();
        process.stdout.write("\n");
        if (!input) {
          reject(new Error("Empty passphrase — aborting"));
        } else {
          resolve(input);
        }
      } else if (char === "") {
        // Ctrl-C — abort with conventional exit code 130
        cleanup();
        process.stdout.write("\n");
        process.stderr.write("Aborted\n");
        process.exit(130);
      } else if (char === "" || char === "\b") {
        // Backspace / Delete
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

  // ── enable-auto-unlock ───────────────────────────────────────────────────
  // Encrypt the vault passphrase via systemd-creds and write it to the
  // configured credential path. After this, the broker unit (re-rendered
  // with vault.broker.autoUnlock=true) can declare LoadCredentialEncrypted=
  // and systemd will inject the passphrase at start time without further
  // user interaction. See issue #152 and README "Auto-unlock on boot".
  broker
    .command("enable-auto-unlock")
    .description(
      "Encrypt vault passphrase via systemd-creds and write to the credential path. " +
      "After this, set vault.broker.autoUnlock=true and reconcile to take effect.",
    )
    .action(async () => {
      const parentOpts = program.opts();

      if (process.platform !== "linux") {
        console.error("enable-auto-unlock requires Linux (systemd-creds is Linux-only).");
        process.exit(1);
      }

      // Verify systemd-creds is on PATH.
      try {
        execFileSync("systemd-creds", ["--version"], { stdio: "ignore" });
      } catch {
        console.error(
          "systemd-creds not found on PATH. Requires systemd >= 250. " +
          "Try: sudo apt install systemd",
        );
        process.exit(1);
      }

      const credPath = getAutoUnlockCredPath(parentOpts.config);
      const vaultPath = getVaultPath(parentOpts.config);

      // Prompt + verify BEFORE writing anything. We must not encrypt a typo.
      let passphrase: string;
      try {
        passphrase = await promptPassphrase();
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      // Wrap the verify + encrypt block in try/finally so the passphrase
      // variable is zeroed on every exit path — including openVault failure.
      try {
        try {
          openVault(passphrase, vaultPath);
        } catch (err) {
          console.error(`Passphrase verification failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }

        mkdirSync(dirname(credPath), { recursive: true, mode: 0o700 });

        // systemd-creds encrypt --name=vault-passphrase --user --quiet - <credPath>
        // Stdin: passphrase. Output: encrypted credential at credPath.
        // The --name=vault-passphrase binding is required — systemd validates the
        // embedded name matches the LoadCredentialEncrypted= id at decrypt time.
        try {
          execFileSync(
            "systemd-creds",
            ["encrypt", "--name=vault-passphrase", "--user", "--quiet", "-", credPath],
            { input: passphrase, stdio: ["pipe", "inherit", "inherit"] },
          );
        } catch (err) {
          console.error(`systemd-creds encrypt failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }
      } finally {
        passphrase = "";
      }

      try {
        chmodSync(credPath, 0o600);
      } catch {
        /* non-fatal — systemd-creds already restricts mode */
      }

      console.log(`Auto-unlock credential written to ${credPath}`);
      console.log("");
      console.log("Next steps:");
      console.log("  1. Set vault.broker.autoUnlock: true in switchroom.yaml");
      console.log("  2. switchroom reconcile        # re-renders the broker unit");
      console.log("  3. systemctl --user restart switchroom-vault-broker.service");
      console.log("");
      console.log("Verify with: switchroom vault broker status (after restart)");
    });

  // ── disable-auto-unlock ──────────────────────────────────────────────────
  broker
    .command("disable-auto-unlock")
    .description("Remove the auto-unlock credential file. Reconcile + restart broker after.")
    .action(() => {
      const parentOpts = program.opts();
      const credPath = getAutoUnlockCredPath(parentOpts.config);

      if (!existsSync(credPath)) {
        console.log(`No credential file at ${credPath} — nothing to do.`);
        return;
      }
      try {
        unlinkSync(credPath);
        console.log(`Removed ${credPath}`);
        console.log("");
        console.log("Next steps:");
        console.log("  1. Set vault.broker.autoUnlock: false in switchroom.yaml (or remove)");
        console.log("  2. switchroom reconcile");
        console.log("  3. systemctl --user restart switchroom-vault-broker.service");
      } catch (err) {
        console.error(`Failed to remove credential file: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
