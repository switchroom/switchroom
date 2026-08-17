#!/usr/bin/env python3
"""Zero-cost schema + consistency lint for the decisive-gap fixture set (RFC P11).

No network, no database, no docker. Loads the fixture set strictly and checks
that every case's declared ``expect_top`` is actually what the faithful ranker
ranks first at that case's gap — so a hand-edited expectation that no longer
matches the mechanic is caught here, not only in the unittest.

    python3 evals/recall/decisive_gap/validate_fixtures.py
    python3 evals/recall/decisive_gap/validate_fixtures.py --selftest
"""

from __future__ import annotations

import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent.parent))

from evals.recall.decisive_gap import ranker  # noqa: E402
from evals.recall.decisive_gap.fixtures import (  # noqa: E402
    DEFAULT_PATH,
    FixtureError,
    load_fixtures,
)


def _check_expectations(fs) -> list[str]:
    problems: list[str] = []
    for case in fs.cases:
        cands = [
            ranker.Candidate(c.id, c.ce, c.recency, c.temporal, c.proof) for c in case.candidates
        ]
        top = ranker.rank(cands, case.gap)[0]
        if top != case.expect_top:
            problems.append(
                f"{case.id}: expect_top={case.expect_top!r} but ranker returns {top!r} "
                f"at gap {case.gap}"
            )
    used = {c.cls for c in fs.cases}
    missing = set(fs.classes) - used
    if missing:
        problems.append(f"declared classes never exercised: {sorted(missing)}")
    return problems


def validate(path: Path) -> int:
    try:
        fs = load_fixtures(path)
    except FixtureError as e:
        print(f"FAIL {path}: {e}")
        return 1
    problems = _check_expectations(fs)
    if problems:
        for p in problems:
            print(f"FAIL {p}")
        return 1
    print(
        f"OK {fs.fixtureset_id} {fs.fixtureset_version} "
        f"({len(fs.cases)} cases, {len(fs.classes)} classes, sha256={fs.sha256[:12]})"
    )
    return 0


def selftest() -> int:
    """Prove the lint can fail: a tampered expectation must be rejected."""
    import copy

    import yaml

    doc = yaml.safe_load(DEFAULT_PATH.read_bytes())
    tampered = copy.deepcopy(doc)
    # Flip the first case's expected winner to the other candidate.
    first = tampered["cases"][0]
    others = [c["id"] for c in first["candidates"] if c["id"] != first["expect_top"]]
    first["expect_top"] = others[0]

    import tempfile

    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=True) as fh:
        yaml.safe_dump(tampered, fh)
        fh.flush()
        rc = validate(Path(fh.name))
    if rc == 0:
        print("SELFTEST FAIL: a tampered expectation was accepted")
        return 1
    print("SELFTEST OK: tampered expectation rejected")
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv[1:]:
        raise SystemExit(selftest())
    raise SystemExit(validate(DEFAULT_PATH))
