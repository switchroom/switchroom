/**
 * `switchroom telegram` — operator CLI for phone-first features (#597).
 *
 * Single verb that wraps "vault put + switchroom.yaml edit + reconcile
 * hint" so enabling voice-in / telegraph / webhook is one command, not
 * three files. Builds on the cascade-canonical schema landed in #596.
 *
 * Phase 1: status + telegraph enable/disable.
 * Phase 2 (this commit): voice-in (vault + OpenAI api-key) and webhook
 *   (vault + signature secret per source).
 */

import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  matchesRule,
  buildGithubContext,
  renderTemplate,
  parseDurationMs,
  isQuietHour,
} from "../web/webhook-dispatch.js";
import { createInterface } from "node:readline";
import { resolvePath, loadConfig } from "../config/loader.js";
import { createVault, setStringSecret } from "../vault/vault.js";
import { getConfig, getConfigPath, withConfigError } from "./helpers.js";
import { resolveAgentConfig } from "../config/merge.js";
import {
  setTelegramFeature,
  removeTelegramFeature,
  addWebhookSource,
  removeWebhookSource,
} from "./telegram-yaml.js";

export function registerTelegramCommand(program: Command): void {
  const tg = program
    .command("telegram")
    .description(
      "Configure phone-first Telegram features (telegraph long-replies, voice-in, webhook ingest) for an agent.",
    );

  registerStatusVerb(tg, program);
  registerEnableVerb(tg, program);
  registerDisableVerb(tg, program);
  registerDispatchVerb(tg, program);
}

// ─── status ──────────────────────────────────────────────────────────────────

function registerStatusVerb(tg: Command, program: Command): void {
  tg.command("status")
    .description(
      "Show which Telegram features are enabled per agent, derived from the resolved cascade.",
    )
    .action(
      withConfigError(async () => {
        const config = getConfig(program);
        const rows: StatusRow[] = [];
        for (const [name, raw] of Object.entries(config.agents)) {
          const resolved = resolveAgentConfig(
            config.defaults,
            config.profiles,
            raw,
          );
          const t = resolved.channels?.telegram;
          rows.push({
            agent: name,
            voiceIn: formatVoiceIn(t?.voice_in),
            telegraph: formatTelegraph(t?.telegraph),
            webhooks: formatWebhooks(t?.webhook_sources),
          });
        }
        printStatusTable(rows);
      }),
    );
}

interface StatusRow {
  agent: string;
  voiceIn: string;
  telegraph: string;
  webhooks: string;
}

function formatVoiceIn(v: { enabled?: boolean; provider?: string; language?: string } | undefined): string {
  if (!v?.enabled) return "—";
  const provider = v.provider ?? "openai";
  return v.language ? `✓ ${provider} (${v.language})` : `✓ ${provider}`;
}

function formatTelegraph(t: { enabled?: boolean; threshold?: number } | undefined): string {
  if (!t?.enabled) return "—";
  return `✓ ${t.threshold ?? 3000}`;
}

function formatWebhooks(sources: string[] | undefined): string {
  if (!sources || sources.length === 0) return "—";
  return `✓ ${sources.join(", ")}`;
}

