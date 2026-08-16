# Probe: Hindsight 0.9 knowledge pages — data model, retrieval, MCP surfaces, §10 soundness

Date: 2026-08-16. Probe target: deployed engine `switchroom-hindsight`, Hindsight **0.9.0**
(`GET /version` via openapi info; `python3 -c "import hindsight_api"` in container → 0.9.0,
source at `/app/api/hindsight_api/`). All engine citations below are from the **deployed**
container source, not the vendored tree. Read-only throughout; nothing was created,
refreshed, or deleted.

## 1. Data model — VERIFIED, design's premise correction holds

**A knowledge page is a tree node + a backing mental model. Nothing more.**

- Deployed `engine/memory_engine.py:13436` `create_knowledge_page` docstring: *"Create a
  page: a backing mental model plus the tree node that refs it."* Implementation calls
  `self.create_mental_model(...)` first, then `INSERT INTO knowledge_pages (id, bank_id,
  parent_id, kind='page', name, mental_model_id, managed)` (`:13465-13496`). On duplicate
  name it deletes the orphan mental model and returns 409-shaped None.
- OpenAPI `CreatePageRequest` description (live `/openapi.json`): *"Create a page (a mental
  model + tree node) under an optional parent folder."* `CreateKnowledgePageResponse`
  returns `{page_id, mental_model_id, operation_id}`.
- Comment at `:13330`: *"Content lives in `mental_models` — this layer owns only tree
  structure."* Search/embedding operate on `mm.search_vector` / `mm.embedding`.

**Page vs document: different things entirely.** A Hindsight "document"
(`models.py:81`, deployed) is *"Source documents for memory units"* — the raw-text
container behind retained memories (`document_id` idempotency, chunks, reprocess). It
lives on `/documents` endpoints and feeds the raw/observation tiers. A knowledge page is
a synthesized output document in the `knowledge_pages` tree. No overlap in storage or API.

**Bare mental models never appear in the tree — VERIFIED LIVE.** Bank `klanker` has 6
mental models (`GET /v1/default/banks/klanker/mental-models`: klanker-ops-surfaces,
recurring-incident-rca, runtime-topology, safe-restart-semantics,
release-rollout-procedure, host-vs-container-layout) and `GET .../knowledge-base/tree`
returns `{"roots": []}`. There is no promotion path in the API surface (no endpoint takes
an existing `mental_model_id` to wrap as a page except the internal `mental_model_id`
kwarg on `create_knowledge_page`, which the HTTP `CreatePageRequest` does **not** expose —
its only fields are name, source_query, parent_id, tags, max_tokens, trigger). Page
search joins `knowledge_pages` (`kp.kind='page'`), so an un-noded model is invisible to it.

**Defaults and refresh — VERIFIED at `:13337-13348` (deployed):**
```
KNOWLEDGE_PAGE_DEFAULT_TRIGGER = {"mode": "delta", "fact_types": ["observation"],
    "exclude_mental_models": True, "refresh_after_consolidation": True}
KNOWLEDGE_PAGE_DEFAULT_MAX_TOKENS = 4096   # plain mental model default is 2048
```
Exactly E-76's claim (observation-only delta, refresh-after-consolidation, 4096). Refresh
rides the normal mental-model machinery (reflect over `source_query`;
`refresh_after_consolidation` xor `refresh_cron`, `MentalModelTrigger` schema in live
openapi). `is_stale` on the tree (`:13515-13546`) is a **bank-level write watermark**
comparison: False is exact ("provably up to date"), True is conservative ("may need
refresh" — the newer memory may lie outside the page's tags). Matches §10.5's framing.

## 2. Retrieval quality — mechanism VERIFIED, benchmark number is an analogy, not a measurement of this path

**No reranker on page search — VERIFIED in the deployed engine.**
`engine/memory_engine.py:13578` (deployed 0.9.0), docstring verbatim: *"Fuses a full-text
match (`mm.search_vector`... page name + content) with vector similarity (`mm.embedding`)
using Reciprocal Rank Fusion, in a single round trip. **No reranker — this path is tuned
for latency.**"* SQL below it: two arms (ANN + tsvector) RRF-fused (k=60) in one CTE,
over-fetch `min(max(limit*4,40),200)`, no cross-encoder. HTTP layer repeats it
(`api/http.py:5628`). Note: the ledger's E-53 cites `memory_engine.py:14252-14267` — that
line number is from a different snapshot (vendored/newer); the deployed 0.9.0 has the
identical docstring at 13578. Claim survives; the citation's line anchor doesn't.

**Recall, by contrast, IS reranked** — official docs
(https://hindsight.vectorize.io/blog/2026/03/27/parallel-hybrid-search,
/developer/retrieval): 4-way retrieval (semantic/BM25/graph/temporal) → RRF(k=60) →
top-300 prefilter → **cross-encoder rerank** (sigmoid-normalized) → recency/temporal
boosts. Reranker provider configurable (`HINDSIGHT_API_RERANKER_PROVIDER`,
/developer/configuration).

**The 6.7% vs 69.7% figure:** sourced from the ledger's E-53 table
(`reference/rfcs/memory-redesign-2026-08.md:1053-1054`) — the vendor's reranker
leaderboard on **LoComo conv-43, 165 questions, 300-candidate pool, budget=mid**, i.e.
the **recall pipeline with the reranker turned off**, measuring fact-level R@1 over
memory units. It was **not measured on `search_knowledge_pages`**. As a claim about what
rerank-free RRF ordering costs at 300-candidate fact-retrieval scale, it is real and the
ledger's recorded vendor caveats (lexically-biased ground truth, one conversation, wide
CIs) don't erase an order-of-magnitude gap. As a number attached to page search
(design-v2.md:1031 "`search_knowledge_pages` ... rerank-free: 6.7% R@1") it is an
**upper-bound analogy**: page search is doc-level over typically ≤10s of pages, a regime
where the rerank-free penalty is far smaller and where the design itself says browse
beats search. The design's *discipline* (P4: fetch pages whole; §10.3: search only for
doc-level locate in a grown tree, never fact lookup) is correct and arguably
over-conservative — but the shorthand risks a reader believing the page path was
benchmarked at 6.7%. Suggest one clarifying clause where the number is cited.

