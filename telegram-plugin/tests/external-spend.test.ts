/**
 * Pure unit tests for External OpenRouter/$ spend (layout B on /usage).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isExternalModel,
  shortModelLabel,
  formatUsd,
  summarizeExternalSpend,
  formatExternalSpendBlock,
  normalizeSpendLogRows,
  resolveLitellmBaseUrl,
  resolveLitellmAdminKey,
  fetchExternalSpendSummary,
  clearExternalSpendCache,
  vaultKeyFromRef,
  addUtcDays,
  utcDateString,
  type LiteLLMDaySpendRow,
} from '../external-spend.js';

const NOW = new Date('2026-07-19T15:30:00.000Z'); // UTC today = 2026-07-19

beforeEach(() => {
  clearExternalSpendCache();
});

describe('isExternalModel', () => {
  it('includes openrouter/ and sr- models', () => {
    expect(isExternalModel('openrouter/openai/gpt-oss-20b')).toBe(true);
    expect(isExternalModel('sr-grok-4.5')).toBe(true);
    expect(isExternalModel('SR-GLM-5')).toBe(true);
  });

  it('includes bare cash-model needles', () => {
    expect(isExternalModel('gpt-oss-20b')).toBe(true);
    expect(isExternalModel('x-ai/grok-4.5')).toBe(true);
    expect(isExternalModel('gemini-3.1-flash-lite')).toBe(true);
    expect(isExternalModel('deepseek-r1')).toBe(true);
    expect(isExternalModel('moonshot/kimi-k2')).toBe(true);
    expect(isExternalModel('glm-5.2')).toBe(true);
    expect(isExternalModel('qwen3-coder')).toBe(true);
    expect(isExternalModel('meta-llama/llama-3.1')).toBe(true);
  });

  it('excludes Claude / Anthropic subscription passthrough', () => {
    expect(isExternalModel('claude-sonnet-4-20250514')).toBe(false);
    expect(isExternalModel('claude-opus-4-5')).toBe(false);
    expect(isExternalModel('anthropic/claude-sonnet-4')).toBe(false);
    expect(isExternalModel('openrouter/anthropic/claude-3.5-sonnet')).toBe(false);
  });

  it('rejects empty / unknown non-cash names', () => {
    expect(isExternalModel('')).toBe(false);
    expect(isExternalModel('some-internal-router')).toBe(false);
  });
});

describe('shortModelLabel', () => {
  it('strips openrouter/ and org path to last segment', () => {
    expect(shortModelLabel('openrouter/openai/gpt-oss-20b')).toBe('gpt-oss-20b');
    expect(shortModelLabel('openrouter/x-ai/grok-4.5')).toBe('grok-4.5');
    expect(shortModelLabel('openai/gpt-oss-20b')).toBe('gpt-oss-20b');
  });

  it('strips sr- prefix', () => {
    expect(shortModelLabel('sr-grok-4.5')).toBe('grok-4.5');
    expect(shortModelLabel('sr-gemini-2.5-flash')).toBe('gemini-2.5-flash');
  });
});

describe('formatUsd', () => {
  it('always formats two decimal places', () => {
    expect(formatUsd(8.07)).toBe('$8.07');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.004)).toBe('$0.00');
    expect(formatUsd(119.894)).toBe('$119.89');
  });

  it('guards non-finite / negative', () => {
    expect(formatUsd(Number.NaN)).toBe('$0.00');
    expect(formatUsd(-3)).toBe('$0.00');
  });
});

describe('summarizeExternalSpend', () => {
  const rows: LiteLLMDaySpendRow[] = [
    {
      startTime: '2026-07-19',
      spend: 50, // mixed — must be ignored
      models: {
        'claude-sonnet-4-20250514': 40,
        'openrouter/openai/gpt-oss-20b': 6.1,
        'sr-grok-4.5': 1.18,
        'gemini-3.1-flash-lite': 0.79,
      },
    },
    {
      startTime: '2026-07-18',
      models: {
        'openrouter/openai/gpt-oss-20b': 10,
        'claude-opus-4': 5,
      },
    },
    {
      startTime: '2026-07-12', // outside 7d (today-6 = 2026-07-13)
      models: { 'openrouter/openai/gpt-oss-20b': 100 },
    },
    {
      startTime: '2026-07-13', // edge of window
      models: { 'sr-deepseek-r1': 2 },
    },
  ];

  it('sums 24h (UTC today) and 7d external only — ignores day.spend and Claude', () => {
    const s = summarizeExternalSpend(rows, NOW);
    // 24h: 6.1 + 1.18 + 0.79
    expect(s.day24hUsd).toBeCloseTo(8.07, 5);
    // 7d: today + 18th (10) + 13th (2) = 8.07 + 10 + 2
    expect(s.day7dUsd).toBeCloseTo(20.07, 5);
  });

  it('top-3 by 7d external spend with short labels', () => {
    const s = summarizeExternalSpend(rows, NOW);
    expect(s.top.map((t) => t.label)).toEqual([
      'gpt-oss-20b',
      'deepseek-r1',
      'grok-4.5',
    ]);
    expect(s.top[0]!.usd).toBeCloseTo(16.1, 5); // 6.1 + 10
    expect(s.top[1]!.usd).toBeCloseTo(2, 5);
    expect(s.top[2]!.usd).toBeCloseTo(1.18, 5);
  });

  it('returns zeros when no external spend', () => {
    const s = summarizeExternalSpend(
      [{ startTime: '2026-07-19', models: { 'claude-sonnet-4': 9 } }],
      NOW,
    );
    expect(s).toEqual({ day24hUsd: 0, day7dUsd: 0, top: [] });
  });

  it('excludes future/out-of-window days', () => {
    const s = summarizeExternalSpend(
      [{ startTime: '2026-07-20', models: { 'sr-grok-4.5': 9 } }],
      NOW,
    );
    expect(s.day7dUsd).toBe(0);
  });
});

describe('formatExternalSpendBlock', () => {
  it('renders locked layout B', () => {
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

  it('omits top line when empty but still shows totals (incl. zeros)', () => {
    expect(formatExternalSpendBlock({ day24hUsd: 0, day7dUsd: 0, top: [] })).toEqual([
      '- 💸 External',
      '- 24h `$0.00` · 7d `$0.00`',
    ]);
  });

  it('returns [] for null/undefined (omit block)', () => {
    expect(formatExternalSpendBlock(null)).toEqual([]);
    expect(formatExternalSpendBlock(undefined)).toEqual([]);
  });
});

describe('normalizeSpendLogRows / base url / vault ref', () => {
  it('accepts bare array and {data:[]}', () => {
    expect(normalizeSpendLogRows([{ startTime: '2026-07-19' }])).toHaveLength(1);
    expect(normalizeSpendLogRows({ data: [{ startTime: 'x' }] })).toHaveLength(1);
    expect(normalizeSpendLogRows({ oops: true })).toEqual([]);
  });

  it('trims trailing slash on base URL', () => {
    expect(resolveLitellmBaseUrl({ SWITCHROOM_LITELLM_BASE: 'http://h:4010/' })).toBe(
      'http://h:4010',
    );
    expect(resolveLitellmBaseUrl({})).toBe('http://127.0.0.1:4010');
  });

  it('parses vault: refs', () => {
    expect(vaultKeyFromRef('vault:litellm/master-key')).toBe('litellm/master-key');
    expect(vaultKeyFromRef('plain')).toBeNull();
  });

  it('utc window helpers', () => {
    expect(utcDateString(NOW)).toBe('2026-07-19');
    expect(addUtcDays('2026-07-19', -6)).toBe('2026-07-13');
    expect(addUtcDays('2026-07-19', 1)).toBe('2026-07-20');
  });
});

describe('resolveLitellmAdminKey', () => {
  const savedAdmin = process.env.SWITCHROOM_LITELLM_ADMIN_KEY;
  const savedMaster = process.env.LITELLM_MASTER_KEY;

  afterEach(() => {
    if (savedAdmin === undefined) delete process.env.SWITCHROOM_LITELLM_ADMIN_KEY;
    else process.env.SWITCHROOM_LITELLM_ADMIN_KEY = savedAdmin;
    if (savedMaster === undefined) delete process.env.LITELLM_MASTER_KEY;
    else process.env.LITELLM_MASTER_KEY = savedMaster;
  });

  it('prefers SWITCHROOM_LITELLM_ADMIN_KEY env', async () => {
    const key = await resolveLitellmAdminKey({
      env: { SWITCHROOM_LITELLM_ADMIN_KEY: ' sk-from-env ' },
      readAdminKeyRef: () => 'vault:litellm/master-key',
      vaultGet: async () => 'sk-vault',
    });
    expect(key).toBe('sk-from-env');
  });

  it('falls back to vault when env unset', async () => {
    const vaultGet = vi.fn(async () => 'sk-vault-value');
    const key = await resolveLitellmAdminKey({
      env: {},
      readAdminKeyRef: () => 'vault:litellm/master-key',
      vaultGet,
    });
    expect(key).toBe('sk-vault-value');
    expect(vaultGet).toHaveBeenCalledWith('litellm/master-key');
  });

  it('soft-fails when vault denies', async () => {
    const key = await resolveLitellmAdminKey({
      env: {},
      readAdminKeyRef: () => 'vault:litellm/master-key',
      vaultGet: async () => null,
    });
    expect(key).toBeNull();
  });
});

describe('fetchExternalSpendSummary', () => {
  it('returns null without admin key', async () => {
    const summary = await fetchExternalSpendSummary({
      now: NOW,
      resolveAdminKey: async () => null,
      bypassCache: true,
    });
    expect(summary).toBeNull();
  });

  it('returns null on non-OK response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    const summary = await fetchExternalSpendSummary({
      now: NOW,
      resolveAdminKey: async () => 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      bypassCache: true,
    });
    expect(summary).toBeNull();
  });

  it('aggregates successful spend/logs body and caches', async () => {
    const body = [
      {
        startTime: '2026-07-19',
        models: {
          'openrouter/openai/gpt-oss-20b': 1.5,
          'claude-sonnet-4': 9,
        },
      },
    ];
    let calls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      calls += 1;
      expect(String(url)).toContain('start_date=2026-07-13');
      expect(String(url)).toContain('end_date=2026-07-20');
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const first = await fetchExternalSpendSummary({
      now: NOW,
      resolveAdminKey: async () => 'sk-test',
      resolveBaseUrl: () => 'http://litellm.test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      bypassCache: true,
    });
    expect(first?.day24hUsd).toBeCloseTo(1.5, 5);
    expect(first?.top[0]?.label).toBe('gpt-oss-20b');

    // Second call should hit cache (no bypass) with zero additional fetches.
    const second = await fetchExternalSpendSummary({
      now: NOW,
      resolveAdminKey: async () => 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(second?.day24hUsd).toBeCloseTo(1.5, 5);
    expect(calls).toBe(1);
  });

  it('returns null on timeout/abort', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });
    const summary = await fetchExternalSpendSummary({
      now: NOW,
      resolveAdminKey: async () => 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 20,
      bypassCache: true,
    });
    expect(summary).toBeNull();
  });
});
