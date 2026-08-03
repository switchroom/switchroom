#!/usr/bin/env python3
"""Static validator for the switchroom eval datasets.

Zero model cost — pure schema + lint checks over dataset.yaml and
trigger_dataset.yaml. Runs UNCONDITIONALLY in CI before the auth gate so it
also protects fork PRs (which have no Anthropic credential).

Two tiers:
  * HARD errors (exit 1) — structural defects that make an eval unscorable
    or trivially-passing: missing/unknown keys, dup ids, empty assertions,
    uncompilable or parenthesised regex, unknown skill refs, self-distractor,
    missing gold, and strict echo-only entries.
  * WARN (exit 0) — quality smells deferred to the authoring buckets:
    weak (any-alternative) echo and bare-hedge negatives. Non-gating so the
    current dataset stays green while the signal is still surfaced.

`--selftest` runs the lints against inline known-bad fixtures and asserts each
HARD lint fires — so a lint that silently stops catching its defect fails CI.
"""

import argparse
import re
import sys
from pathlib import Path

import yaml

EVALS_DIR = Path(__file__).parent
SKILLS_DIR = EVALS_DIR.parent / "skills"
NONE_ROUTE = "none"

QUALITY_REQUIRED = {"id", "question", "primary_skill", "expected_contains"}
QUALITY_OPTIONAL = {"expected_not_contains", "tags"}
TRIGGER_REQUIRED = {"id", "query", "expected_skill"}
TRIGGER_OPTIONAL = {"expected_not_skills", "tags"}

# Anchored bare-hedge patterns: a refusal with NO named object. Service-
# specific inability ('I cannot manipulate PDFs', "I don't have Notion access")
# is LEGAL and used by buckets 4–5, so the match is anchored full-string —
# never a substring ban.
BARE_HEDGE = re.compile(
    r"^\s*i\s*('?m| am|'?ll)?\s*"
    r"(can\s?not|can'?t|do\s?n'?t\s+know|do\s?n'?t\s+have\s+access|"
    r"'?m\s+unable|am\s+unable|'?m\s+not\s+able|am\s+not\s+able)"
    r"[\s.!]*$",
    re.IGNORECASE,
)


def skill_exists(name: str) -> bool:
    return (SKILLS_DIR / name / "SKILL.md").exists()


def alternatives(pattern: str) -> list[str]:
    return [a.strip() for a in pattern.split("|")]


def strict_echo(question: str, expected_contains: list[str]) -> bool:
    """Echo-only: EVERY alternative of EVERY expected_contains item is already
    present (case-insensitively) in the question, so any response that merely
    restates the question passes. HARD failure."""
    if not expected_contains:
        return False
    q = question.lower()
    for item in expected_contains:
        if not all(alt.lower() in q for alt in alternatives(item) if alt):
            return False
    return True


def weak_echo(question: str, expected_contains: list[str]) -> bool:
    """WARN tier: every item has AT LEAST ONE alternative present in the
    question (OR-match makes each item echo-satisfiable). Broader than
    strict_echo; would trip ~40 legacy entries, so non-gating."""
    if not expected_contains:
        return False
    q = question.lower()
    for item in expected_contains:
        if not any(alt.lower() in q for alt in alternatives(item) if alt):
            return False
    return True


