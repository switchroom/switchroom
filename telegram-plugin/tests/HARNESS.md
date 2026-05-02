# Telegram test harness

How to write deterministic integration tests for switchroom code that
talks to Telegram. Use this when you're touching anything that calls
`bot.api.*` or processes incoming Telegram updates.

## What's in the box

| File | Purpose |
|---|---|
| [`fake-bot-api.ts`](./fake-bot-api.ts) | Full mock of `bot.api.*`. Tracks chat model (sent[], pinned, reactions, deleted), supports fault injection with real `GrammyError` shapes, optional `holdNext` for in-flight ordering tests, optional `validateParseMode` for catching malformed MarkdownV2. **Use this for sequence/lifecycle tests.** |
| [`bot-api.harness.ts`](./bot-api.harness.ts) | Lighter mock — just `vi.fn()` stubs with sensible defaults. **Use this when you only need to assert on call shapes**, not chat-model state. |
| [`update-factory.ts`](./update-factory.ts) | Typed factories for Telegram `Update` objects: text messages, edited messages, message reactions, callback queries, photos, documents, my_chat_member events, forum-topic messages. |
| [`waiting-ux-harness.ts`](./waiting-ux-harness.ts) | Phase 1: real `StatusReactionController` + real `ProgressDriver` + recording fake bot + fake clock. Pin the four waiting-UX deadlines (Class A/B/C/F1–F4) under `vi.useFakeTimers()`. |
| [`real-gateway-harness.ts`](./real-gateway-harness.ts) | Phase 3: wraps `waiting-ux-harness` with the real production `InboundCoalescer` and real `flushOnAgentDisconnect`. IPC lifecycle simulation (`bridgeConnect`/`bridgeDisconnect`), opt-in `withDedup` for replay-suppression tests. **The default home for new lifecycle/timing tests.** |
| [`fake-bot-api.test.ts`](./fake-bot-api.test.ts) | Self-test of the fake bot — if this ever breaks, every test that depends on it is suspect. |

## Validation rule for new tests

**Every regression test must carry a `// fails when:` comment**
indicating the production change that would break the invariant. Then
mentally `git stash` that change and confirm the test fails. Without
this round-trip the test is theatre — it asserts what the code already
does, not what it must continue to do.

Example:

```ts
it('👍 fires AT-OR-AFTER last delivery', async () => {
  // fails when: a future refactor moves setDone() from the streamReply
  // post-await branch back to the JSONL turn_end handler — exactly
  // Bug D's failure mode.
  ...
})
```

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

## Pattern 7 — `holdNext`: park a call mid-flight

Some bugs are about ordering between an in-flight outbound and an
inbound event — the canonical example is Bug D (👍 fired while
`editMessageText` was still pending). Asserting "X happens BEFORE Y
resolves" with `vi.advanceTimersByTime` is fragile because the
production code's await boundaries shift with refactors.

`holdNext` parks the next matching call at a gate. The test fires the
unrelated event while the call is parked, then explicitly releases:

```ts
import { createFakeBotApi } from './fake-bot-api.js'

const bot = createFakeBotApi()
const r = await bot.api.sendMessage('c1', 'long enough text content', {})

// Park the next editMessageText call.
const hold = bot.holdNext('editMessageText', 'c1')

// Start the edit — promise pending until release.
const editPromise = bot.api.editMessageText('c1', r.message_id, 'updated', {})
await Promise.resolve() // let the call enter its await

expect(hold.triggered()).toBe(true)

// Fire the unrelated event while the edit is parked.
await bot.api.setMessageReaction('c1', r.message_id, [{ type: 'emoji', emoji: '👍' }])
expect(bot.state.reactions.length).toBe(1)
// Edit hasn't landed yet:
expect(bot.textOf(r.message_id)).toBe('long enough text content')

// Release — edit completes.
hold.release()
await editPromise
expect(bot.textOf(r.message_id)).toBe('updated')
```

`hold.release()` is the happy path; `hold.fail(err)` rejects the held
call with `err` if the test wants to simulate an in-flight failure.
`hold.triggered()` returns true once the held call enters its await —
useful for confirming "yes, the call is parked here" before firing the
follow-up event.

Holds are FIFO per method, just like faults. `bot.reset()` rejects any
unreleased holds so a leaked hold from one test doesn't hang the next.

## Pattern 8 — wired-in `OutboundDedupCache` for replay tests

The #546 bug class is "two paths emit the same content." The fix is
`OutboundDedupCache` (`telegram-plugin/recent-outbound-dedup.ts`) — a
process-wide cache keyed by `(chatId, threadId)` that suppresses
duplicate normalized content within a TTL.

The real-gateway harness wires this in opt-in:

```ts
import { createRealGatewayHarness } from './real-gateway-harness.js'

const h = createRealGatewayHarness({ withDedup: true })
const r1 = await h.send({ chat_id: CHAT, text: 'long content...' })
const r2 = await h.send({ chat_id: CHAT, text: 'long content...' }) // suppressed
expect(r2).toBeNull()
expect(h.dedupSuppressedCount()).toBe(1)
expect(h.dedup!.size(Date.now())).toBe(1)
```

