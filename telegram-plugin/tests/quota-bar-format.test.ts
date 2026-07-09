/**
 * Tests for quota-bar-format.ts — bar-building, time-left formatting, and
 * the full block assembly. Pure functions, frozen-clock fixtures.
 */
import { describe, it, expect } from 'vitest';
import {
  pickDot,
  formatTimeLeft,
  elapsedFraction,
  buildBar,
  accountStatus,
  formatWindowRow,
  renderQuotaBarAccount,
  renderQuotaBarBlockFromListState,
  renderUsageCard,
} from '../quota-bar-format.js';
import type { AccountSnapshot } from '../auth-snapshot-format.js';
import type { QuotaUtilization } from '../quota-check.js';
import type { ListStateData } from '../../src/auth/broker/client.js';

const NOW = new Date('2026-07-10T00:00:00.000Z');

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

// ── pickDot ──────────────────────────────────────────────────────────

describe('pickDot', () => {
  it('green under 50%', () => {
    expect(pickDot(0)).toBe('🟢');
    expect(pickDot(49)).toBe('🟢');
  });
  it('yellow 50-89%', () => {
    expect(pickDot(50)).toBe('🟡');
    expect(pickDot(89)).toBe('🟡');
  });
  it('red 90%+', () => {
    expect(pickDot(90)).toBe('🔴');
    expect(pickDot(100)).toBe('🔴');
  });
});

// ── formatTimeLeft ───────────────────────────────────────────────────

describe('formatTimeLeft', () => {
  it('returns "resets now" when the target is null', () => {
    expect(formatTimeLeft(null, NOW)).toBe('resets now');
  });
  it('returns "resets now" when the target has already passed', () => {
    expect(formatTimeLeft(new Date(NOW.getTime() - 1000), NOW)).toBe('resets now');
  });
  it('returns "resets now" when the target is exactly now', () => {
    expect(formatTimeLeft(new Date(NOW.getTime()), NOW)).toBe('resets now');
  });
  it('formats sub-hour deltas as minutes', () => {
    expect(formatTimeLeft(new Date(NOW.getTime() + 45 * 60_000), NOW)).toBe('45m left');
  });
  it('formats sub-day deltas as compact hours+minutes', () => {
    expect(formatTimeLeft(new Date(NOW.getTime() + (4 * 60 + 20) * 60_000), NOW)).toBe('4h20m left');
  });
  it('formats multi-day deltas as compact days+hours', () => {
    expect(formatTimeLeft(new Date(NOW.getTime() + (3 * 24 + 1) * 60 * 60_000), NOW)).toBe('3d1h left');
  });
  it('drops the hours segment when exactly on a day boundary', () => {
    expect(formatTimeLeft(new Date(NOW.getTime() + 2 * 24 * 60 * 60_000), NOW)).toBe('2d left');
  });
});

// ── elapsedFraction ──────────────────────────────────────────────────

describe('elapsedFraction', () => {
  const fiveHourMs = 5 * 60 * 60 * 1000;
  it('is 0 when there is no reset timestamp', () => {
    expect(elapsedFraction(null, fiveHourMs, NOW)).toBe(0);
  });
  it('is 0 when the reset has already passed', () => {
    expect(elapsedFraction(new Date(NOW.getTime() - 1000), fiveHourMs, NOW)).toBe(0);
  });
  it('is close to 1 just before reset', () => {
    const frac = elapsedFraction(new Date(NOW.getTime() + 60_000), fiveHourMs, NOW);
    expect(frac).toBeGreaterThan(0.99);
    expect(frac).toBeLessThanOrEqual(1);
  });
  it('is ~0.5 halfway through the window', () => {
    const frac = elapsedFraction(new Date(NOW.getTime() + fiveHourMs / 2), fiveHourMs, NOW);
    expect(frac).toBeCloseTo(0.5, 5);
  });
});

// ── buildBar ─────────────────────────────────────────────────────────

