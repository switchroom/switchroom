"""Excerpt of the pinned plastic-labs/honcho hermes-plugin-honcho __init__.py at 5c7d24b3 (pre-HF-757 patch).

Verbatim lines: the head of ``HonchoMemoryProvider._do_session_init`` through the session get-or-create.
Tests exec it with stub clients.
"""


class HonchoMemoryProvider:
    def _do_session_init(self, cfg, session_id: str, **kwargs) -> None:
        """Shared session initialization for both eager and lazy paths."""
        from .client import get_honcho_client
        from .session import HonchoSessionManager

        self._manager = HonchoSessionManager(
            honcho=get_honcho_client(cfg), config=cfg, context_tokens=cfg.context_tokens,
            runtime_user_peer_name=kwargs.get("user_id") or None,
            runtime_user_peer_name_alt=kwargs.get("user_id_alt") or None,
        )
        self._session_key = self._resolve_session_key(cfg, session_id, **kwargs)
        logger.debug("Honcho session key resolved: %s", self._session_key)

        # The provider is not "ready" until this method returns: background startup sets
        # _manager before get_or_create/migration/prewarm finish, and lifecycle hooks must
        # not treat that partially initialized state as usable.
        session = self._manager.get_or_create(self._session_key)
