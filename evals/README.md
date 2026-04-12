# Clerk Skills Eval Framework

Evaluates Claude Code custom skills for quality and routing correctness.

## Setup

```bash
pip install pyyaml
```

## Quality evals

Tests that each skill produces the right kind of response.

```bash
# Run all quality evals
python evals/run_quality.py

# Filter by skill
python evals/run_quality.py --filter clerk-status

# Run with ablation (compare with and without skill content)
python evals/run_quality.py --ablation

# Parallel execution
python evals/run_quality.py --parallel 10

# Different model
python evals/run_quality.py --model claude-opus-4-5
```

## Trigger routing evals

Tests that the model routes user queries to the correct skill.

```bash
# Run all routing evals
python evals/run_trigger.py

# Multi-run flakiness detection (3 runs per eval)
python evals/run_trigger.py --runs 3

# Filter by skill
python evals/run_trigger.py --filter clerk-status
```

## Output

Results are written to `evals/results/` as JSON files with:
- Timestamp and git SHA
- Per-eval pass/fail with matched/missed terms
- Model used

Exit code is `1` if any evals fail.

## Dataset files

- `dataset.yaml` — quality evals (~50 evals across 8 skills)
- `trigger_dataset.yaml` — routing evals (~30 near-miss scenarios)
