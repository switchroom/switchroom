# Switchroom Onboarding — Gap Analysis & Phased Fix Plan

## Problem

Bringing up a new switchroom agent with a real corpus is still a babysitting
job. Setting up `lawgpt` (~100MB Goodfellow Estate export) surfaced six
distinct gaps where the happy path relies on operator knowledge that isn't in
the code or the docs. Most of these are silent-failure shaped: the CLI
reports success, something is actually broken, and the only way to find out
is to tail a log. Fixable. Worth fixing now, before the next agent onboard
repeats the same song.

## The six gaps

### 1. Hindsight bank is not auto-created for new agents

Scaffolding a new agent does not create its Hindsight bank. The first
`retain` against a missing bank blows up with a foreign-key constraint
failure — because `get_bank_stats` returns an empty-looking response for a
missing bank rather than erroring, the worker driving the ingest didn't
realise the bank wasn't there until the first write failed. Silent-on-read,
loud-on-write is the worst ordering for this kind of bug. The fix is two
parts: have `switchroom agent create` call `create_bank` (idempotent), and
make `retain` against a missing bank fail loudly with an actionable message
instead of bubbling up a raw FK error.

### 2. No MCP health verification on start/restart

`switchroom agent restart lawgpt` returned `"Restarted lawgpt"` in under a
second. The service log, a few seconds later, said `"1 MCP server failed ·
/mcp"`. The CLI has no notion of readiness — it spawns the process and
returns. From the operator's seat this looks identical to a clean boot.
Anything that relies on the broken MCP silently no-ops until someone
notices. Restart needs a readiness gate with a timeout and a clear error if
an MCP failed to come up.

### 3. No "is my agent alive and healthy?" command

There is no single command to answer the basic question "is my agent
running, and is it OK?". Today that answer is assembled by hand from `ps`,
`pstree`, `tail service.log`, and a curl against the Hindsight HTTP
endpoint. Every operator who ever debugs an agent reinvents this check.
Should be `switchroom agent status <name>` and it should tell you: claude
PID + uptime, gateway PID, Hindsight MCP reachability, Telegram polling
state, last inbound and outbound message timestamps from the history
SQLite.

### 4. Three loaders, zero single source of truth

Three separate mechanisms load files into an agent, each with a different
list, none of them declarative per-agent:

- **Stable system-prompt injection.** `start.sh` calls
  `switchroom workspace render --stable`, which returns a hardcoded list:
  `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`,
  `BOOTSTRAP.md`. Goes into the system prompt once, cached.
- **Dynamic UserPromptSubmit hook.** Injects `MEMORY.md` and `HEARTBEAT.md`
  into context every turn. Hardcoded list today.
- **Agent self-read.** `AGENTS.md` instructs the agent to read additional
  files (e.g. `BRIEF.md`) on session start. Nothing loads them — the agent
  pulls them because its own instructions say to.

During `lawgpt` setup, I renamed `BRIEF.md` → `BOOTSTRAP.md` on the theory
that the rename would pull it into the system prompt. It did, but the
agent's `AGENTS.md` already pointed at `BRIEF.md` to self-load, so the
rename broke the self-read path. Had to rename back.

The real problem isn't documentation — it's that there's no single place
where an agent declares "here are my context files and when they load."
Short term, a conventions doc stops operators tripping on the incident I
tripped on. Medium term, the three loaders should converge onto one
per-agent `workspace.yaml` declaration that all three mechanisms read
from.

### 5. Big-corpus onboarding is fully manual

There is no automated path from "here's a 280MB reference corpus" to "agent
is ready to serve". A new agent with a real corpus needs: directives
seeded, facts extracted into memories, a `BRIEF.md` written, recall tests
to validate. Today the operator runs a worker sub-agent and babysits it
through every step. This is exactly the kind of repeatable flow that
should be a CLI command backed by a declarative config, not a one-off
improvisation each time.

### 6. Telegram pairing requires a second setup pass

