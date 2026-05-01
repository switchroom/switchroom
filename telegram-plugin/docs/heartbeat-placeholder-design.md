# heartbeat placeholder — design

Status: **DRAFT — design only, no code**.
Author: writeup by `assistant` agent, 2026-05-01.
Companion: `docs/stream-json-daemon-mode.md` (the deferred Path C alternative).

---

## 0. TL;DR

The user's UX complaint: between the `🔵 thinking` placeholder appearing
(~500ms after inbound) and the model's final reply (~5–25s later), the
chat goes silent. No visible activity. The placeholder text doesn't
change. Hindsight's `📚 recalling memories` → `💭 thinking` transitions
fire only when Hindsight is configured AND only between inbound and the
model's first content token — not during the long model TTFT or during
tool-call waits.

This document specifies a heartbeat that updates the placeholder every
3-5 seconds with the elapsed wait time and (optionally) the latest
semantic activity. The user always sees a moving signal — the chat
never feels dead.

The design deliberately rejects PTY-tail-style TUI extraction (the
broken pattern from PR #486) and any new dependency on parsing
external-system output. Every input source the heartbeat consumes
already exists in production today. The minimum viable shape uses zero
extractors and produces a pure elapsed-time counter; the optional
enrichment uses session-tail (already shipping) without introducing
new fragility.

Scope: low-risk shipped-in-a-day work. ~50-100 LOC + tests. No
architectural change.

---

## 1. Goal

A user sending a message to a switchroom agent should see **visible
progress** on the placeholder draft message at all times during the
turn:

- **T+~500ms**: `🔵 thinking` (existing pre-alloc)
- **T+~3s**: `🔵 thinking · 3s`
- **T+~6s**: `🔵 thinking · 6s` (heartbeat tick — NEW)
- **T+~9s**: `🔧 reading CLAUDE.md · 9s` (optional — semantic enrichment)
- **T+~12s**: `🔍 grep · 12s`
- **T+~25s**: [final reply consumes the placeholder]

The hard requirement: **no period > 5s where the placeholder text
hasn't changed.** This is the OpenClaw "no silent gap > 2s" rule from
issue #303 applied to the chat surface.

The soft requirement: the moving text should be **informative when
possible** (tool labels, recall progress) but degrades gracefully to
just elapsed time when the enrichment source is unavailable.

## 2. Non-goals

- **Per-token streaming** — that's Path C, deferred (see
  `stream-json-daemon-mode.md`). Heartbeat-driven updates are
  semantic chunks, not character streams.
- **Replacing recall.py's `update_placeholder` IPC** — that flow stays
  as-is; heartbeat coexists with it.
- **Parsing Claude Code's TUI rendering** — explicitly retired by PR
  #507. Heartbeat consumes only typed events from existing sources.
- **Server-side rendering improvements** (markdown, formatting, etc.)
  — out of scope.

## 3. The minimum viable shape (zero extractors)

The simplest version: a per-chat timer that edits the placeholder
every N seconds with the current elapsed wait.

### 3.1 Lifecycle

1. **Pre-alloc fires** (existing): `gateway.ts:3854` creates the
   placeholder draft with text `🔵 thinking`. Stores chatId →
   `{draftId, allocatedAt}` in `preAllocatedDrafts` map.

2. **Heartbeat starts**: a per-chat `setTimeout` chain starts. First
   tick fires at `HEARTBEAT_INTERVAL_MS` (default 5s) after pre-alloc.

3. **Each tick**:
   - If chat no longer has a pre-alloc entry (consumed or
     turn-end-cleanup) → cancel timer, return.
   - Compute `elapsedMs = Date.now() - preAllocatedDrafts.get(chatId).allocatedAt`.
   - Format as `🔵 thinking · 5s` / `🔵 thinking · 12s` / `🔵 thinking · 1m 5s`.
   - Edit the draft via `sendMessageDraftFn(chatId, draftId, text)`.
   - Schedule next tick at `+HEARTBEAT_INTERVAL_MS`.

4. **Heartbeat stops** (any of):
   - Pre-alloc consumed by `reply` / `stream_reply` (existing
     `preAllocatedDrafts.delete(chatId)` in `gateway.ts:1875`).
   - Turn ends without consuming (orphan cleanup in
     `onTurnComplete` hook).
   - Maximum heartbeat duration exceeded (safety cap, default 5
     minutes — far longer than any realistic turn).

### 3.2 Elapsed time format

```
0–9s:    1s precision   →  "5s", "9s"
10–59s:  5s precision   →  "10s", "15s", "55s"
1–9m:    minute precision → "1m", "1m 30s", "2m"
≥10m:    minute precision → "10m+"
```

