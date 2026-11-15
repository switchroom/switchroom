---
title: Switchroom product spec
last_reviewed: 2026-11-15
---

# Switchroom product spec

The product-level layer between the anchors ([vision](vision.md) / [principles](principles.md) / [invariants](invariants.md)) and the Job Specs. Job Specs `serves:` one of the outcome slugs named here.

Decisions: [rfcs/successor-vision.md](rfcs/successor-vision.md), [rfcs/switchroom-positioning.md](rfcs/switchroom-positioning.md).

## The product, in one line

Switchroom: an opinionated Hermes Agent distribution. Opinionated isolated Hermes. One agent per container and gateway. No shared credentials.

Public headline: "Hermes agents that work your projects, not just your chats." Sub-line: "One box per agent. Linear holds the thread. Tuned for the Claude plan you already pay for." Four proofs, in order: works your projects (Linear), safe to leave running (isolation, per-agent vaulted credentials, agent-to-agent only as an explicit opt-in), tuned for your Claude plan (Claude-first, not Claude-only), runs like infrastructure. Chat surfaces are standard Hermes, not a differentiator. A standing team of specialists is an outcome, not the headline. Decision: the 2026-11-15 amendment in [rfcs/switchroom-positioning.md](rfcs/switchroom-positioning.md).

What is real today: the digest-pinned child image is published, and this repository holds the source for the Linear, Claude ACP and connector plugins plus a vendored copy of the Nous Research DirectSDK plugin (not installed in the image). Every plugin is off in the bare image. The starter overlay configures the reviewed default set in [rfcs/default-on-distribution.md](rfcs/default-on-distribution.md). Six of the defaults that need no credential are `shipped`, proven in real containers ([starter-overlay-acceptance.md](../docs/starter-overlay-acceptance.md)); the rest are `planned`.

## North Star

**Metric:** trusted unsupervised turns (TUTR)

**Definition:** of unsupervised principal turns on Telegram, Slack, and Desktop in a scoring window chosen when the metric is instrumented, the share that were Trusted. A turn is Trusted when it was Unsupervised, completed without a human rescue, stayed inside the granted tools, and made no off-plan model call. The window is not a number invented here.

**Now → Target:** unmeasured → to validate once dogfood runs the public Fleet image and principals text the team on those three surfaces. No numeric target was ratified.

**Why this one:** it is principal-turn quality. Isolation, leash, presence, and subscription honesty all fail this number if they fail.

**Leash signal (not the headline):** intended-change hold rate. Of intended fleet changes, the share where the target has the intended state and every other in-scope agent is still independently working, including tools that still do their job.

## Outcomes

Every job ladders up to exactly one of these. A change that advances none of them is out of scope.

### standing-team – Standing team

Named specialists you text, each with its own identity, memory, tools, and credentials. Not one generalist with profile names.

Signal: share of in-scope specialists that a principal can address as themselves, with unshared memory and credentials. Shape: count of independently addressable specialists that still remember and authenticate as themselves. Now: unmeasured. Target: to validate. Guardrail: do not fake a team by routing everyone through one runtime.

### on-a-leash – On a leash

Isolation plus recoverable change plus no self-escalation. One agent cannot see another's files, network, credentials, or vault. A change to A leaves B alone. Failed upgrades recover without touching the others. Built, published, and deployed stay distinct claims.

Signal: intended-change hold rate (the leash signal above). Now: unmeasured. Target: to validate. Guardrail: do not "fix" bleed by collapsing agents onto a shared runtime, and do not treat a published artefact as a deployed agent.

### there-when-you-reach – There when you reach for it

The isolated agent is still Hermes, still reachable, still itself after a move or restart. Telegram, Slack, and Desktop have the same bar. Adding a surface does not replace an existing one. Persistence includes working tools, not just surviving files.

Signal: first-class surface hold rate. Shape: after an isolation, restart, or intended-runtime change, share of claimed surfaces on which the specialist still completes the job, and share of pre-move tools that still run. Now: unmeasured. Target: to validate. Guardrail: do not treat one surface as proof of another.

### subscription-honest – Subscription-honest

Claude stays on the granted plan login (ACP/OAuth), not a silent API meter. Other billed subscriptions follow the same rule: the principal's granted plan is the ceiling unless they opt a specific account into overage.

Claude-first, not Claude-only: Claude Subscription DirectSDK is the planned default model path, but the rule is the same for every plan the principal brings.

Signal: off-plan model-call rate. Shape: share of turns that billed a path the principal did not grant. Now: unmeasured. Target: to validate. Guardrail: do not "make it work" by dropping to an API key.

### works-your-projects – Works your projects

A person running many parallel pieces of work across several agents can see, per project and issue, who owns it, what was done and what is next, without reading chat history. Long-running work has one owning agent and one durable task per issue. Checkpoints land on the issue. A follow-up from any chat reaches the same task. Several agents can work one project and hand an issue from one to another without the person relaying context. Linear is the human work record; native Hermes owns execution.

Signal: readable-issue rate. Shape: of active issues with agent work, the share where a person who did not watch the chat can state the owning agent, the latest checkpoint and the next action from the issue alone, and that state matches the native work. Now: unmeasured. Target: to validate. Guardrail: do not meet it by mirroring every internal step or chat turn into the tracker, and do not let a tracker record stand in for verified work.

## The customer model

Last revised: 2026-09-12 – successor interview. Confidence: **2** (directional). Dogfood principal+operator evidence is single-source. Public-adopter evidence is [GUESS].

**Who hires the job.** Two people, often the same human on different days.

- Principal: When they already pay for a model plan, they want a standing team they can text, so they can get work done without sitting through every turn, on the plan they already pay for.
- Operator: When they run more than one agent on one host, they want each change to stay local, so they can upgrade or recover one without taking the rest down.

