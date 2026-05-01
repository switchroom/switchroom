# Telegram test harness

How to write deterministic integration tests for switchroom code that
talks to Telegram. Use this when you're touching anything that calls
`bot.api.*` or processes incoming Telegram updates.

## What's in the box

| File | Purpose |
|---|---|
| [`fake-bot-api.ts`](./fake-bot-api.ts) | Full mock of `bot.api.*`. Tracks chat model (sent[], pinned, reactions, deleted), supports fault injection with real `GrammyError` shapes. **Use this for sequence/lifecycle tests.** |
| [`bot-api.harness.ts`](./bot-api.harness.ts) | Lighter mock — just `vi.fn()` stubs with sensible defaults. **Use this when you only need to assert on call shapes**, not chat-model state. |
| [`update-factory.ts`](./update-factory.ts) | Typed factories for Telegram `Update` objects: text messages, callback queries, photos, documents, my_chat_member events, forum-topic messages. |
| [`fake-bot-api.test.ts`](./fake-bot-api.test.ts) | Self-test of the fake bot — if this ever breaks, every test that depends on it is suspect. |

## Decision: which mock?

```
Are you asserting on a sequence/state that spans multiple API calls?
  ├── yes → fake-bot-api.ts
  │         (use bot.messagesIn(), bot.isPinned(), bot.faults.next(...))
  └── no  → bot-api.harness.ts
            (use bot.api.sendMessage.mock.calls, .toHaveBeenCalledWith)
```

The two are intentionally separate so existing tests don't pay the
chat-model overhead and new tests don't lose realism.

## Patterns

### Pattern 1 — assert on outbound API calls

Most common. You're testing a function that sends/edits messages.

```ts
import { createFakeBotApi, errors } from './fake-bot-api.js';

it('pins a banner when slot changes', async () => {
  const bot = createFakeBotApi();
  await refreshBanner({ bot, ownerChatId: 'c', /* ... */ });
  expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
  expect(bot.api.pinChatMessage).toHaveBeenCalledTimes(1);
  expect(bot.isPinned('c', 500)).toBe(true);
});
```

### Pattern 2 — drive a real grammy bot via injected updates

When you want to test the *dispatcher* (which command handler fires for
which Update). The pattern: create a real `new Bot(token, { client })`
with a fetch-shim, then call `bot.handleUpdate(makeMessageUpdate(...))`.

See `streaming-e2e.test.ts` for a worked example. (Not always needed —
most tests can target the extracted handler directly with a fake bot.)

### Pattern 3 — fault injection

`fake-bot-api.ts` ships pre-built error factories matching real
GrammyError shapes:

```ts
bot.faults.next('sendMessage', errors.floodWait(15));      // 429
bot.faults.next('editMessageText', errors.notModified());   // 400
bot.faults.next('pinChatMessage', errors.forbidden());      // 403
bot.faults.next('sendMessage', errors.networkError());      // fetch fail
```

Faults are FIFO per method. Pull-once semantics — a fault fires on the
next matching call and is consumed.

### Pattern 4 — time control

Pair `vi.useFakeTimers()` with `microtaskFlush()` from
`bot-api.harness.ts` for deterministic async settling:

```ts
vi.useFakeTimers();
fireStreamReply({ chat_id: 'c', text: 'partial' }); // doesn't await
await microtaskFlush();
vi.advanceTimersByTime(300);
await microtaskFlush();
expect(bot.api.editMessageText).toHaveBeenCalled();
```

### Pattern 5 — multi-chat / forum-topic isolation

`update-factory.ts` exposes both private and forum chat defaults:

```ts
import { makeMessageUpdate, makeTopicMessageUpdate } from './update-factory.js';

const dm = makeMessageUpdate({ text: '/auth status' });
const topicA = makeTopicMessageUpdate({ text: '/auth status', message_thread_id: 10 });
const topicB = makeTopicMessageUpdate({ text: '/auth status', message_thread_id: 20 });
```

`fake-bot-api.ts` keys its chat-model by `chat_id`, not `(chat_id,
thread_id)`. For per-thread isolation tests, assert on the `args` of
the call (e.g. `expect(call[2].message_thread_id).toBe(10)`).

## Coverage gaps & TODOs

These are deliberately not covered by the harness today; revisit when
the underlying feature lands or stabilises:

- **#479 — pre-alloc placeholder in groups**: write the test once
  PR #487's gateway fix lands. Without the fix, asserting "placeholder
  fires in groups" fails on main.
- **Forum-topic per-pin isolation**: `slot-banner.ts` is single-chat,
  single-banner per gateway process (v1 scope of #421). When per-topic
  pinning lands, extend `BannerState` to be keyed by `(chat,thread)` and
  add isolation tests.
- **Real Telegram rendering** (markdown/HTML parse, link previews,
  emoji reflow): not catchable by any HTTP-level mock. A nightly real-
  test-bot smoke job is the proper home; out of scope for this harness.

## Where to add new e2e tests

Naming convention: `<feature>.e2e.test.ts` for tests that drive an
extracted handler against `fake-bot-api.ts`. Examples already in repo:

- `slot-banner-driver.e2e.test.ts` — banner pin/edit/unpin lifecycle
- `auto-fallback-dispatcher.e2e.test.ts` — quota notification dispatch
- `streaming-e2e.test.ts` — PTY → stream_reply → done sequencing

Keep pure-logic tests in `<feature>.test.ts` (no `.e2e`). Examples:

- `slot-banner.test.ts` — pure `decideBannerAction` state machine
- `auto-fallback.test.ts` — pure `evaluateFallbackTrigger` /
  `performAutoFallback` plan logic
- `auth-slot-commands.test.ts` — `parseAuthSubCommand` decoder

The split keeps the e2e tests fast (no harness boot per pure-logic
case) and the pure tests honest (no accidental coupling to bot calls).

## Anti-patterns

- **Don't hand-roll a `BannerState` with an arbitrary `messageId`** and
  expect editMessageText to succeed. The fake bot tracks sent ids and
  throws `messageToEditNotFound` for unknown ones (this is realistic).
  Either send a message first to seed the chat model, or use the
  natural sequence (call refreshBanner once to pin, then test the next
  transition).
- **Don't bypass `fake-bot-api.ts` and patch `globalThis.fetch`** to
  intercept the real Bot API. Tests that do this couple to grammy
  internals and break on grammy version bumps.
- **Don't assert on the entire Telegram payload** — assert on the
  semantic fields (chat_id, text, parse_mode). Bot API adds optional
  fields over time and full-payload snapshots churn.
