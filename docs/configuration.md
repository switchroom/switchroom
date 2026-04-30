# Configuration Reference

Everything lives in one file: `switchroom.yaml`. Switchroom uses a **three-layer cascade** for agent config:

1. **`defaults:`** — global baseline for every agent
2. **`profiles:`** — named presets agents inherit via `extends:`
3. **`agents:`** — per-agent overrides (only express differences)

## Cascade Semantics

Each field type has specific merge behavior when values exist at multiple layers:

| Merge type | Fields | Behavior |
|---|---|---|
| **Union** | `tools.allow`, `tools.deny`, `skills` | Combine across layers, dedup |
| **Per-key merge** | `mcp_servers`, `env`, `subagents` | Agent wins on key conflict |
| **Per-field merge** | `soul`, `memory`, `session`, `channels` | Agent wins per sub-field |
| **Per-event concat** | `hooks` | Defaults first, then agent |
| **Concatenate** | `schedule`, `system_prompt_append`, `claude_md_raw`, `cli_args` | Defaults prepended/joined |
| **Override** | `model`, `extends`, `dangerous_mode`, all other scalars | Agent wins entirely |
| **Deep merge** | `settings_raw` | Recursive object merge, agent wins |

## Full Field Reference

| Field | Cascade | Description |
|-------|---------|-------------|
| `model` | override | Claude model (`claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`). Haiku is the default for the handoff summarizer; agents typically use opus or sonnet. |
| `extends` | — | Named profile to inherit from |
| `tools.allow` / `tools.deny` | union | Tool permissions |
| `soul` | per-field | Agent persona (name, style, boundaries) |
| `memory` | per-field | Hindsight collection and recall settings |
| `hooks` | per-event concat | Claude Code lifecycle hooks (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd) |
| `env` | per-key | Environment variables for start.sh |
| `mcp_servers` | per-key | Additional MCP server configurations. Set a key to `false` to suppress a built-in default (e.g. `playwright: false`) |
| `system_prompt_append` | concatenate | Appended to the system prompt via `--append-system-prompt` |
| `skills` | union | Named skills from the global skills pool (`switchroom.skills_dir`) |
| `subagents` | per-key | Sub-agent definitions rendered to `.claude/agents/<name>.md` |
| `schedule` | concatenate | Cron-based scheduled tasks (systemd timers) |
| `session.max_idle` | override | Fresh session after idle period (`2h`, `30m`) |
| `session.max_turns` | override | Fresh session after N user turns |
| `channels.telegram.plugin` | override | `switchroom` (default, enhanced) or `official` |
| `channels.telegram.format` | override | Reply format (`html`, `markdownv2`, `text`) |
| `channels.telegram.rate_limit_ms` | override | Min delay between outgoing messages |
| `channels.telegram.orphan_promotion_ms` | override | Progress-card: ms before an unmatched spawn is promoted to a running row (default 5000) |
| `channels.telegram.cold_sub_agent_threshold_ms` | override | Progress-card: ms of JSONL silence before a sub-agent is synthesised as finished (default 30000) |
| `channels.telegram.deferred_completion_timeout_ms` | override | Progress-card: force-close timeout (ms) after parent `turn_end` while sub-agents are still running (default 180000) |
| `channels.telegram.sub_agent_tick_interval_ms` | override | Progress-card: elapsed-counter tick interval (ms) while a sub-agent is running (default 10000) |
| `channels.telegram.edit_budget_threshold` | override | Progress-card: card-edit budget per minute before throttled mode (default 18) |
| `settings_raw` | deep merge | Escape hatch: raw settings.json overrides |
| `claude_md_raw` | concatenate | Escape hatch: append to CLAUDE.md on scaffold |
| `cli_args` | concatenate | Escape hatch: extra `exec claude` flags |

## Built-in MCP Servers

The scaffold wires the following MCP servers automatically:

- **switchroom** — management CLI wrapper (list/start/stop agents, check auth). Always wired.
- **playwright** — Microsoft's `@playwright/mcp` browser automation server, launched via `npx -y @playwright/mcp@<pinned-version> --snapshot`. Always wired by default; opt out with `mcp_servers: { playwright: false }`. Runs in accessibility-tree (snapshot) mode, which is token-cheap and reliable for most web automation tasks. Exposes `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, and related tools directly to the agent without requiring a local Playwright installation. The version is pinned in `src/memory/scaffold-integration.ts` — bump deliberately when validating against a newer release.
- **hindsight** — semantic memory bank, wired only when `memory.backend` is `hindsight`. Agents using a different memory backend (or none) don't get this server.