describe('buildBar', () => {
  it('is all empty cells with a tick at 0% pct and 0 elapsed fraction', () => {
    expect(buildBar(0, 0)).toBe('┃░░░░░░░░░');
  });
  it('the tick always overrides the fill, even at 100% pct', () => {
    expect(buildBar(100, 0.5)).toBe('█████┃████');
  });
  it('the tick overrides fill at the very last cell (100% pct, 100% elapsed)', () => {
    expect(buildBar(100, 1)).toBe('█████████┃');
  });
  it('is exactly 10 characters for any pct/fraction combination', () => {
    for (const pct of [0, 1, 33, 47, 89, 99, 100]) {
      for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
        expect(buildBar(pct, frac).length).toBe(10);
      }
    }
  });
  it('places the tick outside the filled region when there is room', () => {
    // 20% filled (2 cells) + tick at fraction 0.8 → tick lands past the fill.
    const bar = buildBar(20, 0.8);
    expect(bar[0]).toBe('█');
    expect(bar[1]).toBe('█');
    expect(bar).toContain('┃');
  });
  it('over-pace: quota fill visibly punches through past the time-elapsed tick', () => {
    // 80% quota used, only 30% of the way through the window — burning
    // faster than the clock. Fill (8 cells) extends past the tick
    // (index round(0.3*9)=3), so filled cells appear on BOTH sides of the
    // tick — that's the "punch through" signal the operator asked for.
    const bar = buildBar(80, 0.3);
    expect(bar).toBe('███┃████░░');
    const tickIndex = bar.indexOf('┃');
    const filledAfterTick = bar.slice(tickIndex + 1).includes('█');
    expect(filledAfterTick).toBe(true); // fill visibly overtakes the pace marker
  });
});

// ── accountStatus ────────────────────────────────────────────────────

describe('accountStatus', () => {
  it('active wins even if the broker also flags the account exhausted', () => {
    expect(accountStatus(true, true)).toBe('active');
  });
  it('reports exhausted for a non-active exhausted account', () => {
    expect(accountStatus(false, true)).toBe('exhausted');
  });
  it('reports idle for a non-active, non-exhausted account', () => {
    expect(accountStatus(false, false)).toBe('idle');
  });
});

// ── formatWindowRow / renderQuotaBarAccount ─────────────────────────

describe('formatWindowRow', () => {
  it('renders the locked row shape', () => {
    const row = formatWindowRow('5h', 0, null, NOW);
    expect(row).toBe('- 🟢 5h `[┃░░░░░░░░░] 0% / resets now`');
  });
  it('clamps a >100% probe value for display', () => {
    const row = formatWindowRow('7d', 101, null, NOW);
    expect(row).toContain('100%');
  });
});

describe('renderQuotaBarAccount', () => {
  it('renders a title line + two window rows', () => {
    const q = quota({
      fiveHourUtilizationPct: 0,
      sevenDayUtilizationPct: 47,
      sevenDayResetAt: new Date(NOW.getTime() + (3 * 24 + 1) * 60 * 60_000),
    });
    const lines = renderQuotaBarAccount('ken@example.com', true, false, q, NOW);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('- **ken@example.com** (active)');
    expect(lines[1]).toBe('- 🟢 5h `[┃░░░░░░░░░] 0% / resets now`');
    expect(lines[2]).toContain('🟢 7d');
    expect(lines[2]).toContain('47% / 3d1h left');
  });
  it('escapes markdown-significant characters in the label (bold run, not a code span)', () => {
    // Regression: the title line wraps label in **bold**, so a label
    // containing `**` or `[...]` must be backslash-escaped (escapeMarkdown),
    // not defused with codeSpanSafe (which only strips backticks and would
    // leave `*`/`[`/`]` live, breaking the bold run or injecting a link).
    const lines = renderQuotaBarAccount('a**b[x](evil)_c', false, false, null, NOW);
    expect(lines[0]).toBe('- **a\\*\\*b\\[x\\](evil)\\_c** (idle)');
  });
  it('exhausted account at 0% utilization on both windows still shows exhausted status with healthy dots', () => {
    const q = quota({ fiveHourUtilizationPct: 0, sevenDayUtilizationPct: 0 });
    const lines = renderQuotaBarAccount('done@example.com', false, true, q, NOW);
    expect(lines[0]).toBe('- **done@example.com** (exhausted)');
    expect(lines[1]).toContain('🟢 5h');
    expect(lines[2]).toContain('🟢 7d');
  });
  it('degrades gracefully to 0%/no-reset rows when quota is missing', () => {
    const lines = renderQuotaBarAccount('nobody@example.com', false, false, null, NOW);
    expect(lines).toEqual([
      '- **nobody@example.com** (idle)',
      '- 🟢 5h `[┃░░░░░░░░░] 0% / resets now`',
      '- 🟢 7d `[┃░░░░░░░░░] 0% / resets now`',
    ]);
  });
});

// ── renderQuotaBarBlockFromListState ────────────────────────────────

