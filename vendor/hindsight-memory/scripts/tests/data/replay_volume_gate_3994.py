#!/usr/bin/env python3
"""Replay harness for the #3994 sub-agent volume-gate recalibration.

WHAT THIS ANSWERS
-----------------
The sidechain retain now counts, in its volume gate, ONLY the chars the
text-only retain path keeps (``subagent_retain.retained_text_char_count`` ->
``lib.content._extract_text_content``). The previous gate summed text PLUS
``tool_use`` name+input serialized size — chars the payload no longer contains.
This harness re-measures the ``MIN_NON_TOOL_RESULT_CHARS`` floor against the
CORRECTED metric and shows, per transcript:

  * old_metric   — pre-#3994 count (text + tool_use name+input)
  * new_metric   — post-#3994 count (text-only, == what is retained)
  * payload_chars— the ACTUAL text-only formatted payload size
                   (``prepare_retention_transcript(..., include_tool_calls=False)``)
  * human_turns  — genuine human turns (``count_human_turns``)
  * gate decision at a swept set of candidate floors, old vs new

The headline the recalibration turns on: how many tool-heavy / prose-light
forks the OLD gate wrongly PASSED (clearing on tool volume) that the NEW gate
correctly SKIPS, while NO real worker (substantial text-only payload) is newly
skipped at the chosen floor.

DATA
----
Two sources, ``--dir`` preferred:

  * ``--dir <path>``: replay real ``*.jsonl`` sidechain transcripts (one Claude
    Code sidechain per file). Fleet transcripts are NOT committed to this repo
    (they are private agent memory), so this is how an operator re-runs the
    measurement against ground truth.
  * default (no ``--dir``): a SYNTHETIC corpus parameterized by the empirical
    distributions already measured and cited in ``subagent_retain.py`` /
    ``test_subagent_retain_learnings.py`` — real klanker sidechain text-only
    sizes (p10 5,035 / p50 10,058 / p90 26,040 chars; 0 empty, 0 < 500 over 200
    transcripts) plus the trivial-fork and tool-heavy/prose-light shapes the
    gate exists to reject. Deterministic (fixed seed) so the committed report is
    reproducible.

Run:  python3 scripts/tests/data/replay_volume_gate_3994.py [--dir DIR] [--json]

The committed narrative report lives at
``docs/measurements/subagent-volume-gate-3994.md`` and is regenerated from this
harness's output.
"""

