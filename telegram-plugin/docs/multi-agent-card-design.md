# Multi-Agent Progress Card — Design

Status: DRAFT (design only — no code in this PR)
Audience: implementation worker, reviewer
Author: design pass by `assistant` agent
Date: 2026-04-14

---

## 0. TL;DR

Today the progress card shows the parent agent's tool sequence inline, and each
`Agent(...)` dispatch collapses to a single line `🔧 Agent: <description>` that
flips `✅` whenever the parent receives the matching `tool_result`. When Ken
fans out 2–4 background sub-agents in parallel, those minutes-long lines reveal
nothing about what's actually happening.

This design proposes a **single-card, two-section layout**:

```
⚙️ Working… · ⏱ 02:14
💬 <user request, truncated>
─ ─ ─
[Main]
  🔧 Bash git status (12s)
  ✅ Read MANIFEST.md
  🤖 Agent: design ux  ← (2 sub-agents)

[Sub-agents · 2 running, 1 done]
  🤖 design ux · ⏱ 01:48
     └ 🔧 Read DESIGN.md (8s)
  🤖 audit deps · ⏱ 00:42
     └ 🔧 Bash npm ls (12s)
  ✅ scan secrets · 00:31 · 6 tools
```

Hard recommendations:

1. **Flat per-agent sections, NOT a tree.** One section for `Main`, one section
   for `Sub-agents`. Each sub-agent is a 2-line block (header + current activity).
   Trees on Telegram mobile look terrible past one indent level.
2. **One source of truth: the projects-dir watcher.** Extend `session-tail.ts`
   to additionally watch `<sessionId>/subagents/agent-*.jsonl`. Each sub-agent
   gets its own tail, projecting events tagged with an `agentId`.
3. **Correlation via `promptId` + `prompt` text match.** Parent's `Agent`
   `tool_use` has no `agentId` field; we match on `input.prompt` ↔ subagent's
   first user message `content` string (both share `promptId`). Fallback: most
   recently appeared subagent JSONL with no parent yet.
4. **Sub-agents lifecycle: born on Agent tool_use, retired on Agent tool_result.**
   The parent's `tool_result` is the authoritative "this sub-agent is done"
   signal. Sub-JSONL `turn_end` is best-effort, not load-bearing.
5. **No recursion.** Sub-sub-agents render as `(spawned 1 sub-agent)` text on
   the parent sub-agent line. Not worth the rendering complexity.

LOC estimate: ~600 LOC of impl + ~400 LOC of new tests. Single feature flag
`PROGRESS_CARD_MULTI_AGENT=1` gates the new path; flag-off behavior is
byte-identical to today.

---

## 1. UX mockups

All character counts are measured AFTER HTML escape and INCLUDE all whitespace +
newlines. Telegram's `parse_mode=HTML` cap is 4096 characters of body text.
Mobile readability is judged at iPhone-portrait Telegram default font:
~38–40 chars wide before soft-wrap on the SF Mono italic span used for `<i>`.

### 1.1 — 1 main agent, 0 sub-agents, 4 tools done

```
⚙️ Working… · ⏱ 00:08
💬 list files in /tmp and grep for foo
─ ─ ─
  ✅ Bash ls /tmp
  ✅ Read /tmp/notes.md
  ✅ Grep "foo" (in /tmp)
  🔧 Bash grep -rn foo /tmp (3s)
```

Char count: ~205. Fits comfortably. Identical shape to today's card — the
multi-agent structure only kicks in when sub-agents exist.

### 1.2 — 1 main agent + 2 parallel sub-agents, all mid-work

```
⚙️ Working… · ⏱ 01:12
💬 design ux + audit deps in parallel
─ ─ ─
[Main · 5 tools]
  ✅ Read README.md
  ✅ Bash git status
  🤖 Agent: design progress card ux (00:48)
  🤖 Agent: audit npm dependencies (00:42)
  🔧 Read package.json (2s)

[Sub-agents · 2 running]
  🤖 design progress card ux · ⏱ 00:48
     └ 🔧 Read progress-card.ts (12s) · 4 tools
  🤖 audit npm dependencies · ⏱ 00:42
     └ 🔧 Bash npm outdated (8s) · 6 tools
```

Char count: ~510. The two-section split is the load-bearing UX choice.
The `[Main]` section keeps showing `🤖 Agent:` lines (preserving the parent's
linear narrative), and the `[Sub-agents]` section gives each sub-agent a
two-line block: `header` (description + elapsed) and `current activity`
(currently-running tool + tool count).

