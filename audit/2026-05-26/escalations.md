# Drift Audit Phase 2 Escalations

**Run date:** 2026-05-26
**Escalated by:** Phase 2 triage agent
**Recommendations drafted by:** Phase 2.5 recommendation agents (2026-05-26)
**Rule:** These findings require operator decision. They are NOT assigned to any fix-batch because they cannot be resolved by a doc edit alone — they require either a product decision, a code change, or explicit acceptance of a vision gap.

Total escalations: 10. Each carries an inline **Recommendation** drafted by a fresh agent that read the cited evidence. The operator chooses; recommendations are not auto-applied.

---

## Escalation 1

**ID:** contract-vision:c8
**Type:** code-violates-contract (medium confidence)
**File:** `reference/vision.md`
**Evidence files:** `src/config/schema.ts` L1692-1702, `src/cli/telegram.ts` L158-169

**Claim:**
The vision's "What it isn't" table (L127) states "No OpenAI, Gemini, Llama, model swapping." Outcome 3 (L79) forbids "No raw API."

**Violation found:**
Two features use external OpenAI API paths:
1. The Hindsight memory system (`src/config/schema.ts` L1692-1702) supports `openai` and `anthropic` as embedding providers with an `api_key` field. An operator can configure the product to spend against an OpenAI API key for embeddings.
2. The voice-in feature (`src/cli/telegram.ts` L158-169) calls OpenAI Whisper for transcription using a separately stored API key.

**Decision required:**
Does the vision's "No OpenAI" constraint apply only to inference model swapping, or also to auxiliary service APIs (embeddings, transcription)? Options:
- (A) Accept the carve-out: add explicit language to `reference/vision.md` distinguishing "auxiliary service APIs" from inference model swapping.
- (B) Restrict the features: remove or constrain the OpenAI embedding provider and/or Whisper path to comply strictly with the vision.
- (C) Defer: document as a known tension; no change to vision or code.

**Confidence:** Medium. The vision's exact wording targets "model swapping" for inference, but the features create a second billing surface outside Anthropic.

## Recommendation — Escalation 1

**Recommended option:** A
**Confidence:** high

### Why

Reading the vision in context, the constraint targets *inference model routing* — every agent *turn* through the unmodified `claude` CLI on Pro/Max. Neither Whisper nor an OpenAI embedding provider is an inference model for agent turns.

The two surfaces are structurally different from the prohibited pattern:

- **Voice-in (Whisper)** is explicitly opt-in per agent (`src/config/schema.ts:588` documents "Off by default — opt-in per agent"). `docs/telegram-features.md:53-57` already contains a self-aware tradeoff note acknowledging "Switchroom asks you to leave the Pro/Max-only ceiling — there's no Anthropic-side voice transcription yet." This is precisely the kind of explicit, acknowledged, opt-in auxiliary service that Option A would legitimise in writing.
- **Hindsight embedding provider field** has `openai`/`anthropic` choices that appear to be vestigial. At runtime, `src/memory/hindsight.ts:42` defaults to `ollama` (local, no API key). `src/cli/memory.ts:292-300` actively *ignores* `--provider` flags other than `claude-code` — the bundled image is pinned to `HINDSIGHT_API_LLM_PROVIDER=claude-code` (see `docs/auth.md:325`). The schema text advertising `openai` is currently dead for operators running the bundled image.

Option A — adding a narrow carve-out paragraph to `reference/vision.md` — is the honest fix. The "No OpenAI" line was written to foreclose model swapping (routing agent turns through GPT-4 or Gemini), not to prohibit every third-party API a user might subscribe to for auxiliary tasks. Codifying this distinction gives future contributors a clear rule.

### Tradeoffs of the recommendation

- The carve-out language must be narrow enough not to open the door to "optional" OpenAI inference paths by analogy. Use "auxiliary services" with explicit opt-in requirement — not a general "third-party APIs are fine" waiver.
- The Hindsight embedding schema fields (`openai`, `anthropic`, `api_key`) describe configuration currently unreachable via `switchroom memory --start`. Leaving them undocumented as out-of-maintenance is low-level debt; Option A should note this for a follow-up cleanup.
- Accepting the carve-out implicitly accepts that voice-in creates a second billing relationship (OpenAI) for the operator. Already disclosed in feature docs; vision should echo it.
- If Anthropic or a third-party later ships subscription-level transcription via the `claude` CLI, voice-in should migrate. The amended text should include a sunset clause ("until a subscription-native transcription path exists").

### If you pick a different option

- **Option B (restrict the features):** Removing Whisper eliminates the one user-visible capability that lets a principal send voice notes from their phone — a real loss for Outcome 4 and a regression for users already relying on it. Removing embedding provider schema fields is lower cost but requires a migration path. Only right if policy-level consistency outweighs the feature.
- **Option C (defer):** Leaves contributors with a visible contradiction the audit will flag again next pass. Acceptable only if evaluating a subscription-native transcription path before committing to carve-out language.

### Open question for the operator

The `memory.config.provider` schema field (`src/config/schema.ts:1690-1693`) lists `openai` and `anthropic` as valid values, but `switchroom memory --start` ignores them and the bundled image is pinned to `claude-code` — are these provider values intended for operators bringing their own Hindsight image, or are they dead schema text that should be removed?

---

## Escalation 2

**ID:** jtbd-give-each-agent-its-own-workspace:c2, c3, c12
**Type:** outcome-not-realized
**File:** `reference/give-each-agent-its-own-workspace.md`
**Evidence files:** `src/repos/agent-worktree.ts`, `src/repos/bare-clone.ts`, `src/agents/scaffold.ts` L246-253

**Claim:**
The JTBD states "Adding a switchroom agent that works on a repo automatically gives that agent its own worktree. The user doesn't run `git worktree add`. They don't pick a path. They don't pick a branch." And: "Worktrees are provisioned lazily — on the first `agent restart`/`reconcile`."

