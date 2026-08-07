#!/usr/bin/env python3
"""Read-only Hindsight client for the recall-quality eval (issue #4479).

Two properties matter more than features here.

**It cannot write.** The only request this module can issue is
``POST /v1/default/banks/{bank}/memories/recall`` (plus the two read probes
``GET /health`` and ``GET /version``). Recall is a read path and #4479 says to
keep it one; the epic's own abort condition (#4475, "Hard abort if any harness
run is found to have mutated production data") is what a stray retain would
trip. ``_request`` refuses any path not on ``_ALLOWED``, so a future edit that
adds a write has to delete a guard rather than merely add a call.

**It runs sequentially.** There is no concurrency knob, on purpose. This suite
grades *quality*, and the box it runs on also serves the live fleet — issuing a
parallel fan-out would both distort whatever else is measuring latency and buy
nothing, since no metric here is timing-derived. ``--pace-ms`` adds a gap
between calls for the same reason.

Timings ARE captured (``elapsed_ms`` per observation) but are recorded as
diagnostics only and are never scored or gated. Anything in this suite's output
under ``timings`` is not a latency measurement.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

_ALLOWED = ("/health", "/version", "/memories/recall")


class ReadOnlyViolation(RuntimeError):
    """Raised when a caller attempts a request outside the read-only allowlist."""


@dataclass
class RecallObservation:
    """One recall call, reduced to ranked id lists plus non-scored diagnostics."""

    query_id: str
    bank: str
    ok: bool
    http_status: int | None = None
    error: str | None = None
    elapsed_ms: float | None = None
    # stage name -> ranked memory ids, best first
    stages: dict[str, list[str]] = field(default_factory=dict)
    # arm name -> ranked memory ids, pooled across fact_type
    arms: dict[str, list[str]] = field(default_factory=dict)
    result_count: int = 0


class HindsightRecallClient:
    def __init__(
        self,
        base_url: str,
        token: str | None = None,
        timeout_s: float = 60.0,
        pace_ms: int = 0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout_s = timeout_s
        self.pace_ms = pace_ms
        self._last_call = 0.0

    # ── transport ────────────────────────────────────────────────

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        if not any(path.endswith(suffix) for suffix in _ALLOWED):
            raise ReadOnlyViolation(
                f"{method} {path} is not on the read-only allowlist {_ALLOWED}. "
                "This eval must never write to a live bank."
            )
        if method != "GET" and not path.endswith("/memories/recall"):
            raise ReadOnlyViolation(f"{method} {path} is not a read operation")

        if self.pace_ms:
            wait = (self._last_call + self.pace_ms / 1000.0) - time.monotonic()
            if wait > 0:
                time.sleep(wait)

        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base_url + path, data=data, method=method)
        req.add_header("content-type", "application/json")
        if self.token:
            req.add_header("authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                return json.loads(resp.read().decode())
        finally:
            self._last_call = time.monotonic()

    # ── probes ───────────────────────────────────────────────────

    def version(self) -> dict[str, Any]:
        return self._request("GET", "/version")

    def health(self) -> dict[str, Any]:
        return self._request("GET", "/health")

    # ── the one call this suite makes ────────────────────────────

    def recall(
        self,
        bank: str,
        query_id: str,
        query: str,
        *,
        budget: str = "low",
        max_tokens: int = 4096,
        types: list[str] | None = None,
    ) -> RecallObservation:
        payload: dict[str, Any] = {
            "query": query,
            "budget": budget,
            "max_tokens": max_tokens,
            "trace": True,
        }
        if types:
            payload["types"] = types
        started = time.monotonic()
        try:
            raw = self._request("POST", f"/v1/default/banks/{bank}/memories/recall", payload)
        except urllib.error.HTTPError as exc:
            return RecallObservation(
                query_id=query_id,
                bank=bank,
                ok=False,
                http_status=exc.code,
                error=f"HTTP {exc.code}",
                elapsed_ms=round((time.monotonic() - started) * 1000, 1),
            )
        except Exception as exc:  # noqa: BLE001 - any transport failure is a failed case
            return RecallObservation(
                query_id=query_id,
                bank=bank,
                ok=False,
                error=f"{type(exc).__name__}: {exc}",
                elapsed_ms=round((time.monotonic() - started) * 1000, 1),
            )
        elapsed = round((time.monotonic() - started) * 1000, 1)
        obs = parse_observation(query_id, bank, raw)
        obs.elapsed_ms = elapsed
        return obs


def parse_observation(query_id: str, bank: str, raw: dict[str, Any]) -> RecallObservation:
    """Reduce a recall response to ranked id lists.

    Only ids are kept. Memory text never enters an observation, so it can never
    reach a result file: this repo is public and the banks are a live operator's
    private memory. The ids are opaque UUIDs and carry no content.

    Trace shape is ``hindsight_api/engine/search/trace.py`` at tag v0.8.6:
    ``retrieval_results[].method_name`` in {semantic, bm25, graph, temporal},
    one entry per (method, fact_type); ``rrf_merged[]``; ``reranked[]``.
    """
    from . import metrics

    results = raw.get("results") or []
    obs = RecallObservation(
        query_id=query_id,
        bank=bank,
        ok=True,
        http_status=200,
        result_count=len(results),
    )

    trace = raw.get("trace") or {}
    per_arm: dict[str, list[list[str]]] = {}
    for entry in trace.get("retrieval_results") or []:
        arm = entry.get("method_name")
        if not arm:
            continue
        ranked = [r["node_id"] for r in entry.get("results") or [] if r.get("node_id")]
        per_arm.setdefault(arm, []).append(ranked)

    for arm, lists in per_arm.items():
        obs.arms[arm] = metrics.pool_by_best_rank(lists)

    for arm in ("semantic", "bm25", "graph"):
        obs.stages[f"arm:{arm}"] = obs.arms.get(arm, [])

    obs.stages["rrf_client"] = metrics.rrf_fuse(obs.arms)
    obs.stages["rrf_engine"] = [
        r["node_id"] for r in trace.get("rrf_merged") or [] if r.get("node_id")
    ]
    obs.stages["rerank"] = [r["node_id"] for r in trace.get("reranked") or [] if r.get("node_id")]
    obs.stages["final"] = [r["id"] for r in results if r.get("id")]
    return obs