Why two lines per sub-agent and not one?
Single-line "🤖 design ux · 🔧 Read foo · 4 tools" reads clean on desktop but
collapses unreadably on mobile when the description is long ("Investigate
intermittent test failures in stream-controller suite" — 60+ chars). Two lines
gives the description its own line and uses a `└` continuation glyph for the
activity, which renders identically across mobile/desktop/web.

### 1.3 — 4 sub-agents, mixed states, overflow case

```
⚙️ Working… · ⏱ 03:42
💬 fan out four investigators
─ ─ ─
[Main · 8 tools]
  … (+3 more earlier steps)
  ✅ Bash git log -10
  🤖 Agent: investigate flake A
  🤖 Agent: investigate flake B
  🤖 Agent: investigate flake C
  🤖 Agent: investigate flake D
  🔧 Read tsconfig.json (1s)

[Sub-agents · 2 running, 1 done, 1 failed]
  ❌ flake C · 01:08 · 9 tools
  ✅ flake A · 02:12 · 14 tools
  🤖 flake B · ⏱ 03:18
     └ 🔧 Bash bun test races.test.ts (44s) · 11 tools
  🤖 flake D · ⏱ 02:55
     └ 🔧 Read pty-tail.ts (3s) · 7 tools
```

Char count: ~720. Completed/failed sub-agents collapse to a one-line summary
(emoji + short-name + duration + tool count). Running ones keep the two-line
block. Sort order: failed first (so the user sees red), then done, then running
ordered by start time. This sort is **stable** — sub-agents don't reorder
within their bucket between renders.

If we hit ~12 sub-agents on a single turn (theoretical extreme), we apply the
same overflow rule the main checklist already uses: keep all running + last 4
completed, collapse the rest into `… (+N more completed sub-agents)`. The cap
keeps total card body under ~1800 chars even in pathological cases.

### 1.4 — turn_end with mixed success/failure

```
✅ Done · ⏱ 04:15
💬 fan out four investigators
─ ─ ─
[Main · 12 tools]
  … (+8 more earlier steps)
  ✅ Agent: investigate flake A
  ❌ Agent: investigate flake C
  ✅ Agent: investigate flake B
  ✅ Agent: investigate flake D

[Sub-agents · 3 done, 1 failed]
  ❌ flake C · 01:08 · 9 tools
  ✅ flake A · 02:12 · 14 tools
  ✅ flake B · 03:30 · 18 tools
  ✅ flake D · 03:55 · 12 tools
```

Char count: ~510. On `turn_end` we drop the running-sub-agent header section
entirely (no `[Sub-agents · N running, …]` since none are running), collapse
each sub-agent to one line, and the header swaps to `✅ Done`. This is the
final, archived form of the card.

### 1.5 — single sub-agent, hide section header

When the parent has spawned exactly one sub-agent and it's still running, we
DROP the `[Sub-agents · 1 running]` section header and inline the sub-agent
block directly under the main checklist:

```
⚙️ Working… · ⏱ 00:48
💬 ask the doc agent
─ ─ ─
[Main · 2 tools]
  ✅ Read CLAUDE.md
  🤖 Agent: claude code docs

🤖 claude code docs · ⏱ 00:42
   └ 🔧 WebFetch claude.ai/docs (8s) · 3 tools
```

Char count: ~285. Saves a header line for the common case (1 background
investigator). The `[Main]` header appears whenever ANY sub-agent exists, so
the visual rhythm stays consistent.

---

## 2. Information architecture

### 2.1 — Flat sections vs nested tree: pick **flat sections**

Considered:

- **Tree (indented sub-agent activity under each Agent line in main):** Looks
  natural on desktop, breaks on mobile. Two-level indent eats 6+ chars of
  width. Multiple sub-agents create vertical zigzag that's hard to scan.
- **Tabbed cards (one card per agent, send N messages):** Burns N × Telegram
  edit budget. Out — exceeds the 20-edits-per-minute cap with 4 sub-agents
  each emitting tool events.
- **Flat sections (chosen):** Two clearly-labeled blocks separated by a blank
  line. Parent narrative stays linear and intact in `[Main]`; sub-agent
  detail lives in `[Sub-agents]`. Easy to skim top-to-bottom on mobile.

Justification: matches how Ken describes his mental model — "main agent" and
"sub agents" as siblings, not parent/child.

### 2.2 — Per sub-agent fields

Required:

- `description` — from parent's `Agent` `tool_use.input.description` (or
  `subagent_type` if `description` is empty). Truncated to 50 chars.
- `state` — `running | done | failed`
- `elapsedMs` — wall clock since first event in subagent JSONL
- `toolCount` — number of `tool_use` blocks observed in subagent JSONL
- `currentTool` — name + label of the most recent still-running tool_use, or
  null if between tools
- `currentToolElapsedMs` — for the `(8s)` annotation

Not rendered (kept in state for future use):

- `agentId` (correlation key, not shown to user)
- `subagentType` (e.g. "claude-code-guide")
- `model` (haiku vs sonnet — cute but noisy)

