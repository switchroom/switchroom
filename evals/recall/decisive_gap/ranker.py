#!/usr/bin/env python3
"""Pure re-implementation of the decisive-gap ranker for RFC memory-redesign P11.

Everything here is a **pure function** over a candidate's own fields. No HTTP, no
database, no clock, no randomness, no environment read. That is deliberate and it
is the same discipline ``metrics.py`` follows: the scoring half of an eval is the
half CI runs, and it has to be reproducible bit-for-bit on a machine that cannot
reach a Hindsight instance nor pull the 6.4 GB pinned image.

## What this models, and what the knob actually does

``HINDSIGHT_CE_DECISIVE_RELATIVE_GAP`` is **not** an "abstain when the top hits
are bunched" confidence gate — no such mechanism exists in the engine or the
shim, and P11 introduces none. It is a **ranking-damping knob** baked into
``apply_combined_scoring`` by the switchroom CE-saturation patch
(``docker/Dockerfile.hindsight`` — the ``_boost_authority`` helper at line ~400
and the damped ``combined_score`` at line ~435). The final score is::

    combined_score = cross_encoder_score_normalized * (boost_product ** k)

where ``boost_product = recency_boost * temporal_boost * proof_count_boost`` and
each boost is ``1 + alpha * (signal - 0.5)`` for a signal in ``[0, 1]``
(``Dockerfile.hindsight`` ``_boost_authority`` docstring). The exponent ``k`` is
**derived, not tuned**::

    k = min(1.0, log1p(gap) / log(hi / lo))

with ``hi`` / ``lo`` the undamped worst-case boost product
(``hi = prod(1 + alpha/2)``, ``lo = prod(1 - alpha/2)``). ``k`` confines the boost
product's worst-case max/min ratio to exactly ``1 + gap``. So the knob bounds how
far the recency / temporal / proof_count boosts may perturb the cross-encoder's
ordering:

* When one candidate's CE score is more than the gap fraction above another's,
  the CE order is **decisive** and the boosts cannot overturn it.
* When the CE scores are **bunched** (within the gap band — the measured
  saturation regime, every CE inside 0.9800-0.9999), the boosts break the tie,
  and because recency has authority there the fresher memory wins. That is
  constraint 4 ("recency bias is correct"), which is the constraint P11 serves
  (``phase4-rfc.md:46``, ``:960``).
* Widening the gap to ``>= ~0.651`` clamps ``k`` to ``1.0`` — byte-for-byte
  upstream scoring, the documented container-restart rollback path
  (``vendor/hindsight-memory/scripts/recall.py:573``).

## Faithfulness

This module reproduces the two load-bearing functions from the patch verbatim in
behaviour. It deliberately takes each candidate's three boost **signals** in
``[0, 1]`` directly rather than deriving them from ``age_days`` / ``proof_count``
via the engine's decay curves: those curves are upstream and orthogonal to P11,
and pinning them here would couple this fixture to code the RFC's constraint 1
puts out of scope. ``test_decisive_gap.py`` cross-checks this re-implementation
against the constants the docker probe
(``tests/docker/hindsight-search-patches.test.ts``) pins against the *baked*
code, so drift between this file and what actually ships fails loudly.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

# Production alphas. `memory_engine.py` calls `apply_combined_scoring` with no
# alpha argument, so these signature defaults are what runs for every agent. The
# docker probe pins them (hindsight-search-patches.test.ts:310) and fails loudly
# if upstream re-tunes one, because both `k` and the clamp threshold are derived
# from them.
PROD_ALPHAS: tuple[float, float, float] = (0.2, 0.2, 0.1)

# The shipped default, read from `HINDSIGHT_CE_DECISIVE_RELATIVE_GAP` at import in
# production and defaulting here (Dockerfile.hindsight:343). This module never
# reads the environment — the gap is always an explicit argument so a fixture is
# reproducible regardless of the host's env.
DEFAULT_GAP: float = 0.02


@dataclass(frozen=True)
class Candidate:
    """One reranker candidate, reduced to the fields the gap decision consumes.

    ``ce`` is ``cross_encoder_score_normalized`` in ``[0, 1]`` — the absolute,
    caller-visible score the patch deliberately never rewrites. ``recency`` /
    ``temporal`` / ``proof`` are the three boost signals in ``[0, 1]`` that feed
    ``1 + alpha * (signal - 0.5)``; higher means fresher / more temporally
    relevant / more corroborated.
    """

    id: str
    ce: float
    recency: float = 0.5
    temporal: float = 0.5
    proof: float = 0.5


def boost_authority(gap: float, alphas: Sequence[float] = PROD_ALPHAS) -> float:
    """Damping exponent ``k`` — a pure function of the alphas and the gap.

    Mirrors ``_boost_authority`` in the CE-saturation patch
    (``Dockerfile.hindsight`` ~L400) exactly, including its two escape hatches:
    returns ``1.0`` (no damping, exact upstream scoring) when the boosts cannot
    span a ratio at all, or when the operator has widened the gap past what the
    boosts can span.
    """
    hi = 1.0
    lo = 1.0
    for alpha in alphas:
        hi *= 1.0 + alpha / 2.0
        lo *= 1.0 - alpha / 2.0
    if lo <= 0.0 or hi <= lo:
        return 1.0
    return min(1.0, math.log1p(gap) / math.log(hi / lo))


def combined_score(
    cand: Candidate, gap: float = DEFAULT_GAP, alphas: Sequence[float] = PROD_ALPHAS
) -> float:
    """``ce * (boost_product ** k)`` — the baked ``combined_score``.

    Mirrors the damped body the patch installs (``Dockerfile.hindsight`` ~L435).
    Set-independent by construction: a candidate's score depends only on its own
    fields and the (set-independent) exponent.
    """
    k = boost_authority(gap, alphas)
    boost = 1.0
    for alpha, signal in zip(alphas, (cand.recency, cand.temporal, cand.proof)):
        boost *= 1.0 + alpha * (signal - 0.5)
    return cand.ce * (boost**k)


def rank(
    candidates: Sequence[Candidate],
    gap: float = DEFAULT_GAP,
    alphas: Sequence[float] = PROD_ALPHAS,
) -> list[str]:
    """Rank candidate ids best-first by ``combined_score``.

    Ties break by input order so the output is a deterministic total order, the
    same tie discipline ``metrics.rrf_fuse`` uses.
    """
    scored = [(combined_score(c, gap, alphas), i, c.id) for i, c in enumerate(candidates)]
    scored.sort(key=lambda t: (-t[0], t[1]))
    return [cid for _, _, cid in scored]


def undamped_boost_ratio(alphas: Sequence[float] = PROD_ALPHAS) -> float:
    """The worst-case max/min boost product with no damping (``k = 1``).

    ~1.651 at the production alphas — the ratio that let proof_count decide a
    saturated set before the patch, and the number the clamp threshold is the
    ``expm1(log(...))`` of.
    """
    hi = 1.0
    lo = 1.0
    for alpha in alphas:
        hi *= 1.0 + alpha / 2.0
        lo *= 1.0 - alpha / 2.0
    return hi / lo


def clamp_threshold(alphas: Sequence[float] = PROD_ALPHAS) -> float:
    """The gap at/above which ``k`` clamps to 1.0 — the rollback boundary.

    ``expm1(log(hi / lo))`` = ``hi/lo - 1`` ≈ 0.651 at the production alphas
    (hindsight-search-patches.test.ts:354, recall.py:573).
    """
    return math.expm1(math.log(undamped_boost_ratio(alphas)))
