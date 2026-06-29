/**
 * Integration test for the Format 2 wiring through `renderShowText` +
 * `handleAuthCommand`. The pure formatter has dedicated tests in
 * auth-snapshot-format.test.ts; here we cover the seam between the
 * legacy ASCII-table path and the new health-grouped path.
 *
 * Headline guarantees:
 *
 *   1. With no liveQuotas, renderShowText produces the legacy ASCII
 *      table shape (back-compat preserved).
 *   2. With liveQuotas matching state.accounts.length, renderShowText
 *      produces the Format 2 health-grouped shape (Recommendation
 *      footer present, ASCII column header absent).
 *   3. handleAuthCommand attaches a keyboard ONLY when liveQuotas is
 *      supplied AND yields one quota per account (no half-rendered
 *      buttons under partial-failure).
 *   4. The keyboard emitted by handleAuthCommand never references a
 *      blocked or unknown-health account in a switch button (smart-
 *      hide rule, integration variant of the unit test in
 *      auth-snapshot-format.test.ts).
 */
import { describe, it, expect, vi } from 'vitest';
import { __resetDemoMaskCachesForTest } from '../demo-mask.js';
import { renderShowText, handleAuthCommand } from '../gateway/auth-command.js';
import type { AuthBrokerClient, AuthCommandContext } from '../gateway/auth-command.js';
import type { ListStateData } from '../../src/auth/broker/client.js';
import type { QuotaResult, QuotaUtilization } from '../quota-check.js';

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

function qOk(part: Partial<QuotaUtilization>): QuotaResult {
  return { ok: true, data: quota(part) };
}

const NOW_MS = new Date('2026-05-15T00:53:00Z').getTime();

const FIXTURE_STATE: ListStateData = {
  active: 'you@x',
  fallback_order: ['ken@x', 'me@x', 'you@x'],
  accounts: [
    { label: 'ken@x', exhausted: false },
    { label: 'me@x', exhausted: false },
    { label: 'you@x', exhausted: false },
  ],
  agents: [{ name: 'carrie', account: 'you@x', override: null }],
  consumers: [],
};

const FIXTURE_QUOTAS: QuotaResult[] = [
  qOk({ fiveHourUtilizationPct: 0, sevenDayUtilizationPct: 23 }),
  qOk({ sevenDayUtilizationPct: 100 }), // blocked
  qOk({ fiveHourUtilizationPct: 8, sevenDayUtilizationPct: 20 }),
];

function mockClient(over: Partial<AuthBrokerClient> = {}): AuthBrokerClient {
  return {
    listState: vi.fn(async () => FIXTURE_STATE),
    setActive: vi.fn(async (label: string) => ({ active: label, fanned: ['carrie'] })),
    rmAccount: vi.fn(async (label: string) => ({ label })),
    refreshAccount: vi.fn(async (label: string) => ({ account: label })),
    setOverride: vi.fn(async (agent: string, account: string | null) => ({ agent, account })),
    ...over,
  };
}

describe('renderShowText — Format 2 vs legacy', () => {
  it('falls back to legacy ASCII table when no liveQuotas given', () => {
    const out = renderShowText(FIXTURE_STATE, NOW_MS);
    expect(out).toContain('**Auth — fleet snapshot**');
    expect(out).toContain('ACCOUNT');
    expect(out).toContain('STATUS');
    expect(out).toContain('EXPIRES');
    expect(out).not.toContain('🔋');
    expect(out).not.toContain('Recommendation:');
  });

  it('renders Format 2 when liveQuotas length matches accounts length', () => {
    const out = renderShowText(FIXTURE_STATE, NOW_MS, {
      liveQuotas: FIXTURE_QUOTAS,
      tz: 'UTC',
      liveProbedAtMs: NOW_MS,
    });
    expect(out).toContain('🔋 **Auth — fleet status**');
    expect(out).toContain('Recommendation:');
    expect(out).toContain('🔴 **BLOCKED**');
    expect(out).toContain('🟢 **HEALTHY**');
    // Legacy ASCII column headers should be absent
    expect(out).not.toContain('ACCOUNT     STATUS');
  });

  it('falls back to legacy when liveQuotas length disagrees with accounts (defensive)', () => {
    const out = renderShowText(FIXTURE_STATE, NOW_MS, {
      liveQuotas: FIXTURE_QUOTAS.slice(0, 2), // wrong length
    });
    expect(out).not.toContain('🔋');
    expect(out).toContain('ACCOUNT');
  });

  // demo mode (the `/auth demo` suffix) — masks email labels in BOTH shapes.
  describe('demo mode masks account-email labels', () => {
    it('WITHOUT demo, the real labels render (Format 2)', () => {
      const out = renderShowText(FIXTURE_STATE, NOW_MS, { liveQuotas: FIXTURE_QUOTAS, tz: 'UTC' });
      expect(out).toContain('ken@x');
      expect(out).toContain('you@x');
    });
    it('WITH demo, no real label leaks (Format 2)', () => {
      __resetDemoMaskCachesForTest();
      const out = renderShowText(FIXTURE_STATE, NOW_MS, { liveQuotas: FIXTURE_QUOTAS, tz: 'UTC', demo: true });
      expect(out).not.toContain('ken@x');
      expect(out).not.toContain('me@x');
      expect(out).not.toContain('you@x');
      expect(out).toMatch(/@example\.com/);
    });
    it('WITH demo, the legacy ASCII table also masks labels', () => {
      __resetDemoMaskCachesForTest();
      const out = renderShowText(FIXTURE_STATE, NOW_MS, { demo: true });
      expect(out).toContain('ACCOUNT'); // still the legacy table
      expect(out).not.toContain('ken@x');
      expect(out).not.toContain('you@x');
      expect(out).toMatch(/@example\.com/);
    });
  });
});

