---
artefact: Cloudflare-only edge lock for webhook ingest
backs: no-self-escalation
status: Draft v1
---

# RFC: Cloudflare-only edge lock for webhook ingest

Status: Draft v1
Author: Ken (via Claude pair-design)
Date: 2026-05-29

## 1. Summary

Add a per-agent opt-in (`channels.telegram.webhook_require_edge: true`)
that requires every webhook request to carry an `X-Switchroom-Edge`
header matching an operator-held secret before any HMAC work runs. A
Cloudflare Transform Rule injects that header on requests that transit
the edge (`hooks.switchroom.ai`); requests that reach the tunnel origin
by any other path don't carry it and are rejected `403`.

This is Phase 2 of the Docker-native webhook work (Phase 1:
`webhook-via-gateway-socket.md`). It is **defence in depth**, stacking
on the two controls already in place — not replacing either:

1. **GitHub-IP WAF allowlist** at the Cloudflare edge (network origin).
2. **Per-agent HMAC** (`X-Hub-Signature-256`) at the receiver (body
   provenance — proves a secret-holder produced the body).

The gap this closes: the HMAC proves *who signed the body*, not *which
network path the request took*. If anyone learns the tunnel origin, or a
co-located service is coerced into an SSRF against `localhost:8080`, the
HMAC is the only thing standing — and for a public-repo webhook the
"secret" is only as private as GitHub's storage. The edge header proves
"this request entered through our Cloudflare edge", which nothing else
on the request can.

## 2. Motivation

The receiver (`switchroom-web`) listens on `127.0.0.1:8080` and is
fronted by a cloudflared tunnel. Cloudflare's WAF only admits GitHub's
published IP ranges. But the receiver itself cannot tell a request that
came *through* Cloudflare from one that arrived at the tunnel origin
some other way — both look like loopback once cloudflared forwards them.
A header that only Cloudflare can inject (because only Cloudflare's
Transform Rule holds the secret) lets the receiver assert the network
path.

The owner's ask, verbatim: *"Can we make it only work for cloudflare??"*

## 3. Design

### 3.1 The secret

A single endpoint-global value at `~/.switchroom/webhook-edge-secret`
(mode `0600`, one line, trailing whitespace trimmed on read). It guards
the whole receiver, not a single agent — the per-agent grain is already
the HMAC. The same value is configured as the injected header value in
the Cloudflare Transform Rule.

`src/web/webhook-edge.ts`:
- `EDGE_HEADER = 'x-switchroom-edge'` (lower-cased for `Headers.get`).
- `loadEdgeSecret(path?)` → trimmed string, or `null` if missing/empty.
- `verifyEdgeHeader(headerValue, expectedSecret)` → constant-time
  compare (`crypto.timingSafeEqual`), `false` (never throws) on any
  null/length/value mismatch.

### 3.2 The gate

In `handleWebhookIngest` (`src/web/webhook-handler.ts`), after the
source-allowed (`403`) check and **before** the per-source secret read /
HMAC verification:

```
if (args.requireEdge) {
  if (!verifyEdgeHeader(headers.get(EDGE_HEADER), args.edgeSecret)) {
    return 403 { ok: false, error: 'forbidden' }
  }
}
```

Placing it before the HMAC means a non-edge request is cheaply rejected
and never consumes a signature verification. The `403` body leaks no
detail (`forbidden`); the *reason* (missing/mismatch vs.
unconfigured-secret) goes only to the operator log.

`handleWebhookRoute` (`src/web/server.ts`) reads
`webhook_require_edge === true` from the resolved agent config and lazily
loads the edge secret only when required, passing `requireEdge` +
`edgeSecret` into the handler.

### 3.3 Fail-closed

If `requireEdge` is true but `edgeSecret` is `null` (file missing /
empty / unreadable), **every** request is rejected `403`. A
misconfigured lock must never silently fall open — the failure mode of a
security control is "deny", not "allow".

### 3.4 Cloudflare Transform Rule

On the `hooks.switchroom.ai` zone, add an HTTP Request Header
Modification rule:

- **When**: hostname equals `hooks.switchroom.ai` (and/or path starts
  with `/webhook/`).
- **Set static header**: `X-Switchroom-Edge` = `<the secret>`.

Cloudflare strips/overwrites any client-supplied `X-Switchroom-Edge` so
a forged value from outside cannot survive the edge — the rule *sets*
(not appends) the header. The secret lives only in the Transform Rule
config and the local file; it never appears in repo, compose, or agent
state.

## 4. Scope

- **Per-agent opt-in** (`webhook_require_edge`), canaried on `reggie`
  first, mirroring Phase 1's `webhook_via_gateway` rollout.
- **Receiver-side only.** The check happens entirely in the host web
  receiver; no gateway, compose, or agent-image change. Orthogonal to
  `webhook_via_gateway` (an agent can have either, both, or neither).
- **No vault dependency** in v1 — a flat operator file, matching the
  existing `webhook-secrets.json` precedent. A vault-backed resolver is
  a future option if operator burden materialises.

## 5. Rollout

1. Write `~/.switchroom/webhook-edge-secret` (random value, `0600`).
2. Add the Cloudflare Transform Rule with the same value.
3. Flip `reggie`'s `webhook_require_edge: true`; `apply` (no agent
   restart needed — receiver-side flag), restart the receiver.
4. Verify: a signed POST *through* `hooks.switchroom.ai` → `202`; a
   signed POST direct to `127.0.0.1:8080` (no edge header) → `403`.
5. Green → leave on reggie; widen per-agent as desired.

## 6. Test plan

- `src/web/webhook-edge.test.ts` — `loadEdgeSecret` (present/missing/
  empty), `verifyEdgeHeader` (match/mismatch/length/null/fail-closed).
- `src/web/webhook-handler.test.ts` — edge gate: match→202,
  missing→403, wrong→403, fail-closed (null secret)→403, flag-off
  ignored→202, gate-before-HMAC (valid edge + bad sig → 401 not 403).

## 7. Phase 3 (not this RFC)

Dedicated `switchroom-webhook` container in its own compose project,
retiring the systemd unit and the shared-checkout fragility. Tracked
separately.
