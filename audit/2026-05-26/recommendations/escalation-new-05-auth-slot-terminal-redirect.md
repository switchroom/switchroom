# Recommendation: Escalation E5 — jtbd-talk-from-anywhere:c7 (auth slot buttons redirect to terminal)

**Recommended option:** C

**Confidence:** high

## Why

The stub at `telegram-plugin/gateway/gateway.ts:13075-13082` handles the `swap-slot`
and `add-slot` callback actions by replying with "Phase 4c will wire this. Until then,
run in terminal: `switchroom auth use ...`". This is a two-failure sentence: it
announces the product as incomplete AND sends the user to a desktop terminal for a
fleet-management operation. The JTBD's core stake is "if a capability only exists on
the desktop, the user is tethered." Auth slot switching is a fleet-management verb that
the user hits precisely when the CLI is most unavailable — after a quota event on
cellular.

The recommendation is C (remove the buttons, not wire them) for this reason: the
`swap-slot` and `add-slot` inline keyboard buttons are vestiges of a UI shape that was
never built. They exist only because the button-render code ran ahead of the callback
handler. Meanwhile, the text command path `/auth use <label>` is fully wired at
`telegram-plugin/gateway/gateway.ts:11298` via `handleAuthCommand`, and `/auth add` is
wired at `gateway.ts:11266` via `startAccountAuthSession`. The user can do both
operations from Telegram already — they just cannot do them by tapping a button. The
buttons are adding confusion (a tappable thing that tells you it cannot help you) without
adding capability.

Removing the buttons eliminates the JTBD violation cleanly: no stub text, no terminal
redirect, no phone-first claim broken. The underlying `/auth` commands already satisfy
the job. The two `it.skip` tests at
`tests/jtbd-talk-from-anywhere.test.ts:186` and `:195` can be un-skipped and the
inline-keyboard assertion at `:267` rewritten to confirm the buttons do not appear.

Option A (wire the buttons to the live broker paths) is the right long-term UX but is
not a regression fix — it is a new feature. The broker `setActive` call exists
(`gateway.ts:13114` already uses it in `handleAuthDashboardCallback`), so the plumbing
is not deep, but it requires knowing which slots are available at the moment the card
renders, building the keyboard with real labels, and handling the add-slot flow (which
spawns a `startAccountAuthSession` and needs a code-paste round-trip). Estimate 35-45
agent-minutes to do it cleanly with tests.

## Tradeoffs of the recommendation

- Option C is ~10 agent-minutes: delete the two button-render callsites that emit the
  `swap-slot` / `add-slot` actions, delete the two `case` branches at
  `gateway.ts:13075-13082`, un-skip the three test assertions. No new behavior, no new
  plumbing.
- The user loses a button they cannot currently use. They gain a button that does not
  lie to them. The `/auth use <label>` text command path was always there; the button
  was obscuring it.
- The operator-event card that renders during a quota-exhausted state currently shows
  these buttons. Removing them makes the card slightly leaner; the existing `/auth use`
  hint text (rendered by `gateway.ts:11011`) remains as the action surface.
- Fleet-wide slot switching (the `auth:use:<label>` callback path at `gateway.ts:13099`)
  is a separate handler and is already wired; do not remove it.

## If you pick a different option

- **Option A (wire the buttons):** Correct direction, costs 3-4x more than C, and the
  add-slot path requires a multi-turn code-paste flow inside a callback handler, which
  is architecturally awkward (callbacks do not have a natural continuation point). A
  cleaner design would be a `/auth add` deep-link button (tapping it sends `/auth add`
  as a message into the chat) rather than embedding the OAuth flow in the callback
  handler. Do A as a follow-up after C lands.
- **Option B (better error message):** Replaces "run in terminal" with "send `/auth use
  <label>` here." This is honest and does not break the phone-first promise. It is
  strictly better than the status quo and is approximately 5 agent-minutes. It is
  inferior to C because it keeps a button that navigates the user away from the natural
  flow (they will tap the button, read the message, then type a command — the button
  added friction). B is the right call only if the operator wants to preserve button
  affordance for a future A implementation and does not want to touch the card layout.
- **Option D (soften the JTBD):** Wrong direction. Auth slot management from a phone is
  not an admin-tier edge case — it is the recovery path when a quota event hits on
  cellular. Acknowledging that it requires the host CLI would make the JTBD clause
  "there must be no moment where they wish they were at the laptop" literally false for
  a high-frequency scenario.

## Open question for the operator

The `add-slot` button was presumably rendered as forward-looking UI for a planned Phase
4c feature. Is there a timeline or priority for Option A (wired buttons), or should the
button shape be reconsidered entirely in favor of a deep-link pattern (button tap inserts
`/auth add <label>` as a message)?
