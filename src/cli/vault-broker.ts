/**
 * CLI: `switchroom vault broker <subcommand>`
 *
 * Subcommands:
 *   start [--foreground]  Start the broker daemon. With --foreground, runs
 *                         in-process (used by docker entrypoints / supervised
 *                         contexts). Without, spawns detached and exits.
 *   stop                  Send lock RPC, then SIGTERM to the PID in the
 *                         PID file (~/.switchroom/vault-broker.pid).
 *   status                Print JSON broker status. Exit 0=unlocked,
 *                         1=locked, 2=not running.
 *   unlock                Interactive passphrase prompt → push to unlock
 *                         socket. Prints "unlocked OK" or "unlock failed:".
 *   lock                  Send lock RPC. Prints "locked" or error.
 */

import type { Command } from "commander";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { loadConfig } from "../config/loader.js";
import { resolvePath } from "../config/loader.js";
import {
  statusViaBroker,
  lockViaBroker,
  unlockViaBroker,
  brokerIsComposeManaged,
  resolveBrokerSocketPath,
} from "../vault/broker/client.js";
import { VaultBroker, registerShutdownHandlers } from "../vault/broker/server.js";
import { openVault } from "../vault/vault.js";
import {
  applyAutoUnlock,
  autoUnlockSupported,
  encryptCredential,
  EncryptFailedError,
} from "./vault-auto-unlock.js";

const DEFAULT_PID_FILE = "~/.switchroom/vault-broker.pid";
/**
 * Legacy v0.6 socket. Preserved as the explicit-config fallback so a
 * user who points `vault.broker.socket` at this path keeps working.
 * The runtime-aware default (operator socket under Docker, legacy
 * elsewhere) lives in `client.ts:resolveBrokerSocketPath`.
 */
const LEGACY_SOCKET_PATH = "~/.switchroom/vault-broker.sock";

function getSocketPath(configPath?: string): string {
  // Canonical resolution order (#1062 / RFC Bug 4):
  //   1. SWITCHROOM_VAULT_BROKER_SOCK env var — always wins.
  //   2. `vault.broker.socket` from yaml — BUT only when the operator
  //      actually set it. The Zod schema defaults this to
  //      `~/.switchroom/vault-broker.sock`, so a bare
  //      `if (config.vault?.broker?.socket !== undefined)` check was
  //      always true even on hosts with no explicit override, masking
  //      the env var and routing connections to the legacy socket that
  //      has no listener in docker mode. We detect "operator set this
  //      explicitly" by comparing against the schema's default string.
  //   3. Runtime-aware default — operator socket under Docker, legacy
  //      under v0.6 systemd. Delegated to `resolveBrokerSocketPath`.
  //
  // The pre-fix shape pointed `switchroom vault broker status` (and the
  // restart preflight) at the legacy host path even when a docker-mode
  // operator had `SWITCHROOM_VAULT_BROKER_SOCK` exported — false
  // "broker unreachable" reports were the symptom. See
  // reference/rfcs/sub-agent-visibility.md §Bug 4 for the full trace.
  const env = process.env.SWITCHROOM_VAULT_BROKER_SOCK;
  if (env) return resolvePath(env);

  try {
    const config = loadConfig(configPath);
    const raw = config.vault?.broker?.socket;
    if (typeof raw === "string" && raw !== SCHEMA_DEFAULT_SOCKET) {
      return resolvePath(raw);
    }
  } catch {
    // Config load failure — defer to the resolver below.
  }
  // Defer to the broker client's resolver so Docker mode picks the
  // operator socket (`~/.switchroom/broker-operator/sock`) and v0.6
  // installs keep getting the legacy socket. See client.ts.
  return resolveBrokerSocketPath();
}

/**
 * Must mirror the default declared in `src/config/schema.ts` for the
 * `vault.broker.socket` field. The Zod schema applies this default
 * whenever the operator's yaml omits the field, so we use it to
 * distinguish "operator set this explicitly" from "schema filled
 * this in for us." If the schema default changes, change this too.
 */
