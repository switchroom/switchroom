# Probe: what the vendor says knowledge pages are FOR (docs-first, cross-checked live)

Date: 2026-08-16. Sources: `https://hindsight.vectorize.io/developer/knowledge-pages`,
`/developer/api/knowledge-pages`, `/developer/mental-models`, `/developer/observations`,
`/developer/retrieval` — fetched live via webkite this session (`webkite_read`, 200s,
`content_sha256` recorded in each fetch's diagnostics). Cross-checked against
`probes/knowledge-pages-09.md` (read, not modified) and this session's own recall of the
deployed engine (127.0.0.1:18888, Hindsight 0.9.0) via prior probe findings — no new
mutating or even additional live calls were needed since 09 already pulled the exact
defaults from deployed source; this probe adds no new engine citations, only doc citations.
Read-only, nothing created.

## 1. Intended use cases — vendor's own words

**What pages solve that recall doesn't, stated directly** (`/developer/knowledge-pages`):
> "This is a different path from recall, which searches individual memories. Use page
> search to pick a document; use recall for a specific fact."

And on why search returns whole documents rather than fragments:
> "Search is a tool an agent *chooses* to call, visible in the transcript, rather than
> content pushed into its context on every turn. Retrieval the agent asked for informs
> what it's doing; retrieval it didn't ask for tends to derail it."

**The core positioning — pages vs hand-maintained files, explicit:**
> "A file is where information goes to age. Whoever wrote it last wins, contradictions
> accumulate quietly, and nothing ever reconciles them... A knowledge page is a
> **projected view** over processed memory, the way a database view is not a table...
> Your raw documents remain the source of truth about *what was said*. The pages are the
> reconciled truth about *what holds*." "Delete a page and nothing is lost — it
> re-projects from memory."

**Page vs mental model — stated directly, and it's a strict subset relationship, not a
parallel primitive:**
> "A knowledge page *is* a mental model. Same synthesis, same background refresh, same
> provenance. What's different is how much you have to know to use one... So a page
> comes with those decisions already made" (observation-only scope, incremental delta
> refresh, no cross-page reads, bigger token budget).

So the vendor's own framing is: **mental model = general primitive with exposed knobs;
knowledge page = mental model with the knobs pre-set for the "wiki page" use case.** Not
two different mechanisms — one is a preconfigured instance of the other. The API docs
confirm this at the storage level: `knowledge_pages` "owns only tree structure —
everything about the content lives on the backing mental model, which is why every
mental model capability applies to pages unchanged" (`/developer/api/knowledge-pages`).

**When to use a *separate bank* — not stated in the knowledge-pages or mental-models
docs.** Neither page fetched discusses bank-vs-page or bank-vs-model tradeoffs; that
decision boundary (one bank vs many) is out of scope for these two docs. Not stated.

**Mental model docs give the complementary half of the "when":**
> "The reason to use a mental model is speed... your application simply reads the
> current version. Fetching a mental model is a database read. No retrieval, no
> synthesis, no LLM call, no waiting." And: "Mental models are also the first thing
> reflect reaches for" — the reflect retrieval ladder is **mental models → observations
> → raw facts**, each "a cheaper, more settled version of the one below it."

So the vendor's implicit hierarchy (stated across the mental-models and observations
docs, not as one single table but assembled from both): a mental model/page is the
top of a ladder that reflect descends through; a page is the wiki-shaped, multi-page,
browsable specialization of that same top layer, positioned specifically against
*recall* (fragment-level) and against *files* (unreconciled, decaying), not explicitly
against a *bank* (unaddressed).

## 2. Mechanics that bear on multi-agent use

**Who can read a page / scoping — the docs say this is a *mental-model* mechanism a
page inherits, described only in general terms:**
> "A mental model's tags decide two things: which memories it is allowed to read, and
> which callers are allowed to see it. A model scoped to one customer, team, or user is
> built only from that scope's memories and surfaces only for requests in that scope —
> the same isolation rules that govern the rest of the bank, applied to synthesized
> knowledge." (`/developer/mental-models`)

This is stated at the mental-model level and the page API docs say "every mental model
capability applies to pages unchanged" — so by direct inference pages should inherit
tag-based caller scoping too. **But the docs never show a worked page example with
caller-scoping tags**, and the mechanism ("which callers are allowed to see it") is not
spelled out concretely (what counts as a "caller," how tag-based auth is enforced at the
HTTP layer) in either doc fetched. Flag: this is the one place the docs assert something
that probe-09's live findings arguably contradict or at least don't corroborate — see §3.

**Refresh mechanics — fully stated:**
- Default trigger on create: `{"mode": "delta", "fact_types": ["observation"],
  "exclude_mental_models": true, "refresh_after_consolidation": true}`, `max_tokens: 4096`
  (`/developer/api/knowledge-pages`, verbatim JSON block).
- Refresh is incremental/delta by default — edits, doesn't regenerate — "so hand-tuned
  structure and wording survive."
