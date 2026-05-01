# stream-json daemon mode — architectural design

Status: **DRAFT — design only, no code**.
Author: investigation + writeup by `assistant` agent, 2026-05-01.
Companion: `docs/streaming-deterministic.md` (April 2026 research notes that
informed the current `stream_reply` heuristic — superseded by the findings here
for the per-token streaming question).

---

## 0. TL;DR

Switchroom agents currently run interactive Claude Code (`--dangerously-load-development-channels server:switchroom-telegram`) and observe model output via two derived sources: session-tail (whole assistant messages, no token-level granularity) and PTY-tail (parses the TUI rendering, structurally fragile). Per-token streaming of the assistant's reply text — the Claude.ai/mobile UX Ken asked for — is impossible from either source.

Verified live in this investigation: Claude Code's `--print --output-format=stream-json --include-partial-messages` mode emits raw Anthropic-API `content_block_delta` events to stdout in real time, while supporting MCP servers, sub-agents, slash commands, and skills. Multi-turn input over stdin works (`--input-format=stream-json`).

**The catch**: `--dangerously-load-development-channels server:NAME` does not surface the channel's MCP tools (`reply`, `stream_reply`, `react`, ...) to the model when the session runs in `--print` mode. Re-registering the same plugin via `--mcp-config` exposes the tools but loses the channels-as-inbound integration — there's no longer a path for Telegram messages to reach the agent.

Path C — "migrate switchroom agents to stream-json daemon mode" — is therefore a re-architecture, not a flag change. The bridge becomes the inbound + outbound IO loop that today is split between `--channels` (inbound) and the MCP tool calls (outbound). Everything that touches the agent lifecycle (sub-agents, hooks, permission prompts, OAuth flow, slash commands, vault, restart semantics, slot-pool failover) needs revalidation under the new IO shape.

This document captures what's true today, what would change, what's at risk, and how a spike could de-risk the unknowns before committing to a migration.

---

## 1. What was validated in this investigation

### 1.1 Claude Code surfaces (verified against `claude --version` 2.1.126)

| Flag | Behaviour |
|---|---|
| `--print` | One-shot mode (originally), but accepts multi-turn input when paired with `--input-format=stream-json` |
| `--input-format text\|stream-json` | Text default; stream-json reads `{"type":"user","message":...}` JSON lines from stdin and processes each as a turn |
| `--output-format text\|json\|stream-json` | stream-json emits one event per line to stdout |
| `--include-partial-messages` | Emits `stream_event` lines containing Anthropic-API `content_block_delta` events (per-token text deltas) |
| `--include-hook-events` | Emits hook lifecycle events (`PreToolUse`, `PostToolUse`, `Stop`, etc.) on the same stdout stream |
| `--replay-user-messages` | Re-emits user messages back on stdout for ack tracking |
| `--mcp-config <file>` | Loads MCP servers as regular tools the model can call |
| `--strict-mcp-config` | Restricts to MCP servers from `--mcp-config` only (excludes user/global/.mcp.json) |
| `--dangerously-load-development-channels server:NAME` | Loads an MCP plugin **as a channel** (inbound notifications + chat) |

### 1.2 Per-token streaming verified

```
$ echo "say one word" | claude --print --verbose \
    --output-format stream-json --include-partial-messages "say hi"
{"type":"system","subtype":"init","tools":[...],"mcp_servers":[...],...}
{"type":"stream_event","event":{"type":"message_start",...}}
{"type":"stream_event","event":{"type":"content_block_delta",
  "delta":{"type":"text_delta","text":"Hi there"}},...}
{"type":"stream_event","event":{"type":"content_block_delta",
  "delta":{"type":"text_delta","text":", how's it going?"}},...}
{"type":"stream_event","event":{"type":"message_stop"},...}
{"type":"result","subtype":"success","result":"Hi there, how's it going?",...}
```

Two `content_block_delta` events for a single sentence. Real per-token streaming, not whole-message atomic writes. This is the Anthropic API SSE shape forwarded verbatim to stdout.

### 1.3 Multi-turn over stdin verified

```
$ printf '{"type":"user","message":{"role":"user","content":"say one"}}\n{"type":"user","message":{"role":"user","content":"say two"}}\n' \
  | claude --print --verbose --output-format stream-json --input-format stream-json
# Both turns get processed; per-token deltas emit for each.
```

### 1.4 The `--channels` blocker (negative finding)

When the same MCP server is registered as `--dangerously-load-development-channels server:switchroom-telegram` rather than `--mcp-config`:

