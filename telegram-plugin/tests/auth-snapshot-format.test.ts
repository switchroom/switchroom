/**
 * Tests for auth-snapshot-format.ts — Format 2 + causal auto-fallback
 * announcement. Pure functions, fully covered by frozen-clock tests
 * with hand-crafted QuotaUtilization fixtures.
 */
import { describe, it, expect } from 'vitest';
import { __resetDemoMaskCachesForTest } from '../demo-mask.js';
import {
  classifyHealth,
  blockedReason,
  bindingWindow,
  formatRelative,
  formatAbsolute,
  formatStatusTime,
  fmtPct,
  recommendation,
  renderAuthSnapshotFormat2,
  renderFallbackAnnouncement,
  buildSnapshotKeyboard,
  buildSnapshotsFromState,
  zipProbeResults,
  buildSnapshotsFromCachedState,
  reviveLastQuota,
  THROTTLING_THRESHOLD_PCT,
  type AccountSnapshot,
} from '../auth-snapshot-format.js';
import type { QuotaUtilization } from '../quota-check.js';
import type { LastQuotaSnapshot, ListStateData } from '../../src/auth/broker/client.js';

// Frozen "now" for all reset-time math. Friday May 15 2026 10:53 AM Melbourne
// = 2026-05-15T00:53:00Z. Reset epochs in fixtures are in seconds.
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

function snap(part: Partial<AccountSnapshot>): AccountSnapshot {
  return {
    label: 'unset@example.com',
    isActive: false,
    quota: null,
    ...part,
  };
}

// ── classifyHealth ───────────────────────────────────────────────────

