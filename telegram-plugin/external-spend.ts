/**
 * External (non-Claude / OpenRouter cash) spend for the `/usage` card.
 *
 * Layout B (operator-locked 2026-07-19):
 * ```
 * - 💸 External
 * - 24h `$X.XX` · 7d `$Y.YY`
 * - top `model $a` · `model $b` · `model $c`
 * ```
 *
 * Source: LiteLLM `GET /spend/logs?start_date&end_date` daily summaries
 * (admin/master key). Agent virtual keys get 401 — resolve master via env
 * or vault `litellm/master-key`. On any failure, callers OMIT the block.
 *
 * Successful summaries are cached in-process (~90s) so Refresh spam does not
 * hammer LiteLLM. Never log key material.
 */

import {
  getViaBrokerStructured,
  readVaultTokenFile,
} from '../src/vault/broker/client.js';
import { loadConfig, findConfigFile } from '../src/config/loader.js';

export interface ExternalSpendTopModel {
  label: string;
  usd: number;
}

export interface ExternalSpendSummary {
  day24hUsd: number;
  day7dUsd: number;
  top: ExternalSpendTopModel[];
}

/** One daily row from LiteLLM summarized `/spend/logs`. */
export interface LiteLLMDaySpendRow {
  startTime?: string;
  /** Day total including Claude — never used as External. */
  spend?: number;
  models?: Record<string, number | string>;
}

export const EXTERNAL_SPEND_CACHE_TTL_MS = 90_000;
export const EXTERNAL_SPEND_FETCH_TIMEOUT_MS = 4_000;
export const DEFAULT_LITELLM_BASE = 'http://127.0.0.1:4010';
const TOP_N = 3;

const BARE_EXTERNAL_NEEDLES = [
  'gpt-oss',
  'grok',
  'gemini',
  'deepseek',
  'kimi',
  'glm-',
  'qwen',
  'llama',
] as const;

let cache: { atMs: number; summary: ExternalSpendSummary } | null = null;

/** Test seam — clear the in-process cache. */
export function clearExternalSpendCache(): void {
  cache = null;
}

/**
 * True when a LiteLLM model name is cash/external (OpenRouter etc.), not
 * Anthropic Max/Pro subscription passthrough via the proxy.
 */
export function isExternalModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  if (!m) return false;
  // Subscription Claude / Anthropic passthrough — never External $.
  if (m.startsWith('claude')) return false;
  if (m.includes('anthropic/claude')) return false;
  if (m.startsWith('anthropic/claude')) return false;

  if (m.startsWith('openrouter/')) return true;
  if (m.startsWith('sr-')) return true;

  // Bare aliases / non-openrouter-prefixed cash models seen in logs.
  for (const needle of BARE_EXTERNAL_NEEDLES) {
    if (m.includes(needle)) return true;
  }
  return false;
}

/** Strip openrouter/ and keep a short trailing id for the top line. */
export function shortModelLabel(model: string): string {
  let m = model.trim();
  if (m.toLowerCase().startsWith('openrouter/')) {
    m = m.slice('openrouter/'.length);
  }
  // Path-like org/model → last segment (openai/gpt-oss-20b → gpt-oss-20b).
  const parts = m.split('/').filter(Boolean);
  if (parts.length >= 2) {
    m = parts[parts.length - 1]!;
  }
  if (m.toLowerCase().startsWith('sr-')) {
    // sr-grok-4.5 → grok-4.5
    m = m.slice(3);
  }
  return m || model.trim();
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '$0.00';
  return `$${n.toFixed(2)}`;
}

export function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addUtcDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + days);
  return utcDateString(dt);
}

function rowDay(row: LiteLLMDaySpendRow): string | null {
  const st = row.startTime;
  if (!st || typeof st !== 'string') return null;
  // "2026-07-19" or ISO timestamp
  return st.length >= 10 ? st.slice(0, 10) : null;
}

function externalModelsFromRow(row: LiteLLMDaySpendRow): Record<string, number> {
  const out: Record<string, number> = {};
  const models = row.models ?? {};
  for (const [name, raw] of Object.entries(models)) {
    if (!isExternalModel(name)) continue;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n) || n === 0) continue;
    out[name] = (out[name] ?? 0) + n;
  }
  return out;
}

