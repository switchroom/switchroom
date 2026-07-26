/**
 * Behavioural proof for the four search/provider patches
 * `docker/Dockerfile.hindsight` bakes into the pinned upstream Hindsight
 * image. `dockerfile-hindsight-bakes.test.ts` pins the *shape* of those patch
 * blocks (grep-on-file, runs everywhere). This file proves the *outcome*: it
 * runs the same probe against unpatched upstream (must be RED on every bug)
 * and against upstream + the patch blocks applied (must be GREEN).
 *
 * The four defects, all reproduced live on bank `overlord` before the fix:
 *
 *  1. Cross-encoder saturation. `apply_combined_scoring` makes
 *     `CE * recency_boost * temporal_boost * proof_count_boost` the only final
 *     score (RRF is explicitly zeroed). A 116-result recall had every CE score
 *     inside 0.9800-0.9999, so the boosts — whose undamped worst-case ratio is
 *     ~1.65 — decided the order and the single highest-CE memory ranked 7th
 *     behind older, more-proven ones.
 *  2. `tokenize_query` shredded `v0.19.17` into `v0`/`19`/`17`, while
 *     `to_tsvector` indexes it as ONE lexeme — zero overlap on the only
 *     discriminating term, and the stripped `19` then matched clock
 *     timestamps like `19:33:13`.
 *  3. Both LiteLLM timeout handlers ended in a bare `raise`, re-raising an
 *     `asyncio.TimeoutError` whose `str()` is empty → an operator-facing
 *     "TimeoutError:" with no cause.
 *  4. `retrieve_all_fact_types_parallel` ran the vector-similarity scan TWICE
 *     per recall. Step 2's semantic arm is an ANN scan; Step 3 then passed
 *     `semantic_seeds=None` into the graph retriever, whose `_find_semantic_seeds`
 *     issues its own `ORDER BY embedding <=> $1::vector LIMIT $5` per fact type,
 *     serialized behind Step 2's connection block.
 *
 * Beyond proving those three fixes, the probe pins the properties that make
 * the fixes SAFE, because each was violated by an earlier revision of this
 * work and none is visible from the patch text alone:
 *
 *  - `cross_encoder_score_normalized` is never rewritten. `memory_engine.py`
 *    applies the agent-supplied `min_scores.reranker` floor to that field as
 *    an ABSOLUTE cutoff, so rescaling it silently drops results (measured:
 *    a min-max rescale drops 78 of 100 results at `min_scores.reranker=0.8`
 *    that upstream kept).
 *  - Scores are set-independent: a candidate's `combined_score` cannot change
 *    because an unrelated document joined the candidate set.
 *  - CE noise does not decide: a 1e-7 CE difference must stay subordinate to
 *    the boosts rather than being stretched into a ranking decision.
 *  - `combined_score` stays on the [0, 1] CE scale that `recall_boost.py`'s
 *    additive levels and `min_scores.final` are calibrated against.
 *  - `tokenize_query` stays a STRICT SUPERSET of upstream's token list, so the
 *    OR-joined query can only match more documents than upstream, never fewer.
 *  - The seeds the graph expansion is handed are the SAME SET, in the same
 *    order, that upstream's own seed query returns — asserted by calling that
 *    upstream query and diffing, not by trusting the derivation. Where the two
 *    are not provably identical (a `min_scores.semantic` floor above the seed
 *    threshold, or a thinking_budget below the seed cap) the derivation must
 *    decline and let upstream re-query. A faster wrong seed set is a
 *    regression, not a win.
 *
 * The patch blocks are extracted from the Dockerfile itself rather than
 * duplicated here, so this test cannot drift from what actually ships. It
 * applies them by `docker exec` (not `docker build`) so it runs on daemons
 * without buildx, and it never touches the production `switchroom-hindsight`
 * container.
 *
 * SKIP DISCIPLINE (this used to be the weak point — the suite reported green
 * on every CI run because the pinned upstream image is never present on a
 * hosted runner, so the only behavioural evidence for a ranking change
 * affecting 12 live agents silently skipped). Now:
 *
 *   - Locally, with no docker or no cached image, it still skips — it must not
 *     pull a 6.4GB third-party image onto a dev box.
 *   - In CI, `.github/workflows/docker-e2e.yml` has a dedicated
 *     `hindsight-probe` job that PULLS THE PINNED DIGEST and sets
 *     `SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1`. Under that marker an
 *     unavailable docker/image is a HARD FAILURE, never a green skip.
 *   - Both probe runs assert a `PROBE_EXECUTED` sentinel, so a probe that
 *     dies early or short-circuits can never be mistaken for a pass.
 */

import { describe, it, expect, afterAll } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = readFileSync(
  resolve(root, "docker/Dockerfile.hindsight"),
  "utf8"
);

const RUN_ID = randomUUID();
const TEST_PHASE = "hindsight-search-patches";

/** The pinned upstream image, read from the Dockerfile so it can never drift. */
const UPSTREAM_IMAGE = (() => {
  const m = dockerfile.match(/^FROM\s+(\S+)/m);
  if (!m) throw new Error("Dockerfile.hindsight has no FROM line");
  return m[1];
})();

/**
 * The three patch blocks under test, pulled out of the Dockerfile's
 * `RUN python3 - <<'PYEOF' … PYEOF` heredocs by their unique patch names.
 */
function patchBlocks(): string[] {
  const blocks = [
    ...dockerfile.matchAll(/^RUN python3 - <<'PYEOF'\n([\s\S]*?)^PYEOF$/gm),
  ].map((m) => m[1]);
  const wanted = [
    "CE-saturation patch",
    "BM25 compound-token patch",
    "timeout-message patch",
    "duplicate-ANN-scan patch",
  ];
  return wanted.map((name) => {
    const b = blocks.find((x) => x.includes(name));
    if (!b) {
      throw new Error(
        `Dockerfile.hindsight no longer contains the "${name}" RUN block — ` +
          `if it was deliberately removed, delete this test with it.`
      );
    }
    return b;
  });
}

