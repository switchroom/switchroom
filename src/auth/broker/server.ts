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
 * mark-exhausted, mark-throttled, refresh-account, add-account,
 * rm-account, set-override, get-external-spend.
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
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { closeSync, openSync, writeSync } from "node:fs";
import * as constants from "node:constants";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

import { allocateAgentUid } from "../../agents/compose.js";
import { resolveAgentsDir } from "../../config/loader.js";
import {
  fetchQuota,
  resolveModelTierProbeModel,
  type QuotaResult,
} from "../quota.js";
import {
  quotaIndicatesExhaustion,
  resolveConsumerProbeIntervalMs,
  EXHAUSTION_PCT,
} from "./consumer-quota-sensor.js";
import {
  quotaIndicatesModelTierWall,
  quotaTierAllowed,
  isModelTierWalled,
  MODEL_TIER_WALL_DEFAULT_MS,
  type ModelTierWallMark,
} from "./model-tier-quota.js";
import {
  recordUsageSample,
  standardSampleFromResult,
  premiumSampleFromResult,
  summarizeAccountUsage,
  bestPremiumHeadroomAccount,
  resolveUsageRingCap,
  type UsageLedger,
} from "./usage-ledger.js";
import {
  isAccountBlocked as evalAccountBlocked,
  accountEligibility,
  snapshotShouldClearMark,
  clampMarkExpiry,
  overageLiftsWall,
  snapshotFresh,
  evaluateSoftAvoid,
  type SoftAvoidState,
  type SoftAvoidSnapshot,
  snapshotWalled,
  WALL_PCT,
  SNAPSHOT_STALE_AGE_MS,
} from "./account-eligibility.js";
import type { AuthConfig, AuthConsumer, SwitchroomConfig } from "../../config/schema.js";
import { atomicWriteJsonSync } from "../../util/atomic.js";
import {
  fetchAndSummarizeExternalSpend,
  EXTERNAL_SPEND_CACHE_TTL_MS,
  EXTERNAL_SPEND_FETCH_TIMEOUT_MS,
  LITELLM_MASTER_KEY_STATE_BASENAME,
  DEFAULT_LITELLM_BASE,
  type ExternalSpendSummary,
} from "../../litellm/external-spend.js";
import { safeMirrorWrite } from "./mirror-write.js";
import {
  REFRESH_THRESHOLD_MS,
  refreshAccountIfNeeded,
  type AccountRefreshOptions,
} from "../account-refresh.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { GoogleProvider } from "./google-provider.js";
import { MicrosoftProvider } from "./microsoft-provider.js";
import { resolveMicrosoftClientId } from "../default-oauth-clients.js";
import {
  googleAccountExists,
  listGoogleAccounts,
  readGoogleAccountCredentials,
  removeGoogleAccount,
  validateGoogleAccountLabel,
  writeGoogleAccountCredentials,
} from "./google-storage.js";
import {
  listMicrosoftAccounts,
  microsoftAccountExists,
  readMicrosoftAccountCredentials,
  removeMicrosoftAccount,
  validateMicrosoftAccountLabel,
  writeMicrosoftAccountCredentials,
} from "./microsoft-storage.js";
import { ProviderRegistry, type ProviderName } from "./provider.js";
import {
  normalizeMicrosoftBindings,
  type MicrosoftWorkspaceLike,
} from "../../config/microsoft-workspace-acl.js";
import type { GoogleCredentialsShape, MicrosoftCredentialsShape } from "./protocol.js";
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

/** Ceiling on a `mark-throttled.until` (429 throttle tier). Transient burst /
 * RPM throttles clear in seconds-to-minutes; anything longer is the failover
 * path's business (the gateway escalates long resets to mark-exhausted), so a
 * bogus long throttle is clamped rather than lingering in the ledger. */
const MARK_THROTTLED_MAX_MS = 30 * 60 * 1000;

/** Escalation window (429 throttle tier): `throttle_hits` older than this are
 * pruned from the observability ledger on each mark. Bookkeeping only since
 * #failover-429-corroborate — it no longer gates escalation (the live probe
 * runs on the FIRST hit, rate-bounded), it just bounds the recorded window. */
const THROTTLE_ESCALATION_WINDOW_MS = 10 * 60 * 1000;

/** First-hit corroboration rate bound (#failover-429-corroborate): a terminal
 * transient 429 now runs the live escalation probe on the FIRST hit (not the
 * 3rd) so a 5h wall hiding behind transient/generic 429 wording converts to
 * failover in one round-trip instead of stranding a dead turn. To keep a 429
 * burst from costing a probe per hit, the probe is bounded to at most once per
 * this interval per account — combined with the single-flight wrapper and the
 * 5s re-mark dedup, a storm costs ≤1 haiku token/min/account. */
export const THROTTLE_ESCALATION_PROBE_MIN_INTERVAL_MS = 60 * 1000;

/** Re-mark dedup (429 throttle tier): a mark landing within this interval of
 * the account's previous hit only refreshes `throttled_until` (keeping the
 * later expiry) — it adds no escalation hit and can trigger no probe. Bounds
 * the probe-flood when many agents sharing one account 429 simultaneously
 * (one burst counts as one hit). */
const MARK_THROTTLED_MIN_INTERVAL_MS = 5 * 1000;

/**
 * 4c — corroboration-probe delay after an UNCORROBORATED long exhaustion mark.
 *
 * A long mark (> MARK_EXHAUSTED_DEFAULT_MS — the +7d weekly-wall shape) that is
 * accepted WITHOUT a fresh contradicting snapshot is legitimate under #2218
 * weekly-durability, so `clampMarkExpiry` trusts it (never hard-clamps). But a
 * bogus/misparsed weekly signal accepted the same way would strand a healthy
 * account for days. This delay schedules ONE live corroboration probe after the
 * mark; a COMPLETE probe (F0 `sevenDayUtilPresent`) that positively contradicts
 * the weekly wall clamps the persisted `exhausted_until` to 5h. Bounded low
 * enough to neutralise a bogus multi-day mark quickly, high enough to avoid
 * hammering the upstream immediately after the reactive roll (which just
 * probed). Set to 0 (tests) to disable auto-scheduling and drive the probe
 * directly.
 */
const MARK_CORROBORATION_PROBE_DELAY_MS = 90 * 1000;

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
  /** Unix ms until which the account is exhausted (a real quota wall).
   *  Optional since the 429 throttle tier: a throttle-only entry carries
   *  `throttled_until` with no exhaustion mark. */
  exhausted_until?: number;
  /** Unix ms when this mark was written. Lets eligibility compare the mark's
   *  recency against a live snapshot (most-recent-signal-wins). Optional for
   *  backward-compat with marks persisted before 2026-06-10 — a legacy mark
   *  with no `marked_at` is treated as older than any fresh probe, so live
   *  truth overrides it (the safe direction). */
  marked_at?: number;
  /** 429 throttle tier — unix ms until which the account is transiently
   *  rate-limited (`mark-throttled`). NEVER consulted by eligibility
   *  (account-eligibility.ts keys on exhaustion marks + live snapshots
   *  only); read by list-state consumers (cron quota-preflight soft-defer). */
  throttled_until?: number;
  /** Unix ms timestamps of recent `mark-throttled` hits — the escalation
   *  counter. Pruned to THROTTLE_ESCALATION_WINDOW_MS on every hit; cleared
   *  after an escalation probe runs (corroborated or not). */
  throttle_hits?: number[];
  /** #3176 — model-tier (7d_oi / seven_day_overage_included) wall. Unix ms
   *  until which the account is walled on the FLAGSHIP tier only (the account
   *  still serves opus/haiku fine, so this is NOT an `exhausted_until`
   *  blanket mark). Set by the fleet tick's premium canary; cleared when a
   *  fresh canary reports the tier allowed. */
  premium_walled_until?: number;
  /** The binding bucket claim at mark time, for operator messaging. */
  premium_wall_bucket?: string;
  /** Unix ms when the tier-wall mark was written (most-recent-signal-wins). */
  premium_wall_marked_at?: number;
  /** Entitlement-403 hard block: Anthropic returned a 403 whose body says the
   *  org/subscription has DISABLED Claude Code access ("Your organization has
   *  disabled Claude subscription access for Claude Code"). Unlike a util wall
   *  this is a hard account-level block — the account can NEVER serve until the
   *  org re-enables Code access. Set on an entitlement-403 probe; cleared by ANY
   *  later successful probe. */
  entitlement_blocked?: boolean;
  /** Unix ms when the entitlement block was marked. */
  entitlement_blocked_at?: number;
  /** The API error message that triggered the mark, for operator messaging. */
  entitlement_blocked_reason?: string;
}
interface QuotaState {
  [label: string]: QuotaEntry;
}

/**
 * Persisted fleet-active override (`active-override.json`). Written on every
 * successful `set-active` AND on every `mark-exhausted` roll (auto-promote),
 * so an account swap survives a broker restart/recreate.
 *
 * Why: `set-active` historically mutated only in-memory config —
 * "persisting back to YAML is the CLI's job" (RFC §4.6). Every non-CLI
 * swap (Telegram /auth use, the switch buttons, auto-fallback) therefore
 * silently reverted to the stale yaml `auth.active` on the next broker
 * recreate — repeatedly re-poisoning the fleet with a quota-walled account
 * during the 2026-07-05 incident (each recreate re-mirrored the walled
 * account; agents had to crash into the wall again to re-roll).
 *
 * Precedence at boot: the override wins over yaml ONLY while yaml's
 * `auth.active` still reads the same value it had when the override was
 * written (`yaml_active_at_write`). A hand-edited yaml is newer operator
 * intent — it wins and the override file is deleted.
 */
interface ActiveOverride {
  active: string;
  /** yaml `auth.active` at the moment this override was written (null =
   *  yaml had no active set). */
  yaml_active_at_write: string | null;
  updated_at: number;
}

/**
 * Fleet notification-dedup claims (`claim-notification` op): dedup key →
 * unix-ms of the last GRANTED claim. Entries older than the largest
 * permitted window (24h) are pruned on every grant so the file stays
 * bounded. Persisted as `notification-claims.json`.
 */
interface NotificationClaims {
  [key: string]: number;
}

/** Hard ceiling on claim retention — matches the protocol's max windowMs. */
const NOTIFICATION_CLAIM_MAX_AGE_MS = 86_400_000;

/**
 * Record of the most recent BROKER-INITIATED fleet roll (proactive
 * `fleetQuotaProbeTick` failover — hard-exhaustion or soft-avoid). Exposed
 * via `list-state` as `last_fleet_roll` so gateways can announce the roll to
 * the operator (the announcement/dedup channel is #3031 PR 3). Deliberately
 * NOT written by the reactive `mark-exhausted` op: the gateway that 429'd
 * already announces that swap itself, so recording it here would
 * double-announce. Persisted as `last-fleet-roll.json` so a broker restart
 * inside a gateway's poll interval doesn't drop the announcement.
 */
export interface LastFleetRoll {
  /** Account the fleet rolled off (the exhausted/soft-avoided ex-serving). */
  from: string;
  /** Account the fleet rolled to. */
  to: string;
  /** Unix ms the roll happened (broker clock). */
  at: number;
  /** Unix ms the walled account's mark expires, when known. */
  exhausted_until?: number;
  /** Which window bound the roll decision, when known. */
  window?: "5h" | "7d";
  /** Utilization pct of the binding window at roll time, when known. */
  pct?: number;
  /**
   * Trigger attribution (#3031 PR 2): "hard-exhaustion" = the probe saw a
   * genuine quota wall (mark + roll, possibly promote); "soft-avoid" = a
   * serving-preference roll off the soft-avoid tier (no mark, no promote);
   * "model-tier-wall" = the flagship-tier (7d_oi) canary saw the account
   * walled on the premium tier (#3176).
   */
  reason?: "soft-avoid" | "hard-exhaustion" | "model-tier-wall";
  /** #3176 — the binding tier bucket, set only when reason is model-tier-wall. */
  bucket?: string;
}

/**
 * #3176 — the fleet-wide "every account is flagship-tier walled" alert. Set
 * when a model-tier failover finds no premium-eligible target, so the gateway
 * can surface an operator card naming the bucket and the earliest recovery.
 * Persisted as `premium-tier-all-walled.json`; cleared once any account's
 * canary reads the tier allowed again.
 */
export interface PremiumTierAllWalled {
  /** The binding bucket (seven_day_overage_included). */
  bucket: string | null;
  /** Epoch ms of the earliest tier reset across all walled accounts, when known. */
  earliest_reset?: number;
  /** Unix ms the all-walled condition was recorded. */
  at: number;
}

/**
 * #2495 Change 2 — probe-on-open TTL. A `probe-quota` request whose cached
 * snapshot is younger than this serves the cache instead of paying for a live
 * upstream call. 45s is short enough that an opened /auth or /usage card is
 * effectively realtime, but long enough that a render storm (a fleet boot, a
 * user mashing Refresh, several agents' cards opening at once) doesn't multiply
 * into one billable probe per render.
 *
 * COST: each live probe is a billable POST /v1/messages that consumes a sliver
 * of the account's own quota (the only source of real ratelimit headers — see
 * quota.ts). TTL + single-flight together cap probe volume to at most one
 * upstream call per account per TTL window, no matter how many cards render.
 *
 * Env override: SWITCHROOM_QUOTA_PROBE_TTL_MS (ms). 0 disables the TTL gate
 * (every probe-quota goes live — only single-flight coalescing remains).
 */
const DEFAULT_QUOTA_PROBE_TTL_MS = 45_000;

function quotaProbeTtlMs(): number {
  const raw = process.env.SWITCHROOM_QUOTA_PROBE_TTL_MS;
  if (raw == null || raw === "") return DEFAULT_QUOTA_PROBE_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_QUOTA_PROBE_TTL_MS;
}

/**
 * Per-account cached utilization snapshot, written after each successful
 * `opProbeQuota` call. Consumed by `opListState` so callers (quota-watch
 * loop) can classify account health without triggering a live probe.
 *
 * #2495 Change 1 — durable. Mirrored to disk (`last-quota.json`) alongside
 * the exhaustion ledger (`quota.json`) on every `cacheQuotaSnapshot` and
 * reloaded on boot, so a broker restart serves last-known (age-stamped via
 * `capturedAt`) utilization instead of a blank/`unknown` card until the next
 * fleet tick repopulates it. The presence markers (`fiveHourUtilPresent` /
 * `sevenDayUtilPresent`, added in #2494) round-trip too so a thin reloaded
 * snapshot is still recognisably thin.
 */
interface LastQuotaEntry {
  fiveHourUtilizationPct: number;
  sevenDayUtilizationPct: number;
  /** ISO string so the in-memory shape is JSON-friendly (no Date objects). */
  fiveHourResetAt: string | null;
  sevenDayResetAt: string | null;
  representativeClaim: string | null;
  overageStatus: string | null;
  overageDisabledReason: string | null;
  /** Unix ms when this snapshot was captured. */
  capturedAt: number;
  /** #2494 Bug C — which util windows were present in the probe headers. */
  fiveHourUtilPresent?: boolean;
  sevenDayUtilPresent?: boolean;
}

interface LastQuotaCache {
  [label: string]: LastQuotaEntry;
}

/**
 * #3176 — flagship-tier (`7d_oi` / `seven_day_overage_included`) canary
 * snapshot, written after each premium-canary probe in the fleet tick. Kept
 * separate from {@link LastQuotaEntry} (the haiku probe's 5h/7d snapshot) so
 * the two probe models never overwrite each other's windows. Persisted to
 * `last-tier-quota.json` and exposed via `list-state` for transparency.
 */
interface LastTierQuotaEntry {
  /** Overall `anthropic-ratelimit-unified-status` (allowed/rejected). */
  unifiedStatus: string | null;
  /** `anthropic-ratelimit-unified-7d_oi-status` (allowed/rejected). */
  sevenDayOiStatus: string | null;
  /** `7d_oi` bucket utilization (0-100), when the header was present. */
  sevenDayOiUtilizationPct: number | null;
  /** ISO string of the tier-wall reset (7d_oi-reset / unified-reset / retry-after). */
  sevenDayOiResetAt: string | null;
  /** Unix ms when this canary snapshot was captured. */
  capturedAt: number;
}

interface LastTierQuotaCache {
  [label: string]: LastTierQuotaEntry;
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
  /**
   * Live client sockets on this listener. Tracked so a hot-reload (or stop)
   * can forcibly tear down connections whose bound identity was REMOVED or
   * RE-CLASSIFIED — otherwise a demoted/removed agent could keep riding its
   * old connection's bound identity (privilege retention). Retained agents
   * whose identity is unchanged are left alone: client.ts has no auto-
   * reconnect (it lazily reconnects on the next send), so a spurious destroy
   * would cost a still-valid agent a failed in-flight request.
   */
  sockets: Set<net.Socket>;
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
  /** Test-only: replace the quota fetcher so the consumer-probe sensor (and
   *  probe-quota) can be driven without real api.anthropic.com calls. */
  _testFetchQuota?: typeof fetchQuota;
  /** Test-only (4c): override the mark-corroboration probe delay (ms). Set to
   *  0 to disable auto-scheduling so tests drive `corroborateExhaustionMark`
   *  directly; defaults to `MARK_CORROBORATION_PROBE_DELAY_MS`. */
  _testCorroborationDelayMs?: number;
  /**
   * Test-only: replace the LiteLLM external-spend live fetch. Production
   * never sets this; `get-external-spend` calls LiteLLM with the master key.
   */
  _testFetchExternalSpend?: (opts: {
    adminKey: string;
    baseUrl: string;
    now: Date;
    forceLive?: boolean;
  }) => Promise<ExternalSpendSummary | null>;
  /** Test-only: override master-key resolution (skips file/env). */
  _testLitellmMasterKey?: string | null;
}

/* ───────────────────────── Helpers ───────────────────────── */

/**
 * #2495 Change 2 — reconstruct a probe-shaped `QuotaResult` from a durable
 * cache entry, so a TTL-hit / probe-failure fallback can be served on the same
 * wire shape as a live probe. The ISO reset strings are revived to Date for
 * the in-process consumers; the client revives again on the wire (harmless).
 */
