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
        self.assertGreaterEqual(len(doc["vectors"]), 50)

    def test_vectors_cover_the_generated_pattern_table(self):
        """#3982 review, MAJOR 4.

        The vectors originally shipped exercised only the two hand-ported
        imperative rules plus the URL pass — ZERO of the ~60 GENERATED
        patterns. That is exactly the gap that let a Unicode word-boundary
        fork inside the generated table ship past a green CI.
        """
        with open(VECTORS_PATH, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
        expected = "".join(v["expected"] for v in doc["vectors"])
        for marker in (
            "[REDACTED:anthropic_api_key]",
            "[REDACTED:jwt]",
            "[REDACTED:aws_access_key]",
            "[REDACTED:pem_private_key]",
            "[REDACTED:bearer_auth_header]",
            "[REDACTED:basic_auth_header]",
        ):
            with self.subTest(marker):
                self.assertIn(marker, expected)
        non_ascii = [
            v
            for v in doc["vectors"]
            if any(ord(c) > 127 for c in v["input"]) and "[REDACTED" in v["expected"]
        ]
        self.assertGreaterEqual(len(non_ascii), 4)

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

    def test_sentence_final_prose_is_untouched(self):
        """#3982 review, BLOCKER 2.

        The value class is ``[^\\s"']``, so the sentence terminator was
        captured INTO the value and the ``.`` itself supplied the second
        character class the gate asks for. Every string here redacted as a
        credential on the shipped code, and sentence-final is the MOST
        common position for these words — the suite's original
        mid-sentence cases were tests chosen to pass.
        """
        for prose in (
            "The password is required.",
            "The password is incorrect.",
            "The password is unchanged.",
            "The password is different.",
            "The password is protected.",
            "Ken confirmed the password is unchanged.",
            "password: required, minimum twelve characters, mixed case",
            "The passphrase is unchanged; rotate it next quarter.",
        ):
            with self.subTest(prose):
                self.assertEqual(redact(prose), prose)

    def test_real_password_ending_a_sentence_is_masked_whole(self):
        password = "Mango" + "TreeHouse77"
        self.assertEqual(
            redact("The wifi password is " + password + "."),
            "The wifi password is [REDACTED:memorable_password]",
        )
        # A password whose LAST byte is punctuation keeps that byte masked.
        self.assertEqual(
            redact("password: " + "Fluffy" + "Barnaby" + "1998!"),
            "password: [REDACTED:memorable_password]",
        )

    def test_dsn_password_with_unencoded_at_sign_is_fully_masked(self):
        """#3982 review, MAJOR 3 — 9 of 11 password bytes were stored."""
        password = "p" + "@" + "ssW0rd123"
        out = redact("postgres://appuser:" + password + "@db.internal:5432/prod")
        self.assertEqual(
            out, "postgres://appuser:[REDACTED:db_uri_password]@db.internal:5432/prod"
        )
        for i in range(0, len(password) - 3):
            self.assertNotIn(password[i : i + 4], out)

    def test_comma_joined_dsn_list_masks_each_uri_separately(self):
        """Adversarial case for the MAJOR-3 fix.

        The password class now INCLUDES ``@`` so greedy matching backs off
        to the LAST ``@``. The hazard that introduces is one match
        swallowing two DSNs and hiding the first host; it does not,
        because ``/`` terminates the authority.
        """
        a = "Ab" + "3xQ" + "9zK"
        b = "Zt" + "7wM" + "2vR"
        out = redact(
            "postgres://u1:" + a + "@h1.internal:5432/a,"
            "postgres://u2:" + b + "@h2.internal:5432/b"
        )
        self.assertEqual(
            out,
            "postgres://u1:[REDACTED:db_uri_password]@h1.internal:5432/a,"
            "postgres://u2:[REDACTED:db_uri_password]@h2.internal:5432/b",
        )

    def test_dsn_password_stops_at_query_and_fragment_delimiters(self):
        pw = "Ab" + "3xQ" + "9zK"
        self.assertEqual(
            redact("mysql://u:" + pw + "@host/db?opt=x@y"),
            "mysql://u:[REDACTED:db_uri_password]@host/db?opt=x@y",
        )
        self.assertEqual(
            redact("redis://u:" + pw + "@host#frag@z"),
            "redis://u:[REDACTED:db_uri_password]@host#frag@z",
        )

    def test_inert_values_survive_regardless_of_case(self):
        """#3982 review, MAJOR 5.

        The inert-value list applied ONLY to the new memorable_password
        rule, so LETTER CASE decided whether a vault reference survived.
        A vault key NAME is exactly what an agent is supposed to remember.
        """
        for line in (
            "POSTGRES_PASSWORD: vault:pg/password",
            "postgres_password: vault:pg/password",
            "ANTHROPIC_API_KEY: vault:anthropic/api_key",
            "PASSWORD: ${DB_PASSWORD}",
            "password: ${DB_PASSWORD}",
            "API_TOKEN=%API_TOKEN%",
            "JWT_SECRET=<generate-with-openssl-rand>",
            "DB_PASSWORD=changeme-in-production",
            "const API_KEY = process.env.ANTHROPIC_API_KEY",
            '{"token": "the bearer token to use"}',
            "--token <value>   the API token",
        ):
            with self.subTest(line):
                self.assertEqual(redact(line), line)

    def test_inert_gate_does_not_smuggle_a_real_value_through(self):
        token = "zQ7x" + "Vb2n" + "Kd9w" + "Rt4y"
        for line in (
            "POSTGRES_PASSWORD: " + token,
            "ANTHROPIC_API_KEY=" + token,
            '{"token": "' + token + '"}',
            "--token " + token,
        ):
            with self.subTest(line):
                self.assertNotIn(token, redact(line))

    def test_authorization_headers_are_masked_case_insensitively(self):
        """#3982 review, MAJOR 6 — HTTP/2 lowercases header names."""
        token = "AAAABBBB" + "CCCCDDDD" + "EEEEFFFF"
        for line in (
            "Authorization: Bearer " + token,
            "authorization: bearer " + token,
            "AUTHORIZATION: BEARER " + token,
        ):
            with self.subTest(line):
                out = redact(line)
                self.assertNotIn(token, out)
                self.assertIn("[REDACTED:bearer_auth_header]", out)
        creds = "YWxpY2U6" + "c3VwZXJzZWNyZXQ="
        for line in (
            "Authorization: Basic " + creds,
            "authorization: basic " + creds,
        ):
            with self.subTest(line):
                out = redact(line)
                self.assertNotIn(creds, out)
                self.assertIn("[REDACTED:basic_auth_header]", out)

    def test_token_adjacent_to_non_ascii_text_is_masked(self):
        """#3982 review, BLOCKER 1 — the Unicode word-boundary fork.

        Python ``re`` treats ``\\b`` as Unicode-aware for ``str``
        patterns; JavaScript ``RegExp`` without ``/u`` treats it as
        ASCII-only. Every generated rule is ``\\b``-anchored, so a token
        abutting CJK / Cyrillic / accented-Latin text was masked by the
        TypeScript engine and stored VERBATIM by this one. CJK has no
        word spacing, so this is the ordinary case.
        """
        token = "sk-" + "ant-" + "api03-" + ("A" * 40)
        for neighbour in ("К", "中", "é", "ก", "あ"):
            with self.subTest(neighbour):
                out = redact("note" + neighbour + token + neighbour + "end")
                self.assertNotIn(token, out)
                self.assertIn("[REDACTED", out)

    def test_unicode_whitespace_separator_still_masks(self):
        """The other half of the semantics bridge.

        JS ``\\s`` is Unicode-aware even without ``/u``, so a bare
        ``re.ASCII`` port would narrow Python's ``\\s`` BELOW the JS one
        and re-open the fork on the separator instead of the boundary.
        """
        token = "zQ7x" + "Vb2n" + "Kd9w" + "Rt4y"
        for space in (" ", "\u3000", "\u00a0", "\ufeff"):
            with self.subTest(repr(space)):
                out = redact("API_TOKEN:" + space + token)
                self.assertNotIn(token, out)
                self.assertIn("[REDACTED", out)

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
