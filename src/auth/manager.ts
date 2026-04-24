import { execFileSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  chmodSync,
  statSync,
} from "node:fs";
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
  /**
   * The OAuth PKCE `code_challenge` parameter from the authorize URL
   * that `claude setup-token` emitted when the session was first
   * started. Used to detect stale sessions on retry: if claude
   * setup-token has internally restarted (idle timeout, crash) while
   * the user was completing the browser flow, the tmux pane will show
   * a DIFFERENT challenge than this saved value. In that case the user's
   * code matches the OLD challenge but we'd hand them the NEW URL —
   * silent auth failure. See 2026-04-22 incident.
   *
   * Optional because legacy sessions (pre-stale-detection) don't have
   * it. Missing value is treated as "can't verify, recreate to be safe".
   */
  initialCodeChallenge?: string;
  /**
   * The CLAUDE_CONFIG_DIR that claude setup-token was invoked with.
   * For forced reauth this is a throwaway `.setup-token-tmp-XXX` dir
   * (so the new account doesn't see existing credentials). For a
   * first-time login it's the agent's normal `.claude/` dir.
   *
   * Why we store it: claude CLI 2.1+ never prints the OAuth token to
   * stdout after setup-token succeeds. It writes the token to
   * `<configDir>/.credentials.json` and shows only a "Login successful"
   * banner. Switchroom's old log-scan for `sk-ant-oat\d+-...` found
   * nothing and timed out with "no token was found after 20s" even
   * when the exchange had succeeded. To detect silent success we must
   * poll the credentials file directly. See 2026-04-22 bundle-strings
   * investigation — the setup-tool success branch explicitly returns
   * `null` for the on-screen view when a token exists.
   *
   * Optional for the same legacy reason as initialCodeChallenge.
   */
  configDir?: string;
  /**
   * The mtime (ms since epoch) of `<configDir>/.credentials.json` at the
   * moment the auth session was started, or 0 if the file didn't exist.
   *
   * Used in the poll loop inside `submitAuthCode` to reject pre-existing
   * stale tokens: we only accept a credentials.json read if its mtime is
   * strictly greater than this snapshot. That way a leftover credentials.json
   * from a prior auth (e.g. gymbro's expired 2026-04-20 token) can never be
   * mistaken for fresh output from the new `claude setup-token` run.
   *
   * Edge case: snapshot == 0 (file absent at session start) → any positive
   * mtime passes, so first-time logins still work correctly.
   *
   * Optional for legacy session files written before this field was added;
   * missing value is treated as 0 (accept any mtime) to avoid breaking
   * already-in-flight sessions after an upgrade.
   */
  credentialsMtimeAtStart?: number;
}

/**
 * Extract the PKCE `code_challenge` query param from a setup-token
 * authorize URL. Returns `null` if not present. Single place for this
 * shape so tests and the stale-detection branch use identical parsing.
 */
