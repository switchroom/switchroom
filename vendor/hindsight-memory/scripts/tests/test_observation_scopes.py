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
    OBSERVATION_SCOPE_STRATEGIES,
    compute_observation_scopes,
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

    def test_strategy_default_is_curated(self):
        # switchroom ships curated ON out of the box — a fresh install with no
        # settings.json key and no env override still gets the curated scope.
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(load_config().get("observationScopeStrategy"), "curated")

    def test_strategy_env_override_opts_out(self):
        with mock.patch.dict(
            os.environ, {"HINDSIGHT_OBSERVATION_SCOPE_STRATEGY": "combined"}, clear=True
        ):
            self.assertEqual(load_config().get("observationScopeStrategy"), "combined")


class PayloadBuild(unittest.TestCase):
    """``build_retain_payload`` is the single producer for every retain path."""

    _BASE = {"retainRoles": ["user", "assistant"], "retainContext": "claude-code"}

    def _build(self, config_extra):
        config = dict(self._BASE, **config_extra)
        return retain.build_retain_payload(
            config, "sess", _transcript(2), _transcript(2),
            bank_id="bank", api_url="http://fake", api_token=None,
        )["payload"]

    def test_payload_omits_scope_when_opted_out(self):
        # Opt-out (strategy=combined) is byte-identical to the pre-feature body:
        # no scope on the payload, so the engine default stands.
        self.assertIsNone(
            self._build({"observationScopeStrategy": "combined"})["observation_scopes"]
        )

    def test_payload_curates_the_scope_by_default(self):
        # No strategy key at all → the shipped default (curated) fires, so a
        # scope IS carried. A retain carrying only volatile/no stable tags
        # curates down to the bank-wide "shared" scope.
        self.assertEqual(self._build({})["observation_scopes"], "shared")

    def test_payload_curates_stable_tags_into_an_explicit_scope(self):
        # A stable semantic tag survives onto the consolidation scope as an
        # explicit list-of-lists, while a volatile session-id tag is stripped.
        payload = self._build(
            {"retainTags": ["team:acme", "{session_id}"]}
        )
        # {session_id} → "sess" (not a UUID / parent_session:*), so it is NOT
        # volatile here and rides the scope alongside the stable tag.
        self.assertEqual(
            sorted(payload["observation_scopes"][0]), ["sess", "team:acme"]
        )

    def test_payload_carries_the_manually_pinned_scope(self):
        # A hand-pinned observationScopes still wins over the strategy.
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

    def test_curated_list_scope_survives_the_queue_round_trip(self):
        # The curated default emits a list[list[str]] scope. A retain that fails
        # inline and drains hours later must land in the SAME curated scope, so
        # the list value has to survive JSON on disk and reach client.retain
        # intact — otherwise a retried turn shards away from its inline siblings.
        scope = [["agent_type:worker", "sidechain"]]
        entry = json.loads(json.dumps(dict(self._LEGACY, observation_scopes=scope)))
        drain_pending._retry_one(entry, timeout=15)
        self.assertEqual(self.calls[0]["observation_scopes"], scope)


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