`harness.send()` is the dedup-aware "fresh send" path — always issues
a new `sendMessage`, never edits. Use it in replay-dup tests where
"two messages with the same content" means two distinct user-visible
messages, not a streaming edit-in-place. (For streaming-edit
behavior, use `harness.streamReply()` as before.)

`simulateRetryDup({ chat_id, text })` is a one-line scenario for the
full #546 reproducer: send → bridge cycle → send again → assert
suppressed. See `real-gateway-i6-turn-flush-replay-dedup.test.ts`.

## Pattern 9 — opt-in `validateParseMode` lenient validator

Real Telegram returns 400 on unbalanced MarkdownV2. The fake accepts
any string by default to keep 167 existing tests passing. New tests
opt in:

```ts
const bot = createFakeBotApi({ validateParseMode: 'lenient' })
await expect(
  bot.api.sendMessage('c1', '*unbalanced markdown', { parse_mode: 'MarkdownV2' }),
).rejects.toMatchObject({ error_code: 400 })
```

Lenient mode catches the most common failure: unbalanced count of
marker characters (`*`, `_`, `` ` ``, `[`). Backslash-escaped markers
and content inside inline-code / fenced code blocks are exempt. It is
NOT a full Telegram parser — corner cases like nested entities or
custom emoji escapes won't trigger it. For those, use a real-DC
nightly job (out of scope for the in-process fake).

## Bug-class catalog

Each shipped bug class has a regression home. When fixing a new bug,
add the test next to its class. Update this table.

| Class | Example | Test home |
|---|---|---|
| Reaction timing desync | Bug D (👍 before delivery) | `real-gateway-ipc-lifecycle.test.ts` I3, `harness-ordering-invariants.test.ts` INV-1/INV-2 |
| IPC lifecycle leak | Bug A (anon disconnect flush) | `real-gateway-ipc-lifecycle.test.ts` I1, I2 |
| Legacy IPC type lethality | Bug B (`update_placeholder` crash) | `real-gateway-ipc-lifecycle.test.ts` I4 |
| Content-dup retry | #546 (turn-flush + replay) | `real-gateway-i6-turn-flush-replay-dedup.test.ts` |
| Respawn dedup defense | Bug C (wake-audit) | `real-gateway-i6-turn-flush-replay-dedup.test.ts` I5(b); profile-side fix lives elsewhere |
| Edit-on-deleted | latent | `harness-ordering-invariants.test.ts` INV-3 |
| Parse-mode malformed | latent | `harness-parse-mode-validation.test.ts` |
| Update factory shape | latent | `update-factory-edited-and-reactions.test.ts` |

## Pattern 6 — fixture-based integration tests for external-format parsers

When code parses output produced by an **external system you don't
control** (Claude Code's TUI, the Anthropic API stream-json, journalctl
output, `git log` text), unit tests with synthesised input are not
enough. The synthesis matches the test author's mental model of the
format — but the real format drifts on every upstream release, and
synthesised tests can't catch the drift.

**Lesson learned the hard way (PR #486):** `pty-tail.ts`'s
`V1Extractor` was tested against synthesised Claude Code TUI output
that "matched the real shape." Then Claude Code collapsed tool-call
rendering by default, the marker `switchroom-telegram - reply` stopped
appearing in the buffer, and V1Extractor silently started returning
null on every call. The IPC plumbing tests still passed (they fed
mock data); the bridge → gateway wiring tests still passed (they fed
mock partials). The only failure mode that matters — "in production,
does this actually emit anything?" — wasn't covered by any test.

**Pattern**: capture a real chunk of the external format as a fixture
and assert the parser produces a non-null result.

```ts
// telegram-plugin/tests/fixtures/service-log-current-claude-code.bin
//   ← captured via: tail -c 30000 ~/.switchroom/agents/<agent>/service.log

import { readFileSync } from 'node:fs'
const FIXTURE = readFileSync(
  resolve(__dirname, 'fixtures', 'service-log-current-claude-code.bin'),
  'utf8',
)

it('extractor handles current production output', async () => {
  const term = await feedToTerm(FIXTURE)
  const result = new V1Extractor().extract(term)
  expect(result).not.toBeNull()
})
```

**Maintenance**: when upstream's format changes the test fails. The
failure tells you exactly what changed (message includes the byte
range that no longer matches). Either:

1. The format reverted (CI flake, just rerun)
2. The format drifted (update the parser AND recapture the fixture)
3. The feature stops working (remove the parser + dependents,
   document why)

**Where to capture from**: the canonical source for each external
format. For PTY-tail it's `~/.switchroom/agents/<agent>/service.log`.
For Anthropic API stream-json it'd be a saved `--output-format
stream-json` dump. For journalctl, a captured `--since … -o cat`
window.

See `telegram-plugin/tests/pty-tail-real-fixture.test.ts` for the
worked example.
