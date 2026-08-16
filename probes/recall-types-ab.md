# Probe: recall `types` A/B — world+experience (current) vs observation-only vs combined

**Verdict: not settled by this data outright, but the data does falsify two specific claims about E-70.** (1) Observations are NOT a starved minority of these corpora (16–33% of facts across 4 banks measured) — the "observation-only would starve" worry is not supported. (2) `types: ["world","experience","observation"]` (combined) never scored worse than the current config in this sample and strictly recovered relevant, higher-scoring observations in ~4/15 queries that current config missed entirely. Directional recommendation: **switch to combined (all three types) over current, in preference to observation-only** — but this is 15 queries across 3 banks, one sitting, no repeated trials, and is suggestive, not conclusive. It should not ship without a larger run.

All calls made read-only against `127.0.0.1:18888` via `mcp__hindsight__recall` / `get_bank_stats` / `list_memories`. No retains, no mental-model writes, no invalidations were performed.

## Method

- Banks: `klanker` (266,470 facts, largest sampled), `gymbro` (20,371, mid), `ziggy` (2,090, smallest). Picked for volume spread per the task's instruction; `overlord` (308,306) stats were pulled too but not query-probed (budget ran out — see Limits).
- Queries: 15 total (6 klanker, 5 gymbro, 4 ziggy), hand-derived from real content pulled via `list_memories` on each bank (not invented) — e.g. klanker's own live RFC document about this exact defect, gymbro's alcohol/calorie/protein/sleep tracking facts, ziggy's Panorama/Goodfellow/SPEAR facts.
- For each query, ran `recall` three times, varying only `types`: `["world","experience"]` (current default), `["observation"]`, `["world","experience","observation"]` (combined). `prefer_observations` left at default (false) — out of scope here, already established as a no-op per E-70.
- Judged relevance by reading the actual returned text against the query intent — a judgment call, not a metric, and stated as such below.

## Bank type composition (get_bank_stats, live)

| Bank | world | experience | observation | total | obs % of corpus |
|---|---|---|---|---|---|
| klanker | 156,738 | 52,611 | 57,121 | 266,470 | 21.4% |
| overlord | 213,131 | 37,230 | 57,945 | 308,306 | 18.8% |
| gymbro | 12,731 | 4,376 | 3,264 | 20,371 | 16.0% |
| ziggy | 1,130 | 274 | 686 | 2,090 | 32.8% |

Observations are a meaningful fraction everywhere sampled (16–33%), not a token minority. The "observation-only recall would starve" concern in the task brief is **not supported** by these four banks' corpus composition. (Whether observation-only starves *specific* queries is a separate question — see below, it does not in this sample, top-1 relevance was never empty.)

## Result-count and score-shape pattern (consistent across all 15 queries)

