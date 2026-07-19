/**
 * Unit tests for External OpenRouter/$ spend (layout B on /usage).
 * Pure filter/format coverage lives primarily in
 * `src/litellm/external-spend.test.ts`. This file covers the card
 * block formatter + broker-backed fetch ExternalSpendSummary path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  formatExternalSpendBlock,
  fetchExternalSpendSummary,
  clearExternalSpendCache,
  formatUsd,
  isExternalModel,
  shortModelLabel,
  summarizeExternalSpend,
} from '../external-spend.js';
import { renderUsageCard } from '../quota-bar-format.js';
import type { AccountSnapshot } from '../auth-snapshot-format.js';
import type { QuotaUtilization } from '../quota-check.js';

const NOW = new Date('2026-07-19T15:30:00.000Z');

beforeEach(() => {
  clearExternalSpendCache();
});

describe('re-exported pure helpers', () => {
  it('filter / labels / money still work from the telegram module', () => {
    expect(isExternalModel('openrouter/openai/gpt-oss-20b')).toBe(true);
    expect(isExternalModel('claude-sonnet-5')).toBe(false);
    expect(shortModelLabel('openrouter/x-ai/grok-4.5')).toBe('grok-4.5');
    expect(formatUsd(8.07)).toBe('$8.07');
    const s = summarizeExternalSpend(
      [
        {
          startTime: '2026-07-19',
          models: { 'openrouter/openai/gpt-oss-20b': 1.5, 'claude-sonnet-5': 9 },
        },
      ],
      NOW,
    );
    expect(s.day24hUsd).toBeCloseTo(1.5, 5);
  });
});

describe('formatExternalSpendBlock', () => {
  it('renders locked layout B', () => {
    expect(
      formatExternalSpendBlock({
        day24hUsd: 8.07,
        day7dUsd: 119.89,
        top: [
          { label: 'gpt-oss-20b', usd: 6.1 },
          { label: 'grok-4.5', usd: 1.18 },
          { label: 'gemini-3.1-flash-lite', usd: 0.79 },
        ],
      }),
    ).toEqual([
      '- 💸 External',
      '- 24h `$8.07` · 7d `$119.89`',
      '- top `gpt-oss-20b $6.10` · `grok-4.5 $1.18` · `gemini-3.1-flash-lite $0.79`',
    ]);
  });

  it('omits top and returns [] for null', () => {
    expect(formatExternalSpendBlock({ day24hUsd: 0, day7dUsd: 0, top: [] })).toEqual([
      '- 💸 External',
      '- 24h `$0.00` · 7d `$0.00`',
    ]);
    expect(formatExternalSpendBlock(null)).toEqual([]);
  });
});

describe('fetchExternalSpendSummary (broker path)', () => {
  it('returns null when broker says unavailable', async () => {
    const s = await fetchExternalSpendSummary({
      getExternalSpend: async () => ({ available: false, reason: 'master_key_unavailable' }),
      bypassCache: true,
    });
    expect(s).toBeNull();
  });

  it('maps available broker payload + caches', async () => {
    let calls = 0;
    const getExternalSpend = vi.fn(async () => {
      calls += 1;
      return {
        available: true,
        day24hUsd: 1.5,
        day7dUsd: 10,
        top: [{ label: 'gpt-oss-20b', usd: 1.5 }],
        served: 'live' as const,
        capturedAtMs: Date.now(),
      };
    });
    const first = await fetchExternalSpendSummary({
      getExternalSpend,
      bypassCache: true,
    });
    expect(first).toEqual({
      day24hUsd: 1.5,
      day7dUsd: 10,
      top: [{ label: 'gpt-oss-20b', usd: 1.5 }],
    });
    const second = await fetchExternalSpendSummary({ getExternalSpend });
    expect(second?.day24hUsd).toBeCloseTo(1.5, 5);
    expect(calls).toBe(1);
  });

  it('returns null on thrown broker error', async () => {
    const s = await fetchExternalSpendSummary({
      getExternalSpend: async () => {
        throw new Error('unreachable');
      },
      bypassCache: true,
    });
    expect(s).toBeNull();
  });
});

describe('renderUsageCard + externalSpend', () => {
  function quota(part: Partial<QuotaUtilization>): QuotaUtilization {
    return {
      fiveHourUtilizationPct: 0,
      sevenDayUtilizationPct: 0,
      fiveHourResetAt: null,
      sevenDayResetAt: null,
      representativeClaim: null,
      overageStatus: null,
      overageDisabledReason: null,
      ...part,
    };
  }
  const snapshots: AccountSnapshot[] = [
    {
      label: 'ken@example.com',
      isActive: true,
      quota: quota({
        fiveHourUtilizationPct: 0,
        sevenDayUtilizationPct: 47,
        fiveHourResetAt: new Date(NOW.getTime() + 60 * 60_000),
        sevenDayResetAt: new Date(NOW.getTime() + (3 * 24 + 1) * 60 * 60_000),
      }),
    },
  ];
  const exhausted = new Map<string, boolean>([['ken@example.com', false]]);

  it('inserts External between recommendation and freshness', () => {
    const out = renderUsageCard(snapshots, exhausted, {
      now: NOW,
      externalSpend: {
        day24hUsd: 8.07,
        day7dUsd: 119.89,
        top: [{ label: 'gpt-oss-20b', usd: 6.1 }],
      },
    });
    const lines = out.split('\n');
    const recIdx = lines.findIndex((l) => l.includes('Recommendation'));
    const extIdx = lines.findIndex((l) => l.includes('💸 External'));
    expect(extIdx).toBe(recIdx + 1);
    expect(lines[lines.length - 1]).toBe('_Live_');
  });

  it('omits External when null', () => {
    const out = renderUsageCard(snapshots, exhausted, { now: NOW, externalSpend: null });
    expect(out).not.toContain('💸 External');
  });
});
