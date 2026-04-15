#!/usr/bin/env bun
// One-shot migration: lift /data/openclaw-config/credentials/ into the
// Switchroom vault using the Phase 9.1.1 VaultEntry schema. Deleted once
// every host has been migrated.

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openVault,
  saveVault,
  VaultError,
  type VaultEntry,
} from "../src/vault/vault.js";
import { loadConfig, resolvePath } from "../src/config/loader.js";

const DEFAULT_SOURCE = "/data/openclaw-config/credentials";

export type ImportAction =
  | { kind: "set-string"; vaultKey: string; value: string }
  | {
      kind: "set-files";
      vaultKey: string;
      files: Record<string, { encoding: "utf8" | "base64"; value: string }>;
    }
  | { kind: "skip"; reason: string }
  | { kind: "warn"; reason: string };

export interface ImportPlanEntry {
  sourcePath: string;
  sourceName: string;
  action: ImportAction;
}

// Mapping from source filename → vault key, lifted verbatim from
// clerk-export/credentials/CREDENTIAL_MAP.md. Every file listed here is
// stored as a `kind:"string"` entry (plaintext or JSON blob preserved
// as-is). Multi-file and skipped entries are handled outside this table.
const FILE_TO_VAULT_KEY: Record<string, string> = {
  "anthropic-buildkite-token": "anthropic/buildkite-api-key",
  "anthropic-personal-api-key": "anthropic/personal-api-key",

  "buildkite-api-token": "buildkite/api-token",
  "calendar-admin-api-key": "calendar/admin-api-key",
  "calendar-jwt-secret": "calendar/jwt-secret",
  "calendar-jwt-token": "calendar/jwt-token",
  "claude-code-token.json": "anthropic/claude-code-token",
  "claude-code-token.txt": "anthropic/claude-code-token-txt",
  "cloudflare-api-token.json": "cloudflare/api-token",
  "cluedin-agent-key.json": "cluedin/agent-key",
  "cluedin-agent-keys.json": "cluedin/agent-keys",
  "compass-mac.json": "compass/credentials",
  "coolify-api-token": "coolify/api-token",

  "discord-pairing.json": "discord/pairing",
  "elevenlabs-api-key": "elevenlabs/api-key",

  "google-buildkite.json": "google/buildkite-client",
  "google-photos.json": "google/photos-client",
  "google-tokens-buildkite.json": "google/buildkite-tokens",
  "google-tokens-photos.json": "google/photos-tokens",
  "ha-access-token": "ha/access-token",
  "ha-ssh-key": "ha/ssh-key",
  "hotdoc.json": "hotdoc/credentials",
  "linear-api-key": "linear/api-key",
  "linear-personal-api-key": "linear/personal-api-key",
  "microsoft-azure.json": "microsoft/azure-app",

  "nas-ssh-key": "nas/ssh-key",
  "notion-api-key": "notion/api-key",
  "notion-token": "notion/token",
  "perplexity-api-key": "perplexity/api-key",


  "telegram-allowFrom.json": "telegram/main-allowfrom",
  "telegram-bot-token": "telegram/main-bot-token",

  "telegram-default-allowFrom.json": "telegram/default-allowfrom",


  "telegram-pairing.json": "telegram/main-pairing",
  "wsl-ssh-key": "wsl/ssh-key",
};

const EXPLICIT_SKIP: Record<string, string> = {
  "compass-mac-cookies.json": "auto-managed by compass skill (8h TTL cache)",
  "garmin-session.json": "legacy, superseded by garmin-tokens directory",
  "garmin.json": "legacy, superseded by garmin-tokens directory",
};

// `secrets.env` catch-all: known key → vault key. Anything not in this
// map falls through to a warning so the operator can add a mapping.
const SECRETS_ENV_MAP: Record<string, string> = {
  X_BEARER_TOKEN: "x-api/bearer-token",
  OPENROUTER_API_KEY: "openrouter/api-key",
};

// Directory names that should be lifted as `kind:"files"` multi-file
// secrets. Every file inside is read as utf8.
const DIRECTORY_TO_VAULT_KEY: Record<string, string> = {
  "garmin-tokens": "garmin/tokens",
};

export function parseSecretsEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function readDirectoryAsFiles(
  dir: string
): Record<string, { encoding: "utf8"; value: string }> {
  const out: Record<string, { encoding: "utf8"; value: string }> = {};
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isFile()) continue;
    out[entry] = { encoding: "utf8", value: readFileSync(full, "utf8") };
  }
  return out;
}

