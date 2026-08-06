#!/usr/bin/env python3
"""Zero-cost schema and lint pass over the recall query set (#4479).

Sibling of `evals/validate_datasets.py` and runs in the same CI job: no network,
no model, no database, so it protects the asset on every PR including forks.

HARD lints (exit 1) are the ones that would make a run silently meaningless:

* the query set does not parse, or has a duplicate/empty case
* fewer than `--min-cases` cases (#4479 scope item 1 asks for at least 100)
* a family declared but unused, or a case in an undeclared family
* a `zero-result-probe` population under `--min-zero-probes` (the headline
  metric's subset comes from here; too few and the ratio is noise)
* a `morphological` case with no `probe` note, i.e. a stemming probe that does
  not say what it is probing
* two cases with identical text (a duplicated denominator entry)

WARN (exit 0): family length distribution drifting far from the shape the
provenance block claims it was built to match.
"""

from __future__ import annotations

import argparse
import statistics
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from evals.recall.queryset import QuerySetError, load_queryset  # noqa: E402

HERE = Path(__file__).resolve().parent
DEFAULT_QUERYSET = HERE / "queryset" / "v1.yaml"


def validate(path: Path, *, min_cases: int, min_zero_probes: int) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    try:
        qs = load_queryset(path)
    except QuerySetError as exc:
        return [str(exc)], []

    if len(qs.cases) < min_cases:
        errors.append(
            f"{len(qs.cases)} cases, below the {min_cases} minimum "
            "(#4479 scope item 1: at least 100 queries)"
        )

    used = {c.family for c in qs.cases}
    unused = set(qs.families) - used
    if unused:
        errors.append(f"declared but unused families: {sorted(unused)}")

    zero_probes = [c for c in qs.cases if c.family == "zero-result-probe"]
    if len(zero_probes) < min_zero_probes:
        errors.append(
            f"only {len(zero_probes)} zero-result-probe cases, below {min_zero_probes}. "
            "The headline metric's subset is drawn from these; too few makes the ratio noise."
        )

    missing_probe = [c.id for c in qs.cases if c.family == "morphological" and not c.probe]
    if missing_probe:
        errors.append(f"morphological cases with no `probe` note: {missing_probe}")

    by_text: dict[str, list[str]] = {}
    for case in qs.cases:
        by_text.setdefault(" ".join(case.text.lower().split()), []).append(case.id)
    dupes = {text: ids for text, ids in by_text.items() if len(ids) > 1}
    if dupes:
        errors.append(f"duplicate query text across cases: {sorted(dupes.values())}")

    blobs = [len(c.text) for c in qs.cases if c.family == "context-blob"]
    claimed = (qs.provenance.get("shaped_by") or {}).get("query_chars_p50")
    if blobs and claimed:
        median = statistics.median(blobs)
        if abs(median - float(claimed)) > 0.4 * float(claimed):
            warnings.append(
                f"context-blob median length {median:.0f} is far from the "
                f"{claimed} the provenance block claims it matches"
            )

    return errors, warnings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="validate the recall query set")
    parser.add_argument("--queryset", default=str(DEFAULT_QUERYSET))
    parser.add_argument("--min-cases", type=int, default=100)
    parser.add_argument("--min-zero-probes", type=int, default=15)
    parser.add_argument(
        "--selftest",
        action="store_true",
        help="assert each HARD lint fires on a fixture, so the validator cannot go vacuous",
    )
    args = parser.parse_args(argv)

    if args.selftest:
        return selftest()

    errors, warnings = validate(
        Path(args.queryset), min_cases=args.min_cases, min_zero_probes=args.min_zero_probes
    )
    for warning in warnings:
        print(f"WARN  {warning}")
    for error in errors:
        print(f"ERROR {error}", file=sys.stderr)
    if errors:
        return 1
    qs = load_queryset(Path(args.queryset))
    print(
        f"ok: {qs.queryset_id} {qs.queryset_version}, {len(qs.cases)} cases "
        f"across {len(qs.families)} families"
    )
    return 0


def selftest() -> int:
    """Prove each HARD lint fires. A validator nobody has seen fail is a no-op."""
    import tempfile
    import textwrap

    base = textwrap.dedent(
        """
        schema_version: 1
        queryset_version: "t"
        queryset_id: t
        families:
          alpha: a
          morphological: m
          zero-result-probe: z
        cases:
          - {id: a1, family: alpha, text: one}
          - {id: m1, family: morphological, text: two, probe: "x -> y"}
          - {id: z1, family: zero-result-probe, text: three}
        """
    ).strip()

    fixtures = {
        "too-few-cases": (base, dict(min_cases=100, min_zero_probes=1), "below the 100 minimum"),
        "too-few-zero-probes": (base, dict(min_cases=1, min_zero_probes=5), "zero-result-probe"),
        "unused-family": (
            base.replace("  alpha: a\n", "  alpha: a\n  beta: b\n"),
            dict(min_cases=1, min_zero_probes=1),
            "unused families",
        ),
        "morphological-no-probe": (
            base.replace(', probe: "x -> y"', ""),
            dict(min_cases=1, min_zero_probes=1),
            "no `probe` note",
        ),
        "duplicate-text": (
            base + "\n  - {id: a2, family: alpha, text: One}",
            dict(min_cases=1, min_zero_probes=1),
            "duplicate query text",
        ),
        "duplicate-id": (
            base + "\n  - {id: a1, family: alpha, text: four}",
            dict(min_cases=1, min_zero_probes=1),
            "duplicate case id",
        ),
        "unknown-family": (
            base + "\n  - {id: x1, family: nope, text: four}",
            dict(min_cases=1, min_zero_probes=1),
            "unknown family",
        ),
        "empty-text": (
            base + '\n  - {id: e1, family: alpha, text: "  "}',
            dict(min_cases=1, min_zero_probes=1),
            "empty text",
        ),
    }

    failures = 0
    with tempfile.TemporaryDirectory() as tmp:
        # The base fixture itself must be clean, or every lint below is trivially
        # "firing" on unrelated breakage.
        clean = Path(tmp) / "clean.yaml"
        clean.write_text(base)
        errors, _ = validate(clean, min_cases=1, min_zero_probes=1)
        if errors:
            print(f"FAIL  base fixture is not clean: {errors}", file=sys.stderr)
            failures += 1

        for name, (text, kwargs, needle) in fixtures.items():
            path = Path(tmp) / f"{name}.yaml"
            path.write_text(text)
            errors, _ = validate(path, **kwargs)
            if not any(needle in e for e in errors):
                print(f"FAIL  lint {name!r} did not fire (errors={errors})", file=sys.stderr)
                failures += 1
            else:
                print(f"ok    lint {name!r} fires")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
