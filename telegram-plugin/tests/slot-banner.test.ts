import { describe, it, expect } from 'vitest';
import { decideBannerAction, formatBannerHtml, type BannerState } from '../slot-banner';

const DEFAULT = 'default';

describe('decideBannerAction — default state', () => {
  it('noop when on default and nothing pinned', () => {
    const action = decideBannerAction(null, DEFAULT, 'clerk', DEFAULT);
    expect(action.kind).toBe('noop');
  });

  it('noop when slot is null and nothing pinned', () => {
    const action = decideBannerAction(null, null, 'clerk', DEFAULT);
    expect(action.kind).toBe('noop');
  });

  it('unpins existing banner when slot returns to default', () => {
    const prev: BannerState = { messageId: 42, slot: 'personal' };
    const action = decideBannerAction(prev, DEFAULT, 'clerk', DEFAULT);
    expect(action).toEqual({ kind: 'unpin', messageId: 42 });
  });

  it('unpins existing banner when active slot becomes null', () => {
    const prev: BannerState = { messageId: 7, slot: 'work' };
    const action = decideBannerAction(prev, null, 'clerk', DEFAULT);
    expect(action).toEqual({ kind: 'unpin', messageId: 7 });
  });
});

describe('decideBannerAction — non-default state', () => {
  it('pins fresh banner when nothing currently pinned', () => {
    const action = decideBannerAction(null, 'personal', 'clerk', DEFAULT);
    expect(action.kind).toBe('pin');
    if (action.kind === 'pin') {
      expect(action.slot).toBe('personal');
      expect(action.text).toContain('clerk');
      expect(action.text).toContain('personal');
      expect(action.text).toContain('default');
    }
  });

  it('edits when banner exists for a different slot', () => {
    const prev: BannerState = { messageId: 99, slot: 'personal' };
    const action = decideBannerAction(prev, 'work', 'clerk', DEFAULT);
    expect(action.kind).toBe('edit');
    if (action.kind === 'edit') {
      expect(action.messageId).toBe(99);
      expect(action.slot).toBe('work');
      expect(action.text).toContain('work');
    }
  });

  it('noops when banner already reflects current slot', () => {
    const prev: BannerState = { messageId: 12, slot: 'personal' };
    const action = decideBannerAction(prev, 'personal', 'clerk', DEFAULT);
    expect(action.kind).toBe('noop');
  });
});

describe('formatBannerHtml', () => {
  it('markdown-escapes emphasis specials in the agent name (#2669)', () => {
    // The agent name is interpolated into a **bold** run, so an emphasis
    // special in it must be backslash-escaped or it would break the run.
    // Slot names live in `code spans` (literal) and need no escaping.
    const text = formatBannerHtml('a_b*c', 'slot_1', 'def_2');
    expect(text).toContain('**a\\_b\\*c**');
    // Slot names ride in code spans verbatim (literal inside backticks).
    expect(text).toContain('`slot_1`');
    expect(text).toContain('`def_2`');
  });

  it('mentions the failover-from default for context', () => {
    const text = formatBannerHtml('clerk', 'personal', 'default');
    expect(text).toMatch(/failover from/i);
    expect(text).toContain('default');
  });
});