class ComputeCuratedScopes(unittest.TestCase):
    """``compute_observation_scopes`` — the curated-default resolver, asserted as
    exact (input tags, config) → emitted ``observation_scopes`` value mappings.

    This is the load-bearing new behaviour: which tags survive onto the
    consolidation scope and which are stripped as volatile provenance. The
    function NEVER raises — a bad config degrades the scope, never the turn.
    """

    _UUID = "0291c461-864d-4284-b2b3-3fba9bf3142c"

    def _compute(self, tags, **config):
        return compute_observation_scopes(tags, config)

    # --- default (curated) ------------------------------------------------
    def test_curated_strips_parent_session_keeps_stable(self):
        value, err = self._compute(["parent_session:abc", "sidechain", "agent_type:worker"])
        self.assertIsNone(err)
        self.assertEqual(value, [["agent_type:worker", "sidechain"]])  # sorted, stripped

    def test_curated_strips_bare_uuid_session_tag(self):
        value, err = self._compute([self._UUID, "lesson"])
        self.assertIsNone(err)
        self.assertEqual(value, [["lesson"]])

    def test_curated_strips_sidechain_sub_session_tag(self):
        # The dominant observation path: subagent_retain sets
        # `sub_session_id = f"{session_id}-sub-{agent_id}"`, and `retainTags:
        # ["{session_id}"]` resolves to `<parent-uuid>-sub-<agent_id>`. That is
        # per-invocation-unique, so if it survives into the scope every sidechain
        # retain gets its own island and never dedups. It must be treated as
        # volatile (like the bare UUID it derives from) and stripped, while the
        # stable semantic tags stay in scope.
        sub_tag = f"{self._UUID}-sub-af5fba739c0ee6b38"
        value, err = self._compute([sub_tag, "sidechain", "agent_type:worker"])
        self.assertIsNone(err)
        self.assertEqual(value, [["agent_type:worker", "sidechain"]])

    def test_curated_all_volatile_falls_back_to_shared(self):
        # A retain tagged ONLY with volatile provenance has no stable scope, so
        # it pools into the one bank-wide untagged scope instead of an island.
        value, err = self._compute([self._UUID, "parent_session:xyz"])
        self.assertIsNone(err)
        self.assertEqual(value, "shared")

    def test_curated_no_tags_is_shared(self):
        self.assertEqual(self._compute([])[0], "shared")
        self.assertEqual(self._compute(None)[0], "shared")

    def test_curated_scope_is_deterministically_sorted(self):
        # Same tag set in any order → identical scope (so it dedups, not shards).
        a, _ = self._compute(["z:1", "a:2", "m:3"])
        b, _ = self._compute(["m:3", "z:1", "a:2"])
        self.assertEqual(a, b)
        self.assertEqual(a, [["a:2", "m:3", "z:1"]])

    def test_curated_dedups_repeated_tags(self):
        value, _ = self._compute(["lesson", "lesson", "sidechain"])
        self.assertEqual(value, [["lesson", "sidechain"]])

    # --- opt-out ----------------------------------------------------------
    def test_combined_emits_no_scope(self):
        self.assertEqual(
            self._compute(["lesson"], observationScopeStrategy="combined"), (None, None)
        )

    def test_off_emits_no_scope(self):
        self.assertEqual(
            self._compute(["lesson"], observationScopeStrategy="off"), (None, None)
        )

    def test_shared_strategy_is_uniform(self):
        value, err = self._compute(["lesson", "sidechain"], observationScopeStrategy="shared")
        self.assertIsNone(err)
        self.assertEqual(value, "shared")

    # --- precedence / robustness -----------------------------------------
    def test_manual_pin_wins_over_strategy(self):
        # An operator who pinned per_tag keeps it even though curated is default.
        value, err = self._compute(
            ["lesson"], observationScopes="per_tag", observationScopeStrategy="curated"
        )
        self.assertIsNone(err)
        self.assertEqual(value, "per_tag")

    def test_manual_pin_typo_degrades_to_none_with_error_not_curated(self):
        # A typo'd pin must NOT silently fall through to curated — it degrades to
        # the engine default (None) and carries an error, exactly like the
        # pre-strategy behaviour, so the misconfiguration stays visible.
        value, err = self._compute(["lesson"], observationScopes="shred")
        self.assertIsNone(value)
        self.assertIsNotNone(err)
        self.assertIn("shred", err)

    def test_unknown_strategy_degrades_to_curated_with_error(self):
        value, err = self._compute(["lesson"], observationScopeStrategy="curatd")
        self.assertEqual(value, [["lesson"]])
        self.assertIsNotNone(err)
        self.assertIn("curatd", err)
        for s in OBSERVATION_SCOPE_STRATEGIES:
            self.assertIn(s, err)

    def test_empty_strategy_string_is_curated(self):
        # An empty export hands authority back to the default, same idiom as
        # the bare-string scope path.
        self.assertEqual(self._compute(["lesson"], observationScopeStrategy="")[0], [["lesson"]])
        self.assertEqual(self._compute(["lesson"], observationScopeStrategy="   ")[0], [["lesson"]])

    def test_strategy_is_case_insensitive(self):
        self.assertEqual(
            self._compute(["lesson"], observationScopeStrategy="COMBINED"), (None, None)
        )

    def test_custom_volatile_patterns_override_defaults(self):
        # An operator can declare a bank-specific provenance tag volatile.
        value, err = self._compute(
            ["run:42", "lesson"],
            observationScopeVolatilePatterns=[r"^run:"],
        )
        self.assertIsNone(err)
        self.assertEqual(value, [["lesson"]])

    def test_bad_volatile_pattern_is_skipped_not_fatal(self):
        # A malformed regex must not kill the retain — it is dropped and the
        # remaining (valid) matchers still curate.
        err_out = io.StringIO()
        with contextlib.redirect_stderr(err_out):
            value, err = self._compute(
                [self._UUID, "lesson"],
                observationScopeVolatilePatterns=["(", r"^parent_session:",
                                                   r"^[0-9a-fA-F-]{36}$"],
            )
        self.assertIsNone(err)
        self.assertEqual(value, [["lesson"]])

    def test_never_raises_on_junk_tags(self):
        # Non-string tags in the list must be ignored, not explode.
        value, err = self._compute(["lesson", None, 42, "", "sidechain"])
        self.assertIsNone(err)
        self.assertEqual(value, [["lesson", "sidechain"]])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