/**
 * Pure aggregator — unit-test without network.
 * `now` pins the UTC "today" used for 24h / 7d windows.
 *
 * Windows (UTC calendar days on LiteLLM `startTime`):
 *   - 24h: today only
 *   - 7d:  today-6 .. today inclusive
 * Top models: aggregate external spend across the 7d window, top 3.
 * Does NOT use `row.spend` (mixed Claude + external).
 */
export function summarizeExternalSpend(
  days: readonly LiteLLMDaySpendRow[],
  now: Date = new Date(),
): ExternalSpendSummary {
  const today = utcDateString(now);
  const start7 = addUtcDays(today, -6); // inclusive 7 calendar days

  let day24hUsd = 0;
  let day7dUsd = 0;
  const byModel: Record<string, number> = {};

  for (const row of days) {
    const day = rowDay(row);
    if (!day) continue;
    if (day < start7 || day > today) continue;
    const ext = externalModelsFromRow(row);
    let rowSum = 0;
    for (const [name, usd] of Object.entries(ext)) {
      rowSum += usd;
      byModel[name] = (byModel[name] ?? 0) + usd;
    }
    day7dUsd += rowSum;
    if (day === today) day24hUsd += rowSum;
  }

  const top = Object.entries(byModel)
    .filter(([, usd]) => usd > 0)
    .sort((a, b) => b[1]! - a[1]! || a[0]!.localeCompare(b[0]!))
    .slice(0, TOP_N)
    .map(([name, usd]) => ({ label: shortModelLabel(name), usd }));

  return { day24hUsd, day7dUsd, top };
}

/**
 * Render layout-B bullet lines (no trailing freshness).
 * Returns `[]` when summary is null/undefined so callers can omit.
 * Zero totals still render — honest "no external spend".
 */
export function formatExternalSpendBlock(
  summary: ExternalSpendSummary | null | undefined,
): string[] {
  if (summary == null) return [];
  const lines = [
    '- 💸 External',
    `- 24h \`${formatUsd(summary.day24hUsd)}\` · 7d \`${formatUsd(summary.day7dUsd)}\``,
  ];
  if (summary.top.length > 0) {
    const topParts = summary.top.map((t) => `\`${t.label} ${formatUsd(t.usd)}\``);
    lines.push(`- top ${topParts.join(' · ')}`);
  }
  return lines;
}

/** Strip a leading `vault:` reference to the bare key name. */
export function vaultKeyFromRef(ref: string): string | null {
  const t = ref.trim();
  if (!t.toLowerCase().startsWith('vault:')) return null;
  const key = t.slice('vault:'.length).trim();
  return key.length > 0 ? key : null;
}

export function resolveLitellmBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.SWITCHROOM_LITELLM_BASE ?? DEFAULT_LITELLM_BASE).trim();
  return raw.replace(/\/+$/, '') || DEFAULT_LITELLM_BASE;
}

/**
 * Normalize a `/spend/logs` JSON body into day rows. LiteLLM has returned
 * either a bare array or `{ data: [...] }` depending on version.
 */
export function normalizeSpendLogRows(body: unknown): LiteLLMDaySpendRow[] {
  if (Array.isArray(body)) return body as LiteLLMDaySpendRow[];
  if (body && typeof body === 'object') {
    const data = (body as { data?: unknown }).data;
    if (Array.isArray(data)) return data as LiteLLMDaySpendRow[];
  }
  return [];
}

export interface ResolveAdminKeyDeps {
  env?: NodeJS.ProcessEnv;
  /** Raw `litellm.admin_key` from config (may be `vault:…`). */
  readAdminKeyRef?: () => string | null | undefined;
  vaultGet?: (key: string) => Promise<string | null>;
  agentName?: string;
}

/**
 * Resolve LiteLLM master/admin key for `/spend/logs`. Never logs the value.
 * Order: env → config vault ref via broker → null.
 */
