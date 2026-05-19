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
  type VaultEntryScope,
} from "../vault/vault.js";
import { registerVaultSweep } from "./vault-sweep.js";
import {
  getViaBrokerStructured,
  putViaBroker,
  statusViaBroker,
  unlockViaBroker,
  resolveBrokerSocketPath,
  readVaultTokenFile,
} from "../vault/broker/client.js";
import { registerVaultBrokerCommand } from "./vault-broker.js";
import { registerVaultDoctorCommand } from "./vault-doctor.js";
import { registerVaultAuditCommand } from "./vault-audit.js";
import { registerVaultGrantCommands } from "./vault-grant.js";
import { registerVaultBackupCommand } from "./vault-backup.js";

/**
 * Sandbox-context detection.
 *
 * Set by `src/agents/compose.ts` on every agent container's env. Inside
 * the sandbox there is NO `vault.enc` mount — only the broker socket —
 * so any code path that calls `openVault` / `saveVault` / `createVault`
 * directly will surface the misleading "Vault file not found" error
 * reported in issue #968.
 *
 * Sandbox-aware callers should fail closed with a structured prefix
 * (consumed by the Telegram gateway) rather than fall through to direct
 * file IO that cannot work.
 */
function isSandboxContext(): boolean {
  return process.env.SWITCHROOM_RUNTIME === "docker";
}

/**
 * Stable error markers consumed by the Telegram gateway and any other
 * subprocess caller. The gateway greps stderr for these prefixes to
 * route the failure into the right UX (approval card, host-CLI hint,
 * passphrase prompt) instead of dumping a raw stack trace at the user.
 *
 * Exit codes:
 *   2  — VAULT-BROKER-DENIED      (ACL rejection from broker)
 *   5  — VAULT-NEEDS-APPROVAL     (new key, no grant — must be approved)
 *   6  — VAULT-BROKER-UNREACHABLE (broker socket missing/dead)
 *   7  — VAULT-SANDBOX-CONTEXT    (operation impossible from sandbox)
 *
 * Codes 2/6/7 mean "fix the environment, then retry"; code 5 is the
 * only one that means "ask the user to approve."
 */
const VAULT_EXIT_DENIED = 2;
const VAULT_EXIT_NEEDS_APPROVAL = 5;
const VAULT_EXIT_BROKER_UNREACHABLE = 6;
const VAULT_EXIT_SANDBOX_CONTEXT = 7;

function refuseSandboxDirectAccess(verbHint: string): never {
  process.stderr.write(
    `VAULT-SANDBOX-CONTEXT: direct vault access is unavailable inside an ` +
    `agent sandbox. The vault file is not mounted into agent containers; ` +
    `only the broker socket is. Run '${verbHint}' on the host shell, or ` +
    `use a broker-supported operation.\n`
  );
  process.exit(VAULT_EXIT_SANDBOX_CONTEXT);
}

/**
 * Sandbox-aware recovery hint for the three broker failure modes
 * (denied / locked / unreachable). The same `--no-broker` hint that
 * works for an operator on the host is actively misleading inside an
 * agent: the vault file isn't mounted, so `--no-broker` would just
 * fall into `refuseSandboxDirectAccess`. Worse, the agent reads this
 * hint as instruction and gives up ("I'm sandboxed") instead of
 * calling the `vault_request_access` MCP tool that actually exists
 * to recover.
 *
 * In sandbox context, point at the tool that can recover the
 * situation. On the host, keep the historical `--no-broker` hint.
 */
