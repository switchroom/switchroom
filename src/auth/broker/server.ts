/**
 * switchroom-auth-broker server — sole writer of per-agent
 * `<agentDir>/.claude/.credentials.json` and canonical owner of the OAuth
 * refresh loop for every Anthropic account on the host (RFC H).
 *
 * Architectural shape mirrors `src/vault/broker/server.ts`. All three
 * kinds of caller share the same path layout
 * `/run/switchroom/auth-broker/<name>/sock` — the *kind* of caller
 * (agent / consumer / operator) is resolved by config lookup in
 * `peercred.classify()`, not by path shape. Per-bind mode/UID still
 * differs by kind:
 *   - Agent peer       — mode 0660, chowned to allocateAgentUid(name).
 *   - Consumer peer    — mode 0600, chowned to consumers[].uid (default 0).
 *   - Operator peer    — mode 0600, chowned to --operator-uid at the
 *                        reserved `operator/` subpath.
 *   - NDJSON over UDS, 64 KiB frame cap, identity derived from bind path.
 *
 * Verbs (RFC H §4.3): get-credentials, list-state, set-active,
 * mark-exhausted, refresh-account, add-account, rm-account, set-override.
 */

import * as net from "node:net";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { closeSync, openSync, writeSync } from "node:fs";
import * as constants from "node:constants";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import { allocateAgentUid } from "../../agents/compose.js";
import { resolveAgentsDir } from "../../config/loader.js";
import { fetchQuota, type QuotaResult } from "../quota.js";
import type { AuthConfig, AuthConsumer, SwitchroomConfig } from "../../config/schema.js";
import { atomicWriteFileSync, atomicWriteJsonSync } from "../../util/atomic.js";
import {
  REFRESH_THRESHOLD_MS,
  refreshAccountIfNeeded,
  type AccountRefreshOptions,
} from "../account-refresh.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { GoogleProvider } from "./google-provider.js";
import {
  googleAccountExists,
  listGoogleAccounts,
  readGoogleAccountCredentials,
  removeGoogleAccount,
  validateGoogleAccountLabel,
  writeGoogleAccountCredentials,
} from "./google-storage.js";
import { ProviderRegistry, type ProviderName } from "./provider.js";
import type { GoogleCredentialsShape } from "./protocol.js";
import {
  accountCredentialsPath,
  accountDir,
  accountExists,
  accountsRoot,
  chownAccountFiles,
  enrichClaudeCreds,
  listAccounts,
  patchAccountMeta,
  readAccountCredentials,
  readAccountMeta,
  validateAccountLabel,
  writeAccountCredentials,
  type AccountCredentials,
} from "../account-store.js";
import {
  classify,
  RESERVED_NAMES,
  socketPathToName,
  validateConsumerNames,
  type AuthConfigShape,
  type Identity,
} from "./peercred.js";
import {
  decodeRequest,
  encodeError,
  encodeSuccess,
  MAX_FRAME_BYTES,
  type ErrorCode,
  type Request,
} from "./protocol.js";

const AUTH_BROKER_ROOT = "/run/switchroom/auth-broker";

/** Minute between refresh-loop polls. The tick is cheap (it skips per-account
 * when remainingMs > threshold). Frequent enough that a 60-min threshold
 * reliably refreshes well before the 5-min claude window. */
const REFRESH_TICK_INTERVAL_MS = 60 * 1000;

/** Default `mark-exhausted.until` when caller omits the arg. 5 hours — matches
 * the legacy quota-store default and Anthropic's typical 429 reset window. */
const MARK_EXHAUSTED_DEFAULT_MS = 5 * 60 * 60 * 1000;

/** Audit-log size cap before rotation (10 MB, per RFC §4.4). */
const AUDIT_ROTATE_BYTES = 10 * 1024 * 1024;
const AUDIT_KEEP = 5;
/**
 * Maximum bytes per audit row. Sized below Linux's PIPE_BUF (4096) so a
 * single `write(2)` to an O_APPEND fd is atomic — guarantees no torn
 * row on SIGKILL mid-write. Real rows are <300 bytes; this is defence
 * against runaway error strings.
 */
const AUDIT_LINE_MAX = 4000;

/** Threshold-violation counter file. */
interface ThresholdViolations {
  [label: string]: number;
}

interface QuotaEntry {
  exhausted_until: number;
}
interface QuotaState {
  [label: string]: QuotaEntry;
}

interface ShaIndex {
  [label: string]: string;
}

interface ConsumerLastSeen {
  [name: string]: number;
}

interface Listener {
  server: net.Server;
  identity: Identity;
  socketPath: string;
}

export interface AuthBrokerOptions {
  /** Path to switchroom.yaml. When omitted the broker calls `loadConfig()`. */
  configPath?: string;
  /** Operator UID; when set, the operator socket is bound. */
  operatorUid?: number;
  /** Override $HOME (tests). */
  home?: string;
  /** Override the state-dir root (defaults to ~/.switchroom/state/auth-broker). */
  stateDir?: string;
  /** Override the per-listener socket root (defaults to /run/switchroom/auth-broker). */
  socketRoot?: string;
  /** Override the OAuth refresh fetcher (tests). */
  fetcher?: AccountRefreshOptions["fetcher"];
  /** Override now() (tests). */
  now?: () => number;
  /** When true, skip the auto refresh-loop interval. Tests drive the tick manually. */
  disableRefreshLoop?: boolean;
  /** When true, skip writing the healthy marker file. */
  skipHealthyMarker?: boolean;
  /**
   * Test-only: replace `loadConfig` with an injected config. Production
   * never sets this; the entry point reads from disk.
   */
  _testConfig?: SwitchroomConfig;
}

/* ───────────────────────── Helpers ───────────────────────── */

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function nowMs(): number {
  return Date.now();
}

/**
 * Apply `enrichClaudeCreds` to a JSON string from the source-of-truth
 * credentials.json, returning a JSON string for the per-agent
 * `.credentials.json` mirror.
 *
 * Returns the source string verbatim (byte-identical) when:
 *   - JSON is malformed (broker leaves the diagnostic to claude;
 *     synthesizing a fake shape would mask the real corruption).
 *   - There's nothing to enrich — `claudeAiOauth` is absent OR both
 *     `scopes` (non-empty array) and `subscriptionType` are already
 *     present. Avoids whitespace churn on the per-agent mirror when
 *     the source is already in the post-#1280 shape.
 *
 * Exported for tests.
 */
export function enrichMirrorContent(sourceJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceJson);
  } catch {
    return sourceJson;
  }
  const value = parsed as AccountCredentials;
  const oauth = value?.claudeAiOauth;
  if (!oauth) return sourceJson;
  const hasScopes = Array.isArray(oauth.scopes) && oauth.scopes.length > 0;
  const hasSubscription =
    typeof oauth.subscriptionType === "string" && oauth.subscriptionType.length > 0;
  if (hasScopes && hasSubscription) return sourceJson;
  return JSON.stringify(enrichClaudeCreds(value), null, 2);
}

function configToShape(cfg: SwitchroomConfig): AuthConfigShape {
  const auth = cfg.auth ?? {};
  const agentsMap = cfg.agents ?? {};
  const adminAgents = Object.entries(agentsMap)
    .filter(([, a]) => (a as { admin?: boolean }).admin === true)
    .map(([name]) => name);
  return {
    agents: Object.keys(agentsMap),
    consumers: (auth.consumers ?? []).map((c) => c.name),
    adminAgents,
  };
}

/* ───────────────────────── Server class ───────────────────────── */

export class AuthBroker {
  private config: SwitchroomConfig;
  private listeners = new Map<string, Listener>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private stateDir: string;
  private socketRoot: string;
  private home: string | undefined;
  private now: () => number;
  private operatorUid: number | undefined;
  private fetcher: AccountRefreshOptions["fetcher"];
  /**
   * Provider registry — RFC G Phase 3b.1b. AnthropicProvider is registered
   * unconditionally at startup (the broker's existing surface is
   * Anthropic-only). Phase 3b.2 will register GoogleProvider alongside.
   * The registry is consulted for: (a) gating provider-aware verbs at
   * the wire layer, (b) credential-shape validation on add-account,
   * (c) expiry-extraction on refresh-tick. The actual Anthropic refresh
   * exchange continues to be invoked directly via account-refresh.ts —
   * see AnthropicProvider class docstring for rationale.
   */
  private readonly providers: ProviderRegistry;

  // In-memory state mirrored to disk.
  private quota: QuotaState = {};
  private shaIndex: ShaIndex = {};
  private thresholdViolations: ThresholdViolations = {};
  /** Last `expiresAt` the broker wrote per label — drives threshold-violation. */
  private lastWrittenExpiresAt = new Map<string, number | undefined>();
  /** Refresh leases held while a POST is in flight (in-process). */
  private refreshInFlight = new Set<string>();
  private consumerLastSeen: ConsumerLastSeen = {};
  /** Set on first observed EPERM from chownSync — produces one warning,
   *  not one per write. Production runs with CAP_CHOWN so this stays
   *  false; dev/test boxes without the cap stay quiet after the
   *  first heads-up. */
  private capChownWarned = false;

  private closed = false;

