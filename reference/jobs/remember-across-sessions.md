---
job: remember across sessions without being re-told
outcome: The agent brings back relevant facts, preferences, decisions, and open threads from past conversations, in the right moment, without the user reminding it.
stakes: An agent with no memory is a stranger every time. The user stops sharing context because they're tired of repeating it. The relationship never compounds.
serves: standing-team
invariants: [single-tenant]
---

# Job Spec: remember across sessions without being re-told

> A durable Job Spec. The *how* — the four memory surfaces, the injection
> pipeline, the rules lifecycle, the repo-knowledge build — lives in the
> design artifact `design-v2.md` (`serves:` this job) and resolves against
> the evidence ledger `reference/rfcs/memory-redesign-2026-08.md`, where
> every `E-nn` / `P-nn` / `C-nn` cited below has an anchor. That design
> churns; this job does not.

## The job

The user said something last Tuesday that matters today. They told the agent
months ago how they like things done. They started a thread that never got
closed. A goldfish agent forces the user to repeat all of it, so they stop
trying. The job is to make the agent remember in a way that helps, not in a
way that's creepy or noisy. Memory is not a chat log: dumping the last
thousand messages into the prompt is neither remembering nor useful. Good
memory is curated, semantic, and retrieved by relevance: the schedule note
surfaces when planning the week, not when writing code. Memory is also
honest: when the agent recalls something, the user can see that it did,
trust why, and correct it if it's wrong.

> [!IMPORTANT]
> Memory the user can't inspect is memory the user won't trust.

What the user experiences as "it remembered" is four separate things, and
they fail separately: **standing rules** the user set once; **orientation**
— where things stand at the start of a session; **recall** of a specific
past fact; and **standing knowledge** about a codebase or a domain. This
job is met only when all four hold, and holds honestly only when each one
that is not yet built says so out loud rather than being described as if it
were (`design-v2.md` §2).

> [!CAUTION]
> A rule surface with no retirement is not memory, it is accumulation.
> Measured across the live fleet, all 15 banks, live read-only GETs:
> **176 active directives across 15 banks, zero inactive anywhere —
> nothing has ever been retired, in any bank** (E-98, superseding E-42's
> 194-across-14 snapshot from the same pass — one bank was added between
> the two counts). "Set once and respected" and "retirable, and visibly
> so" are the same requirement; a surface that only grows fails this job
> quietly.

## Good / bad

**Good looks like**

- The agent brings back a detail from a past conversation at the right
  moment, without being prompted for it. **The mechanism is deterministic,
  not prompt hope: memory is injected on every eligible turn** — off the
  reply path, capped into the band both comparators ship, gated against
  junk. That is where this job lands, not a stage it passes through
  (`design-v2.md` §1 P1, §5 6a). Retrieval the agent invoked itself stays
  available alongside it and remains the inspectability gold-standard
  (C-01); a per-agent **tools-only** arm exists behind an explicit
  evidentiary gate (`memory.injection: tools-only`, §5 6b) and is an
  experiment, not the trajectory.
- Retrieval never makes the user wait for the reply. It runs off the reply
  path, prefetched at the end of the previous turn and joined with a short
  cap. *Today it does not:* the live hook blocks the reply at **p50 ~1.3s /
  p90 ~5.5s / max ~9.2s** (E-84).
- What comes back is relevant, not a grab-bag; most of what's recalled is
  useful. Slots are filled because a memory earned them, not because a
  candidate existed. **Turns the user did not write get no recall at all** —
  machine-generated task notifications are ~20–30% of all logged recalls
  today, each eligible for a full-cap injection over a query of task ids and
  file paths (E-87); the gate on them is deterministic, not a judgment call.
- The user corrects a stored fact and the correction sticks; the agent
  doesn't reassert the old version later. The correction is explicit — the
  bad fact is invalidated and a superseding fact retained that names what it
  corrects (`design-v2.md` §2.4). *Scope note, carried honestly:* "true, but
  stop surfacing it" is **not available** on the pinned engine — there is no
  tag-write path for an existing memory (E-20, E-31, confirmed fresh at
  0.9.0) — and age does not fade a memory out of ranking either (recency
  moves a result by at most ±10%; the cross-encoder dominates, E-56). A
  correction has to be made, not waited out.
