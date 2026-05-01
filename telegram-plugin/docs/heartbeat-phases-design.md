# heartbeat phases — outcome-focused placeholder enrichment

Status: **DRAFT — design only, no code**.
Author: writeup by `assistant` agent, 2026-05-01.
Companion: `docs/heartbeat-placeholder-design.md` (§3 minimum which
this layers on top of).

---

## 0. TL;DR

The §3 minimum heartbeat shipped (PR #514): placeholder updates every
5s with elapsed time. Now we layer outcome-focused **phase labels**
so a non-technical user sees what the agent is doing for them, in
human language.

**No technical jargon.** The user sees `📚 Looking through what we've
talked about before`, not `📚 hindsight recall`. They see
`🤖 Asking a specialist for help`, not `Agent(subagent_type='Explore')`.
They see `🔍 Looking something up`, not `Read CLAUDE.md` or `grep`.

**Outcome-focused phases** that map onto the agent's actual work but
expressed as outcomes the user understands. The user doesn't care
that we ran a Bash command — they care that we're "checking on
something."

**Auto-ack fallback** for agents without Hindsight: at T+1s, the
placeholder transitions from `🔵 thinking` to `🔵 Got your message,
working on it…` so the user always sees an acknowledgement quickly,
not just an emoji + word.

This is Path A §4 enrichment from the heartbeat design doc, refined
for non-technical UX.

## 1. Goal — what the user perceives

### 1.1 Today (post §3 minimum)

```
T+~500ms:  🔵 thinking
T+5s:      🔵 thinking · 5s
T+10s:     🔵 thinking · 10s
T+~25s:    [reply text lands]
```

User sees a counter ticking. Knows the agent is alive. Doesn't know
what it's doing.

### 1.2 Goal (this PR)

```
T+~500ms:  🔵 thinking                                    (pre-alloc)
T+~1s:     🔵 Got your message, working on it…           (auto-ack — non-Hindsight)
T+~1s:     📚 Looking through what we've talked about    (recall.py — if Hindsight)
T+~7s:     💭 Thinking it through · 7s                   (heartbeat tick after recall)
T+~12s:    🔍 Looking something up · 12s                 (file read)
T+~18s:    🤖 Asking a specialist for help · 18s         (sub-agent dispatch)
T+~25s:    ✍️ Writing your reply · 25s                  (model starts text block)
T+~28s:    [reply lands]
```

User sees a sequence of human-readable phases. Each phase tells them
what's happening in language they understand.

## 2. Non-goals

- **Real-time per-token streaming.** That's Path C, deferred.
- **Per-tool granularity** (e.g., "running bun test on file X").
  Coalesce — the user wants to know we're "running a check," not
  the exact command.
- **Customizable per-agent labels.** v1 uses fixed labels for all
  agents; persona-aware labels (e.g., "Lawyering on this for you")
  are out of scope.
- **Localization.** v1 is English-only.

## 3. The phase taxonomy

### 3.1 The phases

Eight phases, ordered roughly by sequence in a typical turn:

| Phase | Emoji + Label | When it fires |
|---|---|---|
| `acknowledged` | `🔵 Got your message, working on it…` | Auto, at T+1s if no other phase has fired |
| `recalling` | `📚 Looking through what we've talked about` | Hindsight recall hook starts |
| `thinking` | `💭 Thinking it through` | Post-recall, OR no tool activity for ≥3s |
| `looking_up` | `🔍 Looking something up` | Read / Grep / Glob / Find / WebSearch / WebFetch |
| `checking` | `⚙️ Checking on something` | Bash (read-only commands like `ls`, `git status`, `cat`) |
| `working` | `✏️ Making changes` | Edit / Write / NotebookEdit / Bash (write-y commands) |
| `asking_specialist` | `🤖 Asking a specialist for help` | Task / Agent dispatch |
| `writing_reply` | `✍️ Writing your reply` | First text content_block in current turn (model starts replying) |

**Phase rules** (clarified after self-review):
1. **One active phase per chat.** Heartbeat tick reads the current
   phase + appends elapsed.
2. **Phases override each other by default.** A new event sets the
   current phase. Going `recalling` → `thinking` → `looking_up`
   reflects the agent's actual activity.
3. **`writing_reply` is the one sticky exception.** Once the model
   starts writing the reply (first `stream_reply(done=false)` or
   `reply` call of the turn), subsequent tool calls do NOT override.
   Implemented as a `writingReplyStarted` set keyed by chat — the
   phase setter checks this set and short-circuits if true.
4. **Default phase if nothing else fires** is `acknowledged`. The
   auto-ack timer guarantees the user sees something within 1s.
5. **Unknown tools** (anything not in the §3.3 mapping table)
   produce NO phase change. The current phase persists.

### 3.2 The Bash split (read-only vs write-y)

Bash is the awkward one — it can be `ls` (harmless) or `rm -rf`
(destructive). Use a strict starts-with heuristic on the first
shell command:

- Read-only commands: command FIRST WORD ∈
  {`ls`, `cat`, `pwd`, `which`, `head`, `tail`, `wc`, `du`, `ps`,
   `df`, `echo`, `printenv`, `env`}
  OR command starts with `git ` AND second word ∈
  {`status`, `log`, `diff`, `show`, `branch`, `remote`, `config`}
  → `checking` phase
- Everything else → `working` phase

Strict starts-with — `git stash` or `git push` don't match. False
negatives ("✏️ Making changes" when actually just `ls`) are better
than false positives ("⚙️ Checking on something" when actually
`rm -rf`).

Pipelines (`ls | grep`) and `&&`-chains: classified by the FIRST
command. Imperfect but safe — most pipelines starting with `ls` are
indeed read-only.

### 3.3 What about Telegram tools?

The model frequently calls Telegram MCP tools (`reply`, `stream_reply`,
`react`). These are SELF-EVIDENT — the user is about to see a reply,
no need to announce it. Special handling:

- `stream_reply(done=false)` and `reply` calls → trigger the
  `writing_reply` phase
- `react`, `send_typing`, etc. → no phase change (cosmetic, don't
  pollute)

## 4. Where the phase comes from (event sources)

Three existing sources surface the events we need. No new dependencies.

### 4.1 Source A — `update_placeholder` IPC (Hindsight recall.py)

Already shipping. recall.py emits literal text via the existing IPC.
**No change to recall.py.** The gateway's `update_placeholder` handler
recognizes the existing literal text strings and maps them to phases:

```
"📚 recalling memories" → phase: recalling
"💭 thinking" → phase: thinking
```

Any unknown text falls through as-is (treated as a custom literal
label). Keeps the change scope tight — single repo, single PR,
no coordinated update of recall.py needed.

Future cleanup (separate PR): recall.py could emit phase NAMES
instead of literal text for cleaner separation of concerns. Not
required for v1.

### 4.2 Source B — session-tail `tool_use` events

Already shipping (the progress card consumes them). Each tool_use
event has a `toolName`. Map:

```ts
toolName → phase:
  Read, Grep, Glob, WebFetch, WebSearch        → looking_up
  Bash with read-only pattern                   → checking
  Bash with write pattern                       → working
  Edit, Write, NotebookEdit                     → working
  Task, Agent                                   → asking_specialist
  reply, stream_reply (done=false)              → writing_reply
  react, send_typing, *_message, switchroom CLI → no change
  default (unknown)                             → no change
```

The mapping lives in a pure module (`placeholder-phase.ts`) so it's
unit-testable and easy to extend.

### 4.3 Source C — content_block_start events (NOT used in v1)

When the model starts writing a `text` content block (vs `tool_use`
or `thinking`), that's the signal that the model is composing the
reply. Could trigger `writing_reply` phase. Requires Path C
stream-json mode, deferred.

For v1, `writing_reply` fires on the first `stream_reply(done=false)`
or `reply` tool call, which is good enough.

## 5. The auto-ack mechanism

### 5.1 The problem

Without Hindsight (or if recall.py is slow), the user sees `🔵 thinking`
for 5 seconds before the first heartbeat tick. That's the silent gap
the §3 minimum already addresses with the elapsed counter — but the
counter alone isn't reassuring. `🔵 thinking · 5s` reads as "still
thinking..." while `🔵 Got your message, working on it…` reads as "I
heard you and I'm starting."

### 5.2 The fix

A 1-second auto-ack timer that fires AT MOST ONCE per turn:

```
T+~500ms: pre-alloc → 🔵 thinking
T+1s:     auto-ack fires IF no other phase has been set yet
          → 🔵 Got your message, working on it…
T+5s+:    heartbeat ticks at default 5s interval
```

Cancellation: if `recalling` or any other phase is set before T+1s
(i.e., recall.py's IPC arrived first), skip the auto-ack. Recall is
strictly better information.

### 5.3 Why 1 second

Telegram message arrival → Bot API delivery → gateway processing =
~500ms typical. Auto-ack at T+1000ms gives ~500ms buffer for the
pre-alloc draft to land before we edit it. Tight but reliable.

### 5.4 Implementation

Wire into the existing pre-alloc success path. Pseudocode:

```ts
// In gateway.ts, after pre-alloc success
startPlaceholderHeartbeat(chat_id, draftId, allocatedAt)
scheduleAutoAck(chat_id, draftId, allocatedAt)

function scheduleAutoAck(chatId, draftId, startedAt) {
  setTimeout(() => {
    // Only fire if nothing else has set the phase yet
    if (currentPhaseLabel.get(chatId) == null) {
      currentPhaseLabel.set(chatId, phases.acknowledged.label)
      // Heartbeat will pick this up on its next tick;
      // OR fire an immediate edit for snappier UX.
    }
  }, 1000)
}
```

Same lifecycle: cancel on `preAllocatedDrafts.delete(chat_id)`.

## 6. Wiring it together

### 6.1 New module: `placeholder-phase.ts`

Pure module:

```ts
export type PhaseKind =
  | 'acknowledged' | 'recalling' | 'thinking'
  | 'looking_up' | 'checking' | 'working'
  | 'asking_specialist' | 'writing_reply'

export interface Phase {
  kind: PhaseKind
  label: string  // The user-facing text, including emoji
}

export const PHASES: Record<PhaseKind, Phase> = {
  acknowledged:       { kind: 'acknowledged',       label: '🔵 Got your message, working on it…' },
  recalling:          { kind: 'recalling',          label: '📚 Looking through what we've talked about' },
  thinking:           { kind: 'thinking',           label: '💭 Thinking it through' },
  looking_up:         { kind: 'looking_up',         label: '🔍 Looking something up' },
  checking:           { kind: 'checking',           label: '⚙️ Checking on something' },
  working:            { kind: 'working',            label: '✏️ Making changes' },
  asking_specialist:  { kind: 'asking_specialist',  label: '🤖 Asking a specialist for help' },
  writing_reply:      { kind: 'writing_reply',      label: '✍️ Writing your reply' },
}

/** Map a tool_use event to a phase, or null if it doesn't trigger
 * a phase change (e.g., react / send_typing). */
export function toolUseToPhase(toolName: string, input?: Record<string, unknown>): Phase | null

/** Read-only Bash command heuristic. */
export function isReadOnlyBashCommand(command: string): boolean

/** Phase-name → Phase resolver for the recall.py update_placeholder
 * flow (lets recall.py emit phase names, gateway resolves labels). */
export function resolvePhaseByName(name: string): Phase | null
```

### 6.2 Gateway state

```ts
// In gateway.ts
const currentPhase = new Map<string, Phase>()
const autoAckTimers = new Map<string, ReturnType<typeof setTimeout>>()
```

Cleared at the same lifecycle points as `preAllocatedDrafts` (3 sites).

### 6.3 Heartbeat reader

The existing `getCurrentLabel` callback in `placeholder-heartbeat.ts`
becomes:

```ts
getCurrentLabel: (chatId: string) => {
  const phase = currentPhase.get(chatId)
  return phase?.label ?? null  // null → DEFAULT_HEARTBEAT_LABEL ("🔵 thinking")
}
```

### 6.4 Subscribers

Two new subscribers update `currentPhase`:

1. **`update_placeholder` handler** (PR #504) — when `msg.text` matches a
   known phase name (`recalling`, `thinking`, etc.), look up the phase
   and write to `currentPhase`. When it's a literal text (legacy
   recall.py), just write the text directly as the label.

2. **session-tail tool_use callback** — already wired into the progress
   card. Add a parallel callback that maps `tool_use → phase` and
   writes to `currentPhase`.

### 6.5 Phase pin in the heartbeat tick

When heartbeat fires its tick, it composes `${phase.label} · ${elapsed}`.
Same `composeHeartbeatText` from §3 minimum.

## 7. Failure-mode degradation

| Scenario | Behaviour |
|---|---|
| recall.py never fires | Auto-ack at T+1s, then heartbeat ticks with `acknowledged` label until tools fire (or `thinking` if too long) |
| session-tail JSONL parsing breaks | No tool labels, but recall.py + auto-ack still work; heartbeat shows last-set phase + elapsed |
| Both broken | Pure elapsed counter (§3 minimum), unchanged |
| `update_placeholder` IPC delivers a phase name we don't know | Fall back to literal text (backward-compat) |
| Bash heuristic misclassifies a destructive command as `checking` | Worst case: user sees "⚙️ Checking on something" while agent runs `rm`. Cosmetic — no actual harm. |
| Phase fires for cosmetic tool (react, send_typing) | Skipped via the explicit no-change list |

## 8. Performance + rate-limit analysis

Phase changes do NOT add Telegram edits — they update an in-memory
map. The heartbeat tick (every 5s) is the only thing that emits edits.
Same edit budget as §3 minimum.

Auto-ack adds ONE edit at T+1s. Total per turn:
- 1 auto-ack edit (only fires if recall.py doesn't precede)
- ~6 heartbeat edits per 30s turn
- 0-2 update_placeholder edits (Hindsight)

Total: 7-9 edits per chat per turn. Under Telegram's per-chat cap.

## 9. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Bash heuristic wrong (write classified as read) | Medium | Low — cosmetic | Conservative regex; default to `working` for unknown |
| Phase changes too noisy at heartbeat boundary | Low | Low — heartbeat throttles | Same throttle, dedup catches no-op edits |
| `writing_reply` fires from a `stream_reply` that hasn't actually started writing | Medium | Low | Acceptable — `stream_reply(done=false)` is the model's intent to write |
| Non-English speakers confused by labels | High for non-English users | Medium | v1 English-only; localization is separate work |
| Persona-mismatch (KenGPT chat-class agent says "Asking a specialist") | Low | Low — generic enough | Could be customised per-persona later, out of scope |

No HIGH risks. Failure modes degrade to §3 minimum.

## 10. Implementation plan

### 10.1 PR scope

One PR, ~300 LOC:

| File | Change | LOC |
|---|---|---|
| `placeholder-phase.ts` (new) | PHASES table, toolUseToPhase, isReadOnlyBashCommand, resolvePhaseByName | ~150 |
| `tests/placeholder-phase.test.ts` (new) | Pure tests for phase mapping + Bash heuristic | ~100 |
| `placeholder-heartbeat.ts` | Add auto-ack scheduler | ~30 |
| `gateway.ts` | currentPhase map, autoAck timer, wire to lifecycle, update getCurrentLabel | ~50 |
| `update-placeholder-handler.ts` | Resolve phase names → phase labels | ~10 |
| `session-tail.ts` consumer wiring | Add tool_use → phase callback | ~30 |
| `recall.py` | Emit phase names instead of literal text (backward-compat preserved) | ~5 |
| Tests for the integration | Lifecycle + multi-source coordination | ~80 |

### 10.2 Order of changes

1. Ship `placeholder-phase.ts` + tests (pure module, zero coupling)
2. Wire gateway state + heartbeat to read phases
3. Add auto-ack timer + lifecycle
4. Wire session-tail tool_use → phase
5. Map recall.py's existing literal text to phases in `update-placeholder-handler.ts` (backward-compat: unknown text passes through unchanged)
6. Live verification

### 10.3 Acceptance

- [ ] Phase mapping table tested for all expected tools
- [ ] Bash heuristic tested for read-only + destructive patterns
- [ ] Auto-ack fires at T+1s when no recall.py precedes
- [ ] Auto-ack DOESN'T fire when recall.py sets phase first
- [ ] Heartbeat reads the latest phase on each tick
- [ ] `writing_reply` is sticky (subsequent tool calls don't override)
- [ ] Architectural pin tests verify call sites are paired
- [ ] Live test: send a multi-tool prompt to clerk; observe phase transitions visibly
- [ ] No regression on §3 minimum tests

### 10.4 Estimate

**4-6 hours** clean. **1-2 days** realistic with code review iterations.

## 11. Decision points

1. **Auto-ack text** — proposed: `🔵 Got your message, working on it…`
   Could be more conversational ("On it!", "Thanks, looking into this")
   but conversational drifts toward fake-friendly. Stick with neutral.

2. **`thinking` fallback timeout** — when do we transition from a stale
   phase to `thinking`? Proposed: if last tool_use was >10s ago AND no
   reply has started, fall back to `💭 Thinking it through`. Avoids
   `🔍 Looking something up · 30s` when the search took 2s but the model
   spent 28s thinking after.

3. **Bash heuristic strictness** — narrow regex (high false negatives
   to `working`) vs wide regex (more `checking` but some misclass).
   Proposed: narrow.

4. **Should `writing_reply` show elapsed time?** Once the model is
   writing, the elapsed is less interesting. Proposed: show
   `✍️ Writing your reply` without elapsed for cleaner final UX.

5. **Persona-aware labels** — out of scope for v1 but worth noting
   here so the design is forward-compat. The `Phase.label` field
   could accept a personalisation hook later.

## 12. Out of scope (tracked separately)

- Per-token streaming (Path C, shelved per #508 spike)
- Per-persona phase labels
- Localization beyond English
- Sub-agent visibility in the parent's heartbeat (sub-agent has its
  own progress card per #305 / #413)
- Forum-topic placeholder (#479-class follow-up)

## 13. What this enables next

Once phases are in place, future enhancements compose cleanly:

- **Telemetry**: log phase transition timings → identify slow phases
  (e.g., "recalling" averaging 8s suggests Hindsight latency to
  investigate)
- **User preference**: let users set `placeholder_verbosity = brief`
  (just emoji + elapsed) vs `verbose` (current full labels)
- **Path C readiness**: when stream-json daemon mode lands, the same
  phase taxonomy can drive the placeholder there with no UX change

The phase taxonomy is the right abstraction for whatever streaming
architecture lands later. v1 ships the taxonomy + the simplest
delivery path. Future architecture changes are about what FILLS the
taxonomy, not the taxonomy itself.
