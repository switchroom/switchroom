---
name: fleet-coding-clis
description: "Use when launching or tracking background coding CLIs like Codex or Claude Code."
---

# Background coding CLIs

How an agent runs Codex, Claude Code, Grok Build or a similar coding CLI as a background job,
and how it reports on that job. It uses existing Hermes tools; it adds no supervisor, plugin or
model-routing setting.

This skill grants nothing. It does not enable coding for an agent, give repository access, log
an agent in, or widen a specialist's permissions.

## Reporting contract

1. **Name and own the job.** Before launch, say in one line which task, CLI, repository and
   result you intend. After launch, record the process ID, worktree and branch, brief path and
   report path in the existing task record. A launch acknowledgement is not progress. Do not
   create a second executor just to track the job.
2. **Use native completion notification.** Launch finite jobs with
   `terminal(background=true, notify=true, heartbeat=0, workdir=...)`. Keep output visible to the
   process registry; if you `tee` to a private log, preserve the CLI's exit status. Do not use
   shell `&`, `nohup`, the vendor's own background mode or a polling loop. Use
   `persist_on_release=true` only when the person explicitly wants the job to outlive the
   conversation.
3. **Show the real workflow.** For multi-step work, use the task list with an explicit
   verification step. Only one item is in progress at a time; parallel jobs sit under one
   orchestration step.
4. **Report evidence, not chatter.** Relay milestones, blockers and changed expectations. Never
   invent percentages, ETAs, test counts or activity. Keep raw JSON, diffs and secrets out of
   updates. Surface authentication, quota, permission or input blockers with the next safe
   action; do not silently switch provider, billing or approval policy.
5. **Wait without churn.** Do not poll to wait. Do other authorized work, or end the turn and let
   completion arrive. On a status request, inspect the job once. "No recent output" is not proof
   of a hang; do not kill or relaunch a quiet job without evidence.
6. **Exit is not acceptance.** On completion, check the exit status, error output, diff and
   artifacts, and rerun the tests yourself. Follow the repository's independent review rule (see
   `coding-independent-review-merge`). After an interruption, reconcile the existing process and
   remote state before resuming. Stop stays stopped.

## Launching any coding CLI

- Work in a named, owned Git worktree with a bounded brief on disk: editable repositories, test
  commands and prohibited effects.
- Container isolation is not worktree confinement. The CLI can reach whatever the agent's
  container can. Keep credentials and host-level access out of coding tasks.
- Do not change AppArmor, seccomp, capabilities, privileged mode, approval policy, model routing
  or OAuth state to get a CLI to start.
- Check login with the CLI's own status command without printing credential fields. A missing or
  expired login is an authentication blocker; do not substitute an API key or a paid route the
  person did not grant.
- Use one consistent `HOME` for the CLI so it finds the agent's own login. Never copy
  authentication between homes or agents.

## Codex

When agents already run as unprivileged users in separate containers, the container can be the
execution boundary, and Codex's own Bubblewrap sandbox usually cannot start inside it. A
deployment that accepts the container as the boundary sets, in each agent's own Codex
`config.toml`:

```toml
sandbox_mode = "danger-full-access"
```

Make that a reviewed per-profile configuration change that touches only this key and keeps a
rollback copy. Then run ordinary `codex exec` without `--sandbox` overrides and without the
deprecated `--full-auto`. Launch with `pty=true`, and keep the detailed report separate from
`--output-last-message`.

`codex sandbox -- /bin/true` is not proof of the configured default; some versions force
read-only for that debug command.

## Claude Code

- Run one-shot `claude -p` with a bounded brief, `--max-turns`, and
  `--output-format stream-json --verbose`. Launch with `pty=false` and close stdin with
  `</dev/null`.
- Do not combine `-p` with the CLI's own background flag; Hermes owns the background process.
- Do not use `--bare` with a subscription login; it skips that login and needs API billing.
- For approved non-interactive coding, a narrow tool allow list (for example
  `--allowedTools Read,Write,Edit,Bash`) avoids silently waiting on a prompt. Managed and deny
  policies still apply; never switch shared settings to a bypass mode.

## Grok Build

- Run one-shot `grok -p` (or `--prompt-file`) with `--max-turns` and
  `--output-format streaming-json`. Launch with `pty=false` and `</dev/null`.
- Prefer narrow allow rules with a non-prompting permission mode. Use always-approve only for an
  approved container task when no intentional deny or managed policy would be bypassed.
- An auth file existing does not prove a usable login; a real bounded prompt must succeed.

## Acceptance

Verify output artifacts, unchanged test inputs, real tool execution and final exit status. Rerun
the tests independently. Zero exit or the model's own success prose is not acceptance, and
permission or quota errors are not success.
