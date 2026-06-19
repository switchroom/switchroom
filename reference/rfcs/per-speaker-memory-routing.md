---
artefact: Per-speaker memory routing — recall the right user's bank by Telegram sender
serves: jobs/remember-across-sessions.md
relates: jobs/run-a-fleet-of-specialists.md, jobs/feel-like-a-colleague.md
backs: single-tenant
status: proposal (2026-06-19) — design + effort, gate cleared, not yet scheduled
---

# Per-speaker memory routing

When an agent serves more than one trusted user, its memory recall should
surface **the speaker's** context, not a blended pool of everyone the agent
talks to. This RFC records how to do that, why it's now in scope, and what
it costs.

## Why — the job and the invariant

Serves [`remember-across-sessions`](../jobs/remember-across-sessions.md):
the agent brings back *the right* facts in the moment. With multiple users
on one agent, "the right facts" is speaker-dependent — Lisa's preferences
are noise in a turn with Ken, and vice-versa. Two payoffs at once:

1. **Privacy / relevance** — one user's memories don't bleed into another
   user's recall context.
2. **Token efficiency** — recall budget (8 memories / 1024 tokens at
   switchroom's `low` default) isn't spent surfacing the wrong user's
   irrelevant memories.

Both are exactly the property the [`single-tenant`](../invariants.md#single-tenant)
invariant now names: *"agents should isolate memory per user and respect
user memory privacy."*

## The invariant gate — cleared

Routing data by human identity *looks* like multi-tenancy, so it has to
pass the by-construction test. It does, because:

- It stays **one tenant** — every bank is the operator's data, in the
  operator's hindsight instance, fully visible to the operator. A per-user
  bank is a *recall scope*, not a private silo the operator can't see.
- It is **additive recall scoping, never authorization.** Who may drive an
  agent stays the per-agent `allowFrom` assignment in `switchroom.yaml`,
  unchanged. The sender→bank hint must never widen or gate who can talk to
  the agent.

If a future change tries to make per-user routing an *isolation-from-the-operator*
or an *access-control* boundary, that change — not this one — trips the
invariant.

## How it works — the plumbing already exists

The hard parts (per-message transport, envelope parsing, multi-bank recall)
are already built and hardened. This is plumbing, not new architecture.

### 1. The sender identity already reaches the recall hook

Every Telegram inbound is wrapped in a `<channel source="telegram"
chat_id="…" user="…" …>` envelope before it reaches the `claude` session.
The gateway emits the sender per-message:

(Citations are symbol-based — line numbers in these files drift.)

- `handleInbound` (`telegram-plugin/gateway/gateway.ts`) captures `ctx.from`.
- It assembles the `InboundMessage` carrying `userId: from.id` plus
  `meta.user` (= `from.username ?? String(from.id)`) and `meta.user_id`
  (= `String(from.id)`). `InboundMessage`
  (`telegram-plugin/gateway/ipc-protocol.ts`) declares `userId` / `user` /
  `meta` as first-class fields.
- The bridge's `onInbound` (`telegram-plugin/bridge/bridge.ts`) forwards
  `meta` whole to the session; the unmodified `claude` CLI renders meta keys
  as attributes of the channel tag (documented in `bridge.ts` and
  `telegram-plugin/channel-envelope-safety.ts`).

So the speaker is **physically in the prompt text** the recall hook reads
from stdin (`vendor/hindsight-memory/scripts/recall.py`). The hook already
parses sibling attributes out of that same envelope head —
`extract_chat_id_from_prompt` / `extract_topic_from_prompt` in
`vendor/hindsight-memory/scripts/lib/gateway_ipc.py`.

### 2. Multi-bank recall is already built

`recall.py` reads `recallAdditionalBanks` (a list; default in
`scripts/lib/config.py`) and, for each entry, does a separate recall and
merges the results (the additional-banks loop in `recall.py`). It's
production-hardened: the cache key includes the extra banks, each extra bank
has an 8 s timeout with headroom inside the 12 s hook ceiling, and a failed
extra-bank recall is non-fatal. `derive_bank_id` (`scripts/lib/bank.py`)
even has a `user` granularity segment already — it just sources the user
from a *static boot-time* env (`HINDSIGHT_USER_ID`), not the per-message
sender. That static-vs-per-message gap is the entire feature.

### 3. There is a 1:1 precedent: `HINDSIGHT_TOPIC_ALIASES_JSON`

Topic-aliasing already does the exact shape we need: a **static
env-injected JSON map** + a **per-message value extracted from the
envelope** → resolve a routing key (`HINDSIGHT_TOPIC_ALIASES_JSON`, read in
`recall.py`, injected via `profiles/_base/start.sh.hbs`, generated in
`src/agents/scaffold.ts`).
Per-sender bank routing reuses this verbatim, keyed on `user` instead of
topic.

## The change

1. **Vendor hook** (`vendor/hindsight-memory/`, as marked
   `# Switchroom-local:` additions — the existing convention):
   - Add `extract_user_from_prompt(prompt)` to `gateway_ipc.py` (a ~3-line
     sibling of the chat-id/topic extractors).
   - In `recall.py`, after deriving `bank_id`, look the sender up in a
     switchroom-provided map and **append the resolved bank to
     `additional_banks`** (additive — the agent's own bank is still
     recalled).
   - Add the sender to `_cache_key` so two speakers in one session with the
     same prompt don't collide on the recall cache.
   - Add sender / sender-bank fields to the recall log for observability.

2. **Config surface** — a new `memory.recall.sender_banks` map in
   `src/config/schema.ts`, cascaded by the existing `memory.recall`
   deep-merge in `src/config/merge.ts`:

   ```yaml
   memory:
     recall:
       sender_banks:
         "@lisa":      lisa-profile
         "123456789":  ken-profile   # numeric user_id also works
   ```

3. **Scaffold + boot** — serialize the map to a new
   `HINDSIGHT_SENDER_BANKS_JSON` env in `src/agents/scaffold.ts` +
   `start.sh.hbs`, mirroring the topic-aliases wiring 1:1.

## The dependency you can't skip

Routing is **inert without a write side** — something must *create and
populate* the per-user banks. That is the same write-path gap as the
shared-user-profile work: an operator-authored profile (`switchroom memory
profile`-style command) that retains facts into a named bank. **Build the
write path first**, or routing has nothing to route to.

Recommended sequence:
1. **This RFC** — clears the gate, records the design.
2. **Write path** (a profile-authoring command + bank creation) — ~1–1.5 h.
3. **Routing** (this RFC's change) — ~1.5–2 h, the cheap part once banks exist.

## Caveats — decide up front

- **Supergroup multi-speaker cache.** In a forum topic many users share one
  session; the recall cache keys on `session_id + prompt + bank`. The sender
  **must** become part of the cache key or recall serves one speaker's hits
  to another. (Included above; easiest thing to miss.)
- **`vendor/` is third-party.** The resolution logic must live in the hook
  (only the hook sees the per-message sender), so it's a vendor patch with
  an upstream-sync note, landed as marked `# Switchroom-local:` additions.
- **Username vs numeric id.** `user=` is `from.username ?? String(from.id)`
  — username-less senders key by numeric id. The map must accept both;
  normalize switchroom-side or document the key format.

## Effort

- **Routing (read side):** ~1.5–2 agent-hours (one PR), broken down: vendor
  hook + cache-key + telemetry ~30–40 min; schema + cascade ~15 min;
  scaffold/boot wiring ~20 min; tests ~15–20 min; docs ~15 min.
- **Write side (populate banks):** ~1–1.5 h, shared with shared-user-profile.

## Out of scope / non-goals

- **Per-user *authorization*.** Access stays in `allowFrom`. The sender hint
  never gates who can drive the agent.
- **Isolation from the operator.** The operator owns the tenant and sees
  every bank.
- **Cross-tenant anything.** Forbidden by `single-tenant`.
- **Per-user grant scoping in the approval kernel** — already deferred there
  (grants are unit-scoped); unaffected by this RFC.

## Open questions

1. **Default behaviour when a sender has no mapped bank** — fall through to
   the agent's own bank only (recommended), or to a shared default profile?
2. **Retain side** — should retains *also* route per-sender (a user's facts
   written into their bank), or is per-sender routing recall-only for v1?
   Recall-only is simpler and still delivers the relevance/token win;
   per-sender retain is the natural Phase 2.
3. **Map key normalization** — username, numeric id, or both, and who owns
   normalizing it (gateway vs hook).