- Preferences and rules set once stay respected across sessions without
  re-stating. **Standing rules live in the agent's root `CLAUDE.md`** — the
  one surface documented to be re-injected from disk after compaction (E-51,
  E-62) — as a marker-delimited block carrying each rule's id, text,
  creation time, and source. They are budgeted (both standing blocks
  together ≤ 6KB rendered), announced when they change, archived rather than
  vanished when retired, and **retirement is a first-class verb**:
  compaction *applies* a retirement instead of resurrecting the rule
  (`design-v2.md` §4.4).
- That rule surface is tamper-evident. Every legitimate mutation goes
  through one sanctioned writer that appends to a hash-chained mutation log;
  an unexplained delta fails loud and stands until an operator resolves it.
  The threat is honest and named: a prompt-injected turn turning one bad
  message into *persistent* rule authority (`design-v2.md` §2.1a).
- A restart, a compaction, or a new chat window doesn't reset the
  relationship; the agent picks up roughly where it was. The intended
  mechanism is a cron-refreshed **orientation briefing** — a standing
  synthesis of active projects, recent decisions, open commitments and
  current constraints — read at session start as a cached, no-LLM lookup and
  **re-seated after every compaction**, with a visible staleness line when
  the refresh cron is late and a visible cold notice when there is nothing
  to read. ***This read is specified and NOT BUILT*** (E-88): nothing in the
  deployment calls it today, and today's post-compaction footing is the
  native summary plus a generic re-seat. Until it ships, this bullet is a
  target, not a claim (`design-v2.md` §2.2, §5 step 7).
- The user can ask what the agent believes about them and why, and get an
  honest, legible answer. Who the user *is* stays in the dedicated profile
  banks; the orientation briefing excludes identity by construction, because
  auto-seeded profile models were ripped out once already for duplicating
  and contradicting them (E-16).
- Each agent's memory is its own: different specialists, topics, and
  distinct users are never conflated into one pool. **One deliberate
  exception, argued rather than waved through:** durable knowledge about a
  *repo* is identity-free and agent-independent, so it lives in one shared
  bank per repo with a **single writer** (a deterministic ingestion
  pipeline), never receives conversational retains, and is read by every
  granted agent through the already-deployed `additional_banks` fan-out.
  Pages there are **fetched whole** — tree, then page — never used as a
  precision retrieval path (`design-v2.md` §10.1–10.3).
- Bank reach is granted, never minted. An agent may *select* among the banks
  an operator granted it and is loudly rejected outside that set; derived /
  dynamic bank ids are explicitly rejected — they solve an isolation problem
  a static operator-owned mapping already solves, and add silent-misroute
  and ungated lazy-creation failure modes (`design-v2.md` §7, §10.6 W-2;
  E-89, E-90, E-96).
- Work handed to a sub-agent is not a memory hole. *Today it is one:* a
  `worker` has **zero memory read path** — no memory tools on its allowlist
  and no injection on a Task dispatch — while `SubagentStop` retains its
  prose into the parent's bank. The fleet delegates implementation to
  exactly the agent type with the blankest memory. This is a named defect
  with a specified fix (read-only pull tools on the worker allowlist plus
  dispatch-prompt pre-fetch), not an accepted shape (`design-v2.md` §2.6;
  E-86).
- Every failure mode has a name and a visible signal — including the ones
  this design introduces: a dead refresh cron, an unloadable rules block, an
  out-of-band rules edit, a dead repo-ingestion cron, a zero-extraction
  retain that reports success (E-36). The fleet's own history makes this
  non-hypothetical: overlay crons died silently for weeks.

**Bad looks like: never ship this**

- Raw transcript dumping passed off as memory; that's storage, not
  remembering.
- Regurgitating old facts unprompted, out of context, just to prove it
  remembered.
- **Silent forgetting: an old rule quietly stops being applied with no way
  for the user to tell.** This is the headline never-ship, and it now binds
  the new machinery too — a memory subsystem that can fail without emitting
  a signal is not shippable, however cheap the silence is.
- Memory the user cannot inspect, correct, or delete.
- Per-session memory that resets every chat window; the user is not a
  different person each time.
