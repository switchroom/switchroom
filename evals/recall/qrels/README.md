# Relevance judgements (qrels)

Graded relevance labels for the recall-quality suite. One file per
(bank, judgement campaign). `metrics.recall@k` / `nDCG@10` / `MRR` are computed
against these; the headline zero-result metric is not, which is why it is the
number the suite can report at full scale today.

## Format

```json
{
  "judgement": {
    "method": "pooled-graded",
    "judge": "operator",
    "date": "2026-08-07",
    "bank": "bank-0c3d12fd",
    "queryset_version": "v1",
    "pool_depth": 10,
    "pool_configs": ["native/arm:semantic", "native/arm:bm25", "native/final"],
    "scale": {"0": "irrelevant", "1": "marginal", "2": "relevant", "3": "ideal"},
    "notes": "..."
  },
  "qrels": {
    "nq-001": {"7d5f9840-5778-47ed-b8cf-a06edacfbdc1": 3},
    "zr-003": {}
  }
}
```

`load_qrels` **rejects a file with no `judgement` block.** A label set whose
provenance is unrecorded cannot be argued with, and #4479 item 6 asks for
provenance to be stated rather than implied.

## Two hard rules

1. **Ids and integer grades only. Never memory text, never query text.** This
   repository is public and every id here points into a live operator's private
   memory. A UUID is opaque; a snippet is a leak. There is no redaction mode
   that makes pasting text here acceptable.
2. **Case ids are the join key.** Renaming a case in `queryset/v1.yaml`
   silently orphans its judgements — the case becomes unjudged, drops out of
   the graded metrics, and the score goes *up*. Add cases; do not rename them.

An empty object (`"zr-003": {}`) is meaningful and distinct from an absent key:
it records "judged, nothing relevant exists". `recall@k` for such a case is
`0.0`, not `1.0`.

## Choosing a method

See the README's "Judgement provenance, and its limits" for what each method is
worth. Short version:

| method | labels | main bias |
|---|---|---|
| `pooled-graded` | human or LLM judge over a pooled candidate set | recall is recall-within-pool; unjudged relevant docs are invisible |
| `known-item` | derived, exact, deterministic | lexical overlap flatters the keyword arm; use for relative comparisons |
| `operator` | human | does not scale past a few dozen |

Whichever you pick, **the judge must not see ranks, scores, or which
configuration produced a candidate.** That is the difference between a
judgement and a rationalisation of the current ranking.

## Building a pooled set

1. Run the suite against every configuration you intend to compare, with
   `--no-redact-banks` so ids resolve locally.
2. Union the top-`pool_depth` of every stage across every run. Pooling across
   *configurations* is what stops the labels favouring the incumbent.
3. Judge each (case, memory) pair blind, then write ids + grades here.
4. Record `pool_depth` and `pool_configs` in the `judgement` block. Without
   them, `recall@k` has no stated denominator and cannot be interpreted.

## Label rot is expected, and it is measured

Judgements pin memory-unit ids in a **live** bank. Consolidation rewrites
units, so ids decay. A decayed qrels file looks exactly like a quality
regression, which is the failure mode most likely to make someone distrust a
green suite and then ignore a red one.

Every run therefore reports `judged_coverage@10`, and `--min-judged-coverage`
fails the run outright rather than letting rot masquerade as a score change.
When coverage drops below the floor, re-judge; do not lower the floor.

## Committed files

None yet. The baseline in `../results/` is label-free by design: it reports the
keyword-arm zero-result metric and per-stage row counts, which need no
judgements. A graded campaign against a named bank is the next increment, and
it should land as its own PR with its `judgement` block filled in.