The principal already pays the model plan. Fleet is not a second invoice. The operator is judged on agents staying up and not leaking.

**Forces**

- Push: one shared runtime; a bounce that takes everyone down; a specialist that forgets you; an off-plan bill. Evidence: successor interview; Switchroom product the dogfood already ran.
- Pull: isolated specialists you text; recover one without touching the rest; stay on the granted plan. Evidence: same interview.
- Anxiety: isolation that breaks chat, voice, or login; an upgrade they cannot see; a surface that works in Telegram and dies on Slack or Desktop. Evidence: interview surfaces and non-goals.
- Habit: keep the private snowflake, or keep the old Claude-native specialist runtime, because it already works. [GUESS] for public adopters.

*2026-11-15 note:* the job lines above are the 2026-09-12 evidence as recorded. The Linear-first amendment in [rfcs/switchroom-positioning.md](rfcs/switchroom-positioning.md) reads "a standing team they can text" as one entry point, not the value: the principal's harder struggle is following many pieces of work across several agents, which `works-your-projects` names. That reading is [GUESS] for public adopters.

**The workaround.** Hand-assembled runtime, copied env files, "I know what's running because I just deployed it," and a single chat app treated as the product.

**Behaviour.** The principal texts and expects the same specialist back. The operator reads live state when they distrust docs. Zero tolerance for "deployed" when the profile is still on the previous intended state, and for a turn that billed the wrong plan.

**Public adopter.** A technical self-hoster, GitHub-led, early access. They compare Switchroom with plain Hermes profiles. Their question is "what does this add to Hermes, and what is real today?" Evidence: 2026-11-15 positioning interview. Demand is [GUESS].

**Language and the buying committee.** Dogfood words: "what's running", "don't disturb the others", "on a leash", "the plan we already pay for." The dogfood human is both champion and signer. Public-adopter committee unknown. [GUESS]

**Their economics.** Fleet is not a paid product. The principal already pays the model plan. A bad month is a change that takes more than one agent down, a "success" that was only published, or an off-plan bill.

**What must be true to win**

- Principals will text specialists rather than one generalist. Evidence: successor interview. [GUESS] for public adopters. Wrong if they keep one generalist chat.
- Operators will run one isolated agent rather than one Hermes with many profiles. Evidence: public isolation default plus interview. Wrong if they keep a shared runtime.
- The public product can carry generic capability without household identity. Evidence: current public/overlay split. Wrong if every useful integration is deployment-specific.
- Live state can be read independently of the author. Evidence: first Job Spec bet; unproven. Wrong if stock tools already suffice and nobody will score intended-change.
- Telegram, Slack, and Desktop can meet one bar. Evidence: interview. Wrong if Desktop cannot, in which case it is not first-class.

**Known unknowns**

- Public-adopter demand and buying committee. Close: later adopter conversations, not this interview.
- Whether stock runtime tools already satisfy "understand what is running." Close: the first Job Spec's abandon signal.
- What private drift proof already covers. Close: overlay inventory before any new proof surface. Public tree cannot read those issues.
- How TUTR will be scored on Desktop versus Telegram and Slack. Close: first UAT for there-when-you-reach, after that job is specified. No number invented here.

## How it functions, at a high level

Each specialist stays independently bounded. The principal hands it work through Linear or reaches it on Telegram, Slack, or Desktop; longer work is followed on its Linear issue rather than in chat. A change is supposed to land on one of them and leave the others alone. Claude stays on the granted plan. Deployment identity stays outside the public product. Runtime and packaging live in `docs/` and `contracts/`.

## The job index

Only jobs with a Job Spec are indexed.

### on-a-leash

- [understand-what-is-running.md](jobs/understand-what-is-running.md) – share of intended changes where a fresh-process reader can state the target's live state and whether it matches intent. Job metric: unmeasured. Rolls into on-a-leash's Signal. **Specified.** Retargeted from `change-recoverable` by [rfcs/successor-vision.md](rfcs/successor-vision.md).

### works-your-projects

- [entrust-ongoing-work.md](jobs/entrust-ongoing-work.md) – share of interrupted approved outcomes recoverable without human reconstruction or duplicate effects. Job metric: unmeasured. Rolls into works-your-projects' readable-issue rate. **Specified; implementation and outcome UAT unverified.** Delivery direction: [durable-work-execution.md](rfcs/durable-work-execution.md). `serves:` retargeted from `there-when-you-reach` by the 2026-11-15 amendment in [rfcs/switchroom-positioning.md](rfcs/switchroom-positioning.md); its recovery and cross-surface cases still have to hold there-when-you-reach's bar.

### there-when-you-reach

No Job Spec yet.

Further jobs are not indexed until they have Job Specs. The successor interview named work that is still unwritten; it lives in the decision record, not here.

## Evidence & confidence

Evidence: 2026-11-15 positioning interview (name, category line, headline, public adopter, model framing) and its same-day Linear-first amendment (headline, four proofs, works-your-projects, Claude-first); 2026-09-12 successor interview (one-liner, four outcomes, TUTR, surfaces, audience); Switchroom vision/JTBD as the prior vehicle, not copied wholesale; public contracts and README isolation model.

Confidence: 2. The dogfood principal+operator ratified the sentence. Public adopter demand is unmeasured. TUTR is uninstrumented.

## Related

- [vision.md](vision.md)
- [principles.md](principles.md)
- [invariants.md](invariants.md)
- [rfcs/successor-vision.md](rfcs/successor-vision.md)
- [rfcs/switchroom-positioning.md](rfcs/switchroom-positioning.md)
- Linear: [HF-282](https://linear.app/switchroom-ai/issue/HF-282/retarget-public-fleet-vision-as-switchroom-successor)