export function planImport(credentialsDir: string): ImportPlanEntry[] {
  if (!existsSync(credentialsDir)) {
    throw new Error(`credentials directory not found: ${credentialsDir}`);
  }

  const plan: ImportPlanEntry[] = [];
  const entries = readdirSync(credentialsDir).sort();

  for (const name of entries) {
    const full = join(credentialsDir, name);
    const st = statSync(full);

    if (st.isDirectory()) {
      const vaultKey = DIRECTORY_TO_VAULT_KEY[name];
      if (vaultKey) {
        plan.push({
          sourcePath: full,
          sourceName: name,
          action: {
            kind: "set-files",
            vaultKey,
            files: readDirectoryAsFiles(full),
          },
        });
      } else {
        plan.push({
          sourcePath: full,
          sourceName: name,
          action: {
            kind: "warn",
            reason: `unknown directory (no mapping) — add to DIRECTORY_TO_VAULT_KEY or skip`,
          },
        });
      }
      continue;
    }

    if (name.endsWith(".pub")) {
      plan.push({
        sourcePath: full,
        sourceName: name,
        action: { kind: "skip", reason: "public key, not a secret" },
      });
      continue;
    }

    if (name in EXPLICIT_SKIP) {
      plan.push({
        sourcePath: full,
        sourceName: name,
        action: { kind: "skip", reason: EXPLICIT_SKIP[name] },
      });
      continue;
    }

    if (name === "secrets.env") {
      const parsed = parseSecretsEnv(readFileSync(full, "utf8"));
      for (const [envKey, envValue] of Object.entries(parsed)) {
        const vaultKey = SECRETS_ENV_MAP[envKey];
        if (vaultKey) {
          plan.push({
            sourcePath: `${full}#${envKey}`,
            sourceName: `secrets.env:${envKey}`,
            action: { kind: "set-string", vaultKey, value: envValue },
          });
        } else {
          plan.push({
            sourcePath: `${full}#${envKey}`,
            sourceName: `secrets.env:${envKey}`,
            action: {
              kind: "warn",
              reason: `unknown env key — add to SECRETS_ENV_MAP or ignore`,
            },
          });
        }
      }
      continue;
    }

    const vaultKey = FILE_TO_VAULT_KEY[name];
    if (vaultKey) {
      plan.push({
        sourcePath: full,
        sourceName: name,
        action: {
          kind: "set-string",
          vaultKey,
          value: readFileSync(full, "utf8"),
        },
      });
    } else {
      plan.push({
        sourcePath: full,
        sourceName: name,
        action: {
          kind: "warn",
          reason: "unknown file (no mapping) — add to FILE_TO_VAULT_KEY or skip",
        },
      });
    }
  }

  return plan;
}

export interface ApplyResult {
  written: string[];
  skipped: string[];
  warned: string[];
  conflicts: string[];
}

export function applyPlan(
  plan: ImportPlanEntry[],
  vaultPath: string,
  passphrase: string,
  options: { overwrite: boolean } = { overwrite: false }
): ApplyResult {
  const secrets = openVault(passphrase, vaultPath);
  const result: ApplyResult = {
    written: [],
    skipped: [],
    warned: [],
    conflicts: [],
  };

  for (const entry of plan) {
    switch (entry.action.kind) {
      case "skip":
        result.skipped.push(`${entry.sourceName} (${entry.action.reason})`);
        break;
      case "warn":
        result.warned.push(`${entry.sourceName} (${entry.action.reason})`);
        break;
      case "set-string": {
        const { vaultKey, value } = entry.action;
        if (vaultKey in secrets && !options.overwrite) {
          result.conflicts.push(`${vaultKey} (from ${entry.sourceName})`);
          break;
        }
        const vaultEntry: VaultEntry = { kind: "string", value };
        secrets[vaultKey] = vaultEntry;
        result.written.push(`${vaultKey} ← ${entry.sourceName}`);
        break;
      }
      case "set-files": {
        const { vaultKey, files } = entry.action;
        if (vaultKey in secrets && !options.overwrite) {
          result.conflicts.push(`${vaultKey} (from ${entry.sourceName})`);
          break;
        }
        const vaultEntry: VaultEntry = { kind: "files", files };
        secrets[vaultKey] = vaultEntry;
        result.written.push(
          `${vaultKey} ← ${entry.sourceName} (${Object.keys(files).length} files)`
        );
        break;
      }
    }
  }

  if (result.written.length > 0) {
    saveVault(passphrase, vaultPath, secrets);
  }

  return result;
}

