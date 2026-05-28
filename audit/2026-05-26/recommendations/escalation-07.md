# Recommendation: Escalation 7 — rfc-sub-agent-visibility:c12 (fleet cap unimplemented)

**Recommended option:** B

**Confidence:** high

## Why

The fleet renderer at `progress-card.ts` L929-943 is not currently reachable in production. The pinned progress-card driver (`progress-card-driver.ts`) was removed from the gateway in PR #1122 PR3 — `progressDriver` is permanently `null` in `telegram-plugin/gateway/gateway.ts` (L3046), making every `progressDriver?.X` call a no-op at runtime. The `progress-card.ts` module is still imported by `progress-card-driver.ts`, but that driver is never loaded by the gateway. The fleet-zone renderer loop at L929-943 is dead code at the time of this audit.

More importantly, the RFC itself already declares the card model superseded. The document's preamble (L25-33 of `reference/sub-agent-visibility-rfc.md`) says explicitly: "Card model superseded. This RFC reasons about the two-zone progress-card model. That two-zone design has since been superseded by `reference/conversational-pacing.md`, and `reference/status-card-design.md` is archived." AC-5's cap requirement was written for a design that no longer drives the live product. The current Telegram-facing card surface is conversational pacing, not the two-zone pinned card this RFC specified.

There is no meaningful 4096-byte risk to defend against today. The `stream-reply-handler.ts` (L395-400) does enforce a hard 4096-char pre-check on `stream_reply` calls, and `answer-stream.ts` (L49) tracks the same constant — but those guard the conversational-pacing path, which does not use the uncapped fleet renderer. The `cap()` function in `fleet-state.ts` (L157-163) exists, is correct, and is exported, but the one callsite that would matter (the fleet renderer) is unreachable.

Wiring Option A now — importing `cap()` into a renderer that is not live — would cost little but achieve nothing and would leave reviewers confused about why dead code is being maintained. The correct fix is to update AC-5 in the RFC to reflect reality: remove the cap requirement, note that the two-zone card it describes was retired in PR #1122, and point to `reference/conversational-pacing.md` as the live contract. If the project eventually revives a pinned fleet card under the conversational-pacing architecture, the cap requirement should be written fresh against that design, not preserved as a phantom AC in a closed RFC.

## Tradeoffs of the recommendation

- Removing AC-5's cap requirement from a closed RFC is low-risk: the RFC's status is already "SHIPPED / CLOSED" and the doc explicitly flags the card model as superseded.
- The `cap()` function in `fleet-state.ts` remains in place and can be picked up cheaply if a future fleet renderer is ever written — no code needs to be deleted.
- There is no user-visible regression from Option B: the uncapped renderer cannot produce a 4096-byte overrun because it is not called.
- Leaving the spec as-is continues to mislead future auditors (and this audit system) into treating it as an unfulfilled implementation gap in active code.

## If you pick a different option

- **Option A:** Import `cap()` into `progress-card.ts`'s fleet section and add a `+ N more` footer. This is correct if you plan to re-activate the progress-card driver. Doing it without re-activating the driver still leaves the loop unreachable and creates well-maintained dead code — not worthless, but not gap-closure either. If you go this route, also re-wire `progress-card-driver.ts` into the gateway and write the UAT scenario (`bg-heavy-fleet-dm.test.ts`) the RFC called for in Phase 3.

## Open question for the operator

Is there an active plan to revive the pinned progress-card (two-zone or otherwise) under the conversational-pacing architecture? If yes, Option A makes sense as prep work and should be paired with re-activating the driver. If no, close AC-5 with a note and let `cap()` sit ready for future use.
