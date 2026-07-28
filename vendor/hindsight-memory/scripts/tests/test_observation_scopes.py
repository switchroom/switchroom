"""Switchroom — per-row ``observation_scopes`` plumbing on the retain path.

Hindsight stores an ``observation_scopes`` field per retained row.
``"shared"`` makes consolidation write that item's observations into ONE
global untagged scope instead of a scope per tag. The plugin could not send
the field at all before this change, so a bank could never be pooled.

The load-bearing properties, each asserted as an OUTCOME on the wire body or
on the kwargs a callsite hands ``client.retain()``:

1. **Unset is byte-identical to before.** With no config the key is ABSENT
   from the POST body — not present-and-null — so the engine default stands.
2. **Set reaches the wire**, on every part of a split retain.
3. **It survives the pending queue.** The scope is carried on the payload,
   so a retain that fails now and drains hours later lands in the same scope
   it would have landed in inline.
4. **Old queue entries still drain.** Entries written by a pre-feature build
   are on disk right now and carry no such key; the drain must read them
   with ``.get`` and post ``None``, never raise.

Stdlib-only; runs under ``python3 -m unittest discover tests/``.
"""

import contextlib
import io
import json
import os
import sys
import unittest
from unittest import mock

SCRIPTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

import drain_pending  # noqa: E402
import retain  # noqa: E402
from lib.client import HindsightClient  # noqa: E402
from lib.config import (  # noqa: E402
    OBSERVATION_SCOPES_VALUES,
    load_config,
    resolve_observation_scopes,
)
from lib.retain_split import retain_content_limit  # noqa: E402


class _RecordingClient(HindsightClient):
    """Captures the request bodies instead of putting them on a socket."""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.bodies = []

    def _request(self, method, path, body=None, timeout=30):
        self.bodies.append(body)
        return {"ok": True}


def _transcript(n_turns: int) -> list:
    out = []
    for i in range(n_turns):
        out.append({"role": "user", "content": f"user turn {i}", "uuid": f"u{i}"})
        out.append({"role": "assistant", "content": f"assistant turn {i}", "uuid": f"a{i}"})
    return out


class WireBody(unittest.TestCase):
    """What actually goes on the wire."""

    def setUp(self):
        self.client = _RecordingClient("http://hindsight.invalid")

    def test_unset_omits_the_key_entirely(self):
        self.client.retain("bank", "some transcript", document_id="doc")
        item = self.client.bodies[0]["items"][0]
        # Not `is None` — ABSENT. A null would be a value the engine has to
        # interpret; the pre-feature body simply had no such key.
        self.assertNotIn("observation_scopes", item)

    def test_explicit_none_omits_the_key_entirely(self):
        # The default config value is None and every callsite forwards it, so
        # the None path is the one the whole fleet takes.
        self.client.retain(
            "bank", "some transcript", document_id="doc", observation_scopes=None
        )
        self.assertNotIn("observation_scopes", self.client.bodies[0]["items"][0])

    def test_unset_body_is_identical_to_a_pre_feature_body(self):
        self.client.retain(
            "bank", "t", document_id="doc", context="claude-code",
            metadata={"m": "1"}, tags=["x"],
        )
        self.assertEqual(
            self.client.bodies[0],
            {
                "items": [{
                    "content": "t",
                    "document_id": "doc",
                    "metadata": {"m": "1"},
                    "context": "claude-code",
                    "tags": ["x"],
                }],
                "async": True,
            },
        )

    def test_set_value_reaches_the_item(self):
        self.client.retain(
            "bank", "some transcript", document_id="doc", observation_scopes="shared"
        )
        self.assertEqual(
            self.client.bodies[0]["items"][0]["observation_scopes"], "shared"
        )

    def test_every_part_of_a_split_retain_carries_it(self):
        # A split that lands parts in DIFFERENT scopes would silently shard one
        # memory across scopes — the exact drift this pins.
        big = "z" * (retain_content_limit() * 3)
        self.client.retain("bank", big, document_id="doc", observation_scopes="shared")
        self.assertGreater(len(self.client.bodies), 1)
        for body in self.client.bodies:
            self.assertEqual(body["items"][0]["observation_scopes"], "shared")


