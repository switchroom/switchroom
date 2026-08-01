"""Switchroom #3757 — the recall hook must not put an unbounded BM25 query on
the wire, and the per-bank timeout must be configurable.

The bug: recall.py composed a query from the last 2 turns (up to
``recallMaxQueryChars`` = 800 chars, ~110 tokens) and Hindsight OR-joined every
token into one ``to_tsquery``. Postgres native FTS cannot top-k from the GIN
index, so it ranked the whole matched set before the top-60 heapsort. Measured
on the live ``overlord`` bank (135,565 memory_units, 3 fact-type arms):

    as shipped                 96 terms   119,510 rows ranked   14.0 s
    role labels/header removed 93 terms    86,653 rows ranked   11.8 s
    + capped to 24 terms       24 terms    48,433 rows ranked    2.7 s

(`exec` is the best of three EXPLAIN ANALYZE runs on a live, loaded host; the
unshaped query ranged 14.0-94.1 s across those runs while the shaped one held
2.54-2.76 s, so the cap removes the variance as well as the mean.)

Two of the tokens were scaffolding the hook added itself — ``user`` matched
67,363 rows (50% of the bank) and ``assistant`` 29,942 (22%). The 8s hardcoded
client timeout then fired on 96.8% of that agent's own-bank recalls, so the
model got zero memories on ~3 turns in 4.

Acceptance guarantees (outcomes, not code paths):

  1. **The query on the wire is term-capped.** Whatever the composed query, the
     string passed to ``client.recall`` tokenizes to at most
     ``recallQueryMaxTokens`` distinct BM25 terms.

  2. **Role labels never reach the wire.** ``user`` / ``assistant`` are absent
     from the wire query's tokens even when the composed context contains both
     roles.

  3. **The cap is configurable, not hardcoded** — including ``0`` to disable
     shaping entirely (the rollback lever).

  4. **The per-bank timeout is configurable** and defaults to 12s, not the old
     hardcoded 8.

  5. **Shaping does not leak into the client-side lexical gate.** The
     ``recallMinOverlap`` containment gate keeps measuring against the user's
     real words, so this change cannot silently move an operator's threshold.

Stdlib-only (unittest); runs under ``python3 -m unittest discover tests/``
from ``scripts/``.
"""

import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import recall  # noqa: E402
from lib.content import (  # noqa: E402
    BM25_STOPWORDS,
    _selectivity_score,
    common_english_words,
    shape_recall_query,
    tokenize_for_bm25,
)

# A prior turn plus a latest turn, together well past the term budget. Written
# as real prose because the point is a production-shaped query, not a synthetic
# token soup.
PRIOR_USER = (
    "the v0.19.24 rollout went out this morning and the reaper never swept the "
    "orphaned worktrees on the build host, which left eleven stale claims behind"
)
PRIOR_ASSISTANT = (
    "I compared the published manifest digest against what the agent container "
    "actually pulled and they diverge, so the restart raced the tag and the "
    "container is running the previous image entirely"
)
LATEST = (
    "why did recall for the v0.19.24 rollout return v0.18.15 instead of the "
    "release notes from this morning"
)


def _nested_line(role, text):
    return json.dumps({
        "type": role,
        "uuid": f"u-{abs(hash((role, text))) % 10_000_000}",
        "message": {"role": role, "content": text},
    })


class _Client:
    """Fake HindsightClient that records exactly what went on the wire."""

    def __init__(self, results=None):
        self._results = results or []
        self.calls = []

    def list_directives(self, bank_id, active_only=True, timeout=2):
        return {"items": []}

    def recall(self, bank_id, query, **kwargs):
        self.calls.append({"bank_id": bank_id, "query": query, **kwargs})
        return {"results": [dict(r) for r in self._results]}


