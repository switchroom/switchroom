# Recommendation: Escalation 9 — feel-like-a-colleague:c9 (AI non-detectability is unmeasurable)

**Recommended option:** C

**Confidence:** high

## Why

The JTBD format in this codebase is explicitly outcome-focused, not test-result-focused. The README for `reference/` describes JTBDs as answering the question "Did it do the user's job?" — which is a design target, not a passing test suite. Scanning the "Signs it's working" sections across all JTBDs confirms this: they are written in the present tense as outcome descriptions, not verified state. `run-a-fleet-of-specialists.md` says "The user never has to prefix a message with 'as my coding agent'"; `remember-across-sessions.md` says "A restart doesn't reset the relationship." Neither of those are instrumented claims. The entire format is aspirational-but-precise: it tells builders what success looks like so they can orient toward it, not report against it.

The claim at c9 sits inside that consistent pattern. It reads: "A non-technical user can't immediately tell they're talking to an AI from the first ten messages. They can tell it's not a person they've met before, but the shape of the conversation feels human." This is a design target, not a performance assertion. The section header "Signs it's working" already signals that role. Adding a hedge ("target, not yet systematically verified") would be inconsistent with how every other JTBD in the file is written, and would implicitly suggest other "Signs" entries are verified — they are not.

The claim is also load-bearing in the right way. `vision.md` calls out the non-technical principal explicitly: "The bar: one even a non-technical partner likes." The c9 claim is precisely what that bar means in behavioral terms. Softening it would dilute the sharpest user-facing success criterion in the JTBD, which is where the design teeth live. The claim is not a marketing assertion made outside a design document; it is a design criterion inside one, and that context is the correct frame.

Finally, the SOUL.md AI-tell bans (L41-51) are verifiable engineering affordances that implement this criterion. The criterion itself remains correctly at the outcome layer. Removing it (option B) would leave the implementation affordances with no stated purpose in the design contract. Hedging it (option A) would add noise that no other JTBD carries and would signal, incorrectly, that the JTBD format is meant to contain only verified claims.

## Tradeoffs of the recommendation

- The claim cannot be falsified from the codebase alone, which is a real epistemic gap — but it is the same gap that exists for every "Signs it's working" bullet across all JTBDs. Treating c9 differently would require auditing all of them, which is a larger and separate question about the JTBD format itself.
- Accepting as-is means the design contract contains an outcome that only user research can validate. This is appropriate for a design contract; it would be inappropriate in a test report or release checklist.
- The UAT prompts section of the same JTBD (L119-144) already provides a partial proxy: the "AI-tell sweep" prompt is code-reviewable and the behavioral prompts are manually testable. The outcome is closer to measurable than it first appears; it just requires a human in the loop, not an automated test.

## If you pick a different option

- **Option A:** Adding "(target, not yet systematically verified via user testing)" reads as an admission that other "Signs it's working" bullets are verified, which they are not. It would create inconsistency across JTBDs and invite a wave of similar hedges. The actual fix, if hedging is wanted, is a format-level note in `reference/README.md` stating that all "Signs" entries are design targets unless explicitly annotated otherwise — a much broader change.
- **Option B:** Removing the claim leaves the JTBD without a human-perceivable success criterion at the outcome level. The remaining signs (one clarifying question, length match, no AI-tells) are all intermediate indicators; c9 is the only one that names the actual user experience being targeted. Its removal would make the JTBD harder to use as a design gate.

## Open question for the operator

If you want to distinguish measurable "Signs" from aspirational ones across all JTBDs consistently, the right lever is a format note in `reference/README.md`, not individual hedges on individual bullets. Is that a change worth making as a separate pass?
