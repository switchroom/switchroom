"""Native Linear owner evidence plus the real scoped API over a finite transport.

Only native admission fixtures and the synthetic provider transport are used;
there is no model, gateway bootstrap, credential store or real provider network.
"""
from __future__ import annotations

import asyncio
from dataclasses import replace
import json
from types import SimpleNamespace
import unittest

import test_linear_origin_native as fixtures
from test_linear_specialist_authorization import Authority, ORG, VIEWER, USER, ISSUE, SESSION, ACTIVITY, TEAM, PROJECT

plugin = fixtures.plugin
from hermes_fleet_linear_plugin import origin, transport


@unittest.skipUnless(fixtures.SOURCE and fixtures.GUARDED_ROOT, "requires guarded native origin entrypoint")
class LinearProviderOriginScenarios(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = fixtures.OriginScenarios.asyncSetUp
    claim = fixtures.OriginScenarios.claim
    bind = fixtures.OriginScenarios.bind
    during_origin_readback = fixtures.OriginScenarios.during_origin_readback

    async def linear(self, *, assignment=False):
        from gateway.config import Platform
        from gateway.platforms.event import MessageEvent
        from gateway.platform_registry import PlatformEntry, platform_registry
        from gateway.session import SessionSource
        platform_registry.register(PlatformEntry("linear", "Linear", lambda config: None, lambda: True),
                                   scope=str(self.home))
        self.addCleanup(platform_registry.unregister, "linear", scope=str(self.home))
        self.provider = Authority()
        self.api = self.provider.api()
        self.settings = {"identity": {"viewer_id": VIEWER, "organization_id": ORG},
                         "specialist_scope": {"allowed_team_ids": [TEAM], "allowed_project_ids": [PROJECT],
                                              "allowed_requester_ids": [USER]}}
        message = SESSION if assignment else ACTIVITY
        source = SessionSource(platform=Platform("linear"), chat_id=ISSUE, thread_id=SESSION,
                               scope_id=ORG, user_id=USER, message_id=message, is_bot=False)
        self.runner.adapters[source.platform] = SimpleNamespace()
        # This is the consumer author's frozen NativeInput.message contract.
        # The authoritative sender and provider IDs are then read independently
        # from the actual committed native owner row, not from this test object.
        self.event = MessageEvent(text="Continue the authorized remaining work", source=source,
            user_id=USER, message_id=message, allow_gateway_control=False)
        receipt = await self.authority.admit_native(self.event)
        self.sid, self.admission, self.ref = receipt.ref.session_id, receipt.admission_id, receipt.ref
        self.claim()
        self.bind("linear", self.sid, user=USER, chat=ISSUE, thread=SESSION, scope=ORG)

    async def current(self, *, api=True):
        return await asyncio.to_thread(origin.current, transport.capture_context(), self.settings,
                                       api=self.api if api else None)

    async def inspected(self, ref, *, api=True):
        return await asyncio.to_thread(origin.inspect, ref, self.settings, api=self.api if api else None)

    async def test_provider_is_freshly_reverified_after_owner_readback(self):
        await self.linear()
        ref = (await self.current())["reference"]
        self.provider.requests.clear()
        evidence = await self.inspected(ref)
        self.assertEqual(evidence["provider_verification"]["state"], "verified")
        self.assertGreaterEqual(sum("AgentActivityAuthorization" in query for query in self.provider.requests), 2)
        self.during_origin_readback(lambda: self.provider.activities[ACTIVITY].update(user={"id": VIEWER}))
        with self.assertRaises(transport.Unavailable):
            await self.inspected(ref)
        self.assertEqual(self.provider.mutations, [])

    async def test_activity_roundtrip_verifies_exact_provider_actor_and_keeps_reference_opaque(self):
        await self.linear()
        result = await self.current()
        self.assertEqual(result["provider_verification"]["state"], "verified")
        self.assertFalse(result["permission_granted"])
        self.assertEqual(set(result["reference"]), origin.REFERENCE_FIELDS)
        inspected = await self.inspected(result["reference"])
        self.assertEqual(inspected["requester"]["message_id"], ACTIVITY)
        self.assertEqual(inspected["requester"]["user_id"], USER)
        self.assertEqual(inspected["original_message"], self.event.text)
        self.assertEqual(inspected["provider_verification"]["state"], "verified")
        self.assertFalse(inspected["permission_granted"])
        self.assertTrue(any("AgentActivityAuthorization" in query for query in self.provider.requests))
        self.assertEqual(self.provider.mutations, [])

    async def test_assignment_roundtrip_uses_actual_session_creator_not_app_or_issue_creator(self):
        await self.linear(assignment=True)
        result = await self.current()
        self.assertEqual(result["provider_verification"]["state"], "verified")
        self.assertFalse(any("AgentActivityAuthorization" in query for query in self.provider.requests))
        self.provider.sessions[SESSION]["creator"] = {"id": VIEWER}
        with self.assertRaises(transport.Unavailable):
            await self.inspected(result["reference"])
        self.provider.sessions[SESSION]["creator"] = None
        with self.assertRaises(transport.Unavailable):
            await self.inspected(result["reference"])

    async def test_later_real_activity_actor_is_verified_when_assignment_creator_was_unknown(self):
        await self.linear()
        self.provider.sessions[SESSION]["creator"] = None
        result = await self.current()
        inspected = await self.inspected(result["reference"])
        self.assertEqual(inspected["provider_verification"]["state"], "verified")
        self.assertEqual(inspected["requester"]["user_id"], USER)
        self.assertEqual(inspected["requester"]["message_id"], ACTIVITY)
        self.assertFalse(inspected["permission_granted"])

    async def test_later_cli_without_existing_api_honestly_needs_provider_verification(self):
        await self.linear()
        result = await self.current()
        self.provider.requests.clear()
        inspected = await self.inspected(result["reference"], api=False)
        self.assertEqual(inspected["provider_verification"],
                         {"state": "needed", "source": "existing_linear_api_unavailable"})
        self.assertFalse(inspected["permission_granted"])
        self.assertEqual(self.provider.requests, [])

    async def test_foreign_activity_actor_or_session_and_changed_app_org_issue_are_refused(self):
        await self.linear()
        ref = (await self.current())["reference"]
        original = json.loads(json.dumps(self.provider.activities[ACTIVITY]))
        cases = [lambda: self.provider.activities[ACTIVITY].update(user={"id": VIEWER}),
                 lambda: self.provider.activities[ACTIVITY].update(agentSession={"id": "foreign"}),
                 lambda: self.provider.sessions[SESSION].update(appUser={"id": "foreign"}),
                 # A credential cannot change workspace; a different one is proved again.
                 lambda: (setattr(self.provider, "organization", "foreign"),
                          setattr(self.api, "token", lambda: "synthetic-other-workspace")),
                 lambda: self.provider.sessions[SESSION].update(issue={"id": "foreign"})]
        for change in cases:
            self.provider.activities[ACTIVITY] = json.loads(json.dumps(original))
            self.provider.sessions[SESSION] = {"id": SESSION, "creator": {"id": USER},
                "appUser": {"id": VIEWER}, "issue": {"id": ISSUE}}
            self.provider.organization = ORG
            change()
            with self.subTest(change=change), self.assertRaises(transport.Unavailable):
                await self.inspected(ref)
        self.assertEqual(self.provider.mutations, [])

    async def test_context_actor_spoof_and_control_payload_are_refused_before_provider_access(self):
        await self.linear()
        self.provider.requests.clear()
        context = replace(transport.capture_context(), user_id="foreign")
        with self.assertRaises(transport.Unavailable):
            await asyncio.to_thread(origin.current, context, self.settings, api=self.api)
        row = self.db._read_one("SELECT payload_json FROM session_admissions WHERE admission_id=?",
                                         (self.admission,))
        payload = json.loads(row[0])
        payload["native_text_v1"]["event"]["structured_control"] = "stop"
        self.db._execute_write(lambda conn: conn.execute(
            "UPDATE session_admissions SET payload_json=? WHERE admission_id=?", (json.dumps(payload), self.admission)))
        with self.assertRaises(transport.Unavailable):
            await self.current()
        self.assertEqual(self.provider.requests, [])

    async def test_bot_automation_missing_actor_and_command_flags_cannot_supply_human_origin(self):
        await self.linear()
        row = self.db._read_one("SELECT payload_json FROM session_admissions WHERE admission_id=?",
                                         (self.admission,))
        original = json.loads(row[0])
        self.provider.requests.clear()
        cases = [lambda payload: payload["native_text_v1"]["source"].update(is_bot=True),
                 lambda payload: payload["native_text_v1"].update(automation={"heartbeat": True}),
                 lambda payload: payload["native_text_v1"]["source"].update(user_id=None),
                 lambda payload: payload["native_text_v1"]["event"].update(allow_gateway_control=True)]
        for change in cases:
            payload = json.loads(json.dumps(original))
            change(payload)
            self.db._execute_write(lambda conn: conn.execute(
                "UPDATE session_admissions SET payload_json=? WHERE admission_id=?", (json.dumps(payload), self.admission)))
            with self.subTest(change=change), self.assertRaises(transport.Unavailable):
                await self.current()
        self.assertEqual(self.provider.requests, [])

    async def test_missing_original_provider_id_needs_verification_without_inventing_one(self):
        await self.linear()
        row = self.db._read_one("SELECT payload_json FROM session_admissions WHERE admission_id=?",
                                         (self.admission,))
        payload = json.loads(row[0])
        payload["native_text_v1"]["event"]["message_id"] = None
        payload["native_text_v1"]["source"].pop("message_id")
        self.db._execute_write(lambda conn: conn.execute(
            "UPDATE session_admissions SET payload_json=? WHERE admission_id=?", (json.dumps(payload), self.admission)))
        self.provider.requests.clear()
        result = await self.current()
        self.assertEqual(result["provider_verification"],
                         {"state": "needed", "source": "original_provider_message_id_unavailable"})
        self.assertEqual(self.provider.requests, [])
