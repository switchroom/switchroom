# sde-bench sourcing probe (E-57 / E-69)

Probe date: 2026-08-16. All web content treated as untrusted data. Local working copies
cloned read-only under `/scratch/.../scratchpad/{amb,sdb,hs-repo,hca}`.

## Verdict up front

- **The final-campaign numbers (reflect-arm wins) are well sourced**: per-task, per-run JSON
  is public in `vectorize-io/agent-memory-benchmark` under `outputs/sdebench/`, and my
  independent recomputation reproduces the blog table to two decimals.
- **The losing-arm run (1.06 vs 0.97) is NOT published.** No output file, no config, no agent
  name, no run count, no suite version exists anywhere public. Its only source is one paragraph
  of blog prose. E-69's characterization of that arm is *plausible but unverifiable* as to the
  exact configuration at run time.
- The 0.09 delta in the losing run is on the order of the observed run-to-run noise
  (sd ≈ 0.03–0.07 corrections/task across the published triplicate runs), so with an unstated
  run count it is **not distinguishable from noise** on the published evidence. This weakens the
  original E-57 claim as much as the walk-back.
- **We could regenerate the comparison ourselves**: the public harness still carries a
  recall-mode arm (`--history hindsight`) alongside the reflect arm (`--history hscoding`).

---

## 1. What is actually published, where

### Blog (the only source for the 1.06/0.97 number)
URL: https://hindsight.vectorize.io/blog/2026/08/06/hindsight-0-9-0 (fetched 2026-08-16,
content sha256 `028ad195…`)

Verbatim, the losing arm in full — this is everything the blog says about its config:

> "Our integrations did what most of the ecosystem does: **automatic recall on every prompt**
> — embed the message, retrieve similar memories, inject them. On the suite as it stood then,
> that scored **1.06 corrections per task versus 0.97 for no memory at all**."

Note three things the prose itself concedes:
- "**On the suite as it stood then**" — an *earlier version* of the suite, not the final
  61-task set. Task count at that time: unstated.
- Agent/model for that run: unstated. Run count: unstated. CI: none.
- "Our integrations" (plural) — which plugin, and with what recall parameters (top-k, token
  cap, types): unstated.

The winning arm, verbatim:

> "the plugin reflects **once, on the first prompt**, caches the synthesis, and re-injects it
> every turn … reflect stays available **as a tool**"

And the promise that the losing run's details are still to come:

> "the harness, per-task results, and the full hardening journal (including the run where our
> own architecture lost to no memory at all) land at agentmemorybenchmark.ai in August 2026."

As of 2026-08-16 the harness and per-task results HAVE landed (in the GitHub repo; the
website itself is an SPA that would not render for me), but **no hardening journal is
published anywhere I could find** — not in `agent-memory-benchmark`, not in `sde-bench`
(README/DATASET.md/DATASET_DESIGN.md/GENERATING.md have zero hits for `1.06`, `0.97`,
`journal`, or `recall`), not in `hindsight-benchmarks`.

### Harness (public, real)
Repo: https://github.com/vectorize-io/agent-memory-benchmark — `sdebench/harness/run.py`
(909 lines), datasets mounted as submodule from https://github.com/vectorize-io/sde-bench.
Dataset also mirrored at https://huggingface.co/datasets/vectorize-io/sde-bench.

Arms at HEAD (`run.py:721`):
`--history {full, squashed, hindsight, hscoding, memtool, inject, oracle, hybrid, index, provided, conversations, skill}`

- **`full`** = vanilla baseline: full git history, `HINDSIGHT_DISABLED=1` (`run.py:140`).
  Past developer conversations are made *available* (seeded as opencode sessions /
  markdown transcripts under `/root/project-history`) but never injected — "availability +
  agency, not injection" (`run.py:596-600`, `seed_transcript_files` docstring).
- **`hindsight`** = **recall mode**: squashed repo (history lives only in the memory bank),
  Hindsight opencode plugin with `HINDSIGHT_MEMORY_MODE="recall"` (`run.py:134-138`).
  This is the closest surviving analogue of the losing arm.
