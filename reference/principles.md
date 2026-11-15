---
title: Switchroom product principles
last_reviewed: 2026-09-12
---

# Switchroom product principles

These are product engineering standards, applied in every PR and release. They are how we test whether a change serves the vision.

If you cannot answer yes to the checks at the bottom, the work is not done. Redesign. Do not ship and patch later.

Principles are the gradient half of "built well" (defaults, ceremony, evidence, surfaces). The other half is binary and lives in [invariants.md](invariants.md). A change can ace every principle check and still be out of scope because it crosses an invariant. Check both.

## 1. Lead with the benefit

Sensible defaults. Security through **enforced boundaries**, not warning-heavy configuration copy.

Nobody wants to learn Fleet. They want to run Hermes without one agent taking down another. The product should be usable without reading `docs/` first. Errors say what to do next. Only the reviewed default set ([rfcs/default-on-distribution.md](rfcs/default-on-distribution.md)) may be on by default; everything else stays off until the operator turns it on. A default degrades cleanly when its credential is missing and adds no paid path the principal did not grant.

### Check

- Does this work with a sensible default, or did we punt the decision into a warning?
- Is the security property enforced by isolation, mounts, and pins, or only described?
- Can an operator complete the happy path without opening a guide?

### Examples

- Good: one container, volume, and network per profile, Docker socket off, only reviewed defaults on, and a default with no credential turning itself off and saying so instead of blocking startup.
- Bad: a default that silently falls back to an API key, or an unreviewed plugin switched on by default.
- Bad: a long README of "make sure you don't share credentials" with a shared network still on.

## 2. Ceremony matches user-visible change

Not every patch is a launch. Routine fixes use lighter evidence. Releases that change the operator's experience use the full path. Lighter evidence does not mean optional invariants.

### Check

- Is this a routine fix or a change the operator will feel?
- Did we invent a launch process this change does not earn?
- Did we skip an invariant because the patch looked small?

### Examples

- Good: a docs-only commit does not republish the image; skipped publication is not a failure.
- Bad: every plugin typo requires a full production canary write-up.
- Bad: skipping isolation proof because "it's only a script."

## 3. Learning stays in working artefacts

No new ledgers, panels, confidence scores, or standalone formulation documents. Record assumptions and later findings inside the spec, RFC, or post-launch review.

### Check

- Did this add a parallel place to "track" product learning?
- If we learned something, is it written in the spec or RFC the next agent will actually read?
- Would a dashboard or score make the author feel done without proving the job?

### Examples

- Good: a failed UAT updates the Job Spec's silent-failure line and the RFC.
- Bad: a new "confidence" field, adoption board, or formulation doc that nobody gates on.

## 4. Evidence matches the claim

Unit tests, outcome UAT, and production-readiness are separate proofs. **Built, published, and deployed are different claims.** A fresh-process reviewer assesses the change. The author does not grade their own work.

### Check

- Which claim are we making: built, published, or deployed?
- Is the proof the same kind as the claim, or a cheaper substitute?
- Could a reviewer who did not write this still assess it from the artefact?

### Examples

- Good: "image published at digest X" backed by the workflow's remote-manifest check; "profile Y is running X" backed by a live read of that profile.
- Bad: unit-green reported as production-ready.
- Bad: the implementing agent rubber-stamping its own RFC.

## 5. Prove each supported surface

One successful surface does not prove the other. Persistence includes **working tools**, not just surviving volumes. Check execution paths and dependency ownership. Check what the private deployment already exercises before building another harness.

### Check

- Did we prove every surface this job claims (Telegram, Slack, and Desktop, cold and warm state)?
- After a restart or volume reuse, do the tools still run on the intended executable and interpreter?
- Did we look at existing private proof before adding a public harness?

### Examples

- Good: a tool that works via its pinned executable and fails via the wrong Python is a failed persistence proof.
- Bad: "Telegram worked, so Slack and Desktop are done."
- Bad: a new public acceptance harness that duplicates private rollout checks we never read.

## Applying the principles

Before you open a PR, ask:

1. **Benefit test:** does this work by default, with the security property enforced rather than warned about?
2. **Ceremony test:** is the evidence proportional to the user-visible change, without dropping invariants?
3. **Artefact test:** did learning land in the spec or RFC, not a new ledger?
4. **Claim test:** does the proof match built vs published vs deployed, and is the reviewer independent?
5. **Surface test:** did every claimed surface and working-tool path get proven?

If you cannot answer yes, you are not done.

These principles do not replace the Job Specs in `jobs/`. They judge them. A change can satisfy a job outcome and still fail the checks. When that happens, the job is the goal and the principles are how we get there without making Fleet feel like a kit.
