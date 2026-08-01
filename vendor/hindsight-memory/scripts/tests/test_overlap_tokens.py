"""Characterisation of ``recall._overlap_tokens`` — the transcript-fallback tokenizer.

WHY THIS FILE EXISTS
--------------------
``_overlap_tokens`` is the keyword tokenizer behind the #3369 transcript-grep
recall fallback: a recent transcript turn is injected only if its token set
intersects the query's (``recall._build_transcript_fallback``). When the
lexical-overlap recall GATE was removed (#3761, commit e3b9d62f) the gate's
characterisation tests went with it — but ``_overlap_tokens`` itself stayed
load-bearing for the fallback. That left a real, shipped tokenizer with no
direct unit coverage: a change to its rules (letters-only vs alphanumeric, the
length floor, stopword handling) could silently move which transcript turns
recall can surface, and nothing would fail.

These tests pin the tokenizer's contract directly (#3777), including the #3578
decision that DIGITS CARRY SIGNAL (issue numbers, ports, versions). They assert
OUTCOMES of the tokenizer, not code paths, and each would fail on a real
regression of the documented behaviour.

Stdlib-only; runs under ``python3 -m unittest discover tests/``.
"""

import os
import sys
import unittest

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import recall  # noqa: E402

tok = recall._overlap_tokens


class OverlapTokensCharacterisation(unittest.TestCase):
    """Pure-function contract for ``recall._overlap_tokens`` (#3777)."""

    # --- empty / non-string inputs -------------------------------------------

    def test_empty_string_is_empty_set(self):
        self.assertEqual(tok(""), set())

    def test_none_is_empty_set(self):
        self.assertEqual(tok(None), set())

    def test_non_string_scalar_is_empty_set(self):
        self.assertEqual(tok(123), set())

    def test_non_string_container_is_empty_set(self):
        self.assertEqual(tok(["deploy", "server"]), set())
        self.assertEqual(tok({"deploy": 1}), set())

    def test_whitespace_only_is_empty_set(self):
        self.assertEqual(tok("   \t\n "), set())

    # --- basic tokenisation ---------------------------------------------------

    def test_simple_words_split_on_whitespace(self):
        self.assertEqual(tok("deploy staging server"), {"deploy", "staging", "server"})

    def test_lowercased(self):
        self.assertEqual(tok("Deploy STAGING Server"), {"deploy", "staging", "server"})

    def test_case_folds_to_a_single_token(self):
        self.assertEqual(tok("DEPLOY deploy Deploy"), {"deploy"})

    def test_duplicates_collapse_to_a_set(self):
        self.assertEqual(tok("server server server"), {"server"})

    def test_trailing_token_without_separator_is_flushed(self):
        # The final run has no trailing delimiter; it must still be emitted.
        self.assertEqual(tok("deploy server"), {"deploy", "server"})

    # --- punctuation as separators -------------------------------------------

    def test_punctuation_is_a_separator(self):
        self.assertEqual(tok("deploy, the staging server!"), {"deploy", "staging", "server"})

    def test_hyphen_splits_tokens(self):
        self.assertEqual(tok("multi-word thing"), {"multi", "word", "thing"})

    def test_underscore_splits_tokens(self):
        # '_' is not alphanumeric, so it is a separator (documented behaviour).
        self.assertEqual(tok("foo_bar baz"), {"foo", "bar", "baz"})

    def test_dotted_version_splits_on_dots(self):
        self.assertEqual(tok("v0.19.24"), {"v0", "19", "24"})

    # --- length floor ---------------------------------------------------------

    def test_single_alpha_char_is_dropped(self):
        self.assertEqual(tok("x y z deploy"), {"deploy"})

    def test_single_digit_char_is_dropped_as_noise(self):
        # A lone digit is noise, not an identifier — dropped by the > 1 guard,
        # exactly like a lone letter.
        self.assertEqual(tok("python 9 angular"), {"python", "angular"})

    def test_two_char_token_survives_the_floor(self):
        self.assertEqual(tok("pr go"), {"pr", "go"})

    # --- stopwords ------------------------------------------------------------

    def test_stopwords_removed(self):
        self.assertEqual(tok("the is a to of"), set())

    def test_content_survives_with_stopwords_present(self):
        self.assertEqual(tok("what is the deploy status"), {"deploy", "status"})

    # --- #3578: digits carry signal ------------------------------------------

    def test_pure_digit_issue_number_is_a_token(self):
        self.assertEqual(tok("PR 3993"), {"pr", "3993"})

    def test_hash_prefixed_issue_number_keeps_the_digits(self):
        self.assertEqual(tok("#3541 shipped"), {"3541", "shipped"})

    def test_colon_prefixed_port_keeps_the_digits(self):
        self.assertEqual(tok(":9077 port"), {"9077", "port"})

    def test_mixed_alphanumeric_run_stays_intact(self):
        self.assertEqual(tok("abc123def"), {"abc123def"})

    def test_identifier_overlap_between_query_and_transcript(self):
        # The #3578 motivating case: a transcript turn whose only tie to the
        # query is an issue number must now share a token (it did not before).
        query = tok("did PR 3993 land and what did v0.19.24 change")
        turn = tok("3993 shipped in 0.19.24 last night")
        self.assertIn("3993", query & turn)
        self.assertTrue(query & turn)


if __name__ == "__main__":
    unittest.main()
