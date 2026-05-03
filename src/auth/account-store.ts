/**
 * Global Anthropic-account credential store.
 *
 * The account is the unit of authentication (one Anthropic Pro/Max
 * subscription = one account here). Agents are consumers that point at
 * accounts via `agents.<name>.auth.accounts` in switchroom.yaml.
 *
 * Storage layout:
 *
 *   ~/.switchroom/accounts/
 *     <label>/
 *       credentials.json   ← canonical OAuth state for this account
 *       meta.json          ← refresh state, quota state, identity
 *
 * `credentials.json` is the same shape as Claude Code's own
 * `~/.claude/.credentials.json` so that an agent's per-agent mirror
 * (kept in sync by switchroom-auth-broker) is bit-identical to what
 * Claude Code expects.
 *
 * The only writer to these files is `switchroom-auth-broker`, except
 * during the initial `switchroom auth account add` flow which writes the
 * seed credentials. Per-agent mirrors live at `<agentDir>/.claude/
 * .credentials.json` and are also broker-owned (see scaffold.ts).
 *
 * This module is a passive storage layer: validation, paths, atomic
 * read/write. The lifecycle (refresh, fanout, fallback) lives in
 * `src/auth/broker/` and `src/auth/refresh.ts`.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const LABEL_MAX = 64;
const LABEL_RE = /^[A-Za-z0-9._-]+$/;

/** Subset of Claude Code's credentials.json shape we read + rewrite. */
export interface AccountCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    /** Unix ms */
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

/** Per-account state owned by the broker (refresh, quota, identity hint). */
export interface AccountMeta {
  /** Unix ms when the account was first added. */
  createdAt: number;
  /** Optional human label for display ("ken@example.com"); inferred when known. */
  email?: string;
  /** Subscription identifier from Anthropic ("pro" / "max"); cached from credentials. */
  subscriptionType?: string;
  /** Unix ms — when set and in the future, the account is quota-exhausted. */
  quotaExhaustedUntil?: number;
  /** Free-form note about the last quota event. */
  quotaReason?: string;
  /** Unix ms of the last successful refresh tick. */
  lastRefreshedAt?: number;
}

/** Health derived from credentials + meta. */
export type AccountHealth =
  | "healthy"
  | "quota-exhausted"
  | "expired"
  | "missing-credentials"
  | "missing-refresh-token";

export interface AccountInfo {
  label: string;
  health: AccountHealth;
  /** Unix ms — token expiry (from credentials). */
  expiresAt?: number;
  /** Unix ms — quota reset (from meta). */
  quotaExhaustedUntil?: number;
  /** Unix ms — last refresh (from meta). */
  lastRefreshedAt?: number;
  email?: string;
  subscriptionType?: string;
}

/* ── Paths ───────────────────────────────────────────────────────────── */

/** `~/.switchroom/accounts/`. */
export function accountsRoot(home: string = homedir()): string {
  return resolve(home, ".switchroom", "accounts");
}

export function accountDir(label: string, home: string = homedir()): string {
  return join(accountsRoot(home), label);
}

export function accountCredentialsPath(
  label: string,
  home: string = homedir(),
): string {
  return join(accountDir(label, home), "credentials.json");
}

export function accountMetaPath(
  label: string,
  home: string = homedir(),
): string {
  return join(accountDir(label, home), "meta.json");
}

/* ── Label validation ────────────────────────────────────────────────── */

export function validateAccountLabel(label: string): void {
  if (typeof label !== "string" || label.length === 0) {
    throw new Error("Account label cannot be empty");
  }
  if (label.length > LABEL_MAX) {
    throw new Error(`Account label too long (max ${LABEL_MAX} chars)`);
  }
  if (label === "." || label === "..") {
    throw new Error(`Account label "${label}" is reserved`);
  }
  if (label.includes("/") || label.includes("\\")) {
    throw new Error("Account label cannot contain path separators");
  }
  if (!LABEL_RE.test(label)) {
    throw new Error(
      "Account label must match [A-Za-z0-9._-]+ (letters, digits, dot, underscore, dash)",
    );
  }
}

/* ── Listing ─────────────────────────────────────────────────────────── */

