"""Consumed native mapping shapes refuse without changing optional native metadata."""
import argparse
import asyncio
import json
import unittest
from unittest.mock import patch

import test_linear_origin_native as base
from hermes_fleet_linear_plugin import ops, origin_state, transport


BAD = ([], [1], "scalar", "", True, False, 1, 0, 0.5)


class MappingScenarios(base.OriginScenarios):
    def payload(self):
        return json.loads(self.db._read_one(
            "SELECT payload_json FROM session_admissions WHERE admission_id=?", (self.admission,))[0])

    def write_payload(self, value):
        self.db._execute_write(lambda conn: conn.execute(
            "UPDATE session_admissions SET payload_json=? WHERE admission_id=?", (json.dumps(value), self.admission)))

    def policy(self):
        from linear_native_db import local_receipt
        return local_receipt(self.db, self.sid)

    def write_policy(self, value):
        from linear_native_db import POLICY_PREFIX
        self.db.set_meta(POLICY_PREFIX + self.sid, json.dumps(value))

    async def owner_cli_refused(self, action, ref):
        parser = argparse.ArgumentParser()
        ops.setup(parser)
        args = parser.parse_args([action, "--reference-json", json.dumps(ref)])
        with patch("builtins.print") as printed:
            rc = await asyncio.to_thread(ops.run, args, self.home / "unused", self.home / "unused", "default",
                                         origin_settings=self.settings)
        self.assertEqual(rc, 1)
        self.assertFalse(json.loads(printed.call_args.args[0])["ok"])

    async def test_mapping_origin_primary_payloads_and_owner_cli(self):
        from linear_native_db import _json, RuntimeStoreError
        await self.local()
        ref = (await self.current())["reference"]
        original = self.payload()
        for value in (*BAD, None):
            with self.subTest(value=value):
                with self.assertRaises(RuntimeStoreError):
                    _json(value)
                self.write_payload(value)  # Explicit retained-row fault after actual native admission/claim.
                with self.assertRaises(transport.Unavailable):
                    await self.current()
                await self.owner_cli_refused("inspect-origin", ref)
                self.assertEqual(self.payload(), value)
        self.write_payload(original)
        self.assertFalse((await self.inspected(ref))["permission_granted"])

    async def test_mapping_cli_and_api_envelopes_use_native_author_decoder(self):
        from agent.turn_author import parse_turn_author
        from gateway.session_cli_turn import admit_cli_turn
        await self.local()
        ref = (await self.current())["reference"]
        original = self.payload()
        for key in ("cli_turn_v1", "api_turn_v1"):
            for value in BAD:
                with self.subTest(key=key, value=value):
                    self.write_payload({**original, key: value})
                    with self.assertRaises(transport.Unavailable):
                        await self.inspected(ref)
        author = {"id": "native human", "is_bot": False}
        committed = admit_cli_turn({"turn_author": author})
        self.assertEqual(committed["cli_turn_v1"]["turn_author"], parse_turn_author(author))
        # Native author parsing accepts JSON strings too; do not impose a new
        # mapping contract on the optional author value inside a valid envelope.
        for envelope in (None, {}, committed["cli_turn_v1"], {"turn_author": json.dumps(author)}):
            self.write_payload({**original, "cli_turn_v1": envelope})
            self.assertFalse((await self.inspected(ref))["permission_granted"])

    async def test_mapping_native_text_envelope_source_and_event(self):
        await self.messaging("telegram")
        ref = (await self.current())["reference"]
        original = self.payload()
        for location in ("native_text_v1", "source", "event"):
            for value in (*BAD, None):
                with self.subTest(location=location, value=value):
                    payload = json.loads(json.dumps(original))
                    if location == "native_text_v1":
                        payload[location] = value
                    else:
                        payload["native_text_v1"][location] = value
                    self.write_payload(payload)
                    with self.assertRaises(transport.Unavailable):
                        await self.inspected(ref)
        self.write_payload(original)
        self.assertEqual((await self.inspected(ref))["requester"]["platform"], "telegram")

    async def test_mapping_api_settings_optional_null_and_valid_dictionary(self):
        await self.api()
        ref = (await self.current())["reference"]
        original = self.payload()
        for value in BAD:
            with self.subTest(value=value):
                payload = json.loads(json.dumps(original))
                payload["api_turn_v1"]["settings"] = value
                self.write_payload(payload)
                with self.assertRaises(transport.Unavailable):
                    await self.inspected(ref)
        for value in (None, {}, {"opaque": {"nested": [None, [], {}]}}):
            payload = json.loads(json.dumps(original))
            payload["api_turn_v1"]["settings"] = value
            self.write_payload(payload)
            self.assertFalse((await self.inspected(ref))["permission_granted"])
        payload["api_turn_v1"].pop("settings")
        self.write_payload(payload)
        self.assertFalse((await self.inspected(ref))["permission_granted"])

    async def test_mapping_work_primary_payload_on_initial_and_owner_reads(self):
        await self.kanban()
        ref = (await self.work_current())["reference"]
        original = self.payload()
        for value in (*BAD, None):
            self.write_payload(value)
            await self.owner_cli_refused("inspect-work", ref)
        self.write_payload(original)
        def arriving(_method, _params):
            self.before_rpc = None
            self.write_payload([])
        # First native snapshot is valid; fault arrives before work._projection.
        self.before_rpc = arriving
        with self.assertRaises(transport.Unavailable):
            await self.work_inspected(ref)

    async def test_mapping_work_events_preserve_native_optional_null(self):
        from hermes_cli import kanban_db as kb
        from hermes_fleet_linear_plugin.transport import native_json_object
        await self.kanban()
        ref = (await self.work_current())["reference"]
        for kind in ("claimed", "owner_admitted", "worker_bound"):
            row = self.board.execute("SELECT * FROM task_events WHERE task_id=? AND kind=?", (self.task_id, kind)).fetchone()
            for value in BAD:
                with self.subTest(kind=kind, value=value):
                    encoded = json.dumps(value)
                    self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (encoded, row["id"]))
                    await self.owner_cli_refused("inspect-work", ref)
                    self.assertEqual(self.board.execute("SELECT payload FROM task_events WHERE id=?", (row["id"],)).fetchone()[0], encoded)
            for raw in (None, "null"):
                self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (raw, row["id"]))
                native_row = self.board.execute("SELECT * FROM task_events WHERE id=?", (row["id"],)).fetchone()
                self.assertIsNone(kb.Event.from_row(native_row).payload)
                self.assertIsNone(native_json_object(raw, allow_null=True))
                if kind == "claimed":
                    self.assertFalse((await self.work_inspected(ref))["permission_granted"])
                else:
                    with self.assertRaises(transport.Unavailable):
                        await self.work_inspected(ref)
            self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (row["payload"], row["id"]))
        fresh = (await self.work_current())["reference"]
        self.assertFalse((await self.work_inspected(fresh))["permission_granted"])

    async def test_mapping_work_frozen_context_and_request_json(self):
        from gateway.session_policy import restore_policy
        await self.kanban()
        ref = (await self.work_current())["reference"]
        original = self.policy()
        for field in ("kanban_json", "request_json"):
            for value in (*BAD, None):
                with self.subTest(field=field, value=value):
                    saved = json.loads(json.dumps(original))
                    saved["policy"][field] = json.dumps(value)
                    self.write_policy(saved)
                    await self.owner_cli_refused("inspect-work", ref)
            saved = json.loads(json.dumps(original))
            value = json.loads(saved["policy"][field])
            value["opaque"] = {"nested": [None, [], {}]}
            saved["policy"][field] = json.dumps(value)
            restore_policy(saved["policy"])
            self.write_policy(saved)
            fresh = (await self.work_current())["reference"]
            self.assertFalse((await self.work_inspected(fresh))["permission_granted"])
        self.write_policy(original)

    async def test_mapping_origin_and_work_second_read_faults_refuse(self):
        await self.api()
        ref = (await self.current())["reference"]
        original = self.payload()
        def origin_fault():
            payload = json.loads(json.dumps(original))
            payload["api_turn_v1"]["settings"] = []
            self.write_payload(payload)
        self.during_origin_readback(origin_fault)
        with self.assertRaises(transport.Unavailable):
            await self.inspected(ref)
        self.before_rpc = None
        self.write_payload(original)
        await self.kanban()
        ref = (await self.work_current())["reference"]
        saved = self.policy()
        event = self.board.execute("SELECT * FROM task_events WHERE task_id=? AND kind='worker_bound'", (self.task_id,)).fetchone()
        for location in ("worker_bound", "kanban_json", "request_json"):
            def change():
                if location == "worker_bound":
                    self.board.execute("UPDATE task_events SET payload='[]' WHERE id=?", (event["id"],))
                else:
                    value = json.loads(json.dumps(saved))
                    value["policy"][location] = '[]'
                    self.write_policy(value)
            self.during_origin_readback(change)
            with self.assertRaises(transport.Unavailable):
                await self.work_inspected(ref)
            self.before_rpc = None
            self.board.execute("UPDATE task_events SET payload=? WHERE id=?", (event["payload"], event["id"]))
            self.write_policy(saved)


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(MappingScenarios(name) for name in loader.getTestCaseNames(MappingScenarios)
                              if name.startswith("test_mapping_"))
