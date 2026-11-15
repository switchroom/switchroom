# disk-cleanup

Auto-tracks and cleans up ephemeral files created during Hermes Agent
sessions — test scripts, temp outputs, cron logs, stale chrome profiles.
<!-- no-tmp: ok — documents the legacy scratch scope this plugin cleans up -->
Scoped strictly to `$HERMES_HOME` and `/tmp/hermes-*`.

Originally contributed by [@LVT382009](https://github.com/LVT382009) as a
skill in PR #12212.  Ported to the plugin system so the behaviour runs
automatically via `post_tool_call` and `on_session_end` hooks — the agent
never needs to remember to call a tool.

## How it works

| Hook | Behaviour |
|---|---|
| `pre_tool_call` | Snapshot which paths named in the call's arguments do not exist yet, keyed by the owning task/session plus `tool_call_id` (the id alone is not unique: llama.cpp reuses one constant id). |
| `post_tool_call` | When `write_file` / `terminal` / `patch` creates a file matching `test_*`, `tmp_*`, or `*.test.*` inside `HERMES_HOME` — a path named in the call that did not exist before it — track it silently as `test` / `temp` / `cron-output`. Existing files the call edits, runs or lists are never tracked. |
| `on_session_end` | If any test files were auto-tracked during this turn, follow `session_end_mode`. |

## Session-end mode

Configure the automatic hook under `plugins.config.disk-cleanup.session_end_mode`:

```yaml
plugins:
  config:
    disk-cleanup:
      session_end_mode: report_only
```

| Value | Automatic session-end behavior |
|---|---|
| `report_only` | Query `dry-run` candidates and log/return bounded counts only; no deletion, directory sweep, registry write/prune, or reclaimed-byte estimate. |
| `cleanup` | Run the historical automatic `quick` cleanup. This remains the default when the setting is absent. |
| `disabled` | Drain this turn's auto-track state without querying or deleting. |

Unknown, malformed, or unreadable configured modes fail closed as `disabled`. This setting affects only
the automatic lifecycle hook; explicit `/disk-cleanup quick` and `/disk-cleanup deep` commands retain
their existing behavior.

For this hook, a missing `config.yaml` retains the historical `cleanup` default. A present file must
parse to a YAML mapping before that default can be used: malformed YAML, a null/non-mapping root, an
unreadable file, or a malformed `plugins` subtree disables automatic action. This is a plugin-local
safety check; once the user file is valid, the final value is read through Hermes's normal merged
configuration, so a managed `report_only` overlay overrides the user value.

`report_only` is not a general no-I/O promise: the earlier `post_tool_call` hook may already have
created/updated `disk-cleanup/tracked.json` when it auto-tracked a test file. At session end the
report-only branch only reads that registry through `dry_run()` and emits an application log count;
it does not save/prune the registry, sweep empty directories, or delete tracked paths.

Deletion rules (same as the original PR):

| Category | Threshold | Confirmation |
|---|---|---|
| `test` | every session end | Never |
| `temp` | >7 days since tracked | Never |
| `cron-output` | >14 days since tracked | Never |
| empty dirs under HERMES_HOME | always | Never |
| `research` | >30 days, beyond 10 newest | Always (deep only) |
| `chrome-profile` | >14 days since tracked | Always (deep only) |
| files >500 MB | never auto | Always (deep only) |

## Slash command

```
/disk-cleanup status                     # breakdown + top-10 largest
/disk-cleanup dry-run                    # preview without deleting
/disk-cleanup quick                      # run safe cleanup now
/disk-cleanup deep                       # quick + list items needing prompt
/disk-cleanup track <path> <category>    # manual tracking
/disk-cleanup forget <path>              # stop tracking
```

## Safety

<!-- no-tmp: ok — documents the legacy scratch scope this plugin cleans up -->
- `is_safe_path()` rejects anything outside `HERMES_HOME` or `/tmp/hermes-*`
- Windows mounts (`/mnt/c` etc.) are rejected
- The state directory `$HERMES_HOME/disk-cleanup/` is itself excluded
- `$HERMES_HOME/logs/`, `memories/`, `sessions/`, `skills/`, `plugins/`,
  and config files are never tracked
- User project trees (`workspace/`, `projects/`, `plans/`, `home/`, `patches/`,
  `skins/`, `themes/`, `contributors/`, `profiles/`, `backups/`) and `kanban/`
  (task attachments/workspaces) are never tracked or swept, even for files
  named `test_*`/`tmp_*`
- A tracked *directory* under a protected top level (e.g. `cache/`, which holds
  terminal snapshots) is never removed; only its files age out. Stale entries
  are logged as `SKIPPED` and dropped
- Backup/restore is scoped to `tracked.json` — the plugin never touches
  agent logs
- Atomic writes: `.tmp` → backup → rename
