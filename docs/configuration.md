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
| **Per-key merge** | `mcp_servers`, `bundled_skills`, `env`, `subagents` | Agent wins on key conflict |
| **Per-field merge** | `soul`, `memory`, `session`, `channels` | Agent wins per sub-field |
| **Per-event concat** | `hooks` | Defaults first, then agent |
| **Concatenate** | `schedule`, `system_prompt_append`, `claude_md_raw`, `cli_args` | Defaults prepended/joined |
| **Override** | `model`, `extends`, `dangerous_mode`, all other scalars | Agent wins entirely |
| **Deep merge** | `settings_raw` | Recursive object merge, agent wins |

## Full Field Reference

| Field | Cascade | Description |
|-------|---------|-------------|
| `model` | override | Claude model (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`). Haiku is the default for the handoff summarizer; agents typically use opus or sonnet. |
| `extends` | — | Named profile to inherit from |
| `tools.allow` / `tools.deny` | union | Tool permissions |
| `soul` | per-field | Agent persona (name, style, boundaries) |
| `memory` | per-field | Hindsight collection and recall settings |
| `hooks` | per-event concat | Claude Code lifecycle hooks (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd) |
| `env` | per-key | Environment variables for start.sh |
| `mcp_servers` | per-key | Additional MCP server configurations. Set a key to `false` to suppress a built-in default (e.g. `playwright: false`) |
| `system_prompt_append` | concatenate | Appended to the system prompt via `--append-system-prompt` |
| `skills` | union | Named skills from the global skills pool (`switchroom.skills_dir`) |
| `bundled_skills` | per-key | Opt-out map for switchroom's bundled-default skills. Set a key to `false` to suppress (e.g. `pdf: false`). See [docs/skills.md](./skills.md). |
| `subagents` | per-key | Sub-agent definitions rendered to `.claude/agents/<name>.md` |
| `schedule` | concatenate | Cron-based scheduled tasks (in-agent scheduler sidecar — see [scheduling.md](./scheduling.md)) |
| `reactions.enabled` | override | Master switch for the reaction-trigger path (#1074). When `false`, reactions are still persisted but never forwarded to the agent as synthetic inbound turns. Default `true`. |
| `reactions.trigger_emojis` | replace | Emoji allowlist that triggers a synthetic `<channel source="reaction">` inbound when reacted to a bot message. **Replace semantics**, not union — set to `[]` to disable triggering without flipping `enabled`. Default `['👎', '❌', '👍', '✅']`. |
| `reactions.debounce_ms` | override | Per-chat debounce window in ms. Reactions within the window collapse into one batched synthetic. Default `30000`. |
| `reactions.per_hour_cap` | override | Max reaction-triggered synthetic turns per chat per rolling hour. Refusals are stderr-logged but not surfaced to the agent. Default `10`. |
| `reactions.group_admin_only` | override | In groups/supergroups, only trigger when the reacter is `creator` or `administrator`. Failing the lookup is treated as non-admin (fail-closed). DMs are never affected by this flag. Default `true`. |
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
| `google_workspace` | deep merge | Google Drive/Docs/Sheets/Calendar integration. `google_client_id` / `google_client_secret` are install-wide (top level only); `tier` + `approvers` cascade per-agent. See § Google Workspace below. |

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

### Demoting individual memories from auto-recall

If one specific memory keeps surfacing in the recall block and isn't useful (over-broad world fact, stale context, etc.), tag it with `[demote-from-recall]` — or `demote-from-recall` / `no-recall`, all three work. The memory stays in the bank, `mcp__hindsight__reflect` and manual recall can still find it, but auto-recall skips it.

```
# inside an agent, against its own bank
mcp__hindsight__update_memory(memory_id="abc-123", tags=["[demote-from-recall]"])
```

The filter runs before the `max_memories` cap, so demoting a noisy memory doesn't waste a slot.

### Inspecting auto-recall in production — `switchroom memory recall-log`

Every auto-recall run (cache hit or miss) appends a JSONL record to the agent's plugin-state dir. View via:

```
switchroom memory recall-log [agent] [-n N] [--json]
```

Per-agent output looks like:

```
clerk:
  last 20 turns: avg=11.4 max=12 cache_hits=2 capped=8
  2026-04-30T07:53:45Z OK    n=12 ids=mem-a1,mem-c4,mem-9f…+9
  2026-04-30T07:52:10Z CAP   n=12/18 ids=mem-a1,mem-c4,mem-7e…+9
  2026-04-30T07:51:33Z CACHE n=—
```

`OK` = uncapped recall fired; `CAP` = recall returned more than `max_memories` and was sliced; `CACHE` = served from the per-session cache (#424 4.1).

Use this to answer "is 12 the right cap?" — if `CAP` fires on most turns, the bank has more relevant content than 12 lets through; consider raising. If `CAP` rarely fires and `avg` stays well below the cap, the cap isn't the lever and other tuning (`recallBudget`, retain hygiene) probably matters more.

The log is bounded to the last ~5000 events per agent.

### Server-side caps on the Hindsight container

`switchroom memory --start` launches the bundled Hindsight container with `HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE=1000` already set. The same default is baked into the `--compose` snippet output.

What this actually caps: per-*tag scope* observation count. Switchroom's vendored plugin retains with `retainTags: ["{session_id}"]`, so each session becomes its own scope and the cap bounds a single very-long session at 1000 observations. Most sessions stay well below 1000 — this is a safety rail for the worst case (a Telegram session running uninterrupted for weeks), not an active limit on most agents. Tagless observations are unaffected.

This is **not** a fix for vectorize-io/hindsight#1284 (the upstream unbounded-growth bug for whole-bank consolidation) — that's their work to do. It's a companion guardrail.

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

For scheduled tasks that need vault access, switchroom runs a long-lived **vault broker** container that holds the decrypted vault in memory after a one-time passphrase entry (or via auto-unlock; see [vault-broker.md](./vault-broker.md)). Cron-fired prompts then ask the broker for keys instead of re-prompting on every run. The broker is **Linux-only by design** — its access control relies on socket-path-as-identity (each agent gets its own UDS bound by the broker at `/run/switchroom/broker/<agent>/sock`), which only composes on Linux. On non-Linux platforms `switchroom vault get` always reads the vault file directly with the user's passphrase.

```yaml
agents:
  myagent:
    schedule:
      - cron: "0 8 * * *"
        prompt: "morning briefing"
        secrets: [google_calendar_token, weather_api_key]   # NEW
```

The `secrets:` array is **misconfiguration protection, not a security boundary**: it prevents a typo in cron-A from accidentally reading cron-B's keys, and it makes the per-cron secret surface area explicit at config-review time. It does not prevent attack — anyone who can edit cron scripts on the host can also edit `switchroom.yaml` to declare any keys, and anyone who has the vault passphrase can read the vault file directly. Frame it as: "the cron-A script that asks for `weather_api_key` was clearly meant to ask for it" — not "the cron-A script can't reach `bank_token` even if compromised."

The broker runs as a `docker compose` singleton service alongside the agent containers (see `~/.switchroom/compose/docker-compose.yml`). `switchroom apply` regenerates the compose file and `docker compose up -d` brings the broker up with `restart: unless-stopped`, so it auto-restarts on crash and at host boot. CLI verbs `switchroom vault broker {status,unlock,lock,enable-auto-unlock}` talk to the running container.

For interactive use — `switchroom vault get key`, `switchroom vault set key`, etc. — the CLI does **not** go through the broker. It reads the vault file directly with your passphrase. The broker's ACL would deny an interactive caller anyway (the bind-time path-as-identity ACL only grants the per-agent UID), and the user already has the passphrase.

#### Approval posture (`vault.broker.approvalAuth`)

When an agent requests vault access via Telegram, the operator gets an inline card with **Approve** / **Deny** buttons. The factor an Approve tap relies on is configurable via `vault.broker.approvalAuth`:

```yaml
vault:
  broker:
    autoUnlock: true
    approvalAuth: telegram-id   # default: passphrase
    postureMintAgents:           # required when approvalAuth is telegram-id;
      - test-harness             # otherwise no agent can self-mint via posture.
```

| `approvalAuth` | `autoUnlock` | Approve tap result |
|---|---|---|
| `passphrase` (default) | either | Prompts for the vault passphrase before minting the grant. **Two-factor**: Telegram identity + passphrase. |
| `telegram-id` | `true` (required) | Mints immediately with no passphrase prompt. **Single-factor**: Telegram identity only. Agent must also be in `postureMintAgents`. |
| `telegram-id` | `false` | Config error at startup — the schema rejects this combination. |

**Threat model.**

- `passphrase` (default): an attacker who compromises the operator's Telegram account still needs the vault passphrase to mint grants. The passphrase never leaves the operator's device → broker → vault path.
- `telegram-id`: the broker is auto-unlocked at boot and holds the passphrase in memory. The gateway never holds the passphrase — it signals operator-tap intent to the broker via `attest_via_posture: true` on the mint call; the broker uses its retained passphrase internally and never sends it over the wire (#1115 follow-up rev 3). The on-callback gate is the sender's Telegram user ID matching the allowlist; the broker's gate adds (a) `approvalAuth: telegram-id` configured, (b) broker unlocked, (c) calling agent's name is in `postureMintAgents`, (d) request's `agent` field equals the calling agent (no cross-agent posture mint). **An attacker with Telegram account access can mint grants on opted-in agents.** Acceptable when (a) the operator has Telegram 2FA enabled, (b) the host is not multi-tenant, (c) the convenience of zero-friction approvals outweighs the lost factor.

**`postureMintAgents` (per-agent opt-in).** Under `approvalAuth: telegram-id`, only agents on this list can mint grants without a passphrase. **Default `[]`** — even with `telegram-id` enabled, no agent self-mints until you explicitly add its slug. This blocks the in-container threat: claude inside an agent container shares socket access with the gateway, so without this list a tool or skill could call the broker directly and mint without an operator tap. With the list, only the agents you trust at the "broker-auto-unlock-equivalent" level can use the silent-mint path. Suggested rollout: start with `test-harness` only; never add a production agent without thinking explicitly about the trust expansion.

**Architectural residual risk** (telegram-id, allowlisted agents only): an allowlisted agent's claude can theoretically call `mint_grant attest_via_posture` for keys it already has read access to via the existing broker ACL — without an operator tap. This is the documented trade-off of single-factor mode on the current Docker runtime (gateway + claude share UID inside the agent container). To close this gap fully requires a gateway-UID-split (separate UID for gateway vs claude inside each agent) — tracked as a future hardening; not in scope for this feature. Operators who require "every grant requires an explicit tap" should stay on `passphrase` mode.

`telegram-id` is fully opt-in — the default behaviour is unchanged, and `switchroom doctor` surfaces the active posture so it's obvious which mode the host is running.

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

### Switchroom-managed token refresh (`auth refresh-tick`)

Anthropic's OAuth access tokens are short-lived (typically 8 hours). Pre-#429
the only thing that rotated them was the agent's own `claude` process noticing
expiry mid-turn — which fails for stop-hook subprocesses (where claude code
strips `CLAUDE_CODE_OAUTH_TOKEN` from env) and for agents that haven't received
a turn in 24h+. The result was silent 401s on the next inbound message.

`switchroom auth refresh-tick` rotates tokens proactively. Iterate every
agent, check `<agentDir>/.claude/.credentials.json`, and POST to Anthropic's
OAuth refresh endpoint when the access token's remaining lifetime is below
the threshold (default 1h) AND a `refreshToken` is present. The new token
is atomically rewritten into both `.credentials.json` and the active slot's
`.oauth-token` (so start.sh and the legacy mirror see it).

```bash
switchroom auth refresh-tick                       # default 1h threshold, prose output
switchroom auth refresh-tick --json                # structured summary for logs
switchroom auth refresh-tick --threshold-ms 7200000  # custom threshold (2h here)
```

The tick is idempotent and safe to run as often as you like — when nothing
needs refreshing it makes no network calls and writes no files. Wire it to
a cron line on the host (or to an agent's `schedule:` block, which fires
through the in-agent scheduler sidecar — see [scheduling.md](./scheduling.md)):

```
# crontab — every 15 minutes
*/15 * * * * switchroom auth refresh-tick --json >> ~/.switchroom/refresh.log 2>&1
```

Outcomes per agent: `refreshed`, `skipped-fresh`, `skipped-no-refresh-token`
(boot-self-test will already be prompting the user to re-auth in chat),
`skipped-no-credentials`, `skipped-malformed`, `failed`. Process exits
non-zero only when every refresh attempt failed AND nothing was already
fresh — partial failures stay visible without taking the timer down.

Source: `src/auth/token-refresh.ts`.

## Google Workspace (`google_workspace:`)

Centralizes the Google OAuth client + the Drive/Docs/Sheets/Calendar
tier knob. The legacy RFC D key `drive:` is an accepted alias (identical
shape); the loader errors if both are set to different values.

```yaml
google_workspace:
  google_client_id: "vault:google-oauth-client-id"
  google_client_secret: "vault:google-oauth-client-secret"
  approvers: [123456789]      # ≥1 Telegram numeric user id
  tier: core                  # core | extended | complete
```

| Field | Cascade | Notes |
|---|---|---|
| `google_client_id` | top level only | OAuth client id. Literal or `vault:<key>` ref. One client per install (Google ToS) — **not** per-agent. Env override: `SWITCHROOM_GOOGLE_CLIENT_ID`. |
| `google_client_secret` | top level only | OAuth client secret. Literal or `vault:<key>` ref. Env override: `SWITCHROOM_GOOGLE_CLIENT_SECRET`. |
| `approvers` | override (per-agent may narrow) | ≥1 Telegram numeric user id authorized to approve Drive onboarding. Env override: `SWITCHROOM_APPROVER_USER_ID`. |
| `tier` | override | Upstream `google_workspace_mcp` tool tier. `core` (default, ~16 tools: Drive+Docs+Sheets+Calendar), `extended` (~40: +Slides/Forms/Tasks/Chat), `complete` (~60+: +Gmail — not recommended; Gmail's per-thread approval shape is unsuitable today, see RFC G §5). |

The block is optional. When absent, `switchroom auth google account
add` and the rest of the fleet Drive surface error with a guided
next-step (run `switchroom auth google connect`, the one-time
onboarding wizard). The wizard writes this block for you. Full setup
walkthrough — including the GCP Console steps and why switchroom ships
no shared client — is in `docs/google-workspace.md` § Prerequisite.

`google_client_id` / `google_client_secret` are deliberately top-level
only: one OAuth client per switchroom install. A per-agent
`google_workspace:` override may narrow `approvers` or pick a different
`tier`, but not the client credentials (RFC G Phase 1).

### Per-account ACL + per-agent selection (`google_accounts:` + `google_workspace.account`)

The `google_workspace:` block above only configures the OAuth *client*.
Two more pieces gate whether a given agent can actually reach Drive —
**both are required; one without the other silently fails:**

```yaml
google_accounts:                 # top-level; keyed by the Google EMAIL
  alice@example.com:             #   (validated + lowercased — NOT an
    enabled_for: [carrie, finn]  #   arbitrary label)

agents:
  carrie:
    google_workspace:
      account: alice@example.com  # the account THIS agent uses
```

| Field | Notes |
|---|---|
| `google_accounts.<email>.enabled_for[]` | The cross-agent ACL: which agents may read that account's broker-held refresh token. Set by `switchroom auth google enable <email> <agents…>` (or by hand). |
| `agents.<name>.google_workspace.account` | The account the broker returns for that agent. The launcher passes **no** account — the broker derives it from this field (path-as-identity) and then enforces `enabled_for[]`. Must be a key in `google_accounts:`. |

Being listed in `enabled_for[]` is **necessary but not sufficient**: an
agent with no `google_workspace.account` gets `ACCOUNT_NOT_FOUND` from
the broker; an agent with `account:` set but absent from that account's
`enabled_for[]` gets `ACCESS_DENIED`. Both are silent at config time and
only surface when the agent tries to use Drive — so `switchroom doctor`
has a **Google Drive** section that flags every such mismatch (and the
deployed `.mcp.json`/trust wiring) up front. Run it after any change
here.

## Escape Hatches

For Claude Code settings switchroom doesn't wrap:

- **`settings_raw:`** — deep-merged into settings.json as the final step
- **`claude_md_raw:`** — appended verbatim to CLAUDE.md on initial scaffold
- **`cli_args:`** — extra flags appended to `exec claude` in start.sh (POSIX-quoted)

## Admin-Only: Extra Bind-Mounts (`bind_mounts:`)

Agent containers ship with a fixed bind-mount set (state dir, .claude
project dir, logs, read-only skills + credentials). That is the right
default for the typical fleet — sandboxed agents stay isolated from
the host's source trees and operator state.

### Which primitive solves which problem

`bind_mounts:` is the catch-all *extra host paths* escape hatch.
Before reaching for it, check whether one of the more focused
primitives is the right tool:

- **"Agent should edit a git repo (incl. switchroom itself)."** Use
  `repos:` (see `src/config/schema.ts` `AgentRepoEntry`). Switchroom
  provisions a dedicated worktree at `<agentDir>/work/<slug>/` from
  a shared bare clone — the agent edits *inside its own sandbox*,
  not on a mounted host checkout. `bind_mounts:` is not needed and
  doesn't help: the worktree pattern lets the agent commit + push +
  open a PR using its own git identity without touching host state.
- **"Admin agent should deploy a merged change (`switchroom apply`,
  `agent restart`, `update apply`)."** That's the host-control
  daemon's job — see `docs/rfcs/host-control-daemon.md`. `bind_mounts:`
  does not give an agent host-side control; even with the source
  tree mounted, the agent can't run docker commands or `sudo` on
  the host. The daemon is the right surface.
- **"Operator + agent need to share a host directory that isn't a
  git repo and isn't operator config."** *That's* what `bind_mounts:`
  is for. Examples: a shared `~/shared/notes` dir two agents
  collaborate in; a read-only NAS path; a small operator file the
  agent maintains.

If none of the above fit and you still want filesystem reach for a
non-admin agent, the right answer is to run a separate Claude
session from outside switchroom (a host shell), not to relax the
admin gate.

### Shape

```yaml
agents:
  collab-bot:
    admin: true                      # required — see "Admin gating" below
    bind_mounts:
      - source: /home/me/shared/notes
        target: /home/agent/notes    # optional; defaults to `source`
        mode: rw                     # default is `ro`
    add_dirs:
      - /home/me/shared/notes        # also extend claude's tool-reach
```

Each entry takes:

- **`source:`** (required) — absolute host path. Tilde-expansion is
  **not** performed; pass the literal path. Refused if the path is
  under a system-path denylist (`/`, `/etc`, `/proc`, `/sys`, `/dev`,
  `/run`, `/var/run`, `/boot`, `/var/lib/docker`) or equals
  `/var/run/docker.sock`. Repeated `/`, `.` segments, and trailing
  `/` are normalized before the denylist check, so `//etc`,
  `/etc/.`, and `/etc/` are all refused as expected.
- **`target:`** (optional) — container path the mount appears at.
  Defaults to the same path as `source`, matching switchroom's
  existing dual-mount convention so absolute paths in scaffolded
  scripts and tool invocations Just Work. Refused if it shadows a
  switchroom-owned container path (`/state`, `/run/switchroom`,
  `/opt/switchroom`, `/var/log/switchroom`) or an OS path inside
  the container (`/etc`, `/bin`, `/sbin`, `/usr/{bin,sbin,lib}`,
  `/lib`, `/lib64`, `/proc`, `/sys`, `/dev`, `/boot`).
- **`mode:`** (optional, default `ro`) — `ro` or `rw`.

> **Note (symlinks):** the source-path denylist is *textual*. If
> `source` points at a host path that is itself a symlink to a
> denylisted directory (e.g. `/home/me/proj` → `/etc`), Docker
> resolves the symlink at mount time and the agent ends up with
> `/etc` regardless. Admin-trusted: the operator who set `admin:
> true` is the same principal who controls host filesystem layout,
> so the textual check is the right tradeoff against doing
> `fs.realpathSync` in the compose generator (which would couple
> compose generation to filesystem state). If you want defense
> here, declare absolute paths only and avoid symlinking your
> mount sources.

### Admin gating

`bind_mounts:` requires `admin: true` on the same agent. `switchroom
apply` hard-fails if a non-admin agent declares it — silently
dropping the entries would mask an intended privilege grant. The two
are coupled deliberately: the same operator who already trusts an
agent with vault grant-management (`/grant`) and fleet-admin slash
commands (`/agents`, `/logs`, `/update`) is the right principal for
extra-bind-mount access.

### Pair with `add_dirs:`

`bind_mounts:` makes the path **exist** inside the container.
`add_dirs:` makes the claude CLI's tool-allowlist **include** it.
You typically want both. Without `add_dirs:`, claude's Read/Edit
tools will reject the path as outside the working set even though
the file is there. Without `bind_mounts:`, the path doesn't exist in
the sandbox and `add_dirs:` is a no-op.

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