/**
 * Python probe. Exits 0 only when all three fixes are in effect AND every
 * safety property above holds; prints the offending assertions otherwise.
 *
 * Deliberately asserts OUTCOMES rather than merely calling the code or
 * grepping its source. Concretely, this file asserts:
 *
 *  - final rank order out of `apply_combined_scoring`, plus the scoring
 *    safety properties that order depends on — noise subordination,
 *    set-independence, an untouched `cross_encoder_score_normalized`, the
 *    [0, 1] weight scale, and the operator gap knob including its
 *    clamp-to-upstream rollback path;
 *  - the token list `tokenize_query` returns, and that it stays a strict
 *    superset of upstream's across 8 query shapes;
 *  - the exact tsquery string `prepare_bm25_text` emits — that the intact
 *    compound is present, that every bare fragment upstream emitted survives
 *    as a standalone OR arm, and that a non-compound query is byte-identical
 *    to upstream;
 *  - two REAL driven timeouts — a hanging completion forced through both
 *    LiteLLM retry loops — checked for the timeout/scope facts in the message
 *    and for still being caught by an upstack `except asyncio.TimeoutError`;
 *  - the NUMBER of vector-similarity scans a whole recall issues, counted at
 *    the connection by driving the real `retrieve_all_fact_types_parallel` and
 *    the real `LinkExpansionRetriever` over an in-memory corpus, plus the ids
 *    of the seed set that reaches the graph expansion.
 *
 * The test below enforces that the rank-order line above stays true in both
 * directions — this header went stale once already when the ranking patch was
 * split out and the claim outlived the assertions.
 */
