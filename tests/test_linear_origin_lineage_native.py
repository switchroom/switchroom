"""Retained native physical sessions remain part of the stopped work's evidence."""
from functools import partial
import json
import os
import unittest
from unittest.mock import patch

import test_linear_origin_native as base


class CleanupLineage(base.OriginScenarios):
    def reset(self, parent, suffix):
        from linear_native_db import local_receipt
        from linear_native_db import reset_local_target
        receipt = local_receipt(self.db, self.sid)
        child = parent + suffix
        reset_local_target(self.db, epoch=self.authority.epoch, parent_session_id=parent,
            entry={**receipt["entry"], "session_id": child})
        return child

    async def test_lineage_native_reset_mapping_validation_precedes_sdk_access(self):
        await self.stopped_issue()
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        first = self.reset(self.sid, "-reset")
        tip = self.reset(first, "-again")
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        # Both a retained intermediate reset and the current target are
        # consumed by the actual native lineage validator.
        for child, parent in ((first, self.sid), (tip, first)):
            original = json.dumps({"_reset_from": parent})
            for value in ([], [1], None, "scalar", "", True, False, 1, 0):
                with self.subTest(child=child, value=value):
                    raw = json.dumps(value)
                    self.db.update_session_meta(child, raw)
                    evidence = await self.cleanup_inspected()
                    self.assertEqual(evidence["state"], "unknown")
                    self.assertFalse(evidence["quiescence_proven"])
                    self.assertFalse(evidence["permission_granted"])
                    self.assertEqual(self.db.get_session(child)["model_config"], raw)
            # Native NULL/empty fallback still cannot invent _reset_from.
            for raw in (None, ""):
                self.db.update_session_meta(child, raw)
                self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
            self.db.update_session_meta(child, original)
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_lineage_reset_preflight_preserves_native_scope_and_legacy_absence(self):
        from hermes_fleet_linear_plugin import cleanup
        from hermes_fleet_linear_plugin.native_store import runtime_lineage
        from linear_native_db import POLICY_PREFIX
        await self.stopped_issue()
        # Original native receipts have no explicit lineage and ordinary
        # model_config may be NULL. Neither becomes a new global requirement.
        self.assertIsNone(self.db.get_session(self.sid)["model_config"])
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        tip = self.reset(self.sid, "-reset")
        self.db.create_session("foreign-reset-metadata", source="local")
        self.db.update_session_meta("foreign-reset-metadata", "[]")
        self.db.set_meta(POLICY_PREFIX + "foreign-reset-metadata", "[]")
        # A non-reset model field is not consumed as reset ownership metadata.
        self.db.update_session_meta(self.sid, "[]")
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        with self.db._read_ctx() as conn:
            # A physical target reaches the same logical receipt through
            # chat_id, exactly as the native helper's second lookup does.
            native = runtime_lineage(self.db.persistence, tip)
            observed, _, _, _ = cleanup._runtime_scope(self.db.persistence, conn, tip, "admission-worker:" + self.admission)
            self.assertTrue(native <= observed)
            self.assertIn(self.sid, observed)
        self.db.update_session_meta(tip, json.dumps({"_reset_from": "wrong-parent"}))
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        self.db.update_session_meta(tip, json.dumps({"_reset_from": self.sid, "opaque": [None, {}, []]}))
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_lineage_reset_metadata_arrivals_are_rechecked_without_foreign_repairs(self):
        await self.stopped_issue()
        tip = self.reset(self.sid, "-reset")
        original = {"_reset_from": self.sid}
        for value in ([], {**original, "opaque": [None, {}, []]}):
            self.db.update_session_meta(tip, json.dumps(original))
            def arriving(_method, _params):
                self.before_rpc = None
                self.db.update_session_meta(tip, json.dumps(value))
            self.before_rpc = arriving
            evidence = await self.cleanup_inspected()
            self.assertFalse(evidence["quiescence_proven"])
            self.assertEqual(evidence["state"], "unknown")
            if isinstance(value, dict):
                self.assertEqual(evidence["reason"], "cleanup_evidence_changed")
        self.db.create_session("foreign-lineage-arrival", source="local")
        def foreign(_method, _params):
            self.before_rpc = None
            self.db.update_session_meta("foreign-lineage-arrival", "[]")
        self.before_rpc = foreign
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        self.assertEqual(self.db.get_session("foreign-lineage-arrival")["model_config"], "[]")

    def compressed(self, parent, suffix):
        tip = parent + suffix
        self.db.publish_compression_child(parent_session_id=parent, child_session_id=tip,
            source="local", messages=[{"role": "user", "content": "Finite native checkpoint"}],
            require_compression_lease=False)
        return tip

    def admit(self, target, request):
        from linear_native_db import admit_session_input
        return admit_session_input(self.db, epoch=self.authority.epoch,
            principal_id=self.conn.actor.subject, session_id=target, request_id=request,
            payload={"text": "Finite retained native instruction"})

    def retired_extra_root(self, target, name, *, child=True):
        import psutil
        from hermes_cli.process_identity import worker_birth
        from linear_native_db import (register_worker_execution, adopt_worker_execution,
            reserve_child, mutate_worker_execution)
        generation = self.db._read_all("SELECT runtime_generation FROM sessions WHERE id=?", (target,))[0]["runtime_generation"]
        owned = dict(epoch=self.authority.epoch, execution_id=name, session_id=target, generation=generation)
        register_worker_execution(self.db, **owned, kind="compute", adoption_secret="finite-extra-root")
        adopt_worker_execution(self.db, **owned, adoption_secret="finite-extra-root")
        reserved = None
        if child:
            identity = {"profile_id": str(self.home), "pid": os.getpid(), "birth": worker_birth(psutil.Process())}
            reserved = reserve_child(self.db, **owned, sequence=1, secret="finite-extra-child-secret",
                profile_id=identity["profile_id"], pid=identity["pid"], birth=identity["birth"],
                principal=self.conn.actor.subject, limits=(1, 1))
        mutate_worker_execution(self.db, **owned, sequence=2 if child else 1,
                                operation="execution.finish", payload={})
        return reserved

    async def test_lineage_admissions_remain_owned_through_native_settlement(self):
        from gateway.session_settlement_recovery import _mark_unknown
        from linear_native_db import claim_session_input, resolve_unknown_session_input
        from hermes_fleet_linear_plugin.native_store import runtime_lineage
        await self.stopped_issue()
        tip = self.compressed(self.compressed(self.sid, "-compressed"), "-next")
        self.assertIn(tip, runtime_lineage(self.db.persistence, self.sid))
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        row = self.admit(tip, "retained-physical-work")
        before = self.db._read_all("SELECT * FROM session_admissions")
        held = await self.cleanup_inspected()
        self.assertFalse(held["quiescence_proven"])
        self.assertEqual(held["reason"], "native_session_has_unsettled_work")
        self.assertEqual(before, self.db._read_all("SELECT * FROM session_admissions"))
        claimed = claim_session_input(self.db, epoch=self.authority.epoch, session_id=tip)
        self.assertEqual(claimed["admission_id"], row["admission_id"])
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        self.assertEqual(_mark_unknown(self.authority, claimed), "unknown")
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        resolved = resolve_unknown_session_input(self.db, epoch=self.authority.epoch,
            admission_id=row["admission_id"], generation=claimed["generation"])
        self.assertEqual((resolved["status"], resolved["outcome"]), ("terminal", "interrupted"))
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        self.db.create_session("foreign-physical-session", source="local")
        self.admit("foreign-physical-session", "unrelated-queued-work")
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_lineage_stop_marker_requires_native_clear(self):
        from gateway import session_ancillary
        from gateway.session_contract import SessionRef
        getter = getattr(session_ancillary, "process_stop_pending", None)
        await self.stopped_issue()
        tip = self.compressed(self.sid, "-compressed")
        if getter is not None:
            self.enterContext(patch.object(session_ancillary, "process_stop_pending", getter))
            ref = SessionRef(profile_id=str(self.home), session_id=tip)
            token = session_ancillary.record_process_stop(self.authority, ref, 0)
        else:
            # The release-pinned Core lacks this capability. Preserve the
            # existing synthetic adapter; candidate Core uses its real writers.
            self.db.set_meta("fixture.pending.stop." + tip, "pending")
        evidence = await self.cleanup_inspected()
        self.assertFalse(evidence["quiescence_proven"])
        self.assertEqual(evidence["reason"], "native_stop_checkpoint_pending")
        if getter is not None:
            self.assertEqual(getter(self.db, tip), token)
            session_ancillary.clear_process_stop(self.authority, ref, token)
        else:
            self.db._execute_write(lambda conn: conn.execute(
                "DELETE FROM state_meta WHERE key=?", ("fixture.pending.stop." + tip,)))
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_lineage_arrivals_during_owner_read_are_rechecked(self):
        from linear_native_db import cancel_session_input
        await self.stopped_issue()
        tip = self.compressed(self.sid, "-compressed")
        for kind in ("queued", "settled", "lineage"):
            with self.subTest(kind=kind):
                arrived = []
                def arriving(_method, _params):
                    self.before_rpc = None
                    if kind == "lineage":
                        self.compressed(tip, "-arrived")
                    else:
                        row = self.admit(tip, "arrived-" + kind)
                        arrived.append(row)
                        if kind == "settled":
                            cancel_session_input(self.db, epoch=self.authority.epoch,
                                                 admission_id=row["admission_id"])
                self.before_rpc = arriving
                evidence = await self.cleanup_inspected()
                self.assertFalse(evidence["quiescence_proven"])
                self.assertEqual(evidence["reason"], "native_session_has_unsettled_work" if kind == "queued"
                                 else "cleanup_evidence_changed")
                for row in arrived:
                    cancel_session_input(self.db, epoch=self.authority.epoch,
                                         admission_id=row["admission_id"])
                self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_lineage_of_actual_retired_descendant_keeps_its_admissions(self):
        import psutil
        from hermes_cli.process_identity import worker_birth
        import linear_native_db as runtime
        from linear_native_db import reserve_child, cancel_session_input
        original = runtime.mutate_worker_execution
        children = []
        def reserve_before_finish(db, **args):
            identity = {"profile_id": str(self.home), "pid": os.getpid(), "birth": worker_birth(psutil.Process())}
            child = reserve_child(db, **{k: args[k] for k in
                ("epoch", "execution_id", "session_id", "generation", "sequence")},
                secret="finite-native-child-secret", profile_id=identity["profile_id"], pid=identity["pid"],
                birth=identity["birth"], principal=self.conn.actor.subject, limits=(1, 1))
            children.append(child)
            return original(db, **{**args, "sequence": args["sequence"] + 1})
        with patch.object(runtime, "mutate_worker_execution", reserve_before_finish):
            await self.stopped_issue()
        self.assertEqual(len(children), 1)
        child = children[0]
        saved = self.db._read_all("SELECT status FROM worker_executions WHERE execution_id=?",
                                           (child["execution_id"],))
        self.assertEqual(saved[0]["status"], "terminal")
        tip = self.compressed(child["session_id"], "-compressed")
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        row = self.admit(tip, "retained-descendant-work")
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        cancel_session_input(self.db, epoch=self.authority.epoch, admission_id=row["admission_id"])
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_lineage_all_retained_roots_and_descendant_compressions_are_closed(self):
        from linear_native_db import cancel_session_input
        await self.stopped_issue()
        target = self.sid
        for index in range(3):
            # Independent compute roots deliberately do not share the primary
            # admission-worker prefix. The session binding establishes scope.
            target = self.compressed(target, "-continued")
            child = self.retired_extra_root(target, "independent-retained-root-" + str(index))
            target = child["session_id"]
            self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        target = self.compressed(target, "-last")
        row = self.admit(target, "deep-retained-native-work")
        before = self.db._read_all("SELECT * FROM worker_executions")
        held = await self.cleanup_inspected()
        self.assertFalse(held["quiescence_proven"])
        self.assertEqual(held["reason"], "native_session_has_unsettled_work")
        self.assertEqual(before, self.db._read_all("SELECT * FROM worker_executions"))
        cancel_session_input(self.db, epoch=self.authority.epoch, admission_id=row["admission_id"])
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        self.db.set_meta("fixture.pending.stop." + target, "pending")
        self.assertEqual((await self.cleanup_inspected())["reason"], "native_stop_checkpoint_pending")
        self.db._execute_write(lambda conn: conn.execute(
            "DELETE FROM state_meta WHERE key=?", ("fixture.pending.stop." + target,)))
        self.db.create_session("foreign-extra-root-session", source="local")
        foreign = self.retired_extra_root("foreign-extra-root-session", "independent-retained-root-foreign")
        self.admit(foreign["session_id"], "foreign-descendant-queued-work")
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_lineage_extra_retained_roots_arriving_during_owner_read_change_digest(self):
        from linear_native_db import cancel_session_input
        await self.stopped_issue()
        tip = self.compressed(self.sid, "-continued")
        for kind in ("terminal-root", "terminal-child", "settled-child", "queued-child"):
            with self.subTest(kind=kind):
                admitted = []
                def arriving(_method, _params):
                    self.before_rpc = None
                    child = self.retired_extra_root(tip, "arrived-extra-" + kind, child=kind != "terminal-root")
                    if kind in ("settled-child", "queued-child"):
                        row = self.admit(child["session_id"], "arrived-extra-work-" + kind)
                        admitted.append(row)
                        if kind == "settled-child":
                            cancel_session_input(self.db, epoch=self.authority.epoch,
                                                 admission_id=row["admission_id"])
                self.before_rpc = arriving
                evidence = await self.cleanup_inspected()
                self.assertFalse(evidence["quiescence_proven"])
                self.assertEqual(evidence["reason"], "native_session_has_unsettled_work" if kind == "queued-child"
                                 else "cleanup_evidence_changed")
                for row in admitted:
                    cancel_session_input(self.db, epoch=self.authority.epoch,
                                         admission_id=row["admission_id"])
                self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_lineage_native_worker_writer_contracts_keep_valid_history(self):
        from linear_native_db import (RuntimeStoreError, begin_runtime_epoch, claim_session_input,
            register_worker_execution, adopt_worker_execution, mutate_worker_execution, settle_session_input)
        await self.stopped_issue()
        for kind in ("cron", "child", "compute", "kanban"):
            row = self.admit(self.sid, "native-worker-kind-" + kind)
            claimed = claim_session_input(self.db, epoch=self.authority.epoch, session_id=self.sid)
            self.assertEqual(row["admission_id"], claimed["admission_id"])
            owned = dict(epoch=self.authority.epoch, execution_id="native-kind-" + kind,
                         session_id=self.sid, generation=claimed["generation"])
            register_worker_execution(self.db, **owned, kind=kind, adoption_secret="finite-native-kind")
            adopt_worker_execution(self.db, **owned, adoption_secret="finite-native-kind")
            for bad in (None, 0, -1, True, "1", 1.5):
                with self.subTest(kind=kind, bad_sequence=bad):
                    with self.assertRaises(RuntimeStoreError):
                        mutate_worker_execution(self.db, **owned, sequence=bad,
                                                operation="execution.finish", payload={})
            for bad in (None, "future-kind", b"compute", ""):
                with self.subTest(bad_kind=bad), self.assertRaises(RuntimeStoreError):
                    register_worker_execution(self.db, **owned, kind=bad, adoption_secret="finite-native-kind")
            for key in ("epoch", "generation"):
                for bad in (None, True, "1", 1.5):
                    with self.subTest(key=key, bad=bad), self.assertRaises(RuntimeStoreError):
                        register_worker_execution(self.db, **{**owned, key: bad},
                                                  kind=kind, adoption_secret="finite-native-kind")
            # The actual settlement writer can retire a registered/adopted
            # execution without any worker receipt: terminal sequence zero is valid.
            settle_session_input(self.db, epoch=self.authority.epoch,
                admission_id=row["admission_id"], generation=claimed["generation"], outcome="interrupted")
            stored = self.db._read_all("SELECT status,last_sequence FROM worker_executions WHERE execution_id=?",
                                                (owned["execution_id"],))[0]
            self.assertEqual((stored["status"], stored["last_sequence"]), ("terminal", 0))
            self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        # Epoch advancement is a real native storage writer, not a claim of
        # gateway restart. Older terminal owner epochs and generations remain valid.
        self.authority.epoch = begin_runtime_epoch(self.db, instance_id=self.authority.instance_id)
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_lineage_owned_worker_schema_faults_are_held_without_repair(self):
        await self.stopped_issue()
        name = "owned-worker-schema-fault"
        self.retired_extra_root(self.sid, name, child=False)
        original = self.db._read_all("SELECT * FROM worker_executions WHERE execution_id=?", (name,))[0]
        # Explicit retained-schema corruption fixture: CHECK bypass does not
        # bypass NOT NULL. Relax only this fixture table's NOT NULL declarations
        # so actual NULL rows reach the read-only inspector; no production repair.
        def allow_null_faults(conn):
            schema = conn.execute("SELECT sql FROM sqlite_schema WHERE name='worker_executions'").fetchone()[0]
            conn.execute("PRAGMA writable_schema=ON")
            try:
                conn.execute("UPDATE sqlite_schema SET sql=? WHERE name='worker_executions'",
                             (schema.replace("TEXT NOT NULL", "TEXT").replace("INTEGER NOT NULL", "INTEGER"),))
                version = conn.execute("PRAGMA schema_version").fetchone()[0]
                conn.execute("PRAGMA schema_version=" + str(version + 1))
            finally:
                conn.execute("PRAGMA writable_schema=OFF")
        self.db._execute_write(allow_null_faults)
        def update(column, value, target=name):
            def write(conn):
                conn.execute("PRAGMA ignore_check_constraints=ON")
                try:
                    conn.execute(f"UPDATE worker_executions SET {column}=? WHERE execution_id=?", (value, target))
                finally:
                    conn.execute("PRAGMA ignore_check_constraints=OFF")
            self.db._execute_write(write)
        cases = {"kind": ("future-kind", b"compute", None),
                 "status": ("future-status", b"terminal", None),
                 "owner_epoch": (0, -1, self.authority.epoch + 1, 1.5, b"1", None),
                 "generation": (-1, self.row["generation"] + 1, 1.5, b"1", None),
                 "last_sequence": (-1, 1.5, b"1", None)}
        for column, values in cases.items():
            for value in values:
                with self.subTest(column=column, value=value):
                    update(column, value)
                    try:
                        before = self.db._read_all("SELECT * FROM worker_executions WHERE execution_id=?", (name,))
                        result = await self.cleanup_inspected()
                        self.assertFalse(result["quiescence_proven"])
                        self.assertEqual(result["reason"], "native_worker_state_unreadable")
                        self.assertEqual(before, self.db._read_all("SELECT * FROM worker_executions WHERE execution_id=?", (name,)))
                    finally:
                        update(column, original[column])
        def arriving(_method, _params):
            self.before_rpc = None
            update("kind", "future-kind")
        self.before_rpc = arriving
        self.assertEqual((await self.cleanup_inspected())["reason"], "native_worker_state_unreadable")
        update("kind", original["kind"])
        self.db.create_session("foreign-worker-schema-session", source="local")
        foreign = "foreign-worker-schema-fault"
        self.retired_extra_root("foreign-worker-schema-session", foreign, child=False)
        for column, value in (("kind", b"future-kind"), ("status", "future-status"),
                              ("owner_epoch", -1), ("generation", None), ("last_sequence", None)):
            update(column, value, foreign)
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_lineage_owned_worker_missing_native_session_is_unknown(self):
        await self.stopped_issue()
        child = self.retired_extra_root(self.sid, "retained-native-fk-root")
        # A retained descendant still belongs to the root by its native
        # execution range even when its session foreign key is corrupted.
        self.db._conn.execute("PRAGMA foreign_keys=OFF")
        try:
            self.db._execute_write(lambda conn: conn.execute(
                "UPDATE worker_executions SET session_id='missing-native-session' WHERE execution_id=?",
                (child["execution_id"],)))
        finally:
            self.db._conn.execute("PRAGMA foreign_keys=ON")
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])

    async def test_lineage_native_admission_payloads_intents_and_legacy_nulls_remain_valid(self):
        import json
        from linear_native_db import (RuntimeStoreError, _import_legacy_row, _json,
            admit_session_input, cancel_session_input)
        await self.stopped_issue()
        for intent in ("queue", "steer", "redirect"):
            row = admit_session_input(self.db, epoch=self.authority.epoch,
                principal_id=" ", session_id=self.sid, request_id="native-intent-" + intent,
                payload={"arbitrary_payload": {"nested": [None, True, 2]}, "text": None}, intent=intent)
            cancel_session_input(self.db, epoch=self.authority.epoch, admission_id=row["admission_id"])
            self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        for index, (outcome, generation) in enumerate((("completed", None), ("cancelled", None),
                                                      ("steered", None), ("completed", self.row["generation"] + 7))):
            legacy = dict(admission_id="finite-legacy-null-" + str(index), target_session_id=self.sid, root=self.sid,
                lineage=json.dumps([self.sid]), payload=json.dumps({}), status="terminal", generation=generation, outcome=outcome)
            self.db._execute_write(lambda conn: _import_legacy_row(conn, legacy, self.authority.epoch, "legacy"))
        # Nullable terminal epoch is permitted by the retained native schema;
        # it is not substituted for the exact primary executor/owner proof.
        self.db._execute_write(lambda conn: conn.execute(
            "UPDATE session_admissions SET owner_epoch=NULL WHERE admission_id='finite-legacy-null-0'"))
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        for payload in ([], None, {"not_finite": float("nan")}):
            with self.subTest(payload=payload), self.assertRaises(RuntimeStoreError):
                _json(payload)

    async def test_lineage_owned_admission_consumed_fields_require_native_contracts(self):
        from linear_native_db import cancel_session_input
        await self.stopped_issue()
        row = self.admit(self.sid, "owned-admission-schema-fault")
        cancel_session_input(self.db, epoch=self.authority.epoch, admission_id=row["admission_id"])
        original = self.db._read_all("SELECT rowid AS native_rowid,* FROM session_admissions WHERE admission_id=?",
                                             (row["admission_id"],))[0]
        def allow_null_faults(conn):
            schema = conn.execute("SELECT sql FROM sqlite_schema WHERE name='session_admissions'").fetchone()[0]
            conn.execute("PRAGMA writable_schema=ON")
            try:
                conn.execute("UPDATE sqlite_schema SET sql=? WHERE name='session_admissions'",
                             (schema.replace("TEXT NOT NULL", "TEXT").replace("INTEGER NOT NULL", "INTEGER"),))
                version = conn.execute("PRAGMA schema_version").fetchone()[0]
                conn.execute("PRAGMA schema_version=" + str(version + 1))
            finally:
                conn.execute("PRAGMA writable_schema=OFF")
        self.db._execute_write(allow_null_faults)
        def update(column, value, seq=None):
            def write(conn):
                conn.execute("PRAGMA ignore_check_constraints=ON")
                try:
                    conn.execute(f"UPDATE session_admissions SET {column}=? WHERE seq=?",
                                 (value, original["seq"] if seq is None else seq))
                finally:
                    conn.execute("PRAGMA ignore_check_constraints=OFF")
            self.db._execute_write(write)
        cases = {"intent": ("future-native-intent", b"queue", None),
                 "admission_id": ("", b"opaque-id", None), "request_id": ("", b"opaque-request", None),
                 "principal_id": ("", b"opaque-principal", None),
                 "owner_epoch": (0, -1, self.authority.epoch + 1, 1.5, b"1"),
                 "generation": (-1, self.row["generation"] + 1, 1.5, b"1"),
                 "payload_json": ("[]", "null", "1", '{"not_finite":NaN}')}
        for column, values in cases.items():
            for value in values:
                with self.subTest(column=column, value=value):
                    update(column, value)
                    try:
                        before = self.db._read_all("SELECT * FROM session_admissions WHERE seq=?", (original["seq"],))
                        result = await self.cleanup_inspected()
                        self.assertFalse(result["quiescence_proven"])
                        self.assertEqual(result["reason"], "native_admission_state_unreadable")
                        self.assertEqual(before, self.db._read_all("SELECT * FROM session_admissions WHERE seq=?", (original["seq"],)))
                    finally:
                        update(column, original[column])
        for seq in (0, -1):
            with self.subTest(seq=seq):
                update("seq", seq)
                try:
                    self.assertEqual((await self.cleanup_inspected())["reason"], "native_admission_state_unreadable")
                finally:
                    update("seq", original["seq"], seq=seq)
        def arriving(_method, _params):
            self.before_rpc = None
            update("intent", "future-native-intent")
        self.before_rpc = arriving
        self.assertEqual((await self.cleanup_inspected())["reason"], "native_admission_state_unreadable")
        update("intent", original["intent"])
        self.db.create_session("foreign-admission-schema-session", source="local")
        foreign = self.admit("foreign-admission-schema-session", "foreign-admission-schema-fault")
        # Payload/record defects with positively foreign selectors remain outside
        # this inspection; do not parse or repair unrelated foreign payloads.
        self.db._execute_write(lambda conn: conn.execute(
            "UPDATE session_admissions SET payload_json='not-json',principal_id=NULL WHERE admission_id=?",
            (foreign["admission_id"],)))
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])

    async def test_lineage_native_physical_admission_join_cannot_hide_behind_foreign_target(self):
        import json
        from gateway.session_settlement_recovery import _mark_unknown
        from linear_native_db import claim_session_input, linked_worker_admission
        await self.stopped_issue()
        foreign = "foreign-logical-target"
        self.db.create_session(foreign, source="local")
        row = self.admit(foreign, "foreign-target-physical-join")
        claimed = claim_session_input(self.db, epoch=self.authority.epoch, session_id=foreign)
        self.assertEqual(row["admission_id"], claimed["admission_id"])
        # Genuine foreign native work is outside this task's scope.
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        def target_lineage(target):
            self.db._execute_write(lambda conn: conn.execute(
                "UPDATE session_admissions SET lineage_json=? WHERE admission_id=?",
                (json.dumps([target]), row["admission_id"])))
        # Explicit retained identity fault: prove the actual native adoption
        # predicate sees this as an owned physical claim before testing cleanup.
        target_lineage(self.sid)
        with self.db._read_ctx() as conn:
            linked = linked_worker_admission(conn, self.sid, self.row["generation"], self.authority.epoch,
                                              ("started", "unknown"))
        self.assertEqual(linked["admission_id"], row["admission_id"])
        self.assertEqual((await self.cleanup_inspected())["reason"], "native_session_has_unsettled_work")
        self.assertEqual(_mark_unknown(self.authority, claimed), "unknown")
        self.assertFalse((await self.cleanup_inspected())["quiescence_proven"])
        target_lineage(foreign)
        self.db._execute_write(lambda conn: conn.execute(
            "UPDATE session_admissions SET payload_json='not-json' WHERE admission_id=?", (row["admission_id"],)))
        self.assertTrue((await self.cleanup_inspected())["quiescence_proven"])
        def arriving(_method, _params):
            self.before_rpc = None
            target_lineage(self.sid)
        self.before_rpc = arriving
        self.assertEqual((await self.cleanup_inspected())["reason"], "native_session_has_unsettled_work")


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(CleanupLineage(name) for name in loader.getTestCaseNames(CleanupLineage)
                              if name.startswith("test_lineage_"))