export async function resolveLitellmAdminKey(
  deps: ResolveAdminKeyDeps = {},
): Promise<string | null> {
  const env = deps.env ?? process.env;
  const fromEnv = (
    env.SWITCHROOM_LITELLM_ADMIN_KEY ??
    env.LITELLM_MASTER_KEY ??
    ''
  ).trim();
  if (fromEnv) return fromEnv;

  let ref: string | null | undefined;
  try {
    ref = deps.readAdminKeyRef
      ? deps.readAdminKeyRef()
      : defaultReadAdminKeyRef();
  } catch {
    ref = null;
  }

  const vaultKey = ref ? vaultKeyFromRef(ref) : null;
  if (ref && !vaultKey) {
    // Literal non-vault value in config (dev only).
    const plain = ref.trim();
    return plain.length > 0 ? plain : null;
  }
  const keyName = vaultKey ?? 'litellm/master-key';

  if (deps.vaultGet) {
    try {
      return await deps.vaultGet(keyName);
    } catch {
      return null;
    }
  }

  try {
    const agent = deps.agentName ?? env.SWITCHROOM_AGENT_NAME;
    const token = agent ? (readVaultTokenFile(agent) ?? undefined) : undefined;
    const result = await getViaBrokerStructured(keyName, token ? { token } : {});
    if (result.kind === 'ok' && result.entry.kind === 'string' && result.entry.value) {
      const v = result.entry.value.trim();
      return v.length > 0 ? v : null;
    }
  } catch {
    // omit External
  }
  return null;
}

function defaultReadAdminKeyRef(): string | null {
  try {
    // Dynamic import path keeps unit tests that never touch config hermetic
    // when they inject readAdminKeyRef. Production uses loadConfig.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadConfig, findConfigFile } = require('../src/config/loader.js') as typeof import('../src/config/loader.js');
    const cfgPath = findConfigFile();
    const cfg = loadConfig(cfgPath) as { litellm?: { admin_key?: string } };
    const ref = cfg.litellm?.admin_key;
    return typeof ref === 'string' && ref.trim() ? ref.trim() : null;
  } catch {
    return null;
  }
}

export interface FetchExternalSpendDeps {
  env?: NodeJS.ProcessEnv;
  now?: Date;
  fetchImpl?: typeof fetch;
  resolveAdminKey?: () => Promise<string | null>;
  resolveBaseUrl?: () => string;
  cacheTtlMs?: number;
  timeoutMs?: number;
  /** When true, bypass the in-process TTL cache (tests). */
  bypassCache?: boolean;
}

/**
 * Best-effort fleet External spend for `/usage`. Returns null when the
 * summary is unavailable (no key, timeout, 401, etc.) — caller omits the block.
 * Successful results are cached ~90s.
 */
export async function fetchExternalSpendSummary(
  nowOrDeps: Date | FetchExternalSpendDeps = {},
): Promise<ExternalSpendSummary | null> {
  // Backward-compatible: `fetchExternalSpendSummary(new Date())` still works.
  const deps: FetchExternalSpendDeps =
    nowOrDeps instanceof Date ? { now: nowOrDeps } : nowOrDeps;
  const now = deps.now ?? new Date();
  const ttl = deps.cacheTtlMs ?? EXTERNAL_SPEND_CACHE_TTL_MS;
  if (!deps.bypassCache && cache && Date.now() - cache.atMs < ttl) {
    return cache.summary;
  }

  const env = deps.env ?? process.env;
  const resolveKey =
    deps.resolveAdminKey ?? (() => resolveLitellmAdminKey({ env }));
  let key: string | null;
  try {
    key = await resolveKey();
  } catch {
    return null;
  }
  if (!key) return null;

  const base = (deps.resolveBaseUrl ?? (() => resolveLitellmBaseUrl(env)))();
  const today = utcDateString(now);
  const start = addUtcDays(today, -6);
  const end = addUtcDays(today, 1); // exclusive-ish end for LiteLLM
  const url = `${base}/spend/logs?start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}`;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? EXTERNAL_SPEND_FETCH_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
      signal: ac.signal,
    });
    if (!res.ok) return null;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return null;
    }
    const rows = normalizeSpendLogRows(body);
    const summary = summarizeExternalSpend(rows, now);
    cache = { atMs: Date.now(), summary };
    return summary;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
