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
| `model` | override | Claude model (`claude-opus-4-6`, `claude-sonnet-4-6`) |
| `extends` | — | Named profile to inherit from |
| `tools.allow` / `tools.deny` | union | Tool permissions |
| `soul` | per-field | Agent persona (name, style, boundaries) |
| `memory` | per-field | Hindsight collection and recall settings |
| `hooks` | per-event concat | Claude Code lifecycle hooks (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd) |
| `env` | per-key | Environment variables for start.sh |
| `mcp_servers` | per-key | Additional MCP server configurations |
| `system_prompt_append` | concatenate | Appended to the system prompt via `--append-system-prompt` |
| `skills` | union | Named skills from the global skills pool (`switchroom.skills_dir`) |
| `subagents` | per-key | Sub-agent definitions rendered to `.claude/agents/<name>.md` |
| `schedule` | concatenate | Cron-based scheduled tasks (systemd timers) |
| `session.max_idle` | override | Fresh session after idle period (`2h`, `30m`) |
| `session.max_turns` | override | Fresh session after N user turns |
| `channels.telegram.plugin` | override | `switchroom` (default, enhanced) or `official` |
| `channels.telegram.format` | override | Reply format (`html`, `markdownv2`, `text`) |
| `channels.telegram.rate_limit_ms` | override | Min delay between outgoing messages |
| `settings_raw` | deep merge | Escape hatch: raw settings.json overrides |
| `claude_md_raw` | concatenate | Escape hatch: append to CLAUDE.md on scaffold |
| `cli_args` | concatenate | Escape hatch: extra `exec claude` flags |

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