class _Harness(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="recall-shaping-test-")
        self._prev = os.environ.get("CLAUDE_PLUGIN_DATA")
        os.environ["CLAUDE_PLUGIN_DATA"] = self._tmpdir

    def tearDown(self):
        shutil.rmtree(self._tmpdir, ignore_errors=True)
        if self._prev is None:
            os.environ.pop("CLAUDE_PLUGIN_DATA", None)
        else:
            os.environ["CLAUDE_PLUGIN_DATA"] = self._prev

    def _write_transcript(self):
        path = os.path.join(self._tmpdir, "transcript.jsonl")
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join([
                _nested_line("user", PRIOR_USER),
                _nested_line("assistant", PRIOR_ASSISTANT),
                _nested_line("user", LATEST),
            ]) + "\n")
        return path

    def _run(self, client, config_extra=None, prompt=LATEST, with_transcript=True):
        hook_input = {
            "prompt": prompt,
            "session_id": "test-session",
            "transcript_path": self._write_transcript() if with_transcript else "",
            "cwd": "/tmp",
        }
        config = {
            "autoRecall": True,
            "bankId": "own-bank",
            "recallMaxTokens": 1024,
            "recallBudget": "low",
            # 2 turns is the fleet default and the shape that produced the bug.
            "recallContextTurns": 2,
            "recallMaxQueryChars": 800,
            "recallPromptPreamble": "",
            "recallParallelDeadlineSeconds": 5,
            "recallTranscriptFallback": False,
        }
        if config_extra:
            config.update(config_extra)
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(recall, "load_config", return_value=config), patch.object(
            recall, "get_api_url", return_value="http://localhost:18888"
        ), patch.object(recall, "HindsightClient", return_value=client), patch.object(
            recall, "ensure_bank_mission", return_value=None
        ), patch.object(recall, "write_state", return_value=None), patch(
            "sys.stdin", new=io.StringIO(json.dumps(hook_input))
        ), patch("sys.stdout", new=stdout), patch("sys.stderr", new=stderr):
            recall.main()
        raw = stdout.getvalue()
        context = None
        if raw.strip():
            context = json.loads(raw)["hookSpecificOutput"]["additionalContext"]
        return context

    def _wire_terms(self, client):
        self.assertTrue(client.calls, "recall never reached the client")
        return set(tokenize_for_bm25(client.calls[0]["query"]))


class WireQueryIsTermCapped(_Harness):
    def test_defaults_to_24_terms(self):
        client = _Client()
        self._run(client)
        self.assertLessEqual(len(self._wire_terms(client)), 24)

    def test_cap_is_configurable(self):
        for cap in (6, 12, 40):
            client = _Client()
            self._run(client, config_extra={"recallQueryMaxTokens": cap})
            self.assertLessEqual(
                len(self._wire_terms(client)), cap, f"cap={cap} not honoured"
            )

    def test_zero_disables_shaping(self):
        client = _Client()
        self._run(client, config_extra={"recallQueryMaxTokens": 0})
        # Rollback lever: the full composed query goes out unshaped.
        self.assertGreater(len(self._wire_terms(client)), 24)

    def test_latest_turn_survives_the_cap(self):
        # The cap must not cost the user the question they just asked.
        #
        # #3764: this deliberately asserts on ORDINARY English words from the
        # latest turn, not on `v0.19.24`. A version string carries a digit AND
        # is a compound, so it scores 6.0 before recency is considered and
        # survives under every candidate ordering — asserting on it cannot fail
        # on a recency regression. `recall` / `release` / `notes` score 0.0 on
        # shape and are outnumbered by prior-context terms, so they are in the
        # query only because recency is weighted.
        client = _Client()
        self._run(client, config_extra={"recallQueryMaxTokens": 24})
        terms = self._wire_terms(client)
        for word in ("recall", "release", "notes"):
            self.assertIn(word, terms, f"latest-turn term {word!r} lost to prior context")


