"""Direct coverage of ``HindsightClient.document_exists`` (#3599 review R3-B2).

Every drain test patches ``drain_pending._document_state``, so before this
file the tri-state itself — the thing the docstring calls "load-bearing and
must not be collapsed to a bool" — had ZERO executed lines and was asserted
only in prose. ``return False if e.code == 404 else None`` could be mutated
to a bare ``return True`` and both suites stayed green.

These run against a REAL local HTTP server rather than a mocked ``urllib``:
the branch under test is precisely the exception taxonomy urllib raises
(``HTTPError`` with a code vs ``URLError``/``socket.timeout``), and a mock
that hand-raises those proves the handler, not that urllib produces them.

The tri-state contract:
  * ``True``  — 200, the document is there;
  * ``False`` — 404, and ONLY 404. It is the sole answer that lets a caller
    re-POST (reconcile) or keep an entry queued for phase 2;
  * ``None``  — unknown: any 5xx, any transport error, any timeout.
    Collapsing this to ``True`` retires the last on-disk copy of a turn on
    a flaky GET (#3244 silent loss); collapsing it to ``False`` re-POSTs an
    already-durable document at full LLM extraction cost.
"""

import http.server
import os
import socket
import sys
import threading
import unittest
import unittest.mock

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from lib.client import HindsightClient  # noqa: E402

BANK = "bank-a"
DOC = "sess-1-rdoc-1"


class _Handler(http.server.BaseHTTPRequestHandler):
    #: set per-server instance; a callable (handler) -> None, or an int status
    behaviour = 200

    def do_GET(self):  # noqa: N802 — BaseHTTPRequestHandler API
        b = self.server.behaviour
        if callable(b):
            b(self)
            return
        self.send_response(b)
        self.send_header("Content-Type", "application/json")
        body = b'{"id": "%s"}' % DOC.encode() if b == 200 else b"{}"
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_a):  # silence the stderr access log
        pass


class _Server(http.server.HTTPServer):
    behaviour = 200


class DocumentExistsTriStateTest(unittest.TestCase):
    """200 → True, 404 → False, everything else → None."""

    def _serve(self, behaviour):
        srv = _Server(("127.0.0.1", 0), _Handler)
        srv.behaviour = behaviour
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        self.addCleanup(t.join, 5)
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        return HindsightClient(f"http://127.0.0.1:{srv.server_address[1]}")

    def test_200_is_true(self):
        c = self._serve(200)
        self.assertIs(c.document_exists(BANK, DOC, timeout=5), True)

    def test_404_is_false(self):
        """The ONLY negative. A 404 is the server stating the document is
        absent, which is the one answer that authorises a re-POST."""
        c = self._serve(404)
        self.assertIs(c.document_exists(BANK, DOC, timeout=5), False)

    def test_500_is_unknown(self):
        c = self._serve(500)
        self.assertIsNone(c.document_exists(BANK, DOC, timeout=5))

    def test_503_is_unknown(self):
        """The reviewer's live repro: a degraded upstream answering 503 must
        leave the entry queued, not retire it."""
        c = self._serve(503)
        self.assertIsNone(c.document_exists(BANK, DOC, timeout=5))

    def test_429_is_unknown(self):
        """Not every non-404 error is a 5xx; rate limiting says nothing
        about presence either."""
        c = self._serve(429)
        self.assertIsNone(c.document_exists(BANK, DOC, timeout=5))

    def test_timeout_is_unknown(self):
        """A hung server: urllib raises ``socket.timeout``/``URLError``,
        which is neither presence nor absence."""
        import time

        def hang(handler):
            time.sleep(3)
            try:
                handler.send_response(200)
                handler.end_headers()
            except OSError:
                pass

        c = self._serve(hang)
        self.assertIsNone(c.document_exists(BANK, DOC, timeout=1))

    def test_connection_refused_is_unknown(self):
        """Nothing listening at all — the daemon is down, not the document."""
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        c = HindsightClient(f"http://127.0.0.1:{port}")
        self.assertIsNone(c.document_exists(BANK, DOC, timeout=2))

    def test_malformed_body_on_200_is_still_true(self):
        """Presence is decided by the STATUS, not by parsing the body: a
        proxy that mangles the payload must not read as an absence."""

        def garbage(handler):
            handler.send_response(200)
            handler.send_header("Content-Length", "9")
            handler.end_headers()
            handler.wfile.write(b"not-json!")

        c = self._serve(garbage)
        self.assertIs(c.document_exists(BANK, DOC, timeout=5), True)


