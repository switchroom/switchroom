---
name: telegram-test-harness
description: >
  This skill should be used when the user asks to "test telegram", "test
  bot interactions", "mock the bot api", "write a telegram test", "test
  what users see in chat", "test progress card", "test the slot banner",
  "test soft-confirm", "test auto-fallback notification", "test pin
  behavior", or any variation on validating switchroom's Telegram-side
  output deterministically.
  Also use when the user mentions fake-bot-api, update-factory,
  bot-api.harness, GrammyError, e2e telegram, telegram regression
  test, or asks how to add a test for code that calls bot.api.* or
  handles incoming Telegram updates.
---

# Telegram test harness (switchroom)

Switchroom ships a deterministic test harness for Telegram interactions
at `telegram-plugin/tests/`. Use it to lock in the Bot API call
sequences switchroom emits — what the user actually sees in chat — so
regressions fail a test instead of going silent in production.

This skill is a quick-reference for that harness. The full guide lives
at [`telegram-plugin/tests/HARNESS.md`](../../telegram-plugin/tests/HARNESS.md).

## When to use this harness

- A function under test calls `bot.api.sendMessage` / `editMessageText`
  / `pinChatMessage` / `setMessageReaction` / etc.
- A function under test consumes Telegram `Update` objects (commands,
  callback queries, photos, forum-topic messages).
- You're touching code in `telegram-plugin/` and want to lock in what
  the user sees across a sequence of events.

## When NOT to use this harness

- Pure logic with no Bot API surface — write a plain unit test against
  the function (see `slot-banner.test.ts` vs `slot-banner-driver.e2e.test.ts`
  for the split).
- Real-Telegram rendering quirks (markdown parsing edge cases, link
  preview behaviour, emoji reflow on different clients) — only catchable
  by a real test bot. Out of harness scope.

## Two mocks, one decision

```
Need to assert on chat-model state across multiple calls
(pinned messages, message edits, deletions, reactions)?
  ├── yes → createFakeBotApi() from tests/fake-bot-api.ts
  └── no  → createMockBot() from tests/bot-api.harness.ts
```

`fake-bot-api.ts` carries an in-memory chat model and a fault-injection
DSL. `bot-api.harness.ts` is just `vi.fn()` stubs with sensible
defaults. Pick the lighter one when you don't need state.

## Quick start

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createFakeBotApi, errors, type FakeBot } from './fake-bot-api.js';

let bot: FakeBot;
beforeEach(() => { bot = createFakeBotApi({ startMessageId: 100 }); });

it('pins a banner when the slot becomes non-default', async () => {
  await refreshBanner({ bot, ownerChatId: 'c', /* ... */ });
  expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
  expect(bot.api.pinChatMessage).toHaveBeenCalledTimes(1);
  expect(bot.isPinned('c', 100)).toBe(true);
});

