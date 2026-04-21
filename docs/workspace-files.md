# Workspace Files

How an agent's context gets loaded. Three mechanisms, different cadence,
different cache behavior. This page is the single reference — if you're
adding a new context file, read this first, then decide which mechanism
it belongs to.

## TL;DR

| Mechanism                       | Files                                                        | When it loads                  | Cache           |
| ------------------------------- | ------------------------------------------------------------ | ------------------------------ | --------------- |
| **Stable system-prompt render** | `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `BOOTSTRAP.md` | Once, at `claude` launch       | Prefix cache    |
| **Dynamic UserPromptSubmit hook** | `MEMORY.md`, `HEARTBEAT.md`, `memory/YYYY-MM-DD.md` (today + yesterday) | Every turn                     | Never cached    |
| **Agent self-read**             | Whatever `AGENTS.md` tells the agent to read                 | Agent decides, usually turn 1  | N/A (tool call) |

If you renamed a file and something broke, you probably changed mechanism
without meaning to. See [the `BRIEF.md` → `BOOTSTRAP.md` incident](#historical-gotcha-the-briefmd--bootstrapmd-rename).

## The three mechanisms

### 1. Stable system-prompt render

What it does: concatenates a fixed list of files from the agent's
`workspace/` directory into a single block and passes it to `claude` via
`--append-system-prompt` at launch.

The file list is defined in `src/agents/workspace.ts`:

```ts
export const STABLE_BOOTSTRAP_FILENAMES: WorkspaceBootstrapFileName[] = [
  DEFAULT_AGENTS_FILENAME,      // AGENTS.md
  DEFAULT_SOUL_FILENAME,        // SOUL.md
  DEFAULT_IDENTITY_FILENAME,    // IDENTITY.md
  DEFAULT_USER_FILENAME,        // USER.md
  DEFAULT_TOOLS_FILENAME,       // TOOLS.md
  DEFAULT_BOOTSTRAP_FILENAME,   // BOOTSTRAP.md
];
```

Launched via `start.sh`:

```bash
_WS_STABLE=$(timeout 5 switchroom workspace render "$AGENT_NAME" --stable ...)
claude --append-system-prompt "$_WS_STABLE" ...
```

Budget: 12,000 chars per file, 64,000 chars total. Exceeding either aborts
launch with a clear error by default (pass `--warning-mode warn` or
`--warning-mode off` to relax).

Cache behavior: content is stable across a session, so the prefix cache
stays warm. Every turn reuses the cached computation of the system
prompt.

Use this mechanism for: identity, persona, operating rules, safety
directives, tool docs — anything that doesn't change mid-session.

**The list is currently hardcoded in the switchroom binary.** Adding a
new stable file requires a code change + release. This is tracked for
convergence (see [gap analysis](../reference/onboarding-gap-analysis.md)
gap 4 and gap 8).

### 2. Dynamic UserPromptSubmit hook

What it does: on every user turn, the UserPromptSubmit hook runs
`switchroom workspace render --dynamic`, which concatenates a
different fixed list plus today's and yesterday's daily memory files,
and prepends the result to the user's message.

File list:

```ts
export const DYNAMIC_BOOTSTRAP_FILENAMES: WorkspaceBootstrapFileName[] = [
  DEFAULT_MEMORY_FILENAME,      // MEMORY.md
  DEFAULT_HEARTBEAT_FILENAME,   // HEARTBEAT.md
];
// Plus:
//   memory/YYYY-MM-DD.md for today
//   memory/YYYY-MM-DD.md for yesterday
```

Daily memory dates are computed against the host's local timezone (not
UTC) — so "today" rolls over at local midnight.

Budget: 12,000 chars per file, 24,000 chars total (tighter than stable).

Cache behavior: the prompt changes every turn, so none of this caches.
That's fine — cache misses here are in per-turn territory where the
prefix cache doesn't apply anyway.

Use this mechanism for: files that change within a session and need the
agent to see the latest version on every turn. `MEMORY.md` is the
canonical example — the agent updates it, and the next turn needs to
read the updated version.

**The list is also hardcoded.** Same convergence story as stable.

### 3. Agent self-read

What it does: nothing, from switchroom's side. The agent reads files
because its own `AGENTS.md` tells it to.

Example from the lawgpt agent:

```markdown
## Every session
1. Read `SOUL.md` — your persona. That's who you are.
2. Read `BRIEF.md` in your home dir (if present) — current case state.
3. Check your `memory/YYYY-MM-DD.md` for today and yesterday.
```

Mechanism: the `Read` tool. The agent decides when to read and what to
do with the content.

Cache behavior: N/A. This is a tool call inside the conversation; the
file contents land in the transcript as tool output.

Use this mechanism for: files that are per-agent-specific and don't fit
the hardcoded stable or dynamic lists. `BRIEF.md` (lawgpt's case-state
summary) is the current real-world example.

Trade-off: you pay a tool-call turn to read the file, and the content
isn't part of the cached system prompt. For small/stable files, prefer
mechanism 1. For small/volatile files, prefer mechanism 2. Only fall
back to self-read when you need per-agent customization the hardcoded
lists don't provide.

## How an agent actually boots

```
switchroom agent start foo
  └─ start.sh
      ├─ switchroom workspace render foo --stable    (mechanism 1)
      │    └─ concatenated into $_WS_STABLE
      ├─ Start Hindsight (if not running)
      └─ claude --append-system-prompt "$_WS_STABLE" ...

