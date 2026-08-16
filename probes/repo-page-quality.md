# Probe: is §10 (repo knowledge pages) worth building?

**Verdict: undecidable without the test in §5 below.** The vendor source is
unambiguous that dropping `survey.ts` removes real, non-git-derivable content
(component map, tech stack, conventions grounded in actual code) — that part is
decisive against pretending the git-only path is equivalent. But whether the
git-only subset that's left is *itself* worth the pipeline (W-1..W-5, one cron,
one shim extension) is an empirical question about LLM extraction quality over
commit-message corpora that nobody in this repo has run. §10.7 already flags
this exact unknown ("whether synthesis quality over commit-message corpora is
worth reading — measured before R1 ships, neither assumed") — this probe
proposes the measurement, it doesn't supply it.

## 1. What each vendor file contributes to a page

Source: `vectorize-io/hindsight`, `hindsight-integrations/coding-agents/src/core/`
(fetched live, commit at time of fetch — `main` branch, 2026-08-16).

- **`missions.ts:132-236`** (`PAGES` array) — defines the 5-page taxonomy and,
  for each page, a `source_query` fed to the *engine's* server-side page
  synthesis (not client-side). Each page is tag-scoped to one `knowledge:<tier>`
  label (`component`, `concept`, `convention`, `decision`, `feature-work`) that
  the extractor stamps onto facts at retain time. The page body is generated
  by Hindsight's own reflect-class synthesis over whatever facts carry that
  tag — **the taxonomy itself is source-agnostic**: it doesn't know whether the
  underlying facts came from `git.ts` or `survey.ts`.
- **`git.ts`** — two ingestion paths: `retainCommit` (`git:<sha>`, full msg +
  full diff, opt-in `--diffs`, one extraction op/commit — expensive) and
  `ingestGitLog` (`gitlog:<repoName>`, last N commit *messages only*, no diffs,
  ONE aggregated document — the default, "orders of magnitude cheaper"). This
  is what §10.4 step 2 adopts (git.ts:117 comment: default aggregate mode).
- **`survey.ts`** — spawns a **detached headless coding-agent session**
  (`claude -p` for the claude-code harness, `codex exec`, etc.) that actually
  **reads the live source tree** (directory layout, entry points, manifests,
  README, "a few representative source files per major area" — `SURVEY_PROMPT`,
  survey.ts) and calls `hindsight_ingest_document` to write four fixed-title
  documents: *Repository component map*, *Repository core concepts*,
  *Repository conventions and patterns*, *Repository tech stack and features*
  (`SURVEY_DOC_IDS`, survey.ts). These feed the SAME 5 pages via the SAME
  tag-routing mechanism as git/chat facts — no separate write path.
- **`hindsight.ts`** — the HTTP client. `seedPages()` (hindsight.ts:519,
  1153 in the two client-generation copies) idempotently POSTs/PATCHes the 5
  pages by name; `configureBank()` applies `CODING_BANK_TEMPLATE`
  (missions + retain strategies + entity labels) then calls `seedPages()`.
  Nothing here synthesizes content — it wires config and lets the *server*
  (hindsight-api-slim) do synthesis on demand via `source_query`.

**Answer to "how much of the taxonomy is fed by git vs. survey":** structurally,
none of the 5 pages is exclusively either — each page's `tags` field pins it
to a `knowledge:<tier>` label, and *both* git commits and survey documents can
carry that label (the `GIT_MISSION` prompt in missions.ts:16-24 explicitly
instructs the extractor to route facts to `knowledge:*` tiers same as any
other ingestion path; survey.ts's own comment says survey documents "feed the
existing pages... same as git history and chat transcripts do"). So this is
not a case where survey owns some pages and git owns others — **it's a
question of which tiers each source can plausibly populate with correct,
current facts**, covered in §2.

## 2. What commit messages can and cannot support, by taxonomy category

| Page | tag | Answerable from `gitlog` (messages only, no diff, no source read)? |
|---|---|---|
| Initiatives and enhancements | `knowledge:feature-work` | **Yes, plausibly.** `GITLOG_MISSION` (missions.ts:16-24) is written exactly for this: "extract the project's INITIATIVES, FEATURES... over time." This is literally what commit subject lines narrate. |
| Key decisions and rationale | `knowledge:decision` | **Partially.** Only for commits whose message *states* the rationale ("switch to X because Y"). Silent commits ("fix bug", "refactor") contribute nothing; a decision made in a PR description, Slack, or code comment and never explained in the commit message is invisible to this path entirely. |
| Component map | `knowledge:component` | **Weak.** A commit message rarely states "module A depends on module B" as prose; that's a structural fact you read off the tree/imports, not off a changelog. `GITLOG_MISSION` explicitly says "Do NOT extract per-line code detail (there is no diff to draw it from)" — it self-excludes the very evidence a component map needs. |
| Core concepts | `knowledge:concept` | **Weak.** Domain vocabulary is introduced in code (types, module names, docstrings) and design docs, not usually spelled out in commit subject lines. |
| Conventions and patterns | `knowledge:convention` | **Weak-to-none.** Testing approach, naming, error-handling style: these are observed by reading multiple files' *actual code*, not narrated in commit messages except incidentally ("add tests for X" doesn't say *how* tests are structured). |

So: of the 5 pages, only 1 (Initiatives) is well-supported by commit messages
alone; 1 (Decisions) is partially supported and noisy; 3 (Component map, Core
concepts, Conventions) are the categories the survey step exists specifically
to produce, per `SURVEY_PROMPT` itself, which maps almost 1:1 onto
`SURVEY_DOC_IDS`'s four titles. This is not a training-memory inference —
it's read directly off the `GITLOG_MISSION` prompt's own exclusion ("no
diff... do NOT extract per-line code detail") and off `SURVEY_PROMPT`'s scope
("directory layout, entry points, package manifests... a few representative
source files").

**This is the closest thing to a decisive finding in this probe:** dropping
`survey.ts` doesn't shrink the feature evenly across 5 pages — it guts 3 of 5
categories and leaves 1 well-served, 1 half-served. If §10 is adopted with
`git.ts`-only ingestion (as it currently proposes, §10.4 point 4, which
concedes this: "pages know only what history, PR text, and retained design
docs say, not the current source tree"), the honest framing is: **this ships
an "Initiatives" page and a thin "Decisions" page, not a 5-page repo
knowledge base.** §10.4's own text already says this ("partial cover") —
this probe just quantifies which 3 pages are the ones left mostly empty or
wrong.

## 3. Alternatives to `claude -p` for the survey step

The constraint (switchroom is claude-native; `claude -p`/API/SDK forbidden)
does not forbid the *content* of `survey.ts` — only its specific spawn
mechanism (`execFileSync`/`spawn` of a headless `claude -p` subprocess,
survey.ts's `buildSurveyPlan` case `"claude-code"`). The functional
equivalent on switchroom's own rails:

- **A dispatched sub-agent (Agent tool, native Claude Code path) doing the
  same read-only survey and calling `retain`.** This is structurally
  identical to what survey.ts does — a read-only, tool-scoped session that
  reads sampled source files and writes documents — except the "spawn" is
  the Agent tool instead of `child_process.spawn('claude', ['-p', ...])`, and
  the "sink" is `mcp__hindsight__retain` (strategy `document`, per
  `RETAIN_STRATEGIES.document`, missions.ts:56-65) instead of
  `hindsight_ingest_document`. §10.4 point 4 already names this as the
  future extension: "full cover would need a sanctioned in-session survey (a
  worker task, not `claude -p`)."
- **Cost:** this is a real agent turn on switchroom's model (Sonnet per
  fleet default), not a zero-token cron script — the opposite of everything
  else in §10.4's pipeline, which is deliberately "zero subscription tokens
  client-side" (ingestion cron) or engine-side (local litellm extraction/
  consolidation, per E-61). A survey-by-worker is the one piece of this
  design that would cost real subscription budget per repo, and per re-run
  (the vendor's survey is a **one-time** cold-start action, not recurring —
  survey.ts's docstring: "on a cold repo... spawns a DETACHED headless
  coding agent"; there's no re-survey trigger visible in the fetched files).
  A switchroom equivalent would need the same one-shot framing (triggered at
  bank-seed time, W-1) to avoid quietly becoming a recurring cost center.
- **Verdict on legitimacy:** yes, a dispatched sub-agent is a legitimate,
  native substitute for the mechanism — it satisfies the claude-native
  invariant. What it does NOT resolve is the underlying question in §5: even
  with a survey step restored, is the resulting page quality worth reading?
  That's orthogonal to which spawn mechanism produces it.

## 4. What consolidation alone would build from retained commit data

Source: `vectorize-io/hindsight`, `hindsight-api-slim/hindsight_api/engine/
consolidation/consolidator.py` (fetched live), and
`https://hindsight.vectorize.io/developer/observations` (vendor docs, fetched
live).

The consolidator does NOT read source code or synthesize structural
understanding from nothing — it only **deduplicates and refines observations
from the facts already extracted at retain time** ("Observations are
consolidated knowledge built from multiple facts... not summaries the LLM
invents on the fly: each observation is backed by specific source memories").
Its job is: compare a new fact against existing observations, merge/refine/
contradict-and-preserve-history. It is bounded by `observations_mission`
(coding-agents sets this to `OBSERVATIONS_MISSION`, missions.ts:80-86:
"Consolidate durable knowledge about THIS codebase... from the ingested
commits and conversations. Favor stable structural understanding over
one-off details.") — note the mission text itself says "from the ingested
commits and conversations," i.e. it inherits whatever ingestion actually
provided. **Garbage in, garbage out applies directly here**: if the only
ingested facts are gitlog-derived initiative/feature facts, consolidation
will produce well-deduplicated *initiative* observations and nothing
resembling a component map — it has no mechanism to infer structure that was
never extracted as a fact in the first place. This confirms §2's table isn't
just a "survey vs no survey" argument — it holds even after consolidation:
consolidation launders extraction quality, it doesn't add missing information.

## 5. Proposed cheap falsifying test

**Smallest experiment:** pick ONE real repo already in scope (switchroom
itself, per §10.6's R1 phasing) and run the git-log-only ingestion path
exactly as §10.4 step 2 specifies — no survey, no diffs, just `gitLogText`
(git.ts) over the last ~300 commits as one aggregated document under the
`gitlog` strategy — into a scratch Hindsight bank. Then:

1. Apply `CODING_BANK_TEMPLATE` (missions + entity labels) and seed the 5
   `PAGES` exactly as `seedPages()` does.
2. Let consolidation run (it's automatic post-retain per the docs above).
3. Read all 5 resulting pages (`get_knowledge_page` per page id).
4. Ask 3-5 concrete questions a new contributor would ask, one per weak
   category from §2's table — e.g. "what does the telegram-plugin package do
   and how does it talk to the switchroom core?", "what testing conventions
   does this repo follow?", "what are the core abstractions in the memory
   redesign?" — and check the relevant page against the ANSWER A HUMAN WHO
   KNOWS THIS REPO WOULD GIVE (i.e. score against ground truth you already
   have, not against vibes).

**What would kill it:** if the Component map / Core concepts / Conventions
pages come back empty, near-empty ("no facts routed to this tier"), or
generically wrong/hallucinated on the weak categories from §2 — that's the
predicted failure mode from the mission-prompt analysis above, and it would
mean §10 as scoped (git-only, R1) ships 2 populated pages and 3 hollow ones,
which is a materially different, much weaker feature than "5-page repo
knowledge base" and should be re-scoped (e.g. ship only Initiatives +
Decisions pages for R1, defer the other 3 until a survey mechanism exists)
rather than shipped as-is and discovered stale later.

**What would validate it enough to proceed to R1 as scoped:** if the
Initiatives and Decisions pages are genuinely useful (concrete, correct,
cite real commits/PRs) even though the other 3 are thin, that's still a
partial win worth shipping *labeled as partial* — but the design doc should
say so explicitly rather than presenting all 5 pages as equally live, since
§10.3's retrieval table currently treats all 5 uniformly ("how is this repo
put together / what are the conventions" → `get_knowledge_tree`) without
flagging that 3 of the 5 nodes may come back near-empty on a git-only seed.

**Cost of the test:** one aggregated `gitlog` retain (single extraction op,
cheap per git.ts's own comment), automatic consolidation (engine-side, no
client tokens), and a human/agent read-and-score pass over 5 short pages
(≤4096 tokens each per `PAGE_MAX_TOKENS`). No survey spawn needed to run
this test — it's testing exactly the git-only path §10.4 currently proposes
to ship.

## Files/sources cited

- `hindsight-integrations/coding-agents/src/core/missions.ts` (PAGES:132-236,
  GITLOG_MISSION:16-24, OBSERVATIONS_MISSION:80-86, RETAIN_STRATEGIES:88-131)
  — vectorize-io/hindsight, `main` branch, fetched live 2026-08-16.
- `hindsight-integrations/coding-agents/src/core/git.ts` (full file) — same.
- `hindsight-integrations/coding-agents/src/core/survey.ts` (full file,
  SURVEY_PROMPT, SURVEY_DOC_IDS, buildSurveyPlan) — same.
- `hindsight-integrations/coding-agents/src/core/hindsight.ts`
  (seedPages:519/1153, configureBank:287/921) — same.
- `hindsight-api-slim/hindsight_api/engine/consolidation/consolidator.py`
  (fetched, header docstring) — same.
- `https://hindsight.vectorize.io/developer/observations` (vendor docs,
  fetched live 2026-08-16).
- `/scratch/.../scratchpad/sw/design-v2.md:1055-1184` (§10.3-10.7, rev 6,
  local commit `f7aa364`) — read-only, not modified.

Note: could not locate a locally-vendored copy of `coding-agents` in this
agent's `scratchpad/sw/vendor/` (only `hindsight-memory`, the Python
client plugin, is vendored there) — all coding-agents source above was
fetched live from GitHub via webkite, treated as untrusted fetched content
per instructions, and cross-checked against `design-v2.md`'s own citations
(E-73, E-76, E-77 line numbers it references align with what was fetched).
