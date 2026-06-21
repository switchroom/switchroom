/**
 * Tests for auth-snapshot-format.ts — Format 2 + causal auto-fallback
 * announcement. Pure functions, fully covered by frozen-clock tests
 * with hand-crafted QuotaUtilization fixtures.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyHealth,
  blockedReason,
  bindingWindow,
  formatRelative,
  formatAbsolute,
  fmtPct,
  recommendation,
  renderAuthSnapshotFormat2,
  renderFallbackAnnouncement,
  buildSnapshotKeyboard,
  buildSnapshotsFromState,
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
  it('out_of_credits overage at 0% util → blocked (the credits-dead account)', () => {
    expect(
      classifyHealth(snap({ quota: quota({ fiveHourUtilizationPct: 0, sevenDayUtilizationPct: 0, overageStatus: 'rejected', overageDisabledReason: 'out_of_credits' }) })),
    ).toBe('blocked');
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

  it('renders three health-grouped sections (BLOCKED first, then HEALTHY)', () => {
    const out = renderAuthSnapshotFormat2(fixtureSnaps, { now: NOW, tz: 'UTC' });
    // Headers present
    expect(out).toContain('🔋 <b>Auth — fleet status</b>');
    expect(out).toContain('🔴 <b>BLOCKED</b> (1)');
    expect(out).toContain('🟢 <b>HEALTHY</b> (2)');
    // Order: BLOCKED before HEALTHY
    expect(out.indexOf('🔴')).toBeLessThan(out.indexOf('🟢'));
  });

  it('marks the active account with ●', () => {
    const out = renderAuthSnapshotFormat2(fixtureSnaps, { now: NOW, tz: 'UTC' });
    expect(out).toMatch(/●\s*<code>you@example\.com<\/code>/);
  });

  it('shows "back …" for blocked accounts with binding-window word', () => {
    const out = renderAuthSnapshotFormat2(fixtureSnaps, { now: NOW, tz: 'UTC' });
    // bob@example is blocked on 7d, recovers Sun
    expect(out).toMatch(/bob@example\.com[\s\S]*back .* 7-day cap/);
  });

  it('puts the imminent window first on healthy/throttling rows', () => {
    const out = renderAuthSnapshotFormat2(fixtureSnaps, { now: NOW, tz: 'UTC' });
    // you: 5h reset is in 7m, 7d reset is in 2d. 5h should come first.
    const pixRow = out.split('\n').find((l) => l.includes('5h refills') && l.includes('7d resets'));
    expect(pixRow).toBeDefined();
    expect(pixRow!.indexOf('5h refills')).toBeLessThan(pixRow!.indexOf('7d resets'));
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
    expect(out).toContain('quota probe failed');
    expect(out).toContain('HTTP 401');
    expect(out).toContain('⚪ <b>UNKNOWN</b>');
  });

  it('renders refresh stamp when liveProbedAtMs given', () => {
    const out = renderAuthSnapshotFormat2(fixtureSnaps.slice(0, 1), {
      now: NOW,
      liveProbedAtMs: NOW.getTime() - 12_000,
    });
    expect(out).toMatch(/<i>Live · refreshed \d+s ago<\/i>/);
  });

  it('#2495 Change 2 — renders "⚠ cached Nm ago" (NOT a live stamp) on staleCachedAtMs', () => {
    const out = renderAuthSnapshotFormat2(fixtureSnaps.slice(0, 1), {
      now: NOW,
      staleCachedAtMs: NOW.getTime() - 3 * 60_000, // 3 min old cache
    });
    expect(out).toMatch(/<i>⚠ cached 3m ago<\/i>/);
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
    expect(out).toContain('Triggered by: agent <b>carrie</b>');
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
    expect(out).toContain('🔴 <b>All accounts blocked');
    expect(out).toMatch(/ken@x recovers.*in 4h 57m/);
    expect(out).toContain('/auth add');
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

// ── #2494 Bug C — quota-exhausted vs billing-dead, thin probe ────────────

describe('#2494 Bug C — blockedReason + thin probe', () => {
  it('out_of_credits → billing-dead', () => {
    const s = snap({ quota: quota({ fiveHourUtilizationPct: 0, overageDisabledReason: 'out_of_credits' }) });
    expect(classifyHealth(s, NOW)).toBe('blocked');
    expect(blockedReason(s, NOW)).toBe('billing-dead');
  });

  it('a maxed window (no overage reason) → quota-exhausted (recoverable)', () => {
    const futureReset = new Date(NOW.getTime() + 30 * 60_000);
    const s = snap({ quota: quota({ fiveHourUtilizationPct: 100, fiveHourResetAt: futureReset }) });
    expect(blockedReason(s, NOW)).toBe('quota-exhausted');
  });

  it('blockedReason is null for a non-blocked account', () => {
    expect(blockedReason(snap({ quota: quota({ fiveHourUtilizationPct: 10 }) }), NOW)).toBeNull();
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

// ── #2494 — row rendering distinguishes the states ──────────────────────

describe('#2494 — renderAuthSnapshotFormat2 row rendering', () => {
  it('billing-dead row says "billing disabled" with the reason, no timer', () => {
    const out = renderAuthSnapshotFormat2(
      [snap({ label: 'dead@x', isActive: true, quota: quota({ fiveHourUtilizationPct: 0, overageDisabledReason: 'out_of_credits' }) })],
      { now: NOW },
    );
    expect(out).toContain('billing disabled (out_of_credits)');
    expect(out).not.toContain('quota exhausted');
  });

  it('quota-exhausted row shows a recovery countdown, not "billing disabled"', () => {
    const futureReset = new Date(NOW.getTime() + 45 * 60_000);
    const out = renderAuthSnapshotFormat2(
      [snap({ label: 'ex@x', isActive: true, quota: quota({ fiveHourUtilizationPct: 100, fiveHourResetAt: futureReset }) })],
      { now: NOW },
    );
    expect(out).toContain('quota exhausted');
    expect(out).not.toContain('billing disabled');
  });

  it('thin probe row renders "quota unknown", not "0% / 0%"', () => {
    const out = renderAuthSnapshotFormat2(
      [snap({ label: 'thin@x', isActive: true, quota: quota({ fiveHourUtilizationPct: 0, sevenDayUtilizationPct: 0, fiveHourUtilPresent: false, sevenDayUtilPresent: false }) })],
      { now: NOW },
    );
    expect(out).toContain('quota unknown');
    expect(out).not.toContain('0% / 0%');
  });
});