**Gap found:**
`ensureAgentWorktree` and `ensureBareClone` are imported in `scaffold.ts` (L246-253) but have **zero production call sites**. `reconcileAgent` does not call either function. `scaffoldAgent` does not call them. No CLI command triggers them. A user who adds `repos:` to `switchroom.yaml` and runs `switchroom apply` or `switchroom agent restart` does NOT get a worktree provisioned. The `SWITCHROOM_REPO_*` env vars are injected into `start.sh` pointing at paths that don't exist on disk.

**Decision required:**
- (A) Wire the provisioning: add `ensureAgentWorktree`/`ensureBareClone` calls to `reconcileAgent` or `scaffoldAgent`. Update the JTBD after the feature ships.
- (B) Remove the partial implementation: remove the env var injection and unresolved imports until the feature is fully planned. Update the JTBD to mark as vision-only.
- (C) Explicitly document as incomplete: add a disclaimer to the JTBD noting the feature is not yet wired end-to-end.

## Recommendation — Escalation 2

**Recommended option:** A (wire the provisioning)
**Confidence:** high

### Why

The partial implementation is not a stub — it is a complete, well-reasoned implementation. `src/repos/bare-clone.ts` (72 lines) handles idempotent bare-clone creation and fetch-all refresh with graceful network-failure handling. `src/repos/agent-worktree.ts` (323 lines) handles first-create, clean-ff, dirty-skip, dirty-commit surfacing, removal, prune, and orphan detection — the full lifecycle described in the JTBD's "Decisions" section. Both files have proper docstrings, match the design exactly, and are idempotent and safe to call on every reconcile. This is a complete feature waiting for a two-line call site, not a half-written sketch.

The gap is entirely at the integration layer. `src/agents/scaffold.ts` imports all five symbols but calls only `agentWorktreePath` — to compute a deterministic path injected as `SWITCHROOM_REPO_<SLUG_UPPER>` into `start.sh` via `buildRepoEnvVars`. The env var injection is fully wired in both `scaffoldAgent` and `reconcileAgent`. The bare-clone creation and worktree provisioning those paths point at are not. Result: env vars injected pointing to paths that don't exist.

The `repos:` schema field is complete and documented (`src/config/schema.ts:1592-1623`), `docs/configuration.md:544-550` already tells operators to use `repos:` for git-repo agents, and `docs/rfcs/host-control-daemon.md` references the pattern as canonical. The feature is committed to in user-facing documentation. Option B would invalidate that documentation. Option C is awkward given the schema already accepts `repos:` entries today.

The wiring delta is small: in `reconcileAgent`, after the existing agentDir check (scaffold.ts:3678), call `ensureBareClone` for each entry in `agentConfig.repos`, then `ensureAgentWorktree` with the returned clone path. Mirror `removeAgentWorktree` in the agent-remove path. Both functions are idempotent; calling them on a reconcile with no `repos:` is a no-op.

### Tradeoffs of the recommendation

- Wiring makes `reconcileAgent` either async (ripple through callers) or requires `Promise.resolve` wrappers — the provisioning functions are declared async but use `execFileSync` internally. A small refactor to synchronous signatures, or wrapping at the call site, avoids the async refactor.
- The `removeAgentWorktree` teardown path needs to be found and wired for the "removal is symmetric" JTBD contract.
- First reconcile after a user adds `repos:` will block on `git clone --bare` — network-latency at reconcile time. The existing function handles fetch-fail gracefully.
- The env var injection is already shipping to agents configured with `repos:`. Those agents currently get a valid-looking env var pointing at nonexistent paths. Wiring fixes this silently on next restart with no user action.

### If you pick a different option

- **Option B (remove):** Requires removing the `repos:` schema field, `buildRepoEnvVars`, all five imports, and the `docs/configuration.md:544-550` guidance. Net deletion of ~430 lines of tested implementation. Configuration breakage is silent — operators who followed the docs will have invalid YAML or silently broken configs. Disruptive without a clear payoff.
- **Option C (disclaim):** The schema accepts `repos:` today with no warning. An operator who configures it sees `SWITCHROOM_REPO_<SLUG>` pointing at a nonexistent path — agent silently fails to find the repo. A JTBD disclaimer doesn't surface at the point of failure. Worse than current state.

### Open question for the operator

`reconcileAgent` is synchronous today — do you want the worktree-provisioning call sites to refactor the provisioning functions to synchronous signatures (straightforward, since they already use `execFileSync` internally), or do you want `reconcileAgent` to become async (larger ripple through callers in `src/cli/agent.ts` and `src/cli/apply.ts`)?

---

## Escalation 3

**ID:** jtbd-restart-and-know-what-im-running:c3, c8
**Type:** outcome-not-realized
**File:** `reference/restart-and-know-what-im-running.md`
**Evidence files:** `telegram-plugin/gateway/boot-card.ts`, `telegram-plugin/welcome-text.ts` L22-28

**Claim (c3):** "The user can tell if the model changed, the tools changed, skills were added or removed, or memory is attached."
**Claim (c8):** "When something did change, the change is obvious, not buried."

