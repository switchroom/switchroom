/**
 * Per-account quota snapshot store.
 *
 * Persists the most-recent rate-limit observation (5h / 7d utilization
 * + reset timestamps) per Anthropic account so that surfaces which
 * can't afford a live API call (e.g. the Telegram boot/health card)
 * can still display per-account quota headroom.
 *
 * Storage path: `~/.switchroom/accounts/<label>/quota.json`. The path
 * sits alongside `credentials.json` and `meta.json` (managed by
 * `account-store.ts`) so the per-account directory remains the single
 * source of truth for everything we know about that account.
 *
 * Schema (small, additive on purpose — readers tolerate missing
 * fields):
 *
 *   {
 *     "capturedAt":     "<ISO-8601 ms-trimmed>",
 *     "fiveHourPct":    <number 0..100>,
 *     "sevenDayPct":    <number 0..100>,
 *     "fiveHourResetAt":  <unix ms | null>,
 *     "sevenDayResetAt":  <unix ms | null>
 *   }
 *
 * Writes are atomic-ish via `writeFileSync` — we don't use the atomic
 * tmp+rename dance from credentials.json because losing this file is
 * harmless: the next probe re-fills it. Mode 0600 mirrors the rest of
 * the account-store files.
 *
 * Closes part of #708.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { accountDir, validateAccountLabel } from "./account-store.js";

export interface AccountQuotaSnapshot {
  /** ISO-8601 (ms-trimmed) timestamp of when the snapshot was captured. */
  capturedAt: string;
  /** 5-hour utilization, 0..100. Null when the rate-limit header was
   *  absent (e.g. an API-key auth response, or a probe failure). */
  fiveHourPct: number | null;
  /** 7-day utilization, 0..100. Null when the header was absent. */
  sevenDayPct: number | null;
  /** Unix ms of the next 5h window reset, or null when unknown. */
  fiveHourResetAt: number | null;
  /** Unix ms of the next 7d window reset, or null when unknown. */
  sevenDayResetAt: number | null;
}

export function accountQuotaPath(label: string, home: string = homedir()): string {
  return join(accountDir(label, home), "quota.json");
}

/**
 * Read the cached quota snapshot for an account. Returns null on:
 *   - file missing
 *   - JSON parse error
 *   - schema mismatch (unexpected field types)
 */
export function readAccountQuota(
  label: string,
  home: string = homedir(),
): AccountQuotaSnapshot | null {
  const path = accountQuotaPath(label, home);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.capturedAt !== "string") return null;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    capturedAt: o.capturedAt,
    fiveHourPct: num(o.fiveHourPct),
    sevenDayPct: num(o.sevenDayPct),
    fiveHourResetAt: num(o.fiveHourResetAt),
    sevenDayResetAt: num(o.sevenDayResetAt),
  };
}

/**
 * Write a fresh snapshot for an account. Best-effort — IO errors are
 * swallowed (this cache is an optimization, not a correctness
 * requirement). Validates the label first so a corrupt caller can't
 * traverse out of `~/.switchroom/accounts/`.
 */
export function writeAccountQuota(
  label: string,
  snap: AccountQuotaSnapshot,
  home: string = homedir(),
): void {
  validateAccountLabel(label);
  const dir = accountDir(label, home);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(accountQuotaPath(label, home), JSON.stringify(snap, null, 2), {
      mode: 0o600,
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Convenience: capture a snapshot from a `QuotaUtilization` shape (the
 * struct returned by `telegram-plugin/quota-check.ts:fetchQuota`).
 *
 * Kept as a tiny adapter rather than importing the telegram-plugin
 * type into src/ — the shape is stable, and inlining the field list
 * here avoids a back-edge from `src/` to `telegram-plugin/`.
 */
export interface QuotaUtilizationLike {
  fiveHourUtilizationPct: number;
  sevenDayUtilizationPct: number;
  fiveHourResetAt: Date | null;
  sevenDayResetAt: Date | null;
}

export function snapshotFromQuotaUtilization(
  q: QuotaUtilizationLike,
  now: Date = new Date(),
): AccountQuotaSnapshot {
  return {
    capturedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    fiveHourPct: q.fiveHourUtilizationPct,
    sevenDayPct: q.sevenDayUtilizationPct,
    fiveHourResetAt: q.fiveHourResetAt ? q.fiveHourResetAt.getTime() : null,
    sevenDayResetAt: q.sevenDayResetAt ? q.sevenDayResetAt.getTime() : null,
  };
}
