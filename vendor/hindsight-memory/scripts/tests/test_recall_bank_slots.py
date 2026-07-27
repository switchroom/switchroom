"""Switchroom — per-bank slot reservation inside the recall count cap.

The bug these tests guard is compositional, not volumetric. Recall fans out to
the agent's OWN bank and the sender's profile bank, merges the results, sorts
them globally by ``scores.final`` and head-slices at ``recallMaxMemories``. That
head-slice is winner-take-all across banks: on a turn where both banks return
more candidates than the cap, one bank's score distribution can fill every slot,
and the agent is handed a dossier about its operator with none of its own
session memory.

Scope, stated the way the code states it: this is score-based crowd-out among
results that DID return. A timed-out bank contributes zero candidates, so
reservation is a strict no-op there — the own-bank timeout is a separate defect,
and the composition telemetry asserted below (``injected_own_bank_count``) is
what makes THAT one legible per-turn, since a fully timed-out own bank still
logs a full ``result_count``.

Two properties are load-bearing and each has a test that fails without it:

  * the floors bind — neither bank can be zeroed out when it returned results;
  * the floors are FLOORS — they may claim at most half the cap between them,
    so ``scores.final`` still decides the rest and composition still moves when
    the score regime flips. Floors summing to the cap (4+2 at the fleet's
    deployed cap of 6) would be a fixed quota with no score influence at all.

So every test here asserts COMPOSITION (which bank the injected memories came
from), never just a count. A test that passes when all six injected memories
come from the profile bank is not a test for this bug.

Stdlib-only (unittest + mock); runs under ``python3 -m unittest discover
tests/``. Harness mirrors ``test_recall_integration.py``.
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

OWN = "test-bank"
PROFILE = "ken-profile"

# Switchroom's shipped floors, sized against the cap the fleet actually deploys
# (`defaults.memory.recall.max_memories: 6`, which cascades to
# HINDSIGHT_RECALL_MAX_MEMORIES and wins over the 8 in settings.json). Kept as
# named constants so a change to the shipped pair has to come here too.
SHIPPED_CAP = 6
SHIPPED_OWN_FLOOR = 2
SHIPPED_ADDITIONAL_FLOOR = 1


def _memory(text, score, mem_id=None):
    """A recall result carrying the engine's combined relevance score."""
    return {
        "text": text,
        "type": "fact",
        "mentioned_at": "2026-01-01",
        "id": mem_id or text,
        "scores": {"final": score},
    }


class _PerBankClient:
    """Fake HindsightClient returning a different result set per bank."""

    def __init__(self, per_bank, directives=None, bank_exc=None):
        self._per_bank = per_bank
        self._directives = directives or []
        self._bank_exc = bank_exc or {}

    def list_directives(self, bank_id, active_only=True, timeout=2):
        return {"items": list(self._directives)}

    def recall(self, bank_id, query, **kwargs):
        exc = self._bank_exc.get(bank_id)
        if exc is not None:
            raise exc
        # Deep-ish copy: main() stamps a private source-bank key onto results,
        # and a shared list would leak that between calls.
        return {"results": [dict(m) for m in self._per_bank.get(bank_id, [])]}


def _run_main_with(client, prompt="what did we decide", config_extra=None):
    hook_input = {
        "prompt": prompt,
        "session_id": "test-session",
        "transcript_path": "",
        "cwd": "/tmp",
    }
    config = {
        "autoRecall": True,
        "bankId": OWN,
        "recallMaxTokens": 1024,
        "recallBudget": "mid",
        "recallContextTurns": 1,
        "recallMaxQueryChars": 800,
        "recallPromptPreamble": "",
        "directivesCacheTtlSeconds": 0,
        "recallAdditionalBanks": [PROFILE],
    }
    if config_extra:
        config.update(config_extra)

    stdout = io.StringIO()
    stderr = io.StringIO()
    with patch.object(recall, "load_config", return_value=config), patch.object(
        recall, "get_api_url", return_value="http://localhost:18888"
    ), patch.object(recall, "HindsightClient", return_value=client), patch.object(
        recall, "ensure_bank_mission", return_value=None
    ), patch.object(recall, "write_state", return_value=None), patch(
        "sys.stdin", new=io.StringIO(json.dumps(hook_input))
    ), patch("sys.stdout", new=stdout), patch("sys.stderr", new=stderr):
        recall.main()

    raw = stdout.getvalue()
    if not raw.strip():
        return None, raw
    return json.loads(raw)["hookSpecificOutput"]["additionalContext"], raw


