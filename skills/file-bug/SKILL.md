---
name: file-bug
version: 0.1.0
description: |
  File a high-quality bug report against switchroom (or another configured
  repo). Pulls the right log files automatically, forces a root-cause
  section with citations, flags logging gaps when RCA can't be pinned, and
  files via `gh issue create`. Use when a user asks "file a bug",
  "open an issue", or describes a symptom that needs a real ticket.
license: MIT
compatibility: claude-code
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - WebFetch
  - AskUserQuestion
---

# file-bug — File a real bug, not a one-line stub

You are filing a bug. The point of this skill is to make low-effort bug filing harder than high-effort bug filing. Skipping any of the steps below produces a worse ticket than not filing at all — it fills the queue with noise the human has to chase later.

## When to use this skill

The user said "file a bug", "open an issue", "raise a ticket", "log this", or described a symptom that's clearly worth tracking. If the symptom is fuzzy, ask one question to pin it before filing — see "Phase 1" below.

## Non-goals

- Do not auto-file from a thin description. Push back if the symptom is too vague to RCA.
- Do not invent log lines or paste paraphrased excerpts. If the log doesn't say what the bug needs, that's a logging-fidelity finding, not a fix-up.
- Do not file when the user is in the middle of debugging — the bug is "what we couldn't fix in flow", not "what we just observed".

## Phase 1 — Lock the symptom

In one sentence: **What was supposed to happen, what actually happened, and the user-visible surface where it diverged.** If the user gave you any of these, restate them back. If anything is missing, ask one targeted question — e.g. "did this happen on the gymbro agent or on lawgpt?" — not a five-question form.

Pin a time window. The default is the user's last 10 minutes of activity; ask if it should be wider or earlier.

## Phase 2 — Pull the logs

Switchroom's standard log map (resolve `<agent>` from the user or from `SWITCHROOM_AGENT_NAME`):

| Source | Path | What's in it |
|---|---|---|
| Gateway events | `~/.switchroom/agents/<agent>/telegram/gateway.log` | Inbound/outbound messages, IPC, progress card, watcher, classifier output |
| Claude stdout/stderr | `~/.switchroom/agents/<agent>/service.log` | The agent's own session output, tool calls, errors |
| Systemd lifecycle | `journalctl --user -u switchroom-agent-<agent>` | Boot/restart/crash, exit codes |
| Cron lifecycle | `journalctl --user -u switchroom-agent-<agent>-cron` | Scheduled-task firings |
| Vault broker | `journalctl --user -u switchroom-vault-broker` | Audit log, ACL gates |

For each relevant source: extract the slice that brackets the symptom window. Use `awk '/<start-ts>/,/<end-ts>/'` or `journalctl --since "10 min ago"`. Do **not** paste raw multi-MB dumps; cap each excerpt at the lines that actually matter and signpost what was clipped.

If the gateway.log doesn't have what you need, check whether `progress-card.log`, `bridge.log`, or `subagent-watcher.log` are configured separately on this agent (some setups split).

## Phase 3 — Build a timeline

Order the relevant log lines by timestamp. Put them in a fenced block in the issue body. Annotate each line with one short prefix: what it tells us. The reader should be able to follow the timeline without opening a log file.

## Phase 4 — RCA

The bug body **must** have a `## Root cause` subsection. Fill it with:
- The line(s) that prove the root cause, by file and line number.
- One sentence stating what the proximate cause is and why those lines prove it.
- One sentence stating what the underlying cause is, if different from proximate.

If you can't pin RCA on the available log lines, **do not invent one**. Instead, write a `## Logging fidelity — what's missing` checklist:
- `[ ] Add log: <component>::<event-name> — fields: <a, b, c> — gates: <when to log>`
- `[ ] Capture: <signal we don't currently capture>` (e.g. timestamps on a ledger that doesn't have them, error_code on a catch site that swallows)

Logging-gap items are first-class outputs. They turn an unfileable bug into "we need to instrument <thing> before we can RCA this class of failure" — that itself is a useful issue.

## Phase 5 — Related issues

Run `gh search issues --repo switchroom/switchroom <symptom keywords>` and `gh issue list --repo switchroom/switchroom --state all --search "<symptom keywords>"`. Pick up to 5 related issues by similarity. List them in a `## Related` section with one-line descriptions of how they relate (duplicate? blocked-by? same surface?). If you find an exact duplicate, **stop** and tell the user — they should comment on the existing issue, not file a new one.

## Phase 6 — File

Use the canonical body shape from #87:

```
## Symptom
<one sentence — what diverged, on what surface>

## Timeline
\`\`\`
HH:MM:SS [gateway.log]    <line>
HH:MM:SS [service.log]    <line>
HH:MM:SS [journalctl]     <line>
\`\`\`
<one-paragraph narration of what happened>

## Root cause
<one paragraph — proximate + underlying — with file:line citations>

## Logging fidelity — what's missing
- [ ] <gap 1>
- [ ] <gap 2>
(omit this section if the existing logs were sufficient for RCA)

## Reproduction
1. <steps if known; "intermittent" or "happened once" is acceptable>

## Related
- #<n> — <how it relates>

## Environment
- agent: <name>
- branch: <branch> (run `cd ~/code/switchroom && git rev-parse --short HEAD`)
- runtime versions: <bun/node/claude-cli versions>
- triggered: <human-readable timestamp>
```

File the issue with `gh issue create --repo switchroom/switchroom --title "<short title>" --body "$(cat <<'EOF' ... EOF)"`. Write the body to a temp file first if it's longer than ~50 lines — bash heredocs in switchroom commits with embedded quotes are footguns.

After the issue is filed, paste the URL back to the user and stop. Do **not** start working on the bug — filing it was the work.

## Anti-patterns

- ❌ "Card didn't render. See logs." — no log excerpts, no RCA, no related-issue check. The reader has to do all the work you were supposed to do.
- ❌ "Probably a race in the IPC layer." — speculation without log proof. Either the log lines show the race or you have a logging-fidelity finding, not a bug.
- ❌ Filing without `gh search issues` first — duplicate noise.
- ❌ Pasting 500 lines of `journalctl` output. The reader's eye glazes over and the real signal gets buried.
- ❌ Telling the user "I'll file this" and then never doing it. The skill is the file step. If you can't file, say so and stop.

## Output

A single line: `Filed: <issue URL>`. Or, if you couldn't file: a single sentence stating what blocked it (missing logs, dup of #N, can't reach the symptom from here, etc.).
