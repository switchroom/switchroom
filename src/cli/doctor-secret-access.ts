/**
 * Vault access doctor checks (#1473).
 *
 * Two gaps that were invisible until something failed at runtime:
 *
 *  A. **Operator lockout.** A root-mode write (sudo apply / hostd /
 *     broker fanout) can leave `vault.enc` owned `root:root` 0600. The
 *     broker keeps working (it reads via CAP_DAC_READ_SEARCH), so
 *     cron/agents look fine — but every operator `switchroom vault …`
 *     fails. Probe the file AS THE OPERATOR and FAIL with the chown
 *     fix.
 *
 *  B. **Agent secret access.** For every agent, the secrets it needs —
 *     cron `schedule[].secrets[]` and `vault:` refs anywhere in its
 *     resolved config — must (1) exist in the vault and (2) be readable
 *     by that agent under the broker ACL. We reuse the broker's own
 *     predicates (`checkAclByAgent` + `checkEntryScope`) so the doctor
 *     verdict matches what the broker will actually do at runtime.
 *
 * Scope (v1): cron secrets + `vault:` refs. Skill secret needs are
 * documentation-only (no machine-readable manifest) so they're covered
 * transitively wherever a skill surfaces a `vault:` ref in env/mcp;
 * a skill that reads a key purely at runtime is out of scope. Ephemeral
 * capability grants are invisible to a static check — ACL failures are
 * worded "no *static* ACL" to avoid false alarms.
 *
 * All IO is dependency-injected so tests drive every branch without a
 * real vault or containers.
 */

import {
  accessSync,
  constants as fsConstants,
  existsSync,
  realpathSync,
  statSync,
} from "node:fs";
import { userInfo } from "node:os";

import { resolveStatePath } from "../config/paths.js";
import { resolveAgentConfig } from "../config/merge.js";
import { openVault, type VaultEntry } from "../vault/vault.js";
import { checkAclByAgent, checkEntryScope } from "../vault/broker/acl.js";
import type { SwitchroomConfig } from "../config/schema.js";

import type { CheckStatus } from "./doctor-status.js";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

/** Result of probing the vault file as the current (operator) user. */
export interface VaultFileStat {
  exists: boolean;
  readable: boolean;
  uid: number;
  mode: number;
  realPath: string;
}

export interface SecretAccessDeps {
  /** Override the resolved vault path. */
  vaultPath?: string;
  /** Override the passphrase (defaults to SWITCHROOM_VAULT_PASSPHRASE). */
  passphrase?: string;
  /** Probe the vault file as the operator. Default: realpath + stat + access(R_OK). */
  statVault?: (path: string) => VaultFileStat;
  /** Decrypt + load the vault. Default: real `openVault`. */
  openVault?: (passphrase: string, path: string) => Record<string, VaultEntry>;
  /** Current operator uid (default process uid). */
  selfUid?: number;
  /** Current operator username (default os.userInfo().username). */
  selfUser?: string;
}

function resolveVaultPath(config: SwitchroomConfig): string {
  return config.vault?.path
    ? config.vault.path.replace(/^~/, process.env.HOME ?? "")
    : resolveStatePath("vault.enc");
}

function defaultStatVault(path: string): VaultFileStat {
  if (!existsSync(path)) {
    return { exists: false, readable: false, uid: -1, mode: 0, realPath: path };
  }
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    /* broken symlink — fall through with the literal path */
  }
  let uid = -1;
  let mode = 0;
  try {
    const s = statSync(real);
    uid = s.uid;
    mode = s.mode & 0o777;
  } catch {
    return { exists: true, readable: false, uid, mode, realPath: real };
  }
  let readable = false;
  try {
    accessSync(real, fsConstants.R_OK);
    readable = true;
  } catch {
    readable = false;
  }
  return { exists: true, readable, uid, mode, realPath: real };
}

/** Field-agnostic recursive walk for `vault:<key>` references. Mirrors
 *  src/vault/resolver.ts collectVaultRefs (kept local to avoid widening
 *  that module's export surface). Strips the `#filename` selector. */
function collectVaultRefs(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (value.startsWith("vault:")) {
      const key = value.slice("vault:".length).split("#")[0]!.trim();
      if (key) out.add(key);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectVaultRefs(v, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectVaultRefs(v, out);
    }
  }
}