### Tuning auto-recall — `memory.recall.max_memories`

Hindsight's auto-recall hook injects relevant memories into every inbound prompt. Without a cap, a busy bank can return 16–22 memories per turn (forensic on real fleets), bloating the prompt and risking irrelevant memories steering the response.

```yaml
defaults:
  memory:
    recall:
      max_memories: 12   # workspace default (also the plugin default)

agents:
  coach:
    memory:
      recall:
        max_memories: 8  # tighter for a chatty agent

  research:
    memory:
      recall:
        max_memories: 0  # 0 = uncapped; let the token budget alone bound the block
```

The cap applies to the *combined* result list across the primary bank and any `recallAdditionalBanks`, not per-bank. Lower values reduce noise; very low values (≤3) can starve the agent of useful long-term context. The plugin's own default is `12`; omit the field to inherit it. Setting `0` (or any non-positive value) disables the cap entirely.

Operationally: the cap is set via the `HINDSIGHT_RECALL_MAX_MEMORIES` env var that `start.sh` exports. The vendored plugin's `recall.py` slices results client-side before formatting (plugin v0.4.0 has no `recallTopK` setting on the Claude Code integration — only Openclaw exposes it).

### Server-side caps on the Hindsight container

`switchroom memory --start` launches the bundled Hindsight container with `HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE=1000` already set. This caps how many observation entries Hindsight will hold per consolidation scope (per bank, per memory type) — without it, a 24/7 agent's bank grows unboundedly (vectorize-io/hindsight#1284 is the upstream tracking issue). The same default is baked into the `--compose` snippet output.

You don't need to do anything to opt in. Override by stopping the bundled container and re-running `docker run` with a different `-e HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE=N` value, or by editing the generated docker-compose snippet before applying it.

If you run your own Hindsight container outside `switchroom memory --start` (e.g. you point `memory.config.url` at an external server), switchroom doesn't manage that container's env — set the cap on your own image.

Any server from `defaults.mcp_servers` also flows to all agents via the normal cascade.

To suppress the built-in `playwright` server for a specific agent:

```yaml
agents:
  my-agent:
    mcp_servers:
      playwright: false   # opt-out: don't include the browser MCP for this agent
```

Or globally for every agent (in `defaults`):

```yaml
defaults:
  mcp_servers:
    playwright: false   # opt-out: no agent gets the browser MCP unless they explicitly enable it
```

## Progress-Card Tunable Thresholds

When `channels.telegram.stream_mode` is `checklist` (the default), the progress-card driver manages an edit-in-place Telegram message that tracks tool calls and sub-agent activity during a turn. The five knobs below control how it handles edge cases — timeouts, JSONL gaps, and Telegram API rate limits.

All values are in milliseconds unless otherwise noted. Omit a field to keep the built-in default. These fields are only effective when `stream_mode` is `checklist`.

| Field | Default | Description | When to tune |
|---|---|---|---|
| `orphan_promotion_ms` | 5000 (5 s) | How long a parent turn waits for a sub-agent JSONL watcher to deliver `sub_agent_started` before the heartbeat promotes the spawn to a synthesised "running" row. | Increase if fast sub-agents are appearing as orphan rows before their JSONL watcher can connect; decrease if you want orphan detection to fire sooner. Set to `0` to disable orphan promotion entirely. |
| `cold_sub_agent_threshold_ms` | 30000 (30 s) | JSONL-cold threshold. When a running sub-agent emits no events for this long, the heartbeat synthesises a `turn_end` for it so the deferred-completion path can proceed — avoids cards pinned forever on a dead watcher. | Increase if legitimate long-running sub-agents (e.g. waiting on a slow external API) are being falsely closed; decrease to recover faster from a genuinely dead watcher. |
| `deferred_completion_timeout_ms` | 180000 (3 min) | Force-close timeout after the parent `turn_end` arrives while sub-agents are still running. The card is force-closed after this many ms even if the sub-agents never finish. | Increase for agents that routinely spawn very long-running background sub-agents; decrease to shorten the worst-case delay before the card and pin are cleaned up. |
| `sub_agent_tick_interval_ms` | 10000 (10 s) | Elapsed-counter tick interval while a sub-agent is running. Forces a re-render so the elapsed counter advances even during silent stretches between tool calls. | Decrease for a more real-time counter (costs extra edits); increase to reduce edit traffic when many parallel sub-agents are active. Set to `0` to disable. |
| `edit_budget_threshold` | 18 | Card-edit budget per minute before the driver falls back to a slower coalesce window. When a chat exceeds this many edits in the trailing 60 s, the coalesce interval widens until the rate drops. | Increase if your gateway frequently hits the Telegram edit-rate ceiling with many parallel sub-agents; decrease for a more conservative buffer. |

