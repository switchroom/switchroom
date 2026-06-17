# `reference/` — the design home

Everything that explains *why switchroom is the way it is* lives here, in one
place. `docs/` is for *using and operating* switchroom; `reference/` is the
design thinking behind it. There is no second design folder to hunt through.

Two layers, by durability:

```
reference/
├── vision.md  principles.md  invariants.md   ← anchors        (durable: the why / built-well / lines)
├── product-spec.md                           ← product layer  (durable: outcomes + the job index)
├── jobs/                                      ← job specs      (durable: one per job, outcome-focused)
└── rfcs/                                      ← RFCs + design records (the "how"; e.g. access-model.md
                                                  details the no-self-escalation invariant)
```

The **root holds only the anchors and the product spec** — the top tier.
**Durable** docs (anchors, product-spec, jobs) state *what the product must be
and do*; they outlive any implementation. The **`rfcs/`** layer carries *how* —
ship-coupled proposals (with a `status:`) and standing design records (e.g.
`access-model.md`, which details the `no-self-escalation` invariant). The split
is by folder + frontmatter, not by two separate trees.

## Read it top-down

| Doc | Question it answers |
|---|---|
| [`vision.md`](vision.md) | *Should we build this?* — the why, who it's for, what it isn't |
| [`principles.md`](principles.md) | *Did we build it well?* — three PR checks (docs / defaults / consistency) |
| [`invariants.md`](invariants.md) | *Are we even allowed?* — the lines we won't cross by construction |
| [`product-spec.md`](product-spec.md) | *What does it deliver, and how does it function?* — the four outcomes + the job index |
| Job specs ([`jobs/`](jobs/), `job:` frontmatter) | *Did it do the user's job?* — outcome-focused, UAT-verifiable, one per job |
| RFCs ([`rfcs/`](rfcs/), `status:` / `artefact:` frontmatter) | *How do we build/ship this change?* — ship-coupled proposals + design records |

The first three are the **anchors**; `product-spec.md` is the product layer
*beneath* them (it owns the job list); the job specs sit beneath that. The
RFCs are the ship-coupled delivery layer — each references the job it serves;
they are **not** a durable contract tier of their own.

The **verdict rule** (also in `CLAUDE.md` → "Design contract"): a change ships
only when it (a) advances one of the four outcomes, (b) satisfies its job
spec, (c) passes all three principle checks, and (d) crosses no invariant.

## The job index lives in the product spec

[`product-spec.md`](product-spec.md) owns the list of jobs, grouped by the
outcome each `serves:`. That is the single source of truth for "which jobs
does switchroom serve" — this README does not duplicate it.

## Use this directory cheaply

Every job spec opens with `job:` / `outcome:` / `stakes:` frontmatter that
captures ~80% of the doc, plus `serves:` (its outcome) and `invariants:`
(the lines it must never cross).

```bash
# Survey every job spec's frontmatter in one read:
head -7 reference/jobs/*.md | grep -E '^(==>|job:|outcome:|stakes:|serves:)'
```

Read a job spec in full only when your change touches it. The body is short
by design: **Good / bad** (the dual-audience decision aid, read by humans
*and* agents), **Prove it** (UAT wired to real scenarios + a fuzz corpus),
and **Verdict**. The *how* is not here — it's in the RFC the job points to.

## Doc-class rule

Decide what a doc is from its frontmatter key alone:

- `job:` **and** `serves:` ⇒ a **job spec** (in `jobs/`), listed in the
  product-spec index. Durable: its `job` / `outcome` / `stakes` stay stable
  while the build churns; retired approaches are narrated, not silently
  rewritten.
- `status:` / `artefact:` / `serves:` / `backs:` (no `job:`) ⇒ an **RFC or
  design record** (in `rfcs/`) that carries the implementation/how. It points
  *up* — `serves:` at the job it delivers (e.g. [`conversational-pacing.md`](rfcs/conversational-pacing.md)
  serves `know-what-my-agent-is-doing.md`), or `backs:` the invariant it
  details (e.g. [`access-model.md`](rfcs/access-model.md) backs
  `no-self-escalation`). An RFC carries a status lifecycle (Draft → Approved →
  Shipped/Archived); a design record is kept current rather than archived.

There is no other class. `job:` **always** means a job spec — nothing else
uses that key. The line, the outcome, and the how are three separate docs (an
invariant, a job spec, a design record), never collapsed into one.

## `rfcs/` holds two kinds of doc — that's intended

`rfcs/` is the single home for the churny "how" layer. Most files are RFCs
(ship-coupled proposals, each with a `status:`); a few are standing **design
records** kept current (e.g. `conversational-pacing.md`,
`status-card-design.md`). Tell them apart by frontmatter, not by folder. A
couple are historical and say so in their own status line (e.g.
`onboarding-gap-analysis.md` — a point-in-time analysis, not a live tracker).