const SCHEMA_DEFAULT_SOCKET = "~/.switchroom/vault-broker.sock";

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
      "Start the vault-broker daemon. --foreground runs in-process (for supervised contexts).",
    )
    .option("--foreground", "Run in-process (for docker entrypoints / supervised contexts)")
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
      } else if (brokerIsComposeManaged()) {
        // A dockerized broker is already serving here (operator socket
        // present). Spawning a detached HOST daemon would create a
        // phantom second broker that `status` then reports on while
        // the real containerized one is ignored — exactly the #32
        // confusion that masked install-validation 2026-05-17. The
        // container's lifecycle is docker compose's job.
        console.log(
          "vault-broker is managed by docker compose (operator socket present).",
        );
        console.log(
          "  It starts with the project: `switchroom apply` / " +
            "`docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d`.",
        );
        console.log("  To unlock it: `switchroom vault broker unlock`.");
        process.exit(0);
      } else {
        // Detached mode (v0.6 host/systemd): spawn a background
        // process and exit.
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

      // Send lock RPC first (best-effort) — routes to the operator
      // socket under docker, so this locks the real containerized
      // broker (the security-relevant effect of "stop").
      await lockViaBroker({ socket });

      if (brokerIsComposeManaged()) {
        // No host PID to kill — the container's lifecycle is docker
        // compose's. The broker is now locked; stopping the container
        // is a separate compose operation (RFC J Phase 3 / #32).
        console.log("vault-broker locked. It is managed by docker compose;");
        console.log(
          "  to stop the container: `docker compose -p switchroom " +
            "-f ~/.switchroom/compose/docker-compose.yml stop vault-broker`.",
        );
        process.exit(0);
      }

      // v0.6 host/systemd: read PID file and send SIGTERM
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

      // Closes #472 finding #23 — without this guard, an operator
      // accidentally wiring `vault broker unlock` into a non-TTY
      // context (cron, ssh -T, a docker entrypoint, an automated
      // pipeline) silently consumes the first stdin line as the
      // passphrase. That value can be visible upstream in process
      // listings, log captures, or pipe buffers — and there is no
      // rate-limiting to slow a probing script. Refuse non-TTY
      // unlocks unless the operator explicitly opts in via env var
      // (the intentional-pipe case).
      if (!process.stdin.isTTY && process.env.SWITCHROOM_VAULT_UNLOCK_FROM_STDIN !== "1") {
        console.error(
          "vault broker unlock: stdin is not a TTY. Refusing to read a passphrase from a pipe.\n" +
            "  - Run interactively from a terminal, or\n" +
            "  - Set SWITCHROOM_VAULT_UNLOCK_FROM_STDIN=1 to opt in to piped input, or\n" +
            "  - Use 'switchroom vault broker setup-autounlock' for one-time systemd-creds storage.",
        );
        process.exit(1);
      }

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
  // Encrypt the vault passphrase machine-bound (key derived from
  // /etc/machine-id, HKDF-SHA256 — NOT systemd-creds; that wording was
  // vestigial v0.6 text, see RFC J §2.1) and write it to the configured
  // credential path, then flip vault.broker.autoUnlock=true, reconcile,
  // and restart the broker. The dockerized broker decrypts it from the
  // host-mounted /etc/machine-id at every boot — no user interaction,
  // and a stolen vault+blob off-host is useless without that host's
  // machine-id. See issue #152 / RFC J.
  //
  // The encryption cascade is handled in ./vault-auto-unlock.ts so the
  // same flow runs inside `switchroom setup`. The passphrase is sourced
  // from $SWITCHROOM_VAULT_PASSPHRASE when set (the unattended signal
  // used by setup + the gateway), else prompted/piped — so an
  // unattended `setup --non-interactive` can establish auto-unlock
  // (RFC J Phase 1; previously it could not — install-validation
  // 2026-05-17).
  broker
    .command("enable-auto-unlock")
    .description(
      "Set up vault auto-unlock at boot: encrypt the passphrase machine-bound, " +
      "enable vault.broker.autoUnlock, and restart the broker.",
    )
    .option(
      "--no-apply",
      "Stage the credential file only; don't flip vault.broker.autoUnlock or restart the broker.",
    )
    .action(async (opts: { apply?: boolean }) => {
      // commander negates --no-apply by setting opts.apply=false; default true.
      const apply = opts.apply !== false;
      const parentOpts = program.opts();

      if (!autoUnlockSupported()) {
        console.error(
          "Auto-unlock requires a readable /etc/machine-id (or " +
          "/var/lib/dbus/machine-id). On a fresh install, run " +
          "`sudo systemd-machine-id-setup` once and try again.",
        );
        process.exit(1);
      }

      const credPath = getAutoUnlockCredPath(parentOpts.config);
      const vaultPath = getVaultPath(parentOpts.config);

      // Prompt + verify BEFORE writing anything. We must not encrypt a typo.
      // $SWITCHROOM_VAULT_PASSPHRASE is the established unattended signal
      // (setup --non-interactive, the gateway, materialize-bot-token all
      // honor it); consume it here so an unattended install can establish
      // auto-unlock without a TTY. Falls back to the interactive/piped
      // prompt otherwise. (RFC J Phase 1.)
      let passphrase: string;
      const envPass = process.env.SWITCHROOM_VAULT_PASSPHRASE;
      if (envPass && envPass.length > 0) {
        passphrase = envPass;
      } else {
        try {
          passphrase = await promptPassphrase();
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
          return; // unreachable; satisfies TS narrowing
        }
      }

      try {
        try {
          openVault(passphrase, vaultPath);
        } catch (err) {
          console.error(
            `Passphrase verification failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exit(1);
        }

        try {
          encryptCredential(passphrase, credPath);
        } catch (err) {
          if (err instanceof EncryptFailedError) {
            console.error(err.message);
            process.exit(1);
          }
          throw err;
        }
      } finally {
        passphrase = "";
      }

      console.log(`✓ Auto-unlock blob written to ${credPath} (machine-bound)`);

      if (!apply) {
        console.log("");
        console.log("Staged only (--no-apply). To activate:");
        console.log("  1. Set vault.broker.autoUnlock: true in switchroom.yaml");
        console.log("  2. docker compose -f ~/.switchroom/compose/docker-compose.yml restart vault-broker");
        return;
      }

      try {
        await applyAutoUnlock({ configPath: parentOpts.config });
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      console.log("");
      console.log("Done. Vault will unlock automatically on every boot.");
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
        console.log("  2. switchroom apply");
        console.log("  3. docker compose -f ~/.switchroom/compose/docker-compose.yml restart vault-broker");
      } catch (err) {
        console.error(`Failed to remove credential file: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
