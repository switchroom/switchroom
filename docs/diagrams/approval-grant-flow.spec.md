# approval-grant-flow — diagram spec

Status: current

**One idea (comprehension-first):** An agent can't touch anything sensitive
until you tap Allow.

**Source of truth = `approval-grant-flow.html`** (Method A, HTML/CSS → 2x PNG;
see DESIGN.md Part 2). The `.html` is authored and diffable; regenerate the
raster with `docs/diagrams/scripts/render.sh docs/diagrams/approval-grant-flow.html 1200x760`
which writes `approval-grant-flow.png` at 2x (2400×1520). This diagram is the
reference implementation of the DESIGN.md guide. (The legacy `.svg`/`.jpg`
remain for now; the README image swap to the new PNG lands in a follow-up PR.)
(Corrected 2026-05-19: the prior spec/SVG overstated the model with
"Every gated tool call" and a synchronous "claude REPL paused" node.
The kernel does NOT gate every tool call generically. It is a decision
store keyed (agent, scope, action); the agent registers a request,
ends its turn, and polls for the verdict. Spec and SVG were both
regenerated to the corrected register-and-poll model.)

Source of truth in code:
- `src/vault/approvals/kernel.ts:1-13` — stateless decision store keyed
  `(agent_unit, scope, action)`; durable allow/deny, TTL, approver set
- `src/vault/approvals/schema.ts` — SQLite-backed grant store
- `src/vault/approvals/kernel-server.ts:24-27` — per-agent UDS IPC;
  operator host socket is read-only (`approval_list` only, `:542`)
- `telegram-plugin/gateway/approval-callback.ts:14-21` — agent fires the
  request, ends the turn, polls `approval_lookup` once for the verdict
- `telegram-plugin/gateway/approval-card.ts:49` — `apv:<request_id>:once`
  Allow/Deny callback (the inline Telegram card)
- `src/agents/compose.ts:904` — `approval-kernel` singleton service
  (citation aligned with `runtime-topology.spec.md`)

Headline: "Privileged action? The agent asks. You approve in Telegram. Scoped, TTL'd, audited."
Footer:   (none)

## Nodes

1. `agent · claude` · registers a scoped request, ends the turn, then
   polls for the verdict (NOT a held synchronous pause) · dark card
2. `approval kernel` · "SQLite decision store + per-agent UDS" · table
   (agent/scope/action/state/ttl) · plain, focal
   - caption: "Decisions are scoped and TTL'd. One-off allow never
     silently becomes forever. The agent cannot self-approve."
3. `your phone (Telegram)` · approval card mock: `@worker wants to <action>`,
   the what + why (diff / key / command), **Allow / Deny**, scope chips
   "this call · ttl 15m · always" · phone frame

## Edges

- 1 → 2 · "① agent → kernel: register request (scope, get request_id + expires_at)" · primary-flow (brass ①)
- 2 → 3 · "② kernel → phone: push Approve/Deny card with what + why" · primary-flow (cord ②)
- 3 → 2 · "③ phone → kernel: you tap Allow (or Deny)" · primary-flow (cord ③)
- 2 → 1 · "④ agent polls request_id → proceeds on allow; clean recoverable refusal on deny" · primary-flow (brass-done ④)

## Style notes

Inherits v3. Success/done role = solid brass fill with a charcoal glyph (the
"brass-filled check") — the retired off-brand teal is gone; red (cord) is
reserved for the pause beat only. The Drive write path (`drive-write-approval.spec.md`)
reuses this exact kernel + the `apv:<request_id>:once` callback — keep
both diagrams visually consistent (same kernel card treatment, same
①②③④ step-numbering colors). The vault-broker grant path
(`auth-broker-credential-plane` / vault docs) is the sibling on the
*credential* plane; same human-approval shape, different daemon.