it('survives Telegram throwing 429 flood-wait', async () => {
  bot.faults.next('sendMessage', errors.floodWait(15));
  // ... assert the function recovers / surfaces the error gracefully
});
```

## Core APIs

### `createFakeBotApi({ startMessageId? })`

Returns a `FakeBot` with:

- `bot.api.*` — vi.fn-backed Bot API methods. Mutate the chat model on
  success, throw real `GrammyError` shapes on injected faults.
- `bot.state` — `{ sent, currentText, pinned, reactions, deleted }`
- `bot.faults.next(method, error, chat_id?)` — queue a one-shot fault
- `bot.messagesIn(chat_id)` — array of sent messages, oldest first
- `bot.textOf(message_id)` — current text after edits, or null
- `bot.isPinned(chat_id, message_id)` — boolean
- `bot.reset()` — wipe state + fault queue

### Update factories (`tests/update-factory.ts`)

```ts
makeMessageUpdate({ text, chat?, from?, message_thread_id?, ... })
makeTopicMessageUpdate({ text, message_thread_id, chat?, ... })
makeCallbackQueryUpdate({ data, chat?, from?, message_id?, ... })
makeMyChatMemberUpdate({ chat?, oldStatus?, newStatus?, ... })
makePhotoUpdate({ caption?, chat?, file_id?, ... })
makeDocumentUpdate({ file_name, mime_type?, chat?, ... })
```

All return real `Update` objects you can pass to `bot.handleUpdate()`
(grammy's production dispatch path).

### Pre-built error factories (`tests/fake-bot-api.ts → errors`)

```ts
errors.floodWait(retry_after?)         // 429 Too Many Requests
errors.notModified()                   // 400 message is not modified
errors.messageToEditNotFound()         // 400 message to edit not found
errors.messageToDeleteNotFound()       // 400 message to delete not found
errors.threadNotFound()                // 400 message thread not found
errors.forbidden()                     // 403 bot was blocked by user
errors.badRequest(description)         // generic 400
errors.networkError(reason?)           // fetch-level failure
```

These produce real `GrammyError` instances so production code's
`err instanceof GrammyError` checks fire correctly.

### Time control

```ts
import { microtaskFlush } from './bot-api.harness.js';

vi.useFakeTimers();
fireSomeAsyncOp();
await microtaskFlush();         // drain microtasks
vi.advanceTimersByTime(300);
await microtaskFlush();
expect(bot.api.editMessageText).toHaveBeenCalled();
```

## Naming convention

- `<feature>.test.ts` — pure-logic tests (no harness)
- `<feature>.e2e.test.ts` — drives an extracted handler against the
  fake bot (or real grammy bot via injected updates)

Example pairs:

- `slot-banner.test.ts` (pure decision) +
  `slot-banner-driver.e2e.test.ts` (Bot API dispatch)
- `auto-fallback.test.ts` (pure plan) +
  `auto-fallback-dispatcher.e2e.test.ts` (notification dispatch)

## Test-design checklist

Before writing the test, ask:

1. **Is this code testable as-is, or does it need a small extraction?**
   Module-global state in `gateway.ts` (e.g. `pinnedBannerState`,
   `activeTurnStartedAt`) usually means the side-effecting part should
   move to its own module that takes state as an argument. See
   `slot-banner-driver.ts` for the extraction pattern.
2. **What's the failure I want to catch?** Snapshot-style "the whole
   API call sequence" tests are noisy and churn on every minor
   refactor. Assert on semantic fields (chat_id, text content,
   parse_mode, pin/unpin presence).
3. **Which fault would matter in production?** Don't test every
   conceivable error path — pick the ones the function is *supposed*
   to handle (flood-wait retry, message-not-found cleanup, forbidden
   exit). The error factories tell you which ones are worth wiring.
4. **Is there an existing pure-logic test for this?** If yes, the e2e
   should focus on the wiring (which API calls fire in which order)
   rather than re-testing the decision logic.

## Anti-patterns

- **Hand-rolling a `BannerState` (or other handle types) with an
  arbitrary `message_id`** that the fake bot never saw. The fake throws
  `messageToEditNotFound` on edit, which is realistic. Either send a
  real message first to seed the chat model, or sequence the test as a
  natural lifecycle.
- **Patching `globalThis.fetch`** to intercept the real Bot API. Tests
  that do this couple to grammy internals; use `createFakeBotApi()`
  instead so grammy version bumps don't break tests.
- **Asserting on the entire payload** of a sendMessage call.
  Bot API adds optional fields over time and full-payload snapshots
  churn for no semantic reason. Assert on the semantic shape.

## See also

- `telegram-plugin/tests/HARNESS.md` — full guide
- `telegram-plugin/tests/fake-bot-api.test.ts` — meta-test of the fake;
  read first when adding new fake-bot capabilities
- `telegram-plugin/tests/streaming-e2e.test.ts` — worked example of a
  larger end-to-end test (PTY → stream_reply → done)