describe('handleAuthCommand — keyboard attachment', () => {
  function makeCtx(overrides: Partial<AuthCommandContext> = {}): AuthCommandContext {
    return {
      agentName: 'carrie',
      isAdmin: true,
      client: mockClient(),
      chatId: 'chat-1',
      ...overrides,
    };
  }

  it('attaches NO keyboard when liveQuotas is omitted (legacy callers)', async () => {
    const reply = await handleAuthCommand({ kind: 'show' }, makeCtx());
    expect(reply.keyboard).toBeUndefined();
    expect(reply.text).toContain('ACCOUNT'); // legacy table
  });

  it('attaches a smart keyboard when liveQuotas yields one result per account', async () => {
    const reply = await handleAuthCommand(
      { kind: 'show' },
      // #2495 Change 2 — the enricher now returns { quotas, staleCachedAtMs? }.
      makeCtx({ liveQuotas: async () => ({ quotas: FIXTURE_QUOTAS }), tz: 'UTC' }),
    );
    expect(reply.keyboard).toBeDefined();
    const allButtonText = reply.keyboard!.flat().map((b) => b.text);
    // Switch button should exist for ken@x (healthy, not active)
    expect(allButtonText).toContain('Switch fleet → ken@x');
    // me@x is blocked — must NOT appear as a switch target
    expect(allButtonText).not.toContain('Switch fleet → me@x');
    // Bottom row hardware
    expect(allButtonText).toContain('↻ Refresh');
    expect(allButtonText).toContain('/usage');
    expect(allButtonText).toContain('+ Add');
  });

  it('attaches no keyboard when the live probe throws (graceful degrade)', async () => {
    const reply = await handleAuthCommand(
      { kind: 'show' },
      makeCtx({
        liveQuotas: async () => {
          throw new Error('network down');
        },
      }),
    );
    expect(reply.keyboard).toBeUndefined();
    expect(reply.text).toContain('ACCOUNT'); // legacy table fallback
  });

  it('#2495 Change 2 — stamps "⚠ cached Nm ago" when the enricher reports a cache fallback', async () => {
    const reply = await handleAuthCommand(
      { kind: 'show' },
      makeCtx({
        liveQuotas: async () => ({
          quotas: FIXTURE_QUOTAS,
          staleCachedAtMs: Date.now() - 5 * 60_000, // 5 min old cache
        }),
        tz: 'UTC',
      }),
    );
    expect(reply.text).toContain('⚠ cached');
    expect(reply.text).not.toContain('Live · refreshed');
  });

  it('#2495 Change 2 — stamps a live refresh when the enricher reports no cache fallback', async () => {
    const reply = await handleAuthCommand(
      { kind: 'show' },
      makeCtx({ liveQuotas: async () => ({ quotas: FIXTURE_QUOTAS }), tz: 'UTC' }),
    );
    expect(reply.text).toContain('Live · refreshed');
    expect(reply.text).not.toContain('⚠ cached');
  });

  it('ctx.demo masks the account labels in the dashboard reply', async () => {
    __resetDemoMaskCachesForTest();
    const reply = await handleAuthCommand(
      { kind: 'show' },
      makeCtx({ liveQuotas: async () => ({ quotas: FIXTURE_QUOTAS }), tz: 'UTC', demo: true }),
    );
    expect(reply.text).not.toContain('ken@x');
    expect(reply.text).not.toContain('you@x');
    expect(reply.text).toMatch(/@example\.com/);
  });

  it('WITHOUT ctx.demo the real labels still render in the dashboard reply', async () => {
    const reply = await handleAuthCommand(
      { kind: 'show' },
      makeCtx({ liveQuotas: async () => ({ quotas: FIXTURE_QUOTAS }), tz: 'UTC' }),
    );
    expect(reply.text).toContain('you@x');
  });
});