class ConfigResolution(unittest.TestCase):
    """``observationScopes`` default + the HINDSIGHT_OBSERVATION_SCOPES env."""

    def test_default_is_none(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(load_config().get("observationScopes"))

    def test_env_override_sets_it(self):
        with mock.patch.dict(os.environ, {"HINDSIGHT_OBSERVATION_SCOPES": "shared"},
                             clear=True):
            self.assertEqual(load_config().get("observationScopes"), "shared")


class PayloadBuild(unittest.TestCase):
    """``build_retain_payload`` is the single producer for every retain path."""

    _BASE = {"retainRoles": ["user", "assistant"], "retainContext": "claude-code"}

    def _build(self, config_extra):
        config = dict(self._BASE, **config_extra)
        return retain.build_retain_payload(
            config, "sess", _transcript(2), _transcript(2),
            bank_id="bank", api_url="http://fake", api_token=None,
        )["payload"]

    def test_payload_carries_none_when_unconfigured(self):
        self.assertIsNone(self._build({})["observation_scopes"])

    def test_payload_carries_the_configured_scope(self):
        self.assertEqual(
            self._build({"observationScopes": "shared"})["observation_scopes"],
            "shared",
        )


class DrainOfQueuedEntries(unittest.TestCase):
    """``drain_pending._retry_one`` — the durability path, over MIXED entries."""

    def setUp(self):
        self.calls = []
        outer = self

        class _Client:
            def __init__(self, *a, **kw):
                pass

            def retain(self, **kwargs):
                outer.calls.append(kwargs)
                return {"ok": True}

        self.patch = mock.patch.object(drain_pending, "HindsightClient", _Client)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    _LEGACY = {
        "api_url": "http://fake",
        "api_token": None,
        "bank_id": "bank",
        "document_id": "doc",
        "content": "old transcript",
        "context": "claude-code",
        "metadata": {},
        "tags": None,
    }

    def test_entry_written_before_the_feature_drains_with_none(self):
        # These entries are on disk RIGHT NOW. A KeyError here would strand the
        # last on-disk copy of a turn, which is the #3244 silent-loss shape.
        drain_pending._retry_one(dict(self._LEGACY), timeout=15)
        self.assertEqual(self.calls[0]["content"], "old transcript")
        self.assertIsNone(self.calls[0]["observation_scopes"])

    def test_entry_carrying_a_scope_drains_into_that_scope(self):
        entry = dict(self._LEGACY, observation_scopes="shared")
        drain_pending._retry_one(entry, timeout=15)
        self.assertEqual(self.calls[0]["observation_scopes"], "shared")

    def test_scope_survives_a_json_round_trip_through_the_queue_file(self):
        # The queue is JSON on disk; the scope must come back out of it.
        entry = json.loads(json.dumps(dict(self._LEGACY, observation_scopes="shared")))
        drain_pending._retry_one(entry, timeout=15)
        self.assertEqual(self.calls[0]["observation_scopes"], "shared")


class ValueValidation(unittest.TestCase):
    """An off-list scope must not reach the wire — and must not cost a memory.

    The value is invisible after the write: a typo would keep retaining
    happily, the engine would apply its own default scope, and the damage
    (a bank whose observations never merged) surfaces only much later. The
    `memory.observation_scopes` zod enum is the primary gate, but it cannot
    see a hand-edited settings.json or a raw HINDSIGHT_OBSERVATION_SCOPES
    export — which is why this second gate exists here.

    TWO different obligations, and they are not the same severity:

    * `resolve_observation_scopes` is the strict VALIDATOR and RAISES. Callers
      that can safely stop (a config check, a hand-run script) use it.
    * the retain path uses the non-raising classifier, drops the bad field and
      shouts. A misconfigured scope is recoverable; a deleted turn is not, and
      raising at the build seam deleted turns — see
      `test_a_typo_never_reaches_the_payload_BUT_the_memory_survives`.
    """

    _BASE = {"retainRoles": ["user", "assistant"], "retainContext": "claude-code"}

    def _build(self, config_extra):
        config = dict(self._BASE, **config_extra)
        return retain.build_retain_payload(
            config, "sess", _transcript(2), _transcript(2),
            bank_id="bank", api_url="http://fake", api_token=None,
        )["payload"]

    def test_every_accepted_value_resolves_to_itself(self):
        for value in OBSERVATION_SCOPES_VALUES:
            with self.subTest(value=value):
                self.assertEqual(
                    resolve_observation_scopes({"observationScopes": value}), value
                )

    def test_unset_and_empty_resolve_to_none(self):
        # Empty is UNSET, not a typo — matches the plugin's "an empty export
        # hands authority back to the config file" idiom.
        self.assertIsNone(resolve_observation_scopes({}))
        self.assertIsNone(resolve_observation_scopes({"observationScopes": None}))
        self.assertIsNone(resolve_observation_scopes({"observationScopes": ""}))
        self.assertIsNone(resolve_observation_scopes({"observationScopes": "   "}))

    def test_typo_raises_and_names_the_accepted_set(self):
        with self.assertRaises(ValueError) as ctx:
            resolve_observation_scopes({"observationScopes": "shred"})
        msg = str(ctx.exception)
        self.assertIn("shred", msg)
        for value in OBSERVATION_SCOPES_VALUES:
            self.assertIn(value, msg)

    def test_wrong_case_raises(self):
        with self.assertRaises(ValueError):
            resolve_observation_scopes({"observationScopes": "Shared"})

    def test_non_string_raises(self):
        with self.assertRaises(ValueError):
            resolve_observation_scopes({"observationScopes": ["shared"]})

    def test_a_typo_never_reaches_the_payload_BUT_the_memory_survives(self):
        # Two outcomes, and the second is the load-bearing one.
        #
        # (a) The bad value does not ride to the wire — `observation_scopes` is
        #     None, so `HindsightClient._retain_one` omits the key and the
        #     engine's own default scope stands. That is the pre-feature
        #     behaviour, and it is a *recoverable* misconfiguration.
        #
        # (b) The PAYLOAD IS STILL BUILT. `build_retain_payload` raising here
        #     was a far worse bug than the one it fixed: the raise unwound past
        #     `retain.main`'s `pending_enqueue`, so the turn was never POSTed,
        #     never queued and never re-derivable — permanent silent memory
        #     loss for as long as the typo sat in the config. A config typo
        #     must never be able to delete a memory. End-to-end coverage of
        #     the same guarantee lives in
        #     tests/test_reconcile_durability.py::TestObservationScopes.
        payload = self._build({"observationScopes": "shred"})
        self.assertIsNone(payload["observation_scopes"])
        self.assertIn("user turn 0", payload["content"])
        self.assertTrue(payload["document_id"])

    def test_a_typo_never_reaches_the_wire(self):
        client = _RecordingClient("http://fake")
        payload = self._build({"observationScopes": "per-tag"})  # hyphen, not underscore
        client.retain(
            payload["bank_id"],
            payload["content"],
            document_id=payload["document_id"],
            observation_scopes=payload["observation_scopes"],
        )
        self.assertEqual(len(client.bodies), 1)
        # ABSENT, not null: the request body is the pre-feature one.
        self.assertNotIn("observation_scopes", client.bodies[0]["items"][0])

    def test_a_typo_is_shouted_about_rather_than_swallowed(self):
        # A silent downgrade to the engine default is the ORIGINAL defect this
        # feature exists to prevent. Degrading quietly would just reintroduce
        # it, so the build seam must say so on stderr every time it fires.
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self._build({"observationScopes": "shred"})
        msg = err.getvalue()
        self.assertIn("shred", msg)
        self.assertIn("observation_scopes", msg)
        for value in OBSERVATION_SCOPES_VALUES:
            self.assertIn(value, msg)

    def test_env_var_typo_is_caught_too(self):
        # The env path bypasses zod entirely, so this is the only gate on it.
        with mock.patch.dict(os.environ, {"HINDSIGHT_OBSERVATION_SCOPES": "shred"},
                             clear=True):
            with self.assertRaises(ValueError):
                resolve_observation_scopes(load_config())


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
