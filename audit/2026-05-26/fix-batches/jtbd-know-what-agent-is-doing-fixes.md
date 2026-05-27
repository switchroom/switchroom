# Fix batch: fix stale/dead claims in jtbd-know-what-my-agent-is-doing.md and docs/posthog.md

**Scope:** `reference/know-what-my-agent-is-doing.md` and `docs/posthog.md`.
**Verdict pattern:** drift-minor (2), drift-major (1), dead-pointer (1), jtbd-too-technical (1).
**Estimated edits:** small (~12 lines across 2 files).

## Findings in this batch

### Finding 1 -- jtbd-know-what-my-agent-is-doing:c1

- **File:** `reference/know-what-my-agent-is-doing.md` L37
- **Quote:** "It fires within ~100ms of the message arriving (received)"
- **Verdict:** drift-minor
- **Proposed action:** update-text
- **Proposed text:** Replace "~100ms" with "within ~800ms (sub-second)" or "effectively immediately (sub-second)".
- **Evidence:** `telegram-plugin/gateway/gateway.ts` L7850-L7854 -- code comment states "The spec deadline is 800ms."
- **Rationale:** The code's own spec deadline is 800ms. The JTBD says ~100ms. The intent ("effectively instantly") is preserved but the specific number is wrong by 8x.

### Finding 2 -- jtbd-know-what-my-agent-is-doing:c4

- **File:** `reference/know-what-my-agent-is-doing.md` L51-L52
- **Quote:** "is reserved for genuine 5xx server errors and is also non-terminal: recovery to a working state from is allowed"
- **Verdict:** drift-major
- **Proposed action:** update-text
- **Proposed text:** Remove or rewrite this claim. is never emitted as a reaction on the user's inbound message. For 5xx events, appears as a message prefix in operator notifications (`operator-events.ts`), not as a status reaction. The non-terminal error reaction (what the JTBD likely intends) is (REACTION_VARIANTS.error), which IS non-terminal.
- **Evidence:** `telegram-plugin/status-reactions.ts` L71-L85 -- no entry in REACTION_VARIANTS; `operator-events.ts` L369-L383 -- for 5xx in message text only.
- **Rationale:** The JTBD frames as a reaction-state on the user's inbound message. It is not. This misinforms readers about the reaction lifecycle.

### Finding 3 -- jtbd-know-what-my-agent-is-doing:c5

- **File:** `reference/know-what-my-agent-is-doing.md` L58-L61
- **Quote:** "Implementation: `telegram-plugin/status-reactions.ts` (controller), `telegram-plugin/gateway/gateway.ts` (turn_end IPC handler -> `finalizeStatusReaction`). The technical contract spec lives at `telegram-plugin/docs/waiting-ux-spec.md`."
- **Verdict:** jtbd-too-technical
- **Proposed action:** rewrite-at-outcome-level
- **Proposed text:** Remove the "Implementation:" paragraph. Replace with: "See the ambient layer design contract at `reference/conversational-pacing.md`." (The conversational-pacing.md reference at L106 is already the right level for this JTBD.)
- **Evidence:** `telegram-plugin/status-reactions.ts` and `telegram-plugin/docs/waiting-ux-spec.md` both exist and are real, but naming specific files, function names (`finalizeStatusReaction`), and IPC event labels (`turn_end`) leaks architecture into a JTBD.
- **Rationale:** JTBDs describe user outcomes. An "Implementation:" paragraph naming internal function names is too technical for this document category.

### Finding 4 -- jtbd-know-what-my-agent-is-doing:c11

- **File:** `reference/know-what-my-agent-is-doing.md` L57 AND `docs/posthog.md` events table
- **Quote:** "see the `inbound_ack` event in `docs/posthog.md`"
- **Verdict:** dead-pointer
- **Proposed action:** update-text
- **Proposed text:** Two options: (A) Add `inbound_ack` to `docs/posthog.md`'s events table (pointing to `telegram-plugin/streaming-metrics.ts`). (B) Change the reference in the JTBD to point at `streaming-metrics.ts` where the event type is declared.
- **Evidence:** `docs/posthog.md` L72-L77 -- `inbound_ack` is not in the events table; `telegram-plugin/streaming-metrics.ts` L60-L65 -- event type IS declared there.
- **Rationale:** The cross-reference sends readers to a doc that doesn't contain what it promises. Prefer option (A): add the row to posthog.md so it stays as the single events reference.

## Out of scope for this batch

- The silence-poke success rate finding (`jtbd-know-what-my-agent-is-doing:c12`) is `outcome-not-realized` -- escalated, not a doc edit batch.
