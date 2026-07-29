# Switchroom documentation index

A grouped map of everything under `docs/`. Start at **Getting started**;
operators jump to **Operating**; contributors and reviewers use
**Architecture & internals** and **Reference**. Dated snapshots in
**Archived** are point-in-time and not current guidance.

## Getting started

| Doc | What it covers |
|---|---|
| [install.md](install.md) | Zero-to-first-message in ~15 minutes on a fresh Linux host. |
| [operators/install.md](operators/install.md) | Operator install — pulling the Docker fleet from GHCR. |
| [botfather-walkthrough.md](botfather-walkthrough.md) | Step-by-step Telegram bot creation in BotFather (~3 min/bot). |
| [configuration.md](configuration.md) | The `switchroom.yaml` three-layer config cascade reference. |
| [skills.md](skills.md) | Where switchroom finds skills, how they install into agents, bundled vs operator-managed. |
| [telegram-features.md](telegram-features.md) | The three opt-in features that tune how an agent talks on Telegram. |

## Operating

| Doc | What it covers |
|---|---|
| [operators/runtime-mode.md](operators/runtime-mode.md) | Runtime mode — running the agent fleet as Docker containers on Linux. |
| [vault.md](vault.md) | Vault operator guide — declare/scope secrets, Telegram commands, audit log. |
| [vault-security.md](vault-security.md) | Vault security model — auth paths, threat model, which path to use when. |
| [vault-broker.md](vault-broker.md) | Vault broker ACL model and the path-as-identity access contract. |
| [auto-unlock.md](auto-unlock.md) | Boot-time machine-bound vault auto-unlock: setup and recovery. |
| [auth.md](auth.md) | Auth via the switchroom-auth-broker (OAuth, Pro/Max subscription). |
| [operators/auth-broker-drift.md](operators/auth-broker-drift.md) | Recovering when the auth-broker (sole credential writer) drifts. |
| [operators/state-e-recovery.md](operators/state-e-recovery.md) | Recovering from vault layout divergence (State E). |
| [operators/rollback-v0.7.12.md](operators/rollback-v0.7.12.md) | Rollback runbook: v0.7.12 → v0.7.11. |
| [scheduling.md](scheduling.md) | Scheduled tasks via the in-container scheduler sibling. |
| [crash-reports.md](crash-reports.md) | What the watchdog records when it kills an agent. |
| [operators/stale-pin-cleanup.md](operators/stale-pin-cleanup.md) | Clearing orphaned bot pins the automatic sweep deliberately cannot touch. |
| [status-ask-cause-classes.md](status-ask-cause-classes.md) | Cause-class catalog for driving the status-ask rate to zero. |
| [session-optimization.md](session-optimization.md) | Managing context/tokens in long-running agents. |
| [sub-agents.md](sub-agents.md) | Sub-agent delegation ("Opus plans, Sonnet implements"). |
| [supergroup-mode.md](supergroup-mode.md) | One agent owns a Telegram forum supergroup, routing work into per-topic threads (opt-in). |
| [google-workspace.md](google-workspace.md) | Agents reading Google Docs/Sheets/Slides/folders. |
| [linear.md](linear.md) | Agents as first-class Linear app actors: OAuth setup, self-refreshing tokens, MCP tools. |
| [webhook-ingest.md](webhook-ingest.md) | Pushing external events into a specific agent's log. |
| [posthog.md](posthog.md) | Telemetry: product analytics + error tracking via PostHog. |
| [publishing.md](publishing.md) | Publishing the switchroom Claude Code plugin / marketplace. |
| [compliance-attestation.md](compliance-attestation.md) | Switchroom compliance attestation summary. |

## Architecture & internals

