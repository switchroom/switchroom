---
artifact: per-agent Telegram supergroup mode
serves: talk-to-agents-from-anywhere
advances-outcome: always-available
status: Draft for ratification
---

# RFC: Per-agent Telegram supergroup mode

**Status:** Draft for ratification
**Author:** Claude (Opus 4.7), validated against `main` HEAD 2026-05-27
**Supersedes:** Ken's klanker-authored spec of 2026-05-27 (corrects topology and scope)

---

## What we're building

A per-agent opt-in mode where one agent owns its own Telegram supergroup with
forum topics, runs **multiple conversations in parallel across topics without
cross-topic blocking**, and routes scheduled / automated outbounds into named
topic lanes.

## Why, and what the actual pain is

The headline user pain is **parallel conversations**: talk to an agent in topic
A while a long-running turn in topic B continues. Today the gateway gates
inbound delivery on `activeTurnStartedAt.size > 0`, a **fleet-wide**
check. If any topic has an active turn, every other topic's inbound is
buffered until it ends. Two topics deadlock each other.

Secondary pain: automated noise (cron output, boot cards, vault/hostd grants,
compact cards) interleaves with conversation in one topic. Carving lanes
fixes the cosmetic complaint and, more importantly, makes the cron-can-target-
a-topic case (morning digest → `#planning`) ergonomic.

## What's already here: current topology

The original spec assumes klanker lives in a flat DM. It doesn't. The
existing topology is:

- `telegram.forum_chat_id` (global, one): one shared supergroup for the fleet.
- Each agent has `topic_name` + auto-assigned `topic_id`: its own topic in
  that shared supergroup. `topic-manager.ts` + `switchroom topics
  sync/list/cleanup` create and reconcile these.
- `dm_only: true` (per-agent): escape hatch, own bot token, private chat.
- `TELEGRAM_TOPIC_ID` env var filters inbound to a single topic per gateway
  instance (one gateway per agent).

So today's model is **one supergroup, N agents, each in ONE topic, +
DM-only override**. The new mode adds a third shape: **one agent owns a
supergroup with MANY topics**. v1 is one-agent-per-supergroup; multi-agent-
per-its-own-supergroup is explicitly deferred.

## Schema delta

No `mode:` enum. Mode is implied by config shape, additive, backward-compat.

```yaml
# Fleet-wide default supergroup (unchanged)
telegram:
  bot_token: vault:telegram-bot-token
  forum_chat_id: "-1001111111111"

agents:
  # Mode 1 — fleet shared supergroup (current default, unchanged)
  ziggy:
    topic_name: ziggy

  # Mode 2 — DM-only (existing dm_only, unchanged)
  carrie:
    dm_only: true
    topic_name: DM           # display label only

  # Mode 3 — NEW: owns its own supergroup with named topics
  klanker:
    topic_name: klanker      # legacy display label, kept for /status etc.
    channels:
      telegram:
        chat_id: "-1002222222222"   # OVERRIDES forum_chat_id for this agent
        default_topic_id: 1         # General — fallback for unclassified outbounds
        topic_aliases:              # operator-friendly names for cron / routing
          general: 1
          planning: 17
          cron: 23
          admin: 31
          alerts: 41

schedule:
  - cron: "0 8 * * 1-5"
    prompt: "Morning digest…"
    topic: planning          # NEW: alias or numeric, falls back to default_topic_id
```

**Validation rules:**
- `channels.telegram.chat_id` requires `default_topic_id`; must be `< 0`.
- `dm_only: true` forbids `channels.telegram.chat_id` / `default_topic_id` /
  `topic_aliases` / per-cron `topic:`.
- Per-cron `topic:` must resolve to a known alias or be a positive integer
  (validated at config-load against the resolved `topic_aliases` map).
- The cascade (defaults → profile → agent) merges `topic_aliases` per-key;
  agent overrides win, defaults + profile fill in unset keys.

## The structural refactor: what blocks parallel turns