**Gap found:**
The boot card (`RenderBootCardOpts`) has no model, tools allowlist, or memory-backend fields. A config change (model swap, tool scope change, memory backend swap) produces no visible difference in the boot card on a healthy restart. These fields were in the deleted SessionStart greeting card (#142 PR 1) and now live only in `/status` on demand. The UAT test (`jtbd-wake-audit-content-dm.test.ts`) explicitly relaxes the "no need to ask" contract.

**Decision required:**
- (A) Add config-change visibility to the boot card: surface model/tools/memory backend in the boot card when they differ from the previous boot. Implement and update the JTBD.
- (B) Accept the gap: update the JTBD to reflect the split design (boot card = liveness + probe health; `/status` = config audit). Clarify the JTBD outcome to match shipped behavior.
- (C) Implement a change-detection boot card row: detect changes on reconcile, emit a one-line "config changed" summary row. Update the JTBD after implementing.

## Recommendation — Escalation 3

**Recommended option:** C
**Confidence:** high

### Why

The JTBD's "no need to ask" promise is stated without qualification: "After any restart, the user is told what config is live. Model, tools, skills, memory backend, auth state. No need to ask." The anti-patterns explicitly name "Cosmetic summaries that always look the same regardless of the actual config" and "Lying by omission. If tools were silently disabled, the summary should say so." Option B would require rewriting both anti-patterns out of the contract — a deliberate retreat from a core promise, not a refinement.

Option A conflicts with the boot card's own design contract. The boot card file opens: "Default state is a single line: `✅ <agent> back up · <version>`" and the deletion comment is explicit — Profile/Tools/Skills/Limits/Channel/Memory content was removed from the old SessionStart greeting because it was "always-rendered" noise that "becomes wallpaper the user learns to scroll past." The JTBD itself warns against "a boot banner that dumps every setting." Putting that content back unconditionally restores exactly the problem PR #142 solved.

Option C threads the needle. The boot-issue-cache already demonstrates the pattern: persist a fingerprint of the last boot's probe state, diff against the current boot, surface a row only when changed. A config-snapshot cache wired into the same gate would surface "model changed: claude-opus-4 → claude-sonnet-4-5" as a single appended row only when it's true — invisible on identical restarts, unmissable on actual changes. Preserves silent-when-healthy for stable fleets; delivers "change is obvious" (c8) when something shifted. Non-technical users see changes in the one place they already look. The UAT test's docstring explicitly acknowledges this floor-vs-vision split.

Implementation boundary is tight. Config snapshot stores three fields (model slug, tools fingerprint, memory backend) at shutdown or gateway start, diffed on next boot. The boot card renderer already accepts a `resolvedRows` / degraded-rows model; config-diff is a new row type, not a new rendering mode.

### Tradeoffs of the recommendation

- Requires a config snapshot file written on each gateway boot. New disk dependency, small and consistent with `boot-issue-cache.json`.
- Fingerprint stability requires care: model string format changes across releases could produce spurious "model changed" rows. Needs a normalizer (strip trailing version suffix, lowercase) like `normalizeDetail()`.
- Tools fingerprint is harder than model. Full allowlist diff is genuinely useful; a hash that just says "tools changed" is noise. First version can hash the sorted allowlist and show "tools allowlist changed — run /status to see details" — honest without exhaustive.
- The UAT scenario needs a strict variant: restart after config change, assert boot card contains the changed-field row. Current test relaxes to "agent replies with config signals when asked" — correct but not the proactive contract.
- Memory backend change detection depends on which layer the gateway reads. If resolved at yaml load, straightforward. If resolved late, snapshot needs the resolved value.
- No risk to "silent when healthy": row only appears when diff fires.

### If you pick a different option

- **Option A:** Restores deleted-in-#142 content unconditionally on every boot. The v0.4.0 changelog is explicit: the six-row checklist was "noise on the common path." Non-technical users will learn to scroll past, defeating c8's "obvious, not buried" requirement. Fails the "Defaults test" principle.
- **Option B:** Requires rewriting the JTBD to remove or qualify "no need to ask," demoting the "config change restart" UAT prompt, and adding a "split design" note. Honest if the split is permanent — but the UAT test's own docstring says the proactive contract is the "vision target" with the relaxed test as "the floor." B forecloses future proactive delivery. Acceptable only if `/status` is the confirmed permanent home for config audit.

### Open question for the operator

Is "tools allowlist changed — run /status to see details" sufficient for a first cut of Option C, or does the operator want a granular diff row (e.g. "tools: added bash, removed computer") from day one? The granular form is more useful but requires serializing the allowlist at snapshot time, not just a hash.

---

## Escalation 4

**ID:** jtbd-track-plan-quota-live:c2
**Type:** outcome-not-realized
**File:** `reference/track-plan-quota-live.md`
**Evidence files:** `telegram-plugin/auth-dashboard.ts` L91-97, `telegram-plugin/auth-snapshot-format.ts` L60-70, `telegram-plugin/gateway/gateway.ts` L15980-15997

**Claim:** "Approaching a cap produces a visible signal at a point where the user can still act on it."

**Gap found:**
The `/auth` dashboard shows a `[Fall back now]` button at 90% utilization and marks accounts as "near limit — watch this." However, this is reactive and requires the user to open `/auth`. There is no proactive Telegram push notification that fires as utilization climbs toward a cap. Auto-fallback triggers at 99.5%, which is after the limit has effectively been hit.

**Decision required:**
- (A) Add a proactive push: wire a utilization-threshold watcher that sends a Telegram notification when utilization crosses (e.g.) 80%. Implement and update the JTBD.
- (B) Accept the reactive design: update the JTBD to describe the current design accurately (user polls `/auth` for approaching-cap signal; auto-fallback is reactive at 99.5%).
- (C) Hybrid: document the existing `/auth` signal as the current answer and note the proactive push as a planned enhancement.

## Recommendation — Escalation 4

**Recommended option:** A
**Confidence:** medium

### Why

The JTBD's "Signs it's working" includes "Approaching a cap produces a visible signal at a point where the user can still act on it," and anti-patterns explicitly name "Quota visible only in a separate dashboard or a command. If the user has to go looking, they won't, and they'll hit the wall." The current reactive design is a well-executed dashboard affordance but lives entirely inside `/auth`. A user not in the habit of checking `/auth` receives zero proactive signal until auto-fallback fires at 99.5% — effectively after the wall. Option B would mean rewriting the document's intent to match an acknowledged gap.

The pattern for a proactive push already exists and is proven. `credits-watch.ts` (wired in gateway.ts L15975-15997) polls every 15 minutes, reads a local file, compares against persisted last-notified state, and calls `bot.api.sendMessage` on state transition. The same three-state machine (healthy → throttling → blocked) that `classifyHealth` already computes is exactly the input a quota-watch module needs. Extending requires: adding a broker probe call on a polling interval, tracking last-notified health per account. Broker infra (`client.probeQuota`), state-machine (`classifyHealth`), and notification routing all exist. Extension, not new invention.

Noise risk on a multi-agent fleet is real but manageable. Three mitigations: (1) notify on transitions, not absolute level — only fire when health *changes* from healthy to throttling; (2) operators typically have 1-3 account slots, not 10+; (3) 15- or 30-min poll = at most one message per crossing per account. The "over-alerting" anti-pattern targets every-tick notifications, not edge-triggered.

Practical sizing note: the right source is the broker's cached quota state from `list-state` (already computed for `/auth` render), not a fresh network probe per poll. Reading cached state keeps polling cheap and avoids burning API budget. Only trigger a live `probeQuota` when a state change is detected and fresh numbers are needed for the notification body.

### Tradeoffs of the recommendation

- The watcher adds a polling loop alongside credits-watch; both should share notification routing and state persistence patterns.
- Broker-cache polling means notifications lag by however stale broker storage is. Staleness was already accepted for `/auth` render; acceptable here too.
- Two accounts crossing 80% simultaneously yields two notifications within one poll cycle. Correct behavior — each account needs its own action.
- Broker cached state only updates when an agent makes a request. Idle fleet may not trigger state-change push even at high utilization — pre-existing limitation of header-pull, not introduced.
- Implementation cost ~25 agent minutes: new `quota-watch.ts` mirroring `credits-watch.ts`, wired into gateway boot, using `classifyHealth` and broker `list-state`.

### If you pick a different option

- **Option B:** Rewriting JTBD to accept reactive-only closes the audit finding without shipping value. Stakes section ("A user who hits a wall silently loses trust") becomes a known unfulfilled risk. Only appropriate if the operator decided dashboard affordance is sufficient.
- **Option C:** Hybrid documents current state and notes proactive push as planned — reasonable if implementation capacity is constrained. Resolves the audit finding by making the gap intentional and tracked, without shipping incomplete code. Risk: "planned" items without a PR tend to stay planned. Use only with a concrete follow-up issue created at the same time.

### Open question for the operator

Should the proactive push be scoped to the *active* account only, or all accounts in the pool? Auto-fallback cares about the whole pool; the user typically acts by switching to an account with headroom — so a notification about a non-active account approaching its limit is also actionable. The credits-watch precedent fires per-agent; the new watcher would have access to all accounts and could choose either scope.

---

## Escalation 5

**ID:** jtbd-track-plan-quota-live:c7
**Type:** outcome-not-realized
**File:** `reference/track-plan-quota-live.md`
**Evidence files:** `telegram-plugin/credits-watch.ts` L116-123, `telegram-plugin/gateway/gateway.ts` L15986-15997, `src/auth/broker/server.ts` L103-105

**Claim:** "When the window rolls, the user sees the recovery without having to refresh anything."

**Gap found:**
`credits-watch.ts` sends "credits restored" when the fatal-billing state clears (billing-credit-exhaustion case). However, for the normal rolling 5h/7d subscription window reset, there is no proactive Telegram notification that "your 5-hour quota has reset." The user would need to run `/usage` or wait for a boot card. The auth-broker's `exhausted_until` auto-expires, but there is no push-to-Telegram signal when the window rolls naturally.

**Decision required:**
- (A) Add a rolling-window reset notification: when the broker clears an exhausted-until expiry for the rolling window, send a Telegram push to the relevant agents. Implement and update the JTBD.
- (B) Accept the current design: update the JTBD to note that fatal-billing recovery is pushed, but rolling-window reset recovery requires the user to check `/usage` or wait for the next boot card.
- (C) Scope to fatal-billing only: explicitly narrow the JTBD claim to cover only credits-watch notifications, not rolling-window reset.

## Recommendation — Escalation 5

**Recommended option:** C (scope to fatal-billing only), with a JTBD wording tightening
**Confidence:** high

### Why

The gap is real but the original framing overstates what "window rolls" means in practice. In normal operation — an agent that was never blocked — the 5-hour or 7-day window rolling over is a non-event: headroom increases passively and the boot card or `/usage` on next interaction shows updated numbers. There is no "recovery" to surface because the user was never stuck. A proactive notification here is noise, violating the anti-pattern "every small usage tick produces a notification until the user mutes the product."

The case that matters: agent was blocked, original active account's window resets. That IS a recovery the user cares about. However, `credits-watch.ts` already covers the closest analogue (fatal-billing flag clears). The `exhausted_until` operates differently — passive timestamp comparison, not an event. There is no callback when it expires; the broker simply starts treating the account as healthy again on next `get-credentials`. Adding a proactive push would require a polling loop watching `exhausted_until` transitions, plus event routing — non-trivial plumbing with race conditions.

Option B (accept with JTBD note) leaves the misleading "without having to refresh anything" wording intact, which will fail future audits. Option A is over-engineering: the typical fleet recovers naturally (agent retries, gets healthy creds, resumes) or the user already ran `/auth`. The boot card on next agent start carries fresh usage data. Option C is cleanest: narrow the claim to reflect what's implemented (fatal-billing push), reword rolling-window bullet to match real user flow (ambient recovery on next boot card / `/usage`, not push).

Surgical JTBD edit: replace "When the window rolls, the user sees the recovery without having to refresh anything" with "When a fatal billing block clears, the user hears about it without having to ask. For routine quota refills, usage resets are visible on the next boot card or `/usage`." Honest about the two tiers; eliminates the false gap without noisy infrastructure.

### Tradeoffs of the recommendation

- Purely documentary: no code touched, no CI risk, no new plumbing.
- The "was blocked, now unblocked due to window rollover" case remains non-pushed. In practice, when `exhausted_until` expires, auto-fallback (if triggered) had already swapped to a healthy account. Primary coming back healthy after 5h is quietly picked up on next `get-credentials`; next boot card confirms it.
- The UAT prompt ("Let the window roll. The user should see usage free up without having to refresh") needs corresponding update, or UAT keeps flagging this. Scope into the same JTBD edit.
- Accepts that `credits-watch.ts` recovery is the high-fidelity push signal, and rolling-window reset is ambient-tier. If the operator's mental model requires a push on every window reset, Option A is right — but it should have a deduplication gate (only push when previously exhausted).

### If you pick a different option

- **Option A:** Requires a poller watching `exhausted_until` timestamps, emitting IPC events on transition. Gateway routes to Telegram. Non-trivial: multi-account handling, agent-name→chat mapping, race-handling. ~30 agent-minutes + tests. Risk of spam on agents that were never blocked — gate on `prev.exhausted` state matching credits-watch pattern.
- **Option B:** Adds a parenthetical note ("fatal-billing pushed; rolling-window appears on next boot card"). Lower-effort than A, but UAT prompt still says "without having to refresh anything," literally false for rolling-window. Expect recurrence in future audit.

### Open question for the operator

The JTBD's UAT prompt ("Let the window roll. The user should see usage free up without having to refresh") will fail any honest UAT run. Should this prompt be revised to "Check `/usage` after the window rolls — usage should reflect the reset" (ambient tier), or removed in favor of a UAT focused on fatal-billing recovery push?

---

## Escalation 6

**ID:** rfc-sub-agent-visibility:c11
**Type:** low-confidence drift (AC-4 stuck-render pipeline untraced)
**File:** `reference/sub-agent-visibility-rfc.md`
**Evidence files:** `telegram-plugin/fleet-state.ts` L133-137, `telegram-plugin/progress-card-driver.ts`

**Claim (AC-4):** "If a fleet member emits no JSONL event for > 60s, its row glyph flips from ↻ to ⚠ with label `idle <duration>`."

**Gap found (low confidence):**
`fleet-state.ts:markStuck` exists and transitions a member to `stuck` status after 60s. However, `fleet-state.ts` is not imported by `progress-card-driver.ts` or the renderer. The stuck-detection to rendered-⚠ pipeline could not be traced end-to-end through code. `subagent-watcher.ts` has stall detection (`stallNotified`) but calls `onStallTerminal`, not a stuck-render path. AC-4 may be partially implemented at the state level but not yet connected to the renderer's header phase.

**Decision required:**
- (A) Confirm the wire exists: identify the production call path from `markStuck` to the rendered `⚠` glyph and document it in the RFC.
- (B) Confirm AC-4 is not yet wired: update the RFC to note this AC is partially implemented (state exists, render not wired) and track as a follow-up.

## Recommendation — Escalation 6

**Recommended option:** B
**Confidence:** high

### Why

The end-to-end trace is conclusive: `markStuck` in `fleet-state.ts` is dead production code. It is exported and tested in `tests/fleet-state.test.ts`, but no production file imports it or calls it. The only production import of `fleet-state.ts` is in `subagent-watcher.ts:44`, and it imports only `sanitiseToolArg` — not `markStuck`, `FleetStatus`, or any state-transition functions. `progress-card-driver.ts` does not import `fleet-state.ts` at all.

AC-4 describes a per-fleet-member ↻→⚠ glyph flip with `idle <duration>` label. That requires `FleetMember.status` to reach `'stuck'` and a renderer to branch on that status. Neither happens. `FleetStatus` includes `'stuck'`, `markStuck` correctly transitions a member to it, but the renderer that produces the sub-agent zone (`renderSubAgent` in `progress-card.ts`) operates on `SubAgentState`, not `FleetMember`. `SubAgentState.state` is typed as `ItemState` (`'pending' | 'running' | 'done' | 'failed'`) — no `'stuck'` branch, no ⚠ glyph, no `idle <duration>` label.

What IS wired is a different, coarser stall signal: the driver's heartbeat passes `stuckMs` (age of `cs.lastEventAt`) to card-level `render()` in `progress-card.ts`. When `stuckMs >= STUCK_THRESHOLD_MS` (2 min), the renderer inserts `⚠️ No events for <gap> — likely stuck.` as a header-level line. Card-wide warning, not per-fleet-member row glyph flipping. The `onStall` callback from `subagent-watcher.ts` routes to `progressDriver?.onSubAgentStall(...)` in `gateway.ts`, but `progressDriver` is permanently `null` (deleted in PR #1122 — see `gateway.ts:3046`), so those calls are no-ops.

The RFC itself notes that `two-zone-card.ts` was the renderer for the AC-4 fleet zone, but that file no longer exists. The current renderer is `progress-card.ts` which has no per-member stuck-glyph path.

AC-4 as specified has no production implementation. State model exists, render pipeline does not. Option B is correct.

### Tradeoffs of the recommendation

- Updating the RFC to mark AC-4 partially implemented (state exists, render absent) is honest and prevents future confusion.
- The coarser card-level `stuckMs` warning provides *some* stuck signal (at 2 min, card-wide), so the user-facing gap is narrower than it appears — but not AC-4 as written.
- `markStuck` should either be connected or removed; leaving as tested-but-unreachable dead code is a maintenance liability (tests give false confidence).
- The `onStall` → `progressDriver?.onSubAgentStall(...)` call is also dead. If the progress driver is ever reinstated, gateway wire exists but the renderer-side branch would still need adding.

### If you pick a different option

- **Option A (confirm wire exists):** Not viable. The trace is exhaustive. `markStuck` is unreachable, `progressDriver` is null, `renderSubAgent` has no stuck branch. There is no wire to document.

### Open question for the operator

Should `markStuck` be removed from `fleet-state.ts` (and its tests) as dead code, or is the intent to connect it in a follow-up? Determines whether the RFC follow-up is "add the render branch" (connect it) or "remove the dead state function" (clean up).

---

## Escalation 7

**ID:** rfc-sub-agent-visibility:c12
**Type:** outcome gap (fleet cap unimplemented)
**File:** `reference/sub-agent-visibility-rfc.md`
**Evidence files:** `telegram-plugin/fleet-state.ts` L157-163, `telegram-plugin/progress-card.ts` L929-943

**Claim (AC-5):** "6+ parallel sub-agents — render output is balanced HTML, < 4096 bytes, fleet zone caps at 5 rows + '+ N more'."

**Gap found:**
The fleet renderer (`progress-card.ts` L929-943) iterates ALL sub-agents with no row cap. The `cap()` function (`fleet-state.ts` L157-163) caps at 5 + hidden count but is not imported or called by the renderer. The "N more" footer does not exist in the renderer output. For a fleet of 6+ sub-agents, the card will render all rows with no cap, potentially exceeding the 4096-byte Telegram message limit.

**Decision required:**
- (A) Implement the cap: import `cap()` from `fleet-state.ts` in the renderer and apply it with a "+ N more" footer row. Update the RFC after implementing.
- (B) Remove the cap spec: if the renderer is intentionally uncapped (all rows visible), update AC-5 to remove the cap requirement and note that HTML safety is ensured by truncation elsewhere.

## Recommendation — Escalation 7

**Recommended option:** B
**Confidence:** high

### Why

The fleet renderer at `progress-card.ts` L929-943 is not currently reachable in production. The pinned progress-card driver (`progress-card-driver.ts`) was removed from the gateway in PR #1122 PR3 — `progressDriver` is permanently `null` in `telegram-plugin/gateway/gateway.ts` (L3046), making every `progressDriver?.X` call a no-op at runtime. The `progress-card.ts` module is still imported by `progress-card-driver.ts`, but that driver is never loaded by the gateway. The fleet-zone renderer loop is dead code.

More importantly, the RFC itself already declares the card model superseded. The preamble (L25-33): "Card model superseded. This RFC reasons about the two-zone progress-card model. That two-zone design has since been superseded by `reference/conversational-pacing.md`, and `reference/status-card-design.md` is archived." AC-5's cap requirement was written for a design that no longer drives the live product. The current Telegram-facing surface is conversational pacing, not the two-zone pinned card.

There is no meaningful 4096-byte risk to defend against today. `stream-reply-handler.ts` (L395-400) enforces a hard 4096-char pre-check on `stream_reply` calls, and `answer-stream.ts` (L49) tracks the same constant — but those guard the conversational-pacing path, which does not use the uncapped fleet renderer. The `cap()` function exists, is correct, and exported, but the one callsite that would matter is unreachable.

Wiring Option A — importing `cap()` into a renderer that isn't live — would cost little but achieve nothing and leave reviewers confused. Correct fix: update AC-5 in the RFC to reflect reality. Remove the cap requirement, note the two-zone card was retired in PR #1122, point to `conversational-pacing.md` as the live contract. If the project revives a pinned fleet card under conversational-pacing later, the cap requirement should be written fresh.

### Tradeoffs of the recommendation

- Removing AC-5 from a closed RFC is low-risk: status is already "SHIPPED / CLOSED" and the doc flags the card model as superseded.
- The `cap()` function remains in place and can be picked up cheaply if a future fleet renderer is ever written — no deletion needed.
- No user-visible regression from Option B: the uncapped renderer cannot produce a 4096-byte overrun because it isn't called.
- Leaving the spec as-is keeps misleading future auditors (and this audit system) about an unfulfilled gap in active code.

### If you pick a different option

- **Option A:** Import `cap()` into `progress-card.ts` fleet section and add a `+ N more` footer. Correct if you plan to re-activate the progress-card driver. Doing it without re-activating still leaves the loop unreachable and creates well-maintained dead code. If you go this route, also re-wire `progress-card-driver.ts` into the gateway and write the UAT scenario (`bg-heavy-fleet-dm.test.ts`) the RFC called for in Phase 3.

### Open question for the operator

Is there an active plan to revive the pinned progress-card (two-zone or otherwise) under the conversational-pacing architecture? If yes, Option A makes sense as prep work paired with re-activating the driver. If no, close AC-5 with a note and let `cap()` sit ready for future use.

---

## Escalation 8

**ID:** jtbd-run-a-fleet-of-specialists:c9
**Type:** outcome gap (Hindsight memory not purged on destroy)
**File:** `reference/run-a-fleet-of-specialists.md`
**Evidence files:** `src/cli/agent.ts` L1931-1979

**Claim:** "Removing an agent is clean. Its memory, its state, its scheduled work all go with it, with no orphaned processes or dangling config."

**Gap found:**
`switchroom agent destroy` removes the agent directory and stops the container. The config entry removal (which kills the compose service on next apply) cleans up the scheduled work. However, the Hindsight memory bank (stored in the hindsight container's database) is NOT deleted by `agent destroy` — no code in `src/cli/agent.ts` or `src/agents/scaffold.ts` calls hindsight to drop the bank. Memory data orphans in the hindsight service.

**Decision required:**
- (A) Wire memory purge: add a `hindsight delete-bank --collection <agentName>` call (or equivalent) to the `agent destroy` flow. Update the JTBD after implementing.
- (B) Accept the gap: update the JTBD to note that Hindsight memory must be purged manually after `agent destroy` (e.g., `hindsight delete-bank --collection <name>`). Document the purge command.
- (C) Soft delete: mark the collection as archived rather than purging, with a separate cleanup command for operators who want to reclaim storage.

## Recommendation — Escalation 8

**Recommended option:** B
**Confidence:** high

### Why

The core question is whether an orphaned Hindsight bank is a leak or a recovery feature. The answer is: it is a recovery feature in disguise, and that changes the calculus.

The `bankId` for any agent is derived as `agentMemory?.collection ?? agentName` (see `src/agents/scaffold.ts:1613` and `src/memory/hindsight.ts:76`). When no explicit `memory.collection` override is set — the default for every agent — the bank ID is the agent name. `createBank` in scaffold.ts (line 2896) is explicitly documented as idempotent: "calling this on an already-existing bank is a no-op and returns success" (`src/memory/hindsight.ts:392-394`). This means if an agent named `clerk` is destroyed and re-created with the same name, its first scaffold run calls `createBank("clerk")`, Hindsight recognizes the existing bank, and the agent silently resumes with its full memory history. The orphaned bank was a restoration point, not waste.

This re-attach is architecturally desirable. Accidental destroys, name collisions after reconfiguration, fleet rebuilds — all benefit from memory persistence in the backing store. The JTBD claim "no orphaned processes or dangling config" is about processes and config, not persistent data. The wording does not promise data erasure, only operational cleanliness. Interpreting it to mandate automatic bank deletion would be wrong — the analogous expectation would be that destroying a database-backed service should DROP the schema, which is almost never correct.

Practical blocker for Option A: neither the vendored `HindsightClient` (`vendor/hindsight-memory/scripts/lib/client.py`) nor switchroom Hindsight bindings (`src/memory/hindsight.ts`) expose a `delete_bank` call. No `DELETE /banks/{id}` call exists anywhere in the repo. Whether Hindsight's upstream REST API even exposes bank deletion is unconfirmed. Wiring Option A would require: confirming the upstream API supports deletion, adding `deleteBank` to bindings, calling it in destroy flow, handling the case where Hindsight is unreachable at destroy time. The failure mode where destroy aborts because Hindsight is offline is strictly worse UX than current silent orphan.

### Tradeoffs of the recommendation

- Operators who destroy an agent permanently and never re-create it accumulate storage in the Hindsight database with no self-service cleanup path. On a fleet that cycles agents regularly, this compounds.
- The current `mcp__hindsight__delete_memory` tool (available to agents in-session) only deletes individual memories, not the whole bank. Operators have no single-command purge path today.
- Updating the JTBD claim to be accurate about Hindsight persistence is low-risk, takes 1-2 lines.
- Option B does not preclude adding a `switchroom agent destroy --purge-memory` flag in a later PR once the upstream delete API is confirmed.

### If you pick a different option

- **Option A:** Wire memory purge in destroy flow. Before implementing, confirm that `DELETE /v1/default/banks/{bank_id}` exists in the Hindsight REST API — absent from the vendored client. If it exists, add `deleteBank()`, call it after `rmSync`, handle offline gracefully (warn, don't block destroy). If `bankId` was overridden via `memory.collection`, destroying the wrong name is possible — read config before removing agent directory. Risk: breaks re-attach recovery; accidental destroy loses memory permanently.
- **Option C:** Soft-delete/archive. Requires Hindsight archival state (unconfirmed), adds a separate cleanup command, two-phase delete UX operators will find confusing. Adds complexity with limited benefit over Option B + future `--purge-memory` flag.

### Open question for the operator

Does Hindsight's REST API expose a bank deletion endpoint (`DELETE /v1/default/banks/{id}`)? This single fact determines whether Option A is even wirable, and should be confirmed before any implementation work.

---

## Escalation 9

**ID:** jtbd-feel-like-a-colleague:c9
**Type:** vision-only, low confidence (AI non-detectability)
**File:** `reference/feel-like-a-colleague.md`
**Evidence files:** `profiles/default/workspace/SOUL.md.hbs` L41-51

**Claim:** "A non-technical user can't immediately tell they're talking to an AI from the first ten messages. They can tell it's not a person they've met before, but the shape of the conversation feels human."

**Assessment:**
This is not verifiable from the codebase. The prompt engineering and AI-tell bans aim at this outcome, but whether it is actually achieved requires user testing. This is a goal/outcome statement, not an implementable behavior. The JTBD should either flag it as a success criterion (not a current state claim) or acknowledge it's an aspirational target.

**Decision required:**
- (A) Mark as aspirational: add a hedge to the claim — "(target, not yet systematically verified via user testing)."
- (B) Remove the claim: it cannot be verified from code; leave only the prompt engineering claims that CAN be verified.
- (C) Accept as-is: treat it as a product vision statement, not a verifiable claim; no action needed.

## Recommendation — Escalation 9

**Recommended option:** C
**Confidence:** high

### Why

The JTBD format in this codebase is explicitly outcome-focused, not test-result-focused. The README for `reference/` describes JTBDs as answering "Did it do the user's job?" — a design target, not a passing test suite. Scanning "Signs it's working" across all JTBDs confirms: they are written in the present tense as outcome descriptions, not verified state. `run-a-fleet-of-specialists.md` says "The user never has to prefix a message with 'as my coding agent'"; `remember-across-sessions.md` says "A restart doesn't reset the relationship." Neither is instrumented. The entire format is aspirational-but-precise: tells builders what success looks like.

The c9 claim sits inside that consistent pattern. The section header "Signs it's working" already signals that role. Adding a hedge would be inconsistent with how every other JTBD is written, and would implicitly suggest other "Signs" entries are verified — they are not.

The claim is also load-bearing in the right way. `vision.md` calls out the non-technical principal explicitly: "The bar: one even a non-technical partner likes." The c9 claim is precisely what that bar means in behavioral terms. Softening dilutes the sharpest user-facing success criterion. The claim is not a marketing assertion outside a design document; it's a design criterion inside one, and that context is the correct frame.

The SOUL.md AI-tell bans (L41-51) are verifiable engineering affordances implementing this criterion. The criterion itself remains correctly at the outcome layer. Removing (Option B) would leave the implementation affordances with no stated purpose. Hedging (Option A) would add noise that no other JTBD carries, signalling incorrectly that the JTBD format admits only verified claims.

### Tradeoffs of the recommendation

- The claim cannot be falsified from the codebase alone — a real epistemic gap, but the same gap exists for every "Signs it's working" bullet across all JTBDs. Treating c9 differently would require auditing all of them — a larger separate question about the JTBD format itself.
- Accepting as-is means the design contract contains an outcome only user research can validate. Appropriate for a design contract; inappropriate in a test report or release checklist.
- The UAT prompts section of the same JTBD (L119-144) already provides a partial proxy: the "AI-tell sweep" is code-reviewable and behavioral prompts are manually testable. Outcome is closer to measurable than it appears; just needs a human in the loop.

### If you pick a different option

- **Option A:** Adding "(target, not yet systematically verified via user testing)" reads as an admission that other "Signs it's working" bullets are verified, which they are not. Creates inconsistency across JTBDs and invites a wave of similar hedges. The actual fix, if hedging is wanted, is a format-level note in `reference/README.md` — a much broader change.
- **Option B:** Removing leaves the JTBD without a human-perceivable success criterion at the outcome level. The remaining signs are intermediate indicators; c9 is the only one naming the actual user experience targeted. Removal makes the JTBD harder to use as a design gate.

### Open question for the operator

If you want to distinguish measurable "Signs" from aspirational ones across all JTBDs consistently, the right lever is a format note in `reference/README.md`, not individual hedges. Is that a change worth making as a separate pass?

---

## Escalation 10

**ID:** jtbd-give-each-agent-its-own-workspace:c7, c8, c11 (vision-only cluster)
**Type:** vision-only (fast-forward, dirty-tree, sub-agent nesting not end-to-end)
**File:** `reference/give-each-agent-its-own-workspace.md`
**Evidence files:** `src/repos/agent-worktree.ts` L209-238, L196-208

**Claims (vision-only):**
- c7: "Fast-forwarded to `upstream/main` on session start when the worktree is clean."
- c8: "Dirty-tree policy: leave alone, warn. If the worktree has uncommitted changes at session start, the ff-to-main step is skipped. The session resumes on whatever branch the worktree was on. The boot card surfaces `<repo>: dirty since <ts>` as a one-line warning."
- c11 (from workspace JTBD): Sub-agent nesting in worktrees end-to-end.

**Assessment:**
The infrastructure exists in `agent-worktree.ts` (fast-forward logic, dirty-tree detection) but is not callable from any production path (see Escalation 2). Until Escalation 2 is resolved, these vision-only claims cannot be tested. They should be deferred until the provisioning wiring ships.

**Decision required:**
These are tied to Escalation 2. Resolve Escalation 2 first; these vision-only claims will either become verifiable or get updated to reflect the reality after the wiring decision.

## Recommendation — Escalation 10

**Recommended option:** Defer-to-Escalation-2 — mirror its resolution exactly, with one always-on action: mark the boot-card "dirty since <ts>" sub-claim of c8 as separately unimplemented regardless of Escalation 2's outcome.
**Confidence:** high

### Why

**On c7 (fast-forward on clean session start):** ff logic is fully implemented in `src/repos/agent-worktree.ts` L210-238. On clean worktree, `ensureAgentWorktree` runs `git fetch origin` then `git merge --ff-only origin/<defaultBranch>` and logs to stderr. Implementation is correct and complete. But `ensureAgentWorktree` is imported but never called from `scaffold.ts` or any production reconcile path. The ff-to-main never executes on session start. Implemented but unwired. If Escalation 2 = A, c7 becomes testable post-wiring. If Esc2 = B, c7 must also be removed. If Esc2 = C, c7 should receive the same "not wired" disclaimer.

**On c8 (dirty-tree policy):** "Leave alone" half is fully implemented at L196-208: `isWorktreeDirty` detects via `git status --porcelain`, and on dirty detection `ensureAgentWorktree` returns `{ dirty: true, dirtyCommit: sha }` without touching the worktree. The "boot card surfaces `<repo>: dirty since <ts>` as a one-line warning" sub-claim is **not** implemented. Review of `telegram-plugin/gateway/boot-card.ts` shows `RenderBootCardOpts` has no `worktrees` or `dirtyWorktrees` field, `renderBootCard` renders no such row, `runAllProbes` has no worktree probe, and `ProbeKey` has no `repos` or `worktrees` entry. The `WorktreeState.dirtyCommit` field exists but is never consumed by any caller outside agent-worktree.ts itself. Boot-card surface is entirely absent. The "leave alone" half follows Esc2's resolution; the "boot card surfaces" half needs its own disclaimer or implementation work regardless.

**On c11 (sub-agent nesting in worktrees end-to-end):** JTBD text at L40-43 and L111-114 states sub-agents dispatched from inside an agent's worktree create their own nested worktree off the parent's HEAD, "exactly as today." Code search finds no implementation — no `ensureSubAgentWorktree`, no "parent HEAD" resolution, no sub-agent worktree dispatch path. Vision-only independently of Esc2: even if Esc2 = A wires main-agent provisioning, sub-agent nesting requires additional implementation. Under Esc2 = A, c11 should be flagged as "next step after c2/c3 provisioning ships." Under Esc2 = B or C, c11 should also be removed or disclaimed.

The independent always-on action: the boot-card "dirty since <ts>" sub-claim of c8 should be disclaimed regardless of Esc2.

### Tradeoffs of the recommendation

- Deferring to Escalation 2 keeps c7 and "leave alone" of c8 in sync with the provisioning decision, avoiding divergent audit trail.
- Calling out boot-card "dirty since <ts>" independently is correct — it is a separate implementation surface (probe + renderer) even if provisioning ships.
- Flagging c11 as separately unimplemented is independently justified: sub-agent nesting is further out than main-agent provisioning regardless of Esc2.
- Produces three distinct outcomes for three claims rather than uniform treatment — adds audit complexity but accurately reflects three genuinely different implementation states.

### If you pick a different option

- **Treat all three as one cluster and follow Esc2 uniformly:** Simpler audit trail, but leaves boot-card gap and sub-agent nesting gap undisclaimed if Esc2 = A. Operator reading the JTBD after wiring would see c8's boot-card claim and c11's nesting claim as verified when neither was tested.
- **Mark all three vision-only independently of Esc2:** Defensively correct today. Risk: if Esc2 = A ships quickly, creates churn re-verifying and re-clearing c7 and "leave alone" of c8 separately from the provisioning PR.

### Open question for the operator

The "dirty since <ts>" timestamp in c8's boot-card warning requires knowing when the worktree first became dirty (not just that it is dirty now) — `WorktreeState.dirtyCommit` captures HEAD SHA but not a wall-clock timestamp. Should this sub-claim be revised in the JTBD to "dirty at <sha>" (which current implementation could surface) instead of "dirty since <ts>" (which would require new dirty-timestamp tracking)?