def validate_quality(evals: list[dict]) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    seen_ids: set[str] = set()

    for i, e in enumerate(evals):
        eid = e.get("id", f"<index {i}>")
        keys = set(e.keys())
        missing = QUALITY_REQUIRED - keys
        if missing:
            errors.append(f"[{eid}] missing required keys: {sorted(missing)}")
        unknown = keys - QUALITY_REQUIRED - QUALITY_OPTIONAL
        if unknown:
            errors.append(f"[{eid}] unknown keys (typo?): {sorted(unknown)}")

        if "id" in e:
            if e["id"] in seen_ids:
                errors.append(f"[{eid}] duplicate id")
            seen_ids.add(e["id"])

        ec = e.get("expected_contains") or []
        if not ec:
            errors.append(f"[{eid}] empty expected_contains — zero-assertion eval")

        ps = e.get("primary_skill")
        if ps and not skill_exists(ps):
            errors.append(f"[{eid}] primary_skill '{ps}' has no skills/{ps}/SKILL.md")

        for field in ("expected_contains", "expected_not_contains"):
            for item in e.get(field) or []:
                for alt in alternatives(item):
                    if not alt:
                        continue
                    if "(" in alt or ")" in alt:
                        errors.append(f"[{eid}] {field} fragment {alt!r}: parenthesised groups banned (flat pipe-alternation only)")
                    try:
                        re.compile(alt)
                    except re.error as ex:
                        errors.append(f"[{eid}] {field} fragment {alt!r}: uncompilable regex ({ex})")

        if strict_echo(e.get("question", ""), ec):
            errors.append(f"[{eid}] echo-only: every assertion alternative already appears in the question")
        elif weak_echo(e.get("question", ""), ec):
            warnings.append(f"[{eid}] weak-echo: each expected_contains item has an alternative echoing the question")

        for item in e.get("expected_not_contains") or []:
            for alt in alternatives(item):
                if alt and BARE_HEDGE.match(alt):
                    warnings.append(f"[{eid}] bare-hedge not_contains {alt!r}: no named object — prefer a service-specific refusal")

    return errors, warnings


def validate_trigger(evals: list[dict]) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    seen_ids: set[str] = set()

    for i, e in enumerate(evals):
        eid = e.get("id", f"<index {i}>")
        keys = set(e.keys())
        missing = TRIGGER_REQUIRED - keys
        if missing:
            errors.append(f"[{eid}] missing required keys: {sorted(missing)}")
        unknown = keys - TRIGGER_REQUIRED - TRIGGER_OPTIONAL
        if unknown:
            errors.append(f"[{eid}] unknown keys (typo?): {sorted(unknown)}")

        if "id" in e:
            if e["id"] in seen_ids:
                errors.append(f"[{eid}] duplicate id")
            seen_ids.add(e["id"])

        # Explicit gold required — never only expected_not_skills.
        gold = e.get("expected_skill")
        if gold is None:
            errors.append(f"[{eid}] no expected_skill gold (a trigger entry must name a skill or '{NONE_ROUTE}')")
        elif gold != NONE_ROUTE and not skill_exists(gold):
            errors.append(f"[{eid}] expected_skill '{gold}' has no skills/{gold}/SKILL.md")

        ens = e.get("expected_not_skills") or []
        for d in ens:
            if d != NONE_ROUTE and not skill_exists(d):
                errors.append(f"[{eid}] expected_not_skills entry '{d}' has no skills/{d}/SKILL.md")
        if gold is not None and gold in ens:
            errors.append(f"[{eid}] expected_skill '{gold}' appears in its own expected_not_skills")

    return errors, warnings


def covered_skills(quality: list[dict], trigger: list[dict]) -> set[str]:
    covered = {e.get("primary_skill") for e in quality if e.get("primary_skill")}
    covered |= {e.get("expected_skill") for e in trigger
                if e.get("expected_skill") and e.get("expected_skill") != NONE_ROUTE}
    return covered


def all_skill_dirs() -> set[str]:
    if not SKILLS_DIR.is_dir():
        return set()
    return {d.name for d in SKILLS_DIR.iterdir() if (d / "SKILL.md").exists()}


def load_exemptions(path: Path) -> set[str]:
    if not path.exists():
        return set()
    data = yaml.safe_load(path.read_text()) or {}
    return set(data.get("exempt", []) or [])


def new_skill_dirs(base_ref: str) -> set[str] | None:
    """Skill dirs added since base_ref (added SKILL.md files). None if git fails."""
    import subprocess
    try:
        out = subprocess.check_output(
            ["git", "diff", "--name-only", "--diff-filter=A", f"{base_ref}...HEAD", "--", "skills/"],
            cwd=EVALS_DIR.parent, stderr=subprocess.DEVNULL,
        ).decode()
    except Exception:
        return None
    new = set()
    for line in out.splitlines():
        parts = line.strip().split("/")
        if len(parts) >= 2 and parts[0] == "skills" and parts[-1] == "SKILL.md":
            new.add(parts[1])
    return new