const PROBE = String.raw`
import asyncio
import inspect
import math
import re
import sys
from datetime import datetime, timedelta, timezone

from hindsight_api.engine.search.reranking import apply_combined_scoring
from hindsight_api.engine.search.retrieval import tokenize_query
from hindsight_api.engine.search.types import MergedCandidate, RetrievalResult, ScoredResult
from hindsight_api.engine.sql import create_sql_dialect

failures = []
UTC = timezone.utc
NOW = datetime(2026, 7, 25, tzinfo=UTC)


def mk(uid, ce, proof, age_days=10):
    r = RetrievalResult(
        id=uid, text=uid, fact_type="observation",
        occurred_start=NOW - timedelta(days=age_days), proof_count=proof,
    )
    return ScoredResult(
        candidate=MergedCandidate(retrieval=r, rrf_score=0.0),
        cross_encoder_score_normalized=ce,
    )


def order(rows):
    apply_combined_scoring(rows, NOW)
    return [s.id for s in sorted(rows, key=lambda s: s.combined_score, reverse=True)]


# ------------------------------------------------------------------ fix 1
# (a) THE BUG. Saturated CE band as measured live. Same date on both rows, so
# recency/temporal are identical and proof_count is the only other signal.
fresh, old = mk("fresh-high-ce", 0.9999, 1), mk("old-high-proof", 0.9800, 10)
o = order([fresh, old])
print("SATURATED_ORDER", o, fresh.combined_score, old.combined_score)
if o[0] != "fresh-high-ce":
    failures.append("saturated CE: proof_count decided the ranking")

# (b) NOISE MUST NOT DECIDE. A 1e-7 CE difference is float noise from a
# saturated encoder, not signal, so the stale/unproven row must not win on it.
# A min-max rescale is scale-invariant and stretches exactly this noise across
# the whole band, handing it the decision outright.
noisy = mk("noise-stale", 0.9800001, 1, age_days=3000)
real = mk("real-fresh", 0.9800000, 50, age_days=1)
o = order([noisy, real])
print("NOISE_ORDER", o, noisy.combined_score, real.combined_score)
if o[0] != "real-fresh":
    failures.append("CE noise (1e-7 spread) decided the ranking over recency+proof")

# (c) SET-INDEPENDENCE. The same pair must score identically whether or not an
# unrelated third document survived retrieval alongside it.
a1, b1 = mk("A", 0.98, 1), mk("B", 0.99, 9)
order([a1, b1])
a2, b2, c2 = mk("A", 0.98, 1), mk("B", 0.99, 9), mk("C", 0.94, 3)
order([a2, b2, c2])
print("SETDEP_DELTA", abs(a1.combined_score - a2.combined_score), abs(b1.combined_score - b2.combined_score))
if abs(a1.combined_score - a2.combined_score) > 1e-12 or abs(b1.combined_score - b2.combined_score) > 1e-12:
    failures.append("combined_score changed when an unrelated document joined the candidate set")

# (d) min_scores INTERACTION. memory_engine applies the agent-supplied
# min_scores.reranker floor as an ABSOLUTE filter on
# cross_encoder_score_normalized, so rewriting that field silently drops
# results that upstream would have returned.
band = [mk("m%d" % i, 0.9800 + i * 0.0002, 1 + i) for i in range(100)]
before = [s.cross_encoder_score_normalized for s in band]
order(band)
after = [s.cross_encoder_score_normalized for s in band]
survivors = len([x for x in after if x >= 0.8])
print("MINSCORES_SURVIVORS", survivors, "/", len(band))
print("CE_MUTATED", any(x != y for x, y in zip(before, after)))
if any(x != y for x, y in zip(before, after)):
    failures.append("cross_encoder_score_normalized was rewritten - min_scores.reranker floor silently changes meaning")
if survivors != len(band):
    failures.append("min_scores reranker=0.8 now drops %d of %d results that upstream kept" % (len(band) - survivors, len(band)))

# (e) SCALE. recall_boost.py calibrates its additive levels against the [0, 1]
# CE scale ("high=0.5 wins over most semantic matches"), and min_scores.final
# floors sr.weight. combined_score must stay on that scale - the boosts may
# modulate it by at most the decisive-gap fraction, not reshape it.
ratios = [s.combined_score / s.cross_encoder_score_normalized for s in band]
print("WEIGHT_RATIO_RANGE", min(ratios), max(ratios))
if min(ratios) < 0.98 or max(ratios) > 1.02:
    failures.append("combined_score left the [0, 1] CE scale that recall_boost/min_scores.final assume")

# (f) A healthy (well-spread) encoder is still ordered by CE, absolute scores
# untouched.
hi, lo = mk("hi", 0.90, 1), mk("lo", 0.40, 150)
o = order([hi, lo])
print("HEALTHY", o, hi.cross_encoder_score_normalized, lo.cross_encoder_score_normalized)
if o[0] != "hi" or abs(hi.cross_encoder_score_normalized - 0.90) > 1e-12 or abs(lo.cross_encoder_score_normalized - 0.40) > 1e-12:
    failures.append("healthy CE spread was disturbed")

# (g) Upstream's is_passthrough_reranker branch must still reseed CE from RRF
# rank - the patch must not have clobbered it.
p1, p2 = mk("p1", 0.5, 1), mk("p2", 0.5, 1)
p1.candidate.rrf_score, p2.candidate.rrf_score = 0.9, 0.1
apply_combined_scoring([p1, p2], NOW, is_passthrough_reranker=True)
print("PASSTHROUGH", p1.cross_encoder_score_normalized, p2.cross_encoder_score_normalized)
if abs(p1.cross_encoder_score_normalized - 1.0) > 1e-9 or abs(p2.cross_encoder_score_normalized - 0.1) > 1e-9:
    failures.append("upstream is_passthrough_reranker branch was clobbered")

# (h) OPERATOR OVERRIDE + (i) BAD-VALUE SAFETY. The damping is a calibration
# judgement whose failure mode is a silent recall-quality regression, so it must
# be backable-out with a container RESTART rather than an image rebuild. The gap
# is read from HINDSIGHT_CE_DECISIVE_RELATIVE_GAP once at import, so a module
# reload here is exactly what a restart does in production.
#
# Written as a function guarded by hasattr so that unpatched upstream - which
# has none of these symbols - reports a clean RED failure instead of dying with
# an AttributeError before the sentinel prints.
import importlib
import os as _os

import hindsight_api.engine.search.reranking as _rr


def _probe_gap_knob():
    if not hasattr(_rr, "_CE_DECISIVE_RELATIVE_GAP"):
        print("GAP_DEFAULT absent")
        failures.append("no _CE_DECISIVE_RELATIVE_GAP module constant - the CE damping patch is not applied")
        return

    print("GAP_DEFAULT", _rr._CE_DECISIVE_RELATIVE_GAP)
    if abs(_rr._CE_DECISIVE_RELATIVE_GAP - 0.02) > 1e-12:
        failures.append("default decisive gap is not 0.02 with the env var unset")

    def reload_with(value):
        if value is None:
            _os.environ.pop("HINDSIGHT_CE_DECISIVE_RELATIVE_GAP", None)
        else:
            _os.environ["HINDSIGHT_CE_DECISIVE_RELATIVE_GAP"] = value
        return importlib.reload(_rr)

    # PRODUCTION ALPHAS. memory_engine.py calls apply_combined_scoring without
    # passing any alpha, so the SIGNATURE DEFAULTS are what runs for all 12
    # agents - and every number below (the damping exponent, the clamp
    # threshold) is a function of them. Pin them: if upstream re-tunes an alpha
    # the damping silently changes strength, so that must fail loudly here
    # rather than ship.
    _sig = inspect.signature(_rr.apply_combined_scoring).parameters
    ALPHAS = tuple(
        _sig[n].default for n in ("recency_alpha", "temporal_alpha", "proof_count_alpha")
    )
    print("PROD_ALPHAS", ALPHAS)
    if ALPHAS != (0.2, 0.2, 0.1):
        failures.append(
            "apply_combined_scoring's default alphas moved to %r (expected (0.2, 0.2, 0.1)); "
            "the damping exponent and the ~0.65 kill-switch threshold are both derived "
            "from them and must be re-measured" % (ALPHAS,)
        )

    # The MEASURED damping at the production alphas. Undamped, the boost
    # product's worst-case max/min ratio is ~1.651 - which is exactly why
    # proof_count could outrank a higher-CE memory in a saturated set. Damped,
    # it must land on 1 + gap = 1.02 exactly.
    _hi = _lo = 1.0
    for _a in ALPHAS:
        _hi *= 1.0 + _a / 2.0
        _lo *= 1.0 - _a / 2.0
    k = _rr._boost_authority(*ALPHAS)
    print("K_AT_PROD_ALPHAS", k, "UNDAMPED_RATIO", _hi / _lo, "DAMPED_RATIO", (_hi / _lo) ** k)
    if abs(k - 0.03949271225122802) > 1e-9:
        failures.append("damping exponent at the production alphas moved to %r (measured 0.0394927)" % (k,))
    if abs((_hi / _lo) ** k - 1.02) > 1e-9:
        failures.append(
            "damped boost product worst-case ratio is %r, not the 1 + gap = 1.02 the "
            "derivation promises" % ((_hi / _lo) ** k,)
        )

    # A wide gap clamps the exponent to 1.0 - byte-for-byte upstream scoring
    # with the patch still baked in. This is THE rollback path; if it does not
    # hold, the only way out of a bad calibration is an image rebuild. Driven at
    # the PRODUCTION alphas, where the clamp threshold is exp(log(hi/lo)) - 1 =
    # ~0.651: just below it must still damp, at/above it must be exactly 1.0.
    m = reload_with("1.0")
    rows = [mk("fresh-high-ce", 0.9999, 1), mk("old-high-proof", 0.9800, 10)]
    m.apply_combined_scoring(rows, NOW)
    ranked = [r.id for r in sorted(rows, key=lambda r: r.combined_score, reverse=True)]
    exp_off = m._boost_authority(*ALPHAS)
    print("GAP_ROLLBACK", m._CE_DECISIVE_RELATIVE_GAP, exp_off, ranked)
    if abs(exp_off - 1.0) > 1e-12:
        failures.append("HINDSIGHT_CE_DECISIVE_RELATIVE_GAP=1.0 did not clamp the exponent to 1.0 - the env rollback path is broken")
    if ranked[0] != "old-high-proof":
        failures.append("exponent 1.0 did not reproduce upstream scoring - the high-proof row should win again, got %r" % (ranked,))

    # The clamp threshold itself, straddled. Anything at or above it is exact
    # upstream scoring, so this is the operator-facing "how wide is wide enough"
    # answer and it must not drift silently.
    _thresh = math.expm1(math.log(_hi / _lo))
    _below = reload_with("%.12f" % (_thresh * 0.99,))._boost_authority(*ALPHAS)
    _at = reload_with("%.12f" % (_thresh * 1.01,))._boost_authority(*ALPHAS)
    print("GAP_CLAMP_THRESHOLD", _thresh, _below, _at)
    if not (_below < 1.0):
        failures.append("a gap just BELOW the ~%.3f clamp threshold already clamped to 1.0 - the knob has lost its range" % (_thresh,))
    if abs(_at - 1.0) > 1e-12:
        failures.append("a gap just ABOVE the ~%.3f clamp threshold did not clamp to 1.0 - the documented kill-switch is wrong" % (_thresh,))

    # The knob is monotone: a wider gap always damps less.
    exps = [reload_with(v)._boost_authority(*ALPHAS) for v in ("0.005", "0.02", "0.10", "0.30")]
    print("GAP_MONOTONE", exps)
    if exps != sorted(exps) or exps[0] >= exps[-1]:
        failures.append("decisive-gap knob is not monotone in the damping exponent: %r" % (exps,))

    # (i) A BAD VALUE MUST NEVER BREAK RECALL. Unparseable / empty / non-positive
    # / non-finite all fall back to the default rather than raising out of the
    # scoring path.
    bad_ok = True
    for v in ("", "   ", "abc", "0", "-1", "nan", "inf", "1e400"):
        try:
            got = reload_with(v)._CE_DECISIVE_RELATIVE_GAP
        except Exception as e:
            failures.append("decisive-gap override %r raised %s instead of falling back" % (v, type(e).__name__))
            bad_ok = False
            continue
        if got != got or abs(got - 0.02) > 1e-12:
            failures.append("decisive-gap override %r yielded %r instead of the 0.02 default" % (v, got))
            bad_ok = False
    print("GAP_BAD_VALUES_FALL_BACK", bad_ok)

    reload_with(None)


_probe_gap_knob()

# ------------------------------------------------------------------ fix 2
dialect = create_sql_dialect("postgresql")

toks = tokenize_query("rollout v0.19.17")
print("TOKENS", toks)
if "v0.19.17" not in toks:
    failures.append("tokenize_query destroyed the intact version token")

tsq = dialect.prepare_bm25_text(toks, "rollout v0.19.17")
print("TSQUERY", tsq)

# STRICT SUPERSET. Every token upstream emitted must still be emitted, in
# order, so the OR-joined query can only ever match MORE documents than
# upstream - never fewer. This is the entire safety argument for touching a
# shared BM25 candidate-generation arm under 12 live agents.
SUPERSET_CASES = [
    "rollout v0.19.17", "2026-07-25", "state-of-the-art", "github.com/foo/bar",
    "hello world", "2026-07-25 at 19:33:13", "19 v0.19.17", "...",
]
superset_ok = True
for q in SUPERSET_CASES:
    upstream_tokens = re.sub(r"[^\w\s]", " ", q.lower()).split()
    got = tokenize_query(q)
    if got[: len(upstream_tokens)] != upstream_tokens:
        failures.append("tokenize_query is no longer a strict superset of upstream for %r: %r vs %r" % (q, upstream_tokens, got))
        superset_ok = False
        break
print("SUPERSET_OK", superset_ok)

# NON-SEMVER COMPOUNDS. to_tsvector does NOT index every compound as a single
# lexeme - postgres 16 expands state-of-the-art into a PHRASE query and indexes
# 2026 standalone in "shipped in 2026 during july". So every bare fragment must
# remain a standalone OR arm. An earlier revision emitted only
# "compound | (f1 & f2 & ...)", which stopped a query containing 2026-07-25
# matching a doc that mentions only the year, and stopped state-of-the-art
# matching a doc about art. Every fact in these banks carries a date stamp, so
# that is the common path, not a corner case.
for q, frags in (("2026-07-25", ["2026", "07", "25"]), ("state-of-the-art", ["state", "of", "the", "art"])):
    emitted = dialect.prepare_bm25_text(tokenize_query(q), q)
    arms = [p.strip() for p in emitted.split("|")]
    print("COMPOUND_TSQUERY", q, repr(emitted))
    missing = [f for f in frags if f not in arms]
    if missing:
        failures.append("bare fragments %r no longer standalone OR arms for %r - narrows matching vs upstream" % (missing, q))
    if q not in emitted:
        failures.append("intact compound %r missing from the tsquery" % q)

plain = dialect.prepare_bm25_text(tokenize_query("hello world"), "hello world")
print("PLAIN", plain)
if plain != "hello | world":
    failures.append("plain query changed shape: " + repr(plain))

# ------------------------------------------------------------------ fix 3
# Behavioural, not a grep: drive a REAL timeout through both retry loops and
# assert the raised exception carries a message and is still caught by an
# upstack "except asyncio.TimeoutError".
from hindsight_api.engine.providers.litellm_llm import LiteLLMLLM


class _HangingLLM(LiteLLMLLM):
    async def _acompletion(self, **kwargs):
        await asyncio.sleep(30)


async def _drive_timeouts():
    llm = _HangingLLM(
        provider="openai", api_key="unused", base_url="http://127.0.0.1:1",
        model="gpt-4o-mini", timeout=0.05,
    )
    out = {}
    calls = {
        "call": lambda: llm.call([{"role": "user", "content": "hi"}], max_retries=0, initial_backoff=0.0),
        "call_with_tools": lambda: llm.call_with_tools([{"role": "user", "content": "hi"}], [], max_retries=0, initial_backoff=0.0),
    }
    for label, make in calls.items():
        try:
            await make()
            out[label] = ("NO_RAISE", "")
        except asyncio.TimeoutError as e:
            # Reaching this handler at all proves the upstack matcher still
            # works after the patch swaps the re-raised exception object.
            out[label] = ("CAUGHT_BY_ASYNCIO_TIMEOUTERROR", str(e))
        except BaseException as e:
            out[label] = ("WRONG_TYPE:" + type(e).__name__, str(e))
    return out


timeouts = asyncio.run(_drive_timeouts())
for label, (how, msg) in sorted(timeouts.items()):
    print("TIMEOUT", label, how, repr(msg))
    if how != "CAUGHT_BY_ASYNCIO_TIMEOUTERROR":
        failures.append("%s timeout no longer caught by an upstack asyncio.TimeoutError handler (%s)" % (label, how))
    elif not msg.strip():
        failures.append("%s timeout raised an EMPTY message - operators see a bare TimeoutError with no cause" % label)
    elif "timed out after" not in msg or "scope=" not in msg:
        failures.append("%s timeout message lost the timeout/scope facts: %r" % (label, msg))

# ------------------------------------------------------------------ fix 4
# Drive the REAL retrieve_all_fact_types_parallel and the REAL
# LinkExpansionRetriever over an in-memory corpus, and COUNT the
# vector-similarity scans at the connection. Upstream issues one per fact type
# on top of Step 2's arm; patched must issue exactly one for the whole recall.
from hindsight_api.engine.db.ops_postgresql import PostgreSQLOps
from hindsight_api.engine.search import link_expansion_retrieval as LE
from hindsight_api.engine.search import retrieval as R

SEED_LIMIT = 20
SEED_THRESHOLD = 0.3


def urow(ft, i, sim):
    return {
        "id": "%s-%02d" % (ft, i), "text": "fact %d" % i, "context": None,
        "event_date": None, "occurred_start": None, "occurred_end": None,
        "mentioned_at": None, "fact_type": ft, "document_id": None,
        "chunk_id": None, "tags": None, "metadata": None, "proof_count": 1,
        "similarity": sim, "bm25_score": None,
    }


# 40 world rows spanning the seed threshold (33 clear 0.3, so BOTH the 20-cap
# and the threshold bite) plus 5 experience rows that all clear it (under the
# cap, so the whole set is the seed set).
CORPUS = [urow("world", i, round(0.95 - 0.02 * i, 4)) for i in range(40)]
CORPUS += [urow("experience", i, round(0.90 - 0.10 * i, 4)) for i in range(5)]


class FakeConn:
    """Serves the real SQL the engine builds, from the corpus above.

    Discriminates the three query shapes a recall issues so the probe can COUNT
    ANN scans rather than infer them: the Step 2 combined arm, link_expansion's
    standalone seed scan, and the graph expansion CTE.
    """

    backend_type = "postgresql"

    def __init__(self, log):
        self.log = log

    async def fetch(self, query, *params):
        if "'semantic' AS source" in query:
            self.log.append("arm")
            floor = float(re.search(r"<=> \$1::vector\)\) >= ([0-9.]+)", query).group(1))
            return [dict(r, source="semantic") for r in CORPUS if r["similarity"] >= floor]
        if "embedding <=>" in query:
            # The duplicate scan this patch exists to remove.
            self.log.append("seed")
            _emb, _bank, ft, threshold, limit = params[:5]
            hits = [r for r in CORPUS if r["fact_type"] == ft and r["similarity"] >= threshold]
            hits.sort(key=lambda r: r["similarity"], reverse=True)
            return hits[:limit]
        self.log.append("expand")
        return []


class FakePool:
    def __init__(self, conn):
        self.conn = conn
        self.ops = PostgreSQLOps()

    async def acquire(self):
        return self.conn

    async def release(self, conn):
        pass

    def get_size(self):
        return 1

    def get_idle_size(self):
        return 1


class RecordingRetriever(LE.LinkExpansionRetriever):
    """The REAL retriever, wrapped only to capture what it was handed."""

    def __init__(self):
        super().__init__()
        self.seen = {}

    async def retrieve(self, **kw):
        self.seen[kw["fact_type"]] = kw["semantic_seeds"]
        return await super().retrieve(**kw)


async def _drive(fact_types, budget=300, min_semantic=None):
    log = []
    retriever = RecordingRetriever()
    await R.retrieve_all_fact_types_parallel(
        FakePool(FakeConn(log)), "alpha beta", "[0.1,0.2]", "bank-probe",
        list(fact_types), budget, None, None,
        graph_retriever=retriever, min_semantic=min_semantic,
    )
    return log, retriever.seen


def seed_ids(seeds):
    return None if seeds is None else [s.id for s in seeds]


async def _reference(ft):
    """The seed set upstream's OWN query returns, obtained by calling it."""
    rows = await LE._find_semantic_seeds(
        FakeConn([]), "[0.1,0.2]", "bank-probe", ft,
        limit=SEED_LIMIT, threshold=SEED_THRESHOLD,
    )
    return [r.id for r in rows]


# The mirrored seed constants are only right while the call site still passes
# them; upstream retuning either one silently changes which set is equivalent.
le_src = inspect.getsource(LE.LinkExpansionRetriever.retrieve)
print("SEED_CALL_SITE_DEFAULTS", "limit=20" in le_src, "threshold=0.3" in le_src)
if "limit=20" not in le_src or "threshold=0.3" not in le_src:
    failures.append("link_expansion no longer seeds with limit=20/threshold=0.3 - the derived seed set is calibrated against those")

FT = ["world", "experience"]
scan_log, delivered = asyncio.run(_drive(FT))
ref = {ft: asyncio.run(_reference(ft)) for ft in FT}

ann = scan_log.count("arm") + scan_log.count("seed")
print("ANN_SCANS", ann, "ARM", scan_log.count("arm"), "SEED_QUERIES", scan_log.count("seed"))
print("REFERENCE_world", len(ref["world"]))
print("REFERENCE_experience", len(ref["experience"]))
for ft in FT:
    print("DELIVERED_%s" % ft, seed_ids(delivered[ft]))

if scan_log.count("seed") != 0:
    failures.append(
        "graph expansion still issued %d standalone ANN seed scan(s) after Step 2 already ran one"
        % scan_log.count("seed")
    )
if ann != 1:
    failures.append("recall issued %d vector-similarity scans (expected exactly 1)" % ann)

# EQUIVALENCE. Same ids, same order, as upstream's own seed query - the whole
# safety argument, since a narrowed seed set silently narrows recall.
for ft in FT:
    got = seed_ids(delivered[ft])
    if got is None:
        failures.append("%s: semantic_seeds was None - the graph path re-ran the ANN scan" % ft)
    elif got != ref[ft]:
        failures.append("%s: derived seeds %r != upstream seed query %r" % (ft, got, ref[ft]))

# The corpus must keep exercising both bounds, or the equivalence check above
# degenerates into a tautology.
if len(ref["world"]) != SEED_LIMIT:
    failures.append("probe corpus no longer exercises the %d-seed cap (%d)" % (SEED_LIMIT, len(ref["world"])))
if len(ref["experience"]) >= SEED_LIMIT:
    failures.append("probe corpus no longer exercises the under-cap case")

# FALLBACK 1: a per-request min_scores.semantic floor ABOVE the seed threshold
# makes the arm's pool narrower than the seed query's, so rows the seed query
# would have returned were never fetched. Must decline and let upstream query.
log_hi, seen_hi = asyncio.run(_drive(["world"], min_semantic=0.5))
print("HIGH_FLOOR_SEEDS", seed_ids(seen_hi["world"]), "SEED_QUERIES", log_hi.count("seed"))
if seen_hi["world"] is not None:
    failures.append("min_scores.semantic=0.5 (above the 0.3 seed threshold) still derived seeds from the narrowed arm")
if log_hi.count("seed") != 1:
    failures.append("min_scores.semantic=0.5 did not fall back to upstream's own seed query")

# FALLBACK 2: a thinking_budget below the seed cap can trim away rows the seed
# query would have returned.
log_lo, seen_lo = asyncio.run(_drive(["world"], budget=5))
print("TINY_BUDGET_SEEDS", seed_ids(seen_lo["world"]), "SEED_QUERIES", log_lo.count("seed"))
if seen_lo["world"] is not None:
    failures.append("thinking_budget=5 (below the seed cap) still derived seeds from a trimmed arm")
if log_lo.count("seed") != 1:
    failures.append("thinking_budget=5 did not fall back to upstream's own seed query")

# temporal_seeds stays out of scope: upstream passes none, and Step 2's temporal
# rows are a coverage-selected set with different semantics, so threading them
# would ADD seeds rather than reproduce upstream's behaviour.
print("TEMPORAL_SEEDS_STILL_NONE", "temporal_seeds=None" in inspect.getsource(R.retrieve_all_fact_types_parallel))
if "temporal_seeds=None" not in inspect.getsource(R.retrieve_all_fact_types_parallel):
    failures.append("temporal_seeds is no longer None - that is a separate change with different semantics")

print("FAILURES", failures)
# Sentinel: proves the probe ran to completion. The harness asserts this, so a
# probe that dies early or short-circuits can never be mistaken for a pass.
print("PROBE_EXECUTED")
sys.exit(1 if failures else 0)
`;