The 5s precision in the 10-59s window matches the heartbeat tick
interval — every tick produces a different displayed value, so the
visible change is always meaningful (not "it incremented by 1 then
1 then 1").

### 3.3 What's stored

Add to `gateway.ts` near `preAllocatedDrafts`:

```ts
type HeartbeatHandle = { cancel: () => void }
const placeholderHeartbeats = new Map<string, HeartbeatHandle>()
```

That's the entire state. No persistence (heartbeat is best-effort and
resets on gateway restart). No coordination across chats (each chat's
heartbeat is independent).

### 3.4 Failure modes

| Scenario | Behaviour |
|---|---|
| `sendMessageDraftFn` returns null (no draft API) | Heartbeat never starts; no placeholder exists to tick |
| Telegram rate-limits the edit | Swallow with `.catch(() => {})`; next tick still fires |
| Telegram returns 400 (e.g. message deleted by user) | Swallow; next tick verifies via `preAllocatedDrafts.has(chatId)` and exits if entry was cleared |
| Gateway restarts mid-turn | Heartbeat lost (in-memory only); user sees the `🔵 thinking` placeholder freeze until either consumed or turn ends. Acceptable — the boot-clear in PR #500 handles the worst case |
| Pre-alloc consumed between tick scheduling and firing | Tick checks `preAllocatedDrafts.has(chatId)` and exits |
| `update_placeholder` from recall.py races with heartbeat | Both paths use `sendMessageDraftFn` against the same `draftId`; last-write-wins is fine because both are textually similar (label + elapsed); next heartbeat tick re-asserts the right text shortly |

### 3.5 Why this minimum is a real UX win

Even with no semantic enrichment — pure elapsed time — the user sees:

- **Visible aliveness** — text changes every 5s, the chat never
  appears frozen.
- **Time perception calibration** — the user can see *how long* the
  agent has been working, which lowers "is it stuck?" anxiety.
- **Restart signal** — if the heartbeat freezes after restart (because
  the in-memory timer is gone), the user knows something happened and
  can re-send.

It does not deliver "what is the agent doing right now" — that's the
optional §4 enrichment.

## 4. Optional enrichment: semantic labels via existing sources

The heartbeat label can be richer than `🔵 thinking` when other
sources have surfaced state. Three sources already exist in
production; the heartbeat consumes them passively without introducing
new dependencies.

### 4.1 Source A: `update_placeholder` IPC (recall.py et al.)

