# Recommendation: Escalation 5 — track-plan-quota-live:c7 (no rolling-window reset notification)

**Recommended option:** C (scope to fatal-billing only), with a JTBD wording tightening

**Confidence:** high

## Why

The gap is real but the framing in the original claim overstates what "window rolls" means in practice. The JTBD's "Signs it's working" line says "when the window rolls, the user sees the recovery without having to refresh anything." In normal operation — an agent that was never blocked — the 5-hour or 7-day window rolling over is a non-event: usage headroom increases passively and the boot card or `/usage` on the next interaction shows the updated numbers. There is no "recovery" to surface because the user was never stuck. A proactive notification in this case lands as noise, directly violating the anti-pattern "every small usage tick produces a notification until the user mutes the product."

The case where window-reset genuinely matters is when the agent was blocked (quota exhausted, fell back to a secondary account, or showed an "all-blocked" state), and the original active account's window resets. That IS a recovery the user cares about and cannot see without action. However, `credits-watch.ts` already covers the closest analogue: it pushes a "credits restored" message when the `.claude.json` fatal-billing flag clears. The `exhausted_until` in the auth broker operates differently — it is a passive timestamp comparison (`q.exhausted_until > this.now()`), not an event. There is no callback or observer when the timestamp expires; the broker simply starts treating the account as healthy again on the next `get-credentials` call. Adding a proactive Telegram push on rolling-window expiry would require a polling loop watching for the moment `exhausted_until` transitions from future to past, plus routing that event through the gateway to Telegram — non-trivial plumbing with its own race conditions (event fires while agent is mid-restart, duplicate fires on multi-agent fleets, etc.).

Option B (accept the design with a JTBD note) is directionally correct but incomplete: it leaves the misleading "without having to refresh anything" wording intact, which will generate future audit failures on the same sentence. Option A (add rolling-window reset notification) is over-engineering: the typical fleet either recovers naturally (agent retries, gets healthy creds, resumes), or the user ran `/auth` and saw the reset window from `fiveHourResetAt`/`sevenDayResetAt` headers that `quota-check.ts` already captures and displays. The boot card on next agent start also carries fresh usage data. Option C is the cleanest path: narrow the JTBD claim to reflect what is actually implemented (fatal-billing push via credits-watch), and reword the rolling-window bullet to match the real user flow (ambient recovery visible on next boot card or `/usage`, not a push).

The right JTBD edit is surgical: replace "When the window rolls, the user sees the recovery without having to refresh anything" with something like "When a fatal billing block clears, the user hears about it without having to ask. For routine quota refills, usage resets are visible on the next boot card or `/usage`." This is honest about the two tiers of recovery — proactive for blocking states, ambient for routine resets — and eliminates the false gap without adding noisy infrastructure.

## Tradeoffs of the recommendation

- The JTBD change is purely documentary: no code touched, no CI risk, no new plumbing to maintain.
- The "was blocked, now unblocked due to window rollover" case remains non-pushed. In practice, when the `exhausted_until` window expires, the auto-fallback path (if triggered) had already swapped to a healthy account. The primary account coming back healthy after 5h is quietly picked up on the next `get-credentials` call — no user action required, and the next boot card confirms it.
- The UAT prompt "Recovery. Let the window roll. The user should see usage free up without having to refresh" will need a corresponding update or the UAT verifier will keep flagging this as a failure. Scope that into the same JTBD edit.
- This recommendation accepts that the `credits-watch.ts` recovery notification (fatal-billing cleared) is the high-fidelity push signal, and that rolling-window reset is ambient-tier. If the operator's mental model requires a push on every window reset, Option A is the right call — but it should be built with a deduplication gate (only push when the agent was previously in an exhausted state, not on every clean window rollover).

## If you pick a different option

- **Option A:** Requires adding a poller in the auth broker or gateway that watches `exhausted_until` timestamps and emits an IPC event when one transitions from future to past. The gateway then routes that event to Telegram. Non-trivial: must handle multi-account fleets (which account's reset do you notify?), the agent-name→chat mapping, and the race where the agent is mid-restart when the event fires. Estimate ~30 agent-minutes of plumbing + tests. Risk of notification spam on agents that were never blocked (the poller fires on every account whose window rolls, even if the user never saw a blocked state). Mitigation: gate the push on `prev.exhausted` state, matching the credits-watch pattern.
- **Option B:** Leaves the existing wording in place and adds a parenthetical note ("fatal-billing recovery is pushed; rolling-window reset appears on next boot card"). Reduces the false precision of the claim without removing it. Lower-effort than A, but the UAT prompt still says "without having to refresh anything," which remains literally false for rolling-window resets. Expect this escalation to recur in a future audit pass.

## Open question for the operator

The JTBD's UAT prompt ("Let the window roll. The user should see usage free up without having to refresh") will fail on any honest UAT run because the rolling-window reset produces no push. Should this UAT prompt be revised to read "Check `/usage` after the window rolls — usage should reflect the reset" (ambient tier), or removed in favor of a UAT focused on the fatal-billing recovery push?