class ReserveBankSlotsUnitTests(unittest.TestCase):
    """`_reserve_bank_slots` in isolation."""

    @staticmethod
    def _mk(bank, n, base):
        return [
            dict(_memory(f"{bank}-{i}", base - i * 0.001), **{recall.SOURCE_BANK_KEY: bank})
            for i in range(n)
        ]

    def _select(
        self,
        own_n,
        add_n,
        cap=SHIPPED_CAP,
        own_floor=SHIPPED_OWN_FLOOR,
        add_floor=SHIPPED_ADDITIONAL_FLOOR,
        favour=PROFILE,
    ):
        """Run the real `_reserve_bank_slots` under a chosen score regime.

        `favour` picks which bank's candidates outrank the other's end to end.
        Both regimes matter: the crowd-out this fixes is symmetric in the code
        even though the profile-favoured direction is the one seen in
        production, and a suite that only ever ranks profile above own cannot
        tell a working additional-bank floor from a missing one.
        """
        hi, lo = (0.9, 0.5) if favour == PROFILE else (0.5, 0.9)
        merged = self._mk(PROFILE, add_n, hi) + self._mk(OWN, own_n, lo)
        recall._sort_by_final_score(merged)
        sel, r_own, r_add = recall._reserve_bank_slots(
            merged, cap, OWN, own_floor, add_floor
        )
        banks = [m[recall.SOURCE_BANK_KEY] for m in sel]
        return sel, banks.count(OWN), banks.count(PROFILE), r_own, r_add

    def test_profile_bank_cannot_take_every_slot(self):
        """THE BUG. Profile outranks own on every candidate; without floors the
        head-slice hands it all six slots."""
        merged = self._mk(PROFILE, 10, 0.9) + self._mk(OWN, 10, 0.5)
        recall._sort_by_final_score(merged)
        baseline, _, _ = recall._reserve_bank_slots(merged, SHIPPED_CAP, OWN, 0, 0)
        self.assertEqual(
            [m[recall.SOURCE_BANK_KEY] for m in baseline].count(OWN),
            0,
            "precondition: with floors off the profile bank takes all six slots",
        )

        _, own_n, add_n, r_own, r_add = self._select(10, 10)
        self.assertEqual(own_n, 2, "own bank must keep its reserved floor")
        self.assertEqual(add_n, 4, "the non-reserved slots still go to relevance")
        self.assertEqual(r_own, 2, "both own slots were won by reservation")
        self.assertEqual(r_add, 0)

    def test_own_bank_cannot_take_every_slot_either(self):
        """B2 anchor — the ADDITIONAL floor, in the score regime where it is the
        only thing standing between the profile bank and zero slots.

        Own outranks profile on every candidate here, so the head-slice and the
        own floor both point the same way; delete `additional_take` and the
        profile bank gets nothing. This is the mirror of the test above and the
        one the original suite was missing.
        """
        merged = self._mk(PROFILE, 10, 0.5) + self._mk(OWN, 10, 0.9)
        recall._sort_by_final_score(merged)
        baseline, _, _ = recall._reserve_bank_slots(merged, SHIPPED_CAP, OWN, 0, 0)
        self.assertEqual(
            [m[recall.SOURCE_BANK_KEY] for m in baseline].count(PROFILE),
            0,
            "precondition: with floors off the own bank takes all six slots",
        )

        _, own_n, add_n, r_own, r_add = self._select(10, 10, favour=OWN)
        self.assertEqual(
            add_n,
            SHIPPED_ADDITIONAL_FLOOR,
            "additional-bank floor did not bind — the profile bank was zeroed",
        )
        self.assertEqual(own_n, 5)
        self.assertEqual(
            r_add,
            SHIPPED_ADDITIONAL_FLOOR,
            "the profile slot was won by reservation, not by score",
        )
        self.assertEqual(r_own, 0)

    def test_scores_still_decide_composition_at_the_deployed_cap(self):
        """B1 anchor — floors that consume the whole cap are not floors.

        At the fleet's deployed cap of 6, floors of 4/2 would sum to the cap:
        `remaining` would be 0, the global-relevance fill loop would never run,
        and every turn where both banks return would produce the identical 4/2
        split no matter what `scores.final` said. `_reservable_slots` bounds the
        floors to half the cap, so composition still moves with the scores —
        asserted here for BOTH the shipped 2/1 and an operator's oversized 4/2.
        """
        for own_floor, add_floor in ((SHIPPED_OWN_FLOOR, SHIPPED_ADDITIONAL_FLOOR), (4, 2)):
            with self.subTest(floors=(own_floor, add_floor)):
                _, own_hi, _, _, _ = self._select(
                    10, 10, own_floor=own_floor, add_floor=add_floor, favour=OWN
                )
                _, own_lo, _, _, _ = self._select(
                    10, 10, own_floor=own_floor, add_floor=add_floor, favour=PROFILE
                )
                self.assertGreater(
                    own_hi,
                    own_lo,
                    "composition is identical across score regimes — the floors "
                    "have become a fixed quota and scores.final is inert",
                )

    def test_floors_never_claim_more_than_half_the_cap(self):
        """The headroom invariant itself, across caps. At least ceil(cap/2)
        slots are always awarded on pure global relevance, so an oversized floor
        pair can never turn into a quota at any cap an operator picks."""
        for cap in (2, 4, 6, 8, 12):
            with self.subTest(cap=cap):
                # Floors far larger than the cap, i.e. the worst case.
                _, own_n, add_n, r_own, r_add = self._select(
                    20, 20, cap=cap, own_floor=99, add_floor=99
                )
                self.assertEqual(own_n + add_n, cap)
                self.assertLessEqual(
                    r_own + r_add,
                    cap // 2,
                    "reservation claimed more than half the cap",
                )

    def test_floor_is_not_a_quota_when_own_bank_is_silent(self):
        """A timed-out own bank must not waste its reserved slots."""
        _, own_n, add_n, _, _ = self._select(0, 10)
        self.assertEqual(own_n, 0)
        self.assertEqual(add_n, 6, "unclaimed own slots go to the profile bank")

    def test_floor_is_not_a_quota_when_profile_bank_is_silent(self):
        _, own_n, add_n, _, _ = self._select(10, 0)
        self.assertEqual(own_n, 6)
        self.assertEqual(add_n, 0)

    def test_partial_own_results_take_only_what_they_have(self):
        _, own_n, add_n, _, _ = self._select(1, 10)
        self.assertEqual(own_n, 1)
        self.assertEqual(add_n, 5)

    def test_zero_floors_are_the_pre_fix_head_slice(self):
        _, own_n, add_n, r_own, r_add = self._select(10, 10, own_floor=0, add_floor=0)
        self.assertEqual(own_n, 0)
        self.assertEqual(add_n, 6)
        self.assertEqual((r_own, r_add), (0, 0))

    def test_own_floor_wins_when_floors_exceed_the_reservation_budget(self):
        """Floors of 4/2 against a cap of 4 can't both be honoured. The own
        floor takes the whole reservation budget (half the cap = 2) and the
        additional floor gets nothing — but the other two slots are still
        awarded on relevance, so the profile bank is not shut out."""
        _, own_n, add_n, _, _ = self._select(10, 10, cap=4, own_floor=4, add_floor=2)
        self.assertEqual(own_n, 2, "own floor clamped to the reservation budget")
        self.assertEqual(add_n, 2, "the remaining half went to global relevance")

    def test_selection_is_returned_in_relevance_order(self):
        """Reservation changes WHICH memories are injected, never the order."""
        sel, _, _, _, _ = self._select(10, 10)
        scores = [recall._result_final_score(m) for m in sel]
        self.assertEqual(scores, sorted(scores, reverse=True))

    def test_no_cap_is_passthrough(self):
        merged = self._mk(PROFILE, 3, 0.9) + self._mk(OWN, 3, 0.5)
        sel, r_own, r_add = recall._reserve_bank_slots(merged, 0, OWN, 4, 2)
        self.assertEqual(len(sel), 6)
        self.assertEqual((r_own, r_add), (0, 0))

    def test_result_set_smaller_than_cap_is_passthrough(self):
        merged = self._mk(PROFILE, 2, 0.9) + self._mk(OWN, 2, 0.5)
        sel, r_own, r_add = recall._reserve_bank_slots(merged, 6, OWN, 4, 2)
        self.assertEqual(len(sel), 4)
        self.assertEqual((r_own, r_add), (0, 0))

    def test_no_duplicates_and_exact_cap(self):
        _, own_n, add_n, _, _ = self._select(10, 10)
        self.assertEqual(own_n + add_n, 6)
        sel, _, _, _, _ = self._select(10, 10)
        self.assertEqual(len({id(m) for m in sel}), 6)

    def test_untagged_results_count_as_additional(self):
        """A result with no stamped source bank must never be credited to the
        own bank — the own-bank number is never optimistic."""
        merged = [_memory(f"untagged-{i}", 0.9 - i * 0.01) for i in range(10)]
        sel, r_own, _ = recall._reserve_bank_slots(merged, 6, OWN, 4, 2)
        self.assertEqual(len(sel), 6)
        self.assertEqual(r_own, 0)
        self.assertEqual(
            recall._injected_bank_composition(sel, OWN)["injected_own_bank_count"], 0
        )