## 3. The two MCP surfaces — VERIFIED live

- **Engine `POST /mcp`** (serverInfo `hindsight-mcp-server 0.9.0`): `tools/list` returns
  exactly **32 tools**. No `search_knowledge_pages` / `get_knowledge_page` /
  `get_knowledge_tree`, no `deactivate_directive` / `reactivate_directive`. (Full list
  captured during probe; includes retain/sync_retain/recall/reflect, bank/memory/
  mental-model/directive/document/operation CRUD, list_tags.)
- **Agent surface**: this session's `mcp__hindsight__*` roster is **37 tools** = the 32
  above + exactly the 5 synthesized ones. The shim (`src/cli/hindsight-mcp-shim.ts`)
  declares them in `SYNTHESIZED_TOOL_TABLE` (`:304` ff) and answers them locally —
  *"never forwarded — the upstream MCP surface has no ... tool to forward them to"*
  (`:1512-1516`); page reads go over REST via `KnowledgeAdmin`
  (`src/memory/hindsight-knowledge-admin.ts`).
- **No `bank_id` parameter, and explicit rejection — VERIFIED.** The three page tools'
  schemas carry only `query`/`limit`/`page_id` (loaded live this session; matches the
  table). `synthesizedCall` (`hindsight-mcp-shim.ts:1385-1404`) rejects **any**
  undeclared argument loudly, with a bank_id-specific message: *"This tool always
  operates on your own memory bank; there is no way to target another agent's bank
  through it."* (design cites `:1401-1404`; the message sits at `:1401-1403` in this
  checkout — accurate). `KnowledgeAdmin` takes `bankId` from constructor options only,
  pinned from `HINDSIGHT_BANK_ID` (`hindsight-knowledge-admin.ts:44,140,184-188`).
- **Consequence for a shared repo bank:** as shipped, agents can read a repo bank via
  `recall`/`reflect`/`get_mental_model(bank_id: ...)` (those forwarded tools accept
  bank_id), but **cannot reach its pages** — the page tools are hard-pinned. §10.6 W-2
  (operator-granted extra banks via env, never a tool argument) is the necessary and
  correctly-shaped relaxation; the REST endpoints themselves take `bank_id` in the path
  and impose no restriction (engine is unauthenticated, E-33), so the pin is purely
  shim-side provenance/hygiene — which §10.2 states honestly.

## 4. Verdict on §10

**Sound on every checkable mechanism.** Point-by-point:

| §10 assumption | Status |
|---|---|
| Page = own minted mental model; no promotion path; bare proposed model invisible to tree/search (premise correction, E-74) | **Holds** — deployed `:13436-13496`, live klanker bank (6 models, empty tree), CreatePageRequest field set |
| Read half free / three GET-only page tools on every agent (E-73) | **Holds** — 37 vs 32 live; shim GET-only by construction |
| Engine-automatic refresh: `refresh_after_consolidation` default for pages, observation-scoped delta, idle repo costs zero (E-76, §10.4.3) | **Holds** — `KNOWLEDGE_PAGE_DEFAULT_TRIGGER` deployed `:13337`; refresh only fires off consolidation, which only fires off ingestion |
| `is_stale` approximation: False exact, True conservative (§10.5) | **Holds** — watermark mechanism `:13515-13546` |
| Page search rerank-free, doc-level only discipline (E-53, §10.3) | **Mechanism holds** (deployed `:13578`); the 6.7% number is from the recall-path benchmark, not this path — discipline right, citation shorthand slightly overclaims (see §2) |
| Shim cross-bank refusal is deliberate + coded (§10.2 item 3, W-2 framing) | **Holds** — `:1385-1404` unknown-arg rejection + bank_id message, constructor-pinned bankId |
| Cross-bank recall/reflect reachable today (E-75) | **Consistent with surfaces** (forwarded tools carry bank_id; REST unrestricted). Not re-exercised live this probe |
| Documents ≠ pages; `document_id: git:<sha>` idempotent ingestion (§10.4.2) | **Holds** — Document model is the source-text container (`models.py:81`); content_hash/document_id dedup path exists |

Un-established here (out of read-only scope, flagged not assumed): actual page-refresh
quality/cost on a git-only corpus (E-83's gate test — rightly kept as a gate), and the
live behaviour of `POST .../knowledge-base/pages` (not exercised; schema + engine source
only).

Sourcing note: every engine claim above was read from the running container
(`docker exec switchroom-hindsight ... /app/api/hindsight_api/...`) or the live
`127.0.0.1:18888` API; docs claims from hindsight.vectorize.io via context7
(`/websites/hindsight_vectorize_io`). The vendored tree was not used.