def coverage_report(quality: list[dict], trigger: list[dict], exempt: set[str],
                    base_ref: str | None, hard: bool) -> int:
    """Two-phase coverage gate.

    Soft phase (hard=False): WARN on every uncovered, non-exempt skill; exit 0.
    Hard phase (hard=True): additionally FAIL when a NEWLY-ADDED skill dir
    (relative to base_ref) has neither evals nor an exemption. Pre-existing
    gaps stay WARN so the flip doesn't retroactively break the fleet.
    """
    covered = covered_skills(quality, trigger)
    dirs = all_skill_dirs()
    uncovered = sorted(dirs - covered - exempt)
    for name in uncovered:
        print(f"WARN: skill '{name}' has no evals and no coverage-exempt entry")
    print(f"\ncoverage: {len(covered & dirs)}/{len(dirs)} skills covered, "
          f"{len(uncovered)} uncovered (exempt={len(exempt & dirs)})")

    if not hard:
        print("coverage gate: SOFT phase — reporting only")
        return 0

    new = new_skill_dirs(base_ref) if base_ref else None
    if new is None:
        print("coverage gate: HARD phase but git base unavailable — falling back to SOFT")
        return 0
    offending = sorted(set(uncovered) & new)
    if offending:
        print("ERROR: new skill dir(s) shipped without evals or exemption:", file=sys.stderr)
        for n in offending:
            print(f"  - {n}", file=sys.stderr)
        return 1
    print("coverage gate: HARD phase — no new uncovered skills")
    return 0


def load(path: Path, top_key: str) -> list[dict]:
    data = yaml.safe_load(path.read_text())
    if not isinstance(data, dict) or top_key not in data:
        raise SystemExit(f"FATAL: {path} missing top-level '{top_key}:' list")
    items = data[top_key]
    if not isinstance(items, list):
        raise SystemExit(f"FATAL: {path} '{top_key}' is not a list")
    return items


