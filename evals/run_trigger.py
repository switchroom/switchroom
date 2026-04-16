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
DEFAULT_MODEL = "claude-sonnet-4-6"

# Skills exposed to the trigger router. Descriptions are loaded from each
# SKILL.md frontmatter at runtime so the eval stays in sync with the real
# prompts agents see.
ROUTABLE_SKILLS = [
    "switchroom-status",
    "switchroom-health",
    "switchroom-install",
    "switchroom-manage",
    "switchroom-config",
    "switchroom-schedule",
    "switchroom-restart",
    "switchroom-reconcile",
    "switchroom-logs",
    "switchroom-architecture",
]


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
    try:
        fm = yaml.safe_load(text[3:end])
    except yaml.YAMLError:
        return ""
    return fm.get("description", "") if isinstance(fm, dict) else ""


def get_skill_descriptions() -> dict[str, str]:
    out = {}
    for name in ROUTABLE_SKILLS:
        desc = load_skill_description(name)
        if not desc:
            print(f"WARN: skill {name} missing description in SKILL.md frontmatter", file=sys.stderr)
            continue
        out[name] = desc
    return out

ROUTING_SYSTEM_PROMPT = """You are a skill router for the switchroom-ai platform.
Given a user query, select the single best skill from the list below.

Available skills:
{skill_list}

Respond with ONLY a JSON object in this exact format:
{{"selected_skill": "<skill-name>", "confidence": "high|medium|low"}}

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


def build_skill_list() -> str:
    lines = []
    for name, desc in get_skill_descriptions().items():
        lines.append(f"- {name}: {desc}")
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
    timeout: int = 180,
) -> dict:
    # Put routing instructions IN the user prompt — claude -p ignores
    # --system-prompt in practice (it gets overridden by Claude Code's
    # own system prompt framing). Combining everything into one prompt
    # ensures the model sees the routing task.
    routing_context = ROUTING_SYSTEM_PROMPT.format(skill_list=build_skill_list())
    combined_prompt = f"{routing_context}\n\nUser query: {eval_item['query']}"

    response_text = await call_claude(
        combined_prompt,
        model,
        timeout=timeout,
    )
    selected = parse_selected_skill(response_text)

    expected = eval_item["expected_skill"]
    not_expected = eval_item.get("expected_not_skills", [])

    wrong_route = selected in not_expected if selected else False
    passed = selected == expected and not wrong_route

    return {
        "id": eval_item["id"],
        "run": run_index,
        "query": eval_item["query"],
        "expected_skill": expected,
        "selected_skill": selected,
        "passed": passed,
        "wrong_route": wrong_route,
        "raw_response": response_text[:200],
        "tags": eval_item.get("tags", []),
    }


async def run_eval_multi(
    eval_item: dict,
    model: str,
    runs: int,
    semaphore: asyncio.Semaphore,
    timeout: int = 180,
) -> list[dict]:
    async def bounded(run_idx):
        async with semaphore:
            return await run_single(eval_item, model, run_idx, timeout=timeout)

    return await asyncio.gather(*[bounded(i) for i in range(runs)])


async def run_all(evals: list[dict], model: str, runs: int, parallel: int, timeout: int = 180) -> list[dict]:
    semaphore = asyncio.Semaphore(parallel)
    tasks = [run_eval_multi(e, model, runs, semaphore, timeout=timeout) for e in evals]
    batches = await asyncio.gather(*tasks)
    return [r for batch in batches for r in batch]


def main():
    parser = argparse.ArgumentParser(description="Run trigger routing evals for switchroom skills")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Model to use")
    parser.add_argument("--parallel", type=int, default=5, help="Concurrent requests")
    parser.add_argument("--runs", type=int, default=1, help="Runs per eval (for flakiness detection)")
    parser.add_argument("--filter", help="Filter evals by expected_skill or tag")
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

    print(f"Running {len(evals)} trigger evals x{args.runs} runs (parallel={args.parallel})")

    results = asyncio.run(run_all(evals, args.model, args.runs, args.parallel, args.timeout))

    passed = sum(1 for r in results if r["passed"])
    total = len(results)
    print(f"\nResults: {passed}/{total} passed")

    # Group by eval id for multi-run summary
    by_id: dict[str, list[dict]] = {}
    for r in results:
        by_id.setdefault(r["id"], []).append(r)

    any_failed = False
    for eval_id, runs in sorted(by_id.items()):
        run_passed = sum(1 for r in runs if r["passed"])
        flaky = run_passed > 0 and run_passed < len(runs)
        status = "PASS" if run_passed == len(runs) else ("FLAKY" if flaky else "FAIL")
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
        "summary": {"passed": passed, "total": total},
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
