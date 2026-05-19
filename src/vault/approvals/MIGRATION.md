# Approval kernel — call-site migration notes

RFC B Phase 1 landed the kernel core: SQLite schema (`approval_decisions`,
`approval_nonces`, `approval_audit`), broker RPC (`approval_request`,
`approval_lookup`, `approval_consume`, `approval_revoke`, `approval_list`),
the Telegram approval-card primitive, drift detection, single-use nonce
consumption, and the `/approvals list|revoke` command surface.

## ⚠️ Phase 1 is **audit-only**, not enforcing

The dual-dispatch call sites described below (starting with `vd:unlock`
in PR #830) record an approval-kernel decision *alongside* the legacy
verdict but **do not yet gate on it**. A kernel-`deny` does NOT block
the legacy path; only the audit log gains a kernel row. This is
intentional for Phase 1 — we want production traffic flowing through
the kernel so we can compare verdicts against legacy outcomes before
making it authoritative.

Phase 2 will switch each call site so the legacy path defers to the
kernel verdict (deny → block, allow-with-nonce → consume on success).
Until then, do not assume a kernel `deny` row means access was
prevented; double-check the legacy table for that call site.

What's intentionally still on the legacy paths:

## 1. Deferred-secret unlock (`vd:unlock` / `vd:cancel`)

**Where:** `telegram-plugin/gateway/gateway.ts:5577` (card construction) and
the dispatcher around `:6944`.

**Plan:** Replace the bespoke `vd:unlock:<deferKey>` callback with an
`apv:<request_id>:once` callback minted via `approvalRequest({agent_unit, scope: 'secret:<key>', action: 'unlock'})`.
The inline-passphrase capture step (the user types their vault passphrase
in reply to the card) must survive: handle it inside the `apv:once` tap
handler, then call `approvalConsume` only after the passphrase has been
validated by the broker's unlock socket. Don't write the passphrase
through the kernel — the kernel is for *approval state*, not secret
material.

## 2. Vault-grant approval (`/vault grant` wizard, `vault-grants.db`)

**Where:** `src/vault/grants.ts` and the wizard in `gateway.ts` (search
for `vg:`).

**Plan:** The wizard already produces a durable grant row. Migrate the
*confirm* step to mint an approval kernel decision in addition to (or
instead of) the legacy `vault_grants` row, scoped as
`vault:<key>` / `read`. The two tables can coexist during the
migration window — `validateGrant` in `grants.ts` is the read path for
agents using capability tokens, and the kernel is the read path for
"is this user-side approval still valid?" lookups. After Phase 2,
`vault_grants.revoked_at` semantics fold into
`approval_decisions.revoked_at` and the wizard becomes
`/approvals add` (RFC §9 — Phase 1.5).

## 3. ask_user dispatch (`aq:` callbacks)

**Where:** `telegram-plugin/gateway/gateway.ts` (dispatch + `pendingAskUser`
in-process map) and `telegram-plugin/ask-user.ts` (callback shape).

**Plan: do not migrate.** `aq:` and the approval kernel solve different
problems and the schemas don't line up:

- `aq:` is an **N-choice question primitive** — 2–8 arbitrary option
  strings, callback shape `aq:<idx>:<askId>`, result returned to the
  agent as `{ kind: 'answered', choice: string, idx: number }`.
- The approval kernel (`apv:`) is a **binary grant/deny primitive** —
  `parseApprovalCallback` only recognizes `once|always|deny|ttl`, and
  `ApprovalDecisionModeSchema` only encodes `allow_once|allow_always|
  allow_ttl|deny|deny_perm`. There is no field on `approvalRecord` /
  `approvalLookup` to carry "user picked option idx 4 of 7".

`aq:` therefore stays on the existing in-process `pendingAskUser` map
in the gateway. The kernel handles only binary approvals (secrets,
vault grants, MCP requests). If a future RFC needs multi-choice
approvals, that's a kernel-schema extension, not a rename — see
issue #769 for the decision (option B).

## 4. Permission-rule prompts (`perm:more`, `perm:allow`, `perm:deny`)

**Out of scope per RFC §14.** Tools and skills stay on
`permission-rule.ts` + `settings.json`. Migrating these would require
intercepting and rewriting Claude Code's `settings.json` from kernel
state, which would conflict with switchroom's "unmodified Claude"
principle. Do not migrate without a fresh RFC.

## Wiring template

Inside any callsite that needs approval today:

```ts
import { approvalRequest, approvalLookup, approvalConsume } from
  '../../src/vault/approvals/client.js'
import { buildApprovalCard, parseApprovalCallback }
  from './approval-card.js'

// 1. Open a request (returns 8-hex request_id)
const req = await approvalRequest({
  agent_unit: 'switchroom-klanker.service',
  scope: 'secret:OPENAI_API_KEY',
  action: 'read',
  approver_set: access.allowFrom,
  why: 'Calling OpenAI to summarize a doc',
})
if (req === null) { /* broker unreachable — fail closed */ }

// 2. Render the card to every approver
const card = buildApprovalCard({
  request_id: req.request_id,
  agent: 'klanker',
  scope_humanized: 'OPENAI_API_KEY',
  why: 'Calling OpenAI…',
})
for (const chat_id of access.allowFrom) {
  await bot.api.sendMessage(chat_id, card.text, {
    reply_markup: card.reply_markup,
    parse_mode: 'HTML',
  })
}

// 3. In the apv: callback handler:
const parsed = parseApprovalCallback(callbackData)
if (parsed === null) return  // not ours
const consumed = await approvalConsume(parsed.request_id)
if (!consumed?.consumed) {
  await ctx.answerCallbackQuery({ text: 'this prompt expired' })
  return
}
// … then call recordDecision via approval_record (currently in-process
//   on the broker side — Phase 1.5 will surface a recordDecision RPC)
```

A `recordDecision` RPC is intentionally NOT in this commit: the gateway
owns the user-facing tap, so for Phase 1 we do the record step inside
the gateway by writing directly to the broker's grants DB through a
side channel (or by adding `approval_record` later). The kernel's
internal `recordDecision` function is exported so a future
`approval_record` RPC handler can call it without code duplication.

> **PR-6 update.** Both anticipated steps shipped: `approval_record`
> landed, then the two-RPC split (`approval_consume` → `approval_record`)
> was fused into a single atomic `approval_consume_record` op for the
> Telegram `apv:` card path. It composes the same exported `consumeNonce`
> + `recordDecision` primitives inside ONE `db.transaction()`, closing
> the consume↔record gap (a broker/gateway death between the two legacy
> ops burned the nonce with no decision → wedged turn). This realizes
> RFC §6.1's "only on rowcount=1 does the kernel proceed to insert the
> decision row" as one atomic step instead of two round-trips.
> `approval_consume` / `approval_record` remain for their other callers
> (deferred-secret + `/vault grant` dual-dispatch, `/folders`); only the
> `apv:` card migrated.