export function listAccounts(home: string = homedir()): string[] {
  const root = accountsRoot(home);
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root)
      .filter((name) => {
        try {
          return statSync(join(root, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

export function accountExists(
  label: string,
  home: string = homedir(),
): boolean {
  return existsSync(accountCredentialsPath(label, home));
}

/* ── Credentials read/write ──────────────────────────────────────────── */

export function readAccountCredentials(
  label: string,
  home: string = homedir(),
): AccountCredentials | null {
  const p = accountCredentialsPath(label, home);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as AccountCredentials;
  } catch {
    return null;
  }
}

export function writeAccountCredentials(
  label: string,
  value: AccountCredentials,
  home: string = homedir(),
): void {
  validateAccountLabel(label);
  mkdirSync(accountDir(label, home), { recursive: true });
  atomicWriteJson(accountCredentialsPath(label, home), value);
}

/* ── Meta read/write ─────────────────────────────────────────────────── */

export function readAccountMeta(
  label: string,
  home: string = homedir(),
): AccountMeta | null {
  const p = accountMetaPath(label, home);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as AccountMeta;
  } catch {
    return null;
  }
}

export function writeAccountMeta(
  label: string,
  value: AccountMeta,
  home: string = homedir(),
): void {
  validateAccountLabel(label);
  mkdirSync(accountDir(label, home), { recursive: true });
  atomicWriteJson(accountMetaPath(label, home), value);
}

/** Update a single meta field, preserving the rest. Creates if absent. */
export function patchAccountMeta(
  label: string,
  patch: Partial<AccountMeta>,
  home: string = homedir(),
): AccountMeta {
  const existing = readAccountMeta(label, home) ?? { createdAt: Date.now() };
  const merged: AccountMeta = { ...existing, ...patch };
  writeAccountMeta(label, merged, home);
  return merged;
}

/* ── Health ──────────────────────────────────────────────────────────── */

export function accountHealth(
  label: string,
  now: number = Date.now(),
  home: string = homedir(),
): AccountHealth {
  const creds = readAccountCredentials(label, home);
  if (!creds?.claudeAiOauth?.accessToken) return "missing-credentials";
  const meta = readAccountMeta(label, home);
  if (
    meta?.quotaExhaustedUntil != null &&
    meta.quotaExhaustedUntil > now
  ) {
    return "quota-exhausted";
  }
  const expiresAt = creds.claudeAiOauth.expiresAt;
  if (typeof expiresAt === "number" && expiresAt <= now) {
    if (!creds.claudeAiOauth.refreshToken) return "missing-refresh-token";
    return "expired";
  }
  return "healthy";
}

export function getAccountInfos(
  now: number = Date.now(),
  home: string = homedir(),
): AccountInfo[] {
  return listAccounts(home).map((label) => {
    const creds = readAccountCredentials(label, home);
    const meta = readAccountMeta(label, home);
    return {
      label,
      health: accountHealth(label, now, home),
      expiresAt: creds?.claudeAiOauth?.expiresAt,
      quotaExhaustedUntil: meta?.quotaExhaustedUntil,
      lastRefreshedAt: meta?.lastRefreshedAt,
      email: meta?.email,
      subscriptionType:
        meta?.subscriptionType ?? creds?.claudeAiOauth?.subscriptionType,
    };
  });
}

/* ── Removal ─────────────────────────────────────────────────────────── */

/** Remove an account. The caller is responsible for refusing when agents are still enabled. */
export function removeAccount(label: string, home: string = homedir()): void {
  validateAccountLabel(label);
  if (!accountExists(label, home)) {
    throw new Error(`Account "${label}" does not exist`);
  }
  rmSync(accountDir(label, home), { recursive: true, force: true });
}

/* ── Atomic write helper ─────────────────────────────────────────────── */

/**
 * Write a JSON value atomically: tempfile in the same directory + rename.
 * Same-directory rename keeps it on a single filesystem (rename(2) is
 * only atomic intra-fs). Cleans the tempfile on failure so a crash
 * mid-write doesn't leave a sibling turd.
 */
function atomicWriteJson(destPath: string, value: unknown, mode = 0o600): void {
  const tmp = `${destPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode });
    renameSync(tmp, destPath);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* already gone */
    }
    throw err;
  }
}