| Doc | What it covers |
|---|---|
| [architecture.md](architecture.md) | System architecture — per-agent process model, gateway, the brain/mouth split. |
| [telegram-plugin.md](telegram-plugin.md) | The enhanced Telegram MCP plugin (default for all agents). |
| [workspace-files.md](workspace-files.md) | How an agent's context gets loaded (the three mechanisms). |
| [tmux-supervisor-fanout.md](tmux-supervisor-fanout.md) | Rollback to the legacy PTY supervisor (tmux is default since #725). |
| [streaming-deterministic.md](streaming-deterministic.md) | Historical research notes — deterministic MCP-level streaming (H1–H5). |
| [skill-coverage/inventory.md](skill-coverage/inventory.md) | Read-only skill-bundle inventory feeding the coverage harness. |
| [skill-coverage/audit.md](skill-coverage/audit.md) | Skill-bundle audit; companion to the inventory. |
| [skill-coverage/runbook.md](skill-coverage/runbook.md) | Skill-coverage harness live-run runbook. |
| [vs-nanoclaw.md](vs-nanoclaw.md) | Switchroom vs NanoClaw — positioning/tradeoffs. |
| [vs-openclaw.md](vs-openclaw.md) | Switchroom vs OpenClaw — positioning/tradeoffs. |

## Reference

### RFCs (`reference/rfcs/`)

| RFC | Title / status |
|---|---|
| [rfcs/bot-token-to-vault.md](../reference/rfcs/bot-token-to-vault.md) | RFC A: Complete the bot-token-to-vault migration (Draft v2). |
| [rfcs/approval-kernel.md](../reference/rfcs/approval-kernel.md) | RFC B: Unified human-approval kernel (Draft v4). |
| [rfcs/host-control-daemon.md](../reference/rfcs/host-control-daemon.md) | RFC C: Host-control daemon `switchroom-hostd` (Draft v3). |
| [rfcs/gdrive-mcp.md](../reference/rfcs/gdrive-mcp.md) | RFC D: Google Drive MCP integration (Implemented v0.6.0). |
| [rfcs/doc-connection-completion.md](../reference/rfcs/doc-connection-completion.md) | RFC E: Make Google Drive a real collaboration surface (Draft v3.1). |
| [rfcs/google-workspace-generalization.md](../reference/rfcs/google-workspace-generalization.md) | RFC G: Google Workspace as a first-class capability (Draft v3). |
| [rfcs/auth-broker.md](../reference/rfcs/auth-broker.md) | RFC H: switchroom-auth-broker single-writer credential plane (Draft v1). |

### Diagrams (`docs/diagrams/`)

| Doc | What it covers |
|---|---|
| [diagrams/DESIGN.md](diagrams/DESIGN.md) | Unified diagram design system (v3) + source-of-truth/regeneration model. |
| [diagrams/deterministic-status-anatomy.spec.md](diagrams/deterministic-status-anatomy.spec.md) | Regeneration spec for the deterministic-status anatomy diagram (supersedes the retired pinned progress-card). |
| [diagrams/approval-broker.spec.md](diagrams/approval-broker.spec.md) | Regeneration spec for the approval-broker concept diagram (plain-language "you hold the leash" sibling of approval-grant-flow). |
| [diagrams/approval-grant-flow.spec.md](diagrams/approval-grant-flow.spec.md) | Regeneration spec for the approval-grant-flow diagram. |
| [diagrams/auth-broker.spec.md](diagrams/auth-broker.spec.md) | Regeneration spec for the auth-broker concept diagram (newcomer-facing "rides your Claude subscription" companion to auth-broker-credential-plane). |
| [diagrams/wake-audit-lifecycle.spec.md](diagrams/wake-audit-lifecycle.spec.md) | Regeneration spec for the wake-audit-lifecycle diagram. |
| [diagrams/auth-broker-credential-plane.spec.md](diagrams/auth-broker-credential-plane.spec.md) | Regeneration spec for the auth-broker-credential-plane diagram. |
| [diagrams/drive-write-approval.spec.md](diagrams/drive-write-approval.spec.md) | Regeneration spec for the drive-write-approval diagram. |
| [diagrams/runtime-topology.spec.md](diagrams/runtime-topology.spec.md) | Regeneration spec for the runtime-topology diagram. |

Each spec has a matching authored source artifact — a `<name>.html`
(the HTML/CSS → 2x PNG pipeline, see `diagrams/DESIGN.md` Part 2) or a
legacy `<name>.svg` — with the raster export (`<name>.png` at 2x, or a
legacy `<name>.jpg`) always derived from that source, never authored directly.

## Archived (point-in-time snapshots — not current guidance)

| Doc | Snapshot |
|---|---|
| [REVIEW-2026-05-02.md](REVIEW-2026-05-02.md) | Doc-review punch list, 2026-05-02. |
| [install-validation-2026-05.md](install-validation-2026-05.md) | Fresh-VM install validation loop, 2026-05-14. |
| [phase0-findings.md](phase0-findings.md) | Phase 0 narrative findings (container identity model), 2026-05-08. |
| [phase0-peercred-matrix.md](phase0-peercred-matrix.md) | Phase 0 container-identity test matrix, 2026-05-08. |