Already shipped (PR #469). Hindsight's recall.py emits:
- `📚 recalling memories` at hook start
- `💭 thinking` after recall returns

The heartbeat needs to track the **current label** for each chat —
not just `🔵 thinking`. When `update_placeholder` IPC arrives, the
gateway updates the stored label for that chat. Next heartbeat tick
shows the new label + the elapsed time:

```
T+0s:    🔵 thinking          (pre-alloc)
T+~500ms: 📚 recalling memories (recall.py update_placeholder, label
                                changes, elapsed counter not shown
                                yet because heartbeat hasn't fired)
T+5s:     📚 recalling memories · 5s   (first heartbeat tick — appends
                                       elapsed to current label)
T+~6s:    💭 thinking · 6s     (recall.py update_placeholder, label
                                changes; heartbeat continues)
T+10s:    💭 thinking · 10s    (heartbeat tick)
T+15s:    💭 thinking · 15s    (heartbeat tick)
T+~25s:   [final reply consumes placeholder]
```

**Implementation impact**: extract a `currentPlaceholderLabel` map
keyed by chatId. `update_placeholder` writes to it; heartbeat reads
from it. The actual `editMessageText` / `sendMessageDraft` call
combines the label + elapsed time.

### 4.2 Source B: session-tail `tool_use` events (already in production)

session-tail.ts is shipping today (it powers the progress card). It
emits typed events per-tool:

```ts
{ kind: 'tool_use', toolName: 'Bash', toolUseId: '...', input: {...} }
```

The progress card already consumes these. The heartbeat could *also*
consume them to update the label:

```
{toolName: 'Read', input: {file_path: '...CLAUDE.md'}}  →  "🔧 reading CLAUDE.md"
{toolName: 'Bash', input: {command: 'bun test'}}         →  "🔧 bun test"
{toolName: 'Grep', input: {pattern: 'TODO'}}             →  "🔍 grep \"TODO\""
{toolName: 'Agent', input: {description: 'find files'}}   →  "🤖 dispatching find files"
```

**Same tool-label render logic that the progress card uses** at
`telegram-plugin/tool-labels.ts` — reuse it directly, don't
re-implement.

**Fragility risk assessment**: session-tail's JSONL parsing is
**stable in production** (months without breakage). The events are
typed (`kind: 'tool_use'`), and Anthropic's JSONL format adds
event types but doesn't routinely break existing ones. Compared to
PTY-tail's TUI parsing (which broke immediately in PR #486),
session-tail is a different fragility class — but acknowledging it's
non-zero. If session-tail breaks, the heartbeat falls back gracefully:
no `tool_use` events received → label stays at whatever
`update_placeholder` set or the default `🔵 thinking` → user still
sees elapsed time updating.

### 4.3 Source C: stream-json hook events (NOT used in Path A)

Verified to work via `--include-hook-events` in the spike (PR #508
§11). But this requires Path C migration to access. **Not part of
Path A.** Listed here for completeness — when/if Path C ships, the
heartbeat could consume hook events too.

### 4.4 Source priority order

When multiple sources have written to the chat's label, the most
recent wins. Reset to `🔵 thinking` on a new pre-alloc (new turn).

### 4.5 Source-failure graceful degradation

| If this breaks | Behaviour |
|---|---|
| `update_placeholder` IPC stops firing | Label sticks at `🔵 thinking`, heartbeat still ticks elapsed |
| session-tail JSONL parsing breaks | No tool labels, but Hindsight transitions still come through `update_placeholder`, plus elapsed |
| Both broken | Pure elapsed-time counter (§3 minimum shape) |
| `sendMessageDraftFn` API fails | No placeholder existed — heartbeat never started, no UX delivered |

The system never goes WORSE than today. Worst case = today's static
placeholder.

## 5. Configuration

Three knobs, all with defaults that work out of the box:

| Setting | Default | Purpose |
|---|---|---|
| `channels.telegram.placeholder_heartbeat_ms` | `5000` (5s) | Tick interval. Set to `0` to disable heartbeat entirely. |
| `channels.telegram.placeholder_heartbeat_max_duration_ms` | `300000` (5min) | Safety cap — heartbeat stops after this long even if turn hasn't ended |
| `channels.telegram.placeholder_enrichment` | `true` | Whether to consume session-tail tool_use events for label enrichment. `false` = pure elapsed time only |

Defaults align with §1 goal ("no silent gap > 5s") without any user
config. Operators who want more aggressive ticks can lower the
interval; those who don't want session-tail in this loop can disable
enrichment.

## 6. Lifecycle integration with existing code

### 6.1 Where the heartbeat starts

`gateway.ts:3854` (the existing pre-alloc success branch):

```ts
void sendMessageDraftFn!(chat_id, draftId, PRE_ALLOC_PLACEHOLDER_TEXT)
  .then(() => {
    preAllocatedDrafts.set(chat_id, { draftId, allocatedAt: Date.now() })
    process.stderr.write(`telegram gateway: pre-allocate draft ok chatId=${chat_id} draftId=${draftId}\n`)
    // NEW: start the heartbeat
    startPlaceholderHeartbeat(chat_id, draftId)
  })
  ...
```

### 6.2 Where the heartbeat stops

Three call sites in gateway.ts already clear `preAllocatedDrafts`:

- `gateway.ts:1875` — `reply` consumes the placeholder
- `gateway.ts:2079` — `stream_reply` consumes the placeholder
- `gateway.ts:3054` — `onTurnComplete` orphan cleanup

Each of these needs a paired `cancelPlaceholderHeartbeat(chat_id)` call.

### 6.3 Label-update integration

`update_placeholder` IPC handler at `gateway.ts:1640` (already
extracted to `update-placeholder-handler.ts` in PR #504): on each
edit, also write to the new `currentPlaceholderLabel` map.

session-tail `tool_use` events: subscribe via the existing event
ingest path (the progress-card driver currently consumes these).
When a `tool_use` event arrives for a chat with a live heartbeat,
write a tool-label to the `currentPlaceholderLabel` map.

### 6.4 New module: `placeholder-heartbeat.ts`

The heartbeat logic lives in its own module — pure-ish, testable
without booting the gateway:

```ts
// telegram-plugin/placeholder-heartbeat.ts

interface HeartbeatDeps {
  sendMessageDraft: (chatId: string, draftId: number, text: string) => Promise<unknown>
  isPlaceholderActive: (chatId: string) => boolean
  getCurrentLabel: (chatId: string) => string | null
  intervalMs: number
  maxDurationMs: number
  log?: (msg: string) => void
}

export function startHeartbeat(
  chatId: string,
  draftId: number,
  startedAt: number,
  deps: HeartbeatDeps,
): { cancel: () => void } { ... }

export function formatElapsed(elapsedMs: number): string { ... }

export function composeHeartbeatText(label: string, elapsedMs: number): string { ... }
```

Pure functions for the formatting; small closure for the timer
lifecycle. Same shape as `pre-alloc-decision.ts` and
`update-placeholder-handler.ts` from prior PRs.

## 7. Testing

Five test categories, all using existing harness patterns:

### 7.1 Pure formatter tests (vitest)

`tests/placeholder-heartbeat.test.ts`:

```ts
describe('formatElapsed', () => {
  it('uses 1s precision in 0-9s range')
  it('uses 5s precision in 10-59s range')
  it('uses minute precision in 1-9m range')
  it('caps at 10m+')
})

describe('composeHeartbeatText', () => {
  it('appends elapsed to a custom label')
  it('uses default 🔵 thinking when label is null')
  it('does not double-append elapsed if label already contains a · pattern')
})
```

### 7.2 Lifecycle tests (vitest with vi.useFakeTimers)

```ts
describe('startHeartbeat', () => {
  it('schedules first tick at intervalMs after start')
  it('keeps ticking at intervalMs after each successful edit')
  it('stops when isPlaceholderActive returns false')
  it('stops at maxDurationMs even if isPlaceholderActive still true')
  it('cancel() prevents the next scheduled tick')
  it('swallows sendMessageDraft errors and continues ticking')
  it('reads getCurrentLabel on each tick (label can change between ticks)')
})
```

### 7.3 Architectural pin (vitest)

`tests/gateway-heartbeat-call-sites.test.ts`:

Greps gateway.ts to confirm `cancelPlaceholderHeartbeat` is called at
all three places `preAllocatedDrafts.delete(chat_id)` appears. If a
future PR adds a fourth delete site without canceling the heartbeat,
the test fails.

### 7.4 E2E behavioral test (vitest with fake-bot-api)

`tests/placeholder-heartbeat.e2e.test.ts` using the harness from
PR #495:

```ts
describe('heartbeat lifecycle end-to-end', () => {
  it('emits 3 sendMessageDraft edits over 15 simulated seconds')
  it('uses the latest update_placeholder text in the heartbeat label')
  it('stops when reply consumes the placeholder')
  it('stops on turn-end orphan cleanup')
})
```

### 7.5 Integration with session-tail enrichment

```ts
describe('heartbeat with session-tail enrichment', () => {
  it('renders Read tool label as "🔧 reading <file>"')
  it('renders Bash tool label using existing tool-labels logic')
  it('falls back to default label when session-tail emits no events')
})
```

## 8. Performance + rate-limit analysis

Each agent runs ~30 turns/hour at peak. Each turn = ~6 heartbeat
edits (5s interval × 30s avg turn). Per agent: ~180 edits/hour. Five
agents: ~900 edits/hour total = 0.25 edits/sec average.

Per-chat instantaneous rate: 1 edit per 5s = 0.2 edits/sec, well
under Telegram's 1/sec recommended cap.

If the user sends rapid back-to-back messages to the same chat:

- First message: pre-alloc, heartbeat ticks
- Second message arrives mid-turn: pre-alloc skips (
  `decideShouldPreAlloc → already-allocated`), no second heartbeat
- The first heartbeat keeps ticking; user sees `🔵 thinking · 12s`
  while their second message queues

So even bursty user input doesn't compound heartbeat traffic. Safe.

`update_placeholder` from recall.py adds ~2 edits per turn (recall
start, recall end). Combined with heartbeat: ~6+2 = 8 edits per turn
per chat. Still well under any cap.

## 9. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Heartbeat doesn't fire (timer race / restart) | Low | Low — placeholder degrades to today's static text | Boot-clear from PR #500 handles the worst case (orphan markers) |
| Heartbeat fires AFTER placeholder consumed | Medium | Low — `isPlaceholderActive` check exits the tick | Built into the tick logic |
| `formatElapsed` produces ugly text for edge cases (5h, negative ms, etc.) | Low | Low — pure-formatter tests cover the range | §7.1 |
| session-tail enrichment breaks if Anthropic changes JSONL format | Low | Low — degrades to no labels, heartbeat still ticks | Existing fragility class, has not materialized in months of production |
| Telegram per-chat edit cap hit during sustained load | Very low | Low — `.catch(() => {})` swallows; next tick succeeds | §8 analysis |
| Heartbeat label conflicts with `update_placeholder` from recall.py | Low | Low — last-write-wins; next tick re-asserts correct text | §3.4 |
| 5min max-duration kicks in for a legitimate long turn | Low | Low-medium — placeholder freezes (becomes today's behaviour); user can still see final reply | Tunable; could raise default to 10min for known long-running agents |

**No HIGH risks.** Path A's failure modes degrade to "current behaviour" gracefully.

## 10. Migration / rollout

This is purely additive; no config change required for existing
deployments. Knobs in §5 are opt-out:

1. Ship the implementation behind a default-on flag
   (`placeholder_heartbeat_ms: 5000`).
2. Operators who don't want the heartbeat set
   `placeholder_heartbeat_ms: 0`.
3. Operators who want pure elapsed time set
   `placeholder_enrichment: false`.

Compatible with all existing agents. No rebuild-and-restart-everything
scenario; per-agent restart at the operator's normal cadence picks
up the new behaviour.

## 11. Out of scope for this PR (tracked separately)

- **Per-token streaming** — Path C in `stream-json-daemon-mode.md`.
  Heartbeat is the thing to ship now; Path C is the architectural
  conversation for later.
- **Replacing recall.py with stream-json hook events** — depends
  on Path C.
- **Forum-topic placeholder** — `decideShouldPreAlloc` already drops
  pre-alloc for forum topics (no `sendMessageDraft` thread support).
  Heartbeat inherits that — forum-topic chats get no heartbeat
  because they have no placeholder. Tracked separately.
- **Custom heartbeat text per agent persona** — could be cute (e.g.
  KenGPT uses `🤔` instead of `🔵`) but not in scope.
- **Animation between ticks** — Telegram doesn't support per-edit
  animation; the visible change between ticks IS the animation.

## 12. Acceptance criteria for the PR

- [ ] `formatElapsed` + `composeHeartbeatText` are pure functions
      with vitest coverage for §3.2 boundaries
- [ ] `startHeartbeat` is testable with `vi.useFakeTimers` and
      verifies the §3.4 failure modes
- [ ] `gateway.ts` calls `startPlaceholderHeartbeat` after pre-alloc
      success, `cancelPlaceholderHeartbeat` at all three current
      `preAllocatedDrafts.delete` sites
- [ ] Architectural pin test confirms no missed cancel sites
- [ ] E2E test using fake-bot-api shows N edits over M simulated
      seconds, with semantic correct text on each
- [ ] Live verification: send a message to a real agent, observe
      `🔵 thinking` → `🔵 thinking · 5s` → ... → final reply
- [ ] `cd telegram-plugin && bun test` passes
- [ ] No regression on existing pre-alloc / placeholder tests
- [ ] Diagnostic log lines added for heartbeat start / tick / stop
      (for the next "why isn't it firing?" diagnostic)
- [ ] Three config knobs added to schema with sensible defaults

## 13. Decision points before implementation

1. **Default `placeholder_heartbeat_ms`** — 5s seems right but
   could be tuned. Lower = more visible, higher = less Telegram
   noise. Real user testing would calibrate; 5s is the safe
   starting point.
2. **session-tail enrichment default** — recommend `true` because the
   labels make the heartbeat meaningfully better, and the fragility
   class is already accepted (session-tail is the progress card's
   only data source). If the team's appetite for ANY fragility is
   zero, default to `false` (pure elapsed time).
3. **Where the heartbeat label state lives** — proposed
   `currentPlaceholderLabel` map in `gateway.ts`, but could be a
   separate module if it grows. Probably in-gateway is fine for v1.
4. **What about the existing `recall.py` placeholder transitions** —
   should they keep their existing format (`💭 thinking` with no
   elapsed) or get the heartbeat treatment too? Proposal: heartbeat
   takes over after the first tick; recall.py just sets the label,
   heartbeat appends elapsed.
5. **Should heartbeat also fire for non-DM chats** — depends on §11
   forum-topic decision. For now, heartbeat fires wherever pre-alloc
   fires (DMs + groups, not forum topics).

## 14. Implementation estimate

- Design review (this doc): 1 day
- `placeholder-heartbeat.ts` module + pure tests: 2-3 hours
- `gateway.ts` integration + cancel site wiring: 2-3 hours
- E2E test using fake-bot-api: 1-2 hours
- Architectural pin tests: 30 min
- Live verification + tune: 1 hour
- PR write-up + review cycle: 2 hours

**Total: 1-2 days from design approval to merged PR.**

Compare with Path C (`stream-json-daemon-mode.md`): 2-4 weeks plus
spike. Path A delivers the user-visible UX win in a fraction of the
time at zero architectural risk.
