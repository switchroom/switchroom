#!/usr/bin/env python3
"""Trigger routing eval runner for switchroom skills."""

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

EVALS_DIR = Path(__file__).parent
RESULTS_DIR = EVALS_DIR / "results"
SKILLS_DIR = EVALS_DIR.parent / "skills"
DEFAULT_MODEL = "claude-sonnet-5"

# The abstain sentinel. When no skill fits a query the router is expected to
# return this instead of forcing a wrong pick. Trigger evals may set
# expected_skill: "none" to assert a query is deliberately out-of-scope.
NONE_ROUTE = "none"


def _description_line_fallback(frontmatter: str) -> str:
    """Extract description without strict YAML.

    Several shipped SKILL.md files carry an unquoted plain-scalar description
    containing a bare ': ' (e.g. 'MCP SDK): use ...') — invalid strict YAML but
    accepted by Claude Code's own tolerant frontmatter reader. Match that
    leniency: pull the raw description value (plain, quoted, or | / > block
    scalar) by hand so these skills stay routable.
    """
    lines = frontmatter.splitlines()
    for i, line in enumerate(lines):
        m = re.match(r"^description:\s*(.*)$", line)
        if not m:
            continue
        rest = m.group(1).strip()
        if rest in ("|", ">", "|-", ">-", "|+", ">+"):
            block = []
            for cont in lines[i + 1:]:
                if cont.strip() == "" or cont[:1] in (" ", "\t"):
                    block.append(cont.strip())
                else:
                    break
            return " ".join(x for x in block if x).strip()
        if rest[:1] in ("'", '"') and rest[-1:] == rest[:1] and len(rest) >= 2:
            return rest[1:-1].strip()
        return rest
    return ""


def load_skill_description(skill_name: str) -> str:
    path = SKILLS_DIR / skill_name / "SKILL.md"
    if not path.exists():
        return ""
    text = path.read_text()
    if not text.startswith("---"):
        return ""
    end = text.find("\n---", 3)
    if end == -1:
        return ""
    frontmatter = text[3:end]
    try:
        fm = yaml.safe_load(frontmatter)
        if isinstance(fm, dict) and fm.get("description"):
            return fm["description"]
    except yaml.YAMLError:
        pass
    # Tolerant fallback for frontmatter that isn't strict YAML.
    return _description_line_fallback(frontmatter)


def discover_routable_skills(allowlist: list[str] | None = None) -> dict[str, str]:
    """Derive the routable roster by scanning skills/*/SKILL.md frontmatter.

    Replaces the historical 6-item hard-code: the router now sees every
    skill that ships a SKILL.md with a non-empty description, so the eval
    measures routing against the real roster agents are exposed to. An
    optional allowlist restricts the roster (e.g. to reproduce a legacy run).
    """
    out: dict[str, str] = {}
    if not SKILLS_DIR.is_dir():
        return out
    for skill_dir in sorted(SKILLS_DIR.iterdir()):
        if not skill_dir.is_dir():
            continue
        name = skill_dir.name
        if allowlist is not None and name not in allowlist:
            continue
        desc = load_skill_description(name)
        if not desc:
            # A skill dir with no parseable description can't be routed to —
            # it would appear as a nameless bullet. Skip with a warning; the
            # dataset-reference check below hard-fails if an eval needs it.
            print(f"WARN: skill {name} has no description in SKILL.md frontmatter — excluded from roster", file=sys.stderr)
            continue
        out[name] = desc
    return out


def validate_dataset_references(evals: list[dict], roster: dict[str, str]) -> None:
    """Hard-fail (exit 2) if any dataset-referenced skill is unroutable.

    Every expected_skill (other than the 'none' sentinel) and every
    expected_not_skills distractor must resolve to a real skill that has a
    SKILL.md with a description — otherwise the eval is silently unscorable.
    """
    referenced: set[str] = set()
    for e in evals:
        gold = e.get("expected_skill")
        if gold and gold != NONE_ROUTE:
            referenced.add(gold)
        for d in e.get("expected_not_skills", []) or []:
            if d != NONE_ROUTE:
                referenced.add(d)

    problems: list[str] = []
    for name in sorted(referenced):
        path = SKILLS_DIR / name / "SKILL.md"
        if not path.exists():
            problems.append(f"{name}: no skills/{name}/SKILL.md")
        elif name not in roster:
            problems.append(f"{name}: SKILL.md present but no parseable description")
    if problems:
        print("FATAL: trigger dataset references unroutable skills:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        sys.exit(2)


ROUTING_SYSTEM_PROMPT = """You are a skill router for the switchroom-ai platform.
Given a user query, select the single best skill from the list below.

Available skills:
{skill_list}

If NONE of the skills above is a good fit for the query, select "none" instead
of forcing a wrong pick.

Respond with ONLY a JSON object in this exact format:
{{"selected_skill": "<skill-name-or-none>", "confidence": "high|medium|low"}}

Do not include any other text."""


def git_sha() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=EVALS_DIR,
            stderr=subprocess.DEVNULL,
        ).decode().strip()
    except Exception:
        return "unknown"