### 2.3 — Ken's "main agent task list"

**Clarification:** the existing per-tool checklist IS the main agent's task
list. The new `[Main · N tools]` section is exactly today's checklist, with
the only behavioral change being that `Agent(...)` lines no longer flip to
`✅` instantly — they hold `🤖` while the sub-agent is running, and only
flip to `✅`/`❌` when the parent receives the corresponding `tool_result`.
This makes the parent narrative honest: today the `🔧 → ✅` flip happens
the moment Claude Code emits the placeholder, which is misleading.

### 2.4 — Overflow strategy

Single rule, applied per section:

- `[Main]`: existing rule (last 12, with `… (+N more earlier steps)`).
- `[Sub-agents]`: keep ALL running, plus the last 4 done/failed. Collapse
  earlier done/failed into `… (+N more completed sub-agents)`. No collapse if
  total ≤ 6.

If the rendered card exceeds 3500 chars (safety margin under the 4096 cap),
truncate the `[Main]` `(label)` portions first (drop file path hints), then
reduce `[Main]` visible cap from 12 → 6, then collapse all done sub-agents
into a single rollup line. These three steps fit any plausibly-large turn.

### 2.5 — Update cadence

Same as today, with one addition:

- Event-driven: every state transition (new tool_use, tool_result,
  sub-agent born, sub-agent retired) schedules a flush via the existing
  coalesce timer (`max(coalesceMs, minIntervalMs - sinceLast)`).
- Heartbeat: same 5s heartbeat; now considers a sub-agent state's
  `currentToolElapsedMs` bucket too, so per-sub-agent `(Ns)` ticks visibly.
- New: **sub-agent event coalescing**. When the same sub-agent emits 3+ events
  inside the coalesce window, only the LAST is rendered. This prevents a
  burst of fast Reads in one sub-agent from monopolizing Telegram's edit
  budget.

---

## 3. Data model

### 3.1 — Types

```ts
// progress-card.ts

export type AgentRole = 'main' | 'sub'
export type ItemState = 'pending' | 'running' | 'done' | 'failed'
export type Stage = 'plan' | 'run' | 'done'

export interface ChecklistItem {
  readonly id: number
  readonly toolUseId: string | null
  readonly tool: string
  readonly label: string
  readonly state: ItemState
  readonly startedAt: number
  readonly finishedAt?: number
  /**
   * For Agent/Task tool_use only: the `agentId` of the spawned sub-agent
   * once correlation succeeds. Null until correlation lands. Used by the
   * renderer to keep the [Main] line in `🤖` (not `✅`) until the parent's
   * tool_result arrives.
   */
  readonly spawnedAgentId?: string | null
}

export interface SubAgentState {
  readonly agentId: string                // subagent JSONL filename stem
  readonly description: string             // from parent Agent tool_use input
  readonly subagentType?: string
  /** Parent's tool_use_id ("toolu_…") that spawned this sub-agent. */
  readonly parentToolUseId: string | null
  readonly state: ItemState                // running | done | failed
  readonly startedAt: number
  readonly finishedAt?: number
  readonly toolCount: number
  /** Latest still-running tool inside this sub-agent. */
  readonly currentTool?: {
    readonly tool: string
    readonly label: string
    readonly toolUseId: string
    readonly startedAt: number
  }
  /**
   * If this sub-agent itself spawned sub-sub-agents, count them so we can
   * render "(spawned N)" inline. We do NOT recurse — keeping it simple.
   */
  readonly nestedSpawnCount: number
}

export interface ProgressCardState {
  readonly turnStartedAt: number
  readonly userRequest?: string
  readonly items: ReadonlyArray<ChecklistItem>     // main agent's checklist
  readonly subAgents: ReadonlyMap<string, SubAgentState>  // by agentId
  /**
   * Pending parent Agent tool_uses awaiting correlation to a sub-agent.
   * Keyed by parentToolUseId. When a subagent JSONL appears with a
   * matching first-user-message text, we move from pending → subAgents.
   */
  readonly pendingAgentSpawns: ReadonlyMap<string, {
    parentToolUseId: string
    description: string
    promptText: string
    startedAt: number
  }>
  readonly stage: Stage
  readonly thinking: boolean
  readonly latestText?: string
}
```

### 3.2 — Event types (additions to `SessionEvent`)

