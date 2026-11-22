"""Finite shared-runtime host for the Linear native seams; no gateway/model bootstrap.

Our own copy of the runner settings the seams need, so they do not import a Core
test module. Admission, epoch recovery, the inbound admission step and settlement
are Core production code; only the runner settings, agent and transport are finite.
Every Core name used here exists in upstream Hermes.
"""
from __future__ import annotations

from pathlib import Path
from types import MethodType, SimpleNamespace
import sys
import tempfile
import unittest


class FiniteAgent:
    """Only an in-memory model endpoint; never executes tools or contacts a provider."""
    _supports_active_turn_redirect = True

    def __init__(self):
        self.effects, self.pending = [], set()
        self.failure = None

    def steer(self, text, *, ticket=None):
        if self.failure == "refuse":
            return False
        self.effects.append(("steer", text, ticket))
        self.pending.add(ticket)
        if self.failure == "unknown":
            raise RuntimeError("finite endpoint lost its acknowledgement after enqueue")
        return True

    def withdraw_steer(self, ticket):
        if ticket not in self.pending:
            return False
        self.pending.remove(ticket)
        return True

    def redirect(self, text):
        self.effects.append(("redirect", text))
        return True

    def interrupt(self, text=None):
        self.effects.append(("interrupt", text))


class NativeRuntimeFixture(unittest.IsolatedAsyncioTestCase):
    """Driven by a seam's own ``asyncSetUp``; it defines no tests."""

    async def asyncSetUp(self):
        self.assertNotIn("gateway.run", sys.modules)
        self.assertNotIn("run_agent", sys.modules)
        from gateway.config import GatewayConfig, Platform
        from gateway.run_busy import GatewayBusySessionMixin
        from gateway.run_inbound import GatewayInboundMixin
        from gateway.session import SessionSource, SessionStore
        from gateway.session_authority import initialize_session_authority
        from hermes_constants import reset_hermes_home_override, set_hermes_home_override
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.addCleanup(reset_hermes_home_override, set_hermes_home_override(self.home))
        self.store = SessionStore(self.home / "sessions", GatewayConfig())
        self.persistence = self.store._scoped_persistence()
        self.addCleanup(self.persistence.close)
        runner = self.runner = SimpleNamespace(session_store=self.store, _session_db=self.persistence, adapters={},
            _draining=False, config=GatewayConfig(), _cached_agent_for=lambda key: None,
            _peek_session_state=lambda key: None, _primary_profile_name="default")
        self.allowed = {"fixture-author", "other-author"}
        runner._adapter_for_source = lambda source: runner.adapters.get(source.platform)
        runner._adapter_flag = lambda *args: False
        runner._adapter_profile_for_source = lambda source: None
        runner._is_user_authorized_for_source = lambda source, **kwargs: source.user_id in self.allowed
        self.authority = await initialize_session_authority(runner, profile_id=str(self.home), instance_id="first")
        self.scheduled = []
        self.authority._schedule = lambda ref: self.scheduled.append(ref)
        self.source = SessionSource(platform=Platform.TELEGRAM, chat_id="fixture-chat", user_id="fixture-author")
        self.adapter = SimpleNamespace()
        runner.adapters[self.source.platform] = self.adapter
        runner._intake_adapter_for = lambda source: runner.adapters.get(source.platform)
        runner._delivery_adapter_for = lambda source: self.adapter
        self.mode = "steer"
        runner._effective_busy_input_mode = lambda source: self.mode
        runner._effective_busy_text_mode = lambda source: "interrupt"
        runner._agent_has_active_subagents = lambda agent: False

        async def no_compression(route):
            return False
        runner._session_has_compression_in_flight = no_compression
        runner._steer_text_with_origin = lambda text, event: text
        runner._steer_active_subagents = GatewayBusySessionMixin._steer_active_subagents
        runner._steer_running_agent = MethodType(GatewayBusySessionMixin._steer_running_agent, runner)
        runner._fold_into_running_turn = lambda *args: None
        runner._reanchor_redirected_turn = lambda *args: None
        self.acks = []

        async def ack(*args, **kwargs):
            self.acks.append(args[0].message_id)
        runner._busy_interrupt_and_ack = ack
        # The authority path admits through the runner's own FIFO step (upstream ``_hm_admit_to_fifo``).
        runner._hm_admit_to_fifo = MethodType(GatewayInboundMixin._hm_admit_to_fifo, runner)

        async def no_consume(*args):
            return False, None
        runner._hm_post_admission_consume = no_consume
        runner._is_session_running = lambda route: True

        async def busy_callback(event, *args):
            return True
        runner._route_plaintext_approval_while_busy = busy_callback
        runner._hm_busy_preempt = busy_callback
        runner._plaintext_approval_words = lambda: {"yes": ("approve", "")}

        async def approval_confirmation(*args):
            return None  # finite transport presentation only
        runner._deliver_approval_confirmation = approval_confirmation
