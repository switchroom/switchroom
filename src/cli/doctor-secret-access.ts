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
import { userInfo, homedir } from "node:os";
import { join } from "node:path";

import { resolveStatePath } from "../config/paths.js";
import { resolveAgentConfig } from "../config/merge.js";
import { openVault, type VaultEntry } from "../vault/vault.js";
import { checkAclByAgent, checkEntryScope } from "../vault/broker/acl.js";
import { rpcRaw } from "../vault/broker/client.js";
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
  /**
   * Operator-socket preflight RPC. Default: `rpcRaw(preflight_access)`
   * over `~/.switchroom/broker-operator/sock`. Lets default `doctor`
   * (no SWITCHROOM_VAULT_PASSPHRASE) verify cron-secret existence+ACL
   * via the broker's already-unlocked vault. Injectable for tests.
   */
  preflight?: (agent: string, keys: string[]) => Promise<PreflightOutcome>;
  /** Override the broker operator socket path (tests). */
  brokerOperatorSocket?: string;
}

export interface PreflightKeyResult {
  key: string;
  exists: boolean;
  acl_ok: boolean;
  acl_reason?: string;
  scope_ok: boolean;
  scope_reason?: string;
}

export type PreflightOutcome =
  | { kind: "ok"; results: PreflightKeyResult[] }
  | { kind: "locked" }
  | { kind: "unreachable"; msg: string };

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

/** Per-agent declared secret needs: cron `schedule[].secrets[]`
 *  (broker-served → checkAclByAgent gates) + every `vault:` config
 *  ref (resolved operator-side; scope still applies). */
function collectNeeds(resolved: unknown): {
  needed: Set<string>;
  cronKeys: Set<string>;
} {
  const cronKeys = new Set<string>();
  for (const entry of (resolved as { schedule?: Array<{ secrets?: string[] }> })
    .schedule ?? []) {
    for (const s of entry.secrets ?? []) cronKeys.add(s);
  }
  const refKeys = new Set<string>();
  collectVaultRefs(resolved, refKeys);
  return { needed: new Set<string>([...cronKeys, ...refKeys]), cronKeys };
}

/**
 * The ONE per-key gap rule, shared by the local-passphrase and the
 * broker paths so they produce byte-identical verdicts. Returns a gap
 * string or null. `google:` slots are auth-broker slots — existence
 * is governed by google_accounts, not the vault blob, so skip the
 * existence check for them. Cron keys get the static ACL check; the
 * "no *static* ACL" wording is deliberate — a runtime capability/
 * token grant the static check can't see may still cover it (do not
 * regress this caveat).
 */
function keyGap(
  key: string,
  isCron: boolean,
  exists: boolean,
  acl: { allow: boolean; reason?: string },
  scope: { allow: boolean; reason?: string },
): string | null {
  const isGoogleSlot = key.startsWith("google:");
  if (!isGoogleSlot && !exists) return `'${key}' missing from the vault`;
  if (isCron && !acl.allow) {
    return `'${key}' (cron) — no static ACL grants read (${acl.reason})`;
  }
  if (!scope.allow) {
    return `'${key}' — per-key scope denies read (${scope.reason})`;
  }
  return null;
}

/** Default preflight: one operator-socket RPC per agent. No
 *  passphrase needed — the broker answers from its unlocked vault.
 *  Exported so the Drive doctor reuses the exact RPC + LOCKED/
 *  unreachable mapping (one source → byte-identical verdicts). */
export async function defaultPreflight(
  socketPath: string,
  agent: string,
  keys: string[],
): Promise<PreflightOutcome> {
  const r = await rpcRaw(
    { v: 1, op: "preflight_access", agent, keys },
    { socket: socketPath, timeoutMs: 5000 },
  );
  if (r.kind === "unreachable") return { kind: "unreachable", msg: r.msg };
  const resp = r.resp;
  if (resp.ok === true && (resp as { op?: string }).op === "preflight_access") {
    return {
      kind: "ok",
      results: (resp as unknown as { results: PreflightKeyResult[] }).results,
    };
  }
  if (resp.ok === false && resp.code === "LOCKED") return { kind: "locked" };
  return {
    kind: "unreachable",
    msg:
      resp.ok === false
        ? `broker error ${resp.code}: ${resp.msg}`
        : "unexpected broker response",
  };
}