- `init.tools` only contains built-ins + claude.ai HTTP MCP. **No `reply`, `stream_reply`, `react`, etc. exposed to the model.**
- The model, asked directly: *"No `switchroom-telegram` MCP server is connected to this session."*

Re-registering via `--mcp-config /tmp/test-mcp.json --strict-mcp-config`:

- `mcp_servers` lists `switchroom-telegram status=failed`.
- The MCP server crashes on boot — likely because `server.ts` looks for the gateway IPC socket and short-circuits when missing, and the test environment has no live gateway socket.

So: no single flag invocation today both (a) surfaces the channel's tools to the model AND (b) routes Telegram inbound to it via stdin. Today's `--channels` mode does both for interactive sessions but neither path is wired for `--print --output-format=stream-json`.

### 1.5 What the on-disk JSONL contains in stream-json mode

Inspected after the test run:

```
$ jq -r 'type' < ~/.claude/projects/.../.../<id>.jsonl | sort -u
queue-operation
user
attachment
ai-title
assistant
last-prompt
```

**No `stream_event` lines on disk.** Token deltas are stdout-only. `session-tail` watching the JSONL cannot become a streaming source no matter what flags get passed at invocation. This confirms `session-tail.ts:16` is right that "per-token text deltas are NOT in this file" — but `session-tail.ts:5` is wrong about the *reason*. Streaming events exist, just on a different transport.

### 1.6 Codebase docstrings to update if/when this lands

`telegram-plugin/session-tail.ts:5-8` and `telegram-plugin/pty-tail.ts:5-9` both
state Claude Code doesn't support `--output-format stream-json` in `--channels`
mode. The corrected nuance: it doesn't expose stream-json from a `--channels`
**interactive** session, but `--print` mode does support stream-json end-to-end
when MCP servers are registered via `--mcp-config`. Path C is exactly the
migration to that mode.

---

## 2. The architectural change in detail

### 2.1 Current architecture (today)

```
┌────────────────────────────┐     ┌──────────────────────────┐
│ switchroom-{name}.service  │     │ switchroom-{name}-       │
│                            │     │ gateway.service          │
│  start.sh                  │     │                          │
│  └─ exec claude            │     │  bun gateway.ts          │
│      --channels server:    │     │  ├─ Telegram bot         │
│      switchroom-telegram   │     │  ├─ progress card        │
│      ...                   │     │  ├─ slot banner          │
│      └─ child MCP plugin   │◀────┤  └─ IPC socket           │
│         (server.ts dynamic │ IPC │                          │
│          imports bridge.ts │     │                          │
│          when gateway      │     │                          │
│          socket detected)  │     │                          │
└────────────────────────────┘     └──────────────────────────┘
        │                                    ▲
        ▼                                    │
   service.log (TUI capture)         Telegram inbound
   ├─ session-tail watches JSONL    polls bot.getUpdates()
   │  (whole messages)
   └─ pty-tail watches log
      (TUI extraction — broken
       on current Claude Code)
```

Inbound Telegram → gateway polls → IPC → bridge.ts → MCP NotificationHandler → claude session.
Outbound: model calls `reply` MCP tool → server.ts/bridge.ts → IPC → gateway → Telegram API.

The MCP plugin lives inside Claude Code as a child process. It has dual identity — as a "channel" it receives inbound notifications; as an "MCP server" it exposes the `reply`/`stream_reply`/`react` tools. Both come from the same `server.ts` codebase, switched on whether the gateway socket is reachable (when reachable: act as bridge; when not: legacy monolith).

### 2.2 Proposed architecture (Path C)

```
┌────────────────────────────┐     ┌──────────────────────────┐
│ switchroom-{name}-         │     │ switchroom-{name}-       │
│ daemon.service             │     │ gateway.service          │
│                            │     │                          │
│  bridge-daemon.ts          │     │  bun gateway.ts          │
│  ├─ spawns claude --print  │     │  ├─ Telegram bot         │
│  │  --input-format         │     │  ├─ progress card        │
│  │   stream-json           │     │  ├─ slot banner          │
│  │  --output-format        │◀────┤  └─ IPC socket           │
│  │   stream-json           │ IPC │                          │
│  │  --include-partial-     │     │                          │
│  │   messages              │     │                          │
│  │  --include-hook-events  │     │                          │
│  │  --mcp-config <path>    │     │                          │
│  │                         │     │                          │
│  ├─ claude.stdin           │     │                          │
│  │  ◀── Telegram inbound   │     │                          │
│  │      (via gateway IPC)  │     │                          │
│  │                         │     │                          │
│  └─ claude.stdout          │     │                          │
│     ──→ stream events      │     │                          │
│         ├─ content_block_  │     │                          │
│         │  delta → live    │     │                          │
│         │  text streaming  │     │                          │
│         ├─ tool_use →      │     │                          │
│         │  progress card   │     │                          │
│         └─ result →        │     │                          │
│            turn complete   │     │                          │
└────────────────────────────┘     └──────────────────────────┘
```

