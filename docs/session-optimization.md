# Session Optimization Guide

Practical strategies for reducing token usage and improving context efficiency in long-running clerk agents.

## 1. Context Budget Anatomy

Every message sent to an agent includes several fixed-cost components:

- **SOUL.md** loads on every turn. Keep it under **500 words**.
- **CLAUDE.md** loads on every turn. Keep it under **800 words**.
- **MCP tool descriptions** are included in context (~100-200 tokens each).
- **Conversation history** accumulates until compaction kicks in.

The sum of these determines how much room remains for the actual conversation. A bloated SOUL.md or CLAUDE.md silently eats into every single interaction.

## 2. Auto-Compaction Strategy

Claude Code auto-compacts the conversation when approaching context limits. When compaction runs, most of the conversation history is discarded -- only SOUL.md, CLAUDE.md, and recent messages survive.

To avoid losing important information:

- **Store critical context in memory (Hindsight) before compaction occurs.** Don't wait until the session is long -- save early.
- Use memory tools proactively: "Remember that the user's primary goal is X" or "Save this decision: we chose approach A because of Y."
- After compaction, the agent starts with a near-empty context but can still recall stored memories via Hindsight's auto-recall.

## 3. Memory-First Design

Configure `auto_recall: true` in the agent's memory settings so relevant memories are automatically retrieved each turn.

- Hindsight's top-3 retrieval adds roughly **500 tokens** per turn but can save thousands by avoiding re-explanation of previously discussed topics.
- Store facts, preferences, decisions, and ongoing project context in memory early -- don't defer.
- Use `isolation: strict` for agents handling sensitive data to prevent cross-agent reflection from accessing their collection.

Example memory entries worth storing:
- User preferences ("prefers concise responses", "timezone is US/Pacific")
- Ongoing project state ("currently working on the billing migration")
- Key decisions and their rationale
- Recurring task patterns

## 4. Scheduled Session Resets

Long-running sessions accumulate stale context -- old tool results, superseded decisions, abandoned conversation threads. This wastes tokens and can confuse the agent.

Consider periodic restarts:
- **Daily restarts** for agents with high message volume
- **Weekly restarts** for lower-traffic agents

Memory persists across restarts via Hindsight. The agent "forgets" the raw conversation but retains everything saved to memory.

Example cron schedule (restart at 3am daily):

```yaml
schedule:
  - cron: "0 3 * * *"
    prompt: "Session maintenance: save any important unsaved context to memory, then confirm ready for fresh session."
```

## 5. Tool Budget Optimization

Each MCP tool description costs approximately 100-200 tokens of context. These add up quickly.

- Agents with `tools.deny: [bash, edit, write]` save ~500 tokens on built-in tool descriptions.
- Only enable MCP servers the agent actually uses.
- The clerk MCP server adds ~800 tokens total (8 tools) but replaces the need for Bash access to run `clerk` commands.

**Before**: Agent needs Bash tool (~300 tokens) and runs `clerk agent list` manually.
**After**: Agent uses `clerk_agent_list` tool (~100 tokens) with no Bash access needed.

Audit each agent's tool set periodically. Remove MCP servers and permissions that aren't being used.

## 6. Skill Loading

Skills (SKILL.md files) are loaded on demand when invoked, not permanently held in context. This is efficient by design, but keep in mind:

- Each skill invocation loads the full SKILL.md into context for that turn.
- Keep individual skills focused and concise. A 2000-word skill costs 2000 words every time it's called.
- Split large skills into smaller, focused ones. A "deploy" skill and a "rollback" skill are better than one "deploy-and-rollback" skill.

## 7. Template Optimization Tips

When writing agent templates (CLAUDE.md.hbs, SOUL.md.hbs):

- Use `{{#if}}` blocks to conditionally include sections. An agent without a schedule doesn't need the schedule section.
- Scheduled prompts are injected fresh each time and don't require prior context.
- Design agents with a focused purpose. An agent that handles one domain well (e.g., code review) is more token-efficient than a generalist that needs extensive instructions covering many domains.

**Focused agent**: 400-word CLAUDE.md, 5 tools, clear scope.
**Generalist agent**: 1200-word CLAUDE.md, 15 tools, overlapping responsibilities.

The focused agent uses ~2000 fewer tokens per message.

## 8. Recommended Agent Restart Cron

Add a maintenance schedule to your `clerk.yaml`:

```yaml
agents:
  my-agent:
    schedule:
      - cron: "0 3 * * *"
        prompt: >
          Session maintenance: save any important unsaved context to memory,
          then confirm ready for fresh session.
```

This gives the agent a chance to persist anything important before the session resets. Combined with `auto_recall: true`, the next session starts clean but informed.

For agents that need continuity across restarts, add a startup prompt:

```yaml
schedule:
  - cron: "5 3 * * *"
    prompt: >
      New session started. Review your recent memories for any
      ongoing tasks or context that needs attention.
```