describe('renderQuotaBarBlockFromListState', () => {
  it('renders the locked multi-account block shape', () => {
    const state: ListStateData = {
      active: 'ken@example.com',
      fallback_order: ['ken@example.com', 'alt@example.com'],
      accounts: [
        {
          label: 'ken@example.com',
          exhausted: false,
          last_quota: {
            fiveHourUtilizationPct: 0,
            sevenDayUtilizationPct: 47,
            fiveHourResetAt: new Date(NOW.getTime() + 60_000).toISOString(),
            sevenDayResetAt: new Date(NOW.getTime() + (3 * 24 + 1) * 60 * 60_000).toISOString(),
            representativeClaim: null,
            overageStatus: null,
            overageDisabledReason: null,
            capturedAt: NOW.getTime(),
          },
        },
        {
          label: 'alt@example.com',
          exhausted: true,
          last_quota: {
            fiveHourUtilizationPct: 0,
            sevenDayUtilizationPct: 100,
            fiveHourResetAt: new Date(NOW.getTime() - 60_000).toISOString(),
            sevenDayResetAt: new Date(NOW.getTime() + 2 * 24 * 60 * 60_000 + 16 * 60 * 60_000).toISOString(),
            representativeClaim: null,
            overageStatus: null,
            overageDisabledReason: null,
            capturedAt: NOW.getTime(),
          },
        },
      ],
      agents: [],
      consumers: [],
    };
    const block = renderQuotaBarBlockFromListState(state, { now: NOW });
    const lines = block.split('\n');
    expect(lines).toEqual([
      '- **ken@example.com** (active)',
      '- 🟢 5h `[░░░░░░░░░┃] 0% / 1m left`',
      '- 🟢 7d `[█████┃░░░░] 47% / 3d1h left`',
      '- **alt@example.com** (exhausted)',
      '- 🟢 5h `[┃░░░░░░░░░] 0% / resets now`',
      '- 🔴 7d `[██████┃███] 100% / 2d16h left`',
    ]);
  });
});

// ── renderUsageCard (bar block only — /usage no longer appends the ─────
// Format 2 table underneath; see gateway.ts's `bot.command('usage', ...)`)

describe('renderUsageCard', () => {
  function snap(part: Partial<AccountSnapshot> & { label: string }): AccountSnapshot {
    return {
      isActive: false,
      quota: null,
      ...part,
    };
  }

  const snapshots: AccountSnapshot[] = [
    snap({
      label: 'ken@example.com',
      isActive: true,
      quota: quota({
        fiveHourUtilizationPct: 0,
        sevenDayUtilizationPct: 47,
        fiveHourResetAt: new Date(NOW.getTime() + 60 * 60_000),
        sevenDayResetAt: new Date(NOW.getTime() + (3 * 24 + 1) * 60 * 60_000),
      }),
    }),
  ];
  const exhausted = new Map<string, boolean>([['ken@example.com', false]]);

  it('renders ONLY the quota-bar block — no Format 2 table underneath', () => {
    const out = renderUsageCard(snapshots, exhausted, { now: NOW });
    const lines = out.split('\n');
    // Bar block — account title + two window rows with the ASCII bar.
    expect(lines[0]).toBe('- **ken@example.com** (active)');
    expect(out).toContain('- 🟢 5h `[');
    expect(out).toContain('- 🟢 7d `[');
    // Reset info is carried by the bar rows themselves (relative
    // time-left), not a separate table.
    expect(out).toContain('1h0m left');
    expect(out).toContain('left');
    // The old Format 2 table must be fully gone from this card.
    expect(out).not.toContain('🔋 **Auth — fleet status**');
    expect(out).not.toContain('| State | Account | 5h | 5h resets | 7d | 7d resets |');
    expect(out).not.toContain('Recommendation:');
    // Exactly 3 lines: title + 5h row + 7d row, no trailing table.
    expect(lines).toHaveLength(3);
  });

  it('masks the account-email label in demo mode', () => {
    const out = renderUsageCard(snapshots, exhausted, { now: NOW, demo: true });
    expect(out).not.toContain('ken@example.com');
    // Bar rows are unaffected; only the title-line label is masked.
    expect(out).toContain('5h `[');
  });

  it('does not mask the label when demo is omitted', () => {
    const out = renderUsageCard(snapshots, exhausted, { now: NOW });
    expect(out).toContain('- **ken@example.com** (active)');
  });
});
