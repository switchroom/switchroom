# Sub-agent volume-gate recalibration — #3994

## What changed

`subagent_retain.py`'s volume gate decides whether a terminating sub-agent's
sidechain window is worth an LLM-backed retain. Its char floor
(`MIN_NON_TOOL_RESULT_CHARS = 2000`) used to be measured by a metric
(`non_tool_result_char_count`) that summed assistant/user **text** PLUS every
`tool_use` block's `name` + serialized `input`.

But the sidechain retain runs on the **text-only** path (`retainToolCalls =
False`), so `tool_use` inputs are **not** in the stored payload. The gate and
the payload measured different things: a tool-heavy / prose-light fork could
clear the gate on tool-command volume and then retain a near-empty document.

The gate now counts exactly what the text-only path keeps, via
`retained_text_char_count` → `lib.content._extract_text_content` (assistant
`text` blocks, channel-message tool_use text, plain-string user turns). Gate and
payload now measure the identical char set.

## Re-measuring the 2,000-char floor

Because the metric shrank (it no longer counts tool chars), the floor had to be
re-measured against the corrected count — not carried over blind.

**Replay harness:** `scripts/tests/data/replay_volume_gate_3994.py`
(re-runnable; `--dir <path>` replays real `*.jsonl` sidechain transcripts,
default is a deterministic synthetic corpus parameterized by the empirical
distributions already measured and cited in the code).

**Data source note.** Fleet sidechain transcripts are private agent memory and
are not committed to this repo, so the committed run uses the
distribution-parameterized synthetic corpus (seed 1994): 120 real workers drawn
across the measured klanker text-only size range (p10 5,035 / p50 10,058 / p90
26,040; 0 empty / 0 < 500 over 200 real transcripts — see
`test_subagent_retain_learnings.py::TextOnlyPathIsNotEmpty`), 60 trivial 10-second
forks, and 40 tool-heavy / prose-light forks (the exact shape this change exists
to reject). An operator re-runs it against ground truth with `--dir`.

## Result (committed run, `python3 scripts/tests/data/replay_volume_gate_3994.py --json`)

| metric | value |
|---|---|
| corpus | 220 transcripts (120 real / 60 trivial / 40 tool-heavy-prose-light) |
| old gate passed but actual payload < 500 chars | **40** |
| new gate passed but actual payload < 500 chars | **0** |
| gate-passers' payload size (new, floor 2000) | min 5,591 / p10 8,293 / p50 13,968 / p90 24,672 |

Floor sweep (real workers newly skipped vs. the old 2000 gate ; empty-ish forks
now correctly skipped):

| floor | real workers newly skipped | empty-ish forks now skipped |
|---|---|---|
| 500  | 0 | 40 |
| 1000 | 0 | 40 |
| 1500 | 0 | 40 |
| **2000** | **0** | **40** |
| 3000 | 0 | 40 |
| 5000 | **2** | 40 |

## Decision: keep the floor at 2,000

The two populations separate cleanly under the corrected metric. Every
gate-passer has a text-only payload of **≥ 5,591 chars** (p10 8,293) — real
workers cluster an order of magnitude above the floor — while the entire
trivial / tool-heavy-prose-light fork population falls below it. Any floor in
`[500, 3000]` yields the same decision on this corpus, so 2,000 is not a knife
edge: it sits in the wide flat middle. Pushing to 5,000 begins clipping genuine
short-but-real workers (2 lost), so 2,000 stays as the conservative,
well-separated choice.

The headline win: **40 forks the old gate passed to a near-empty (< 500 char)
retain are now correctly skipped, and zero real workers are lost.**

## Guarding tests

- `test_subagent_retain.py::VolumeGate::test_tool_heavy_prose_light_fork_now_skips`
  — a tool-heavy / prose-light fork that PASSED the old gate now FAILS (RED if
  the metric reverts to counting `tool_use` inputs).
- `test_subagent_retain.py::VolumeGate::test_char_count_is_text_only`
  — `retained_text_char_count` counts only `_extract_text_content` chars.
- `test_subagent_retain_learnings.py::ProseFreeSidechainIsSkipped`
  — the prose-free degenerate case is now SKIPPED by the gate (the retain path's
  own guarantee that gate-passers always carry retainable prose).
