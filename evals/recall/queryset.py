#!/usr/bin/env python3
"""Query-set and qrels loading for the recall-quality eval (#4479).

The query set is the asset this phase leaves behind, so loading it is strict:
an unknown key, a duplicate id or an empty query is an error, not a warning. A
silently-dropped case is a silently-shrunk denominator, and every metric in the
suite is a ratio.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import yaml

CASE_KEYS = {"id", "family", "text", "probe", "banks", "notes"}
TOP_KEYS = {
    "schema_version",
    "queryset_version",
    "queryset_id",
    "provenance",
    "families",
    "cases",
}


class QuerySetError(ValueError):
    pass


@dataclass(frozen=True)
class Case:
    id: str
    family: str
    text: str
    probe: str | None = None
    banks: tuple[str, ...] | None = None
    notes: str | None = None


@dataclass
class QuerySet:
    queryset_id: str
    queryset_version: str
    schema_version: int
    families: dict[str, str]
    provenance: dict
    cases: list[Case]
    sha256: str

    def filtered(self, families: list[str]) -> QuerySet:
        wanted = {f.strip() for f in families if f.strip()}
        unknown = wanted - set(self.families)
        if unknown:
            raise QuerySetError(f"unknown families: {sorted(unknown)}")
        return QuerySet(
            self.queryset_id,
            self.queryset_version,
            self.schema_version,
            self.families,
            self.provenance,
            [c for c in self.cases if c.family in wanted],
            self.sha256,
        )

    def limited(self, n: int, seed: int = 0) -> QuerySet:
        """Take a deterministic, family-balanced subset of ``n`` cases.

        Deliberately not `random.sample`: a subset that changes between runs
        makes two result files incomparable, and the whole point of `--limit` is
        to run a small set on a contended box and still be able to diff it
        against the next one. Selection is a stable round-robin across families
        ordered by `sha256(seed:id)`, so the same (n, seed) always yields the
        same cases and every family is represented before any family repeats.
        """
        if n <= 0 or n >= len(self.cases):
            return self
        by_family: dict[str, list[Case]] = {}
        for case in self.cases:
            by_family.setdefault(case.family, []).append(case)
        for family in by_family:
            by_family[family].sort(
                key=lambda c: hashlib.sha256(f"{seed}:{c.id}".encode()).hexdigest()
            )
        picked: list[Case] = []
        order = sorted(by_family)
        i = 0
        while len(picked) < n:
            progressed = False
            for family in order:
                if i < len(by_family[family]):
                    picked.append(by_family[family][i])
                    progressed = True
                    if len(picked) == n:
                        break
            if not progressed:
                break
            i += 1
        picked.sort(key=lambda c: c.id)
        return QuerySet(
            self.queryset_id,
            self.queryset_version,
            self.schema_version,
            self.families,
            self.provenance,
            picked,
            self.sha256,
        )


def load_queryset(path: str | Path) -> QuerySet:
    raw_text = Path(path).read_text()
    data = yaml.safe_load(raw_text)
    if not isinstance(data, dict):
        raise QuerySetError(f"{path}: top level must be a mapping")

    unknown = set(data) - TOP_KEYS
    if unknown:
        raise QuerySetError(f"{path}: unknown top-level keys {sorted(unknown)}")
    for key in ("schema_version", "queryset_version", "queryset_id", "families", "cases"):
        if key not in data:
            raise QuerySetError(f"{path}: missing required key {key!r}")
    if data["schema_version"] != 1:
        raise QuerySetError(f"{path}: unsupported schema_version {data['schema_version']!r}")

    families = data["families"]
    if not isinstance(families, dict) or not families:
        raise QuerySetError(f"{path}: families must be a non-empty mapping")

    cases: list[Case] = []
    seen: set[str] = set()
    for i, raw in enumerate(data["cases"] or []):
        if not isinstance(raw, dict):
            raise QuerySetError(f"{path}: case #{i} is not a mapping")
        extra = set(raw) - CASE_KEYS
        if extra:
            raise QuerySetError(f"{path}: case #{i} has unknown keys {sorted(extra)}")
        cid = raw.get("id")
        if not cid or not isinstance(cid, str):
            raise QuerySetError(f"{path}: case #{i} has no id")
        if cid in seen:
            raise QuerySetError(f"{path}: duplicate case id {cid!r}")
        seen.add(cid)
        family = raw.get("family")
        if family not in families:
            raise QuerySetError(f"{path}: case {cid} has unknown family {family!r}")
        text = (raw.get("text") or "").strip()
        if not text:
            raise QuerySetError(f"{path}: case {cid} has empty text")
        banks = raw.get("banks")
        cases.append(
            Case(
                id=cid,
                family=family,
                text=text,
                probe=raw.get("probe"),
                banks=tuple(banks) if banks else None,
                notes=raw.get("notes"),
            )
        )
    if not cases:
        raise QuerySetError(f"{path}: no cases")

    return QuerySet(
        queryset_id=data["queryset_id"],
        queryset_version=data["queryset_version"],
        schema_version=data["schema_version"],
        families=families,
        provenance=data.get("provenance") or {},
        cases=cases,
        sha256=hashlib.sha256(raw_text.encode()).hexdigest(),
    )


def load_qrels(path: str | Path) -> dict[str, dict[str, int]]:
    """Load relevance judgements.

    Shape::

        {
          "judgement": {"method": "...", "judge": "...", "date": "...",
                        "pool_depth": 10, "pool_configs": ["..."]},
          "qrels": {"<case-id>": {"<memory-uuid>": 2, ...}, ...}
        }

    Ids and integer grades only. Memory TEXT must never appear in a qrels file:
    this repository is public and the memories are private. The `judgement`
    block is mandatory because #4479 item 6 asks for provenance to be recorded
    rather than implied, and a file without it cannot answer "where did these
    labels come from".
    """
    data = json.loads(Path(path).read_text())
    if "judgement" not in data:
        raise QuerySetError(f"{path}: qrels file has no 'judgement' provenance block")
    qrels = data.get("qrels") or {}
    out: dict[str, dict[str, int]] = {}
    for case_id, judgements in qrels.items():
        out[case_id] = {str(doc): int(grade) for doc, grade in (judgements or {}).items()}
    return out
