/**
 * CLI: `switchroom buzz provision|status <agent>` — per-agent Nostr identity
 * provisioning for the Buzz co-channel (PR-2 of the Buzz live-enablement plan).
 *
 * Job spec: reference/jobs/use-my-team-from-the-desktop.md (Production-readiness
 * §Security — "the agent's Nostr key is broker-fetched in-process at sidecar
 * boot, never written to env or logs").
 *
 * All the leak-sensitive logic (keypair gen, print path, status computation)
 * lives in `src/buzz-provision.ts`, which imports no vault/broker/commander
 * code. This file is the thin host wiring: it builds the real vault-backed
 * store and broker-backed grant, reads the compose file + sidecar log for
 * status, and delegates. The nsec never transits this file — it is generated
 * inside the core and written straight to the vault by the injected store.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { loadConfig, resolvePath } from "../config/loader.js";
import {
  getSecret,
  setStringSecret,
  listSecrets,
  VaultError,
} from "../vault/vault.js";
import {
  resolveBrokerSocketPath,
  mintGrantViaBroker,
  listGrantsViaBroker,
  listViaBroker,
  statusViaBroker,
  type BrokerClientOpts,
} from "../vault/broker/client.js";
import { DEFAULT_COMPOSE_PATH } from "./apply.js";
import {
  runBuzzProvision,
  computeBuzzStatus,
  formatBuzzStatus,
  isBuzzFullyLive,
  buzzNsecKey,
  type BuzzProvisionStore,
} from "../buzz-provision.js";

/** The buzz sidecar's log path INSIDE the agent container. */
const BUZZ_SIDECAR_LOG = "/var/log/switchroom/buzz-gateway.log";

function isSandboxContext(): boolean {
  return process.env.SWITCHROOM_RUNTIME === "docker";
}

function getVaultPath(configPath?: string): string {
  try {
    const config = loadConfig(configPath);
    return resolvePath(config.vault?.path ?? "~/.switchroom/vault.enc");
  } catch {
    return resolvePath("~/.switchroom/vault.enc");
  }
}

function getBrokerOpts(configPath?: string): BrokerClientOpts {
  try {
    const config = loadConfig(configPath);
    return {
      socket: resolveBrokerSocketPath({
        vaultBrokerSocket: config.vault?.broker?.socket
          ? resolvePath(config.vault.broker.socket)
          : undefined,
      }),
    };
  } catch {
    return { socket: resolveBrokerSocketPath() };
  }
}