`switchroom setup` writes the bot config, but the user's Telegram `user_id`
only becomes knowable after the user DMs the bot `/start`. So the user has
to: run setup, DM the bot, rerun setup to get their id captured into
`access.json`. Two passes where one would do. The bot is already polling
between the passes — we could just wait for the `/start` interactively
during setup and write `access.json` in the same session.

### 7. Empty template files pollute every turn's context

New agents ship with template `MEMORY.md`, `USER.md`, `TOOLS.md` etc.
containing placeholder strings like `_set this_` and "Edit this file to
describe …". Those files load into the system prompt (stable) or every
turn (`MEMORY.md` via the dynamic hook) regardless of whether anyone
filled them in. The result is that a fresh agent burns context — and
occasionally model attention — on instructions to fill in blanks that
nobody is going to fill in during the conversation. Either the loader
should skip files whose only content is template placeholder, or the
scaffold should ship them empty with a commented header and let them
populate on demand.

### 8. Stable render list is itself hardcoded

Related to gap 4 but worth calling out: `switchroom workspace render
--stable` has a literal list of filenames baked into the binary. Adding
a new context file to an agent requires editing switchroom source, not
the agent's config. That's what drove the `BRIEF.md` → `BOOTSTRAP.md`
rename in the first place — there was no way to add `BRIEF.md` to the
stable list without shipping a switchroom release. Folds into the
convergence work proposed in gap 4.

## Phased fix plan

Effort estimates are Ken-hours, not calendar time. Success criteria are
the bar for "done" — not aspirational, the actual gate.

### Phase A — quick wins, ship first

#### A1. Auto-create Hindsight bank on agent create + loud failure on missing bank

- **Effort:** ~2 hours
- **Scope:** `switchroom agent create` calls `mcp__hindsight__create_bank`
  with the agent name. No-op if bank exists. Separate upstream fix in
  Hindsight: `retain` against a missing bank returns a clear error, not a
  raw FK constraint violation. `get_bank_stats` against a missing bank
  errors instead of returning empty.
- **Success criteria:** fresh `switchroom agent create foo` followed
  immediately by a `retain` call succeeds. Manual `retain` against a
  non-existent bank produces an error message naming the missing bank and
  suggesting `create_bank`.

#### A2. `switchroom agent status <name>`

- **Effort:** ~4 hours
- **Scope:** single command that prints claude PID + uptime, gateway PID,
  Hindsight MCP reachability (HTTP probe of `/mcp/` endpoint), Telegram
  polling state (parsed from `gateway.log` for the `polling as @botname`
  line), last inbound + outbound message timestamps from the Telegram
  plugin's history SQLite.
- **Success criteria:** replaces the current five-command manual check with
  one command. Exit code non-zero if any component is down. Output is
  stable enough to grep in scripts.

#### A3. Root-cause the "1 MCP server failed" race

- **Effort:** ~3 hours investigation, fix size depends on cause
- **Scope:** triage which MCP actually failed on the first `lawgpt` boot
  (leading theory: Hindsight HTTP not ready when Claude Code tried to
  connect). Fix is either retry-with-backoff in the MCP connection path,
  or gate agent start on Hindsight HTTP being up.
- **Success criteria:** ten consecutive `agent restart` calls boot cleanly
  with zero MCP failures in the service log. Whatever the underlying race
  was, it is closed or masked with a bounded retry.

#### A4. Workspace conventions doc

- **Effort:** ~2 hours
- **Scope:** one page (`docs/workspace-files.md`) covering the three
  loading mechanisms — stable system-prompt render, dynamic UserPromptSubmit
  hook, agent self-read — what files go where, naming conventions, and
  how an agent actually boots. Linked from `README.md` and the profile
  docs.
- **Success criteria:** a new contributor can set up a new agent's
  workspace without asking which file gets loaded how.

### Phase B — medium effort, medium value

#### B1. Readiness gate on start/restart

- **Effort:** ~1 day
- **Scope:** `agent restart` (and `agent start`) poll until the claude
  PID is up AND every configured MCP is reachable AND the gateway is
  polling, with a configurable timeout. Return non-zero and a specific
  error if the gate fails.