Spec PR2 ("correctness fixes, ~2d") underestimates the surface. Trace below
distinguishes **CRITICAL** (parallel turns impossible without it) from **HIGH**
(silent wrong-topic routing) from **MEDIUM/LOW** (cosmetic).

| # | Surface | File | Issue | Class |
|---|---|---|---|---|
| 1 | `currentTurn` (module singleton) | `gateway.ts:~1072` | Only one active turn across the entire gateway. Must become `Map<ChatKey, Turn>`. ~100+ readers to thread. | CRITICAL |
| 2 | `activeTurnStartedAt.size > 0` gate | `gateway.ts:1380,1471,3932,7991,8930` | Fleet-wide inbound-delivery gate. Must become `.has(chatKey(chat,thread))`. | CRITICAL |
| 3 | `chatThreadMap` chatId→threadId fallback | `gateway.ts:1082,7998,1766` + 12 readers | Last-write-wins; outbound for topic A can resolve to topic B's thread if B's inbound arrived recently. Fix: kill the fallback; require explicit `message_thread_id` on outbound, sourced from the active turn's pinned ChatKey. | HIGH |
| 4 | `typingIntervals` / `turnTypingIntervals` chatId-keyed | `gateway.ts:1878,1926,1946,1954` | Topic A's typing indicator dies when topic B's turn ends (and vice-versa). Composite-key. | HIGH |
| 5 | `pendingReauthFlows` chatId-keyed | `gateway.ts:2129,8219,13032` | OAuth code pasted in topic B credited to topic A's pending reauth. Composite-key. | HIGH |
| 6 | Inbound-coalesce key `userId:chatId` | `inbound-coalesce.ts` | Two messages to different topics merge into one turn. Add threadId. | MEDIUM |
| 7 | 5-min restart wedge snapshot | `gateway.ts:7991` | Snapshot is fleet-wide (`.size > 0`). After fix #2, this becomes per-topic automatically. | (subsumed by #2) |
| 8 | `chat-lock` chatId-only serialization | `chat-lock.ts:13,52` | Forces cross-topic outbounds to serialize. Comment says "acceptable, noted" — **need your call** (see decisions). | DECISION |
| 9 | `lastPtyPreviewByChat`, `chatAvailableReactions` | `gateway.ts:1108,1156` | Shared dedup cache across topics; rare misfires. Composite-key. | LOW |
| 10 | `chatKey()` primitive exists but `stream-reply-handler.ts:308` reinvents it inline | `chat-key.ts:44` | Adopt + delete the duplicate; consider tightening the brand. | LOW |

Already-safe (composite-keyed today): `activeDraftStreams`, `activeStatusReactions`, `progressUpdateLastSent`, `pending-work-progress`, vault/permission state. Good, these are the pattern to extend.

## Outbound routing: by event class

The router decides which `message_thread_id` an autonomous (non-reply) outbound
lands on. Per-agent topic_aliases give operator-friendly names; falls back to
`default_topic_id` if alias unset.

**Routing principle (CPO call, ratified 2026-05-27):** smart split. Things
the operator triggered in a conversation follow the conversation. Things
the system or schedule triggered land in the ops lanes (`alerts` for
notification, `admin` for action-required).

| Event | Target topic | Fallback |
|---|---|---|
| Reply to user inbound (existing) | originating turn's `message_thread_id` | — (always present) |
| Sub-agent progress card | parent turn's `message_thread_id` | — |
| Cron-fired prompt | per-entry `topic:` | `default_topic_id` |
| Boot card / SessionStart | `alerts` alias | `default_topic_id` |
| Vault grant — **turn-initiated** (reply to user) | originating turn's `message_thread_id` | `default_topic_id` |
| Vault grant — **background** (cron, watchdog, scheduled) | `admin` alias | `default_topic_id` |
| Permission card (Claude Code tool-use) — turn-initiated | originating turn's `message_thread_id` | broadcast to `allowFrom` (today's behavior, fallback) |
| Permission card — background | `admin` alias | `default_topic_id` |
| Hostd approval card (always operator-initiated) | originating turn's `message_thread_id` | `admin` alias |
| Compact card / watchdog (system-initiated) | `alerts` alias | `default_topic_id` |
| **Query slash commands** (`/status`, `/help`, `/version`, `/auth`, `/usage`-light) | reply in originating topic | — |
| **Mutation slash commands** (`/restart`, `/update apply`, `/new`, `/stop`, `/agentstart`) | `admin` alias | originating topic |
| **Heavy-output slash commands** (`/logs`, `/upgradestatus`, `/audit`, `/memory <q>`, `/permissions`) | `admin` alias always | `default_topic_id` |
| **Approval-button callbacks** (`apv:…`, `/approve` `/deny` `/pending`) | reply where the card was (callback-driven, no change) | — |