function printStatusTable(rows: StatusRow[]): void {
  if (rows.length === 0) {
    console.log(chalk.yellow("No agents declared in switchroom.yaml."));
    return;
  }
  const headers = { agent: "Agent", voiceIn: "Voice-in", telegraph: "Telegraph", webhooks: "Webhook sources" };
  const widths = {
    agent: Math.max(headers.agent.length, ...rows.map((r) => r.agent.length)),
    voiceIn: Math.max(headers.voiceIn.length, ...rows.map((r) => stripAnsi(r.voiceIn).length)),
    telegraph: Math.max(headers.telegraph.length, ...rows.map((r) => stripAnsi(r.telegraph).length)),
    webhooks: Math.max(headers.webhooks.length, ...rows.map((r) => stripAnsi(r.webhooks).length)),
  };
  const fmt = (r: StatusRow) =>
    `${r.agent.padEnd(widths.agent)}  ${r.voiceIn.padEnd(widths.voiceIn)}  ${r.telegraph.padEnd(widths.telegraph)}  ${r.webhooks.padEnd(widths.webhooks)}`;
  console.log(chalk.bold(fmt({ agent: headers.agent, voiceIn: headers.voiceIn, telegraph: headers.telegraph, webhooks: headers.webhooks })));
  for (const r of rows) console.log(fmt(r));
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ─── enable ──────────────────────────────────────────────────────────────────

function registerEnableVerb(tg: Command, program: Command): void {
  const enable = tg
    .command("enable")
    .description("Turn on a Telegram feature for an agent.");

  enable
    .command("telegraph")
    .description(
      "Enable Telegraph long-reply publishing. Replies above --threshold chars publish to telegra.ph and the agent sends a single message linking to the Instant View.",
    )
    .requiredOption("--agent <name>", "Agent name (must exist in switchroom.yaml)")
    .option("--threshold <chars>", "Character count above which replies go to Telegraph", "3000")
    .option("--short-name <name>", "Telegraph account short_name (defaults to agent name)")
    .option("--author-name <name>", "Telegraph 'author' shown on the article header")
    .option("--dry-run", "Print the YAML diff without writing")
    .action(
      withConfigError(async (opts: TelegraphEnableOpts) => {
        const threshold = Number(opts.threshold);
        if (!Number.isFinite(threshold) || threshold <= 0) {
          fail(`--threshold must be a positive integer (got ${opts.threshold})`);
        }
        const value: Record<string, unknown> = { enabled: true, threshold };
        if (opts.shortName) value.short_name = opts.shortName;
        if (opts.authorName) value.author_name = opts.authorName;
        await applyYamlEdit(program, opts.agent, "telegraph", value, opts.dryRun ?? false);
      }),
    );

  // ─── voice-in (#597 phase 2) ─────────────────────────────────────────────
  enable
    .command("voice-in")
    .description(
      "Enable voice-message transcription via OpenAI Whisper. Vault-stores the API key under 'openai/api-key' and points the agent's voice_in.api_key at it.",
    )
    .requiredOption("--agent <name>", "Agent name (must exist in switchroom.yaml)")
    .requiredOption("--api-key <key>", "OpenAI API key (sk-...). Stored in the vault, never written to switchroom.yaml.")
    .option("--provider <name>", "Transcription provider", "openai")
    .option("--language <iso639>", "Optional language hint (e.g. 'en'). Improves accuracy when the user's language is known.")
    .option("--vault-key <key>", "Vault key under which to store the API key", "openai/api-key")
    .option("--dry-run", "Print the YAML diff without writing or vaulting anything")
    .action(
      withConfigError(async (opts: VoiceInEnableOpts) => {
        if (opts.provider !== "openai") {
          fail(`--provider currently only supports 'openai' (got '${opts.provider}'). Other providers will land in a follow-up.`);
        }
        if (!opts.apiKey.startsWith("sk-")) {
          // Soft validation — OpenAI keys all start with sk-. Catches an
          // operator pasting the wrong thing (e.g. the org id) at write
          // time rather than discovering it via a 401 at first voice msg.
          fail(`--api-key doesn't look like an OpenAI key (expected prefix 'sk-', got '${opts.apiKey.slice(0, 6)}…'). If this is intentional, please file a bug.`);
        }
        if (!opts.dryRun) {
          await vaultPut(program, opts.vaultKey, opts.apiKey);
        }
        const value: Record<string, unknown> = {
          enabled: true,
          provider: opts.provider,
          api_key: `vault:${opts.vaultKey}`,
        };
        if (opts.language) value.language = opts.language;
        await applyYamlEdit(program, opts.agent, "voice_in", value, opts.dryRun ?? false);
      }),
    );

  // ─── webhook (#597 phase 2) ──────────────────────────────────────────────
  enable
    .command("webhook")
    .description(
      "Enable a webhook source for the agent. Vault-stores the signature secret under 'webhook/<agent>/<source>' and appends the source to the agent's webhook_sources array.",
    )
    .requiredOption("--agent <name>", "Agent name (must exist in switchroom.yaml)")
    .requiredOption("--source <name>", "Source identifier (e.g. 'github', 'generic', 'stripe'). Used for the vault key and to label inbound payloads.")
    .requiredOption("--secret <value>", "Webhook signature secret. Stored in the vault, never in switchroom.yaml.")
    .option("--dry-run", "Print the YAML diff without writing or vaulting")
    .action(
      withConfigError(async (opts: WebhookEnableOpts) => {
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(opts.source)) {
          fail(`--source must be lowercase alphanumeric (with -/_), 1-64 chars (got '${opts.source}'). The source name is used as a vault key segment and as a label on inbound payloads.`);
        }
        const vaultKey = `webhook/${opts.agent}/${opts.source}`;
        if (!opts.dryRun) {
          await vaultPut(program, vaultKey, opts.secret);
        }
        await applyYamlAddWebhook(program, opts.agent, opts.source, opts.dryRun ?? false);
      }),
    );
}

