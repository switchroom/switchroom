---
artifact: Fleet dashboard — Hermes-Desktop adapter for the operator console
serves: see-my-whole-fleet-from-one-screen
advances-outcome: hold-the-leash
status: rfc — draft. Pivoted from "build our own SPA" to "expose the
  Hermes-Desktop contract from a Switchroom adapter and run the unmodified
  desktop in remote mode." Carries the alignment review of the original
  external plan.
relates: "jobs/know-what-my-agent-is-doing.md jobs/track-plan-quota-live.md
  jobs/restart-and-know-what-im-running.md jobs/steer-or-queue-mid-flight.md
  rfcs/conversational-pacing.md rfcs/host-control-daemon.md
  rfcs/access-model.md invariants.md #1122"
---

# Fleet dashboard — Hermes-Desktop adapter for the operator console

## TL;DR

The operator wants a Hermes-class management surface. Rather than build our
own SPA, **Switchroom exposes the Hermes-Desktop integration contract** and
the operator runs the **unmodified, MIT-licensed Hermes Desktop** (NousResearch
`hermes-agent/apps/desktop`) in its **remote-gateway mode**, pointed at a
Switchroom adapter. The adapter speaks the desktop's two transports (REST
`/api/*` and **JSON-RPC-2.0-over-WebSocket** `/api/ws`) backed by
Switchroom's own artifacts and IPC.

The connection is **observe + operator-chat, approvals stay on Telegram**:

- **Observe.** Implement the read/list/event subset so the desktop renders
  the fleet, sessions, history, and a live per-agent activity stream.
- **Operator chat.** Implement `prompt.submit` by routing the operator's turn
  through Switchroom's existing **synthesized-inbound path** (`inject_inbound`
  / cron pattern). The operator's turn **and the agent's reply mirror into
  that agent's Telegram thread**, one canonical record.
- **Approvals stay on Telegram.** We simply **do not implement** the approval
  methods/events; per the desktop's graceful-degradation behaviour that panel
  just stays empty. The Telegram tap remains the sole approval surface.

**`telegram-and-buzz-only` is not crossed.** That invariant governs the *principal's*
channel. It bars a second chat channel for the people the team serves
(WhatsApp, Signal, Slack). The dashboard is an **admin component** of
switchroom, not a principal channel, so it is out of that invariant's scope.
This change clarifies that scope in `invariants.md` and pins the conditions
that keep the admin console from quietly becoming a second channel (operator
audience, mirrored to the one Telegram thread, approvals on Telegram). No
desktop fork is maintained. We track upstream by implementing its contract.

## Decisions (owner-ratified)

These were settled with the owner before this draft (see the admin-console
scope note under `telegram-and-buzz-only` in `invariants.md`):

1. **No return of the progress card.** This is not the retired #1122 card
   rebuilt anywhere. The live desktop activity stream is an **operator**
   surface; the Telegram chat prompt is untouched, so the model still
   narrates to the principal (no crutch).
2. **Unmodified Hermes Desktop, remote mode.** Adapter-only. No fork.
3. **Observe + operator chat; approvals Telegram-only.**
4. **Operator turns + replies mirror into Telegram.**
5. **`src/web` is additive-and-decide-later** — the existing dashboard keeps
   shipping; whether it's eventually redundant to the Hermes path is revisited
   once the adapter is proven, not pre-committed.

## The integration contract (from a source read of `hermes-agent`)

The desktop is **Electron + React + nanostores**; it embeds no backend in the
renderer and supports a documented **remote-gateway** mode
(`apps/desktop/electron/connection-config.cjs`). It talks to a backend two ways:

- **REST `/api/*`** via `apps/desktop/src/hermes.ts` — sessions, status,
  config, model/provider info, etc. (CRUD + reads).
- **JSON-RPC 2.0 over WebSocket `/api/ws`** via
  `apps/shared/src/json-rpc-gateway.ts` — the live turn + control. Requests
  `{jsonrpc,id,method,params}`; server→client events are notifications with a
  fixed method `"event"` and `params:{type, session_id, payload}`. The first
  frame after open is always `gateway.ready`.