  constructor(
    config: SwitchroomConfig,
    private readonly opts: AuthBrokerOptions = {},
  ) {
    this.config = config;
    this.home = opts.home;
    this.now = opts.now ?? nowMs;
    this.operatorUid = opts.operatorUid;
    this.fetcher = opts.fetcher;
    this.stateDir =
      opts.stateDir ?? resolve(this.homeRoot(), ".switchroom", "state", "auth-broker");
    this.socketRoot = opts.socketRoot ?? AUTH_BROKER_ROOT;

    // Phase 3b.1b — register the Anthropic provider unconditionally.
    // Phase 3b.2b — conditionally register Google when the
    // `google_workspace:` config block is set (carries the OAuth
    // client id/secret the provider needs). No client config = no
    // Google provider loaded; the broker still rejects
    // `provider: "google"` requests via registry.has() per Phase 3b.1.
    //
    // **Known foot-gun (tracked):** the `google_client_id` / `_secret`
    // schema fields accept `vault:<key>` references (per
    // `src/config/schema.ts:759`); `src/cli/drive.ts:446-448`
    // resolves them via `resolveMaybeVaultRef`. The broker passes the
    // raw config string verbatim, so a vault-ref config would
    // silently send a literal `"vault:..."` string to Google's token
    // endpoint and fail. Resolution requires broker-side vault
    // access (its own architectural piece — broker doesn't currently
    // talk to vault-broker). Until then operators must use plain
    // strings in `google_workspace.{google_client_id, google_client_secret}`
    // — the OAuth client identity isn't a high-secrecy value (it's
    // operator-owned, not account-owned). Refresh-tick (this file's
    // `refreshOneGoogleAccount`) lands without vault-ref support.
    //
    // **Known limitation:** `reload()` does NOT re-run provider
    // registration. An operator who adds `google_workspace:` to a
    // running broker and SIGHUPs will need to restart the broker
    // for the provider to be picked up. Acceptable for v1; track
    // as a future-hardening item.
    this.providers = new ProviderRegistry();
    this.providers.register(new AnthropicProvider());
    const googleClientId = config.google_workspace?.google_client_id;
    const googleClientSecret = config.google_workspace?.google_client_secret;
    if (googleClientId !== undefined && googleClientSecret !== undefined) {
      this.providers.register(
        new GoogleProvider({
          clientId: googleClientId,
          clientSecret: googleClientSecret,
          fetcher: opts.fetcher as typeof fetch | undefined,
        }),
      );
    }

    this.assertConfigConsistent(config);
  }

  private homeRoot(): string {
    return this.home ?? process.env.HOME ?? "/root";
  }

  /* ─── Lifecycle ─────────────────────────────────────────────── */

