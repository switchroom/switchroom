"""``pending.is_permanent_failure`` — the gate on retiring a memory.

Lives under ``scripts/tests/`` because that is the only python test
directory CI discovers (``ci-tests-python.yml`` runs ``python3 -m unittest
discover tests/`` with ``working-directory: vendor/hindsight-memory/scripts``).

The rule under test is asymmetric on purpose. Misclassifying a permanent
failure as retryable costs a re-POST (an upsert — time). Misclassifying a
transient failure as permanent costs the user's memory. So only a positively
identified client-side 4xx is permanent; everything else, including anything
unrecognised, is retryable.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.pending import is_permanent_failure  # noqa: E402


def _http(code, body=""):
    """The shape ``client.HindsightClient._request`` raises."""
    return RuntimeError(f"HTTP {code} from http://hindsight/v1/x: {body}")


class TestIsPermanentFailure(unittest.TestCase):
    def test_client_errors_are_permanent(self):
        for code in (400, 401, 403, 404, 409, 413, 422):
            with self.subTest(code=code):
                self.assertTrue(is_permanent_failure(_http(code)))

    def test_transient_4xx_are_not_permanent(self):
        """408/425/429 wear a 4xx status but describe a transient state."""
        for code in (408, 425, 429):
            with self.subTest(code=code):
                self.assertFalse(is_permanent_failure(_http(code)))

    def test_server_errors_are_retryable(self):
        for code in (500, 502, 503, 504):
            with self.subTest(code=code):
                self.assertFalse(is_permanent_failure(_http(code)))

    def test_extraction_failure_500_is_retryable(self):
        """The measured dominant failure (2026-07-26 fleet backlog).

        Both observed variants are one bad sampling run, not bad content:
        an empty completion, and a numbered prose list where JSON was asked
        for. Neither is evidence the memory can never be persisted.
        """
        empty = _http(
            500,
            '{"detail":"Fact extraction failed: 1/1 chunks failed. First '
            'failures: chunk 0: JSONDecodeError: Expecting value: line 1 '
            'column 1 (char 0)"}',
        )
        prose = _http(
            500,
            '{"detail":"Fact extraction failed: 1/1 chunks failed. First '
            'failures: chunk 0: JSONDecodeError: Extra data: line 1 column 2 '
            '(char 1)"}',
        )
        self.assertFalse(is_permanent_failure(empty))
        self.assertFalse(is_permanent_failure(prose))

    def test_transport_failures_are_retryable(self):
        for err in (
            TimeoutError("timed out"),
            ConnectionError("connection reset"),
            OSError("network unreachable"),
        ):
            with self.subTest(err=type(err).__name__):
                self.assertFalse(is_permanent_failure(err))

    def test_unclassifiable_error_is_retryable(self):
        """The fail-safe direction: unknown means keep the memory."""
        self.assertFalse(is_permanent_failure(RuntimeError("something odd")))
        self.assertFalse(is_permanent_failure(RuntimeError("HTTP  from x")))
        self.assertFalse(is_permanent_failure(RuntimeError("HTTP notanumber")))

    def test_status_read_from_a_chained_cause(self):
        """A live ``urllib.error.HTTPError`` chained on ``__cause__``."""

        class _FakeHTTPError(Exception):
            code = 404

        wrapped = RuntimeError("upstream rejected the retain")
        wrapped.__cause__ = _FakeHTTPError()
        self.assertTrue(is_permanent_failure(wrapped))

        wrapped5xx = RuntimeError("upstream blew up")
        cause = _FakeHTTPError()
        cause.code = 503
        wrapped5xx.__cause__ = cause
        self.assertFalse(is_permanent_failure(wrapped5xx))

    def test_direct_code_attribute_wins(self):
        err = OSError("boom")
        err.code = 400
        self.assertTrue(is_permanent_failure(err))


if __name__ == "__main__":
    unittest.main()
