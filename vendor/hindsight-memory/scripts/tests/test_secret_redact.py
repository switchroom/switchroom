"""Write-path secret redaction — Python half.

Two obligations are pinned here:

1. The Python redactor produces byte-identical output to the TypeScript
   one for every case in ``lib/secret_redaction_vectors.json``. The same
   file is asserted by
   ``telegram-plugin/tests/secret-detect-write-path.test.ts``, so a
   divergence between the two engines fails one side or the other.

2. No retain this plugin issues can put a raw credential on the wire.
   The assertions are on the POSTED BODY, not on "the redactor was
   called" — a test that only proved the code path ran would still pass
   if the redaction were a no-op.

Every credential-shaped literal below is synthetic and assembled at
runtime so nothing token-shaped is committed.
"""

import json
import os
import sys
import unittest
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib.client import HindsightClient  # noqa: E402
from lib.secret_redact import (  # noqa: E402
    REDACTED_MARKER,
    redact,
    redact_metadata,
)

VECTORS_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "lib",
    "secret_redaction_vectors.json",
)


def _pg_uri(password):
    return "postgres://appuser:" + password + "@db.internal:5432/prod"


class SharedVectorTests(unittest.TestCase):
    """Behaviour parity with the TypeScript redactor."""

    def test_vectors_file_is_present_and_non_trivial(self):
        with open(VECTORS_PATH, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
        self.assertGreaterEqual(len(doc["vectors"]), 20)

    def test_every_shared_vector_matches(self):
        with open(VECTORS_PATH, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
        for vector in doc["vectors"]:
            with self.subTest(vector["name"]):
                self.assertEqual(redact(vector["input"]), vector["expected"])


class RedactorBehaviourTests(unittest.TestCase):
    def test_database_connection_password_is_removed(self):
        password = "Hunter" + "Two99"
        out = redact("DSN " + _pg_uri(password))
        self.assertNotIn(password, out)
        self.assertIn("[REDACTED:db_uri_password]", out)
        # Host and user survive — the row stays diagnostically useful.
        self.assertIn("appuser", out)
        self.assertIn("db.internal:5432/prod", out)

    def test_human_memorable_password_is_removed(self):
        password = "Fluffy" + "Barnaby" + "1998"
        out = redact("the wifi password is " + password)
        self.assertNotIn(password, out)
        self.assertIn("[REDACTED:memorable_password]", out)

    def test_prose_mentioning_passwords_is_untouched(self):
        for prose in (
            "The password policy requires rotation every 90 days.",
            "the password is rotated quarterly",
            "I need the password for staging, can you check the vault?",
            "password: ${DB_PASSWORD}",
        ):
            with self.subTest(prose):
                self.assertEqual(redact(prose), prose)

    def test_prefixed_provider_token_is_removed(self):
        token = "sk-" + "ant-" + "oat01-" + ("A" * 60)
        out = redact("here is the token " + token)
        self.assertNotIn(token, out)
        self.assertIn(REDACTED_MARKER.rstrip("]"), out)

    def test_redaction_is_stable_under_repetition(self):
        text = "db " + _pg_uri("Pineapple" + "Roof8") + " pw: " + "Sparrow" + "Kettle31"
        once = redact(text)
        self.assertEqual(redact(once), once)

    def test_none_and_empty_pass_through(self):
        self.assertIsNone(redact(None))
        self.assertEqual(redact(""), "")

    def test_metadata_strings_are_redacted_recursively(self):
        password = "Mango" + "TreeHouse77"
        meta = {
            "source": "claude-code",
            "nested": {"note": "password: " + password},
            "list": ["password: " + password],
            "count": 3,
        }
        out = redact_metadata(meta)
        self.assertNotIn(password, json.dumps(out))
        self.assertEqual(out["source"], "claude-code")
        self.assertEqual(out["count"], 3)


class _FakeResponse:
    def __init__(self):
        self.status = 200

    def read(self):
        return b"{}"

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class WireCaptureCase(unittest.TestCase):
    """Base case that captures the REQUEST BODY BYTES the client sends.

    Nothing in `HindsightClient` is stubbed — only `urlopen` — so these
    assertions run through the production `retain()` / `_request()` path
    and prove what actually leaves the process.
    """

    def setUp(self):
        self.sent = []
        self._real_urlopen = urllib.request.urlopen

        def fake_urlopen(req, timeout=None):
            self.sent.append(
                {
                    "url": req.full_url,
                    "method": req.get_method(),
                    "body": req.data.decode("utf-8") if req.data else "",
                }
            )
            return _FakeResponse()

        urllib.request.urlopen = fake_urlopen
        self.addCleanup(setattr, urllib.request, "urlopen", self._real_urlopen)
        self.client = HindsightClient("http://localhost:1")

    def wire(self):
        return json.dumps([s["body"] for s in self.sent])

    def stored_text(self):
        """Every item's content, in send order, concatenated.

        A split retain stores adjacent rows in ONE bank, so what an
        attacker (or a future recall) can reassemble is the concatenation
        — not any single chunk. Assertions about a boundary-straddling
        credential have to be made against this, because a cut through the
        middle of the secret makes per-chunk checks pass by accident.
        """
        out = []
        for sent in self.sent:
            body = json.loads(sent["body"])
            for item in body.get("items", []):
                out.append(item.get("content") or "")
        return "".join(out)


class RetainWirePayloadTests(WireCaptureCase):
    """The bytes that actually leave the process carry no credential."""

    def test_retain_content_is_redacted_on_the_wire(self):
        password = "Hunter" + "Two99"
        self.client.retain(bank_id="bank", content="DSN " + _pg_uri(password))
        self.assertEqual(len(self.sent), 1)
        self.assertTrue(self.sent[0]["url"].endswith("/memories"))
        self.assertNotIn(password, self.wire())
        self.assertIn("[REDACTED:db_uri_password]", self.wire())

    def test_retain_context_and_metadata_are_redacted_on_the_wire(self):
        password = "Fluffy" + "Barnaby" + "1998"
        self.client.retain(
            bank_id="bank",
            content="a normal sentence",
            context="password: " + password,
            metadata={"detail": "password: " + password},
        )
        self.assertNotIn(password, self.wire())

    def test_secret_straddling_a_split_boundary_is_still_redacted(self):
        """Redaction runs BEFORE splitting, so a credential that would be
        cut in half by `split_retain_content` is masked while whole.

        Asserted against the REASSEMBLED text, and on the presence of the
        marker — not merely on the absence of the password. A chunk
        boundary through the middle of the credential makes "password not
        in any single chunk" true by accident, so that check alone would
        pass with the redactor removed entirely while both halves sat in
        adjacent rows of the same bank.
        """
        from lib.retain_split import retain_content_limit

        password = "Hunter" + "Two99"
        uri = _pg_uri(password)
        # Land the URI so that it spans the first chunk boundary.
        limit = retain_content_limit()
        prefix = "x " * ((limit - (len(uri) // 2)) // 2)
        self.client.retain(bank_id="bank", content=prefix + uri + " tail")
        self.assertGreater(len(self.sent), 1, "expected a split retain")
        stored = self.stored_text()
        self.assertIn("[REDACTED:db_uri_password]", stored)
        self.assertNotIn(password, stored)
        # No fragment of the credential survives on either side of the cut.
        for size in range(4, len(password) + 1):
            self.assertNotIn(password[:size], stored)
            self.assertNotIn(password[-size:], stored)

    def test_request_backstop_redacts_a_body_that_skipped_retain(self):
        """A caller reaching the HTTP leg without going through retain()
        still cannot write a raw credential."""
        password = "Sparrow" + "Kettle31"
        self.client._request(
            "POST",
            "/v1/default/banks/bank/memories",
            {"items": [{"content": "password: " + password}], "async": True},
        )
        self.assertNotIn(password, self.wire())
        self.assertIn("[REDACTED", self.wire())

    def test_recall_body_is_not_rewritten(self):
        """`POST .../memories/recall` is a READ. Rewriting the query would
        silently change search results."""
        query = "what is the postgres://u:PineappleRoof8@h/d dsn"
        self.client.recall(bank_id="bank", query=query)
        self.assertIn(json.dumps(query)[1:-1], self.sent[0]["body"])

    def test_is_memory_write_classification(self):
        cases = [
            ("POST", "/v1/default/banks/b/memories", True),
            ("POST", "/v1/default/banks/b/memories/", True),
            ("POST", "/v1/default/banks/b/memories/recall", False),
            ("GET", "/v1/default/banks/b/memories", False),
            ("PATCH", "/v1/default/banks/b/config", False),
            ("POST", "/v1/default/banks/b/memories?dry=1", True),
        ]
        for method, path, expected in cases:
            with self.subTest(path=path, method=method):
                self.assertEqual(
                    HindsightClient._is_memory_write(method, path), expected
                )


if __name__ == "__main__":
    unittest.main()
