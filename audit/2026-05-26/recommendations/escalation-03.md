# Recommendation: Escalation 3 — restart-and-know-what-im-running:c3,c8 (boot card lacks config-change visibility)

**Recommended option:** C

**Confidence:** high

## Why

The JTBD's "no need to ask" core promise is stated without qualification in `reference/restart-and-know-what-im-running.md`: "After any restart, the user is told what config is live. Model, tools, skills, memory backend, auth state. No need to ask." The anti-patterns list explicitly names "Cosmetic summaries that always look the same regardless of the actual config. The user learns to distrust it." and "Lying by omission. If tools were silently disabled, the summary should say so, not quietly drop them." Option B (accepting the gap and narrowing the JTBD) would require rewriting both of those anti-patterns out of the contract. That is a deliberate retreat from the product's core promise, not a design refinement.

Option A (full model/tools/memory fields on every boot card) conflicts with the boot card's own explicit design contract. The boot card file opens: "Default state is a single line: `✅ <agent> back up · <version>`" and the deletion comment is explicit — Profile/Tools/Skills/Limits/Channel/Memory content was removed from the old SessionStart greeting because it was "always-rendered" noise that "becomes wallpaper the user learns to scroll past." The JTBD itself warns against "a boot banner that dumps every setting." Putting that content back unconditionally on every restart restores the exact problem PR #142 solved. The design split — quiet boot card for liveness, `/status` for config audit — was intentional and has held across many subsequent changes.

Option C threads the needle. The boot-issue-cache already demonstrates the underlying pattern: persist a fingerprint of the last boot's probe state, diff against the current boot, surface a row only when something changed. A config-snapshot cache (model, tools, memory backend) wired into the same gate would surface "model changed: claude-opus-4 → claude-sonnet-4-5" as a single appended row on the boot card only when it's true — invisible on identical restarts, unmissable on actual changes. This preserves the silent-when-healthy contract for stable fleets and delivers the "change is obvious" promise (c8) when something actually shifted. Non-technical users who never run `/status` would see changes appear in the one place they already look: the quiet ack line that turns into a short card when something needs attention. The UAT test (`jtbd-wake-audit-content-dm.test.ts`) explicitly acknowledges this floor-vs-vision split in its own docstring and calls the strict contract "the future UAT."

The implementation boundary for Option C is also tighter than Option A. The config snapshot stores three fields (model slug, tools fingerprint, memory backend) at shutdown or gateway start, diffed on next boot. The boot card renderer already accepts a `resolvedRows` / degraded-rows model; a config-diff row is a new row type, not a new rendering mode. The `updateOutcomeLine` pattern (PR C) shows that the card already accepts appended-section text from an external computation — config-diff could use the same slot. The risk of introducing config-field noise (e.g. model variants that look different but behave the same) is real but bounded: the fingerprint can fold across patch versions the same way `fingerprintProbe` folds across incidental detail variance.

## Tradeoffs of the recommendation

- Requires a config snapshot file written on each gateway boot (or read from scaffold artifacts). A new disk dependency, though small and consistent with `boot-issue-cache.json`.
- Fingerprint stability requires care: if the model string format changes across releases, a spurious "model changed" row appears. Needs a normalizer (strip trailing version suffix, lowercase) similar to `normalizeDetail()` in boot-issue-cache.
- Tools fingerprint is harder than model. A full allowlist diff ("added: bash, removed: computer") is genuinely useful; a hash that just says "tools changed" is noise. The first version can hash the sorted allowlist and show "tools allowlist changed — run /status to see details" which is honest without being exhaustive.
- The UAT scenario (`jtbd-wake-audit-content-dm.test.ts`) would need a strict variant: restart after a config change and assert the boot card edit contains the changed-field row. The current test relaxes to "agent replies with config signals when asked" — correct but not the proactive contract.
- Memory backend change detection depends on which layer of config the gateway reads. If the memory backend is resolved at `switchroom.yaml` load time, it's straightforward. If it's resolved late (at recall time), a snapshot needs the resolved value passed through.
- No risk to the "silent when healthy" property: the row only appears when the diff fires.

## If you pick a different option

- **Option A:** Restores the content deleted in PR #142 PR 1 unconditionally on every boot. The changelog entry for v0.4.0 is explicit: the six-row checklist was "noise on the common path." Non-technical users who restart frequently will learn to scroll past the card, defeating c8's "obvious, not buried" requirement. High regression risk against the principles test ("Defaults test": does it work on a fresh setup?). Not recommended.

- **Option B:** Requires rewriting `reference/restart-and-know-what-im-running.md` to remove or qualify "no need to ask," demote the "config change restart" UAT prompt, and add an explicit "split design" note. This is honest if the operator has decided the split is permanent — but the UAT test's own docstring says the proactive contract is "the vision target" and frames the relaxed test as "the floor." Choosing B now forecloses future proactive delivery. Acceptable only if there is a confirmed product decision that `/status` is the permanent home for config audit and the boot card will never surface config changes.

## Open question for the operator

Is "tools allowlist changed — run /status to see details" sufficient for a first cut of Option C, or does the operator want a granular diff row (e.g. "tools: added bash, removed computer") from day one? The granular form is more useful but requires serializing the allowlist at snapshot time, not just a hash.