```ts
export type SessionEvent =
  | { kind: 'enqueue'; ... }                       // unchanged
  | { kind: 'dequeue' }                            // unchanged
  | { kind: 'thinking' }                           // unchanged
  | { kind: 'tool_use'; ... }                      // unchanged
  | { kind: 'tool_result'; ... }                   // unchanged
  | { kind: 'text'; text: string }                 // unchanged
  | { kind: 'turn_end'; durationMs: number }       // unchanged
  // NEW: sub-agent-scoped events. Carry agentId so the reducer routes
  // them to the correct SubAgentState.
  | { kind: 'sub_agent_started'; agentId: string; firstPromptText: string; subagentType?: string }
  | { kind: 'sub_agent_tool_use'; agentId: string; toolUseId: string | null; toolName: string; input?: Record<string, unknown> }
  | { kind: 'sub_agent_tool_result'; agentId: string; toolUseId: string; isError?: boolean }
  | { kind: 'sub_agent_turn_end'; agentId: string }
  | { kind: 'sub_agent_nested_spawn'; agentId: string }   // sub-sub-agent observed; we don't render it but count it
```

### 3.3 — Reducer mapping

| Event | State change |
|---|---|
| `enqueue` | reset `initialState()`, set `turnStartedAt`, `userRequest`, `stage='plan'` |
| `tool_use` (name=`Agent` or `Task`) | append `ChecklistItem{state: running}`, store `pendingAgentSpawns[toolUseId] = {description, promptText: input.prompt}` |
| `tool_use` (other) | append `ChecklistItem{state: running}` (unchanged) |
| `tool_result` (matches Agent toolUseId) | flip main item to `done|failed`; if `subAgents` has entry with `parentToolUseId == toolUseId`, mark sub-agent `done|failed` and stop tracking |
| `tool_result` (other) | flip main item to `done|failed` (unchanged) |
| `sub_agent_started` | match `firstPromptText` against `pendingAgentSpawns` entries; on hit, move to `subAgents`, set `parentToolUseId`, `startedAt=now`, `state='running'`. Also set `items[i].spawnedAgentId` for the matching Agent line. On miss, create an "orphan" `SubAgentState` with `parentToolUseId=null`. |
| `sub_agent_tool_use` | for `subAgents[agentId]`: increment `toolCount`, set `currentTool` |
| `sub_agent_tool_result` | for `subAgents[agentId]`: clear `currentTool` if matching toolUseId; on `isError=true` keep the count but don't change agent-level state (per-tool errors don't fail the agent — only the parent tool_result does) |
| `sub_agent_turn_end` | for `subAgents[agentId]`: set `state='done'`, `finishedAt=now` (best-effort early signal; final state still set when parent's Agent tool_result lands) |
| `sub_agent_nested_spawn` | for `subAgents[agentId]`: `nestedSpawnCount++` |
| `turn_end` | close stragglers in items + subAgents, `stage='done'` |

### 3.4 — Why correlation by prompt text, not by agentId

The parent's `Agent` `tool_use` has these fields: `id` (toolu_…), `name`,
`input.subagent_type`, `input.description`, `input.prompt`. **No agentId.** The
sub-agent JSONL filename embeds `agentId`. The first user message inside the
subagent JSONL contains exactly the `input.prompt` string (verified empirically
against `/home/kenthompson/.claude/projects/-home-kenthompson/0887bb59-…`).

So the only deterministic correlation is:

```
parent.input.prompt === subagent_jsonl[firstUserMessage].message.content
```

Both also share `promptId`, but `promptId` is per-USER-TURN, not per-Agent-call.
A turn that spawns 4 parallel sub-agents will have 4 sub-agent JSONLs all
sharing the same `promptId`. Prompt-text match disambiguates within a turn.

Edge case: two parallel Agent calls with IDENTICAL prompt text (Ken running
"do X" twice as a duplicate). We fall back to FIFO assignment (first unmatched
pending spawn wins) and log a warning. Acceptable — duplicates are rare and
the visual cost is just "one sub-agent shows the wrong description for ~1s
until tool_result". No correctness harm.

---

## 4. Implementation plan

### 4.1 — `session-tail.ts`: discover and tail subagent JSONLs

Today the tail watches the projects dir for `*.jsonl` and picks the
newest-mtime. New behavior:

1. Continue watching `projectsDir` for the parent JSONL (unchanged path).
2. NEW: also watch `projectsDir/<sessionId>/subagents/` (one dir per
   active session). Discover sessionIds by stripping `.jsonl` from the
   parent file.
3. For each `agent-*.jsonl` file in any `subagents/` dir, attach a
   per-file tailer (same machinery as the parent tail — cursor, partial
   buffer, fs.watch + poll fallback). Identify it by `agentId` =
   filename stem minus `agent-`.
4. Project each line through `projectSubagentLine(line, agentId)` (new
   function) which emits the new `sub_agent_*` events.
5. On `subagents/` dir creation/deletion, the supervisor adds/removes
   tails. Use `fs.watch(projectsDir, recursive: false)` for parent and
   `fs.watch(subagentsDir)` per-subdir. Poll fallback every
   `rescanIntervalMs` for safety (matches the existing pattern).

Why per-file tails (not one global "scan newest"): with N sub-agents writing
in parallel, mtime ping-pong is constant. Per-file cursors (already a fix in
PR #25 for parent vs sub-mtime ping-pong) generalize cleanly.

Cleanup: when the `currentChatId` ends a turn (`turn_end` lands), close all
attached subagent tailers. Do NOT close them on `sub_agent_turn_end` — the
sub-agent JSONL may still get tailing tool_results we want to capture
post-completion (rare but cheap to handle).

### 4.2 — Parsing subagent JSONL events

Subagent JSONL line shapes (verified):

```jsonc
// First line — sub-agent's "user" message (prompt from parent)
{"isSidechain": true, "agentId": "aac6...", "type": "user",
 "message": {"role": "user", "content": "<prompt text>"}, ...}

// Subsequent assistant messages with tool_use
{"isSidechain": true, "agentId": "aac6...", "type": "assistant",
 "message": {"content": [{"type": "tool_use", "id": "toolu_...", "name": "Read", "input": {...}}]}}

// tool_results
{"isSidechain": true, "agentId": "aac6...", "type": "user",
 "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_...", "is_error": false}]}}
```

`projectSubagentLine` mirrors `projectTranscriptLine` with three differences:
emits `sub_agent_*` event variants, ignores `enqueue`/`dequeue` (sub-agents
don't have queue ops), and emits `sub_agent_started` ONLY for the first
`type=user` message in the file (track via "have we emitted started yet?"
flag in the per-file tail state).

### 4.3 — Correlation: parent Agent tool_use ↔ subagent JSONL

Parent's `Agent` tool_use carries `input.prompt`. Subagent's first user
message has `message.content` which is exactly that string.

Reducer logic (in pseudo-code):

```
on sub_agent_started(agentId, firstPromptText):
  for [parentToolUseId, pending] in pendingAgentSpawns:
    if pending.promptText === firstPromptText:
      subAgents.set(agentId, {parentToolUseId, description: pending.description, ...})
      items.find(i => i.toolUseId === parentToolUseId).spawnedAgentId = agentId
      pendingAgentSpawns.delete(parentToolUseId)
      return
  // No match — orphan. Could be a stale subagent JSONL from a prior
  // session, or correlation failed. Render as "(unknown sub-agent)".
  subAgents.set(agentId, {parentToolUseId: null, description: '(unknown)', ...})
```

If the parent's `Agent` `tool_use` arrives BEFORE the subagent JSONL appears
(common — JSONL is created async by Claude Code), the entry sits in
`pendingAgentSpawns` and the `[Main]` line shows `🤖 Agent: <description>`
without sub-agent activity. When the subagent JSONL lands ~50–200ms later,
correlation completes and the `[Sub-agents]` block populates.

If subagent JSONL arrives BEFORE parent (race in the other direction —
unlikely but possible if fs.watch on parent JSONL is slow), the subagent
becomes an "orphan" temporarily. Re-correlation runs every time a new pending
spawn lands: when the parent `Agent` tool_use eventually arrives, we check
existing orphan `subAgents` entries for matching `firstPromptText` (we keep
the first prompt text as part of `SubAgentState` for this lookup) and adopt.

**Blocker check:** if Claude Code ever ships a release where `input.prompt`
is omitted from the parent's `Agent` tool_use (truncated, or replaced with
a hash), correlation breaks. Mitigation: add a `promptId`-based fallback
(group by promptId, FIFO assign). Both signals are cheap to keep.

### 4.4 — Rate limit handling

Telegram allows ~1 edit/sec/chat, hard cap 20/min. The card is one message,
one chat. Today's coalesce + min-interval logic handles bursty parent events.
Multi-agent adds N parallel event sources, so:

1. **Same coalesce timer for ALL agents.** A single per-chat timer collects
   pending state mutations from any source (parent, sub-agent A, sub-agent B,
   …) and fires one render. This is already how the driver works — sub-agent
   events route through the same `ingest` path with the same `chatId`.
2. **Edit-budget guardrail.** New: track edits emitted in the last 60s per
   chat. If >18 in last 60s, switch to a 3s coalesce window until the rate
   drops. The chosen "winner" event when over budget is just "the latest
   render" (no event-level prioritization — render() reflects current state).
3. **Heartbeat respects budget too** — heartbeat skips if rate is >18/min.

### 4.5 — Sub-agent lifecycle close-out

Two signals exist:
- (a) Parent's `tool_result` for the Agent `tool_use` — authoritative.
- (b) Sub-agent JSONL `turn_end` — early hint, sub-agent finished its work
  but parent hasn't received the response yet (~100ms gap).

Rule: **(a) is canonical.** Sub-agent flips to `done`/`failed` on (a). On (b),
we set a tentative `state='done'` (so the UI feels responsive) but do NOT
delete from `subAgents`. The parent `tool_result` finalizes (and can override
to `failed` if `isError=true`). This gives users instant "done" feedback
while keeping the parent as the source of truth.

Test invariants this enforces:
- A sub-agent that finished its work but whose parent Agent tool_result is
  delayed renders as ✅ during the gap.
- If a sub-agent crashes mid-execution (no `turn_end` in subagent JSONL),
  the parent's `tool_result` with `isError=true` flips it to ❌. Reliable
  fallback.

### 4.6 — Error handling

| Failure mode | Behavior |
|---|---|
| `subagents/` subdir doesn't exist | No-op. Watch parent dir for the subdir to be created. |
| Malformed subagent JSONL line | Skip (matches existing parent behavior). Log at debug. |
| Subagent JSONL appears with `agentId` we already track (re-attach) | Use per-file cursor map — same trick PR #25 uses for parent. |
| Parent Agent tool_use never gets a tool_result | At `turn_end`, the reducer's existing "close stragglers" loop flips both the main item AND the sub-agent to `done`. |
| Subagent JSONL missing entirely (Claude Code didn't write one) | The `pendingAgentSpawns` entry sits forever; rendered as `🤖 Agent: <desc>` with no sub-agent block. At `turn_end`, the line flips to `✅`. No `[Sub-agents]` block ever appears for that spawn. Acceptable degradation. |
| Correlation fails (prompt text mismatch) | Sub-agent renders in `[Sub-agents]` with `description='(uncorrelated)'`. Doesn't break the card. |
| `fs.watch` on subagents/ unreliable (WSL, network mounts) | Same poll fallback as parent (`rescanIntervalMs`). |

---

## 5. Test harness additions

All scenarios go in `tests/progress-card-harness.test.ts`. The harness's
`mkProjectsDir` already creates the right shape; add a helper
`mkSubagentJsonl(projectsDir, sessionId, agentId)` that ensures
`<projectsDir>/<sessionId>/subagents/agent-<agentId>.jsonl` exists.

New JSONL line builders:

```ts
const subAgentUserLine = (agentId: string, promptText: string): string =>
  JSON.stringify({
    isSidechain: true, agentId, type: 'user',
    message: { role: 'user', content: promptText },
  }) + '\n'

const subAgentToolUseLine = (agentId: string, toolUseId: string, name: string, input: Record<string, unknown>): string =>
  JSON.stringify({
    isSidechain: true, agentId, type: 'assistant',
    message: { content: [{ type: 'tool_use', id: toolUseId, name, input }] },
  }) + '\n'

const subAgentToolResultLine = (agentId: string, toolUseId: string, isError = false): string =>
  JSON.stringify({
    isSidechain: true, agentId, type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError }] },
  }) + '\n'

const parentAgentToolUseLine = (toolUseId: string, description: string, prompt: string): string =>
  JSON.stringify({
    type: 'assistant',
    message: { content: [{
      type: 'tool_use', id: toolUseId, name: 'Agent',
      input: { subagent_type: 'researcher', description, prompt },
    }] },
  }) + '\n'
```

### 5.1 — Scenario: 4 parallel sub-agents, all correlate

Steps:
1. Create parent JSONL `session-A.jsonl`, `subagents/` dir.
2. Append parent enqueue.
3. Append 4 parent `Agent` tool_uses with prompts P1..P4.
4. Wait 50ms → assert `[Main]` shows 4 `🤖 Agent:` lines, no `[Sub-agents]`
   block yet (no subagent JSONLs exist).
5. Create 4 subagent JSONLs in random order; first line of each is the matching
   prompt text.
6. Wait 100ms → assert `[Sub-agents · 4 running]` block exists and each
   sub-agent shows the right description (correlation worked).
7. Append `Read` tool_use to each subagent JSONL → assert each row shows
   `└ 🔧 Read …`.
8. Append parent `tool_result` for all 4 Agent tool_uses → assert all
   sub-agents flip to `✅` and `[Main]` lines flip to `✅ Agent:`.
9. Append parent `turn_end` → assert one `done=true` edit, exactly.

### 5.2 — Scenario: sub-agent finishes before parent tool_result

Steps:
1. Single sub-agent setup as in 5.1.
2. Subagent JSONL appends a `turn_duration` line (sub_agent_turn_end) BEFORE
   parent appends the matching `tool_result`.
3. Assert sub-agent shows `✅` after turn_end (early-success state).
4. Append parent `tool_result` 200ms later → assert it stays `✅` and parent
   `[Main]` line flips to `✅`.
5. Reverse case: sub-agent `turn_end` first, then parent `tool_result` with
   `isError=true` → assert sub-agent flips ✅ → ❌ (parent overrides).

### 5.3 — Scenario: subagent JSONL appears AFTER parent tool_use (race)

Most common race in production — the parent tool_use is in the JSONL ~10ms
before Claude Code has flushed the subagent JSONL.

Steps:
1. Append parent `Agent` tool_use.
2. Wait 30ms (no subagent JSONL yet) → assert `[Main]` shows `🤖 Agent: …`,
   no `[Sub-agents]` block.
3. Create subagent JSONL with matching prompt text.
4. Wait 100ms → assert correlation succeeds, `[Sub-agents]` block populated.

### 5.4 — Scenario: subagent JSONL appears BEFORE parent tool_use (reverse race)

Steps:
1. Create subagent JSONL with prompt text P1 (no parent Agent tool_use yet).
2. Wait 50ms → assert `[Sub-agents]` block shows ONE entry with
   `description='(uncorrelated)'`.
3. Append parent `Agent` tool_use with prompt=P1.
4. Wait 100ms → assert the `(uncorrelated)` entry adopts the description
   from the parent and links to the `[Main]` Agent line.

### 5.5 — Scenario: sub-sub-agent (recursion)

Steps:
1. Sub-agent A is correlated and running.
2. Sub-agent A's JSONL contains an `Agent` tool_use of its own (sub-A spawns
   sub-B). A subagent JSONL `agent-B.jsonl` appears.
3. Assert: `[Sub-agents]` shows sub-agent A with `(spawned 1 sub-agent)`
   suffix on the description line. Sub-agent B is NOT rendered as a
   top-level row. Tool count for A includes A's tool_uses but NOT B's.
4. When sub-A's parent Agent tool_result arrives (yes, sub-agents themselves
   wait for tool_result), no card-level state changes for sub-B (it's
   invisible).

This locks in the "no recursion" rendering choice via tests.

### 5.6 — Scenario: overflow, 12 sub-agents, 8 done

Steps:
1. Spawn 12 sub-agents in sequence, complete 8, leave 4 running.
2. Assert `[Sub-agents · 4 running, 4 done]` (header counts), shows
   the 4 running + last 4 done explicitly, plus `… (+4 more completed
   sub-agents)`.
3. Assert total card body < 3500 chars.

### 5.7 — Scenario: subagent JSONL is malformed mid-stream

Steps:
1. Sub-agent A running normally.
2. Append a garbled line (not valid JSON) to its JSONL.
3. Append more valid lines.
4. Assert: garbled line silently skipped, subsequent valid events still
   processed.

### 5.8 — Scenario: rate-limit budget cap

Steps:
1. Use injected fake timers + a chat with a rapid burst of sub-agent
   tool_uses (50 events in 5 seconds across 4 sub-agents).
2. Assert `bot.edits.length <= 20` (Telegram cap respected) over a
   60-second window.

---

## 6. Open questions for Ken

Five genuine decisions that should be made before the worker starts:

**Q1 — Sort order in `[Sub-agents]` section.**
Proposed: failed → done → running (by start time). Alternative: pure
chronological (running mixed with done). Failed-first surfaces problems but
shuffles items between renders when one fails late.
*Default if no answer: failed → done → running.*

**Q2 — Show sub-agent's `subagent_type` (e.g. "researcher", "claude-code-guide")?**
Could append `· researcher` after the description. Useful for users
juggling many specialized agents; noisy if every agent is the same type.
*Default if no answer: omit.*

**Q3 — Recursion: render sub-sub-agents at all?**
Design assumes NO (just `(spawned N)` count on parent sub-agent line). If
Ken's sub-agents themselves spawn investigators, he might want a depth-2
tree. Cost: ~150 LOC + 3 more test scenarios + tighter overflow rules.
*Default if no answer: no, just count them.*

**Q4 — Should the `[Main]` Agent line still show when its sub-agent completes
before the parent receives the tool_result?**
Current proposal: stays `🤖` until parent's `tool_result` arrives (honest).
Alternative: flip to `✅` on `sub_agent_turn_end` (more responsive but
inconsistent with how every other tool line works).
*Default if no answer: stay `🤖` until parent tool_result.*

**Q5 — On `turn_end`, do we keep the `[Sub-agents]` block in the final
archived card, or collapse it into a single summary line?**
Proposed: keep it (full sub-agent breakdown is valuable retrospectively).
Alternative: replace with `[3 sub-agents · 47 tools total · 04:15]`.
*Default if no answer: keep the block.*

---

## 7. Rollout plan

### 7.1 — Incremental ship

Suggested PR sequence:

**PR-A (foundation, ~250 LOC):**
- Add per-file subagent JSONL tailer plumbing in `session-tail.ts`.
- Project `sub_agent_*` events but DROP them in the driver (no behavior
  change yet). Behind feature flag `PROGRESS_CARD_MULTI_AGENT=1`.
- Test 5.7 (malformed JSONL) lands.

**PR-B (correlation + state, ~200 LOC):**
- Reducer changes: `pendingAgentSpawns`, `subAgents` map, correlation
  on `sub_agent_started`. Renderer unchanged (still drops the data).
- Tests 5.3 + 5.4 (race conditions) land.

**PR-C (renderer, ~150 LOC):**
- New `[Main]` / `[Sub-agents]` two-section render. Behind feature flag.
- Tests 5.1, 5.2, 5.5, 5.6 land.

**PR-D (rate limit + heartbeat refinements, ~100 LOC):**
- Per-chat edit budget tracking, sub-agent-aware heartbeat buckets.
- Test 5.8 lands.

**PR-E (flag flip):**
- Default `PROGRESS_CARD_MULTI_AGENT=1`. Documentation update.
- Old behavior kept under `PROGRESS_CARD_MULTI_AGENT=0` for one release
  cycle, then removed.

### 7.2 — Backwards compatibility

The PR #26 harness tests live entirely under the parent JSONL path. They
don't use sub-agents. With the feature flag OFF, behavior is byte-identical:

- `session-tail.ts`: when no `subagents/` subdir exists, the new code
  paths are no-ops (existing tests in `progress-card-harness.test.ts`
  unaffected).
- `progress-card-driver.ts`: when `subAgents` map is empty, render falls
  back to the today's single-section layout (no `[Main]`/`[Sub-agents]`
  headers).

