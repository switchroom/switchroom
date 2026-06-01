# RFC: Hard-boundary operator approvals (no agent self-elevation)

- Status: **Draft for operator review**
- Author: drafted 2026-06-02
- Tracks: vision.md outcome 2 ("you hold the leash — it can't self-elevate
  or route around you"); supersedes the audit-only framing of #833 / the
  approval-kernel `src/vault/approvals/MIGRATION.md` Phase 2 for the
  *enforcement* question.

## 1. Summary

Switchroom's approval surfaces (vault grants, `apv:` MCP/secret approvals)
are **soft boundaries by architecture**: the gateway that processes an
operator's Telegram tap runs in the **same container as `claude`, sharing
the same per-agent UDS sockets**. So any operator-authorization the gateway
can produce, a determined `claude` can also produce. This contradicts the
vision's "it can't self-elevate." This RFC proposes the architectural change
required for a **hard** boundary: move the operator-tap *verification* to a
host-side component `claude` cannot impersonate, and make the broker's mint
gate on a decision recorded through that path.

## 2. The problem, precisely

`vault_request_access` (agent asks → operator taps → broker mints a grant)
mints via `mint_grant` on the broker's **per-agent socket**. The
posture-attested path requires only: agent on `postureMintAgents`, telegram-id
mode, agent-self-match. **No key-ACL, no proof an operator tapped.**

Completing the approval-kernel "enforcing flip" (#833) — making the broker
require a consumed kernel `approval_decision` — does **not** fix it. The
kernel's `approval_consume` / `approval_record` are themselves on the
**per-agent socket** and verify only *"the nonce belongs to the calling
agent"* (`src/vault/approvals/kernel-server.ts:414-483`). The code says so:

> "Without this a compromised agent could self-consume + self-record an
> allow_always decision … no operator ever approved (approval-integrity
> bypass)." — kernel-server.ts:472

That listener-ACL blocks **cross-agent** forgery only. An agent forging a
decision for **its own** request still works: `claude` calls
`vault_request_access` for key K → a card with a `request_id` nonce is
posted → `claude` reads the nonce off the card → self-`consume`s +
self-`record`s an `allow` decision claiming the operator's id → mints. Every
in-container secret (`bot_token`, sockets) is reachable by `claude` (it has
Bash + full container access), so **no in-container scheme is unforgeable.**

This is consistent with `docs/vault.md` ("the ACL is misconfiguration
protection, not a security boundary") and contradicts the vision. The two
have simply never been reconciled in code.

## 3. The crux

The only authorization `claude` cannot manufacture is the operator's **real
Telegram tap** — a `callback_query` Telegram delivers, signed by Telegram's
own infrastructure, to whoever holds the bot token's update stream. To make
approvals hard, **that tap must be received and verified by a component
outside the agent container**, and the broker must gate the mint on a
decision recorded only through that component.

`hostd` is the natural home: it already runs **on the host as the operator
UID** in its own compose project, brokers privileged ops, and binds an
**operator-only socket** (`~/.switchroom/hostd/operator/sock`, mode 0600)
that no agent container can reach. But note the trap: hostd *also* binds
per-agent sockets that `claude` shares — so "route through hostd" is only
hard if the **operator-tap verification itself** happens host-side, not via
a per-agent dispatch hostd would have to trust.

## 4. Design

### 4.1 Recommended: host-side approval verification

Introduce a host-side **approval verifier** (in the hostd process / compose
project, operator UID — *not* in any agent container) that:

1. **Holds the credential that receives approval taps.** Two sub-options:
   - **(A) Dedicated approval bot.** A second Telegram bot token, host-only,
     never mounted into agent containers. Sensitive approval cards
     (vault grants first) are posted *and their callbacks received* by the
     host verifier via this bot. The agent-facing bot still drives normal
     chat; only the sensitive-approval card lives on the approval bot.
   - **(B) Host-side callback relay for the existing bot.** Move
     `callback_query` reception for `apv:`/`vg:` cards to the host verifier
     (the gateway stops being the sole poller for those updates). Heavier —
     splits one bot's update stream — and Telegram delivers a bot's updates
     to a single poller/webhook, so this effectively means the *host* polls
     and forwards non-approval updates inward. Higher blast radius.

   **Recommend (A)** — a dedicated, host-only approval bot keeps the
   unforgeable path small and additive, and never changes the agent bots.

2. **Verifies the tap** (`from.id ∈ approvers`) host-side, where `claude`
   has no token and no update stream.

3. **Records the kernel decision on the kernel's OPERATOR socket**
   (host-only). The kernel already distinguishes `isOperator` connections
   (kernel-server.ts:188, 333) — extend the operator socket to accept
   `approval_record`/`approval_consume` for the verified decision (today the
   operator socket is read-mostly; see `feedback_kernel_operator_socket_deny_by_default`
   — this RFC deliberately revisits that for the host-verified path only).

### 4.2 Broker enforcement

`mint_grant` (and the future generalized apv: gate) requires a kernel
decision that was **recorded on the operator socket** (a new
`origin: 'operator'` column on `approval_decisions`, set only by the
host-verified path; per-agent-socket `approval_record` sets
`origin: 'agent'`). Posture-attested mint accepts a decision **iff
`origin = 'operator'`**, matches the agent + keys, is consumed, unexpired.
A `claude`-forged per-agent decision has `origin = 'agent'` → rejected. The
passphrase-attested and operator-socket CLI paths are unchanged.

### 4.3 Why this is hard, not soft

`claude` can still self-`consume`+`record` an `origin='agent'` decision — but
the broker won't mint on it. It cannot produce an `origin='operator'`
decision because it cannot reach the operator socket and cannot make the
host verifier act without a real Telegram tap it cannot generate.

## 5. Scope & phasing

Same forgeability affects **all** apv: approvals (MCP tool approvals,
deferred-secret unlock). Fix vault grants first (the identified leak), then
generalize the `origin='operator'` gate to the apv: enforcing flip.

- **Phase 0 (done):** #833 Phase-1 dual-dispatch (kernel decisions recorded,
  advisory). Standing-grant primitive (v0.14.34) decouples access from crons.
- **Phase 1 — interim defense-in-depth (optional, shippable now):** add the
  key-ACL constraint to posture `mint_grant` (only keys held via standing
  config ACL; writes/new-keys require passphrase). Blocks *casual* self-grant
  and cross-agent; honestly **not** a hard boundary. Kill-switch'd.
- **Phase 2 — host verifier + dedicated approval bot (this RFC).** vault
  grants only. The hard boundary.
- **Phase 3 — generalize** `origin='operator'` enforcement to all apv:
  approvals; retire the soft per-agent record path for sensitive scopes.

## 6. Risks / rollback

- **Blast radius:** credential-granting. Every phase ships behind a config
  flag + kill-switch; default-off until validated on test-harness, then a
  monitored fleet roll. A bug must fail *closed* (deny) without wedging the
  GET path (daily reads never touch mint).
- **UX:** a dedicated approval bot is a second bot the operator taps for
  sensitive grants. Acceptable for the security gain; the normal-chat bots
  are untouched.
- **Downgrade:** `origin` column is additive; pre-existing decisions read as
  `origin='agent'` (fail-closed for the new gate, which is correct).

## 7. Open questions for the operator

1. **Approval-bot (4.1-A) vs host-side relay (4.1-B)?** A is smaller/additive
   and recommended; B avoids a second bot but splits the update stream.
2. **Ship the Phase-1 interim key-ACL constraint now** (defense-in-depth,
   honest framing) while Phase 2 is built — or wait for the hard boundary?
3. **Scope of Phase 2** — vault grants only first (recommended), or bundle
   the apv: MCP-approval generalization?
