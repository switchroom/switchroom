import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SwitchroomConfig } from "../config/schema.js";
import { resolveAgentsDir } from "../config/loader.js";
import {
  getSlotInfos,
  listSlots,
  migrateLegacyIfNeeded,
  pickFallbackSlot,
  readActiveSlot,
  removeSlot,
  suggestSlotName,
  syncLegacyFromActive,
  useSlot,
  validateSlotName,
  writeActiveSlot,
  writeSlotToken,
  type SlotInfo,
} from "./accounts.js";

const TOKEN_VALIDITY_MS = 365 * 24 * 60 * 60_000;

export interface AuthStatus {
  authenticated: boolean;
  subscriptionType?: string;
  expiresAt?: number;
  timeUntilExpiry?: string;
  rateLimitTier?: string;
  source?: "credentials" | "oauth-token";
  pendingAuth?: boolean;
}

interface CredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

interface OAuthTokenMeta {
  createdAt: number;
  expiresAt: number;
  source: "claude-setup-token";
}

interface AuthSessionMeta {
  sessionName: string;
  logPath: string;
  startedAt: number;
  /** Target slot for the pending auth flow (undefined = active/default). */
  slot?: string;
}

export interface AuthSessionResult {
  sessionName: string;
  loginUrl?: string;
  instructions: string[];
}

export interface AuthCodeResult {
  completed: boolean;
  tokenSaved: boolean;
  tokenPath?: string;
  instructions: string[];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[@-_]/g, "")
    .replace(/\r/g, "");
}

function claudeDir(agentDir: string): string {
  return join(agentDir, ".claude");
}

function credentialsPath(agentDir: string): string {
  return join(claudeDir(agentDir), ".credentials.json");
}

function oauthTokenPath(agentDir: string): string {
  return join(claudeDir(agentDir), ".oauth-token");
}

function oauthTokenMetaPath(agentDir: string): string {
  return join(claudeDir(agentDir), ".oauth-token.meta.json");
}

function authLogPath(agentDir: string): string {
  return join(claudeDir(agentDir), ".setup-token.log");
}

function authSessionMetaPath(agentDir: string): string {
  return join(claudeDir(agentDir), ".setup-token.session.json");
}