export function extractCodeChallenge(url: string): string | null {
  const match = url.match(/[?&]code_challenge=([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
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

/**
 * Return the mtime (ms since epoch) of a file, or 0 if it doesn't exist
 * or can't be stat'd. Used to snapshot .credentials.json before an auth
 * session starts so the poll loop can reject pre-existing stale tokens.
 */
function fileMtimeMs(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
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

/**
 * Is the running tmux auth session stale?
 *
 * "Stale" means the `code_challenge` currently visible in the tmux
 * pane's authorize URL doesn't match the `initialCodeChallenge` saved
 * when the session was first started. This happens when claude
 * setup-token internally idle-times-out and relaunches with a new
 * PKCE pair while the user is still completing the browser flow
 * against the original URL.
 *
 * Return value semantics:
 *   - true  → caller MUST kill + recreate. Session is unusable; user's
 *             eventual code won't match the new challenge.
 *   - false → session is live AND the challenge matches the one we
 *             emitted the URL for. Safe to return the existing URL.
 *
 * Edge cases (all treated as "stale" for safety):
 *   - Legacy meta file with no `initialCodeChallenge` field — we
 *     have nothing to compare to, can't guarantee coherence.
 *   - Current pane has no parseable URL — setup-token hasn't
 *     rendered yet OR has crashed; recreate is safer than returning
 *     a non-URL.
 *   - Meta file missing entirely — race condition, recreate.
 */
export function isSessionStale(
  agentDir: string,
  sessionName: string,
): boolean {
  const meta = readJsonFile<AuthSessionMeta>(authSessionMetaPath(agentDir));
  if (!meta) return true;
  if (meta.sessionName !== sessionName) return true;
  if (!meta.initialCodeChallenge) return true;
  const pane = captureTmuxPane(sessionName);
  const currentUrl = parseSetupTokenUrl(pane);
  if (!currentUrl) return true;
  const currentChallenge = extractCodeChallenge(currentUrl);
  if (!currentChallenge) return true;
  return currentChallenge !== meta.initialCodeChallenge;
}

/** Remove any leftover .setup-token-tmp-* dirs from interrupted reauth flows. */
function cleanupAuthTempDirs(agentDir: string): void {
  const dir = claudeDir(agentDir);
  if (!existsSync(dir)) return;
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".setup-token-tmp-")) {
        rmSync(join(dir, entry), { recursive: true, force: true });
      }
    }
  } catch {
    // best effort
  }
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
  // Anthropic has served the OAuth authorize URL under two shapes over
  // time: the legacy `https://claude.ai/oauth/authorize?...` form and
  // (as of ~2026-04) the newer `https://claude.com/cai/oauth/authorize?...`
  // form. Match either — claude.ai/oauth OR claude.com/cai/oauth — so
  // the URL-surfacing path in startAuthSession keeps working across the
  // flip. Regressing this regex means `switchroom auth reauth` falls
  // back to "use tmux attach" and the Telegram /auth reauth handler
  // never delivers a tappable link to the user.
  const match = clean.match(
    /https:\/\/claude\.(?:ai\/|com\/cai\/)oauth\/authorize\?[\s\S]*?(?=\n\s*\n|\n\s*Paste code here|$)/,
  );
  if (!match) return null;
  return match[0].replace(/\s+/g, "");
}

export function parseSetupTokenValue(output: string): string | null {
  const clean = stripAnsi(output);
  const match = clean.match(/sk-ant-oat\d+-[A-Za-z0-9._-]+/);
  return match?.[0] ?? null;
}

/**
 * Read the OAuth access token from a `.credentials.json` file written
 * by `claude setup-token`. The file shape (as of claude CLI 2.1.x):
 *
 *   { "claudeAiOauth": { "accessToken": "sk-ant-oat01-...", ... } }
 *
 * Returns null if the file is missing, unreadable, malformed, or has
 * no accessToken. Also validates the token format so we don't hand a
 * random string downstream. The valid token shape is the same regex
 * parseSetupTokenValue uses for backwards compatibility.
 *
 * Why this exists: claude CLI 2.1+ does not print the OAuth token to
 * stdout. The old path of log-scanning for `sk-ant-oat...` in tmux
 * output stopped working silently. This reader is the new primary
 * success-detection channel; log-scanning is kept as a fallback for
 * older CLI versions. 2026-04-22 incident.
 */
export function readTokenFromCredentialsFile(
  credentialsFilePath: string,
): string | null {
  try {
    if (!existsSync(credentialsFilePath)) return null;
    const raw = readFileSync(credentialsFilePath, "utf-8");
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } };
    const token = parsed?.claudeAiOauth?.accessToken;
    if (typeof token !== "string") return null;
    // Validate format. Protects against half-written files and
    // unexpected shape drift in future claude CLI versions.
    if (!/^sk-ant-oat\d+-[A-Za-z0-9._-]+$/.test(token)) return null;
    return token;
  } catch {
    return null;
  }
}

