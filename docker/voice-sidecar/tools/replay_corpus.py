#!/usr/bin/env python3
"""Replay a captured TTS corpus through Stage B and report what changes.

A unit test proves a rule does what it says; only a replay tells you what a
rule does to REAL traffic — how many messages it touches, and whether every
change is an improvement. Run this before shipping a rule change:

    python3 tools/replay_corpus.py /path/to/corpus.json --sample 40

The corpus is NOT in this repo on purpose: production message text carries
personal data (names, numbers, private context). Point this at a capture on
the host, review the diff, and keep the capture out of git.

Input: a JSON list of objects with a `text` field (the /tts request body as
captured), or a JSON list of strings. Output: counts, the properties that
must hold over the whole corpus, and a sample of before/after pairs.

Exit code is 1 if any invariant fails (a digit glued to a letter, a leaked
private-use codepoint, or a non-idempotent rewrite), so this is usable as a
gate, not just a report.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import text_normalize as tn  # noqa: E402

DIGIT_LETTER = re.compile(r"\d[A-Za-z]")
# The invariant is that Stage B may not CREATE a digit-glued-to-letter token
# (contract 2 in text_normalize.py). Leaving one it has no rule for ("2048px",
# "19T") is honest — the phonemizer handles those no worse than before — so
# the gate compares whole tokens, not raw matches.
DL_TOKEN = re.compile(r"[\w.]*\d[A-Za-z][\w.]*")


def load(path: str) -> list[str]:
    with open(path, "r", encoding="utf-8") as fh:
        doc = json.load(fh)
    out: list[str] = []
    for row in doc:
        if isinstance(row, str):
            out.append(row)
        elif isinstance(row, dict) and isinstance(row.get("text"), str):
            out.append(row["text"])
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("corpus", help="path to the captured corpus JSON")
    ap.add_argument("--sample", type=int, default=25, help="changed samples to print")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--grep", default=None, help="only show diffs matching this regex")
    args = ap.parse_args()

    texts = load(args.corpus)
    if not texts:
        print(f"no usable rows in {args.corpus}", file=sys.stderr)
        return 2

    changed: list[tuple[str, str]] = []
    digit_letter_in: int = 0
    digit_letter_out: int = 0
    failures: list[str] = []

    for text in texts:
        out = tn.normalize(text)
        if DIGIT_LETTER.search(text):
            digit_letter_in += 1
        if DIGIT_LETTER.search(out):
            digit_letter_out += 1
        before_tokens = set(DL_TOKEN.findall(text))
        for token in DL_TOKEN.findall(out):
            if token not in before_tokens:
                failures.append(f"Stage B created {token!r} in: {out[:140]!r}")
        if any(0xE000 <= ord(c) <= 0xF8FF for c in out):
            failures.append(f"private-use codepoint leaked: {out[:160]!r}")
        if tn.SPAN_OPEN not in text and tn.SPAN_CLOSE not in text:
            if tn.normalize(out) != out:
                failures.append(f"not idempotent: {text[:120]!r}")
        if out != text:
            changed.append((text, out))

    print(f"corpus:            {len(texts)} messages")
    print(f"changed by Stage B:{len(changed):>6} ({100.0 * len(changed) / len(texts):.1f}%)")
    print(f"digit+letter in:   {digit_letter_in} messages")
    print(f"digit+letter out:  {digit_letter_out} messages (carried through, not created)")
    print(f"invariant failures:{len(failures):>6}")
    for line in failures[:20]:
        print("  FAIL", line)

    pattern = re.compile(args.grep) if args.grep else None
    pool = [c for c in changed if not pattern or pattern.search(c[0]) or pattern.search(c[1])]
    random.Random(args.seed).shuffle(pool)
    print(f"\n--- {min(args.sample, len(pool))} sampled changes (of {len(pool)}) ---")
    for before, after in pool[: args.sample]:
        for b, a in zip(before.split("\n"), after.split("\n")):
            if b != a:
                print(f"  - {b[:200]}")
                print(f"  + {a[:200]}")
                break
        else:
            print(f"  - {before[:200]}")
            print(f"  + {after[:200]}")
        print()

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
