---
artifact: webhook ingest writes via the agent gateway socket
backs: no-self-escalation
status: Draft v1
---

# RFC: Webhook ingest writes via the agent gateway socket

Status: Draft v1
Author: Ken (via Klanker pair-design)
Date: 2026-05-21

## 1. Summary

Move the `appendFileSync(webhook-events.jsonl)` call out of the host
web server (`src/web/webhook-handler.ts`) and into the per-agent
gateway, reached over the existing `gateway.sock` Unix socket. The
web server keeps HTTP termination, HMAC/Bearer verification, dedup,
and rate limiting. After those checks pass, it forwards the verified
record to the agent's gateway via a new `webhook_ingest` IPC verb;
the gateway, running as the agent's UID, performs the append.

This restores the single-writer invariant the rest of the agent's
`telegram/` directory already follows (every other file there,
`history.db`, `registry.db`, `gateway.log`, `issues.jsonl`, is
written by the gateway and only the gateway). Webhook events became
the lone exception when ingest moved host-side in #586, and that
exception just bit us in production.

## 2. Motivation

### 2.1 The trigger

Today (2026-05-21) every PR/issue webhook to `reggie` has been
returning HTTP 500 for ~12 days, with the receiver silently dropping
events. Root cause: `~/.switchroom/agents/reggie/telegram/webhook-
events.jsonl` is mode `0o600`, owner UID `10014` (reggie's container
UID, set when the file was first created by something running as that
UID, likely the gateway or a host process during a different
deployment topology). The host's web server now runs as a different
UID. `appendFileSync` → EACCES → caught → `jsonReply(500, "write
failed")` → GitHub treats the hook as broken and eventually disables
it.

Note that the bug is owner-mismatch, not mode-mismatch. The
`mode: 0o600` argument on `appendFileSync` in
`src/web/webhook-handler.ts:414` only applies at *file creation*;
once the file exists with a non-matching owner, no mode tweak
helps. A future reader's "just chmod it" instinct will not fix
this class of bug.

The proximate fix ("`rm webhook-events.jsonl`") works because the
receiver recreates the file under its current UID. But that fix
papers over the actual defect: **two processes with different UIDs
share a private state file**. Any future change to either process's
UID (a packaging change, a systemd unit edit, a docker user-
namespace tweak, a `docker compose` re-up under a different account)
silently re-breaks ingest. The webhook surface is the *only*
untrusted-inbound surface in switchroom; silently dropping events is
the worst failure mode.

### 2.2 Why fix it structurally

Adjacent defensive fixes considered and rejected:

- **Auto-rotate on EACCES** (rename stale file, create fresh).
  Solves *this* break, masks the structural issue, and loses
  historical events. Future packaging changes still surprise.
- **Change file mode to `0o660` + add the web server to the
  agent's group.** Couples the host's user-group membership to every
  agent's UID. Drift surface: one agent created post-config-update
  silently fails until the operator re-runs `usermod -aG`.
- **Run the web server as root** (or as a shared "switchroom" user
  that's a member of every agent's group). Expands the privilege
  envelope of the only untrusted-inbound process in the system,
  exactly backwards.
- **Move webhook state to a web-server-owned directory** (e.g.
  `~/.switchroom/webhooks/<agent>/events.jsonl`). Drops cross-UID
  writes but splits agent state across two dirs, defeats the "agent
  owns its `telegram/`" convention, and breaks the operator's mental
  model of where to look.

The right invariant is the one the rest of the directory already
encodes: **the agent gateway is the sole writer of state in
`<agent>/telegram/`.** Webhook ingest violated that invariant in
#586 to keep the change small; this RFC pays the deferred cost.

## 3. Proposal

### 3.1 Wire-level change

Add a `webhook_ingest` verb to the gateway's existing Unix-socket
IPC (`gateway.sock`). The web server connects on demand, sends a
single JSON line, awaits an ack, closes.

