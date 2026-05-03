/**
 * Account-level OAuth refresh + fanout to enabled agents.
 *
 * The account is the unit of authentication; this module is the loop
 * that keeps each account's credentials fresh and pushes the result to
 * every agent that has the account in its `auth.accounts` list.
 *
 * Design contract
 * ---------------
 * Pure side-effect function: read disk → conditionally hit Anthropic →
 * atomically rewrite the global account credentials → fan out to enabled
 * agents. Safe to call repeatedly. When nothing needs refreshing it's a
 * no-op (no network, no writes).
 *
 * Atomicity
 * ---------
 * Every write goes through tempfile + rename in the same directory
 * (rename(2) is atomic intra-fs). A crash mid-tick leaves the OLD file
 * intact, never a half-written one.
 *
 * Concurrency
 * -----------
 * No locking between concurrent ticks. A racing tick that picks the
 * same expiring account issues a duplicate POST; the loser's atomic
 * rename clobbers the winner's. Result: one wasted refresh API call,
 * a valid (live) token on disk. Adding a lockfile here would buy
 * defence against a cost we're not paying.
 *
 * Relation to token-refresh.ts
 * ----------------------------
 * `src/auth/token-refresh.ts` refreshes the legacy per-agent
 * `.credentials.json` files. This module refreshes the new
 * `~/.switchroom/accounts/<label>/credentials.json` files and then
 * mirrors them into each enabled agent's `.credentials.json`. Both
 * coexist during the transition; an agent ends up with the same
 * credentials.json shape on disk regardless of which path produced it.
 */

import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { resolveAgentsDir } from "../config/loader.js";
import type { SwitchroomConfig } from "../config/schema.js";
import {
  accountCredentialsPath,
  listAccounts,
  patchAccountMeta,
  readAccountCredentials,
  writeAccountCredentials,
  type AccountCredentials,
} from "./account-store.js";

/**
 * Refresh threshold — refresh when the account's access token has less
 * than this remaining. Mirrors `src/auth/token-refresh.ts` so behaviour
 * is consistent across the legacy + new paths.
 */
export const REFRESH_THRESHOLD_MS = 60 * 60 * 1000;

const DEFAULT_TOKEN_URL =
  process.env.SWITCHROOM_OAUTH_TOKEN_URL ??
  "https://console.anthropic.com/v1/oauth/token";

const DEFAULT_CLIENT_ID =
  process.env.SWITCHROOM_OAUTH_CLIENT_ID ??
  "9d1cd16e-bcb9-40c9-a915-196412f27aa6";

interface AnthropicRefreshResponse {
  access_token?: string;
  refresh_token?: string;
  /** seconds */
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

/** Outcome of a single account's refresh attempt. */
export type AccountRefreshOutcome =
  | { kind: "skipped-no-credentials"; account: string }
  | { kind: "skipped-malformed"; account: string; reason: string }
  | { kind: "skipped-fresh"; account: string; expiresAt: number; remainingMs: number }
  | { kind: "skipped-no-refresh-token"; account: string; expiresAt?: number }
  | { kind: "refreshed"; account: string; oldExpiresAt?: number; newExpiresAt: number }
  | { kind: "failed"; account: string; httpStatus?: number; error: string };

/** Outcome of a single fanout attempt to one agent. */
export type FanoutOutcome =
  | { kind: "fanned-out"; account: string; agent: string }
  | { kind: "fanout-skipped-no-agent-dir"; account: string; agent: string }
  | { kind: "fanout-failed"; account: string; agent: string; error: string };

export interface AccountTickSummary {
  startedAt: number;
  finishedAt: number;
  refreshes: AccountRefreshOutcome[];
  fanouts: FanoutOutcome[];
  counts: {
    refreshed: number;
    skippedFresh: number;
    skippedNoRefreshToken: number;
    failedRefresh: number;
    fannedOut: number;
    failedFanout: number;
  };
}

/** Hook for unit tests to swap the HTTP layer. */
export type Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const defaultFetcher: Fetcher = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
  });
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

export interface AccountRefreshOptions {
  /** Threshold below which we refresh. Default REFRESH_THRESHOLD_MS. */
  thresholdMs?: number;
  now?: () => number;
  tokenUrl?: string;
  clientId?: string;
  fetcher?: Fetcher;
  /** Override homedir() for tests. */
  home?: string;
}

/* ── Atomic write helper (file content, JSON or text) ────────────────── */