/** Prompt for a passphrase on stderr (stdout is reserved for payload). */
function promptPassphrase(): Promise<string> {
  const env = process.env.SWITCHROOM_VAULT_PASSPHRASE;
  if (env) return Promise.resolve(env);
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    if (process.stdin.isTTY) {
      process.stderr.write("Vault passphrase: ");
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
          process.stderr.write("\n");
          resolve(input);
        } else if (char === "\u0003") {
          stdin.setRawMode(false);
          stdin.removeListener("data", onData);
          rl.close();
          process.stderr.write("\n");
          reject(new Error("Aborted"));
        } else if (char === "\u007f" || char === "\b") {
          if (input.length > 0) input = input.slice(0, -1);
        } else {
          input += char;
        }
      };
      stdin.on("data", onData);
    } else {
      rl.question("Vault passphrase: ", (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

/** Duration → seconds (30d / 12h / 60m / 3600s / never). */
function parseDuration(raw: string): number | null {
  const lower = raw.toLowerCase().trim();
  if (lower === "0" || lower === "never" || lower === "none") return null;
  const m = lower.match(/^(\d+(?:\.\d+)?)(d|h|m|s)$/);
  if (!m) {
    throw new Error(
      `Unrecognised duration '${raw}'. Use <N>d, <N>h, <N>m, <N>s, or 'never'.`,
    );
  }
  const n = parseFloat(m[1]);
  switch (m[2]) {
    case "d": return Math.round(n * 86400);
    case "h": return Math.round(n * 3600);
    case "m": return Math.round(n * 60);
    default: return Math.round(n);
  }
}

export function registerBuzzCommand(program: Command): void {
  const buzz = program
    .command("buzz")
    .description("Per-agent Buzz co-channel identity provisioning");

  // ── provision ────────────────────────────────────────────────────────────
  buzz
    .command("provision <agent>")
    .description(
      "Generate a Nostr keypair for the agent, store the nsec in the vault, " +
        "grant the agent read on it, and print the operator enrollment steps.",
    )
    .option("--rotate", "Overwrite an existing nsec (invalidates the old npub)")
    .option("--no-grant", "Do not grant the agent read on the new key")
    .option(
      "--duration <duration>",
      "Grant lifetime: 30d, 12h, 60m, never (default: never)",
      "never",
    )
    .action(
      async (
        agent: string,
        opts: { rotate?: boolean; grant?: boolean; duration?: string },
      ) => {
        if (isSandboxContext()) {
          console.error(
            chalk.red(
              "Error: `switchroom buzz provision` writes the vault directly and " +
                "must run on the host, not inside an agent sandbox.",
            ),
          );
          process.exit(1);
        }

        const parentOpts = program.opts();
        const vaultPath = getVaultPath(parentOpts.config);
        const brokerOpts = getBrokerOpts(parentOpts.config);

        let ttlSeconds: number | null;
        try {
          ttlSeconds = parseDuration(opts.duration ?? "never");
        } catch (err) {
          console.error(chalk.red(`Error: ${(err as Error).message}`));
          process.exit(1);
        }

        // Resolve the passphrase once, lazily — needed for both the existence
        // check and the write.
        let cachedPass: string | undefined;
        const pass = async (): Promise<string> => {
          if (cachedPass === undefined) cachedPass = await promptPassphrase();
          return cachedPass;
        };

        const store: BuzzProvisionStore = {
          async hasNsec(key) {
            return getSecret(await pass(), vaultPath, key) !== null;
          },
          async writeNsec(key, nsec) {
            setStringSecret(await pass(), vaultPath, key, nsec);
          },
          async grantRead(agentName, key) {
            const r = await mintGrantViaBroker({
              ...brokerOpts,
              agent: agentName,
              keys: [key],
              ttl_seconds: ttlSeconds,
              description: `buzz nsec read (${key})`,
            });
            return r.kind === "ok" ? { ok: true } : { ok: false, error: r.msg };
          },
        };

        try {
          const { exitCode } = await runBuzzProvision(agent, store, {
            rotate: opts.rotate,
            noGrant: opts.grant === false,
          });
          if (exitCode !== 0) process.exit(exitCode);
        } catch (err) {
          if (err instanceof VaultError || err instanceof Error) {
            console.error(chalk.red(`Error: ${err.message}`));
            process.exit(1);
          }
          throw err;
        }
      },
    );

  // ── status ───────────────────────────────────────────────────────────────
  buzz
    .command("status <agent>")
    .description(
      "Report the four Buzz preconditions red/green: vault key, grant, " +
        "compose env projection, and live sidecar auth.",
    )
    .action(async (agent: string) => {
      const parentOpts = program.opts();
      const brokerOpts = getBrokerOpts(parentOpts.config);
      const nsecKey = buzzNsecKey(agent);

      // 1. Vault keys — prefer the broker (auto-unlocked on a dev host, no
      //    passphrase prompt); fall back to a direct read only if a passphrase
      //    is already in the environment (keep status non-interactive).
      let vaultKeys: string[] | null = null;
      try {
        const status = await statusViaBroker(brokerOpts);
        if (status?.unlocked) {
          vaultKeys = await listViaBroker(brokerOpts);
        }
      } catch {
        vaultKeys = null;
      }
      if (vaultKeys === null && process.env.SWITCHROOM_VAULT_PASSPHRASE) {
        try {
          vaultKeys = listSecrets(
            process.env.SWITCHROOM_VAULT_PASSPHRASE,
            getVaultPath(parentOpts.config),
          );
        } catch {
          vaultKeys = null;
        }
      }

      // 2. Grants for this agent.
      let grants: { agent_slug: string; key_allow: string[] }[] | null = null;
      try {
        const r = await listGrantsViaBroker(agent, brokerOpts);
        if (r.kind === "ok") {
          grants = r.grants.map((g) => ({
            agent_slug: g.agent_slug,
            key_allow: g.key_allow,
          }));
        }
      } catch {
        grants = null;
      }

      // 3. Generated compose file.
      let composeYaml: string | null = null;
      try {
        if (existsSync(DEFAULT_COMPOSE_PATH)) {
          composeYaml = readFileSync(DEFAULT_COMPOSE_PATH, "utf8");
        }
      } catch {
        composeYaml = null;
      }

      // 4. Sidecar log tail (best-effort docker exec into the agent container).
      let logTail: string | null = null;
      try {
        logTail = execFileSync(
          "docker",
          [
            "exec",
            `switchroom-${agent}`,
            "tail",
            "-n",
            "200",
            BUZZ_SIDECAR_LOG,
          ],
          { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] },
        );
      } catch {
        logTail = null;
      }

      const report = computeBuzzStatus(agent, {
        nsecKey,
        vaultKeys,
        grants,
        composeYaml,
        logTail,
      });

      for (const line of formatBuzzStatus(agent, report)) {
        // Colorize the status marker without changing its text width.
        const colored = line
          .replace("[green]", chalk.green("[green]"))
          .replace("[ red ]", chalk.red("[ red ]"))
          .replace("[  ?  ]", chalk.yellow("[  ?  ]"));
        console.log(colored);
      }

      if (!isBuzzFullyLive(report)) {
        // Non-zero exit so scripts/CI can gate on a fully-live channel.
        process.exitCode = 2;
      }
    });
}