User sends message
  └─ UserPromptSubmit hook fires
      ├─ switchroom workspace render foo --dynamic   (mechanism 2)
      ├─ hindsight recall (auto-fire)
      └─ concatenated and prepended to user message

Agent processes turn
  └─ Agent may Read BRIEF.md, daily notes, etc.     (mechanism 3)
      (driven by AGENTS.md instructions)
```

## Naming conventions

- `AGENTS.md` — operating protocol, safety rules, how to behave
- `SOUL.md` — persona, voice, communication style
- `IDENTITY.md` — who the agent is (name, what it's not)
- `USER.md` — who the agent talks to
- `TOOLS.md` — host-specific paths, credentials locations, known-good
  commands
- `BOOTSTRAP.md` — one-time startup instructions that don't fit above
- `MEMORY.md` — long-term curated memory, updated mid-session
- `HEARTBEAT.md` — intentions / current state for heartbeat checks
- `memory/YYYY-MM-DD.md` — daily raw-log notes
- `BRIEF.md` — per-agent convention; not loaded automatically; must be
  referenced in `AGENTS.md` if you want the agent to read it

## Adding a new context file

1. Decide which mechanism fits:
   - Stable across a session, relevant to all sessions? → mechanism 1
   - Changes mid-session, needs re-read every turn? → mechanism 2
   - Per-agent-specific, agent knows when to read it? → mechanism 3

2. If mechanism 1 or 2: the file list is hardcoded in
   `src/agents/workspace.ts`. Changing it is a switchroom code change
   and release. Consider carefully — most new files belong in mechanism
   3.

3. If mechanism 3: add a line to that agent's `AGENTS.md` telling the
   agent to read the file at the right moment. No switchroom changes
   needed.

## Historical gotcha: the `BRIEF.md` → `BOOTSTRAP.md` rename

During lawgpt setup (April 2026), we discovered the stable list includes
`BOOTSTRAP.md` but not `BRIEF.md`. We renamed `BRIEF.md` → `BOOTSTRAP.md`
so it would be picked up by mechanism 1.

It worked — but lawgpt's `AGENTS.md` had `"Read BRIEF.md in your home
dir"` baked in. The rename broke mechanism 3's self-read path. Had to
rename back and accept that `BRIEF.md` loads via mechanism 3 only.

Lesson: renaming a file moves it between mechanisms. If an agent's
`AGENTS.md` references a filename, that's mechanism 3. If a filename is
in the hardcoded stable or dynamic list, that's mechanism 1 or 2. Don't
rename across the boundary without updating both sides.

## Related

- `src/agents/workspace.ts` — loader implementation
- `src/agents/bootstrap-budget.ts` — budget enforcement
- `reference/onboarding-gap-analysis.md` — fixes planned for the
  mechanism-convergence gap