function atomicWriteText(destPath: string, value: string, mode = 0o600): void {
  const tmp = `${destPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, value, { mode });
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

/* ── Single-account refresh ──────────────────────────────────────────── */

/**
 * If the account's access token is expiring soon AND a refreshToken is
 * present, exchange it via Anthropic OAuth and atomically persist the
 * new credentials. Returns a structured outcome — never throws on the
 * network failure path.
 */
export async function refreshAccountIfNeeded(
  label: string,
  opts: AccountRefreshOptions = {},
): Promise<AccountRefreshOutcome> {
  const thresholdMs = opts.thresholdMs ?? REFRESH_THRESHOLD_MS;
  const now = opts.now ?? Date.now;
  const tokenUrl = opts.tokenUrl ?? DEFAULT_TOKEN_URL;
  const clientId = opts.clientId ?? DEFAULT_CLIENT_ID;
  const fetcher = opts.fetcher ?? defaultFetcher;
  const home = opts.home;

  const creds = readAccountCredentials(label, home);
  if (!creds) {
    return { kind: "skipped-no-credentials", account: label };
  }
  const oauth = creds.claudeAiOauth;
  if (
    !oauth ||
    typeof oauth.accessToken !== "string" ||
    oauth.accessToken.length === 0
  ) {
    return {
      kind: "skipped-malformed",
      account: label,
      reason: "credentials present but missing claudeAiOauth.accessToken",
    };
  }
  const expiresAt = oauth.expiresAt;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return {
      kind: "skipped-malformed",
      account: label,
      reason: "credentials have invalid expiresAt",
    };
  }

  const remainingMs = expiresAt - now();
  if (remainingMs > thresholdMs) {
    return { kind: "skipped-fresh", account: label, expiresAt, remainingMs };
  }

  if (!oauth.refreshToken || oauth.refreshToken.length === 0) {
    return { kind: "skipped-no-refresh-token", account: label, expiresAt };
  }

  const body = JSON.stringify({
    grant_type: "refresh_token",
    refresh_token: oauth.refreshToken,
    client_id: clientId,
  });

  let res: { ok: boolean; status: number; text: () => Promise<string> };
  try {
    res = await fetcher(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
    });
  } catch (err) {
    return {
      kind: "failed",
      account: label,
      error: `network error: ${(err as Error).message}`,
    };
  }

  if (!res.ok) {
    let bodyText = "";
    try {
      bodyText = (await res.text()).slice(0, 500);
    } catch {
      /* ignore */
    }
    return {
      kind: "failed",
      account: label,
      httpStatus: res.status,
      error: `HTTP ${res.status}${bodyText ? `: ${bodyText}` : ""}`,
    };
  }

  let parsed: AnthropicRefreshResponse;
  try {
    parsed = JSON.parse(await res.text()) as AnthropicRefreshResponse;
  } catch (err) {
    return {
      kind: "failed",
      account: label,
      httpStatus: res.status,
      error: `unparseable response: ${(err as Error).message}`,
    };
  }

  const newAccessToken = parsed.access_token;
  if (typeof newAccessToken !== "string" || newAccessToken.length === 0) {
    return {
      kind: "failed",
      account: label,
      httpStatus: res.status,
      error: "refresh response missing access_token",
    };
  }

  const newExpiresAt =
    typeof parsed.expires_in === "number" && Number.isFinite(parsed.expires_in)
      ? now() + parsed.expires_in * 1000
      : now() + 8 * 60 * 60 * 1000; // sensible default
  const newRefreshToken =
    typeof parsed.refresh_token === "string" && parsed.refresh_token.length > 0
      ? parsed.refresh_token
      : oauth.refreshToken; // some providers don't rotate

  const updated: AccountCredentials = {
    ...creds,
    claudeAiOauth: {
      ...oauth,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresAt: newExpiresAt,
    },
  };
  try {
    writeAccountCredentials(label, updated, home);
  } catch (err) {
    return {
      kind: "failed",
      account: label,
      error: `failed to write credentials.json: ${(err as Error).message}`,
    };
  }
  patchAccountMeta(label, { lastRefreshedAt: now() }, home);

  return {
    kind: "refreshed",
    account: label,
    oldExpiresAt: expiresAt,
    newExpiresAt,
  };
}

/* ── Fanout ──────────────────────────────────────────────────────────── */

/**
 * Copy the account's credentials.json into each agent's `.claude/`
 * directory atomically. Idempotent: writing identical bytes is fine,
 * the point is the agent dir always sees the most recent token.
 *
 * Also writes the legacy `.oauth-token` + `.oauth-token.meta.json`
 * mirrors that the existing `start.sh` reads to inject
 * `CLAUDE_CODE_OAUTH_TOKEN` into the parent claude process. This keeps
 * the parent and its subprocesses on the SAME token even while the old
 * slot-pool code path remains in place — without it, the parent would
 * use the slot's stale env-var token while subprocesses fall back to
 * the account's new credentials.json. The legacy mirror is removed in
 * the follow-up PR that drops the env-var path entirely.
 */
export function fanoutAccountToAgents(
  account: string,
  agents: Array<{ name: string; agentDir: string }>,
  opts: { home?: string } = {},
): FanoutOutcome[] {
  const credsPath = accountCredentialsPath(account, opts.home);
  if (!existsSync(credsPath)) {
    return agents.map((a) => ({
      kind: "fanout-failed",
      account,
      agent: a.name,
      error: `no credentials at ${credsPath}`,
    }));
  }
  const content = readFileSync(credsPath, "utf-8");
  let parsed: { claudeAiOauth?: { accessToken?: string; expiresAt?: number } };
  try {
    parsed = JSON.parse(content);
  } catch {
    return agents.map((a) => ({
      kind: "fanout-failed",
      account,
      agent: a.name,
      error: `account credentials are not valid JSON`,
    }));
  }
  const accessToken = parsed.claudeAiOauth?.accessToken;
  const expiresAt = parsed.claudeAiOauth?.expiresAt;

  return agents.map((a): FanoutOutcome => {
    if (!existsSync(a.agentDir)) {
      return {
        kind: "fanout-skipped-no-agent-dir",
        account,
        agent: a.name,
      };
    }
    const claudeDir = join(a.agentDir, ".claude");
    try {
      mkdirSync(claudeDir, { recursive: true });
      atomicWriteText(join(claudeDir, "credentials.json"), content);
      // Mirror to the legacy paths the existing start.sh reads. Skip if
      // accessToken is missing — better to leave the old mirror alone
      // than to clobber it with garbage.
      if (typeof accessToken === "string" && accessToken.length > 0) {
        atomicWriteText(join(claudeDir, ".oauth-token"), accessToken + "\n");
        atomicWriteText(
          join(claudeDir, ".oauth-token.meta.json"),
          JSON.stringify(
            {
              createdAt: Date.now(),
              expiresAt: expiresAt ?? Date.now() + 8 * 60 * 60 * 1000,
              source: `account:${account}`,
            },
            null,
            2,
          ) + "\n",
        );
      }
      return { kind: "fanned-out", account, agent: a.name };
    } catch (err) {
      return {
        kind: "fanout-failed",
        account,
        agent: a.name,
        error: (err as Error).message,
      };
    }
  });
}

/* ── Whole-tick: refresh every account, fan out to enabled agents ────── */

/**
 * Build the per-account agent list from a loaded config: an account's
 * "enabled agents" are those whose `auth.accounts` list contains the
 * account label.
 */
export function enabledAgentsForAccount(
  account: string,
  config: SwitchroomConfig,
  agentsDir: string,
): Array<{ name: string; agentDir: string }> {
  const out: Array<{ name: string; agentDir: string }> = [];
  for (const [name, agent] of Object.entries(config.agents)) {
    const accounts = agent.auth?.accounts ?? [];
    if (accounts.includes(account)) {
      out.push({ name, agentDir: resolve(agentsDir, name) });
    }
  }
  return out;
}

export async function refreshAllAccounts(
  config: SwitchroomConfig,
  opts: AccountRefreshOptions = {},
): Promise<AccountTickSummary> {
  const startedAt = Date.now();
  const home = opts.home;
  const agentsDir = resolveAgentsDir(config);

  const refreshes: AccountRefreshOutcome[] = [];
  const fanouts: FanoutOutcome[] = [];

  for (const label of listAccounts(home)) {
    let outcome: AccountRefreshOutcome;
    try {
      outcome = await refreshAccountIfNeeded(label, opts);
    } catch (err) {
      outcome = {
        kind: "failed",
        account: label,
        error: `unexpected exception: ${(err as Error).message}`,
      };
    }
    refreshes.push(outcome);

    // Fanout always runs (even if refresh was skipped-fresh) so a newly
    // enabled agent picks up an existing fresh credential without waiting
    // for the next actual refresh.
    const targets = enabledAgentsForAccount(label, config, agentsDir);
    fanouts.push(...fanoutAccountToAgents(label, targets, { home }));
  }

  const counts = {
    refreshed: refreshes.filter((o) => o.kind === "refreshed").length,
    skippedFresh: refreshes.filter((o) => o.kind === "skipped-fresh").length,
    skippedNoRefreshToken: refreshes.filter(
      (o) => o.kind === "skipped-no-refresh-token",
    ).length,
    failedRefresh: refreshes.filter((o) => o.kind === "failed").length,
    fannedOut: fanouts.filter((o) => o.kind === "fanned-out").length,
    failedFanout: fanouts.filter((o) => o.kind === "fanout-failed").length,
  };

  return {
    startedAt,
    finishedAt: Date.now(),
    refreshes,
    fanouts,
    counts,
  };
}
