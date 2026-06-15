import {
  readFileSync,
  existsSync,
  realpathSync,
  mkdirSync,
  openSync,
  closeSync,
  writeSync,
  constants as fsConstants,
} from "node:fs";
import { resolve, extname, join, relative, dirname } from "node:path";
import { homedir } from "node:os";
import { timingSafeEqual, randomBytes } from "node:crypto";
import type { SwitchroomConfig } from "../config/schema.js";
import { resolveAgentConfig } from "../config/merge.js";
import { loadConfig, resolvePath } from "../config/loader.js";
import { getViaBrokerStructured, resolveBrokerSocketPath } from "../vault/broker/client.js";
import {
  handleGetAgents,
  handleStartAgent,
  handleStopAgent,
  handleRestartAgent,
  handleGetLogs,
  handleGetTurns,
  handleGetSubagents,
  handleGetAccounts,
  handleRefreshAccountsQuota,
  handleGetAgentAccounts,
  handleGetAgentConfig,
  handleUseAccount,
  handleGetSystemHealth,
  handleGetMemoryHealth,
  handleMemoryReprocess,
  handleMemoryRefreshModel,
  handleMemoryBuildProfile,
  handleGetGoogleAccounts,
  handleGetMicrosoftAccounts,
  handleSetConnectionAccess,
  handleGetConnectionAccessStatus,
  handleStartMicrosoftConnect,
  handleGetMicrosoftConnectStatus,
  handleGetNotionWorkspace,
  handleGetSchedule,
  handleGetApprovals,
  handleGetGrants,
  handleGetSummary,
  dashboardCache,
  DASHBOARD_CACHE_TTL,
  type AgentInfo,
  type SystemHealth,
  type ScheduleDashboard,
  type ApprovalsDashboard,
  type GrantsDashboard,
  type AccountDashboardInfo,
} from "./api.js";
import type { CachedResult } from "./cache.js";
import { fetchAgentLogsViaHostd } from "./hostd-read-client.js";
import { handleWebhookIngest } from "./webhook-handler.js";
import { loadEdgeSecret } from "./webhook-edge.js";

/** Live-log poll cadence (ms) for the WS stream. hostd reads `docker
 *  logs --tail` each tick — a poll, not a follow, because the dockerless
 *  web can't `docker logs -f`. 3s balances freshness against host load. */
const LOG_POLL_INTERVAL_MS = 3000;
/** Trailing lines requested each poll. hostd caps its `stdout_tail` at
 *  4 KiB regardless, so a very high-volume container shows only the last
 *  ~tail; acceptable for this at-a-glance log view. */
const LOG_POLL_TAIL_LINES = 400;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

/**
 * Constant-time string comparison to prevent timing attacks on token checks.
 * When lengths differ, compares against self to consume constant time.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Resolve the bearer token the dashboard will require for every request.
 *
 * Precedence: `SWITCHROOM_WEB_TOKEN` env var wins. Otherwise we generate
 * a 256-bit random token and persist it at `~/.switchroom/web-token`
 * (mode 0o600) — subsequent runs reuse it. Auth is NEVER optional:
 * without a token, any website the user visits could CSRF the localhost
 * dashboard into starting/stopping agents or streaming journal logs.
 */
function resolveWebToken(): string {
  const fromEnv = process.env.SWITCHROOM_WEB_TOKEN;
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  const home = process.env.HOME ?? homedir();
  const tokenPath = join(home, ".switchroom", "web-token");
  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, "utf8").trim();
    if (existing.length > 0) return existing;
  }

  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
  // O_CREAT|O_EXCL: refuse to follow a pre-existing symlink or overwrite a
  // token someone else created in the same race. If the file already exists
  // we fall through and use the existing token (above); we only land here
  // when it truly didn't. If a concurrent dashboard start created the file
  // between our existsSync and openSync, EEXIST: re-read and use that.
  try {
    const fd = openSync(
      tokenPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    try {
      writeSync(fd, token + "\n");
    } finally {
      closeSync(fd);
    }
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      const existing = readFileSync(tokenPath, "utf8").trim();
      if (existing.length > 0) return existing;
    }
    throw err;
  }
}

/**
 * Returns true when the request carries a Tailscale identity header AND the
 * connection originates from the loopback interface (127.0.0.1 or ::1).
 *
 * Safety rule — trust only from loopback:
 *   Tailscale's `tailscale serve` daemon injects `Tailscale-User-Login` (and
 *   related headers) into requests it proxies to the local backend. These
 *   headers are authoritative ONLY when the request comes from the Tailscale
 *   daemon itself, which always connects via loopback. If we trusted the header
 *   from arbitrary remote IPs, any external caller could spoof it and bypass
 *   the bearer-token check entirely. By requiring source IP to be loopback we
 *   guarantee the header was injected by the daemon, not a remote attacker.
 *
 * Exported for unit-testing; not part of the public API.
 */