class _LogTestBase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="recall-slots-test-")
        self._prev = os.environ.get("CLAUDE_PLUGIN_DATA")
        os.environ["CLAUDE_PLUGIN_DATA"] = self._tmpdir

    def tearDown(self):
        shutil.rmtree(self._tmpdir, ignore_errors=True)
        if self._prev is None:
            os.environ.pop("CLAUDE_PLUGIN_DATA", None)
        else:
            os.environ["CLAUDE_PLUGIN_DATA"] = self._prev

    def _read_log(self):
        path = os.path.join(self._tmpdir, "state", "recall_log.jsonl")
        if not os.path.isfile(path):
            return []
        with open(path, encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]


class SlotReservationIntegrationTests(_LogTestBase):
    """Wired through main(): the injected block itself must carry own-bank
    memories, not just the right count of memories."""

    # Every profile memory outranks every own memory — the production shape.
    PROFILE_MEMS = [_memory(f"profile-fact-{i}", 0.99 - i * 0.001) for i in range(10)]
    OWN_MEMS = [_memory(f"own-fact-{i}", 0.5 - i * 0.001) for i in range(10)]
    # The inverted regime. Not hypothetical — `scores.final` is a per-query
    # rerank, so which bank leads flips with the prompt. It is also the only
    # regime in which the ADDITIONAL floor is load-bearing.
    OWN_MEMS_HIGH = [_memory(f"own-fact-{i}", 0.99 - i * 0.001) for i in range(10)]
    PROFILE_MEMS_LOW = [_memory(f"profile-fact-{i}", 0.5 - i * 0.001) for i in range(10)]

    def _client(self, **kw):
        return _PerBankClient({OWN: self.OWN_MEMS, PROFILE: self.PROFILE_MEMS}, **kw)

    def _client_own_favoured(self, **kw):
        return _PerBankClient(
            {OWN: self.OWN_MEMS_HIGH, PROFILE: self.PROFILE_MEMS_LOW}, **kw
        )

    def test_without_floors_profile_bank_starves_own_bank(self):
        """Precondition/regression anchor: this is today's behaviour."""
        ctx, _ = _run_main_with(
            self._client(), config_extra={"recallMaxMemories": SHIPPED_CAP}
        )
        self.assertIsNotNone(ctx)
        self.assertNotIn("own-fact-", ctx)
        e = self._read_log()[0]
        self.assertEqual(e["result_count"], 6)
        self.assertEqual(e["injected_own_bank_count"], 0)
        self.assertEqual(e["injected_additional_bank_count"], 6)

    def test_without_floors_own_bank_starves_profile_bank(self):
        """The mirror precondition, in the inverted score regime — without the
        additional floor the profile bank reaches the prompt zero times."""
        ctx, _ = _run_main_with(
            self._client_own_favoured(), config_extra={"recallMaxMemories": SHIPPED_CAP}
        )
        self.assertIsNotNone(ctx)
        self.assertNotIn("profile-fact-", ctx)
        e = self._read_log()[0]
        self.assertEqual(e["result_count"], 6)
        self.assertEqual(e["injected_own_bank_count"], 6)
        self.assertEqual(e["injected_additional_bank_count"], 0)

    def test_floors_guarantee_profile_memories_reach_the_prompt(self):
        """B2 — end-to-end proof that `recallAdditionalBankMinSlots` does
        something. Deleting the knob makes this fail: own outranks profile on
        every candidate, so only the floor puts a profile fact in the prompt."""
        ctx, _ = _run_main_with(
            self._client_own_favoured(),
            config_extra={
                "recallMaxMemories": SHIPPED_CAP,
                "recallOwnBankMinSlots": SHIPPED_OWN_FLOOR,
                "recallAdditionalBankMinSlots": SHIPPED_ADDITIONAL_FLOOR,
            },
        )
        self.assertIsNotNone(ctx)
        profile_lines = [ln for ln in ctx.splitlines() if "profile-fact-" in ln]
        self.assertEqual(
            len(profile_lines),
            SHIPPED_ADDITIONAL_FLOOR,
            "additional-bank floor did not reach the injected block",
        )
        e = self._read_log()[0]
        self.assertEqual(e["injected_additional_bank_count"], SHIPPED_ADDITIONAL_FLOOR)
        self.assertEqual(e["injected_own_bank_count"], 5)
        self.assertEqual(
            e["reserved_additional_slots"],
            SHIPPED_ADDITIONAL_FLOOR,
            "the profile slot must be recorded as won by reservation, not score",
        )
        self.assertEqual(e["reserved_own_slots"], 0)

    def test_floors_guarantee_own_bank_memories_reach_the_prompt(self):
        ctx, _ = _run_main_with(
            self._client(),
            config_extra={
                "recallMaxMemories": SHIPPED_CAP,
                "recallOwnBankMinSlots": SHIPPED_OWN_FLOOR,
                "recallAdditionalBankMinSlots": SHIPPED_ADDITIONAL_FLOOR,
            },
        )
        self.assertIsNotNone(ctx)
        own_lines = [ln for ln in ctx.splitlines() if "own-fact-" in ln]
        profile_lines = [ln for ln in ctx.splitlines() if "profile-fact-" in ln]
        self.assertEqual(
            len(own_lines), SHIPPED_OWN_FLOOR, "own bank did not get its floor"
        )
        # The other four are still won on relevance, not handed out by quota.
        self.assertEqual(len(profile_lines), 4)

    def test_log_row_records_injected_bank_composition(self):
        """The field that would have caught the own-bank timeout outage."""
        _run_main_with(
            self._client(),
            config_extra={
                "recallMaxMemories": SHIPPED_CAP,
                "recallOwnBankMinSlots": SHIPPED_OWN_FLOOR,
                "recallAdditionalBankMinSlots": SHIPPED_ADDITIONAL_FLOOR,
            },
        )
        e = self._read_log()[0]
        self.assertEqual(e["result_count"], 6)
        self.assertEqual(e["injected_own_bank_count"], SHIPPED_OWN_FLOOR)
        self.assertEqual(e["injected_additional_bank_count"], 4)
        self.assertEqual(e["reserved_own_slots"], SHIPPED_OWN_FLOOR)
        self.assertEqual(e["reserved_additional_slots"], 0)

    def test_own_bank_timeout_is_visible_in_the_log_row(self):
        """A fully timed-out own bank must NOT look healthy: result_count is
        still 6, but the composition fields expose the collapse."""
        import socket

        _run_main_with(
            self._client(bank_exc={OWN: socket.timeout("timed out")}),
            config_extra={
                "recallMaxMemories": SHIPPED_CAP,
                "recallOwnBankMinSlots": SHIPPED_OWN_FLOOR,
                "recallAdditionalBankMinSlots": SHIPPED_ADDITIONAL_FLOOR,
            },
        )
        e = self._read_log()[0]
        self.assertEqual(e["result_count"], 6, "volume telemetry still reads healthy")
        self.assertEqual(e["injected_own_bank_count"], 0, "composition exposes it")
        self.assertEqual(e["injected_additional_bank_count"], 6)
        self.assertTrue(e["deadline_hit"])

    def test_source_bank_key_never_leaks_into_the_injected_block(self):
        ctx, _ = _run_main_with(
            self._client(),
            config_extra={
                "recallMaxMemories": SHIPPED_CAP,
                "recallOwnBankMinSlots": SHIPPED_OWN_FLOOR,
                "recallAdditionalBankMinSlots": SHIPPED_ADDITIONAL_FLOOR,
            },
        )
        self.assertNotIn(recall.SOURCE_BANK_KEY, ctx)
        self.assertNotIn("ken-profile", ctx)

    def test_serial_mode_tags_source_banks_too(self):
        """The serial rollback path (HINDSIGHT_RECALL_PARALLEL=false) must not
        silently lose reservation."""
        ctx, _ = _run_main_with(
            self._client(),
            config_extra={
                "recallMaxMemories": SHIPPED_CAP,
                "recallOwnBankMinSlots": SHIPPED_OWN_FLOOR,
                "recallAdditionalBankMinSlots": SHIPPED_ADDITIONAL_FLOOR,
                "recallParallel": False,
            },
        )
        self.assertIsNotNone(ctx)
        self.assertEqual(
            len([ln for ln in ctx.splitlines() if "own-fact-" in ln]), SHIPPED_OWN_FLOOR
        )
        e = self._read_log()[0]
        self.assertEqual(e["recall_mode"], "serial")
        self.assertEqual(e["injected_own_bank_count"], SHIPPED_OWN_FLOOR)


if __name__ == "__main__":
    unittest.main()
