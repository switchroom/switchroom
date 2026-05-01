/**
 * End-to-end tests for the auto-fallback notification dispatcher
 * (#11 / #420 / #421).
 *
 * `auto-fallback.ts` returns a `FallbackPlan` (pure). This test
 * exercises the side-effecting half: given a plan, does the
 * dispatcher emit the right Bot API call to the owner chat?
 *
 * The pure plan logic itself is covered by `auto-fallback.test.ts`.
 * This file locks in the wiring so a regression in dispatch (wrong
 * parse_mode, missing link-preview disable, swallowed errors) is
 * caught here instead of going silent in production.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  dispatchFallbackNotification,
  type DispatchOutcome,
} from '../auto-fallback-dispatcher.js';
import type { FallbackPlan } from '../auto-fallback.js';
import { createFakeBotApi, errors, type FakeBot } from './fake-bot-api.js';

const OWNER = 'chat-owner';

let bot: FakeBot;

beforeEach(() => {
  bot = createFakeBotApi({ startMessageId: 200 });
});

function planExecuted(): FallbackPlan {
  return {
    kind: 'executed',
    previousSlot: 'default',
    newSlot: 'personal',
    resetAtMs: Date.now() + 60_000,
    notificationHtml:
      '⚠️ <b>Quota exhausted</b> on slot <code>default</code>. Switched to <code>personal</code>.',
    agentName: 'clerk',
    triggerReason: '429-response',
  };
}

function planExhaustedAll(): FallbackPlan {
  return {
    kind: 'exhausted-all',
    activeSlot: 'default',
    resetAtMs: Date.now() + 4 * 60 * 60_000,
    notificationHtml:
      '🚨 <b>All slots quota-exhausted</b> for clerk. Run /auth add to attach another subscription.',
    agentName: 'clerk',
  };
}

describe('dispatchFallbackNotification — happy path', () => {
  it('sends executed plan with HTML parse_mode + link preview disabled', async () => {
    const plan = planExecuted();
    const outcome = await dispatchFallbackNotification({
      bot,
      ownerChatId: OWNER,
      plan,
    });
    expect(outcome).toEqual<DispatchOutcome>({ kind: 'sent', messageId: 200 });
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
    const [chat, text, opts] = bot.api.sendMessage.mock.calls[0];
    expect(chat).toBe(OWNER);
    expect(text).toBe(plan.notificationHtml);
    expect(opts).toMatchObject({
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  });

  it('sends exhausted-all plan to owner chat', async () => {
    const plan = planExhaustedAll();
    const outcome = await dispatchFallbackNotification({
      bot,
      ownerChatId: OWNER,
      plan,
    });
    expect(outcome.kind).toBe('sent');
    const text = bot.api.sendMessage.mock.calls[0][1] as string;
    expect(text).toContain('All slots quota-exhausted');
    expect(text).toContain('clerk');
  });

  it('chat model reflects the sent message', async () => {
    await dispatchFallbackNotification({
      bot,
      ownerChatId: OWNER,
      plan: planExecuted(),
    });
    const sent = bot.messagesIn(OWNER);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('Quota exhausted');
    expect(sent[0].parse_mode).toBe('HTML');
  });
});

describe('dispatchFallbackNotification — no chat', () => {
  it('returns no-chat when ownerChatId is null', async () => {
    const outcome = await dispatchFallbackNotification({
      bot,
      ownerChatId: null,
      plan: planExecuted(),
    });
    expect(outcome).toEqual({ kind: 'no-chat' });
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('returns no-chat when ownerChatId is undefined (access.allowFrom empty)', async () => {
    const outcome = await dispatchFallbackNotification({
      bot,
      ownerChatId: undefined,
      plan: planExecuted(),
    });
    expect(outcome).toEqual({ kind: 'no-chat' });
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it('returns no-chat for empty string', async () => {
    const outcome = await dispatchFallbackNotification({
      bot,
      ownerChatId: '',
      plan: planExecuted(),
    });
    expect(outcome).toEqual({ kind: 'no-chat' });
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });
});

describe('dispatchFallbackNotification — error paths', () => {
  it('forbidden error (bot blocked) is reported via onError, never throws', async () => {
    bot.faults.next('sendMessage', errors.forbidden());
    const onError = vi.fn();
    const outcome = await dispatchFallbackNotification({
      bot,
      ownerChatId: OWNER,
      plan: planExecuted(),
      onError,
    });
    expect(outcome).toEqual({ kind: 'error' });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('flood-wait error is reported via onError, never throws', async () => {
    bot.faults.next('sendMessage', errors.floodWait(15));
    const onError = vi.fn();
    const outcome = await dispatchFallbackNotification({
      bot,
      ownerChatId: OWNER,
      plan: planExhaustedAll(),
      onError,
    });
    expect(outcome).toEqual({ kind: 'error' });
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('network error is reported via onError, never throws', async () => {
    bot.faults.next('sendMessage', errors.networkError('ECONNRESET'));
    const onError = vi.fn();
    const outcome = await dispatchFallbackNotification({
      bot,
      ownerChatId: OWNER,
      plan: planExecuted(),
      onError,
    });
    expect(outcome).toEqual({ kind: 'error' });
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('omitted onError still resolves cleanly on failure', async () => {
    bot.faults.next('sendMessage', errors.forbidden());
    // No onError supplied — should not throw, just return error outcome.
    const outcome = await dispatchFallbackNotification({
      bot,
      ownerChatId: OWNER,
      plan: planExecuted(),
    });
    expect(outcome).toEqual({ kind: 'error' });
  });
});
