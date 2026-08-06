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
      expect(out.announcement).toContain('Triggered by: agent **carrie**');
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
      // Bug 3 — the announcement enumerates EVERY account, not just the trigger.
      expect(out.announcement).toContain('ken@x');
      expect(out.announcement).toContain('me@x');
    }
  });

  it('parsedResetAt (429 throttle tier) names the recovery when the old probe carried no reset', async () => {
    const failover = vi.fn(async () => ({ rolledTo: 'you@x', rolled: ['ken@x'] }));
    const out = await runFleetAutoFallback({
      state: state('ken@x', ['ken@x', 'you@x']),
      quotas: [
        // ken: walled, but the probe carried NO reset time — pre-fix the
        // announcement's recovery line was silently dropped.
        qOk({ fiveHourUtilizationPct: 100, representativeClaim: 'five_hour' }),
        qOk({ fiveHourUtilizationPct: 8, sevenDayUtilizationPct: 20 }),
      ],
      failover,
      triggerAgent: 'carrie',
      now: NOW,
      tz: 'UTC',
      // Parsed from the error prose ("resets 5:50am") by the gateway.
      parsedResetAt: new Date('2026-05-15T05:50:00Z'),
    });

    expect(out.kind).toBe('switched');
    if (out.kind === 'switched') {
      expect(out.announcement).toContain('recovers');
      expect(out.announcement).toContain('in 4h 57m');
    }
  });

  it('rateLimitTrigger: swaps even when the old account probes HEALTHY (the >threshold leg must execute)', async () => {
    // A terminal transient 429 NEGATES the usage-limit reading, so healthy
    // utilization is the EXPECTED state for the rate-limited account. The
    // healthy-idempotency guard must not self-cancel this swap into a
    // "probed healthy / Stale event?" no-op.
    const failover = vi.fn(async () => ({ rolledTo: 'you@x', rolled: ['ken@x'] }));
    const out = await runFleetAutoFallback({
      state: state('ken@x', ['ken@x', 'you@x']),
      quotas: [
        qOk({ fiveHourUtilizationPct: 12, sevenDayUtilizationPct: 30 }), // healthy!
        qOk({ fiveHourUtilizationPct: 8, sevenDayUtilizationPct: 20 }),
      ],
      failover,
      triggerAgent: 'carrie',
      now: NOW,
      tz: 'UTC',
      parsedResetAt: new Date('2026-05-15T02:53:00Z'),
      rateLimitTrigger: true,
    });

    expect(out.kind).toBe('switched');
    expect(failover).toHaveBeenCalledTimes(1);
    if (out.kind === 'switched') {
      // Honest headline: a rate limit, not a utilization-derived window cap.
      expect(out.announcement).toContain('rate limit on ken@x');
      expect(out.announcement).not.toContain('5-hour limit');
      // Recovery line carries the parsed reset (no window was maxed).
      expect(out.announcement).toContain('recovers');
      expect(out.announcement).toContain('in 2h');
    }
  });

  it('rateLimitTrigger stays subject to the broker outcome (all-blocked passes through)', async () => {
    const failover = vi.fn(async () => ({ rolledTo: null, rolled: [] }));
    const out = await runFleetAutoFallback({
      state: state('ken@x', ['ken@x']),
      quotas: [qOk({ fiveHourUtilizationPct: 12, sevenDayUtilizationPct: 30 })],
      failover,
      triggerAgent: 'carrie',
      now: NOW,
      tz: 'UTC',
      rateLimitTrigger: true,
    });
    expect(out.kind).toBe('all-blocked');
    expect(failover).toHaveBeenCalledTimes(1);
  });

  it('strict-pinned caller: null rolledTo yields the strict-pinned outcome, NOT all-blocked', async () => {
    // agents.<name>.auth.strict — the broker marked the account but
    // deliberately did not roll the caller. The all-blocked card here would
    // claim fleet-wide exhaustion while its own snapshots show healthy
    // accounts.
    const failover = vi.fn(async () => ({
      rolledTo: null, rolled: [], callerPinnedStrict: true,
    }));
    const out = await runFleetAutoFallback({
      state: state('work@x', ['work@x']),
      quotas: [qOk({ fiveHourUtilizationPct: 12, sevenDayUtilizationPct: 30 })],
      failover,
      triggerAgent: 'workbot',
      now: NOW,
      tz: 'UTC',
      rateLimitTrigger: true,
    });
    expect(out.kind).toBe('strict-pinned');
    expect(failover).toHaveBeenCalledTimes(1);
    expect(out.announcement).toContain('strictly pinned');
    expect(out.announcement).toContain('fleet is unaffected');
    expect(out.announcement).not.toContain('blocked');
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

  it('out_of_credits active account ⇒ NO swap (informational, not a serve-block)', async () => {
    // NEW CONTRACT (fix/out-of-credits-serve-block): out_of_credits is
    // INFORMATIONAL. An active account at 0% util with out_of_credits is
    // classified HEALTHY by classifyHealth(), so the idempotency guard fires
    // and the swap is skipped. out_of_credits must NEVER on its own cause a
    // fleet auto-fallback swap.
    const failover = vi.fn(async () => ({ rolledTo: 'bob@example.com', rolled: ['alice@example.com'] }));
    const out = await runFleetAutoFallback({
      state: state('alice@example.com', ['alice@example.com', 'bob@example.com']),
      quotas: [
        qOk({ fiveHourUtilizationPct: 0, sevenDayUtilizationPct: 0, overageStatus: 'rejected', overageDisabledReason: 'out_of_credits' }),
        qOk({ fiveHourUtilizationPct: 8, sevenDayUtilizationPct: 20 }),
      ],
      failover,
      triggerAgent: 'carrie',
      now: NOW,
      tz: 'UTC',
    });

    // out_of_credits at 0% util → classifyHealth='healthy' → idempotency guard
    // returns no-eligible-target WITHOUT calling failover.
    expect(out.kind).toBe('no-eligible-target');
    expect(failover).not.toHaveBeenCalled();
  });

  it('genuine quota wall (100% 5h util) ⇒ swap fires (failover safety preserved)', async () => {
    // Failover on a REAL quota wall must still work. This anchors the safety
    // contract: only out_of_credits is demoted, genuine exhaustion still swaps.
    const failover = vi.fn(async () => ({ rolledTo: 'bob@example.com', rolled: ['alice@example.com'] }));
    const out = await runFleetAutoFallback({
      state: state('alice@example.com', ['alice@example.com', 'bob@example.com']),
      quotas: [
        qOk({ fiveHourUtilizationPct: 100, fiveHourResetAt: new Date('2026-05-15T05:50:00Z'), representativeClaim: 'five_hour' }),
        qOk({ fiveHourUtilizationPct: 8, sevenDayUtilizationPct: 20 }),
      ],
      failover,
      triggerAgent: 'carrie',
      now: NOW,
      tz: 'UTC',
    });

    expect(out.kind).toBe('switched');
    expect(failover).toHaveBeenCalledTimes(1);
    if (out.kind === 'switched') expect(out.newLabel).toBe('bob@example.com');
  });

  it('org_level_disabled active @75% ⇒ NO swap (idempotency: classifyHealth=healthy)', async () => {
    // The benign reason on the live active account must NOT trigger a swap.
    const failover = vi.fn();
    const out = await runFleetAutoFallback({
      state: state('alice@example.com', ['alice@example.com', 'bob@example.com']),
      quotas: [
        qOk({ fiveHourUtilizationPct: 75, sevenDayUtilizationPct: 40, overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled' }),
        qOk({ fiveHourUtilizationPct: 5, sevenDayUtilizationPct: 10 }),
      ],
      failover,
      triggerAgent: 'carrie',
      now: NOW,
      tz: 'UTC',
    });

    expect(out.kind).toBe('no-eligible-target');
    expect(failover).not.toHaveBeenCalled();
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

// ── failure notice (broken-promise fix, 2026-06-09 incident follow-up) ──────

import { renderFallbackFailureNotice } from "../auto-fallback-fleet.js";

describe("renderFallbackFailureNotice", () => {
  it("names the trigger agent, the reason, and the manual recovery verbs", () => {
    const out = renderFallbackFailureNotice("marko", "auth-broker unreachable (no client).");
    expect(out).toContain("Auto-failover could not run");
    expect(out).toContain("**marko**");
    expect(out).toContain("auth-broker unreachable");
    expect(out).toContain("/auth use");
    expect(out).toContain("`/auth`");
  });

  it("passes < > & literally in the error reason (markdown, #2669)", () => {
    // Broker errors can contain angle brackets — they are literal in rich
    // markdown and cannot inject formatting; emphasis specials are escaped.
    const out = renderFallbackFailureNotice("a<b", 'request <probe-quota> failed & a_b');
    expect(out).toContain("a<b");
    expect(out).toContain("<probe-quota>");
    expect(out).toContain("&");
    expect(out).toContain("a\\_b");
  });
});

// ── failure-notice cooldown (reviewer blocker: gate window never arms on
//    failure; quota_wall_detected re-fires ~60s → unbounded notice spam) ─────

import {
  evaluateFallbackFailureNotice,
  FALLBACK_FAILURE_NOTICE_COOLDOWN_MS,
} from "../auto-fallback-fleet.js";

describe("evaluateFallbackFailureNotice", () => {
  const T0 = 1_780_000_000_000;

  it("first failure always sends and arms the cooldown", () => {
    const r = evaluateFallbackFailureNotice({ lastSentAtMs: 0 }, T0);
    expect(r.send).toBe(true);
    expect(r.next.lastSentAtMs).toBe(T0);
  });

  it("a repeat failure inside the cooldown is suppressed and does NOT extend the window", () => {
    const armed = { lastSentAtMs: T0 };
    const r = evaluateFallbackFailureNotice(armed, T0 + 60_000);
    expect(r.send).toBe(false);
    expect(r.next).toBe(armed); // unchanged — window not extended by suppressed attempts
  });

  it("sends again once the cooldown elapses", () => {
    const r = evaluateFallbackFailureNotice(
      { lastSentAtMs: T0 },
      T0 + FALLBACK_FAILURE_NOTICE_COOLDOWN_MS,
    );
    expect(r.send).toBe(true);
    expect(r.next.lastSentAtMs).toBe(T0 + FALLBACK_FAILURE_NOTICE_COOLDOWN_MS);
  });

  it("bounds the 60s quota_wall_detected re-fire storm to ≤2 notices/hour", () => {
    // Simulate a wedged agent re-signalling every 60s for one hour with a
    // dead broker — the incident shape the reviewer flagged.
    let state = { lastSentAtMs: 0 };
    let sent = 0;
    for (let t = T0; t < T0 + 3_600_000; t += 60_000) {
      const r = evaluateFallbackFailureNotice(state, t);
      if (r.send) sent++;
      state = r.next;
    }
    expect(sent).toBeLessThanOrEqual(2);
    expect(sent).toBeGreaterThanOrEqual(1);
  });
});

// ── Bug 2: the all-blocked card must not re-emit every ~60s ───────────────────

import {
  evaluateAllBlockedNotice,
  FALLBACK_ALL_BLOCKED_NOTICE_COOLDOWN_MS,
} from "../auto-fallback-fleet.js";

describe("evaluateAllBlockedNotice", () => {
  const T0 = 1_780_000_000_000;

  it("the first all-blocked card sends and arms the cooldown", () => {
    const r = evaluateAllBlockedNotice({ lastSentAtMs: 0 }, T0);
    expect(r.send).toBe(true);
    expect(r.next.lastSentAtMs).toBe(T0);
  });

  it("a second all-blocked signal within the cooldown does NOT re-emit (the Bug-2 fix)", () => {
    const armed = { lastSentAtMs: T0 };
    const r = evaluateAllBlockedNotice(armed, T0 + 60_000);
    expect(r.send).toBe(false);
    expect(r.next).toBe(armed); // window not extended by suppressed attempts
  });

  it("sends again once the cooldown elapses (still-walled, but the user re-hears once)", () => {
    const r = evaluateAllBlockedNotice(
      { lastSentAtMs: T0 },
      T0 + FALLBACK_ALL_BLOCKED_NOTICE_COOLDOWN_MS,
    );
    expect(r.send).toBe(true);
    expect(r.next.lastSentAtMs).toBe(T0 + FALLBACK_ALL_BLOCKED_NOTICE_COOLDOWN_MS);
  });

  it("collapses the ~60s quota_wall_detected re-fire storm to ≤2 cards/hour", () => {
    let state = { lastSentAtMs: 0 };
    let sent = 0;
    for (let t = T0; t < T0 + 3_600_000; t += 60_000) {
      const r = evaluateAllBlockedNotice(state, t);
      if (r.send) sent++;
      state = r.next;
    }
    expect(sent).toBeLessThanOrEqual(2);
    expect(sent).toBeGreaterThanOrEqual(1);
  });

  it("a NEW transition emits promptly: reset (lastSentAtMs=0) after a swap sends immediately", () => {
    // The gateway resets the window on a successful swap, so a fresh all-blocked
    // after a recovery is not stale-suppressed.
    const r = evaluateAllBlockedNotice({ lastSentAtMs: 0 }, T0 + 5 * 60_000);
    expect(r.send).toBe(true);
  });
});