- `["world","experience"]` and combined almost always returned **2–3 results**, then results simply stopped (in Hindsight's recall, results plainly get gated off — this looks like a score-threshold/elbow cutoff, not a fixed top-K, since the number varies 2–3).
- `["observation"]` alone consistently returned **4–7 results** with scores staying above ~0.9 much further down the list, because consolidation generates several near-duplicate paraphrases of the same underlying fact as separate observation rows (e.g. gymbro's "150 g protein target" surfaced as 6 near-identical observation memories from different dates/sessions). This means observation corpora are **denser but more redundant** — raw result-count comparisons between configs are misleading unless you control for this duplication.
- Combined's result count tracked the world/experience count (2–3), *not* the observation count — i.e., combined behaves like "top-N across all types by score," not "union of both configs." When a world/experience fact and its observation paraphrase score nearly identically (common, since they describe the same event), the near-duplicate world/experience version tends to win the slot and the observation is silently dropped from combined's output even though it's substantively the same information.

## Per-query relevance judgment (my read of the text, not a score)

**klanker** (6 queries — recall config defect, vendor benchmark, knowledge-index trigger, CLAUDE.md/MEMORY.md limits, migration rollback ordering, Hindsight tool count):
- world/exp top hits: relevant in 6/6.
- observation-only top-1: relevant in 6/6; tail (rank 3+) went off-topic in 2/6 (e.g. the "knowledge-index regeneration" query's obs tail surfaced unrelated pg_search index-drift facts sharing only the word "drift").
- combined: **matched world/exp exactly (dropped the observation) in 4/6**; in 2/6 (CLAUDE.md/MEMORY.md limits; Hindsight tool count) it correctly mixed in 1 relevant observation with a distinct, useful detail (e.g. an observation citing the byte-ratchet limit of 31,120 bytes, which neither the world/exp-only nor the query text itself mentioned).

**gymbro** (5 queries — alcohol/dry-flag bug, calorie-deficit physiology model, protein target, sleep tracking, body-composition trend):
- world/exp top hits: relevant in 5/5.
- observation-only top-1: relevant in 5/5; very dense but genuinely on-topic through rank 4–6 in 4/5 (this bank's observations are tightly scoped daily-log facts, so duplication was less noisy than klanker's).
- combined: **matched world/exp exactly in 3/5**; in 2/5 it **strictly improved** on current — most notably the calorie-deficit query, where the single highest-scoring result across *all* types was an observation (`1494c595…`, final score 1.0022, "Garmin reported total calorie burn 1208 kcal vs physiology model 2787 kcal") that world/exp-only never surfaces at all under current config. That's a concrete, non-hypothetical instance of the defect: a materially useful, top-ranked fact invisible to auto-recall today.

**ziggy** (4 queries — bond release-date letter preference, SPEAR applicant, Panorama permit amendment, Goodfellow estate/solicitor):
- world/exp top hits: relevant in 4/4.
- observation-only top-1: relevant in 4/4; ziggy's obs tail was the noisiest of the three banks — the bond query's obs-only set included an unrelated $58,972.80 civil-works-bond fact at score 0.098 (clearly below any reasonable cutoff, so low practical risk, but illustrates the duplication issue).
- combined: **matched world/exp exactly in 3/4**; in 1/4 (SPEAR applicant) it kept both the experience-type correction fact and an observation with a materially different, useful detail (the specific pending SPEAR application number and blocking Civil Infrastructure RA Response date) that world/exp-only did not surface.

## Net tally across all 15 queries

- world/exp top-1 relevant: 15/15
- observation-only top-1 relevant: 15/15 (tail noise in 3/15, all below informative score ranges)
- combined identical to world/exp-only (observation silently dropped): **10/15**
- combined strictly better than world/exp-only (surfaced a materially useful, non-duplicate observation): **5/15**
- combined strictly worse than either single-type config: **0/15**

## Token/payload cost (qualitative, not exact byte counts)

I did not instrument exact token counts server-side; the payload sizes below are eyeballed from the JSON actually returned in this session, not measured with a tokenizer — treat as an order-of-magnitude read, not a number to build a cost model on.

- `["world","experience"]`: smallest payload, 2–3 results, but each result carries a heavier metadata block (`document_id`, `context`, full `metadata` object with chat_id/session_id/retain_part_count etc).
- `["observation"]`: leaner per-item schema (no `document_id`/`context`, `metadata` empty in every sample seen), but 2–3x more items per query, so **total payload usually came out larger** than world/exp-only across the queries sampled.
- combined: tracked world/exp-only's item count (2–3), so its payload was close to world/exp-only's, occasionally +1 item when an observation won a slot. It was never close to observation-only's volume.

This is directionally consistent with the RFC's stated 0–65% cost-range language (per the klanker bank's own record of that correction) — combined is not "both configs' cost stacked," it's closer to current cost with an occasional extra item.

## Limits of this method (be explicit)

- **3 banks, 15 queries, one pass, no repeated trials.** No variance/confidence interval — a different random query set could shift the 10/15 vs 5/15 split materially.
- **`overlord` (308k facts, the largest bank) was not query-probed** — only its `get_bank_stats` was pulled. The "meaningfully different volume" instruction was satisfied via gymbro/ziggy instead; if overlord's redundancy pattern differs at that scale, this finding could change.
- Relevance was judged by me reading result text against query intent — a judgment call, explicitly not a precision/recall metric. No independent second-rater.
- Queries were derived from content I happened to sample via `list_memories` (limit 30 per bank/type) — not a random or stratified sample of each bank's full query distribution, so results may not generalize to the kinds of queries auto-recall actually fires on in production.
- Did not test `min_scores` or `max_tokens` variation, which would materially change the 2–3-result cutoff behavior observed under world/exp and combined — the "elbow cutoff" mechanism itself was not identified from source, only inferred from output shape.
- Token/payload costs are eyeballed, not tokenizer-measured.

## Files/evidence

- All findings above are from live `mcp__hindsight__recall` / `mcp__hindsight__get_bank_stats` / `mcp__hindsight__list_memories` tool calls against `127.0.0.1:18888` in this session (2026-08-16). No files were read; this probe is standalone and does not depend on `design-v2.md` or the RFC (both left untouched, per instruction).