Example: an agent with many parallel sub-agents that hit the Telegram rate ceiling:

```yaml
agents:
  worker:
    channels:
      telegram:
        stream_mode: checklist
        edit_budget_threshold: 12
        sub_agent_tick_interval_ms: 15000
```

## Profiles

Profiles are named partial configs that agents inherit from via `extends: <name>`. They can be defined in two places:

1. **Inline** in switchroom.yaml under `profiles:` — takes priority
2. **Filesystem** at `profiles/<name>/` — contains `CLAUDE.md.hbs`, `SOUL.md.hbs`, and optional `skills/`

```yaml
profiles:
  advisor:
    tools:
      deny: [Bash, Edit, Write]
    soul:
      style: warm, empathetic
      boundaries: not a licensed professional
    system_prompt_append: |
      Prioritize listening over advising.

agents:
  coach:
    extends: advisor
    topic_name: "Coach"
```

## Global Skills Pool

Skills live in `switchroom.skills_dir` (default `~/.switchroom/skills/`). Each subdirectory is a named skill. Agents select skills via `skills: [name1, name2]` — scaffold symlinks them into the agent's `skills/` directory.

## Skill Secrets, Env Vars, and Dependency Caches

Ported skills follow a few conventions that keep them decoupled from the host filesystem.

### Env-var naming

Each skill exposes its secrets to scripts via env vars of the form `<SKILL>_<FIELD>`, upper-snake-case. The skill's `SKILL.md` is authoritative for the exact names; examples:

| Skill | Env var | Resolved from |
|---|---|---|
| `garmin` | `GARMIN_TOKEN_DIR` | `vault:garmin-tokens` (kind="files" → temp dir path) |
| `compass` | `COMPASS_CREDS` | `vault:compass-creds` (kind="string") |
| `doctor-appointments` | `HOTDOC_CREDS` | `vault:hotdoc-creds` (kind="string") |
| `home-assistant` | `HA_SSH_KEY` | `vault:ha-ssh-key#id_rsa` (specific file inlined) |

The left side (`<SKILL>_<FIELD>`) is the runtime contract with the skill's scripts; the right side is the Switchroom vault reference that fills it in. Use `env:` in the agent config to wire them together — vault references resolve at scaffold/start time.

### Vault reference syntax

References use the `vault:` scheme and accept an optional `#<filename>` fragment:

| Reference | Kind | Substituted with |
|---|---|---|
| `vault:<key>` | `string` | the raw string value |
| `vault:<key>` | `binary` | the base64 payload as-is |
| `vault:<key>` | `files` | path to a per-process temp dir materialized from the files |
| `vault:<key>#<filename>` | `files` | the named file's contents inlined as a string |

Materialized `kind="files"` dirs land under `$XDG_RUNTIME_DIR/switchroom/vault/<pid>/<key>/` (fallback `$TMPDIR/switchroom-vault-<uid>-<pid>/<key>/`), dir mode `0700`, files mode `0600`. They are wiped on process exit (SIGINT/SIGTERM/normal exit) and re-wiped whenever the same key is re-resolved within the same process, so a file removed from the vault between resolves never lingers on disk.

Manage entries with `switchroom vault set <key>`, `switchroom vault get <key>`, and `switchroom vault list`. Multi-line string values are preserved verbatim via piped stdin or `--file <path>`; file-kind entries are set programmatically via `setFilesSecret` (a CLI surface for multi-file set is tracked separately).

### Vault broker (Linux only)

For scheduled tasks that need vault access, switchroom can run a long-lived **vault broker** daemon that holds the decrypted vault in memory after a one-time passphrase entry. Cron scripts then ask the broker for keys instead of prompting for the passphrase on every run. The broker is **Linux-only by design** — its access control relies on cgroup-based systemd unit identification, which doesn't exist on macOS / WSL. On non-Linux platforms `switchroom vault get` always reads the vault file directly with the user's passphrase.

```yaml
agents:
  myagent:
    schedule:
      - cron: "0 8 * * *"
        prompt: "morning briefing"
        secrets: [google_calendar_token, weather_api_key]   # NEW
```