- **`hscoding`** = the shipped `hindsight-coding-agents` plugin, "reflect + INJECT"
  (`run.py:759-762`); for claude-code, "a UserPromptSubmit hook that reflects+injects
  (no MCP)" (`run.py:267-269` comment).
- Plus ablations: `inject` (push top-k TF-ranked raw commits into the prompt), `oracle`
  (inject the known cause commit — upper bound), `index` (derived DECISIONS.md),
  `conversations` (recall skill/tool), etc. The vendor clearly ran a broad config matrix;
  only the vanilla-vs-reflect campaign results are published.

### Published per-task results (I verified these)
`outputs/sdebench/*/coding/boltons.json` — 61 tasks each, with per-task `interventions`
(= corrections), solved flag, cost, tokens, wall time, and the injected memory content in
`context`. My recomputation (mean interventions/task):

| arm | runs | per-run values | mean | sd |
|---|---|---|---|---|
| vanilla-claude (sonnet-5) | 3 | 0.918, 0.820, 0.803 | **0.847** | 0.062 |
| hindsight-claude | 3 | 0.393, 0.279, 0.410 | **0.361** | 0.071 |
| vanilla-codex (gpt-5.4-mini) | 3 | 1.311, 1.361, 1.361 | **1.344** | 0.028 |
| hindsight-codex | 3 | 0.410, 0.492, 0.508 | **0.470** | 0.053 |
| vanilla-opencode (gemini-3.5-flash) | 3 | 1.213, 1.246, 1.131 | **1.197** | 0.059 |
| hindsight-opencode | 3 | 0.820, 0.754, 0.820 | **0.798** | 0.038 |

Matches the blog table (0.85→0.36, 1.34→0.47, 1.20→0.80). The blog's headline is honest
against its own raw data. The `hindsight-*` runs' `context` fields carry an actual
"## Memory (reflect)" synthesized answer per task — confirming the winning arm injected a
**synthesized conclusion**, not fragments. (There are also two extra runs each of
`full61-cc-hs` / `full61-cc-none`, consistent: 0.328 vs 0.844.)

## 2. The losing arm: what is and isn't recoverable

**Not recoverable from any public source:** the exact configuration of the 1.06 run — agent,
model, suite version/task count, run count, recall top-k/budget/token cap, memory types,
sync/async injection point. The AMB repo's entire git history is 36 commits; sdebench
arrived as one squashed commit (`7acca55` "sdebench: does memory help a coding agent?"),
so the pre-August iterations are not in history. No output directory for a recall arm exists.

**Recoverable, as circumstantial context only (do not backdate onto the losing run):**
the *current* opencode plugin (`hs-repo/hindsight-integrations/opencode/src/`) does
auto-recall with defaults `recallBudget: "mid"`, `recallMaxTokens: 1024`,
`recallTypes: ["world","experience"]` (`config.ts:56-62`), injected into the system prompt.
Notably, at HEAD it recalls **once per session** (`recalledSessions` dedup, `hooks.ts:29-30,297-331`)
— i.e. the shipped code has already moved past the per-prompt pattern the blog describes.
The losing run used "our integrations … [as they were] then"; that older per-prompt code is
what I could not locate.

So: E-69's claim that the losing arm was "raw unsynthesized fragments injected synchronously
per prompt" is **consistent with the blog prose** ("embed the message, retrieve similar
memories, inject them", "per-prompt recall put a retrieval round-trip in front of every
single message") — the "raw fragments" part is supported by "Recall returns fragments — a
handful of loosely similar snippets, each plausible, none synthesized". But token cap,
count, and whether injection blocked the reply path are **prose, not config**. The walk-back
is an interpretation of marketing narrative, and remains exactly that.

## 3. Domain — settled

