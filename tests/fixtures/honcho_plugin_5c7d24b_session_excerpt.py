"""Excerpt of the pinned plastic-labs/honcho hermes-plugin-honcho session.py at 5c7d24b3 (pre-HF-757 patch).

Verbatim lines: the typing import and the observation-flag code of HonchoSessionManager. The rest
of the class is omitted; tests run it under the provider init excerpt.
"""

from __future__ import annotations

from typing import Any, TYPE_CHECKING


class HonchoSessionManager:
    def __init__(self, config=None):
        self._config = config
        # Behavior knobs copied from config (HonchoClientConfig defaults when absent); the
        # observation booleans map 1:1 to Honcho's SessionPeerConfig toggles.
        for name, default in (
            ("write_frequency", "async"), ("dialectic_reasoning_level", "low"), ("dialectic_dynamic", True),
            ("dialectic_max_chars", 600), ("dialectic_max_input_chars", 10000),
            ("user_observe_me", True), ("user_observe_others", True),
            ("ai_observe_me", True), ("ai_observe_others", True),
        ):
            setattr(self, f"_{name}", getattr(config, name) if config else default)
        self._turn_counter: int = 0
        self._session_observation: dict[str, dict[str, bool]] = {}

    def _observation_flags(self, honcho_session_id: str) -> dict[str, bool]:
        """The four observation booleans for one session: the values synced from that session's
        server config once setup ran, else the config snapshot held on the manager."""
        synced = self._session_observation.get(honcho_session_id)
        if synced is not None:
            return dict(synced)
        return {f"{kind}_{name}": getattr(self, f"_{kind}_{name}")
                for kind in ("user", "ai") for name in ("observe_me", "observe_others")}

    def _ai_observes_others(self, session: HonchoSession) -> bool:
        """Whether the AI peer observes other peers in this session; this picks the recall observer."""
        synced = self._session_observation.get(session.honcho_session_id)
        return synced["ai_observe_others"] if synced is not None else self._ai_observe_others

    def _join_observation_flags(self, honcho_session_id: str) -> tuple[bool, bool]:
        """(observe_me, observe_others) for an author peer joining ``honcho_session_id``: the session's
        server-synced values once setup ran, else the manager's config snapshot."""
        flags = self._observation_flags(honcho_session_id)
        return flags["user_observe_me"], flags["user_observe_others"]
