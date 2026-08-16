---
artefact: Memory, redesigned from first principles (2026-08)
status: Draft (2026-08-16) — RESEARCH + EVIDENCE LEDGER; design not yet written
serves: remember-across-sessions
advances-outcome: standing-team
relates:
  - reference/jobs/remember-across-sessions.md
  - reference/rfcs/hindsight-synthesis-layers.md
  - reference/rfcs/hindsight-phase5-mental-model-curation.md
  - reference/rfcs/per-speaker-memory-routing.md
  - reference/rfcs/shared-knowledge-banks.md
  - reference/rfcs/shared-user-profile.md
supersedes: reference/rfcs/hindsight-memory-reimagined.md
---

# Memory, redesigned (2026-08)

> [!IMPORTANT]
> This document is **evidence first, design second**. The RFC it supersedes
> (`hindsight-memory-reimagined.md`) was parked because its central mechanism
> rested on an engine capability nobody had verified. Every claim here carries
> a citation to code, a docs URL, an issue, or a live API response. A claim
> without one does not belong in this file.

## Why a new RFC

`hindsight-memory-reimagined.md` (Draft 2026-07-07) is parked, and its Tier 1
has since shipped by another route (the #3430 leverage programme) — see
[E-11](#e-11). It is stale rather than wrong. Rather than unpark and patch a
document whose premises have moved, this RFC restates the problem against the
engine we actually run today (Hindsight **0.9.0**, [E-01](#e-01)).

---

## Evidence ledger

Each entry: the claim, the evidence, and the date it was checked. Anything
marked UNVERIFIED is a lead, not a fact, and must not be built on.

**Convention added at rev 9, after three confirmed instances
([E-70](#e-70) REFUTED, [P-05](#p-05) corrected, [E-53](#e-53) anchor
drift): a claim about LIVE behaviour must cite the DEPLOYED artefact —
the running container's source, the stamped per-agent `settings.json`,
the override site in `scaffold.ts`, or the operator config — never a
vendored snapshot, repo-tree default, or engine-internal DEFAULTS tier.**
Those lower tiers are real code and still produce plausible line-anchored
citations, which is exactly what makes the trap dangerous;
`vendor/hindsight-memory/CLAUDE.md:25-38` documents it in terms ("reading
the vendored `settings.json` to learn live behaviour is actively
misleading"). When a snapshot is all that is available, the entry must
say so and mark the live claim UNVERIFIED.

### Live deployment

<a id="e-01"></a>
**E-01 — We run Hindsight 0.9.0.**
`curl -s http://127.0.0.1:18888/openapi.json` → `info.version: "0.9.0"`;
container `switchroom-hindsight`, image
`ghcr.io/switchroom/switchroom-hindsight:v0.21.13`. Checked 2026-08-16.
Note: issue #4525 (the 0.8.6→0.9.0 bump epic) reads as planned-not-executed,
with its child work packages unchecked. The running server reports 0.9.0
regardless. **The epic's status and reality disagree; resolve before citing
either.**

<a id="e-02"></a>
**E-02 — `ReflectRequest` fields on our engine.**
From the live `/openapi.json`, `ReflectRequest` properties are exactly:
`query`, `budget`, `context`, `max_tokens`, `include`, `response_schema`,
`tags`, `tags_match`, `tag_groups`, `apply_all_directives`, `fact_types`,
`exclude_mental_models`, `exclude_mental_model_ids`. Checked 2026-08-16.
`query_timestamp`, `prefer_observations`, `min_scores`,
`recall_budget_function`, `entity_labels` and `memory_defense` all appear in
the live spec. This settles the parked RFC's open question about
`query_timestamp` — it exists on the engine (whether our client *wires* it is
a separate question, [E-12](#e-12)).

### Directives — the layer we are using against its design

<a id="e-03"></a>
**E-03 — Directives are a `reflect`-only feature, by the vendor's own docs.**
<https://hindsight.vectorize.io/developer/api/memory-banks#directives>, read
2026-08-16, verbatim:

> Directives are hard rules that the agent must follow during **reflect**
> operations. […] **Directives only affect the `reflect` operation.** They are
> injected into prompts and the agent is required to comply with them in all
> responses.

They are further defined as *hard* rules — the docs' own contrast table puts
directives ("Hard rules, must be followed" / "Compliance, guardrails,
constraints") against **disposition** ("Soft influence on reasoning style" /
"Personality, character, tone"), with disposition exposed as bank config
(`disposition_skepticism`, `disposition_literalism`, `disposition_empathy`).

<a id="e-04"></a>
**E-04 — Directive tags are a scoping mechanism, and there is an override
flag.** Same page, verbatim:

> **Untagged directives always apply**, on every `reflect`. **Tagged
> directives apply only when the `reflect` request includes matching tags**
> (using the request's `tags_match` mode). A `reflect` call with no tags
> applies only the untagged directives.
>
> To apply **every** active directive regardless of tags, set
> `apply_all_directives: true` on the `reflect` request.

`apply_all_directives` is present on our live engine ([E-02](#e-02)).

<a id="e-05"></a>
**E-05 — switchroom injects directives client-side into every turn instead.**
`vendor/hindsight-memory/scripts/lib/directives.py:1-17` (module docstring,
read at HEAD `4a70ee5`):

> Hindsight's `reflect` MCP tool has an upstream bug
> (vectorize-io/hindsight#1269) where tagged directives are silently dropped
> from synthesis. Until that ships, we surface directives client-side as a
> structurally distinct top-of-prompt block so the agent reads them every
> turn — independent of whatever `reflect` does with them.

`fetch_active_directives_cached` calls `list_directives(active_only=True)`
with **no tag filter** (`:175-216`); `format_active_directives_block`
(`:244-315`) renders an `<active_directives>` block injected on every
`UserPromptSubmit`.

<a id="e-06"></a>
**E-06 — The bug that justified the workaround is CLOSED, and the behaviour
is now documented as intended.** `gh issue view 1269 --repo
vectorize-io/hindsight` → state `CLOSED`, closed **2026-04-26** (opened the
same day). Title: "`reflect` silently drops every directive that has at least
one tag (isolation_mode filter bug)". The issue body itself records that
`reflect(tags=["safety"])` **does** apply the directive, and that untagged
directives always apply — which is precisely the behaviour the current docs
describe as the designed tag-scoping model ([E-04](#e-04)).

> **Consequence.** The workaround's stated premise ("until that ships") expired
> roughly four months ago, and what it works around is now a documented
> scoping feature with an explicit override flag. The client-side block is no
> longer a bug workaround; it is an undeclared parallel mechanism.

<a id="e-07"></a>
**E-07 — The cost of that block, from the code's own measurement.**
`directives.py:26-52`, verbatim:

> `recall.py` rebuilds the `<active_directives>` block on EVERY
> UserPromptSubmit […] with no per-session dedupe and no "unchanged since last
> turn" suppression, and `additionalContext` is APPENDED into the
> conversation. So the block is re-paid every turn and accumulates — roughly
> (block size) x (turn count) over a session, not once.

Measured live 2026-07-25: overlord 12 active ≈ 9.8 KB; klanker 17 active
≈ 9.9 KB; gymbro 9 active ≈ 9.3 KB. Fleet average ≈ 700 chars/directive; a
bank at the cap injects ≈ 21 KB, "on the order of 5,000-6,000 tokens per
injection, per turn, cumulative across the session."

<a id="e-08"></a>
**E-08 — `MAX_DIRECTIVES = 30` is a switchroom invention, not a Hindsight
limit.** `directives.py:51`, with the comment at `:26-50` stating it is "a
COST TRADEOFF, not an arbitrary limit" and that "the actual defence against
pile-up is the doctor's WARN/FAIL on the active directive count
(`src/cli/doctor-memory.ts`), not this cap." No cap is documented on the
vendor's directives page ([E-03](#e-03)). Issue #3586 (open) records that the
cap is inject-path only, unenforced on the write path, and that no
switchroom-owned interception point exists that a determined caller cannot
bypass (`mcp_transport: "http"`, or direct REST).

<a id="e-09"></a>
**E-09 — Deactivation is a documented, ordinary update.** Vendor docs
([E-03](#e-03)) show `update_directive(bank_id, directive_id,
is_active=False)` / `hindsight directive update … --is-active false` as the
supported path. Hard `delete_directive` is separate. Retirement is therefore
cheap and reversible, which matters because the fleet's create path is nudged
and free while retirement has been treated as gated.

> [!WARNING]
> **Corrected 2026-08-16 against the live MCP surface.** The docs are right
> about the *capability* but wrong about *our* reach. Live `tools/list`
> returns 32 tools including `create_directive`, `list_directives` and
> `delete_directive` — and **no** `update_directive`,
> `deactivate_directive` or `reactivate_directive`. REST
> `PATCH /directives/{id}` with `{"is_active": false}` does work (200, field
> flipped). So deactivation exists, but **only over REST**, not over the MCP
> transport agents actually use.
>
> This matters twice over. Practically: an agent's only in-band lifecycle
> verbs are *create* and *hard delete* — the cheap reversible middle option
> is not reachable from where the agent stands, which is exactly the wrong
> shape for a "curate your own directives" design. And methodologically:
> `deactivate_directive`/`reactivate_directive` appear as nominally available
> names in this harness's deferred-tool listing, which is what made the
> earlier claim feel verified. **A name in the tool listing is not proof the
> server exposes it.** Verify against `tools/list`.

<a id="e-10"></a>
**E-10 — Live fleet directive counts, 2026-08-16.** overlord 26, marko 26,
clerk 25, assistant 25 (all above the doctor WARN line of 24); klanker 24;
carrie 18; reggie 13; gymbro 12; finn 11; lawgpt 11; ziggy 6; test-harness 1;
kdogg 1. Nothing is being truncated today — the cap is not the live problem.

### The parked RFC, and what has moved under it

<a id="e-11"></a>
**E-11 — Tier 1 shipped by another route.** `scores.final` sorting is live at
`vendor/hindsight-memory/scripts/recall.py:513-528` (`_result_final_score`)
and `:694` (`_sort_by_final_score`); `prefer_observations` is wired at
`vendor/hindsight-memory/scripts/lib/client.py:180,190,209-210` and exposed as
per-agent config at `src/config/schema.ts:947,3860`. The parked RFC's central
"unverifiable" claim is now verified *and built*, via the #3430 programme.

<a id="e-12"></a>
**E-12 — `query_timestamp` exists on the engine but was not found wired in our
client.** Engine side confirmed ([E-02](#e-02)). A grep of the vendored client
found `tags_match` and `prefer_observations` wired but not `query_timestamp`.
Treat "we do not use it" as likely; treat "we cannot" as **UNVERIFIED**.

### Measured dead ends — do not re-propose without new evidence

<a id="e-13"></a>
**E-13 — A recall relevance floor (`min_scores`) does not work here.**
`vendor/hindsight-memory/scripts/recall.py:439-445`: `scores.final` is **not
calibrated across queries** — "a clearly-relevant match may score ~0.001 while
ranked first." Over 330 replayed queries every candidate floor had
`top1lost% == zero%` exactly; a floor never trims a bad tail, it only empties
result sets (0.001 → zero-result rate 5.8%→28.2%; 0.05 → 40.6%, re-creating
#3541). This is measured, not assumed.

<a id="e-14"></a>
**E-14 — The lexical-overlap recall gate was shipped, measured, and removed
(#3761).** `recall.py:420-445`: discarded 79.8% of post-reranker candidates
fleet-wide (94.4% for overlord), dropped the engine's own top-ranked candidate
on 31.2% of 330 replayed queries, and filtered no measurable noise (27.0% vs
28.2% below-threshold rate — inside sampling noise). "It was not acting as a
floor; it was acting as a rival, worse ranker." Root cause: a tokenizer
keeping only alphabetic tokens >1 char, blind to digits and identifiers.

<a id="e-15"></a>
**E-15 — Capping rerank candidates 150→50 was reverted mid-PR (#3629).**
45.9% of injected memories come from RRF rank >50; 5/8 test queries lost their
#1 result. Reranking is 72-91% of every recall's latency, so the temptation
recurs — the finding is that this particular lever costs real results.

<a id="e-16"></a>
**E-16 — Auto-seeded per-agent `user-profile` mental models were ripped out
(#2447).** `hindsight-phase5-mental-model-curation.md:17-40`: empty/thin banks
synthesised to noise; the per-agent model duplicated and could **contradict**
the dedicated profile banks (the "wrong dog" answer); and silent
self-enriching structure brushed `on-leash` / `no-self-escalation`. Profile
banks own identity.

<a id="e-17"></a>
**E-17 — DB-level levers do not fix recall latency (#4474).** The epic
falsified its own founding hypothesis: DB-side fixes cap out at ~25% of
latency under contention; reranking and query-embedding dominate at every
concurrency level; bank size barely matters. It is a single-accelerator
queueing problem.

### Open engine-side problems

<a id="e-18"></a>
**E-18 — `reflect` has no relevance floor (#4170, open).** A near-zero
retrieval still returns confident prose. The only mitigation today is a seeded
`no-confabulation` directive — prompt discipline standing in for a guarantee.

<a id="e-19"></a>
**E-19 — `reflect`'s `budget` knob is inert (#4165, open).** Never hits its
iteration cap across 30 live calls. The real terminator is
`HINDSIGHT_API_REFLECT_MAX_CONTEXT_TOKENS=20000`, which force-terminates 60%
of live reflect runs and costs 38% of answers a false "I don't know."

<a id="e-20"></a>
**E-20 — `memory demote` is unimplementable on the pinned engine (#3772,
open).** No tag-write path for an existing memory, so `[demote-from-recall]`
can only be attached at retain time. This puts a hole in the job spec's
"corrections stick" promise. **Possible resolution to test:** bank config
`entity_labels` with `tag: true` writes `key:value` labels as tags on the
memory unit at retain time ([E-21](#e-21)) — that is still retain-time, so it
likely does not close #3772, but the 0.9.0 surface should be re-probed for an
update path before the issue is treated as fixed-cost.

### Capability surface we are not using

<a id="e-21"></a>
**E-21 — Bank config is a large, mostly-unused surface.** From the vendor
docs page ([E-03](#e-03)): `retain_mission`, `retain_extraction_mode`
(`concise`/`verbose`/`custom`) + `retain_custom_instructions`,
`retain_chunk_size`, `entity_labels` (typed label groups —
`value`/`multi-values`/`text`/`map` — that become graph entities, and with
`tag: true` are also written as tags), `entities_allow_free_form`,
`observations_mission`, consolidation batch/token controls, `allowed_tools`
(per-bank tool allowlist), `recall_budget_function` + adaptive budget ratios,
`disposition_*`, and a `memory_defense` policy with `prompt_injection` /
`sensitive_data` / `protected_key` / `immutable_key` / `size_anomaly`
detectors mapping to `allow`/`redact`/`quarantine`/`block`.

<a id="e-22"></a>
**E-22 — Consolidation is controllable.** `consolidation_auto` can be turned
off so consolidation runs only when explicitly triggered via the consolidate
endpoint, including targeted consolidation for specific scopes. Relevant to
the "background consolidation is invisible spend" tension recorded in
`hindsight-synthesis-layers.md:181-193`.

<a id="e-23"></a>
**E-23 — Document transfer without re-extraction.** Export/import moves
documents and their already-extracted facts between banks without re-running
the LLM; facts are re-embedded with the target bank's model. Directly relevant
to any bank-topology change, which would otherwise look prohibitively
expensive.

### Live probe, 2026-08-16 (measured, not read)

All entries below are from direct calls against `http://127.0.0.1:18888`,
using a throwaway bank `probe-scratch-klanker` for any write test.

<a id="e-24"></a>
**E-24 — `recall` DOES return similarity scores. The vendored comment is
wrong for 0.9.0.** A live recall against bank `klanker` returned
`"scores":{"final":0.6178,"reranker":0.6171,"keyword":15.02}` on every
result, identically over REST and MCP. The `RecallScores` schema documents
`final` / `reranker` / `semantic` / `keyword`. The comment that read
"Hindsight's HTTP API does not return similarity scores" was presumably
true of the version it was written against; it was false of what we run.
This corroborates [E-11](#e-11) from the other direction. **Anchor
correction (design-v2.md §5 step 1(d) fold-in):** the comment is already
deleted, in commit `70d29067` ("Deleted the stale 'Hindsight's HTTP API
does not return similarity scores' comment … and rewrote the #475 gate
rationale"), which predates this document — there was nothing left to
fix. The original `recall.py:344-345` line anchor has since drifted with
the file and now points at unrelated recall-cache-lookup code; cite the
commit `70d29067`, not a line number, for this claim going forward.
`grep -rn similarity vendor/hindsight-memory/scripts/` returns nothing
relevant on `main` today. Re-verified against `origin/main` at `4a70ee58`.

<a id="e-25"></a>
**E-25 — `min_scores` IS functional at the engine.** `{"final":0.99}` → 0
results; `{"final":0.0}` → 90 results. Note carefully: this does **not**
overturn [E-13](#e-13). E-13's finding is that a floor is *useless for
precision here* because scores are uncalibrated across queries — not that
the parameter is inert. Both are true. Do not cite E-25 as licence to add a
floor.

<a id="e-26"></a>
**E-26 — Parameter reality check.** Functional and confirmed:
`prefer_observations` (true→42 results, false→44), `query_timestamp` (shifts
`scores.final` when the anchor moves 2020→2026, so recency scoring responds
— this closes [E-12](#e-12) on the engine side), `tags_match` (enum
`any`/`all`/`any_strict`/`all_strict`/`exact`). Weak: `budget` on recall
(41 vs 40 results low-vs-high at fixed `max_tokens`) — it gates candidate
depth, not final count. **Do not exist:** `limit`/`top_k`, and
`recall_budget_function` is absent from the live schema despite appearing in
the docs ([E-21](#e-21)) — a docs/engine mismatch worth noting.

<a id="e-27"></a>
**E-27 — `reflect` genuinely consults mental models first, and it DOES apply
our directives.** A live reflect on `klanker` returned
`based_on: {memories: 0, mental_models: 5, directives: 24}` — zero raw facts,
with a `search_mental_models` tool call visible in the trace. Two things
follow. First, the mental-model-first claim is true, not marketing. Second,
**all 24 of this bank's directives were applied by `reflect` without us doing
anything** — which is further evidence that the client-side block
([E-05](#e-05)) is now redundant with, not compensating for, the engine.
Reflect is agentic: max 10 iterations, and it must gather evidence before
answering.

<a id="e-28"></a>
**E-28 — Latency, measured.** `recall`: 4 consecutive calls, 0.60-0.75s,
tight spread — consistent with pure retrieval and rerank, no LLM round trip,
corroborating [P-03](#p-03). `reflect`: 51.5s and 87.0s, at `budget: "low"`,
with `usage: {input_tokens: 34728, output_tokens: 1205}` in the response.
**Reflect is not a hot-path mechanism at these latencies.** Any design that
routes turn-time work through reflect has to answer for a minute of wall
clock.

> [!CAUTION]
> **Rev 10 scope note — the 0.60–0.75s is the single-bank MCP recall
> *tool*, not the deployed reply-path hook.** The hook runs a multi-bank
> parallel fan-out and measures p50 ~1.28s / p90 ~5.5s / max ~9.2s on
> the live log — see [E-84](#e-84). Design revs 1–9 cited this entry's
> figure at four hot-path-cost sites; corrected at rev 10. E-28 remains
> valid for what it measured (tool-call latency, and reflect's 51–87s).

<a id="e-29"></a>
**E-29 — Directives carry no provenance and no usage telemetry.** Live
`DirectiveResponse` fields are exactly: `id`, `bank_id`, `name`, `content`,
`priority`, `is_active`, `tags`, `created_at`, `updated_at`. There is **no
`superseded_by`** and **no hit/usage counter** — a prior belief that
directives carry supersession provenance is wrong at this version. Any
lifecycle design must carry provenance itself.

<a id="e-30"></a>
**E-30 — The 30-directive cap is unenforced server-side, confirmed by
experiment.** 35 directives created on the throwaway bank; all 35 returned
`200` and all 35 listed back. No cap, no error. Confirms #3586
([E-08](#e-08)) empirically: enforcement is ours to do, or not done.

<a id="e-31"></a>
**E-31 — #3772 still holds at 0.9.0: there is no tag-write path.**
`PATCH /memories/{id}` with `{"tags":[...]}` → `422 "Provide at least one
field to update"` — `tags` is not a recognised field. `UpdateMemoryRequest`
has no `tags`; MCP `update_memory` has no `tags`; `/tags` is GET-only. Note
the issue is filed against 0.8.5 and we run 0.9.0, so this is a **fresh
confirmation on the current version**, not an inherited assumption.
`memory demote` by tag cannot be built against this API. [E-20](#e-20)'s
`entity_labels` idea remains retain-time only and does not rescue it.

<a id="e-32"></a>
**E-32 — Cross-bank recall requires N calls.** Both `RecallRequest` and
`ReflectRequest` take a single `bank_id`. No list parameter exists. Our
fan-out is the only available shape.

<a id="e-33"></a>
**E-33 — SECURITY: the engine enforces no authentication or ACL on our
deployment.** With **no `Authorization` header at all**, a probe from inside
an agent container successfully ran `GET /v1/default/banks` and enumerated
**every bank in the fleet** — `overlord`, `marko`, `lawgpt`, `kdogg` and the
rest — with mission text and fact counts, then read `klanker`'s directives.
An unknown `bank_id` returns `200 {"items": []}`, not 404 or 403. `bank_id`
is a bare capability string, and the capability is not even required.

> [!CAUTION]
> This is an operational finding, not a design opinion, and it should be
> triaged on its own rather than waiting for this RFC. It bears directly on
> [C-02](#c-02): `single-tenant`'s per-user memory-isolation clause is a
> best-effort *should*, and the engine currently provides no enforcement
> underneath it.

<a id="e-33a"></a>
**E-33a — Blast radius, measured 2026-08-16. Not network-exposed; fully
fleet-exposed.** The severity of [E-33](#e-33) turns entirely on who can
reach `18888`, so it was tested rather than assumed.

- The listener is bound to **loopback only**: `/proc/net/tcp` shows
  `0100007F:49C8` state `0A` — `127.0.0.1:18888`, not `0.0.0.0`. A request
  to the host's LAN address does not connect. **Nothing off-box can reach
  it**, and no reverse proxy fronts it.
- But **every agent container runs `network_mode: host`** — verified for all
  12 (`klanker`, `overlord`, `carrie`, `finn`, `gymbro`, `clerk`, `ziggy`,
  `reggie`, `lawgpt`, `kdogg`, `marko`, `test-harness`) plus
  `switchroom-hindsight` itself. They therefore **share the host's loopback
  namespace**, so `127.0.0.1:18888` is the *same socket* for all of them.
  Confirmed by execing a read-only `GET /health` from a peer container
  (`gymbro` → `200`).

So the true statement is: the exposure is **not** an internet or LAN issue,
and **is** a total absence of isolation *between agents*. Any one of the 12
can read and write any other's entire memory bank, unauthenticated. That is
the security-relevant fact, because agents are deliberately
prompt-injectable surfaces — they ingest web pages, forwarded Telegram
content, and peer logs, all of which the fleet prompt already classifies as
untrusted. A successful injection in the least-trusted agent inherits full
read/write over the most sensitive banks.

The realistic mitigation is not inside Hindsight (it has no permission model
to configure — see below); it is network isolation, i.e. moving the engine
and the agents off shared `host` networking onto a bridge with only intended
reachability. That is an infrastructure change with its own blast radius and
is **the operator's call, not a change to make from here.**

Mitigations that exist per the docs but are not obviously in use: per-bank
`mcp_enabled_tools` (a tool allowlist, e.g. `["recall","reflect"]` — real,
but bypassable by anyone calling REST directly) and, on Cloud only,
bank-scoped API keys. Neither is a read-only credential; **no first-class
read-vs-write permission exists in either OSS or Cloud** per the docs sweep.

### Engine behaviour worth designing around

<a id="e-34"></a>
**E-34 — Consolidation reconciles contradictions over TIME, and the
concurrent case is undocumented.** The docs describe an explicit mechanism —
detect conflict, preserve history, synthesise a nuanced observation, update
freshness — with worked examples ("User was previously a React enthusiast…
but has now switched to Vue"; "Alice works at Meta (previously thought to
work at Google)"). Every example is a single narrative thread correcting
itself. **Nothing in the docs addresses two writers asserting incompatible
facts with no later-corrects-earlier ordering** — no source-trust
adjudication, no voting, no flag-for-review. For a 12-agent fleet
contemplating any shared bank, this is the load-bearing unknown, and the
vendor's "more writers make memory richer" line ([P-02](#p-02)) is not
supported by their own docs. Near-duplicate merging is separate and
threshold-based (`CONSOLIDATION_DEDUP_THRESHOLD`, default `0.97` cosine),
scoped **within the same tag set only**, and skipped entirely on Oracle.
`observation_scopes` on retain (`combined`/`shared`/`per_tag`/
`all_combinations`/`custom`) is the lever controlling which groupings
consolidate together.

<a id="e-35"></a>
**E-35 — Knowledge pages are the shape this redesign has been looking for.**
Per the docs, a knowledge page is a mental model with document defaults,
organised in a folder tree, created with
`{"mode":"delta","fact_types":["observation"],"exclude_mental_models":true,
"refresh_after_consolidation":true}`. The vendor's own rationale, verbatim:

> A file is where information goes to age… A knowledge page is a **projected
> view** over processed memory, the way a database view is not a table…
> pages heal themselves rather than rot: they aren't the storage, they're the
> rendering. Delete a page and nothing is lost — it re-projects from memory.

And on retrieval, verbatim:

> Search is a tool an agent chooses to call, visible in the transcript,
> rather than content pushed into its context on every turn… Use page search
> to pick a document; use recall for a specific fact.

That is simultaneously an answer to *what is always-on vs retrieved*
(question 1 below) and to *inspectability* ([C-01](#c-01)) — an agent-invoked
search is visible in the transcript in a way hidden injection never is.
`exclude_mental_models: true` is deliberate: "pages would cite each other and
drift into a feedback loop where one wrong claim propagates." Page search is
BM25+vector RRF with **no reranking**, deliberately, for speed — which
matters given [E-17](#e-17). Staleness is exposed as `is_stale`, a cheap
bank-wide proxy that can false-positive.

<a id="e-36"></a>
**E-36 — Retain has an under-used control surface, and a silent failure
mode.** `update_mode` (`replace` default / `append`, where delta retain skips
unchanged chunks), `observation_scopes`, `retain_mission`,
`retain_extraction_mode`, `document_id` idempotency, `operation_id` as an
idempotency key, and `reprocess` to re-extract already-stored text after
widening a mission. **The failure mode to guard:** a `retain_mission` that
excludes everything produces zero memories **with no error** — the retain
reports success. Detection is `memory_unit_count: 0` or the
`outcome="no_facts"` metric. Extraction is also explicitly **not
deterministic**: "a borderline document can yield facts on one run and none
on the next." Any design that leans on missions needs a zero-extraction
alarm ([C-01](#c-01): silent forgetting with no way to tell is a
never-ship).

<a id="e-38"></a>
**E-38 — RESOLVED: Hindsight has no concurrent-writer machinery at all.
Shared banks across agents are unsafe.** This was [E-34](#e-34)'s open
question and it is now answered from engine source at
`vectorize-io/hindsight` `main` @ `396f63a` (2026-08-15), all citations in
`hindsight-api-slim/hindsight_api/engine/consolidation/`. The finding is
*genuinely absent*, not *not-found-by-weak-search* — the researcher grepped
`needs_review` / `conflict_flag` / `requires_review` / `flagged` across the
engine and the only hits were unrelated prose and Postgres `ON CONFLICT`
upserts.

Four separate mechanisms one would expect, and what is actually there:

1. **No contradiction detector.** There is no dedicated routine. Resolution
   happens, if at all, inside the one batch-consolidation LLM call
   (`consolidator.py:2741-2895`). The only textual hook is processing rule 4
   "STATE CHANGES" (`prompts.py:42`) and the `deletes` rule "only when an
   observation is directly superseded or contradicted by new facts"
   (`prompts.py:152`). Both are framed as **one narrative evolving over
   time**. Nothing tells the model what to do when two facts conflict with
   no supersession signal.
2. **Writer identity never reaches the adjudicating call.** This is the
   decisive one. `_build_observations_for_llm` (`consolidator.py:2664-2696`)
   and `_fact_line` (`:2755-2767`) serialise only `id`, `text`,
   `occurred_start/end`, `mentioned_at`, and optional free-text `context`.
   `document_id`, `metadata`, and `tags` all exist on `MemoryFact`
   (`response_models.py:216-253`) and are **stripped before the prompt is
   built** — `prompts.py:154` explicitly says *"Do NOT include tags —
   handled automatically."* Tags scope which observations get pooled as
   candidates; they are never a "who said this" signal. **The LLM cannot
   weigh sources because it is never shown them.**
3. **No flag-for-review state exists.** No schema column, no state machine.
   Every UPDATE overwrites `text` wholesale
   (`consolidator.py:2405-2469`). The prior wording survives only in a
   separate `observation_history` audit table, and only when
   `enable_observation_history` is on (`:2284-2332`, `:2394-2401`). So the
   system **always writes something** — merge, overwrite, or create — and
   never surfaces the conflict.
4. **"Most recent wins" is not enforced in code.** `mentioned_at` is rolled
   up with `GREATEST(...)` (`consolidator.py:2426`, `_merge_max` at
   `:990-994`) — bookkeeping for "latest time this was touched," not a
   tie-breaker. The surviving **text** is whatever string the LLM chose
   (`new_text`, `:2337`, `:2417`). The model is told what `mentioned_at`
   *means* (`prompts.py:59,65`) but never told to prefer the later fact.
   The docs' "later corrects earlier" framing ([E-34](#e-34)) is therefore
   **model judgment per call, not a guarantee** — and judgment exercised
   without source identity.

The dedup path is confirmed separate and confirmed to *back off* on
conflict, which makes the exposure worse rather than better: threshold
`0.97` (`config.py:1258`, env `HINDSIGHT_API_CONSOLIDATION_DEDUP_THRESHOLD`
at `:662`), scoped `tags_match="all_strict"` (`consolidator.py:273`), top-5
candidates (`:155`), and its own prompt instructs *"If they differ in ANY
important detail — a number/quantity, a named entity or language, a
negation, or a condition — set 'action' to 'keep'"* (`:205-208`). So
genuine contradictions are deliberately passed through dedup untouched and
land in the main consolidation batch, i.e. in exactly the unconstrained,
source-blind path described above.

> [!CAUTION]
> **Design consequence, binding.** Two agents writing contradictory facts
> into one bank get **silent arbitrary resolution, not adjudication**. This
> disproves [P-02](#p-02) (the vendor's "more writers make memory richer"
> line) for our fleet's case, and it independently fails the job doc's
> never-ship bar ([C-01](#c-01)): a fact can be overwritten with no way for
> the user to tell, which is silent forgetting by definition.
>
> **A shared cross-agent bank is off the table** unless a writer-identity
> and conflict-surfacing layer is built *above* Hindsight. Per-agent banks
> plus explicit fan-out ([E-32](#e-32)) remain the design.
>
> One partial mitigation worth noting: `enable_observation_history`
> preserves prior text in an audit table. That does not prevent the silent
> overwrite, but it is the difference between *recoverable* and *gone*, and
> it should be verified as ON in our deployment regardless of what the
> redesign concludes.
>
> **Rev 7 naming correction ([E-82](#e-82)):** as a *bank-config key on our
> deployment*, `enable_observation_history` **does not exist** — a
> repo-wide grep returns zero hits, and the field that actually gates
> observation writes is **`enable_observations`**
> (`src/cli/doctor-observation-scopes.ts:381,697`). Live probe,
> `GET /v1/default/banks/klanker/config` (2026-08-16): the returned blob
> includes `"enable_observations": true` (and
> `"enable_auto_consolidation": true`) — so the precondition is satisfied
> for at least this bank. The engine-source flag name cited in mechanism
> 3 above is left as read from `consolidator.py`; the *actionable*
> migration check must use the real config key. Caveat carried from the
> probe: verified against exactly one bank's live config; the schema dump
> shows no differently-spelled key, but the remaining banks were not
> enumerated.

<a id="e-39"></a>
**E-39 — Knowledge pages are REAL at 0.9.0, entirely UNUSED, and NOT on the
MCP surface.** [E-35](#e-35) was docs-only evidence and was flagged as the
design's top unverified assumption. Probed live 2026-08-16, three findings:

1. **The feature exists and responds.** The REST route is
   `/v1/default/banks/{bank_id}/**knowledge-base**/...`, not `/knowledge/`.
   Methods, from the live spec: `GET tree`, `POST folders`, `POST pages`,
   `GET export`, `GET search` (query param `q`), `GET pages/{page_id}`,
   `PATCH`/`DELETE nodes/{node_id}`. `GET tree` → `200 {"roots":[]}`.
2. **Nothing in the fleet uses it.** `tree` returns `{"roots":[]}` for every
   bank checked — klanker, overlord, marko, clerk, assistant, carrie. Zero
   pages exist anywhere. This is entirely greenfield capability we are
   already running and have never touched.
3. **The MCP surface exposes none of it.** The live 32-tool `tools/list`
   contains **no** knowledge/page tool at all — no `search_knowledge_pages`,
   no `get_knowledge_page`, no `get_knowledge_tree`.

> [!IMPORTANT]
> Point 3 is the load-bearing one, and it is [E-09](#e-09)'s failure mode
> repeating exactly: those three tool names appear in this harness's
> deferred-tool listing, which is what made them look available. **They are
> not on the server.** Twice now, a capability has looked reachable because
> the harness advertised a name. The listing is not evidence; `tools/list`
> is.
>
> Design consequence: the pull-first story survives, but *not for free*. An
> agent cannot invoke page search directly today, so switchroom must build a
> REST-backed tool shim for it — the same shim shape [E-09](#e-09) already
> forces for directive deactivation. Two of the design's pillars now depend
> on switchroom wrapping REST because MCP under-exposes. That is a real,
> costed piece of work, and it should be stated as such rather than assumed
> away.

Methodological note for anyone extending this ledger: the first probe of
this feature returned `404` on `/knowledge/tree` and could easily have been
written up as "knowledge pages don't exist at 0.9.0." The path shape was
wrong. **A single negative probe is not a capability verdict** — check the
spec before concluding absence.

<a id="e-40"></a>
**E-40 — `disposition_*` is real and already populated on live banks.** The
design routes style/voice here. Confirmed on `klanker`'s bank config:
`disposition_skepticism: 4`, `disposition_literalism: 3`,
`disposition_empathy: 2`. Not hypothetical, and already carrying values
nobody set deliberately in this redesign — worth auditing fleet-wide before
leaning on it.

### Measured telemetry, 2026-08-16 — the cost, for real

Sources: the literal injected `<active_directives>` spans in persisted hook
payloads (`.claude/projects/*/*/tool-results/hook-*additionalContext.txt`,
30-day window), cross-checked against `recall_log.jsonl` at
`.claude/plugins/data/hindsight-memory-inline/state/` (present for all 12
agents), plus the Hindsight Postgres. Read-only throughout.

<a id="e-41"></a>
**E-41 — The real cost is ~48.7M directive input tokens per 30 days,
fleet-wide, and [E-07](#e-07)'s estimate was wrong in both directions.**
Per-injection cost measured at **~1.9-3.8k tokens for 9 of 11 agents** —
so the "~5-6k per turn" code comment **overstates the typical agent**. But
`overlord` is a severe outlier at **~6.8k tokens (27,044 chars) per
injection**, which the comment understates. Volume × size over 30 days:
**~48.7M fresh input tokens**, dominated by overlord (~27.4M across 4,048
injections) and klanker (~11.0M across 2,989). Two agents are two thirds of
the bill. This supersedes the estimate in [E-07](#e-07) as the number to
design against, and it means **per-agent variance matters more than the
fleet average** — a uniform cap would be aimed at the wrong problem.

<a id="e-42"></a>
**E-42 — The cap is not the live problem, confirmed at scale.** 194 active
directives across 14 banks, **zero inactive anywhere** (nothing has ever
been retired, in any bank — the lifecycle gap is total, not partial).
Counts: overlord and marko 26, clerk 25, klanker 24, tailing to 1. No bank
exceeds `MAX_DIRECTIVES=30`, and `directives_omitted` fired **zero times
across 26,773 `recall_log` rows**. The silent-drop risk is real in code but
has never once occurred. Corroborates [E-10](#e-10) with 30 days of data
rather than a snapshot.

<a id="e-43"></a>
**E-43 — CORRECTION: system-prompt duplication is not the waste.
Cross-bank duplication is.** A working assumption going into this was that
directives restate `CLAUDE.md`. Measured shingle overlap with `CLAUDE.md`
is **~0% for every directive in every bank** — that premise is wrong and
should not survive into the design. What is real:

- `no-confabulation` (1,029 chars) is **verbatim in all 13 banks**. Paid 13
  times over, every injection, forever.
- `windows-boxes-access-and-full-stop` exists as **divergent** copies —
  klanker 2,362 chars, overlord 3,567 chars. Same rule, drifted apart, no
  mechanism could ever have noticed.
- Five further shared copies across klanker/reggie/clerk/finn/carrie.
- One intra-bank near-duplicate: clerk's `always-invite-both-lisa-emails`
  (May) vs `invite-both-lisa-emails` (Aug), cosine 0.77, **both active**.

<a id="e-44"></a>
**E-44 — Influence is NOT measurable, and the design must stop pretending
otherwise.** Checked exhaustively: the Postgres `directives` table has no
counter ([E-29](#e-29) confirmed at the DB, not just the API), `audit_log`
has **0 rows**, and `recall_log` records only `directive_count`, never
*which* directives. The one genuine signal is an agent explicitly naming a
rule in its output, and it is sparse and asymmetric — overlord cites
`separate-review-and-merge` 15× and `no-confabulation` 10×, gymbro cites
`food-log-card-verbatim` 5×, and **most directives have never been cited
once**. That last fact proves nothing: silent compliance is the normal case
for a well-followed rule. **Citation counts must not be used as a
retirement signal** — they would preferentially delete rules that work
quietly.

<a id="e-45"></a>
**E-45 — Retirement CAN be grounded, on two deterministic signals rather
than age.** Named, evidenced candidates for retirement today:

- **Supersession** (deterministic, detectable): clerk's older lisa-emails
  copy, superseded by its own August rewrite.
- **Mechanization** — the rule is now enforced by code, so the prompt-level
  rule is dead weight: finn's `Inline-keyboard tap confirmation pattern`
  (now native gateway behaviour, #789); gymbro's
  `telegram-render-markdown-not-html` (largely mechanized by GFM
  rendering).
- **Category error** — a fact filed as a rule, which should be a memory:
  clerk's `pets-correction` and `carrie-spelling`.
- Age alone (ziggy's five 106-day directives) is the **weakest** signal and
  should not be sufficient on its own.

Two concrete recommendations follow, and both stand independent of the
redesign: **(a)** hoist the 13-copy `no-confabulation` into the injection
preamble template once — roughly 1k chars saved per injection fleet-wide
for **zero behaviour change**; **(b)** log injected directive IDs into
`recall_log` rows, which already carry `memory_ids`. (b) is cheap and turns
exposure from unmeasurable into measured, which is the missing input every
lifecycle proposal in this RFC has been guessing at.

### Vendor reference architecture, sourced 2026-08-16

From `hindsight.vectorize.io/llms-full.txt` (complete OSS docs dump) plus
the repo README. **OSS/self-hosted surface only** — `docs.hindsight.
vectorize.io` (Cloud) was not fetched in this pass, so treat Cloud absences
here as unverified rather than confirmed ([P-06](#p-06) still applies).

<a id="e-46"></a>
**E-46 — DECISIVE: the vendor explicitly calls per-turn injection an
anti-pattern.** From `developer/knowledge-pages.mdx`, verbatim:

> Search is a tool an agent *chooses* to call, visible in the transcript,
> rather than content pushed into its context on every turn. **Retrieval
> the agent asked for informs what it's doing; retrieval it didn't ask for
> tends to derail it.**

This is the strongest available authority on the RFC's central question,
and it is the vendor arguing *against* the thing our plugin does
([E-05](#e-05)). Note the claim is about **quality, not cost** — injected
retrieval is said to *derail* the agent, which is a stronger charge than
"wastes tokens" and one no measurement in this ledger has tested. It is
listed in the docs among the mistakes a naive integration makes.

<a id="e-47"></a>
**E-47 — Our reflect is 20-60× slower than the vendor's own stated
numbers. This is a tuning defect, not an inherent cost.** Vendor
`developer/performance.md` states: recall **100-600ms** (bottleneck: the
reranker), reflect **800-3000ms** (bottleneck: LLM generation), retain
500-2000ms/batch.

Measured on our deployment ([E-28](#e-28)): recall 0.60-0.75s — at the top
of the vendor's band but inside it. Reflect **51.5s and 87.0s** — against a
stated ceiling of 3s.

The vendor documents the likely cause directly, in a section titled
*"Tuning for Local & Small Environments"*: local deployments inherit
cloud-tuned defaults, and `HINDSIGHT_API_LLM_MAX_CONCURRENT=32` will
"starve any other client sharing the endpoint" on a local LLM server. They
also advise a **small, cheap extraction model rather than a frontier one** —
"Hindsight doesn't need a smart model" — and lowering
`consolidation_llm_batch_size` (e.g. to 2) on small models, because a large
batch "produces an oversized prompt and a long, error-prone response."

> [!IMPORTANT]
> [E-28](#e-28) concluded reflect "is not a hot-path mechanism at these
> latencies," and every design decision that routed around reflect inherited
> that. **That conclusion may be an artefact of our configuration, not of
> reflect.** At the vendor's stated 800-3000ms, reflect becomes a plausible
> session-start or background mechanism. This must be re-measured after
> tuning before any design forecloses on it. Ours runs
> `gpt-oss-20b-consolidation` via a local litellm endpoint — consistent with
> the vendor's own small-model warning applying to us.

<a id="e-48"></a>
**E-48 — A knowledge page IS a mental model, with the mechanics
pre-decided.** Verbatim from `developer/knowledge-pages.mdx`: *"A knowledge
page **is** a mental model... What's different is how much you have to know
to use one."*

A mental model is "a standing answer to a question about a bank" —
deliberately curated, where "you decide which questions deserve a permanent,
always-current answer," and fetching one is "a database read. No retrieval,
no synthesis, no LLM call, no waiting." A page is that same primitive with
opinionated defaults: built only from `observations`, never reading other
pages ("so pages can't cite each other into a feedback loop"), delta-
refreshed after consolidation, given a larger token budget (4096 vs 2048)
"because it's a document rather than an answer," and arranged in a
browsable folder tree.

**Choose by shape:** a bare mental model for a single Q&A-shaped standing
answer; a page where you'd otherwise hand-maintain a runbook or doc that
ages — *"Your raw documents remain the source of truth about what was said.
The pages are the reconciled truth about what holds."* This resolves the
design's mental-models-vs-pages question: it is not either/or, it is one
primitive at two levels of ceremony.

<a id="e-49"></a>
**E-49 — Bank templates are the vendor's reference deployment shape, and
are exactly what a 12-agent fleet needs.** `developer/api/bank-templates.
mdx`: a declarative JSON manifest bundling bank config (missions,
disposition, extraction mode, `entity_labels`), **mental models, and
directives** in one document. Pitched for "Onboarding — new users start with
a known-good configuration," "Sharing — distribute recommended setups as
portable JSON," and "Framework integrations — ship a recommended template
alongside your integration."

This is the mechanism [E-43](#e-43)'s divergence problem was crying out for:
`no-confabulation` verbatim in 13 banks and
`windows-boxes-access-and-full-stop` drifted into two incompatible copies
are both *template* problems, and the vendor already ships the template
primitive. A live template library exists at `/templates` (not fetched).

> [!CAUTION]
> **Correction (E-97, this pass): this entry read the vendor docs, not
> the deployed engine, and the docs description does not describe an
> apply-to-existing-banks operation on our engine.** `GET
> /openapi.json` on the running 0.9.0 engine (`127.0.0.1:18888`,
> re-verified live) lists exactly one bank-template route,
> `/v1/bank-template-schema`, and it is **GET only** — `POST` against it
> returns 405. It is a schema an agent reads when composing a bank, not
> a template it can apply to deactivate/replace directives on banks that
> already exist. Directives remain per-bank rows everywhere else in the
> schema (`/v1/default/banks/{bank_id}/directives`,
> `/v1/default/banks/{bank_id}/directives/{directive_id}`) — no
> cross-bank shared-directive primitive exists at all. "The vendor
> already ships the template primitive" is true only of the onboarding
> shape this entry itself named two sentences earlier; it does not carry
> over to retrofitting live banks, and design-v2.md §5 step 3, which
> leaned on this entry for exactly that, is REFUTED accordingly. A live
> audit (E-98) additionally found the `no-confabulation` count here (13)
> is one short of the deployed count (14 banks; a fifteenth,
> `switchroom-dev`, carries zero directives) and that all 14 copies are
> byte-identical — so even the dedup this entry motivated has nothing to
> dedup. The `windows-boxes-access-and-full-stop` drift stands exactly
> as measured (E-43) and remains a single-directive fix, not a template
> one.

<a id="e-50"></a>
**E-50 — Vendor-stated gotchas a naive integration hits.** Recorded so the
design can be checked against them:

1. `observation_scopes: []` silently falls back to `combined` — "shared"
   must be spelled `[[]]`, not `[]` (`:::caution`, `retain.mdx`).
2. **Tagged mental models default to `all_strict`** and silently return
   empty content when a broadly-tagged model refreshes against
   narrowly-tagged memories. Vendor recommends overriding to
   `tags_match: "any"` (`:::warning`, twice).
3. A too-narrow `retain_mission` yields **zero memories with no error** —
   corroborates [E-36](#e-36), detectable via `memory_unit_count: 0` or the
   `outcome="no_facts"` metric.
4. **`min_scores` must not be treated as calibrated confidence** — scores
   are "relative... not comparable" across queries and a fixed cutoff
   "risks silently dropping good results." **The vendor independently
   confirms [E-13](#e-13)**, which we learned the expensive way.
5. Supplying any custom `trigger` on a page **replaces** the default object
   rather than merging — silently resetting `fact_types`,
   `exclude_mental_models`, `refresh_after_consolidation`.
6. Per-turn injection (see [E-46](#e-46)).
7. Delta-mode mental models drift over many refreshes; vendor recommends a
   periodic clear+refresh (~48h) for long-lived delta models.

Two further architecture facts worth carrying: **bank-per-identity is the
intended model** — each bank gets its own MCP endpoint, "enforces isolation
— each MCP connection is scoped to a single bank," and tags are the
*opt-in* mechanism for the shared-bank case, not the default. That is
independent vendor corroboration of [E-38](#e-38)'s conclusion. And the
recall-vs-reflect decision table is explicit: recall for raw facts and
simple lookup, reflect when you want "reasoned interpretation,"
disposition-consistent responses, and directive enforcement.

<a id="p-12"></a>
**P-12 — openclaw's Hindsight plugin: push-based, and it uses none of the
curation layer.** Read at `vectorize-io/hindsight` main,
`hindsight-integrations/openclaw/` (README, `openclaw.plugin.json`,
`src/index.ts` 3131 lines, `src/types.ts`, `src/retain-queue.ts`), verified
by an independent second pass.

Injection is automatic on the `before_prompt_build` hook (`index.ts:2125-
2373`), wrapping results in `<hindsight_memories>` — the same push shape we
have. Caps: `recallMaxTokens` **1024** (`openclaw.plugin.json:225-230`),
`recallMaxQueryChars` 800, `recallTimeoutMs` 10s, `recallContextTurns` 1,
`recallTypes` **`["observation"]` only** — the consolidated view, not raw
facts. Retain fires every turn on `agent_end` plus a forced `session_end`
flush, and retains `tool_use`/`tool_result` blocks, filtering Hindsight's
own calls to avoid a feedback loop. Errors degrade silently — on Hindsight
downtime, memory just stops appearing.

**Directives: zero usage.** A `grep -rni directive` across the package hits
only two unrelated English-word comments. No mental models. Knowledge-page
tools exist but sit behind `enableKnowledgeTools`, **default `false`**.
Banks are per-`(agent, channel, user)` tuple by default (`index.ts:1127-
1181`) — multiple banks, not one.

> [!NOTE]
> Read under [P-10](#p-10)'s operator steer: this is a third integration
> that doesn't use directives, mental models, or pages. That is evidence
> about *comparator maturity*, not about whether the features work. It is
> also the third independent confirmation that a **1024-token recall cap**
> is the industry-normal budget, against our current unbounded block.

> [!NOTE]
> **Re-verified 2026-08-16** against the live integration docs
> (`hindsight.vectorize.io/sdks/integrations/openclaw`) and the source at
> `main` (`index.ts` still 3131 lines). Confirmed at line level:
> `DEFAULT_RECALL_TIMEOUT_MS = 10_000` (`index.ts:234`),
> `before_prompt_build` recall hook (`index.ts:2125`), retain on
> `agent_end` per turn plus a forced `session_end` flush
> (`index.ts:2691-2699`, shared path comment `:2375-2382`),
> `recallMaxTokens` default 1024 (`openclaw.plugin.json:225-230`),
> `recallTypes` default `["observation"]` (plugin.json + docs), bank per
> `(agent, channel, user)` via `dynamicBankGranularity` (docs "Memory
> Isolation"; `index.ts:1037-1039`), `<hindsight_memories>` feedback-loop
> stripping (`index.ts:489-493`). Two sharpenings: **(1) the recall is
> awaited inside `before_prompt_build`** — openclaw's injection is
> synchronous on the reply path (timeout → `debug` log + "skipping memory
> injection", `index.ts:2360-2367`), unlike Hermes's off-path prefetch
> ([P-08](#p-08)). **(2) The docs page argues FOR auto-recall**, verbatim:
> *"Traditional memory systems give agents a `search_memory` tool - but
> models don't use it consistently. Auto-recall solves this by injecting
> memories automatically before every turn."* — the vendor's chat-domain
> guidance defends the very mechanism their coding-domain docs call an
> anti-pattern ([E-46](#e-46)). See [P-14](#p-14) for what that split
> means.

<a id="p-13"></a>
**P-13 — The vendor built our exact architecture for Claude Code, then
superseded it.** `hindsight-integrations/claude-code/` is a five-component
push plugin: `session_start.py` (health check), **`recall.py` on
`UserPromptSubmit` injecting via `hookSpecificOutput.additionalContext`**,
`retain.py` on `Stop` (async, reads the session JSONL, chunk-retains every
N turns), `session_end.py`, and a stdio MCP server. `recallMaxTokens`
**1024**, `retainEveryNTurns` 10 with 2-turn overlap. **No `PreCompact`
hook.** That is switchroom's `hindsight-memory` plugin, feature for feature.

It has been replaced by `hindsight-integrations/coding-agents`
(`@vectorize-io/hindsight-coding-agents`), whose README states the older
per-agent integrations "are superseded by this package." Two changes matter:
banks move from one static `bankId: "claude_code"` to **per-repository**
(`coding-agent::{gitProject}`), shared across every agent and harness on
that repo; and the whole `recall*` / `retain*` config surface is
**deliberately not carried over** — "describes a pipeline this package
replaced, and reinterpreting them would be guesswork." Session start now
does bank config, conversation import, gitlog seed, per-commit diff
batching, and knowledge-page extraction, plus a reflect step
(`reflectTimeoutMs` default 120000ms, capped to 25s inside hook harnesses).

**This is the strongest trajectory evidence in the ledger.** Combined with
[E-46](#e-46), the vendor did not merely *advise* against per-turn recall
injection — they shipped it, learned, and retired the pipeline.

> [!WARNING]
> **Resolved 2026-08-16 — the README-only caveat is closed.** This entry
> originally read only READMEs ("no line-level implementation citations")
> and was flagged as a lead, not a fact. The full reference docs and the
> successor package's source have now been read ([E-63](#e-63)–[E-67](#e-67)),
> with three corrections to what is written above:
>
> 1. **"Per-repository, shared across every agent" is the *default*, not
>    the structure.** Bank resolution is a configurable template — static
>    `bankId`, `{harness}`/`{channel}`/`{user}` placeholders,
>    `mapPathToBank` — so per-agent banks are expressible. What is
>    structurally coding-shaped is the ingestion pipeline (git seed,
>    codebase survey, session import), not the bank id ([E-65](#e-65)).
> 2. **"Knowledge-page extraction plus a reflect step" at session start
>    undersold the design shift.** The successor's runtime does **no
>    per-turn recall injection at all** — reflect once per session
>    (25s-capped), pages pulled by tool only, roster re-injected every 10
>    turns, write on Stop ([E-63](#e-63)). The trajectory claim above is
>    thereby *strengthened*: the current production default is the
>    reflect-once + pull pattern, with per-turn injection removed on the
>    record as "phantom research".
> 3. **The `reflectTimeoutMs` 120000ms / 25s-hook-cap detail is confirmed
>    in source** (`HOOK_REFLECT_CAP_MS`, `hook.ts:73`) — and on our
>    deployment that cap is what makes the package inoperative
>    ([E-64](#e-64)).
>
> The [E-38](#e-38) point stands unchanged: nothing in the successor
> overrides the shared-bank rejection for our multi-agent case.

<a id="e-51"></a>
**E-51 — Compaction mechanics, and the fix for review BLOCKER 2.** From
Claude Code's own docs (`code.claude.com/docs/en/memory.md` and hooks/
compaction docs).

What **survives** compaction: the system prompt, output style, **root
`CLAUDE.md` and unscoped rules — re-injected from disk**, auto-memory
`MEMORY.md` — also re-injected from disk, and invoked skill bodies (capped
5,000 tokens each / 25,000 total). What is **dropped**: path-scoped rules,
nested/subdirectory `CLAUDE.md` files (until re-read), and the skill
listing.

> [!IMPORTANT]
> BLOCKER 2 held that a rule retired mid-session doesn't survive
> compaction — the stale session-start render persists and the retired rule
> silently resumes. **The mechanism that fixes this already exists:**
> content re-injected *from disk* at compaction is re-read, so a rules
> surface that lives in a root-level file Claude Code reloads picks up the
> retirement automatically, while anything rendered once by a `SessionStart`
> hook into conversation history does not. The design must put the rules
> surface on the reload path, not the render-once path.

Supporting constraints: the memory hierarchy is **merged, not
override-precedence**; `@path` imports resolve relative to the importing
file with a **max depth of 4 hops**; auto-loaded content is truncated at
**200 lines or 25KB, whichever comes first** — a hard ceiling any file-based
rules surface must fit inside. `UserPromptSubmit` and `SessionStart` both
inject via `hookSpecificOutput.additionalContext` with **no documented size
limit** (which is precisely how our directive block grew to 27KB
unchallenged, [E-42](#e-42)).

**Documentation gaps** (do not design against assumptions here): `PreCompact`'s
input/output contract is unspecified, `additionalContext` has no stated
cap, and there are no prescriptive token-cost benchmarks.

> [!NOTE]
> **Rev 7 ([E-81](#e-81)) — the PreCompact gap is closed, and there is a
> better tool.** `PreCompact`'s contract is now documented: input = common
> fields + `trigger` ("manual"|"auto") + `custom_instructions`; it CAN
> block compaction (exit 2 / `"decision":"block"`), but its
> `systemMessage` and `continue` output are **discarded** — PreCompact
> cannot inject content post-compaction. A `PostCompact` event **exists in
> CLI v2.1.233** (binary schema: `trigger`, `compact_summary`) — whether
> its output injects into the fresh context is unverified. And the
> deterministic post-compaction injection path is **already running in
> production**: `SessionStart` with source `compact` — empirically
> observed in a live session injecting a 14.7KB `<compact-recovery>`
> payload immediately after an auto-compaction (transcript JSONL,
> `hookName:"SessionStart:compact"`). If the design ever needs a
> belt-and-braces guarantee beyond the CLAUDE.md re-read, that hook is
> the proven vehicle.

<a id="e-52"></a>
**E-52 — What `recall()` actually does, and what it costs.** Engine source,
`hindsight-api-slim/hindsight_api/engine/`. Six stages
(`memory_engine.py:5709` `_search_impl`): temporal-constraint extraction
(CPU only); **4-way parallel retrieval** per fact type — semantic vector,
BM25 keyword, graph, temporal (`search/retrieval.py:797`); RRF fusion
(`memory_engine.py:6085`); **reranking**, default `"cross_encoder"`
(`:472`, `:6108-6157`); combined scoring; token-budget trim to
`max_tokens` (default 2048 facts).

The reranker is a **local CPU cross-encoder**,
`cross-encoder/ms-marco-MiniLM-L-6-v2` (`config.py:978,980`), swappable via
`HINDSIGHT_API_RERANKER_PROVIDER` (Cohere, Voyage, Jina, FlashRank, TEI,
LiteLLM, `none`).

**`recall()` makes no LLM call.** Embedding, BM25, rerank and scoring are
all non-LLM. LLM cost lives in `retain()` (fact extraction), consolidation
(own `ENV_CONSOLIDATION_LLM_*` block, batch 8), and `reflect()` (own
`ENV_REFLECT_LLM_*` block, agentic loop, `max_iterations` 10, 300s
wall-clock, 100K context cap). **Mental-model reads make no LLM call
either** — cached content, single lookup, cost paid once at refresh. That
last fact makes mental models the cheapest possible read in the system and
strengthens their case as the primary standing-answer surface
([E-48](#e-48)).

`budget` low/mid/high maps to `thinking_budget` — a graph-traversal node
limit — 100/300/1000 under the default `"fixed"` function
(`config.py:1394-1396`), and optionally to per-level reranker candidate
pools (default flat 300).

<a id="e-53"></a>
**E-53 — DECISIVE: `search_knowledge_pages` has no reranker, and the
rerank-free penalty is roughly 10× on top-1 precision.**
`memory_engine.py:14252-14267`, docstring verbatim: *"Fuses a full-text
(BM25) match over the page name + content with vector similarity... using
Reciprocal Rank Fusion, in a single round trip. **No reranker — this path
is tuned for latency.**"* Confirmed in the SQL at `:14305-14335` — single
CTE, no cross-encoder anywhere.

The vendor's own reranker leaderboard quantifies what that costs (LoComo
conv-43, 165 questions, 300-candidate pool, budget=mid):

| | MRR | R@1 | R@3 | R@5 |
|---|---|---|---|---|
| MiniLM-L6 (default) | 0.788 | 69.7% | 85.5% | 90.3% |
| **No reranker (RRF only)** | **0.183** | **6.7%** | **14.5%** | **29.7%** |

> [!WARNING]
> **This invalidates design decision 3.** The draft routed standing
> knowledge through `search_knowledge_pages`. That path is RRF-only, and
> RRF-only ordering is ~4.3× worse on MRR and ~10× worse on R@1. It is
> fine for "which page is roughly relevant" — a doc-level lookup feeding a
> whole page into context, which is what pages are *for*. It is **not** a
> substitute for `recall()` where the top result matters. The design must
> use pages as documents to fetch whole, never as a precision retrieval
> path. (This is separate from, and additional to, BLOCKER 1's finding that
> the tool isn't even on our MCP surface, [E-39](#e-39).)

Vendor caveats, recorded so this number isn't over-read: ground truth was
annotated from RRF then LLM-labelled, giving *"implicit lexical bias"* that
structurally favours a lexically-trained cross-encoder; 165 questions from
one conversation means *"confidence intervals are wide"*; and explicitly
*"these numbers... should not be read as a general reranker ranking."* The
MiniLM/Cohere/FlashRank spread is likely not significant. The
**rerank-vs-no-rerank** gap is an order of magnitude and survives those
caveats; the *choice of* reranker does not turn on this table.

> [!NOTE]
> **Rev 9 corrections, two, neither touching the claim.** (1) **Anchor
> drift — the line citation is from a non-deployed snapshot** (the third
> confirmed instance of the snapshot-vs-deployed trap, after E-70 and
> P-05): on the DEPLOYED 0.9.0 engine (`switchroom-hindsight`,
> `/app/api/hindsight_api/engine/memory_engine.py`, read from the
> running container 2026-08-16, per `probes/knowledge-pages-09.md`) the
> `search_knowledge_pages` docstring sits at **`:13578`** (`def` at
> `:13570`), verbatim as quoted — "No reranker — this path is tuned for
> latency" — with the RRF(k=60) two-arm SQL and no cross-encoder below
> it; deployed `:14252` is unrelated directive-deletion code. The FACT
> is verified true on the deployed artefact; only the anchor was taken
> from a different snapshot. (2) **Scope of the 6.7% table:** the
> numbers are the vendor's reranker leaderboard on the **recall
> pipeline** (LoComo conv-43, 300-candidate fact retrieval with the
> reranker off) — they were never measured on `search_knowledge_pages`
> itself, which is doc-level over on the order of ten pages, a regime
> where the rerank-free penalty is smaller. The table is carried as what
> it is: a measurement of what rerank-free RRF ordering costs at
> fact-retrieval scale, supporting the fetch-whole/never-fact-lookup
> discipline by analogy plus the verified absence of a reranker — not a
> benchmark of the page path. Design §7 and §10.3 carry matching
> clarifications at rev 9.

<a id="e-54"></a>
**E-54 — Our model choices match the vendor's own leaderboards.** Vendor
benchmark winners: `retain()` → **`openai/gpt-oss-20b`**; `reflect()` →
**`openai/gpt-oss-120b`**; reranker → MiniLM-L6; embeddings → BGE Small EN
v1.5. Our consolidation runs `gpt-oss-20b` ([E-47](#e-47)) — the vendor's
retain-tier winner, so extraction model choice is not a defect.

But the reflect tier's winner is the **120b**, and [E-47](#e-47)'s
unexplained 51.5-87.0s reflect latency sits against a vendor band of
800-3000ms. Two candidate causes now have names:
`HINDSIGHT_API_LLM_MAX_CONCURRENT=32` starving a local endpoint, and
possibly serving reflect from the smaller model. **Neither is confirmed** —
this needs a config read before any design decision leans on it.

<a id="e-55"></a>
**E-55 — Nobody has published retrieval quality at our bank size.** The
vendor's headline scores run on the Agent Memory Benchmark (LongMemEval-S
94.6%, LoCoMo10 92%, BEAM10M 64.1%), all claimed #1 — vendor's own claim,
independently checkable at `agentmemorybenchmark.ai`. BEAM scales by
**tokens**, not facts: 100K→10M, where 10M is glossed as "roughly a year of
daily agent conversations." Notably 1M (73.9%) scores *higher* than 500K
(71.1%), which the vendor reads as retrieval quality not degrading
monotonically with volume.

**No published curve maps quality against fact count or link count.** Our
banks hold ~265K facts / ~7.7M links. There is no vendor statement that
this is fine and none that it isn't — a genuine gap in what they publish,
not a green light. Also unmeasured anywhere: the `budget` low/mid/high
quality trade-off, and `search_knowledge_pages` accuracy (only `recall()`
is benchmarked, which is why [E-53](#e-53)'s number had to be inferred from
the reranker ablation).

<a id="e-56"></a>
**E-56 — Recency confirmed, and its practical effect is smaller than
assumed.** `search/reranking.py:38-57`, linear branch is exactly
`max(0.1, min(1.0, 1.0 - days_ago/window))` with a **365-day** window
(`config.py:1043`) — confirming [E-37](#e-37) word for word. Shape is
configurable (`linear` / `exponential` at 90-day half-life / `none`).

The nuance that matters: recency is **not** multiplied into the score
directly. It becomes a bounded boost, `1 + 0.2 * (recency - 0.5)`, and the
final score is `CE_normalized × recency_boost × temporal_boost ×
proof_count_boost` with caps of ±10% / ±10% / ±5% respectively
(`reranking.py:60-193`). **The cross-encoder score dominates; recency can
move a result by at most 10%.** Any design assuming old memories fade
meaningfully from ranking is wrong — they don't, and [E-37](#e-37)'s
"recency is scoring, not deletion" is even weaker than it sounds.

<a id="e-57"></a>
**E-57 — DECISIVE, AND MEASURED: the vendor benchmarked per-turn
auto-recall and it made agents *worse*.** Blog `hindsight.vectorize.io/
blog/2026/08/06/hindsight-0-9-0`. On their sde-bench harness, naive
per-prompt auto-recall scored **1.06 corrections/task against a no-memory
baseline of 0.97** — memory injected on every turn was a net negative.
The pattern that worked was **"reflect once + reflect-as-tool"**, cutting
corrections **33-65%**.

> [!IMPORTANT]
> This is the single most important entry in the ledger. [E-46](#e-46) was
> the vendor *asserting* per-turn injection derails agents; this is the
> vendor *measuring* it, against a control, with the harness closest to
> ours. It converts the pull-first direction from a cost argument into a
> **quality** argument, and it means our current architecture
> ([E-05](#e-05)) is plausibly worse than having no memory at all on the
> injection path.
>
> It also **rehabilitates `reflect`**, which the winning pattern is built
> from — and which this ledger had written off on latency
> ([E-28](#e-28)) that [E-47](#e-47) now shows is probably our
> misconfiguration, not the engine. **Re-measuring reflect after tuning is
> now the highest-priority open item in this RFC**, because the vendor's
> best-known-good architecture depends on it.

Caveat: sde-bench is a *software-engineering* harness and the metric is
corrections per task. Our fleet is not exclusively coding agents, so the
magnitude should not be assumed to transfer. The *sign* of the result —
per-turn injection underperforming no memory — is what binds.

> [!WARNING]
> **Downgraded 2026-08-16 (rev 7) — this entry is a vendor anecdote with a
> number, not evidence.** A dedicated sourcing probe
> (`probes/sde-bench-sources.md`, all sources fetched/cloned 2026-08-16)
> established three things:
>
> 1. **The 1.06/0.97 run exists only as one paragraph of blog prose.** No
>    output file, no config, no agent name, no model, no run count, no CI
>    exists anywhere public — and the prose itself concedes "on the suite
>    **as it stood then**", an earlier suite version whose task count is
>    unstated and which is absent from git history (the
>    `agent-memory-benchmark` repo is 36 commits total; sdebench arrived as
>    one squashed commit `7acca55`, so the pre-August iterations are not
>    recoverable). The promised "hardening journal" naming the losing run's
>    config is not published anywhere the probe could find as of
>    2026-08-16.
> 2. **The 0.09 delta is on the order of run-to-run noise.** Reconstructed
>    per-task JSON from the published final campaign
>    (`outputs/sdebench/*/coding/boltons.json`) gives a between-run sd of
>    ≈ 0.03–0.07 corrections/task per arm; with an unstated run count for
>    the losing run, 0.09 "is within ~1.3–3 sd of single-run noise — not a
>    reliable 'memory made it worse', and equally not a reliable 'memory
>    was neutral'" (probe verbatim). E-57 should never have carried the
>    weight it did, independent of [E-69](#e-69)'s reinterpretation.
> 3. **The positive arm IS well-evidenced.** The 3×3 final campaign is
>    published per-task and per-run; the probe's independent recomputation
>    reproduces the blog table to two decimals; **every hindsight run beat
>    every same-agent vanilla run (9/9), with non-overlapping per-agent
>    ranges**, and the winning runs' `context` fields carry an actual
>    synthesized "## Memory (reflect)" answer per task — the winning arm
>    injected a synthesized conclusion, not fragments.
>
> The IMPORTANT block above and this entry's closing caveat ("the *sign*…
> is what binds") are **retracted**: the sign is not established by this
> run. The defensible residue is directional only — naive per-prompt
> recall showed no benefit on that suite, while reflect-style synthesis
> showed a large, replicated one. Full sourcing record, incl. the
> self-run path that could actually settle the injection question:
> [E-79](#e-79).

<a id="e-58"></a>
**E-58 — What 0.9.0 actually added, and the one feature that changes the
design's shape.** From the changelog and both 0.9.0 blog posts.
**Knowledge Pages are the headline feature**, OSS not Cloud-gated (commit
`218e6d34b`). Also shipped: mental-model dry-run refresh + trace retention,
per-operation `llm_extra_body` overrides, a **reranker failover chain** and
per-budget candidate cap, structured reflect output in the Control Plane
(also OSS), **per-bank toggles for temporal search / graph expansion /
reranking during recall**, and a reliability fix the vendor flags with
"upgrading is recommended" (no pooled DB connection held across embedder
and LLM calls).

The design-relevant one: **`hindsight fs mount --bank <bank>` projects
knowledge pages to real files**, so "ordinary tools (`ls`/`grep`/editor)
work with zero SDK," arranged as a folder tree (`Architecture/`,
`Runbooks/`, `Decisions/`).

> [!NOTE]
> This composes directly with [E-51](#e-51). Claude Code **re-reads root
> `CLAUDE.md` and its `@path` imports from disk at compaction**. A mounted
> knowledge page is a file on disk. That is a route to a standing-knowledge
> surface that is engine-maintained, agent-readable with no tool call, and
> **automatically refreshed at compaction** — and it sidesteps
> [E-53](#e-53) entirely, because pages are fetched whole as documents
> rather than ranked by the rerank-free search path. Whether `fs mount` is
> viable in our container topology is **unverified** and must be probed
> before the design relies on it.

One further vendor datum worth recording: `recall`'s "prefer observations"
option was added **"via OpenClaw integration"** (`d19f54c77`) — the engine
grew a feature because a harness needed it. That is direct support for
[P-10](#p-10)'s steer: integration coverage lags engine capability, so a
comparator's non-use of a feature is not evidence against it.

<a id="e-59"></a>
**E-59 — The full live MCP tool list, enumerated. 32 tools, and the gaps
are now definitive.** `POST /mcp` `tools/list` against
`127.0.0.1:18888`, 2026-08-16. This closes the enumeration gap the design
flagged — previous entries recorded individual presence/absence, never the
whole set.

```
cancel_operation      clear_memories        clear_mental_model    create_bank
create_directive      create_mental_model   delete_bank           delete_directive
delete_document       delete_mental_model   get_bank              get_bank_stats
get_document          get_memory            get_mental_model      get_operation
invalidate_memory     list_banks            list_directives       list_documents
list_memories         list_mental_models    list_operations       list_tags
recall                reflect               refresh_mental_model  retain
sync_retain           update_bank           update_memory         update_mental_model
```

**Present, and the design may rely on them:** `invalidate_memory`
(correction path confirmed — was verify-or-shim), `get_mental_model` /
`list_mental_models` / `refresh_mental_model` / `update_mental_model`
(**the entire mental-model lifecycle is MCP-native**, which makes Branch B
buildable with no shim at all), `recall`, `reflect`.

**Absent, definitively:** every knowledge-page tool — no
`get_knowledge_page`, `get_knowledge_tree`, `search_knowledge_pages`
(confirming [E-39](#e-39)); and `deactivate_directive` /
`reactivate_directive` / `update_directive` (confirming [E-09](#e-09)).
Directive lifecycle on MCP is **create / list / delete only** — retiring a
rule means either a destructive delete or a REST shim.

> [!WARNING]
> **Corrected 2026-08-16 (same day, second probe) — the enumeration is
> right about the wrong surface.** The 32-tool list above is the
> **engine's** `/mcp` surface, re-verified today (`tools/list` against
> `127.0.0.1:18888/mcp` → the same 32 tools, still zero knowledge tools,
> still no `update_directive`). But agents do not connect to the engine's
> `/mcp` directly. Every agent's `hindsight` MCP entry is
> `switchroom hindsight-mcp-shim` (klanker's `.mcp.json`:
> `command: "/usr/local/bin/switchroom", args: ["hindsight-mcp-shim"]`,
> `HINDSIGHT_BANK_ID=klanker`) — a switchroom-owned stdio proxy that
> **synthesizes five extra tools on every `tools/list` path** (live,
> cached, and cold-boot fallback alike): `deactivate_directive`,
> `reactivate_directive`, `search_knowledge_pages`, `get_knowledge_page`,
> `get_knowledge_tree` (`src/cli/hindsight-mcp-shim.ts:34-49`, merge at
> `:1322` and `:1332-1339`). Live-verified end-to-end 2026-08-16 by
> driving the shim over stdio: `tools/list` → **37 tools** including all
> five; `get_knowledge_tree` on klanker's bank → a successful (empty-bank)
> response. Full detail in [E-73](#e-73).
>
> Three consequences. **(1) The design's operative conclusions from this
> entry are stale:** "pages have zero MCP tools" is false for the surface
> agents actually call, and §2.5's directive-deactivate shim — migration
> step 2 — is not future work, it is **already shipped and deployed**
> (`SYNTHESIZED_TOOL_TABLE`, `DirectiveAdmin`, `KnowledgeAdmin`).
> **(2) [E-53](#e-53) is untouched:** page search is still rerank-free at
> the engine; reachability does not make it a precision retrieval path.
> **(3) The methodological lesson inverts.** E-09 and E-39 both scolded
> the harness's deferred-tool listing for advertising names the server
> doesn't expose — but the listing was advertising the **shim's** surface,
> and the shim is the server agents talk to. The listing was right; the
> raw-backend `tools/list` was the wrong oracle for "what can an agent
> call". The durable rule: enumerate the surface *the caller is wired to*,
> not the backend behind it.

<a id="e-60"></a>
**E-60 — `hindsight fs mount` is NOT viable here. The design's primary
knowledge-page route is dead.** Probed 2026-08-16:

- `hindsight` CLI: **not on PATH in this agent container**.
- `hindsight` CLI: **not present in `switchroom-hindsight` either**.
- `/dev/fuse`: **absent**. No `fusermount` / `fusermount3` binary.

FUSE mounting would require `--device /dev/fuse` plus `SYS_ADMIN`
capability on each of 12 agent containers. That is a material privilege
escalation across the fleet, and it lands on a service that already has no
authentication ([E-33](#e-33)). Not worth it for a convenience read path.

> [!IMPORTANT]
> **Combined, [E-59](#e-59) and E-60 collapse the knowledge-page question.**
> Pages have **zero MCP tools** and **no filesystem projection**. The only
> possible route is a bespoke REST shim we build and maintain. Meanwhile
> [E-48](#e-48) established that *a knowledge page **is** a mental model
> with the mechanics pre-decided* — and the **entire mental-model lifecycle
> is already MCP-native** ([E-59](#e-59)), LLM-free at read time
> ([E-52](#e-52)).
>
> The design should therefore build the standing-knowledge surface on
> **mental models**, and treat knowledge pages as a deferred nice-to-have
> justified only by the folder-tree browsing ergonomics — which we cannot
> use anyway without the mount. This removes the design's largest
> unverified dependency and shrinks the shim to directive-deactivate alone.

<a id="e-61"></a>
**E-61 — RESOLVED: reflect is slow because it runs on the `claude-code`
provider, not because we mistuned it. [E-47](#e-47)'s hypothesis is
disproved.** Deployment config read 2026-08-16 with operator authorisation,
via a strict whitelist of tuning keys (no `*_API_KEY` / `*_TOKEN` /
`*_SECRET` selected, credentials in URLs redacted):

| Key | Value |
|---|---|
| `LLM_PROVIDER` | `claude-code` |
| `LLM_MODEL` | `claude-sonnet-5` |
| `REFLECT_LLM_PROVIDER` | `claude-code` |
| `REFLECT_LLM_MODEL` | `claude-sonnet-5` |
| `LLM_MAX_CONCURRENT` | **28** |
| `CONSOLIDATION_LLM_PROVIDER` | `litellm` |
| `CONSOLIDATION_LLM_MODEL` | `openai/gpt-oss-20b-consolidation` |
| `CONSOLIDATION_LLM_BATCH_SIZE` | **3** |
| `EMBEDDINGS_PROVIDER` | `onnx` |

[E-47](#e-47) guessed two causes and **both are wrong**.
`LLM_MAX_CONCURRENT` is 28, already below the 32 default the vendor warns
about. Reflect is **not** served by a small local model — it runs
`claude-sonnet-5`. Consolidation already uses the vendor's own retain-tier
benchmark winner ([E-54](#e-54)) at batch size 3, matching the vendor's
"lower it to ~2 on small models" guidance. **The deployment is tuned
sensibly; there is no misconfiguration to fix.**

The real cause is architectural. `reflect` is an agentic tool-calling loop
of up to **10 iterations** ([E-52](#e-52)), and every iteration is a full
round trip through the `claude-code` provider — the Claude CLI, not a
low-latency API endpoint. The vendor's 800-3000ms band assumes a fast
API-backed LLM. Ours cannot reach it without switching provider, and the
`claude-code` provider is precisely what satisfies the **claude-native /
subscription-honest** invariant. Moving reflect to a raw API endpoint to
win latency would trade an invariant for a benchmark.

> [!IMPORTANT]
> **This decides the design's reflect branch: take Branch B.** Reflect is
> not a hot-path mechanism for us and cannot be made into one at acceptable
> cost. The session-start orientation surface must come from a
> **cron-refreshed mental model** — cached, no LLM at read time
> ([E-52](#e-52)), entire lifecycle MCP-native ([E-59](#e-59)) — with
> `reflect` itself reserved for explicit user asks and scheduled refreshes,
> where 51-87s is affordable.
>
> Note this does **not** weaken [E-57](#e-57). The vendor's winning pattern
> was "reflect once + reflect-as-tool"; we keep both halves, we just serve
> the "once" from a pre-computed cache instead of a live call. The thing
> [E-57](#e-57) actually indicts — per-turn pushed injection — is removed
> either way. *(Rev 7: E-57 itself is downgraded to a vendor anecdote
> ([E-79](#e-79)) — but the winning-arm half leaned on here survives as
> the well-evidenced, replicated result, so this decision stands.)*

<a id="e-62"></a>
**E-62 — `@path` import behaviour at compaction is UNDOCUMENTED. Do not
design against it.** Targeted docs check, 2026-08-16, against
`code.claude.com/docs`.

What the docs **do** say, three times over, is that expansion is a
launch-time operation: *"Imported files are **expanded and loaded into
context at launch**"* (`memory.md:95`), *"Claude **loads the imported file
at session start**"* (`:129`), *"imported files **load at launch**"*
(`:445`). And separately, that after `/compact` *"Project-root CLAUDE.md and
unscoped rules"* are *"**Re-injected from disk**"* (`context-window.md`).

What the docs **never** state is whether that re-injection **re-expands**
the imports or merely reloads the already-expanded text. Also silent: when
a mid-session edit to an imported file becomes visible, and whether any
documented mechanism forces a mid-session re-read (none found).

> [!IMPORTANT]
> This confirms review **B-1**. The design cited [E-51](#e-51) three times
> for a claim [E-51](#e-51) does not make. The behaviour is a coin-flip
> between two undocumented outcomes, and the losing side silently
> resurrects retired rules after compaction — with the per-turn directive
> block, today's accidental backstop, already deleted.
>
> **Resolution: move the rules ledger out of an import and into the root
> `CLAUDE.md` itself**, where re-injection from disk IS documented. This
> dissolves B-1 rather than betting on the ambiguity. The cost is that
> rules no longer live in a separate file.
>
> That cost is smaller than it looks here: switchroom's agent-root
> `CLAUDE.md` already carries a **preserved `# --- Yours ---` section**
> that survives `apply` regeneration. The rules ledger belongs there —
> documented reload semantics *and* apply-durable. **Whether the preserved
> section counts as "unscoped rules" for re-injection purposes is itself
> unverified** and must be probed before step 5 of the migration.

One further correction to [E-51](#e-51): the **25KB cap applies to auto-memory
`MEMORY.md`, not to `CLAUDE.md`**, which has only a 200-line *guideline*
and no documented hard limit. And splitting into imports *"doesn't reduce
context, since imported files load at launch"* — so the byte budget must be
measured on the fully-expanded total, never per-file.

> [!NOTE]
> **Rev 7 ([E-81](#e-81)) — the preserved-section question is malformed,
> and dissolves.** The unscoped/path-scoped distinction is a **file-level**
> distinction, not a section-level one: docs verbatim, *"Project-root
> CLAUDE.md survives compaction: after `/compact`, Claude re-reads it from
> disk and re-injects it into the session"* — what is NOT re-injected
> automatically is nested CLAUDE.md files and `paths:`-frontmatter rules,
> i.e. other files. Claude Code has no concept of sections inside the root
> file: the probe's own live session (v2.1.233) carries root CLAUDE.md as
> a single whole-file `# claudeMd` block, `# --- Yours ---` marker and
> everything after it included, verbatim — the marker is a switchroom
> `apply`-time convention the CLI is blind to. So the preserved section
> rides along with the documented whole-file re-read. **Honest limit,
> carried verbatim:** the definitive in-situ probe (mutate the preserved
> section → force `/compact` → ask for the mutated text) "has NOT been
> run and remains the definitive test" — the transcript JSONL does not
> persist the claudeMd injection, so the probe's 4 observed compactions
> cannot show the post-compaction content directly. Design consequence:
> step 5 is safe to gate on docs + mechanism, with the mutate-and-compact
> probe kept as a cheap **post-step-5 canary**, not a precondition
> (design §5 step 1(f), §8.1 — resolved).

<a id="e-37"></a>
**E-37 — Recency is scoring, not deletion.** Recall applies
`clamp(1.0 - days_ago/365, 0.1, 1.0)` — linear decay over a year, floored at
a 8% penalty. There is no TTL and no decay-deletion feature. Pruning is
manual: `clear_memories`, `clear_memory_observations`, `invalidate_memory`,
document reprocess. The docs state mechanisms but give **no guidance on when
to prune**.

### The vendor's coding-agents package, verified at reference + source, 2026-08-16

[P-13](#p-13) was flagged as README-only evidence. This pass closes it: the
full reference (`hindsight.vectorize.io/sdks/integrations/coding-agents`,
anchors `#reference` and `#migrating-from-the-per-agent-plugins`, fetched
2026-08-16) plus the package source at `vectorize-io/hindsight` `main`
(`hindsight-integrations/coding-agents/src/`), read file-by-file for the
Claude Code path. The question under test: **should switchroom adopt
`@vectorize-io/hindsight-coding-agents` instead of maintaining
`hindsight-memory`?** Verdict, decided by [E-64](#e-64): **no** — and the
package's own architecture independently corroborates this RFC's design
([E-63](#e-63), [E-68](#e-68)).

<a id="e-63"></a>
**E-63 — The vendor's current production integration has NO per-turn recall
injection. Its runtime is reflect-once + pull-tools + Stop-write — the same
shape as this RFC's design.** Source: `src/core/hook.ts` (the shared runtime
for all hook harnesses, including Claude Code). What actually runs:

- **Per prompt (`UserPromptSubmit`):** reflect **once per session** on the
  first prompt, `budget: "low"`, hard-capped at 25s (`HOOK_REFLECT_CAP_MS =
  25_000`, `hook.ts:73`), cached per session, injected **exactly once** —
  the code comment is explicit: *"The reflect block is injected exactly
  ONCE, the turn reflect ran. No cadence re-injection: replaying the turn-1
  synthesis at arbitrary later turns reads as random noise once the session
  drifts"* (`hook.ts:176-180`). Knowledge pages are **deliberately not
  auto-injected**: *"the agent pulls them through
  `hindsight_search_knowledge_pages` when a question warrants it — an
  unprompted injection on every turn (even a plain "yes") read as phantom
  research"* (`hook.ts:181-184`). The only recurring injection is a
  titles-only **page roster + tool guide** every `pageRefreshEveryTurns`
  (default 10) user turns — tens of tokens, an index, not content.
- **Session start (`SessionStart` hook):** background git-history seed of a
  cold repo's bank + knowledge-page bank-mission injection
  (`claude-sessionstart-hook.ts`).
- **On write (`Stop` hook):** session transcript retained
  (`claude-stop-hook.ts`; reference: "hook harnesses always write on
  Stop"). Per-turn transcript upsert exists only on the *plugin* harnesses
  (opencode, Kilo — `retainSessions`), and it is a background **write**,
  not an injection.
- **Pull surface:** the package ships its **own stdio MCP server**
  (`mcp-server.ts`) exposing exactly 8 tools (`knowledge-tools.ts:70-215`):
  `hindsight_sync_status`, `hindsight_diagnose`,
  `hindsight_search_knowledge_pages`, `hindsight_list_knowledge_pages`,
  `hindsight_read_knowledge_page`, `hindsight_reflect`,
  `hindsight_capture_initiative`, `hindsight_ingest_document`. This is how
  pages become tool-reachable despite the engine MCP exposing none
  ([E-59](#e-59)) — a REST-wrapping shim, exactly the shape this RFC costed.
- **Failure honesty:** every reflect/pages outcome lands in a structured
  diag file — *"a memory-less session can't masquerade as a memory
  session"* (`hook.ts:12-13`); a failed reflect emits a one-line user
  notice (`hook.ts:201-207`). Independent convergence on this RFC's P7.

Two stale-docstring traps, recorded so nobody re-derives the wrong
architecture from them: `claude-hook.ts:10-12` still says "recall every
prompt", and `hook.ts:7-9`'s header says page sections are injected every
turn — **both contradict the body code**, which injects neither. Trust the
runtime (`buildHookOutput`), not the comments.

> [!IMPORTANT]
> This completes [P-13](#p-13)'s trajectory evidence at line level: the
> vendor shipped per-turn recall push ([P-13](#p-13)), reported it losing
> ([E-57](#e-57) — downgraded at rev 7 to a vendor anecdote,
> [E-79](#e-79)), and their **current production default** is
> reflect-once + agent-invoked pull + Stop-write with per-turn injection
> deliberately removed and documented as noise ("phantom research"). This
> RFC's Surfaces B/C/D are the same pattern. The strongest possible
> corroboration short of running it ourselves.

<a id="e-64"></a>
**E-64 — DECISIVE AGAINST ADOPTION: the package's central mechanism is
structurally inoperative on our deployment.** The once-per-session reflect
is hard-capped at **25s** inside the hook window (`hook.ts:66-73`, with an
INVARIANT comment: the cap "MUST stay below every harness's
UserPromptSubmit hook timeout (currently 30s)"). On timeout the catch
caches `reflectAnswer = ""` — *"ran and failed — don't retry every turn"*
(`hook.ts:134`) — logs *"reflect failed — session runs without memory"*,
and the session proceeds **memoryless** with a one-line notice.

Our reflect at `budget: "low"` measures **51.5–87.0s** ([E-28](#e-28)),
and that latency is architectural on the invariant-pinned `claude-code`
provider ([E-61](#e-61)), not tunable. So on our deployment the package's
auto-reflect would time out on **essentially every session**: the
integration degrades permanently to its no-memory mode plus pull tools.
Adopting it means adopting a session-start surface that never fires —
unless we switch reflect to a fast API provider, which trades the
claude-native / subscription-honest invariant for a benchmark
([C-03](#c-03), [E-61](#e-61)).

> [!IMPORTANT]
> Two consequences. **(1) Do not adopt:** the one thing the package does
> that our design also wants — orientation at session start — is exactly
> the thing that cannot work here. **(2) Independent corroboration of
> Branch B:** even the vendor treats hook-time reflect as best-effort
> under a hard cap and accepts memoryless sessions as the degraded mode.
> This RFC's cron-refreshed orientation mental model ([E-61](#e-61)'s
> Branch B) serves the same "reflect once" slot from cache in
> milliseconds — on a slow provider it is **strictly better than the
> vendor's own degraded mode**, which is no orientation at all.

<a id="e-65"></a>
**E-65 — Bank topology: the default is per-repo, but resolution is fully
configurable; the *ingestion pipeline* is what stays repo-shaped.**
Reference `#reference` + `#bank-resolution`: default `bankIdTemplate` is
`"coding-agent::{gitProject}"` (one bank per repo, shared across
harnesses), but the surface offers static `bankId`, template placeholders
(`{gitProject}`, `{project}`, `{harness}`, `{channel}`/`{user}` from env),
`mapPathToBank` (longest-prefix path routing), `banks.<id>` rename/converge
and per-bank behavioural overrides, `harnesses.<name>` per-agent overrides,
and `optInOnly`. A 12-persona-agent fleet's one-bank-per-agent topology is
therefore *expressible* — e.g. static `bankId` per agent container's
`~/.hindsight/coding-agent.json`.

What is **not** configurable away is what the package feeds a bank: git
history seed (`autoSeed`/`seedLimit`/`gitIngest`), a headless **codebase
survey** of repo structure (`codebaseSurvey`), coding-session transcript
retain, and knowledge pages curated around "architecture, conventions,
in-flight initiatives". For a non-git working directory `{gitProject}`
falls back to the directory basename and the git machinery idles — the
package runs, but its entire value proposition (the "last mile" of a code
fix living in git history and past coding sessions) is absent. For our
fleet — persona agents whose work is mostly not repo-scoped — the pipeline
feeds the wrong content or none.

**Correction to [P-13](#p-13):** "structurally repo-shaped" is wrong at
the bank-resolution layer (that layer is a template) and right at the
ingestion layer (that layer *is* the product).

<a id="e-66"></a>
**E-66 — Invariant and operational frictions of adoption, enumerated.**
From the reference (`#reference`, `#where-memory-lives`, `#install`):

1. **`claude -p` by default.** `codebaseSurvey` defaults `true` and runs a
   headless survey via the harness CLI — the Claude recipe is `claude -p
   --model haiku --max-budget-usd 2` (`surveyModel`, `surveyBudgetUsd`).
   The fleet has an explicit `eliminate-claude-p` programme and the
   subscription-honest pillar; `--max-budget-usd` is API-billing
   semantics. Config-off, but the default breaches fleet policy.
2. **Cloud by default.** `apiUrl` defaults to
   `https://api.hindsight.vectorize.io` — memory text off-box unless
   `--server self-hosted` is chosen ([C-02](#c-02)). Configurable; the
   migration path even auto-adopts an existing endpoint config.
3. **Installer owns wiring we already own.** `install claude-code` merges
   3 hooks into `~/.claude/settings.json`, registers MCP via `claude mcp
   add` (user scope), and ships a companion skill into `~/.claude/skills/`
   — all surfaces switchroom's `apply` pipeline generates and reconciles.
   Coexistence with our hooks is mechanically possible (Claude Code runs
   multiple hooks) but functionally incoherent: double Stop-retain into
   different banks, two competing session-start injections, and an
   installer and `apply` fighting over the same files.
4. **Daemon mode prefers raw API keys** (`OPENAI_API_KEY` /
   `ANTHROPIC_API_KEY` / … for local extraction, falling back to the
   Claude Code CLI) — moot for us (we run self-hosted), listed for
   completeness.

<a id="e-67"></a>
**E-67 — What the package does not have, and what its migration path
actually migrates.** Absences first, from the full reference + source
sweep: **no directive tools, no mental-model tools, no rules lifecycle of
any kind** — its 8-tool surface ([E-63](#e-63)) has no recall tool and no
retain tool either (writes go through the Stop hook,
`hindsight_ingest_document`, and `hindsight_capture_initiative`). Every
curation-layer need this RFC has — rules with provenance and retirement,
an orientation mental model, operator-gated writes — is outside the
package's scope.

The migration guide (`#migrating-from-the-per-agent-plugins`) migrates
exactly two things off the **vendor's own** old per-agent plugins: the
server endpoint (auto-adopted from `~/.hindsight/claude-code.json`) and
conversations — `--import-conversations` re-extracts **local transcripts**
(cost: "tokens roughly in proportion to the history imported"; idempotent,
"ingestion dedups by document id"), matching a session to a repo **only**
when the transcript records its cwd; sessions recording nothing are
skipped and counted. The old bank is deliberately not the source (it
cannot be split by repo), and the old behavioural config — "12 `recall*`,
7 `retain*`, `bankMission`/`retainMission`, `dynamicBankGranularity`" — is
deliberately dropped: "describes a pipeline this package replaced, and
reinterpreting them would be guesswork."

**For switchroom the guide is moot in both directions** ([P-04](#p-04)):
our `hindsight-memory` shares no lineage with the superseded plugins the
guide migrates from, our banks are already live on the target engine (no
transcript re-import needed — the memories exist), and re-running
`--import-conversations` over persona-agent Telegram transcripts would
re-extract into per-*repo* banks keyed off container working directories,
which is the wrong topology outright ([E-65](#e-65)).

<a id="e-68"></a>
**E-68 — The vendor's recall-vs-reflect guidance, read in full, supports
this RFC's verb split — including serving orientation from a cached mental
model.** `developer/reflect#when-to-use-reflect`, fetched 2026-08-16. The
decision table verbatim: use `recall()` for "You need raw facts / You're
building your own reasoning / You need maximum control / Simple fact
lookup"; use `reflect()` for "You need reasoned interpretation / You want
disposition-consistent responses / You want the bank to 'think' for itself
/ Forming recommendations." The guidance is about **capability, not
placement**: nothing on the page prescribes reflect for a hot or per-turn
path, and the vendor's own harness caps hook-time reflect at 25s and
accepts none at all ([E-64](#e-64)).

Two further statements bear directly on Surface B's cache move, same page
(`#hierarchical-retrieval-strategy`): *"**Mental models** are saved
reflect responses that you create for frequently asked questions. They're
checked first because they represent explicitly curated knowledge"* — the
reflect agent's own retrieval hierarchy is mental models → observations →
raw facts. A cron-refreshed orientation mental model *is* a saved reflect
response to the standing question "what context should this agent hold",
i.e. the design's cache is the vendor's own primitive used exactly as
described, not a workaround. One genuine coupling to carry
(`#directives-hard-rules`): **directives bind only during reflect** —
*"hard rules that the agent must follow when they apply to the current
reflect scope"* ([E-03](#e-03) confirmed at the current docs). A design
that takes reflect off the hot path therefore gets **no directive
enforcement on the hot path** — which is why always-on rules must live on
a client-owned surface (this RFC's rules block) and engine directives are
scoped to reflect-time guardrails, applied when the orientation model
refreshes ([E-27](#e-27)).

### Second adversarial pass, 2026-08-16 — the comparators vs the naive arm, at source level

Added by the independent review against the operator steer "harness stays
Claude CLI, behaviour converges on openclaw + Hermes." Hermes read at the
**pinned commit `460d345`** (now the authority; [P-07](#p-07)–[P-11](#p-11)
re-verified in place); openclaw read at live docs + `main` source
([P-12](#p-12) re-verified); the 0.9.0 blog and Claude Code hooks reference
fetched fresh.

<a id="e-69"></a>
**E-69 — What [E-57](#e-57)'s losing arm actually was, mechanism-level —
and what its winning arm actually injected.** From the 0.9.0 blog
(`/blog/2026/08/06/hindsight-0-9-0`, fetched 2026-08-16), verbatim:

> Our integrations did what most of the ecosystem does: **automatic recall
> on every prompt** — embed the message, retrieve similar memories, inject
> them.

Two named failure mechanisms, both quoted: *"Scattered memories break
focus. Recall returns fragments — a handful of loosely similar snippets,
each plausible, none synthesized… feeding it scattered,
confidently-injected fragments doesn't inform the mission, it derails
it"*; and *"Never add work to the hot path. Per-prompt recall put a
retrieval round-trip in front of every single message."* So the penalised
arm is specifically: **raw similarity-fragment retrieval, unsynthesized,
injected synchronously on the reply path, every prompt, on a coding
benchmark.**

The winning arm, same post: *"the plugin reflects once, on the first
prompt, caches the synthesis, and **re-injects it every turn**."* The
benchmarked winner was therefore NOT injection-free — it re-pushed the
cached reflect synthesis per turn. The once-only injection in today's
source ([E-63](#e-63): "no cadence re-injection… reads as random noise")
is a **post-benchmark refinement, not the measured configuration.** Two
consequences: (a) E-57 penalises *fragment* injection, not injection per
se — what it validates is *synthesized-vs-fragment* content and
*off-vs-on hot path* timing; (b) nobody has measured once-only vs
per-turn re-injection of the cached synthesis — E-63's "random noise"
comment is engineering judgement, not benchmark data.

> [!WARNING]
> **Rev 7 labelling ([E-79](#e-79)): this entry's characterization of the
> losing arm is interpretation of blog prose — directionally plausible,
> unverifiable.** The sourcing probe (`probes/sde-bench-sources.md`) found
> no output file, no config, no agent name, no run count, and no suite
> version for the 1.06 run anywhere public; the exact configuration —
> agent, model, suite version/task count, recall top-k/budget/token cap,
> memory types, sync/async injection point — is **not recoverable from any
> public source**. What the prose does support: "raw fragments" is stated
> ("Recall returns fragments — a handful of loosely similar snippets, each
> plausible, none synthesized"), as is per-prompt hot-path timing
> ("per-prompt recall put a retrieval round-trip in front of every single
> message"). But "token cap, count, and whether injection blocked the
> reply path are **prose, not config**. The walk-back is an interpretation
> of marketing narrative, and remains exactly that" (probe verbatim). The
> current opencode plugin's defaults (recallBudget "mid",
> recallMaxTokens 1024, per-session dedup at HEAD) are circumstantial
> context only and **must not be backdated onto the losing run**. What IS
> confirmed independently: the coding domain (61 bug-fix tasks in
> `boltons`, pytest-graded — the sde-bench README and harness), and that
> the bench's bank is pre-seeded with planted decisive answers plus 140
> decoy conversations against a strong vanilla baseline — a workload
> materially different from our observation-recall channel. Since E-57 is
> itself downgraded, neither E-57 nor this entry decides the fleet-wide
> per-turn-injection question; the deciding evidence would be a self-run
> arm matching our actual configuration ([E-79](#e-79)).

<a id="e-70"></a>
**E-70 — Switchroom's per-turn recall push is closer to E-69's losing arm
than either comparator's, on a config default nobody had surfaced:
observations are EXCLUDED from our recall.** Read at
`vendor/hindsight-memory/scripts/lib/config.py:103` — default
`"recallTypes": ["world", "experience"]` (also `:567`,
`DEFAULT_RECALL_FACT_TYPES = ("world", "experience")`) — and
`scripts/recall.py:2110,2120` (`types=resolved_recall_types`,
`prefer_observations=config.get("recallPreferObservations", True)`).
Both comparators default to `["observation"]` **only** — the exact
inverse ([P-09](#p-09), [P-12](#p-12)) — citing token density and
dedup. Ours injects only raw fragments, never the consolidated layer:
the shape E-69 names as the failure.

Worse: `prefer_observations=True` is a **no-op under our own default.**
The live 0.9.0 engine schema (`/openapi.json`, `RecallRequest.
prefer_observations`, fetched 2026-08-16) states verbatim: *"No effect
unless 'observation' and at least one raw type are both requested"* — and
a live probe on the `klanker` bank (2026-08-16, read-only) returned
byte-identical 12-result sets for `prefer_observations` true vs false at
`types=["world","experience"]`. The design's "keep `prefer_observations`"
(§2.3 rev 4) preserves a flag that currently does nothing.

> [!NOTE]
> **Rev 7 — the types question has now been measured live** (15 queries ×
> 3 configs × 3 banks, one pass, 2026-08-16): combined
> `["world","experience","observation"]` was never worse than the current
> config and strictly better on 5/15 queries; the "observation-only would
> starve" hypothesis is not supported by corpus composition (observations
> are 16–33% of facts in every bank measured). Full result, sample limits
> carried verbatim: [E-80](#e-80). The measurement is suggestive, not
> conclusive — but it points the same direction as this entry's config
> analysis, and the design ships combined types at step 6a on it.

> [!CAUTION]
> **REFUTED 2026-08-16 (rev 9) — this entry read the wrong config tier.
> The deployed fleet already recalls all three types, and
> `prefer_observations` is live and effective.** Every anchor this entry
> cited is real code — but it is the **vendored plugin's DEFAULTS tier**
> (`vendor/hindsight-memory/scripts/lib/config.py:103` and `:567`), the
> bottom of a precedence chain the same file documents as
> `DEFAULTS → settings.json → env` (`config.py:831-850`,
> `load_config`). Switchroom stamps its own overrides over the copied
> `settings.json` at scaffold time, and that stamp is the tier that
> binds. Verified live, 2026-08-16, all read-only:
>
> 1. **The override site:** `src/agents/scaffold.ts:3968` —
>    `settings.recallTypes = ["world", "experience", "observation"]`,
>    with the surrounding comment (`:3950-3967`) stating in terms this is
>    "the ON-BY-DEFAULT value for every agent on every install",
>    operators opt OUT via `memory.recall.types`, and start.sh exports
>    `HINDSIGHT_RECALL_TYPES` **only when overridden**.
> 2. **The operator schema:** `src/config/schema.ts:863-871` —
>    `memory.recall.types` documents "Switchroom default is
>    `["world","experience","observation"]`" and describes
>    `["world","experience"]` as the opt-out value.
> 3. **Deployed reality:** all 12 agents under
>    `/host-home/.switchroom/agents/*/.claude/plugins/hindsight-memory/settings.json`
>    carry `recallTypes: ["world","experience","observation"]`. Zero
>    exceptions; no `HINDSIGHT_RECALL_TYPES` env override exists on any
>    agent, and `switchroom.yaml` sets no `memory.recall.types` opt-out.
> 4. **`prefer_observations` is on and NOT a no-op:**
>    `HINDSIGHT_RECALL_PREFER_OBSERVATIONS=true` is exported in 11/12
>    agents' `start.sh` (e.g. klanker `start.sh:1136`; test-harness lacks
>    the export but inherits the same `True` from `config.py:107`), and
>    `recall.py:2120` passes it per call. Since observation AND at least
>    one raw type are both requested on every live recall, the schema's
>    own conditionality clause is **satisfied**, not violated.
>
> **How the error entered — the documented trap, walked into.** The
> vendored tree's own `CLAUDE.md`
> (`vendor/hindsight-memory/CLAUDE.md:25-38`) warns verbatim: "Trap:
> `settings.json` here is NOT what switchroom installs … reading the
> vendored `settings.json` to learn live behaviour is actively
> misleading" — and names `recallTypes` as its concrete example
> (vendored `["world","experience"]` vs stamped
> `["world","experience","observation"]`), directing readers to the
> `scaffold.ts` override site or the deployed per-agent `settings.json`.
> This entry cited the vendored Python defaults and never checked the
> stamp. The override predates this entry's authorship: it is present at
> the oldest commit reachable in this worktree (`139a6bf`, 2026-08-13),
> three days before E-70 was written.
>
> **What survives:** (a) the engine-schema reading — "No effect unless
> 'observation' and at least one raw type are both requested" — is a
> correct statement of `prefer_observations`' conditionality; (b) the
> live probe (byte-identical result sets at explicit
> `types=["world","experience"]`) is a valid measurement of **that
> parameterization**, which is the opt-out config, not ours; (c) the
> comparator facts (both default to `["observation"]` only, P-09/P-12)
> stand. **What is refuted:** "observations are EXCLUDED from our
> recall"; "our per-turn push is closer to E-69's losing arm" on the
> content axis; "`prefer_observations=True` is a no-op under our own
> default"; and every downstream framing of combined-types +
> `prefer_observations` as a change to be shipped — it is the shipped,
> fleet-wide status quo. Design §2.3, §5 step 6a, §6, §7, §8.11 and
> [E-80](#e-80)'s framing are corrected at rev 9 accordingly.

<a id="e-71"></a>
**E-71 — Retain cadence: both comparators write every turn; we write every
Nth.** Hermes `retain_every_n_turns = 1` (pinned `:824`), with append-mode
delta shipping and a bounded read-after-write wait so the next turn's
recall sees the just-written turn ([P-08](#p-08), [P-09](#p-09)). openclaw
`retainEveryNTurns` default 1 (docs, fetched 2026-08-16), retain on every
`agent_end` ([P-12](#p-12)). Switchroom retains every Nth turn (fleet
default 3, some agents 8) with an overlap window — the shape of the
vendor's *superseded* claude-code plugin (`retainEveryNTurns` 10,
[P-13](#p-13)). Consequence under a pull architecture: up to N-1 recent
turns are not yet recallable when the agent reaches for the tool, and
nothing equivalent to Hermes's `prefetch_waits_for_retain` read-after-write
guard exists on our side.

<a id="e-72"></a>
**E-72 — The Claude Code hook model can natively express Hermes's
off-reply-path recall ([P-08](#p-08)).** From the hooks reference
(`code.claude.com/docs/en/hooks.md`, fetched 2026-08-16): `Stop` fires
"when Claude finishes responding" — once per turn; hooks accept `async:
true` — "runs in the background without blocking"; `UserPromptSubmit`
stdout/`additionalContext` is "added as context that Claude can see";
and `UserPromptSubmit` lowers the command-hook default timeout to **30s**
(independently confirming the hook-window premise behind
[E-64](#e-64)'s 25s cap). Composition: an `async` Stop hook at end of
turn N runs the recall against turn N's content and writes a buffer
file; the UserPromptSubmit hook at turn N+1 does a local buffer read
(milliseconds, no network on the reply path) and injects it. This is
P-08's exact mechanism — queue at end of N, buffer-read at N+1 —
expressible with zero harness modification. The claude-native invariant
is not a blocker to converging on the comparators' best idea.

> [!WARNING]
> **Rev 7 correction ([E-81](#e-81)): mechanism CONFIRMED, timing
> guarantee REFUTED — "natively express Hermes's pattern" over-claims.**
> Probed 2026-08-16 against the docs and the shipped CLI binary
> (v2.1.233, strings-extracted): the queue-at-N / read-at-N+1 shape
> exists, but **nothing makes turn N+1 wait for turn N's async Stop
> hook**. Async hooks "can't block or control Claude's behavior"; the
> collection pass takes completed registry entries and leaves running
> ones running — no join, no drain, no freshness check. If the user
> replies in 2s and recall takes 8s, UserPromptSubmit at N+1 reads the
> PREVIOUS turn's buffer (stale) or nothing. Hermes's
> `prefetch_waits_for_retain` + 3s join has **no native equivalent — the
> join is ours to build** (a bounded sentinel-poll inside the
> synchronous UserPromptSubmit hook; design §5 step 6a). Two rails this
> entry didn't surface: **`asyncTimeout` defaults to 15000ms** (binary:
> `let c=r.asyncTimeout||15000`) — a recall pipeline slower than 15s
> gets killed unless the config raises it; and async-hook **stdout is
> delivered as a next-turn attachment**, so the recall hook must stay
> silent on stdout. One correction of scale: the *general* command-hook
> default timeout is **600s**, not 60s; only `UserPromptSubmit` lowers
> it to 30s (that part of this entry stands).

<a id="p-14"></a>
**P-14 — DETERMINATION: the comparators' per-turn injection is a
materially different, hardened variant of what E-57 penalised — different
on exactly the two axes the vendor's own autopsy names — and the vendor
still ships it as their chat-domain default.** This is the synthesis
entry through which the "converge on comparator behaviour" vs "delete
per-turn injection" tension resolves:

- **Axis 1 — fragment vs consolidated content.** E-69's losing arm
  injected raw similarity fragments, "none synthesized." Both comparators
  inject `["observation"]` only — Hindsight's consolidated, deduplicated,
  evidence-grounded layer ([P-09](#p-09), [P-12](#p-12)) — i.e. partially
  synthesized content, the direction the winning arm went (full
  synthesis, cached). Switchroom today injects the losing-arm shape
  ([E-70](#e-70)).
- **Axis 2 — hot path vs off path.** E-69's losing arm paid a retrieval
  round-trip per prompt. Hermes moved recall entirely off the reply path
  ([P-08](#p-08)); openclaw did not (synchronous, 10s timeout —
  [P-12](#p-12) note); switchroom today pays 0.6-0.75s synchronously
  ([E-28](#e-28)).
- **Domain.** E-57/E-63 are coding-agent evidence (sde-bench; the
  coding-agents package). Hermes and openclaw are **chat/persona
  harnesses — our fleet's actual domain** — and the vendor's openclaw
  docs, fetched today, argue *for* auto-recall there ("models don't use
  [a search tool] consistently" — [P-12](#p-12) note). The vendor's
  guidance is genuinely forked by domain, not settled.

**What this does and does not license.** It does NOT resurrect our
current block: raw-fragment synchronous push is the measured loser on
the only benchmark anyone has ([E-57](#e-57), [E-69](#e-69)) and both
comparators have already moved off that shape. It DOES mean "delete all
per-turn injection, fleet-wide, on E-57's sign" over-reads the evidence:
the sign was measured on the fragment variant in the coding domain;
the comparator variant (observation-only, capped, off-path, trivia-gated)
is **unmeasured in either direction**, and it is what the operator's
named convergence targets actually run. The evidence-honest position: the
design's reflect-once + pull core stands ([E-63](#e-63) corroboration);
the injection endpoint (hardened-hybrid vs tools-only) is a **per-agent
empirical question our fleet must answer**, not one sde-bench already
answered — which is also exactly the shape Hermes shipped
([P-07](#p-07): a `memory_mode` switch, defaulting to hybrid, deciding
nothing architecturally).

> [!NOTE]
> **Rev 7 amendment ([E-79](#e-79)):** "measured loser on the only
> benchmark anyone has" is retracted with E-57's downgrade — the losing
> run is a vendor anecdote whose delta is on the order of run-to-run noise, and
> [E-69](#e-69)'s account of its configuration is labelled interpretation
> of blog prose. The determination's *structure* is strengthened, not
> weakened: **neither** direction of the injection question now carries a
> measurement anywhere. The rejection of the raw-fragment synchronous
> variant survives on the convergent non-benchmark grounds (E-46 prose,
> E-63 vendor removal, P-09/P-12 comparator abandonment, E-70's config
> defect); the hardened-variant-vs-tools-only question remains per-agent
> and empirically open, and the only path to closing it is a self-run
> harness arm ([E-79](#e-79)).

> [!CAUTION]
> **Rev 9 correction ([E-70](#e-70) REFUTED): Axis 1's characterization
> of switchroom is wrong, and the "E-70 config defect" leg above
> dissolves.** "Switchroom today injects the losing-arm shape" is false:
> the deployed fleet default is `["world","experience","observation"]`
> with `prefer_observations=true` effective — the consolidated tier is IN
> today's injected block, on every agent (E-70 rev 9 correction). On
> Axis 1 (fragment vs consolidated content), switchroom today already
> sits **between** the losing arm and the comparators: consolidated
> observations are injected and preferentially ranked, mixed with raw
> types, rather than observation-only. The divergence from the
> comparators that remains real is **Axis 2 plus cadence**: our recall is
> synchronous on the reply path (0.6-0.75s, [E-28](#e-28)) where Hermes
> prefetches off-path, and our retain is every-Nth where both comparators
> write every turn ([E-71](#e-71)). Consequences: the rejection of the
> raw-fragment synchronous variant now rests on E-46 / E-63 / P-09 /
> P-12 **without** the "our instance is additionally defective" leg —
> that variant is nobody's shipped config, including ours; and the
> hardened-variant-vs-tools-only question is unchanged (still open,
> still per-agent, still needing the self-run arm). No confidence level
> moves; one ground is removed and the remaining grounds carry.

### Knowledge pages, re-probed at the agent-facing surface, 2026-08-16 — the E-59 reach correction and the repo-knowledge evidence

Trigger: the operator asked how working agent memory composes with the
vendor's repo knowledge pages, and a fresh live probe contradicted E-59's
"agents cannot reach pages" conclusion. Everything below is from
switchroom source at worktree HEAD `4a70ee5`, engine source at the 0.9.0
release tag (`b12646f4`, local checkout), the coding-agents package
source, and live probes against `127.0.0.1:18888` including driving the
actual `switchroom hindsight-mcp-shim` binary over stdio. All probes
read-only.

<a id="e-73"></a>
**E-73 — The agent-facing MCP surface is the switchroom shim, and it is 37
tools, not 32: knowledge-page reads and directive deactivate are ALREADY
SHIPPED.** Every agent's `hindsight` MCP entry runs
`switchroom hindsight-mcp-shim` (klanker's `.mcp.json`; env
`HINDSIGHT_MCP_URL=http://127.0.0.1:18888/mcp/`,
`HINDSIGHT_BANK_ID=klanker`). The shim proxies the engine's 32 tools and
**synthesizes five more, answered locally over REST and never forwarded**
(`src/cli/hindsight-mcp-shim.ts:34-49`): `deactivate_directive` /
`reactivate_directive` (backed by `DirectiveAdmin`) and
`search_knowledge_pages` / `get_knowledge_page` / `get_knowledge_tree`
(backed by `KnowledgeAdmin`,
`src/memory/hindsight-knowledge-admin.ts`). The synthesized set is merged
on **every** tools/list path — live, cached, and cold-boot fallback
(`hindsight-mcp-shim.ts:1322,1332-1339`) — so agents never lose them to a
backend outage. Live-verified 2026-08-16 by driving the shim over stdio:
`tools/list` → 37 tools including all five; `get_knowledge_tree` →
successful empty-bank response. The gateway allow-lists all three page
tools (`telegram-plugin/telegraph.ts:1305-1307`).

Three properties that bind the design:

1. **Reads only, by construction.** `KnowledgeAdmin` has exactly three
   methods, all GET; its single network primitive hard-codes
   `method: "GET"` (`hindsight-knowledge-admin.ts:26-51,196-216`). Page
   authorship and deletion are deliberately unreachable from the agent
   surface — upstream's own sidecar was rejected partly because it "drags
   ungated WRITE tools" along (`:18-24`).
2. **Pinned to the agent's own bank.** The three page tools expose no
   `bank_id` property; the bank comes from `HINDSIGHT_BANK_ID` only
   (`:42-51`). Explicitly a usability/provenance boundary, not a security
   one — the REST surface stays unauthenticated ([E-33](#e-33)).
3. **Consequences for this ledger:** the design's §2.5 "ship the
   directive-deactivate shim" (migration step 2) is already built,
   deployed, and contract-pinned
   (`tests/fixtures/hindsight-tools-list.snapshot.json`); E-09's "only
   over REST, not over the MCP transport agents actually use" is
   corrected — deactivate/reactivate ARE on the agent transport; and
   E-39/E-59's methodological scolding of the harness tool listing
   inverts — the listing advertised the shim's real surface, and the
   raw-backend `tools/list` was the wrong oracle for agent reach.

<a id="e-74"></a>
**E-74 — A page is NOT a projection of an existing mental model: pages are
created only via the knowledge-base route, which mints its own backing
model. The shim's cold-tree hint overstates, and no page-write path exists
anywhere on switchroom rails today.** Engine source
(`memory_engine.py`, knowledge-base section): a page row lives in
`knowledge_pages` and references a backing mental model; content lives in
`mental_models` — "this layer owns only tree structure."
`create_knowledge_page` **inserts a NEW pinned mental model plus the tree
node in one transaction** (`_insert_pinned_mental_model` + the
`knowledge_pages` INSERT, shared transaction). There is no engine path
that promotes an existing mental model into the tree; a bare
`create_mental_model` never produces a tree node, and the vendor's own
bank-template comment states it outright: "the template's `mental_models`
key creates bare mental models with no knowledge-base node, which leaves
them invisible to page search" (coding-agents `src/core/missions.ts`,
template section). [E-48](#e-48)'s "a page IS a mental model" therefore
means every page is *backed by* one — not that models project pages.

Two operational consequences:

1. **The shim's empty-tree message is wrong as a pipeline claim.** "Pages
   are synthesized from mental models — propose one to start it"
   (`hindsight-mcp-shim.ts:1497`) implies `mental_model_propose` →
   approval → page. It does not: an approved proposal creates a bare
   mental model, which never appears in the tree. Filed as a fix in the
   design (§10.6).
2. **Page creation today requires raw REST** (`POST
   .../knowledge-base/pages`), which `KnowledgeAdmin` cannot do by
   construction and nothing else in switchroom calls (repo-wide grep:
   zero non-GET knowledge-base callers). Any page pipeline needs a new,
   deliberately-gated write path — the design keeps it off the agent
   surface (§10.3).

<a id="e-75"></a>
**E-75 — Cross-bank READS are native to the engine MCP surface and pass
through the shim unmodified — verified live.** Every engine MCP tool
except `list_banks` takes an optional `bank_id`, documented "defaults to
session bank. Use for cross-bank operations", and the engine resolves the
argument FIRST: `bank_id = arguments.get("bank_id") or
config.bank_id_resolver()` (`hindsight_api/mcp_tools.py:521`). The shim
forwards tool arguments transparently (its only mutations are default
`max_tokens`/`budget` injection). Live probe: `get_bank_stats` with
`bank_id: "overlord"` through a shim pinned to `klanker` returned
overlord's stats. So `recall` / `reflect` / `get_mental_model` against a
shared bank are **zero new code** from any agent's existing tool surface.
This refines [E-32](#e-32) — still one bank per call, fan-out is N calls —
and adds nothing to [E-33](#e-33)'s exposure (the surface was already
fleet-open; the pin was never a security boundary). The three synthesized
page tools are the exception: own-bank only ([E-73](#e-73)).

<a id="e-76"></a>
**E-76 — Page freshness is engine-automatic once ingestion happens:
consolidation triggers refresh of stale auto-refresh models, and
`is_stale` is a scope-aware check with a cheap approximate tree variant.**
Engine source, three mechanisms:

1. **Auto-refresh.** After consolidation, models with
   `trigger.refresh_after_consolidation = true` are SQL-prefiltered by
   the consolidated tags, verified stale via
   `compute_mental_model_is_stale`, then submitted for async refresh
   (`consolidation/consolidator.py:1700-1786`). Knowledge pages default
   to exactly that trigger: `KNOWLEDGE_PAGE_DEFAULT_TRIGGER = {mode:
   delta, fact_types: [observation], exclude_mental_models: true,
   refresh_after_consolidation: true}`, default 4096 tokens
   (`memory_engine.py`, knowledge-base section) — confirming
   [E-35](#e-35) at source.
2. **Staleness.** The tree's per-page `is_stale` uses the bank write
   watermark (`_may_need_refresh`, `memory_engine.py:1189-1204`): False
   is exact, True means "may need refresh" (something was written,
   possibly outside the page's scope). The single-model read computes the
   exact answer against the model's resolved tag/fact-type scope
   (`compute_mental_model_is_stale`).
3. **Reading never refreshes.** The page GET renders stored content with
   no lazy-refresh side effect (confirmed in the switchroom client's
   header note and upstream handler).

Net: a repo page refreshes itself when — and only when — new material is
retained into its bank and consolidated. The refresh itself is
reflect-class synthesis on the engine's reflect provider, i.e.
`claude-code` here ([E-61](#e-61)); its cost is the same unmeasured
quantity as [§8.3]'s `refresh_mental_model`, and a dead ingestion cron
means silently frozen pages — same failure class, same guard shape, as
the orientation model (design §2.2).

<a id="e-77"></a>
**E-77 — The vendor's repo-knowledge pipeline, at source: a fixed 5-page
taxonomy over tag-routed facts, seeded idempotently by name, fed by plain
retains of git history. The only LLM the client runs is the optional
`claude -p` survey; everything else is engine-side.** Coding-agents
package source (`src/core/`):

- **Taxonomy.** Five pages — Component map, Core concepts, Conventions
  and patterns, Key decisions and rationale, Initiatives and enhancements
  — each a tag-scoped synthesis view (`tags: ["knowledge:<tier>"]`) whose
  `source_query` draws from "commit history and past discussions", NOT
  the current source tree: pages are "CONSOLIDATED from the ingested
  MEMORY … NOT mirrored from the current source (which would need
  constant re-sync)" (`missions.ts:178-236`).
- **Fact routing is bank config, not client code.** `KNOWLEDGE_LABELS` is
  an `entity_labels` group with `tag: true`: the engine's own extraction
  classifies each fact into `knowledge:<tier>` tags at retain time, with
  an explicit "MOST facts should get no label" steer
  (`missions.ts:132-176`) — the [E-21](#e-21) surface doing real work.
- **Seeding is idempotent by page NAME** (the server mints `kp-…` ids):
  existing pages are PATCHed when the packaged `source_query` drifts,
  never recreated (`hindsight.ts:336-395`).
- **Agents never author page structure**: "Raw page CRUD … is
  deliberately NOT exposed — agents never author page structure"
  (`knowledge-tools.ts:9-11`); the one agent-triggered creation is
  `captureInitiative` — a page under `Initiatives/` plus a tagged marker
  memory (`hindsight.ts:407-440`).
- **Ingestion is plain `retain`.** Per-commit mode retains full message +
  diff under document id `git:<sha>` (idempotent); gitlog mode retains
  the last N commit *messages* as ONE document — "a single
  retain/extraction op, orders of magnitude cheaper" (`git.ts:2-5,64-95,
  168-199`). The background seed spawns `node deepen.js`, not a model CLI
  (`seed.ts:26-46`). Only `survey.ts` shells a harness CLI (`claude -p …`
  et al.), and it is config-off (`codebaseSurvey`) — [E-66](#e-66)'s
  breach is contained to that one component.

This is the reimplementable core: bank config + deterministic retains +
engine-side synthesis. None of it needs the package's runtime, installer,
or `claude -p`.

<a id="e-78"></a>
**E-78 — Switchroom already has a designed (unscheduled) home for shared
repo-domain banks, and the cross-bank read config exists at HEAD.**
`reference/rfcs/shared-knowledge-banks.md` (Draft 2026-07-11): operator-
declared shared banks under `memory.shared_banks`, read set enumerated
per bank, `write: explicit | readonly` with **no `auto` value
expressible** — "the schema cannot express auto-retain into a shared
bank"; explicit writes carry `lesson` / `author:<agent>` provenance tags;
a poisoned-lesson threat analysis is already written, including the
honesty caveat that the REST surface stays unauthenticated underneath.
Its driving use case is literally this question's: overlord and klanker
both doing switchroom development, sharing hard-won repo lessons. And the
read plumbing it rides is real at HEAD: `memory.recall.additional_banks`
(`src/config/schema.ts:873,3894`; consumed in the vendored hook,
`recall.py` per-bank loop). Note the fan-out feeds the per-turn
*injection* path that design v2 steps 6a/6b reshape — in the pull world
the equivalent is the `bank_id` argument ([E-75](#e-75)), which needs no
config at all for reads.

### Validation probes, 2026-08-16 (rev 7) — five standalone reports folded in

Five parallel probes ran against the open verification list; their full
reports live under `probes/` (`sde-bench-sources.md`, `recall-types-ab.md`,
`hook-mechanics.md`, `subagent-mcp-surface.md`, `repo-page-quality.md`) and
are the source of record for every entry below — the reports carry the
complete citations and are not modified by this merge. In-place corrections
landed on E-57 (downgraded), E-69 (labelled interpretation), E-70, E-72
(timing guarantee refuted), E-51, E-62, E-38 and P-14; the entries here
carry what is new.

<a id="e-79"></a>
**E-79 — sde-bench sourcing, in full: the losing run is unpublished blog
prose; the winning campaign is published, replicated, and independently
recomputed; and we could generate the missing comparison ourselves.**
Source: `probes/sde-bench-sources.md` (probe date 2026-08-16; blog fetched
at content sha256 `028ad195…`; repos cloned read-only).

- **Publication status.** The only source for 1.06/0.97 is one paragraph
  of the 0.9.0 blog. The harness and per-task results for the *final*
  campaign HAVE landed (`vectorize-io/agent-memory-benchmark`,
  `outputs/sdebench/`; dataset at `vectorize-io/sde-bench` + HuggingFace
  mirror), but the promised "hardening journal (including the run where
  our own architecture lost to no memory at all)" is **not published
  anywhere the probe could find** as of 2026-08-16 — not in any of the
  three repos, zero grep hits for `1.06`/`0.97`/`journal`/`recall` in
  sde-bench's docs. Watch `agentmemorybenchmark.ai` / the AMB repo.
- **Independent recomputation** (mean interventions/task from published
  per-task JSON, 61 tasks × 3 runs per arm):

  | arm | per-run values | mean | sd |
  |---|---|---|---|
  | vanilla-claude (sonnet-5) | 0.918, 0.820, 0.803 | 0.847 | 0.062 |
  | hindsight-claude | 0.393, 0.279, 0.410 | 0.361 | 0.071 |
  | vanilla-codex (gpt-5.4-mini) | 1.311, 1.361, 1.361 | 1.344 | 0.028 |
  | hindsight-codex | 0.410, 0.492, 0.508 | 0.470 | 0.053 |
  | vanilla-opencode (gemini-3.5-flash) | 1.213, 1.246, 1.131 | 1.197 | 0.059 |
  | hindsight-opencode | 0.820, 0.754, 0.820 | 0.798 | 0.038 |

  Matches the blog table (0.85→0.36, 1.34→0.47, 1.20→0.80) to two
  decimals — the blog's headline is honest against its own raw data.
  **Every hindsight run beat every same-agent vanilla run (9/9,
  non-overlapping per-agent ranges)**, and the winning runs' `context`
  fields carry a synthesized "## Memory (reflect)" answer per task.
- **The bench's transfer limits, stated in its own docs:** the bank is
  pre-seeded with planted decisive answers plus 140 decoy conversations,
  and the vanilla baseline is strong (full git history + browsable past
  transcripts). It measures "can retrieval outrank noise to find a
  known-decisive fact on a symptom-distant query" — not the
  observation-recall workload our per-turn injection serves.
- **The self-run path.** The public harness still carries a recall-mode
  arm alongside reflect and vanilla
  (`run.py:721`: `--history {full, squashed, hindsight, hscoding, …}`;
  `hindsight` = squashed repo + plugin in `HINDSIGHT_MEMORY_MODE="recall"`
  — the closest surviving analogue of the losing arm). Full pipeline is
  public and Dockerized; extrapolating recorded per-task `cost_usd`
  (≈ $0.30–0.50): **a single-run recall-vs-vanilla pass ≈ $60–80; a full
  triplicate matrix ≈ $300 and roughly a day of wall time** — and given
  the sd finding above, a single run could not carry a decision, so
  triplicate is the only defensible shape. The probe's key addition: we
  could run a **fourth arm shaped like what this fleet actually ships**
  (capped observation-only async recall) — the comparison the design
  decision actually needs, which no vendor run, published or promised,
  provides. Probe bottom line, verbatim: "Neither E-57 nor E-69 should
  decide the fleet-wide per-turn-injection question on its own; the
  deciding evidence would be a self-run arm matching our actual
  configuration."

<a id="e-80"></a>
**E-80 — Recall `types` A/B, measured live: combined
`["world","experience","observation"]` never lost, strictly won 5/15, and
the observation-starvation hypothesis is unsupported by corpus
composition.** Source: `probes/recall-types-ab.md` — all calls read-only
against `127.0.0.1:18888` via MCP tools, 2026-08-16; no retains, no
mental-model writes.

- **Method:** 15 queries (6 klanker, 5 gymbro, 4 ziggy), hand-derived from
  real bank content via `list_memories`, each run three ways varying only
  `types`: current `["world","experience"]`, `["observation"]`, combined.
  `prefer_observations` left at default (false) — explicitly out of scope
  (already established a no-op today, E-70).
- **Corpus composition** (`get_bank_stats`, live): observations are
  16.0–32.8% of facts in every bank measured (klanker 21.4% of 266,470;
  overlord 18.8% of 308,306; gymbro 16.0%; ziggy 32.8%) — "not a token
  minority"; the starve concern is not supported by composition, and
  observation-only top-1 was relevant 15/15 in-sample too.
- **Tally:** world/exp top-1 relevant 15/15; combined identical to
  world/exp (observation silently dropped) 10/15; **combined strictly
  better** (surfaced a materially useful, non-duplicate observation the
  current config never returns) **5/15**; combined strictly worse
  **0/15**. Concrete defect instance: gymbro's calorie-deficit query,
  where the single highest-scoring result across all types was an
  observation (final score 1.0022) invisible to auto-recall under the
  current config.
- **Shape findings:** observation corpora are denser but more redundant
  (consolidation writes near-duplicate paraphrases as separate rows);
  combined behaves like top-N across all types by score, tracking
  world/exp's 2–3-result count, so its payload is close to current cost
  with an occasional extra item — not both configs' cost stacked.
- **Limits, carried verbatim:** "3 banks, 15 queries, one pass, no
  repeated trials. No variance/confidence interval"; overlord (the
  largest bank) was **not query-probed** — stats only; relevance was a
  judgment call by one rater, not a precision/recall metric; queries were
  not a random sample of production recall traffic; the elbow-cutoff
  mechanism was inferred from output shape, not source; token costs
  eyeballed, not tokenizer-measured. Probe's own verdict: "**suggestive,
  not conclusive… should not ship without a larger run**" — the design
  adopts combined as step 6a's default on this plus E-70's config
  analysis, with the larger run owed (design §8.11).
- **Probe-internal inconsistency, recorded (rev 8):** the probe's verdict
  paragraph says "~4/15" strictly-better while its own per-query tally
  sums to 5/15 (`probes/recall-types-ab.md:3` vs `:53`); the tally's
  **5/15** is authoritative and is the figure this ledger and the design
  carry.

> [!IMPORTANT]
> **Rev 9 re-scoping (E-70 REFUTED) — the arms are valid; the labels were
> wrong. This A/B validates the deployed status quo; it is not a case for
> change.** The probe compared explicit `types` parameters, and those
> measurements stand untouched. But the arm the probe called "current
> default" — `["world","experience"]` — is in fact the **opt-out**
> config; the **combined arm IS the fleet's deployed default** (all 12
> agents, verified at the deployed `settings.json`, E-70 correction). So
> what E-80 establishes, restated precisely: *the shipped fleet default
> (combined types) never lost to the raw-only opt-out config and strictly
> beat it on 5/15 queries, and observation-only — the comparators' shape
> — is not starved by corpus composition.* That is a directional
> validation of what already ships, not evidence for a migration step.
> Two label corrections ride along: (1) the probe's method note that
> `prefer_observations` was "already established as a no-op per E-70"
> rests on the refuted claim (probe file left unmodified, per ledger
> practice — the correction lives here); (2) no probe arm exactly
> reproduces the live hook path, which runs combined types **plus**
> `prefer_observations=true` and the operator-raised 16-memory/6144-token
> caps — so the incremental effect of `prefer_observations` under
> combined types remains unmeasured **in production**, not merely out of
> scope. The "larger run owed" obligation (design §8.11) survives with
> its urgency honestly restated: it now guards a shipped default rather
> than gating a proposed change.

<a id="e-81"></a>
**E-81 — Hook mechanics, probed at docs + shipped binary + live
transcript: async Stop is real but unjoined; compaction re-injection is
file-level and whole-file; `SessionStart:compact` injection is proven in
production.** Source: `probes/hook-mechanics.md` — official docs
(`code.claude.com/docs/en/hooks.md`, `context-window.md`), the shipped CLI
binary v2.1.233 (strings-extracted minified JS, cites verbatim), and a
live session transcript containing 4 real auto-compactions; probed
2026-08-16, no live settings touched, no `claude -p`.

Confirmed: `async: true` on hooks incl. Stop (plus `asyncRewake` /
`rewakeMessage`); the async hook is a real detached child whose file
writes persist; async stdout is not discarded but delivered as a
next-turn attachment ("if the session is idle, the response waits until
the next user interaction"); UserPromptSubmit default timeout 30s
(general command-hook default 600s); matching hooks run in parallel; a
synchronous UserPromptSubmit blocks model processing. **Refuted: any
completion guarantee** — no join, no drain, no freshness check ties turn
N+1 to turn N's async hook (full consequence recorded on E-72). New
rails: `asyncTimeout` default **15000ms**; async-process fate at session
END is unverified — no cross-restart dependency on it. Compaction:
unscoped-vs-path-scoped is a **file-level** distinction; root `CLAUDE.md`
is injected as one whole-file unit and re-read from disk after `/compact`
(preserved `# --- Yours ---` section included — the CLI is blind to the
marker); the definitive mutate-then-compact probe is **unrun** and stays
a post-step-5 canary, not a gate (full detail on E-62). PreCompact is now
documented (blocker-capable; `systemMessage`/`continue` **discarded** —
not an injection vehicle); `PostCompact` exists in v2.1.233
(`compact_summary`), injection semantics unverified; and
`SessionStart:compact` injection is **empirically proven** — a live
session's post-compaction turn carries a `hook_success` attachment with a
14.7KB `<compact-recovery>` payload (full detail on E-51). Residual
tests, named: the two-turn live buffer-race probe (~5 min of operator
time; docs and binary already agree) and the mutate-and-compact canary.

<a id="e-82"></a>
**E-82 — Sub-agent Hindsight surface, resolved: type-dependent, not
uniform — `worker` gets NO Hindsight tools by explicit allowlist;
researcher/reviewer/general-purpose inherit the full surface pinned to
the PARENT's bank; a dedicated `SubagentStop` hook retains sub-agent work
anyway; and `enable_observation_history` does not exist as a config
key.** Source: `probes/subagent-mcp-surface.md` — repo read at
`/host/~/switchroom` HEAD `6979a932` (2026-08-10 — six
days stale at probe time, flagged in the report) plus klanker's live
agent definitions and one live REST probe.

- **Tool inheritance is split by sub-agent type.** `worker.md:5` carries
  an explicit `tools:` allowlist with **no `mcp__hindsight__*` entry** —
  workers cannot call any Hindsight tool. `researcher.md`/`reviewer.md`
  carry no `tools:` key, so they (and `general-purpose`) inherit the full
  parent toolset, hindsight included. Directly contradicts any design
  assumption that "sub-agents" as a class all have or all lack the
  surface — and `worker`, the type used for repo-editing work, is the one
  cut off.
- **Bank pinning.** The shim pins `HINDSIGHT_BANK_ID` from env at spawn
  (`hindsight-mcp-shim.ts:39,63-67`); MCP servers are registered once per
  top-level session and shared by Task-tool sub-agents; the `SubagentStop`
  hook's `derive_bank_id` independently resolves to the same configured
  bank. Two code paths agree: **same bank as parent, always.**
- **Cross-bank:** `bank_id` is real and forwarded upstream on the 32
  engine tools (consistent with E-75); the three synthesized page tools
  **deliberately omit it** — `synthesizedCall()` rejects unknown args and
  special-cases `bank_id` in the error text
  (`hindsight-mcp-shim.ts:1401-1404`: "This tool always operates on your
  own memory bank; there is no way to target another agent's bank through
  it."). An agent CAN read a shared repo bank's raw memories via
  `recall(bank_id=…)` but CANNOT read its knowledge pages at all today —
  own-bank only, a **deliberate coded refusal, not a small gap** (binds
  §10.2/W-2's framing).
- **Not hook-free:** `hooks.json` wires `SubagentStop` →
  `subagent_retain.py`: resolves the sidechain transcript
  (`agent_transcript_path`), volume-gates (`MIN_HUMAN_TURNS=6`,
  `MIN_NON_TOOL_RESULT_CHARS=2000`), retains **text-only** (tool bodies
  and diffs dropped), tagged `sidechain` + `parent_session:<id>`,
  idempotent by content-derived `document_id`, failures enqueue to the
  durability queue. So even a worker's substantive findings land in the
  bank — via the hook, never a live tool call. Recall side: no
  `SubagentPromptSubmit` exists — sub-agents get no automatic recall
  injection and must call the tool explicitly (if they have it).
- **`enable_observation_history`: zero hits repo-wide.** The real key is
  `enable_observations`, live-verified `true` on klanker's bank
  (2026-08-16, read-only GET). Correction recorded on E-38.
- **Caveats carried:** no live sub-agent was dispatched to observe its
  runtime `tools/list` (evidence is declarative config + the harness's
  system-injected roster); the upstream `mcp_tools.py` bank-resolution
  line was not independently re-verified (not vendored); the checkout was
  six days behind origin at probe time.

<a id="e-83"></a>
**E-83 — Repo-page quality on a git-only seed, decided at mission-prompt
level: dropping the `claude -p` survey guts 3 of 5 page categories;
consolidation cannot manufacture structure never ingested; a dispatched
sub-agent is the claude-native survey substitute at real token cost; and
a cheap falsifying test exists and should gate R1.** Source:
`probes/repo-page-quality.md` — coding-agents source fetched live from
`vectorize-io/hindsight` `main` 2026-08-16 (treated as untrusted fetched
content, cross-checked against E-73/E-76/E-77's citations), plus
`consolidator.py` and the vendor observations doc.

- **Per-category supportability from commit messages alone** (read off
  `GITLOG_MISSION`'s own exclusion — "no diff… do NOT extract per-line
  code detail" — and `SURVEY_PROMPT`'s scope): Initiatives —
  **yes, plausibly** (subject lines narrate exactly this); Decisions —
  **partially** (only commits whose message states rationale; silent
  commits and PR/Slack/code-comment decisions are invisible); Component
  map, Core concepts, Conventions — **weak to none**: these are the
  three categories `survey.ts` exists specifically to produce (its four
  `SURVEY_DOC_IDS` map almost 1:1 onto them, sourced from reading the
  live tree). "This ships an 'Initiatives' page and a thin 'Decisions'
  page, not a 5-page repo knowledge base" (probe verbatim). The taxonomy
  itself is source-agnostic (tag-routed); the deficit is which tiers
  git-only ingestion can populate.
- **Consolidation is not a rescue.** The consolidator only deduplicates
  and refines observations from facts already extracted at retain time
  ("each observation is backed by specific source memories");
  `OBSERVATIONS_MISSION` inherits whatever ingestion provided. "Garbage
  in, garbage out applies directly… consolidation launders extraction
  quality, it doesn't add missing information."
- **Survey substitute.** The claude-native constraint forbids
  `survey.ts`'s spawn mechanism (`claude -p`), not its content. A
  dispatched sub-agent via the normal Agent tool doing the same read-only
  survey and retaining documents (strategy `document`) is a legitimate,
  structurally identical substitute — at **real subscription-token cost
  per repo and per re-run**, the one piece of §10 that isn't
  client-LLM-free. The vendor's survey is a one-time cold-start action;
  any switchroom equivalent needs the same one-shot framing to avoid
  becoming a recurring cost center. Restoring a survey does not by itself
  answer whether the resulting pages are worth reading.
- **The cheap falsifying test** (now the design's R1 gate, §10.6): run
  git-log-only ingestion exactly as §10.4 step 2 specifies (last ~300
  commits, one aggregated document) into a scratch bank; apply the bank
  template and seed the 5 pages; let consolidation run; read all 5
  pages; score 3–5 concrete new-contributor questions (one per weak
  category) against ground truth a human who knows the repo would give.
  **Kill:** the three weak-category pages come back empty, near-empty,
  or hallucinated → re-scope R1 to Initiatives + Decisions only, shipped
  labelled partial. **Proceed:** Initiatives and Decisions genuinely
  useful (concrete, correct, citing real commits/PRs) — still a partial
  win, shipped *labelled as partial*. Cost: one aggregated `gitlog`
  retain, engine-side consolidation, a read-and-score pass over 5
  ≤4096-token pages; no survey spawn needed.
- Probe's own verdict, carried honestly: "**undecidable without the
  test**" — the probe proposes the measurement, it does not supply it.

<a id="e-84"></a>
**E-84 — Hot-path recall latency, measured on the DEPLOYED hook from the
live log: p50 ~1.28s / p90 ~5.5s / max ~9.2s — roughly 2× E-28 at median
and ~7× at p90.** Source per the rev-9 deployed-artefact convention: the
running agent's recall log
(`.claude/plugins/data/hindsight-memory-inline/state/recall_log.jsonl`),
read twice on 2026-08-16 — the injection-cadence probe measured 882 rows
carrying `duration_ms` over 5000 (min 50ms, p50 1282, p90 5522, max
9162); an independent re-read the same day at 885 timed rows reproduced
it (p50 1279, p90 5522, max 9162; the five most recent turns at probe
time: 1419/1301/1129/1132/1407ms). The hook is **synchronous on
`UserPromptSubmit`** (no `async` flag, `timeout: 12` — deployed
`hooks/hooks.json`), so this is reply-path blocking time. **Scope
correction to [E-28](#e-28):** E-28's 0.60–0.75s measured four
consecutive calls of the single-bank MCP `recall` *tool*; the deployed
hook runs a multi-bank parallel fan-out
(`HINDSIGHT_RECALL_PARALLEL=true`, `recallParallelDeadlineSeconds 10`,
live env) and is the thing actually on the reply path. E-28 stands for
the tool; every hot-path-cost argument must cite this entry instead.
Checked 2026-08-16 (probes/injection-cadence.md §1).

<a id="e-85"></a>
**E-85 — Live injection quality: the deployed block is a full-cap
grab-bag with no relevance floor in normal mode.** Same log, same
convention. The probe's last logged turn: 16 memories injected from
`pre_cap_count: 152`, `injected_score_min: 0.0001`,
`injected_score_median: 0.0243`, `min_score_applied: false` — the
deployed 0.01 floor has `min_score_scope: "degraded"`, i.e. it applies
only in degraded mode and never on a healthy turn. 2111/5000 rows
`capped: true` (re-read same day: 2114/5000, and the then-latest
injecting row showed 16-from-90, min 0.001, median 0.1475, floor still
unapplied) — the block fills all 16 slots whenever candidates exist,
score notwithstanding. Read WITH [E-13](#e-13), not against it: E-13's
330-query replay measured that a fixed floor never trims a bad tail and
only empties result sets (scores are query-relative; a rank-1 relevant
hit can score ~0.001), so this entry is evidence for **cap/type/gate
tuning**, not for resurrecting `min_scores`. Checked 2026-08-16
(probes/injection-cadence.md §1).

<a id="e-86"></a>
**E-86 — Sub-agent memory surface, completed: a `worker` has ZERO memory
read path — no tools AND no injection — while its output is retained
into the parent's bank it can never read.** Extends [E-82](#e-82), which
resolved the tool-allowlist half only. Verified on the deployed tree
2026-08-16, partly first-person (the probe itself ran as a `researcher`):
(a) `worker.md:5`'s explicit `tools:` list carries no
`mcp__hindsight__*` (re-verified this rev); researcher/reviewer omit the
`tools:` key and inherit everything — a live `mcp__hindsight__recall`
from inside a researcher returned scored hits against bank `klanker`.
(b) The only injection hook is `UserPromptSubmit` → `recall.py`, which
does not fire for an Agent/Task dispatch: the probe's own researcher
prompt arrived with no injected memory block, and the 5000-row recall
log contains only main-session-shaped queries. (c) `SubagentStop` →
`subagent_retain.py` retains the sidechain's last ~40 human turns,
text-only (`retainToolCalls` forced False, `:538`), into the **parent's**
bank (`derive_bank_id` keys on cwd/session, `:446-449`), tagged
`sidechain` / `parent_session:<id>` / `agent_type:<type>` (`:539-543`)
— live recall with `tags:["sidechain"]` returned 7 such rows incl.
`agent_type:worker`. Net: implementation work is delegated to the one
agent type with a blank memory, which then writes memory it cannot
read. **Footgun recorded en route:** the MCP `recall` tool with
`budget:"low"` / small `max_tokens` (~200) silently returned
`{"results":[]}` twice where a direct HTTP recall with near-identical
parameters returned hits; with tool defaults it works. Any pull-path
guidance that tells agents to trim recall budgets must retest this
first. Checked 2026-08-16 (probes/subagent-and-longsession.md §1).

<a id="e-87"></a>
**E-87 — Junk recall traffic: ~20–30% of all auto-recalls fire on
machine-generated `<task-notification>` prompts, each eligible for the
full 16-memory / 6144-token injection.** Live log, same convention: 984
of 5000 rows (19.7%) at probe time — 61 of the last 200 (30.5%) — are
recalls whose query derives from a background-task completion wakeup:
task IDs, tool-use IDs, output-file paths (`query_chars: 800` observed),
not anything the user wrote. A same-day re-read measured 1120/5000
(22.4%) and 65 of the last 200 — the share is growing with
delegation-heavy use. Observed injections on these turns ran to the full
cap (`result_count: 16`); the deployed ack/trivia gates
(`recall.py:1740-1770`) do not skip them. Injected score medians on the
last three such turns ranged 0.065–0.95 — the high end is
**self-referential**: the query about task N matches the sidechain
retain of task N ([E-86](#e-86)), high similarity carrying near-zero new
information. In a delegation-heavy session this is the dominant recall
traffic and a direct multiplier on both the [E-84](#e-84) reply-path
cost and the §6 token bound. Checked 2026-08-16
(probes/subagent-and-longsession.md §2.2).

<a id="e-88"></a>
**E-88 — Compaction wiring, deployed: no `PreCompact`/`PostCompact` hook
exists anywhere; nothing calls `get_mental_model`; and a matcher-less
`SessionStart` hook re-fires at `source=compact` for free.** Grep over
the deployed `settings.json`, `settings.local.json`, and the plugin
`hooks.json` (re-run this rev): zero `PreCompact`/`PostCompact` matches.
The only compaction-time injectors are (a) `SessionStart` matcher
`"compact"` → `/opt/switchroom/bin/working-state-reload-hook.sh` — a
static "you were just compacted" orientation block, the
`.working-state.md` file verbatim if non-empty, and a lean briefing
whose single Hindsight recall uses the FIXED query "what was happening
recently?" (`handoff-briefing.sh:11-12,395-412`), 3s-capped — and (b)
the plugin's matcher-less `SessionStart` → `session_start.py`, whose
docstring states it injects NO additionalContext (every return path a
pure side effect; that is why it runs async). No hook in the deployment
invokes `get_mental_model` (repo-wide grep: the only hit is the
permission allowlist entry) — **design §2.2's orientation-model
SessionStart read is unbuilt, not merely unpolished.** The lever this
proves: `SessionStart` demonstrably fires at `source=compact` (the
compact-matcher hook rides exactly that event), so a matcher-less
Surface-B read hook would re-fire post-compaction with zero extra
machinery — deterministic re-orientation, where the design previously
left post-compaction re-seat to a pull the model might not make.
Checked 2026-08-16 (probes/subagent-and-longsession.md §2.3–2.4).

### Dynamic-bank and vendor-docs probes, 2026-08-16 (rev 11)

Two report-only probes (`probes/dynamic-banks.md`,
`probes/knowledge-pages-docs.md`), folded in as citable evidence. Both
were re-verified independently at fold-in time against the deployed
artefact each claim actually rests on, per the convention at the head of
this ledger: openclaw's **published** bundle
`@vectorize-io/hindsight-openclaw@0.10.0` (`npm pack`, re-extracted this
rev — the shipped artefact, so the vendored-snapshot trap does not apply
to it), Hermes at the design's pin `460d345` (raw.githubusercontent at
that SHA), the vendor docs pages fetched live (sha256 recorded per
fetch), this repo's shipped shim at HEAD, and the **running** engine at
`127.0.0.1:18888` (read-only GETs only). Neither probe overturns the
design; both corroborate parts of it, and one corrects a framing error
this document had been carrying. The re-verification also turned up
counter-evidence neither probe reached, which qualifies one probe's own
headline framing — recorded as [E-96](#e-96) rather than dropped.

<a id="e-89"></a>
**E-89 — openclaw's dynamic bank IDs are an identity-ISOLATION
mechanism, not a sharing one — and they mint banks lazily, with no
operator gate.** Verified in the published bundle
`@vectorize-io/hindsight-openclaw@0.10.0`, `package/dist/index.js`
(re-extracted and re-grepped this rev):

- **Re-derived per message, not per session.** `const bankId =
  usesStaticBank(config) ? getStaticBankId(config) : deriveBankId(ctx,
  config)` (`:334`) runs on each memory event; one gateway process
  writes to many banks concurrently.
- **Key is a template over identity fields.** `deriveBankId()`
  (`:903-946`) joins the configured `dynamicBankGranularity` fields —
  valid set `agent`, `channel`, `user`, `provider` — with `::`,
  URL-encoding each segment, optional `bankIdPrefix` prepended. Default
  granularity `["agent","channel","user"]`
  (`DEFAULT_DYNAMIC_BANK_GRANULARITY`, `:348-352`).
- **Dynamic is the DEFAULT** (`dynamicBankId: config.dynamicBankId !==
  false`, `:1278`); static mode falls back to `bankId` else the constant
  `DEFAULT_BANK_NAME = "openclaw"` (`:344`).
- **Purpose is isolation, in the docs' own words:** "each unique
  combination gets its own **isolated** memory store". Loosening
  granularity *widens the isolation unit*; it never makes two distinct
  identities share by design.
- **Knowledge tools fail closed on unresolved identity and expose no
  bank argument.** `resolveBankIdForKnowledgeTools()` (`:955-996`)
  returns an `identityError` — "Knowledge tools use the same per-user
  memory bank as auto-recall/retain" — when user-scoped banking can't
  resolve a stable sender, an `anonymous` segment appears, or the
  derived bank collapses to the default. A `grep -n "bank_id"` over the
  whole shipped bundle returns **zero hits**: no agent-facing openclaw
  tool takes a bank argument. Even the outlier treats "which bank" as
  infrastructure-resolved identity, never a model-suppliable argument.
- **Failure modes acknowledged in their own source:** a granularity typo
  logs a warn and "will resolve to `unknown`" (`:913-920`); a missing
  `senderId` yields an `anonymous` segment (`:922-925`). Derivation buys
  flexibility at the cost of silent misroute-to-a-new-bank.
- **Banks are lazily auto-created by writing to them.** The plugin never
  checks existence; `ensureBankDefaultsApplied()` (`:118-132`) calls
  `applyConfiguredBankDefaults` → `createBank`, documented as an upsert
  ("createBank upserts each mission column … unset fields are left
  untouched", `:104-110`). No operator gate on bank creation exists
  anywhere in the path, so a misconfiguration mints new empty banks
  silently. Checked 2026-08-16 (probes/dynamic-banks.md §F1–F2). **Scope
  qualification added at fold-in, from evidence the probe did not
  reach — see [E-96](#e-96): the vendor DOES publish a how-to for
  sharing one dynamic bank across several agents, so "isolation, not
  sharing" is true of the mechanism's construction and its default, but
  is too strong as a claim about how the vendor tells people to use it.**

<a id="e-90"></a>
**E-90 — Hermes resolves its bank ONCE at provider init, static by
default, and pitches the dynamic option as isolation — so across all
three integrations the model is one bank ↔ one writing identity.
openclaw differs in DEFAULT, not in MODEL — a direct corroboration of the
design's P5 (design-v2.md §1).** Verified at the design's pin `460d345` this rev:
default `bank_id: "hermes"` (`plugins/memory/hindsight/config_schema.py:54-58`;
`plugins/memory/hindsight/__init__.py:1650`, `:1179`), optional
`bank_id_template` with placeholders `{profile} {workspace} {platform}
{user} {session}` (`__init__.py:692-724`, advertised `:1180`), resolved
in provider initialization at `__init__.py:1651-1660` — **per provider
instance, not per message** as in openclaw. Purpose stated in the
provider's own README (`plugins/memory/hindsight/README.md:63`):
"`hermes-{profile}` **isolates** memory per active Hermes profile."
Net: bank resolution is configurable in all three harnesses; dynamic
derivation only changes how *finely* one writing identity is cut, never
who shares a bank. This is independent confirmation of the vendor
deployment model already recorded at [E-49](#e-49)/[E-50](#e-50) and
relied on by P5. Checked 2026-08-16 (probes/dynamic-banks.md §F4).

<a id="e-91"></a>
**E-91 — No comparator has ANY concurrent-writer machinery.
[E-38](#e-38) stands untouched.** openclaw's shipped bundle carries no
writer identity plumbed into adjudication and no contradiction handling;
its only provenance is document-level retain metadata (`agent_id`,
`sender_id`, `session_key`, `channel_id` in `buildRetainRequest`), which
is retrieval metadata, not an input to engine consolidation. Its docs do
pitch external-API mode for "Shared memory across multiple OpenClaw
instances" and "Team environments where agents share knowledge", but no
code backs a multi-writer story: openclaw does not *solve* concurrent
writers, it **avoids** them by making banks smaller. Hermes, resolving
one bank per provider instance ([E-90](#e-90)), has the same shape.
Consequence for this design: nothing found in either comparator
mitigates E-38's engine-side finding (no contradiction detector, writer
identity stripped, silent arbitrary resolution), so §10.2's
single-writer discipline must keep carrying that weight on its own.
Checked 2026-08-16 (probes/dynamic-banks.md §F3).

<a id="e-92"></a>
**E-92 — The vendor states outright that a knowledge page IS a mental
model — page ⊂ mental model, on the ladder mental models → observations
→ raw facts — with an explicit page-vs-recall boundary. Independent
corroboration of the design's P4 and §2.2's choice of the mental model as
the primitive.** Docs fetched live 2026-08-16 and re-fetched this rev
(`/developer/knowledge-pages`, content sha256
`84e153b3…4a7acc7`; `/developer/mental-models`, sha256
`d7e834a8…061413c6`), verbatim:

> "A knowledge page *is* a mental model. Same synthesis, same background
> refresh, same provenance. What's different is how much you have to
> know to use one… So a page comes with those decisions already made."

The decisions pre-set are exactly the ones [E-76](#e-76) read out of the
engine: observation-only scope, incremental delta refresh, never reads
other pages, larger content budget. The API doc puts it at the storage
level — "The page layer owns only tree structure — everything about the
content lives on the backing mental model, which is why every mental
model capability applies to pages unchanged" (`/developer/api/knowledge-pages`,
sha256 `3b565796…c6b523e3`, re-fetched this rev). Two further verbatim
statements bear directly on this design:

- **The retrieval boundary P4 asserts, stated by the vendor:** "This is
  a different path from recall, which searches individual memories. **Use
  page search to pick a document; use recall for a specific fact.**" Plus
  the reason page search skips reranking — "fast enough to be the first
  thing an agent reaches for" — matching [E-53](#e-53)'s deployed-source
  finding.
- **§2.2's cached-orientation move, stated by the vendor:** "Fetching a
  mental model is a database read. No retrieval, no synthesis, no LLM
  call, no waiting. An agent that boots by loading its mental models
  starts with a page of settled knowledge instead of spending its first
  few seconds rediscovering it." And the ladder is given as a table:
  mental models (whole document per question) → observations (one belief
  per fact cluster) → raw facts, "each layer a cheaper, more settled
  version of the one below it."

So the design's split — mental model for persona standing knowledge,
pages for §10's repo knowledge, `recall` for facts — is the vendor's own
taxonomy, arrived at here independently. Checked 2026-08-16
(probes/knowledge-pages-docs.md §1).

<a id="e-93"></a>
**E-93 — The vendor docs matched the DEPLOYED engine on every mechanism
previously verified live, in places down to identical JSON — a positive
reliability signal for the engine notes in this ledger.** The
knowledge-pages probe cross-checked every mechanism-level doc statement
against [E-53](#e-53)/[E-74](#e-74)/[E-76](#e-76)'s live findings and
found agreement on all of them: the page data model (page = tree node +
its own backing mental model, response `{page_id, mental_model_id,
operation_id}`), the default trigger `{mode: delta, fact_types:
["observation"], exclude_mental_models: true,
refresh_after_consolidation: true}` and `max_tokens: 4096` — *verbatim
identical JSON block* — the rerank-free document-level hybrid search
(BM25 + vector, RRF-fused), and the `is_stale` bank-write-watermark
approximation versus the exact per-model scope check. **This does not
license citing docs in place of the deployed artefact** — the ledger
convention stands unchanged, and E-53's own anchor drift is why it
exists. What it licenses is treating a doc statement as a reasonable
*lead* about engine mechanism, where before this rev we had no measured
base rate at all. Checked 2026-08-16
(probes/knowledge-pages-docs.md §3).

<a id="e-94"></a>
**E-94 — NAMED GAP: multi-writer bank semantics and shared/team-bank
pages are not addressed in the vendor docs at all. §10's
concurrent-writer argument therefore has no vendor position to defer
to.** Across `/developer/knowledge-pages`, `/developer/api/knowledge-pages`,
`/developer/mental-models` and `/developer/observations`: nothing on what
happens when multiple independent writers retain into one bank
concurrently, whether page refreshes serialize, or any locking/race
behaviour around a shared page; and nothing on a page spanning banks, a
"team bank", or any cross-bank fan-out for the page surface. The nearest
adjacent documented behaviour is observation dedup (near-duplicates
merged above a 0.97 cosine threshold, explicitly scoped *within the same
tag scope*) — which is about dedup, not concurrent writers. The docs are
likewise silent on bank-vs-page as a design lever: when to reach for a
separate bank is **not stated** anywhere in the four pages.
**How to use this entry:** it is a gap, not agreement. §10.2's
single-writer discipline may not be argued as "consistent with vendor
guidance" — there is no guidance. It stands on [E-38](#e-38) plus
[E-91](#e-91) (no comparator solves it either), and the honest form of
the claim is that the vendor has not addressed the question we are
answering. Checked 2026-08-16 (probes/knowledge-pages-docs.md §2, §4).

<a id="e-96"></a>
**E-96 — COUNTER-EVIDENCE, found at fold-in and recorded rather than
smoothed: the vendor publishes a how-to for SHARING one dynamic bank
across several agents. It qualifies [E-89](#e-89)'s framing; it does not
overturn the design's recommendation, and it supplies no
concurrent-writer answer.** Source: the vendor guide "OpenClaw Shared
Memory Across Agents" (`hindsight-docs/guides/2026-04-20-guide-openclaw-shared-memory-across-agents.md`,
`vectorize-io/hindsight` at `main`, fetched 2026-08-16). It prescribes
exactly what E-89's probe said the mechanism never does by design:
"remove `agent` from the bank key, keep the user dimension, and make
sure every agent points at the same Hindsight backend", recommending
`["provider","user"]`. So dynamic granularity IS used for sharing in the
vendor's own guidance. Four things bound what this changes:

1. **The mechanism claim in E-89 is unaffected.** Sharing is obtained by
   *widening the isolation unit* — dropping a field from an
   identity-derived key — not by a sharing primitive. The integration
   docs page still titles the section **"Memory Isolation"** and reads
   "each unique combination gets its own isolated memory store"
   (`/sdks/integrations/openclaw`, verbatim, fetched this rev).
2. **The shared bank is keyed on the USER, not on a repo or a project.**
   The guide's worked outcome is "one shared memory bank per user, per
   platform" so several bots serving one human stay coherent. That is
   the topology this fleet already runs statically as `ken-profile` /
   `lisa-profile` plus the deployed `additional_banks` read fan-out —
   the same destination, reached by operator config instead of a
   runtime template. It is not §10's repo-shaped case.
3. **Its answer to multi-writer is a retain MISSION, not adjudication.**
   The guide's whole hygiene story for a shared bank is a shared
   `retainMission` ("Ignore one-off chatter, duplicate tool output, and
   transient noise") — a content filter on what gets written. Its
   troubleshooting for "memory is too broad" is "tighten the mission
   before you widen isolation again." Nothing addresses two writers
   asserting incompatible facts, which is [E-38](#e-38)'s actual
   finding, and nothing contradicts [E-91](#e-91).
4. **Register and date.** This is a marketing how-to guide (2026-04-20),
   not the developer docs, and older than the 0.10.0 bundle E-89 reads.
   [E-94](#e-94)'s "not stated" stands exactly as scoped — over the four
   *developer* docs pages — and this entry is the reason that scope is
   stated explicitly rather than generalised to "the vendor is silent".

**Net effect on the design:** the §7 recommendation not to adopt dynamic
bank IDs is unchanged, but its reason narrows honestly — not "dynamic
banks can't share" (they can, and the vendor shows how), but that the
sharing they buy is per-identity sharing we already have statically,
paid for with derivation failure modes (E-89) and no gain against E-38.
Checked 2026-08-16.

<a id="e-95"></a>
**E-95 — CORRECTION OF FRAMING: the "page tools take no `bank_id`"
restriction is OUR SHIM's, not the platform's. Every documented and
deployed REST/SDK path takes a bank explicitly, and the backend tools
already pass `bank_id` through — so cross-bank recall reach needs zero
code, and W-2 is a shim change only.** Three layers, each verified this
rev at its own deployed artefact:

1. **Engine REST — bank is a required path parameter, everywhere.**
   Live `GET /openapi.json` on the running 0.9.0 engine
   (`127.0.0.1:18888`, read-only) lists exactly seven knowledge-base
   paths, all of the form
   `/v1/default/banks/{bank_id}/knowledge-base/...` (`/tree`,
   `/folders`, `/pages`, `/pages/{page_id}`, `/nodes/{node_id}`,
   `/search`, `/export`). The vendor docs agree — every SDK example
   passes `BANK_ID` as the first argument. There is **no platform-level
   own-bank restriction on pages at all.**
2. **Engine MCP through the shim — `bank_id` already flows.**
   `FALLBACK_TOOL_TABLE` (`src/cli/hindsight-mcp-shim.ts:190-222`) lists
   `bank_id` among the optional props of `recall`, `reflect`, `retain`,
   `get_mental_model` and every other backend tool, byte-pinned by the
   fixture contract test. This restates [E-75](#e-75) at the manifest.
3. **The restriction lives in the five SYNTHESIZED tools only.** Their
   schemas omit `bank_id` by explicit design ("NOTE the deliberate
   absence of a `bank_id` property. The bank is pinned from
   `HINDSIGHT_BANK_ID`; a caller cannot name one. That is a usability
   and provenance boundary, not a security one",
   `hindsight-mcp-shim.ts:258-262`); `bankId` enters only via
   constructor options; and `synthesizedCall()` loud-rejects an unknown
   `bank_id` argument (`:1379-1405`).

**The three things that refusal protects, to be preserved by any
relaxation** (all read at HEAD this rev): (a) **anti-silent-drop** —
"Silently ignoring `bank_id` would leave a caller believing it had
targeted another bank when it had in fact edited its own"
(`:1379-1383`); (b) **the provenance-not-security boundary** —
`src/memory/hindsight-directive-admin.ts:21-36` states the transport is
unauthenticated and "any agent with Bash can still curl any bank
directly, bypassing this module entirely", so relaxing the pin weakens
no security property that exists, only the provenance property that
every mutation attributable to an agent's tool surface targeted its own
bank; (c) **the retirement seam** — `withSynthesizedTools()` drops any
same-named backend tool so behaviour "never silently widens to accept a
`bank_id`" if a future engine image registers real tools (`:461-469`),
with the fixture test as tripwire. **Sites corrected on this entry:**
§2.5, §10.2 pt 3, §8's resolved list, §10.6 W-2. Checked 2026-08-16
(probes/dynamic-banks.md §F5, probes/knowledge-pages-docs.md §3 row 4).

### Post-fold-in refutation, 2026-08-16 (same rev)

<a id="e-97"></a>
**E-97 — REFUTED: design-v2.md §5 step 3's "bank template for
fleet-common guardrails" has no primitive to run on. There is no
apply-a-template-to-existing-banks verb on the deployed engine, and the
step's claimed `~1KB/injection saved fleet-wide, zero behaviour change`
is withdrawn.** Live route table, `GET /openapi.json` against the
running 0.9.0 engine (`127.0.0.1:18888`), re-verified this pass:

- `/v1/bank-template-schema` — **`get` only.** `curl -X POST` against it
  returns HTTP 405; `curl -X GET` returns 200. It is a schema an agent
  reads when composing a bank definition, not an operation that mutates
  an existing bank.
- `/v1/default/banks/{bank_id}/directives` — `get`, `post` only.
- `/v1/default/banks/{bank_id}/directives/{directive_id}` — `get`,
  `patch`, `delete`.
- No other path in the 65-path (85-operation) schema contains `template` or takes a
  cross-bank directive argument. Directives are per-bank rows, full
  stop; there is no cross-bank shared-directive primitive anywhere in
  the deployed API.

Step 3 as specified — "create canonical directives from the template,
deactivate the 13 per-bank `no-confabulation` copies … via the step-2
shim. Standalone win — ~1KB per injection saved fleet-wide immediately,
zero behaviour change" — cannot be executed against this API, and its
central premise is backwards: deactivating the per-bank copies with
nothing replacing them at read time (`recall`'s `based_on.directives`
count and the reflect-scoped guardrail injection are both computed
per-bank, live, from that bank's own `directives` rows — [E-27](#e-27))
leaves every one of those banks carrying **zero** copies of a rule they
currently all obey. That is a behaviour change — the guardrail stops
firing — not the claimed zero-risk saving. [E-49](#e-49)'s "the vendor
already ships the template primitive" was read off vendor docs
describing bank *onboarding* (`developer/api/bank-templates.mdx`); nailed
down against the artefact that actually matters — the deployed engine's
own route table — that primitive doesn't extend to retrofitting live
banks. The token saving this design counted from step 3 is only
obtainable through shrinking or retiring directive content (step 4's
triage), never through cross-bank deduplication. **Sites corrected on
this entry:** design-v2.md §1 P5, §4.2, §5 step 2 (the ordering note at
`:975-977` citing step 3's rollback mechanism, now vestigial), §5 step 3,
§9's verdict check, the status frontmatter (rev 11 correction note);
[E-49](#e-49) carries an inline correction pointing here. Checked
2026-08-16, live, read-only
GETs and one probing `POST` against `/v1/bank-template-schema` only (no
bank state mutated).

<a id="e-98"></a>
**E-98 — Fleet directive audit, all 15 banks, live, read-only (E-97's
supporting measurements).** `GET /v1/default/banks` then `GET
/v1/default/banks/{bank_id}/directives` for each of the 15 deployed
banks (`assistant`, `carrie`, `finn`, `gymbro`, `kdogg`, `ken-profile`,
`klanker`, `lawgpt`, `lisa-profile`, `marko`, `overlord`, `reggie`,
`switchroom-dev`, `test-harness`, `ziggy`):

- **`no-confabulation` is live in 14 of 15 banks, and every copy is
  byte-identical** — 1,029 chars, `priority: 10`, `is_active: true`,
  same SHA-256 prefix across all 14. `switchroom-dev` carries zero
  directives of any kind. [E-43](#e-43)'s "verbatim in all 13 banks" is
  one bank short of the current count (a bank has been added since);
  the byte-identical finding is new and confirms there was no drift to
  reconcile in this directive, contrary to what [E-49](#e-49) assumed
  when it named `no-confabulation` alongside the genuinely-drifted
  `windows-boxes` pair as "both *template* problems."
- **`windows-boxes-access-and-full-stop` is drifted, and it is exactly
  the 2 copies [E-43](#e-43) already measured** — klanker 2,362 chars,
  overlord 3,567 chars, both `is_active: true`, overlord's text a
  strict superset of klanker's. This is the one finding in the old step
  3 that survives: a single `PATCH` of klanker's directive with
  overlord's text, via the step-2 shim, is still cheap and still
  reversible — a single-directive fix, not a template operation, and it
  saves nothing beyond itself.
- **176 active directives fleet-wide** (sum of per-bank `is_active`
  counts): overlord 26, marko 26, assistant 25, klanker 24, reggie 13,
  gymbro 12, carrie 18, finn 11, lawgpt 11, ziggy 6, `kdogg`/
  `ken-profile`/`lisa-profile`/`test-harness` 1 each, `switchroom-dev`
  0. Three banks (overlord, marko, assistant) are already past the
  doctor `WARN` threshold of 24 (design-v2.md §4.2, `doctor-memory.ts`
  `MAX_DIRECTIVES`); none is past the `FAIL` threshold of 30 — folded
  into §4.2's count-watch paragraph as a live instance, not a new claim.
- **`enable_observations` is `true` on 14 of 15 banks; only
  `switchroom-dev` is `false`.** `GET
  /v1/default/banks/{bank_id}/config` for all 15 banks, this pass.
  **`enable_observation_history` does not exist in the deployed config
  schema on any bank** — this re-confirms [E-82](#e-82)'s key-name
  correction live; it is recorded here as corroboration only and does
  not restate E-82 as new.

Checked 2026-08-16, live, read-only GETs against all 15 banks (no
bank state mutated).

---

## What binds the design

<a id="c-01"></a>
**C-01 — The job spec's acceptance criteria.**
`reference/jobs/remember-across-sessions.md`, frontmatter:
`job: remember across sessions without being re-told`; `serves: standing-team`;
`invariants: [single-tenant]`. Load-bearing callout at `:31-32`:

> Memory the user can't inspect is memory the user won't trust.

"Bad — never ship" (`:141-157`) includes: raw transcript dumping; regurgitating
old facts unprompted to prove it remembered; **silent forgetting with no way
to tell**; memory the user cannot inspect/correct/delete; conflating
topics/specialists into one pool; treating every memory as equally weighted.

<a id="c-02"></a>
**C-02 — `single-tenant` is the binding invariant, and it binds harder than
the parked RFC assumed.** `reference/invariants.md:104-128`. Per-user memory
isolation *within* the tenant is in scope, not a violation. But sending memory
text (user PII) off-box — e.g. to a hosted reranker — is the actual violation
category, and `invariants.md:21-23` is explicit: "A change that breaks one of
these invariants is out of scope, full stop. Not a redesign, not a follow-up."
An operator opt-in is **not** a valid escape hatch for an invariant question.

<a id="c-03"></a>
**C-03 — `claude-native`.** `reference/invariants.md:25-79`. Unmodified
`claude` CLI, no `ANTHROPIC_API_KEY`, no protocol interception. Governs
Claude's own model calls; a third-party reranker is a `single-tenant` question,
not a `claude-native` one ([C-02](#c-02)).

<a id="c-04"></a>
**C-04 — Phase 4 did not ban what the parked RFC thought it banned.**
`hindsight-synthesis-layers.md:332-345` governs **user-visible** legibility
lines (📌 remembered / ✂️ forgot), engineered to avoid regurgitation. It never
touched the recall hook's hidden `additionalContext` injection, which fires
every non-trivial turn regardless. Visible legibility and invisible injection
are orthogonal; do not re-litigate one as the other.

---

## Comparative practice

<a id="p-01"></a>
**P-01 — No comparable Hindsight harness has a standing-rule layer at all.**
Read directly from source: the openclaw Hindsight plugin
(`vectorize-io/hindsight`, `hindsight-integrations/openclaw`) and Hermes's
Hindsight provider (`NousResearch/hermes-agent`,
`plugins/memory/hindsight/__init__.py`). Neither has any concept of a
persistent rule block injected every turn — switchroom's directive layer is
**switchroom-original**, with no analogue in either.

> [!WARNING]
> **Correction, logged deliberately.** An earlier pass cited openclaw as
> capping injected memory at 10,000 chars with FIFO eviction, and using
> `minScore=0.3` / `DEFAULT_AUTO_RECALL_RESULT_CAP=3`. A source read of the
> openclaw **Hindsight plugin** could not find any of those constants; the
> only `10_000` there is `MAX_TRACKED_SESSIONS`, a session map. Those figures
> came from openclaw's *native* memory extensions, a different subsystem from
> its Hindsight integration. Both may be true of their respective components —
> but the "everyone else caps injection" claim is **not** supported by the
> Hindsight-integration code, and must not be used as evidence for it.

What the source does support:
- **Injection caps.** openclaw `recallMaxTokens` default **1024**
  (`openclaw.plugin.json:225-230`); switchroom `recallMaxTokens` default
  **1024** (`recall.py:2099`) — identical; Hermes `recall_max_tokens` default
  **4096**. (Hermes's `memory_char_limit=2200` belongs to its *builtin*
  on-disk store, not its Hindsight provider — do not conflate.)
- **Triviality gating.** Hermes gates centrally
  (`agent/memory_provider.py:75-101`, `TRIVIAL_PROMPT_RE`); switchroom has one
  too (`tests/test_recall_trivial_skip.py`); openclaw's Hindsight plugin has
  **none**.
- **Where switchroom is ahead:** a min-score floor test
  (`tests/test_recall_min_score.py`) and an explicit degraded-recall notice
  (`tests/test_recall_degraded_notice.py`). Both openclaw and Hermes silently
  return empty on recall failure with no model-facing signal — we tell the
  agent. That is a real inspectability lead over both ([C-01](#c-01)).
- **Where they are ahead:** see [E-27](#e-27) and [E-28](#e-28).

> [!CAUTION]
> **Rev 9 correction — the "switchroom `recallMaxTokens` default 1024"
> figure above is the vendored-snapshot tier, not the deployed config:
> same trap as [E-70](#e-70), second victim.** `recall.py:2099` is the
> vendored Python fallback. The deployed value is stamped from the
> operator cascade (`src/agents/scaffold.ts:3937-3938`,
> `settings.recallMaxMemories/recallMaxTokens` "from the CASCADE-RESOLVED
> operator config, NOT hardcoded literals"), and `switchroom.yaml` raised
> the fleet default to **`max_memories: 16` / `max_tokens: 6144`** on
> 2026-08-03 (`switchroom.yaml:1013-1023`, with the comment noting the
> count cap binds first and "max_tokens rarely binds"). Verified at the
> deployed `settings.json`, 2026-08-16: 11/12 agents carry 6144/16
> (test-harness carries 1024/8). The openclaw and Hermes figures stand;
> "identical" does not — our deployed token ceiling is 6x openclaw's and
> 1.5x Hermes's, bounded in practice by the 16-memory count cap. See the
> matching correction on [P-05](#p-05).

<a id="p-02"></a>
**P-02 — The vendor's cross-agent sharing model is one primitive: a shared
`bank_id` string.** No ACL, no asymmetric grant, no per-memory permission —
possession of the id confers full read and write. Any design wanting "agent X
reads bank Y but cannot write it" must build that above the engine.

<a id="p-03"></a>
**P-03 — `recall` is LLM-free; only `retain` and `reflect` call an LLM.**
Stated consistently across vendor material; changes the cost model for recall
fan-out (compute, not tokens). **Flagged for confirmation against engine
source rather than blog prose.** *Confirmed 2026-08-16* — see
[E-28](#e-28): recall never returns a `usage` block and runs sub-second;
reflect always returns `usage` and runs 50-90s.

<a id="p-07"></a>
**P-07 — Hermes makes push-vs-pull an explicit config choice, not an
architecture.** Source read at `NousResearch/hermes-agent` @ `d5773bf`
(2026-08-15), `plugins/memory/hindsight/__init__.py`. `memory_mode` takes
exactly three values (`:750`, `:1184`, `:1664-1665`), defaulting to
**`hybrid`**:

- **`context`** — auto-inject only. `get_tool_schemas()` returns `[]`
  (`:2172`); the model gets no memory tools at all.
- **`tools`** — no auto-injection; `_recall_disabled()` returns `True`
  unconditionally (`:1844-1846`). Agent-invoked tools are the only path in.
- **`hybrid`** (default) — both.

This is the exact question our design is wrestling with, already
parameterised. Worth noting they did **not** pick a side: they shipped the
switch and defaulted to both.

> [!NOTE]
> **Re-verified 2026-08-16 against the pinned commit `460d345`** (the new
> authority; the entry above was read at `d5773bf`). Every claim holds at
> identical line numbers: default `hybrid` at `:750`, enum at `:1184`,
> parse+validate at `:1664-1665`, `get_tool_schemas` returning `[]` in
> `context` mode at `:2170-2172`, `_recall_disabled` at `:1842-1846`. One
> phrasing correction: `_recall_disabled()` does not return `True`
> "unconditionally" in `tools` mode — it is the first of three guards
> (`tools` mode, `auto_recall` off, shutting down), each returning `True`
> (`:1842-1851`). Effect as described: `tools` mode disables all
> auto-recall.

<a id="p-08"></a>
**P-08 — The best idea found in any comparator: recall runs OFF the reply
path.** By default (`recall_sync=false`), Hermes queues the recall for turn
N+1 in a background thread at the **end of turn N** (`queue_prefetch`,
`:1950-1975`), then merely reads the buffer back at the start of N+1 with a
capped 3s join (`:1928-1937`). **Memory I/O costs zero user-facing
latency.** The stated trade-off is staleness: injected memories answer the
*previous* turn's query, and `recall_sync=true` opts back in to
freshness-for-latency, citing `hermes-agent#5820` (`:1914-1917`).

They extend the same discipline to writes: `prefetch_waits_for_retain`
(default true) makes the background prefetch wait, bounded at 10s, for a
just-completed retain to become server-visible, so the next turn sees what
was just said (`:1728-1729`, `:1964-1967`). A read-after-write guard that
still costs the user nothing.

Relevance to us: [E-28](#e-28) measured recall at 0.60-0.75s, which we
currently pay synchronously on every turn. This architecture makes that
free, and it is the one comparator idea that is **strictly better than what
we do**, independent of every other decision in this RFC.

> [!NOTE]
> **Re-verified 2026-08-16 at pinned `460d345`.** All mechanics confirmed:
> `recall_sync` default `False` (`:847`, `:1195`, `:1703`); `queue_prefetch`
> at `:1950-1975` (background thread started `:1974-1975`, retain-drain wait
> inside `_run` at `:1958-1967`); buffer read with `join(timeout=3.0)` at
> `:1928-1937`; `prefetch_waits_for_retain` default `True` / drain timeout
> `10.0` (`:835-836`, config parse `:1727-1730` — the entry's `:1728-1729`
> cite drifted by one line); `#5820` cited at `:1917`. One honesty note the
> entry under-states: the 3s capped join runs on the reply path, so a slow
> background recall can still cost up to 3s of user-facing latency —
> "zero" is the common case, not a bound. [E-72](#e-72) confirms this
> pattern is natively expressible in Claude Code hooks.

<a id="p-09"></a>
**P-09 — Hermes narrows `recall_types` to `["observation"]` by default,
explicitly for token economy.** (`:849-857`, README 83-89.) Raw
`world`/`experience` facts are excluded by default so the
`recall_max_tokens` budget is spent on Hindsight's consolidated layer
rather than re-shipping the supporting facts underneath it. Stated in
source as a token-economy decision, not a quality one. We do not do this
and it is cheap to test.

Other Hermes budgets, for the record: `recall_max_tokens` 4096 (`:848`),
`recall_max_input_chars` 800 (`:857`), `recall_budget` default `mid`,
request timeout 120s (`:75`, commented "cloud API can take 30-40s per
request"). Retain runs every turn by default (`retain_every_n_turns: 1`,
`:823-824`), batched into one document per session with append-mode delta
shipping (`:2081-2096`), always on a background writer thread (`:2143`).

> [!NOTE]
> **Re-verified 2026-08-16 at pinned `460d345`.** Confirmed:
> `recall_types = ["observation"]` default at `:857` (comment block
> `:849-856`, config-parse fallback `:1707-1714`); README behavior-change
> callout at lines 83-89 verbatim ("observations are denser per token");
> `recall_max_tokens` 4096 at `:848`; `retain_every_n_turns = 1` at `:824`;
> `recall_budget` default `mid` (`:1074`, `:1183`); append-mode delta via
> `_last_retained_turn_count` (`:838-843`, delta slice `:2081-2087`).
> Two one-line drifts: `recall_max_input_chars` 800 now at `:859` (was
> `:857`), the 120s-timeout "cloud API can take 30-40s" comment at `:74`
> (was `:75`). Substance unchanged.

<a id="p-10"></a>
**P-10 — Hermes uses NO directives, NO mental models, NO knowledge pages.
Read this as scope, not as a verdict.** `grep -n "directive"` on the plugin
returns **zero matches**; likewise no `mental_model`, `knowledge_page`, or
`knowledge_tree`. Hermes treats Hindsight purely as a
recall/reflect/retain fact store.

> [!NOTE]
> **Re-verified 2026-08-16 at pinned `460d345`:** `grep -c` for
> `directive`, `mental_model`, `knowledge_page|knowledge_tree` over
> `plugins/memory/hindsight/__init__.py` returns 0, 0, 0. Unchanged.

> [!NOTE]
> **Operator steer, 2026-08-16, and it binds the rest of this research:**
> anchor on the **0.9.0 capability surface as primary truth**, because our
> deployment is ahead of what the comparator integrations were built
> against. A feature the comparators don't use may simply be one they
> couldn't, or haven't got to — **their non-adoption is not evidence
> against it.** So P-10 must not be cited as "nobody uses mental models, so
> we shouldn't." It is evidence about Hermes' scope, and nothing more.
>
> The corollary matters more: the under-adopted parts of 0.9.0 —
> [E-39](#e-39)'s knowledge pages being the clearest case, live on our
> deployment and never once used by any bank — are where unexploited
> capability actually lives, precisely *because* no comparator has picked
> them up yet.

<a id="p-11"></a>
**P-11 — Hermes fails open and silent, which our job doc forbids.**
`_do_recall` swallows every exception and returns an empty result at
`logger.debug` level (`:1889-1891`) — not even a warning. Success shows a
"👁️ Hindsight — recalled N memories" indicator; **failure just looks like
zero memories**, with no distinct error surfaced to the user. Tool-mode
failures do return `tool_error(...)` into the model's tool result
(`:2197-2199`), so the model sees them; the user still doesn't.

This is a direct instance of [C-01](#c-01)'s never-ship bar — silent
forgetting with no way to tell. Our degraded-recall notice is **better
than the comparator here**, and the design must keep it rather than copy
Hermes wholesale.

> [!NOTE]
> **Re-verified 2026-08-16 at pinned `460d345`.** `_do_recall`'s
> catch-all at `:1889-1891` (`logger.debug`, returns `_RecallResult("", 0)`)
> and `tool_error(...)` into the model-visible tool result (`:2199`,
> `:2226`, `:2244`) both confirmed at the cited lines. One addition at the
> pin: the success indicator is now a deterministic, config-keyed pair —
> `recall_indicator` / `retain_indicator`, both default `True`
> (`:1196-1197`, `:1716-1724`) — emitted by the harness, not the model.
> This strengthens Hermes's *success* visibility but changes nothing about
> failure: a swallowed recall error still renders as "no indicator line,"
> indistinguishable from zero matching memories. The entry's verdict
> stands.

<a id="p-04"></a>
**P-04 — Our plugin has no upstream. "Drift from upstream" is not a
available frame.** The vendor repo does contain
`hindsight-integrations/claude-code`, which makes it tempting to treat our
plugin as a fork that has drifted. It is not: that plugin's own README says
it is superseded by "Coding Agents" and no longer developed, and our
`vendor/hindsight-memory` shares no lineage with it — it is switchroom-
authored from scratch. So there is no upstream to re-sync with and no
maintained reference implementation to copy. Every behaviour in our plugin
is a choice we made and own, including [E-05](#e-05). Design accordingly:
nothing gets fixed for us by pulling.

<a id="p-05"></a>
**P-05 — Injection budgets across the three harnesses are strikingly
similar, and ours is not the outlier people assumed.** openclaw
`recallMaxTokens` default **1024** (`openclaw.plugin.json:225-230`); ours
default **1024** (`recall.py:2099`); Hermes `recall_max_tokens` default
**4096**. Query caps: openclaw 800 chars, Hermes 800, ours the same
`recallMaxQueryChars` truncation. **Our recall injection is squarely in
line with both comparators.** The divergence is not recall at all — it is
the *directive* block bolted alongside it ([E-05](#e-05)), which neither
comparator has an equivalent of. This sharpens the problem statement: don't
redesign recall budgeting to fix a directives problem.

> [!CAUTION]
> **Rev 9 correction — "ours default 1024" read the vendored snapshot,
> not the deployed config (same trap as [E-70](#e-70)).** The deployed
> fleet default, stamped from the operator cascade
> (`src/agents/scaffold.ts:3937-3938`) and set in `switchroom.yaml` on
> 2026-08-03 (`:1013-1023`), is **16 memories / 6144 tokens** — verified
> on 11/12 deployed `settings.json` (test-harness: 1024/8),
> 2026-08-16. So "squarely in line with both comparators" is wrong for
> the deployed fleet: our token ceiling is the highest of the three
> (6144 vs openclaw 1024, Hermes 4096), though the yaml's own rationale
> is that `max_memories: 16` binds first and the token cap rarely does.
> The entry's conclusion — the outlier is the directive block, and
> recall budgeting is not the problem to redesign — survives on the
> directive block's measured ~48.7M/30d ([E-41](#e-41)), but the
> "identical budgets" premise must not be cited again. Design §2.3, §5
> step 6a and §6's recall-block bound are corrected at rev 9.

<a id="p-06"></a>
**P-06 — Two vendor doc domains, two products. Do not conflate them.**
`hindsight.vectorize.io` documents the OSS/self-hosted product we run;
`docs.hindsight.vectorize.io` documents **Hindsight Cloud**, a hosted
control plane with org/team RBAC, SSO, and an Enterprise-gated "Memory
Defense v2" that is a superset of the OSS feature. Several capabilities
that look available in a naive docs search are Cloud-only. This is the
direct reason [E-33](#e-33) has no in-product fix: the permission model
people would reach for lives in the product we are not running, and
[C-02](#c-02) forbids the obvious remedy of moving there.

---

## Open questions the design must answer

1. **What is always-on, and what is retrieved?** Given [E-03](#e-03),
   [E-04](#e-04) and [P-01](#p-01), the current answer ("everything, every
   turn") is not defensible. Tag-scoped directives are the engine's own answer
   and we bypass them.
2. **If directives are `reflect`-scoped by design, what is the right home for
   an always-on behavioural rule?** Candidates: bank `disposition_*` for soft
   style, the agent's `CLAUDE.md` for hard invariants, directives for
   compliance guardrails only. This is a re-homing question, not a pruning
   question.
3. **Can retirement be made as cheap as creation?** Creation is nudged and
   free ([E-05](#e-05)); retirement is a documented one-field update
   ([E-09](#e-09)) that the fleet prompt does not tell agents about. The
   ratchet is a documentation bug before it is a design problem.
4. **How does a user see what memory did on a given turn?** [C-01](#c-01)
   makes this a requirement, and silent truncation ([E-08](#e-08)) currently
   violates it.
5. **What replaces `memory demote` while #3772 stands?** ([E-20](#e-20))

---

## Verdict check (four-part rule)

Not yet performed — this document is the evidence phase. The design section,
when written, must clear: advances a named outcome; satisfies the job spec's
UAT ([C-01](#c-01)); passes the three principle checks; crosses no invariant
([C-02](#c-02), [C-03](#c-03)).