- Conflating different topics or different specialists into one
  undifferentiated memory pool.
- Treating every retained memory as equally weighted, with no sense of what
  mattered and what was small talk.
- Retrieval on the reply path, making the user wait for the agent's memory
  before they get a word (E-84).
- A full-cap grab-bag: every slot filled whenever candidates exist,
  including on machine-generated turns nobody typed (E-85, E-87).
- **A relevance floor as the fix for that grab-bag.** Refused on
  measurement, not taste: scores are not calibrated across queries — a
  rank-1 relevant hit can score ~0.001 — so every candidate floor trimmed no
  bad tail and only emptied result sets (E-13, 330 replayed queries; the
  vendor independently warns the same, E-50 item 4). The junk cut comes from
  the count cap and the deterministic skip gate.
- A rule or knowledge surface with create but no retire, no provenance, and
  no visible lifecycle (E-42's measured outcome).
- A memory an agent writes into but can never read (E-86).
- Standing knowledge served by unreranked search standing in for `recall`,
  or pushed into every turn as raw document content.
- A bank identifier an agent can derive or invent for itself.

## Prove it

- **Survives restart (DM)** — `jtbd-memory-survives-restart-dm`. *Watch:* a
  fact stated before a restart is recalled after it, without re-telling.
  *Invariant:* a restart or new window never resets the relationship.
- **Honest, legible recall** — `tests/cli.memory.recall-log.test.ts`,
  `tests/memory.user-profile.test.ts`,
  `jtbd-memory-legibility-dm` / `-channel`. *Watch:* the user can see what was recalled and why; the
  profile reflects what the agent believes. *Invariant:* nothing is recalled
  from a black box the user can't inspect. *Lead worth keeping:* our
  degraded-recall notice tells the agent when recall failed; both
  comparators fail open and silent (P-01, P-11).
- **Correction sticks** — `tests/memory.add-memory-tag.test.ts` (wire
  shape), `tests/cli.memory.demote.test.ts` (**CLI wiring and preflight
  only** — the demote-by-tag capability itself is *unimplementable* on the
  pinned engine, E-20/E-31/#3772). *Watch:* a corrected memory stops
  surfacing. *Invariant:* a correction the user makes is honoured and not
  silently reverted. *Coverage gap:* no runnable scenario for the shipped
  correction path — invalidate + supersede (`design-v2.md` §2.4). The
  earlier "decays sensibly" half of this row is **withdrawn**: memories do
  not meaningfully fade with age (E-56).
- **Per-agent banks, no pooling** — `tests/memory.create-bank.test.ts`,
  `tests/memory.bank-missions.test.ts`,
  `tests/scaffold.recall-additional-banks.test.ts`. *Watch:* each specialist
  recalls only its own bank plus the banks an operator granted it.
  *Invariant:* topics and specialists are never conflated into one memory
  pool (`single-tenant`); extra reach is operator-granted config, never
  agent-derived.
- **Relevant, not exhaustive recall (DM)** — *(coverage gap: no runnable
  scenario yet)*. *Watch:* a query touching several past threads brings back
  the few useful ones, not a grab-bag. *Invariant:* recall is ranked by
  relevance, not dumped, and never fills the cap merely because candidates
  existed (E-85).
- **Junk turns get no recall** — *(coverage gap)*. *Watch:* a
  machine-generated task-notification turn triggers no injection at all.
  *Invariant:* the gate is deterministic (envelope tag), never a model
  judgment (E-87).
- **Retirement survives compaction** — *(coverage gap: the mutate-then-
  compact canary is specified but UNRUN, `design-v2.md` §5 step 1(f),
  E-81)*. *Watch:* a rule retired mid-session is absent after compaction,
  not resurrected. *Invariant:* compaction applies retirements; it never
  reverts them.
- **The standing block actually loaded** — *(coverage gap)*. *Watch:* an
  unreadable file, missing markers, or a sentinel mismatch produces a
  visible notice and a doctor FAIL. *Invariant:* an unloadable rules block
  is loud, never silent (C-01).
- **Orientation at session start** — *(coverage gap: the surface is
  UNBUILT, E-88)*. *Watch:* a session and a post-compaction turn both open
  with current standing context; a stale or missing briefing says so.
  *Invariant:* stale context is never served as fresh, and a missing
  briefing is announced rather than faked.
- **Sub-agent memory reach** — *(coverage gap)*. *Watch:* a dispatched
  worker can read the memory its own output is being written into.
  *Invariant:* no agent type writes into a bank it has no path to read
  (E-86).

**Fuzz corpus:** vary elapsed time × topic overlap × correction-then-recall
× restart/compaction × human-vs-machine-generated turn × sub-agent dispatch
× number of competing memories; relevance, honesty, correction-stickiness,
loud failure, and per-bank isolation hold across all.

## Verdict

- **Done when:** the agent brings back the right context at the right moment
  without being re-told and without blocking the reply to do it; standing
  rules set once are respected, retirable, and survive compaction as
  retired; the user can inspect and correct what it believes; every memory
  failure emits a signal; and no agent writes into memory it cannot read —
  proven by the scenarios above.
- **Not done yet, explicitly:** session-start and post-compaction
  orientation is unbuilt (E-88); the worker read path is a named defect
  (E-86); injection still runs on the reply path at every-Nth retain
  cadence (E-84, E-71); and the repo-knowledge build is gated on two
  measurements that have not reported (`design-v2.md` §10.6).

## Production-readiness

- *Durability:* recalled context survives restart, compaction, and new chat
  windows — on the documented disk-reload surface for standing rules, and
  on a re-seated session-start read for orientation once that read exists.
- *Inspectability:* every recall is attributable; the user can see, correct,
  and retire what the agent stores. Standing rules are a plain block in a
  file they can read, backed by an append-only mutation log.
- *Placement:* memory retrieval belongs off the reply path. Latency the user
  waits through is a defect of this job, not a tuning backlog item (E-84).
- *Cost, refused as a point estimate:* the measured ~48.7M input tokens per
  30 days of always-on directive block is deleted outright (E-41). The
  recall block's share is **unmeasured**, with a nominal ceiling of ~164M at
  the deployed caps, roughly halved to **~75–90M** by the junk gate and the
  budget convergence — nominal twice over, and **no point inside that range
  is asserted**. The new spend (orientation refreshes) has **never been
  measured**; the plausible net ranges from roughly neutral to about a 65%
  reduction, and rollout is gated on the measurement rather than on a
  guess (`design-v2.md` §6).
- *Quality claims, held at their real confidence:* the pattern this design
  serves — synthesis read once, rather than raw fragments pushed every turn
  — is the replicated result (9/9 runs, non-overlapping ranges, E-79). The
  comparison between hardened injection and tools-only is **unmeasured in
  either direction** (P-14); generating a defensible answer costs ~$300 of
  harness time, and a ~$0 live A/B is the cheap first probe. No flip is
  presented as evidence-backed until one of those reports.
- *Failure visibility:* dead refresh cron, unloadable or tampered rules
  block, dead repo ingestion, and zero-extraction retains each have a named
  signal and a doctor check. Silence is the failure.

## Related

- [`run-a-fleet-of-specialists`](run-a-fleet-of-specialists.md) — why each
  agent's memory bank is its own and never pooled, and what the shared repo
  bank has to prove to be the exception.
- [`survive-reboots-and-real-life`](survive-reboots-and-real-life.md) — memory
  surviving a restart, compaction, or crash.
- [`get-better-the-longer-they-run`](get-better-the-longer-they-run.md) — how
  remembered context compounds over time; the lesson has to land in this
  substrate to bind.
- [`approve-what-my-agent-can-touch`](approve-what-my-agent-can-touch.md) —
  why rule mutations, bank grants, and page authorship are operator-gated
  rather than self-served.
- [`keep-my-subscription-honest`](keep-my-subscription-honest.md) — memory's
  synthesis stays on the sanctioned Claude path; no `claude -p` anywhere in
  the pipeline.

---

> **Implementation:** the how lives in `design-v2.md` (frontmatter `serves:`
> this job), resolving against the evidence ledger
> `reference/rfcs/memory-redesign-2026-08.md`. Those churn; this Job Spec
> outlives them.