function hasPendingAuthSession(name: string, agentDir: string): boolean {
  const meta = readJsonFile<AuthSessionMeta>(authSessionMetaPath(agentDir));
  if (meta?.sessionName && tmuxSessionExists(meta.sessionName)) {
    return true;
  }
  return tmuxSessionExists(authSessionName(name));
}

function readCredentials(agentDir: string): CredentialsFile["claudeAiOauth"] | null {
  const credPath = credentialsPath(agentDir);
  if (!existsSync(credPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(credPath, "utf-8")) as CredentialsFile;
    return parsed.claudeAiOauth ?? null;
  } catch {
    return null;
  }
}

export function getAuthStatus(name: string, agentDir: string): AuthStatus {
  const pendingAuth = hasPendingAuthSession(name, agentDir);
  const creds = readCredentials(agentDir);
  const oauthToken = readOAuthToken(agentDir);

  if (oauthToken) {
    const meta = readJsonFile<OAuthTokenMeta>(oauthTokenMetaPath(agentDir));
    const expiresAt = meta?.expiresAt;
    const isExpired = expiresAt != null && expiresAt <= Date.now();

    // Prefer credentials.json subscription metadata when available — it carries
    // the real plan name (max/pro/free) and rate-limit tier. Fall back to the
    // literal "oauth-token" string only if credentials are absent.
    const subscriptionType = creds?.subscriptionType ?? "oauth-token";
    const rateLimitTier = creds?.rateLimitTier;

    return {
      authenticated: !isExpired,
      expiresAt,
      timeUntilExpiry:
        expiresAt != null ? formatTimeUntilExpiry(expiresAt) : undefined,
      source: "oauth-token",
      subscriptionType,
      rateLimitTier,
      pendingAuth,
    };
  }

  if (!creds?.accessToken) {
    return { authenticated: false, pendingAuth };
  }

  const expiresAt = creds.expiresAt;
  const isExpired = expiresAt != null && expiresAt <= Date.now();

  return {
    authenticated: !isExpired,
    subscriptionType: creds.subscriptionType,
    expiresAt: creds.expiresAt,
    timeUntilExpiry:
      expiresAt != null ? formatTimeUntilExpiry(expiresAt) : undefined,
    rateLimitTier: creds.rateLimitTier,
    source: "credentials",
    pendingAuth,
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
    } else if (isSessionStale(agentDir, sessionName)) {
      // Stale-session detection (2026-04-22 incident fix): claude
      // setup-token can idle-restart internally while the user is
      // completing the browser flow. The tmux pane then shows a NEW
      // OAuth URL (with a new code_challenge) that differs from the
      // one the user already authorized. Handing them that new URL
      // and asking them to paste a code matching the OLD challenge
      // silently fails. Detect via saved `initialCodeChallenge` in
      // the session meta; on mismatch, kill + recreate so the user
      // gets a coherent fresh session.
      tmux(["kill-session", "-t", sessionName]);
      clearAuthSessionMeta(agentDir);
      // Fall through to the fresh-session-creation code below.
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
  cleanupAuthTempDirs(agentDir);
  const logPath = authLogPath(agentDir);
  rmSync(logPath, { force: true });

  // When forcing a reauth, use a clean temporary config dir so claude
  // setup-token doesn't see existing credentials and reuse the same
  // Anthropic account. This lets the user log in with a different account.
  //
  // Pre-create the dir *from Node* with `mkdtempSync` so the path has an
  // unguessable random suffix (not just Date.now()) AND the dir exists with
  // 0o700 before the tmux/bash command runs. That closes two gaps the
  // prior shape had:
  //   - a local process watching for `.setup-token-tmp-*` inside agentDir
  //     could no longer predict the next name and stage a symlink/squat
  //   - any path where `mkdir -p` silently raced with an attacker-created
  //     world-readable dir now fails fast (mkdtemp refuses to reuse a path)
  let configDir: string;
  if (opts.force) {
    configDir = mkdtempSync(join(claudeDir(agentDir), ".setup-token-tmp-"));
    try { chmodSync(configDir, 0o700); } catch {}
  } else {
    configDir = claudeDir(agentDir);
  }

  // Snapshot the mtime of the credentials file BEFORE we launch claude
  // setup-token. The poll loop in submitAuthCode uses this to reject any
  // token read from a .credentials.json that hasn't changed since session
  // start — i.e. a stale file from a prior auth. For the force path the
  // configDir is a fresh temp dir, so the file never existed (mtime == 0)
  // and the snapshot is effectively a no-op guard.
  const credentialsMtimeAtStart = fileMtimeMs(join(configDir, ".credentials.json"));

  // For a forced reauth, cleanup MUST still run even if `claude setup-token`
  // crashes, is killed, or the tmux session is torn down — otherwise OAuth
  // artifacts linger. A bash EXIT trap gives us that guarantee. We route
  // paths through env-var expansion so the trap body references a stable
  // variable — avoids nested quoting around shellQuote() output.
  const commandParts: string[] = []
  commandParts.push(`CLAUDE_CONFIG_DIR=${shellQuote(configDir)}`)
  commandParts.push(`LOG_PATH=${shellQuote(logPath)}`)
  // BROWSER=/bin/true suppresses claude setup-token's attempt to
  // auto-launch a browser on the host. On a server that has Firefox
  // installed but no active graphical user session, the launched
  // browser lands on Claude's login page without any cookies —
  // useless — and leaves a zombie Firefox + loopback listener behind.
  // Forcing a no-op browser keeps the manual-paste flow as the only
  // path and makes the process tree cleaner. Doesn't affect the URL
  // shown to the user (still uses the platform.claude.com redirect).
  // Proven via 2026-04-22 experiments (stt-exp1, stt-exp2).
  commandParts.push(`BROWSER=/bin/true`)
  if (opts.force) {
    commandParts.push(`trap 'rm -rf -- "$CLAUDE_CONFIG_DIR"' EXIT`)
  }
  commandParts.push(`export CLAUDE_CONFIG_DIR BROWSER`)
  commandParts.push(`claude setup-token | tee -- "$LOG_PATH"`)
  const command = commandParts.join(" && ");

  tmux(["new-session", "-d", "-s", sessionName, "-c", agentDir, `bash -lc ${shellQuote(command)}`]);

  sleepMs(8000);
  const output = captureTmuxPane(sessionName);
  const loginUrl = parseSetupTokenUrl(output) ?? undefined;

  // Save the INITIAL code_challenge so a subsequent call to
  // startAuthSession can detect if claude setup-token has since
  // restarted internally (new challenge ≠ saved challenge → stale
  // session). See 2026-04-22 incident. Written only after the URL is
  // available; if we couldn't parse a challenge (e.g. claude failed
  // to render), we save the meta without it — legacy treats missing
  // as "kill + recreate on retry" which is the safe default.
  const initialCodeChallenge = loginUrl ? extractCodeChallenge(loginUrl) ?? undefined : undefined;
  writeAuthSessionMeta(agentDir, {
    sessionName,
    logPath,
    startedAt: Date.now(),
    slot: slotArg,
    initialCodeChallenge,
    configDir,
    credentialsMtimeAtStart,
  });

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

/**
 * Read the current contents of the setup-token log file and try to extract
 * an OAuth token. Returns null if the file is missing, unreadable, or doesn't
 * yet contain a token. Exported for unit testing.
 */
export function readTokenFromLogFile(logPath: string): string | null {
  if (!existsSync(logPath)) return null;
  try {
    const content = readFileSync(logPath, "utf-8");
    return parseSetupTokenValue(content);
  } catch {
    return null;
  }
}

export function submitAuthCode(
  name: string,
  agentDir: string,
  code: string,
  slot?: string,
  _opts: { pollIntervalMs?: number; pollTimeoutMs?: number } = {},
): AuthCodeResult {
  const pollIntervalMs = _opts.pollIntervalMs ?? 500;
  const pollTimeoutMs = _opts.pollTimeoutMs ?? 20_000;

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

  // Read the configDir that `claude setup-token` was launched with so
  // we can watch its .credentials.json for the success-written token.
  // Fallback to the agent's regular .claude dir for first-time logins
  // (non-force flow) where configDir == claudeDir(agentDir) anyway.
  const meta = readJsonFile<AuthSessionMeta>(authSessionMetaPath(agentDir));
  const credFileToWatch = meta?.configDir
    ? join(meta.configDir, ".credentials.json")
    : credentialsPath(agentDir);

  // Stale-token guard (Fix 1, 2026-04-25 gymbro incident):
  // We only accept a credentials.json read if the file was written AFTER
  // the auth session started. snapshot == 0 means the file didn't exist at
  // session start, so any positive mtime passes (first-time login case).
  // Legacy session meta without this field → treat as 0 (accept any mtime)
  // to avoid breaking already-in-flight sessions after an upgrade.
  const credsMtimeSnapshot = meta?.credentialsMtimeAtStart ?? 0;

  // Two-channel success detection:
  //   1. <configDir>/.credentials.json written by claude CLI itself.
  //      This is the PRIMARY channel as of claude CLI 2.1+ because the
  //      token is no longer printed to stdout on setup-token success.
  //      GATED: only accepted if the file's mtime is strictly newer than
  //      the snapshot taken at session start (stale-token fix).
  //   2. Log file scan for a raw `sk-ant-oat...` string. Covers older
  //      claude CLI versions that DID print it, and any future code
  //      path that logs the token (e.g. debug mode). Not mtime-gated
  //      because the log file is created fresh at session start.
  //
  // Both channels produce the same token string on success; we return
  // whichever wins the race. Polling both each tick means a silent
  // success is detected on the same interval as a printed success.
  const logPath = authLogPath(agentDir);
  let token: string | null = null;
  const deadline = Date.now() + pollTimeoutMs;
  while (Date.now() < deadline) {
    sleepMs(pollIntervalMs);
    // Only read credentials.json if it's newer than the snapshot.
    const credsMtime = fileMtimeMs(credFileToWatch);
    if (credsMtime > credsMtimeSnapshot) {
      token = readTokenFromCredentialsFile(credFileToWatch);
      if (token) break;
    }
    token = readTokenFromLogFile(logPath);
    if (token) break;
  }

  // Last-ditch pane capture. If both channels are empty but the UI
  // happens to have the token rendered (unlikely but cheap), catch it.
  if (!token) {
    const paneOutput = captureTmuxPane(sessionName);
    token = parseSetupTokenValue(paneOutput);
  }

  if (!token) {
    return {
      completed: false,
      tokenSaved: false,
      instructions: [
        `Submitted code to Claude for agent "${name}", but no token was found after ${Math.round(pollTimeoutMs / 1000)}s.`,
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
  // Belt-and-braces: the bash EXIT trap in startAuthSession removes the
  // throwaway CLAUDE_CONFIG_DIR when the tmux pane exits, but if the tmux
  // server was torn down by SIGKILL or the machine lost power, the trap
  // never fires. Sweep on successful token ingest too.
  cleanupAuthTempDirs(agentDir);
  // Clean up auth log file — it contains the token in plaintext.
  rmSync(authLogPath(agentDir), { force: true });
  // Fix 2 (2026-04-25 gymbro incident): remove the agent's .credentials.json
  // so the running claude CLI doesn't shadow the new .oauth-token with a
  // stale (possibly expired) credentials file. The env-var path
  // (CLAUDE_CODE_OAUTH_TOKEN exported from start.sh) is the single source
  // of truth at runtime. For the force path, credentials.json lives in the
  // throwaway temp dir which cleanupAuthTempDirs just wiped; this call is
  // a no-op there (force: true makes it safe).
  rmSync(credentialsPath(agentDir), { force: true });

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
  cleanupAuthTempDirs(agentDir);

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