class DocumentExistsRequestShapeTest(unittest.TestCase):
    """The URL/method/auth the tri-state is derived from."""

    def test_gets_the_document_path_with_both_ids_url_encoded(self):
        seen = {}

        def capture(handler):
            seen["path"] = handler.path
            seen["auth"] = handler.headers.get("Authorization")
            seen["method"] = handler.command
            handler.send_response(200)
            handler.send_header("Content-Length", "2")
            handler.end_headers()
            handler.wfile.write(b"{}")

        srv = _Server(("127.0.0.1", 0), _Handler)
        srv.behaviour = capture
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        self.addCleanup(t.join, 5)
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)

        c = HindsightClient(f"http://127.0.0.1:{srv.server_address[1]}", "tok")
        self.assertIs(c.document_exists("bank/with slash", "doc id", timeout=5), True)
        self.assertEqual(seen["method"], "GET")
        self.assertEqual(
            seen["path"],
            "/v1/default/banks/bank%2Fwith%20slash/documents/doc%20id",
            "both ids must be fully quoted — an unescaped '/' would GET a "
            "different resource and the answer would be about that one",
        )
        self.assertEqual(seen["auth"], "Bearer tok")


class DocumentStateWrapperTest(unittest.TestCase):
    """``drain_pending._document_state`` — the wrapper every drain test
    patches away, and which was therefore never itself executed.

    It must preserve the tri-state end to end and swallow every exception
    into ``None``: it is called on the retire path, where a raised
    exception escaping into ``drain()``'s per-entry handler would be
    recorded as a POST failure and age the entry toward ``.dead``.
    """

    def _entry(self, **kw):
        e = {
            "api_url": "http://127.0.0.1:1/none",
            "api_token": None,
            "bank_id": BANK,
            "document_id": DOC,
        }
        e.update(kw)
        return e

    def test_forwards_the_client_tri_state_unchanged(self):
        import drain_pending

        for state in (True, False, None):
            with self.subTest(state=state):
                with unittest.mock.patch.object(
                    drain_pending.HindsightClient,
                    "document_exists",
                    lambda self, b, d, timeout=30: state,
                ):
                    self.assertIs(
                        drain_pending._document_state(self._entry()), state
                    )

    def test_missing_ids_are_unknown_not_absent(self):
        """No document_id / bank_id means we cannot ask. That is unknown —
        returning ``False`` would re-POST, ``True`` would retire blind."""
        import drain_pending

        self.assertIsNone(drain_pending._document_state(self._entry(document_id="")))
        self.assertIsNone(drain_pending._document_state(self._entry(bank_id=None)))

    def test_a_raising_client_is_unknown_not_a_crash(self):
        import drain_pending

        def boom(self, b, d, timeout=30):
            raise RuntimeError("upstream on fire")

        with unittest.mock.patch.object(
            drain_pending.HindsightClient, "document_exists", boom
        ):
            self.assertIsNone(drain_pending._document_state(self._entry()))

    def test_a_bad_api_url_is_unknown_not_a_crash(self):
        """``HindsightClient.__init__`` raises on a non-http scheme; an old
        queue entry with a junk url must not take the drain down."""
        import drain_pending

        self.assertIsNone(
            drain_pending._document_state(self._entry(api_url="ftp://nope/x"))
        )


