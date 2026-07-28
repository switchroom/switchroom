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
from lib.config import load_config  # noqa: E402
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


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