Key change: a new **bridge-daemon** process owns the claude lifecycle. It spawns claude with stream-json mode, pumps Telegram inbound to its stdin, and consumes stream events from its stdout. The MCP plugin is loaded via `--mcp-config` so the model still has `reply`/`stream_reply`/`react` tools — but those tools now only push to Telegram via the gateway IPC (no channels-as-inbound path needed because the daemon owns inbound).

Per-token streaming: the bridge-daemon edits the pre-allocated Telegram draft on each `content_block_delta` event. The model's eventual `reply`/`stream_reply` tool call is the canonical "this is the answer" signal that finalizes the message; until then, the deltas drive a live preview.

### 2.3 The model-vs-deltas coordination problem

The model emits text via `content_block_delta` (every token) AND eventually calls `reply(text="<full text>")` or `stream_reply(text="<full text>", done=true)`. The bridge has the same text from two sources. Choices:

**A. Deltas-only.** Render text as it streams; ignore the eventual `reply`/`stream_reply` text content (just observe the tool call as "the model has decided this turn is done"). Risk: the model's tool call is the explicit "send this" signal — bypassing it changes semantics. Some agents may rely on the tool's `format`/`reply_to`/`message_thread_id` parameters for correctness (e.g. forum-topic threading). Lose those if we ignore the tool.

**B. Tool-call-only.** Stream nothing live; wait for the model's final `reply`/`stream_reply`. Loses the streaming UX entirely — defeats the whole exercise.

**C. Deltas-as-preview, tool-call-as-finalize.** Stream deltas into the placeholder draft as they arrive; when the model calls `reply`/`stream_reply`, finalize the draft with that tool's text + parameters (potentially identical text, but with the tool's `format`/`reply_to`/etc. applied). This is the Claude.ai pattern. Pre-existing draft consumption logic in `stream-reply-handler.ts` is close to what's needed.

Recommendation: **C**. Most flexible, preserves tool semantics, gives the streaming UX.

Edge case: model emits a partial reply via deltas, then *doesn't* call `reply` (e.g. interrupted, error, refused). Need a turn-end watchdog that converts the partial preview into a finalized message (or deletes the placeholder). The existing orphan-cleanup logic on `turn_end` handles a similar case today.

### 2.4 Inbound message format

Claude Code expects `--input-format=stream-json` lines like:

```json
{"type":"user","message":{"role":"user","content":"hello"}}
```

The bridge-daemon translates Telegram inbound to this format. Image/document attachments need to be inlined as base64 or referenced by file path (Anthropic API supports both). The MCP `download_attachment` tool currently handles this lazily; the daemon needs to either inline at inbound time or keep the tool.

Special cases the existing `--channels` integration handles that need explicit migration:

- **Forum topic threading** (`message_thread_id` is a Telegram concept; Claude has no native field for it). Today wrapped in the channel's metadata. Daemon needs to inject it into the prompt as an XML wrapper or system note so the model knows what topic to reply to.
- **Reply-to context** (Telegram quote-reply). Same treatment.
- **Multi-message coalescing** (gateway buffers rapid messages). Already happens upstream of the daemon.

### 2.5 Why the bridge-daemon needs to be a NEW service

The existing `bridge.ts` is a child process of `claude` (loaded via dynamic import from `server.ts` when the gateway socket is detected). It can't spawn the parent claude — that's the wrong direction. The daemon mode requires reversing the parent/child relationship: the bridge owns claude, claude is the child.

Practical implication: switchroom adds a third systemd unit per agent (`switchroom-{name}-daemon.service`), distinct from both the gateway and the legacy agent service. Per-agent restart semantics need rework.

---

## 3. Per-feature impact analysis

Each switchroom feature is currently implemented somewhere along the path `Telegram → gateway → IPC → bridge → claude → MCP tool → IPC → gateway → Telegram`. Migrating to stream-json daemon mode shifts who owns what. This table is the work.