export function runSecretAccessChecks(
  config: SwitchroomConfig,
  deps: SecretAccessDeps = {},
): CheckResult[] {
  const results: CheckResult[] = [];
  const vaultPath = deps.vaultPath ?? resolveVaultPath(config);
  const statVault = deps.statVault ?? defaultStatVault;
  const selfUid = deps.selfUid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  let selfUser = deps.selfUser;
  if (selfUser === undefined) {
    try {
      selfUser = userInfo().username;
    } catch {
      selfUser = "<you>";
    }
  }

  // ---- Check A: operator can read the vault file --------------------
  const vf = statVault(vaultPath);
  if (!vf.exists) {
    results.push({
      name: "vault: operator readable",
      status: "ok",
      detail: `vault file not present at ${vaultPath} — see the Vault section`,
    });
  } else if (!vf.readable) {
    results.push({
      name: "vault: operator readable",
      status: "fail",
      detail:
        `${vf.realPath} is owned by uid ${vf.uid} (mode 0${vf.mode.toString(8)}) — ` +
        `the operator (uid ${selfUid} ${selfUser}) cannot read it, so every ` +
        `\`switchroom vault …\` fails. The broker still works (CAP_DAC_READ_SEARCH), ` +
        `which masks this until you touch the vault directly.`,
      fix: `sudo chown ${selfUser}:${selfUser} ${vf.realPath}`,
    });
  } else {
    results.push({
      name: "vault: operator readable",
      status: "ok",
      detail: `operator can read ${vf.realPath}`,
    });
  }

  // ---- Check B: per-agent secret existence + ACL --------------------
  const passphrase = deps.passphrase ?? process.env.SWITCHROOM_VAULT_PASSPHRASE;
  if (!passphrase) {
    results.push({
      name: "agent secret access",
      status: "skip",
      detail:
        "SWITCHROOM_VAULT_PASSPHRASE not set — cannot enumerate vault keys/ACLs " +
        "to verify per-agent secret access",
      fix: "Export SWITCHROOM_VAULT_PASSPHRASE and re-run `switchroom doctor`",
    });
    return results;
  }

  let entries: Record<string, VaultEntry>;
  try {
    entries = (deps.openVault ?? openVault)(passphrase, vaultPath);
  } catch (err) {
    results.push({
      name: "agent secret access",
      status: vf.readable ? "fail" : "warn",
      detail: `cannot open the vault: ${(err as Error).message}`,
      fix: vf.readable
        ? "SWITCHROOM_VAULT_PASSPHRASE may be wrong, or the vault is corrupt"
        : "fix the vault file ownership above first (operator cannot read it)",
    });
    return results;
  }

  const agents = Object.keys(config.agents ?? {});
  for (const name of agents) {
    const resolved = resolveAgentConfig(
      config.defaults,
      config.profiles,
      config.agents[name],
    );

    // Provenance matters. Cron `schedule[].secrets[]` are served at
    // runtime BY THE BROKER, so the broker's cron allowlist
    // (checkAclByAgent) AND the per-key scope (checkEntryScope) both
    // gate them. Plain `vault:` config refs (bot_token, env, mcp, …)
    // are resolved operator-side at scaffold time via openVault — they
    // do NOT pass through checkAclByAgent (applying it here would
    // falsely FAIL the canonical `bot_token: "vault:…"` config on any
    // agent without a cron schedule). Per-key scope still applies to
    // them wherever the broker serves them.
    const cronKeys = new Set<string>();
    for (const entry of (resolved as { schedule?: Array<{ secrets?: string[] }> }).schedule ?? []) {
      for (const s of entry.secrets ?? []) cronKeys.add(s);
    }
    const refKeys = new Set<string>();
    collectVaultRefs(resolved, refKeys);
    const needed = new Set<string>([...cronKeys, ...refKeys]);

    if (needed.size === 0) {
      results.push({
        name: `secret access: ${name}`,
        status: "ok",
        detail: "no declared vault secrets",
      });
      continue;
    }

    const gaps: string[] = [];
    for (const key of [...needed].sort()) {
      // google:<acct>:* are auth-broker slots, not literal vault keys —
      // existence is governed by google_accounts, not the vault blob;
      // the ACL predicate already routes them, so check ACL only.
      const isGoogleSlot = key.startsWith("google:");
      if (!isGoogleSlot && !(key in entries)) {
        gaps.push(`'${key}' missing from the vault`);
        continue;
      }
      const byScope = checkEntryScope(entries[key]?.scope, name);
      if (cronKeys.has(key)) {
        // broker-served cron secret → full broker predicate
        const byAgent = checkAclByAgent(config, name, key);
        if (!byAgent.allow) {
          gaps.push(`'${key}' (cron) — no static ACL grants read (${byAgent.reason})`);
          continue;
        }
      }
      if (!byScope.allow) {
        gaps.push(`'${key}' — per-key scope denies read (${byScope.reason})`);
      }
    }

    if (gaps.length === 0) {
      results.push({
        name: `secret access: ${name}`,
        status: "ok",
        detail: `${needed.size} secret(s): all present + ACL ok`,
      });
    } else {
      results.push({
        name: `secret access: ${name}`,
        status: "fail",
        detail: `${gaps.length}/${needed.size} unreachable — ${gaps.join("; ")}`,
        fix:
          "`switchroom vault set <key>` for missing keys; " +
          "`switchroom vault set <key> --allow " +
          name +
          "` to grant this agent read access",
      });
    }
  }

  return results;
}