  async start(): Promise<void> {
    // umask BEFORE any mkdir so mode-bits are not loosened by inheritance.
    process.umask(0o077);

    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.stateDir, "refresh-lease"), { recursive: true, mode: 0o700 });
    mkdirSync(this.socketRoot, { recursive: true, mode: 0o755 });

    this.loadStateFromDisk();
    this.assertDriftFree();

    // Bind a listener per agent + per consumer + operator (if requested).
    for (const agentName of Object.keys(this.config.agents ?? {})) {
      await this.bindAgentListener(agentName);
    }
    for (const consumer of this.config.auth?.consumers ?? []) {
      await this.bindConsumerListener(consumer);
    }
    if (this.operatorUid !== undefined) {
      await this.bindOperatorListener(this.operatorUid);
    }

    // Refresh loop — every minute, walk every account and fire when threshold hit.
    if (!this.opts.disableRefreshLoop) {
      this.refreshTimer = setInterval(() => {
        this.refreshTick().catch((err) => {
          this.logErr(`refresh-tick threw: ${(err as Error).message}`);
        });
      }, REFRESH_TICK_INTERVAL_MS);
      this.refreshTimer.unref();
    }

    // Boot fanout — write per-agent .credentials.json mirrors for every
    // agent whose effective account exists on disk. Without this, a fresh
    // boot leaves agents without a mirror until the next setActive() RPC
    // or threshold-driven refreshTick(): with a far-future expiresAt the
    // refresh tick no-ops indefinitely, and `switchroom update` fleets
    // come back logged-out because the new RFC-H runtime reads the file,
    // not the env var the legacy path injected. fanoutAll is a no-op when
    // auth.active and per-agent overrides are both unset (returns 0).
    const fanned = this.fanoutAll();
    if (fanned.length > 0) {
      process.stdout.write(
        `auth-broker: boot fanout wrote ${fanned.length} mirror(s) — ${fanned.join(", ")}\n`,
      );
    }

    // Healthy marker — docker healthcheck reads this.
    if (!this.opts.skipHealthyMarker) {
      try {
        const healthyPath = join(this.stateDir, "healthy");
        writeFileSync(healthyPath, String(this.now()) + "\n", { mode: 0o600 });
      } catch (err) {
        this.logErr(`failed to write healthy marker: ${(err as Error).message}`);
      }
    }

    process.stdout.write(
      `auth-broker: ${this.listeners.size} listener(s) bound under ${this.socketRoot}\n`,
    );
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const [sock, lis] of this.listeners) {
      try { lis.server.close(); } catch { /* ignore */ }
      try { if (existsSync(sock)) unlinkSync(sock); } catch { /* ignore */ }
    }
    this.listeners.clear();
    try {
      const healthyPath = join(this.stateDir, "healthy");
      if (existsSync(healthyPath)) unlinkSync(healthyPath);
    } catch { /* ignore */ }
  }

  /** SIGHUP — re-read switchroom.yaml and reconcile listeners. */
  async reload(config: SwitchroomConfig): Promise<void> {
    this.assertConfigConsistent(config);
    const prev = this.config;
    this.config = config;

    const wanted = new Set<string>();
    for (const name of Object.keys(config.agents ?? {})) {
      wanted.add(this.agentSocketPath(name));
    }
    for (const c of config.auth?.consumers ?? []) {
      wanted.add(this.consumerSocketPath(c.name));
    }
    if (this.operatorUid !== undefined) {
      wanted.add(this.operatorSocketPath());
    }

    // Close listeners we no longer want.
    for (const [sock, lis] of [...this.listeners]) {
      if (!wanted.has(sock)) {
        try { lis.server.close(); } catch { /* ignore */ }
        try { if (existsSync(sock)) unlinkSync(sock); } catch { /* ignore */ }
        this.listeners.delete(sock);
      }
    }

    // Bind any new listeners.
    for (const name of Object.keys(config.agents ?? {})) {
      const path = this.agentSocketPath(name);
      if (!this.listeners.has(path)) {
        await this.bindAgentListener(name);
      }
    }
    for (const c of config.auth?.consumers ?? []) {
      const path = this.consumerSocketPath(c.name);
      if (!this.listeners.has(path)) {
        await this.bindConsumerListener(c);
      }
    }
    if (this.operatorUid !== undefined && !this.listeners.has(this.operatorSocketPath())) {
      await this.bindOperatorListener(this.operatorUid);
    }

    void prev; // currently unused — placeholder for future diff metrics.
  }

  /* ─── Path helpers ──────────────────────────────────────────── */

  private agentSocketPath(name: string): string {
    return join(this.socketRoot, name, "sock");
  }
  private consumerSocketPath(name: string): string {
    return join(this.socketRoot, name, "sock");
  }
  private operatorSocketPath(): string {
    return join(this.socketRoot, "operator", "sock");
  }

  /* ─── Listener binding ──────────────────────────────────────── */

  private async bindAgentListener(agentName: string): Promise<void> {
    if (RESERVED_NAMES.has(agentName)) {
      this.logErr(`refusing to bind reserved agent name '${agentName}'`);
      return;
    }
    const sockPath = this.agentSocketPath(agentName);
    const uid = allocateAgentUid(agentName);
    // Admin authority sourced from the per-agent `admin: true` flag —
    // same source of truth as the gateway's /agents / /restart / /update
    // intercepts (PR #1258). One knob, not two.
    const adminFlag = (this.config.agents?.[agentName] as { admin?: boolean } | undefined)?.admin === true;
    await this.bindListener(sockPath, uid, 0o660, {
      kind: "agent",
      name: agentName,
      admin: adminFlag,
    });
  }

  private async bindConsumerListener(consumer: AuthConsumer): Promise<void> {
    if (RESERVED_NAMES.has(consumer.name)) {
      this.logErr(`refusing to bind reserved consumer name '${consumer.name}'`);
      return;
    }
    const sockPath = this.consumerSocketPath(consumer.name);
    const uid = consumer.uid ?? 0;
    await this.bindListener(sockPath, uid, 0o600, { kind: "consumer", name: consumer.name });
  }

  private async bindOperatorListener(operatorUid: number): Promise<void> {
    const sockPath = this.operatorSocketPath();
    await this.bindListener(sockPath, operatorUid, 0o600, { kind: "operator" });
  }

  /**
   * Create the parent dir with mode 0700 owned by `targetUid`, then bind the
   * socket and chown it. Uses mode-on-mkdir (no mkdir-then-chmod race).
   */
  private async bindListener(
    sockPath: string,
    targetUid: number,
    sockMode: number,
    identity: Identity,
  ): Promise<void> {
    const dir = dirname(sockPath);

    // Reset parent dir to root:root 0700 before binding (mirrors vault-broker).
    if (existsSync(dir)) {
      try { chownSync(dir, 0, 0); } catch { /* dev / no CAP_CHOWN */ }
      try { chmodSync(dir, 0o700); } catch { /* idempotent */ }
    } else {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    // Remove stale socket if present.
    if (existsSync(sockPath)) {
      try { unlinkSync(sockPath); } catch { /* tolerate */ }
    }

    await new Promise<void>((resolveP, rejectP) => {
      const server = net.createServer((sock) => {
        this.handleConnection(sock, sockPath, identity);
      });
      server.on("error", (err) => rejectP(err));
      server.listen(sockPath, () => {
        try { chmodSync(sockPath, sockMode); } catch { /* tolerate */ }
        try { chownSync(sockPath, targetUid, targetUid); } catch { /* dev */ }
        try { chownSync(dir, targetUid, targetUid); } catch { /* dev */ }
        this.listeners.set(sockPath, { server, identity, socketPath: sockPath });
        resolveP();
      });
    });
  }

  /* ─── Connection plumbing ───────────────────────────────────── */

  private handleConnection(
    socket: net.Socket,
    sockPath: string,
    boundIdentity: Identity,
  ): void {
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      if (Buffer.byteLength(buf, "utf-8") > MAX_FRAME_BYTES) {
        socket.end(encodeError("0", "INVALID_ARGS", "frame exceeds 64KiB limit"));
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        this.handleRequest(socket, sockPath, boundIdentity, line).catch((err) => {
          this.logErr(`unhandled error: ${(err as Error).message}`);
        });
      }
    });
    socket.on("error", () => { try { socket.destroy(); } catch { /* ignore */ } });

    if (boundIdentity.kind === "consumer") {
      this.consumerLastSeen[boundIdentity.name] = this.now();
    }
  }

  private async handleRequest(
    socket: net.Socket,
    sockPath: string,
    boundIdentity: Identity,
    line: string,
  ): Promise<void> {
    let req: Request;
    let reqId = "0";
    try {
      req = decodeRequest(line);
      reqId = req.id;
    } catch (err) {
      socket.write(
        encodeError(reqId, "INVALID_ARGS", (err as Error).message),
      );
      return;
    }

    // Re-classify by socket path against the CURRENT config so a hot-reload
    // takes effect immediately for new requests on existing connections.
    const identity =
      classify(sockPath, configToShape(this.config)) ?? boundIdentity;

    try {
      switch (req.op) {
        case "get-credentials": {
          // Phase 3b.4 — provider field routes between Anthropic
          // (existing path-as-identity flow) and Google (per-agent
          // google_workspace.account + per-account ACL gate).
          const provider: ProviderName = req.provider ?? "anthropic";
          if (!this.providers.has(provider)) {
            socket.write(
              encodeError(
                reqId,
                "INVALID_ARGS",
                `provider '${provider}' is not registered with this broker (only ${this.providers.names().join(", ")} available)`,
              ),
            );
            break;
          }
          if (provider === "anthropic") {
            await this.opGetCredentials(socket, reqId, identity);
            break;
          }
          if (provider === "google") {
            await this.opGoogleGetCredentials(socket, reqId, identity);
            break;
          }
          socket.write(
            encodeError(
              reqId,
              "INTERNAL",
              `unhandled provider '${provider}' in get-credentials dispatch`,
            ),
          );
          break;
        }
        case "list-state":
          await this.opListState(socket, reqId, identity);
          break;
        case "set-active": {
          // Phase 3b.1b: `set-active` is fleet-wide active-account swap,
          // an Anthropic-only concept by design (Google's account-active
          // model is per-agent via google_accounts.enabled_for[]). Reject
          // any non-Anthropic provider regardless of registry state.
          const provider: ProviderName = req.provider ?? "anthropic";
          if (provider !== "anthropic") {
            socket.write(
              encodeError(
                reqId,
                "INVALID_ARGS",
                `set-active is Anthropic-only — Google's account-active model is per-agent via google_accounts.enabled_for[]`,
              ),
            );
            break;
          }
          await this.opSetActive(socket, reqId, identity, req.account);
          break;
        }
        case "mark-exhausted":
          await this.opMarkExhausted(socket, reqId, identity, req.until);
          break;
        case "refresh-account": {
          const provider: ProviderName = req.provider ?? "anthropic";
          // Phase 3b.1b: gate via registry.has() — when 3b.2 registers
          // Google, this naturally accepts provider:"google" requests.
          // For now Anthropic is the only registered provider but the
          // dispatch shape no longer hardcodes the name.
          if (!this.providers.has(provider)) {
            socket.write(
              encodeError(
                reqId,
                "INVALID_ARGS",
                `provider '${provider}' is not registered with this broker (only ${this.providers.names().join(", ")} available)`,
              ),
            );
            break;
          }
          // Anthropic refresh continues via account-refresh.ts directly
          // per AnthropicProvider class docstring. When Phase 3b.2 lands
          // Google, this dispatcher will route by provider — for now the
          // Anthropic short-circuit holds.
          if (provider === "anthropic") {
            await this.opRefreshAccount(socket, reqId, identity, req.account);
            break;
          }
          // Future-provider path — for 3b.2 Google support.
          socket.write(
            encodeError(
              reqId,
              "INVALID_ARGS",
              `refresh-account dispatch through provider '${provider}' storage path lands in Phase 3b.2c (vault-broker-mediated, not direct-to-disk like Anthropic)`,
            ),
          );
          break;
        }
        case "add-account": {
          const provider: ProviderName = req.provider ?? "anthropic";
          if (!this.providers.has(provider)) {
            socket.write(
              encodeError(
                reqId,
                "INVALID_ARGS",
                `provider '${provider}' is not registered with this broker (only ${this.providers.names().join(", ")} available)`,
              ),
            );
            break;
          }
          // Validate the credentials variant matches the provider via
          // the provider's own shape validator. Replaces the hardcoded
          // "claudeAiOauth in req.credentials" check.
          const validationError = this.providers
            .lookup(provider)
            .validateCredentialShape(req.credentials);
          if (validationError !== null) {
            socket.write(
              encodeError(
                reqId,
                "INVALID_ARGS",
                `provider '${provider}' rejected credentials: ${validationError}`,
              ),
            );
            break;
          }
          // Phase 3b.2c — providers dispatch by name.
          if (provider === "anthropic") {
            const anthropicCreds = req.credentials as {
              claudeAiOauth: AccountCredentials["claudeAiOauth"];
            };
            await this.opAddAccount(
              socket,
              reqId,
              identity,
              req.label,
              anthropicCreds,
              req.replace ?? false,
            );
            break;
          }
          // Google: writes to broker's own state dir under
          // `~/.switchroom/state/auth-broker/google/<account>/`.
          // Phase 3b.2d will migrate to vault-broker-mediated storage
          // per RFC G v3 §4.4.
          if (provider === "google") {
            const googleCreds = req.credentials as GoogleCredentialsShape;
            await this.opGoogleAddAccount(
              socket,
              reqId,
              identity,
              req.label,
              googleCreds,
              req.replace ?? false,
            );
            break;
          }
          // Unreachable today (registry has() rejects unknown
          // providers above), but defensive.
          socket.write(
            encodeError(
              reqId,
              "INTERNAL",
              `unhandled provider '${provider}' in add-account dispatch`,
            ),
          );
          break;
        }
        case "rm-account": {
          const provider: ProviderName = req.provider ?? "anthropic";
          if (!this.providers.has(provider)) {
            socket.write(
              encodeError(
                reqId,
                "INVALID_ARGS",
                `provider '${provider}' is not registered with this broker (only ${this.providers.names().join(", ")} available)`,
              ),
            );
            break;
          }
          if (provider === "anthropic") {
            await this.opRmAccount(socket, reqId, identity, req.label);
            break;
          }
          if (provider === "google") {
            await this.opGoogleRmAccount(socket, reqId, identity, req.label);
            break;
          }
          socket.write(
            encodeError(
              reqId,
              "INTERNAL",
              `unhandled provider '${provider}' in rm-account dispatch`,
            ),
          );
          break;
        }
        case "set-override":
          await this.opSetOverride(socket, reqId, identity, req.agent, req.account);
          break;
        case "list-google-accounts":
          await this.opListGoogleAccounts(socket, reqId, identity);
          break;
        case "probe-quota":
          await this.opProbeQuota(
            socket,
            reqId,
            identity,
            req.accounts,
            req.timeoutMs,
          );
          break;
      }
    } catch (err) {
      socket.write(
        encodeError(reqId, "INTERNAL", (err as Error).message),
      );
    }
  }

  /* ─── Authorization ─────────────────────────────────────────── */

  private isAdmin(identity: Identity): boolean {
    if (identity.kind === "operator") return true;
    if (identity.kind === "agent") return identity.admin;
    return false; // consumers can't be admin
  }

  private respondForbidden(socket: net.Socket, id: string, why: string): void {
    socket.write(encodeError(id, "FORBIDDEN", why));
  }

  /** Resolve the account a caller is bound to (used by get-credentials / mark-exhausted). */
  private callerAccount(identity: Identity): string | null {
    const auth = this.config.auth;
    if (!auth) return null;
    if (identity.kind === "operator") return auth.active ?? null;
    if (identity.kind === "consumer") {
      const c = (auth.consumers ?? []).find((x) => x.name === identity.name);
      return c?.account ?? null;
    }
    // agent
    const agent = (this.config.agents ?? {})[identity.name];
    const override = agent?.auth?.override;
    if (override) return override;
    return auth.active ?? null;
  }

  /* ─── Op handlers ───────────────────────────────────────────── */

  private async opGetCredentials(
    socket: net.Socket,
    id: string,
    identity: Identity,
  ): Promise<void> {
    const account = this.callerAccount(identity);
    if (!account) {
      this.audit({ op: "get-credentials", identity, ok: false, error: "no-active-account" });
      socket.write(encodeError(id, "ACCOUNT_NOT_FOUND", "no active account configured"));
      return;
    }
    const creds = readAccountCredentials(account, this.home);
    if (!creds) {
      this.audit({ op: "get-credentials", identity, account, ok: false, error: "missing-credentials" });
      socket.write(encodeError(id, "ACCOUNT_NOT_FOUND", `no credentials for account '${account}'`));
      return;
    }
    const expiresAt = creds.claudeAiOauth?.expiresAt;
    this.audit({ op: "get-credentials", identity, account, ok: true });
    socket.write(encodeSuccess(id, { account, credentials: creds, expiresAt }));
  }

  private async opListState(
    socket: net.Socket,
    id: string,
    identity: Identity,
  ): Promise<void> {
    const auth = this.config.auth ?? {};
    const accounts = listAccounts(this.home).map((label) => {
      const creds = readAccountCredentials(label, this.home);
      const meta = readAccountMeta(label, this.home);
      const q = this.quota[label];
      const exhausted = q !== undefined && q.exhausted_until > this.now();
      return {
        label,
        expiresAt: creds?.claudeAiOauth?.expiresAt,
        exhausted,
        exhausted_until: q?.exhausted_until,
        threshold_violations: this.thresholdViolations[label] ?? 0,
        last_refreshed_at: meta?.lastRefreshedAt,
      };
    });
    const agents = Object.entries(this.config.agents ?? {}).map(([name, agent]) => {
      const override = agent.auth?.override ?? null;
      const account = override ?? auth.active ?? "";
      return { name, account, override };
    });
    const consumers = (auth.consumers ?? []).map((c) => ({
      name: c.name,
      account: c.account,
      last_seen_at: this.consumerLastSeen[c.name] ?? null,
    }));
    this.audit({ op: "list-state", identity, ok: true });
    socket.write(
      encodeSuccess(id, {
        active: auth.active ?? "",
        fallback_order: auth.fallback_order ?? [],
        accounts,
        agents,
        consumers,
      }),
    );
  }

  /**
   * Inventory of Google accounts the broker has stored on disk.
   * Reads `~/.switchroom/state/auth-broker/google/<account>/credentials.json`
   * for each account and returns metadata only — refresh + access
   * tokens stay on disk. Sorted by account email for stable output.
   *
   * Distinct from `list-state` (Anthropic-shaped fleet snapshot). The
   * Google equivalent for the operator-facing matrix lives in YAML
   * (`google_accounts.<email>.enabled_for[]`); this op exists so the
   * `auth google account list` verb can confirm the broker actually
   * holds the credentials the YAML claims.
   *
   * No ACL — same posture as `list-state`. Identity is recorded in the
   * audit log but every caller that reaches the broker can call this.
   */
  private async opListGoogleAccounts(
    socket: net.Socket,
    id: string,
    identity: Identity,
  ): Promise<void> {
    const accounts = listGoogleAccounts(this.stateDir)
      .map((account) => {
        const creds = readGoogleAccountCredentials(this.stateDir, account);
        if (!creds) return null;
        return {
          account,
          expiresAt: creds.googleOauth.expiresAt,
          scope: creds.googleOauth.scope,
          clientId: creds.googleOauth.clientId,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => a.account.localeCompare(b.account));
    this.audit({ op: "list-google-accounts", identity, ok: true });
    socket.write(encodeSuccess(id, { accounts }));
  }

  /**
   * Probe live Anthropic quota for a set of accounts. Reads each
   * account's stored accessToken (broker-owned source of truth at
   * `~/.switchroom/accounts/<label>/credentials.json`) and calls
   * Anthropic's `/v1/messages` with the OAuth-CLI header shape;
   * returns the parsed rate-limit-utilization headers.
   *
   * Why the broker owns this: the gateway lives in the agent
   * container and post-RFC-H has no access to account-level
   * credentials.json (the broker fanout writes only the per-agent
   * `.claude/.credentials.json` mirror, not the account-level
   * source). Doing the probe broker-side keeps accessTokens off
   * the gateway entirely.
   *
   * Probes run in parallel across the input list. Each individual
   * failure becomes a `{ ok: false, reason }` entry — the op never
   * hard-errors unless the request itself is malformed.
   *
   * Audit fires once per probe with `op: "probe-quota"` and the
   * account label; per-account success/failure is captured in
   * `error` field so dashboards can attribute failures.
   */
  private async opProbeQuota(
    socket: net.Socket,
    id: string,
    identity: Identity,
    accounts: readonly string[],
    timeoutMs?: number,
  ): Promise<void> {
    const results = await Promise.all(
      accounts.map(async (label): Promise<{ label: string; result: QuotaResult }> => {
        const creds = readAccountCredentials(label, this.home);
        const token = creds?.claudeAiOauth?.accessToken;
        if (!token) {
          const result: QuotaResult = {
            ok: false,
            reason: "no credentials for account in broker store",
          };
          this.audit({ op: "probe-quota", identity, account: label, ok: false, error: "missing-credentials" });
          return { label, result };
        }
        const result = await fetchQuota({ accessToken: token, timeoutMs });
        this.audit({
          op: "probe-quota",
          identity,
          account: label,
          ok: result.ok,
          error: result.ok ? undefined : result.reason,
        });
        return { label, result };
      }),
    );
    socket.write(encodeSuccess(id, { results }));
  }

  private async opSetActive(
    socket: net.Socket,
    id: string,
    identity: Identity,
    account: string,
  ): Promise<void> {
    if (!this.isAdmin(identity)) {
      this.audit({ op: "set-active", identity, account, ok: false, error: "FORBIDDEN" });
      this.respondForbidden(socket, id, "set-active requires admin");
      return;
    }
    if (!accountExists(account, this.home)) {
      this.audit({ op: "set-active", identity, account, ok: false, error: "ACCOUNT_NOT_FOUND" });
      socket.write(encodeError(id, "ACCOUNT_NOT_FOUND", `account '${account}' not found`));
      return;
    }
    // Mutate in-memory config; persisting back to YAML is the CLI's job
    // (CLI calls set-active via the operator socket *after* writing YAML —
    // see RFC §4.6). The broker accepts the in-memory swap so subsequent
    // get-credentials calls reflect it immediately.
    const cfg: SwitchroomConfig = {
      ...this.config,
      auth: { ...(this.config.auth ?? {}), active: account },
    };
    this.config = cfg;
    const fanned = this.fanoutToAffectedAgents(account);
    this.audit({ op: "set-active", identity, account, ok: true });
    socket.write(encodeSuccess(id, { active: account, fanned }));
  }

  private async opMarkExhausted(
    socket: net.Socket,
    id: string,
    identity: Identity,
    until: number | undefined,
  ): Promise<void> {
    const account = this.callerAccount(identity);
    if (!account) {
      this.audit({ op: "mark-exhausted", identity, ok: false, error: "no-active-account" });
      socket.write(encodeError(id, "ACCOUNT_NOT_FOUND", "no active account configured"));
      return;
    }
    const exhaustedUntil = until ?? this.now() + MARK_EXHAUSTED_DEFAULT_MS;
    this.quota[account] = { exhausted_until: exhaustedUntil };
    this.persistQuota();
    // Fan out next-fallback creds to every agent whose active account is `account`.
    const rolled = this.fanoutFailoverFor(account);
    this.audit({ op: "mark-exhausted", identity, account, ok: true });
    socket.write(encodeSuccess(id, { account, rolled }));
  }

  private async opRefreshAccount(
    socket: net.Socket,
    id: string,
    identity: Identity,
    account: string,
  ): Promise<void> {
    if (!this.isAdmin(identity)) {
      this.audit({ op: "refresh-account", identity, account, ok: false, error: "FORBIDDEN" });
      this.respondForbidden(socket, id, "refresh-account requires admin");
      return;
    }
    if (!accountExists(account, this.home)) {
      this.audit({ op: "refresh-account", identity, account, ok: false, error: "ACCOUNT_NOT_FOUND" });
      socket.write(encodeError(id, "ACCOUNT_NOT_FOUND", `account '${account}' not found`));
      return;
    }
    const result = await this.refreshOneAccount(account, /*force*/ true);
    if (result.kind === "failed") {
      this.audit({ op: "refresh-account", identity, account, ok: false, error: result.error });
      socket.write(encodeError(id, "REFRESH_FAILED", result.error));
      return;
    }
    const creds = readAccountCredentials(account, this.home);
    const expiresAt = creds?.claudeAiOauth?.expiresAt;
    this.audit({ op: "refresh-account", identity, account, ok: true });
    socket.write(encodeSuccess(id, { account, expiresAt }));
  }

  private async opAddAccount(
    socket: net.Socket,
    id: string,
    identity: Identity,
    label: string,
    credentials: AccountCredentials,
    replace: boolean,
  ): Promise<void> {
    if (!this.isAdmin(identity)) {
      this.audit({ op: "add-account", identity, account: label, ok: false, error: "FORBIDDEN" });
      this.respondForbidden(socket, id, "add-account requires admin");
      return;
    }
    try {
      validateAccountLabel(label);
    } catch (err) {
      socket.write(encodeError(id, "INVALID_ARGS", (err as Error).message));
      return;
    }
    if (accountExists(label, this.home) && !replace) {
      this.audit({ op: "add-account", identity, account: label, ok: false, error: "ACCOUNT_ALREADY_EXISTS" });
      socket.write(encodeError(id, "ACCOUNT_ALREADY_EXISTS", `account '${label}' already exists; pass replace:true to overwrite`));
      return;
    }
    try {
      writeAccountCredentials(label, credentials, this.home);
      patchAccountMeta(label, { lastRefreshedAt: this.now() }, this.home);
    } catch (err) {
      socket.write(encodeError(id, "INTERNAL", (err as Error).message));
      return;
    }
    // #1447 (WS1-F1): broker runs as root in production (auth-broker
    // container) and the writes above leave the dir + files root:root.
    // The operator's CLI then can't read them — chown back to the
    // operator UID. Swallow EPERM on dev hosts that lack CAP_CHOWN.
    this.chownAccountFilesIfRoot(label);
    // Re-index sha so a subsequent boot doesn't trip drift detection on the new file.
    const contents = readFileSync(accountCredentialsPath(label, this.home), "utf-8");
    this.shaIndex[label] = sha256Hex(contents);
    this.lastWrittenExpiresAt.set(label, credentials.claudeAiOauth?.expiresAt);
    this.persistShaIndex();
    // Fan out to any agents already pinned to this label.
    this.fanoutToAffectedAgents(label);
    const expiresAt = credentials.claudeAiOauth?.expiresAt;
    this.audit({ op: "add-account", identity, account: label, ok: true, replace });
    socket.write(encodeSuccess(id, { label, expiresAt }));
  }

  private async opRmAccount(
    socket: net.Socket,
    id: string,
    identity: Identity,
    label: string,
  ): Promise<void> {
    if (!this.isAdmin(identity)) {
      this.audit({ op: "rm-account", identity, account: label, ok: false, error: "FORBIDDEN" });
      this.respondForbidden(socket, id, "rm-account requires admin");
      return;
    }
    if (!accountExists(label, this.home)) {
      socket.write(encodeError(id, "ACCOUNT_NOT_FOUND", `account '${label}' not found`));
      return;
    }
    // Refuse to remove if it's the fleet active or any agent's override.
    const auth = this.config.auth ?? {};
    if (auth.active === label) {
      socket.write(encodeError(id, "INVALID_ARGS", `account '${label}' is the fleet active; switch first`));
      return;
    }
    const pinned = Object.entries(this.config.agents ?? {})
      .filter(([, a]) => a.auth?.override === label)
      .map(([n]) => n);
    if (pinned.length > 0) {
      socket.write(encodeError(id, "INVALID_ARGS", `account '${label}' is the override target for agents: ${pinned.join(", ")}`));
      return;
    }
    try {
      rmSync(accountDir(label, this.home), { recursive: true, force: true });
    } catch (err) {
      socket.write(encodeError(id, "INTERNAL", (err as Error).message));
      return;
    }
    delete this.shaIndex[label];
    delete this.quota[label];
    delete this.thresholdViolations[label];
    this.lastWrittenExpiresAt.delete(label);
    this.persistShaIndex();
    this.persistQuota();
    this.persistThresholdViolations();
    this.audit({ op: "rm-account", identity, account: label, ok: true });
    socket.write(encodeSuccess(id, { label }));
  }

  /**
   * RFC G Phase 3b.2c — Google add-account.
   *
   * Storage layout: writes verbatim Google credentials to
   * `<stateDir>/google/<account>/credentials.json` via
   * `google-storage.ts`. Phase 3b.2d (future) will migrate to
   * vault-broker-mediated storage per RFC G v3 §4.4.
   *
   * Differences from Anthropic's opAddAccount:
   *   - Storage location is broker stateDir not `~/.switchroom/accounts/`
   *   - Credentials are GoogleCredentialsShape (`googleOauth: {...}`)
   *     not `claudeAiOauth`
   *   - No fanout to per-agent .credentials.json mirrors — Google
   *     consumers (MCP wrapper) will read via `get-credentials` UDS
   *     when Phase 3b.4 wires the wrapper. Today the credentials sit
   *     in storage waiting for that consumer.
   *   - No sha-index or threshold-violation tracking yet (those are
   *     Anthropic-state machinery; Google parallel state lands when
   *     it's needed — likely Phase 3b.2d alongside the refresh tick
   *     wiring).
   */
  /**
   * RFC G Phase 3b.4 — Google get-credentials.
   *
   * Identity comes from path-as-identity (the agent's bind socket).
   * Account comes from the agent's `google_workspace.account` config
   * field (NOT from the wire — agent can't ask for someone else's
   * Google account). ACL is enforced via
   * `google_accounts.<account>.enabled_for[]` containing the agent.
   *
   * Operator and consumer identities are not (yet) supported for Google
   * get-credentials — the Google ACL model is per-agent, and operators
   * + consumers have different identity models. Return INVALID_ARGS
   * with a clear message until Phase 3b.4b extends the contract if
   * needed.
   */
  private async opGoogleGetCredentials(
    socket: net.Socket,
    id: string,
    identity: Identity,
  ): Promise<void> {
    if (identity.kind !== "agent") {
      socket.write(
        encodeError(
          id,
          "INVALID_ARGS",
          `Google get-credentials is per-agent only (caller kind '${identity.kind}' not supported); use the agent's per-agent socket bind`,
        ),
      );
      return;
    }
    const agentName = identity.name;
    const agent = (this.config.agents ?? {})[agentName] as
      | { google_workspace?: { account?: string } }
      | undefined;
    const account = agent?.google_workspace?.account;
    if (!account) {
      this.audit({ op: "get-credentials", identity, ok: false, error: "no-google-account-configured" });
      socket.write(
        encodeError(
          id,
          "ACCOUNT_NOT_FOUND",
          `agent '${agentName}' has no google_workspace.account configured in switchroom.yaml`,
        ),
      );
      return;
    }
    // ACL: agent must be in google_accounts.<account>.enabled_for[].
    const ga = (this.config as { google_accounts?: Record<string, { enabled_for?: string[] }> })
      .google_accounts;
    const enabledFor = ga?.[account]?.enabled_for ?? [];
    if (!enabledFor.includes(agentName)) {
      this.audit({ op: "get-credentials", identity, account, ok: false, error: "acl-deny" });
      socket.write(
        encodeError(
          id,
          "FORBIDDEN",
          `agent '${agentName}' not in google_accounts['${account}'].enabled_for[] — operator must run \`switchroom auth google enable ${account} ${agentName}\``,
        ),
      );
      return;
    }
    // Storage read.
    const creds = readGoogleAccountCredentials(this.stateDir, account);
    if (!creds) {
      this.audit({ op: "get-credentials", identity, account, ok: false, error: "missing-credentials" });
      socket.write(
        encodeError(
          id,
          "ACCOUNT_NOT_FOUND",
          `no Google credentials for account '${account}' — operator must run \`switchroom auth google account add ${account}\``,
        ),
      );
      return;
    }
    const expiresAt = creds.googleOauth?.expiresAt;
    this.audit({ op: "get-credentials", identity, account, ok: true });
    socket.write(encodeSuccess(id, { account, credentials: creds, expiresAt }));
  }

  private async opGoogleAddAccount(
    socket: net.Socket,
    id: string,
    identity: Identity,
    label: string,
    credentials: GoogleCredentialsShape,
    replace: boolean,
  ): Promise<void> {
    if (!this.isAdmin(identity)) {
      this.audit({ op: "add-account", identity, account: label, ok: false, error: "FORBIDDEN" });
      this.respondForbidden(socket, id, "add-account requires admin");
      return;
    }
    // Defense-in-depth path-traversal guard. Wire-protocol schema
    // accepts `z.string().min(1)`; the email-shape validator runs
    // here so a malformed label can't escape the stateDir via `..`,
    // `/`, etc. before any fs op fires.
    try {
      validateGoogleAccountLabel(label);
    } catch (err) {
      socket.write(encodeError(id, "INVALID_ARGS", (err as Error).message));
      return;
    }
    if (googleAccountExists(this.stateDir, label) && !replace) {
      this.audit({ op: "add-account", identity, account: label, ok: false, error: "ACCOUNT_ALREADY_EXISTS" });
      socket.write(encodeError(id, "ACCOUNT_ALREADY_EXISTS", `google account '${label}' already exists; pass replace:true to overwrite`));
      return;
    }
    try {
      writeGoogleAccountCredentials(this.stateDir, label, credentials);
    } catch (err) {
      socket.write(encodeError(id, "INTERNAL", (err as Error).message));
      return;
    }
    const expiresAt = credentials.googleOauth?.expiresAt;
    this.audit({ op: "add-account", identity, account: label, ok: true, replace });
    socket.write(encodeSuccess(id, { label, expiresAt }));
  }

  /**
   * RFC G Phase 3b.2c — Google rm-account. Refuses to remove while
   * the account is in `google_accounts.<label>.enabled_for[]` (any
   * agent still depends on the credential). Operator must
   * `auth google disable <label> all` first.
   */
  private async opGoogleRmAccount(
    socket: net.Socket,
    id: string,
    identity: Identity,
    label: string,
  ): Promise<void> {
    if (!this.isAdmin(identity)) {
      this.audit({ op: "rm-account", identity, account: label, ok: false, error: "FORBIDDEN" });
      this.respondForbidden(socket, id, "rm-account requires admin");
      return;
    }
    try {
      validateGoogleAccountLabel(label);
    } catch (err) {
      socket.write(encodeError(id, "INVALID_ARGS", (err as Error).message));
      return;
    }
    if (!googleAccountExists(this.stateDir, label)) {
      socket.write(encodeError(id, "ACCOUNT_NOT_FOUND", `google account '${label}' not found`));
      return;
    }
    // Refuse if any agent is still enabled on this account.
    const ga = (this.config as { google_accounts?: Record<string, { enabled_for?: string[] }> }).google_accounts;
    const enabledFor = ga?.[label]?.enabled_for ?? [];
    if (enabledFor.length > 0) {
      socket.write(encodeError(id, "INVALID_ARGS", `google account '${label}' is still enabled for agents: ${enabledFor.join(", ")}. Run \`auth google disable ${label} all\` first.`));
      return;
    }
    try {
      removeGoogleAccount(this.stateDir, label);
    } catch (err) {
      socket.write(encodeError(id, "INTERNAL", (err as Error).message));
      return;
    }
    this.audit({ op: "rm-account", identity, account: label, ok: true });
    socket.write(encodeSuccess(id, { label }));
  }

  private async opSetOverride(
    socket: net.Socket,
    id: string,
    identity: Identity,
    agentName: string,
    account: string | null,
  ): Promise<void> {
    if (!this.isAdmin(identity)) {
      this.audit({ op: "set-override", identity, account: account ?? undefined, ok: false, error: "FORBIDDEN" });
      this.respondForbidden(socket, id, "set-override requires admin");
      return;
    }
    if (!(this.config.agents ?? {})[agentName]) {
      socket.write(encodeError(id, "INVALID_ARGS", `unknown agent '${agentName}'`));
      return;
    }
    if (account !== null && !accountExists(account, this.home)) {
      socket.write(encodeError(id, "ACCOUNT_NOT_FOUND", `account '${account}' not found`));
      return;
    }
    const agents = { ...(this.config.agents ?? {}) };
    const cur = agents[agentName];
    const auth = { ...(cur.auth ?? {}) };
    if (account === null) delete auth.override;
    else auth.override = account;
    agents[agentName] = { ...cur, auth };
    this.config = { ...this.config, agents };
    // Re-mirror this agent's creds against its new effective account.
    this.fanoutForAgent(agentName);
    this.audit({ op: "set-override", identity, account: account ?? undefined, ok: true });
    socket.write(encodeSuccess(id, { agent: agentName, account }));
  }

  /* ─── Refresh loop ──────────────────────────────────────────── */

  private async refreshTick(): Promise<void> {
    for (const label of listAccounts(this.home)) {
      try {
        await this.refreshOneAccount(label, /*force*/ false);
      } catch (err) {
        this.logErr(`refresh-tick ${label}: ${(err as Error).message}`);
      }
    }
    // Phase 3b.2d — also walk Google accounts. The provider may not
    // be registered (no google_workspace: config), in which case there
    // are no Google accounts on disk anyway and the loop is a no-op.
    if (this.providers.has("google")) {
      for (const account of listGoogleAccounts(this.stateDir)) {
        try {
          await this.refreshOneGoogleAccount(account, /*force*/ false);
        } catch (err) {
          this.logErr(
            `refresh-tick google:${account}: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  /**
   * Pre-emptively refresh one Google account's access token if it's
   * within REFRESH_THRESHOLD_MS of expiry. Mirrors `refreshOneAccount`
   * (the Anthropic path) in shape — same in-flight lease pattern, same
   * threshold, same outcome discriminant — but talks to GoogleProvider
   * and writes back via `writeGoogleAccountCredentials`.
   *
   * Unlike Anthropic refresh, there's no per-agent fanout: Google
   * credentials are pulled on-demand by the wrapper-broker client
   * (`src/drive/wrapper-broker.ts`) via `get-credentials({provider:
   * "google"})`. The broker just needs the on-disk credentials kept
   * fresh.
   *
   * Returns the same outcome shape as the Anthropic path so callers
   * can branch uniformly.
   */
  private async refreshOneGoogleAccount(
    account: string,
    force: boolean,
  ): Promise<
    | { kind: "noop" }
    | { kind: "refreshed"; newExpiresAt: number }
    | { kind: "failed"; error: string }
  > {
    // Lease key is namespaced so Google `alice@example.com` doesn't
    // collide with an Anthropic account literally named the same.
    const leaseKey = `google:${account}`;
    if (this.refreshInFlight.has(leaseKey)) return { kind: "noop" };

    const credsBefore = readGoogleAccountCredentials(this.stateDir, account);
    if (!credsBefore) {
      // Account vanished between listGoogleAccounts() and now — treat
      // as noop. Operator-driven `auth google account remove` is the
      // typical path here.
      return { kind: "noop" };
    }
    const provider = this.providers.lookup("google");
    const onDiskExpires = provider.extractExpiresAt(credsBefore);
    if (!force) {
      const remaining = (onDiskExpires ?? 0) - this.now();
      if (onDiskExpires !== undefined && remaining > REFRESH_THRESHOLD_MS) {
        return { kind: "noop" };
      }
    }

    this.refreshInFlight.add(leaseKey);
    try {
      const refreshToken = credsBefore.googleOauth.refreshToken;
      const result = await provider.refresh({
        refreshToken,
        accountEmail: account,
        clientId: credsBefore.googleOauth.clientId,
      });
      if (!result.ok) {
        // Don't touch on-disk credentials on failure — the existing
        // refreshToken may still work next tick (transient network),
        // and on `invalid_grant` the operator needs to re-OAuth (the
        // wrapper-broker get-credentials path will surface a clean
        // error to the consumer when they next call).
        return { kind: "failed", error: `${result.kind}: ${result.detail}` };
      }
      const newCreds = result.rawCredentials as GoogleCredentialsShape;
      // Provider returned the rawCredentials shape verbatim; persist.
      writeGoogleAccountCredentials(this.stateDir, account, newCreds);
      return { kind: "refreshed", newExpiresAt: result.expiresAt };
    } finally {
      this.refreshInFlight.delete(leaseKey);
    }
  }

  private async refreshOneAccount(
    label: string,
    force: boolean,
  ): Promise<
    | { kind: "noop" }
    | { kind: "refreshed"; newExpiresAt: number }
    | { kind: "failed"; error: string }
  > {
    if (this.refreshInFlight.has(label)) return { kind: "noop" };

    // Threshold-violation: detect on-disk expiresAt change vs last write.
    // Phase 3b.1b — this single read uses the provider's extractExpiresAt
    // as a plumbing demonstration. Eight other `claudeAiOauth?.expiresAt`
    // reads in this file (lines ~620, ~640, ~745, ~785, ~790, ~935, and
    // the seed loop ~1100) are still direct-access — they get routed
    // through `lookup(accountKey.provider).extractExpiresAt()` as part of
    // Phase 3b.2 alongside the `refreshOneAccount(label)` →
    // `refreshOneAccount(accountKey)` signature change. This call is
    // hardcoded to "anthropic" until that refactor lands.
    const credsBefore = readAccountCredentials(label, this.home);
    const onDiskExpires = this.providers.lookup("anthropic").extractExpiresAt(credsBefore);
    const lastWritten = this.lastWrittenExpiresAt.get(label);
    if (
      onDiskExpires !== undefined &&
      lastWritten !== undefined &&
      onDiskExpires !== lastWritten
    ) {
      this.thresholdViolations[label] = (this.thresholdViolations[label] ?? 0) + 1;
      this.persistThresholdViolations();
      this.logErr(`THRESHOLD_VIOLATION ${label} mtime=${this.now()}`);
    }

    if (!force) {
      // Skip when not near the threshold.
      const remaining = (onDiskExpires ?? 0) - this.now();
      if (onDiskExpires === undefined || remaining > REFRESH_THRESHOLD_MS) {
        return { kind: "noop" };
      }
    }

    // Acquire cross-container flock on the lease file.
    const leasePath = join(this.stateDir, "refresh-lease", label);
    let leaseFd: number | null = null;
    try {
      leaseFd = openSync(leasePath, constants.O_RDWR | constants.O_CREAT, 0o600);
      // node has no flock primitive in core; we serialize within-process and
      // accept that across-process serialization for v1 single-instance broker
      // is best-effort. RFC §4.4 calls this out as a future-multi-broker
      // hardening item.
      this.refreshInFlight.add(label);

      const opts: AccountRefreshOptions = {
        home: this.home,
        now: this.now,
        fetcher: this.fetcher,
        thresholdMs: force ? Number.POSITIVE_INFINITY : REFRESH_THRESHOLD_MS,
      };
      const outcome = await refreshAccountIfNeeded(label, opts);
      if (outcome.kind === "refreshed") {
        // #1447 (WS1-F1): refreshAccountIfNeeded wrote credentials.json
        // + meta.json under the broker's UID (root in production); chown
        // back to the operator UID so the operator CLI keeps working.
        this.chownAccountFilesIfRoot(label);
        const creds = readAccountCredentials(label, this.home);
        const newExpiresAt = creds?.claudeAiOauth?.expiresAt ?? outcome.newExpiresAt;
        this.lastWrittenExpiresAt.set(label, newExpiresAt);
        const contents = readFileSync(accountCredentialsPath(label, this.home), "utf-8");
        this.shaIndex[label] = sha256Hex(contents);
        this.persistShaIndex();
        // Fan out to every agent whose effective account == this label.
        this.fanoutToAffectedAgents(label);
        return { kind: "refreshed", newExpiresAt };
      }
      if (outcome.kind === "failed") {
        return { kind: "failed", error: outcome.error };
      }
      return { kind: "noop" };
    } finally {
      this.refreshInFlight.delete(label);
      if (leaseFd !== null) {
        try { closeSync(leaseFd); } catch { /* ignore */ }
      }
    }
  }

  /* ─── Fanout ────────────────────────────────────────────────── */

  /** Walk every agent and re-mirror their effective-account credentials. */
  private fanoutAll(): string[] {
    const out: string[] = [];
    for (const name of Object.keys(this.config.agents ?? {})) {
      if (this.fanoutForAgent(name)) out.push(name);
    }
    return out;
  }

  /** Fan out to every agent whose effective account == label. */
  private fanoutToAffectedAgents(label: string): string[] {
    const auth = this.config.auth ?? {};
    const fanned: string[] = [];
    for (const [name, agent] of Object.entries(this.config.agents ?? {})) {
      const effective = agent.auth?.override ?? auth.active;
      if (effective === label) {
        if (this.fanoutForAgent(name)) fanned.push(name);
      }
    }
    // Also fan out to any pinned consumers — they write to a host path
    // we don't own (their compose mounts their socket), so we only mirror
    // account-creds-on-disk; consumers fetch via get-credentials.
    return fanned;
  }

  /** Failover: every agent on `label` rolls to the next entry in fallback_order. */
  private fanoutFailoverFor(label: string): string[] {
    const auth = this.config.auth ?? {};
    const order = auth.fallback_order ?? [];
    const next = this.nextHealthyAccount(label, order);
    if (!next || next === label) return []; // nothing better available
    const rolled: string[] = [];
    for (const [name, agent] of Object.entries(this.config.agents ?? {})) {
      const effective = agent.auth?.override ?? auth.active;
      if (effective !== label) continue;
      // For agents on the fleet active, we don't rewrite YAML — we just
      // mirror the next-account creds. The CLI is expected to persist
      // the swap via set-active when it sees rolled[] in the response.
      if (this.mirrorAccountToAgent(next, name)) {
        rolled.push(name);
      }
    }
    return rolled;
  }

  private nextHealthyAccount(current: string, order: readonly string[]): string | null {
    const start = order.indexOf(current);
    if (start === -1) return order[0] ?? null;
    for (let i = 1; i <= order.length; i++) {
      const cand = order[(start + i) % order.length];
      if (!cand) continue;
      const q = this.quota[cand];
      const exhausted = q !== undefined && q.exhausted_until > this.now();
      if (!exhausted && accountExists(cand, this.home)) return cand;
    }
    return null;
  }

  /** Compute an agent's effective account and write its mirror. */
  private fanoutForAgent(name: string): boolean {
    const auth = this.config.auth ?? {};
    const agent = (this.config.agents ?? {})[name];
    if (!agent) return false;
    const effective = agent.auth?.override ?? auth.active;
    if (!effective) return false;
    return this.mirrorAccountToAgent(effective, name);
  }

  /**
   * Symlink guard for the per-agent mirror write path (#1393, WS1).
   *
   * `~/.switchroom/agents/<name>/` is recursively chowned to the
   * agent's per-agent UID (`scaffold.ts` `chown -R`) and RW
   * bind-mounted into the agent container. A prompt-injected /
   * compromised agent owns that tree and can pre-plant `.claude`
   * (or `agentDir`, or the target file) as a **symlink**. The
   * auth-broker runs as root with `CAP_DAC_OVERRIDE`; if it then
   * does `mkdirSync({recursive})` / `openSync` / `chownSync` over
   * that path it dereferences the attacker-controlled symlink and
   * writes a root-owned file at an arbitrary host path — an
   * agent→host trust-boundary crossing on every fanout
   * (`switchroom update` boot, set-active, refresh-tick, …).
   *
   * `atomicWriteFileSync`'s tempfile+rename only defeats a swap of
   * the *final* file, not a symlinked *parent dir* (both the
   * recursive mkdir and the tempfile `openSync` resolve through a
   * symlinked `claudeDir`). So we must `lstat` every controllable
   * component — `agentsDir`, `agentDir`, `agentDir/.claude`, and
   * the target file — and refuse if any existing component is a
   * symlink (or not the expected type). Fail closed: skip *this*
   * agent's mirror with a logged + audited reason; never crash the
   * whole fanout (one poisoned agent must not deny-of-service the
   * fleet's auth).
   *
   * Returns the validated paths on success, or `null` if the mirror
   * must be skipped (reason already logged + audited).
   */
  private resolveMirrorPathsSafe(
    agentName: string,
  ): { agentDir: string; claudeDir: string; targetPath: string } | null {
    const agentsDir = resolveAgentsDir(this.config);
    const agentDir = resolve(agentsDir, agentName);
    const claudeDir = join(agentDir, ".claude");
    const targetPath = join(claudeDir, ".credentials.json");

    const refuse = (component: string, reason: string): null => {
      this.logErr(
        `fanout ${agentName}: REFUSING mirror — ${component} ${reason} ` +
          `(symlink-guard #1393; agent-owned tree may be attacker-poisoned)`,
      );
      this.audit({
        op: "mirror-symlink-refused",
        identity: { kind: "agent", name: agentName, admin: false },
        ok: false,
        error: `${component}:${reason}`,
      });
      return null;
    };

    // `agentsDir` is operator/root-owned and bind-mounted from the
    // host root of the agents tree — must be a real directory, not a
    // symlink the agent could have swapped (it can't write here, but
    // guard the anchor anyway for defence-in-depth).
    const agentsStat = this.lstatOrNull(agentsDir);
    if (!agentsStat) return refuse("agentsDir", "does-not-exist");
    if (agentsStat.isSymbolicLink())
      return refuse("agentsDir", "is-a-symlink");
    if (!agentsStat.isDirectory())
      return refuse("agentsDir", "is-not-a-directory");

    // `agentDir` (~/.switchroom/agents/<name>) — agent-UID-owned and
    // agent-writable. If it doesn't exist there is nothing to mirror
    // (mirror only lands for scaffolded agents); a symlink here means
    // a poisoned tree.
    const agentDirStat = this.lstatOrNull(agentDir);
    if (!agentDirStat) return null; // not scaffolded yet — silently skip (matches prior !existsSync behaviour)
    if (agentDirStat.isSymbolicLink())
      return refuse("agentDir", "is-a-symlink");
    if (!agentDirStat.isDirectory())
      return refuse("agentDir", "is-not-a-directory");

    // `.claude` — the primary attack target. `mkdirSync({recursive})`
    // would dereference an existing symlink here; reject before any
    // mkdir. If it doesn't exist yet that's fine (we create it).
    const claudeStat = this.lstatOrNull(claudeDir);
    if (claudeStat) {
      if (claudeStat.isSymbolicLink())
        return refuse(".claude", "is-a-symlink");
      if (!claudeStat.isDirectory())
        return refuse(".claude", "is-not-a-directory");
    }

    // The target file — `atomicWriteFileSync` renames over it, so a
    // symlink here is largely defeated by the tempfile dance, but a
    // dangling/regular-vs-symlink mismatch is still a clear poisoning
    // signal. Reject a symlink; allow absent or a regular file.
    const targetStat = this.lstatOrNull(targetPath);
    if (targetStat) {
      if (targetStat.isSymbolicLink())
        return refuse(".credentials.json", "is-a-symlink");
      if (!targetStat.isFile())
        return refuse(".credentials.json", "is-not-a-regular-file");
    }

    return { agentDir, claudeDir, targetPath };
  }

  private lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
    try {
      return lstatSync(path);
    } catch {
      return null;
    }
  }

  private mirrorAccountToAgent(label: string, agentName: string): boolean {
    const credsPath = accountCredentialsPath(label, this.home);
    if (!existsSync(credsPath)) return false;
    // enrichMirrorContent: defense-in-depth on top of #1280's write-
    // time enrichment for stale legacy source files. See its docstring.
    const mirrorContent = enrichMirrorContent(readFileSync(credsPath, "utf-8"));
    // Symlink guard (#1393): validate every controllable path
    // component is a real (non-symlink) dir/file BEFORE any
    // mkdir/write/chown. Fail closed — skip this agent, don't crash
    // the fanout.
    const safe = this.resolveMirrorPathsSafe(agentName);
    if (!safe) return false;
    const { claudeDir, targetPath } = safe;
    mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
    // Claude Code (2.x) reads OAuth credentials from `.credentials.json`
    // (dotfile, see the binary string table). The pre-RFC-H fanout used
    // the non-dot name `credentials.json` and got away with it because
    // `start.sh` also exported CLAUDE_CODE_OAUTH_TOKEN from the legacy
    // .oauth-token — claude never actually read the on-disk mirror.
    // RFC H §7.4 deletes the env-injection path, so the on-disk mirror
    // must land at the dotfile path or agents silently lose auth on
    // first restart. Pinned by tests in server.test.ts. `targetPath`
    // is the symlink-guarded path from `resolveMirrorPathsSafe`.
    try {
      atomicWriteFileSync(targetPath, mirrorContent, 0o600);
      try {
        const uid = allocateAgentUid(agentName);
        chownSync(targetPath, uid, uid);
      } catch (err) {
        this.warnCapChownMissing(err);
      }
      return true;
    } catch (err) {
      this.logErr(`fanout ${agentName} <- ${label}: ${(err as Error).message}`);
      return false;
    }
  }

  /* ─── State persistence ─────────────────────────────────────── */

  private loadStateFromDisk(): void {
    this.quota = this.readJson<QuotaState>("quota.json") ?? {};
    this.shaIndex = this.readJson<ShaIndex>("sha-index.json") ?? {};
    this.thresholdViolations = this.readJson<ThresholdViolations>("threshold-violations.json") ?? {};
  }

  private readJson<T>(name: string): T | null {
    const p = join(this.stateDir, name);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, "utf-8")) as T; } catch { return null; }
  }

  private persistQuota(): void { atomicWriteJsonSync(join(this.stateDir, "quota.json"), this.quota, 0o600); }
  private persistShaIndex(): void { atomicWriteJsonSync(join(this.stateDir, "sha-index.json"), this.shaIndex, 0o600); }
  private persistThresholdViolations(): void { atomicWriteJsonSync(join(this.stateDir, "threshold-violations.json"), this.thresholdViolations, 0o600); }

  /* ─── Drift detection ───────────────────────────────────────── */

  /**
   * On boot, every label in shaIndex must match the on-disk credentials.
   * Mismatch is a hard error per RFC §4.4. Labels not in the index are
   * accepted (broker hasn't seen them before — e.g. a fresh `auth add`).
   */
  private assertDriftFree(): void {
    for (const label of Object.keys(this.shaIndex)) {
      const p = accountCredentialsPath(label, this.home);
      if (!existsSync(p)) {
        // Index entry without on-disk file — operator deleted it manually.
        // Treat as drift to surface the inconsistency.
        this.logErr(`DRIFT_DETECTED ${label}: index entry but no on-disk credentials`);
        process.exit(1);
      }
      const got = sha256Hex(readFileSync(p, "utf-8"));
      if (got !== this.shaIndex[label]) {
        this.logErr(
          `DRIFT_DETECTED ${label}: sha256 mismatch (recover with 'switchroom auth add ${label} --replace')`,
        );
        process.exit(1);
      }
    }
    // Seed lastWrittenExpiresAt from on-disk so threshold-violation works
    // even for accounts the broker hasn't refreshed yet this boot.
    for (const label of listAccounts(this.home)) {
      const creds = readAccountCredentials(label, this.home);
      if (creds?.claudeAiOauth?.expiresAt !== undefined) {
        this.lastWrittenExpiresAt.set(label, creds.claudeAiOauth.expiresAt);
      }
    }
  }

  /* ─── Audit log ─────────────────────────────────────────────── */

  private audit(entry: {
    op: string;
    identity: Identity;
    account?: string;
    ok: boolean;
    error?: string;
    replace?: boolean;
  }): void {
    const peer =
      entry.identity.kind === "operator"
        ? "operator"
        : `${entry.identity.kind}:${entry.identity.name}`;
    const row = JSON.stringify({
      ts: this.now(),
      op: entry.op,
      peer,
      account: entry.account,
      ok: entry.ok,
      error: entry.error,
      replace: entry.replace,
    });
    const auditPath = join(this.stateDir, "audit.jsonl");
    try {
      this.rotateAuditIfLarge(auditPath);
      const line = row + "\n";
      let buf = Buffer.from(line, "utf-8");
      // SIGKILL-safe torn-write guard. POSIX `write(2)` to an O_APPEND
      // fd is atomic with respect to other writers AND with respect to
      // signals — the kernel doesn't yield mid-syscall to deliver a
      // signal — IFF the write is a single syscall AND the buffer
      // length is ≤ PIPE_BUF (4096 bytes on Linux for regular files,
      // per the `write(2)` man page). Two changes vs the prior code
      // which used `writeFileSync(fd, line)`:
      //   1. `writeFileSync` LOOPS internally on short writes, so it
      //      could in principle issue multiple syscalls. Switched to
      //      `writeSync` (one syscall) below.
      //   2. Hard-cap the row at AUDIT_LINE_MAX. Real audit rows are
      //      <300 bytes; the cap defends against a runaway field
      //      (e.g. a huge `entry.error` string). Oversized rows are
      //      truncated with a marker — a truncated audit entry is
      //      strictly better than a torn one.
      if (buf.length > AUDIT_LINE_MAX) {
        const truncated =
          row.slice(0, AUDIT_LINE_MAX - 32) + '","__truncated":true}\n';
        buf = Buffer.from(truncated, "utf-8");
      }
      this._writeAuditLineAtomic(auditPath, buf);
    } catch (err) {
      // Audit failure must not affect protocol responses.
      this.logErr(`audit write failed: ${(err as Error).message}`);
    }
  }

  /**
   * Single-syscall atomic append. Caller has enforced
   * `buf.length <= AUDIT_LINE_MAX <= PIPE_BUF`.
   */
  private _writeAuditLineAtomic(path: string, buf: Buffer): void {
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
      0o600,
    );
    try {
      const written = writeSync(fd, buf, 0, buf.length, null);
      if (written !== buf.length) {
        // Short write on an O_APPEND fd to a regular file with a tiny
        // buffer shouldn't happen on Linux — the size cap exists to
        // prevent this. Log loud if it does. The line is partial but
        // we got the prefix; retry-risk would duplicate bytes.
        this.logErr(`audit short-write: wrote=${written} expected=${buf.length}`);
      }
    } finally {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }

  private rotateAuditIfLarge(path: string): void {
    let size = 0;
    try { size = statSync(path).size; } catch { return; }
    if (size < AUDIT_ROTATE_BYTES) return;
    // Roll: audit.jsonl.4 -> .5 (discard .5), .3 -> .4, ..., .1 -> .2, base -> .1.
    for (let i = AUDIT_KEEP - 1; i >= 1; i--) {
      const src = `${path}.${i}`;
      const dst = `${path}.${i + 1}`;
      if (existsSync(src)) {
        try { renameSync(src, dst); } catch { /* ignore */ }
      }
    }
    try { renameSync(path, `${path}.1`); } catch { /* ignore */ }
  }

  private logErr(msg: string): void {
    process.stderr.write(`[auth-broker] ${msg}\n`);
  }

  /**
   * Emit a one-shot warning on the first chown failure. Production
   * runs with CAP_CHOWN so this is normally silent. Dev/test boxes
   * lacking the cap produce ONE line per process lifetime, not one
   * per credentials.json write — keeps stderr from drowning.
   * The mirror still lands (atomic write succeeded); ownership stays
   * whoever the broker runs as, which on a dev box is fine since
   * the agent is the same user.
   */
  private warnCapChownMissing(err: unknown): void {
    if (this.capChownWarned) return;
    this.capChownWarned = true;
    const msg = err instanceof Error ? err.message : String(err);
    this.logErr(
      `chown failed (CAP_CHOWN missing?): ${msg}. ` +
      `Per-agent mirror written but ownership not flipped. ` +
      `Suppressing further chown warnings for this process.`,
    );
  }

  /**
   * Chown the account dir + credentials.json + meta.json to the
   * operator UID after a broker write (#1447). No-op when operatorUid
   * is undefined (dev path where broker runs under the operator UID
   * already) and silently swallows EPERM on hosts without CAP_CHOWN
   * via the same warn helper the per-agent mirror chown uses.
   */
  private chownAccountFilesIfRoot(label: string): void {
    if (this.operatorUid === undefined) return;
    try {
      chownAccountFiles(label, this.operatorUid, this.home);
    } catch (err) {
      this.warnCapChownMissing(err);
    }
  }

  /* ─── Config validation ─────────────────────────────────────── */

  private assertConfigConsistent(cfg: SwitchroomConfig): void {
    const shape = configToShape(cfg);
    const errs = validateConsumerNames(shape);
    if (errs.length > 0) {
      throw new Error(`CONFIG_INVALID: ${errs.join("; ")}`);
    }
    // adminAgents is derived from agents.<name>.admin === true so the
    // subset-of-agents invariant holds by construction — no explicit
    // check needed. Pre-unification (PR #?), `auth.admin_agents` was a
    // separate list and we asserted it referenced declared agents only;
    // that gate moved into the per-agent schema (zod refuses a
    // top-level `admin: true` outside an agent block).
  }

  /* ─── Test affordances ──────────────────────────────────────── */

  /** Test-only: force a refresh tick. */
  async _tick(): Promise<void> {
    await this.refreshTick();
  }

  /** Test-only: read the in-memory state for assertions. */
  _state(): {
    quota: QuotaState;
    shaIndex: ShaIndex;
    thresholdViolations: ThresholdViolations;
    listeners: string[];
  } {
    return {
      quota: { ...this.quota },
      shaIndex: { ...this.shaIndex },
      thresholdViolations: { ...this.thresholdViolations },
      listeners: [...this.listeners.keys()],
    };
  }

  /** Test-only: run the all-agent fanout. */
  _fanoutAll(): string[] {
    return this.fanoutAll();
  }
}

/** Re-export so the entry point can register error codes. */
export type { ErrorCode };
