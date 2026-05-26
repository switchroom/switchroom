# Recommendation: Escalation 4 — track-plan-quota-live:c2 (no proactive cap-approach push)

**Recommended option:** A

**Confidence:** medium

## Why

The JTBD's own "Signs it's working" list includes "Approaching a cap produces a visible signal at a point where the user can still act on it," and its anti-patterns section explicitly names "Quota visible only in a separate dashboard or a command. If the user has to go looking, they won't, and they'll hit the wall." The current reactive design — `[Fall back now]` button at 90%, `near limit — watch this` badge — is a well-executed dashboard affordance, but it lives entirely inside `/auth`. A user who isn't in the habit of checking `/auth` receives zero proactive signal until auto-fallback fires at 99.5%, which is effectively after the wall. The JTBD text is unambiguous: the signal must find the user, not the other way around. Option B (update the JTBD to describe the current design) would mean rewriting the intent of the document to match an acknowledged gap — that is rationalisation, not resolution.

The pattern for a proactive push already exists and is proven. `credits-watch.ts` (wired in gateway.ts at L15975-15997) polls every 15 minutes, reads a local file, compares against a persisted last-notified state, and calls `bot.api.sendMessage` on state transition. It fires on entry, on recovery, and on reason-change — and explicitly avoids re-firing for the same steady state. The same three-state machine (healthy → throttling → blocked) that `classifyHealth` in `auth-snapshot-format.ts` already computes is exactly the input a quota-watch module would need. Extending the credits-watch pattern to cover the 80% (`THROTTLING_THRESHOLD_PCT`) transition requires adding a broker `probe-quota` call on a polling interval and tracking last-notified health per account. The broker infra for that probe already exists (`client.probeQuota`); the state-machine logic (`classifyHealth`) already exists; the notification routing already exists. This is extension, not new invention.

Noise risk on a multi-agent fleet is real but manageable. The concern is N agents × M accounts × two windows producing a flood of threshold-crossing messages as utilization fluctuates near 80%. Three mitigations make this tractable. First, the notification should track transitions, not absolute level — exactly like credits-watch: only fire when health _changes from healthy to throttling_ (not on every poll while throttling). Second, the operator typically has 1–3 account slots, not 10+; the account pool is shallow by design (the `/auth add` flow is non-trivial). Third, a 15- or 30-minute poll interval means at most one message per crossing per account, not one per minute. The "over-alerting" anti-pattern in the JTBD points at every-tick notifications, not edge-triggered ones.

One practical sizing note: the current quota probe (`probeQuota`) makes an actual API call (a 1-token Haiku request) to read utilization headers. For the proactive watcher, the right source is the broker's cached quota state from `list-state` (already computed on the `/auth` render path), not a fresh network probe every 15 minutes per account. Reading the cached broker state is a local IPC call, keeps the polling cheap, and avoids burning API budget just to check the gauge. The watcher should only trigger a live `probeQuota` when it detects a state change and needs fresh numbers for the notification message body.

## Tradeoffs of the recommendation

- The watcher adds a polling loop in the gateway alongside credits-watch; both should share the same notification routing and state persistence pattern to avoid a third bespoke approach.
- Broker-cache polling means the notification lags by however stale the broker's stored quota is. That staleness was already accepted for the `/auth` render; it's acceptable here too. Operators can always trigger a live probe via `/auth`.
- If a user has two accounts and both cross 80% simultaneously (unlikely but possible near the end of a billing window), they get two notifications within one poll cycle. That's correct behavior, not noise — each account needs its own action.
- The broker's cached quota state is only updated when an agent makes a request. A fleet that is idle may not trigger a state-change push even if utilization is high — but that is a pre-existing limitation of the header-pull approach, not introduced by this change.
- Implementation cost is low (~25 agent minutes): a new `quota-watch.ts` module mirroring `credits-watch.ts`, wired into the gateway boot block, using `classifyHealth` for the state machine and broker list-state for the input.

## If you pick a different option

- **Option B:** Rewriting the JTBD to accept reactive-only design closes the audit finding without shipping value. The stakes section ("A user who hits a wall silently loses trust") would then be a known unfulfilled risk, not a gap. This is appropriate only if the operator has explicitly decided the dashboard affordance is sufficient — a deliberate product choice, not a technical gap.
- **Option C:** Hybrid (document current state, note proactive push as planned) is a reasonable interim choice if implementation capacity is constrained right now. It resolves the audit finding by making the gap intentional and tracked, without shipping incomplete code. The risk is that "planned" items without a PR or milestone tend to stay planned — use this option only with a concrete follow-up issue created at the same time.

## Open question for the operator

Should the proactive push be scoped to the _active_ account only, or to all accounts in the pool? The auto-fallback machinery cares about the whole pool (to pick the best target), but the user typically acts by switching to an account that has headroom — so a notification about a non-active account approaching its limit is also actionable. The credits-watch precedent fires per-agent (one gateway, one account context); the new watcher would have access to all accounts via broker `list-state` and could choose either scope.
