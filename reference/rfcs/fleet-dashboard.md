---
artefact: Fleet dashboard — operator web surface, scope + invariant gates
serves: jobs/see-my-whole-fleet-from-one-screen.md
status: rfc — draft. Records the alignment review of an externally-authored
  "Hermes-class dashboard" plan and re-scopes it against the dashboard that
  already ships (`src/web/`, `switchroom-web` compose project).
relates: "jobs/know-what-my-agent-is-doing.md jobs/track-plan-quota-live.md
  jobs/restart-and-know-what-im-running.md rfcs/conversational-pacing.md
  rfcs/host-control-daemon.md rfcs/access-model.md #1122"
---

# Fleet dashboard — operator web surface

## TL;DR

An external plan proposed building a "Hermes-class" management dashboard for
Switchroom. The plan was written **blind to the source** (GitHub blocked the
`src/` read), so its central premise is wrong: **the dashboard already
exists.** `src/web/` is served by the `switchroom-web` compose project (its
own project, pinned GHCR image — memory `project_web_dashboard_local_hotfix_deploy`)
and already does fleet list + restart (start/stop deferred to a follow-up
approval PR), logs, turns, sub-agents, accounts/quota, system + memory
health, schedule, approvals + grants (read), connections, and config edits
via hostd.

So this is an **extend, not a build-new**. This RFC (a) records the
alignment review of the plan against `vision` / `principles` / `invariants`,
(b) keeps the genuinely good parts of the plan, (c) **hard-gates the one
piece that crosses an invariant** (a live progress-card mirror), and (d)
lists the net-new work worth doing on top of the existing dashboard.

The plan's compliance instincts (no API/SDK, no token egress, untrusted-
content escaping, jailed file browser) are **excellent and adopted wholesale**
— they restate `claude-native` / `no-self-escalation` correctly.

## Alignment review of the external plan

### What the plan got right (keep)

- **I1 / I3 (no API-SDK, no secret egress).** Exact match for `claude-native`
  + `no-self-escalation`. The dashboard reads Switchroom's own artifacts and
  CLI verbs, never `api.anthropic.com`, never a token. Keep as the PR gate.
- **I4 (untrusted content).** Escape everything; jail + traversal-test the
  file browser. Correct and not yet fully proven in `src/web/` — adopt as
  net-new test work (see Net-new §).
- **Exposure floor.** Off by default, loopback bind default, refuse
  unauthenticated non-loopback. This already exists (`src/cli/web.ts` warns
  on LAN bind; `server.ts` token-gates `/api/*`) — keep and make the refusal
  hard, not a warning.
- **Aggregator pattern.** A single per-host service sibling to the fleet is
  the right shape, and is what already ships.

### Where the plan diverges from reality (correct before coding)

1. **"`switchroom web` is likely a stub" — false.** It is a substantial
   React SPA + Bun server (`src/web/server.ts`, `api.ts`, `ui/`) shipping as
   `switchroom-web`. The plan's Phase 0 "extend vs replace" is already
   decided: **extend.** Read `src/web/` first; most Phase-1 endpoints in the
   plan already exist (`/api/agents`, `/api/summary`, `/api/system-health`,
   `/api/memory-health`, `/api/schedule`, `/api/approvals`, `/api/grants`,
   `/api/accounts`).
2. **"Phase 1 strictly read-only / zero web mutations" — stricter than
   shipped reality, and not what the invariants require.** The existing
   dashboard already restarts agents, refreshes quota, sets connection
   access, and edits config via hostd. `telegram-only` is about a second
   **human-facing chat channel**, not operator fleet ops; `no-self-escalation`
   permits any action that flows from operator config / an operator tap and
   is enforced where the agent can't rewrite it. So **operator fleet ops on
   the web are in scope** — provided they route through the existing
   hostd/CLI operator-authored paths (`host-control-daemon.md`) and never the
   one thing that is reserved: **approvals.**
3. **Approvals: the plan is right, restate it as the hard line.** No
   Allow/Deny on the web, ever. Approvals are the human-validated Telegram
   tap — the trust anchor of `no-self-escalation`. Web *displays* pending +
   history; the decision is Telegram-only. (The existing `/api/approvals` /
   `/api/grants` are read-only — keep them that way; never add a resolve
   endpoint.)
4. **Stale stack facts.** The plan cites Buildkite CI (retired 2026-05-15,
   now GHA), changesets (this repo uses Conventional Commits + `CHANGELOG.md`,
   no changesets), and the systemd model (Docker Compose is current). Ignore
   those.

### The one invariant collision — gate it

