# Clearing orphaned bot pins

The gateway pins things: the foreground activity card, worker feeds, the slot
banner (plus legacy `pin_message` tool pins from builds before that tool was
retired in #4452). A crash mid-turn can leave one of those pinned
forever — an **orphan**. The boot sweep
(`telegram-plugin/gateway/stale-pin-sweep.ts`) exists to drain them, and on a
current build it does so automatically. This page is for the residue it
deliberately cannot touch.

## What the automatic sweep will and will not do

A Telegram chat holds a **stack** of pinned messages. A bot cannot enumerate
it: `getChat().pinned_message` exposes only the top, and there is no list-pins
method. So the sweep is not a stack walk — in a group it unpins **exactly the
message ids the gateway is on record as having pinned**, from
`status-pins.json` plus the pinned activity cards.

That restriction is a correctness requirement, not caution.
`unpinAllChatMessages` clears a group's whole stack in one silent call, and
"whole stack" includes **other people's pins** — measured, it destroyed a
pre-existing pin that predated the test. In a real team chat that is
unrecoverable. A pin the gateway did not place is not the gateway's to remove.

The cost is a blind spot. An orphan the gateway has no record of — one left by
a build that predates durable pin records, or one whose store row was lost — is
invisible to the sweep and will never be cleared automatically. In the gateway
log it shows up as:

```
telegram gateway: stale-pin-sweep: chat=-100… thread=… kind=supergroup status=skipped-nothing-recorded …
```

`skipped-nothing-recorded` means "there is nothing here this gateway may
legitimately remove", not "the chat is clean". If you can still see a stale
pin in the chat after that line, it is an unrecorded orphan and one of the two
remedies below applies.

## Remedy 1 — unpin it by hand (default)

Fastest and safest, because you can see exactly what you are removing: in the
Telegram client, open the pinned-message bar, find the stale card, and unpin
it. Long-press → **Unpin** on mobile; the pin bar's context menu on desktop.

You need `can_pin_messages` in that chat, same as the bot. Nothing in
switchroom needs to be restarted — the sweep only ever removed pins it
recorded, so removing an unrecorded one behind its back cannot desynchronise
anything.

## Remedy 2 — the wholesale topic drain (opt-in, forum supergroups only)

For a forum topic with more orphans than you want to click through, a
deployment can opt into `unpinAllForumTopicMessages`:

```
SWITCHROOM_PIN_SWEEP_UNPIN_ALL_TOPIC=1
```

Set it in the agent's environment and restart the agent; the next boot sweep
uses it for `forum-topic` targets.

**Read this before you set it.** The verb is genuinely topic-scoped — it is
the only pin verb a bot has that takes a `message_thread_id` — but *within*
that topic it is indiscriminate: it removes every pin in the topic, including
ones the gateway never placed and ones a human deliberately pinned. That is why
it is off by default and why it is a remedy rather than a policy. Turn it on,
let one boot sweep run, turn it back off.

It also runs **once** per sweep, never in a loop: on a deep stack the unpin-all
family can peg at `429 retry_after: 3` with zero progress, because TDLib
services it through `run_affected_history_query_until_complete`, which re-issues
the identical query while the result is not final. Retrying that is not slow,
it is non-terminating. A 429 there is reported as `deferred-flood` and the
sweep yields to the next boot.

## What is deliberately not offered

There is no "unpin everything in this chat" switch and no automatic fallback
that clears an unrecorded orphan, because both would mean the gateway removing
pins it did not place. See
[#3960](https://github.com/switchroom/switchroom/issues/3960) for the full
reasoning, and `telegram-plugin/gateway/stale-pin-sweep.ts` for where it is
enforced.
