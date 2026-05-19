/**
 * doctor-inlined-secrets — WS6-F3 (MEDIUM), audit #1390 / epic #1389.
 *
 * `src/agents/compose.ts` bind-mounts the FULL `switchroom.yaml`
 * read-only into every agent container. Any agent — including a
 * prompt-injected one — can therefore read the entire fleet config,
 * and crucially any operator-inlined *plaintext* secret (the schema
 * permits literal `bot_token` / `google_client_secret` / …; this has
 * been observed inlined in a real install). That's a direct
 * cross-agent secret read.
 *
 * This is the **proportionate Part 1** remediation: a detection-only
 * doctor probe that flags secret-shaped keys carrying a literal value
 * (not a `vault:` reference) and tells the operator to move them into
 * the per-agent-ACL'd vault. It NEVER rewrites the file and NEVER
 * echoes a secret value. Part 2 — emitting a per-agent reduced config
 * instead of the whole file — is a tracked design-led follow-up
 * (see #1421), not a quick patch.
 *
 * DI seam mirrors doctor-drive.ts: tests inject a fake reader; prod
 * uses real syscalls.
 */

import { readFileSync as fsReadFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

import type { SwitchroomConfig } from "../config/schema.js";

import type { CheckStatus } from "./doctor-status.js";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

export interface InlinedSecretDeps {
  /** Absolute path to the switchroom.yaml the operator runs from. */
  configPath?: string;
  /** Reads the raw YAML text. Defaults to fs.readFileSync. */
  readFileSync?: (p: string) => string;
}

/**
 * Secret-shaped key matcher. Deliberately tight — operator-facing
 * doctor output that cries wolf erodes trust (the consistency /
 * defaults principle). Matches the exact names the schema permits as
 * inlinable secrets plus the conventional `*_secret` / `*_token`
 * suffixes; intentionally NOT bare `*_key` (too many benign hits like
 * `topic_*`, `*_key` config knobs).
 */
const SECRET_KEY_EXACT = new Set([
  "bot_token",
  "client_secret",
  "google_client_secret",
  "password",
  "passphrase",
  "api_key",
  "secret_key",
  "private_key",
  "anthropic_api_key",
  "openai_api_key",
]);

function isSecretShapedKey(key: string): boolean {
  const k = key.toLowerCase();
  if (SECRET_KEY_EXACT.has(k)) return true;
  return k.endsWith("_secret") || k.endsWith("_token") || k.endsWith("_apikey");
}

/** A scalar is "safe" only when it's a `vault:` reference. Empty /
 *  whitespace / obvious placeholder comments are treated as not-a-leak
 *  so we don't nag on a fresh scaffold. */
function isInlinedLiteralSecret(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length === 0) return false;
  if (v.startsWith("vault:")) return false; // the sanctioned form
  // Common "unset" sentinels a setup wizard / example leaves behind.
  if (/^(changeme|xxx+|<.*>|your[-_ ]?.*|todo)$/i.test(v)) return false;
  return true;
}

/** Recursively collect dotted paths of secret-shaped keys whose value
 *  is an inlined literal. Never collects the value itself. */
function walk(
  node: unknown,
  path: string,
  out: string[],
): void {
  if (Array.isArray(node)) {
    node.forEach((el, i) => walk(el, `${path}[${i}]`, out));
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path.length > 0 ? `${path}.${k}` : k;
      if (isSecretShapedKey(k) && isInlinedLiteralSecret(v)) {
        out.push(childPath);
      } else {
        walk(v, childPath, out);
      }
    }
  }
}

/**
 * @param config the loaded config (unused for the scan itself — we
 *   read the RAW file because that exact file is what compose
 *   bind-mounts; but accepted for signature symmetry with the other
 *   doctor modules and future per-agent scoping).
 */
export function runInlinedSecretChecks(
  _config: SwitchroomConfig,
  deps: InlinedSecretDeps = {},
): CheckResult[] {
  const configPath = deps.configPath;
  if (!configPath) return []; // no file to scan (e.g. synthetic config)
  const read = deps.readFileSync ?? ((p: string) => fsReadFileSync(p, "utf8"));

  let raw: string;
  try {
    raw = read(configPath);
  } catch {
    return []; // unreadable here ≠ a finding; other checks cover that
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return [
      {
        name: "switchroom.yaml parses",
        status: "warn",
        detail: "could not parse switchroom.yaml to scan for inlined secrets",
      },
    ];
  }

  const hits: string[] = [];
  walk(parsed, "", hits);

  if (hits.length === 0) {
    return [
      {
        name: "No inlined plaintext secrets in switchroom.yaml",
        status: "ok",
        detail:
          "the full switchroom.yaml is bind-mounted read-only into every agent (WS6-F3) — no secret-shaped keys carry a literal value",
      },
    ];
  }

  return hits.map((p) => ({
    name: `Inlined secret in switchroom.yaml: ${p}`,
    status: "warn" as const,
    detail:
      `\`${p}\` is a literal value, not a \`vault:\` reference. The entire ` +
      `switchroom.yaml is bind-mounted read-only into EVERY agent ` +
      `container, so a prompt-injected agent can read this secret and ` +
      `every other agent's secrets (WS6-F3, #1421).`,
    fix:
      `Move it to the per-agent-ACL'd vault: \`switchroom vault set <name>\` ` +
      `then replace the literal with \`vault:<name>\`. Rotate the exposed ` +
      `value if any agent may already have read it.`,
  }));
}