**Phase 2 of the plan ("live step-stream timeline / Hermes-style progress
cards") crosses `chat-is-the-single-source-of-truth`.** It proposes
reconstructing the progress card — last-N steps, elapsed timers, sub-agent
nesting, `(1/N)` — as a live web surface running parallel to the
conversation. That surface is the **retired #1122 card**, rebuilt on the web.
The job [`know-what-my-agent-is-doing`](../jobs/know-what-my-agent-is-doing.md)
names it explicitly under "never ship this": *"A separate progress surface
running parallel to the chat… covers for a model that won't talk."*

The collision is not "a dashboard is bad." It is specifically the **live
parallel mirror of an in-flight turn**. The distinction this RFC draws:

- **Allowed — post-hoc operator review of durable artifacts.** History,
  session transcripts, the `card-events.jsonl` audit trail, sub-agent
  records. The operator inspects what an agent *did*. This is observability
  over already-persisted state, not a live state mirror, and it does not
  substitute for the model talking in chat.
- **Gated — a live, auto-updating "what is the agent doing right now" card**
  that an operator (or worse, a principal) watches *instead of* the chat.
  That is the card. Do not build it. If live freshness is wanted, it is
  bounded to coarse operator status (up / working / idle / recovering) on the
  fleet grid — a liveness dot, not a step-by-step turn mirror — and it is
  never presented to a principal.

The gateway event-bus refactor the plan proposes (Phase 2 §6) exists to feed
that gated card, so it is **out of scope** here. If a future need for a
structured operator event stream appears, it gets its own RFC and its own
invariant check; it does not ride in on this one.

## Scope

**Already shipped (verify, harden — do not rebuild):** fleet list + status,
restart (start/stop deferred to a follow-up approval PR), logs, turns,
sub-agents, accounts/quota health, system +
memory health, schedule, approvals + grants (read), connections, config edit
via hostd, token auth on `/api/*`, loopback-default bind.

**Net-new worth doing (on top of the existing dashboard):**

1. **History browser** — per-agent SQLite inbound buffer, read-only (WAL,
   separate read connection, last-write-wins tolerant), with cron-tagged
   turns (`meta.source="cron"`) labelled distinctly.
2. **Sessions view** — JSONL transcripts with continuity-mode awareness
   (handoff vs continue vs cold) and a wake-audit / recovery indicator, so a
   fresh-session-with-handoff is not mislabelled as a continued transcript.
   This is the operator-side mirror of
   [`restart-and-know-what-im-running`](../jobs/restart-and-know-what-im-running.md).
3. **Workspace / worktree file browser** — sandboxed, canonicalised, jailed
   to the agent workspace root, size-capped previews, binaries refused. Never
   serves arbitrary host paths.
4. **Audit feed** — `card-events.jsonl` rendered read-only across the fleet
   (rotation / partial-trailing-line tolerant tailer), beside the existing
   pending-approvals view.
5. **Security hardening pass** — XSS audit of every rendered field
   (message/tool/file/memory content is untrusted), path-traversal tests on
   the file API, a secret-redaction test asserting no response body ever
   contains token-shaped material, and turning the non-loopback-without-auth
   case from a warning into a hard refusal.

**Out of scope (gated):**

- The live progress-card / step-stream timeline and its gateway event-bus
  refactor (crosses `chat-is-the-single-source-of-truth` — see above).
- Any web Allow/Deny / approval-resolve action (`no-self-escalation`).
- A web prompt box that opens a new conversation surface to an agent
  (`telegram-only`). Routing an operator prompt through the existing
  synthesized-inbound path is a *separate* future RFC with its own invariant
  review — not assumed here.
- Anything the principal is meant to open to know what their agent is doing
  or where their quota stands — those stay in chat
  (`know-what-my-agent-is-doing`, `track-plan-quota-live`).

## Principle checks

- **Docs test:** the dashboard is an operator power tool; it does not replace
  any self-teaching CLI/chat surface and does not become required reading for
  a principal. The CLI (`switchroom web`) prints its bind + exposure state
  inline. Pass.
- **Defaults test:** off by default, loopback by default, zero config to run.
  A fresh `switchroom setup` fleet works with no dashboard. Pass.
- **Consistency test:** reuses the config cascade, the vault model (reads
  *metadata*, never values), the hostd operator-action path, and the same
  agent nouns as the CLI. No new interaction idiom for the principal. Pass —
  *provided* the gated live-card is not built, which would reintroduce the
  retired parallel-surface idiom.

## Invariant checks

| Invariant | Verdict |
|---|---|
| `claude-native` | Pass — reads artifacts + CLI verbs only; no API/SDK/token. |
| `no-self-escalation` | Pass — mutations route through hostd/CLI operator paths; **no web approval action**; web grants nothing the config didn't authorize. |
| `chat-is-the-single-source-of-truth` | Pass **only with the live-card gated out**. Post-hoc artifact review is fine; a live parallel turn mirror is not. |
| `telegram-only` | Pass — operator observability + fleet ops are not a second chat channel; a web prompt box would be, and is out of scope. |
| `single-tenant` | Pass — one operator, one deployment, auth-gated, loopback default. |

## Testing

- Web/integration tests under `src/web/*.test.ts` (the existing pattern), not
  the Telegram mtcute UAT corpus.
- Unit: jsonl tailer (rotation / partial line), SQLite read adapter
  (concurrent-write tolerance), path-traversal jail, secret-redaction.
- Security: XSS payloads in message/tool/file content render inert; traversal
  attempts on the file API are refused; no response body carries token-shaped
  material; non-loopback bind without auth refuses to serve.

## Deployment

`switchroom-web` is its own compose project (`~/.switchroom/web/docker-compose.yml`,
pinned GHCR image — code baked in, no source mount), reached via
`tailscale serve` → `127.0.0.1:8080`. A merged `src/web/` change does **not**
update the live dashboard without an image rebuild + recreate (memory
`project_web_dashboard_local_hotfix_deploy`). New work must keep the service
rendered from config so it survives `switchroom apply` — never hand-edited
into the generated compose file.

## Open questions

1. Confirm with the owner that the **live progress-card mirror stays gated**
   out — this is the one place the external plan and the invariants disagree,
   and the invariant wins unless the owner explicitly revisits #1122.
2. Confirm the **coarse fleet-grid liveness dot** (up/working/idle/recovering)
   is acceptable as the only "live" element, distinct from a step mirror.
3. Net-new priority order: history → sessions → files → audit, or reorder?