Coding, unambiguously: 61 bug-fix tasks planted in the `boltons` Python library, graded by
pytest in Docker, metric = correction rounds (cap 5), no LLM judge. Source: sde-bench README
(https://github.com/vectorize-io/sde-bench) and the harness. The walk-back's
"coding benchmark ≠ chat/persona channel" premise **holds**.

Also material for transferring the result to Hermes/openclaw: the bench's bank is
**pre-seeded with planted decisive answers plus 140 decoy conversations** ("Yes, the answers
are seeded into the bank — deliberately"), and the vanilla baseline is a *strong* one (full
git history + browsable past-conversation transcripts). This measures "can retrieval
outrank noise to find a known-decisive fact on a symptom-distant query", which is not the
observation-recall workload our per-turn injection serves.

## 4. Sample size / variance — the 9% is likely noise

- No CI, run count, or variance is published for the 1.06 vs 0.97 run. Nothing in the blog
  or repos.
- Published final-campaign runs show between-run sd of 0.03–0.07 corrections/task per arm
  (table above). The losing-run delta is 0.09. If it was a single run per arm (unstated,
  but no multi-run language is used for it, in contrast to the final campaign's explicit
  "mean of 3 runs"), **0.09 is within ~1.3–3 sd of single-run noise — not a reliable
  "memory made it worse", and equally not a reliable "memory was neutral"**.
- Consequence: E-57 should never have carried the weight it did, independent of E-69's
  reinterpretation. The defensible reading is only directional: naive per-prompt recall
  showed no benefit on that suite, while reflect-style synthesis showed a large, replicated
  one (the 3×3 final campaign is genuinely well-evidenced: every hindsight run beat every
  same-agent vanilla run; ranges do not overlap for any agent).

## 5. Other vendor publications comparing memory configurations

- AMB leaderboard (https://agentmemorybenchmark.ai, repo `agent-memory-benchmark`): chat/QA
  datasets (LongMemEval, LoComo, BEAM, LifeBench, PersonaMem) comparing *providers*, not
  injection policies. Not on point.
- `hindsight-benchmarks` (https://github.com/vectorize-io/hindsight-benchmarks): LongMemEval/
  LoComo accuracy + model leaderboard. Not on point.
- "The Agent Memory Benchmark: Hindsight vs Alternatives" guide
  (https://hindsight.vectorize.io/guides/2026/04/21/comparison-agent-memory-benchmark-hindsight-vs-alternatives):
  provider comparison, not recall-vs-reflect. Not fetched in depth; listed for completeness.
- No published recall-vs-reflect ablation numbers exist anywhere I found. The harness has
  the arms (`hindsight`, `inject`, `oracle`, `index`, …) but no published outputs for them.
- Note: docs.hindsight.vectorize.io is Hindsight **Cloud** (different product); nothing here
  was sourced from it.

## 6. What would settle it, and can we generate it

**Would settle it:** the promised "hardening journal" (per-arm configs incl. the losing run),
or published outputs for the recall arm. Watch `agentmemorybenchmark.ai` / the AMB repo —
promised "August 2026", not there as of the 16th.

**We can generate it ourselves.** The full pipeline is public and Dockerized:
`uv run python sdebench/harness/run.py --task <task.json> --agent claude-code --history hindsight`
(recall arm) vs `--history hscoding` (reflect arm) vs `--history full` (vanilla), needing a
local Hindsight server, the plugin dir, and model creds. 61 tasks × ~85s × 3 arms × 3 runs is
roughly a day of wall time and (extrapolating the recorded per-task `cost_usd` ≈ $0.30–0.50)
order-of-$300 in tokens for a full triplicate matrix; a single-run recall-vs-vanilla pass
would be ~$60–80. **More importantly, we could run a fourth arm shaped like what Hermes/
openclaw actually ship** (capped observation-only async recall) — which is the comparison
the design decision actually needs and which no vendor run, published or promised, provides.

## Bottom line for the ledger

- E-57's number is real but unpublished in detail, single-sourced to blog prose, and
  statistically weak. Downgrade it from "benchmark result" to "vendor anecdote with a number".
- E-69's walk-back is directionally supported (coding domain: confirmed; per-prompt raw-
  fragment injection: stated in prose; "materially different from what we ship": confirmed at
  least for the seeded-answer/decoy design) but its config claims cannot be verified and
  should be labeled as interpretation.
- The strongly evidenced finding is the positive one: reflect-once synthesis beat vanilla in
  9/9 runs with non-overlapping ranges — on a coding benchmark purpose-built so that memory
  can win. Neither E-57 nor E-69 should decide the fleet-wide per-turn-injection question on
  its own; the deciding evidence would be a self-run arm matching our actual configuration.