def build_skill_list(roster: dict[str, str]) -> str:
    lines = [f"- {name}: {desc}" for name, desc in roster.items()]
    return "\n".join(lines)


async def call_claude(
    prompt: str,
    model: str,
    system_prompt: str | None = None,
    append_system: bool = False,
    timeout: int = 60,
) -> str:
    args = ["claude", "-p", prompt, "--model", model, "--print", "--no-session-persistence"]
    if system_prompt:
        if append_system:
            args.extend(["--append-system-prompt", system_prompt])
        else:
            args.extend(["--system-prompt", system_prompt])
    # Use CLAUDE_CONFIG_DIR for OAuth credentials. Run from /tmp to
    # avoid CLAUDE.md auto-discovery from the project directory — the
    # project's CLAUDE.md adds conversational instructions that compete
    # with the eval's system prompt (especially the "respond with ONLY
    # JSON" routing instruction).
    env = {**os.environ, "SWITCHROOM_EVAL_MODE": "1"}
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR")
    if config_dir:
        env["CLAUDE_CONFIG_DIR"] = config_dir
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
        cwd="/tmp",  # clean dir — no CLAUDE.md interference
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError(f"claude -p timed out after {timeout}s")
    if proc.returncode != 0:
        raise RuntimeError(f"claude -p failed (exit {proc.returncode}): {stderr.decode().strip()}")
    return stdout.decode("utf-8").strip()


def parse_selected_skill(response_text: str) -> str | None:
    # Try strict JSON first
    try:
        data = json.loads(response_text.strip())
        return data.get("selected_skill")
    except json.JSONDecodeError:
        pass
    # Fallback: extract from partial JSON
    match = re.search(r'"selected_skill"\s*:\s*"([^"]+)"', response_text)
    return match.group(1) if match else None


async def run_single(
    eval_item: dict,
    model: str,
    run_index: int,
    roster: dict[str, str],
    timeout: int = 180,
) -> dict:
    # Put routing instructions IN the user prompt — claude -p ignores
    # --system-prompt in practice (it gets overridden by Claude Code's
    # own system prompt framing). Combining everything into one prompt
    # ensures the model sees the routing task.
    routing_context = ROUTING_SYSTEM_PROMPT.format(skill_list=build_skill_list(roster))
    combined_prompt = f"{routing_context}\n\nUser query: {eval_item['query']}"

    response_text = await call_claude(
        combined_prompt,
        model,
        timeout=timeout,
    )
    selected = parse_selected_skill(response_text)

    expected = eval_item["expected_skill"]
    not_expected = eval_item.get("expected_not_skills", [])

    wrong_route = bool(selected) and selected in not_expected
    passed = selected == expected and not wrong_route

    return {
        "id": eval_item["id"],
        "run": run_index,
        "query": eval_item["query"],
        "expected_skill": expected,
        "selected_skill": selected,
        "passed": passed,
        "wrong_route": wrong_route,
        "error": None,
        "raw_response": response_text[:200],
        "tags": eval_item.get("tags", []),
    }


async def run_eval_multi(
    eval_item: dict,
    model: str,
    runs: int,
    semaphore: asyncio.Semaphore,
    roster: dict[str, str],
    timeout: int = 180,
) -> list[dict]:
    async def bounded(run_idx):
        async with semaphore:
            return await run_single(eval_item, model, run_idx, roster, timeout=timeout)

    outcomes = await asyncio.gather(
        *[bounded(i) for i in range(runs)], return_exceptions=True
    )
    rows: list[dict] = []
    for i, o in enumerate(outcomes):
        if isinstance(o, Exception):
            # Convert the exception into a failed row so the results
            # artifact ALWAYS exists (CI parses it to gate the build).
            rows.append({
                "id": eval_item["id"],
                "run": i,
                "query": eval_item["query"],
                "expected_skill": eval_item["expected_skill"],
                "selected_skill": None,
                "passed": False,
                "wrong_route": False,
                "error": f"{type(o).__name__}: {o}",
                "raw_response": "",
                "tags": eval_item.get("tags", []),
            })
        else:
            rows.append(o)
    return rows