export function isTailscaleIdentified(req: Request, server: { requestIP(req: Request): { address: string } | null }): boolean {
  const login = req.headers.get("Tailscale-User-Login");
  if (!login || login.trim() === "") return false;
  const ipInfo = server.requestIP(req);
  if (!ipInfo) return false;
  const addr = ipInfo.address;
  return addr === "127.0.0.1" || addr === "::1";
}

/**
 * Reject requests whose Origin doesn't belong to our own localhost-bound
 * server. Prevents a malicious page the user happens to load in a browser
 * from issuing same-site-ish requests to 127.0.0.1:<port> and piggy-backing
 * on any ambient credentials a browser might attach. We accept requests
 * with NO Origin header (CLI / curl / same-origin) but block any Origin
 * that isn't http[s]://localhost[:port] or http[s]://127.0.0.1[:port].
 *
 * When the server is bound to a non-loopback address (e.g. 0.0.0.0 or a
 * Tailscale IP) the user has explicitly opted in to network exposure. In that
 * case the original CSRF concern — a malicious website reaching localhost —
 * doesn't apply: the attacker would need to know the target IP and defeat
 * same-origin browser protections for a remote host. The randomly-generated
 * bearer token is the security boundary; origin filtering is skipped.
 *
 * Exported for unit-testing; not part of the public API.
 */
export function isOriginAllowed(
  req: Request,
  port: number,
  localhostOnly: boolean,
  tailscaleIdentified = false,
): boolean {
  if (!localhostOnly) {
    // Non-loopback bind: token is the sole auth boundary; skip origin check.
    return true;
  }
  // Behind `tailscale serve`: the request arrived on loopback carrying
  // a `Tailscale-User-Login` header that only the tailscale daemon can
  // inject (verified by isTailscaleIdentified — loopback source + the
  // header). It is therefore NOT a hostile cross-origin web page hitting
  // raw localhost — it came through the trusted serve proxy, whose
  // Origin is the tailnet host. Allow it; this mirrors how checkAuth
  // already trusts the same predicate, and makes the dashboard's own
  // printed `tailscale serve` instructions actually work on a
  // localhost-only bind (they previously 403'd here). A malicious page
  // CANNOT set Tailscale-User-Login, so CSRF protection for the
  // original threat (web page → raw 127.0.0.1) is unchanged.
  if (tailscaleIdentified) return true;
  const origin = req.headers.get("Origin");
  if (!origin) return true;
  const allowed = [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
  ];
  return allowed.includes(origin);
}

function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.get("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  // Browsers can't set Authorization on WebSocket upgrades, but they CAN set
  // Sec-WebSocket-Protocol — client does `new WebSocket(url, ["bearer", token])`.
  const wsProto = req.headers.get("Sec-WebSocket-Protocol");
  if (wsProto) {
    const parts = wsProto.split(",").map((s) => s.trim());
    const idx = parts.indexOf("bearer");
    if (idx >= 0 && idx + 1 < parts.length) return parts[idx + 1];
  }
  return null;
}

