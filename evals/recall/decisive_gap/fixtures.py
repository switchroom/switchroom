#!/usr/bin/env python3
"""Fixture loading for the decisive-relative-gap regression set (RFC P11).

Loading is strict, the same discipline ``queryset.py`` follows: an unknown key,
a duplicate id, an undeclared class, an out-of-range score or a candidate id
that is not among a case's candidates is an error, not a warning. A silently
dropped or malformed case is a silently weakened regression set.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path

import yaml

TOP_KEYS = {
    "schema_version",
    "fixtureset_version",
    "fixtureset_id",
    "provenance",
    "classes",
    "cases",
}
CASE_KEYS = {"id", "cls", "text", "gap", "candidates", "expect_top", "note"}
CANDIDATE_KEYS = {"id", "ce", "recency", "temporal", "proof"}
_SIGNAL_FIELDS = ("recency", "temporal", "proof")


class FixtureError(ValueError):
    pass


@dataclass(frozen=True)
class FixtureCandidate:
    id: str
    ce: float
    recency: float
    temporal: float
    proof: float


@dataclass(frozen=True)
class FixtureCase:
    id: str
    cls: str
    text: str
    gap: float
    candidates: tuple[FixtureCandidate, ...]
    expect_top: str
    note: str | None = None


@dataclass
class FixtureSet:
    fixtureset_id: str
    fixtureset_version: str
    schema_version: int
    classes: dict[str, str]
    provenance: dict
    cases: list[FixtureCase]
    sha256: str


def _require(cond: bool, msg: str) -> None:
    if not cond:
        raise FixtureError(msg)


def _unit(value: object, where: str) -> float:
    _require(
        isinstance(value, (int, float)) and not isinstance(value, bool),
        f"{where}: expected a number, got {value!r}",
    )
    v = float(value)  # type: ignore[arg-type]
    _require(math.isfinite(v) and 0.0 <= v <= 1.0, f"{where}: {v!r} is outside [0, 1]")
    return v


def load_fixtures(path: str | Path) -> FixtureSet:
    path = Path(path)
    raw_bytes = path.read_bytes()
    doc = yaml.safe_load(raw_bytes)
    _require(isinstance(doc, dict), "top level must be a mapping")

    unknown = set(doc) - TOP_KEYS
    _require(not unknown, f"unknown top-level keys: {sorted(unknown)}")
    for key in TOP_KEYS:
        _require(key in doc, f"missing top-level key: {key}")

    classes = doc["classes"]
    _require(isinstance(classes, dict) and bool(classes), "`classes` must be a non-empty mapping")

    cases_raw = doc["cases"]
    _require(isinstance(cases_raw, list) and bool(cases_raw), "`cases` must be a non-empty list")

    seen_ids: set[str] = set()
    cases: list[FixtureCase] = []
    for i, c in enumerate(cases_raw):
        _require(isinstance(c, dict), f"case #{i} is not a mapping")
        extra = set(c) - CASE_KEYS
        _require(not extra, f"case #{i} has unknown keys: {sorted(extra)}")
        for k in ("id", "cls", "text", "gap", "candidates", "expect_top"):
            _require(k in c, f"case #{i} missing required key: {k}")

        cid = c["id"]
        _require(isinstance(cid, str) and bool(cid), f"case #{i} has an empty id")
        _require(cid not in seen_ids, f"duplicate case id: {cid}")
        seen_ids.add(cid)

        cls = c["cls"]
        _require(cls in classes, f"{cid}: class {cls!r} is not declared in `classes`")

        gap = c["gap"]
        _require(
            isinstance(gap, (int, float)) and not isinstance(gap, bool),
            f"{cid}: gap must be a number, got {gap!r}",
        )
        gap = float(gap)
        _require(math.isfinite(gap) and gap > 0.0, f"{cid}: gap {gap!r} must be finite and > 0")

        cand_raw = c["candidates"]
        _require(
            isinstance(cand_raw, list) and len(cand_raw) >= 2,
            f"{cid}: needs at least two candidates",
        )
        cand_ids: set[str] = set()
        candidates: list[FixtureCandidate] = []
        for j, cd in enumerate(cand_raw):
            _require(isinstance(cd, dict), f"{cid} candidate #{j} is not a mapping")
            cextra = set(cd) - CANDIDATE_KEYS
            _require(not cextra, f"{cid} candidate #{j} has unknown keys: {sorted(cextra)}")
            _require("id" in cd and "ce" in cd, f"{cid} candidate #{j} needs id and ce")
            did = cd["id"]
            _require(isinstance(did, str) and bool(did), f"{cid} candidate #{j} has an empty id")
            _require(did not in cand_ids, f"{cid}: duplicate candidate id {did!r}")
            cand_ids.add(did)
            candidates.append(
                FixtureCandidate(
                    id=did,
                    ce=_unit(cd["ce"], f"{cid}/{did}.ce"),
                    # Signals default to 0.5 (neutral: boost multiplier 1.0).
                    recency=_unit(cd.get("recency", 0.5), f"{cid}/{did}.recency"),
                    temporal=_unit(cd.get("temporal", 0.5), f"{cid}/{did}.temporal"),
                    proof=_unit(cd.get("proof", 0.5), f"{cid}/{did}.proof"),
                )
            )

        expect_top = c["expect_top"]
        _require(
            expect_top in cand_ids,
            f"{cid}: expect_top {expect_top!r} is not one of the candidates {sorted(cand_ids)}",
        )

        cases.append(
            FixtureCase(
                id=cid,
                cls=cls,
                text=c["text"],
                gap=gap,
                candidates=tuple(candidates),
                expect_top=expect_top,
                note=c.get("note"),
            )
        )

    # Hash the normalised content so a result can never be compared against a set
    # it was not computed on (same guard queryset.py applies).
    canonical = json.dumps(doc, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return FixtureSet(
        fixtureset_id=doc["fixtureset_id"],
        fixtureset_version=doc["fixtureset_version"],
        schema_version=doc["schema_version"],
        classes=classes,
        provenance=doc.get("provenance", {}),
        cases=cases,
        sha256=hashlib.sha256(canonical).hexdigest(),
    )


DEFAULT_PATH = Path(__file__).resolve().parent / "fixtures" / "v1.yaml"
