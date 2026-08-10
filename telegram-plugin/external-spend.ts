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
 * **Durable path:** the auth-broker holds the LiteLLM master key and
 * serves a sanitized summary via `get-external-spend`. Agents never
 * receive the master key. Soft-fail → omit the External block.
 *
 * Pure helpers (filter/format) live in `src/litellm/external-spend.ts`
 * and are re-exported here for card rendering + tests.
 */

import {
  formatUsd,
  type ExternalSpendSummary,
  type ExternalSpendTopModel,
} from '../src/litellm/external-spend.js';

export type { ExternalSpendSummary, ExternalSpendTopModel };
export {
  isExternalModel,
  shortModelLabel,
  formatUsd,
  summarizeExternalSpend,
  normalizeDailyActivityRows,
  utcDateString,
  addUtcDays,
  EXTERNAL_SPEND_CACHE_TTL_MS,
  type LiteLLMDaySpendRow,
} from '../src/litellm/external-spend.js';

/** Soft client-side cache so strip double-taps of /usage within a process. */
const CLIENT_CACHE_TTL_MS = 30_000;
let clientCache: { atMs: number; summary: ExternalSpendSummary } | null = null;

/** Test seam. */
export function clearExternalSpendCache(): void {
  clientCache = null;
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

export interface FetchExternalSpendDeps {
  now?: Date;
  /** Prefer injected client for tests; defaults to env agent socket. */
  getExternalSpend?: (forceLive?: boolean) => Promise<{
    available: boolean;
    day24hUsd?: number;
    day7dUsd?: number;
    top?: Array<{ label: string; usd: number }>;
    capturedAtMs?: number;
    served?: 'live' | 'cache';
    reason?: string;
  }>;
  forceLive?: boolean;
  bypassCache?: boolean;
  cacheTtlMs?: number;
}

/**
 * Best-effort fleet External spend for `/usage`.
 * Primary: auth-broker `get-external-spend` (master key stays in broker).
 * Returns null when unavailable — caller omits the block.
 */
export async function fetchExternalSpendSummary(
  nowOrDeps: Date | FetchExternalSpendDeps = {},
): Promise<ExternalSpendSummary | null> {
  const deps: FetchExternalSpendDeps =
    nowOrDeps instanceof Date ? { now: nowOrDeps } : nowOrDeps;
  const ttl = deps.cacheTtlMs ?? CLIENT_CACHE_TTL_MS;
  if (!deps.bypassCache && clientCache && Date.now() - clientCache.atMs < ttl) {
    return clientCache.summary;
  }

  try {
    let data: Awaited<ReturnType<NonNullable<FetchExternalSpendDeps['getExternalSpend']>>>;
    if (deps.getExternalSpend) {
      data = await deps.getExternalSpend(deps.forceLive);
    } else {
      // Lazy import avoids pulling the full client graph into pure test paths.
      const { AuthBrokerClient } = await import('../src/auth/broker/client.js');
      const client = new AuthBrokerClient();
      try {
        data = await client.getExternalSpend(deps.forceLive);
      } finally {
        try {
          await client.close();
        } catch {
          /* ignore */
        }
      }
    }
    if (!data?.available) return null;
    if (
      typeof data.day24hUsd !== 'number' ||
      typeof data.day7dUsd !== 'number' ||
      !Array.isArray(data.top)
    ) {
      return null;
    }
    const summary: ExternalSpendSummary = {
      day24hUsd: data.day24hUsd,
      day7dUsd: data.day7dUsd,
      top: data.top.map((t) => ({ label: String(t.label), usd: Number(t.usd) })),
    };
    clientCache = { atMs: Date.now(), summary };
    return summary;
  } catch {
    return null;
  }
}
