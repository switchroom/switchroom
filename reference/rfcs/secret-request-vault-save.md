# RFC: Agent-requested secrets — secure save-card → vault (no chat paste)

**Status:** Draft (needs operator product decision on §6)
**Owner:** Ken Thompson
**Date:** 2026-06-01
**Related:** [bot-token-to-vault.md](./bot-token-to-vault.md), [vault-broker-resilience.md](./vault-broker-resilience.md); incident PRs [#2043](https://github.com/switchroom/switchroom/pull/2043) (Sanctum pattern + history redaction), [#2046](https://github.com/switchroom/switchroom/pull/2046) (outbound transport redaction). Tracking issue: #2045.

## 1. Summary

When an agent needs a secret that isn't in the vault, it must **never ask
the user to paste the raw value into a chat message**. Today nothing stops
that — it's exactly what triggered the 2026-06-01 incident: Clerk asked the
operator to paste a Coolify API token because the `vault:` entry was empty,
the operator pasted it as freeform text, and (because the Sanctum shape was
uncovered) it persisted in plaintext.

This RFC adds the missing primitive: an agent-facing **`request_secret`**
tool that triggers a **secure save-card → vault** flow. The operator taps
the card and sends the value once; the gateway deletes it instantly and
writes it straight to the vault. The raw value is never recorded to
history, never logged, and **never returned to the agent** — the agent only
ever sees `vault:<key>`.

This is composition of primitives that already exist for the
detected-paste and OAuth-code flows; it is not new cryptography or a new
storage path.

## 2. Motivation — which JTBDs this serves

- **You hold the leash** — the operator explicitly authorizes each secret
  by tapping a card; the agent can request but never self-serve a value.
- **Subscription-honest / safe-by-construction** — secrets stop traveling
  the channel as freeform text. #2043/#2046 are the *safety net* (detect +
  redact); this removes the *reason* the net gets exercised.
- **A standing team that knows you** — agents acquire the credentials they
  need without a clumsy "paste your token here" exchange that a
  non-technical operator shouldn't be coached into.

## 3. The leak today (what we're replacing)

1. Agent: "Please paste your Coolify API token here and I'll use it."
2. Operator pastes `17|<40-char>` as a normal message.
3. Inbound gate runs `detectSecrets` (ingest, fail-closed) — but only
   catches it if a pattern matches. Pre-#2043 the Sanctum shape was
   uncovered → the raw token was recorded to `history.db` and forwarded to
   the agent over IPC.

Even with #2043 (pattern now matches → delete + offer-to-vault) and #2046
(outbound mask), the *value still transits the channel* before the gate
deletes it, and the UX still coaches a paste. The fix is to never ask for a
freeform paste.

## 4. Design

### 4.1 New tool: `request_secret`
On the `switchroom-telegram` MCP server (agent-facing):

```
request_secret(key: string, reason: string, chat_id?: string)
```

- `key` — the vault key the agent needs (e.g. `coolify/api-token`).
- `reason` — one line shown to the operator ("to trigger a redeploy").
- Returns immediately with a tool result like: *"Asked the operator to
  provide `vault:<key>`. It will be available once they approve; do not ask
  them to paste it in chat."* The agent does **not** block on it and does
  **not** receive the value.

### 4.2 The save-card
The gateway posts to the operator chat:

> 🔒 *<agent>* needs a secret: `<key>` — <reason>.
> Tap **Provide securely**, then send the value. I'll delete your message
> instantly and store it in the vault — it's never shown in chat or to the
> agent.
> `[ Provide securely ]  [ Not now ]`

Callback_data is namespaced + minted exactly like the existing deferred-
secret keyboard (`buildDeferredSecretKeyboard` / `mintDeferredSecretKernelRequest`).

### 4.3 Secure value capture (reuses proven machinery)
- **Provide securely** → set an `awaitingSecretValue` marker for the chat:
  `{ key, agent, requestedAt }` with a TTL (mirror `awaitingAuthCodeAt` /
  `AUTH_CODE_CONTEXT_TTL_MS`). Edit the card → "Send the value for `<key>`
  now (auto-deletes)."
- The **next inbound message** in that chat is intercepted **early in
  `handleInbound`** — before `recordInbound`, before the IPC broadcast,
  before even the normal secret-detect logging — and treated as the value:
  1. `deleteSensitiveMessage(chat_id, msgId, 'requested secret value')`.
  2. Write to the vault under `key` via the **existing deferred-secret
     path**: if a passphrase is cached, store directly; if not, stage with
     `suggested_slug = key` and present the existing one-tap
     unlock-and-save card (`buildDeferredSecretKeyboard`). This is the same
     code path a detected paste already uses — we just pre-set the slug
     instead of deriving it.
  3. Confirm: "✅ saved as `vault:<key>` (masked: `<maskToken>`)." Clear the
     marker.
  4. **Never** `recordInbound`, never broadcast to the agent, never log the
     value. (The capture branch `return`s, exactly like the existing
     auth-code branch at gateway.ts ~9601/9683.)