interface TelegraphEnableOpts {
  agent: string;
  threshold: string;
  shortName?: string;
  authorName?: string;
  dryRun?: boolean;
}

interface VoiceInEnableOpts {
  agent: string;
  apiKey: string;
  provider: string;
  language?: string;
  vaultKey: string;
  dryRun?: boolean;
}

interface WebhookEnableOpts {
  agent: string;
  source: string;
  secret: string;
  dryRun?: boolean;
}

// ─── disable ─────────────────────────────────────────────────────────────────

function registerDisableVerb(tg: Command, program: Command): void {
  const disable = tg
    .command("disable")
    .description("Turn off a Telegram feature for an agent.");

  disable
    .command("telegraph")
    .description("Disable Telegraph long-reply publishing for the agent.")
    .requiredOption("--agent <name>", "Agent name")
    .option("--dry-run", "Print the YAML diff without writing")
    .action(
      withConfigError(async (opts: { agent: string; dryRun?: boolean }) => {
        await applyYamlRemove(program, opts.agent, "telegraph", opts.dryRun ?? false);
      }),
    );

  disable
    .command("voice-in")
    .description(
      "Disable voice-in for the agent. Removes the voice_in entry from switchroom.yaml; leaves the vault key in place so re-enable doesn't require re-entering the key.",
    )
    .requiredOption("--agent <name>", "Agent name")
    .option("--dry-run", "Print the YAML diff without writing")
    .action(
      withConfigError(async (opts: { agent: string; dryRun?: boolean }) => {
        await applyYamlRemove(program, opts.agent, "voice_in", opts.dryRun ?? false);
      }),
    );

  disable
    .command("webhook")
    .description(
      "Remove a single webhook source from the agent. Other sources (if any) remain enabled. The vault entry for the source's signature secret is NOT deleted — re-enable doesn't require re-entering it.",
    )
    .requiredOption("--agent <name>", "Agent name")
    .requiredOption("--source <name>", "Source identifier to remove")
    .option("--dry-run", "Print the YAML diff without writing")
    .action(
      withConfigError(async (opts: { agent: string; source: string; dryRun?: boolean }) => {
        await applyYamlRemoveWebhook(program, opts.agent, opts.source, opts.dryRun ?? false);
      }),
    );
}

// ─── shared helpers ──────────────────────────────────────────────────────────

async function applyYamlEdit(
  program: Command,
  agent: string,
  feature: "telegraph" | "voice_in" | "webhook_sources",
  value: unknown,
  dryRun: boolean,
): Promise<void> {
  const path = getConfigPath(program);
  const before = readFileSync(path, "utf-8");
  let after: string;
  try {
    after = setTelegramFeature(before, agent, feature, value);
  } catch (err) {
    fail((err as Error).message);
  }
  emitDiffOrWrite(path, before, after, dryRun);
  if (!dryRun) {
    console.log(chalk.green(`✓ Enabled ${feature.replace("_", "-")} for agent '${agent}'`));
    console.log(
      chalk.gray(`  Run 'switchroom agent restart ${agent}' to pick up the change.`),
    );
  }
}

async function applyYamlRemove(
  program: Command,
  agent: string,
  feature: "telegraph" | "voice_in" | "webhook_sources",
  dryRun: boolean,
): Promise<void> {
  const path = getConfigPath(program);
  const before = readFileSync(path, "utf-8");
  const after = removeTelegramFeature(before, agent, feature);
  if (before === after) {
    console.log(
      chalk.yellow(
        `No change — ${feature.replace("_", "-")} is not set for agent '${agent}'.`,
      ),
    );
    return;
  }
  emitDiffOrWrite(path, before, after, dryRun);
  if (!dryRun) {
    console.log(chalk.green(`✓ Disabled ${feature.replace("_", "-")} for agent '${agent}'`));
    console.log(
      chalk.gray(`  Run 'switchroom agent restart ${agent}' to pick up the change.`),
    );
  }
}

