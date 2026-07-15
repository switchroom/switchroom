# approval-broker — diagram spec

Status: new

**One idea (comprehension-first):** Most agents act first; Switchroom asks
first. Before any risky move the approval broker pauses the agent and hands
the decision to you. You hold the leash.

**Source of truth = `approval-broker.html`** (Method A, HTML/CSS → 2x PNG;
see DESIGN.md Part 2). The `.html` is authored and diffable; regenerate the
raster with
`docs/diagrams/scripts/render.sh docs/diagrams/approval-broker.html 1200x760`
(writes `approval-broker.png` at 2x, 2400×1520). This is the plain-language
sibling of `approval-grant-flow` — same mechanism, one-concept framing.

Source of truth in code:
- `src/vault/approvals/kernel.ts:1-13` — stateless decision store keyed
  `(agent_unit, scope, action)`; durable allow/deny, TTL, approver set. The
  agent cannot self-approve.
- `src/vault/approvals/kernel-server.ts:24-27` — per-agent UDS IPC; operator
  host socket is read-only.
- `telegram-plugin/gateway/approval-callback.ts:14-21` — agent fires the
  request, ends the turn, polls for the verdict (the "pause").
- `telegram-plugin/gateway/approval-card.ts:49` — `apv:<request_id>:once`
  Allow/Deny inline Telegram card.

Headline: "Most agents act first. Switchroom asks first."
Footer:   "You hold the leash. The pause is enforced in code, not left to good behaviour."

## Nodes

1. `agent · claude` · wants to do something sensitive (send email, run a
   command, spend money) · dark card · brass step
2. `approval broker` · pauses the action; nothing runs yet · pause card with
   red "On hold" tag · cord step (the emotional centre / pause)
3. `your phone (Telegram)` · approval card mock: `@worker wants to send an
   email`, the what + why, **Allow / Deny** · phone frame · cord step
4. `outcome` · only then it proceeds; Allow runs, Deny backs off cleanly ·
   brass-filled done card

## Edges

- 1 → 2 · agent → broker: risky action registered · primary-flow (brass)
- 2 → 3 · broker → phone: Approve/Deny card with what + why · primary-flow (cord)
- 3 → 4 · you tap Allow, action proceeds · primary-flow (brass)

## Style notes

Inherits v3. Success/done role = solid brass fill with a charcoal glyph (the
"brass-filled check"), replacing the retired off-brand teal. Red (cord) is
reserved for the pause/hold beat only — the signature "asks first" moment.
Keep visually consistent with `approval-grant-flow` (same kernel mechanism).
