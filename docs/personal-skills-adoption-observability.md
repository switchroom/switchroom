# Personal-skills adoption observability

> **Why this doc exists.** RFC v3 (#1819) deferred Phase 2 — operator-
> approval-gated edits to the **shared** skill pool — until 60+ days of
> personal-skill usage data is in. This doc says how to read that data.

## Version control (durability)

Personal skills are *runtime state* at
`~/.switchroom/agents/<agent>/.claude/skills/personal-<name>/` —
survive container recreate but NOT git-tracked. A host rebuild loses
every personal skill.

If `~/.switchroom-config/` exists (the operator's private config repo),
every successful `init_personal` / `edit_personal` / `clone_to_personal`
also writes an opportunistic mirror to:

```
~/.switchroom-config/agents/<agent>/personal-skills/<name>/
```

`remove_personal` moves the corresponding mirror to a sibling
`.<name>-trash-<ts>/` dir so the deletion shows up in `git status`.
Each edit also leaves a `.<name>-prior-<ts>/` sibling holding the
prior content (cheap recovery before the operator commits).

**Retention.** `.prior-*` and `.trash-*` siblings older than **24h**
get swept lazily on the next mirror op. Without this, a chatty agent
would accumulate one stale dir per edit forever. Mirrors the live
`skills-trash` 24h sweep so the operator's mental model is uniform.
Anything older than 24h lives in git history once the operator
commits.

Override `SWITCHROOM_CONFIG_DIR` to point at an alternate repo
(separate-operator fleets, tests). If the config repo doesn't exist
the mirror **silently no-ops** (operator hasn't opted in). If the
repo exists but a mirror write fails (EACCES, ENOSPC,
cross-device-link), a warning prints to stderr and the live copy
continues unaffected.

**No auto-commit.** The operator commits the config repo at their own
cadence. `cd ~/.switchroom-config && git status` shows what's changed.

## What's instrumented

After v0.13.45 + the audit-instrumentation follow-up, every **mutating**
personal-skill op writes one JSONL row to
`~/.switchroom/audit/<agent>/agent-config.jsonl`:

| cmd                    | When                                                  |
|------------------------|-------------------------------------------------------|
| `skill.init_personal`  | New personal skill written (success path only)        |
| `skill.edit_personal`  | Existing personal skill overwritten (success only)    |
| `skill.remove_personal`| Personal skill moved to trash (success only)          |

`skill.list_personal` and `skill.search` are read-only and **not**
audited — they fire too often to be useful signal. Disk state at
`~/.switchroom/agents/<agent>/.claude/skills/personal-*/` is the ground
truth for "what skills currently exist."

Failure paths exit via `fail()` before the audit call. That's deliberate:
we want adoption signal, not error rate (the existing structured CLI
errors already cover the failure case).

## Reading the data

```bash
node scripts/observe-personal-skills.mjs            # text report
node scripts/observe-personal-skills.mjs --json     # machine-readable
node scripts/observe-personal-skills.mjs --since 7d # last week only
sudo node scripts/observe-personal-skills.mjs       # full file/byte counts
```

**Personal-skill dirs are mode 0700** (per-agent private workspace).
The host operator can see the dir NAME (via the 0755 parent at
`.claude/skills/`), but the dir's CONTENTS are unreadable without
root. Running as operator surfaces the entry correctly but shows
`files=? bytes=?  <opaque (need sudo)>` for each. The top-of-report
`Unreadable (0700 dirs): N` line tells you when to re-run with sudo
for accurate file/byte numbers. The **dir count itself** — the
load-bearing signal for the 60-day decision — is correct either way
(#1832).

The script reads:

1. **Disk state** — every `~/.switchroom/agents/<agent>/.claude/skills/personal-<name>/`
   dir. Reports name, file count, size, mtime. This is the authoritative
   "is anyone using this?" signal.
2. **Trash state** — `~/.switchroom/agents/<agent>/.claude/skills-trash/`.
   Recently-removed skills, recoverable for 24h. Helps separate
   experimentation from durable adoption.
3. **Audit log** — `~/.switchroom/audit/<agent>/agent-config.jsonl`,
   filtered to `skill.*_personal`. Gives the time series — when did the
   workflow start being used, what's the cadence per agent.

## Phase-2 decision criteria (60-day checkpoint, ~2026-07-25)

Re-run the script after the 60-day window. The Phase 2 RFC body should
cite the actual numbers, not assumptions.

**Strong signal for Phase 2 priority (proceed with the design):**

- ≥ 50% of fleet agents have authored at least one personal skill
- Total `skill.init_personal` count > 10× total `skill.remove_personal`
  (means skills are sticking, not just being tried+abandoned)
- Operator has been asked to copy a personal skill into the shared pool
  at least 3 times (the Workflow-3 demand signal — proves the gap that
  Phase 2 would close)

**Weak signal (defer Phase 2 further):**

- < 20% of agents have used the workflow at all
- Most `init_personal` events have a matching `remove_personal` (test
  drives, not adoption)
- No operator request to promote a personal skill to shared

**No signal (the deferred-tracker #1821 stays closed):**

- Zero personal skills authored across the fleet
- Indicates the workflow either isn't discovered (skill_search itself
  needs better surfacing) or isn't needed. Either way, Phase 2 is the
  wrong fix.

## What this doesn't measure

- **Skill quality** — usage count says nothing about whether the skills
  agents author are useful. Spot-check the actual `SKILL.md` files.
- **Operator-side burden** — Phase 2's whole reason for existing is
  reducing operator taps on the approval card. If operators are happy
  with the current `switchroom skill apply` CLI as the shared-pool path,
  Phase 2 buys nothing regardless of personal-skill volume.
- **Cross-agent capability spread** — `skill_search` could surface a
  shared skill to other agents; we don't currently log opt-ins, so this
  blind spot remains. If it matters, add audit rows to `skill_install`
  in a follow-up.

## Operating note

The audit log is best-effort: `appendAudit` swallows write errors silently
to avoid blocking the action. If the `~/.switchroom/audit/<agent>/` dir
is read-only, you'll see disk state but no audit rows for that agent.
Same defensive pattern as the existing `config.get` / `cron.list`
auditing.