import argparse
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS_DIR = os.path.abspath(os.path.join(HERE, "..", ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import subagent_retain  # noqa: E402
from lib.content import (  # noqa: E402
    _extract_message_blocks,
    prepare_retention_transcript,
)

CANDIDATE_FLOORS = [500, 1000, 1500, 2000, 3000, 5000]
SHIPPED_FLOOR = subagent_retain.MIN_NON_TOOL_RESULT_CHARS  # 2000
MIN_TURNS = subagent_retain.MIN_HUMAN_TURNS  # 6

# A payload this size or larger is a "real worker" whose learnings we must not
# lose. Set well under the measured klanker p10 (5,035) so the "newly skipped
# real worker" check is strict, not self-serving.
REAL_WORKER_PAYLOAD_FLOOR = 2000


def _old_metric(messages):
    """Pre-#3994 count: text + tool_use name+input serialized size."""
    total = 0
    for m in messages:
        if not isinstance(m, dict):
            continue
        for b in _extract_message_blocks(m.get("content", ""), role=m.get("role", "")):
            if not isinstance(b, dict) or b.get("type") == "tool_result":
                continue
            if b.get("type") == "text":
                total += len(b.get("text", ""))
            elif b.get("type") == "tool_use":
                total += len(b.get("name", "")) + len(
                    json.dumps(b.get("input", {}), ensure_ascii=False)
                )
    return total


def _payload_chars(messages):
    """Actual text-only formatted payload size (what is retained)."""
    text, _ = prepare_retention_transcript(
        messages, ["user", "assistant"], True, include_tool_calls=False
    )
    return len(text or "")


def measure(messages):
    new_metric = subagent_retain.retained_text_char_count(messages)
    return {
        "human_turns": subagent_retain.count_human_turns(messages),
        "old_metric": _old_metric(messages),
        "new_metric": new_metric,
        "payload_chars": _payload_chars(messages),
    }


# ---------------------------------------------------------------------------
# Synthetic corpus (deterministic) — models the documented distributions.
# ---------------------------------------------------------------------------

def _user(text):
    return {"role": "user", "content": text}


def _assistant_prose(text, *, tool_bulk=0):
    content = [{"type": "text", "text": text}]
    if tool_bulk:
        content.append(
            {"type": "tool_use", "name": "Bash",
             "input": {"command": "grep -rn x " + ("q" * tool_bulk)}}
        )
    return {"role": "assistant", "content": content}


def _tool_result_user(bulk):
    return {"role": "user",
            "content": [{"type": "tool_result", "tool_use_id": "t", "content": "Z" * bulk}]}


def _real_worker(target_text_chars, rng):
    """A genuine worker: 6-14 human turns, prose totalling ~target text chars,
    interleaved with heavy tool traffic (the payload drops the tool traffic)."""
    turns = rng.randint(6, 14)
    per = max(80, target_text_chars // turns)
    msgs = []
    for i in range(turns):
        msgs.append(_user(f"step {i}: continue the investigation and report findings"))
        prose = (f"Finding {i}: confirmed the guard only probes observation rows; "
                 "world/experience facts never traverse the semantic dedup path. ")
        prose = (prose * ((per // len(prose)) + 1))[:per]
        msgs.append(_assistant_prose(prose, tool_bulk=rng.randint(2000, 8000)))
        msgs.append(_tool_result_user(rng.randint(2000, 6000)))
    return msgs


def _trivial_fork(rng):
    """A 10-second fork: 2-4 turns, almost no prose. Both gates should SKIP."""
    turns = rng.randint(2, 4)
    msgs = []
    for i in range(turns):
        msgs.append(_user("go"))
        msgs.append(_assistant_prose("ok", tool_bulk=rng.randint(0, 500)))
    return msgs


def _tool_heavy_prose_light(rng):
    """The recalibration target: clears MIN_TURNS human turns and emits a LOT of
    tool traffic, but almost NO retainable prose. OLD gate passes (tool chars),
    NEW gate skips (text-only ~0). Retaining it stores a near-empty document."""
    turns = rng.randint(6, 10)
    msgs = []
    for i in range(turns):
        msgs.append(_user("go"))  # genuine human turn, but tiny
        # No text block at all — pure tool_use with a large command body.
        msgs.append({"role": "assistant",
                     "content": [{"type": "tool_use", "name": "Bash",
                                  "input": {"command": "true " + ("x" * rng.randint(3000, 9000))}}]})
        msgs.append(_tool_result_user(rng.randint(3000, 8000)))
    return msgs


def synthetic_corpus(seed=1994):
    rng = random.Random(seed)
    corpus = []
    # Real workers across the measured size range (p10..p90+).
    for _ in range(120):
        target = int(rng.triangular(1500, 30000, 10058))  # low, high, mode≈p50
        corpus.append(("real_worker", _real_worker(target, rng)))
    for _ in range(60):
        corpus.append(("trivial_fork", _trivial_fork(rng)))
    for _ in range(40):
        corpus.append(("tool_heavy_prose_light", _tool_heavy_prose_light(rng)))
    return corpus


def _load_dir(path):
    corpus = []
    for name in sorted(os.listdir(path)):
        if not name.endswith(".jsonl"):
            continue
        msgs = subagent_retain.read_transcript(os.path.join(path, name))
        corpus.append((name, msgs))
    return corpus


def run(corpus):
    rows = []
    for label, msgs in corpus:
        m = measure(msgs)
        m["label"] = label
        rows.append(m)

    def gate(row, floor):
        return row["human_turns"] >= MIN_TURNS and row["new_metric"] >= floor

    def old_gate(row, floor):
        return row["human_turns"] >= MIN_TURNS and row["old_metric"] >= floor

    real = [r for r in rows if r["payload_chars"] >= REAL_WORKER_PAYLOAD_FLOOR]
    empty_ish = [r for r in rows if r["payload_chars"] < 500]

    floor_sweep = {}
    for f in CANDIDATE_FLOORS:
        newly_skipped_real = [
            r for r in real if old_gate(r, SHIPPED_FLOOR) and not gate(r, f)
        ]
        # Tool-heavy/prose-light forks the OLD gate passed that NEW gate skips.
        old_pass_new_skip_emptyish = [
            r for r in empty_ish if old_gate(r, SHIPPED_FLOOR) and not gate(r, f)
        ]
        floor_sweep[f] = {
            "passes_new": sum(1 for r in rows if gate(r, f)),
            "real_workers_newly_skipped_vs_old_2000": len(newly_skipped_real),
            "emptyish_forks_now_correctly_skipped": len(old_pass_new_skip_emptyish),
        }

    summary = {
        "corpus_size": len(rows),
        "shipped_floor": SHIPPED_FLOOR,
        "min_turns": MIN_TURNS,
        "counts_by_label": _counts(rows),
        "payload_percentiles_all": _pcts([r["payload_chars"] for r in rows]),
        "payload_percentiles_gate_passers_new_2000": _pcts(
            [r["payload_chars"] for r in rows if gate(r, SHIPPED_FLOOR)]
        ),
        "old_gate_passed_but_payload_under_500": sum(
            1 for r in rows if old_gate(r, SHIPPED_FLOOR) and r["payload_chars"] < 500
        ),
        "new_gate_passed_but_payload_under_500": sum(
            1 for r in rows if gate(r, SHIPPED_FLOOR) and r["payload_chars"] < 500
        ),
        "floor_sweep": floor_sweep,
    }
    return summary, rows


def _counts(rows):
    out = {}
    for r in rows:
        out[r["label"]] = out.get(r["label"], 0) + 1
    return out


def _pcts(values):
    if not values:
        return {}
    s = sorted(values)

    def p(q):
        return s[min(len(s) - 1, int(q * len(s)))]

    return {"n": len(s), "min": s[0], "p10": p(0.10), "p50": p(0.50),
            "p90": p(0.90), "max": s[-1]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", help="directory of real *.jsonl sidechain transcripts")
    ap.add_argument("--json", action="store_true", help="emit JSON only")
    args = ap.parse_args()

    if args.dir:
        corpus = _load_dir(args.dir)
        source = f"real transcripts from {args.dir}"
    else:
        corpus = synthetic_corpus()
        source = "synthetic corpus (distribution-parameterized, seed=1994)"

    summary, _ = run(corpus)
    summary["data_source"] = source

    if args.json:
        print(json.dumps(summary, indent=2))
        return

    print(f"# Volume-gate recalibration replay (#3994)\nsource: {source}\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
