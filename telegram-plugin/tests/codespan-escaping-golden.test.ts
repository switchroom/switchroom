/**
 * Golden regression tests for GFM code-span escaping (#2695 / #2701).
 *
 * Inside a GFM inline code span (`` `…` ``) content is LITERAL — backslash
 * escaping does NOT apply. #2695 renamed `escapeHtml`→`escapeMarkdown`
 * blindly across the auth/quota/usage surfaces, so identifiers containing
 * `_ * ~ [ ] | =` were rendered with visible backslashes inside code spans
 * (e.g. `openai\_key` instead of `openai_key`), and the /usage table cell
 * corrupted the row when a label carried a `_`/`*`.
 *
 * These goldens are the ONLY guard for this class of bug: the rendered
 * rich-message content isn't observable through the mtcute UAT harness
 * (it can't read message text formatting), so a unit assertion on the
 * exact string is the regression fence. If any of these re-introduce a
 * stray backslash before an identifier char inside a code span, they fail.
 */
import { describe, it, expect } from 'vitest';
import { codeSpanSafe, escapeMarkdown } from '../format.js';
import {
  renderAuthSnapshotFormat2,
  renderFallbackAnnouncement,
  type AccountSnapshot,
} from '../auth-snapshot-format.js';
import {
  buildThrottlingMessage,
  buildRecoveryMessage,
} from '../quota-watch.js';
import type { QuotaUtilization } from '../quota-check.js';

const NOW = new Date('2026-05-15T00:53:00Z');

// Two representative payloads that broke under escapeMarkdown-in-code-span:
// an email/label with an underscore, and a vault-key-shaped secret ref.
const LABEL_UNDERSCORE = 'ken_max';
const SECRET_REF = 'secret:OPENAI_API_KEY';

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

/**
 * Assert `value` renders LITERALLY inside a code span somewhere in `rendered`:
 *  - the exact `` `value` `` span is present, and
 *  - no backslash-escaped variant of the value leaked (no `\_`, `\*`, etc.).
 */
function expectLiteralInCodeSpan(rendered: string, value: string) {
  expect(rendered).toContain('`' + value + '`');
  // The buggy output would be `` `secret:OPENAI\_API\_KEY` `` — assert no
  // backslash immediately precedes any char of the value's active set.
  const escaped = escapeMarkdown(value);
  if (escaped !== value) {
    // escapeMarkdown would have produced a different (backslashed) string;
    // that exact string must NOT appear.
    expect(rendered).not.toContain('`' + escaped + '`');
  }
  // Belt-and-suspenders: no stray backslash before an identifier char.
  expect(rendered).not.toMatch(/\\[_*~=\[\]|]/);
}

describe('codeSpanSafe helper', () => {
  it('leaves identifier chars untouched (no backslash)', () => {
    expect(codeSpanSafe(LABEL_UNDERSCORE)).toBe(LABEL_UNDERSCORE);
    expect(codeSpanSafe(SECRET_REF)).toBe(SECRET_REF);
    expect(codeSpanSafe('a_b*c~d=e[f]g|h')).toBe('a_b*c~d=e[f]g|h');
  });

  it('neutralizes an embedded backtick so it cannot close the span', () => {
    const out = codeSpanSafe('a`b');
    // A raw backtick would close the surrounding span; the transform must
    // insert a separator so `` `${out}` `` cannot be split into two spans.
    expect(out).not.toBe('a`b');
    expect(out.startsWith('a`')).toBe(true);
    // The zero-width space sits right after the backtick.
    expect(out).toContain('`​');
  });

  it('escapeMarkdown (the WRONG helper for code spans) would backslash these', () => {
    // Guards the premise: if someone reverts to escapeMarkdown, the output
    // differs — proving these goldens actually catch the regression.
    expect(escapeMarkdown(LABEL_UNDERSCORE)).toBe('ken\\_max');
    expect(escapeMarkdown(SECRET_REF)).toContain('\\_');
  });
});

describe('/auth card — code-span labels render literally (#2695)', () => {
  it('renders an underscore label literally in the /usage table account cell', () => {
    const rendered = renderAuthSnapshotFormat2(
      [snap({ label: LABEL_UNDERSCORE, isActive: true, quota: quota({ fiveHourUtilizationPct: 10, sevenDayUtilizationPct: 20 }) })],
      { now: NOW },
    );
    // The account cell wraps the label (plus the (active) suffix) in a code span.
    expect(rendered).toContain('`' + LABEL_UNDERSCORE + ' (active)`');
    expect(rendered).not.toContain('ken\\_max');
    expect(rendered).not.toMatch(/\\[_*~=\[\]|]/);
  });

  it('renders a secret-ref-shaped label literally in the account cell', () => {
    const rendered = renderAuthSnapshotFormat2(
      [snap({ label: SECRET_REF, quota: quota({ fiveHourUtilizationPct: 5, sevenDayUtilizationPct: 5 }) })],
      { now: NOW },
    );
    expect(rendered).toContain('`' + SECRET_REF + '`');
    expect(rendered).not.toMatch(/\\[_*~=\[\]|]/);
  });

  it('renders the label literally in the fallback-announcement code spans', () => {
    const rendered = renderFallbackAnnouncement({
      oldLabel: LABEL_UNDERSCORE,
      newLabel: 'new_acct',
      triggerAgent: 'clerk',
      oldQuota: null,
      newQuota: quota({ fiveHourUtilizationPct: 3, sevenDayUtilizationPct: 4 }),
      now: NOW,
    });
    // Code spans are literal (the fix). The **bold** header legitimately
    // escapes the label — that is emphasis context, out of scope here — so we
    // only assert the code-span form, not a global no-backslash rule.
    expect(rendered).toContain('`' + LABEL_UNDERSCORE + '`');
    expect(rendered).toContain('`new_acct`');
    expect(rendered).not.toContain('`ken\\_max`');
  });
});

describe('quota card — code-span labels render literally (#2695)', () => {
  it('throttling card renders an underscore label literally', () => {
    const rendered = buildThrottlingMessage(
      'clerk',
      snap({ label: LABEL_UNDERSCORE, isActive: true, quota: quota({ fiveHourUtilizationPct: 85, sevenDayUtilizationPct: 40 }) }),
    );
    expectLiteralInCodeSpan(rendered, LABEL_UNDERSCORE);
  });

  it('throttling card renders a secret-ref label literally (non-active use hint)', () => {
    const rendered = buildThrottlingMessage(
      'clerk',
      snap({ label: SECRET_REF, isActive: false, quota: quota({ fiveHourUtilizationPct: 90, sevenDayUtilizationPct: 30 }) }),
    );
    expectLiteralInCodeSpan(rendered, SECRET_REF);
  });

  it('recovery card renders an underscore label literally', () => {
    const rendered = buildRecoveryMessage(
      'clerk',
      snap({ label: LABEL_UNDERSCORE, isActive: true, quota: quota({ fiveHourUtilizationPct: 10, sevenDayUtilizationPct: 5 }) }),
    );
    expectLiteralInCodeSpan(rendered, LABEL_UNDERSCORE);
  });
});