function emitDiffOrWrite(path: string, before: string, after: string, dryRun: boolean): void {
  if (dryRun) {
    console.log(chalk.bold(`[dry-run] would edit ${path}`));
    console.log(makeUnifiedDiff(before, after));
    return;
  }
  writeFileSync(path, after, "utf-8");
}

function makeUnifiedDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++; j++;
    } else if (j < b.length && (i >= a.length || a[i] !== b[j])) {
      out.push(chalk.green(`+ ${b[j]}`));
      j++;
    } else {
      out.push(chalk.red(`- ${a[i]}`));
      i++;
    }
  }
  return out.join("\n");
}

function fail(msg: string): never {
  console.error(chalk.red(`Error: ${msg}`));
  process.exit(1);
}

// ─── shared helpers for #597 phase 2 ─────────────────────────────────────────

async function applyYamlAddWebhook(
  program: Command,
  agent: string,
  source: string,
  dryRun: boolean,
): Promise<void> {
  const path = getConfigPath(program);
  const before = readFileSync(path, "utf-8");
  let after: string;
  try {
    after = addWebhookSource(before, agent, source);
  } catch (err) {
    fail((err as Error).message);
  }
  if (before === after) {
    console.log(
      chalk.yellow(
        `No change — webhook source '${source}' was already enabled for agent '${agent}'.`,
      ),
    );
    return;
  }
  emitDiffOrWrite(path, before, after, dryRun);
  if (!dryRun) {
    console.log(chalk.green(`✓ Enabled webhook source '${source}' for agent '${agent}'`));
    console.log(
      chalk.gray(`  Vault key: webhook/${agent}/${source}`),
    );
    console.log(
      chalk.gray(`  Run 'switchroom agent restart ${agent}' to pick up the change.`),
    );
  }
}

async function applyYamlRemoveWebhook(
  program: Command,
  agent: string,
  source: string,
  dryRun: boolean,
): Promise<void> {
  const path = getConfigPath(program);
  const before = readFileSync(path, "utf-8");
  const after = removeWebhookSource(before, agent, source);
  if (before === after) {
    console.log(
      chalk.yellow(
        `No change — webhook source '${source}' is not currently enabled for agent '${agent}'.`,
      ),
    );
    return;
  }
  emitDiffOrWrite(path, before, after, dryRun);
  if (!dryRun) {
    console.log(chalk.green(`✓ Disabled webhook source '${source}' for agent '${agent}'`));
    console.log(
      chalk.gray(`  Vault key webhook/${agent}/${source} left in place — re-enable will reuse it.`),
    );
    console.log(
      chalk.gray(`  Run 'switchroom agent restart ${agent}' to pick up the change.`),
    );
  }
}

/**
 * Vault-put helper for the voice-in / webhook verbs. Resolves the
 * vault path from the loaded config (falls back to the canonical
 * default), prompts for the passphrase if not set via env, and writes
 * the secret as a string entry. Mirrors the pattern in cli/setup.ts.
 *
 * Creates the vault on first use — operators who haven't run
 * `switchroom vault init` yet shouldn't see the verb fail with a
 * confusing "vault not found" error when the natural action is to
 * create it.
 */
async function vaultPut(program: Command, key: string, value: string): Promise<void> {
  const configPath = (program.optsWithGlobals().config as string | undefined) ?? undefined;
  const vaultPath = resolveVaultPath(configPath);
  const passphrase = await getVaultPassphrase();
  if (!existsSync(vaultPath)) {
    createVault(passphrase, vaultPath);
    console.log(chalk.gray(`  Created new vault at ${vaultPath}`));
  }
  setStringSecret(passphrase, vaultPath, key, value);
  console.log(chalk.green(`✓ Stored secret in vault as '${key}'`));
}

function resolveVaultPath(configPath?: string): string {
  try {
    const config = loadConfig(configPath);
    return resolvePath(config.vault?.path ?? "~/.switchroom/vault.enc");
  } catch {
    return resolvePath("~/.switchroom/vault.enc");
  }
}

