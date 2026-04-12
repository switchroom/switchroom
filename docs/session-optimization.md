# Session Optimization

Strategies for managing context and tokens in long-running clerk agents.

## Context Budget

Every turn includes fixed-cost components:

- **CLAUDE.md** — loaded every turn. Keep under 800 words.
- **SOUL.md** — loaded every turn. Keep under 500 words.
- **MCP tool descriptions** — ~100-200 tokens each.
- **Hindsight auto-recall** — ~500 tokens of relevant memories per turn.
- **Conversation history** — accumulates until compaction.

## Three Layers of Continuity

Clerk agents have three mechanisms that survive restarts and compaction:

1. **Claude Code session** — `--continue` resumes the full conversation. Configurable freshness via `session.max_idle` and `session.max_turns` in clerk.yaml.

2. **Hindsight memory** — auto-retain fires every 10 turns, saving the full transcript to a semantic bank. Auto-recall fires every turn, bringing back relevant memories. Important facts survive compaction because they're stored externally.

3. **Telegram history** — SQLite buffer of every inbound/outbound message. `get_recent_messages` lets the agent recover chat context after a restart.

## Session Freshness Policy

Configure automatic fresh-session boundaries in clerk.yaml:

```yaml
defaults:
  session:
    max_idle: 2h      # fresh session after 2h of inactivity
    max_turns: 50     # fresh session after 50 user turns
```

At startup, the agent checks the previous session's last-modified time and turn count. If either threshold is exceeded, it starts a fresh session instead of resuming. Hindsight auto-recall brings back relevant context automatically.

## Sub-Agent Cost Optimization

Route implementation work to cheaper models via sub-agents:

```yaml
defaults:
  model: claude-opus-4-6
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
- The clerk MCP server (~800 tokens for 8 tools) replaces Bash access for agent management.

## Compaction

Claude Code auto-compacts at ~83.5% of the context window (~835k tokens on the 1M Opus model). This is handled transparently:

- **Micro-compaction** selectively summarizes old tool results.
- **Full compaction** produces a structured summary of intent, changes, and pending work.
- **CLAUDE.md is sacred** — never compacted, always in the system prompt.
- **Hindsight is the safety net** — anything compaction loses can be recalled from the memory bank.

With the 1M context window on Opus 4.6, most conversations won't hit compaction in a single session.