export function formatPlan(plan: ImportPlanEntry[]): string {
  const lines: string[] = [];
  let written = 0;
  let skipped = 0;
  let warned = 0;

  for (const entry of plan) {
    switch (entry.action.kind) {
      case "set-string":
        lines.push(`  SET    ${entry.action.vaultKey.padEnd(38)} ← ${entry.sourceName}`);
        written++;
        break;
      case "set-files":
        lines.push(
          `  FILES  ${entry.action.vaultKey.padEnd(38)} ← ${entry.sourceName} (${Object.keys(entry.action.files).length} files)`
        );
        written++;
        break;
      case "skip":
        lines.push(`  SKIP   ${entry.sourceName} — ${entry.action.reason}`);
        skipped++;
        break;
      case "warn":
        lines.push(`  WARN   ${entry.sourceName} — ${entry.action.reason}`);
        warned++;
        break;
    }
  }

  lines.push("");
  lines.push(`Total: ${plan.length}  set=${written}  skip=${skipped}  warn=${warned}`);
  return lines.join("\n");
}

interface CliOptions {
  source: string;
  apply: boolean;
  overwrite: boolean;
  vault?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    source: DEFAULT_SOURCE,
    apply: false,
    overwrite: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") opts.source = argv[++i] ?? "";
    else if (a === "--apply") opts.apply = true;
    else if (a === "--overwrite") opts.overwrite = true;
    else if (a === "--vault") opts.vault = argv[++i];
    else if (a === "-h" || a === "--help") opts.help = true;
  }
  return opts;
}

function printHelp(): void {
  console.log(
    `import-openclaw-credentials — one-shot migration script (Phase 9.1.7)

USAGE
  bun scripts/import-openclaw-credentials.ts [--source DIR] [--apply] [--overwrite] [--vault PATH]

OPTIONS
  --source DIR    Source credentials directory (default: ${DEFAULT_SOURCE})
  --apply         Actually write to the vault (default: dry-run)
  --overwrite     Overwrite existing vault keys (default: skip conflicts)
  --vault PATH    Override vault path (default: from switchroom config)
  -h, --help      Show this help

The script is dry-run by default. Review the plan, then re-run with --apply.
Requires SWITCHROOM_VAULT_PASSPHRASE in the environment when --apply is set.`
  );
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return 0;
  }

  const sourceDir = resolve(opts.source);
  if (!existsSync(sourceDir)) {
    console.error(`error: source directory does not exist: ${sourceDir}`);
    return 1;
  }

  console.log(`source: ${sourceDir}`);
  const plan = planImport(sourceDir);
  console.log("");
  console.log(formatPlan(plan));
  console.log("");

  if (!opts.apply) {
    console.log("dry-run: no changes written. Re-run with --apply to commit.");
    return 0;
  }

  const passphrase = process.env.SWITCHROOM_VAULT_PASSPHRASE;
  if (!passphrase) {
    console.error(
      "error: SWITCHROOM_VAULT_PASSPHRASE must be set when using --apply"
    );
    return 2;
  }

  let vaultPath: string;
  if (opts.vault) {
    vaultPath = resolve(opts.vault);
  } else {
    try {
      const config = loadConfig();
      vaultPath = resolvePath(config.vault?.path ?? "~/.switchroom/vault.enc");
    } catch {
      vaultPath = resolvePath("~/.switchroom/vault.enc");
    }
  }

  console.log(`vault:  ${vaultPath}`);
  console.log(`overwrite: ${opts.overwrite}`);
  console.log("");

  try {
    const result = applyPlan(plan, vaultPath, passphrase, {
      overwrite: opts.overwrite,
    });
    console.log(`wrote ${result.written.length} secret(s):`);
    for (const line of result.written) console.log(`  + ${line}`);
    if (result.conflicts.length > 0) {
      console.log("");
      console.log(
        `${result.conflicts.length} conflict(s) (re-run with --overwrite to replace):`
      );
      for (const line of result.conflicts) console.log(`  ! ${line}`);
    }
    if (result.warned.length > 0) {
      console.log("");
      console.log(`${result.warned.length} warning(s):`);
      for (const line of result.warned) console.log(`  ? ${line}`);
    }
    return result.conflicts.length > 0 ? 3 : 0;
  } catch (err) {
    if (err instanceof VaultError) {
      console.error(`vault error: ${err.message}`);
      return 2;
    }
    throw err;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const selfPath = fileURLToPath(import.meta.url);
if (invokedPath === selfPath) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}
