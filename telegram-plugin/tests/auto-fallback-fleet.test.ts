/**
 * Tests for the fleet-wide auto-fallback planner. Pure-data —
 * no broker UDS, no Telegram bot.
 *
 * Contract change (fix/auto-fallback-non-admin): the swap now goes through
 * the broker's NON-ADMIN `mark-exhausted` verb via the injected `failover()`
 * dep, which returns the account the broker rolled TO (`rolledTo`). Target
 * SELECTION moved to the broker (`nextHealthyAccount`, fallback_order order —
 * what /auth rotate uses); this module no longer picks, it announces whatever
 * the broker rolled to. The old admin-gated `setActive` dep is gone — that
 * gate is exactly why a non-admin agent that 429'd could never self-heal.
 */
import { describe, it, expect, vi } from 'vitest';
import { runFleetAutoFallback } from '../auto-fallback-fleet.js';
import type { QuotaResult, QuotaUtilization } from '../quota-check.js';
import type { ListStateData } from '../../src/auth/broker/client.js';

const NOW = new Date('2026-05-15T00:53:00Z');

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

function state(active: string, accounts: string[]): ListStateData {
  return {
    active,
    fallback_order: accounts,
    accounts: accounts.map((label) => ({ label, exhausted: false })),
    agents: [],
    consumers: [],
  };
}

describe('runFleetAutoFallback', () => {
  it('swaps via the non-admin failover() and announces the broker’s rolledTo', async () => {
    // The broker (mark-exhausted → nextHealthyAccount) chose you@x.
    const failover = vi.fn(async () => ({ rolledTo: 'you@x', rolled: ['alice', 'bob'] }));
    const out = await runFleetAutoFallback({
      state: state('ken@x', ['ken@x', 'me@x', 'you@x']),
      quotas: [
        // ken: just blew 5h (the trigger)
        qOk({
          fiveHourUtilizationPct: 100,
          fiveHourResetAt: new Date('2026-05-15T05:50:00Z'),
          representativeClaim: 'five_hour',
        }),
        // me: dead on 7d
        qOk({
          sevenDayUtilizationPct: 100,
          sevenDayResetAt: new Date('2026-05-17T10:00:00Z'),
          representativeClaim: 'seven_day',
        }),
        // you: healthy — the rolled-to account, used for the headroom line
        qOk({ fiveHourUtilizationPct: 8, sevenDayUtilizationPct: 20 }),
      ],
      failover,
      triggerAgent: 'carrie',
      now: NOW,
      tz: 'UTC',
    });

    expect(out.kind).toBe('switched');
    expect(failover).toHaveBeenCalledTimes(1);
    if (out.kind === 'switched') {
      expect(out.oldLabel).toBe('ken@x');
      expect(out.newLabel).toBe('you@x');
      expect(out.announcement).toContain('5-hour limit on ken@x');
      expect(out.announcement).toContain('Triggered by: agent <b>carrie</b>');
      expect(out.announcement).toContain('plenty of headroom');
    }
  });

  it('returns all-blocked when the broker reports rolledTo=null (nowhere to roll)', async () => {
    const failover = vi.fn(async () => ({ rolledTo: null, rolled: [] }));
    const out = await runFleetAutoFallback({
      state: state('ken@x', ['ken@x', 'me@x']),
      quotas: [
        qOk({
          fiveHourUtilizationPct: 100,
          fiveHourResetAt: new Date('2026-05-15T05:50:00Z'),
          representativeClaim: 'five_hour',
        }),
        qOk({
          sevenDayUtilizationPct: 100,
          sevenDayResetAt: new Date('2026-05-17T10:00:00Z'),
          representativeClaim: 'seven_day',
        }),
      ],
      failover,
      triggerAgent: 'carrie',
      now: NOW,
      tz: 'UTC',
    });

    expect(out.kind).toBe('all-blocked');
    // failover IS called even on all-blocked — marking the active exhausted is
    // correct (consumers/telemetry); there was just nowhere to roll.
    expect(failover).toHaveBeenCalledTimes(1);
    if (out.kind === 'all-blocked') {
      expect(out.announcement).toContain('All accounts blocked');
      expect(out.announcement).toContain('/auth add');
    }
  });

  it('idempotency: skips the swap WITHOUT calling failover when active probes healthy', async () => {
    const failover = vi.fn();
    const out = await runFleetAutoFallback({
      state: state('ken@x', ['ken@x', 'you@x']),
      quotas: [
        qOk({ fiveHourUtilizationPct: 5, sevenDayUtilizationPct: 10 }),
        qOk({ fiveHourUtilizationPct: 5, sevenDayUtilizationPct: 10 }),
      ],
      failover,
      triggerAgent: 'carrie',
      now: NOW,
      tz: 'UTC',
    });

    expect(out.kind).toBe('no-eligible-target');
    expect(failover).not.toHaveBeenCalled();
    expect(out.announcement).toContain('skipped');
    expect(out.announcement).toContain('Stale event?');
  });

  it('returns no-old-active (no failover) when broker has no active account', async () => {
    const failover = vi.fn();
    const out = await runFleetAutoFallback({
      state: { active: '', fallback_order: [], accounts: [], agents: [], consumers: [] },
      quotas: [],
      failover,
      triggerAgent: 'carrie',
      now: NOW,
      tz: 'UTC',
    });

    expect(out.kind).toBe('no-old-active');
    expect(failover).not.toHaveBeenCalled();
  });

  it('announces even when the live probe of the active account failed (broker still rolled)', async () => {
    // Probe failure for the active account → oldQuota null, but the broker
    // (authoritative exhaustion state) still rolled. We must still announce.
    const failover = vi.fn(async () => ({ rolledTo: 'you@x', rolled: ['alice'] }));
    const out = await runFleetAutoFallback({
      state: state('ken@x', ['ken@x', 'you@x']),
      quotas: [
        { ok: false, reason: 'HTTP 401' }, // active probe failed → unknown health (not 'healthy', so we proceed)
        qOk({ fiveHourUtilizationPct: 5 }),
      ],
      failover,
      triggerAgent: 'carrie',
      now: NOW,
      tz: 'UTC',
    });

    expect(out.kind).toBe('switched');
    expect(failover).toHaveBeenCalledTimes(1);
    if (out.kind === 'switched') {
      expect(out.newLabel).toBe('you@x');
    }
  });
});