- "A supplied `trigger` **replaces** these defaults, it does not merge with them" —
  explicit caution, e.g. `{"trigger": {"mode": "full"}}` also resets `fact_types` to all
  types, `exclude_mental_models` to `false`, `refresh_after_consolidation` to `false`.
- Staleness: tree-level `is_stale` is a bank-wide watermark (`last_memory_write_at`)
  compared to the page's last refresh — an approximation ("may need a refresh"); the
  page's own mental model, fetched via `GET /mental-models/{id}`, evaluates the page's
  actual tag/fact-type scope for an exact answer. Matches probe-09 exactly.

**Bank with multiple writers — not stated.** Neither the knowledge-pages page, the
knowledge-pages API page, the mental-models page, nor the observations page discusses
what happens when multiple independent writers (e.g. multiple agents) retain into the
same bank concurrently, whether page refreshes serialize, or any locking/race behavior
around a shared page. The closest adjacent material is the *tag-scoping* story above
(which memories a model reads) and the consolidation-dedup story in `/developer/observations`
(near-duplicate observations get merged above a 0.97 cosine-similarity threshold, and
this reconciliation is explicitly scoped **within the same tag scope** — "if you tag
retains with a unique per-call value... each session lands in its own scope and never
dedups against the others"). That's about observation dedup, not about concurrent page
writers, but it's the nearest documented behavior for "what happens when many things
write into one bank." Not stated: page-specific multi-writer semantics.

**Pages across banks / shared or team banks — not stated.** No mention in any of the
four docs fetched of a page spanning multiple banks, a "team bank," or any
`additional_banks`-style fan-out for the page tools. The knowledge-base endpoints are
explicitly bank-scoped in the path (`/v1/default/banks/{bank_id}/knowledge-base`) with
no cross-bank parameter shown in any request example. This is consistent with — not
contradicting — probe-09's live finding that the page MCP tools take no `bank_id` and
are hard-pinned to the caller's own bank.

## 3. Cross-check against probe-09's live findings — where docs and deployed engine agree / disagree

| probe-09 claim (live, deployed 0.9.0) | Docs say | Verdict |
|---|---|---|
| Page = tree node + a mental model `create_knowledge_page` mints itself | "A page is backed by a mental model... Create — the page is stored with placeholder content and a background refresh is submitted" (`/developer/api/knowledge-pages`); response is `{page_id, mental_model_id, operation_id}` | **Agrees exactly.** |
| Defaults `{mode: delta, fact_types: [observation], exclude_mental_models: true, refresh_after_consolidation: true}`, 4096 tokens | Verbatim identical JSON block and "Defaults to 4096 (a plain mental model defaults to 2048)" in the API doc | **Agrees exactly, word-for-word and number-for-number.** |
| No reranker on page search | "Document-level hybrid search: a full-text (BM25) match and a vector-similarity match, fused with Reciprocal Rank Fusion. There is no reranking step, which keeps it fast enough to be an agent's first call." | **Agrees exactly**, and the docs give the *reason* (latency/first-call speed) matching the deployed docstring's "tuned for latency." |
| Page tools take no `bank_id` | All doc examples pass `BANK_ID` explicitly as the first client-call argument (`client.create_knowledge_page(BANK_ID, ...)`, `client.get_knowledge_base_tree(BANK_ID)`, etc.) and the REST path is `/v1/default/banks/{bank_id}/knowledge-base/...` | **This is the one place docs and deployed diverge — but not in contradiction, in scope.** The **HTTP/SDK API** the docs describe is bank-scoped by path/argument on every call, exactly as probe-09 also found for the REST layer ("the REST endpoints themselves take `bank_id` in the path and impose no restriction"). What has no `bank_id` is specifically the **agent-facing MCP shim's synthesized tool surface** (`search_knowledge_pages`, `get_knowledge_page`, `get_knowledge_tree` as exposed to *this* agent) — a narrower, switchroom-side wrapper, not the vendor's documented API. The vendor docs never describe an MCP tool without a bank parameter; the closest doc mention of agent-native tools is one throwaway line: "Agent tools — the agent SDK exposes `agent_knowledge_*` tools so an agent can list, read, create, and update its own pages during a session" (`/developer/knowledge-pages`) — no schema shown, so whether the vendor's own `agent_knowledge_*` tools take a bank_id is **not stated**. **No disagreement found; the "no bank_id" property is a shim-layer design choice, correctly attributed to the shim by probe-09, and the docs are silent on whether the vendor's own agent SDK tools share that property.** |

**No other disagreements found.** Every mechanism-level doc statement checked against
probe-09's line-cited deployed-engine claims (data model, defaults, refresh triggers,
staleness watermark, no-reranker search) matches exactly, in most cases down to the
verbatim JSON. The 6.7%-vs-69.7% R@1 concern probe-09 already flagged is a citation-
provenance issue in the design doc, not a docs-vs-engine disagreement — confirmed again
here: the "no reranker" docs page (`/developer/api/knowledge-pages`) states the *design
reason* (fast first call) but gives no retrieval-quality number for page search at all,
consistent with probe-09's conclusion that no vendor benchmark measures
`search_knowledge_pages` specifically.