| Feature | Current home | Daemon-mode home | Risk |
|---|---|---|---|
| **Inbound Telegram → claude** | `--channels` MCP NotificationHandler | bridge-daemon writes stream-json to claude's stdin | Medium — wrap forum-topic + reply-to context as prompt prefix |
| **Outbound `reply` / `stream_reply` / `react` tools** | MCP server inside claude's child process | Same MCP server, registered via `--mcp-config`; communicates with gateway via existing IPC | Low — gateway IPC contract unchanged |
| **Status reactions** (👀 🤔 👨‍💻 👍) | Driven by session-tail JSONL events | Driven by stream-json `tool_use` / `result` events from claude's stdout | Low — equivalent event shapes, different source |
| **Pre-alloc placeholder** (`🔵 thinking`) | Gateway pre-allocates on inbound | Same — gateway still owns chat-id-keyed pre-alloc map | Low |
| **Per-token streaming** | Doesn't work | bridge-daemon edits placeholder on each `content_block_delta` | New capability, low risk |
| **`update_placeholder` IPC** (recall.py) | Hindsight hook → IPC → gateway | Unchanged — Hindsight hook still fires via `--include-hook-events` consumption OR directly via IPC | Low |
| **Progress card** | session-tail `tool_use` events → reducer → renderer | stream-json `tool_use` events → same reducer → same renderer | Low — change input source, same reducer |
| **Sub-agents (Task)** | Spawned as child claude processes inheriting parent env | Verify they inherit stream-json mode; verify `parent_tool_use_id` correlation works | **MEDIUM — needs spike validation** |
| **Hooks (Pre/PostToolUse, Stop)** | Run in claude's process, fire to disk + IPC | `--include-hook-events` exposes lifecycle on stream | Low — better visibility |
| **Slash commands** | Typed in TUI, executed by claude | Need to verify how they're invoked via stream-json input | **MEDIUM — needs spike** |
| **Permission prompts** | Interactive TUI → user types y/n | stream-json must emit a permission_request event the bridge can route to Telegram inline-keyboard, then write back the answer to stdin | **HIGH — needs spike, may not exist** |
| **OAuth flow** (login, reauth, code paste) | `claude` invokes browser, user pastes code into TUI | Daemon-mode browsers? Pasting into stdin? | **HIGH — likely needs separate `--print` invocation for OAuth, or daemon kept on legacy mode for auth flows** |
| **Slot-pool failover** (auto-fallback on quota) | Restart agent service with new slot env | Restart bridge-daemon with new slot env (same shape) | Low |
| **Vault** (passphrase entry, secret materialization) | Telegram inbound → MCP plugin → vault CLI | Same — vault is separate process; daemon just routes | Low |
| **OAuth code redaction** (PR #490) | MCP plugin's `redactAuthCodeMessage` after exchange | Same — runs in MCP server which still exists | Low |
| **`/restart`, `/reset`, `/new` commands** | Gateway intercepts, sends signal to agent service | Same intercept, restart bridge-daemon instead | Low |
| **Resume / continue** | `claude --continue` re-attaches to most recent session in cwd | Verify `--continue` works for stream-json daemon (session_id in init event suggests yes, but unverified) | **MEDIUM — needs spike** |
| **Sub-agent SQLite registry** | `bridge.ts` watches sub-agent JSONLs | Daemon emits sub-agent events on stream OR daemon also runs the JSONL watchers | Medium — coordinate event sources |
| **`SWITCHROOM_HANDOFF_SHOW_LINE`** (handoff briefing) | Read by start.sh, baked into `--append-system-prompt` | Same — daemon constructs the same prompt prefix | Low |

Five rows flagged MEDIUM or HIGH risk. Each needs a spike or a design decision before commitment.

---

## 4. Migration strategy options

### 4.1 Big-bang migration

All agents flip to daemon mode in one release. New systemd unit replaces old. Rollback = revert + restart.

**Pros**: clean codebase post-migration; no dual-mode bookkeeping.
**Cons**: blast radius is the entire fleet; one regression breaks every agent simultaneously; harder to A/B compare.

### 4.2 Per-agent opt-in via config

Add `agent.streaming_mode: 'classic' | 'daemon'` to `switchroom.yaml`. New agents default to daemon; existing agents stay classic until manually flipped.

**Pros**: incremental rollout; easy to revert per-agent; can validate on one chat-class agent before rolling to all.
**Cons**: codebase has to support both modes for a long time; tests need to cover both; config knob is one more thing to misuse.

### 4.3 Side-by-side A/B (parallel daemon for streaming preview only)

Keep classic agent doing all the work; spawn a SECOND `claude --print` process per agent JUST for the streaming text preview. The preview stream feeds the placeholder; the canonical message comes from the classic agent's `reply` tool.

**Pros**: zero risk to existing functionality; pure additive.
**Cons**: ~2× compute per agent (two model sessions); coordination is fragile (the two sessions can drift); MCP state would need to mirror; rejected on cost grounds.

**Recommended: 4.2 (per-agent opt-in)** with a chat-class agent (e.g. `clerk` or `klanker`) as the first migrant. After 1-2 weeks of stability, expand. After 4-6 weeks of the daemon being the default for all new agents and most existing ones, deprecate classic mode in a release that bumps the major version.

---

## 5. Spike plan — what must work end-to-end

Before committing to a migration, build a spike that proves the core path. Spike acceptance:

1. **Spawn-and-converse**: bridge-daemon spawns claude in stream-json mode, sends a Telegram-equivalent inbound to its stdin, receives `content_block_delta` events on stdout, sends an outbound to Telegram via the MCP `reply` tool. Round-trip works on a real Telegram bot.

2. **Per-token preview**: as the model generates, the placeholder draft updates character-by-character in Telegram (verified by client screenshots/recording). The 600ms throttle from `draft-stream.ts` keeps under Telegram's edit-rate limit.

3. **Tool-call finalize**: when the model calls `reply` or `stream_reply` after streaming via deltas, the placeholder is finalized with the tool's text + format. No duplicate messages.

4. **Sub-agent dispatch**: model dispatches a `Task(subagent_type='worker', ...)` and gets a result. The sub-agent's events (parent_tool_use_id correlation) flow correctly.

5. **Hook firing**: a UserPromptSubmit hook (recall.py shape) fires and emits an event the bridge can act on.

6. **Permission prompt**: a tool requiring permission triggers something the bridge can present to Telegram (inline keyboard) and feed an answer back.

7. **`--continue` resumption**: kill the bridge-daemon mid-conversation, restart it with `--continue`, send a new turn — model has prior context.

8. **OAuth flow**: log in, paste code, restart, agent runs. May require keeping classic mode for the auth flow itself (daemon mode after auth is established).

If all 8 work in a 1-2 week spike, Path C is feasible and the per-agent migration can begin. If 6 (permissions) or 8 (OAuth) hit a hard blocker, Path C is shelved or scoped down to "streaming-only sidecar" patterns.

---

## 6. Open questions / unknowns

These need answers before commit:

1. **Does `--include-hook-events` emit hooks as inline events that can replace the file-based hook lifecycle?** Or do hooks still need to run as subprocesses and write to disk? If the latter, the daemon doesn't simplify hooks.
2. **What does a permission prompt look like in stream-json?** Need to test interactively or find docs. If there's no event for it, switchroom needs `--permission-mode auto` or `bypassPermissions` for daemon-mode agents (loss of safety surface for some users).
3. **How does `Task(subagent_type)` interact with stream-json?** Does the sub-agent get its own stream? Does the parent see the sub-agent's events? `parent_tool_use_id` in the init event suggests yes but unverified.
4. **What's the real performance / cost difference?** Stream-json mode emits more events to stdout — does that increase per-turn latency or memory usage? Probably negligible but unmeasured.
5. **What happens on session compaction?** Claude Code automatically compacts long sessions; verify the daemon survives compaction without losing context.
6. **What happens if the Hindsight HTTP server isn't ready when claude boots?** Today `start.sh` has a `HINDSIGHT_WAIT` loop. The daemon needs the same.
7. **What about IDE integration?** Switchroom doesn't need it but verifying it doesn't conflict.
8. **Does `switchroom auth code` still work?** OAuth code paste likely needs to remain on a non-daemon code path.

---

## 7. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Permission prompts can't be plumbed through stream-json | Medium | High — would force `bypassPermissions` for daemon agents | Spike early; if blocked, daemon mode is opt-in for sandboxed agents only |
| Sub-agent correlation breaks | Low | High — sub-agent UX is core | Spike early; existing `parent_tool_use_id` field suggests this works |
| OAuth flow incompatible with daemon mode | High | Medium — auth happens once, can be a separate code path | Keep classic mode for auth flows; daemon mode after auth is established |
| Claude Code stream-json shape changes between versions | Medium | Medium — Anthropic occasionally refines | Pin to a Claude Code version; integration test against captured fixtures (per `HARNESS.md` Pattern 6) |
| Daemon process crash leaves orphaned session | Medium | Low — `--continue` recovers | systemd `Restart=on-failure` + boot-time `--continue` (already pattern) |
| Telegram edit-rate limit hits during fast streams | Low | Low — existing 600ms throttle handles | Reuse `draft-stream.ts` throttle; same code path |
| Coordination between deltas + model's `reply` call ships duplicate messages | Medium | Medium — primary UX bug class | "Deltas as preview, reply as finalize" pattern (3.3 option C); regression tests |
| Migration breaks existing PR review queue (open branches assume classic mode) | Medium | Low | Coordinate with active PR authors before flipping defaults |

---

## 8. Decision points

Before this PR could be merged, the following need to be decided:

1. **Is per-token streaming worth this scope?** If "good enough" UX comes from Path A (heartbeat placeholder with semantic chunks every 3-5s), Path C may be over-engineering for the stated goal.
2. **Is switchroom willing to own the IO loop?** Today switchroom inherits Claude Code's TUI lifecycle and just instruments around it. Path C makes switchroom the parent process — closer to OpenClaw's model. Architectural shift.
3. **Per-agent opt-in vs big-bang?** §4 lays out the options; recommendation is opt-in.
4. **How long does the spike get?** Suggest 1-2 weeks for the 8 acceptance items in §5; if they all work, commit; if not, retreat to Path A with confidence.
5. **What's the deprecation timeline for classic mode?** If we're keeping it long-term, code complexity stays; if we're aiming to delete it, deprecation announcement is a separate user-facing comm.

---

## 9. Alternatives considered

### 9.1 Path A — heartbeat placeholder (RECOMMENDED for now)

50 LOC, no architectural change. Edit the placeholder every 3-5s with elapsed time + last tool used. User sees `🔵 thinking · 5s · reading CLAUDE.md` etc. Doesn't deliver per-token streaming but never silent for >5s — matches the OpenClaw "no silent gap > 2s" rule from #303.

**Why prefer over Path C**: ships in a day; zero migration risk; achieves the stated UX goal ("not silent for so long"); doesn't preclude Path C later.

### 9.2 Path B — stream-json sidecar reader

Run a SECOND claude process per agent in `--print --output-format=stream-json` mode just to capture stream events for streaming UX. Verified during this investigation: this doesn't work because there's no way to attach a stream reader to an existing interactive session — the secondary instance would be a separate conversation, not an observer of the primary.

**Rejected**.

### 9.3 Fix V1Extractor for new TUI format

Reverse-engineer current Claude Code TUI rendering, update `pty-tail.ts:111-216` to match. Would restore PTY-based streaming.

**Rejected**: structurally fragile; the test added in PR #507 already documents this pattern as the wrong tool. Even fixed, breaks again on next Claude Code TUI change.

### 9.4 Force model to use `stream_reply` via stricter prompting / hooks

Already the default `profiles/default/CLAUDE.md` instruction. Model compliance is variable. A `Stop` hook could veto turns that didn't call `stream_reply` — heavyweight, brittle, and PR #483 already removed the rejection that punished it.

**Rejected as standalone**, but compatible with Path A or Path C.

### 9.5 OpenClaw model — custom runtime

Re-implement Claude's agent loop with full SDK control. Switchroom explicitly chose NOT to do this (`docs/vs-openclaw.md`); reversing that decision is a much bigger conversation than streaming UX.

**Out of scope** — would not be the same product.

---

## 10. Recommended path forward

1. **Ship Path A (heartbeat placeholder) immediately** — closes the user-visible gap with low risk. Tracks in a separate small PR.
2. **File this design doc as an architectural issue** linking to all the validation evidence. Solicit feedback before any spike.
3. **Schedule a 1-2 week spike** if/when the team commits to Path C, against the 8 acceptance items in §5. Spike outcome is binary: green-light migration, or shelve and stick with Path A long-term.
4. **Update the codebase docstrings** (`session-tail.ts:5`, `pty-tail.ts:5`) with the corrected nuance about stream-json availability — independent of any migration commitment.
5. **Capture this investigation in `HARNESS.md`** as a worked example of the "validate assumptions against the upstream surface" pattern.

The validation finding that Claude Code DOES support per-token streaming changes the long-term architecture conversation. Whether to act on it now is a strategic question, not a tactical one.