function authSessionName(name: string, slot?: string): string {
  const base = `switchroom-auth-${name.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
  if (!slot || slot === "default") return base;
  return `${base}-${slot.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
}

function tmux(args: string[]): string {
  return execFileSync("tmux", args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function tmuxSessionExists(sessionName: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", sessionName], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function captureTmuxPane(sessionName: string): string {
  return tmux(["capture-pane", "-p", "-t", sessionName, "-S", "-200"]);
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function readOAuthToken(agentDir: string): string | null {
  const path = oauthTokenPath(agentDir);
  if (!existsSync(path)) return null;
  try {
    const token = readFileSync(path, "utf-8").trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Write the token into the slot-aware storage AND mirror the legacy
 * top-level .oauth-token path so start.sh.hbs / Claude Code keep working.
 *
 * If `slot` is unspecified, writes to the active slot (migrating legacy
 * layout if needed); if no active slot exists, creates "default".
 */
function writeOAuthToken(
  agentDir: string,
  token: string,
  slot?: string,
): string {
  mkdirSync(claudeDir(agentDir), { recursive: true });

  // Ensure accounts/ layout exists (idempotent).
  migrateLegacyIfNeeded(agentDir);

  const targetSlot = slot
    ? (validateSlotName(slot), slot)
    : readActiveSlot(agentDir) ?? "default";

  const now = Date.now();
  const { tokenPath } = writeSlotToken(agentDir, targetSlot, token, {
    expiresAtMs: now + TOKEN_VALIDITY_MS,
    source: "claude-setup-token",
  });

  // If this is the first slot (no active marker yet), make it active.
  if (!readActiveSlot(agentDir)) {
    writeActiveSlot(agentDir, targetSlot);
  }

  // Mirror into legacy path if this slot is the active one.
  if (readActiveSlot(agentDir) === targetSlot) {
    syncLegacyFromActive(agentDir);
  }

  return tokenPath;
}

/**
 * Pick a slot name for a new `auth add` flow. Auto-generates when omitted.
 * Exported so the CLI can echo the chosen name back to the user.
 */
export function resolveSlotForAdd(
  agentDir: string,
  requested: string | undefined,
): string {
  if (requested) {
    validateSlotName(requested);
    return requested;
  }
  return suggestSlotName(agentDir);
}

function writeAuthSessionMeta(agentDir: string, meta: AuthSessionMeta): void {
  mkdirSync(claudeDir(agentDir), { recursive: true });
  writeFileSync(authSessionMetaPath(agentDir), JSON.stringify(meta, null, 2) + "\n", {
    mode: 0o600,
  });
}

function clearAuthSessionMeta(agentDir: string): void {
  rmSync(authSessionMetaPath(agentDir), { force: true });
}

export function formatTimeUntilExpiry(expiresAt: number): string {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return "expired";

  const totalMinutes = Math.floor(remaining / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function parseSetupTokenUrl(output: string): string | null {
  const clean = stripAnsi(output);
  const match = clean.match(
    /https:\/\/claude\.ai\/oauth\/authorize\?[\s\S]*?(?=\n\s*\n|\n\s*Paste code here|$)/,
  );
  if (!match) return null;
  return match[0].replace(/\s+/g, "");
}

export function parseSetupTokenValue(output: string): string | null {
  const clean = stripAnsi(output);
  const match = clean.match(/sk-ant-oat\d+-[A-Za-z0-9._-]+/);
  return match?.[0] ?? null;
}

function hasPendingAuthSession(name: string, agentDir: string): boolean {
  const meta = readJsonFile<AuthSessionMeta>(authSessionMetaPath(agentDir));
  if (meta?.sessionName && tmuxSessionExists(meta.sessionName)) {
    return true;
  }
  return tmuxSessionExists(authSessionName(name));
}

export function getAuthStatus(name: string, agentDir: string): AuthStatus {
  const oauthToken = readOAuthToken(agentDir);
  if (oauthToken) {
    const meta = readJsonFile<OAuthTokenMeta>(oauthTokenMetaPath(agentDir));
    const expiresAt = meta?.expiresAt;
    const isExpired = expiresAt != null && expiresAt <= Date.now();

    return {
      authenticated: !isExpired,
      expiresAt,
      timeUntilExpiry:
        expiresAt != null ? formatTimeUntilExpiry(expiresAt) : undefined,
      source: "oauth-token",
      subscriptionType: "oauth-token",
      pendingAuth: hasPendingAuthSession(name, agentDir),
    };
  }

  const credPath = credentialsPath(agentDir);
  if (!existsSync(credPath)) {
    return { authenticated: false, pendingAuth: hasPendingAuthSession(name, agentDir) };
  }

  let creds: CredentialsFile;
  try {
    creds = JSON.parse(readFileSync(credPath, "utf-8"));
  } catch {
    return { authenticated: false, pendingAuth: hasPendingAuthSession(name, agentDir) };
  }

  const oauth = creds.claudeAiOauth;
  if (!oauth?.accessToken) {
    return { authenticated: false, pendingAuth: hasPendingAuthSession(name, agentDir) };
  }

  const expiresAt = oauth.expiresAt;
  const isExpired = expiresAt != null && expiresAt <= Date.now();

  return {
    authenticated: !isExpired,
    subscriptionType: oauth.subscriptionType,
    expiresAt: oauth.expiresAt,
    timeUntilExpiry:
      expiresAt != null ? formatTimeUntilExpiry(expiresAt) : undefined,
    rateLimitTier: oauth.rateLimitTier,
    source: "credentials",
    pendingAuth: hasPendingAuthSession(name, agentDir),
  };
}

export function getAllAuthStatuses(
  config: SwitchroomConfig,
): Record<string, AuthStatus> {
  const agentsDir = resolveAgentsDir(config);
  const statuses: Record<string, AuthStatus> = {};

  for (const name of Object.keys(config.agents)) {
    const agentDir = resolve(agentsDir, name);
    statuses[name] = getAuthStatus(name, agentDir);
  }

  return statuses;
}

export function startAuthSession(
  name: string,
  agentDir: string,
  opts: { force?: boolean; slot?: string } = {},
): AuthSessionResult {
  const slotArg = opts.slot;
  const status = getAuthStatus(name, agentDir);
  // For an explicit `auth add` into a NEW slot we want to proceed even if the
  // active slot is healthy. Only short-circuit when slot is unspecified (ie the
  // default "operate on active" path) and we're not forcing.
  if (!slotArg && status.authenticated && !opts.force) {
    return {
      sessionName: authSessionName(name),
      instructions: [
        `Agent "${name}" is already authenticated via ${status.source ?? "credentials"}.`,
        `  Subscription: ${status.subscriptionType ?? "unknown"}`,
        `  Expires in: ${status.timeUntilExpiry ?? "unknown"}`,
        `Use 'switchroom auth reauth ${name}' to replace it.`,
      ],
    };
  }

  const sessionName = authSessionName(name, slotArg);
  if (tmuxSessionExists(sessionName)) {
    if (opts.force) {
      tmux(["kill-session", "-t", sessionName]);
      clearAuthSessionMeta(agentDir);
    } else {
      const output = captureTmuxPane(sessionName);
      const loginUrl = parseSetupTokenUrl(output) ?? undefined;
      return {
        sessionName,
        loginUrl,
        instructions: [
          `Auth session already running for agent "${name}".`,
          ...(loginUrl ? [`Open this URL in your browser:`, loginUrl, ""] : []),
          `Then finish with: switchroom auth code ${name} <browser-code>`,
          `Cancel with:      switchroom auth cancel ${name}`,
        ],
      };
    }
  }

  mkdirSync(claudeDir(agentDir), { recursive: true });
  const logPath = authLogPath(agentDir);
  rmSync(logPath, { force: true });

  const command = [
    `mkdir -p ${shellQuote(claudeDir(agentDir))}`,
    `env CLAUDE_CONFIG_DIR=${shellQuote(claudeDir(agentDir))} claude setup-token | tee ${shellQuote(logPath)}`,
  ].join(" && ");

  tmux(["new-session", "-d", "-s", sessionName, "-c", agentDir, `bash -lc ${shellQuote(command)}`]);
  writeAuthSessionMeta(agentDir, {
    sessionName,
    logPath,
    startedAt: Date.now(),
    slot: slotArg,
  });

  sleepMs(8000);
  const output = captureTmuxPane(sessionName);
  const loginUrl = parseSetupTokenUrl(output) ?? undefined;

  return {
    sessionName,
    loginUrl,
    instructions: [
      `Started Claude auth for agent "${name}" in tmux session ${sessionName}.`,
      ...(loginUrl ? [`Open this URL in your browser:`, loginUrl, ""] : [
        `Use 'tmux attach -t ${sessionName}' if you need to inspect the auth prompt.`,
        "",
      ]),
      `After Claude shows you a browser code, finish with:`,
      `  switchroom auth code ${name} <browser-code>`,
      `Cancel with: switchroom auth cancel ${name}`,
    ],
  };
}

/**
 * Back-compat wrapper used by the CLI/tests. Starts the auth flow.
 */
export function loginAgent(
  name: string,
  agentDir: string,
): { instructions: string[] } {
  const result = startAuthSession(name, agentDir, { force: false });
  return { instructions: result.instructions };
}

/**
 * Back-compat wrapper used by the CLI/tests. Starts a forced re-auth flow.
 */
export function refreshAgent(
  name: string,
  agentDir: string,
): { instructions: string[] } {
  const result = startAuthSession(name, agentDir, { force: true });
  return { instructions: result.instructions };
}

export function submitAuthCode(
  name: string,
  agentDir: string,
  code: string,
  slot?: string,
): AuthCodeResult {
  // If slot is omitted, try to read pending session meta to discover it.
  let targetSlot = slot;
  if (!targetSlot) {
    const pending = readJsonFile<AuthSessionMeta>(authSessionMetaPath(agentDir));
    if (pending?.slot) targetSlot = pending.slot;
  }
  const sessionName = authSessionName(name, targetSlot);
  if (!tmuxSessionExists(sessionName)) {
    return {
      completed: false,
      tokenSaved: false,
      instructions: [
        `No pending auth session for agent "${name}".`,
        `Start one with: switchroom auth login ${name}`,
      ],
    };
  }

  tmux(["send-keys", "-t", sessionName, code.trim(), "Enter"]);
  sleepMs(1500);
  const output = captureTmuxPane(sessionName);
  const token = parseSetupTokenValue(output);

  if (!token) {
    return {
      completed: false,
      tokenSaved: false,
      instructions: [
        `Submitted code to Claude for agent "${name}", but no token is visible yet.`,
        `If the code was invalid, Claude will say so in the auth session.`,
        `Inspect with: tmux attach -t ${sessionName}`,
        `Retry with:   switchroom auth code ${name} <browser-code>`,
      ],
    };
  }

  const tokenPath = writeOAuthToken(agentDir, token, targetSlot);
  try {
    tmux(["kill-session", "-t", sessionName]);
  } catch {
    // best effort
  }
  clearAuthSessionMeta(agentDir);

  return {
    completed: true,
    tokenSaved: true,
    tokenPath,
    instructions: [
      `Saved Claude OAuth token for agent "${name}".`,
      `  Token file: ${tokenPath}`,
      `Restart the agent to pick up the new account, or let switchroom do it now.`,
    ],
  };
}

export function cancelAuthSession(
  name: string,
  agentDir: string,
  slot?: string,
): { instructions: string[] } {
  // If slot unspecified, read session meta to find the pending one.
  let targetSlot = slot;
  if (!targetSlot) {
    const pending = readJsonFile<AuthSessionMeta>(authSessionMetaPath(agentDir));
    if (pending?.slot) targetSlot = pending.slot;
  }
  const sessionName = authSessionName(name, targetSlot);
  if (tmuxSessionExists(sessionName)) {
    tmux(["kill-session", "-t", sessionName]);
  }
  clearAuthSessionMeta(agentDir);

  return {
    instructions: [`Cancelled pending auth session for agent "${name}".`],
  };
}

/* ── Multi-account high-level helpers (for CLI use) ──────────────────── */

export function addAccountStart(
  name: string,
  agentDir: string,
  requested?: string,
): AuthSessionResult & { slot: string } {
  // Ensure legacy layout is migrated so the current token becomes "default"
  // before we allocate a new slot name (otherwise "default" would appear free
  // when it actually reflects the legacy token).
  migrateLegacyIfNeeded(agentDir);
  const slot = resolveSlotForAdd(agentDir, requested);
  const result = startAuthSession(name, agentDir, { force: false, slot });
  return { ...result, slot };
}

export function listAccounts(name: string, agentDir: string): SlotInfo[] {
  migrateLegacyIfNeeded(agentDir);
  void name;
  return getSlotInfos(agentDir);
}

export function switchAccount(
  name: string,
  agentDir: string,
  slot: string,
): { slot: string } {
  migrateLegacyIfNeeded(agentDir);
  void name;
  useSlot(agentDir, slot);
  return { slot };
}

export function removeAccount(
  name: string,
  agentDir: string,
  slot: string,
): { slot: string } {
  migrateLegacyIfNeeded(agentDir);
  void name;
  removeSlot(agentDir, slot);
  return { slot };
}

/**
 * Swap to the next healthy (or least-recently-quota-exhausted) slot.
 * Returns the new active slot, or null if no alternative exists.
 */
export function fallbackToNextSlot(
  name: string,
  agentDir: string,
): { newActive: string | null; previous: string | null } {
  migrateLegacyIfNeeded(agentDir);
  void name;
  const previous = readActiveSlot(agentDir);
  const next = pickFallbackSlot(agentDir, previous);
  if (!next) return { newActive: null, previous };
  useSlot(agentDir, next);
  return { newActive: next, previous };
}

export function currentActiveSlot(agentDir: string): string | null {
  return readActiveSlot(agentDir);
}

export function ensureMigrated(agentDir: string): void {
  migrateLegacyIfNeeded(agentDir);
}

export function listSlotNames(agentDir: string): string[] {
  return listSlots(agentDir);
}
