/**
 * End-to-end tests for the slot-banner driver (#421).
 *
 * Drives `refreshBanner` against the chat-model-tracking
 * `fake-bot-api` so we lock in the actual Bot API call sequence the
 * gateway emits — not just the pure decision in `slot-banner.ts`.
 *
 * Each test walks one transition (no-banner → pinned, pinned → edited,
 * pinned → unpinned) and asserts both the call shape and the returned
 * BannerState the gateway will hold for the next refresh.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { refreshBanner } from '../slot-banner-driver.js';
import type { BannerState } from '../slot-banner.js';
import { createFakeBotApi, errors, type FakeBot } from './fake-bot-api.js';

const OWNER = 'chat-owner';
const AGENT = 'clerk';
const DEFAULT = 'default';

let bot: FakeBot;

beforeEach(() => {
  bot = createFakeBotApi({ startMessageId: 100 });
});

describe('refreshBanner — transitions from clean state', () => {
  it('on default slot with no prior state, does nothing (no API calls, returns null)', async () => {
    const next = await refreshBanner({
      bot,
      ownerChatId: OWNER,
      agentName: AGENT,
      currentSlot: DEFAULT,
      defaultSlot: DEFAULT,
      prevState: null,
    });
    expect(next).toBeNull();
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
    expect(bot.api.pinChatMessage).not.toHaveBeenCalled();
  });

  it('on null active slot (failed to read), treats as default — no banner', async () => {
    const next = await refreshBanner({
      bot,
      ownerChatId: OWNER,
      agentName: AGENT,
      currentSlot: null,
      defaultSlot: DEFAULT,
      prevState: null,
    });
    expect(next).toBeNull();
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('on non-default slot with no prior state, sends + pins, returns state', async () => {
    const next = await refreshBanner({
      bot,
      ownerChatId: OWNER,
      agentName: AGENT,
      currentSlot: 'personal',
      defaultSlot: DEFAULT,
      prevState: null,
    });
    expect(next).not.toBeNull();
    expect(next?.slot).toBe('personal');
    expect(next?.messageId).toBe(100);
    // sendRichMessage + pinChatMessage called in that order (#2669).
    expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(bot.api.pinChatMessage).toHaveBeenCalledTimes(1);
    const sendArgs = bot.api.sendRichMessage.mock.calls[0];
    expect(sendArgs[0]).toBe(OWNER);
    const md = (sendArgs[1] as { markdown: string }).markdown;
    expect(md).toContain('clerk');
    expect(md).toContain('personal');
    // Pin call should disable notifications so users don't get pinged.
    const pinArgs = bot.api.pinChatMessage.mock.calls[0];
    expect(pinArgs[2]).toMatchObject({ disable_notification: true });
    // Chat model also reflects the pin.
    expect(bot.isPinned(OWNER, 100)).toBe(true);
  });
});

describe('refreshBanner — transitions from pinned state', () => {
  // Seed the chat model with a real pin (matches gateway's first-pin path),
  // then run subsequent transitions against it. Avoids the fake-bot's
  // realistic "edit on unknown message_id throws not-found" behaviour
  // that would fire if we hand-rolled a BannerState referencing an id
  // the fake never saw.
  let prior: BannerState;
  beforeEach(async () => {
    const seeded = await refreshBanner({
      bot,
      ownerChatId: OWNER,
      agentName: AGENT,
      currentSlot: 'personal',
      defaultSlot: DEFAULT,
      prevState: null,
    });
    if (!seeded) throw new Error('failed to seed prior state');
    prior = seeded;
    // Reset the spy counts so the under-test transition starts from zero.
    bot.api.sendMessage.mockClear();
    bot.api.sendRichMessage.mockClear();
    bot.api.editMessageText.mockClear();
    bot.api.pinChatMessage.mockClear();
    bot.api.unpinChatMessage.mockClear();
  });

  it('same slot is a noop (no API calls, state preserved)', async () => {
    const next = await refreshBanner({
      bot,
      ownerChatId: OWNER,
      agentName: AGENT,
      currentSlot: 'personal',
      defaultSlot: DEFAULT,
      prevState: prior,
    });
    expect(next).toEqual(prior);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
    expect(bot.api.editMessageText).not.toHaveBeenCalled();
    expect(bot.api.unpinChatMessage).not.toHaveBeenCalled();
  });

  it('different non-default slot edits in place, advances state', async () => {
    const next = await refreshBanner({
      bot,
      ownerChatId: OWNER,
      agentName: AGENT,
      currentSlot: 'work',
      defaultSlot: DEFAULT,
      prevState: prior,
    });
    expect(next).toEqual({ messageId: prior.messageId, slot: 'work' });
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
    expect(bot.api.sendRichMessage).not.toHaveBeenCalled();
    const editArgs = bot.api.editMessageText.mock.calls[0];
    expect(editArgs[0]).toBe(OWNER);
    expect(editArgs[1]).toBe(prior.messageId);
    // #2669: the edit carries the rich { markdown } wrapper, not a string.
    expect((editArgs[2] as { markdown: string }).markdown).toContain('work');
  });

  it('return to default slot unpins, clears state', async () => {
    const next = await refreshBanner({
      bot,
      ownerChatId: OWNER,
      agentName: AGENT,
      currentSlot: DEFAULT,
      defaultSlot: DEFAULT,
      prevState: prior,
    });
    expect(next).toBeNull();
    expect(bot.api.unpinChatMessage).toHaveBeenCalledTimes(1);
    expect(bot.api.unpinChatMessage.mock.calls[0]).toEqual([OWNER, prior.messageId]);
  });

  it('null active slot (failure to read) also unpins', async () => {
    const next = await refreshBanner({
      bot,
      ownerChatId: OWNER,
      agentName: AGENT,
      currentSlot: null,
      defaultSlot: DEFAULT,
      prevState: prior,
    });
    expect(next).toBeNull();
    expect(bot.api.unpinChatMessage).toHaveBeenCalledTimes(1);
  });
});

describe('refreshBanner — full lifecycle (sequenced)', () => {
  it('walks no-banner → personal → work → default → noop', async () => {
    let state: BannerState | null = null;

    // 1. Initial — quota fired, swapped to personal.
    state = await refreshBanner({
      bot,
      ownerChatId: OWNER,
      agentName: AGENT,
      currentSlot: 'personal',
      defaultSlot: DEFAULT,
      prevState: state,
    });
    expect(state?.slot).toBe('personal');

    // 2. Slot moved again (manual /auth use work).
    state = await refreshBanner({
      bot,
      ownerChatId: OWNER,
      agentName: AGENT,
      currentSlot: 'work',
      defaultSlot: DEFAULT,
      prevState: state,
    });
    expect(state?.slot).toBe('work');
    expect(state?.messageId).toBe(100); // edited in place, same id

    // 3. Operator returned to default.
    state = await refreshBanner({
      bot,
      ownerChatId: OWNER,
      agentName: AGENT,
      currentSlot: DEFAULT,
      defaultSlot: DEFAULT,
      prevState: state,
    });
    expect(state).toBeNull();

    // 4. Repeat default → still noop.
    state = await refreshBanner({
      bot,
      ownerChatId: OWNER,
      agentName: AGENT,
      currentSlot: DEFAULT,
      defaultSlot: DEFAULT,
      prevState: state,
    });
    expect(state).toBeNull();

    // Final tally on the chat model.
    expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1);
    expect(bot.api.unpinChatMessage).toHaveBeenCalledTimes(1);
    expect(bot.api.pinChatMessage).toHaveBeenCalledTimes(1);
    // After unpin, isPinned returns false.
    expect(bot.isPinned(OWNER, 100)).toBe(false);
  });
});

describe('refreshBanner — error paths', () => {
  it('pinChatMessage failure after sendMessage success preserves prior state', async () => {
    // Why: gateway must not claim a message_id it never managed to pin —
    // the next refresh would think a banner exists and try to edit it.
    bot.faults.next('pinChatMessage', errors.badRequest('chat not found', 'pinChatMessage'));
    const onError = vi.fn();
    const next = await refreshBanner({
      bot,
      ownerChatId: OWNER,
      agentName: AGENT,
      currentSlot: 'personal',
      defaultSlot: DEFAULT,
      prevState: null,
      onError,
    });
    expect(next).toBeNull(); // prior state was null, preserved
    expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(bot.api.pinChatMessage).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('pin', expect.any(Error));
  });

  it('sendRichMessage failure surfaces but does not throw', async () => {
    bot.faults.next('sendRichMessage', errors.forbidden('sendRichMessage'));
    const onError = vi.fn();
    const next = await refreshBanner({
      bot,
      ownerChatId: OWNER,
      agentName: AGENT,
      currentSlot: 'personal',
      defaultSlot: DEFAULT,
      prevState: null,
      onError,
    });
    expect(next).toBeNull();
    expect(onError).toHaveBeenCalledWith('pin', expect.any(Error));
    // pinChatMessage never reached because sendMessage failed first.
    expect(bot.api.pinChatMessage).not.toHaveBeenCalled();
  });

  it('editMessageText failure preserves prior state (next refresh tries again)', async () => {
    const PRIOR: BannerState = { messageId: 7, slot: 'personal' };
    bot.faults.next('editMessageText', errors.messageToEditNotFound());
    const onError = vi.fn();
    const next = await refreshBanner({
      bot,
      ownerChatId: OWNER,
      agentName: AGENT,
      currentSlot: 'work',
      defaultSlot: DEFAULT,
      prevState: PRIOR,
      onError,
    });
    expect(next).toEqual(PRIOR); // unchanged
    expect(onError).toHaveBeenCalledWith('edit', expect.any(Error));
  });

  it('unpinChatMessage failure still drops the claim (returns null)', async () => {
    // Out-of-band unpin (operator did it) is the most common cause —
    // re-pinning would surprise the user.
    const PRIOR: BannerState = { messageId: 7, slot: 'personal' };
    bot.faults.next('unpinChatMessage', errors.badRequest('message to unpin not found', 'unpinChatMessage'));
    const onError = vi.fn();
    const next = await refreshBanner({
      bot,
      ownerChatId: OWNER,
      agentName: AGENT,
      currentSlot: DEFAULT,
      defaultSlot: DEFAULT,
      prevState: PRIOR,
      onError,
    });
    expect(next).toBeNull();
    expect(onError).toHaveBeenCalledWith('unpin', expect.any(Error));
  });
});

describe('refreshBanner — banner content', () => {
  it('contains agent name, current slot, and failover-from default', async () => {
    await refreshBanner({
      bot,
      ownerChatId: OWNER,
      agentName: 'klanker',
      currentSlot: 'backup',
      defaultSlot: 'default',
      prevState: null,
    });
    const rich = bot.api.sendRichMessage.mock.calls[0][1] as { markdown: string };
    const text = rich.markdown;
    expect(text).toContain('klanker');
    expect(text).toContain('backup');
    expect(text).toContain('default');
    expect(text.toLowerCase()).toMatch(/failover/);
  });

  it('markdown-escapes emphasis specials in agent name; slot names ride in code spans (#2669)', async () => {
    await refreshBanner({
      bot,
      ownerChatId: OWNER,
      agentName: 'a_b*c',
      currentSlot: 'slot_1',
      defaultSlot: 'def_2',
      prevState: null,
    });
    const rich = bot.api.sendRichMessage.mock.calls[0][1] as { markdown: string };
    const text = rich.markdown;
    // The agent name is bolded — its emphasis specials are escaped.
    expect(text).toContain('**a\\_b\\*c**');
    // Slot names ride in `code spans` — literal, never escaped.
    expect(text).toContain('`slot_1`');
    expect(text).toContain('`def_2`');
  });

  it('sends via the rich path (no parse_mode, no link_preview_options) #2669', async () => {
    await refreshBanner({
      bot,
      ownerChatId: OWNER,
      agentName: AGENT,
      currentSlot: 'personal',
      defaultSlot: DEFAULT,
      prevState: null,
    });
    // The banner ships raw GFM markdown via sendRichMessage — no parse_mode,
    // and sendRichMessage doesn't accept link_preview_options (it's omitted).
    expect(bot.api.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
    const opts = bot.api.sendRichMessage.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.parse_mode).toBeUndefined();
    expect(opts.link_preview_options).toBeUndefined();
    expect(opts.disable_notification).toBe(true);
  });
});