The `secrets:` array is **misconfiguration protection, not a security boundary**: it prevents a typo in cron-A from accidentally reading cron-B's keys, and it makes the per-cron secret surface area explicit at config-review time. It does not prevent attack — anyone who can edit cron scripts on the host can also edit `switchroom.yaml` to declare any keys, and anyone who has the vault passphrase can read the vault file directly. Frame it as: "the cron-A script that asks for `weather_api_key` was clearly meant to ask for it" — not "the cron-A script can't reach `bank_token` even if compromised."

The broker is started/stopped via `switchroom vault broker {start,stop,status,unlock,lock}`. When `installAllUnits()` runs (called by `switchroom agent create` and similar), a `switchroom-vault-broker.service` user unit is installed with `Restart=on-failure`, so the broker auto-restarts if it crashes and auto-starts at user login.

For interactive use — `switchroom vault get key`, `switchroom vault set key`, etc. — the CLI does **not** go through the broker. It reads the vault file directly with your passphrase. The broker's ACL would deny an interactive caller anyway (no cron systemd unit), and the user already has the passphrase.

### Per-skill dependency caches

Skills that need a Python venv or a Node `node_modules` tree get a lazy, hash-stamped cache per skill — no system-level installs, no per-agent duplication.

| Kind | Source file | Cache layout |
|---|---|---|
| Python | `skills/<skill>/requirements.txt` | `~/.switchroom/deps/python/<skill>/` (standard venv; `bin/python`, `bin/pip`) |
| Node | `skills/<skill>/package.json` (+ lockfile) | `~/.switchroom/deps/node/<skill>/` (with `node_modules/`, `node_modules/.bin/`) |

First invocation builds the env and stamps a sha256 of the inputs (`.requirements.sha256` / `.package.sha256`). Subsequent invocations short-circuit when the hash matches; any change to `requirements.txt`, `package.json`, or any recognized lockfile (`bun.lock`, `bun.lockb`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`) busts the cache and triggers a clean rebuild.

Manual recovery: `switchroom deps rebuild <skill>` force-rebuilds one skill's caches; pass `--python` or `--node` to scope.

Host prerequisites:
- Python venvs need `python3-venv` (on Debian/Ubuntu: `apt install python3.12-venv`). `switchroom health` reports missing deps.
- Node envs use `bun` by default. `npm` is available as an alternate installer.

## Multi-Account OAuth (Slot Pool)

Each agent owns a **pool** of Claude OAuth account slots. One slot is
active at a time; the others sit in the pool as automatic fallbacks when
the active slot hits a quota window. Nothing in `switchroom.yaml`
describes the pool — it's managed at runtime via `switchroom auth` (or
`/auth` inside Telegram).

On-disk layout per agent:

```
<agentDir>/.claude/
  accounts/
    <slot>/
      .oauth-token             # token value
      .oauth-token.meta.json   # { createdAt, expiresAt, quotaExhaustedUntil?, source }
  active                       # text file: name of the active slot
  .oauth-token                 # LEGACY path, mirrored from the active slot
  .oauth-token.meta.json       # LEGACY path, mirrored from the active slot
```

Slot names must match `[A-Za-z0-9._-]+` (max 64 chars). The legacy
top-level token paths are always kept in sync with the active slot so
`start.sh` and the `claude` CLI see no layout change.

### Auto-fallback on quota exhaustion

The switchroom telegram plugin polls each agent's quota. When the active
slot crosses the exhaustion threshold (~99.5% utilisation) the plugin:

1. Marks the slot `quota-exhausted` (writes `quotaExhaustedUntil` into
   the slot's meta file).
2. Picks the next healthy slot in the pool and switches to it.
3. Restarts the agent so the new token is picked up.
4. Posts a short notice into the chat; if no fallback slot is available,
   prompts you to `/auth add <agent>` another subscription.

A per-slot cooldown prevents fallback-loop storms if two polls race.
Source: `telegram-plugin/auto-fallback.ts`, `src/auth/accounts.ts`.

## Escape Hatches

For Claude Code settings switchroom doesn't wrap:

- **`settings_raw:`** — deep-merged into settings.json as the final step
- **`claude_md_raw:`** — appended verbatim to CLAUDE.md on initial scaffold
- **`cli_args:`** — extra flags appended to `exec claude` in start.sh (POSIX-quoted)

## Minimal Example

```yaml
switchroom:
  version: 1

telegram:
  bot_token: "vault:telegram-bot-token"
  forum_chat_id: "-1001234567890"

memory:
  backend: hindsight

agents:
  assistant:
    topic_name: "General"
```

Two lines per agent. Everything else inherited from sensible defaults.