export async function runSecretAccessChecks(
  config: SwitchroomConfig,
  deps: SecretAccessDeps = {},
): Promise<CheckResult[]> {
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
  const pushAgentResult = (
    name: string,
    total: number,
    gaps: string[],
  ): void => {
    results.push(
      gaps.length === 0
        ? {
            name: `secret access: ${name}`,
            status: "ok",
            detail: `${total} secret(s): all present + ACL ok`,
          }
        : {
            name: `secret access: ${name}`,
            status: "fail",
            detail: `${gaps.length}/${total} unreachable — ${gaps.join("; ")}`,
            fix:
              "`switchroom vault set <key>` for missing keys; " +
              "`switchroom vault set <key> --allow " +
              name +
              "` to grant this agent read access",
          },
    );
  };

  const passphrase = deps.passphrase ?? process.env.SWITCHROOM_VAULT_PASSPHRASE;
  if (!passphrase) {
    // Default path — NO passphrase. Ask the vault-broker (which holds
    // the vault unlocked in memory) over its operator socket, using
    // the broker's OWN enforcement predicates. Turns the old
    // passphrase-gated `skip` into a real verified verdict.
    const sock =
      deps.brokerOperatorSocket ??
      join(homedir(), ".switchroom", "broker-operator", "sock");
    const preflight =
      deps.preflight ?? ((a: string, k: string[]) => defaultPreflight(sock, a, k));
    for (const name of Object.keys(config.agents ?? {})) {
      const resolved = resolveAgentConfig(
        config.defaults,
        config.profiles,
        config.agents[name],
      );
      const { needed, cronKeys } = collectNeeds(resolved);
      if (needed.size === 0) {
        results.push({
          name: `secret access: ${name}`,
          status: "ok",
          detail: "no declared vault secrets",
        });
        continue;
      }
      const out = await preflight(name, [...needed].sort());
      if (out.kind === "unreachable" || out.kind === "locked") {
        // Global condition (one broker) → a single honest skip, stop.
        // Mirrors the historical single-skip shape; never a false fail.
        results.push({
          name: "agent secret access",
          status: "skip",
          detail:
            out.kind === "locked"
              ? "vault-broker is locked — cron-secret existence/ACL unverified (re-run after it unlocks; it auto-unlocks on boot)"
              : `vault-broker operator socket unreachable (${out.msg}) and SWITCHROOM_VAULT_PASSPHRASE unset — cron-secret existence/ACL unverified`,
          fix: "Ensure the broker operator socket (~/.switchroom/broker-operator/sock) is bound, or export SWITCHROOM_VAULT_PASSPHRASE and re-run `switchroom doctor`",
        });
        return results;
      }
      const byKey = new Map(out.results.map((r) => [r.key, r]));
      const gaps: string[] = [];
      for (const key of [...needed].sort()) {
        const r = byKey.get(key);
        if (r === undefined) {
          gaps.push(`'${key}' — broker returned no result`);
          continue;
        }
        const g = keyGap(
          key,
          cronKeys.has(key),
          r.exists,
          { allow: r.acl_ok, reason: r.acl_reason },
          { allow: r.scope_ok, reason: r.scope_reason },
        );
        if (g) gaps.push(g);
      }
      pushAgentResult(name, needed.size, gaps);
    }
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

  // Passphrase IS set → local path (operator decrypts the vault
  // themselves). Behaviour-identical to before; shares the SAME
  // collectNeeds + keyGap rule as the broker path so the two can't
  // drift. (Provenance: cron `schedule[].secrets[]` are broker-served
  // → checkAclByAgent gates; plain `vault:` config refs are resolved
  // operator-side and only the per-key scope applies — keyGap encodes
  // exactly this.)
  for (const name of Object.keys(config.agents ?? {})) {
    const resolved = resolveAgentConfig(
      config.defaults,
      config.profiles,
      config.agents[name],
    );
    const { needed, cronKeys } = collectNeeds(resolved);
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
      const g = keyGap(
        key,
        cronKeys.has(key),
        key in entries,
        checkAclByAgent(config, name, key),
        checkEntryScope(entries[key]?.scope, name),
      );
      if (g) gaps.push(g);
    }
    pushAgentResult(name, needed.size, gaps);
  }

  return results;
}