# ── selftest fixtures — one known-bad entry per HARD lint ────────────────────
def selftest() -> int:
    failures = 0

    def expect(cond: bool, label: str):
        nonlocal failures
        if not cond:
            print(f"SELFTEST FAIL: {label} lint did not fire", file=sys.stderr)
            failures += 1
        else:
            print(f"selftest ok: {label}")

    # zero-assertion
    errs, _ = validate_quality([{"id": "x", "question": "q", "primary_skill": "switchroom-cli", "expected_contains": []}])
    expect(any("zero-assertion" in e for e in errs), "empty-expected_contains")

    # unknown key (expected_containz typo)
    errs, _ = validate_quality([{"id": "x", "question": "q", "primary_skill": "switchroom-cli", "expected_contains": ["a"], "expected_containz": ["b"]}])
    expect(any("unknown keys" in e for e in errs), "unknown-key")

    # duplicate id
    base = {"question": "q", "primary_skill": "switchroom-cli", "expected_contains": ["zzz"]}
    errs, _ = validate_quality([{"id": "dup", **base}, {"id": "dup", **base}])
    expect(any("duplicate id" in e for e in errs), "duplicate-id")

    # parenthesised group
    errs, _ = validate_quality([{"id": "x", "question": "q", "primary_skill": "switchroom-cli", "expected_contains": ["(foo|bar)"]}])
    expect(any("parenthesised" in e for e in errs), "paren-group")

    # uncompilable regex
    errs, _ = validate_quality([{"id": "x", "question": "q", "primary_skill": "switchroom-cli", "expected_contains": ["[unterminated"]}])
    expect(any("uncompilable" in e for e in errs), "uncompilable-regex")

    # unknown primary_skill
    errs, _ = validate_quality([{"id": "x", "question": "q", "primary_skill": "no-such-skill", "expected_contains": ["zzz"]}])
    expect(any("no skills/" in e for e in errs), "missing-skill")

    # strict echo-only (mirrors old arch-001 family)
    errs, _ = validate_quality([{"id": "x", "question": "restart and check status now", "primary_skill": "switchroom-cli", "expected_contains": ["restart|status|check"]}])
    expect(any("echo-only" in e for e in errs), "strict-echo")

    # trigger: no gold (only expected_not_skills)
    errs, _ = validate_trigger([{"id": "t", "query": "q", "expected_not_skills": ["switchroom-cli"]}])
    expect(any("no expected_skill gold" in e for e in errs), "trigger-missing-gold")

    # trigger: self-distractor
    errs, _ = validate_trigger([{"id": "t", "query": "q", "expected_skill": "switchroom-cli", "expected_not_skills": ["switchroom-cli"]}])
    expect(any("its own expected_not_skills" in e for e in errs), "self-distractor")

    # trigger: unknown expected_skill
    errs, _ = validate_trigger([{"id": "t", "query": "q", "expected_skill": "no-such-skill"}])
    expect(any("no skills/" in e for e in errs), "trigger-unknown-skill")

    # WARN: bare hedge fires (and stays a warning, not an error)
    errs, warns = validate_quality([{"id": "x", "question": "unique probe words", "primary_skill": "switchroom-cli", "expected_contains": ["zzz"], "expected_not_contains": ["I cannot"]}])
    expect(any("bare-hedge" in w for w in warns), "bare-hedge-warn")
    expect(not any("bare-hedge" in e for e in errs), "bare-hedge-not-hard")

    # NEGATIVE: a service-specific refusal must NOT be flagged as bare-hedge
    _, warns = validate_quality([{"id": "x", "question": "unique probe words", "primary_skill": "switchroom-cli", "expected_contains": ["zzz"], "expected_not_contains": ["I cannot manipulate PDFs"]}])
    expect(not any("bare-hedge" in w for w in warns), "service-refusal-legal")

    print(f"\nselftest: {failures} lint(s) not firing as expected")
    return 1 if failures else 0


def main():
    ap = argparse.ArgumentParser(description="Validate switchroom eval datasets")
    ap.add_argument("--quality", default=str(EVALS_DIR / "dataset.yaml"))
    ap.add_argument("--trigger", default=str(EVALS_DIR / "trigger_dataset.yaml"))
    ap.add_argument("--selftest", action="store_true", help="Run lints against known-bad fixtures and exit")
    ap.add_argument("--coverage", action="store_true", help="Run the skill-coverage gate instead of the schema lints")
    ap.add_argument("--exempt", default=str(EVALS_DIR / "coverage-exempt.yaml"))
    ap.add_argument("--base-ref", default=None, help="Git ref to diff for newly-added skills (hard phase)")
    ap.add_argument("--hard", action="store_true", help="Fail on newly-added uncovered skills (phase 2)")
    args = ap.parse_args()

    if args.selftest:
        sys.exit(selftest())

    if args.coverage:
        quality = load(Path(args.quality), "evals")
        trigger = load(Path(args.trigger), "trigger_evals")
        exempt = load_exemptions(Path(args.exempt))
        sys.exit(coverage_report(quality, trigger, exempt, args.base_ref, args.hard))

    all_errors: list[str] = []
    all_warnings: list[str] = []

    q_errors, q_warns = validate_quality(load(Path(args.quality), "evals"))
    t_errors, t_warns = validate_trigger(load(Path(args.trigger), "trigger_evals"))
    all_errors = [f"quality {e}" for e in q_errors] + [f"trigger {e}" for e in t_errors]
    all_warnings = [f"quality {w}" for w in q_warns] + [f"trigger {w}" for w in t_warns]

    for w in all_warnings:
        print(f"WARN: {w}")
    for e in all_errors:
        print(f"ERROR: {e}", file=sys.stderr)

    print(f"\n{len(all_errors)} error(s), {len(all_warnings)} warning(s)")
    if all_errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