- **Success criteria:** restart returns success only when the agent is
  actually ready to take a message. A failed MCP boot surfaces as a
  non-zero exit and a named error, not as a cheerful `"Restarted"`.

#### B2. Per-agent dynamic workspace file list

- **Effort:** ~1 day
- **Scope:** each agent declares in its config (likely a `workspace:`
  stanza in `switchroom.yaml` or a separate `workspace.yaml`) which files
  the per-turn UserPromptSubmit hook injects. Today it's hardcoded
  `MEMORY.md` + `HEARTBEAT.md`. `lawgpt` wants `BRIEF.md` in the dynamic
  list because case state evolves faster than the system-prompt cache.
- **Success criteria:** at least one agent (lawgpt) runs with a
  per-agent dynamic list that differs from the default, and the extra
  file shows up in every turn's context.

#### B3. `switchroom agent doctor <name>`

- **Effort:** ~1 day
- **Scope:** deeper than `status` — checks Hindsight bank exists and has
  non-zero memories if the agent is supposed to be seeded, directives are
  loaded, stable workspace files are non-empty and aren't still the
  unedited template with `_set this_` placeholders, every file referenced
  in `AGENTS.md` actually exists in the workspace.
- **Success criteria:** on a freshly created agent before any corpus
  ingest, `doctor` calls out the missing/empty pieces by name. On a
  healthy agent, it exits clean with no findings.

### Phase C — bigger design

#### C1. Corpus bootstrap with an LLM worker template

- **Effort:** ~week
- **Scope:** the real work in onboarding a corpus isn't file copying —
  it's synthesis. Reading hundreds of files to produce a `BRIEF.md`,
  extracting directives, seeding mental models, and writing recall
  validation queries. That's LLM work, not a shell script. The scope
  here is two layers: (a) a declarative `workspace/bootstrap.yaml` per
  agent declaring corpus paths, directive seeds, brief-template sources,
  and recall-test queries; (b) a packaged prompt-template that
  `switchroom agent bootstrap <name>` feeds to a worker sub-agent to
  execute the synthesis against the declared inputs. Idempotent —
  re-running skips work already done. Today's lawgpt Phase 1 onboarding
  becomes a one-liner.
- **Success criteria:** `lawgpt`-scale corpus onboarding is reproducible
  from a committed `bootstrap.yaml` with no operator sitting on top of a
  worker. Re-run on the same config is a no-op. Dry-run mode exists.
  The prompt template ships with switchroom and is versioned.

#### C2. Telegram pairing in one shot

- **Effort:** ~2 days
- **Scope:** `switchroom setup` guides the user to DM `/start` as an
  interactive step, auto-detects the resulting `user_id` from the bot's
  update stream, writes it to `access.json`, all without a second pass.
- **Success criteria:** a user going from zero to a working paired agent
  runs `switchroom setup` exactly once.

## Recommended ship order

Straight down the list: **A1, A2, A3, A4**, then **B1, B2, B3**, then
**C1, C2**. Inside Phase A, A1 and A2 together close the biggest pain
points from today's lawgpt setup and should land first even if A3/A4 slip
a day.

Dependencies and parallelism:

- **A1 and A2 are independent** — land them in parallel. Different
  files, no shared logic.
- **A3 is a spike, not a feature.** Timebox to half a day of
  investigation; if the root cause isn't obvious, ship a bounded-retry
  mask as the shippable outcome and move on.
- **A4 is pure docs** — can land alongside any of A1/A2/A3.
- **B1 builds on A2.** The readiness gate is "what A2's status command
  reports, run in a poll loop until green." Don't start B1 until A2's
  component list is stable.
- **B2 and B3 are independent** of everything else in phase B once A is
  done.
- **C1's declarative bootstrap config depends on the loader convergence
  hinted at in gap 4 / gap 8.** If B-phase unifies the three loaders
  under a `workspace.yaml`, C1 extends that file rather than inventing
  a second one. Sequence B before C1 to avoid two overlapping config
  formats.

Phase B items can otherwise be picked off in any order once A is done.
Phase C items are real design work; schedule them, don't slot them in.