## 4. Decision table — knowledge page vs mental model vs dedicated bank vs `additional_banks` fan-out

| Primitive | Good at | Cost | Failure mode if misused | Grounding |
|---|---|---|---|---|
| **Knowledge page** | Browsable, multi-document wiki over one bank's settled knowledge; document-level "which page has this" search; safe to expose to an agent as a first-call, transcript-visible tool since retrieval is opt-in, not injected | 4096-token doc-level synthesis, incremental delta refresh (cheap after first build); rerank-free search is fast but doc-level-only, not fact-precise | Using page search for fact lookup instead of document selection — rerank-free ranking is a doc-level design choice, and the docs never claim fact-level precision for it; also, pages "never read other pages," so relying on one page to cite/aggregate across siblings will silently fail (explicit anti-feedback-loop design) | Doc statements §1/§2; probe-09 §1/§2 live confirmation of mechanism |
| **Mental model (bare)** | A single standing answer to one question, read at DB-read speed with no synthesis-on-request; first rung of reflect's retrieval ladder; scoping via tags controls both build-scope and caller-visibility | 2048-token default (page default is 4096); exposes and requires you to reason about refresh triggers/scope yourself, unlike a page's pre-set defaults | Treating a bare model as browsable/discoverable — bare models never appear in the knowledge-base tree (probe-09, live: klanker bank has 6 models, empty tree) and are invisible to page search; there's no promotion path from bare model to page in the documented API surface | `/developer/mental-models`; probe-09 §1 live: "Bare mental models never appear in the tree — VERIFIED LIVE" |
| **Dedicated bank** | Hard isolation boundary — separate memory pool, separate consolidation/observation scope, separate knowledge-base tree entirely | Full duplication of retain/consolidate/refresh machinery per bank; no doc-described cross-bank page mechanism | Splitting a knowledge domain across banks expecting pages or mental models to see across the split — not supported per any doc read; page/model tools operate within one bank's path/argument in every documented example | **Reasoned, not directly doc-sourced** — inferred from the consistent bank-scoped-path pattern across all knowledge-base API examples; docs never explicitly discuss when to choose "separate bank" as a design lever (§1, "not stated in the docs") |
| **`additional_banks` fan-out** (agent-side pattern, not a vendor doc term) | Letting one agent's `recall`/`reflect` reach into another bank's raw memories/models when tools carry an explicit `bank_id` argument (as REST and SDK calls do throughout the docs) | Whatever the operator grants — the docs show `bank_id` as a plain call argument with no built-in fan-out primitive; "fan-out" is an integration pattern the caller builds, not a documented Hindsight feature | Assuming this reaches page content too — probe-09 found page MCP tools are shim-pinned to the caller's own bank with an explicit rejection message ("there is no way to target another agent's bank through it"); the *vendor* docs don't describe this restriction because they don't describe the MCP shim at all — **mixed source**: the restriction is shim-side/probe-09-verified, not a vendor-documented boundary | Vendor docs: bank_id present as a plain argument throughout, no fan-out primitive described (not stated as unsupported, just never shown). Shim behavior: probe-09 §3, live, `hindsight-mcp-shim.ts:1385-1404` |

**Rows marked "reasoned, not directly doc-sourced" or "mixed source" above are the ones
to treat with lower confidence** — the dedicated-bank row and the fan-out row's cost
column both extrapolate from the consistent shape of documented examples rather than
from an explicit vendor statement on bank-selection strategy.

## Headline findings

1. **Vendor's own framing is a strict hierarchy, not four peer primitives:** page ⊂
   mental model ⊂ (reflect's retrieval ladder: mental models → observations → raw
   facts). A page is explicitly "a mental model" with pre-set defaults for the
   wiki-document use case — not a separate mechanism.
2. **Every mechanism-level claim in probe-09 (defaults, data model, no-reranker search,
   staleness watermark) matches the docs verbatim** — no disagreement found on any of
   those points.
3. **The one place that looked like a potential doc-vs-deployed conflict — page tools
   having no `bank_id` — resolves as no conflict on inspection**: the vendor's
   documented HTTP/SDK API is bank-scoped by argument/path everywhere; the "no
   `bank_id`" property belongs to this deployment's MCP shim (a switchroom-side layer),
   which the vendor docs don't describe at all (they only namecheck `agent_knowledge_*`
   agent-SDK tools once, with no schema shown).
4. **Multi-writer-bank semantics and cross-bank/shared-bank pages are simply not
   addressed anywhere in the four docs fetched** — worth stating plainly as "not stated"
   rather than inferring an answer, per the probe's own instructions.