function cachedSnapshotToResult(s: LastQuotaEntry): QuotaResult {
  return {
    ok: true,
    data: {
      fiveHourUtilizationPct: s.fiveHourUtilizationPct,
      sevenDayUtilizationPct: s.sevenDayUtilizationPct,
      fiveHourResetAt: s.fiveHourResetAt ? new Date(s.fiveHourResetAt) : null,
      sevenDayResetAt: s.sevenDayResetAt ? new Date(s.sevenDayResetAt) : null,
      representativeClaim: s.representativeClaim,
      overageStatus: s.overageStatus,
      overageDisabledReason: s.overageDisabledReason,
      fiveHourUtilPresent: s.fiveHourUtilPresent,
      sevenDayUtilPresent: s.sevenDayUtilPresent,
      // #3176 — the haiku 5h/7d cache carries no flagship-tier signal; the
      // canary owns those in `lastTierQuotaCache`. Null here by construction.
      unifiedStatus: null,
      sevenDayOiStatus: null,
      sevenDayOiUtilizationPct: null,
      sevenDayOiResetAt: null,
    },
  };
}

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
    // `root: true` is a strictly-higher tier than admin (the root-tier
    // debugging agent) and carries admin authority — see docs/root-agent.md.
    .filter(([, a]) => {
      const cfg = a as { admin?: boolean; root?: boolean };
      return cfg.admin === true || cfg.root === true;
    })
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
  /** Periodic probe of consumer-pinned accounts → auto mark-exhausted. See
   *  consumer-quota-sensor.ts. Null when disabled or no consumers. */
  private consumerProbeTimer: NodeJS.Timeout | null = null;
  private fleetProbeTimer: NodeJS.Timeout | null = null;
  /** 4c — live one-shot corroboration-probe timers keyed to uncorroborated
   *  long exhaustion marks. Tracked so `stop()` can clear them. */
  private markCorroborationTimers = new Set<NodeJS.Timeout>();
  /** 4c — corroboration-probe delay (ms); 0 disables auto-scheduling (tests). */
  private readonly markCorroborationDelayMs: number = MARK_CORROBORATION_PROBE_DELAY_MS;
  /** Quota fetcher — injectable for tests via opts._testFetchQuota. */
  private fetchQuotaImpl: typeof fetchQuota;
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
  /** Utilization cache. Populated by opProbeQuota; mirrored to disk
   *  (`last-quota.json`) and reloaded on boot — #2495 Change 1. */
  private lastQuotaCache: LastQuotaCache = {};
  /**
   * External OpenRouter/$ spend summary for `/usage`. Broker owns the
   * LiteLLM master key; agents only pull this sanitized snapshot via
   * `get-external-spend`. Mirrored to `external-spend.json`.
   */
  private externalSpendCache: {
    summary: ExternalSpendSummary;
    capturedAtMs: number;
  } | null = null;
  /** Single-flight for live LiteLLM external-spend refresh. */
  private externalSpendInFlight: Promise<void> | null = null;
  /** #2495 Change 2 — single-flight: in-flight live probes keyed by account
   *  label. Concurrent `probe-quota` requests for the same label share the one
   *  pending upstream call (a render storm = 1 API call per account, not N). */
  private probeInFlight = new Map<string, Promise<QuotaResult>>();
  /** #failover-429-corroborate — per-account unix-ms of the last throttle
   *  escalation probe. Rate-bounds first-hit corroboration to at most one live
   *  probe per THROTTLE_ESCALATION_PROBE_MIN_INTERVAL_MS per account (in-memory
   *  only; a broker restart re-arms it, which just permits one extra probe). */
  private lastEscalationProbeAt: Record<string, number> = {};
  private shaIndex: ShaIndex = {};
  private thresholdViolations: ThresholdViolations = {};
  /** Fleet notification-dedup claims: key → unix-ms of last grant.
   *  Persisted so a broker restart inside the window stays closed. */
  private notificationClaims: NotificationClaims = {};
  /** Most recent broker-initiated proactive fleet roll (see LastFleetRoll).
   *  Persisted so a restart doesn't drop a pending announcement. */
  private lastFleetRoll: LastFleetRoll | null = null;
  /** #3176 — per-account flagship-tier (`7d_oi`) canary snapshot. Kept
   *  SEPARATE from `lastQuotaCache` (which the haiku probe owns) so the two
   *  probes never clobber each other's windows. Persisted to
   *  `last-tier-quota.json`, reloaded on boot. */
  private lastTierQuotaCache: LastTierQuotaCache = {};
  /** #3176 — resolved model-tier canary probe model (env-overridable). */
  private readonly modelTierProbeModel: string = resolveModelTierProbeModel();
  /**
   * #3185 — per-account, per-tier rolling usage ledger. Harvested PASSIVELY
   * from the rate-limit headers the broker already receives each fleet tick
   * (standard tier at `cacheQuotaSnapshot`, premium/`7d_oi` tier at
   * `recordTierProbe`) — zero added requests. Persisted to `usage-ledger.json`,
   * reloaded on boot, surfaced via `list-state` and consumed as a headroom
   * PREFERENCE by the premium-failover selector.
   */
  private usageLedger: UsageLedger = {};
  /** #3185 — rolling-ring cap per (account, tier); env-overridable. */
  private readonly usageRingCap: number = resolveUsageRingCap(
    process.env.SWITCHROOM_USAGE_LEDGER_RING_CAP,
  );
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

  /**
   * The `auth.active` value as read from switchroom.yaml (constructor
   * config / last SIGHUP reload), BEFORE any persisted-override or swap is
   * applied. Recorded into `active-override.json` at write time so boot
   * can tell "yaml unchanged since the swap → override wins" apart from
   * "operator hand-edited yaml since → yaml wins". See applyActiveOverride.
   */
  private yamlActive: string | undefined;

  private closed = false;

  constructor(
    config: SwitchroomConfig,
    private readonly opts: AuthBrokerOptions = {},
  ) {
    this.config = config;
    this.yamlActive = config.auth?.active;
    this.home = opts.home;
    this.now = opts.now ?? nowMs;
    this.operatorUid = opts.operatorUid;
    this.fetcher = opts.fetcher;
    this.fetchQuotaImpl = opts._testFetchQuota ?? fetchQuota;
    this.markCorroborationDelayMs =
      opts._testCorroborationDelayMs ?? MARK_CORROBORATION_PROBE_DELAY_MS;
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
    // RFC #1873 / out-of-box — the Microsoft provider always registers.
    // A shipped default public client_id makes Microsoft available with
    // zero config; operators override via
    // microsoft_workspace.microsoft_client_id (resolveMicrosoftClientId
    // encodes env → config → default). Registering unconditionally is
    // safe: with no Microsoft accounts on disk the refresh tick is a
    // no-op and get-credentials returns ACCOUNT_NOT_FOUND. client_secret
    // stays optional — the default app is a public client (no secret).
    this.providers.register(
      new MicrosoftProvider({
        clientId: resolveMicrosoftClientId(
          config.microsoft_workspace?.microsoft_client_id,
        ).clientId,
        clientSecret: config.microsoft_workspace?.microsoft_client_secret,
        fetcher: opts.fetcher as typeof fetch | undefined,
      }),
    );

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

      // Consumer-account quota sensor — periodically probe accounts pinned by
      // a consumer (e.g. hindsight) and auto mark-exhausted, so a consumer on
      // a dedicated account no agent shares still fails over (its
      // serving-failover is wired but otherwise never triggers). Only armed
      // when enabled AND there is at least one consumer; a no-consumer fleet
      // pays nothing. See consumer-quota-sensor.ts.
      const probeMs = resolveConsumerProbeIntervalMs(process.env);
      const hasConsumers = (this.config.auth?.consumers ?? []).length > 0;
      if (probeMs > 0 && hasConsumers) {
        this.consumerProbeTimer = setInterval(() => {
          this.consumerQuotaProbeTick().catch((err) => {
            this.logErr(`consumer-quota-probe threw: ${(err as Error).message}`);
          });
        }, probeMs);
        this.consumerProbeTimer.unref();
      }

      // Fleet quota probe: keep every account's 5h/7d snapshot warm so the
      // dashboard shows live quota with no manual "Refresh all quota" click.
      // Always armed when probing is enabled (not gated on consumers — the
      // dashboard wants quota regardless). Run once at boot so data is there
      // immediately. Disable with SWITCHROOM_DISABLE_FLEET_QUOTA_PROBE=1.
      if (probeMs > 0 && process.env.SWITCHROOM_DISABLE_FLEET_QUOTA_PROBE !== "1") {
        void this.fleetQuotaProbeTick().catch((err) => {
          this.logErr(`fleet-quota-probe (boot) threw: ${(err as Error).message}`);
        });
        this.fleetProbeTimer = setInterval(() => {
          this.fleetQuotaProbeTick().catch((err) => {
            this.logErr(`fleet-quota-probe threw: ${(err as Error).message}`);
          });
        }, probeMs);
        this.fleetProbeTimer.unref();
      }
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
    if (this.consumerProbeTimer) {
      clearInterval(this.consumerProbeTimer);
      this.consumerProbeTimer = null;
    }
    if (this.fleetProbeTimer) {
      clearInterval(this.fleetProbeTimer);
      this.fleetProbeTimer = null;
    }
    for (const timer of this.markCorroborationTimers) clearTimeout(timer);
    this.markCorroborationTimers.clear();
    for (const [sock, lis] of this.listeners) {
      try { lis.server.close(); } catch { /* ignore */ }
      for (const s of lis.sockets) {
        try { s.destroy(); } catch { /* ignore */ }
      }
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
    // Re-apply the persisted active override against the fresh yaml read —
    // without this a SIGHUP would silently revert a persisted swap to the
    // stale yaml `auth.active` (same class as the boot-revert this fixes).
    this.yamlActive = config.auth?.active;
    this.applyActiveOverride();

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

    // Close listeners we no longer want, and forcibly tear down live sockets
    // whose identity was REMOVED or RE-CLASSIFIED across the reload. Compare
    // classify(prev) vs classify(next): a removed agent (null after) or a
    // demoted one (admin flip) must not keep riding its open connection's
    // bound identity. Retained listeners whose identity is unchanged keep
    // their sockets — client.ts lazily reconnects, so a spurious destroy
    // would cost a still-valid agent a failed in-flight request.
    const prevShape = configToShape(prev);
    const nextShape = configToShape(config);
    for (const [sock, lis] of [...this.listeners]) {
      const before = classify(lis.socketPath, prevShape, this.socketRoot);
      const after = classify(lis.socketPath, nextShape, this.socketRoot);
      const identityChanged =
        JSON.stringify(before ?? null) !== JSON.stringify(after ?? null);
      if (!wanted.has(sock)) {
        try { lis.server.close(); } catch { /* ignore */ }
        try { if (existsSync(sock)) unlinkSync(sock); } catch { /* ignore */ }
        for (const s of lis.sockets) {
          try { s.destroy(); } catch { /* ignore */ }
        }
        this.listeners.delete(sock);
      } else if (identityChanged) {
        for (const s of lis.sockets) {
          try { s.destroy(); } catch { /* ignore */ }
        }
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
    // intercepts (PR #1258). One knob, not two. `root: true` (the
    // root-tier debugging agent) is strictly above admin and carries it.
    const agentCfg = this.config.agents?.[agentName] as
      | { admin?: boolean; root?: boolean }
      | undefined;
    const adminFlag = agentCfg?.admin === true || agentCfg?.root === true;
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
        this.listeners.set(sockPath, {
          server,
          identity,
          socketPath: sockPath,
          sockets: new Set(),
        });
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
    // Track this socket on its listener so a hot-reload/stop can tear down
    // connections whose identity was removed or re-classified.
    const listener = this.listeners.get(sockPath);
    if (listener) {
      listener.sockets.add(socket);
      socket.on("close", () => {
        listener.sockets.delete(socket);
      });
    }

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
    // A null classification means the bound identity is no longer configured
    // (agent/consumer removed via reload). We MUST NOT fall back to the
    // bind-time `boundIdentity` here — it may carry admin:true, so serving it
    // would let a removed/demoted agent retain privilege on a still-open
    // connection. Reject the request and close the socket instead.
    const identity = classify(
      sockPath,
      configToShape(this.config),
      this.socketRoot,
    );
    if (!identity) {
      this.audit({
        op: "stale-identity-rejected",
        identity: boundIdentity,
        ok: false,
        error: "FORBIDDEN",
      });
      // end() (not destroy()) so the FORBIDDEN frame flushes before the FIN —
      // an immediate destroy() can truncate the reply.
      socket.end(
        encodeError(reqId, "FORBIDDEN", "identity no longer configured"),
      );
      return;
    }

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
          if (provider === "microsoft") {
            await this.opMicrosoftGetCredentials(
              socket,
              reqId,
              identity,
              req.account,
            );
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
        case "mark-throttled":
          await this.opMarkThrottled(socket, reqId, identity, req.until, req.probeOnly);
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
          // Microsoft: writes to broker's own state dir under
          // `~/.switchroom/state/auth-broker/microsoft/<account>/`,
          // mirroring the Google shape (RFC #1873).
          if (provider === "microsoft") {
            const microsoftCreds = req.credentials as MicrosoftCredentialsShape;
            await this.opMicrosoftAddAccount(
              socket,
              reqId,
              identity,
              req.label,
              microsoftCreds,
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
          if (provider === "microsoft") {
            await this.opMicrosoftRmAccount(socket, reqId, identity, req.label);
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
        case "list-microsoft-accounts":
          await this.opListMicrosoftAccounts(socket, reqId, identity);
          break;
        case "probe-quota":
          await this.opProbeQuota(
            socket,
            reqId,
            identity,
            req.accounts,
            req.timeoutMs,
            req.forceLive,
          );
          break;
        case "claim-notification":
          this.opClaimNotification(socket, reqId, identity, req.key, req.windowMs);
          break;
        case "get-external-spend":
          await this.opGetExternalSpend(socket, reqId, identity, req.forceLive);
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

  /**
   * The account a caller is PINNED/BOUND to — the raw, attribution-true
   * resolution. This is what `mark-exhausted` must use: the exhaustion signal
   * has to attribute to the account the caller actually owns, never a failover
   * view (otherwise a consumer could mark a healthy fallback account exhausted
   * and cascade the fleet off it). For SERVING credentials, use
   * `servingAccount`, which layers consumer failover on top.
   */
  private callerAccount(identity: Identity): string | null {
    const auth = this.config.auth;
    if (!auth) return null;
    if (identity.kind === "operator") return auth.active ?? null;
    if (identity.kind === "consumer") {
      const c = (auth.consumers ?? []).find((x) => x.name === identity.name);
      if (!c) return null;
      // Unpinned consumer (no `account:` in yaml) rides the fleet active —
      // same resolution as an override-less agent, so swaps/failover apply
      // identically. Attribution follows: its mark-exhausted hits the
      // active, exactly like an agent's.
      return c.account ?? auth.active ?? null;
    }
    // agent
    const agent = (this.config.agents ?? {})[identity.name];
    const override = agent?.auth?.override;
    if (override) return override;
    return auth.active ?? null;
  }

  /**
   * The agent that owns `account` exclusively (`auth.exclusive: true` on its
   * pin), or null when the account is unrestricted. Load-time schema
   * validation already rejects yaml that routes an exclusive account
   * elsewhere; this runtime lookup covers hot-mutated config (set-active /
   * set-override) and the persisted-active-override boot path.
   */
  private exclusiveOwnerOf(account: string): string | null {
    for (const [name, agent] of Object.entries(this.config.agents ?? {})) {
      if (agent.auth?.exclusive && agent.auth?.override === account) return name;
    }
    return null;
  }

  /** True when `account` may serve `forAgent` (undefined = consumer/operator
   *  path — never allowed onto someone's exclusive account). */
  private isServableBy(account: string, forAgent?: string): boolean {
    const owner = this.exclusiveOwnerOf(account);
    return owner === null || owner === forAgent;
  }

  /**
   * The account to SERVE credentials for. Same as `callerAccount`, except a
   * consumer (e.g. hindsight) whose pinned account is quota-exhausted fails
   * over to the first healthy account in `fallback_order`.
   *
   * Consumers are pinned to a dedicated account for quota isolation, but a
   * pinned account that exhausts would otherwise leave the consumer dead —
   * agents avoid this because they ride the swappable `auth.active`. Failover
   * gives consumers the same resilience; it reverts automatically once the
   * exhaustion window passes, and propagates via the consumer's background
   * cred-refresh loop. Failover applies ONLY to the serving path — never to
   * attribution (`callerAccount`) — so a consumer can never mismark the wrong
   * account exhausted.
   */
  private servingAccount(identity: Identity): string | null {
    // Operator serving stays attribution-true — the operator CLI owns
    // auth.active explicitly and a forced `auth use` must mirror exactly what
    // it asked for. Consumers (pinned for quota isolation) AND agents (riding
    // the swappable auth.active) both fail a walled account over so neither is
    // ever served exhausted credentials.
    if (identity.kind === "operator") return this.callerAccount(identity);
    if (identity.kind === "agent") return this.servedAccountForAgent(identity.name);
    return this.accountWithFailover(this.callerAccount(identity));
  }

  /**
   * Failover-resolved serving account for one agent — the single resolution
   * every agent-facing path (serve, fanout, refresh re-mirror) must share.
   *
   * A `strict: true` pin short-circuits the failover entirely: the pin is a
   * hard billing/compliance boundary, so the agent is served its own account
   * even while that account is walled — it rides out the wall (surfacing the
   * normal 429/quota cards) instead of silently borrowing fleet quota. The
   * non-strict pin keeps the #3031 semantics: a routing preference, not a
   * suicide pact.
   */
  private servedAccountForAgent(name: string): string | null {
    const agent = (this.config.agents ?? {})[name];
    const override = agent?.auth?.override;
    if (override && agent?.auth?.strict) return override;
    return this.accountWithFailover(override ?? this.config.auth?.active ?? null, name);
  }

  /**
   * True if `account` is blocked from serving / failover right now.
   *
   * Live-truth-authoritative (2026-06-10 fix): a fresh quota snapshot
   * (≤24h, newer than the mark) decides — walled→blocked, healthy→not —
   * and only when there is no usable live snapshot does the persisted
   * `exhausted_until` mark govern. This is what stops a bogus future mark
   * from stranding a live-healthy account, and a stale past mark from
   * routing onto a live-walled one. See account-eligibility.ts.
   */
  /**
   * True when the account is in the operator's `auth.allow_overage_accounts`
   * opt-in list. Overage-eligible accounts may be served past the weekly util
   * wall when Anthropic overage billing is available for them. PURE — reads
   * only this.config.
   */
  private isOverageAllowed(account: string): boolean {
    return (this.config.auth?.allow_overage_accounts ?? []).includes(account);
  }

  /**
   * View a quota-ledger entry as an eligibility `ExhaustionMark` — only when
   * it actually carries an exhaustion mark. A throttle-only entry (429
   * throttle tier: `throttled_until` with no `exhausted_until`) is NOT a
   * mark: it must never gate serving or failover eligibility.
   */
  private exhaustionMarkOf(
    account: string,
  ): { exhausted_until: number; marked_at?: number } | undefined {
    const q = this.quota[account];
    if (!q || q.exhausted_until === undefined) return undefined;
    return { exhausted_until: q.exhausted_until, marked_at: q.marked_at };
  }

  private isAccountExhausted(account: string): boolean {
    return evalAccountBlocked({
      mark: this.exhaustionMarkOf(account),
      snapshot: this.lastQuotaCache[account],
      now: this.now(),
      allowOverage: this.isOverageAllowed(account),
      entitlementBlocked: this.isAccountEntitlementBlocked(account),
    });
  }

  /* ─── Entitlement-403 hard block (Claude Code access disabled) ─── */

  /** True when the account carries an entitlement-403 mark (org/subscription
   *  disabled Claude Code access). A hard account-level block — never serves. */
  private isAccountEntitlementBlocked(account: string): boolean {
    return this.quota[account]?.entitlement_blocked === true;
  }

  /**
   * Persist an entitlement-403 mark from a FAILED probe. No-op unless the
   * failure is classified `entitlement_blocked` (a bad-scope 403 / transient
   * failure stays a no-op — the legacy behaviour). Idempotent: a label already
   * marked doesn't re-persist or re-audit. The mark is cleared by any later
   * successful probe (see {@link cacheQuotaSnapshot} → {@link clearEntitlementBlocked}).
   */
  private markEntitlementBlocked(label: string, result: QuotaResult): void {
    if (result.ok || result.failureKind !== "entitlement_blocked") return;
    if (this.quota[label]?.entitlement_blocked === true) return;
    this.quota[label] = {
      ...this.quota[label],
      entitlement_blocked: true,
      entitlement_blocked_at: this.now(),
      ...(result.apiErrorMessage
        ? { entitlement_blocked_reason: result.apiErrorMessage }
        : {}),
    };
    this.persistQuota();
    this.audit({
      op: "mark-exhausted",
      identity: { kind: "operator" },
      account: label,
      accountKind: "claude",
      ok: true,
      reason: "entitlement-403",
    });
    process.stdout.write(
      `auth-broker: ${label} returned entitlement-403 (Claude Code access disabled) — marked entitlement_blocked${result.apiErrorMessage ? ` (${result.apiErrorMessage})` : ""}\n`,
    );
  }

  /** Clear an entitlement-403 mark. Called on ANY successful probe (the org
   *  re-enabled Code access, or the 403 was transient). No-op when unmarked. */
  private clearEntitlementBlocked(label: string): void {
    const entry = this.quota[label];
    if (!entry?.entitlement_blocked) return;
    const {
      entitlement_blocked,
      entitlement_blocked_at,
      entitlement_blocked_reason,
      ...rest
    } = entry;
    void entitlement_blocked;
    void entitlement_blocked_at;
    void entitlement_blocked_reason;
    this.quota[label] = rest;
    this.persistQuota();
    process.stdout.write(
      `auth-broker: live probe of ${label} succeeded — cleared entitlement_blocked mark\n`,
    );
  }

  /* ─── Model-tier (7d_oi / seven_day_overage_included) wall (#3176) ─── */

  /** View a quota-ledger entry as a model-tier wall mark — only when it
   *  carries one. */
  private premiumWallMarkOf(account: string): ModelTierWallMark | undefined {
    const q = this.quota[account];
    if (!q || q.premium_walled_until === undefined) return undefined;
    return {
      premium_walled_until: q.premium_walled_until,
      premium_wall_bucket: q.premium_wall_bucket,
      premium_wall_marked_at: q.premium_wall_marked_at,
    };
  }

  /**
   * True when `account` is walled on the FLAGSHIP tier right now (#3176).
   * Live-truth first: a fresh canary snapshot that positively read the tier
   * `allowed` (newer than the mark) clears it; otherwise an unexpired mark
   * governs. Consulted ONLY by the fleet-active roll/serving path — a tier
   * wall benches flagship traffic, never opus/haiku.
   */
  private isAccountPremiumWalled(account: string): boolean {
    const mark = this.premiumWallMarkOf(account);
    const tier = this.lastTierQuotaCache[account];
    // A canary that ran AFTER the mark and read the tier allowed is live truth.
    const tierAllowed =
      tier != null &&
      tier.capturedAt >= (mark?.premium_wall_marked_at ?? 0) &&
      this.now() - tier.capturedAt <= SNAPSHOT_STALE_AGE_MS &&
      (tier.unifiedStatus === "allowed" || tier.sevenDayOiStatus === "allowed") &&
      !(tier.sevenDayOiStatus === "rejected");
    return isModelTierWalled({
      mark,
      now: this.now(),
      snapshotTierAllowed: tierAllowed ? true : undefined,
    });
  }

  /**
   * Cache a premium-canary result and reconcile the tier-wall mark (#3176).
   * A walled result is left to the caller (it may need to roll the fleet); a
   * result that positively reads the tier allowed CLEARS a stale mark; an
   * inconclusive result (failed probe / no tier headers / rotted canary id)
   * is a no-op — it never clears a real wall.
   */
  private recordTierProbe(label: string, result: QuotaResult): void {
    if (result.ok) {
      const d = result.data;
      this.lastTierQuotaCache[label] = {
        unifiedStatus: d.unifiedStatus ?? null,
        sevenDayOiStatus: d.sevenDayOiStatus ?? null,
        sevenDayOiUtilizationPct: d.sevenDayOiUtilizationPct ?? null,
        sevenDayOiResetAt: d.sevenDayOiResetAt?.toISOString() ?? null,
        capturedAt: this.now(),
      };
      this.persistLastTierQuotaCache();
      // #3185 — harvest a PREMIUM-tier (7d_oi) usage sample from the SAME canary
      // headers (zero added requests). A result carrying no tier signal (rotted
      // canary id / non-flagship response) yields null → no-op.
      this.recordUsage(label, "premium", premiumSampleFromResult(result, this.now()));
    }
    // Self-heal: a fresh canary that positively reads the tier allowed clears
    // any lingering tier-wall mark so the account rejoins flagship serving.
    const entry = this.quota[label];
    if (quotaTierAllowed(result) && entry?.premium_walled_until !== undefined) {
      const { premium_walled_until, premium_wall_bucket, premium_wall_marked_at, ...rest } = entry;
      void premium_walled_until;
      void premium_wall_bucket;
      void premium_wall_marked_at;
      this.quota[label] = rest;
      this.persistQuota();
      process.stdout.write(
        `auth-broker: premium canary shows ${label} flagship-tier allowed — cleared model-tier wall mark\n`,
      );
      this.fanoutToAffectedConsumers(label);
    }
    // An account that can serve the flagship again lifts a fleet-wide
    // all-walled alert.
    if (quotaTierAllowed(result)) this.clearPremiumAllWalled();
  }

  /**
   * Flagship-eligible failover target for `from` (#3176): a `fallback_order`
   * account, starting after `from`, that exists, has stored credentials, and is
   * NEITHER exhausted NOR premium-walled. Null when every candidate is walled on
   * the flagship tier (or exhausted) — the honest all-walled path, which the
   * caller surfaces with the earliest reset.
   *
   * #3185 — among the ELIGIBLE candidates, prefer the one with the most premium
   * (`7d_oi`) HEADROOM from the usage ledger, so a proactive roll lands on the
   * account that can serve the most Fable before walling again. This is a
   * PREFERENCE, not a gate: eligibility is still owned entirely by the #3176
   * `premium_walled_until` marks above. When the ledger has no premium data for
   * any candidate, `bestPremiumHeadroomAccount` returns null and we fall back to
   * the first eligible candidate in ring order — i.e. behavior is UNCHANGED
   * whenever the ledger is empty (pre-existing #3176 failover tests unaffected).
   */
  private nextPremiumEligibleAccount(from: string): string | null {
    const order = this.config.auth?.fallback_order ?? [];
    const start = order.indexOf(from);
    const ring =
      start === -1
        ? [...order]
        : order.map((_, i) => order[(start + 1 + i) % order.length]);
    const eligible: string[] = [];
    for (const cand of ring) {
      if (!cand || cand === from) continue;
      if (this.isAccountExhausted(cand)) continue;
      if (this.isAccountPremiumWalled(cand)) continue;
      if (this.exclusiveOwnerOf(cand)) continue; // never a fleet roll target
      if (!accountExists(cand, this.home)) continue;
      if (!readAccountCredentials(cand, this.home)) continue;
      eligible.push(cand);
    }
    if (eligible.length === 0) return null;
    // Headroom-preferred pick (order-stable on ties / empty ledger).
    return bestPremiumHeadroomAccount(this.usageLedger, eligible, this.now()) ?? eligible[0];
  }

  /**
   * The earliest flagship-tier reset across all walled accounts, for the
   * all-walled operator card ("recovers at …"). Null when nothing is walled.
   */
  private earliestPremiumWallReset(): number | null {
    let earliest: number | null = null;
    for (const label of listAccounts(this.home)) {
      const until = this.quota[label]?.premium_walled_until;
      if (until != null && (earliest == null || until < earliest)) earliest = until;
    }
    return earliest;
  }

  /**
   * Mark `account` walled on the flagship tier and roll the fleet off it
   * (#3176). Unlike `markExhaustedAndRoll` this is TIER-SCOPED: it writes a
   * `premium_walled_until` mark (not a blanket `exhausted_until`), selects a
   * flagship-ELIGIBLE target (not merely non-exhausted), and — when `account`
   * is the fleet active and a target exists — durably promotes the target so
   * the fleet stops routing flagship agents onto the walled account. The
   * canary that triggered this IS the fresh corroboration, so the promote is
   * not gated on a 5h/7d snapshot (which a tier wall never trips).
   */
  private markPremiumWalledAndRoll(
    account: string,
    until: number | null,
    bucket: string | null,
  ): { rolledTo: string | null; allWalled: boolean; earliestReset: number | null } {
    const now = this.now();
    const premiumWalledUntil = until ?? now + MODEL_TIER_WALL_DEFAULT_MS;
    this.quota[account] = {
      ...this.quota[account],
      premium_walled_until: premiumWalledUntil,
      premium_wall_bucket: bucket ?? undefined,
      premium_wall_marked_at: now,
    };
    this.persistQuota();
    const target = this.nextPremiumEligibleAccount(account);
    if (!target) {
      // Every account is flagship-walled (or exhausted). Honest all-walled —
      // do NOT roll (nowhere better to go); surface the earliest reset.
      return { rolledTo: null, allWalled: true, earliestReset: this.earliestPremiumWallReset() };
    }
    this.fanoutFailoverTo(account, target);
    this.fanoutToAffectedConsumers(account);
    // A flagship-eligible target exists → clear any fleet-wide all-walled alert.
    this.clearPremiumAllWalled();
    if (this.config.auth?.active === account) {
      this.config = {
        ...this.config,
        auth: { ...(this.config.auth ?? {}), active: target },
      };
      this.persistActiveOverride(target);
      this.fanoutAllConsumers();
      this.audit({ op: "auto-promote-active", identity: { kind: "operator" }, account: target, accountKind: "claude", ok: true, reason: "model-tier-wall" });
      process.stdout.write(
        `auth-broker: auto-promoted auth.active ${account} → ${target} ` +
          `(${account} flagship-tier walled until ${new Date(premiumWalledUntil).toISOString()}, bucket=${bucket ?? "?"}) — persisted\n`,
      );
    }
    return { rolledTo: target, allWalled: false, earliestReset: null };
  }

  /* ─── Soft-avoid tier (#3031, PR 1/4) ───────────────────────── */

  /** Per-account soft-avoid hysteresis (in-memory; re-derived from the next
   *  probe after a broker restart — the durable quota cache reseeds it). */
  private softAvoidState: Record<string, SoftAvoidState> = {};

  /**
   * Per-label memo of the last probe-tick soft-avoid roll target (PR 2 of
   * #3031). Dedupes the fanout + audit across ticks while the preference is
   * unchanged — NOT hysteresis (flap-safety is `isAccountSoftAvoided`'s
   * enter/exit latch); this only stops an identical roll from re-auditing
   * every tick. Cleared when the tier releases or the target degrades.
   */
  private softAvoidRolledTo: Record<string, string> = {};

  /** View a cached quota entry through the soft-avoid snapshot shape (reset
   *  ISO strings → unix-ms epochs the pure layer compares). */
  private softAvoidSnapshotOf(account: string): SoftAvoidSnapshot | undefined {
    const s = this.lastQuotaCache[account];
    if (!s) return undefined;
    return {
      ...s,
      fiveHourResetAtMs: s.fiveHourResetAt ? Date.parse(s.fiveHourResetAt) : null,
      sevenDayResetAtMs: s.sevenDayResetAt ? Date.parse(s.sevenDayResetAt) : null,
    };
  }

  /**
   * True when `account` is in the soft-avoid PREFERENCE tier (#3031): its
   * fresh utilization is at/above `auth.proactive_failover_pct` (7d) or
   * min(pct+3, 98) (5h), with enter/exit hysteresis. This is a serving-path
   * RANKING only — it never blocks, never affects attribution
   * (`callerAccount` / mark-exhausted), and is structurally FALSE whenever
   * the config knob is unset (the no-behavior-change guarantee).
   * Overage-lifted accounts are never soft-avoided.
   *
   * A soft-avoid tier FLIP still does not fan out from HERE — this stays a
   * pure predicate. The probe-tick-driven push (PR 2 of #3031) lives in
   * `softAvoidProbeRoll`, called from `fleetQuotaProbeTick`; the pull paths
   * (get-credentials / refresh-tick fanout) already route through
   * accountWithFailover. Announcements/notifications are PR 3.
   */
  private isAccountSoftAvoided(account: string): boolean {
    const pct = this.config.auth?.proactive_failover_pct;
    if (pct === undefined) return false; // feature off — zero state churn
    const now = this.now();
    const snapshot = this.softAvoidSnapshotOf(account);
    const overageLifted =
      !!snapshot && snapshotFresh(snapshot, now) &&
      overageLiftsWall(snapshot, this.isOverageAllowed(account));
    const state = evaluateSoftAvoid({
      snapshot,
      now,
      pct,
      overageLifted,
      prev: this.softAvoidState[account],
    });
    this.softAvoidState[account] = state;
    return state.softAvoided;
  }

  /**
   * Tie-break score for an all-soft-avoid candidate set: the account's worst
   * fresh window utilization (lower = more headroom). Accounts with no fresh
   * snapshot score WORST (+Infinity): an account CAN reach this tie-break
   * without fresh evidence — the hysteresis latch carries across a snapshot
   * going stale (>24h) — and a latched-then-stale account must never beat a
   * freshly-measured one (we have zero evidence it has headroom). Callers
   * seed their fold so the first candidate still wins when every score is
   * +Infinity (the tie-break never returns null / shrinks availability).
   */
  private softAvoidUtilScore(account: string): number {
    const s = this.lastQuotaCache[account];
    if (!s || !snapshotFresh(s, this.now())) return Number.POSITIVE_INFINITY;
    return Math.max(s.fiveHourUtilizationPct, s.sevenDayUtilizationPct);
  }

  /**
   * THE single audited signal that authorizes spending Anthropic overage credit.
   * True iff `account` may RIGHT NOW be served past the weekly utilization wall
   * on overage billing — the in-agent rate-limit-menu handler consults this
   * (over the broker, never config) before it may select "usage credits".
   *
   * True requires ALL of:
   *   (a) the account is in `auth.allow_overage_accounts` (operator opt-in), AND
   *   (b) a FRESH (≤24h) quota snapshot satisfies `overageLiftsWall()` — i.e.
   *       `overageStatus === "allowed"` AND `overageDisabledReason` is not
   *       `out_of_credits`, AND
   *   (c) no active real-429 exhaustion mark blocks it (a mark still wins —
   *       deferred to the shared `accountEligibility` decision, not re-checked).
   *
   * DEFAULT-OFF is structural: with `allow_overage_accounts` empty/unset (the
   * default) `isOverageAllowed` is false for every account, so this returns false
   * unconditionally — the watchdog can never select a paid option. Reuses
   * `overageLiftsWall` + `accountEligibility`; no duplicated predicate logic.
   */
  private isActiveOverageServing(account: string | null): boolean {
    if (!account) return false;
    if (!this.isOverageAllowed(account)) return false;
    const snapshot = this.lastQuotaCache[account];
    const now = this.now();
    if (!snapshot || !snapshotFresh(snapshot, now)) return false;
    if (!overageLiftsWall(snapshot, true)) return false;
    // Mark vs. snapshot is MOST-RECENT-SIGNAL-WINS (see accountEligibility): a
    // real-429 mark blocks overage only while it is NEWER than the latest fresh
    // probe. Once the broker re-probes after the 429 and Anthropic reports
    // overageStatus:"allowed", that newer snapshot re-authorizes overage — which
    // is exactly how overage engages at the weekly wall, since hitting the wall
    // is what wrote the mark in the first place. A mark that is newer than the
    // last probe still blocks (a fresh refusal wins).
    return (
      accountEligibility({
        mark: this.exhaustionMarkOf(account),
        snapshot,
        now,
        allowOverage: true,
        entitlementBlocked: this.isAccountEntitlementBlocked(account),
      }) === "eligible"
    );
  }

  /**
   * Tri-state eligibility for a failover/serving candidate — the basis of the
   * Bug-1 fix. `'blocked'` only on POSITIVE exhaustion evidence (fresh
   * over-wall snapshot, or an unexpired mark with no fresher contradicting
   * snapshot). `'unknown'` when there is NO usable live snapshot and NO
   * unexpired mark — a candidate we simply haven't measured, which must NOT be
   * conflated with a hard block. See account-eligibility.ts.
   */
  private accountEligibilityOf(account: string): "blocked" | "eligible" | "unknown" {
    const snapshot = this.lastQuotaCache[account];
    const allowOverage = this.isOverageAllowed(account);
    const verdict = accountEligibility({
      mark: this.exhaustionMarkOf(account),
      snapshot,
      now: this.now(),
      allowOverage,
      entitlementBlocked: this.isAccountEntitlementBlocked(account),
    });
    // Observability: when an account is being served past the utilization wall
    // because overage lifted it, emit a log so the operator can see that
    // Anthropic overage billing is active and spending real money.
    if (
      verdict === "eligible" &&
      allowOverage &&
      snapshot &&
      (snapshot.fiveHourUtilizationPct >= WALL_PCT ||
        snapshot.sevenDayUtilizationPct >= WALL_PCT)
    ) {
      process.stdout.write(
        `auth-broker: ${account} is past the utilization wall but eligible via allow_overage — Anthropic overage billing active (5h=${snapshot.fiveHourUtilizationPct.toFixed(1)}%, 7d=${snapshot.sevenDayUtilizationPct.toFixed(1)}%)\n`,
      );
    }
    return verdict;
  }

  /**
   * Force a single live quota probe of `account` and fold the result into the
   * in-memory cache / self-heal path — the SAME caching `opProbeQuota` does on
   * a successful probe, factored out so the failover selector can resolve an
   * `unknown` (never-probed / transiently-failed) candidate to a real verdict
   * before ruling it out. Bypasses the TTL gate (this is the live corroboration
   * Bug 1 needs) but shares the single-flight wrapper, so a concurrent render
   * probe of the same label coalesces. A failed probe is a no-op (the candidate
   * stays `unknown`); never throws into the caller.
   */
  private async probeAndCacheOne(account: string): Promise<void> {
    try {
      const creds = readAccountCredentials(account, this.home);
      const token = creds?.claudeAiOauth?.accessToken;
      if (!token) return;
      const result = await this.probeQuotaSingleFlight(account, token);
      if (result.ok) this.cacheQuotaSnapshot(account, result);
      // An entitlement-403 (Claude Code access disabled) is a hard block — mark
      // it so this force-probe of an `unknown` candidate can never route onto a
      // disabled account. Any other failure stays the legacy no-op.
      else this.markEntitlementBlocked(account, result);
    } catch {
      // Probe failures stay no-ops — the candidate remains `unknown` and is
      // handled as a last-resort by the selector, never a hard block.
    }
  }

  /**
   * Failover-selection variant of {@link nextHealthyAccount} that resolves
   * `unknown` candidates with a LIVE probe before declaring "all blocked".
   *
   * The Bug-1 race: the gateway probes every account into its own `quotas`
   * array, but the broker's selector re-read only its OWN cache — which is
   * written ONLY on a successful probe. A candidate whose probe missed/errored
   * (or was never run) therefore had no fresh snapshot; a stale `exhausted_until`
   * mark then made it look `blocked`, so selection returned null → the fleet
   * wrongly broadcast "all accounts blocked" while a secondary had headroom
   * (proven by a retry 6 min later switching to it cleanly).
   *
   * Fix: when the cache-only pass finds no clearly-`eligible` candidate, force a
   * live probe of every `unknown` candidate and re-run selection. A candidate
   * that is genuinely healthy now is picked; one that is genuinely walled stays
   * blocked. If after probing there is STILL no eligible account, fall back to
   * the first `unknown` candidate-of-last-resort (better to try an unmeasured
   * account than to go dark) — but a truly all-exhausted fleet (every candidate
   * resolves to `blocked`) still returns null → the honest all-blocked path.
   */
  private async nextHealthyAccountLive(
    current: string,
    order: readonly string[],
  ): Promise<string | null> {
    // Fast path: a clearly-eligible candidate from cache needs no probe.
    // Soft-avoid (#3031): a soft-avoided candidate does NOT take the fast
    // path — fall through to the unknown-probe pass so a never-measured
    // fallback with real headroom can outrank it. (With the config knob
    // unset this extra predicate is structurally false — identical path.)
    const cached = this.nextHealthyAccount(current, order);
    if (
      cached &&
      this.accountEligibilityOf(cached) === "eligible" &&
      !this.isAccountSoftAvoided(cached)
    ) {
      return cached;
    }

    // No cache-eligible candidate. Force-probe the `unknown` candidates (the
    // ones with no positive evidence) so a never-probed-but-healthy secondary
    // gets a real verdict instead of being lumped in with the truly walled.
    // `ring` walks the fallback order starting just AFTER `current` (the same
    // wrap order `nextHealthyAccount` uses).
    const start = order.indexOf(current);
    const ring: string[] =
      start === -1
        ? [...order]
        : order.map((_, i) => order[(start + 1 + i) % order.length]).filter((x): x is string => !!x);
    const unknowns = ring.filter(
      (cand) => cand && cand !== current &&
        accountExists(cand, this.home) &&
        this.accountEligibilityOf(cand) === "unknown",
    );
    await Promise.all(unknowns.map((cand) => this.probeAndCacheOne(cand)));

    // Re-run selection now that the unknowns carry live verdicts.
    const reselected = this.nextHealthyAccount(current, order);
    if (reselected && this.accountEligibilityOf(reselected) === "eligible") return reselected;

    // Still no eligible account. Prefer the first candidate that is `unknown`
    // even after the probe (a last-resort try beats going dark) over returning
    // null. A candidate that probed `blocked` is never offered here.
    for (const cand of ring) {
      if (cand && cand !== current && accountExists(cand, this.home) &&
          !this.exclusiveOwnerOf(cand) &&
          this.accountEligibilityOf(cand) === "unknown") {
        return cand;
      }
    }
    // Genuinely all-exhausted: every candidate resolved to `blocked`. Honest
    // all-blocked — the caller surfaces the "all accounts blocked" card.
    return null;
  }

  /**
   * `account`, unless it's within a mark-exhausted window — then the first
   * non-exhausted account in `fallback_order` that has stored credentials.
   * Falls back to `account` itself when no healthy alternative exists (better
   * to retry the pinned/active account than serve nothing — an all-walled
   * fleet keeps trying rather than going dark).
   *
   * Shared by the consumer serving path AND the agent serving/fanout path.
   * The agent path is the durable half of the #2218 weekly-wall fix:
   * `mark-exhausted` marks quota + mirrors failover creds once but leaves
   * `auth.active` pointed at the walled account, so the exhaustion-BLIND
   * refresh-tick fanout (refreshOneAccount → fanoutToAffectedAgents, every
   * ~1h when the walled account's OAuth token refreshes — refresh works fine,
   * a quota wall is not an auth failure) would otherwise silently re-mirror the
   * walled creds back onto the fleet, undoing the auto-fallback. Routing
   * fanout + serving through this read makes the exhaustion window actually
   * hold, and — like the consumer path — auto-reverts once the window passes.
   */
  private accountWithFailover(
    account: string | null | undefined,
    forAgent?: string,
  ): string | null {
    if (!account) return null;
    // The BASE account can itself be exclusive to someone else — reachable
    // when hot-mutated or persisted state escaped both the yaml validator and
    // the applyActiveOverride drop (defense-in-depth). Never serve it: pick
    // the first healthy servable fallback, else the servable active, else
    // DENY (null) — an honest ACCOUNT_NOT_FOUND beats leaking the exclusive
    // account's credentials to a non-owner.
    if (!this.isServableBy(account, forAgent)) {
      for (const cand of this.config.auth?.fallback_order ?? []) {
        if (cand === account || this.isAccountExhausted(cand)) continue;
        if (!this.isServableBy(cand, forAgent)) continue;
        if (readAccountCredentials(cand, this.home)) return cand;
      }
      const active = this.config.auth?.active;
      if (
        active &&
        active !== account &&
        !this.isAccountExhausted(active) &&
        this.isServableBy(active, forAgent) &&
        readAccountCredentials(active, this.home)
      ) {
        return active;
      }
      return null;
    }
    const exhausted = this.isAccountExhausted(account);
    // Soft-avoid (#3031): a non-exhausted account still serves, but when it
    // sits in the soft-avoid tier we PREFER a fully-eligible fallback. With
    // `auth.proactive_failover_pct` unset this predicate is structurally
    // false, so the fast path below is byte-identical to the pre-#3031 code.
    if (!exhausted && !this.isAccountSoftAvoided(account)) return account;
    // Pass 1 — first fallback candidate that is neither exhausted nor
    // soft-avoided (the preference ranking: fully-eligible beats soft-avoid).
    // Track whether soft-avoid actually excluded anyone: if it never fired,
    // pass 2's predicates are identical to this scan, so it can be skipped
    // (no pointless credential re-reads — identical behavior, less I/O).
    //
    // Every candidate scan (both passes, the soft-avoid tie-break, and the
    // last-resort active) also skips accounts exclusive to another agent
    // (`isServableBy`). Yaml validation keeps exclusive accounts out of
    // `fallback_order` / `active`, so this is defense-in-depth for
    // hot-mutated or persisted-override state — a caller must never be
    // served credentials that belong to someone else's exclusive pin.
    let softAvoidExcludedAny = false;
    for (const cand of this.config.auth?.fallback_order ?? []) {
      if (cand === account || this.isAccountExhausted(cand)) continue;
      if (!this.isServableBy(cand, forAgent)) continue;
      if (this.isAccountSoftAvoided(cand)) {
        softAvoidExcludedAny = true;
        continue;
      }
      if (readAccountCredentials(cand, this.home)) return cand;
    }
    if (!exhausted) {
      // The account is merely soft-avoided and no fully-eligible fallback
      // exists — every serveable candidate is soft-avoided too. Serve the
      // least-utilized of them (most headroom) and do NOT roll anything.
      // Never returns null: `account` itself is always a candidate, so this
      // branch cannot reduce availability relative to pre-#3031 behavior.
      let best = account;
      let bestScore = this.softAvoidUtilScore(account);
      for (const cand of this.config.auth?.fallback_order ?? []) {
        if (cand === account || this.isAccountExhausted(cand)) continue;
        if (!this.isServableBy(cand, forAgent)) continue;
        if (!readAccountCredentials(cand, this.home)) continue;
        const score = this.softAvoidUtilScore(cand);
        if (score < bestScore) {
          best = cand;
          bestScore = score;
        }
      }
      return best;
    }
    // Pass 2 — exhausted, and no fully-eligible fallback: the pre-#3031
    // behavior. A soft-avoided fallback beats retrying a hard-exhausted pin.
    // Only worth scanning when pass 1 actually excluded someone for being
    // soft-avoided — otherwise the predicates are identical and pass 1
    // already proved no candidate has credentials.
    if (softAvoidExcludedAny) {
      for (const cand of this.config.auth?.fallback_order ?? []) {
        if (cand === account || this.isAccountExhausted(cand)) continue;
        if (!this.isServableBy(cand, forAgent)) continue;
        if (readAccountCredentials(cand, this.home)) return cand;
      }
    }
    // Last-resort: if auth.active is set, is different from the exhausted
    // account, is itself not exhausted, and has credentials, use it.
    //
    // This intentionally breaks consumer quota-isolation as a last resort to
    // avoid a total stall. It only triggers when BOTH the consumer's pinned
    // account AND every fallback_order member are walled — the 2026-06-19
    // incident where hindsight stalled fleet-wide for ~2h because auth.active
    // was healthy but never consulted. For agents, callerAccount() already
    // returns auth.active, so account === active and this branch is skipped
    // (strict no-op). For consumers whose pinned account differs from
    // auth.active, this gives the fleet-active account as an emergency escape
    // hatch, and reverts automatically once the exhaustion window clears.
    const active = this.config.auth?.active;
    if (
      active &&
      active !== account &&
      !this.isAccountExhausted(active) &&
      this.isServableBy(active, forAgent) &&
      readAccountCredentials(active, this.home)
    ) {
      return active;
    }
    return account;
  }

  /* ─── Op handlers ───────────────────────────────────────────── */

  private async opGetCredentials(
    socket: net.Socket,
    id: string,
    identity: Identity,
  ): Promise<void> {
    // Serving path → failover-aware (a consumer's exhausted pinned account
    // fails over). mark-exhausted stays on the raw callerAccount for attribution.
    const account = this.servingAccount(identity);
    if (!account) {
      this.audit({ op: "get-credentials", identity, accountKind: "claude", ok: false, error: "no-active-account" });
      socket.write(encodeError(id, "ACCOUNT_NOT_FOUND", "no active account configured"));
      return;
    }
    const creds = readAccountCredentials(account, this.home);
    if (!creds) {
      this.audit({ op: "get-credentials", identity, account, accountKind: "claude", ok: false, error: "missing-credentials" });
      socket.write(encodeError(id, "ACCOUNT_NOT_FOUND", `no credentials for account '${account}'`));
      return;
    }
    const expiresAt = creds.claudeAiOauth?.expiresAt;
    this.audit({ op: "get-credentials", identity, account, accountKind: "claude", ok: true });
    socket.write(encodeSuccess(id, { account, credentials: creds, expiresAt }));
  }

  private async opListState(
    socket: net.Socket,
    id: string,
    identity: Identity,
  ): Promise<void> {
    const auth = this.config.auth ?? {};
    // The config's in-service account set (active ∪ fallback_order ∪ agent
    // overrides ∪ consumer pins). An account absent from this set is RETIRED —
    // its credentials linger on disk but the fleet no longer routes to it, so
    // the views must not render it as "available". Computed once per call.
    const inService = this.inServiceSet();
    const accounts = listAccounts(this.home).map((label) => {
      const creds = readAccountCredentials(label, this.home);
      const meta = readAccountMeta(label, this.home);
      const q = this.quota[label];
      // Report the SAME live-authoritative verdict the failover path uses, so
      // the dashboard / quota-watch never see `exhausted=true` while live util
      // is healthy (the contradicting-fields bug). `exhausted_until` still
      // carries the raw mark for transparency.
      const exhausted = this.isAccountExhausted(label);
      const lq = this.lastQuotaCache[label];
      return {
        label,
        expiresAt: creds?.claudeAiOauth?.expiresAt,
        exhausted,
        // Fleet in-service classification: true when the config still routes to
        // this account. false → RETIRED (removed from rotation); the views
        // render it as such instead of "available".
        in_service: inService.has(label),
        exhausted_until: q?.exhausted_until,
        // 429 throttle tier — raw ledger value for transparency (consumers
        // compare against their own clock). Never feeds `exhausted`.
        throttled_until: q?.throttled_until,
        threshold_violations: this.thresholdViolations[label] ?? 0,
        last_refreshed_at: meta?.lastRefreshedAt,
        // Cached utilization snapshot from the most recent probeQuota call.
        // null when no probe has been run since broker start.
        last_quota: lq ?? null,
        // #3176 — flagship-tier (7d_oi) wall: live-authoritative verdict +
        // raw mark + latest canary snapshot for the dashboard/operator card.
        premium_walled: this.isAccountPremiumWalled(label),
        premium_walled_until: q?.premium_walled_until,
        premium_wall_bucket: q?.premium_wall_bucket,
        last_tier_quota: this.lastTierQuotaCache[label] ?? null,
        // Entitlement-403 hard block: org/subscription disabled Claude Code
        // access. Renderers (PR1) show DISABLED off this flag.
        entitlement_blocked: q?.entitlement_blocked ?? false,
        // #3185 — rolling per-tier usage summary (refill-normalized) so the
        // operator/dashboard can answer "how much Fable is left" instantly.
        usage_ledger: summarizeAccountUsage(this.usageLedger, label, this.now()),
      };
    });
    const agents = Object.entries(this.config.agents ?? {}).map(([name, agent]) => {
      const override = agent.auth?.override ?? null;
      const account = override ?? auth.active ?? "";
      // Pin posture (additive fields): renderers can flag a hard pin and an
      // owner-locked account instead of showing them as fleet-poolable.
      const strict = Boolean(override && agent.auth?.strict);
      const exclusive = Boolean(override && agent.auth?.exclusive);
      return { name, account, override, strict, exclusive };
    });
    const consumers = (auth.consumers ?? []).map((c) => ({
      name: c.name,
      // Unpinned consumers report the account they are bound to right now
      // (the fleet active) so dashboards stay truthful; the wire shape
      // stays a plain string either way.
      account: c.account ?? auth.active ?? "",
      last_seen_at: this.consumerLastSeen[c.name] ?? null,
    }));
    // Identity-specific overage signal: is the account THIS caller is bound to
    // currently authorized to serve on Anthropic overage past the weekly wall?
    // The in-agent wedge-watchdog reads this (never config) to decide whether a
    // `/rate-limit-options` menu may select "usage credits". Default-off: false
    // whenever `allow_overage_accounts` is empty (the default).
    const active_overage_serving = this.isActiveOverageServing(
      this.callerAccount(identity),
    );
    // The account the fleet is ACTUALLY served from right now. `auth.active`
    // is the configured PIN, and the pin is not always what serves: the
    // soft-avoid proactive roll (`softAvoidProbeRoll`, #3031 PR 2) mirrors a
    // different account's credentials onto every rider agent while
    // deliberately leaving `auth.active` alone ("NO durable promote of
    // auth.active"), and the exhaustion-blind fanout guard routes serving
    // through `accountWithFailover` for the same reason. Reporting only the
    // pin made every "(active)" renderer name an account that had already
    // been rolled off. Identity-independent: this is the FLEET's serving
    // account (`accountWithFailover(auth.active)` — the very resolver
    // `servingAccount` uses), not the caller's.
    const serving = this.accountWithFailover(auth.active) ?? auth.active ?? "";
    this.audit({ op: "list-state", identity, ok: true });
    socket.write(
      encodeSuccess(id, {
        active: auth.active ?? "",
        serving,
        fallback_order: auth.fallback_order ?? [],
        accounts,
        agents,
        consumers,
        active_overage_serving,
        // #3031 — most recent broker-initiated proactive roll, so gateways
        // can announce it (null until the first proactive roll).
        last_fleet_roll: this.lastFleetRoll,
        // #3176 — fleet-wide flagship-tier all-walled alert (null unless every
        // account is walled on the 7d_oi bucket with no eligible failover).
        premium_tier_all_walled: this.premiumTierAllWalled,
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
    this.audit({ op: "list-google-accounts", identity, accountKind: "google", ok: true });
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
    forceLive?: boolean,
  ): Promise<void> {
    // #2495 Change 2/3 — forceLive (quota-watch corroboration) bypasses the
    // TTL gate so the alarm decision is taken off a true live probe, not a
    // possibly-stale cache read. Single-flight still applies.
    const ttlMs = forceLive ? 0 : quotaProbeTtlMs();
    const results = await Promise.all(
      accounts.map(async (label): Promise<{ label: string; result: QuotaResult; served?: "live" | "cache"; capturedAt?: number }> => {
        // #2495 Change 2 — TTL gate: a cached snapshot younger than the TTL
        // serves the cache, skipping the billable upstream probe entirely.
        const cached = this.lastQuotaCache[label];
        if (ttlMs > 0 && cached && this.now() - cached.capturedAt < ttlMs) {
          return { label, result: cachedSnapshotToResult(cached), served: "cache", capturedAt: cached.capturedAt };
        }

        const creds = readAccountCredentials(label, this.home);
        const token = creds?.claudeAiOauth?.accessToken;
        if (!token) {
          // No live creds. If we have ANY prior snapshot, serve it stale rather
          // than render a blank card; otherwise surface the failure.
          if (cached) {
            return { label, result: cachedSnapshotToResult(cached), served: "cache", capturedAt: cached.capturedAt };
          }
          const result: QuotaResult = {
            ok: false,
            reason: "no credentials for account in broker store",
          };
          this.audit({ op: "probe-quota", identity, account: label, accountKind: "claude", ok: false, error: "missing-credentials" });
          return { label, result };
        }

        // #2495 Change 2 — single-flight: concurrent renders for the same label
        // share one in-flight upstream probe (a render storm = 1 API call).
        const result = await this.probeQuotaSingleFlight(label, token, timeoutMs);
        this.audit({
          op: "probe-quota",
          identity,
          account: label,
          accountKind: "claude",
          ok: result.ok,
          error: result.ok ? undefined : result.reason,
        });
        // Cache the utilization snapshot for listState consumers (quota-watch
        // loop). Only update on success — a failed probe should not evict a
        // valid previous snapshot.
        if (result.ok) {
          this.cacheQuotaSnapshot(label, result);
          return { label, result, served: "live" };
        }
        // An entitlement-403 (org disabled Claude Code access) is a real,
        // durable account-level block — persist it so a failed probe is NOT the
        // silent no-op that serves the stale cache. Eligibility + list-state
        // then surface DISABLED instead of decaying to "unknown". Any other
        // failure stays a no-op (legacy behaviour).
        this.markEntitlementBlocked(label, result);
        // #2495 Change 2 — probe FAILED. If we have a prior snapshot, serve it
        // age-stamped (served:"cache") so the card renders an explicit
        // "⚠ cached Nm ago" warning instead of a false live stamp.
        if (cached) {
          return { label, result: cachedSnapshotToResult(cached), served: "cache", capturedAt: cached.capturedAt };
        }
        return { label, result, served: "live" };
      }),
    );
    socket.write(encodeSuccess(id, { results }));
  }

  /**
   * #2495 Change 2 — single-flight wrapper around a live quota probe. The
   * first caller for a label starts the upstream `fetchQuota`; concurrent
   * callers await the SAME promise. The entry is cleared when it settles, so
   * the next probe-on-open (after the TTL window) starts a fresh call.
   */
  private probeQuotaSingleFlight(
    label: string,
    token: string,
    timeoutMs?: number,
  ): Promise<QuotaResult> {
    const existing = this.probeInFlight.get(label);
    if (existing) return existing;
    const pending = this.fetchQuotaImpl({ accessToken: token, timeoutMs })
      .finally(() => {
        // Only clear if WE are still the registered in-flight promise (a later
        // probe could have replaced it after we settled).
        if (this.probeInFlight.get(label) === pending) this.probeInFlight.delete(label);
      });
    this.probeInFlight.set(label, pending);
    return pending;
  }

  /** Store a successful quota probe in the in-memory cache that `list-state`
   *  (and thus the dashboard) reads. Shared by the explicit probe op and the
   *  periodic fleet tick so the snapshot shape stays in one place. */
  private cacheQuotaSnapshot(label: string, result: QuotaResult): void {
    if (!result.ok) return;
    // A successful probe is proof the account is reachable again — clear any
    // entitlement-403 hard block (the org re-enabled Code access, or the 403 was
    // transient). Done before caching so list-state/eligibility see it lifted.
    this.clearEntitlementBlocked(label);
    const snapshot = {
      fiveHourUtilizationPct: result.data.fiveHourUtilizationPct,
      sevenDayUtilizationPct: result.data.sevenDayUtilizationPct,
      fiveHourResetAt: result.data.fiveHourResetAt?.toISOString() ?? null,
      sevenDayResetAt: result.data.sevenDayResetAt?.toISOString() ?? null,
      representativeClaim: result.data.representativeClaim,
      overageStatus: result.data.overageStatus,
      overageDisabledReason: result.data.overageDisabledReason,
      capturedAt: this.now(),
      fiveHourUtilPresent: result.data.fiveHourUtilPresent,
      sevenDayUtilPresent: result.data.sevenDayUtilPresent,
    };
    this.lastQuotaCache[label] = snapshot;
    // #2495 Change 1 — persist the cache so a broker restart serves this
    // last-known snapshot (age-stamped via capturedAt) instead of blank.
    this.persistLastQuotaCache();
    // #3185 — harvest a STANDARD-tier usage sample from the SAME probe headers
    // (zero added requests). A thin probe yields null → no-op.
    this.recordUsage(label, "standard", standardSampleFromResult(result, this.now()));
    // Self-heal: a fresh, clearly-healthy probe (both windows well under the
    // wall) that is newer than the mark CLEARS the persisted mark — so a
    // misfired/expired exhaustion can't linger on disk and survive restarts
    // (the sticky-bogus-+7d-mark that outlasted recreate on 2026-06-10). A
    // genuine weekly wall (7d≥99.5%) is never "clearly healthy" → never cleared.
    if (snapshotShouldClearMark(snapshot, this.exhaustionMarkOf(label), this.now())) {
      delete this.quota[label];
      this.persistQuota();
      process.stdout.write(
        `auth-broker: live probe shows ${label} healthy (5h=${snapshot.fiveHourUtilizationPct}% 7d=${snapshot.sevenDayUtilizationPct}%) — cleared stale exhaustion mark\n`,
      );
      // Re-mirror any consumer whose pinned account is `label` — now that the
      // exhaustion mark is cleared the serving path reverts to the pinned
      // account, so push the revert immediately rather than waiting for the
      // consumer's next pull-loop tick. This is the auto-revert path.
      this.fanoutToAffectedConsumers(label);
    }
  }

  /**
   * Periodic background probe of every account's 5h/7d quota, so the dashboard
   * shows live utilization WITHOUT the operator clicking "Refresh all quota".
   * Each probe is a 1-token Haiku call (fetchQuota) — negligible spend. Caches
   * the snapshot for `list-state`; a failed probe is a no-op (keeps the prior
   * snapshot). Never throws into the timer. Public for tests.
   *
   * Proactive fleet failover (2026-07-05 incident): when the fresh probe of
   * the ACTIVE account indicates exhaustion (same overage-aware test the
   * consumer sensor uses), mark it and roll the fleet immediately — without
   * waiting for an agent to crash into the wall mid-turn. The reactive
   * 429/TUI-wall path stays as the fast trigger; this closes the idle-fleet
   * gap (a wall crossed overnight previously sat unhandled until the next
   * live turn failed) AND the recreate-revert gap (this runs at boot, so a
   * recreated broker whose stale yaml points at a walled account self-heals
   * on the first tick instead of re-poisoning the fleet). Self-quiescing:
   * a successful roll auto-promotes the target to `auth.active`, so the
   * next tick probes a healthy active and no-ops. During a true all-blocked
   * window the roll re-runs each tick and succeeds on the first tick after
   * any fallback's window refills.
   */
  async fleetQuotaProbeTick(): Promise<void> {
    // Phase 1 — probe + cache EVERY account before acting. The act phase
    // (hard-exhaustion roll / soft-avoid serving roll) compares the probed
    // account against its fallback candidates; acting mid-scan would rank
    // candidates the loop simply hadn't reached yet (stale/absent snapshots)
    // — most visibly on the boot tick, where nothing is cached at all.
    const probed: Array<{ label: string; result: QuotaResult }> = [];
    // #3176 — accounts whose flagship-tier canary reported a 7d_oi wall this
    // tick, collected in Phase 1 and acted on in Phase 2 (same probe-all-then-
    // act discipline the exhaustion path uses).
    const tierWalled = new Map<string, { until: number | null; bucket: string | null }>();
    // The set the premium canary probes: the fleet active + fallback candidates
    // + pinned agent accounts. Probing only the serving set bounds flagship
    // spend (a 200 canary costs one flagship token; a walled canary 429s free).
    const canarySet = this.premiumCanarySet();
    const canaryEnabled = process.env.SWITCHROOM_DISABLE_MODEL_TIER_PROBE !== "1";
    for (const label of listAccounts(this.home)) {
      // Skip a hard entitlement-blocked account: its 403 (org disabled Claude
      // Code access) won't clear by re-probing — the org must re-enable access —
      // so each tick probe is a wasted billable call against a dead account. An
      // explicit manual re-probe (opProbeQuota) still runs and clears the mark
      // on success.
      if (this.isAccountEntitlementBlocked(label)) continue;
      const creds = readAccountCredentials(label, this.home);
      const token = creds?.claudeAiOauth?.accessToken;
      if (!token) continue;
      let result: QuotaResult;
      try {
        result = await this.fetchQuotaImpl({ accessToken: token });
      } catch (err) {
        this.logErr(`fleet-quota-probe ${label}: ${(err as Error).message}`);
        continue;
      }
      this.cacheQuotaSnapshot(label, result);
      // An entitlement-403 from the tick probe is a hard block — mark it (and
      // skip this account on subsequent ticks). Any other failure is a no-op.
      this.markEntitlementBlocked(label, result);
      probed.push({ label, result });
      // #3176 — flagship-tier canary. The default haiku probe above CANNOT see
      // the per-tier 7d_oi wall (haiku is `allowed` while flagship is
      // `rejected`), so we issue a second 1-token request against the flagship
      // tier and read its own response headers.
      if (canaryEnabled && canarySet.has(label)) {
        let tierResult: QuotaResult;
        try {
          tierResult = await this.fetchQuotaImpl({ accessToken: token, model: this.modelTierProbeModel });
        } catch (err) {
          this.logErr(`fleet-tier-probe ${label}: ${(err as Error).message}`);
          continue;
        }
        this.recordTierProbe(label, tierResult);
        const wall = quotaIndicatesModelTierWall(tierResult);
        if (wall.walled) tierWalled.set(label, { until: wall.until, bucket: wall.bucket });
      }
    }
    // #3176 — pre-mark EVERY flagship-walled account before the roll phase.
    // Without this, Phase 2 marks accounts one at a time, so the first walled
    // account's roll would pick a second walled account that simply hadn't
    // been marked yet (same ordering hazard the exhaustion path avoids by
    // probing all before acting). Marking first makes
    // `nextPremiumEligibleAccount` see the true fleet-wide state.
    for (const [label, wall] of tierWalled) {
      const now = this.now();
      this.quota[label] = {
        ...this.quota[label],
        premium_walled_until: wall.until ?? now + MODEL_TIER_WALL_DEFAULT_MS,
        premium_wall_bucket: wall.bucket ?? undefined,
        premium_wall_marked_at: now,
      };
    }
    if (tierWalled.size > 0) this.persistQuota();
    // Phase 2 — act on the fleet ACTIVE and on PINNED agent accounts.
    for (const { label, result } of probed) {
      // Re-read active each iteration: a promote earlier in this loop moves it.
      const active = this.config.auth?.active;
      // PR 2 of #3031 — the probe acts on PINNED agent accounts too (the
      // consumerQuotaProbeTick analog for `auth.override`): a pin is a
      // PRIMARY, not a hard pin, so a pinned agent whose account walls (or
      // enters the soft-avoid tier) fails over the same way the fleet
      // active does. Non-active, non-pinned labels stay probe-only.
      const isPinnedAgentAccount = this.pinnedAgentAccounts().has(label);
      if (label !== active && !isPinnedAgentAccount) continue;
      // #3176 — flagship-tier (7d_oi) wall acts BEFORE the 5h/7d exhaustion
      // check: this is exactly the case the haiku probe reads healthy (the
      // incident). A tier wall is tier-scoped (the account still serves
      // opus/haiku), so it takes the dedicated tier roll, not mark-exhausted.
      const tw = tierWalled.get(label);
      if (tw) {
        process.stdout.write(
          `auth-broker: fleet-tier-probe shows ${label === active ? "ACTIVE" : "PINNED"} ${label} ` +
            `flagship-tier walled (bucket=${tw.bucket ?? "?"}) — model-tier failover\n`,
        );
        this.audit({ op: "mark-exhausted", identity: { kind: "operator" }, account: label, accountKind: "claude", ok: true, reason: "model-tier-wall" });
        const { rolledTo, allWalled, earliestReset } = this.markPremiumWalledAndRoll(label, tw.until, tw.bucket);
        if (rolledTo && label === active) {
          this.recordFleetRoll(label, rolledTo, "model-tier-wall", tw.until ?? undefined, tw.bucket);
        } else if (allWalled && label === active) {
          this.recordPremiumAllWalled(tw.bucket, earliestReset);
        }
        continue;
      }
      const decision = quotaIndicatesExhaustion(result, this.isOverageAllowed(label));
      if (decision.exhausted) {
        process.stdout.write(
          `auth-broker: fleet-quota-probe shows ${label === active ? "ACTIVE" : "PINNED"} ${label} exhausted — proactive failover\n`,
        );
        // Audit parity with the consumer sensor: a proactive mark leaves a
        // durable audit record, not just a stdout line (#2845 review nit).
        this.audit({ op: "mark-exhausted", identity: { kind: "operator" }, account: label, accountKind: "claude", ok: true, reason: "hard-exhaustion" });
        // Pinned accounts share the exact roll core: mark + mirror-fanout to
        // every agent whose raw effective account is `label`. The durable
        // auto-promote inside is self-gating (`auth.active === account`), so
        // a pinned-only wall never mutates the fleet active.
        const { rolledTo } = await this.markExhaustedAndRoll(label, decision.until ?? undefined, { kind: "operator" });
        // Record the broker-initiated FLEET roll so gateways can announce it
        // (list-state `last_fleet_roll`; announcement channel is #3031 PR 3).
        // Only when a target was actually found (an all-blocked no-roll is
        // the fleet-all-exhausted alert's domain) and only for the fleet
        // ACTIVE — a pinned-only roll is not a fleet roll and must not
        // overwrite a pending fleet announcement (it stays audit-only).
        if (rolledTo && label === active) {
          this.recordFleetRoll(label, rolledTo, "hard-exhaustion", decision.until ?? undefined);
        }
        continue;
      }
      // PR 2 of #3031 — not hard-walled: act on the soft-avoid PREFERENCE
      // tier with a serving-preference roll (mirror push only — no mark, no
      // durable promote). Structurally a no-op while
      // `auth.proactive_failover_pct` is unset.
      this.softAvoidProbeRoll(label);
    }
  }

  /**
   * Write + persist the `last_fleet_roll` record for a broker-initiated
   * proactive roll of the fleet ACTIVE (`fleetQuotaProbeTick` hard-exhaustion
   * or soft-avoid path). Gateways read it from `list-state` and announce it
   * to the operator with claim-notification dedup (#3031 PR 3) — this is the
   * ONLY notification surface PR 2 touches; the roll stays silent here.
   * Window/pct attribution comes from the snapshot the tick just cached.
   */
  private recordFleetRoll(
    from: string,
    to: string,
    reason: "soft-avoid" | "hard-exhaustion" | "model-tier-wall",
    exhaustedUntil?: number,
    bucket?: string | null,
  ): void {
    const s = this.lastQuotaCache[from];
    this.lastFleetRoll = {
      from,
      to,
      at: this.now(),
      reason,
      ...(bucket ? { bucket } : {}),
      ...(exhaustedUntil != null ? { exhausted_until: exhaustedUntil } : {}),
      // A model-tier wall does not bind on the 5h/7d windows — those read
      // healthy (the whole point of the bug). Only stamp window/pct for the
      // 5h/7d-driven rolls, where they are meaningful.
      ...(s && reason !== "model-tier-wall"
        ? {
            window:
              s.fiveHourUtilizationPct >= s.sevenDayUtilizationPct
                ? ("5h" as const)
                : ("7d" as const),
            pct: Math.max(s.fiveHourUtilizationPct, s.sevenDayUtilizationPct),
          }
        : {}),
    };
    this.persistLastFleetRoll();
  }

  /* ─── Premium-tier all-walled alert (#3176) ─────────────────── */

  /** Fleet-wide "every account is flagship-tier walled" state (see
   *  {@link PremiumTierAllWalled}). Persisted so a restart doesn't drop the
   *  operator alert. Null when at least one account can serve the flagship. */
  private premiumTierAllWalled: PremiumTierAllWalled | null = null;

  /** Record the all-flagship-walled condition for the operator card. */
  private recordPremiumAllWalled(bucket: string | null, earliestReset: number | null): void {
    this.premiumTierAllWalled = {
      bucket,
      ...(earliestReset != null ? { earliest_reset: earliestReset } : {}),
      at: this.now(),
    };
    atomicWriteJsonSync(
      join(this.stateDir, "premium-tier-all-walled.json"),
      this.premiumTierAllWalled,
      0o600,
    );
    process.stdout.write(
      `auth-broker: ALL accounts flagship-tier walled (bucket=${bucket ?? "?"}` +
        `${earliestReset != null ? `, earliest reset ${new Date(earliestReset).toISOString()}` : ""}) ` +
        `— no premium-eligible failover target\n`,
    );
  }

  /** Clear the all-walled alert once any account can serve the flagship again. */
  private clearPremiumAllWalled(): void {
    if (this.premiumTierAllWalled == null) return;
    this.premiumTierAllWalled = null;
    try { unlinkSync(join(this.stateDir, "premium-tier-all-walled.json")); } catch { /* best-effort */ }
  }

  /**
   * The set of accounts the flagship-tier canary probes each tick: the fleet
   * active, every `fallback_order` candidate (so a wall is seen BEFORE the
   * fleet rolls onto it), and every pinned agent account. Bounds flagship
   * spend to the serving set.
   */
  private premiumCanarySet(): Set<string> {
    const set = new Set<string>();
    const active = this.config.auth?.active;
    if (active) set.add(active);
    for (const cand of this.config.auth?.fallback_order ?? []) set.add(cand);
    for (const acct of this.pinnedAgentAccounts()) set.add(acct);
    return set;
  }

  /**
   * The fleet's IN-SERVICE account set — every account the config still routes
   * traffic to: the fleet active, every `fallback_order` candidate, every
   * per-agent `auth.override` pin, and every consumer pin
   * (`auth.consumers[].account`). An account NOT in this set has been fully
   * removed from rotation (dropped from `fallback_order` and every agent /
   * consumer pin) — it is RETIRED, and the account views must render it as such
   * rather than "available", even though its credentials still sit on disk.
   *
   * Superset of {@link premiumCanarySet} (adds consumer pins). Built ON TOP of
   * it deliberately: the flagship-canary probe scope (bounded by
   * `premiumCanarySet`) is unchanged by this display-only classifier.
   */
  private inServiceSet(): Set<string> {
    const set = this.premiumCanarySet();
    for (const c of this.config.auth?.consumers ?? []) {
      if (c.account) set.add(c.account);
    }
    return set;
  }

  /** Every account some agent is pinned to via per-agent `auth.override`. */
  private pinnedAgentAccounts(): Set<string> {
    return new Set(
      Object.values(this.config.agents ?? {})
        .map((a) => a.auth?.override)
        .filter((x): x is string => typeof x === "string" && x.length > 0),
    );
  }

  /**
   * PR 2 of #3031 — probe-tick-driven SERVING-preference roll off a
   * soft-avoided account (`label` is the fleet active or a pinned agent's
   * override). When the account sits in the soft-avoid tier AND a strictly
   * better candidate exists — non-exhausted, NOT itself soft-avoided, with
   * stored credentials (exactly the pass-1 preference `accountWithFailover`
   * applies) — push the failover credentials NOW via the same mirror
   * mechanism the hard-exhaustion roll uses (`fanoutFailoverTo` +
   * `fanoutToAffectedConsumers`), instead of waiting for each agent's next
   * credential read.
   *
   * Deliberately NOT the hard-exhaustion path:
   *  - NO exhaustion mark — the account still serves, and attribution
   *    (`callerAccount` / mark-exhausted) is untouched;
   *  - NO durable promote of `auth.active` and NO `active-override.json`
   *    write — the yaml-drift/override semantics are untouched, and the
   *    preference self-reverts (via the normal refresh-tick fanout, which
   *    routes through accountWithFailover) once the tier's exit hysteresis
   *    releases;
   *  - flap-safety is `isAccountSoftAvoided`'s enter/exit latch — no new
   *    hysteresis here. `softAvoidRolledTo` only dedupes an identical
   *    roll's fanout + audit across consecutive ticks.
   *
   * When every serveable candidate is soft-avoided too (no strictly better
   * candidate), this does NOT roll — the least-utilized ranking inside
   * `accountWithFailover` still shapes pull-path serving, but a proactive
   * push on a utilization tie-break would ping-pong as scores drift.
   *
   * Notification/messaging is PR 3 — this stays silent beyond the audit
   * record and a stdout line.
   */
  private softAvoidProbeRoll(label: string): void {
    if (!this.isAccountSoftAvoided(label)) {
      delete this.softAvoidRolledTo[label]; // tier released → memo reset
      return;
    }
    const target = this.accountWithFailover(label);
    if (!target || target === label || this.isAccountSoftAvoided(target)) {
      // No strictly-better candidate: don't roll. Clear the memo so a later
      // genuine improvement (a fallback dropping out of the tier) re-rolls.
      delete this.softAvoidRolledTo[label];
      return;
    }
    if (this.softAvoidRolledTo[label] === target) return; // already pushed
    this.softAvoidRolledTo[label] = target;
    process.stdout.write(
      `auth-broker: fleet-quota-probe shows ${label} soft-avoided (≥ auth.proactive_failover_pct) — serving-preference roll → ${target}\n`,
    );
    // Same audit shape as the probe's hard-exhaustion roll; `reason`
    // distinguishes the trigger (#3031 PR 2 deliverable).
    this.audit({ op: "proactive-roll", identity: { kind: "operator" }, account: label, accountKind: "claude", ok: true, reason: "soft-avoid" });
    // Same mirror mechanism as the hard-exhaustion roll: `target`'s creds
    // onto every agent whose raw effective account (override ?? active) is
    // `label` — fleet-active riders and pinned agents alike…
    this.fanoutFailoverTo(label, target);
    // …and push consumers bound to `label` (their serving path is already
    // soft-avoid-aware; this removes the pull-loop latency).
    this.fanoutToAffectedConsumers(label);
    // Fleet-ACTIVE rolls ride the `last_fleet_roll` announcement channel
    // (#3031 PR 3); a pinned-only roll stays audit-only so it can't
    // overwrite a pending fleet announcement.
    if (label === this.config.auth?.active) {
      this.recordFleetRoll(label, target, "soft-avoid");
    }
  }

  /**
   * Consumer-account quota sensor tick. Probes every account pinned by a
   * consumer and, when a probe shows a hard wall, marks it exhausted so the
   * consumer's serving-failover (accountWithFailover) kicks in. This
   * is the missing TRIGGER for a consumer (e.g. hindsight) on a dedicated
   * account that no agent shares — nothing else ever raises mark-exhausted for
   * it. Public for tests (driven directly via the `_testFetchQuota` seam).
   *
   * Sets `exhausted_until` to the probe's real reset time so it expires
   * race-free (no explicit clear). A FAILED probe is a no-op (never fail a
   * consumer over on a transient probe error). Never throws into the timer.
   */
  async consumerQuotaProbeTick(): Promise<void> {
    // PINNED accounts only: an unpinned consumer rides the fleet active,
    // which the fleet-wide probe (fleetQuotaProbeTick) already covers —
    // including the proactive roll when it walls.
    const accounts = Array.from(
      new Set(
        (this.config.auth?.consumers ?? [])
          .map((c) => c.account)
          .filter((a): a is string => typeof a === "string" && a.length > 0),
      ),
    );
    for (const label of accounts) {
      const creds = readAccountCredentials(label, this.home);
      const token = creds?.claudeAiOauth?.accessToken;
      if (!token) continue; // no creds → nothing to probe (don't mark)
      let result: QuotaResult;
      try {
        result = await this.fetchQuotaImpl({ accessToken: token });
      } catch (err) {
        this.logErr(`consumer-quota-probe ${label}: ${(err as Error).message}`);
        continue;
      }
      // Cache the fresh probe first: keeps the consumer account's snapshot warm
      // for the dashboard AND makes it the live truth clampMarkExpiry consults
      // below (so a genuine consumer weekly wall keeps its real reset). A
      // healthy probe here also self-heals any stale mark via cacheQuotaSnapshot.
      this.cacheQuotaSnapshot(label, result);
      const allowOverage = this.isOverageAllowed(label);
      const decision = quotaIndicatesExhaustion(result, allowOverage);
      if (!decision.exhausted) {
        // When util is walled but overage lifted it, log so the operator can
        // see that overage spend is active for this account.
        if (
          result.ok &&
          (result.data.fiveHourUtilizationPct >= EXHAUSTION_PCT ||
            result.data.sevenDayUtilizationPct >= EXHAUSTION_PCT) &&
          allowOverage
        ) {
          process.stdout.write(
            `auth-broker: consumer-quota-sensor ${label} is wall-walled but serving via overage (allow_overage) — Anthropic overage billing is active\n`,
          );
        }
        continue;
      }
      const now = this.now();
      // This probe IS the live truth for `label`, so a long until here is
      // self-corroborated — pass the snapshot so clampMarkExpiry honors a real
      // weekly reset while still clamping an uncorroborated default.
      const exhaustedUntil = clampMarkExpiry({
        proposedUntil: decision.until ?? now + MARK_EXHAUSTED_DEFAULT_MS,
        now,
        shortMs: MARK_EXHAUSTED_DEFAULT_MS,
        snapshot: this.lastQuotaCache[label],
      });
      // Idempotent: skip the write/persist if already marked at/past this reset.
      const existing = this.quota[label]?.exhausted_until;
      if (existing !== undefined && existing >= exhaustedUntil) continue;
      // Spread preserves throttle-tier fields (throttled_until/throttle_hits)
      // living beside the exhaustion mark in the same ledger entry.
      this.quota[label] = { ...this.quota[label], exhausted_until: exhaustedUntil, marked_at: now };
      this.persistQuota();
      this.audit({ op: "mark-exhausted", identity: { kind: "operator" }, account: label, accountKind: "claude", ok: true });
      process.stdout.write(
        `auth-broker: consumer-quota-sensor marked ${label} exhausted until ${new Date(exhaustedUntil).toISOString()} — consumer(s) fail over\n`,
      );
      // Push failover creds immediately to any consumer with a mirror_dir.
      // Without this push the consumer sits on stale credentials until its
      // next pull-loop tick (up to 30 min). This is the fix for the
      // 2026-06-25 hindsight outage: the sensor correctly detected exhaustion
      // but the consumer never got a push, so it stayed dead on the exhausted
      // account until the 30-min refresh loop happened to fire.
      this.fanoutToAffectedConsumers(label);
    }
  }

  private async opSetActive(
    socket: net.Socket,
    id: string,
    identity: Identity,
    account: string,
  ): Promise<void> {
    if (!this.isAdmin(identity)) {
      this.audit({ op: "set-active", identity, account, accountKind: "claude", ok: false, error: "FORBIDDEN" });
      this.respondForbidden(socket, id, "set-active requires admin");
      return;
    }
    if (!accountExists(account, this.home)) {
      this.audit({ op: "set-active", identity, account, accountKind: "claude", ok: false, error: "ACCOUNT_NOT_FOUND" });
      socket.write(encodeError(id, "ACCOUNT_NOT_FOUND", `account '${account}' not found`));
      return;
    }
    // An exclusive pin must never become the fleet active — that would route
    // every override-less agent onto one agent's dedicated account. Same
    // invariant the schema enforces for authored yaml, applied to the
    // hot-mutation path (/auth use, switch buttons).
    const exclusiveOwner = this.exclusiveOwnerOf(account);
    if (exclusiveOwner) {
      this.audit({ op: "set-active", identity, account, accountKind: "claude", ok: false, error: "exclusive-account" });
      socket.write(encodeError(
        id,
        "FORBIDDEN",
        `account '${account}' is exclusive to agent '${exclusiveOwner}' ` +
        `(agents.${exclusiveOwner}.auth.exclusive) — it cannot be the fleet active. ` +
        `Clear the exclusive flag in switchroom.yaml first if you really mean this.`,
      ));
      return;
    }
    // Mutate in-memory config AND persist the swap to the broker's own
    // state file. Yaml stays the CLI's job (RFC §4.6: CLI writes YAML then
    // calls set-active), but non-CLI callers (Telegram /auth use, the
    // switch buttons) have no yaml writer — pre-fix their swap silently
    // reverted to the stale yaml `auth.active` on the next broker
    // recreate (2026-07-05 incident). The override survives restarts and
    // yields to a newer hand-edited yaml (see applyActiveOverride).
    const cfg: SwitchroomConfig = {
      ...this.config,
      auth: { ...(this.config.auth ?? {}), active: account },
    };
    this.config = cfg;
    this.persistActiveOverride(account);
    const fanned = this.fanoutToAffectedAgents(account);
    // Push updated creds to any consumer mirror whose effective account is now
    // `account` (e.g. a consumer whose failover just resolved to this account
    // because its pinned account was exhausted and this is the healthy fallback).
    this.fanoutAllConsumers();
    this.audit({ op: "set-active", identity, account, accountKind: "claude", ok: true });
    socket.write(encodeSuccess(id, { active: account, fanned }));
  }

  /**
   * `rolledTo` as seen by the CALLER. A strict-pinned agent is skipped by
   * `fanoutFailoverTo`, so its mirror kept the pin — but the fleet-level
   * `rolledTo` would still be non-null whenever a target existed. Gateways
   * key "switched to X" announcements AND the resume nudge off a non-null
   * `rolledTo`; advertising a switch that did not happen to this caller
   * re-runs the turn straight back into the wall (resume → 429 → mark loop).
   * Null for a strict caller; pass-through for everyone else.
   */
  private callerRolledTo(identity: Identity, rolledTo: string | null): string | null {
    if (identity.kind !== "agent") return rolledTo;
    const a = (this.config.agents ?? {})[identity.name]?.auth;
    return a?.override && a?.strict ? null : rolledTo;
  }

  private async opMarkExhausted(
    socket: net.Socket,
    id: string,
    identity: Identity,
    until: number | undefined,
  ): Promise<void> {
    const account = this.callerAccount(identity);
    if (!account) {
      this.audit({ op: "mark-exhausted", identity, accountKind: "claude", ok: false, error: "no-active-account" });
      socket.write(encodeError(id, "ACCOUNT_NOT_FOUND", "no active account configured"));
      return;
    }
    const { rolled, rolledTo } = await this.markExhaustedAndRoll(account, until, identity);
    this.audit({ op: "mark-exhausted", identity, account, accountKind: "claude", ok: true });
    socket.write(encodeSuccess(id, {
      account,
      rolled,
      rolledTo: this.callerRolledTo(identity, rolledTo),
    }));
  }

  /**
   * 429 throttle tier — record a TRANSIENT per-account rate limit on the
   * caller's bound account. Unlike `mark-exhausted` this:
   *   - rolls NOTHING (no fanout, no promote — the fleet stays put), and
   *   - blocks NOTHING (eligibility keys only on exhaustion marks + live
   *     snapshots; `throttled_until` is invisible to it by construction —
   *     see `exhaustionMarkOf`).
   * Consumers of `list-state` (cron quota-preflight) read `throttled_until`
   * to soft-defer scheduled fires until the throttle clears.
   *
   * Escalation guard (#failover-429-corroborate): a terminal transient 429 can
   * be a genuine 5h/7d wall hiding behind transient/generic wording, so the
   * live quota probe runs on the FIRST hit — not the 3rd — converting a real
   * wall to failover in one round-trip instead of stranding a dead turn. Only
   * a probe that CORROBORATES exhaustion (same overage-aware test every other
   * trigger uses) converts the throttle into the standard mark-exhausted +
   * fleet roll; a healthy probe leaves the account merely throttled and
   * CARRIES the pruned hit window forward (it is cleared only on a corroborated
   * escalation). The probe is RATE-BOUNDED to at most one per account per
   * THROTTLE_ESCALATION_PROBE_MIN_INTERVAL_MS (plus the single-flight wrapper),
   * so a 429 burst costs ≤1 haiku token/min. Marks within
   * MARK_THROTTLED_MIN_INTERVAL_MS of the previous hit only refresh
   * `throttled_until` (no hit, no probe) — a simultaneous multi-agent burst
   * counts once and cannot flood probes. THROTTLE_ESCALATION_WINDOW_MS is
   * retained for window bookkeeping / observability only; it no longer gates
   * escalation.
   *
   * PROBE-ONLY mode (`probeOnly` — #failover-429-corroborate, generic-transient
   * origin): run ONLY the rate-bounded escalation probe and, iff it corroborates
   * a wall, the mark-exhausted + roll. Record NOTHING otherwise — no
   * `throttled_until`, no hit, no soft-defer. A generic-transient 429 (bare
   * `rate_limit_error` wording that neither names the account nor is proxy-local)
   * must stay account-inert on a HEALTHY probe: the calm rate-limited card the
   * gateway already emitted is the only user-visible output, exactly as before
   * the escalation was ever wired. The shared escalation semantics live in
   * `maybeEscalateThrottle` so the two entrypoints cannot diverge.
   *
   * Announcement doctrine: an escalated roll is NOT recorded in
   * `last_fleet_roll` — this is a REACTIVE path (see the LastFleetRoll
   * docstring), so the RAISING gateway announces from this op's response
   * (`escalated` + `rolledTo`), which also covers rolls of PINNED
   * (non-fleet-active) override accounts that the fleet channel would skip.
   */
  private async opMarkThrottled(
    socket: net.Socket,
    id: string,
    identity: Identity,
    until: number,
    probeOnly = false,
  ): Promise<void> {
    const account = this.callerAccount(identity);
    if (!account) {
      this.audit({ op: "mark-throttled", identity, accountKind: "claude", ok: false, error: "no-active-account" });
      socket.write(encodeError(id, "ACCOUNT_NOT_FOUND", "no active account configured"));
      return;
    }
    const now = this.now();

    // PROBE-ONLY (generic-transient origin): corroborate WITHOUT recording a
    // throttle. No throttled_until, no hit, no soft-defer — a healthy probe is
    // account-inert (its only effect is the silent quota self-heal inside the
    // probe). Only a corroborated wall converts to mark-exhausted + roll.
    if (probeOnly) {
      const { escalated, rolledTo } = await this.maybeEscalateThrottle(account, identity, now);
      this.audit({ op: "mark-throttled", identity, account, accountKind: "claude", ok: true });
      socket.write(
        encodeSuccess(id, {
          account,
          // Nothing recorded — echo any pre-existing expiry (else 0) so the
          // response shape holds; the probe-only caller ignores this field.
          throttled_until: this.quota[account]?.throttled_until ?? 0,
          escalated,
          rolledTo: escalated ? this.callerRolledTo(identity, rolledTo) : null,
        }),
      );
      return;
    }

    // Clamp: a throttle is minutes, never days. Past/short values still get
    // a floor of now+1s so the entry is observably "throttled right now".
    const throttledUntil = Math.min(
      Math.max(until, now + 1000),
      now + MARK_THROTTLED_MAX_MS,
    );
    const entry = this.quota[account] ?? {};
    const priorHits = entry.throttle_hits ?? [];
    const lastHit = priorHits.length > 0 ? priorHits[priorHits.length - 1] : undefined;

    // Re-mark dedup: a burst of near-simultaneous marks (N agents sharing the
    // throttled account) refreshes the expiry but counts as ONE hit and can
    // trigger no probe — the probe-flood bound.
    if (lastHit !== undefined && now - lastHit < MARK_THROTTLED_MIN_INTERVAL_MS) {
      const refreshed = Math.max(entry.throttled_until ?? 0, throttledUntil);
      this.quota[account] = { ...entry, throttled_until: refreshed };
      this.persistQuota();
      this.audit({ op: "mark-throttled", identity, account, accountKind: "claude", ok: true });
      process.stdout.write(
        `auth-broker: mark-throttled ${account} deduped (re-mark within ${MARK_THROTTLED_MIN_INTERVAL_MS / 1000}s) — expiry refreshed, no new hit\n`,
      );
      socket.write(
        encodeSuccess(id, {
          account,
          throttled_until: refreshed,
          escalated: false,
          rolledTo: null,
        }),
      );
      return;
    }

    const hits = priorHits.filter((t) => now - t < THROTTLE_ESCALATION_WINDOW_MS);
    hits.push(now);
    this.quota[account] = {
      ...entry,
      throttled_until: throttledUntil,
      // Carry the pruned window forward; cleared below iff the probe escalates.
      throttle_hits: hits,
    };
    this.persistQuota();
    this.audit({ op: "mark-throttled", identity, account, accountKind: "claude", ok: true });
    process.stdout.write(
      `auth-broker: mark-throttled ${account} until ${new Date(throttledUntil).toISOString()} ` +
        `(hit ${hits.length} in window)\n`,
    );

    const { escalated, rolledTo } = await this.maybeEscalateThrottle(account, identity, now);
    if (escalated) {
      // Clear the hit window — the throttle converted to a durable exhaustion
      // mark, so the escalation counter starts fresh.
      this.quota[account] = { ...this.quota[account], throttle_hits: [] };
      this.persistQuota();
    }
    socket.write(
      encodeSuccess(id, {
        account,
        throttled_until: throttledUntil,
        escalated,
        rolledTo: escalated ? this.callerRolledTo(identity, rolledTo) : null,
      }),
    );
  }

  /**
   * #failover-429-corroborate — the shared FIRST-hit corroboration probe, used
   * by both mark-throttled entrypoints (the account-scoped throttle write and
   * the generic-transient probe-only path) so they cannot diverge in
   * escalation semantics.
   *
   * A terminal transient 429 can be a genuine 5h/7d wall hiding behind
   * generic/transient wording. So the live quota probe runs on the FIRST hit
   * (not the 3rd) — but RATE-BOUNDED to at most one probe per account per
   * THROTTLE_ESCALATION_PROBE_MIN_INTERVAL_MS (plus the single-flight wrapper in
   * probeThrottleEscalation) so a 429 burst costs ≤1 haiku token/min. A healthy
   * probe means the 429 really was transient → stay put (the caller records or
   * omits the throttle as appropriate). A corroborated wall converts to the
   * standard mark-exhausted + fleet roll here; the caller owns any hit-window
   * bookkeeping around it. Deliberately NO recordFleetRoll — reactive-path
   * doctrine (see opMarkThrottled docstring): the raising gateway announces
   * from the response.
   */
  private async maybeEscalateThrottle(
    account: string,
    identity: Identity,
    now: number,
  ): Promise<{ escalated: boolean; rolledTo: string | null }> {
    const lastProbeAt = this.lastEscalationProbeAt[account];
    const probeAllowed =
      lastProbeAt === undefined ||
      now - lastProbeAt >= THROTTLE_ESCALATION_PROBE_MIN_INTERVAL_MS;
    if (!probeAllowed) {
      process.stdout.write(
        `auth-broker: throttle-escalation probe on ${account} rate-bounded — skipped\n`,
      );
      return { escalated: false, rolledTo: null };
    }
    this.lastEscalationProbeAt[account] = now;
    const probe = await this.probeThrottleEscalation(account);
    if (!probe.exhausted) {
      process.stdout.write(
        `auth-broker: throttle-escalation probe on ${account} did NOT corroborate a wall — staying put\n`,
      );
      return { escalated: false, rolledTo: null };
    }
    process.stdout.write(
      `auth-broker: throttle-escalation probe corroborates wall on ${account} — mark-exhausted + roll\n`,
    );
    this.audit({ op: "mark-exhausted", identity, account, accountKind: "claude", ok: true, reason: "throttle-escalation" });
    const roll = await this.markExhaustedAndRoll(account, probe.until ?? undefined, identity);
    return { escalated: true, rolledTo: roll.rolledTo };
  }

  /**
   * Live-probe `account` for the throttle escalation guard. Returns the
   * overage-aware exhaustion decision; a failed probe (no creds, network
   * error) is `exhausted:false` — never escalate on missing evidence.
   * Caches a successful probe so the dashboard / eligibility see the fresh
   * snapshot (and so markExhaustedAndRoll's corroboration gate can act on it).
   * Routed through probeQuotaSingleFlight so concurrent escalation probes (or
   * a probe-quota render storm) for the same account collapse to ONE upstream
   * call — part of the first-hit corroboration cost bound.
   */
  private async probeThrottleEscalation(
    account: string,
  ): Promise<{ exhausted: boolean; until: number | null }> {
    const creds = readAccountCredentials(account, this.home);
    const token = creds?.claudeAiOauth?.accessToken;
    if (!token) return { exhausted: false, until: null };
    let result: QuotaResult;
    try {
      result = await this.probeQuotaSingleFlight(account, token);
    } catch (err) {
      this.logErr(`throttle-escalation probe ${account}: ${(err as Error).message}`);
      return { exhausted: false, until: null };
    }
    this.cacheQuotaSnapshot(account, result);
    return quotaIndicatesExhaustion(result, this.isOverageAllowed(account));
  }

  /**
   * Mark `account` exhausted, roll the fleet off it, and — when the walled
   * account was the fleet active — promote the roll target to nominal
   * `auth.active` (persisted). Shared core of the `mark-exhausted` op (the
   * reactive 429/TUI-wall path via auto-fallback) and the proactive
   * fleet-probe path (`fleetQuotaProbeTick`), so the two triggers cannot
   * diverge in roll/promote semantics.
   */
  private async markExhaustedAndRoll(
    account: string,
    until: number | undefined,
    identity: Identity,
  ): Promise<{ rolled: string[]; rolledTo: string | null }> {
    const now = this.now();
    // Clamp the misfire-prone case: a mark longer than the 5h default (the +7d
    // weekly fallback that landed on the healthy primary on 2026-06-10) is only
    // honored when a FRESH live probe of THIS account confirms its 7-day window
    // is actually walled. An uncorroborated long mark clamps to 5h, so a
    // misparsed weekly signal self-expires fast instead of stranding for days.
    const exhaustedUntil = clampMarkExpiry({
      proposedUntil: until ?? now + MARK_EXHAUSTED_DEFAULT_MS,
      now,
      shortMs: MARK_EXHAUSTED_DEFAULT_MS,
      snapshot: this.lastQuotaCache[account],
    });
    // Spread preserves throttle-tier fields (throttled_until/throttle_hits)
    // living beside the exhaustion mark in the same ledger entry.
    this.quota[account] = { ...this.quota[account], exhausted_until: exhaustedUntil, marked_at: now };
    this.persistQuota();
    // 4c — a LONG mark accepted here is either (a) synchronously corroborated
    // (a fresh contradicting snapshot already clamped it to 5h above) or (b)
    // UNCORROBORATED: no fresh snapshot, so clampMarkExpiry trusted the caller
    // (the legit #2218 weekly-durability path). For case (b) we do NOT
    // hard-clamp (that regresses #2218) — instead schedule ONE live
    // corroboration probe. A COMPLETE probe that positively contradicts the
    // weekly wall clamps the persisted mark to 5h; a failed/incomplete probe
    // leaves the durable weekly mark intact.
    if (exhaustedUntil > now + MARK_EXHAUSTED_DEFAULT_MS) {
      this.scheduleMarkCorroboration(account, now, identity);
    }
    // Fan out next-fallback creds to every agent whose active account is
    // `account`. Uses the LIVE selector (Bug 1): force-probe an `unknown`
    // candidate before ruling it out so a never-probed-but-healthy secondary is
    // actually rolled to, instead of being mistaken for blocked.
    const rolledTo = await this.nextHealthyAccountLive(
      account,
      this.config.auth?.fallback_order ?? [],
    );
    const rolled = this.fanoutFailoverTo(account, rolledTo);
    // Fan out to any consumer whose pinned account == `account` AND that
    // has a `mirror_dir`. This eliminates the pull-latency gap: without
    // this push the consumer only gets failover creds at its next
    // scheduled get-credentials loop tick (up to 30 min). The serving
    // path (accountWithFailover) is already failover-aware — we just need
    // to push the resulting creds immediately rather than waiting for a
    // pull. Attribution stays attribution-true (servingAccountForConsumer
    // uses accountWithFailover, never the raw pinned account), so a consumer
    // cannot poison the fallback account.
    this.fanoutToAffectedConsumers(account);
    // `rolledTo` is the account the fleet rolled TO — same selection the fanout
    // used. Lets a non-admin caller (the agent that just 429'd, via
    // auto-fallback) report an accurate "switched to <X>" without a follow-up
    // admin set-active. `null` when every fallback_order entry is genuinely
    // exhausted (honest all-blocked).
    //
    // Auto-promote (2026-07-05 incident): when the roll found a target AND
    // the walled account was the fleet active, promote the target to
    // nominal `auth.active` and persist it. Pre-fix the nominal active
    // stayed pointed at the walled account for the whole exhaustion
    // window; every restart/recreate-time mirror path that reads nominal
    // active (agent recreate scaffolds, boot fanout) re-poisoned the fleet
    // with walled creds, and each agent had to crash into the wall again
    // before the serving-path failover re-covered it. Promoting makes the
    // failover the fleet's real, durable state. Stale-wall storms from
    // other gateways are guarded upstream: runFleetAutoFallback live-probes
    // the (now healthy) active and skips before ever calling this op.
    //
    // Corroboration gate: a promote is a DURABLE act with no auto-revert,
    // so it requires a FRESH live snapshot proving the account is genuinely
    // walled (same discipline clampMarkExpiry applies to long marks, and
    // the #2478 probe-blind guard applies to the fleet alert). Without it,
    // a bogus/misfired mark (the 2026-06-10 incident shape) would durably
    // swap the fleet off a healthy account; ungated marks still get the
    // temporary window-failover semantics, which self-heal on the next
    // healthy probe.
    if (
      rolledTo &&
      this.config.auth?.active === account &&
      this.exhaustionLiveCorroborated(account)
    ) {
      this.config = {
        ...this.config,
        auth: { ...(this.config.auth ?? {}), active: rolledTo },
      };
      this.persistActiveOverride(rolledTo);
      this.fanoutAllConsumers();
      this.audit({ op: "auto-promote-active", identity, account: rolledTo, accountKind: "claude", ok: true });
      process.stdout.write(
        `auth-broker: auto-promoted auth.active ${account} → ${rolledTo} ` +
          `(${account} exhausted until ${new Date(exhaustedUntil).toISOString()}) — persisted\n`,
      );
    }
    return { rolled, rolledTo };
  }

  /**
   * 4c — schedule a one-shot corroboration probe for an uncorroborated long
   * exhaustion mark. Keyed to the mark's `markedAt` so a mark that is cleared
   * or superseded before the probe fires is a no-op. Timer is `unref`'d (never
   * holds the process open) and tracked for `stop()` cleanup. Delay 0 (tests)
   * disables auto-scheduling — the test drives `corroborateExhaustionMark`.
   */
  private scheduleMarkCorroboration(
    account: string,
    markedAt: number,
    identity: Identity,
  ): void {
    if (this.markCorroborationDelayMs <= 0) return;
    const timer = setTimeout(() => {
      this.markCorroborationTimers.delete(timer);
      void this.corroborateExhaustionMark(account, markedAt, identity).catch((err) => {
        this.logErr(`mark-corroboration ${account}: ${(err as Error).message}`);
      });
    }, this.markCorroborationDelayMs);
    timer.unref?.();
    this.markCorroborationTimers.add(timer);
  }

  /**
   * 4c — corroborate (or refute) an uncorroborated long exhaustion mark with a
   * single live probe. A COMPLETE probe (F0 `sevenDayUtilPresent`) that
   * positively contradicts the weekly wall — the same condition `clampMarkExpiry`
   * enforces — clamps the PERSISTED `exhausted_until` to `now + 5h`. Everything
   * else is a NO-OP, preserving #2218 weekly-durability:
   *   - the mark was cleared/superseded since scheduling → no-op;
   *   - the mark is no longer long (already clamped) → no-op;
   *   - no creds / probe failed / probe INCOMPLETE (7d window absent) → no-op
   *     (clampMarkExpiry's F0 guard refuses to clamp a weekly mark off a probe
   *     that never saw the weekly window);
   *   - probe complete but the account is still walled → no-op.
   *
   * This is the "contradicting probe → rewrite persisted exhausted_until" write
   * path that did not exist before (clampMarkExpiry is mark-TIME only). Public
   * for tests (driven via `_testFetchQuota` + `_testCorroborationDelayMs: 0`).
   */
  async corroborateExhaustionMark(
    account: string,
    markedAt: number,
    identity: Identity,
  ): Promise<{ clamped: boolean; reason: string; until?: number }> {
    const entry = this.quota[account];
    if (!entry || entry.marked_at !== markedAt) {
      return { clamped: false, reason: "mark-superseded" };
    }
    const until = entry.exhausted_until;
    const now = this.now();
    if (until == null || until <= now + MARK_EXHAUSTED_DEFAULT_MS) {
      return { clamped: false, reason: "not-long" };
    }
    const creds = readAccountCredentials(account, this.home);
    const token = creds?.claudeAiOauth?.accessToken;
    if (!token) return { clamped: false, reason: "no-token" };
    let result: QuotaResult;
    try {
      result = await this.fetchQuotaImpl({ accessToken: token });
    } catch (err) {
      this.logErr(`mark-corroboration probe ${account}: ${(err as Error).message}`);
      return { clamped: false, reason: "probe-failed" };
    }
    // Cache so the dashboard / eligibility see the fresh snapshot and so
    // clampMarkExpiry consults live truth (it reads lastQuotaCache-shaped data).
    this.cacheQuotaSnapshot(account, result);
    const snapshot = this.lastQuotaCache[account];
    // clampMarkExpiry enforces the F0 completeness guard (sevenDayUtilPresent)
    // internally: an incomplete probe that never measured the 7-day window
    // CANNOT clamp a legitimate weekly mark down to 5h.
    const clampedUntil = clampMarkExpiry({
      proposedUntil: until,
      now,
      shortMs: MARK_EXHAUSTED_DEFAULT_MS,
      snapshot,
    });
    if (clampedUntil >= until) {
      return { clamped: false, reason: "not-contradicted" };
    }
    // Re-read the live entry: a concurrent op may have changed the mark between
    // the await and here. Only rewrite when the SAME mark is still in place and
    // the clamp actually shortens it.
    const live = this.quota[account];
    if (!live || live.marked_at !== markedAt || (live.exhausted_until ?? 0) <= clampedUntil) {
      return { clamped: false, reason: "mark-superseded" };
    }
    this.quota[account] = { ...live, exhausted_until: clampedUntil };
    this.persistQuota();
    this.audit({
      op: "mark-corroboration-clamp",
      identity,
      account,
      accountKind: "claude",
      ok: true,
    });
    process.stdout.write(
      `auth-broker: mark-corroboration probe CONTRADICTS ${account} weekly wall — ` +
        `clamped exhausted_until ${new Date(until).toISOString()} → ` +
        `${new Date(clampedUntil).toISOString()}\n`,
    );
    return { clamped: true, reason: "contradicted", until: clampedUntil };
  }

  /**
   * Is `account`'s exhaustion backed by live evidence — a FRESH cached
   * snapshot that reads walled (and not overage-lifted)? Gates the durable
   * auto-promote in `markExhaustedAndRoll`; mirrors the corroboration the
   * quota-watch fleet alert requires (#2478) and the freshness discipline
   * of `clampMarkExpiry`.
   */
  private exhaustionLiveCorroborated(account: string): boolean {
    const snapshot = this.lastQuotaCache[account];
    // Tighter freshness ceiling than the serving path's 24h default
    // (#2845 review nit): a durable promote must be backed by a snapshot
    // younger than one 5h refill period, else a stale walled reading
    // (fleet probing disabled / degraded) could promote off an account
    // whose window already refilled. With default probing (minutes-old
    // snapshots) this never binds.
    if (!snapshot || !snapshotFresh(snapshot, this.now(), MARK_EXHAUSTED_DEFAULT_MS)) return false;
    if (!snapshotWalled(snapshot)) return false;
    return !overageLiftsWall(snapshot, this.isOverageAllowed(account));
  }

  /**
   * `get-external-spend` — fleet OpenRouter/cash spend for `/usage`.
   * ACL: same as list-state (any bound identity). Never puts the master
   * key on the wire. Soft-fails with `available:false` when the key is
   * missing or LiteLLM is unreachable and no durable cache exists.
   */
  private async opGetExternalSpend(
    socket: net.Socket,
    id: string,
    _identity: Identity,
    forceLive?: boolean,
  ): Promise<void> {
    const nowMs = this.now();
    const ttl = EXTERNAL_SPEND_CACHE_TTL_MS;
    const fresh =
      this.externalSpendCache != null &&
      nowMs - this.externalSpendCache.capturedAtMs < ttl;

    if (forceLive || !fresh) {
      try {
        await this.refreshExternalSpend(forceLive === true);
      } catch (err) {
        this.logErr(
          `external-spend refresh failed: ${(err as Error)?.message ?? err}`,
        );
      }
    }

    if (!this.externalSpendCache) {
      socket.write(
        encodeSuccess(id, {
          available: false,
          reason: this.resolveLitellmMasterKey()
            ? "litellm_unreachable"
            : "master_key_unavailable",
        }),
      );
      return;
    }

    const recently =
      nowMs - this.externalSpendCache.capturedAtMs < 5_000;
    const outServed: "live" | "cache" = recently && (forceLive || !fresh)
      ? "live"
      : "cache";

    const s = this.externalSpendCache.summary;
    socket.write(
      encodeSuccess(id, {
        available: true,
        day24hUsd: s.day24hUsd,
        day7dUsd: s.day7dUsd,
        top: s.top,
        capturedAtMs: this.externalSpendCache.capturedAtMs,
        served: outServed,
      }),
    );
  }

  /** Resolve LiteLLM master key: test override → env → state-dir file. Never logs value. */
  private resolveLitellmMasterKey(): string | null {
    if (this.opts._testLitellmMasterKey !== undefined) {
      const v = this.opts._testLitellmMasterKey;
      return v && v.trim() ? v.trim() : null;
    }
    const envKey = (
      process.env.SWITCHROOM_LITELLM_ADMIN_KEY ??
      process.env.LITELLM_MASTER_KEY ??
      ""
    ).trim();
    if (envKey) return envKey;
    try {
      const path = join(this.stateDir, LITELLM_MASTER_KEY_STATE_BASENAME);
      if (!existsSync(path)) return null;
      const raw = readFileSync(path, "utf-8").trim();
      return raw.length > 0 ? raw : null;
    } catch {
      return null;
    }
  }

  private resolveLitellmBaseUrl(): string {
    const fromCfg = (this.config as { litellm?: { base_url?: string } }).litellm
      ?.base_url;
    const raw = (
      process.env.SWITCHROOM_LITELLM_BASE ??
      fromCfg ??
      DEFAULT_LITELLM_BASE
    ).trim();
    return raw.replace(/\/+$/, "") || DEFAULT_LITELLM_BASE;
  }

  /**
   * Live-refresh external spend from LiteLLM. Single-flight. On failure
   * leaves any existing durable cache in place.
   */
  private async refreshExternalSpend(forceLive: boolean): Promise<void> {
    // Wait for any in-flight refresh, then re-evaluate. A concurrent
    // forceLive must not be starved by a non-force flight that no-ops
    // on a still-within-TTL (but operator-stale) cache.
    while (this.externalSpendInFlight) {
      await this.externalSpendInFlight;
      if (!forceLive) return;
      const justNow = this.now();
      if (
        this.externalSpendCache &&
        justNow - this.externalSpendCache.capturedAtMs < 5_000
      ) {
        return;
      }
      // lost the race to start another force — loop and try again
    }
    const run = (async () => {
      const nowMs = this.now();
      if (
        !forceLive &&
        this.externalSpendCache &&
        nowMs - this.externalSpendCache.capturedAtMs < EXTERNAL_SPEND_CACHE_TTL_MS
      ) {
        return;
      }
      const key = this.resolveLitellmMasterKey();
      if (!key) return;
      const baseUrl = this.resolveLitellmBaseUrl();
      const now = new Date(nowMs);
      let summary: ExternalSpendSummary | null = null;
      if (this.opts._testFetchExternalSpend) {
        summary = await this.opts._testFetchExternalSpend({
          adminKey: key,
          baseUrl,
          now,
          forceLive,
        });
      } else {
        summary = await fetchAndSummarizeExternalSpend({
          adminKey: key,
          baseUrl,
          now,
          timeoutMs: EXTERNAL_SPEND_FETCH_TIMEOUT_MS,
        });
      }
      if (!summary) return;
      this.externalSpendCache = { summary, capturedAtMs: this.now() };
      this.persistExternalSpendCache();
    })();
    this.externalSpendInFlight = run.finally(() => {
      this.externalSpendInFlight = null;
    });
    await this.externalSpendInFlight;
  }

  /**
   * Fleet notification-dedup claim. Grants the FIRST caller of a given
   * `key` inside `windowMs`; everyone else is denied. The check-and-set
   * is fully synchronous (no awaits), so two agents racing the same key
   * serialize on the event loop — exactly one grant per window, by
   * construction.
   *
   * Audit: granted claims only. Denials are the designed common case
   * (N-1 of N agents per event) — auditing them would re-create the
   * very log spam this op exists to remove.
   */
  private opClaimNotification(
    socket: net.Socket,
    id: string,
    identity: Identity,
    key: string,
    windowMs: number,
  ): void {
    const now = this.now();
    const prev = this.notificationClaims[key];
    const granted = prev === undefined || now - prev >= windowMs;
    if (granted) {
      this.notificationClaims[key] = now;
      // Prune anything past the protocol's max window so the file stays
      // bounded by the set of keys active in the last 24h.
      for (const [k, ts] of Object.entries(this.notificationClaims)) {
        if (now - ts > NOTIFICATION_CLAIM_MAX_AGE_MS) delete this.notificationClaims[k];
      }
      this.persistNotificationClaims();
      this.audit({ op: "claim-notification", identity, account: key, ok: true });
    }
    socket.write(encodeSuccess(id, { granted }));
  }

  private async opRefreshAccount(
    socket: net.Socket,
    id: string,
    identity: Identity,
    account: string,
  ): Promise<void> {
    if (!this.isAdmin(identity)) {
      this.audit({ op: "refresh-account", identity, account, accountKind: "claude", ok: false, error: "FORBIDDEN" });
      this.respondForbidden(socket, id, "refresh-account requires admin");
      return;
    }
    if (!accountExists(account, this.home)) {
      this.audit({ op: "refresh-account", identity, account, accountKind: "claude", ok: false, error: "ACCOUNT_NOT_FOUND" });
      socket.write(encodeError(id, "ACCOUNT_NOT_FOUND", `account '${account}' not found`));
      return;
    }
    const result = await this.refreshOneAccount(account, /*force*/ true);
    if (result.kind === "failed") {
      this.audit({ op: "refresh-account", identity, account, accountKind: "claude", ok: false, error: result.error });
      socket.write(encodeError(id, "REFRESH_FAILED", result.error));
      return;
    }
    const creds = readAccountCredentials(account, this.home);
    const expiresAt = creds?.claudeAiOauth?.expiresAt;
    this.audit({ op: "refresh-account", identity, account, accountKind: "claude", ok: true });
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
      this.audit({ op: "add-account", identity, account: label, accountKind: "claude", ok: false, error: "FORBIDDEN" });
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
      this.audit({ op: "add-account", identity, account: label, accountKind: "claude", ok: false, error: "ACCOUNT_ALREADY_EXISTS" });
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
    // A (re-)added label starts with a fresh soft-avoid latch — any state
    // left over from a previously-removed account of the same name (or a
    // replace) belongs to the old credentials, not these.
    delete this.softAvoidState[label];
    delete this.softAvoidRolledTo[label];
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
    this.audit({ op: "add-account", identity, account: label, accountKind: "claude", ok: true, replace });
    socket.write(encodeSuccess(id, { label, expiresAt }));
  }

  private async opRmAccount(
    socket: net.Socket,
    id: string,
    identity: Identity,
    label: string,
  ): Promise<void> {
    if (!this.isAdmin(identity)) {
      this.audit({ op: "rm-account", identity, account: label, accountKind: "claude", ok: false, error: "FORBIDDEN" });
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
    delete this.lastQuotaCache[label];
    // Soft-avoid hysteresis is per-label in-memory state — prune it with the
    // account so a later re-add of the same label starts with a clean latch.
    delete this.softAvoidState[label];
    delete this.softAvoidRolledTo[label];
    this.persistShaIndex();
    this.persistQuota();
    this.persistThresholdViolations();
    this.persistLastQuotaCache();
    this.audit({ op: "rm-account", identity, account: label, accountKind: "claude", ok: true });
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
      this.audit({ op: "get-credentials", identity, accountKind: "google", ok: false, error: "no-google-account-configured" });
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
      this.audit({ op: "get-credentials", identity, account, accountKind: "google", ok: false, error: "acl-deny" });
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
      this.audit({ op: "get-credentials", identity, account, accountKind: "google", ok: false, error: "missing-credentials" });
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
    this.audit({ op: "get-credentials", identity, account, accountKind: "google", ok: true });
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
      this.audit({ op: "add-account", identity, account: label, accountKind: "google", ok: false, error: "FORBIDDEN" });
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
      this.audit({ op: "add-account", identity, account: label, accountKind: "google", ok: false, error: "ACCOUNT_ALREADY_EXISTS" });
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
    this.audit({ op: "add-account", identity, account: label, accountKind: "google", ok: true, replace });
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
      this.audit({ op: "rm-account", identity, account: label, accountKind: "google", ok: false, error: "FORBIDDEN" });
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
    this.audit({ op: "rm-account", identity, account: label, accountKind: "google", ok: true });
    socket.write(encodeSuccess(id, { label }));
  }

  /**
   * RFC #1873 — Microsoft get-credentials. Mirrors
   * `opGoogleGetCredentials`: per-agent only, account derived from the
   * agent's `microsoft_workspace.account` selector (never the wire —
   * path-as-identity), ACL gated on
   * `microsoft_accounts.<account>.enabled_for[]`, credentials read from
   * the broker's own state dir.
   */
  private async opMicrosoftGetCredentials(
    socket: net.Socket,
    id: string,
    identity: Identity,
    requestedAccount?: string,
  ): Promise<void> {
    if (identity.kind !== "agent") {
      socket.write(
        encodeError(
          id,
          "INVALID_ARGS",
          `Microsoft get-credentials is per-agent only (caller kind '${identity.kind}' not supported); use the agent's per-agent socket bind`,
        ),
      );
      return;
    }
    const agentName = identity.name;
    const agent = (this.config.agents ?? {})[agentName] as
      | { microsoft_workspace?: MicrosoftWorkspaceLike }
      | undefined;
    const bindings = normalizeMicrosoftBindings(agent?.microsoft_workspace);
    let account: string | undefined;
    if (requestedAccount !== undefined) {
      // Multi-account form: the requested account must be one of the
      // agent's bindings. A mismatch keeps the ACCOUNT_NOT_FOUND code so
      // nothing silently downgrades.
      const wanted = requestedAccount.trim().toLowerCase();
      const bound = bindings.find((b) => b.account === wanted);
      if (!bound) {
        this.audit({ op: "get-credentials", identity, account: wanted, accountKind: "microsoft", ok: false, error: "account-not-bound" });
        socket.write(
          encodeError(
            id,
            "ACCOUNT_NOT_FOUND",
            `agent '${agentName}' is not bound to Microsoft account '${wanted}' in switchroom.yaml microsoft_workspace`,
          ),
        );
        return;
      }
      account = bound.account;
    } else if (bindings.length > 1) {
      // Multi-account agent but NO account requested. Silently returning
      // bindings[0] here is the root of the write-approval-card mis-resolve
      // (review 2026-07-17, Finding 2): callers that forget to thread the
      // account would enrich/act against the wrong mailbox. Fail loudly with
      // a hint instead — every legitimate multi-account caller passes the
      // account explicitly.
      this.audit({ op: "get-credentials", identity, accountKind: "microsoft", ok: false, error: "account-ambiguous" });
      socket.write(
        encodeError(
          id,
          "INVALID_ARGS",
          `agent '${agentName}' is bound to ${bindings.length} Microsoft accounts (${bindings
            .map((b) => b.account)
            .join(", ")}); an account must be specified — call getCredentials("microsoft", <account>)`,
        ),
      );
      return;
    } else {
      // Back-compat: derive the single account from the (normalized)
      // bindings. Exactly one binding is expected in the singular form.
      account = bindings[0]?.account;
    }
    if (!account) {
      this.audit({ op: "get-credentials", identity, accountKind: "microsoft", ok: false, error: "no-microsoft-account-configured" });
      socket.write(
        encodeError(
          id,
          "ACCOUNT_NOT_FOUND",
          `agent '${agentName}' has no microsoft_workspace.account configured in switchroom.yaml`,
        ),
      );
      return;
    }
    // ACL: agent must be in microsoft_accounts.<account>.enabled_for[].
    const ma = (this.config as { microsoft_accounts?: Record<string, { enabled_for?: string[] }> })
      .microsoft_accounts;
    const enabledFor = ma?.[account]?.enabled_for ?? [];
    if (!enabledFor.includes(agentName)) {
      this.audit({ op: "get-credentials", identity, account, accountKind: "microsoft", ok: false, error: "acl-deny" });
      socket.write(
        encodeError(
          id,
          "FORBIDDEN",
          `agent '${agentName}' not in microsoft_accounts['${account}'].enabled_for[] — operator must run \`switchroom auth microsoft enable ${account} ${agentName}\``,
        ),
      );
      return;
    }
    // Storage read.
    const creds = readMicrosoftAccountCredentials(this.stateDir, account);
    if (!creds) {
      this.audit({ op: "get-credentials", identity, account, accountKind: "microsoft", ok: false, error: "missing-credentials" });
      socket.write(
        encodeError(
          id,
          "ACCOUNT_NOT_FOUND",
          `no Microsoft credentials for account '${account}' — operator must run \`switchroom auth microsoft account add ${account}\``,
        ),
      );
      return;
    }
    const expiresAt = creds.microsoftOauth?.expiresAt;
    this.audit({ op: "get-credentials", identity, account, accountKind: "microsoft", ok: true });
    socket.write(encodeSuccess(id, { account, credentials: creds, expiresAt }));
  }

  private async opMicrosoftAddAccount(
    socket: net.Socket,
    id: string,
    identity: Identity,
    label: string,
    credentials: MicrosoftCredentialsShape,
    replace: boolean,
  ): Promise<void> {
    if (!this.isAdmin(identity)) {
      this.audit({ op: "add-account", identity, account: label, accountKind: "microsoft", ok: false, error: "FORBIDDEN" });
      this.respondForbidden(socket, id, "add-account requires admin");
      return;
    }
    // Defense-in-depth path-traversal guard (same posture as Google).
    try {
      validateMicrosoftAccountLabel(label);
    } catch (err) {
      socket.write(encodeError(id, "INVALID_ARGS", (err as Error).message));
      return;
    }
    if (microsoftAccountExists(this.stateDir, label) && !replace) {
      this.audit({ op: "add-account", identity, account: label, accountKind: "microsoft", ok: false, error: "ACCOUNT_ALREADY_EXISTS" });
      socket.write(encodeError(id, "ACCOUNT_ALREADY_EXISTS", `microsoft account '${label}' already exists; pass replace:true to overwrite`));
      return;
    }
    try {
      writeMicrosoftAccountCredentials(this.stateDir, label, credentials);
    } catch (err) {
      socket.write(encodeError(id, "INTERNAL", (err as Error).message));
      return;
    }
    const expiresAt = credentials.microsoftOauth?.expiresAt;
    this.audit({ op: "add-account", identity, account: label, accountKind: "microsoft", ok: true, replace });
    socket.write(encodeSuccess(id, { label, expiresAt }));
  }

  /**
   * RFC #1873 — Microsoft rm-account. Refuses to remove while the
   * account is in `microsoft_accounts.<label>.enabled_for[]` (an agent
   * still depends on the credential). Operator must
   * `auth microsoft disable <label> all` first.
   */
  private async opMicrosoftRmAccount(
    socket: net.Socket,
    id: string,
    identity: Identity,
    label: string,
  ): Promise<void> {
    if (!this.isAdmin(identity)) {
      this.audit({ op: "rm-account", identity, account: label, accountKind: "microsoft", ok: false, error: "FORBIDDEN" });
      this.respondForbidden(socket, id, "rm-account requires admin");
      return;
    }
    try {
      validateMicrosoftAccountLabel(label);
    } catch (err) {
      socket.write(encodeError(id, "INVALID_ARGS", (err as Error).message));
      return;
    }
    if (!microsoftAccountExists(this.stateDir, label)) {
      socket.write(encodeError(id, "ACCOUNT_NOT_FOUND", `microsoft account '${label}' not found`));
      return;
    }
    // Refuse if any agent is still enabled on this account.
    const ma = (this.config as { microsoft_accounts?: Record<string, { enabled_for?: string[] }> }).microsoft_accounts;
    const enabledFor = ma?.[label]?.enabled_for ?? [];
    if (enabledFor.length > 0) {
      socket.write(encodeError(id, "INVALID_ARGS", `microsoft account '${label}' is still enabled for agents: ${enabledFor.join(", ")}. Run \`auth microsoft disable ${label} all\` first.`));
      return;
    }
    try {
      removeMicrosoftAccount(this.stateDir, label);
    } catch (err) {
      socket.write(encodeError(id, "INTERNAL", (err as Error).message));
      return;
    }
    this.audit({ op: "rm-account", identity, account: label, accountKind: "microsoft", ok: true });
    socket.write(encodeSuccess(id, { label }));
  }

  /**
   * RFC #1873 — Microsoft account inventory. Mirror of
   * `opListGoogleAccounts`: no ACL (same posture as `list-state`), never
   * returns the refresh/access tokens, just the metadata an operator
   * needs to confirm `auth microsoft list` (YAML) matches what the
   * broker actually holds. Also surfaces accountType so the operator can
   * tell a personal MSA from a work/school account at a glance.
   */
  private async opListMicrosoftAccounts(
    socket: net.Socket,
    id: string,
    identity: Identity,
  ): Promise<void> {
    const accounts = listMicrosoftAccounts(this.stateDir)
      .map((account) => {
        const creds = readMicrosoftAccountCredentials(this.stateDir, account);
        if (!creds) return null;
        return {
          account,
          expiresAt: creds.microsoftOauth.expiresAt,
          scope: creds.microsoftOauth.scope,
          clientId: creds.microsoftOauth.clientId,
          accountType: creds.microsoftOauth.accountType,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => a.account.localeCompare(b.account));
    this.audit({ op: "list-microsoft-accounts", identity, accountKind: "microsoft", ok: true });
    socket.write(encodeSuccess(id, { accounts }));
  }

  private async opSetOverride(
    socket: net.Socket,
    id: string,
    identity: Identity,
    agentName: string,
    account: string | null,
  ): Promise<void> {
    if (!this.isAdmin(identity)) {
      this.audit({ op: "set-override", identity, account: account ?? undefined, accountKind: "claude", ok: false, error: "FORBIDDEN" });
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
    // Refuse pinning an agent to an account another agent holds exclusively.
    // The owner re-pinning to its own account is fine (idempotent).
    if (account !== null) {
      const exclusiveOwner = this.exclusiveOwnerOf(account);
      if (exclusiveOwner && exclusiveOwner !== agentName) {
        this.audit({ op: "set-override", identity, account, accountKind: "claude", ok: false, error: "exclusive-account" });
        socket.write(encodeError(
          id,
          "FORBIDDEN",
          `account '${account}' is exclusive to agent '${exclusiveOwner}' ` +
          `(agents.${exclusiveOwner}.auth.exclusive) — agent '${agentName}' cannot pin it.`,
        ));
        return;
      }
    }
    // Refuse MOVING or CLEARING a strict/exclusive pin over the socket. The
    // flags are yaml-only and bind to the yaml-declared account: a hot move
    // would either carry `exclusive` onto an account yaml never marked
    // (locking a fleet fallback out of rotation until restart) or leave the
    // flag dangling with no pin. Idempotent re-pin to the same account stays
    // allowed. Edit switchroom.yaml + restart the broker to change these.
    {
      const curAuth = (this.config.agents ?? {})[agentName]?.auth;
      if (
        (curAuth?.strict || curAuth?.exclusive) &&
        account !== (curAuth?.override ?? null)
      ) {
        this.audit({ op: "set-override", identity, account: account ?? undefined, accountKind: "claude", ok: false, error: "yaml-pinned" });
        socket.write(encodeError(
          id,
          "FORBIDDEN",
          `agent '${agentName}' has a strict/exclusive pin declared in switchroom.yaml — ` +
          `edit the yaml (agents.${agentName}.auth) and restart the broker to change it.`,
        ));
        return;
      }
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
    this.audit({ op: "set-override", identity, account: account ?? undefined, accountKind: "claude", ok: true });
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
    // RFC #1873 — also walk Microsoft accounts. Same no-op-if-unregistered
    // guard as Google; keeps the on-disk access token fresh for the
    // m365-mcp-launcher (which pulls via get-credentials({provider:
    // "microsoft"})). Microsoft rotates the refresh token on every
    // exchange, so refreshOneMicrosoftAccount persists the new RT
    // atomically — see microsoft-storage.ts.
    if (this.providers.has("microsoft")) {
      for (const account of listMicrosoftAccounts(this.stateDir)) {
        try {
          await this.refreshOneMicrosoftAccount(account, /*force*/ false);
        } catch (err) {
          this.logErr(
            `refresh-tick microsoft:${account}: ${(err as Error).message}`,
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

  /**
   * Pre-emptively refresh one Microsoft account's access token if it's
   * within REFRESH_THRESHOLD_MS of expiry. Mirrors
   * `refreshOneGoogleAccount` — same lease pattern, threshold, and
   * outcome discriminant — but talks to MicrosoftProvider and writes
   * back via `writeMicrosoftAccountCredentials`.
   *
   * **Microsoft-specific**: the provider needs `priorCredentials` to
   * preserve canonical identity fields (tenantId / accountType /
   * homeAccountId / accountEmail) when Microsoft's v2 `/token` omits
   * `id_token` on a refresh response — without it the provider would
   * clobber those with empty placeholders (see microsoft-provider.ts).
   * Google's path doesn't pass this because its credential shape carries
   * no identity claims a refresh could fail to return.
   */
  private async refreshOneMicrosoftAccount(
    account: string,
    force: boolean,
  ): Promise<
    | { kind: "noop" }
    | { kind: "refreshed"; newExpiresAt: number }
    | { kind: "failed"; error: string }
  > {
    // Namespaced lease key so Microsoft `alice@outlook.com` can't
    // collide with an Anthropic/Google account named the same.
    const leaseKey = `microsoft:${account}`;
    if (this.refreshInFlight.has(leaseKey)) return { kind: "noop" };

    const credsBefore = readMicrosoftAccountCredentials(this.stateDir, account);
    if (!credsBefore) {
      // Account vanished between listMicrosoftAccounts() and now — noop.
      return { kind: "noop" };
    }
    const provider = this.providers.lookup("microsoft");
    const onDiskExpires = provider.extractExpiresAt(credsBefore);
    if (!force) {
      const remaining = (onDiskExpires ?? 0) - this.now();
      if (onDiskExpires !== undefined && remaining > REFRESH_THRESHOLD_MS) {
        return { kind: "noop" };
      }
    }

    this.refreshInFlight.add(leaseKey);
    try {
      const refreshToken = credsBefore.microsoftOauth.refreshToken;
      const result = await provider.refresh({
        refreshToken,
        accountEmail: account,
        clientId: credsBefore.microsoftOauth.clientId,
        priorCredentials: credsBefore,
      });
      if (!result.ok) {
        // Leave on-disk credentials untouched on failure — a transient
        // network error may resolve next tick, and on invalid_grant the
        // operator must re-OAuth (the launcher's get-credentials call
        // surfaces a clean error to the consumer when it next reads).
        return { kind: "failed", error: `${result.kind}: ${result.detail}` };
      }
      const newCreds = result.rawCredentials as MicrosoftCredentialsShape;
      writeMicrosoftAccountCredentials(this.stateDir, account, newCreds);
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
        // Fan out to every consumer mirror whose effective account == this
        // label (so a consumer on a failover account gets the refreshed creds
        // pushed without waiting for its pull-loop tick).
        this.fanoutToAffectedConsumers(label);
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

  /** Walk every agent and every consumer-mirror and re-mirror their effective-account credentials. */
  private fanoutAll(): string[] {
    const out: string[] = [];
    for (const name of Object.keys(this.config.agents ?? {})) {
      if (this.fanoutForAgent(name)) out.push(name);
    }
    // Boot fanout for consumers with mirror_dir — same "re-point after restart"
    // guarantee agents get, so a broker restart doesn't leave a consumer stuck on
    // pre-restart creds until its next pull-loop tick.
    for (const consumerName of this.fanoutAllConsumers()) {
      out.push(`consumer:${consumerName}`);
    }
    return out;
  }

  /** Fan out to every agent whose effective (failover-resolved) account == label. */
  private fanoutToAffectedAgents(label: string): string[] {
    const fanned: string[] = [];
    for (const name of Object.keys(this.config.agents ?? {})) {
      // Match on the SERVED account (post exhaustion-failover), not the raw
      // auth.active. When auth.active is walled, an agent's served account is
      // its healthy fallback — so refreshing the fallback re-mirrors it, while
      // refreshing the walled account matches no agent (it serves none) and so
      // can never re-mirror walled creds. With nothing exhausted this is
      // identical to matching auth.active. Strict pins resolve to the pin
      // itself (servedAccountForAgent) — a strict agent is only ever fanned
      // its own account's creds.
      const effective = this.servedAccountForAgent(name);
      if (effective === label) {
        if (this.fanoutForAgent(name)) fanned.push(name);
      }
    }
    return fanned;
  }

  /**
   * Fan out to every consumer whose effective (failover-resolved) account ==
   * label AND that has a `mirror_dir` configured.
   *
   * The consumer model is pull-based by default: hindsight calls
   * `get-credentials` on a periodic loop (default 30 min). Without a push,
   * a consumer pinned to an account that just became exhausted keeps running
   * on stale credentials for up to 30 min — the 2026-06-25 incident where
   * the consumer-quota-sensor correctly marked `me@` exhausted, but hindsight
   * didn't re-fetch until the next loop tick and stayed dead on a 429.
   *
   * `mirror_dir` closes the gap: the broker writes
   * `<mirror_dir>/.credentials.json` immediately when it detects exhaustion
   * (sensor tick or a mark-exhausted RPC on the pinned account) and on any
   * credential refresh. The consumer container bind-mounts `mirror_dir` from
   * a host-accessible path so both sides can reach the same file.
   *
   * Attribution invariant is preserved: `mirrorAccountToConsumer` uses the
   * SERVING account (post exhaustion-failover), never the raw pinned account,
   * so stale exhausted creds are never re-mirrored onto the consumer.
   *
   * Returns the list of consumer names whose mirror was successfully updated.
   */
  private fanoutToAffectedConsumers(label: string): string[] {
    const fanned: string[] = [];
    for (const consumer of this.config.auth?.consumers ?? []) {
      if (!consumer.mirror_dir) continue;
      // A consumer is affected when EITHER:
      //   (a) its pinned account is `label` — the pinned account may have just
      //       been marked exhausted; re-mirror with the failover account so the
      //       consumer doesn't wait for its next pull tick.
      //   (b) its EFFECTIVE (serving) account is `label` — the effective account
      //       just had its creds refreshed; push the fresh creds immediately.
      // In both cases we write the current serving account (post failover), never
      // the raw pinned one, preserving the attribution invariant.
      // An unpinned consumer's "bound" account is the fleet active.
      const bound = consumer.account ?? this.config.auth?.active;
      const isPinned = bound === label;
      const effective = this.servingAccountForConsumer(consumer.name);
      const isEffective = effective === label;
      if (!isPinned && !isEffective) continue;
      const toMirror = effective ?? bound;
      if (toMirror == null) continue;
      if (this.mirrorAccountToConsumer(toMirror, consumer)) {
        fanned.push(consumer.name);
      }
    }
    return fanned;
  }

  /**
   * Walk every consumer with a `mirror_dir` and re-mirror their
   * effective-account credentials. Used at boot and after a global
   * state change (e.g. set-active).
   */
  private fanoutAllConsumers(): string[] {
    const out: string[] = [];
    for (const consumer of this.config.auth?.consumers ?? []) {
      if (!consumer.mirror_dir) continue;
      const effective = this.servingAccountForConsumer(consumer.name);
      if (!effective) continue;
      if (this.mirrorAccountToConsumer(effective, consumer)) out.push(consumer.name);
    }
    return out;
  }

  /**
   * The serving (failover-resolved) account for a named consumer. Extracted
   * as a helper so fanoutToAffectedConsumers can call it without building a
   * synthetic Identity object.
   */
  private servingAccountForConsumer(name: string): string | null {
    const c = (this.config.auth?.consumers ?? []).find((x) => x.name === name);
    if (!c) return null;
    // Unpinned consumer follows the fleet active (agent parity).
    return this.accountWithFailover(c.account ?? this.config.auth?.active);
  }

  /**
   * Write the effective-account credentials to a consumer's `mirror_dir`.
   * Atomic (temp + rename). Chown to `consumer.uid` (default 0) — swallowed
   * when CAP_CHOWN is absent (dev hosts, tests).
   *
   * Returns true on success, false on any failure (logged, never throws).
   */
  private mirrorAccountToConsumer(label: string, consumer: { name: string; uid?: number; mirror_dir?: string }): boolean {
    const mirrorDir = consumer.mirror_dir;
    if (!mirrorDir) return false;
    const credsPath = accountCredentialsPath(label, this.home);
    if (!existsSync(credsPath)) return false;
    const mirrorContent = enrichMirrorContent(readFileSync(credsPath, "utf-8"));

    // Symlink guard (#1393 / M1): the consumer owns `mirror_dir` and its
    // contents, so it can pre-plant `mirror_dir` (or the target file, or
    // any ancestor of a not-yet-existing `mirror_dir`) as a symlink. The
    // broker runs as root; a raw recursive-mkdir + path-chown would
    // dereference that and hand the consumer a root-owned write/chown at
    // an arbitrary host path. Validate + safely create BEFORE any write.
    const safe = this.resolveConsumerMirrorPathsSafe(consumer.name, mirrorDir);
    if (!safe) return false;

    return safeMirrorWrite({
      parentDir: safe.mirrorDir,
      expectedRealParent: safe.expectedRealParent,
      targetPath: safe.targetPath,
      content: mirrorContent,
      uid: consumer.uid ?? 0,
      onChownError: (err) => this.warnCapChownMissing(err),
      refuse: (component, reason) =>
        this.auditMirrorRefused({ kind: "consumer", name: consumer.name }, component, reason),
      logErr: (msg) => this.logErr(`consumer-mirror ${consumer.name} <- ${label}: ${msg}`),
    });
  }

  /**
   * Symlink guard for a consumer's `mirror_dir` write path (#1393 / M1).
   *
   * Harsher than the per-agent tree: the broker `mkdirSync({recursive})`s
   * `mirror_dir`, and that directory is consumer-writable. So we refuse to
   * CREATE it through any symlinked ancestor — the leaf `mirror_dir` is
   * mkdir'd (non-recursively) only after `lstat` confirms it is absent and
   * its parent is a real (non-symlink) directory. An already-existing
   * `mirror_dir` must itself be a real directory (not a symlink the
   * consumer swapped in). The target `.credentials.json` must be
   * absent or a regular file — never a symlink.
   *
   * Returns the validated paths + the canonical-parent pin for
   * `safeMirrorWrite`, or `null` if the mirror must be skipped (already
   * logged + audited). Never throws.
   */
  private resolveConsumerMirrorPathsSafe(
    consumerName: string,
    mirrorDir: string,
  ): { mirrorDir: string; targetPath: string; expectedRealParent: string } | null {
    const identity: Identity = { kind: "consumer", name: consumerName };
    const refuse = (component: string, reason: string): null => {
      this.auditMirrorRefused(identity, component, reason);
      return null;
    };

    const parent = dirname(mirrorDir);
    const mirrorStat = this.lstatOrNull(mirrorDir);
    if (mirrorStat) {
      // `mirror_dir` exists — it must be a real directory, not a symlink
      // the consumer swapped in to redirect the root write.
      if (mirrorStat.isSymbolicLink()) return refuse("mirror_dir", "is-a-symlink");
      if (!mirrorStat.isDirectory()) return refuse("mirror_dir", "is-not-a-directory");
    } else {
      // `mirror_dir` absent — create it, but ONLY through a real
      // (non-symlink) parent: refuse to mkdir through a symlinked
      // ancestor the consumer could have planted.
      const parentStat = this.lstatOrNull(parent);
      if (!parentStat) return refuse("mirror_dir-parent", "does-not-exist");
      if (parentStat.isSymbolicLink()) return refuse("mirror_dir-parent", "is-a-symlink");
      if (!parentStat.isDirectory()) return refuse("mirror_dir-parent", "is-not-a-directory");
      try {
        mkdirSync(mirrorDir, { recursive: false, mode: 0o700 });
      } catch (err) {
        this.logErr(`consumer-mirror ${consumerName}: mkdir ${mirrorDir}: ${(err as Error).message}`);
        return null;
      }
    }

    const targetPath = join(mirrorDir, ".credentials.json");
    const targetStat = this.lstatOrNull(targetPath);
    if (targetStat) {
      if (targetStat.isSymbolicLink()) return refuse(".credentials.json", "is-a-symlink");
      if (!targetStat.isFile()) return refuse(".credentials.json", "is-not-a-regular-file");
    }

    // Canonical-parent pin (M1): derive the expected realpath from the
    // parent's canonical location + the leaf name. `safeMirrorWrite`
    // recomputes `realpathSync(mirror_dir)` and refuses on divergence —
    // catching a raced swap of `mirror_dir` to a symlink after this sweep.
    let expectedRealParent: string;
    try {
      expectedRealParent = join(realpathSync(parent), basename(mirrorDir));
    } catch (err) {
      this.logErr(`consumer-mirror ${consumerName}: realpath ${parent}: ${(err as Error).message}`);
      return null;
    }

    return { mirrorDir, targetPath, expectedRealParent };
  }

  /**
   * Failover: mirror `next`'s creds onto every agent currently on `label`.
   * `next` is the already-selected roll target (from `nextHealthyAccountLive`),
   * passed in so the live-probe selection runs exactly once and the announced
   * `rolledTo` matches what the fleet actually rolled to.
   */
  private fanoutFailoverTo(label: string, next: string | null): string[] {
    const auth = this.config.auth ?? {};
    if (!next || next === label) return []; // nothing better available
    const rolled: string[] = [];
    for (const [name, agent] of Object.entries(this.config.agents ?? {})) {
      const effective = agent.auth?.override ?? auth.active;
      if (effective !== label) continue;
      // A strict pin never rolls: the pin is a hard billing/compliance
      // boundary, so the agent keeps its own (walled) account's creds and
      // rides out the window rather than borrowing `next`'s quota.
      if (agent.auth?.override && agent.auth?.strict) continue;
      // Never roll an agent onto an account exclusive to someone else —
      // defense-in-depth; the selector already skips exclusive candidates.
      if (!this.isServableBy(next, name)) continue;
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
    // A fleet-wide roll target serves EVERY rider of the walled account, so an
    // account exclusive to one agent is never a valid target — regardless of
    // who triggered the roll. (Yaml validation keeps exclusive accounts out of
    // fallback_order; this guards hot-mutated / stale persisted state, and the
    // auto-promote path that would otherwise set auth.active to it.)
    const start = order.indexOf(current);
    if (start === -1) {
      for (const cand of order) {
        if (cand && !this.exclusiveOwnerOf(cand)) return cand;
      }
      return null;
    }
    // Soft-avoid (#3031) preference RANKING: the first non-exhausted,
    // non-soft-avoided candidate wins; when every healthy candidate is
    // soft-avoided, fall back to the least-utilized of them (never null when
    // a healthy-but-soft-avoided candidate exists — the tier must not shrink
    // availability). With `proactive_failover_pct` unset, isAccountSoftAvoided
    // is structurally false and this is exactly the pre-#3031 selection.
    let bestSoftAvoided: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let i = 1; i <= order.length; i++) {
      const cand = order[(start + i) % order.length];
      if (!cand) continue;
      // Live-authoritative: skip a candidate the live probe shows walled even
      // if its mark expired, and accept one the live probe shows healthy even
      // if a stale/bogus mark says exhausted. (The 2026-06-10 root predicate.)
      if (this.isAccountExhausted(cand) || !accountExists(cand, this.home)) continue;
      if (this.exclusiveOwnerOf(cand)) continue;
      if (!this.isAccountSoftAvoided(cand)) return cand;
      const score = this.softAvoidUtilScore(cand);
      // `=== null` seed: even when every candidate scores +Infinity (all
      // latched with stale snapshots) the first one still wins — the
      // tie-break must never return null when a serveable candidate exists.
      if (bestSoftAvoided === null || score < bestScore) {
        bestSoftAvoided = cand;
        bestScore = score;
      }
    }
    return bestSoftAvoided;
  }

  /** Compute an agent's effective account and write its mirror. */
  private fanoutForAgent(name: string): boolean {
    const agent = (this.config.agents ?? {})[name];
    if (!agent) return false;
    // Mirror the effective account THROUGH exhaustion-failover: when the raw
    // effective (override ?? auth.active) is walled, write the healthy fallback
    // instead. Without this, a refresh-tick fanout of the walled account would
    // re-mirror it onto the agent and undo the auto-fallback (#2218 durability).
    // Strict pins resolve to the pin itself — the mirror never carries another
    // account's creds onto a strict agent.
    const effective = this.servedAccountForAgent(name);
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
  ): { agentDir: string; claudeDir: string; targetPath: string; expectedRealParent: string } | null {
    const agentsDir = resolveAgentsDir(this.config);
    const agentDir = resolve(agentsDir, agentName);
    const claudeDir = join(agentDir, ".claude");
    const targetPath = join(claudeDir, ".credentials.json");

    const refuse = (component: string, reason: string): null => {
      this.auditMirrorRefused({ kind: "agent", name: agentName, admin: false }, component, reason);
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

    // Canonical-parent pin (M1): derive `claudeDir`'s expected realpath
    // from the trusted anchor (`agentsDir`, root-owned, lstat-verified
    // non-symlink) + the lstat-validated component names. `safeMirrorWrite`
    // recomputes `realpathSync(claudeDir)` right before the write and
    // refuses on divergence — catching a raced swap of `agentDir`/`.claude`
    // to a symlink after this sweep. `agentsDir` is guaranteed to exist
    // here (validated above), so `realpathSync` cannot throw for it.
    const expectedRealParent = join(realpathSync(agentsDir), agentName, ".claude");

    return { agentDir, claudeDir, targetPath, expectedRealParent };
  }

  private lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
    try {
      return lstatSync(path);
    } catch {
      return null;
    }
  }

  /**
   * Log + audit a symlink/TOCTOU mirror refusal (#1393). Shared by the
   * per-agent and per-consumer resolvers and the `safeMirrorWrite`
   * primitive. Never throws.
   */
  private auditMirrorRefused(identity: Identity, component: string, reason: string): void {
    const who = identity.kind === "operator" ? "operator" : identity.name;
    this.logErr(
      `mirror ${who}: REFUSING mirror — ${component} ${reason} ` +
        `(symlink-guard #1393; peer-owned tree may be attacker-poisoned)`,
    );
    this.audit({
      op: "mirror-symlink-refused",
      identity,
      ok: false,
      error: `${component}:${reason}`,
    });
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
    const { claudeDir, targetPath, expectedRealParent } = safe;
    // `.claude` was lstat-verified (absent or a real dir) by
    // `resolveMirrorPathsSafe`; `agentDir` is a verified real dir, so a
    // recursive mkdir here only ever creates the single `.claude` leaf and
    // cannot traverse a symlink. `safeMirrorWrite` then re-pins
    // `realpathSync(claudeDir)` against `expectedRealParent` right before
    // the write to close the residual lstat→write TOCTOU.
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
    return safeMirrorWrite({
      parentDir: claudeDir,
      expectedRealParent,
      targetPath,
      content: mirrorContent,
      uid: allocateAgentUid(agentName),
      onChownError: (err) => this.warnCapChownMissing(err),
      refuse: (component, reason) =>
        this.auditMirrorRefused({ kind: "agent", name: agentName, admin: false }, component, reason),
      logErr: (msg) => this.logErr(`fanout ${agentName} <- ${label}: ${msg}`),
    });
  }

  /* ─── State persistence ─────────────────────────────────────── */

  private loadStateFromDisk(): void {
    this.quota = this.readJson<QuotaState>("quota.json") ?? {};
    this.shaIndex = this.readJson<ShaIndex>("sha-index.json") ?? {};
    this.thresholdViolations = this.readJson<ThresholdViolations>("threshold-violations.json") ?? {};
    this.notificationClaims = this.readJson<NotificationClaims>("notification-claims.json") ?? {};
    this.lastFleetRoll = this.readJson<LastFleetRoll>("last-fleet-roll.json") ?? null;
    // #2495 Change 1 — reload the durable utilization cache so a restart
    // serves last-known (age-stamped) quota, not a blank card.
    this.lastQuotaCache = this.readJson<LastQuotaCache>("last-quota.json") ?? {};
    // #3176 — reload the durable flagship-tier canary cache + all-walled alert.
    this.lastTierQuotaCache = this.readJson<LastTierQuotaCache>("last-tier-quota.json") ?? {};
    this.premiumTierAllWalled = this.readJson<PremiumTierAllWalled>("premium-tier-all-walled.json") ?? null;
    // #3185 — reload the durable per-(account, tier) usage ledger so a restart
    // keeps the rolling history instead of starting the trend from scratch.
    this.usageLedger = this.readJson<UsageLedger>("usage-ledger.json") ?? {};
    {
      const es = this.readJson<{
        summary?: ExternalSpendSummary;
        capturedAtMs?: number;
      }>("external-spend.json");
      if (
        es &&
        es.summary &&
        typeof es.capturedAtMs === "number" &&
        Number.isFinite(es.summary.day24hUsd) &&
        Number.isFinite(es.summary.day7dUsd) &&
        Array.isArray(es.summary.top) &&
        es.summary.top.every(
          (t) =>
            t &&
            typeof t.label === "string" &&
            typeof t.usd === "number" &&
            Number.isFinite(t.usd),
        )
      ) {
        this.externalSpendCache = {
          summary: {
            day24hUsd: es.summary.day24hUsd,
            day7dUsd: es.summary.day7dUsd,
            top: es.summary.top.map((t) => ({
              label: t.label,
              usd: t.usd,
            })),
          },
          capturedAtMs: es.capturedAtMs,
        };
      }
    }
    this.applyActiveOverride();
  }

  /**
   * Apply the persisted fleet-active override (see `ActiveOverride`).
   * Called on boot (loadStateFromDisk) and after every SIGHUP reload.
   *
   * Rules:
   *   - no file / malformed → nothing.
   *   - yaml `auth.active` changed since the override was written →
   *     operator hand-edit is newer intent: drop the override (delete file).
   *   - override account no longer exists on disk → ignore (keep yaml).
   *   - otherwise → the override IS the fleet active.
   */
  private applyActiveOverride(): void {
    const ov = this.readJson<ActiveOverride>("active-override.json");
    if (!ov || typeof ov.active !== "string" || ov.active.length === 0) return;
    const yamlActive = this.yamlActive ?? null;
    if ((ov.yaml_active_at_write ?? null) !== yamlActive) {
      process.stdout.write(
        `auth-broker: active-override dropped — yaml auth.active changed since the swap ` +
          `(${ov.yaml_active_at_write ?? "unset"} → ${yamlActive ?? "unset"}); yaml wins\n`,
      );
      try { unlinkSync(join(this.stateDir, "active-override.json")); } catch { /* best-effort */ }
      return;
    }
    if (!accountExists(ov.active, this.home)) {
      process.stdout.write(
        `auth-broker: active-override ignored — account '${ov.active}' not found on disk\n`,
      );
      return;
    }
    // A persisted swap can predate an `exclusive` flag added to yaml since:
    // schema validation only sees yaml's own `auth.active`, so a stale
    // override naming a now-exclusive account would re-apply at every boot
    // and serve the account fleet-wide. Drop it (not just ignore) — yaml is
    // the source of truth for exclusivity and the swap is no longer legal.
    const exclusiveOwner = this.exclusiveOwnerOf(ov.active);
    if (exclusiveOwner) {
      process.stdout.write(
        `auth-broker: active-override dropped — account '${ov.active}' is now exclusive ` +
          `to agent '${exclusiveOwner}' (agents.${exclusiveOwner}.auth.exclusive); yaml wins\n`,
      );
      try { unlinkSync(join(this.stateDir, "active-override.json")); } catch { /* best-effort */ }
      return;
    }
    if (ov.active === this.config.auth?.active) return;
    this.config = {
      ...this.config,
      auth: { ...(this.config.auth ?? {}), active: ov.active },
    };
    process.stdout.write(
      `auth-broker: active-override applied — auth.active ${yamlActive ?? "unset"} → ${ov.active} ` +
        `(persisted swap survives restarts)\n`,
    );
  }

  /** Persist the current fleet-active swap so it survives a broker
   *  restart/recreate. See `ActiveOverride` for the precedence contract. */
  private persistActiveOverride(active: string): void {
    const entry: ActiveOverride = {
      active,
      yaml_active_at_write: this.yamlActive ?? null,
      updated_at: this.now(),
    };
    atomicWriteJsonSync(join(this.stateDir, "active-override.json"), entry, 0o600);
  }

  private readJson<T>(name: string): T | null {
    const p = join(this.stateDir, name);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, "utf-8")) as T; } catch { return null; }
  }

  private persistQuota(): void { atomicWriteJsonSync(join(this.stateDir, "quota.json"), this.quota, 0o600); }
  /** #2495 Change 1 — mirror the utilization cache to disk so it survives
   *  a broker restart. Same atomic-write pattern as the exhaustion ledger. */
  private persistLastQuotaCache(): void { atomicWriteJsonSync(join(this.stateDir, "last-quota.json"), this.lastQuotaCache, 0o600); }
  private persistExternalSpendCache(): void {
    if (!this.externalSpendCache) return;
    atomicWriteJsonSync(
      join(this.stateDir, "external-spend.json"),
      this.externalSpendCache,
      0o600,
    );
  }
  /** #3176 — mirror the flagship-tier canary cache to disk. */
  private persistLastTierQuotaCache(): void { atomicWriteJsonSync(join(this.stateDir, "last-tier-quota.json"), this.lastTierQuotaCache, 0o600); }
  /** #3185 — mirror the per-(account, tier) usage ledger to disk so the rolling
   *  history survives a broker restart. */
  private persistUsageLedger(): void { atomicWriteJsonSync(join(this.stateDir, "usage-ledger.json"), this.usageLedger, 0o600); }

  /**
   * #3185 — append a usage sample to the rolling ledger and persist. A null
   * sample (failed / thin / no-tier-signal probe) is a no-op and does NOT
   * re-write the file — so a run of empty probes costs nothing. Never throws
   * into the probe path: a ledger/persist failure is logged, never fatal.
   */
  private recordUsage(
    label: string,
    tier: "standard" | "premium",
    sample: ReturnType<typeof standardSampleFromResult>,
  ): void {
    if (sample == null) return;
    try {
      recordUsageSample(this.usageLedger, label, tier, sample, this.usageRingCap);
      this.persistUsageLedger();
    } catch (err) {
      this.logErr(`usage-ledger ${label}/${tier}: ${(err as Error).message}`);
    }
  }
  private persistNotificationClaims(): void { atomicWriteJsonSync(join(this.stateDir, "notification-claims.json"), this.notificationClaims, 0o600); }
  private persistLastFleetRoll(): void { if (this.lastFleetRoll) atomicWriteJsonSync(join(this.stateDir, "last-fleet-roll.json"), this.lastFleetRoll, 0o600); }
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
    /**
     * Credential kind for the account this audit entry concerns.
     * Omitted for ops that have no account context (list-state, claim-notification,
     * mirror-symlink-refused) or for list-* ops where the op name already
     * encodes the provider.
     *
     * Values:
     *   "claude"    — Anthropic / claudeAiOauth credential
     *   "google"    — Google Workspace / googleOauth credential
     *   "microsoft" — Microsoft 365 / microsoftOauth credential
     *   "unknown"   — provider could not be determined at the call site
     */
    accountKind?: "claude" | "microsoft" | "google" | "unknown";
    ok: boolean;
    error?: string;
    replace?: boolean;
    /**
     * Trigger attribution for probe-driven failover rolls (#3031 PR 2):
     *   "soft-avoid"          — serving-preference roll off the soft-avoid tier
     *   "hard-exhaustion"     — the probe saw a genuine quota wall
     *   "throttle-escalation" — repeated transient 429s corroborated by a live
     *                           probe (429 throttle tier escalation guard)
     *   "model-tier-wall"     — flagship-tier (7d_oi) canary saw the account
     *                           walled on the premium tier (#3176)
     *   "entitlement-403"     — a 403 whose body says the org/subscription has
     *                           disabled Claude Code access (hard block)
     * Omitted for every other op.
     */
    reason?: "soft-avoid" | "hard-exhaustion" | "throttle-escalation" | "model-tier-wall" | "entitlement-403";
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
      accountKind: entry.accountKind,
      ok: entry.ok,
      error: entry.error,
      replace: entry.replace,
      reason: entry.reason,
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
    /** #2495 Change 1 — durable utilization cache (in-memory view). */
    lastQuotaCache: LastQuotaCache;
    /** #3176 — flagship-tier canary cache + all-walled alert + live active. */
    lastTierQuotaCache: LastTierQuotaCache;
    premiumTierAllWalled: PremiumTierAllWalled | null;
    /** #3185 — per-(account, tier) rolling usage ledger (in-memory view). */
    usageLedger: UsageLedger;
    activeAccount: string | undefined;
  } {
    return {
      quota: { ...this.quota },
      shaIndex: { ...this.shaIndex },
      thresholdViolations: { ...this.thresholdViolations },
      listeners: [...this.listeners.keys()],
      lastQuotaCache: structuredClone(this.lastQuotaCache),
      lastTierQuotaCache: structuredClone(this.lastTierQuotaCache),
      usageLedger: structuredClone(this.usageLedger),
      premiumTierAllWalled: this.premiumTierAllWalled
        ? { ...this.premiumTierAllWalled }
        : null,
      activeAccount: this.config.auth?.active,
    };
  }

  /** Test-only: run the all-agent fanout. */
  _fanoutAll(): string[] {
    return this.fanoutAll();
  }
}

/** Re-export so the entry point can register error codes. */
export type { ErrorCode };
