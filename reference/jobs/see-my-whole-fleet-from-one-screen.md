---
job: see and manage my whole fleet from one operator screen
outcome: The operator can open one management console and see every agent's live state, health, quota, history, sessions, memory, workspace, and approval/audit trail, run fleet ops (restart, config edits), and drive an agent with a turn from the console, without any secret reaching the client, without approvals ever leaving Telegram, and without the surface becoming the principal's source of truth or a separate conversation record (operator turns mirror into the agent's Telegram thread).
stakes: An operator running a standing fleet 24/7 needs a place to glance across all of it at once. The chat is per-agent and per-topic, so a fleet-wide problem (a stuck agent, a quota wall, a drifted config, a failing memory backend) is invisible until a principal complains. Without a fleet view the operator debugs blind, one `docker exec` at a time. But a dashboard is also the easiest place to accidentally rebuild the retired progress card, leak a token, or grow a second approval path, so the screen earns its place only by staying an operator tool, never a principal one.
serves: hold-the-leash
invariants: [chat-is-the-single-source-of-truth, telegram-only, no-self-escalation, single-tenant, claude-native]
---

# Job Spec: see and manage my whole fleet from one operator screen

> A durable Job Spec. The *how* lives in the design artifact
> `reference/rfcs/fleet-dashboard.md` and the code under `src/web/`: the
> Hermes-Desktop adapter (REST + JSON-RPC WebSocket) served from
> `switchroom-web`, the unmodified Hermes Desktop run in remote mode, the
> `inject_inbound` mirror, the auth gate. That implementation churns; this
> job does not.

## Who this is for, read this first

Switchroom has **two people** (`vision.md`): the **principal**, who texts an
agent and never sees a server, and the **operator**, who stands the fleet up
and keeps it running. This job belongs to the **operator only**.

The principal's "what is my agent doing" job is
[`know-what-my-agent-is-doing`](know-what-my-agent-is-doing.md), and it is
answered **in the chat**, by the model talking, never by a dashboard. The
quota job is [`track-plan-quota-live`](track-plan-quota-live.md), whose title
is literally "*without a dashboard*" because the principal should never have
to stop and open one. This fleet screen does not, and must never, become the
place a principal goes to know what their agent is doing or where their quota
stands. It is the operator's workshop view of the machine, not a principal
surface. Conflating the two is how this job crosses
`chat-is-the-single-source-of-truth` (see Verdict).

## The job

The operator runs N specialists round the clock. Each lives in its own
Telegram topic, which is exactly right for the principal but wrong for the
operator who needs to know, at a glance: which agents are up, which are
working, which are wedged, who's near a quota wall, whose memory backend is
sick, whose config drifted, what's pending approval across the whole fleet,
and what each has been doing lately. Today that means SSH plus `docker exec`
plus grepping logs, one agent at a time. The job is to give the operator one
screen that aggregates all of it, lets them act on the fleet (restart, edit
config), and never leaks a secret or quietly grows into a second principal
channel or a second approval path.

## Good / bad

**Good looks like**

- One screen lists every agent with live status (up / working / idle /
  recovering / down), and the operator can drill into any one.
- Per-agent: auth-slot + quota health (active slot, % used, reset window,
  expiry) as **metadata only**, never a token, never `credentials.json`.
- Per-agent history, sessions (handoff vs continue vs cold, plus
  wake-audit/recovery state), workspace files, and memory are browsable
  read-only for debugging.
- The approval/grant trail is visible as a **read-only audit feed** across
  the fleet, plus what's currently pending, so the operator can see the
  leash state at a glance.
- Fleet ops the operator already does from the CLI (restart, and operator
  config edits) are available from the screen, routed through the same
  operator-authored, hostd/CLI-enforced paths, never a new privileged
  backdoor.
- The operator can send a turn to one of their own agents from the console,
  and that turn plus the agent's reply **mirror into the agent's Telegram
  thread**. The console is another way *in*, never a separate conversation
  the Telegram thread can't see. The turn rides the same synthesized-inbound
  path as cron, landing in the one agent session.
- Off by default, binds loopback by default, refuses to serve
  unauthenticated when bound to a non-loopback address; Tailscale is the
  documented remote path.
- Nothing the screen renders or returns contains a secret, OAuth token, or
  bot token. All rendered content (messages, tool args, file contents,
  memory) is treated as untrusted and escaped; the file browser is jailed to
  the agent workspace and traversal-safe.

**Bad looks like: never ship this**

- A live, pinned, parallel **progress mirror** of a turn, a web re-creation
  of the retired #1122 card. The operator may review what an agent *did*
  from durable artifacts (history, audit, sessions); they do not get a live
  blow-by-blow surface that runs beside the conversation and substitutes for
  the model talking. Resurrecting the card on the web crosses
  `chat-is-the-single-source-of-truth`. See Verdict.
- The dashboard becoming the principal's way to check quota or watch an
  agent work. That is the chat's job; a screen the principal must open is the
  exact anti-pattern `track-plan-quota-live` names.
- Any **Allow/Deny or approve action** on the web. Approvals are the
  human-validated Telegram tap; the trust anchor stays there
  (`no-self-escalation`). The web may *display* pending approvals and
  history; the decision never happens here.
- A **principal-facing** way in from the console, or an operator turn that
  does **not** mirror into the Telegram thread (a hidden side-channel
  conversation). The admin console stays out of `telegram-only`'s scope only
  while it is operator-only and every turn surfaces in the one Telegram
  record. A prompt box the principal uses, or a bridge to WhatsApp/Signal,
  crosses `telegram-only`.
- Any secret reaching the browser, an API response, or a log
  (`credentials.json`, vault values, OAuth/bot tokens).
- A mutating path that lets the web grant access the operator's config
  didn't already authorize, a self-escalation backdoor around the cascade.
- A file browser that can serve arbitrary host paths, or unescaped content
  that lets untrusted message/tool/file text run as script.
- A service that disappears on `switchroom apply` because it was hand-edited
  into the compose file instead of rendered from config.

## Prove it

This surface is an operator tool, exercised by web/integration tests under
`src/web/*.test.ts`, not by the Telegram mtcute UAT corpus (which proves the
principal's chat jobs). Pin:

- **Fleet at a glance** — the screen lists every configured agent with live
  status and per-agent quota/slot health. *Invariant:* every value rendered
  is metadata; no response body contains a token or secret
  (secret-redaction test).
- **Read-only depth** — history, sessions (continuity-mode aware), memory,
  workspace files browse read-only. *Invariant:* the file API is jailed +
  traversal-tested; all rendered content is escaped (XSS payloads in
  message/tool/file content are inert).
- **Leash visible, never operated** — pending approvals + the grant/audit
  trail render read-only. *Invariant:* there is no approve/deny endpoint;
  the only approval action in the whole product is the Telegram tap.
- **Fleet ops, not backdoors** — restart and config edits route through the
  existing hostd/CLI operator paths. *Invariant:* the console grants no access
  the operator's config didn't already authorize; no path mutates the vault or
  resolves an approval.
- **Operator turn = one record** — a turn sent from the console produces a
  real turn in the target agent's Telegram thread (turn and reply observable
  there). *Invariant:* the console never opens a conversation the Telegram
  thread can't see; the admin console stays out of telegram-only's scope.
- **Exposure floor** — off by default; loopback bind default; unauthenticated
  non-loopback bind is refused. *Invariant:* a network-accessible bind
  without auth never serves.
- **Survives reconcile** — the service is rendered into the compose file from
  config and survives `switchroom apply`. *Invariant:* no hand-edit of the
  generated compose file.

## Verdict

- **Done when:** the operator can see and manage the whole fleet from one
  screen, can debug any agent's history/sessions/memory/files/audit
  read-only, sees quota and leash state at a glance, runs the fleet ops they
  already had on the CLI. And the screen leaks no secret, grows no approval
  or chat path, and never becomes a principal surface or a live parallel
  progress mirror.

## Production-readiness

- *Compliance:* no Anthropic API/SDK import, no token read/forward/log, no
  inference proxying. Cross-checked against `claude-native` and
  `no-self-escalation` (`access-model.md`).
- *Exposure:* loopback default; non-loopback requires auth; secrets never
  egress; untrusted content escaped; file access jailed.
- *Boundary:* this surface stays operator-only and read-mostly. The two
  principal-facing jobs it could cannibalise,
  [`know-what-my-agent-is-doing`](know-what-my-agent-is-doing.md) and
  [`track-plan-quota-live`](track-plan-quota-live.md), remain answered in
  the chat.

> [!CAUTION]
> If the dashboard starts being where a principal goes, this job has failed
> even if every feature works.

---

> **Implementation:** `reference/rfcs/fleet-dashboard.md` (the design
> artifact, `serves:` this job): the Hermes-Desktop adapter served from
> `src/web/` (`switchroom-web`), with unmodified Hermes Desktop run in remote
> mode as the client. `reference/invariants.md` records why the admin console
> is out of `telegram-only`'s scope (it governs principal channels, not admin
> tooling) and the conditions that keep it so. Those churn; this job outlives
> them.
