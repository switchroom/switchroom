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
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { closeSync, openSync } from "node:fs";
import * as constants from "node:constants";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import { allocateAgentUid } from "../../agents/compose.js";
import { resolveAgentsDir } from "../../config/loader.js";
import type { AuthConfig, AuthConsumer, SwitchroomConfig } from "../../config/schema.js";
import { atomicWriteFileSync, atomicWriteJsonSync } from "../../util/atomic.js";
import {
  REFRESH_THRESHOLD_MS,
  refreshAccountIfNeeded,
  type AccountRefreshOptions,
} from "../account-refresh.js";
import {
  accountCredentialsPath,
  accountDir,
  accountExists,
  accountsRoot,
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

function configToShape(cfg: SwitchroomConfig): AuthConfigShape {
  const auth = cfg.auth ?? {};
  return {
    agents: Object.keys(cfg.agents ?? {}),
    consumers: (auth.consumers ?? []).map((c) => c.name),
    adminAgents: auth.admin_agents ?? [],
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
    await this.bindListener(sockPath, uid, 0o660, {
      kind: "agent",
      name: agentName,
      admin: (this.config.auth?.admin_agents ?? []).includes(agentName),
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
        case "get-credentials":
          await this.opGetCredentials(socket, reqId, identity);
          break;
        case "list-state":
          await this.opListState(socket, reqId, identity);
          break;
        case "set-active":
          await this.opSetActive(socket, reqId, identity, req.account);
          break;
        case "mark-exhausted":
          await this.opMarkExhausted(socket, reqId, identity, req.until);
          break;
        case "refresh-account":
          await this.opRefreshAccount(socket, reqId, identity, req.account);
          break;
        case "add-account":
          await this.opAddAccount(socket, reqId, identity, req.label, req.credentials, req.replace ?? false);
          break;
        case "rm-account":
          await this.opRmAccount(socket, reqId, identity, req.label);
          break;
        case "set-override":
          await this.opSetOverride(socket, reqId, identity, req.agent, req.account);
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
    const credsBefore = readAccountCredentials(label, this.home);
    const onDiskExpires = credsBefore?.claudeAiOauth?.expiresAt;
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

  private mirrorAccountToAgent(label: string, agentName: string): boolean {
    const credsPath = accountCredentialsPath(label, this.home);
    if (!existsSync(credsPath)) return false;
    const content = readFileSync(credsPath, "utf-8");
    const agentsDir = resolveAgentsDir(this.config);
    const agentDir = resolve(agentsDir, agentName);
    if (!existsSync(agentDir)) return false;
    const claudeDir = join(agentDir, ".claude");
    mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
    // Claude Code (2.x) reads OAuth credentials from `.credentials.json`
    // (dotfile, see the binary string table). The pre-RFC-H fanout used
    // the non-dot name `credentials.json` and got away with it because
    // `start.sh` also exported CLAUDE_CODE_OAUTH_TOKEN from the legacy
    // .oauth-token — claude never actually read the on-disk mirror.
    // RFC H §7.4 deletes the env-injection path, so the on-disk mirror
    // must land at the dotfile path or agents silently lose auth on
    // first restart. Pinned by tests in server.test.ts.
    const targetPath = join(claudeDir, ".credentials.json");
    try {
      atomicWriteFileSync(targetPath, content, 0o600);
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
      const fd = openSync(auditPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
      try {
        writeFileSync(fd, line);
      } finally {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    } catch (err) {
      // Audit failure must not affect protocol responses.
      this.logErr(`audit write failed: ${(err as Error).message}`);
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

  /* ─── Config validation ─────────────────────────────────────── */

  private assertConfigConsistent(cfg: SwitchroomConfig): void {
    const shape = configToShape(cfg);
    const errs = validateConsumerNames(shape);
    if (errs.length > 0) {
      throw new Error(`CONFIG_INVALID: ${errs.join("; ")}`);
    }
    // admin_agents must be subsets of agents.
    for (const a of shape.adminAgents) {
      if (!shape.agents.includes(a)) {
        throw new Error(`CONFIG_INVALID: admin_agents entry '${a}' is not a declared agent`);
      }
    }
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