Background/turn-initiated split requires the bridge to mark each outbound
event with its origin class (a single enum field). Already partly there:
`pendingVaultRequestAccesses` knows whether it was opened from a turn handler
or from a fire-and-forget scheduled task; just needs threading through to
the card-sender.

Emitter callsites: `gateway/boot-card.ts` (3 sites), vault grant cards,
hostd approval cards (already builds via approval-kernel), cron synthetic-
inbound builder (`src/scheduler/dispatch.ts`), compact card
(`gateway.ts:1639`). All already plumb `message_thread_id` conditionally;
the change is sourcing the value from `resolveOutboundTopic(agent, event,
ctx)` instead of `null`.

## General-topic Telegram quirk: the wrapper

Definitively answered (sources in research notes): General topic has `id=1`
at MTProto, but the Bot API `sendMessage` **rejects** `message_thread_id: 1`
with HTTP 400 "message thread not found." Inbound carries 1; outbound must
omit. The strip-1 wrapper goes at the existing chokepoint
(`chatLock.wrapBot` proxy in `chat-lock.ts:40-62`): single layer, no
callsite changes. Apply to both `sendMessage` AND `sendChatAction` (spec said
sendChatAction is exempt; that appears to be folklore, confirm with a 5-min
live test in UAT before locking). `editMessageText` doesn't take
`message_thread_id` at all (inferred from `message_id`), so progress-card
editing is unaffected.

## Memory: topic-aware metadata, single bank (CPO call, ratified)

Hindsight memory stays **per-agent, one bank** (preserves the
"one agent, one persona, one memory bank" principle from `reference/vision.md`).
The change: tag memories with the topic they were captured in, and inject
the active topic into the recall preamble so the model can self-filter.

**Retain path** (`vendor/hindsight-memory/scripts/retain.py` + the bridge):
- Extract `chat_id` + `thread_id` from the session's `<channel>` envelope.
- Pass them as fields in the `retain()` metadata bag:
  `metadata: { ..., chat_id, thread_id, topic_alias }` (topic_alias = the
  human-readable name from `topic_aliases`, if any).
- No schema migration needed; Hindsight already accepts arbitrary metadata.

**Recall path** (`recall.py`):
- Extract `chat_id` + `thread_id` from the prompt envelope (one regex
  addition; chat_id already parsed).
- Inject a one-line preamble: *"You are in topic `#planning`. Memories
  from other topics are shown for cross-context awareness; prefer
  topic-matched memories unless cross-topic relevance is obvious."*
- Cache key gets `(chat_id, thread_id)` appended to prevent cross-topic
  cache hits.

**Operator-felt behavior:**
- "Remember what I said about the launch" in #planning → agent recalls
  facts said in #planning first; cross-topic facts only surface if
  semantically obvious match.