function checkAuth(
  req: Request,
  token: string,
  server: { requestIP(req: Request): { address: string } | null },
): Response | null {
  // Tailscale identity header from loopback takes priority over bearer token.
  // This allows tailnet-authenticated browser sessions (proxied via
  // `tailscale serve`) to use the dashboard without needing the bearer token.
  if (isTailscaleIdentified(req, server)) return null;

  const presented = extractBearerToken(req);
  if (!presented || !constantTimeEqual(presented, token)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

function checkWsAuth(
  req: Request,
  token: string,
  server: { requestIP(req: Request): { address: string } | null },
): boolean {
  // Tailscale identity header from loopback is sufficient for WebSocket auth too.
  if (isTailscaleIdentified(req, server)) return true;
  const presented = extractBearerToken(req);
  return presented !== null && constantTimeEqual(presented, token);
}

/**
 * Webhook secrets file lives at ~/.switchroom/webhook-secrets.json.
 * Shape:
 *   {
 *     "klanker": { "github": "<secret>", "generic": "<token>" },
 *     "finn":    { "github": "<secret>" }
 *   }
 *
 * One operator-managed file — no vault integration in this PR. Mode
 * 0600 (read by switchroom user only). Future PR can swap for a
 * vault-backed resolver if the operator burden becomes real.
 */
function loadWebhookSecrets(): Record<string, Record<string, string>> {
  const path = join(homedir(), ".switchroom", "webhook-secrets.json");
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, Record<string, string>>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    process.stderr.write(
      `webhook-ingest: failed to parse ${path}: ${(err as Error).message} — webhooks will return 401 until fixed\n`,
    );
    return {};
  }
}

/**
 * Resolve a webhook source's signature secret from the vault at
 * `webhook/<agent>/<source>` — the location `switchroom telegram enable
 * webhook` writes it to. Read via the vault broker as the web server's
 * own (operator) identity; the secret must therefore be broker-readable
 * by the operator (i.e. NOT scoped `--allow <agent>`, which would lock
 * out the verifier). Returns the raw string secret, or null when the key
 * is absent / the broker is unreachable / the entry isn't a string —
 * every null path fails closed (the route returns 401 "no secret").
 *
 * Non-throwing: a broker hiccup must not 500 the webhook endpoint.
 */
export async function resolveWebhookSecretFromVault(
  agent: string,
  source: string,
  config: SwitchroomConfig,
): Promise<string | null> {
  const key = `webhook/${agent}/${source}`;
  try {
    const socket = resolveBrokerSocketPath({
      vaultBrokerSocket: config.vault?.broker?.socket
        ? resolvePath(config.vault.broker.socket)
        : undefined,
    });
    const result = await getViaBrokerStructured(key, { socket });
    if (result.kind === "ok" && result.entry.kind === "string") {
      return result.entry.value;
    }
    // not_found is the common, benign "webhook not enabled / no vault
    // secret" case — stay quiet. denied/unreachable are misconfigurations
    // worth a log line (e.g. the secret got scoped `--allow <agent>`,
    // which denies the operator-identity verifier).
    if (result.kind === "denied" || result.kind === "unreachable") {
      process.stderr.write(
        `webhook-ingest: vault resolve for ${key} → ${result.kind}` +
        `${"code" in result && result.code ? ` (${result.code})` : ""}` +
        `; webhook will 401 until the secret is operator-readable\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `webhook-ingest: vault resolve for ${key} threw: ${(err as Error).message}\n`,
    );
  }
  return null;
}

async function handleWebhookRoute(
  req: Request,
  agent: string,
  source: string,
  config: SwitchroomConfig,
): Promise<Response> {
  const agentConfigRaw = config.agents[agent];
  const agentConfig = agentConfigRaw
    ? resolveAgentConfig(config.defaults, config.profiles, agentConfigRaw)
    : undefined;
  // Canonical location is channels.telegram.webhook_sources (#596).
  // The cascade resolver folds the deprecated root-level field into
  // it, so reading from the new spot covers both old and new
  // switchroom.yaml shapes.
  const allowedSources = agentConfig?.channels?.telegram?.webhook_sources ?? [];
  // Two secret sources, file-first:
  //  1. webhook-secrets.json — the legacy operator-managed file (github
  //     secrets for hand-wired agents). Kept for backwards compatibility.
  //  2. The vault under `webhook/<agent>/<source>` — the CANONICAL path
  //     since `switchroom telegram enable webhook` (src/cli/telegram.ts),
  //     which vault-stores the per-source secret. The receiver historically
  //     only read the file (loadWebhookSecrets' "future PR" TODO), so every
  //     CLI-enabled webhook 401'd "no secret in vault" — its secret was in
  //     the vault but nothing here resolved it. Resolve it now, only when
  //     the file doesn't already supply this source (file wins).
  const allSecrets = loadWebhookSecrets();
  const agentSecrets: Record<string, string> = { ...(allSecrets[agent] ?? {}) };
  if (!agentSecrets[source]) {
    const fromVault = await resolveWebhookSecretFromVault(agent, source, config);
    if (fromVault) agentSecrets[source] = fromVault;
  }

  // Cloudflare-only edge lock (Phase 2). Per-agent opt-in; the secret
  // itself is endpoint-global (one file guards the whole receiver). Loaded
  // lazily only when the agent requires it; null when the file is
  // missing/empty, which fails closed inside the handler.
  const requireEdge = agentConfig?.channels?.telegram?.webhook_require_edge === true;
  const edgeSecret = requireEdge ? loadEdgeSecret() : null;

  let bodyBuf: Uint8Array;
  try {
    bodyBuf = new Uint8Array(await req.arrayBuffer());
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "could not read body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const result = await handleWebhookIngest(
    {
      agent,
      source,
      body: bodyBuf,
      headers: req.headers,
      allowedSources,
      config: { secrets: agentSecrets as Partial<Record<"github" | "generic" | "linear", string>> },
      agentExists: agentConfig !== undefined,
      dispatchConfig: agentConfig?.channels?.telegram?.webhook_dispatch,
      // Docker-runtime: forward to the agent's gateway instead of writing
      // the per-agent-UID-owned dir as the host operator UID (EACCES 500).
      viaGateway: agentConfig?.channels?.telegram?.webhook_via_gateway === true,
      requireEdge,
      edgeSecret,
    },
    {},
  );
  return new Response(result.body, {
    status: result.status,
    headers: { "Content-Type": result.contentType },
  });
}

function parseRoute(
  pathname: string,
  method: string
): { handler: string; params: Record<string, string> } | null {
  // GET /api/agents
  if (method === "GET" && pathname === "/api/agents") {
    return { handler: "getAgents", params: {} };
  }

  // GET /api/summary — one aggregate of the cached reads for the Summary
  // tab, so it needs a single round-trip instead of fanning out to five.
  if (method === "GET" && pathname === "/api/summary") {
    return { handler: "getSummary", params: {} };
  }

  // GET /api/agents/:name/logs
  const logsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/logs$/);
  if (method === "GET" && logsMatch) {
    return { handler: "getLogs", params: { name: logsMatch[1] } };
  }

  // POST /api/agents/:name/start
  const startMatch = pathname.match(/^\/api\/agents\/([^/]+)\/start$/);
  if (method === "POST" && startMatch) {
    return { handler: "startAgent", params: { name: startMatch[1] } };
  }

  // POST /api/agents/:name/stop
  const stopMatch = pathname.match(/^\/api\/agents\/([^/]+)\/stop$/);
  if (method === "POST" && stopMatch) {
    return { handler: "stopAgent", params: { name: stopMatch[1] } };
  }

  // POST /api/agents/:name/restart
  const restartMatch = pathname.match(/^\/api\/agents\/([^/]+)\/restart$/);
  if (method === "POST" && restartMatch) {
    return { handler: "restartAgent", params: { name: restartMatch[1] } };
  }

  // GET /api/agents/:name/turns
  const turnsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/turns$/);
  if (method === "GET" && turnsMatch) {
    return { handler: "getTurns", params: { name: turnsMatch[1] } };
  }

  // GET /api/agents/:name/subagents
  const subagentsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/subagents$/);
  if (method === "GET" && subagentsMatch) {
    return { handler: "getSubagents", params: { name: subagentsMatch[1] } };
  }

  // GET /api/system-health
  if (method === "GET" && pathname === "/api/system-health") {
    return { handler: "getSystemHealth", params: {} };
  }

  // GET /api/memory-health
  if (method === "GET" && pathname === "/api/memory-health") {
    return { handler: "getMemoryHealth", params: {} };
  }

  // POST /api/memory/reprocess  body: { bank }
  // Re-extract facts from a bank's stuck (gap) documents. The web only
  // POKES hindsight's REST API — hindsight does the LLM work on its own
  // provider; no model call from the dashboard.
  if (method === "POST" && pathname === "/api/memory/reprocess") {
    return { handler: "memoryReprocess", params: {} };
  }

  // POST /api/memory/refresh-model  body: { bank, modelId }
  // Regenerate one mental model (fixes a corrupted/stale model).
  if (method === "POST" && pathname === "/api/memory/refresh-model") {
    return { handler: "memoryRefreshModel", params: {} };
  }

  // POST /api/memory/build-profile  body: { bank }
  // Create-if-missing the user-profile mental model for a bank.
  if (method === "POST" && pathname === "/api/memory/build-profile") {
    return { handler: "memoryBuildProfile", params: {} };
  }

  // GET /api/google-accounts
  if (method === "GET" && pathname === "/api/google-accounts") {
    return { handler: "getGoogleAccounts", params: {} };
  }

  // GET /api/microsoft-accounts
  if (method === "GET" && pathname === "/api/microsoft-accounts") {
    return { handler: "getMicrosoftAccounts", params: {} };
  }

  // GET /api/notion-workspace
  if (method === "GET" && pathname === "/api/notion-workspace") {
    return { handler: "getNotionWorkspace", params: {} };
  }

  // GET /api/schedule
  if (method === "GET" && pathname === "/api/schedule") {
    return { handler: "getSchedule", params: {} };
  }

  // GET /api/approvals
  if (method === "GET" && pathname === "/api/approvals") {
    return { handler: "getApprovals", params: {} };
  }

  // GET /api/grants — standing capability grants from the vault-broker
  // grants DB (the operator's REAL grants; the kernel decision ledger
  // above is honestly empty on most installs).
  if (method === "GET" && pathname === "/api/grants") {
    return { handler: "getGrants", params: {} };
  }

  // GET /api/accounts
  if (method === "GET" && pathname === "/api/accounts") {
    return { handler: "getAccounts", params: {} };
  }

  // POST /api/connections/access
  //   body: { provider, account, agent, action: "enable" | "disable" }
  // PROPOSE granting/revoking an agent's access to a Google/Microsoft
  // account. Does NOT write config — raises a Telegram Allow/Deny card via
  // hostd (the sole writer). Returns a requestId to poll.
  if (method === "POST" && pathname === "/api/connections/access") {
    return { handler: "setConnectionAccess", params: {} };
  }

  // GET /api/connections/access/:requestId — poll the approval outcome.
  const accessStatusMatch = pathname.match(/^\/api\/connections\/access\/([^/]+)$/);
  if (method === "GET" && accessStatusMatch) {
    return {
      handler: "getConnectionAccessStatus",
      params: { requestId: decodeURIComponent(accessStatusMatch[1]) },
    };
  }

  // POST /api/connections/microsoft/connect — start an in-browser
  // device-code connect; returns a user code + verification URL to poll.
  if (method === "POST" && pathname === "/api/connections/microsoft/connect") {
    return { handler: "startMicrosoftConnect", params: {} };
  }

  // GET /api/connections/microsoft/connect/:requestId — poll the connect.
  const msConnectMatch = pathname.match(/^\/api\/connections\/microsoft\/connect\/([^/]+)$/);
  if (method === "GET" && msConnectMatch) {
    return {
      handler: "getMicrosoftConnectStatus",
      params: { requestId: decodeURIComponent(msConnectMatch[1]) },
    };
  }

  // POST /api/auth/use
  //   body: { account: string }
  // Replaces the pre-RFC-H `/api/accounts/:label/promote` endpoint. The
  // fleet-wide model has one knob, not a per-agent matrix — body carries
  // the chosen label so callers don't have to URL-encode it past the
  // account-label charset.
  if (method === "POST" && pathname === "/api/auth/use") {
    return { handler: "useAccount", params: {} };
  }

  // POST /api/accounts/quota/refresh  body: { labels?: string[], force?: bool }
  // Explicit, cost-bearing: probe-quota is a live billed Anthropic call
  // per account. TTL-cached server-side; force=true bypasses the TTL.
  if (method === "POST" && pathname === "/api/accounts/quota/refresh") {
    return { handler: "refreshQuota", params: {} };
  }

  // GET /api/agents/:name/accounts
  const agentAccountsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/accounts$/);
  if (method === "GET" && agentAccountsMatch) {
    return { handler: "getAgentAccounts", params: { name: agentAccountsMatch[1] } };
  }

  // GET /api/agents/:name/config
  const agentConfigMatch = pathname.match(/^\/api\/agents\/([^/]+)\/config$/);
  if (method === "GET" && agentConfigMatch) {
    return { handler: "getAgentConfig", params: { name: agentConfigMatch[1] } };
  }

  return null;
}

export function startWebServer(
  config: SwitchroomConfig,
  port: number,
  hostname = "127.0.0.1",
  configPath?: string,
): { token: string } {
  const uiDirRaw = resolve(import.meta.dirname, "ui");
  // Resolve symlinks once at startup so the traversal check compares real paths.
  const uiDir = existsSync(uiDirRaw) ? realpathSync(uiDirRaw) : uiDirRaw;
  const token = resolveWebToken();

  // The connection views + the access-mutation endpoint must reflect the
  // CURRENT switchroom.yaml — the startup `config` goes stale the moment
  // the dashboard writes an ACL change. Re-read fresh from disk per
  // request (cheap, and only for the config-derived connection routes);
  // fall back to the startup config if the path is unset or a load fails.
  const freshConfig = (): SwitchroomConfig => {
    if (!configPath) return config;
    try {
      return loadConfig(configPath);
    } catch {
      return config;
    }
  };

  // ── Cached read producers ────────────────────────────────────────────
  // Every expensive READ panel routes through `dashboardCache` (a tiny
  // stale-while-revalidate cache) keyed by the route name, so a tab-open
  // / poll-tick serves a cached value fast and at most ONE background
  // refresh hits the host. These producers are shared verbatim by the
  // per-tab routes AND `/api/summary` — same key + TTL — so a Summary
  // open warms the tabs (and vice-versa) and the two can never disagree.
  // Each returns the cached value plus its `dataAsOf` stamp. Producers
  // re-read `freshConfig()` per refresh (the config can change under us).
  const cachedAgents = (): Promise<CachedResult<AgentInfo[]>> =>
    dashboardCache.get(
      "agents",
      DASHBOARD_CACHE_TTL.agents,
      () => handleGetAgents(freshConfig()),
    );
  const cachedSystemHealth = (): Promise<CachedResult<SystemHealth>> =>
    dashboardCache.get(
      "system-health",
      DASHBOARD_CACHE_TTL["system-health"],
      () => handleGetSystemHealth(freshConfig()),
    );
  const cachedMemoryHealth = () =>
    dashboardCache.get(
      "memory-health",
      DASHBOARD_CACHE_TTL["memory-health"],
      () => handleGetMemoryHealth(freshConfig()),
    );
  const cachedSchedule = (): Promise<CachedResult<ScheduleDashboard>> =>
    dashboardCache.get(
      "schedule",
      DASHBOARD_CACHE_TTL.schedule,
      () => handleGetSchedule(freshConfig()),
    );
  const cachedApprovals = (): Promise<CachedResult<ApprovalsDashboard>> =>
    dashboardCache.get(
      "approvals",
      DASHBOARD_CACHE_TTL.approvals,
      () => handleGetApprovals(),
    );
  const cachedGrants = (): Promise<CachedResult<GrantsDashboard>> =>
    dashboardCache.get(
      "grants",
      DASHBOARD_CACHE_TTL.grants,
      () => handleGetGrants(),
    );
  const cachedAccounts = (): Promise<CachedResult<AccountDashboardInfo[]>> =>
    dashboardCache.get(
      "accounts",
      DASHBOARD_CACHE_TTL.accounts,
      () => handleGetAccounts(freshConfig()),
    );

  /** Attach the cache stamp to an OBJECT response. Arrays stay bare (the
   *  UI expects a raw array there) — only object panels carry the stamp. */
  const withStamp = <T extends object>(part: CachedResult<T>): T =>
    ({ ...part.value, dataAsOf: part.dataAsOf, stale: part.stale } as T);

  // Loopback-only when binding to a localhost address; any other bind address
  // (including 0.0.0.0) is considered a deliberate network-exposure opt-in.
  const localhostOnly =
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";

  const server = Bun.serve({
    port,
    hostname,
    fetch(req, server) {
      const url = new URL(req.url);
      const { pathname } = url;

      // Webhook ingest (#577) sits BEFORE the origin gate + bearer-token
      // gate because:
      //   - The webhook brings its own auth (HMAC for github, Bearer for
      //     generic) verified inside the handler.
      //   - External services (GitHub, Sentry, custom) cannot send the
      //     `Origin` header that isOriginAllowed expects, so the origin
      //     gate would block them.
      //   - The dashboard's web token has no business gating an external
      //     webhook — wrong principle, wrong key.
      // Path: POST /webhook/:agent/:source
      const webhookMatch = pathname.match(/^\/webhook\/([^/]+)\/([^/]+)$/);
      if (req.method === "POST" && webhookMatch) {
        return handleWebhookRoute(req, webhookMatch[1], webhookMatch[2], config);
      }

      // Cross-origin requests from any page the user happens to load in a
      // browser must not reach the privileged API. When bound to loopback,
      // reject any Origin that isn't our own loopback address. When bound to
      // a non-loopback address the user has opted in to network exposure and
      // the bearer token is the sole security boundary (see isOriginAllowed).
      if (!isOriginAllowed(req, port, localhostOnly, isTailscaleIdentified(req, server))) {
        return new Response("Forbidden", { status: 403 });
      }

      // Handle CORS preflight — not needed for localhost-only server
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204 });
      }

      // WebSocket upgrade
      if (pathname === "/ws") {
        if (!checkWsAuth(req, token, server)) {
          return new Response("Unauthorized", { status: 401 });
        }
        // If the client sent a Sec-WebSocket-Protocol header for auth, echo
        // back "bearer" so the negotiated subprotocol is valid.
        const wsProto = req.headers.get("Sec-WebSocket-Protocol");
        const headers =
          wsProto && wsProto.split(",").map((s) => s.trim()).includes("bearer")
            ? { "Sec-WebSocket-Protocol": "bearer" }
            : undefined;
        const upgraded = server.upgrade(req, headers ? { headers } : undefined);
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined as unknown as Response;
      }

      // API routes — require auth if SWITCHROOM_WEB_TOKEN is set
      const route = parseRoute(pathname, req.method);
      if (route) {
        const authError = checkAuth(req, token, server);
        if (authError) return authError;

        switch (route.handler) {
          case "getAgents":
            // Array response — the UI expects a bare array, so DON'T wrap
            // it; the cache still speeds the poll. Stamp lives on the
            // object panels + the summary.
            return (async () => jsonResponse((await cachedAgents()).value))();

          case "getSummary":
            return (async () =>
              jsonResponse(
                await handleGetSummary({
                  agents: cachedAgents,
                  systemHealth: cachedSystemHealth,
                  approvals: cachedApprovals,
                  schedule: cachedSchedule,
                  accounts: cachedAccounts,
                }),
              ))();

          case "getLogs": {
            const agentName = route.params.name;
            if (!config.agents[agentName]) {
              return jsonResponse({ ok: false, error: `Unknown agent: ${agentName}` }, 404);
            }
            const rawLines = Number(url.searchParams.get("lines") ?? "50");
            const lines =
              Number.isInteger(rawLines) && rawLines >= 1 && rawLines <= 10000
                ? rawLines
                : 50;
            return (async () => jsonResponse(await handleGetLogs(agentName, lines)))();
          }

          case "startAgent": {
            const agentName = route.params.name;
            if (!config.agents[agentName]) {
              return jsonResponse({ ok: false, error: `Unknown agent: ${agentName}` }, 404);
            }
            return (async () => jsonResponse(await handleStartAgent(agentName)))();
          }

          case "stopAgent": {
            const agentName = route.params.name;
            if (!config.agents[agentName]) {
              return jsonResponse({ ok: false, error: `Unknown agent: ${agentName}` }, 404);
            }
            return (async () => jsonResponse(await handleStopAgent(agentName)))();
          }

          case "restartAgent": {
            const agentName = route.params.name;
            if (!config.agents[agentName]) {
              return jsonResponse({ ok: false, error: `Unknown agent: ${agentName}` }, 404);
            }
            return (async () => jsonResponse(await handleRestartAgent(agentName)))();
          }

          case "getTurns": {
            const agentName = route.params.name;
            if (!config.agents[agentName]) {
              return jsonResponse({ ok: false, error: `Unknown agent: ${agentName}` }, 404);
            }
            const rawLimit = Number(url.searchParams.get("limit") ?? "20");
            const limit =
              Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 200
                ? rawLimit
                : 20;
            const result = handleGetTurns(config, agentName, limit);
            if (!result.ok) {
              return jsonResponse({ ok: false, error: result.error }, 500);
            }
            return jsonResponse(result.turns);
          }

          case "getSubagents": {
            const agentName = route.params.name;
            if (!config.agents[agentName]) {
              return jsonResponse({ ok: false, error: `Unknown agent: ${agentName}` }, 404);
            }
            const status = url.searchParams.get("status") ?? undefined;
            const result = handleGetSubagents(config, agentName, status);
            if (!result.ok) {
              return jsonResponse({ ok: false, error: result.error }, 500);
            }
            return jsonResponse(result.subagents);
          }

          case "getSystemHealth":
            return (async () =>
              jsonResponse(withStamp(await cachedSystemHealth())))();

          case "getMemoryHealth":
            return (async () =>
              jsonResponse(withStamp(await cachedMemoryHealth())))();

          case "getGoogleAccounts":
            return (async () =>
              jsonResponse(await handleGetGoogleAccounts(freshConfig())))();

          case "getMicrosoftAccounts":
            return (async () =>
              jsonResponse(await handleGetMicrosoftAccounts(freshConfig())))();

          case "getNotionWorkspace":
            return jsonResponse(handleGetNotionWorkspace(freshConfig()));

          case "getSchedule":
            return (async () =>
              jsonResponse(withStamp(await cachedSchedule())))();

          case "getApprovals":
            return (async () =>
              jsonResponse(withStamp(await cachedApprovals())))();

          case "getGrants":
            return (async () =>
              jsonResponse(withStamp(await cachedGrants())))();

          case "getAccounts":
            // Array response — bare array, no stamp wrap (see getAgents).
            return (async () => jsonResponse((await cachedAccounts()).value))();

          case "useAccount": {
            return (async () => {
              let body: { account?: string };
              try {
                body = (await req.json()) as { account?: string };
              } catch {
                return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
              }
              const account = body.account;
              if (typeof account !== "string" || account.length === 0) {
                return jsonResponse(
                  { ok: false, error: "Body must include `account` (string)." },
                  400,
                );
              }
              const result = await handleUseAccount(account);
              if (!result.ok) {
                return jsonResponse(result, 400);
              }
              return jsonResponse(result);
            })();
          }

          case "setConnectionAccess": {
            return (async () => {
              if (!configPath) {
                return jsonResponse(
                  { ok: false, error: "config path not available to the web server" },
                  500,
                );
              }
              let body: {
                provider?: string;
                account?: string;
                agent?: string;
                action?: string;
              };
              try {
                body = (await req.json()) as typeof body;
              } catch {
                return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
              }
              const result = handleSetConnectionAccess(configPath, freshConfig(), {
                provider: String(body.provider ?? ""),
                account: String(body.account ?? ""),
                agent: String(body.agent ?? ""),
                action: String(body.action ?? ""),
              });
              return jsonResponse(result, result.ok ? 200 : 400);
            })();
          }

          case "getConnectionAccessStatus":
            return jsonResponse(
              handleGetConnectionAccessStatus(route.params.requestId),
            );

          case "startMicrosoftConnect":
            return (async () => {
              const result = await handleStartMicrosoftConnect(freshConfig());
              return jsonResponse(result, result.ok ? 200 : 400);
            })();

          case "getMicrosoftConnectStatus":
            return jsonResponse(
              handleGetMicrosoftConnectStatus(route.params.requestId),
            );

          case "refreshQuota": {
            return (async () => {
              let body: { labels?: unknown; force?: unknown } = {};
              try {
                const raw = await req.text();
                body = raw ? JSON.parse(raw) : {};
              } catch {
                return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
              }
              const labels = Array.isArray(body.labels)
                ? body.labels.filter((l): l is string => typeof l === "string")
                : undefined;
              const force = body.force === true;
              const result = await handleRefreshAccountsQuota(labels, force);
              return jsonResponse(result, result.ok ? 200 : 502);
            })();
          }

          case "memoryReprocess": {
            return (async () => {
              let body: { bank?: unknown } = {};
              try {
                const raw = await req.text();
                body = raw ? JSON.parse(raw) : {};
              } catch {
                return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
              }
              const result = await handleMemoryReprocess(freshConfig(), body);
              return jsonResponse(result, result.ok ? 200 : 400);
            })();
          }

          case "memoryRefreshModel": {
            return (async () => {
              let body: { bank?: unknown; modelId?: unknown } = {};
              try {
                const raw = await req.text();
                body = raw ? JSON.parse(raw) : {};
              } catch {
                return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
              }
              const result = await handleMemoryRefreshModel(freshConfig(), body);
              return jsonResponse(result, result.ok ? 200 : 400);
            })();
          }

          case "memoryBuildProfile": {
            return (async () => {
              let body: { bank?: unknown } = {};
              try {
                const raw = await req.text();
                body = raw ? JSON.parse(raw) : {};
              } catch {
                return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
              }
              const result = await handleMemoryBuildProfile(freshConfig(), body);
              return jsonResponse(result, result.ok ? 200 : 400);
            })();
          }

          case "getAgentAccounts": {
            const agentName = route.params.name;
            if (!config.agents[agentName]) {
              return jsonResponse({ ok: false, error: `Unknown agent: ${agentName}` }, 404);
            }
            return jsonResponse(handleGetAgentAccounts(config, agentName));
          }

          case "getAgentConfig": {
            const agentName = route.params.name;
            if (!config.agents[agentName]) {
              return jsonResponse({ ok: false, error: `Unknown agent: ${agentName}` }, 404);
            }
            return jsonResponse(handleGetAgentConfig(config, agentName));
          }
        }
      }

      // Static files — no auth required
      let filePath = pathname === "/" ? "/index.html" : pathname;
      const fullPath = join(uiDir, filePath);

      // Resolve symlinks before comparing so traversal via symlinked uiDir
      // (or symlinks inside it) can't escape the static root.
      if (!existsSync(fullPath)) {
        return new Response("Not Found", { status: 404 });
      }
      let realFullPath: string;
      try {
        realFullPath = realpathSync(fullPath);
      } catch {
        return new Response("Not Found", { status: 404 });
      }
      const rel = relative(uiDir, realFullPath);
      if (rel.startsWith("..") || resolve(uiDir, rel) !== realFullPath) {
        return new Response("Forbidden", { status: 403 });
      }

      const ext = extname(realFullPath);
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      const content = readFileSync(realFullPath);
      return new Response(content, {
        headers: { "Content-Type": contentType },
      });
    },

    websocket: {
      open(_ws) {
        // No-op; tracking handled per-subscription
      },
      close(ws) {
        // Stop the live-log poll loop on disconnect.
        const interval = (ws as any)._logInterval;
        if (interval) {
          clearInterval(interval);
          (ws as any)._logInterval = null;
        }
      },
      message(ws, message) {
        // Handle subscription requests for agent logs.
        //
        // The web container is dockerless BY DESIGN (no docker binary/
        // socket — security hardening), so it CANNOT `docker logs -f` to
        // follow a stream. Instead we POLL hostd's `agent_logs` verb (hostd
        // runs as root with the docker socket) every few seconds and push
        // the latest tail as a REPLACE. hostd caps its tail at 4 KiB, so a
        // very high-volume container shows only the last ~tail — acceptable
        // for this at-a-glance view. The client merges/replaces the panel.
        let data: any;
        try {
          data = JSON.parse(String(message));
        } catch {
          return; // Ignore invalid messages
        }

        const clearLogInterval = () => {
          const existing = (ws as any)._logInterval;
          if (existing) {
            clearInterval(existing);
            (ws as any)._logInterval = null;
          }
        };

        if (data && data.type === "unsubscribe") {
          clearLogInterval();
          return;
        }

        if (data && data.type === "subscribe" && data.agent) {
          const agentName = String(data.agent).replace(/[^a-zA-Z0-9_-]/g, "");
          // Only allow subscribing to agents that actually exist in config.
          if (!agentName || !config.agents[agentName]) {
            try {
              ws.send(JSON.stringify({ type: "error", error: "Unknown agent" }));
            } catch {}
            return;
          }

          // Drop any existing poll loop before starting a new one (the
          // client only views one agent's logs at a time per socket).
          clearLogInterval();

          // One poll: read the tail via hostd, push a REPLACE. On a hard
          // error (hostd down / denied) surface it once and stop the loop
          // so we don't spin pushing the same failure every 3s.
          const poll = async () => {
            let result: Awaited<ReturnType<typeof fetchAgentLogsViaHostd>>;
            try {
              result = await fetchAgentLogsViaHostd(agentName, LOG_POLL_TAIL_LINES);
            } catch (err) {
              // fetchAgentLogsViaHostd never throws, but belt-and-braces.
              try {
                ws.send(JSON.stringify({
                  type: "log_error",
                  agent: agentName,
                  data: err instanceof Error ? err.message : String(err),
                }));
              } catch {}
              clearLogInterval();
              return;
            }
            if (result.ok) {
              try {
                ws.send(JSON.stringify({
                  type: "log",
                  agent: agentName,
                  data: result.logs,
                  replace: true,
                }));
              } catch {
                // Client gone mid-send — stop polling.
                clearLogInterval();
              }
            } else {
              try {
                ws.send(JSON.stringify({
                  type: "log_error",
                  agent: agentName,
                  data: result.error,
                }));
              } catch {}
              // Don't keep hammering hostd on a hard error.
              clearLogInterval();
            }
          };

          // Immediate first poll, then a steady cadence.
          void poll();
          (ws as any)._logInterval = setInterval(() => void poll(), LOG_POLL_INTERVAL_MS);
        }
      },
    },
  });

  const displayHost = hostname === "0.0.0.0" ? "<host-ip>" : hostname;
  console.log(`Switchroom dashboard running at http://${displayHost}:${server.port}`);
  if (localhostOnly) {
    console.log(
      `  Tailscale users: run \`tailscale serve --bg --https / http://localhost:${server.port}\`` +
      ` then browse to https://<tailnet-name>.ts.net/ — tailnet members are authenticated automatically.`,
    );
  } else {
    console.log("  Network-accessible — token required for all requests.");
  }
  return { token };
}
