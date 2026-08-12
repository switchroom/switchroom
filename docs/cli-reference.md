# CLI reference

The full `switchroom` verb surface, grounded in `src/cli/*.ts`. The
[README](../README.md#quickstart) carries only a short quickstart
cheat-sheet. This page is the reference: every verb, grouped, with
behaviour and common usage. `switchroom --help` lists every verb at
runtime (including `deps`, `issues`, `migrate`).

## Core / lifecycle

```bash
switchroom setup                              # Interactive wizard
switchroom doctor [--fix]                     # Health check; --fix auto-heals rev5 /model carrier drift (regenerates drifted start.sh)
switchroom apply                              # Reconcile + regenerate docker-compose.yml (self-elevates via sudo for scaffolds). Does NOT run docker; prints the `up` command
switchroom update [--check|--status|--rebuild] # Operator catch-up: pull images + apply + recreate fleet + doctor
switchroom restart [agent] [--force]          # Bounce agent(s); drains in-flight turn by default
switchroom version                            # Show versions + running agent health summary
```

## Agents

```bash
switchroom agent list                         # Status of all agents
switchroom agent status <name>                # Status of one agent
switchroom agent add [name]                   # Wizard: scaffold a new agent end-to-end (#543)
switchroom agent create <name> [--profile <p>] # Scaffold + install timers; --profile writes yaml entry
switchroom agent bootstrap <name> --profile <p> --bot-token <t>  # One-shot scaffold + auth + start
switchroom agent reconcile <name|all>         # Re-apply switchroom.yaml (without pulling/building)
switchroom agent start|stop|restart <name>    # Lifecycle (with preflight)
switchroom agent interrupt <name>             # Cancel in-flight turn without restarting
switchroom agent unquarantine <name>          # Clear a crash-quarantine and resume supervision
switchroom agent rename <old> <new>           # Rename an agent slug (#168)
switchroom agent destroy <name>               # Remove from compose + scaffold dir
switchroom agent attach <name>                # Interactive tmux session
switchroom agent send <name> <slash-cmd>      # Inject a slash command into the agent's tmux pane
switchroom agent logs <name> [-f]             # View logs
switchroom agent grant <name> <tool>          # Grant a tool permission
switchroom agent permissions <name>           # Show allow/deny list
switchroom agent dangerous <name> [off]       # Toggle full tool access
```

Profiles live in `profiles/` at the repo root. Bundled ones for
`--profile`: `coding`, `default`, `executive-assistant`,
`health-coach` (the `_base/` dir is framework-internal render
templates, not a user-selectable profile).

`switchroom agent create <name> --profile <profile>` does two things in
one step:

1. Adds an entry to `switchroom.yaml` under `agents:` with `extends:
   <profile>` and a derived `topic_name` (capitalized agent name).
   Edit the yaml afterwards to change the topic name, emoji, tools.
2. Scaffolds the agent directory and registers it in
   `docker-compose.yml` on the next `switchroom apply` (same as
   running `agent create` on an entry that already exists in yaml).

If the agent is already in yaml, `--profile` must match the existing
`extends:` value or it errors. If the yaml entry has no `extends:` and
you pass `--profile`, the flag is written in additively with a
warning. Running `agent create` with no `--profile` on a missing entry
keeps the "Agent not defined in switchroom.yaml" error, now with a
hint to use `--profile`.

Model aliases: the bare names `opus`, `sonnet`, `haiku` are accepted
alongside the full IDs (`claude-opus-5`, `claude-sonnet-5`,
`claude-haiku-4-5-20251001`). Use whichever reads cleaner in your config.

## Authentication (one OAuth, many agents)

The Anthropic account is the unit of authentication. One OAuth flow
per account, then every agent in the fleet inherits the fleet-wide
active account. The `switchroom-auth-broker` daemon owns the refresh
loop and is the sole writer of every `credentials.json`. Per-account
quota state fans out across the fleet in seconds. See
[`auth.md`](auth.md) for the full operator guide.

```bash
switchroom auth add <label> --via-claude          # New account, broader scope; recommended for first-time
switchroom auth add <label> --from-oauth          # Narrow scope=user:inference (rejected by agents in server: mode)
switchroom auth add <label> --from-agent <name>   # Seed from an existing agent's creds
switchroom auth add <label> --from-credentials <path>  # Import a credentials.json
switchroom auth add <label> --via-claude --replace     # Re-auth an existing label (drift recovery)

switchroom auth list                              # Accounts + health + which one is fleet-active
switchroom auth show [agent]                      # Full snapshot (fleet + agents + consumers), or one agent
switchroom auth use <label>                       # Fleet-wide active swap
switchroom auth rotate                            # Cycle to next non-exhausted in fallback_order
switchroom auth rm <label>                        # Remove an account (refused if it's the only one)

switchroom auth agent override <agent> <label>    # Edge case: one agent on a different account
switchroom auth agent override <agent> --clear    # Back to fleet active

switchroom auth refresh [label]                   # Diagnostic: force a refresh tick
```

The same surface is reachable from Telegram in any agent's chat:
`/auth show` (read-only), `/auth use <label>`, `/auth rotate`.
Mutating verbs are admin-gated against the per-agent `admin: true`
flag (the same flag that gates `/agents`, `/restart`, `/update`). One
knob to make an agent the fleet control panel.

## Persona, host-control, Drive

```bash
switchroom soul path|show|reset <name>        # Manage the agent's user-owned SOUL.md (persona)
switchroom hostd install|status|uninstall|audit # Host-control daemon (/restart, /update apply, …)
switchroom drive connect|disconnect <agent>   # Per-agent Google Drive OAuth
```

## Workspace (agent bootstrap layer)

Each agent has a workspace directory
(`~/.switchroom/agents/<name>/workspace/`) with editable stable files
(`AGENTS.md`, `USER.md`, `IDENTITY.md`, `TOOLS.md`) and dynamic files
(`MEMORY.md`, `memory/YYYY-MM-DD.md`) injected into the
model's context at turn time.

`SOUL.md` (the persona) is a special case since v0.12.0: it is
user-owned and seeded once. Switchroom writes it at first scaffold
(from the setup wizard's persona prompts or the profile default) and
then never overwrites it, the deliberate inverse of the
switchroom-managed `CLAUDE.md`. Edit it freely; `switchroom update`
will not touch it. Use `switchroom soul reset <agent>` to re-seed from
the profile (it backs the old one up first). See
[configuration.md § Persona & SOUL.md ownership](configuration.md#persona--soulmd-ownership).

```bash
switchroom workspace path <agent>                 # Print the workspace dir
switchroom workspace show <agent> [file]          # Print one workspace file (default AGENTS.md)
switchroom workspace edit <agent> [file]          # Open in $EDITOR (default AGENTS.md)
switchroom workspace render <agent> --stable      # Dump the stable bootstrap block (for start.sh)
switchroom workspace render <agent> --dynamic     # Dump the dynamic block (for UserPromptSubmit)
switchroom workspace search <agent> <query...>    # BM25-lite search over workspace markdown
switchroom workspace commit <agent> [-m <msg>]    # Git checkpoint of workspace state
switchroom workspace status <agent>               # git status on the workspace
```

## Observability

```bash
switchroom debug turn <agent>                     # Dump the exact prompt layering from the last turn
switchroom memory setup|search|stats|reflect      # Hindsight memory
switchroom memory repair --all [--dry-run]        # Rebuild per-bank vector index coverage
switchroom memory recall-log [agent] [-n <N>]     # Tail the per-turn auto-recall log
switchroom memory demote <agent> <memory-id>      # Drop one memory out of auto-recall
switchroom memory profile add|list <bank> ...     # Author + inspect operator profile banks
switchroom memory docker-compose                  # Print a Hindsight compose snippet
```

`memory repair` is the fix for a bank whose recall silently under-returns —
one that arrived already populated (restore, cross-version upgrade,
vector-extension switch) and so never got its per-`(bank, fact_type)` vector
indexes. Idempotent, `CREATE INDEX CONCURRENTLY`, safe on a live fleet;
requires hindsight ≥ 0.8.5. See `docs/operators/hindsight-memory.md`.

`memory profile` is the authoring path for the shared / per-user profile
banks you point `memory.recall.additional_banks` at: `add` writes an
operator-authored fact (creating the bank on first write), `list` shows what
is in one. See
[configuration.md § Shared / profile recall banks](configuration.md#shared--profile-recall-banks--memoryrecalladditional_banks).

`memory recall-log` tails what auto-recall actually injected per turn, and
`memory demote` tags a single memory out of auto-recall while leaving it
queryable via `recall` / `reflect`. See
[configuration.md § Inspecting auto-recall in production](configuration.md#inspecting-auto-recall-in-production--switchroom-memory-recall-log)
and
[§ Demoting individual memories from auto-recall](configuration.md#demoting-individual-memories-from-auto-recall).


The progress-card driver also writes a per-agent `card-events.jsonl`
audit log: every edit, pin, unpin, and tool-label transition the user
sees in Telegram, captured locally so a debug session does not depend
on Telegram's history. Tail it like any other journal.

## Other

```bash
switchroom topics sync|list|cleanup               # Telegram forum topics
switchroom vault init|set|get|list|remove         # Encrypted secrets (see vault.md)
switchroom handoff <agent>                        # Cross-session handoff summarizer
switchroom web                                    # Web dashboard
```

Migrating credentials from OpenClaw is covered in
[vs-openclaw.md](vs-openclaw.md#migrating-credentials).

## `switchroom worktree` — isolated checkouts for parallel agents

Multiple agents (and sub-agents) can run concurrently on one host and
touch the same repo. Working directly on a repo's primary checkout
collides: mid-edit files, branch switches under another agent's feet,
half-staged commits clobbered. `switchroom worktree` is the supported
way to hand each task its own isolated checkout on a fresh branch,
with a registry so stale ones get reaped instead of accumulating.

Each claim is an **independent clone** — not a linked `git worktree`
off the source repo, which shares the stash ref, refs, and
`.git/worktrees` admin metadata across concurrent tasks and lets them
corrupt each other. The clone hardlinks the object store on the same
filesystem, so it costs about what a worktree did, and its `origin` is
rewired to the source repo's real remote so `git fetch` / `git push`
work as usual. The checkout base must live under `$HOME` (default
`~/.switchroom/worktree-checkouts`); a base under `/tmp` is rejected
at claim time because agent containers mount tmp `noexec`.

```sh
switchroom worktree claim <repo> [--task <name>] [--agent <name>] [--json]
switchroom worktree list [--json]
switchroom worktree release <id> [--json]
switchroom worktree reap [--dry-run] [--json]
```

- **`claim <repo>`** claims an isolated checkout for a repo (alias or
  absolute path). Prints the claim **id**, **branch**, and **path**.
  `--task` becomes the branch suffix so the branch name says what it is
  for; `--agent` associates the claim with an agent so the registry
  shows who owns it.
- **`list`** shows every active claim, with repo, branch, path, owning
  agent, and heartbeat age. `fresh` means the heartbeat is under 120s
  old.
- **`release <id>`** releases a claim by id. Removal is shape-aware:
  clone checkouts are deleted outright; legacy linked worktrees go
  through `git worktree remove --force`. If removal fails the registry
  entry is still cleaned up and the result is reported as *partial* so
  it does not leak.
- **`reap`** removes stale / orphaned worktrees (no heartbeat for
  >10 min). `--dry-run` prints what *would* be reaped without acting.
  Always sanity-check with `--dry-run` first on a shared host.

Typical flow for a non-trivial change on a shared box:

```sh
ID=$(switchroom worktree claim switchroom --task fix-card --agent clerk --json | jq -r .id)
# ...work in the printed path, commit, push, open PR...
switchroom worktree release "$ID"
```

*Grounded in:* `src/cli/worktree.ts`, `src/worktree/{claim,release,list,reaper}.ts`.

## `switchroom web` — local monitoring dashboard

```sh
switchroom web [--port <n>] [--bind <host>]
```

Starts the browser dashboard for watching the fleet (Summary / Agents
/ Accounts / System / Google / Schedule / Approvals tabs). Default port
`8080`, default bind `127.0.0.1` (localhost-only). Binding to a
network-reachable host prints a short-lived access token the browser
must present. Full tab-by-tab behaviour is documented under "Web
dashboard" in [`telegram-features.md`](telegram-features.md#web-dashboard).

*Grounded in:* `src/cli/web.ts`, `src/web/server.ts`.

## `switchroom issues` — per-agent issue sink

A per-agent sink that surfaces *silent* failures (the CLI said
success, something is actually broken) to Telegram instead of leaving
them buried in a log. Occurrences coalesce by `source+code` so a
flapping failure does not spam the chat.

```sh
switchroom issues record --source <s> --code <c> [--detail <text>] [--agent <name>]
switchroom issues list [--severity <level>] [--include-resolved] [--json]
switchroom issues resolve [fingerprint] [--source <s> --code <c>]
switchroom issues prune
```

- **`record`** records (or coalesces into) an issue occurrence. Mostly
  called by switchroom internals and hooks, not by hand.
- **`list`** shows current issues from the sink; `--severity` filters
  to at-or-above a level, `--include-resolved` also shows cleared ones.
- **`resolve`** marks an issue (by fingerprint, or all matching a
  `--source`/`--code`) resolved.
- **`prune`** drops entries per the retention rules.

*Grounded in:* `src/cli/issues.ts`.

## `switchroom agent perf` — per-agent cache-hit telemetry

```sh
switchroom agent perf <name> [--last <n>] [--full] [--json]
```

Reads the agent's latest session JSONL and reports prompt-cache
telemetry (`cache_read` / `cache_creation` tokens per assistant turn).
Defaults to the last 20 assistant turns; `--last <n>` widens the
window, `--full` analyses every turn in the JSONL. Use it to see
whether an agent is actually getting cache hits (a low cache-read
ratio means the prompt prefix is churning and burning quota).

*Grounded in:* `src/cli/perf.ts`.

## `switchroom versions` — manifest-vs-installed drift (hidden)

```sh
switchroom versions
```

Prints the pinned dependency manifest (switchroom + dependents like
hindsight, broker protocol) against what is actually installed, and
highlights drift. The verb is **hidden** from `--help` because it is
easily confused with `switchroom version` (singular: running-agent
health summary); a follow-up may rename it to `drift` or fold it into
`switchroom doctor`. Until then it is still callable by name.

*Grounded in:* `src/cli/versions.ts`.

## Internal / host-side verbs (not for everyday use)

- **`switchroom handoff <agent>`** *(hidden)* summarises the agent's
  last session into a handoff briefing (`.handoff.md`) and a topic
  line (`.handoff-topic`). Run automatically by the Stop hook for
  cross-session continuity; not something you invoke by hand. Flags:
  `--timeout`, `--max-turns`, `--model`. *Grounded in:* `src/cli/handoff.ts`.
- **`switchroom hostd <install|status|uninstall|audit>`** manages
  `switchroom-hostd`, the host-control daemon for admin agents (RFC C).
  `install` writes `~/.switchroom/hostd/docker-compose.yml` and brings
  the hostd container up (it lives in a *separate* compose project from
  the agent fleet by design); `status` shows daemon state + bound
  sockets; `uninstall` stops the container but leaves the compose file
  for re-install; `audit` tails/filters the privileged-verb call log
  (`--tail`, `--agent`, `--op`, `--error`). Recent `switchroom update`
  runs refresh hostd automatically, so the manual `install` path is
  the fallback for debugging a stuck daemon. *Grounded in:*
  `src/cli/hostd.ts`.
- **`switchroom webd <install|status|uninstall>`** manages
  `switchroom-web`, the dashboard + GitHub-webhook receiver container.
  `install` writes `~/.switchroom/web/docker-compose.yml` and brings the
  container up in its own compose project (separate from the agent fleet
  by design), `network_mode: host` so it keeps owning host loopback
  `127.0.0.1:8080` for the cloudflared tunnel + `tailscale serve`
  consumers, running as the operator uid so its webhook forwards pass
  each agent gateway's peercred ACL; `status` shows container state;
  `uninstall` stops it but leaves the compose file for re-install.
  Replaces the legacy `switchroom-web.service` systemd unit. `switchroom
  update` refreshes it only when `web_service.managed: true` is set in
  `switchroom.yaml` (default off — existing systemd installs are
  untouched). The listen port comes from `web_service.port` in
  `switchroom.yaml` (default `8080`) — set it when another service owns
  8080 on the host; because `install` regenerates the compose file, a
  config-driven port survives `switchroom update` where a hand-edit
  would be reverted. See `docs/webhook-ingest.md` § Deployment. *Grounded in:*
  `src/cli/webd.ts`.
