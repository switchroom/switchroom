# Switchroom Skills Eval Framework

Evaluates Claude Code custom skills for quality and routing correctness.

## Setup

```bash
pip install pyyaml
```

## Dataset validation (zero model cost)

`validate_datasets.py` runs pure schema + lint checks over the datasets — no
model calls, so it runs unconditionally in CI (including on fork PRs, which
have no Anthropic credential). Run it before spending any quota.

```bash
python evals/validate_datasets.py            # schema + lints over both datasets
python evals/validate_datasets.py --selftest # assert each HARD lint fires on a fixture
python evals/validate_datasets.py --coverage # skill-coverage report (soft)
```

**HARD lints (exit 1)** — structural defects that make an eval unscorable or
trivially-passing: missing/unknown keys (catches `expected_containz`-style
typos), duplicate ids, empty `expected_contains` (zero-assertion), uncompilable
or parenthesised-group regex (flat pipe-alternation only), unknown skill refs,
`expected_skill` appearing in its own `expected_not_skills` (self-distractor),
a trigger entry with no gold (must name a skill or `none`), and strict
**echo-only** entries (every alternative of every assertion already appears in
the question, so any echo passes).

**WARN (exit 0)** — quality smells deferred to the authoring buckets:
weak-echo (each assertion item has *an* alternative echoing the question) and
bare-hedge negatives. Bare-hedge matching is **anchored**: a generic refusal
with no named object (`I cannot`, `I'm unable`) is flagged, but a
service-specific refusal (`I cannot manipulate PDFs`, `I don't have Notion
access`) is legal and left alone.

## Quality evals

Tests that each skill produces the right kind of response.

```bash
python evals/run_quality.py                       # all quality evals
python evals/run_quality.py --filter switchroom-status
python evals/run_quality.py --ablation            # compare with / without skill; emit uplift
python evals/run_quality.py --runs 3              # repeat each eval for flakiness detection
python evals/run_quality.py --parallel 10
python evals/run_quality.py --model claude-opus-5
python evals/run_quality.py --timeout 240         # per-call timeout in seconds
```

`--ablation` runs each eval both with and without the skill's `SKILL.md` in the
system prompt. The exit code is gated on the **with-skill** arm only; the
no-skill arm is the comparison baseline. Results JSON carries an `uplift` block
with **per-skill and per-eval** deltas (with-skill pass rate − no-skill pass
rate). A per-eval uplift `<= 0` means the skill didn't help — the eval is
tautological and buckets 2–5 use that signal to reject it.

## Trigger routing evals

Tests that the model routes a user query to the correct skill.

```bash
python evals/run_trigger.py                       # all routing evals
python evals/run_trigger.py --runs 3              # multi-run flakiness detection
python evals/run_trigger.py --filter switchroom-status
python evals/run_trigger.py --skills switchroom-cli,switchroom-status  # restrict roster
python evals/run_trigger.py --timeout 240
```

### Derived routable roster

The roster the router chooses from is **derived at runtime** by scanning
`skills/*/SKILL.md` frontmatter — every skill that ships a non-empty
`description` is offered (23 today), replacing the old 6-item hard-code. Any
skill a dataset entry names as gold or distractor that lacks a `SKILL.md` /
description is a **hard error (exit 2)**. `--skills` restricts the roster to an
allowlist (e.g. to reproduce a legacy run).

### The `none` route

The router prompt includes an explicit `none` abstain option, and a trigger
entry may set `expected_skill: "none"` to assert a query is deliberately
out-of-scope. A pick that lands on a declared `expected_not_skills` distractor
is reported as **WRONG_ROUTE** — a worse, distinct severity than a plain miss,
so distractors stay load-bearing.

> **Proxy-router disclaimer.** This harness measures a *forced-choice* routing
> proxy: it asks `claude -p` to pick the best skill from a listed roster. That
> is NOT how skills are invoked in production (Claude Code self-selects skills
> from their descriptions during a real session). Treat routing numbers as a
> relative signal on description quality, not a production accuracy figure.

## Output

Results are written to `evals/results/` as JSON with timestamp, git SHA, model,
the derived roster, per-eval pass/fail (with matched/missed terms or the routing
pick), and — for quality `--ablation` — the uplift block. Runner exceptions are
captured as failed rows with an `error` field, so **a results artifact always
exists** even when individual calls blow up. Exit code is `1` if any eval
fails, `2` on a config error (empty selection, unroutable dataset reference).

## Coverage gate

`validate_datasets.py --coverage` compares every `skills/*/` dir against the
covered set (`primary_skill` ∪ `expected_skill`). Skills that carry no evals
and no entry in `coverage-exempt.yaml` are reported. It ships two-phase:

- **Soft (default):** WARN on gaps, exit 0. This is CI's current mode while the
  office / writing / builder / release / runtime / testing families gain evals.
- **Hard (`--hard --base-ref origin/main`):** additionally FAIL when a
  *newly-added* skill dir ships with neither evals nor an exemption. Pre-existing
  gaps stay WARN so the flip doesn't retroactively break the fleet.

## Family-tag scheme

Beyond the routing tags, evals carry a **family** tag so buckets 2–5 can slice
coverage by domain:

| family    | skills |
|-----------|--------|
| `office`  | docx, pdf, pptx, xlsx |
| `writing` | humanizer, humanizer-calibrate, notion |
| `builder` | mcp-builder, skill-creator, file-bug |
| `release` | switchroom-release |
| `runtime` | switchroom-runtime, switchroom-cli, switchroom-status, switchroom-health, switchroom-manage, switchroom-install, switchroom-architecture |
| `testing` | webapp-testing, telegram-test-harness |

## Dataset files

- `dataset.yaml` — quality evals (58 across 5 skills today: switchroom-cli,
  -install, -status, -health, -architecture).
- `trigger_dataset.yaml` — routing evals (43 across 6 skills today, adding
  switchroom-manage over the quality set).
- `coverage-exempt.yaml` — skills intentionally excused from the coverage gate.
