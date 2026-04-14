import type { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { loadConfig } from "../config/loader.js";
import { resolvePath } from "../config/loader.js";
import {
  createVault,
  setSecret,
  getSecret,
  listSecrets,
  removeSecret,
  VaultError,
} from "../vault/vault.js";

function getVaultPath(configPath?: string): string {
  try {
    const config = loadConfig(configPath);
    return resolvePath(config.vault?.path ?? "~/.clerk/vault.enc");
  } catch {
    return resolvePath("~/.clerk/vault.enc");
  }
}

function promptLine(prompt: string, hidden = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    if (hidden && process.stdin.isTTY) {
      // Disable echo for hidden input
      process.stdout.write(prompt);
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
        } else if (char === "\u0003") {
          // Ctrl+C
          stdin.setRawMode(false);
          stdin.removeListener("data", onData);
          rl.close();
          process.stdout.write("\n");
          reject(new Error("Aborted"));
        } else if (char === "\u007F" || char === "\b") {
          // Backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
          }
        } else {
          input += char;
        }
      };
      stdin.on("data", onData);
    } else {
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

/**
 * Read all bytes from stdin until EOF. Used for piped input so that
 * multi-line values (JSON, PEM, SSH keys, etc.) are preserved verbatim
 * instead of being truncated to a single line by readline.
 */
function readStdinToEnd(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", reject);
  });
}

async function getPassphrase(confirm = false): Promise<string> {
  // Check env var first
  const envPassphrase = process.env.CLERK_VAULT_PASSPHRASE;
  if (envPassphrase) {
    return envPassphrase;
  }

  const passphrase = await promptLine("Vault passphrase: ", true);
  if (!passphrase) {
    throw new Error("Passphrase cannot be empty");
  }

  if (confirm) {
    const confirmation = await promptLine("Confirm passphrase: ", true);
    if (passphrase !== confirmation) {
      throw new Error("Passphrases do not match");
    }
  }

  return passphrase;
}

export function registerVaultCommand(program: Command): void {
  const vault = program
    .command("vault")
    .description("Manage encrypted secrets vault");

  vault
    .command("init")
    .description("Create a new encrypted vault file")
    .action(async () => {
      try {
        const parentOpts = program.opts();
        const vaultPath = getVaultPath(parentOpts.config);
        const passphrase = await getPassphrase(true);

        createVault(passphrase, vaultPath);
        console.log(chalk.green(`✓ Vault created at ${vaultPath}`));
      } catch (err) {
        if (err instanceof VaultError || err instanceof Error) {
          console.error(chalk.red(`Error: ${err.message}`));
          process.exit(1);
        }
        throw err;
      }
    });

  vault
    .command("set <key>")
    .description("Set a secret in the vault")
    .option(
      "-f, --file <path>",
      "Read the secret value from a file (preserves multi-line content)"
    )
    .action(async (key: string, opts: { file?: string }) => {
      try {
        const parentOpts = program.opts();
        const vaultPath = getVaultPath(parentOpts.config);
        // When stdin is piped we need to consume it for the secret value,
        // so the passphrase must come from the env var rather than a prompt.
        if (!process.stdin.isTTY && !process.env.CLERK_VAULT_PASSPHRASE && !opts.file) {
          console.error(
            chalk.red(
              "Error: piping a value to `vault set` requires CLERK_VAULT_PASSPHRASE to be set"
            )
          );
          process.exit(1);
        }
        const passphrase = await getPassphrase();

        let value: string;
        if (opts.file) {
          // --file flag: read value from a file verbatim.
          try {
            value = readFileSync(resolvePath(opts.file), "utf8");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(chalk.red(`Error reading file: ${msg}`));
            process.exit(1);
          }
        } else if (!process.stdin.isTTY) {
          // Piped/non-TTY stdin: slurp all bytes so multi-line values
          // (JSON, PEM, SSH keys) are preserved instead of being
          // truncated to the first line by readline.
          value = await readStdinToEnd();
        } else {
          // Interactive TTY: keep the existing password-masked prompt.
          value = await promptLine("Secret value: ", true);
        }

        if (!value) {
          console.error(chalk.red("Error: Value cannot be empty"));
          process.exit(1);
        }

        setSecret(passphrase, vaultPath, key, value);
        console.log(chalk.green(`✓ Secret '${key}' saved`));
      } catch (err) {
        if (err instanceof VaultError || err instanceof Error) {
          console.error(chalk.red(`Error: ${err.message}`));
          process.exit(1);
        }
        throw err;
      }
    });

  vault
    .command("get <key>")
    .description("Get a secret from the vault")
    .action(async (key: string) => {
      try {
        const parentOpts = program.opts();
        const vaultPath = getVaultPath(parentOpts.config);
        const passphrase = await getPassphrase();

        const value = getSecret(passphrase, vaultPath, key);
        if (value === null) {
          console.error(chalk.yellow(`Secret '${key}' not found`));
          process.exit(1);
        }

        console.log(value);
      } catch (err) {
        if (err instanceof VaultError || err instanceof Error) {
          console.error(chalk.red(`Error: ${err.message}`));
          process.exit(1);
        }
        throw err;
      }
    });

  vault
    .command("list")
    .description("List all secret key names in the vault")
    .action(async () => {
      try {
        const parentOpts = program.opts();
        const vaultPath = getVaultPath(parentOpts.config);
        const passphrase = await getPassphrase();

        const keys = listSecrets(passphrase, vaultPath);
        if (keys.length === 0) {
          console.log(chalk.dim("No secrets in vault"));
        } else {
          for (const key of keys) {
            console.log(key);
          }
        }
      } catch (err) {
        if (err instanceof VaultError || err instanceof Error) {
          console.error(chalk.red(`Error: ${err.message}`));
          process.exit(1);
        }
        throw err;
      }
    });

  vault
    .command("remove <key>")
    .description("Remove a secret from the vault")
    .action(async (key: string) => {
      try {
        const parentOpts = program.opts();
        const vaultPath = getVaultPath(parentOpts.config);
        const passphrase = await getPassphrase();

        removeSecret(passphrase, vaultPath, key);
        console.log(chalk.green(`✓ Secret '${key}' removed`));
      } catch (err) {
        if (err instanceof VaultError || err instanceof Error) {
          console.error(chalk.red(`Error: ${err.message}`));
          process.exit(1);
        }
        throw err;
      }
    });
}