describe('classifyHealth', () => {
  it('returns healthy for low utilization on both windows', () => {
    expect(classifyHealth(snap({ quota: quota({ fiveHourUtilizationPct: 8, sevenDayUtilizationPct: 20 }) }))).toBe('healthy');
  });
  it('returns throttling when either window crosses the 80% threshold', () => {
    expect(classifyHealth(snap({ quota: quota({ fiveHourUtilizationPct: 85, sevenDayUtilizationPct: 20 }) }))).toBe('throttling');
    expect(classifyHealth(snap({ quota: quota({ fiveHourUtilizationPct: 5, sevenDayUtilizationPct: 95 }) }))).toBe('throttling');
  });
  it('returns blocked at 99.5%+ utilization on either window', () => {
    expect(classifyHealth(snap({ quota: quota({ fiveHourUtilizationPct: 100, sevenDayUtilizationPct: 0 }) }))).toBe('blocked');
    expect(classifyHealth(snap({ quota: quota({ fiveHourUtilizationPct: 0, sevenDayUtilizationPct: 100 }) }))).toBe('blocked');
    expect(classifyHealth(snap({ quota: quota({ fiveHourUtilizationPct: 99.6, sevenDayUtilizationPct: 0 }) }))).toBe('blocked');
  });
  it('returns unknown when quota probe failed', () => {
    expect(classifyHealth(snap({ quota: null, quotaError: 'HTTP 401' }))).toBe('unknown');
  });
  it('out_of_credits overage at 0% util → healthy (demoted to informational — serves fine from quota)', () => {
    // THE KEY CHANGE: out_of_credits is no longer serve-blocking. An account at
    // 0% util with out_of_credits is a valid failover target (carol scenario).
    expect(
      classifyHealth(snap({ quota: quota({ fiveHourUtilizationPct: 0, sevenDayUtilizationPct: 0, overageStatus: 'rejected', overageDisabledReason: 'out_of_credits' }) })),
    ).toBe('healthy');
  });
  it('org_level_disabled at 75% util → unchanged/healthy (MANDATORY non-regression: live active account)', () => {
    // overageStatus:"rejected" + the benign reason must NOT flip it to blocked.
    expect(
      classifyHealth(snap({ quota: quota({ fiveHourUtilizationPct: 75, sevenDayUtilizationPct: 40, overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled' }) })),
    ).toBe('healthy');
  });
  it('unknown overage reason (payment_failed) at 0% util → healthy (deny-by-omission)', () => {
    expect(
      classifyHealth(snap({ quota: quota({ fiveHourUtilizationPct: 0, sevenDayUtilizationPct: 0, overageDisabledReason: 'payment_failed' }) })),
    ).toBe('healthy');
  });
  it('THROTTLING_THRESHOLD_PCT is 80 (regression — design choice, see jtbd)', () => {
    // If this number changes, the recommendation footer + button visibility
    // shift; bump it deliberately.
    expect(THROTTLING_THRESHOLD_PCT).toBe(80);
  });
});

// ── bindingWindow ────────────────────────────────────────────────────

describe('bindingWindow', () => {
  it('respects representative_claim when present (server-authoritative)', () => {
    expect(bindingWindow(quota({ representativeClaim: 'five_hour', fiveHourUtilizationPct: 10, sevenDayUtilizationPct: 90 }))).toBe('5h');
    expect(bindingWindow(quota({ representativeClaim: 'seven_day', fiveHourUtilizationPct: 90, sevenDayUtilizationPct: 10 }))).toBe('7d');
  });
  it('falls back to higher window when no claim is present', () => {
    expect(bindingWindow(quota({ fiveHourUtilizationPct: 10, sevenDayUtilizationPct: 90 }))).toBe('7d');
    expect(bindingWindow(quota({ fiveHourUtilizationPct: 90, sevenDayUtilizationPct: 10 }))).toBe('5h');
  });
});

// ── formatRelative ───────────────────────────────────────────────────

describe('formatRelative', () => {
  it('renders sub-hour countdowns in minutes', () => {
    expect(formatRelative(new Date('2026-05-15T01:00:00Z'), NOW)).toBe('7m');
  });
  it('renders sub-day countdowns in h+m', () => {
    expect(formatRelative(new Date('2026-05-15T05:50:00Z'), NOW)).toBe('4h 57m');
  });
  it('renders multi-day countdowns in d+h', () => {
    expect(formatRelative(new Date('2026-05-17T10:00:00Z'), NOW)).toBe('2d 9h');
  });
  it('returns "—" for null and "now" for past targets', () => {
    expect(formatRelative(null, NOW)).toBe('—');
    expect(formatRelative(new Date('2026-05-14T00:00:00Z'), NOW)).toBe('now');
  });
});

// ── fmtPct ───────────────────────────────────────────────────────────

describe('fmtPct', () => {
  it('rounds to nearest integer percent', () => {
    expect(fmtPct(8.4)).toBe('8%');
    expect(fmtPct(8.6)).toBe('9%');
    expect(fmtPct(99.6)).toBe('100%');
  });
  it('CLAMPS the displayed value to 100% — never shows over 100 (trust)', () => {
    // Anthropic returns a decimal that can exceed 1.0; quota-check multiplies by
    // 100 → e.g. 1.01 → 101. The displayed number must clamp to 100%.
    expect(fmtPct(101)).toBe('100%');
    expect(fmtPct(100.4)).toBe('100%');
    expect(fmtPct(250)).toBe('100%');
    expect(fmtPct(1.01 * 100)).toBe('100%');
  });
});

// ── formatAbsolute ───────────────────────────────────────────────────

describe('formatAbsolute', () => {
  it('renders weekday + hour + minute in the given timezone', () => {
    const out = formatAbsolute(new Date('2026-05-15T05:50:00Z'), 'Australia/Melbourne');
    // Just sanity-check the contract: weekday name, hour:minute, AM/PM
    expect(out).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\b/);
    expect(out).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/);
  });
  it('returns "—" for null', () => {
    expect(formatAbsolute(null, 'UTC')).toBe('—');
  });
});

// ── formatStatusTime (date shown only when NOT today, in user tz) ─────
describe('formatStatusTime', () => {
  // Fixed injected now + fixed tz → fully deterministic (no wall-clock).
  // 2026-05-15T05:00:00Z = Fri 15 May 3:00 PM in Australia/Melbourne (AEST,
  // UTC+10). May is winter there → AEST, not AEDT — the tz database handles it.
  const MEL = 'Australia/Melbourne';
  const NOW_MEL = new Date('2026-05-15T05:00:00Z'); // Fri 3:00 PM Melbourne

  it('shows TIME ONLY when the target is the same calendar day (user tz)', () => {
    // 2026-05-15T13:00:00Z = Fri 11:00 PM Melbourne — same Melbourne day as now.
    const out = formatStatusTime(new Date('2026-05-15T13:00:00Z'), NOW_MEL, MEL);
    expect(out).toBe('11:00 PM');
    // No weekday/date leaks on a same-day target.
    expect(out).not.toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
  });

  it('includes the WEEKDAY when the target is a different day (within the week)', () => {
    // 2026-05-15T15:00:00Z = Sat 16 May 1:00 AM Melbourne — next Melbourne day.
    const out = formatStatusTime(new Date('2026-05-15T15:00:00Z'), NOW_MEL, MEL);
    expect(out).toBe('Sat 1:00 AM');
    expect(out).toMatch(/^Sat\b/);
  });

  it('includes day-of-month + month when the target is beyond the current week', () => {
    // ~9 days out: 2026-05-24T01:00:00Z = Sun 24 May 11:00 AM Melbourne.
    const out = formatStatusTime(new Date('2026-05-24T01:00:00Z'), NOW_MEL, MEL);
    // Intl en-US renders the weekday+day+month as "Sun, May 24".
    expect(out).toBe('Sun, May 24 11:00 AM');
    expect(out).toMatch(/^Sun\b/);
    expect(out).toContain('May 24');
  });

  it('is tz-correct — same instant renders differently in UTC vs Melbourne', () => {
    const instant = new Date('2026-05-15T15:00:00Z');
    // In UTC that instant is still Fri 15 May 3:00 PM → same day as NOW_MEL's UTC
    // wall date — but NOW in UTC terms is also 2026-05-15, so time-only.
    expect(formatStatusTime(instant, NOW_MEL, 'UTC')).toBe('3:00 PM');
    // In Melbourne it has crossed midnight into Saturday.
    expect(formatStatusTime(instant, NOW_MEL, MEL)).toBe('Sat 1:00 AM');
  });

  it('returns "—" for a null target', () => {
    expect(formatStatusTime(null, NOW_MEL, MEL)).toBe('—');
  });
});

// ── renderAuthSnapshotFormat2 ────────────────────────────────────────

describe('renderAuthSnapshotFormat2', () => {
  // Matches the live snapshot we proved against claude.ai for the user's
  // own three accounts (15 May 2026, 10:53 AM Mel) — this is the gold
  // fixture. If the formatter changes shape, update these expectations.
  const fixtureSnaps: AccountSnapshot[] = [
    snap({
      label: 'alice@example.com',
      isActive: false,
      quota: quota({
        fiveHourUtilizationPct: 0,
        sevenDayUtilizationPct: 23,
        fiveHourResetAt: new Date('2026-05-15T05:50:00Z'),
        sevenDayResetAt: new Date('2026-05-18T19:00:00Z'),
        representativeClaim: 'five_hour',
      }),
    }),
    snap({
      label: 'bob@example.com',
      isActive: false,
      quota: quota({
        fiveHourUtilizationPct: 0,
        sevenDayUtilizationPct: 100,
        fiveHourResetAt: new Date('2026-05-15T00:50:00Z'),
        sevenDayResetAt: new Date('2026-05-17T10:00:00Z'),
        representativeClaim: 'seven_day',
      }),
    }),
    snap({
      label: 'you@example.com',
      isActive: true,
      quota: quota({
        fiveHourUtilizationPct: 8,
        sevenDayUtilizationPct: 20,
        fiveHourResetAt: new Date('2026-05-15T01:00:00Z'),
        sevenDayResetAt: new Date('2026-05-17T01:00:00Z'),
        representativeClaim: 'five_hour',
      }),
    }),
  ];

  // Helper: parse the GFM table rows (the lines between the header separator
  // and the trailing blank line) into their cell arrays.
  function tableRows(out: string): string[][] {
    const lines = out.split('\n');
    const sep = lines.findIndex((l) => /^\|\s*---/.test(l));
    if (sep < 0) return [];
    const rows: string[][] = [];
    for (let i = sep + 1; i < lines.length; i++) {
      const l = lines[i];
      if (!l.startsWith('|')) break;
      rows.push(l.split('|').slice(1, -1).map((c) => c.trim()));
    }
    return rows;
  }

  it('renders a GFM table with the State/Account/5h/5h resets/7d/7d resets header', () => {
    const out = renderAuthSnapshotFormat2(fixtureSnaps, { now: NOW, tz: 'UTC' });
    expect(out).toContain('🔋 **Auth — fleet status**');
    expect(out).toContain('| State | Account | 5h | 5h resets | 7d | 7d resets |');
    expect(out).toContain('| --- | --- | --- | --- | --- | --- |');
    // The single collapsed Status column is gone.
    expect(out).not.toContain('| 7d | Status |');
    // No legacy group headers / health-section titles remain.
    expect(out).not.toContain('**BLOCKED**');
    expect(out).not.toContain('**HEALTHY**');
  });

  it('sorts the ACTIVE account to the top row regardless of health group', () => {
    const rows = tableRows(renderAuthSnapshotFormat2(fixtureSnaps, { now: NOW, tz: 'UTC' }));
    expect(rows.length).toBe(3);
    // you@example.com is active + healthy; bob is blocked. Active still wins
    // the top row over the blocked account.
    expect(rows[0][1]).toContain('you@example.com');
  });

  it('labels the active account with " (active)" and NO black-dot marker', () => {
    const out = renderAuthSnapshotFormat2(fixtureSnaps, { now: NOW, tz: 'UTC' });
    expect(out).toContain('you@example.com (active)');
    // The ⚫/● active marker is removed entirely.
    expect(out).not.toContain('⚫');
    expect(out).not.toContain('●');
  });

  it('shows the FULL email address, never truncated', () => {
    const longSnaps = [
      snap({ label: 'a-very-long-account-name@really-long-domain.example.com', isActive: true, quota: quota({ fiveHourUtilizationPct: 5 }) }),
    ];
    const rows = tableRows(renderAuthSnapshotFormat2(longSnaps, { now: NOW, tz: 'UTC' }));
    expect(rows[0][1]).toContain('a-very-long-account-name@really-long-domain.example.com');
    expect(rows[0][1]).not.toContain('…');
    expect(rows[0][1]).not.toContain('...');
  });

  it('orders non-active rows blocked-before-healthy', () => {
    const rows = tableRows(renderAuthSnapshotFormat2(fixtureSnaps, { now: NOW, tz: 'UTC' }));
    // After the active row (you), the blocked bob must precede the healthy alice.
    const bob = rows.findIndex((r) => r[1].includes('bob@example.com'));
    const alice = rows.findIndex((r) => r[1].includes('alice@example.com'));
    expect(bob).toBeGreaterThan(0);
    expect(bob).toBeLessThan(alice);
  });

  it('reset columns show a "<time> (in ...)" cell for a blocked account (7d binding window)', () => {
    const rows = tableRows(renderAuthSnapshotFormat2(fixtureSnaps, { now: NOW, tz: 'UTC' }));
    const bob = rows.find((r) => r[1].includes('bob@example.com'))!;
    // bob is 7d-maxed; its 7d reset (2026-05-17T10:00Z) is ~2 days out and still
    // renders in its own reset cell — no "back" prefix in the new per-window shape.
    expect(bob[5]).toMatch(/^.* \(in .+\)$/);
    expect(bob[5]).not.toContain('back');
  });

  it('reset columns show a "<time> (in ...)" cell for each window of a healthy account', () => {
    const rows = tableRows(renderAuthSnapshotFormat2(fixtureSnaps, { now: NOW, tz: 'UTC' }));
    const you = rows.find((r) => r[1].includes('you@example.com'))!;
    // 5h resets cell [3] and 7d resets cell [5] both carry a relative hint.
    expect(you[3]).toMatch(/^.* \(in .+\)$/);
    expect(you[5]).toMatch(/^.* \(in .+\)$/);
    expect(you[3]).not.toContain('refills');
  });

  it('NEVER displays a percentage over 100% even on an over-cap account', () => {
    // Feed 1.01 (decimal) * 100 = 101 → must clamp to 100% in the cell.
    const overSnaps = [
      snap({
        label: 'over@example.com',
        isActive: true,
        quota: quota({ fiveHourUtilizationPct: 101, sevenDayUtilizationPct: 250 }),
      }),
    ];
    const rows = tableRows(renderAuthSnapshotFormat2(overSnaps, { now: NOW, tz: 'UTC' }));
    expect(rows[0][2]).toBe('100%'); // 5h
    expect(rows[0][4]).toBe('100%'); // 7d
    // And the blocked state still surfaces via the emoji (🔴). No resets known
    // (fixture has no reset timestamps) → both reset cells degrade to "—".
    expect(rows[0][0]).toBe('🔴');
    expect(rows[0][3]).toBe('—'); // 5h resets
    expect(rows[0][5]).toBe('—'); // 7d resets
  });

  it('renders dates in the reset columns only when NOT today (user tz)', () => {
    // now = Fri 3:00 PM Melbourne. A reset later the SAME Melbourne day shows
    // time-only; a reset on the next day shows the weekday.
    const MEL = 'Australia/Melbourne';
    const NOW_MEL = new Date('2026-05-15T05:00:00Z'); // Fri 3:00 PM Mel
    const sameDay = [
      snap({ label: 'today@example.com', isActive: true, quota: quota({
        fiveHourUtilizationPct: 5,
        fiveHourResetAt: new Date('2026-05-15T11:00:00Z'), // Fri 9:00 PM Mel (today)
        sevenDayResetAt: new Date('2026-05-22T11:00:00Z'),
      }) }),
    ];
    const todayRows = tableRows(renderAuthSnapshotFormat2(sameDay, { now: NOW_MEL, tz: MEL }));
    // 5h resets cell [3] — same Melbourne day → time only.
    expect(todayRows[0][3]).toContain('9:00 PM');
    expect(todayRows[0][3]).not.toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);

    const nextDay = [
      snap({ label: 'tomorrow@example.com', isActive: true, quota: quota({
        fiveHourUtilizationPct: 5,
        fiveHourResetAt: new Date('2026-05-15T15:00:00Z'), // Sat 1:00 AM Mel (tomorrow)
        sevenDayResetAt: new Date('2026-05-22T11:00:00Z'),
      }) }),
    ];
    const tomorrowRows = tableRows(renderAuthSnapshotFormat2(nextDay, { now: NOW_MEL, tz: MEL }));
    // 5h resets cell [3] — next Melbourne day → weekday prefix.
    expect(tomorrowRows[0][3]).toContain('Sat 1:00 AM');
  });

  it('emits a recommendation footer that names a healthy alternative when active is throttling', () => {
    const throttlingSnaps: AccountSnapshot[] = [
      snap({ label: 'a@x', isActive: true, quota: quota({ fiveHourUtilizationPct: 90 }) }),
      snap({ label: 'b@x', quota: quota({ fiveHourUtilizationPct: 5 }) }),
    ];
    const out = renderAuthSnapshotFormat2(throttlingSnaps, { now: NOW });
    expect(out).toMatch(/Recommendation:.*active a@x is throttling.*Switch to b@x/);
  });

  it('"stay on" when active is healthy', () => {
    const happySnaps: AccountSnapshot[] = [
      snap({ label: 'a@x', isActive: true, quota: quota({ fiveHourUtilizationPct: 5 }) }),
    ];
    const out = renderAuthSnapshotFormat2(happySnaps, { now: NOW });
    expect(out).toMatch(/Recommendation: stay on a@x\./);
  });

  it('falls back gracefully when quota probe failed', () => {
    const errSnaps: AccountSnapshot[] = [
      snap({ label: 'broken@x', isActive: true, quota: null, quotaError: 'HTTP 401' }),
    ];
    const out = renderAuthSnapshotFormat2(errSnaps, { now: NOW });
    // Probe-failed row: ⚪ State emoji + a "probe failed (...)" Status cell.
    expect(out).toContain('probe failed');
    expect(out).toContain('HTTP 401');
    expect(out).toContain('⚪');
  });

  it('renders refresh stamp when liveProbedAtMs given', () => {
    const out = renderAuthSnapshotFormat2(fixtureSnaps.slice(0, 1), {
      now: NOW,
      liveProbedAtMs: NOW.getTime() - 12_000,
    });
    expect(out).toMatch(/_Live · refreshed \d+s ago_/);
  });

  it('#2495 Change 2 — renders "⚠ cached Nm ago" (NOT a live stamp) on staleCachedAtMs', () => {
    const out = renderAuthSnapshotFormat2(fixtureSnaps.slice(0, 1), {
      now: NOW,
      staleCachedAtMs: NOW.getTime() - 3 * 60_000, // 3 min old cache
    });
    expect(out).toMatch(/_⚠ cached 3m ago_/);
    // Crucially: no false live stamp.
    expect(out).not.toContain('Live · refreshed');
  });

  it('#2495 Change 2 — staleCachedAtMs takes precedence over liveProbedAtMs', () => {
    const out = renderAuthSnapshotFormat2(fixtureSnaps.slice(0, 1), {
      now: NOW,
      liveProbedAtMs: NOW.getTime(),
      staleCachedAtMs: NOW.getTime() - 90_000,
    });
    expect(out).toContain('⚠ cached');
    expect(out).not.toContain('Live · refreshed');
  });

  // ── demo mode (the `/usage demo` / `/auth demo` suffix) ──────────────
  describe('demo mode masks email labels', () => {
    it('WITHOUT demo, the real account emails still render', () => {
      const out = renderAuthSnapshotFormat2(fixtureSnaps, { now: NOW, tz: 'UTC' });
      expect(out).toContain('alice@example.com');
      expect(out).toContain('bob@example.com');
      expect(out).toContain('you@example.com');
    });

    it('WITH demo, no real account label leaks and rows render masked emails', () => {
      __resetDemoMaskCachesForTest();
      const out = renderAuthSnapshotFormat2(fixtureSnaps, { now: NOW, tz: 'UTC', demo: true });
      // Real labels gone.
      expect(out).not.toContain('alice@example.com');
      expect(out).not.toContain('bob@example.com');
      expect(out).not.toContain('you@example.com');
      // Masked fakes present — plain table cells (no backtick wrap now).
      expect(out).toMatch(/[^@\s<]+@example\.com/);
    });

    it('WITH demo, the recommendation footer masks the active label', () => {
      __resetDemoMaskCachesForTest();
      const happy: AccountSnapshot[] = [
        snap({ label: 'real-active@corp.com', isActive: true, quota: quota({ fiveHourUtilizationPct: 5 }) }),
      ];
      const out = renderAuthSnapshotFormat2(happy, { now: NOW, demo: true });
      expect(out).not.toContain('real-active@corp.com');
      expect(out).toMatch(/Recommendation: stay on [^@\s]+@example\.com\./);
    });

    it('demo masking is deterministic across two renders in the same process', () => {
      __resetDemoMaskCachesForTest();
      const a = renderAuthSnapshotFormat2(fixtureSnaps, { now: NOW, tz: 'UTC', demo: true });
      const b = renderAuthSnapshotFormat2(fixtureSnaps, { now: NOW, tz: 'UTC', demo: true });
      expect(a).toBe(b);
    });
  });
});

// ── renderFallbackAnnouncement ───────────────────────────────────────

describe('renderFallbackAnnouncement', () => {
  const KEN_5H_BLOWN = quota({
    fiveHourUtilizationPct: 100,
    sevenDayUtilizationPct: 23,
    fiveHourResetAt: new Date('2026-05-15T05:50:00Z'),
    sevenDayResetAt: new Date('2026-05-18T19:00:00Z'),
    representativeClaim: 'five_hour',
  });

  const YOU_HEALTHY = quota({
    fiveHourUtilizationPct: 8,
    sevenDayUtilizationPct: 20,
    fiveHourResetAt: new Date('2026-05-15T01:00:00Z'),
    sevenDayResetAt: new Date('2026-05-17T01:00:00Z'),
  });

  it('headlines the limit type explicitly (5-hour vs 7-day) — JTBD core', () => {
    const out5 = renderFallbackAnnouncement({
      oldLabel: 'ken@x',
      oldQuota: KEN_5H_BLOWN,
      newLabel: 'you@x',
      newQuota: YOU_HEALTHY,
      triggerAgent: 'carrie',
      now: NOW,
      tz: 'UTC',
    });
    expect(out5).toContain('5-hour limit on ken@x');
    expect(out5).not.toContain('quota exhausted');

    const out7 = renderFallbackAnnouncement({
      oldLabel: 'me@x',
      oldQuota: quota({
        sevenDayUtilizationPct: 100,
        sevenDayResetAt: new Date('2026-05-17T10:00:00Z'),
        representativeClaim: 'seven_day',
      }),
      newLabel: 'you@x',
      newQuota: YOU_HEALTHY,
      triggerAgent: 'clerk',
      now: NOW,
      tz: 'UTC',
    });
    expect(out7).toContain('7-day limit on me@x');
  });

  // Context-correct escaping (#2695 fix): the swap announcement renders each
  // label in TWO contexts, and each demands a different treatment —
  //  • **bold** header / trigger-agent → escapeMarkdown (backslash-escaped, so
  //    an underscore can't open an emphasis run), and
  //  • `code span` (the old→new line, recovery line) → codeSpanSafe (LITERAL,
  //    because backslash escaping is inert inside a code span and would show a
  //    visible `old\_a\*x`).
  it('escapes labels in the bold header but renders them literally in code spans (#2695)', () => {
    const out = renderFallbackAnnouncement({
      oldLabel: 'old_a*x',
      oldQuota: KEN_5H_BLOWN,
      newLabel: 'new_b*y',
      newQuota: YOU_HEALTHY,
      triggerAgent: 'agent_z*q',
      now: NOW,
      tz: 'UTC',
    });
    // Emphasis contexts: backslash-escaped.
    expect(out).toContain('old\\_a\\*x'); // bold header "· … on old_a*x"
    expect(out).toContain('agent\\_z\\*q'); // "Triggered by: agent **…**"
    // Code-span contexts: literal, no stray backslash.
    expect(out).toContain('`old_a*x`');
    expect(out).toContain('`new_b*y`');
    expect(out).not.toContain('`old\\_a\\*x`');
    expect(out).not.toContain('`new\\_b\\*y`');
  });

  it('names the triggering agent + recovery countdown for the old account', () => {
    const out = renderFallbackAnnouncement({
      oldLabel: 'ken@x',
      oldQuota: KEN_5H_BLOWN,
      newLabel: 'you@x',
      newQuota: YOU_HEALTHY,
      triggerAgent: 'carrie',
      now: NOW,
      tz: 'UTC',
    });
    expect(out).toContain('Triggered by: agent **carrie**');
    expect(out).toMatch(/ken@x.*recovers.*in 4h 57m/);
  });

  it('reports new-account headroom verdict', () => {
    const happy = renderFallbackAnnouncement({
      oldLabel: 'ken@x',
      oldQuota: KEN_5H_BLOWN,
      newLabel: 'you@x',
      newQuota: YOU_HEALTHY,
      triggerAgent: 'carrie',
      now: NOW,
      tz: 'UTC',
    });
    expect(happy).toContain('plenty of headroom');

    const tight = renderFallbackAnnouncement({
      oldLabel: 'ken@x',
      oldQuota: KEN_5H_BLOWN,
      newLabel: 'you@x',
      newQuota: quota({ fiveHourUtilizationPct: 85 }),
      triggerAgent: 'carrie',
      now: NOW,
      tz: 'UTC',
    });
    expect(tight).toContain('near limit — watch this');
  });

  it('handles all-blocked: no swap, surface earliest reset + /auth add hint', () => {
    const out = renderFallbackAnnouncement({
      oldLabel: 'ken@x',
      oldQuota: KEN_5H_BLOWN,
      newLabel: null,
      newQuota: null,
      triggerAgent: 'carrie',
      now: NOW,
      tz: 'UTC',
    });
    expect(out).toContain('🔴 **All accounts blocked');
    expect(out).toMatch(/ken@x recovers.*in 4h 57m/);
    expect(out).toContain('/auth add');
  });

  it('Bug 3 — all-blocked card ENUMERATES every account (5h%/7d% + recovery ETA)', () => {
    // Three walled accounts with different recovery times. The card must list
    // ALL of them so the user can verify true fleet-wide exhaustion, not just
    // the one triggering account.
    const ken = quota({
      fiveHourUtilizationPct: 100,
      sevenDayUtilizationPct: 23,
      fiveHourResetAt: new Date('2026-05-15T05:50:00Z'),
      sevenDayResetAt: new Date('2026-05-18T19:00:00Z'),
      representativeClaim: 'five_hour',
    });
    const you = quota({
      fiveHourUtilizationPct: 30,
      sevenDayUtilizationPct: 100,
      sevenDayResetAt: new Date('2026-05-16T10:00:00Z'),
      representativeClaim: 'seven_day',
    });
    const carol = quota({
      fiveHourUtilizationPct: 100,
      sevenDayUtilizationPct: 60,
      fiveHourResetAt: new Date('2026-05-15T03:00:00Z'),
      representativeClaim: 'five_hour',
    });
    const out = renderFallbackAnnouncement({
      oldLabel: 'ken@x',
      oldQuota: ken,
      newLabel: null,
      newQuota: null,
      triggerAgent: 'carrie',
      fleetSnapshots: [
        snap({ label: 'ken@x', isActive: true, quota: ken }),
        snap({ label: 'you@x', quota: you }),
        snap({ label: 'carol@x', quota: carol }),
      ],
      now: NOW,
      tz: 'UTC',
    });
    expect(out).toContain('🔴 **All accounts blocked');
    // Every account is listed (not just the trigger).
    expect(out).toContain('ken@x');
    expect(out).toContain('you@x');
    expect(out).toContain('carol@x');
    // Per-account utilization rows are rendered (the renderAccountRow shape).
    expect(out).toMatch(/100%\s*\/\s*23%/);   // ken
    expect(out).toMatch(/30%\s*\/\s*100%/);   // you
    expect(out).toMatch(/100%\s*\/\s*60%/);   // carol
    // Each account's recovery countdown is surfaced.
    expect(out).toMatch(/quota exhausted/);
    // The earliest recovery across the fleet (carol, 5h reset at 03:00Z = ~2h)
    // is called out explicitly.
    expect(out).toMatch(/Earliest recovery:\s*`carol@x`/);
    expect(out).toContain('/auth add');
  });

  it('Bug 3 back-compat — no fleetSnapshots falls back to the single-account shape', () => {
    const out = renderFallbackAnnouncement({
      oldLabel: 'ken@x',
      oldQuota: KEN_5H_BLOWN,
      newLabel: null,
      newQuota: null,
      triggerAgent: 'carrie',
      now: NOW,
      tz: 'UTC',
    });
    expect(out).toContain('🔴 **All accounts blocked');
    expect(out).toMatch(/ken@x recovers.*in 4h 57m/);
    expect(out).not.toContain('Earliest recovery:');
  });
});

// ── buildSnapshotKeyboard ────────────────────────────────────────────

describe('buildSnapshotKeyboard', () => {
  it('hides switch buttons for BLOCKED accounts (no temptation to swap into a wall)', () => {
    const snaps: AccountSnapshot[] = [
      snap({ label: 'a@x', isActive: true, quota: quota({ fiveHourUtilizationPct: 5 }) }),
      snap({ label: 'b@x', quota: quota({ fiveHourUtilizationPct: 100 }) }), // blocked
      snap({ label: 'c@x', quota: quota({ fiveHourUtilizationPct: 5 }) }),  // healthy
    ];
    const rows = buildSnapshotKeyboard(snaps);
    const allText = rows.flat().map((b) => b.text);
    expect(allText).toContain('Switch fleet → c@x');
    expect(allText).not.toContain('Switch fleet → b@x');
  });

  it('hides switch buttons for UNKNOWN-health accounts (probe failed = unsafe)', () => {
    const snaps: AccountSnapshot[] = [
      snap({ label: 'a@x', isActive: true, quota: quota({ fiveHourUtilizationPct: 5 }) }),
      snap({ label: 'broken@x', quota: null, quotaError: 'HTTP 401' }),
    ];
    const rows = buildSnapshotKeyboard(snaps);
    const allText = rows.flat().map((b) => b.text);
    expect(allText).not.toContain('Switch fleet → broken@x');
  });

  it('always includes ↻ Refresh, /usage, + Add in the bottom row', () => {
    const rows = buildSnapshotKeyboard([
      snap({ label: 'a@x', isActive: true, quota: quota({}) }),
    ]);
    const last = rows[rows.length - 1]!.map((b) => b.text);
    expect(last).toEqual(['↻ Refresh', '/usage', '+ Add']);
  });

  it('caps switch buttons via maxSwitchButtons option', () => {
    const snaps: AccountSnapshot[] = Array.from({ length: 10 }, (_, i) =>
      snap({ label: `acc${i}@x`, isActive: i === 0, quota: quota({ fiveHourUtilizationPct: 5 }) }),
    );
    const rows = buildSnapshotKeyboard(snaps, { maxSwitchButtons: 2 });
    const switchRows = rows.slice(0, -1);
    expect(switchRows.length).toBe(2);
  });

  it('#2495 nit A — threads `now` so a refilled-since-snapshot account is offered as a switch target', () => {
    // refilled@x reads 100% on 5h, but its reset is in the PAST relative to the
    // threaded `now` → refill-normalized to 0% → healthy → a valid switch
    // target. With a default `new Date()` (well after the fixture epoch) the
    // normalization still treats it as refilled, so to prove the THREADING we
    // compare two explicit clocks.
    const resetAt = new Date('2026-05-15T00:00:00Z'); // before `now`
    const snaps: AccountSnapshot[] = [
      snap({ label: 'active@x', isActive: true, quota: quota({ fiveHourUtilizationPct: 5 }) }),
      snap({
        label: 'refilled@x',
        quota: quota({ fiveHourUtilizationPct: 100, fiveHourResetAt: resetAt }),
      }),
    ];
    // `now` AFTER the reset → refilled@x normalizes to healthy → offered.
    const after = buildSnapshotKeyboard(snaps, { now: new Date('2026-05-15T00:53:00Z') })
      .flat().map((b) => b.text);
    expect(after).toContain('Switch fleet → refilled@x');
    // `now` BEFORE the reset → still walled → NOT offered. Proves the threaded
    // clock actually drives classification (a default-`now` impl would ignore it).
    const before = buildSnapshotKeyboard(snaps, { now: new Date('2026-05-14T23:00:00Z') })
      .flat().map((b) => b.text);
    expect(before).not.toContain('Switch fleet → refilled@x');
  });

  it('demo mode masks the switch-button label but keeps the real label in callback_data', () => {
    __resetDemoMaskCachesForTest();
    const snaps: AccountSnapshot[] = [
      snap({ label: 'ken.real@example.com', isActive: true, quota: quota({ fiveHourUtilizationPct: 5 }) }),
      snap({ label: 'alt.real@example.com', quota: quota({ fiveHourUtilizationPct: 5 }) }),
    ];
    const rows = buildSnapshotKeyboard(snaps, { now: NOW, demo: true });
    const switchBtn = rows.flat().find((b) => b.callbackData?.startsWith('auth:use:'));
    expect(switchBtn).toBeDefined();
    // Label masked — the real email never appears on screen…
    expect(switchBtn!.text).not.toContain('alt.real@example.com');
    // …but the broker still gets the real label to act on.
    expect(switchBtn!.callbackData).toBe('auth:use:alt.real@example.com');
  });

  it('demo mode flips the refresh callback to auth:refresh:demo so a ↻ tap stays masked', () => {
    const snaps: AccountSnapshot[] = [
      snap({ label: 'a@x', isActive: true, quota: quota({}) }),
    ];
    const demoRows = buildSnapshotKeyboard(snaps, { demo: true }).flat();
    expect(demoRows.find((b) => b.text === '↻ Refresh')?.callbackData).toBe('auth:refresh:demo');
    const plainRows = buildSnapshotKeyboard(snaps).flat();
    expect(plainRows.find((b) => b.text === '↻ Refresh')?.callbackData).toBe('auth:refresh');
  });
});

// ── zipProbeResults ──────────────────────────────────────────────────

describe('zipProbeResults', () => {
  const okResult = { ok: true as const, data: quota({ fiveHourUtilizationPct: 5 }) };

  it('returns quotas parallel to labels with no staleCachedAtMs when everything is live', () => {
    const { quotas, staleCachedAtMs } = zipProbeResults(
      ['a@x', 'b@x'],
      [
        { label: 'a@x', result: okResult, served: 'live' },
        { label: 'b@x', result: okResult, served: 'live' },
      ],
    );
    expect(quotas).toHaveLength(2);
    expect(quotas.every((q) => q.ok)).toBe(true);
    expect(staleCachedAtMs).toBeUndefined();
  });

  it('surfaces the OLDEST capturedAt among cache-served rows (#2495 Change 2)', () => {
    const { staleCachedAtMs } = zipProbeResults(
      ['a@x', 'b@x', 'c@x'],
      [
        { label: 'a@x', result: okResult, served: 'live' },
        { label: 'b@x', result: okResult, served: 'cache', capturedAt: 5_000 },
        { label: 'c@x', result: okResult, served: 'cache', capturedAt: 2_000 },
      ],
    );
    expect(staleCachedAtMs).toBe(2_000);
  });

  it('degrades a missing per-label row to ok:false, preserving input order', () => {
    const { quotas } = zipProbeResults(
      ['a@x', 'gone@x'],
      [{ label: 'a@x', result: okResult }],
    );
    expect(quotas[0]!.ok).toBe(true);
    expect(quotas[1]!.ok).toBe(false);
    expect((quotas[1] as { ok: false; reason: string }).reason).toContain('no result');
  });

  it('ignores served:"cache" rows without capturedAt (no false staleness)', () => {
    const { staleCachedAtMs } = zipProbeResults(
      ['a@x'],
      [{ label: 'a@x', result: okResult, served: 'cache' }],
    );
    expect(staleCachedAtMs).toBeUndefined();
  });
});

// ── buildSnapshotsFromState ──────────────────────────────────────────

describe('buildSnapshotsFromState', () => {
  it('zips broker accounts with parallel quota results, marks the active', () => {
    const state: ListStateData = {
      active: 'b@x',
      fallback_order: ['a@x', 'b@x', 'c@x'],
      accounts: [
        { label: 'a@x', exhausted: false },
        { label: 'b@x', exhausted: false },
        { label: 'c@x', exhausted: false },
      ],
      agents: [],
      consumers: [],
    };
    const snaps = buildSnapshotsFromState(state, [
      { ok: true, data: quota({ fiveHourUtilizationPct: 5 }) },
      { ok: true, data: quota({ fiveHourUtilizationPct: 50 }) },
      { ok: false, reason: 'HTTP 401' },
    ]);
    expect(snaps.map((s) => s.label)).toEqual(['a@x', 'b@x', 'c@x']);
    expect(snaps.map((s) => s.isActive)).toEqual([false, true, false]);
    expect(snaps[0]!.quota?.fiveHourUtilizationPct).toBe(5);
    expect(snaps[2]!.quota).toBeNull();
    expect(snaps[2]!.quotaError).toBe('HTTP 401');
  });
});

// ── reviveLastQuota ──────────────────────────────────────────────────

describe('reviveLastQuota', () => {
  it('returns null for null input', () => {
    expect(reviveLastQuota(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(reviveLastQuota(undefined)).toBeNull();
  });

  it('converts ISO-string dates to Date objects', () => {
    const isoFive = '2026-05-15T06:00:00.000Z';
    const isoSeven = '2026-05-22T06:00:00.000Z';
    const lq: LastQuotaSnapshot = {
      fiveHourUtilizationPct: 45,
      sevenDayUtilizationPct: 72,
      fiveHourResetAt: isoFive,
      sevenDayResetAt: isoSeven,
      representativeClaim: 'five_hour',
      overageStatus: 'allowed',
      overageDisabledReason: null,
      capturedAt: Date.now(),
    };
    const q = reviveLastQuota(lq);
    expect(q).not.toBeNull();
    expect(q!.fiveHourUtilizationPct).toBe(45);
    expect(q!.sevenDayUtilizationPct).toBe(72);
    expect(q!.fiveHourResetAt).toBeInstanceOf(Date);
    expect(q!.fiveHourResetAt!.toISOString()).toBe(isoFive);
    expect(q!.sevenDayResetAt).toBeInstanceOf(Date);
    expect(q!.sevenDayResetAt!.toISOString()).toBe(isoSeven);
    expect(q!.representativeClaim).toBe('five_hour');
    expect(q!.overageStatus).toBe('allowed');
    expect(q!.overageDisabledReason).toBeNull();
  });

  it('passes through null dates as null', () => {
    const lq: LastQuotaSnapshot = {
      fiveHourUtilizationPct: 20,
      sevenDayUtilizationPct: 30,
      fiveHourResetAt: null,
      sevenDayResetAt: null,
      representativeClaim: null,
      overageStatus: null,
      overageDisabledReason: null,
      capturedAt: Date.now(),
    };
    const q = reviveLastQuota(lq);
    expect(q!.fiveHourResetAt).toBeNull();
    expect(q!.sevenDayResetAt).toBeNull();
  });
});

// ── buildSnapshotsFromCachedState ────────────────────────────────────

describe('buildSnapshotsFromCachedState', () => {
  function makeLastQuota(fivePct: number, sevenPct: number): LastQuotaSnapshot {
    return {
      fiveHourUtilizationPct: fivePct,
      sevenDayUtilizationPct: sevenPct,
      fiveHourResetAt: null,
      sevenDayResetAt: null,
      representativeClaim: null,
      overageStatus: null,
      overageDisabledReason: null,
      capturedAt: Date.now(),
    };
  }

  it('produces quota=null for accounts with no cached snapshot', () => {
    const state: ListStateData = {
      active: 'a@x',
      fallback_order: [],
      accounts: [{ label: 'a@x', exhausted: false, last_quota: null }],
      agents: [],
      consumers: [],
    };
    const snaps = buildSnapshotsFromCachedState(state);
    expect(snaps[0]!.quota).toBeNull();
    // classifyHealth on this snap returns 'unknown'
    expect(snaps[0]!.quotaError).toContain('no cached quota');
  });

  it('revives cached utilization into Date-bearing QuotaUtilization', () => {
    const state: ListStateData = {
      active: 'b@x',
      fallback_order: [],
      accounts: [
        { label: 'a@x', exhausted: false, last_quota: makeLastQuota(20, 30) },
        { label: 'b@x', exhausted: false, last_quota: makeLastQuota(85, 40) },
      ],
      agents: [],
      consumers: [],
    };
    const snaps = buildSnapshotsFromCachedState(state);
    expect(snaps[0]!.quota?.fiveHourUtilizationPct).toBe(20);
    expect(snaps[1]!.quota?.sevenDayUtilizationPct).toBe(40);
    expect(snaps[1]!.isActive).toBe(true);
  });

  it('classifyHealth correctly classifies cached throttling account (≥80% threshold)', () => {
    const state: ListStateData = {
      active: 'a@x',
      fallback_order: [],
      accounts: [
        { label: 'a@x', exhausted: false, last_quota: makeLastQuota(85, 40) },
      ],
      agents: [],
      consumers: [],
    };
    const snaps = buildSnapshotsFromCachedState(state);
    // With cached 85% 5h utilization, classifyHealth should return 'throttling'
    expect(classifyHealth(snaps[0]!)).toBe('throttling');
  });

  it('treats absent last_quota (undefined) the same as null', () => {
    const state: ListStateData = {
      active: 'a@x',
      fallback_order: [],
      // last_quota absent — simulates old broker version / cold broker start
      accounts: [{ label: 'a@x', exhausted: false }],
      agents: [],
      consumers: [],
    };
    const snaps = buildSnapshotsFromCachedState(state);
    expect(snaps[0]!.quota).toBeNull();
  });
});

// ── recommendation logic edge cases ──────────────────────────────────

describe('recommendation', () => {
  it('#2494 Bug B: does NOT say "all blocked" when an alternative is refilling', () => {
    // a@x is maxed with no reset (truly blocked); b@x is maxed but its weekly
    // window resets in ~2d (refilling). The honest summary must surface the
    // refill, not collapse to a false "All accounts blocked".
    const snaps: AccountSnapshot[] = [
      snap({ label: 'a@x', isActive: true, quota: quota({ fiveHourUtilizationPct: 100 }) }),
      snap({ label: 'b@x', quota: quota({ sevenDayUtilizationPct: 100, sevenDayResetAt: new Date('2026-05-17T00:00:00Z') }) }),
    ];
    const out = recommendation(snaps, NOW);
    expect(out).not.toContain('All accounts blocked');
    expect(out).toMatch(/soonest refill: b@x in 1d/);
  });

  it('#2494 Bug B: says "all blocked" only when EVERY account is truly walled (no reset)', () => {
    const snaps: AccountSnapshot[] = [
      snap({ label: 'a@x', isActive: true, quota: quota({ fiveHourUtilizationPct: 100 }) }),
      snap({ label: 'b@x', quota: quota({ sevenDayUtilizationPct: 100 }) }),
    ];
    const out = recommendation(snaps, NOW);
    expect(out).toContain('All accounts blocked');
  });

  it('reports throttling-with-no-alt when active is throttling and others are too', () => {
    const snaps: AccountSnapshot[] = [
      snap({ label: 'a@x', isActive: true, quota: quota({ fiveHourUtilizationPct: 90 }) }),
      snap({ label: 'b@x', quota: quota({ fiveHourUtilizationPct: 85 }) }),
    ];
    const out = recommendation(snaps, NOW);
    expect(out).toContain('throttling; no healthy alternative');
  });

  it('#2494 Bug B: mixed blocked-active + throttling-other → recommends the throttling slot, never "all blocked"', () => {
    const snaps: AccountSnapshot[] = [
      snap({ label: 'a@x', isActive: true, quota: quota({ fiveHourUtilizationPct: 100 }) }),
      snap({ label: 'b@x', quota: quota({ fiveHourUtilizationPct: 85 }) }), // throttling, usable
    ];
    const out = recommendation(snaps, NOW);
    expect(out).not.toContain('All accounts blocked');
    expect(out).toContain('b@x is throttling but still usable');
  });
});

// ── #2494 Bug A — refill-aware classification ───────────────────────────

describe('#2494 Bug A — refill-aware classifyHealth', () => {
  it('a pre-refill snapshot read AFTER its 5h reset classifies healthy', () => {
    // Captured at 100% on a 5h window whose reset is 3 min in the PAST → rolled.
    const pastReset = new Date(NOW.getTime() - 3 * 60_000);
    const s = snap({
      isActive: true,
      quota: quota({ fiveHourUtilizationPct: 100, fiveHourResetAt: pastReset, sevenDayUtilizationPct: 1 }),
    });
    expect(classifyHealth(s, NOW)).toBe('healthy');
  });

  it('a maxed weekly whose reset has PASSED classifies healthy', () => {
    const pastWeekly = new Date(NOW.getTime() - 60_000);
    const s = snap({ quota: quota({ sevenDayUtilizationPct: 100, sevenDayResetAt: pastWeekly, fiveHourUtilizationPct: 2 }) });
    expect(classifyHealth(s, NOW)).toBe('healthy');
  });

  it('a maxed window with a FUTURE reset still classifies blocked (not yet refilled)', () => {
    const futureReset = new Date(NOW.getTime() + 60 * 60_000);
    const s = snap({ quota: quota({ fiveHourUtilizationPct: 100, fiveHourResetAt: futureReset }) });
    expect(classifyHealth(s, NOW)).toBe('blocked');
  });

  it('the just-refilled lone active account is not falsely "all blocked" in the summary', () => {
    const pastReset = new Date(NOW.getTime() - 3 * 60_000);
    const snaps: AccountSnapshot[] = [
      snap({ label: 'a@x', isActive: true, quota: quota({ fiveHourUtilizationPct: 100, fiveHourResetAt: pastReset, sevenDayUtilizationPct: 1 }) }),
    ];
    expect(recommendation(snaps, NOW)).toContain('stay on a@x');
  });
});

// ── #2494 Bug C — quota-exhausted vs thin probe (billing-dead demoted) ────────

describe('#2494 Bug C — blockedReason + thin probe (out_of_credits now informational)', () => {
  it('out_of_credits at 0% util → healthy (demoted from billing-dead to informational)', () => {
    // THE KEY CHANGE: out_of_credits is no longer a blocked state.
    const s = snap({ quota: quota({ fiveHourUtilizationPct: 0, overageDisabledReason: 'out_of_credits' }) });
    expect(classifyHealth(s, NOW)).toBe('healthy');
    expect(blockedReason(s, NOW)).toBeNull(); // not blocked → no blocked reason
  });

  it('out_of_credits at HIGH util is still blocked (via util wall, not credits)', () => {
    // blocked because 5h>=99.5%, NOT because of out_of_credits
    const futureReset = new Date(NOW.getTime() + 30 * 60_000);
    const s = snap({ quota: quota({ fiveHourUtilizationPct: 100, fiveHourResetAt: futureReset, overageDisabledReason: 'out_of_credits' }) });
    expect(classifyHealth(s, NOW)).toBe('blocked');
    expect(blockedReason(s, NOW)).toBe('quota-exhausted'); // blocked by quota, not billing
  });

  it('a maxed window (no overage reason) → quota-exhausted (recoverable)', () => {
    const futureReset = new Date(NOW.getTime() + 30 * 60_000);
    const s = snap({ quota: quota({ fiveHourUtilizationPct: 100, fiveHourResetAt: futureReset }) });
    expect(blockedReason(s, NOW)).toBe('quota-exhausted');
  });

  it('blockedReason is null for a non-blocked account', () => {
    expect(blockedReason(snap({ quota: quota({ fiveHourUtilizationPct: 10 }) }), NOW)).toBeNull();
  });

  it('org_level_disabled behavior is unchanged — still healthy', () => {
    const s = snap({ quota: quota({ fiveHourUtilizationPct: 75, sevenDayUtilizationPct: 40, overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled' }) });
    expect(classifyHealth(s, NOW)).toBe('healthy');
    expect(blockedReason(s, NOW)).toBeNull();
  });

  it('a thin/headerless probe classifies unknown, never a confident 0%/healthy', () => {
    const s = snap({
      quota: quota({ fiveHourUtilizationPct: 0, sevenDayUtilizationPct: 0, fiveHourUtilPresent: false, sevenDayUtilPresent: false }),
    });
    expect(classifyHealth(s, NOW)).toBe('unknown');
  });

  it('a real 0%/0% probe (both windows present) stays healthy', () => {
    const s = snap({
      quota: quota({ fiveHourUtilizationPct: 0, sevenDayUtilizationPct: 0, fiveHourUtilPresent: true, sevenDayUtilPresent: true }),
    });
    expect(classifyHealth(s, NOW)).toBe('healthy');
  });

  it('a single-window probe (7d header missing) is NOT thin → governed by util', () => {
    const s = snap({
      quota: quota({ fiveHourUtilizationPct: 50, sevenDayUtilizationPct: 0, fiveHourUtilPresent: true, sevenDayUtilPresent: false }),
    });
    expect(classifyHealth(s, NOW)).toBe('healthy');
  });
});

// ── #2494 — row rendering: out_of_credits as informational annotation ─────────

describe('#2494 — renderAuthSnapshotFormat2 row rendering (out_of_credits demoted)', () => {
  it('out_of_credits at 0% util → healthy (🟢) row, NOT blocked', () => {
    // THE KEY CHANGE: carol scenario — 0% util, out_of_credits → healthy. In the
    // table this surfaces as a 🟢 State emoji, not 🔴 — the row is not blocked.
    const out = renderAuthSnapshotFormat2(
      [snap({ label: 'dead@x', isActive: true, quota: quota({ fiveHourUtilizationPct: 0, overageDisabledReason: 'out_of_credits' }) })],
      { now: NOW },
    );
    expect(out).toContain('| 🟢 |');
    expect(out).not.toContain('| 🔴 |');
    // Must NOT have old blocked framing.
    expect(out).not.toContain('billing disabled');
    expect(out).not.toContain("won't recover until billing is fixed");
    expect(out).not.toContain('quota exhausted');
    expect(out).not.toContain('back ');
  });

  it('out_of_credits account is a valid failover target (appears in buildSnapshotKeyboard switch buttons)', () => {
    // A 0%-util out_of_credits account must be offerable as a switch target
    const snaps: AccountSnapshot[] = [
      snap({ label: 'a@x', isActive: true, quota: quota({ fiveHourUtilizationPct: 100 }) }), // blocked, active
      snap({ label: 'carol@example.com', quota: quota({ fiveHourUtilizationPct: 0, overageDisabledReason: 'out_of_credits' }) }), // healthy
    ];
    const rows = buildSnapshotKeyboard(snaps);
    const allText = rows.flat().map((b) => b.text);
    expect(allText).toContain('Switch fleet → carol@example.com');
  });

  it('quota-exhausted row shows a 🔴 + its 5h reset time in the reset cell, not "billing disabled"', () => {
    const futureReset = new Date(NOW.getTime() + 45 * 60_000);
    const out = renderAuthSnapshotFormat2(
      [snap({ label: 'ex@x', isActive: true, quota: quota({ fiveHourUtilizationPct: 100, fiveHourResetAt: futureReset }) })],
      { now: NOW },
    );
    expect(out).toContain('| 🔴 |');
    // The 5h reset (45m out) renders in its own reset cell — no "back" prefix.
    expect(out).toMatch(/\(in 45m\)/);
    expect(out).not.toContain('back ');
    expect(out).not.toContain('billing disabled');
    expect(out).not.toContain('overage off');
  });

  it('thin probe row renders "quota unknown", not "0% / 0%"', () => {
    const out = renderAuthSnapshotFormat2(
      [snap({ label: 'thin@x', isActive: true, quota: quota({ fiveHourUtilizationPct: 0, sevenDayUtilizationPct: 0, fiveHourUtilPresent: false, sevenDayUtilPresent: false }) })],
      { now: NOW },
    );
    expect(out).toContain('quota unknown');
    expect(out).not.toContain('0% / 0%');
  });

  it('org_level_disabled at 85% util has no overage annotation (only in OVERAGE_EXHAUSTED_REASONS)', () => {
    // org_level_disabled is NOT on the OVERAGE_EXHAUSTED_REASONS list → no annotation
    const out = renderAuthSnapshotFormat2(
      [snap({ label: 'org@x', isActive: false, quota: quota({ fiveHourUtilizationPct: 85, overageDisabledReason: 'org_level_disabled' }) })],
      { now: NOW },
    );
    // 85% util → throttling, surfaced as the 🟡 State emoji in the table.
    expect(out).toContain('| 🟡 |');
    expect(out).not.toContain('overage off');
  });

  it('recommendation treats out_of_credits 0%-util account as healthy alternative', () => {
    // The active account is blocked (quota), the out_of_credits 0%-util account
    // is the only alternative — it must be recommended as the switch target.
    const snaps: AccountSnapshot[] = [
      snap({ label: 'main@x', isActive: true, quota: quota({ fiveHourUtilizationPct: 100 }) }), // blocked
      snap({ label: 'carol@example.com', quota: quota({ fiveHourUtilizationPct: 0, overageDisabledReason: 'out_of_credits' }) }), // healthy
    ];
    const out = recommendation(snaps, NOW);
    expect(out).toContain('switch to carol@example.com');
    expect(out).not.toContain('All accounts blocked');
  });
});