function recoveryHint(
  situation: "denied" | "locked" | "unreachable",
  key?: string,
): string {
  if (!isSandboxContext()) {
    const keyArg = key ? ` ${key}` : "";
    return `Hint: run 'switchroom vault get --no-broker${keyArg}' for interactive (non-cron) access.`;
  }
  // Inside an agent. The vault.enc file isn't mounted; `--no-broker`
  // can't work. Tell the agent what *can* work.
  switch (situation) {
    case "denied":
      return (
        `Hint: this agent has no grant for ${key ? `'${key}'` : "this key"}. ` +
        `Call the \`vault_request_access\` MCP tool ` +
        `(key=${key ? `'${key}'` : "'<key>'"}, scope='read') ` +
        `to ask the operator for access via a Telegram approval card. ` +
        `Do NOT retry with --no-broker — the vault file is not mounted ` +
        `into agent containers.`
      );
    case "locked":
      return (
        `Hint: the broker is locked. Ask the operator to unlock it ` +
        `(\`/vault unlock\` in this chat, or ` +
        `\`switchroom vault broker unlock\` on the host). ` +
        `Do NOT retry with --no-broker — the vault file is not mounted ` +
        `into agent containers.`
      );
    case "unreachable":
      return (
        `Hint: the broker is unreachable. Ask the operator to check it ` +
        `(\`switchroom vault broker status\` on the host; if wedged, ` +
        `\`docker compose -p switchroom restart vault-broker\`). ` +
        `Do NOT retry with --no-broker — the vault file is not mounted ` +
        `into agent containers.`
      );
  }
}

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
    // Issue #999: interactive prompts go to stderr, not stdout. Stdout
    // is reserved for the actual secret payload (which the caller is
    // capturing via `$(switchroom vault get ...)`); piping the prompt
    // there silently consumed it, producing "Passphrase cannot be empty"
    // with no visible prompt and a missing value in the captured var.
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    if (hidden && process.stdin.isTTY) {
      // Disable echo for hidden input
      process.stderr.write(prompt);
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
          // Ctrl+C
          stdin.setRawMode(false);
          stdin.removeListener("data", onData);
          rl.close();
          process.stderr.write("\n");
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

/**
 * Issue #969 P3: emit a one-shot deprecation warning when
 * `SWITCHROOM_VAULT_PASSPHRASE` is set inside an agent sandbox. The env
 * var is still honoured for backwards compatibility AND for the
 * canonical gateway-passphrase-attestation flow (P1a) — both legitimate.
 * The warning targets the anti-pattern where a SKILL script bakes the
 * master passphrase into the agent's environment.
 *
 * Heuristic for distinguishing the two: the gateway invokes the CLI
 * with the env var set on a per-spawn basis AND the wider sandbox
 * shell does not have it exported. The legitimate gateway flow never
 * enters this codepath under normal sandbox boot because the env is
 * only on the spawned subprocess, not the agent's interactive shell
 * environment. A skill script that runs `switchroom vault get` after
 * `export SWITCHROOM_VAULT_PASSPHRASE=...` WILL hit it — which is
 * exactly what we want.
 *
 * Emitting the warning is therefore safe to put at vault CLI entry:
 * even if it fires on a legitimate gateway-spawned subprocess, it's
 * one-shot, goes to stderr (not stdout), and gateway error handling
 * already separates these streams.
 */
let _passphraseEnvDeprecationWarned = false;
function maybeWarnPassphraseEnvDeprecation(): void {
  if (_passphraseEnvDeprecationWarned) return;
  if (process.env.SWITCHROOM_VAULT_PASSPHRASE === undefined) return;
  if (!isSandboxContext()) return;
  if (process.env.SWITCHROOM_NO_VAULT_DEPRECATION_WARNING === "1") return;
  _passphraseEnvDeprecationWarned = true;
  process.stderr.write(
    `VAULT-DEPRECATION-WARNING: SWITCHROOM_VAULT_PASSPHRASE is set inside ` +
    `an agent sandbox. Skills should authenticate via a capability grant ` +
    `(\`switchroom vault grant <agent> --keys ... [--write ...]\`) instead — ` +
    `the master passphrase in process env defeats the ACL model and ` +
    `bypasses the broker audit log. See docs/vault-security.md. ` +
    `(Set SWITCHROOM_NO_VAULT_DEPRECATION_WARNING=1 to silence.)\n`
  );
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
    .description("Manage encrypted secrets vault")
    .hook("preAction", () => {
      // Fire the env-var deprecation check once per CLI invocation, BEFORE
      // any subcommand runs. Catches the legacy skill pattern of exporting
      // SWITCHROOM_VAULT_PASSPHRASE in the agent environment. (#969 P3)
      maybeWarnPassphraseEnvDeprecation();
    });

  vault
    .command("init")
    .description("Create a new encrypted vault file")
    .action(async () => {
      try {
        if (isSandboxContext()) {
          refuseSandboxDirectAccess("switchroom vault init");
        }
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
    .option(
      "--allow <agents>",
      "Comma-separated list of agent names allowed to read this secret via the broker. When set, only listed agents may access this key. Deny takes precedence over allow."
    )
    .option(
      "--deny <agents>",
      "Comma-separated list of agent names explicitly denied access to this secret via the broker. Takes precedence over --allow."
    )
    .action(async (key: string, opts: { file?: string; format?: string; allow?: string; deny?: string }) => {
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

        // ── Sandbox guards (issue #968) ─────────────────────────────────────
        //
        // Inside an agent container the vault file is not mounted; only
        // the broker socket is. Direct-IO options that need host vault
        // access (--file, --allow, --deny) cannot work — fail closed with
        // a marker the Telegram gateway can route to a clearer UX.
        const inSandbox = isSandboxContext();
        if (inSandbox && opts.file) {
          process.stderr.write(
            `VAULT-SANDBOX-CONTEXT: --file is not supported inside an agent ` +
            `sandbox (the source file is not visible to the host vault). ` +
            `Pipe the value via stdin, or run 'switchroom vault set ${key} ` +
            `--file ${opts.file}' on the host.\n`
          );
          process.exit(VAULT_EXIT_SANDBOX_CONTEXT);
        }
        if (inSandbox && (opts.allow !== undefined || opts.deny !== undefined)) {
          process.stderr.write(
            `VAULT-SANDBOX-CONTEXT: --allow / --deny scope changes require ` +
            `host-side vault re-encryption and cannot run from inside an ` +
            `agent sandbox. Re-run on the host shell.\n`
          );
          process.exit(VAULT_EXIT_SANDBOX_CONTEXT);
        }

        // ── Broker-mediated put (agent-driven rotation) ─────────────────────
        //
        // When stdin is piped (and the caller hasn't requested scope changes
        // or file input), route writes through the broker. This is the
        // path the calendar skill (and any OAuth-style skill that rotates
        // refresh tokens) needs: agents can't acquire the operator
        // passphrase, so direct vault writes are off-limits. The broker's
        // put-ACL is the same as the read-ACL (schedule.secrets[]) — agents
        // that can read a key can rotate it.
        //
        // Pre-fix this branch errored with "requires SWITCHROOM_VAULT_PASSPHRASE
        // to be set", which the calendar skill's ms_graph_token.py hit on
        // every refresh, dropping freshly-rotated tokens on the floor.
        //
        // Issue #968 fix: when running inside the agent sandbox, ALWAYS use
        // the broker — even if SWITCHROOM_VAULT_PASSPHRASE is set (the
        // Telegram gateway sets it for /vault commands). Direct vault.enc
        // access is impossible from the sandbox; falling through would
        // surface the misleading "Vault file not found:
        // /state/agent/home/.switchroom/vault.enc" error.
        if (
          (!process.stdin.isTTY || inSandbox)
          && !opts.file
          && opts.allow === undefined
          && opts.deny === undefined
          && (inSandbox || !process.env.SWITCHROOM_VAULT_PASSPHRASE)
        ) {
          // Read the new value from stdin first — broker put needs the
          // value as a string/binary kind. Multi-line preserved.
          const value = await readStdinToEnd();
          if (!value) {
            console.error(chalk.red("Error: Value cannot be empty"));
            process.exit(1);
          }
          if (formatHint) {
            const validationError = validateFormatHint(value, formatHint);
            if (validationError) {
              console.error(
                chalk.red(`Error: format validation failed for --format ${formatHint}: ${validationError}`),
              );
              process.exit(1);
            }
          }
          let brokerSocket: string | undefined;
          try {
            const config = loadConfig(parentOpts.config);
            brokerSocket = resolveBrokerSocketPath({
              vaultBrokerSocket: config.vault?.broker?.socket
                ? resolvePath(config.vault.broker.socket)
                : undefined,
            });
          } catch {
            brokerSocket = resolveBrokerSocketPath();
          }
          // Forward the agent's capability token to the broker (#969 P1b)
          // and any operator-passphrase attestation (#969 P1a). The broker
          // checks them in this priority:
          //   1. passphrase attestation → operator-attested, allows new keys
          //   2. write-grant token       → capability-attested, allows new keys
          //   3. path-as-identity        → rotate-only for keys in
          //                                schedule.secrets[]
          // The gateway sets SWITCHROOM_VAULT_PASSPHRASE in the env when
          // routing a user-approved save through this CLI — passing it
          // here is what makes the one-tap Telegram save flow succeed
          // for new keys without requiring a pre-minted write-grant.
          const agentSlug = process.env.SWITCHROOM_AGENT_NAME;
          const token = agentSlug ? readVaultTokenFile(agentSlug) ?? undefined : undefined;
          const passphraseEnv = process.env.SWITCHROOM_VAULT_PASSPHRASE;
          const result = await putViaBroker(
            key,
            { kind: "string", value },
            {
              socket: brokerSocket,
              token,
              ...(passphraseEnv ? { passphrase: passphraseEnv } : {}),
            },
          );
          if (result.kind === "ok") {
            return;
          }
          if (result.kind === "unreachable") {
            // Broker isn't there. From the sandbox there is no fallback —
            // surface a marker the gateway can route to a "broker down"
            // help card (#969 P0a). From the host, surface the legacy
            // passphrase-required hint.
            if (inSandbox) {
              process.stderr.write(
                `VAULT-BROKER-UNREACHABLE: cannot reach vault broker (${result.msg}). ` +
                `From inside the agent sandbox, direct vault access is not ` +
                `possible. Check broker health on the host: ` +
                `'switchroom vault broker status'.\n`
              );
              process.exit(VAULT_EXIT_BROKER_UNREACHABLE);
            }
            console.error(
              chalk.red(
                "Error: piping a value to `vault set` requires SWITCHROOM_VAULT_PASSPHRASE " +
                "to be set OR a reachable vault-broker (broker " +
                (result.msg ?? "unreachable") + ")",
              ),
            );
            process.exit(1);
          }
          // not_found: the broker reached us but the key doesn't exist.
          // Agents cannot create new keys via the broker — that requires
          // operator approval. Mark this with VAULT-NEEDS-APPROVAL (issue
          // #969 P0a) so the gateway can offer an approval card instead
          // of dumping a denied error at the user.
          if (result.kind === "not_found") {
            process.stderr.write(
              `VAULT-NEEDS-APPROVAL [unknown_key]: secret '${key}' does not ` +
              `exist in the vault yet. Agents can rotate existing keys via ` +
              `the broker but cannot create new ones; this requires operator ` +
              `approval. Tap the approval card in your Telegram chat, or run ` +
              `'switchroom vault set ${key}' on the host to create the entry.\n`
            );
            process.exit(VAULT_EXIT_NEEDS_APPROVAL);
          }
          // denied — broker reached and ACL refused. Print the structured
          // reason so the caller can act on it.
          process.stderr.write(
            `VAULT-BROKER-DENIED [${result.code}]: ${result.msg}\n`
          );
          process.exit(VAULT_EXIT_DENIED);
        }

        // Past this point we need direct vault.enc access — refuse early
        // from the sandbox with a clear marker instead of falling through
        // to setStringSecret → openVault → "Vault file not found".
        if (inSandbox) {
          refuseSandboxDirectAccess(`switchroom vault set ${key}`);
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

        // Build per-entry scope from --allow / --deny flags.
        let scope: VaultEntryScope | undefined;
        if (opts.allow !== undefined || opts.deny !== undefined) {
          scope = {};
          if (opts.allow !== undefined) {
            scope.allow = opts.allow
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
          }
          if (opts.deny !== undefined) {
            scope.deny = opts.deny
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
          }

          // #8 review-fix: warn (don't error) on agent names that don't match
          // any agent in switchroom.yaml. Operator typos like `--allow clerks`
          // (instead of `clerk`) would otherwise silently lock out the
          // intended agent — discoverable only by reading the audit log
          // looking for `denied:scope-allow` with the wrong slug. A warning
          // here catches the common case at write time.
          //
          // Non-fatal: a future agent name that doesn't exist yet is a
          // legitimate use case (you can scope an entry for an agent you're
          // about to add). Don't reject; nudge.
          try {
            const config = loadConfig();
            const knownAgents = new Set(Object.keys(config.agents ?? {}));
            const unknown: string[] = [];
            for (const name of [...(scope.allow ?? []), ...(scope.deny ?? [])]) {
              if (!knownAgents.has(name)) unknown.push(name);
            }
            if (unknown.length > 0) {
              console.error(
                chalk.yellow(
                  `⚠️  Unknown agent name(s) in scope: ${unknown.join(", ")}. ` +
                  `Known agents: ${[...knownAgents].sort().join(", ") || "(none)"}. ` +
                  `Continuing — but verify this isn't a typo.`,
                ),
              );
            }
          } catch {
            // loadConfig may fail in test contexts or before setup. Don't
            // block the secret-set on a config-load problem.
          }
        }

        setStringSecret(passphrase, vaultPath, key, value, formatHint, scope);
        if (formatHint && scope) {
          const scopeDesc = [
            scope.allow?.length ? `allow: ${scope.allow.join(", ")}` : "",
            scope.deny?.length ? `deny: ${scope.deny.join(", ")}` : "",
          ].filter(Boolean).join("; ");
          console.log(chalk.green(`✓ Secret '${key}' saved (format: ${formatHint}, scope: ${scopeDesc})`));
        } else if (formatHint) {
          console.log(chalk.green(`✓ Secret '${key}' saved (format: ${formatHint})`));
        } else if (scope) {
          const scopeDesc = [
            scope.allow?.length ? `allow: ${scope.allow.join(", ")}` : "",
            scope.deny?.length ? `deny: ${scope.deny.join(", ")}` : "",
          ].filter(Boolean).join("; ");
          console.log(chalk.green(`✓ Secret '${key}' saved (scope: ${scopeDesc})`));
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
    .option("--no-broker", "Bypass the broker and read directly from the vault store. Required for interactive (non-scheduled) access — the broker only serves an agent's scheduled runs (the in-agent agent-scheduler sidecar) over that agent's per-agent socket.")
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
        // Use the canonical resolver — honors `SWITCHROOM_VAULT_BROKER_SOCK`
        // env first (set by compose into agent containers), then config
        // `vault.broker.socket`, then `~/.switchroom/vault-broker.sock`
        // legacy fallback. Pre-fix this CLI skipped the env entirely and
        // jumped straight to config → legacy fallback. Inside an agent
        // container the legacy fallback `~/.switchroom/vault-broker.sock`
        // is a dangling symlink (via the #910 home-symlink fix), so the
        // CLI reported "broker not running" even when the broker WAS
        // reachable on the canonical env path. Surfaced 2026-05-10 as
        // clerk's calendar skill failing every `switchroom vault get`
        // even though direct broker IPC worked fine.
        let brokerSocket: string | undefined;
        try {
          const config = loadConfig(parentOpts.config);
          brokerSocket = resolveBrokerSocketPath({
            vaultBrokerSocket: config.vault?.broker?.socket
              ? resolvePath(config.vault.broker.socket)
              : undefined,
          });
        } catch {
          brokerSocket = resolveBrokerSocketPath();
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
                `VAULT-BROKER-DENIED: broker locked and stdin is not a TTY.\n` +
                `${recoveryHint("locked", key)}\n`
              );
              process.exit(3);
            }
          }

          // Broker is unlocked — request the key.
          // Issue #1053: include the agent's capability token so the
          // broker's grant path (server.ts:994-1028) can bypass the
          // peercred ACL check. Mirror the `vault set` path above
          // (line 401-402) which has done this since #969 P1b.
          // Without this, a freshly-minted grant (Telegram approval
          // card) writes a token file the CLI then ignores —
          // subsequent `vault get` still gets DENIED on the
          // peercred ACL even though the operator just approved.
          const getAgentSlug = process.env.SWITCHROOM_AGENT_NAME;
          const getToken = getAgentSlug ? readVaultTokenFile(getAgentSlug) ?? undefined : undefined;
          const result = await getViaBrokerStructured(key, {
            ...brokerOpts,
            ...(getToken ? { token: getToken } : {}),
          });

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
                `${recoveryHint("denied", key)}\n`
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
            `VAULT-BROKER-DENIED: broker not running and stdin is not a TTY.\n` +
            `${recoveryHint("unreachable", key)}\n`
          );
          process.exit(1);
        }
        // Fall through to direct vault access with passphrase prompt (or env var)
      }

      // ── Direct vault access (--no-broker or broker unreachable + TTY) ──
      //
      // Sandbox guard: vault.enc isn't mounted into agent containers, so a
      // direct read here would surface "Vault file not found". Refuse with
      // a clear marker instead. The broker path above is the only valid
      // surface from inside an agent.
      if (isSandboxContext()) {
        refuseSandboxDirectAccess(`switchroom vault get ${key}`);
      }

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

        // Sandbox: route via broker — vault.enc isn't mounted into agent
        // containers. Falling through to listSecrets would surface
        // "Vault file not found".
        if (isSandboxContext()) {
          let brokerSocket: string | undefined;
          try {
            const config = loadConfig(parentOpts.config);
            brokerSocket = resolveBrokerSocketPath({
              vaultBrokerSocket: config.vault?.broker?.socket
                ? resolvePath(config.vault.broker.socket)
                : undefined,
            });
          } catch {
            brokerSocket = resolveBrokerSocketPath();
          }
          const { listViaBroker } = await import("../vault/broker/client.js");
          const keys = await listViaBroker({ socket: brokerSocket });
          if (keys === null) {
            process.stderr.write(
              `VAULT-BROKER-UNREACHABLE: cannot reach vault broker; ` +
              `'switchroom vault list' from a sandbox requires a live broker.\n`
            );
            process.exit(VAULT_EXIT_BROKER_UNREACHABLE);
          }
          if (keys.length === 0) {
            console.log(chalk.dim("No secrets in vault"));
          } else {
            for (const key of keys) console.log(key);
          }
          return;
        }

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
        if (isSandboxContext()) {
          // The broker has no `remove` op — removal needs host-side
          // vault re-encryption. Fail closed with a clear marker.
          refuseSandboxDirectAccess(`switchroom vault remove ${key}`);
        }
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

  // `vault doctor` — health check for vault security model.
  registerVaultDoctorCommand(vault, program);

  // `vault audit` — tail/filter the vault audit log.
  registerVaultAuditCommand(vault, program);

  // `vault grant` / `vault grants` / `vault revoke` — capability token management.
  registerVaultGrantCommands(vault, program);

  // `vault backup` — dated encrypted snapshots of vault.enc to a
  // configured destination (operator's private config repo by default).
  // Companion to the proven manual `cp + restart broker` recovery flow;
  // see src/cli/vault-backup.ts for the trust-model + design discussion.
  registerVaultBackupCommand(vault, program);
}