async function getVaultPassphrase(): Promise<string> {
  const env = process.env.SWITCHROOM_VAULT_PASSPHRASE;
  if (env) return env;
  const passphrase = await promptHidden("Vault passphrase: ");
  if (!passphrase) throw new Error("Vault passphrase cannot be empty");
  return passphrase;
}

// ─── dispatch ────────────────────────────────────────────────────────────────

function registerDispatchVerb(tg: Command, _program: Command): void {
  const dispatch = tg
    .command("dispatch")
    .description("Webhook dispatch utilities.");

  dispatch
    .command("test")
    .description(
      "Dry-run dispatch rule matching against a captured payload file. " +
      "Prints which rules would match and the rendered prompt, without " +
      "spawning a claude -p process.",
    )
    .requiredOption("--agent <name>", "Agent name (must exist in switchroom.yaml)")
    .requiredOption("--payload <file>", "Path to a JSON payload file")
    .requiredOption("--event <type>", "GitHub event type (e.g. 'pull_request', 'push')")
    .option("--source <name>", "Webhook source (default: github)", "github")
    .action(
      withConfigError(async (opts: DispatchTestOpts) => {
        const config = getConfig(_program);
        const agentRaw = config.agents[opts.agent];
        if (!agentRaw) {
          fail(`Unknown agent '${opts.agent}'. Check switchroom.yaml.`);
        }
        const resolved = resolveAgentConfig(config.defaults, config.profiles, agentRaw);
        const dispatchConfig = resolved.channels?.telegram?.webhook_dispatch;
        if (!dispatchConfig) {
          console.log(
            chalk.yellow(`No webhook_dispatch config found for agent '${opts.agent}'.`),
          );
          return;
        }

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(readFileSync(opts.payload, "utf-8")) as Record<string, unknown>;
        } catch (err) {
          fail(`Could not read payload file '${opts.payload}': ${(err as Error).message}`);
        }

        // Collect matches without spawning
        const rules = opts.source === "github" ? (dispatchConfig.github ?? []) : [];
        if (rules.length === 0) {
          console.log(chalk.yellow(`No dispatch rules for source '${opts.source}'.`));
          return;
        }

        let matchCount = 0;
        const now = new Date();

        for (let i = 0; i < rules.length; i++) {
          const rule = rules[i];
          const matched = matchesRule(opts.event, payload, rule.match);
          const prefix = matched ? chalk.green("✓ MATCH") : chalk.dim("✗ no match");
          const desc = rule.description ? ` — ${rule.description}` : ` — rule ${i}`;
          console.log(`${prefix}  rule ${i}${desc}`);

          if (!matched) continue;
          matchCount++;

          // Quiet hours status
          if (rule.quiet_hours) {
            const quiet = isQuietHour(rule.quiet_hours, now);
            console.log(
              `  quiet hours: ${quiet ? chalk.yellow("ACTIVE (would skip)") : chalk.green("inactive")}`,
            );
          }

          // Cooldown note
          if (rule.cooldown) {
            const ms = parseDurationMs(rule.cooldown);
            console.log(
              `  cooldown: ${rule.cooldown} (${ms}ms) — state tracked in webhook-cooldown.json`,
            );
          }

          // Rendered prompt
          const ctx = buildGithubContext(opts.event, payload);
          const rendered = renderTemplate(rule.prompt, ctx);
          console.log(chalk.bold("  rendered prompt:"));
          for (const line of rendered.split("\n")) {
            console.log(`    ${line}`);
          }
          console.log(`  model: ${rule.model ?? "claude-sonnet-4-6"}`);
        }

        console.log();
        if (matchCount === 0) {
          console.log(chalk.yellow("No rules matched — no dispatch would fire."));
        } else {
          console.log(
            chalk.green(
              `${matchCount} rule(s) matched. ` +
              `Run without --dry-run in production to spawn claude -p.`,
            ),
          );
        }
      }),
    );
}

interface DispatchTestOpts {
  agent: string;
  payload: string;
  event: string;
  source: string;
}

function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    if (process.stdin.isTTY) {
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
    } else {
      // Non-TTY: read a single line. Operator can pipe the passphrase
      // through stdin for scripted use.
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}