```
host web server (any UID)            agent gateway (agent UID)
        |                                       |
        | --- HTTP POST /webhook/reggie/github  |
        | --- HMAC verify, dedup, rate limit    |
        |                                       |
        | -- connect agents/reggie/telegram/    |
        |    gateway.sock                       |
        | -- {                                  |
        |      verb: "webhook_ingest",          |
        |      source: "github",                |
        |      event_type: "pull_request",     |
        |      ts: 1779329020000,                |
        |      payload: {...},                  |
        |      rendered_text: "..."             |
        |    }                                  |
        |  <-- { ok: true, ts }                 |
        |                                       |
```

`gateway.sock` already exists with mode `0o755`-on-dir and is bound
by the gateway with `0o600` owner-only. The web server (different
UID) cannot connect today. The change: rebind the socket as
`0o666` (filesystem layer lets anyone `connect()`), with a
`SO_PEERCRED` gate inside the gateway's `webhook_ingest` handler
acting as the actual authn layer. Any peer whose peercred UID is
not on the allowlist (see §7) gets the connection closed with no
verb response. Same primitive the vault broker uses
(`src/vault/broker/scope.test.ts`).

### 3.2 Gateway side

The gateway already has a Bun.serve loop on the socket for chat
IPC. Add a `webhook_ingest` handler that:

1. Validates the payload shape (zod schema mirroring the web
   server's record).
2. Appends `JSON.stringify(record) + "\n"` to
   `telegram/webhook-events.jsonl`. Same content as today, same
   path, but now the writer is the gateway (UID match guaranteed).
3. Triggers any matching `webhook_dispatch` rule. Today this
   logic lives in the web server (`src/web/webhook-dispatch.ts`)
   and spawns `claude -p` as a sibling of the web-server process.
   In the new model the gateway is the parent of the long-running
   interactive `claude` session, so dispatch spawns a *second*
   `claude -p` while the interactive session may be mid-turn.
   Concurrency story: dispatch turns get their own process,
   independent of the interactive session's turn queue. They land
   in Telegram as fresh inbound, the same way a `/cron` fire does
   today. No shared state with the interactive turn, no need to
   wait for it to finish. Web-server-side cooldown + dedup (kept
   in place per §4) prevents dispatch storms.
4. Returns `{ ok: true, ts }` to the web server after the append
   syscall returns (NOT after `fsync`, see §5). The web server
   then returns HTTP 202 to GitHub. Records are durable to the
   OS page cache, not to disk; that matches the prior on-host
   `appendFileSync` semantics exactly (no regression, no false
   "durable" claim).

### 3.3 Web server side

`src/web/webhook-handler.ts` keeps its job through the verify /
dedup / rate-limit / render steps. The terminal `appendFileSync`
block becomes a Unix-socket POST. Socket path is the well-known
`~/.switchroom/agents/<agent>/telegram/gateway.sock`, the same path
the gateway binds, same path `mkdirSync(telegramDir, ...)` in the
current handler already implies it knows. New failure modes:

- **Socket file missing entirely** (agent never ran): HTTP 503,
  log `webhook-ingest: agent=X socket-missing`.
- **Socket exists but `connect()` returns ECONNREFUSED** (gateway
  crashed, socket file orphaned): HTTP 503, log
  `webhook-ingest: agent=X gateway-down`. Same status code; the
  two cases differ only in operator-facing diagnostics.
- **Socket connect EOF / write timeout**: HTTP 503.
- **Gateway returns non-ok**: HTTP 500 with the gateway's error
  message verbatim. Rare; only fs/disk failures inside the gateway.

**Durability caveat.** GitHub retries failed deliveries up to ~8
times with exponential backoff (minutes-to-hours), then gives up
and (after enough failures) auto-disables the hook. A long agent
outage (~hours) can permanently lose events. Two mitigations,
both deferred to a follow-up RFC if the steady-state rate of
gateway downtime warrants them:
1. Web-server-side spool: on 503, append the verified record to
   a web-server-owned `~/.switchroom/webhook-spool/<agent>/...`
   directory; gateway drains on next startup. Adds a second
   writer and a second state dir, but only as a degradation
   path, not a steady-state second writer.
2. `switchroom doctor` proactively pings agent sockets and warns
   the operator when one is down for >N minutes.
Neither is in scope here; called out so future readers don't
think they were missed.

### 3.4 Migration

Three PRs:

1. **PR 1 — truly additive.** Add `webhook_ingest` verb to
   gateway, add IPC client to web-server side, gate behind a
   defaults flag `channels.telegram.webhook_via_gateway` with
   **default `false`**. Legacy `appendFileSync` path stays the
   shipped behaviour. Tests on both paths. Nothing in production
   changes; operators can opt in per-agent for canary.
2. **PR 2 — the rollout.** Flip the default to `true`. This is
   the breaking change (web server now requires gateway sockets
   to be reachable for webhook ingestion). Release notes call it
   out. Operators with bespoke deployments can pin
   `webhook_via_gateway: false` to defer.
3. **PR 3 — subtractive.** One release after PR 2: delete the
   legacy `appendFileSync` path and the flag. Add a
   `switchroom doctor` check that flags any
   `webhook-events.jsonl` whose owner UID doesn't match the
   gateway's expected UID. Points to either a stale file
   (delete & let recreate) or a misconfigured deploy.

A `switchroom doctor --fix` mode could repair stale files in
PR 3; out of scope for this RFC.

## 4. Non-goals

- Reworking the dedup or rate-limit logic. Both stay where they are
  (web-server side, ahead of the gateway hop) because GitHub
  retries should be deduped before they pay the gateway round-trip.
- Encrypting the webhook record at rest. The payload is already
  HMAC-verified GitHub data; encryption is a separate hardening
  question.
- Removing the host web server. It still terminates TLS, verifies
  signatures, and serves the dashboard.

## 5. Risks

- **Gateway is now in the synchronous webhook path.** A slow
  append blocks a GitHub delivery. The request budget is
  GitHub's 10s timeout; `appendFileSync` to a warm log file
  returns from the write syscall in single-digit ms on typical
  hardware. We do NOT `fsync` (parity with prior behaviour);
  records are durable to OS page cache only. If we ever want
  fsync'd durability, re-cost the latency budget.
- **Socket permission model is sensitive.** `0o666` socket file
  perms + `SO_PEERCRED` UID gate at the verb layer. The file
  perms are intentionally open so any local UID can `connect()`;
  the peercred check is the actual authn. Test suite mirrors
  `src/vault/broker/scope.test.ts`.
- **One new hard-fail mode: gateway down.** Mapped to HTTP 503,
  which trades silent 500-then-disable for noisy retry-then-give-
  up. Net improvement, but see §3.3 "Durability caveat": long
  agent outages can still lose events if the deferred spool
  mitigation isn't built.
- **Webhook dispatch fans out from inside the gateway.** A
  flood of matching events spawns a flood of `claude -p`
  processes. Existing web-server-side cooldown (kept per §4) is
  the back-pressure; verify it survives the move.

## 6. Alternatives considered

See §2.2 (auto-rotate, group-perms, root web server, separate
state dir). Each rejected with rationale.

## 7. Decisions

- **Peercred allowlist source: web-server runtime UID.** The
  web server writes its current UID to its existing pidfile
  record at startup (alongside `pid`, `port`, `version`). The
  gateway, at startup, reads that file and adds the UID to its
  peercred allowlist. Re-read on SIGHUP so a web-server restart
  under a different user (e.g. systemd unit edit) is picked up
  without a gateway restart. **Not** derived from
  `~/.switchroom/` ownership; that's a coincidence of typical
  single-user installs and would silently fail closed for
  deployments where the web server runs as e.g. `www-data`,
  which is the exact failure mode this RFC is trying to remove.
- **Forwarding semantics: append-complete.** The web server
  awaits the gateway's `{ ok: true, ts }` (post-append) before
  returning 202 to GitHub. Median cost is single-digit ms;
  failure semantics are clear (502/503 means the record is
  not durable, GitHub will retry).