class RecencyIsAWeightNotATier(_Harness):
    """#3760 review, Blocker 2. Making recency an ABSOLUTE tier meant any latest
    turn with >= max_tokens surviving terms took every slot, so a conversational
    follow-up whose subject lives only in the prior turn produced a query with
    no subject in it at all — a query about nothing, which BM25-matches a broad
    near-random slice of the bank and embeds to a near-meaningless vector."""

    # The reviewer's exact reproduction.
    SUBJECT_PRIOR = (
        "We were debugging the Coolify deploy for the webkite container and the "
        "nginx TLS cert."
    )
    SUBJECT_LATEST = (
        "Right, so continuing from where we left off, could you please have another "
        "careful look and tell me whether the thing we were discussing previously is "
        "actually still broken, because honestly the whole situation seems rather "
        "confusing and I would really appreciate a clear explanation of what exactly "
        "is happening underneath and whether anything changed recently."
    )

    def _write_transcript(self):
        path = os.path.join(self._tmpdir, "transcript.jsonl")
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join([
                _nested_line("user", self.SUBJECT_PRIOR),
                _nested_line("user", self.SUBJECT_LATEST),
            ]) + "\n")
        return path

    def test_subject_from_prior_turn_survives_a_long_latest_turn(self):
        client = _Client()
        self._run(client, prompt=self.SUBJECT_LATEST)
        terms = self._wire_terms(client)
        # The latest turn alone yields well over 24 content terms, so under the
        # old absolute tier every one of these was dropped.
        for word in ("coolify", "webkite", "nginx", "tls"):
            self.assertIn(word, terms, f"subject term {word!r} was crowded out")

    # A prior turn whose subject is ORDINARY ENGLISH — no identifier, no digit,
    # no compound. The recency weight alone cannot save it (every term scores
    # 0.0 against 1.5 for every latest-turn term), so only the reserve can. This
    # is the general form of Blocker 2: with `recallContextTurns: 2` shipped on,
    # any latest turn holding >= max_tokens terms took every slot.
    PLAIN_PRIOR = (
        "The landlord refused to return the bond after the final inspection and "
        "the tribunal hearing was adjourned."
    )

    def test_all_english_prior_turn_is_still_represented(self):
        path = os.path.join(self._tmpdir, "transcript.jsonl")
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join([
                _nested_line("user", self.PLAIN_PRIOR),
                _nested_line("user", self.SUBJECT_LATEST),
            ]) + "\n")
        self._write_transcript = lambda: path
        client = _Client()
        self._run(client, prompt=self.SUBJECT_LATEST)
        terms = self._wire_terms(client)
        prior_terms = set(tokenize_for_bm25(self.PLAIN_PRIOR)) & terms
        self.assertGreaterEqual(
            len(prior_terms),
            24 // 3,
            f"prior context was starved: only {sorted(prior_terms)} survived",
        )

    def test_reserve_scales_with_the_cap_and_never_starves_the_latest_turn(self):
        client = _Client()
        self._run(client, prompt=self.SUBJECT_LATEST, config_extra={"recallQueryMaxTokens": 24})
        terms = self._wire_terms(client)
        prior_terms = set(tokenize_for_bm25(self.SUBJECT_PRIOR)) & terms
        latest_terms = set(tokenize_for_bm25(self.SUBJECT_LATEST)) & terms
        # The reserve is a ceiling, not an allocation: prior context is
        # guaranteed representation but must not take the majority of slots.
        self.assertGreaterEqual(len(prior_terms), 4)
        self.assertGreater(len(latest_terms), len(prior_terms))

    # Two turns of ORDINARY English on both sides, the common conversational
    # case: every candidate scores 0.0 on shape, so neither reserve can decide
    # anything past its own third and the remaining budget is settled purely by
    # the recency weight. Drop `_SCORE_RECENCY` and the tie falls back to
    # `first_seen`, which orders by position in `Prior context: <old> … <new>`
    # — i.e. the STALEST turn wins the leftover budget and the tail of the
    # user's actual question is dropped. This is the fill stage, and it is where
    # recency-as-a-weight (rather than as a tier) does its work.
    FILL_PRIOR = (
        "The removalists arrived before the inspection finished so the landlord "
        "postponed the handover until the following afternoon and the neighbours "
        "complained about the noise in the stairwell again."
    )
    FILL_LATEST = (
        "Could you summarise whether the tribunal accepted the amended evidence "
        "bundle and confirm the hearing date they eventually settled on."
    )

    def test_leftover_budget_goes_to_the_latest_turn_on_equal_merit(self):
        path = os.path.join(self._tmpdir, "transcript.jsonl")
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join([
                _nested_line("user", self.FILL_PRIOR),
                _nested_line("user", self.FILL_LATEST),
            ]) + "\n")
        self._write_transcript = lambda: path
        client = _Client()
        self._run(client, prompt=self.FILL_LATEST, config_extra={"recallQueryMaxTokens": 24})
        terms = self._wire_terms(client)
        latest_terms = {
            t for t in tokenize_for_bm25(self.FILL_LATEST)
            if len(t) > 1 and t not in BM25_STOPWORDS
        }
        # The latest turn holds more terms than its own reserve (24 // 3 = 8),
        # so the surplus can only be here because the fill stage preferred it.
        self.assertGreater(len(latest_terms), 24 // 3)
        missing = sorted(latest_terms - terms)
        self.assertEqual(
            missing, [], f"the latest turn lost the leftover budget to stale context: {missing}"
        )


class SelectivityRewardsIdentifiersNotLongWords(_Harness):
    """#3760 review, Blocker 1. The previous revision scored `+min(len, 12)/4`,
    so `understanding` (3.0) and `configuration` (3.0) tied the maximum awarded
    to a compound or a digit while `pkce` (1.0) and `zod` (0.75) sat near the
    floor. Measured median `overlord` df by token length is flat-to-rising, so
    length predicts nothing; English-word membership does."""

    IDENTIFIER_LATEST = (
        "I have been thinking particularly carefully about this and essentially my "
        "understanding of the currently shipped configuration documentation basically "
        "describes something different from the implementation, so probably the "
        "important information here is that generally, additionally, previously "
        "mentioned considerations regarding authentication mechanisms suggest we "
        "should use PKCE rather than something else entirely"
    )

    def test_short_identifier_beats_long_common_english(self):
        client = _Client()
        self._run(
            client,
            prompt=self.IDENTIFIER_LATEST,
            with_transcript=False,
            config_extra={"recallContextTurns": 1, "recallQueryMaxTokens": 6},
        )
        terms = self._wire_terms(client)
        # Six slots for a 60-word turn. `pkce` is the last word of the sentence
        # and the shortest content token in it, so under the old length rule
        # (score 1.0, against 3.0 for every long abstract noun before it) it was
        # dropped. It must now take the first slot on merit.
        self.assertIn("pkce", terms, "the only identifier in the turn was dropped")
        # The long English words are DEMOTED, not dropped — with six slots and
        # nothing more selective competing, some of them legitimately fill the
        # remainder. What must not happen is any of them outranking `pkce`.
        for filler in ("understanding", "particularly", "configuration", "documentation"):
            self.assertLess(
                _selectivity_score(filler),
                _selectivity_score("pkce"),
                f"{filler!r} scores at or above an identifier",
            )

    def test_length_is_not_rewarded(self):
        # The regression this guards: `score += min(len(token), 12) / 4.0`.
        # Measured median `overlord` df by token length is flat-to-rising, so a
        # longer common word is not more selective than a shorter one.
        self.assertEqual(
            _selectivity_score("configuration"), _selectivity_score("thing")
        )
        # ...and the same holds for two identifiers of very different length.
        self.assertEqual(_selectivity_score("zod"), _selectivity_score("kubernetes"))

    def test_compound_shape_is_rewarded_on_top_of_rarity(self):
        # A path/version/module compound is worth MORE than a merely unknown
        # word, and the compound bonus is what supplies that. Measured on the
        # live `overlord` bank, `.`/`/`/`-` joined tokens are the second-most
        # reliable low-df shape after digits — and unlike a bare rare word the
        # server shreds a compound into its fragments too, so one kept compound
        # buys several matching surfaces. `docs/setup` and `wibbleton` are BOTH
        # absent from the dictionary, so the +2.0 rarity bonus cancels and only
        # the compound bonus can separate them.
        self.assertNotIn("docs/setup", common_english_words())
        self.assertNotIn("wibbleton", common_english_words())
        self.assertGreater(
            _selectivity_score("docs/setup"),
            _selectivity_score("wibbleton"),
            "a compound scores no better than an unknown bare word",
        )
        # And it must still beat a compound-shaped token's own fragments, which
        # are ordinary dictionary words on their own.
        self.assertGreater(_selectivity_score("docs/setup"), _selectivity_score("setup"))


class RoleLabelsNeverReachTheWire(_Harness):
    def test_user_and_assistant_are_not_bm25_terms(self):
        client = _Client()
        self._run(client)
        terms = self._wire_terms(client)
        # These two were 50% and 22% of the overlord bank's document frequency.
        self.assertNotIn("user", terms)
        self.assertNotIn("assistant", terms)
        # ...and the composed query's own section header.
        self.assertNotIn("prior", terms)
        self.assertNotIn("context", terms)

    def test_still_absent_with_shaping_disabled(self):
        # Fix at source: compose_recall_query no longer emits the labels, so
        # even the rollback lever cannot put them back on the wire.
        client = _Client()
        self._run(client, config_extra={"recallQueryMaxTokens": 0})
        terms = self._wire_terms(client)
        self.assertNotIn("user", terms)
        self.assertNotIn("assistant", terms)

    def test_prior_context_content_still_reaches_the_wire(self):
        # Dropping the labels must not drop the turns they labelled.
        client = _Client()
        self._run(client, config_extra={"recallQueryMaxTokens": 0})
        terms = self._wire_terms(client)
        self.assertIn("reaper", terms)
        self.assertIn("manifest", terms)


class PerBankTimeoutIsConfigurable(_Harness):
    def test_defaults_to_12_seconds(self):
        client = _Client()
        self._run(client)
        self.assertEqual(client.calls[0]["timeout"], 12.0)

    def test_honours_config(self):
        client = _Client()
        self._run(client, config_extra={"recallRequestTimeoutSeconds": 20})
        self.assertEqual(client.calls[0]["timeout"], 20.0)

    def test_invalid_value_falls_back_to_default(self):
        for bad in ("banana", None, 0, -3):
            client = _Client()
            self._run(client, config_extra={"recallRequestTimeoutSeconds": bad})
            self.assertEqual(client.calls[0]["timeout"], 12.0, f"bad={bad!r}")


class ShapingDoesNotMoveTheOverlapGate(_Harness):
    """The `recallMinOverlap` containment gate is |Q ∩ M| / |M|. If it measured
    against the SHAPED query, shrinking Q would shrink every memory's score and
    silently tighten every operator's configured threshold. It must keep
    measuring against the user's real words."""

    def test_memory_matching_only_stopwords_of_the_prompt(self):
        # "did we decide about the auth flow" — every shared term with the
        # memory below is a stopword that shaping removes. With the gate on the
        # UNSHAPED query the memory clears a 0.5 threshold; against the shaped
        # query it would score 0 and be dropped.
        memory = {"text": "did we decide about the", "type": "fact",
                  "mentioned_at": "2026-01-01", "id": "m1"}
        client = _Client(results=[memory])
        context = self._run(
            client,
            prompt="did we decide about the auth flow",
            with_transcript=False,
            config_extra={"recallMinOverlap": 0.5, "recallContextTurns": 1},
        )
        self.assertIsNotNone(context)
        self.assertIn("did we decide about the", context)


class SingleCharSubjectSurvives(unittest.TestCase):
    """#3766 — the ``len(t) > 1`` filter used to run BEFORE the stopword
    fallback, dropping a single-char SUBJECT ('C', 'R', a single-digit version)
    outright and then letting the fallback pick multi-char STOPWORDS instead. The
    length guard now lives only in the fallback, so a single-char content word
    survives while single-char stopwords ('a', 'i') are still removed.

    These call ``shape_recall_query`` directly — the shaped string is what the
    BM25 arm searches for, and a subject that vanishes from it is a subject the
    recall cannot match on. Each assertion fails if the length filter moves back
    ahead of the stopword filter.
    """

    def test_single_letter_subject_survives_among_stopwords(self):
        # 'r' is the only content word; all the rest are stopwords. Pre-fix it
        # was dropped and the fallback kept 'still'/'faster'/'python' but never
        # 'r'; post-fix 'r' is a first-class term.
        out = shape_recall_query("is R still faster than python", max_tokens=24)
        self.assertIn("r", out.lower().split())

    def test_subject_is_a_lone_single_char_and_all_else_stopwords(self):
        # "what about C for this" — every other token is a stopword. The subject
        # 'c' MUST be what searches; pre-fix the query came back as stopwords.
        out = shape_recall_query("what about C for this", max_tokens=24)
        terms = out.lower().split()
        self.assertIn("c", terms)
        for stop in ("what", "about", "for", "this"):
            self.assertNotIn(stop, terms, f"stopword {stop!r} reached the wire over the subject")

    def test_single_digit_version_survives(self):
        # 'single-digit versions' (#3766): "python 9 or python 3".
        out = shape_recall_query("python 9 or python 3", max_tokens=24)
        terms = out.lower().split()
        self.assertIn("9", terms)
        self.assertIn("3", terms)

    def test_single_char_stopwords_are_still_removed(self):
        # The guard must not become "keep every single char": 'a' and 'i' are
        # stopwords and must not survive just because they are one character.
        out = shape_recall_query("a deploy i triggered", max_tokens=24)
        terms = out.lower().split()
        self.assertIn("deploy", terms)
        self.assertIn("triggered", terms)
        self.assertNotIn("a", terms)
        self.assertNotIn("i", terms)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
