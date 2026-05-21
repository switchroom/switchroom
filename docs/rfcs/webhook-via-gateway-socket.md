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
`telegram/` directory already follows (every other file there —
`history.db`, `registry.db`, `gateway.log`, `issues.jsonl` — is
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
UID — likely the gateway or a host process during a different
deployment topology). The host's web server now runs as a different
UID. `appendFileSync` → EACCES → caught → `jsonReply(500, "write
failed")` → GitHub treats the hook as broken and eventually disables
it.

The proximate fix ("`rm webhook-events.jsonl`") works because the
receiver recreates the file under its current UID. But that fix
papers over the actual defect: **two processes with different UIDs
share a private state file**. Any future change to either process's
UID — a packaging change, a systemd unit edit, a docker user-
namespace tweak, a `docker compose` re-up under a different account —
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
  envelope of the only untrusted-inbound process in the system —
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
UID) cannot connect today. **First sub-task**: relax the socket
binding to `0o660` and grant the web server's UID via group OR
make the socket world-connectable (`0o666`) — the verb itself is
unauthenticated by socket perms because the verified webhook
payload arrives through it (untrusted inbound, but already
HMAC-verified). Recommend: `0o666` socket + verb-level allowlist
("`webhook_ingest` accepts records only from a process whose
peercred UID is on the host operator's allowlist; everything else
is rejected"). Peercred check uses `SO_PEERCRED`, same primitive
the vault broker uses.

### 3.2 Gateway side

The gateway already has a Bun.serve loop on the socket for chat
IPC. Add a `webhook_ingest` handler that:

1. Validates the payload shape (zod schema mirroring the web
   server's record).
2. Appends `JSON.stringify(record) + "\n"` to
   `telegram/webhook-events.jsonl`. Same content as today, same
   path, but now the writer is the gateway (UID match guaranteed).
3. Triggers any matching `webhook_dispatch` rule — today this
   logic also lives in the web server (`src/web/webhook-
   dispatch.ts` → spawns `claude -p`). The gateway already spawns
   `claude -p` for chat turns; the dispatch path becomes a thin
   wrapper that reuses the existing spawn machinery instead of
   shelling out to a top-level `switchroom claude` invocation.
4. Returns `{ ok: true, ts }` synchronously after the append, so
   the web server can return HTTP 202 to GitHub.

### 3.3 Web server side

`src/web/webhook-handler.ts` keeps its job through the verify /
dedup / rate-limit / render steps. The terminal `appendFileSync`
block becomes a Unix-socket POST. New failure modes:

- **Gateway socket missing** (agent stopped): return HTTP 503,
  GitHub retries on its own schedule (typically within seconds,
  with backoff). Log `webhook-ingest: agent=X gateway-down`.
- **Socket connect refused / EOF**: same — 503, retry.
- **Gateway returns non-ok**: 500 with the gateway's error
  message verbatim. Should be vanishingly rare since the gateway's
  only failure mode is fs/disk, and that would block the agent
  itself anyway.

### 3.4 Migration

Two PRs:

1. **PR 1 — additive.** Add `webhook_ingest` verb to gateway,
   add IPC client to web-server side, gate behind a defaults flag
   (`channels.telegram.webhook_via_gateway: true` default). On the
   `false` legacy path, keep direct `appendFileSync`. Emit a
   deprecation warning when the legacy path fires. Tests on both
   paths.
2. **PR 2 — subtractive.** One release later: delete the legacy
   `appendFileSync` path and the flag. Add a `switchroom doctor`
   check that flags any `webhook-events.jsonl` whose owner UID
   doesn't match the gateway's expected UID — points to either a
   stale file (delete & let recreate) or a misconfigured deploy.

A new `switchroom doctor --fix` mode could repair stale files in
PR 2; out of scope for this RFC.

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
  append (cold disk, fsync stall) blocks a GitHub delivery. The
  request budget is GitHub's 10s timeout; gateway fs writes
  typically take <5ms. Bounded.
- **Socket permission tuning is sensitive.** `0o666` + peercred
  allowlist is correct but easy to get wrong. The vault broker's
  test suite is a good template (`src/vault/broker/scope.test.ts`).
- **One more failure mode (gateway-down)**, but with the right
  HTTP code (503), it converts a hard data loss into GitHub-side
  retry — net improvement.

## 6. Alternatives considered

See §2.2 (auto-rotate, group-perms, root web server, separate
state dir). Each rejected with rationale.

## 7. Decisions

- **Peercred allowlist source: auto-detect.** The gateway
  determines the allowed UID at startup by `stat()`ing
  `~/.switchroom/` and reading the owner. No config knob; the
  invariant "the operator's UID is the one that owns the
  config tree" already holds everywhere else in the codebase.
- **Forwarding semantics: append-complete.** The web server
  awaits the gateway's `{ ok: true, ts }` (post-append) before
  returning 202 to GitHub. Median cost is single-digit ms;
  failure semantics are clear (502/503 means the record is
  not durable, GitHub will retry).