- **Not now** / TTL expiry → drop the marker; tell the agent the request
  was declined so it can proceed without the secret or re-ask later.

### 4.4 Agent guidance (the behavioral fix)
Update the fleet behavior text (the `TELEGRAM_GUIDANCE` const →
`renderFleetInvariants` → `switchroom-invariants.md`, per
`reference_live_telegram_guidance_carrier`): **"Never ask the user to paste
a secret, API key, token, or password into chat. If you need a credential
that isn't in the vault, call `request_secret(key, reason)` — the operator
provides it through a secure card and you reference it as `vault:<key>`."**
This is what actually prevents the incident class; the tool + card are the
mechanism it points at.

### 4.5 This is the THIRD member of an existing tool family

The gateway already ships two agent-initiated vault tools (issue #969 P1a / #1012):

- **`vault_request_save(chat_id, key, value, …)`** — the agent **has** a
  value and asks the operator to approve saving it (`executeVaultRequestSave`,
  `PendingVaultRequestSave`, `vrs:` callbacks, `renderVaultRequestSaveCard`).
- **`vault_request_access(chat_id, key, scope, …)`** — the agent hits
  `VAULT-BROKER-DENIED` and asks the operator to grant it read/write access
  to an existing key (`vra:` callbacks).

`request_secret` is the **missing third case**: the agent needs a value it
does **not** have. It is `vault_request_save` *minus the `value` arg* — the
value arrives from the operator via secure capture instead of from the
agent. It reuses the same staging map shape, card/keyboard rendering, slug
validation (`VAULT_KEY_REGEX`), and the on-tap vault write
(`defaultVaultWritePosture` / `defaultVaultWrite`). New callback prefix
`vsp:` (vault-secret-provide), mirroring `vrs:`.

**This resolves §6.1:** the access grant is NOT new work — after the value
is saved, the requesting agent gets read access through the *existing*
`vault_request_access` flow (or the operator's `mcp_servers[].secrets[]`).
`request_secret` can optionally chain into it, but it doesn't reimplement
granting.

## 5. Why this is low-risk to build

Every piece already exists and is battle-tested:

| Need | Existing primitive |
|---|---|
| "next message in chat is sensitive" marker + TTL | `awaitingAuthCodeAt` / `AUTH_CODE_CONTEXT_TTL_MS` |
| delete the raw message from chat, surfacing failures | `deleteSensitiveMessage` |
| stage a value for vault write under a chosen slug | `deferredSecrets` + `runPipeline` store path |
| one-tap unlock-and-save when no passphrase cached | `buildDeferredSecretKeyboard` + `mintDeferredSecretKernelRequest` |
| early-return before record/broadcast | the auth-code branch in `handleInbound` (~9601/9683) |
| masked confirmation | `maskToken` |

The new code is the `request_secret` tool + handler, the `awaitingSecretValue`
map, one callback branch, and one early interception branch in
`handleInbound`. Plus the guidance string.

## 6. Open product decisions (need operator input before implementation)

1. **Does `request_secret` auto-propose a broker ACL grant** for the
   requesting agent (so it can then *read* `vault:<key>`), or is granting
   left to the operator editing `mcp_servers[].secrets[]` in
   `switchroom.yaml`? Requesting ≠ access: the value lands in the vault
   under broker ACL regardless; the question is whether we offer a one-tap
   "also let <agent> read this" on the same card. (Recommendation: offer it
   on the card, since the operator is already in the approve flow — but it's
   a security-posture call.)
2. **Tool name + card copy** — `request_secret` vs `need_secret` vs
   `ask_for_credential`; exact card wording. Product/voice call.
3. **Should we also intercept a detected raw-secret paste** (the #2043
   flow) and *steer* it: "looks like you pasted a secret — want me to save
   it to the vault instead?" Already partly true (detected pastes are
   deleted + offered for vaulting); this would add explicit steering copy.
   In scope here or a separate ticket?
4. **Rate/spam control** — TTL + per-key dedupe so an agent can't spam
   save-cards. (Recommendation: one open request per `(chat, key)`, 5-min
   TTL.)

## 7. Test plan (on implementation)

- Unit: the `awaitingSecretValue` marker set/expire/clear; the capture
  branch routes to the vault-write path with `slug === key` and returns
  before record/broadcast.
- Structural (handlers aren't exported): `request_secret` registered in the
  tool list + dispatch; capture interception sits BEFORE `recordInbound` /
  broadcast in `handleInbound` (mirror `gateway-secret-detect.test.ts`).
- Guarantee: a captured value never appears in `history.db` (extend
  `history.test.ts`) and never in the IPC payload.
- UAT (operator, mtcute): end-to-end — agent calls `request_secret`, card
  appears, operator provides, value deletes + vaults, agent reads
  `vault:<key>`.

## 8. Out of scope

- Non-Telegram channels.
- Secret *rotation* prompts (separate from first-time provisioning).
- Changing the vault storage/encryption model.
