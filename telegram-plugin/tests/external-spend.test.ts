import { describe, expect, it } from 'vitest';
import {
  formatExternalSpendBlock,
  formatUsd,
  isExternalModel,
  shortModelLabel,
  summarizeExternalSpend,
  type LiteLLMDaySpendRow,
} from '../external-spend.js';
import { renderUsageCard } from '../quota-bar-format.js';
import type { AccountSnapshot } from '../auth-snapshot-format.js';
import type { QuotaUtilization } from '../quota-check.js';

describe('isExternalModel', () => {
  it('includes openrouter and sr-* cash models', () => {
    expect(isExternalModel('openrouter/openai/gpt-oss-20b')).toBe(true);
    expect(isExternalModel('openrouter/x-ai/grok-4.5')).toBe(true);
    expect(isExternalModel('sr-grok-4.5')).toBe(true);
    expect(isExternalModel('gpt-oss-20b')).toBe(true);
  });

  it('excludes Claude / Anthropic subscription passthrough', () => {
    expect(isExternalModel('claude-sonnet-5')).toBe(false);
    expect(isExternalModel('claude-opus-4-8')).toBe(false);
    expect(isExternalModel('anthropic/claude-fable-5')).toBe(false);
    expect(isExternalModel('anthropic/claude-sonnet-5')).toBe(false);
  });
});

describe('shortModelLabel', () => {
  it('strips openrouter and keeps the trailing model id', () => {
    expect(shortModelLabel('openrouter/openai/gpt-oss-20b')).toBe('gpt-oss-20b');
    expect(shortModelLabel('openrouter/x-ai/grok-4.5')).toBe('grok-4.5');
    expect(shortModelLabel('sr-grok-4.5')).toBe('grok-4.5');
  });
});

describe('formatUsd', () => {
  it('formats two decimal places', () => {
    expect(formatUsd(8.0667)).toBe('$8.07');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(119.892)).toBe('$119.89');
  });
});

describe('summarizeExternalSpend', () => {
  // Fixed "now": 2026-07-19T12:00:00Z → UTC today 2026-07-19
  const now = new Date('2026-07-19T12:00:00.000Z');

  const days: LiteLLMDaySpendRow[] = [
    {
      startTime: '2026-07-18',
      spend: 500,
      models: {
        'claude-sonnet-5': 100,
        'openrouter/openai/gpt-oss-20b': 107.78,
        'openrouter/google/gemini-3.1-flash-lite': 0.01,
      },
    },
    {
      startTime: '2026-07-19',
      spend: 200,
      models: {
        'anthropic/claude-fable-5': 50,
        'openrouter/openai/gpt-oss-20b': 6.1,
        'openrouter/x-ai/grok-4.5': 1.18,
        'openrouter/google/gemini-3.1-flash-lite': 0.79,
      },
    },
    // Outside 7d window (today-6 = 2026-07-13)
    {
      startTime: '2026-07-10',
      models: { 'openrouter/openai/gpt-oss-20b': 999 },
    },
  ];

  it('sums 24h = UTC today external only; 7d = rolling 7 calendar days; top from 7d', () => {
    const s = summarizeExternalSpend(days, now);
    expect(s.day24hUsd).toBeCloseTo(6.1 + 1.18 + 0.79, 5);
    expect(s.day7dUsd).toBeCloseTo(107.78 + 0.01 + 6.1 + 1.18 + 0.79, 5);
    expect(s.top.map((t) => t.label)).toEqual([
      'gpt-oss-20b',
      'grok-4.5',
      'gemini-3.1-flash-lite',
    ]);
    expect(s.top[0]!.usd).toBeCloseTo(107.78 + 6.1, 5);
  });

  it('ignores Claude even when dominant in day.spend', () => {
    const s = summarizeExternalSpend(
      [{ startTime: '2026-07-19', spend: 999, models: { 'claude-opus-4-8': 999 } }],
      now,
    );
    expect(s.day24hUsd).toBe(0);
    expect(s.day7dUsd).toBe(0);
    expect(s.top).toEqual([]);
  });
});

describe('formatExternalSpendBlock', () => {
  it('matches layout B', () => {
    const lines = formatExternalSpendBlock({
      day24hUsd: 8.07,
      day7dUsd: 119.89,
      top: [
        { label: 'gpt-oss-20b', usd: 6.1 },
        { label: 'grok-4.5', usd: 1.18 },
        { label: 'gemini-3.1-flash-lite', usd: 0.79 },
      ],
    });
    expect(lines).toEqual([
      '- 💸 External',
      '- 24h `$8.07` · 7d `$119.89`',
      '- top `gpt-oss-20b $6.10` · `grok-4.5 $1.18` · `gemini-3.1-flash-lite $0.79`',
    ]);
  });

  it('omits top line when empty', () => {
    const lines = formatExternalSpendBlock({ day24hUsd: 0, day7dUsd: 0, top: [] });
    expect(lines).toEqual(['- 💸 External', '- 24h `$0.00` · 7d `$0.00`']);
  });
});

describe('renderUsageCard + externalSpend', () => {
  const NOW = new Date('2026-07-10T12:00:00Z');
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

  it('omits External when externalSpend is null/undefined', () => {
    const out = renderUsageCard(snapshots, exhausted, { now: NOW });
    expect(out).not.toContain('External');
    expect(out.split('\n').pop()).toBe('_Live_');
  });

  it('inserts External between recommendation and freshness footer', () => {
    const out = renderUsageCard(snapshots, exhausted, {
      now: NOW,
      externalSpend: {
        day24hUsd: 8.07,
        day7dUsd: 119.89,
        top: [
          { label: 'gpt-oss-20b', usd: 6.1 },
          { label: 'grok-4.5', usd: 1.18 },
        ],
      },
    });
    const lines = out.split('\n');
    expect(out).toContain('- 💸 External');
    expect(out).toContain('- 24h `$8.07` · 7d `$119.89`');
    expect(out).toContain('top `gpt-oss-20b $6.10`');
    // Freshness remains last.
    expect(lines[lines.length - 1]).toBe('_Live_');
    // Recommendation precedes External.
    const recIdx = lines.findIndex((l) => l.includes('Recommendation'));
    const extIdx = lines.findIndex((l) => l.includes('💸 External'));
    expect(recIdx).toBeGreaterThanOrEqual(0);
    expect(extIdx).toBeGreaterThan(recIdx);
  });
});