function hasDocker(): boolean {
  try {
    execSync("docker version --format '{{.Server.Version}}'", {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function hasImage(ref: string): boolean {
  try {
    execSync(`docker image inspect ${ref}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * CI marker. When set, this suite MUST really execute — an absent docker or
 * an absent upstream image becomes a hard failure instead of a green skip.
 * `.github/workflows/docker-e2e.yml` sets it after pulling the pinned digest.
 */
const REQUIRED = process.env.SWITCHROOM_REQUIRE_HINDSIGHT_PROBE === "1";

const dockerOk = hasDocker();
const imageOk = dockerOk && hasImage(UPSTREAM_IMAGE);

type ProbeResult = { status: number; stdout: string };

/** Run the probe in a throwaway container, optionally patching first. */
function runProbe(patched: boolean): ProbeResult {
  const name = `sr-hs-probe-${patched ? "patched" : "upstream"}-${RUN_ID.slice(
    0,
    8
  )}`;
  try {
    execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--name",
        name,
        "--label",
        `switchroom.test=${TEST_PHASE}`,
        "--label",
        `switchroom.test.run=${RUN_ID}`,
        "--user",
        "root",
        "--network",
        "none",
        UPSTREAM_IMAGE,
        "sleep",
        "300",
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );

    if (patched) {
      for (const block of patchBlocks()) {
        // Each block is self-verifying: it asserts its upstream anchors exist
        // exactly once and re-asserts the result, so a non-zero exit here means
        // upstream drifted and the patch must be re-authored.
        execFileSync("docker", ["exec", "-i", name, "python3", "-"], {
          input: block,
          stdio: ["pipe", "pipe", "pipe"],
        });
      }
    }

    const res = execFileSync(
      "docker",
      ["exec", "-i", "-w", "/app/api", name, "/app/api/.venv/bin/python", "-"],
      { input: PROBE, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" }
    );
    return { status: 0, stdout: res };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string };
    return {
      status: err.status ?? -1,
      stdout: (err.stdout ?? "").toString(),
    };
  } finally {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
}

describe("Dockerfile.hindsight search-patch probe is real, not a silent skip", () => {
  it("header's rank-order claim matches what the probe actually checks", () => {
    // This header went stale once already: after the ranking patch was split
    // into its own PR it still advertised "final rank order" while no
    // rank-order assertion remained anywhere in the file. Because this file
    // moves between branches with and without that patch, the claim can drift
    // in EITHER direction, so assert both. A prose claim cannot be trusted to
    // stay true by discipline — tie it to the probe source mechanically.
    const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const header = src.slice(0, src.indexOf("const PROBE ="));
    const probeChecksRankOrder = /SATURATED_ORDER|combined_score/.test(PROBE);
    const headerClaimsRankOrder = /rank\s+order/i.test(header);
    expect(
      headerClaimsRankOrder,
      probeChecksRankOrder
        ? "the probe asserts final rank order but the header does not say so — " +
          "understated coverage hides the file's most important guarantee"
        : "the header advertises rank-order coverage but the probe asserts " +
          "nothing about rank order — describe what this file actually checks",
    ).toBe(probeChecksRankOrder);
  });

  it("pins the upstream image by digest so the probe tests the exact shipping bytes", () => {
    expect(UPSTREAM_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("hard-fails rather than skipping when CI demands a real run", () => {
    if (!REQUIRED) {
      // Local/dev path: skipping is legitimate (never pull a 6.4GB image onto
      // a dev box), but it must be visible rather than silent.
      expect(
        REQUIRED,
        "SWITCHROOM_REQUIRE_HINDSIGHT_PROBE is unset — the behavioural probe " +
          "is advisory here. CI's hindsight-probe job sets it after pulling " +
          `${UPSTREAM_IMAGE}.`
      ).toBe(false);
      return;
    }
    expect(
      dockerOk,
      "SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1 but the docker daemon is unreachable"
    ).toBe(true);
    expect(
      imageOk,
      `SWITCHROOM_REQUIRE_HINDSIGHT_PROBE=1 but ${UPSTREAM_IMAGE} is not present ` +
        "locally — the workflow must pull the pinned digest before running this suite"
    ).toBe(true);
  });
});

describe.skipIf(!dockerOk || !imageOk)(
  "Dockerfile.hindsight search patches change real behaviour",
  () => {
    afterAll(() => {
      // Label-scoped teardown belt (never an unlabelled bulk removal).
      try {
        const ids = execSync(
          `docker ps -aq --filter label=switchroom.test.run=${RUN_ID}`,
          { encoding: "utf8" }
        )
          .split("\n")
          .filter(Boolean);
        if (ids.length) {
          execFileSync("docker", ["rm", "-f", ...ids], { stdio: "ignore" });
        }
      } catch {
        /* nothing to clean */
      }
    });

    it("unpatched upstream is RED on all four defects (proves the probe bites)", () => {
      const { status, stdout } = runProbe(false);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED"
      );
      expect(status, `probe unexpectedly passed:\n${stdout}`).not.toBe(0);

      // Defect 1 — the concrete inversion: the highest-CE row loses to the
      // high-proof row.
      expect(stdout).toContain("saturated CE: proof_count decided the ranking");
      expect(stdout).toMatch(
        /SATURATED_ORDER \['old-high-proof', 'fresh-high-ce'\]/
      );

      expect(stdout).toContain("GAP_DEFAULT absent");
      expect(stdout).toContain(
        "no _CE_DECISIVE_RELATIVE_GAP module constant - the CE damping patch is not applied"
      );

      // Defect 2 — the intact compound never reaches the tsquery.
      expect(stdout).toContain(
        "tokenize_query destroyed the intact version token"
      );
      expect(stdout).toContain("TOKENS ['rollout', 'v0', '19', '17']");
      expect(stdout).toContain("TSQUERY rollout | v0 | 19 | 17");
      expect(stdout).toContain(
        "intact compound '2026-07-25' missing from the tsquery"
      );

      // Defect 3 — driven for real: both timeout paths raise an EMPTY message.
      expect(stdout).toContain("call timeout raised an EMPTY message");
      expect(stdout).toContain(
        "call_with_tools timeout raised an EMPTY message"
      );
      expect(stdout).toMatch(/TIMEOUT call CAUGHT_BY_ASYNCIO_TIMEOUTERROR ''/);
      expect(stdout).toMatch(
        /TIMEOUT call_with_tools CAUGHT_BY_ASYNCIO_TIMEOUTERROR ''/
      );

      // Defect 4 — the duplicate ANN scan, counted at the connection: Step 2's
      // arm plus one standalone seed scan per fact type.
      expect(stdout).toContain("ANN_SCANS 3 ARM 1 SEED_QUERIES 2");
      expect(stdout).toContain(
        "graph expansion still issued 2 standalone ANN seed scan(s) after Step 2 already ran one"
      );
      expect(stdout).toContain("DELIVERED_world None");
      expect(stdout).toContain("DELIVERED_experience None");
    }, 240_000);

    it("upstream + the baked patch blocks is GREEN, including every safety property", () => {
      const { status, stdout } = runProbe(true);
      expect(stdout, "probe did not run to completion").toContain(
        "PROBE_EXECUTED"
      );
      expect(status, `probe failed:\n${stdout}`).toBe(0);
      expect(stdout).toContain("FAILURES []");

      // Fix 1: highest-CE row now wins despite proof_count 1 vs 10 …
      expect(stdout).toMatch(
        /SATURATED_ORDER \['fresh-high-ce', 'old-high-proof'\]/
      );
      // … while 1e-7 of CE noise still does NOT get to decide …
      expect(stdout).toMatch(/NOISE_ORDER \['real-fresh', 'noise-stale'\]/);
      // … scores are set-independent to the last bit …
      expect(stdout).toContain("SETDEP_DELTA 0.0 0.0");
      // … the caller-visible CE field is untouched, so an agent-supplied
      // min_scores.reranker floor keeps upstream semantics exactly …
      expect(stdout).toContain("CE_MUTATED False");
      expect(stdout).toContain("MINSCORES_SURVIVORS 100 / 100");
      // … and upstream's passthrough branch still works.
      expect(stdout).toMatch(/PASSTHROUGH 1\.0 0\.0999999/);

      // … the decisive gap defaults to the measured 0.02 but is an operator
      // knob: a wide gap clamps the exponent to 1.0, i.e. byte-for-byte
      // upstream scoring with the patch still baked in. That makes backing
      // this calibration out a container restart, not an image rebuild.
      expect(stdout).toContain("GAP_DEFAULT 0.02");

      // memory_engine.py passes NO alphas, so these signature defaults are what
      // actually runs for all 12 agents — and both numbers below are derived
      // from them. Pinned so an upstream re-tune cannot silently change the
      // damping strength.
      expect(stdout).toContain("PROD_ALPHAS (0.2, 0.2, 0.1)");
      // The measured damping: k = log1p(0.02) / log(1.651) = 0.0394927, which
      // collapses the boost product's worst-case ratio from ~1.651 to exactly
      // 1 + gap = 1.02.
      expect(stdout).toMatch(
        /^K_AT_PROD_ALPHAS 0\.03949271225122802 UNDAMPED_RATIO 1\.65107212475633\d* DAMPED_RATIO 1\.02(?:0*\d*)?$/m
      );
      expect(stdout).toContain(
        "GAP_ROLLBACK 1.0 1.0 ['old-high-proof', 'fresh-high-ce']"
      );
      // The kill-switch threshold, straddled at the production alphas: just
      // below ~0.651 still damps (<1.0), just above is exactly 1.0 = upstream.
      expect(stdout).toMatch(
        /GAP_CLAMP_THRESHOLD 0\.65107212475633\d+ 0\.9\d+ 1\.0$/m
      );
      // … the knob is monotone, and no bad value can break recall.
      expect(stdout).toMatch(/GAP_MONOTONE \[/);
      expect(stdout).toContain("GAP_BAD_VALUES_FALL_BACK True");

      // Fix 2: the intact compound is APPENDED, never substituted — the
      // fragments upstream emitted all survive as standalone OR arms, so the
      // query can only match more documents than upstream, never fewer.
      expect(stdout).toContain(
        "TOKENS ['rollout', 'v0', '19', '17', 'v0.19.17']"
      );
      expect(stdout).toContain("TSQUERY rollout | v0 | 19 | 17 | v0.19.17");
      expect(stdout).toContain("SUPERSET_OK True");
      expect(stdout).toContain(
        "COMPOUND_TSQUERY 2026-07-25 '2026 | 07 | 25 | 2026-07-25'"
      );
      expect(stdout).toContain(
        "COMPOUND_TSQUERY state-of-the-art 'state | of | the | art | state-of-the-art'"
      );
      // Non-compound queries are byte-identical to upstream.
      expect(stdout).toContain("PLAIN hello | world");

      // Fix 3: both driven timeouts now carry the timeout/attempts/scope
      // facts AND are still caught by an upstack asyncio.TimeoutError.
      expect(stdout).toMatch(
        /TIMEOUT call CAUGHT_BY_ASYNCIO_TIMEOUTERROR 'LiteLLM call timed out after 0\.05s on 1 attempts \(TimeoutError, scope=memory\)'/
      );
      expect(stdout).toMatch(
        /TIMEOUT call_with_tools CAUGHT_BY_ASYNCIO_TIMEOUTERROR 'LiteLLM tool call timed out after 0\.05s on 1 attempts \(TimeoutError, scope=tools\)'/
      );

      // Fix 4: exactly ONE vector-similarity scan for the whole recall — the
      // arm — and zero standalone seed scans, no matter how many fact types.
      expect(stdout).toContain("ANN_SCANS 1 ARM 1 SEED_QUERIES 0");

      // … and the seeds the graph expansion actually received are the SAME SET,
      // in the same order, that upstream's own seed query returns. Diffed
      // against that query's real output, with both of its bounds biting: the
      // 20-seed cap on `world` (40 rows, 33 above the 0.3 threshold) and the
      // under-cap case on `experience` (5 rows).
      expect(stdout).toContain("SEED_CALL_SITE_DEFAULTS True True");
      expect(stdout).toContain("REFERENCE_world 20");
      expect(stdout).toContain("REFERENCE_experience 5");
      expect(stdout).toContain(
        "DELIVERED_world ['world-00', 'world-01', 'world-02', 'world-03', " +
          "'world-04', 'world-05', 'world-06', 'world-07', 'world-08', " +
          "'world-09', 'world-10', 'world-11', 'world-12', 'world-13', " +
          "'world-14', 'world-15', 'world-16', 'world-17', 'world-18', " +
          "'world-19']"
      );
      expect(stdout).toContain(
        "DELIVERED_experience ['experience-00', 'experience-01', " +
          "'experience-02', 'experience-03', 'experience-04']"
      );

      // … and it DECLINES rather than guessing wherever the derived set is not
      // provably the upstream set. Correctness first: a narrowed seed set is a
      // silently quieter recall, which is worse than a slower one.
      expect(stdout).toContain("HIGH_FLOOR_SEEDS None SEED_QUERIES 1");
      expect(stdout).toContain("TINY_BUDGET_SEEDS None SEED_QUERIES 1");

      // … while temporal seeds stay out of scope (upstream passes none, and
      // Step 2's temporal rows are a differently-selected set).
      expect(stdout).toContain("TEMPORAL_SEEDS_STILL_NONE True");
    }, 240_000);
  }
);
