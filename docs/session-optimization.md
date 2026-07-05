# Session Optimization

Strategies for managing context and tokens in long-running switchroom agents.

## Context Budget

Every turn includes fixed-cost components:

- **CLAUDE.md** — loaded every turn. Keep under 800 words.
- **SOUL.md** — loaded every turn. Keep under 500 words.
- **MCP tool descriptions** — ~100-200 tokens each.
- **Hindsight auto-recall** — ~500 tokens of relevant memories per turn.
- **Conversation history** — accumulates until compaction.

## Three Layers of Continuity

Switchroom agents have three mechanisms that survive restarts and compaction:

1. **Handoff briefing** — the default since switchroom #362. Every restart starts a **fresh** `claude` session; a compact summary of the prior session (written to `<agentDir>/.handoff.md` by the Stop hook) plus a live briefing assembled from recent Telegram messages, Hindsight recall, and today's daily memory file (`<agentDir>/.handoff-briefing.md`) is merged into `--append-system-prompt` so the new session wakes up oriented. The full transcript is *not* replayed.

   To opt into transcript-replay continuity instead, set `session_continuity.resume_mode` per agent in switchroom.yaml:

   - `handoff` — default. Fresh session every restart, briefing injected.
   - `auto` — pass `--continue` only when the JSONL transcript exists, is under the size cap (`session_continuity.resume_max_bytes`, default 2 MB), and is fresher than `session.max_idle` if set, else a hardcoded 7-day fallback (the schema gives `session.max_idle` no default; the 7-day floor lives in `start.sh` as `${SWITCHROOM_SESSION_MAX_IDLE_SECS:-604800}`).
   - `continue` — always pass `--continue`. Flaky on large transcripts; only use if you know your sessions stay small.
   - `none` — fresh every time, no briefing.

   **Session-JSONL retention (#2792).** Session transcripts accumulate one JSONL per session under `<agentDir>/.claude/projects/`. The Stop hook prunes old ones after building the briefing (so the handoff source is never touched), bounded by two `session_continuity` fields (same shallow per-key cascade merge as the rest of the block — set fleet-wide under `defaults.session_continuity` or override per agent/profile):

   - `session_retention_max_count` — keep at most this many newest transcripts (default `20`; `0` disables the count bound).
   - `session_retention_max_age_days` — prune transcripts older than this many days (default `30`; `0` disables the age bound).

   A transcript is deleted only when it is **both** over the count bound **and** older than the age bound; the newest two sessions are always retained regardless.

2. **Hindsight memory** — auto-retain fires every 10 turns, saving the full transcript to a semantic bank. Auto-recall fires every turn, bringing back relevant memories. Important facts survive compaction and restart because they're stored externally.

3. **Telegram history** — SQLite buffer of every inbound/outbound message. `get_recent_messages` lets the agent recover recent chat context after a restart, regardless of resume mode.

## Session Freshness Policy

`session.max_idle` and `session.max_turns` are the freshness knobs in switchroom.yaml:

```yaml
defaults:
  session:
    max_idle: 2h      # under resume_mode: auto, force fresh after 2h of inactivity
    max_turns: 50     # rotate to a fresh session after 50 user turns
```

In `auto` mode the boot check inspects the previous session's last-modified time and turn count and decides whether to pass `--continue`. In `handoff` mode (the default) every restart is fresh by construction; `session.max_idle` does not gate `--continue` because `--continue` is never passed. Hindsight auto-recall brings back relevant context regardless of mode.

## Sub-Agent Cost Optimization

Route implementation work to cheaper models via sub-agents:

```yaml
defaults:
  model: claude-opus-4-8
  subagents:
    worker:
      model: sonnet
      background: true
      isolation: worktree
```

The main agent (Opus) handles planning and review. `@worker` (Sonnet) handles implementation in the background at ~5x lower token cost. The main agent stays available for new requests.

## Tool Budget

- Restrict tools per agent: `tools.deny: [Bash, Edit, Write]` saves ~500 tokens.
- Only enable MCP servers the agent uses.
- The switchroom MCP server (~800 tokens for 8 tools) replaces Bash access for agent management.

## Compaction

Claude Code auto-compacts late in the context window (roughly 80–85% full — on the 1M Opus model that is well past 800k tokens). This is handled transparently:

- **Micro-compaction** selectively summarizes old tool results.
- **Full compaction** produces a structured summary of intent, changes, and pending work.
- **CLAUDE.md is sacred** — never compacted, always in the system prompt.
- **Hindsight is the safety net** — anything compaction loses can be recalled from the memory bank.

On the 1M context window (Opus 4.8), most conversations never reach native auto-compaction in a single session.

### Proactive compaction (`session.max_context_tokens`)

Native auto-compaction firing only near the very top of a 1M window means an agent can spend a long time operating with a very large, mostly-stale context — slower, costlier per turn, and lower-signal than a lean window. To hold a **deliberately small working context** on a large-window model, set a token cap:

```yaml
defaults:
  session:
    max_context_tokens: 190000   # /compact when occupancy reaches ~190k
```

Behavior:

- **Opt-in.** Unset (the default) → unchanged: rely on Claude Code's native auto-compaction. A fresh `switchroom setup` is unaffected.
- **What's measured.** Occupancy = the latest assistant turn's `input + cache-read + cache-creation` tokens — the prefix the model actually re-read this turn, i.e. the live window fill. Not cumulative across the session.
- **When it fires.** Only at a turn boundary while the model is idle (never mid-generation). It runs the same `/compact` the model would, just earlier and on your schedule.
- **Anti-flap.** After a compaction it disarms and re-arms only once occupancy falls back below ~60% of the cap, with an additional few-turn floor — so a borderline post-compact turn can't trigger a second compaction.
- **Cascade.** Standard `session.*` per-field merge: set fleet-wide under `defaults.session` or override per agent/profile. Orthogonal to `session.max_idle` / `session.max_turns` (fresh-session rotation) and `session_continuity.resume_mode`.

This is the recommended setting for an always-on fleet on the 1M Opus model where lean, fast, high-signal turns matter more than maximum single-session memory (Hindsight remains the cross-session safety net).

### Idle auto-clear (`session.idle_clear_after`)

After a session has been idle for this long (wall-clock, no inbound/turn/cron activity), the gateway auto-runs `/clear` to wipe the working context, so a long-untouched agent starts the next message on a fresh slate instead of resuming a stale, context-heavy thread.

```yaml
defaults:
  session:
    idle_clear_after: 3h   # default; '0s' disables
```

- **On by default** (`3h`) — unlike `max_context_tokens`, no opt-in needed. Set `0s` to disable.
- **Clear, not compact.** It wipes the in-session thread; long-term memory lives in Hindsight, so only the scratch thread is lost. (Use `max_context_tokens` if you'd rather *compact* on size.)
- **When it fires.** A wall-clock interval (≈60s), never mid-turn (same idle gate as proactive compaction); fires once per idle period and re-arms on the next activity. Cron fires count as activity, so a scheduled-only agent isn't cleared mid-work.
- **Notice.** A subtle one-line message ("🧹 Cleared after 3h idle …") posts so you know why the agent is fresh.
- **Manual control.** `/compact` and `/clear` are first-class Telegram commands (open to any chat member) for on-demand trimming/wiping.
- **Cascade.** Standard `session.*` per-field merge; duration string (`3h`, `90m`, `7200s`). Env override `SWITCHROOM_IDLE_CLEAR_MS` (ms) for testing.