async def run_all(evals, model, runs, parallel, roster, timeout=180) -> list[dict]:
    semaphore = asyncio.Semaphore(parallel)
    tasks = [run_eval_multi(e, model, runs, semaphore, roster, timeout=timeout) for e in evals]
    batches = await asyncio.gather(*tasks)
    return [r for batch in batches for r in batch]


def main():
    parser = argparse.ArgumentParser(description="Run trigger routing evals for switchroom skills")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Model to use")
    parser.add_argument("--parallel", type=int, default=5, help="Concurrent requests")
    parser.add_argument("--runs", type=int, default=1, help="Runs per eval (for flakiness detection)")
    parser.add_argument("--filter", help="Filter evals by expected_skill or tag")
    parser.add_argument("--skills", help="Comma-separated allowlist restricting the routable roster")
    parser.add_argument("--dataset", default=str(EVALS_DIR / "trigger_dataset.yaml"))
    parser.add_argument("--timeout", type=int, default=180, help="Per-call timeout in seconds")
    args = parser.parse_args()

    dataset = yaml.safe_load(Path(args.dataset).read_text())
    evals = dataset["trigger_evals"]

    if args.filter:
        evals = [
            e for e in evals
            if args.filter == e.get("expected_skill")
            or args.filter in e.get("tags", [])
        ]

    if not evals:
        print("FATAL: no evals selected after --filter", file=sys.stderr)
        sys.exit(2)

    allowlist = None
    if args.skills:
        allowlist = [s.strip() for s in args.skills.split(",") if s.strip()]
    roster = discover_routable_skills(allowlist)
    # Every skill a dataset entry names as gold or distractor must be routable.
    validate_dataset_references(evals, roster)

    print(f"Running {len(evals)} trigger evals x{args.runs} runs "
          f"(parallel={args.parallel}, roster={len(roster)} skills + '{NONE_ROUTE}')")

    results = asyncio.run(run_all(evals, args.model, args.runs, args.parallel, roster, args.timeout))

    passed = sum(1 for r in results if r["passed"])
    total = len(results)
    wrong_routes = sum(1 for r in results if r["wrong_route"])
    errored = sum(1 for r in results if r.get("error"))
    print(f"\nResults: {passed}/{total} passed "
          f"({wrong_routes} wrong-route, {errored} errored)")

    # Group by eval id for multi-run summary
    by_id: dict[str, list[dict]] = {}
    for r in results:
        by_id.setdefault(r["id"], []).append(r)

    any_failed = False
    for eval_id, runs in sorted(by_id.items()):
        run_passed = sum(1 for r in runs if r["passed"])
        any_wrong = any(r["wrong_route"] for r in runs)
        any_err = any(r.get("error") for r in runs)
        if run_passed == len(runs):
            status = "PASS"
        elif any_wrong:
            # A wrong-route (picked a declared distractor) is a WORSE failure
            # than a miss/abstain — distractors are load-bearing, so surface it.
            status = "WRONG_ROUTE"
        elif any_err:
            status = "ERROR"
        elif run_passed > 0:
            status = "FLAKY"
        else:
            status = "FAIL"
        if status != "PASS":
            any_failed = True
        selected_skills = list({r["selected_skill"] for r in runs})
        expected = runs[0]["expected_skill"]
        print(f"  [{status}] {eval_id}: expected={expected}, got={selected_skills} ({run_passed}/{len(runs)})")

    RESULTS_DIR.mkdir(exist_ok=True)
    output = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "model": args.model,
        "git_sha": git_sha(),
        "runs_per_eval": args.runs,
        "roster": sorted(roster.keys()),
        "summary": {
            "passed": passed,
            "total": total,
            "wrong_route": wrong_routes,
            "errored": errored,
        },
        "results": results,
    }
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    outfile = RESULTS_DIR / f"trigger_{ts}.json"
    outfile.write_text(json.dumps(output, indent=2))
    print(f"\nResults written to {outfile}")

    if any_failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