Canonical data types live in `apps/desktop/src/types/hermes.ts`. Auth is
**token mode** by default (`X-Hermes-Session-Token` header on REST, `?token=`
on WS), which maps cleanly onto Switchroom's existing `switchroom-web` token
+ Tailscale setup. Per the research, **features we don't implement degrade
that panel only; they don't block chat.**

### Adapter surface — MVP

**WS methods to implement (the chat + observe core):**

| Method | Switchroom backing |
|---|---|
| `session.create` / `session.resume` / `session.activate` / `session.close` | map to the agent's claude session; "session" ≈ a Switchroom agent/turn context |
| `session.list` / `session.most_recent` / `session.history` / `session.status` / `session.usage` | per-agent SQLite inbound buffer + session JSONL + `auth list --json` (quota) |
| `prompt.submit` (and `prompt.background`) | **route through `inject_inbound`**; mirror to Telegram (see below) |
| `session.interrupt` / `session.steer` | map to the existing interrupt / steer-or-queue path (`steer-or-queue-mid-flight`) |

**WS events to emit during a turn** (subset of the desktop's vocabulary):
`gateway.ready`, `session.info`, `message.start` / `message.delta` /
`message.complete`, `status.update`, `tool.start` / `tool.complete`,
`error`, `background.complete`.

**NOT implemented (panels degrade empty, by design):**
`approval.request` / `approval.respond`, `sudo.*`, `secret.*` (approvals stay
Telegram); plus `pet.*`, `billing.*`, `moa.*`, `voice.*`, computer-use,
messaging-platforms (Hermes's own chat gateway, irrelevant to us).

**REST subset to implement:** `/api/sessions*`, `/api/status`,
`/api/logs`, `/api/analytics/usage`, `/api/config` (read; secrets redacted).
Model/provider/env endpoints return Switchroom's claude-native truth
(single provider, OAuth-slot health as metadata). Never a token.

### The mirror (the load-bearing bit)

`prompt.submit` must not open a private side-channel. Implementation:

1. Operator turn → adapter → `inject_inbound` to the target agent's gateway,
   tagged with an operator-console source (analogous to `meta.source="cron"`).
2. The agent processes it as an ordinary turn in its **one** session.
3. The agent's reply is delivered to the agent's **Telegram thread** as
   normal; the adapter relays the same stream to the desktop via
   `message.delta` so the desktop is live too.

Result: exactly one record (Telegram), the desktop is an input + live view,
nothing is hidden. This is what keeps the admin console out of `telegram-and-buzz-only`'s scope (an input that feeds the one thread, not a second channel).

## Alignment review of the original external plan (still valid)

The external plan was written **blind to source**. Findings that still hold:

- **The card is gated.** The plan's "live progress-card step-stream timeline"
  was the retired #1122 card. We are not rebuilding it in Telegram. The
  desktop's live stream is allowed only as an **operator** surface (audience
  is the whole line; chat prompt untouched).
- **`src/web` already exists** (the plan assumed `switchroom web` was a stub).
  It ships as the `switchroom-web` compose project with fleet list + restart
  (start/stop deferred to a follow-up approval PR), logs, turns, sub-agents,
  accounts/quota, health, schedule, approvals + grants (read), connections,
  config edits via hostd. The Hermes adapter is **additive** to it.
- **Stale stack facts:** the plan cited Buildkite (retired 2026-05-15, now
  GHA) and changesets (this repo uses Conventional Commits + `CHANGELOG.md`).
  Ignore those.
- **Compliance instincts adopted wholesale:** no Anthropic API/SDK, no token
  egress, escape all untrusted content, jail the file browser.

## Where the adapter lives

Recommended: **extend the existing `src/web` server** to also serve the Hermes
contract (`/api/ws` JSON-RPC + the `/api/*` REST subset) rather than stand up
a new service. `src/web` already has a Bun HTTP+WS server, the `/api/*` token
gate, loopback-default bind, and the Tailscale serve path
(`project_web_dashboard_local_hotfix_deploy`). Adding the Hermes routes there
reuses auth, exposure, and the compose wiring, and keeps one operator service
to deploy. Confirm in implementation that the JSON-RPC `/api/ws` namespace
doesn't collide with the existing live-log WS.

## Scope

**In scope:** the adapter (WS MVP + REST subset above), the `prompt.submit`→
`inject_inbound`→Telegram-mirror path, token auth reuse, compose wiring so the
adapter survives `switchroom apply`, and a docs note on pointing Hermes
Desktop at the Switchroom URL.

**Out of scope:** any approval/grant action in the console
(`no-self-escalation`); a desktop fork; implementing the Hermes inference /
agent runtime (we only emit its event stream + answer its RPCs); the PTY /
embedded-terminal path; Hermes's own messaging-platform gateway; deprecating
`src/web` (decide later).

## Principle checks

- **Docs test:** operator power tool; one docs line to point the desktop at
  the URL. The principal never touches it. Pass.
- **Defaults test:** off by default, loopback default, token-gated, zero
  config to a working fleet without it. Pass.
- **Consistency test:** reuses the `src/web` server, the token/Tailscale
  exposure model, the `inject_inbound` turn path, the vault metadata-only
  rule, and the same agent nouns. The operator turn rides the *same*
  conversational pacing because it becomes an ordinary Telegram-thread turn.
  Pass.

## Invariant checks

| Invariant | Verdict |
|---|---|
| `claude-native` | Pass — adapter emits events + answers RPCs over Switchroom's own data/IPC; no API/SDK/token; the agent runtime is still the unmodified CLI. |
| `no-self-escalation` | Pass — approval methods are not implemented; the Telegram tap stays the sole approval surface. |
| `chat-is-the-single-source-of-truth` | Pass — operator-audience surface; chat prompt untouched (no crutch); turns + replies mirror into the one Telegram thread. |
| `telegram-and-buzz-only` | Pass — **not crossed.** The invariant governs *principal* channels; the dashboard is an admin component, out of scope. The admin-console conditions (operator audience, mirrored to the one Telegram thread, approvals on Telegram) keep it from becoming a second channel. A principal-facing bridge (WhatsApp/Signal/web chat) would still be out. |
| `single-tenant` | Pass — one operator, auth-gated, single deployment. |

## Testing

- Web/integration tests under `src/web/*.test.ts`.
- Contract tests: the adapter's `/api/ws` answers a recorded Hermes-Desktop
  handshake (`gateway.ready`) and a `session.list` / `prompt.submit` exchange;
  emitted event frames match the `{type,session_id,payload}` shape.
- **Mirror test:** an operator `prompt.submit` produces a real turn in the
  target agent's Telegram thread (the turn and reply are observable there),
  not just on the WS. This is the load-bearing admin-console condition.
- **No-approval test:** the adapter exposes no approve/deny method; an
  `approval.respond` call is rejected/absent.
- Secret-redaction: no REST/WS payload ever carries token-shaped material.

## Deployment

The adapter ships in the `switchroom-web` service (its own compose project,
pinned GHCR image `project_web_dashboard_local_hotfix_deploy`), reached via
`tailscale serve` → `127.0.0.1:8080`. The operator points Hermes Desktop's
remote-gateway config at that URL with the service token. Keep the service
rendered from config so it survives `switchroom apply`, never hand-edited
into the generated compose file.

## Open questions

1. Session model mapping: Hermes "sessions" are first-class, multi-per-profile;
   Switchroom has one live claude session per agent + a turn/inbound history.
   Confirm the cleanest mapping (agent = profile, session = a resumable
   turn-context vs the single live session) during the spike.
2. Live stream source: which Switchroom seam feeds `message.delta` /
   `tool.start` cleanly for the operator view without touching the Telegram
   output path? (Same seam the worker-activity feed already taps may suffice.)
3. Does the operator-console source tag need to be visible in the Telegram
   mirror (so a principal sees "operator asked: …"), or is it silent? Default
   assume a light attribution; confirm with owner.