The existing 3 harness tests should pass unmodified. Renderer golden tests
in `progress-card-golden.test.ts` will need golden updates ONLY for the
multi-agent scenarios (new tests, no existing golden affected).

### 7.3 — Feature flag mechanism

Use the existing pattern (`process.env.<NAME> === '1'`), checked at driver
construction time, not per-event. Read once into a `multiAgent: boolean`
on the driver state. Old code path is fully reachable when the flag is
off — no shared mutable state changes shape.

### 7.4 — Migration risks

- **Subagent JSONL flushing latency.** Claude Code 2.1.x flushes subagent
  JSONLs every 100ms (same as parent). If a future release stops flushing
  until subagent completion, our `[Sub-agents]` activity goes silent
  during long sub-agent runs and the heartbeat is the only thing keeping
  the card alive. Acceptable but worth monitoring.
- **`isSidechain: true` field stability.** We use this implicitly via
  filename location, not the field itself, so a rename wouldn't affect us.
- **`agentId` filename format change.** If Claude Code ever moves to a
  different naming scheme (`subagent-*.jsonl` instead of `agent-*.jsonl`),
  we need a glob update in `session-tail.ts`. Single-line fix.

---

## Appendix A — render() pseudo-code

```ts
function render(state: ProgressCardState, now: number): string {
  if (state.turnStartedAt === 0) return '🤔 Waiting…'

  const lines: string[] = []
  const elapsed = formatDuration(now - state.turnStartedAt)
  const headerIcon = state.stage === 'done' ? '✅' : '⚙️'
  const headerLabel = state.stage === 'done' ? 'Done' : 'Working…'
  lines.push(`${headerIcon} <b>${headerLabel}</b> · ⏱ ${elapsed}`)
  if (state.userRequest) lines.push(`💬 ${escapeHtml(truncate(state.userRequest, 120))}`)
  lines.push('─ ─ ─')

  const hasSubAgents = state.subAgents.size > 0 || state.pendingAgentSpawns.size > 0

  // [Main] section header only if multi-agent rendering is active
  if (hasSubAgents) {
    lines.push(`[Main · ${state.items.length} tools]`)
  }

  // Render main checklist (existing logic)
  for (const item of applyVisibleCap(compactItems(state.items)).items) {
    lines.push(renderMainItem(item, now, state.subAgents))
  }

  // Sub-agents section
  if (state.subAgents.size > 0) {
    lines.push('') // blank separator
    const counts = countByState(state.subAgents)
    lines.push(`[Sub-agents · ${formatCounts(counts)}]`)
    for (const sa of sortSubAgents(state.subAgents)) {
      lines.push(...renderSubAgent(sa, now))
    }
  }

  if (state.stage !== 'done' && state.latestText) {
    lines.push('')
    lines.push(`💭 <i>${escapeHtml(truncate(state.latestText.trim(), 160))}</i>`)
  }

  return enforceCharBudget(lines.join('\n'), 3500)
}
```

## Appendix B — `enforceCharBudget` cascade

If body > limit:
1. Drop file-path labels from `[Main]` items (keep tool name only).
2. Reduce `[Main]` visible cap from 12 → 6.
3. Collapse all done sub-agents into single `… (+N completed)` line.
4. Last resort: truncate the whole card with `\n…\n[truncated for length]`.

Each step is deterministic and reversible if the next render has fewer items.