- "What's the operator's email" → cross-topic fact (likely from #admin)
  still surfaces because it's clearly relevant.
- "Continue what we were discussing" → defaults to current topic only;
  cleanest case.

**Why not per-topic banks (Option C, rejected):** breaks reflection
("what do we know about the operator?" fractures across banks), breaks
the bank principle, and creates a bank explosion (N topics × M agents).

**Out of scope for v1:** UI for inspecting per-topic memory counts.
`switchroom memory recall-log <agent>` will already show the topic in
each recalled memory's metadata once tags are added. That's the inspection
surface for now.

## Two regressions to pull forward (CPO call, ratified; ship as standalone fleet PRs)

Surfaced in research; both affect the **existing** shared-supergroup
fleet, just less visibly. Ship as standalone PRs before / parallel to the
supergroup work.

1. **Boot card / SessionStart routing** — today posts to one hardcoded
   chat per agent. Under supergroup mode the operator may not see it. Fix:
   route via `resolveOutboundTopic()` (the same helper PR1 introduces),
   target `alerts` alias if present, else `default_topic_id`, else
   the existing single-chat behavior. Standalone PR, low risk.

2. **`/restart` marker collision** — `stampUserRestartReason` is a
   per-agent singleton (`gateway.ts:10242`). Two operators calling
   `/restart` concurrently get cross-attributed in the greeting card.
   Fix: re-key the marker by `chatKey(chat,thread)`. Standalone PR,
   small.

These don't require any of the supergroup scaffolding to land. They're
fleet bugs being shipped on their own merits.

## Migration path

Doc spec proposed `share_state_with: <name>` to run a shadow agent for A/B
soak. Recommend skipping that and using a simpler model:

1. Build the schema + structural refactor + outbound router behind no flag.
   Backward-compat: existing fleet agents keep working unchanged (no
   `channels.telegram.chat_id` set → fleet mode).
2. Create klanker's new supergroup; populate topic_aliases.
3. **Edit klanker's config in place**: flip from `topic_id` in the fleet
   supergroup to `channels.telegram.chat_id` + `default_topic_id`. Run
   `switchroom apply` + `switchroom agent restart klanker --wait`.
4. Hindsight memory bank is agent-scoped, not chat-scoped, so it survives. Vault
   grants keyed by agent+key, not chat, so they survive. DM history is in
   per-(chat,thread) SQLite; nothing is deleted on flip.
5. **Rollback**: edit the config back, restart. The DM/fleet topic is
   never deleted; messages are preserved both sides.

The `share_state_with` shadow-agent path is more complex than the underlying
risk. If we want a soak window, use a `klanker-test` agent with a separate
bot token pointing at the new supergroup; mirror one low-stakes cron for
1–2 weeks; flip the real klanker when confident. No new schema field needed.

## Decisions

### Ratified (CPO call, 2026-05-27)

1. ✅ **Memory scoping** — Option B: per-agent single bank, tagged with topic
   metadata, model self-filters via recall preamble. (See "Memory" section.)
2. ✅ **Approvals routing** — smart split: turn-initiated follow the
   conversation; background (cron/watchdog) go to `admin`.
3. ✅ **Slash commands routing** — smart split: queries reply in-place;
   mutations go to `admin`; heavy-output always to `admin`. (Supersedes
   round-1 decision #4 below.)
4. ✅ **Two fleet bugs pulled forward** — boot card routing fix and
   `/restart` marker collision shipped as standalone PRs, independent of
   supergroup direction.
5. ✅ **Topology** — one agent owns a supergroup; multi-agent-per-supergroup
   explicitly deferred. Default-topic + per-cron override.
6. ✅ **Cron/skills/MCP/hooks** — stay per-agent, no topic plumbing
   (research confirmed no breakage). Telegram-MCP already auto-routes
   `message_thread_id`. Cron synthetic-inbound already passes `threadId`.

### Ratified (CPO call, 2026-05-27 round 2)

7. ✅ **Parallel-turns scope = A (full refactor).** `currentTurn` becomes
   `Map<ChatKey, Turn>`, gate becomes per-topic. PR3 owns this.
8. ✅ **chat-lock granularity = B (per-(chat,topic)).** End-to-end
   parallelism at the API-call layer. Guardrail: verify grammY auto-retry
   transformer handles 429 cleanly with an explicit per-topic test in PR2.
9. ✅ **Inbound coalesce key = add threadId.** Each topic coalesces its
   1.5s window independently.

## PR decomposition (after ratification)

Conditional on decision #7 = A. **PR0 ships independently**; PR1–PR6
sequence the supergroup work.

| PR | Scope | Est | Ships independently? |
|---|---|---|---|
| **0a** | Boot card / SessionStart routing via `resolveOutboundTopic()` helper | ~0.5 day | **Yes** — fleet bug fix |
| **0b** | `/restart` marker collision fix (`stampUserRestartReason` per-ChatKey) | ~0.5 day | **Yes** — fleet bug fix |
| 1 | Schema delta + validator (`channels.telegram.chat_id` / `default_topic_id` / `topic_aliases`, per-cron `topic:`) + `resolveOutboundTopic()` helper | ~1 day | Yes (additive, no semantic change without other PRs) |
| 2 | Adopt `chatKey()` everywhere; composite-key the HIGH-class state (`chatThreadMap` kill, `typingIntervals`, `pendingReauthFlows`); composite-key inbound coalesce | ~2 days | Yes — fleet correctness wins today |
| 3 | **The big one** — refactor `currentTurn` → `Map<ChatKey, Turn>`; per-topic `activeTurnStartedAt` gate; thread Turn ref through MCP handlers; UAT for parallel-turn correctness | ~3 days | Gated work for supergroup |
| 4 | Outbound router + emitter refactors (vault/permission/hostd/cron/compact) per the routing table + General-topic strip-1 wrapper + sendChatAction live-test | ~2 days | After PR1 |
| 5 | Slash-command smart-split routing (queries in-place, mutations → admin, heavy → admin) — replaces blanket dm-command-gate rejection in agent-owned supergroups | ~1 day | After PR1 |
| 6 | Hindsight memory tagging (retain `chat_id`/`thread_id` metadata, recall preamble, cache key extension) | ~1 day | After PR1 (needs `topic_aliases` for the alias-name tag) |
| 7 | `switchroom telegram topics <chat_id>` discovery command (read SQLite buffer for distinct thread_ids) | ~0.5 day | Ergonomics; ship last |

**Ship order:** PR0a + PR0b first (fleet wins, no dependency). PR1 + PR2 next
(unblock the supergroup work + close more fleet bugs). PR3 is the gated work,
it is UAT-heavy. PR4 + PR5 + PR6 + PR7 are surface polish; can ship in any order
after PR3.

## Out of scope (v1)

- Multi-agent-per-supergroup (deferred, needs orchestrator routing layer)
- Per-topic system prompts / personas (violates "one agent, one persona")
- Per-topic memory bank sharding (violates "one agent, one bank")
- `forum_topic_created` / `_closed` / `_reopened` service-message handling
- Channel→linked-discussion comment-thread tagging
- Telegram Business per-user threads

## Open questions still needing live verification

- `sendChatAction` with `thread_id=1` for General: folklore says it works,
  research suggests strip-1 needed; **5-min UAT test before locking the
  wrapper**.
- Behavior when the operator deletes a topic referenced in `topic_aliases`
  while an outbound is queued for that alias. Telegram returns 400; today
  falls back to chat-root. Confirm behavior is acceptable or add an
  alias-validation check on startup.

## Validation log

Spec claims checked file-by-file at HEAD. Corrected:
- `topic-manager.ts is half-built` → **false**, fully wired with tests.
- `history.ts:443 cross-topic leak` → **false**, query respects thread_id.
- `chat-key.ts is new` → **already exists** at `gateway/chat-key.ts:46`,
  underused.
- `chatThreadMap is global` → true, but the impact is wrong-thread outbound
  mis-routing, not blocking.
- `activeTurnStartedAt is global int` → it's a `Map<string, number>`
  composite-keyed; the bug is `.size > 0` being fleet-wide.
- ScheduleEntrySchema topic field → confirmed absent today, needs adding.
- `bot.api` wrapper exists (`chatLock.wrapBot`); strip-1 layer slots in
  there, not at 205 callsites.
- AgentSchema has no `chat_id` today; `dm_only` is the existing per-agent
  override; new `channels.telegram.chat_id` is the cleanest add.