class HealthCheckRetryBoundaryTest(unittest.TestCase):
    """``client.py``'s ``if attempt < retries`` sleep guard (#3599 R3-L3).

    Mutating it to ``<=`` survived the whole sweep: it costs one extra
    ``HEALTH_CHECK_DELAY`` sleep after the LAST attempt, for a result that
    is already decided. The SessionStart drain gate passes ``retries=1``
    precisely so a hung server costs ~one timeout and no delay at all; the
    mutant makes that path sleep 2s inside a 4s hook budget.
    """

    def _client(self, attempts_log, ok_after=None):
        c = HindsightClient("http://127.0.0.1:1/none")

        def fake_urlopen(req, timeout=None):
            attempts_log.append(timeout)
            if ok_after is not None and len(attempts_log) >= ok_after:
                class _R:
                    status = 200

                    def __enter__(self_inner):
                        return self_inner

                    def __exit__(self_inner, *a):
                        return False

                return _R()
            raise OSError("refused")

        return c, fake_urlopen

    def _run(self, retries, ok_after=None):
        attempts, slept = [], []
        c, fake = self._client(attempts, ok_after)
        import time as _t

        with unittest.mock.patch("urllib.request.urlopen", fake):
            with unittest.mock.patch.object(_t, "sleep", slept.append):
                result = c.health_check(timeout=1, retries=retries)
        return result, attempts, slept

    def test_a_single_retry_never_sleeps(self):
        """retries=1 is the hook-budget contract: one shot, no delay."""
        ok, attempts, slept = self._run(retries=1)
        self.assertFalse(ok)
        self.assertEqual(len(attempts), 1)
        self.assertEqual(slept, [], "no sleep after the final attempt")

    def test_n_attempts_sleep_exactly_n_minus_one_times(self):
        ok, attempts, slept = self._run(retries=3)
        self.assertFalse(ok)
        self.assertEqual(len(attempts), 3)
        self.assertEqual(
            len(slept), 2, "a sleep BETWEEN attempts, never after the last"
        )

    def test_success_short_circuits_the_remaining_attempts(self):
        ok, attempts, slept = self._run(retries=3, ok_after=2)
        self.assertTrue(ok)
        self.assertEqual(len(attempts), 2)
        self.assertEqual(len(slept), 1)

    def test_retries_is_floored_at_one(self):
        ok, attempts, slept = self._run(retries=0)
        self.assertEqual(len(attempts), 1, "0 retries still makes one attempt")
        self.assertEqual(slept, [])


class SessionDocumentIdsPagingTest(unittest.TestCase):
    """``session_document_ids`` must page until the server runs out.

    The loop stops on a SHORT page (``len(items) < page``). With ``<=`` it
    stops on a FULL one too, so a session with exactly one page of
    documents reports only that page — and the #3244 recovery caller reads
    a truncated set as "these turns were never retained" and restores
    duplicates. A sweep found this uncovered: no test ever served more
    than one page.
    """

    def _serve(self, pages):
        """Serve ``pages`` (a list of lists of ids) by offset."""
        seen = []

        def handler(h):
            import urllib.parse as up

            q = up.parse_qs(up.urlparse(h.path).query)
            offset = int(q.get("offset", ["0"])[0])
            limit = int(q.get("limit", ["200"])[0])
            seen.append((offset, limit))
            idx = offset // limit
            items = pages[idx] if idx < len(pages) else []
            body = (
                '{"items": ['
                + ", ".join('{"id": "%s"}' % i for i in items)
                + "]}"
            ).encode()
            h.send_response(200)
            h.send_header("Content-Type", "application/json")
            h.send_header("Content-Length", str(len(body)))
            h.end_headers()
            h.wfile.write(body)

        srv = _Server(("127.0.0.1", 0), _Handler)
        srv.behaviour = handler
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        self.addCleanup(t.join, 5)
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        return HindsightClient(f"http://127.0.0.1:{srv.server_address[1]}"), seen

    def test_a_full_page_is_followed_by_another_request(self):
        c, seen = self._serve([["a", "b"], ["c"]])
        got = c.list_session_document_ids(BANK, "sess-1", page=2, timeout=5)
        self.assertEqual(got, {"a", "b", "c"}, "a full page must not end the walk")
        self.assertEqual([o for o, _ in seen], [0, 2])

    def test_a_short_page_ends_the_walk(self):
        c, seen = self._serve([["a"], ["never-fetched"]])
        got = c.list_session_document_ids(BANK, "sess-1", page=2, timeout=5)
        self.assertEqual(got, {"a"})
        self.assertEqual(len(seen), 1, "a short page means the server is done")

    def test_an_exactly_full_last_page_costs_one_empty_confirmation(self):
        """The walk cannot know a full page was the last one without asking."""
        c, seen = self._serve([["a", "b"], []])
        got = c.list_session_document_ids(BANK, "sess-1", page=2, timeout=5)
        self.assertEqual(got, {"a", "b"})
        self.assertEqual(len(seen), 2)

    def test_max_pages_bounds_the_walk(self):
        c, seen = self._serve([["a", "b"]] * 10)
        c.list_session_document_ids(BANK, "sess-1", page=2, max_pages=3, timeout=5)
        self.assertEqual(len(seen), 3, "max_pages is a hard bound")


if __name__ == "__main__":
    unittest.main()
