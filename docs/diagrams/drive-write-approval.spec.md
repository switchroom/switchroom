# drive-write-approval — diagram spec

Status: new
Source of truth in code:
- `telegram-plugin/gateway/drive-write-approval.ts:177` — shipped path registers **one** kernel request, scope `doc:gdrive:write:${fileId}`
- `telegram-plugin/gateway/drive-write-approval.ts:198` — passes only `suggestRequestId: registered.request_id` to `buildCard` (no `writeRequestId`)
- `telegram-plugin/gateway/diff-preview-card.ts:40,49` — `suggestRequestId` required; `writeRequestId?` **optional** (renderer capability, RFC E default is suggest-only)
- `telegram-plugin/gateway/diff-preview-card.ts:111-112` — write-mode emits only `apply_directly`; renderer drops it when `writeRequestId` omitted
- `src/drive/diff-preview.ts` — `buildDiffPreview()` (the rendered diff body)
- `telegram-plugin/gateway/approval-callback.ts` — `apv:<request_id>:once` callback routing
- Reuses the kernel from `approval-grant-flow.spec.md` (do not draw a second kernel)

> Shipped vs renderer-capable: today the flow registers a **single**
> kernel request at scope `doc:gdrive:write:<fileId>` and renders it
> through the suggest-button slot. The two-scope card (separate
> `doc:gdrive:suggest:` vs `doc:gdrive:write:` requests + an escalation-
> gated "Apply directly" button) is a renderer capability
> (`writeRequestId?`) that the gateway does **not** yet wire. Draw the
> shipped single-request path solid; show the second button as a dashed
> "renderer-capable, not wired" affordance so the diagram stays
> code-grounded, not RFC-aspirational.

Headline: "Editing a Google Doc is a gated tool call too."
Footer:   "Same kernel, same TTL, same audit — a diff you approve before it lands in Drive."

## Nodes

1. `agent` · Drive write intent (MCP tool) · dark card
2. `approval kernel` · same singleton as approval-grant-flow — render with the *identical* card treatment, not a new component · plain, focal
3. `diff-preview card (Telegram)` · phone frame:
   - file name + rendered diff (`buildDiffPreview`)
   - **shipped**: one approve button bound to the single
     `doc:gdrive:write:<fileId>` request (rendered via the suggest slot)
   - **renderer-capable, dashed/ghosted**: a second "⚠ Apply directly"
     button (`writeRequestId?`) — not wired by the gateway today
   - on grant: card gains an **"Open in Drive"** button
4. `Google Drive` · the write/suggestion lands · teal

## Edges

- 1 → 2 · "register one kernel request @ doc:gdrive:write:<fileId>, get request_id + expires_at" · primary-flow ①
- 2 → 3 · "post diff-preview card" · primary-flow ②
- 3 → 2 · "user taps approve — apv:<request_id>:once" · primary-flow ③
- 2 → 1 · "hook polls request_id → resumes / denies" · primary-flow ④
- 1 → 4 · "write applied" · primary-flow ⑤
- 3 → 4 · "Open in Drive" · leader (post-grant button, not the flow)
- (dashed) second-scope escalation · "renderer-capable, not wired" · leader

## Style notes

Inherits v3. This is the sibling of `approval-grant-flow`: reuse its
kernel card 1:1 and the same ①②③④ step-color scheme so a reader sees
"Drive writes ride the existing approval rail." The only new surface is
the single-request diff card + the Open-in-Drive post-grant button; the
second escalation button is drawn ghosted/dashed (renderer-capable, not
wired) so the diagram never overstates the shipped flow. Callout 8 of
`deterministic-status-anatomy` points here (a Drive write is a separate
gated approval, not part of the status surface — do not conflate).
