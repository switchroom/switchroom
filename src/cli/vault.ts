import type { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { loadConfig } from "../config/loader.js";
import { resolvePath } from "../config/loader.js";
import {
  createVault,
  setStringSecret,
  getSecret,
  listSecrets,
  removeSecret,
  validateFormatHint,
  detectFormat,
  VAULT_FORMAT_HINTS,
  VaultError,
  type VaultFormatHint,
} from "../vault/vault.js";
import { registerVaultSweep } from "./vault-sweep.js";
import {
  getViaBrokerStructured,
  statusViaBroker,
  unlockViaBroker,
  resolveBrokerSocketPath,
} from "../vault/broker/client.js";
import { registerVaultBrokerCommand } from "./vault-broker.js";

function getVaultPath(configPath?: string): string {
  try {
    const config = loadConfig(configPath);
    return resolvePath(config.vault?.path ?? "~/.switchroom/vault.enc");
  } catch {
    return resolvePath("~/.switchroom/vault.enc");
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
  const envPassphrase = process.env.SWITCHROOM_VAULT_PASSPHRASE;
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

/**
 * Return a human-readable conversion suggestion when a stored format does not
 * match the expected format.  Returns an empty string when no known conversion
 * path exists.
 */
function conversionHint(stored: VaultFormatHint, expected: VaultFormatHint): string {
  if (stored === "base64-raw-seed" && expected === "pem") {
    return (
      "Convert with: openssl genpkey -algorithm ed25519 " +
      "(or wrap the raw seed with your key type's PEM encoder)."
    );
  }
  if (stored === "pem" && expected === "base64-raw-seed") {
    return "Extract the raw seed from the PEM with: openssl pkey -in key.pem -outform DER | tail -c 32 | base64";
  }
  return "";
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
    .option(
      "--format <kind>",
      `Annotate the stored value with a format hint (${VAULT_FORMAT_HINTS.join(", ")}). The hint is validated against the value at set time and checked against --expect at get time.`
    )
    .action(async (key: string, opts: { file?: string; format?: string }) => {
      try {
        const parentOpts = program.opts();
        const vaultPath = getVaultPath(parentOpts.config);

        // Validate --format value early so we fail before prompting for passphrase.
        let formatHint: VaultFormatHint | undefined;
        if (opts.format !== undefined) {
          if (!(VAULT_FORMAT_HINTS as readonly string[]).includes(opts.format)) {
            console.error(
              chalk.red(
                `Error: unknown format '${opts.format}'. Allowed values: ${VAULT_FORMAT_HINTS.join(", ")}`
              )
            );
            process.exit(1);
          }
          formatHint = opts.format as VaultFormatHint;
        }

        // When stdin is piped we need to consume it for the secret value,
        // so the passphrase must come from the env var rather than a prompt.
        if (!process.stdin.isTTY && !process.env.SWITCHROOM_VAULT_PASSPHRASE && !opts.file) {
          console.error(
            chalk.red(
              "Error: piping a value to `vault set` requires SWITCHROOM_VAULT_PASSPHRASE to be set"
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

        // Validate the value against the declared format hint.
        if (formatHint) {
          const validationError = validateFormatHint(value, formatHint);
          if (validationError) {
            console.error(
              chalk.red(`Error: format validation failed for --format ${formatHint}: ${validationError}`)
            );
            process.exit(1);
          }
        }

        setStringSecret(passphrase, vaultPath, key, value, formatHint);
        if (formatHint) {
          console.log(chalk.green(`✓ Secret '${key}' saved (format: ${formatHint})`));
        } else {
          console.log(chalk.green(`✓ Secret '${key}' saved`));
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
    .command("get <key>")
    .description("Get a secret from the vault (tries broker first)")
    .option("--no-broker", "Bypass the broker and read directly from the vault file. Required for interactive (non-cron) access — the broker only serves switchroom cron units.")
    .option(
      "--expect <format>",
      `Warn if the stored format hint does not match. Allowed values: ${VAULT_FORMAT_HINTS.join(", ")}. Exits with code 4 on mismatch (warn-and-proceed is the default; use --strict-format to fail-closed).`
    )
    .option(
      "--strict-format",
      "When combined with --expect, exit with code 4 instead of warning-and-proceeding on a format mismatch."
    )
    .action(async (key: string, opts: { broker?: boolean; expect?: string; strictFormat?: boolean }) => {
      const useBroker = opts.broker !== false;
      const parentOpts = program.opts();

      // Validate --expect value early.
      let expectFormat: VaultFormatHint | undefined;
      if (opts.expect !== undefined) {
        if (!(VAULT_FORMAT_HINTS as readonly string[]).includes(opts.expect)) {
          console.error(
            chalk.red(
              `Error: unknown format '${opts.expect}' for --expect. Allowed values: ${VAULT_FORMAT_HINTS.join(", ")}`
            )
          );
          process.exit(1);
        }
        expectFormat = opts.expect as VaultFormatHint;
      }

      /**
       * Check format hint on a retrieved entry and warn (or fail) on mismatch.
       * Returns false if the caller should exit (strict-format + mismatch).
       */
      function checkFormatExpectation(entry: { kind: string; value?: string; format?: VaultFormatHint }): boolean {
        if (!expectFormat) return true;
        if (entry.kind !== "string" && entry.kind !== "binary") return true;

        const storedFormat = (entry as { format?: VaultFormatHint }).format;

        // Primary check: stored format hint vs expected
        if (storedFormat && storedFormat !== expectFormat) {
          const hint = conversionHint(storedFormat, expectFormat);
          const msg =
            `VAULT-FORMAT-MISMATCH: secret '${key}' was stored as format '${storedFormat}' ` +
            `but caller expects '${expectFormat}'.` +
            (hint ? ` ${hint}` : "");
          process.stderr.write(msg + "\n");
          if (opts.strictFormat) {
            process.exit(4);
          }
          return true; // warn-and-proceed
        }

        // Secondary check: no stored hint — detect from value content
        if (!storedFormat && entry.value !== undefined) {
          const detected = detectFormat(entry.value);
          if (detected && detected !== expectFormat) {
            const hint = conversionHint(detected, expectFormat);
            const msg =
              `VAULT-FORMAT-MISMATCH: secret '${key}' has no stored format hint but value ` +
              `looks like '${detected}', not '${expectFormat}'.` +
              (hint ? ` ${hint}` : "");
            process.stderr.write(msg + "\n");
            if (opts.strictFormat) {
              process.exit(4);
            }
          }
        }

        return true;
      }

      // ── Broker routing ──────────────────────────────────────────────────
      if (useBroker) {
        let brokerSocket: string | undefined;
        try {
          const config = loadConfig(parentOpts.config);
          brokerSocket = resolvePath(config.vault?.broker?.socket ?? "~/.switchroom/vault-broker.sock");
        } catch {
          brokerSocket = resolvePath("~/.switchroom/vault-broker.sock");
        }

        const brokerOpts = { socket: brokerSocket };
        const status = await statusViaBroker(brokerOpts);

        if (status !== null) {
          // Broker is reachable
          if (!status.unlocked) {
            // Broker locked
            if (process.stdin.isTTY) {
              // Prompt locally and offer to push to broker
              try {
                const passphrase = await getPassphrase();
                const vaultPath = getVaultPath(parentOpts.config);
                const entry = getSecret(passphrase, vaultPath, key);
                if (entry === null) {
                  console.error(chalk.yellow(`Secret '${key}' not found`));
                  process.exit(1);
                }
                if (entry.kind === "string" || entry.kind === "binary") {
                  checkFormatExpectation(entry);
                  console.log(entry.value);
                } else {
                  console.error(chalk.yellow(`Secret '${key}' is kind="${entry.kind}"`));
                  process.exit(1);
                }
                // Offer to unlock broker
                const push = await promptLine("\nPush passphrase to broker for future requests? [Y/n]: ");
                if (!push.trim() || push.trim().toLowerCase() === "y") {
                  const result = await unlockViaBroker(passphrase, brokerOpts);
                  if (result.ok) {
                    console.log(chalk.green("broker unlocked"));
                  } else {
                    console.error(chalk.yellow(`Could not unlock broker: ${result.msg}`));
                  }
                }
                return;
              } catch (err) {
                if (err instanceof VaultError || err instanceof Error) {
                  console.error(chalk.red(`Error: ${err.message}`));
                  process.exit(1);
                }
                throw err;
              }
            } else {
              // Non-TTY + broker locked: write a clearly-prefixed error to
              // stderr so agents/scripts surfacing captured output can grep it.
              process.stderr.write(
                `VAULT-BROKER-DENIED: broker locked and stdin is not a TTY; ` +
                `use 'switchroom vault get --no-broker' for interactive access\n`
              );
              process.exit(3);
            }
          }

          // Broker is unlocked — request the key
          const result = await getViaBrokerStructured(key, brokerOpts);

          if (result.kind === "ok") {
            const entry = result.entry;
            if (entry.kind === "string" || entry.kind === "binary") {
              checkFormatExpectation(entry);
              console.log(entry.value);
              return;
            }
            console.error(chalk.yellow(`Secret '${key}' is kind="${entry.kind}"`));
            process.exit(1);
          }

          if (result.kind === "not_found") {
            // Broker is healthy and we're allowed; the key just doesn't
            // exist. Direct vault decrypt won't help — exit straight away.
            console.error(chalk.yellow(`Secret '${key}' not found in vault`));
            process.exit(1);
          }

          if (result.kind === "denied") {
            // ACL rejection or vault locked. For interactive callers, fall
            // through to direct vault decrypt with the user's passphrase
            // (--no-broker semantics). For non-interactive callers, fail
            // with a clearly-prefixed error so captured subprocess output
            // is still actionable (issue #173).
            if (process.stdin.isTTY) {
              console.error(
                chalk.yellow(
                  `broker denied request (${result.code}): ${result.msg}. ` +
                  `Falling back to direct vault access.`,
                ),
              );
              // fall through to direct-decrypt block below
            } else {
              // Write a VAULT-BROKER-DENIED prefix so scripts/agents that
              // capture stdout/stderr can grep for it even when the full
              // message isn't surfaced in their UI.
              process.stderr.write(
                `VAULT-BROKER-DENIED [${result.code}]: ${result.msg}\n` +
                `Hint: run 'switchroom vault get --no-broker ${key}' for interactive (non-cron) access.\n`
              );
              process.exit(2);
            }
          } else {
            // result.kind === "unreachable" — fall through to direct decrypt.
            // The status check above already returned non-null, so this is a
            // weird mid-request failure (broker died between status and get?).
            if (process.stdin.isTTY) {
              console.error(
                chalk.yellow(`broker became unreachable mid-request: ${result.msg}`),
              );
            } else {
              console.error(`broker unreachable: ${result.msg}`);
              process.exit(1);
            }
          }
        }

        // Broker not reachable
        if (!process.stdin.isTTY && !process.env.SWITCHROOM_VAULT_PASSPHRASE) {
          process.stderr.write(
            `VAULT-BROKER-DENIED: broker not running and stdin is not a TTY; ` +
            `use 'switchroom vault get --no-broker ${key}' for interactive access\n`
          );
          process.exit(1);
        }
        // Fall through to direct vault access with passphrase prompt (or env var)
      }

      // ── Direct vault access (--no-broker or broker unreachable + TTY) ──
      try {
        const vaultPath = getVaultPath(parentOpts.config);
        const passphrase = await getPassphrase();

        const entry = getSecret(passphrase, vaultPath, key);
        if (entry === null) {
          console.error(chalk.yellow(`Secret '${key}' not found`));
          process.exit(1);
        }

        if (entry.kind === "string" || entry.kind === "binary") {
          checkFormatExpectation(entry);
          console.log(entry.value);
        } else {
          console.error(
            chalk.yellow(
              `Secret '${key}' is kind="${entry.kind}" — use 'switchroom vault get-file <key> <filename>' to read a specific file.`
            )
          );
          process.exit(1);
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

  // `vault sweep` — retroactively scrub stored vault values from Telegram
  // SQLite history + Claude Code session transcripts. See vault-sweep.ts.
  registerVaultSweep(vault, program);

  // `vault broker` — manage the vault-broker daemon.
  registerVaultBrokerCommand(vault, program);
}
