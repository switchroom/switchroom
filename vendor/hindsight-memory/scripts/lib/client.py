"""Hindsight REST API client.

Communicates with a Hindsight server via HTTP. Mirrors the HTTP mode of the
Openclaw HindsightClient (client.js), adapted for Python stdlib.
"""

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

from .retain_split import part_document_id, part_metadata, split_retain_content
from .secret_redact import redact, redact_metadata, redact_retain_fields

DEFAULT_TIMEOUT = 15  # seconds
HEALTH_CHECK_RETRIES = 3
HEALTH_CHECK_DELAY = 2  # seconds


def _plugin_version() -> str:
    """Read the plugin version from plugin.json (single source of truth)."""
    manifest = Path(__file__).resolve().parents[2] / ".claude-plugin" / "plugin.json"
    try:
        return json.loads(manifest.read_text()).get("version", "0.0.0")
    except (OSError, ValueError):
        return "0.0.0"


# Sent on every request so self-hosted deployments behind Cloudflare (or any
# reverse proxy with UA-based bot filtering) don't block the stdlib default
# "Python-urllib/X.Y", which trips Cloudflare error 1010.
USER_AGENT = f"hindsight-claude-code/{_plugin_version()}"


def _validate_api_url(url: str) -> str:
    """Validate and normalize the API URL. Reject non-HTTP schemes."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"Hindsight API URL must use http or https, got: {parsed.scheme!r}")
    if not parsed.hostname:
        raise ValueError(f"Hindsight API URL has no hostname: {url!r}")
    return url.rstrip("/")


class HindsightClient:
    """HTTP client for the Hindsight API."""

    def __init__(
        self,
        api_url: str,
        api_token: Optional[str] = None,
        request_timeout_override: Optional[int] = None,
    ):
        self.api_url = _validate_api_url(api_url)
        self.api_token = api_token
        self.request_timeout_override = request_timeout_override

    def _resolve_timeout(self, timeout: int) -> int:
        """Return the override if configured, otherwise the caller's timeout.

        Upstream 55ef70679. NOTE: recall.py deliberately does not pass the
        override — its 8s timeout is a hook-budget invariant.

        The override is clamped to >= 1: a zero/negative env value would
        otherwise reach urlopen as a nonsensical timeout (0 fails every
        request immediately), turning a config typo into a dead client.
        """
        if self.request_timeout_override is None:
            return timeout
        return max(1, self.request_timeout_override)

    def _headers(self) -> dict:
        headers = {
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        }
        if self.api_token:
            headers["Authorization"] = f"Bearer {self.api_token}"
        return headers

    @staticmethod
    def _is_memory_write(method: str, path: str) -> bool:
        """True for a request that CREATES memory rows.

        `POST .../memories` is the write; `POST .../memories/recall` is a
        read that happens to be a POST, and must not be rewritten.
        """
        if method.upper() != "POST":
            return False
        base = path.split("?", 1)[0].rstrip("/")
        return base.endswith("/memories")

    @staticmethod
    def _redact_write_body(body: Optional[dict]) -> Optional[dict]:
        """Structural backstop — mask secrets in a memory-write body.

        `retain()` already redacts BEFORE splitting (which is where a
        secret straddling a chunk boundary is still whole). This second
        pass exists so a future caller that reaches `_request` without
        going through `retain()` cannot write a raw credential into a
        bank: every memory row this client creates is emitted from here.
        Redaction is mask-in-place and stable on already-masked text, so
        running it twice is a no-op on the second pass.
        """
        if not isinstance(body, dict):
            return body
        items = body.get("items")
        if not isinstance(items, list):
            return body
        for item in items:
            if not isinstance(item, dict):
                continue
            if isinstance(item.get("content"), str):
                item["content"] = redact(item["content"])
            if isinstance(item.get("context"), str):
                item["context"] = redact(item["context"])
            if isinstance(item.get("metadata"), dict):
                item["metadata"] = redact_metadata(item["metadata"])
        return body

    def _request(self, method: str, path: str, body: Optional[dict] = None, timeout: int = DEFAULT_TIMEOUT) -> dict:
        timeout = self._resolve_timeout(timeout)
        if self._is_memory_write(method, path):
            body = self._redact_write_body(body)
        url = f"{self.api_url}{path}"
        data = json.dumps(body).encode() if body else None
        req = urllib.request.Request(url, data=data, headers=self._headers(), method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            body_text = ""
            try:
                body_text = e.read().decode()
            except Exception:
                pass
            raise RuntimeError(f"HTTP {e.code} from {url}: {body_text}") from e

    def health_check(self, timeout: int = 5, retries: int = HEALTH_CHECK_RETRIES) -> bool:
        """Check if the Hindsight server is reachable.

        Mirrors Openclaw's checkExternalApiHealth: retries up to
        ``retries`` times (default ``HEALTH_CHECK_RETRIES`` = 3) with
        ``HEALTH_CHECK_DELAY`` (2s) between attempts.

        Time-budgeted callers (e.g. the SessionStart drain gate,
        #1094) should pass ``retries=1``: against a HUNG server the
        default loop costs ~retries*timeout + (retries-1)*delay of wall
        clock, which blows a 5s hook budget.
        """
        import time

        retries = max(1, retries)
        for attempt in range(1, retries + 1):
            try:
                url = f"{self.api_url}/health"
                req = urllib.request.Request(url, headers=self._headers(), method="GET")
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    if resp.status == 200:
                        return True
            except Exception:
                pass
            if attempt < retries:
                time.sleep(HEALTH_CHECK_DELAY)
        return False

    def recall(
        self,
        bank_id: str,
        query: str,
        max_tokens: int = 1024,
        budget: str = "mid",
        types: Optional[list] = None,
        tags: Optional[list] = None,
        tags_match: Optional[str] = None,
        tag_groups: Optional[object] = None,
        prefer_observations: Optional[bool] = None,
        query_timestamp: Optional[str] = None,
        timeout: int = 10,
    ) -> dict:
        """Recall memories from a bank.

        Returns the raw API response dict with 'results' list. Each result
        carries a `scores` object (`RecallScores`) whose `final` field is the
        engine's combined ranking score — callers sort the merged multi-bank
        set by it before applying any count cap.

        `prefer_observations=True` asks the engine to prefer deduped
        observation statements over the raw facts they supersede, backfilling
        the freed slots — denser coverage inside the same token/count budget.

        ``query_timestamp`` is an ISO 8601 datetime naming when the query is
        being asked, from the user's perspective. The engine uses it as the
        anchor for resolving relative temporal expressions in the query ("last
        week", "yesterday") and for recency scoring; absent, the server's own
        current time is the anchor. Sent only when non-empty, so a ``None``
        (the default) leaves the wire body byte-identical to a pre-field
        client — the additive-field invariant switchroom P2 depends on. The
        REST recall body validates this field's format (a malformed value
        400s: "Invalid query_timestamp format. Expected ISO format"), so the
        caller is responsible for passing a well-formed ISO string.
        """
        path = f"/v1/default/banks/{urllib.parse.quote(bank_id, safe='')}/memories/recall"
        body = {
            "query": query,
            "max_tokens": max_tokens,
        }
        if budget:
            body["budget"] = budget
        if types:
            body["types"] = types
        if tags:
            body["tags"] = tags
        if tags_match:
            body["tags_match"] = tags_match
        if tag_groups:
            body["tag_groups"] = tag_groups
        if prefer_observations is not None:
            body["prefer_observations"] = prefer_observations
        if query_timestamp:
            body["query_timestamp"] = query_timestamp
        return self._request("POST", path, body, timeout=timeout)

    def retain(
        self,
        bank_id: str,
        content: str,
        document_id: str = "conversation",
        context: Optional[str] = None,
        metadata: Optional[dict] = None,
        tags: Optional[list] = None,
        timeout: int = 15,
        async_processing: bool = True,
        observation_scopes: Optional[object] = None,
    ) -> dict:
        """Retain content into a bank's memory.

        ``observation_scopes`` is a per-row Hindsight field controlling which
        observation scope consolidation writes this item's observations into.
        ``"shared"`` puts them in ONE global untagged scope instead of a scope
        per tag; an explicit ``list[list[str]]`` (e.g. ``[["lesson"]]``, what
        the ``curated`` strategy emits) declares the exact scope(s) to
        consolidate into, JSON-serialised onto the wire as a nested array.
        ``None`` (a falsy value) omits the field entirely, so the engine's own
        default stands and the wire body is byte-identical to a
        pre-``observation_scopes`` client.

        By default posts with ``async=true`` so the server processes extraction
        in the background (a 200 is an ack-of-receipt, not proof of durable
        persistence). The context field helps Hindsight cluster memories by
        provenance (e.g. "claude-code" vs manual retains).

        ``async_processing=False`` (switchroom #3244 §1.1) posts ``async=false``
        so the 200 is returned only after the daemon has durably committed the
        item — commit-before-ack. Durability paths whose success advances the
        retain watermark (the Stop-hook durability retain and boot
        reconciliation) MUST use this so a bare async 200 can never falsely mark
        unpersisted work as committed. (Merge precondition: the daemon honours
        ``async=false`` as commit-before-ack — verified by the §1.1 probe.)

        **Oversized content is split before it is posted** (``lib/retain_split``).
        The daemon runs one sequential extraction LLM call per
        ``retain_chunk_size`` (3000) chars, so server wall time is linear in
        ``len(content)`` while the client has a single deadline for the whole
        POST — past ~45,000 chars a retain cannot complete at ANY client
        timeout and the memory is permanently unsaveable (measured: 154 of the
        629 entries in the 2026-07-25 fleet backlog). This is the enforcement
        point precisely because every retain POST in the plugin goes through
        it, so the bound is code-enforced rather than left to each producer.

        Parts are posted SEQUENTIALLY, each with the caller's ``timeout`` (the
        timeout is a per-HTTP-request read deadline, and each part is its own
        request) and each with the caller's ``async_processing`` — so a
        durability caller still gets commit-before-ack per part. Any part
        failing raises, exactly as an unsplit failure does, so the caller's
        existing enqueue/retry handling is unchanged; already-committed parts
        carry deterministic ids and are upserted, not duplicated, on retry.

        ``timeout`` bounds the CALLER'S TOTAL WALL TIME, not just each HTTP
        request. Splitting must never turn one bounded POST into N of them:
        the Stop hook passes ``timeout=15`` because it has a hook budget to
        respect, and ``15 × N`` would stall the session. Once the budget is
        spent no further part is started and the call raises, exactly as an
        unsplit failure does, so each caller's EXISTING failure path handles
        the remainder: the hook paths (``retain.py``, ``subagent_retain.py``,
        ``reconcile_tail.py``) enqueue, and ``pending.enqueue`` queues the
        remainder as bounded per-part entries the drainer can finish; the
        drain paths count an attempt and keep the entry;
        ``backfill_transcripts.py`` logs and backs off. The parts already
        committed are upserted on the next attempt, not duplicated.
        """
        # ── Secret redaction, BEFORE splitting ────────────────────────
        #
        # Every retain in this plugin (Stop-hook auto-retain, SubagentStop
        # sidechain retain, the pending-backlog drainer, boot
        # reconciliation, transcript backfill) funnels through this one
        # method, so this is the intake chokepoint for memory content —
        # the same property `retain_split` relies on.
        #
        # It runs BEFORE `split_retain_content` on purpose: a credential
        # straddling a 3000-char part boundary is only whole here. The
        # second pass in `_request` is the structural backstop for any
        # caller that never reaches this method.
        content, context, metadata = redact_retain_fields(
            content, context, metadata
        )
        parts = split_retain_content(content)
        total = len(parts)
        response = None
        deadline = time.monotonic() + timeout
        part_timeout = timeout
        for index, part in enumerate(parts):
            if index > 0:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(
                        f"retain wall budget of {timeout}s exhausted after "
                        f"{index}/{total} parts; no further part was started. "
                        f"The caller's own failure path decides the remainder: "
                        f"the hook paths enqueue it (as bounded per-part "
                        f"entries), the drain paths count an attempt and keep "
                        f"the entry queued."
                    )
                # Clamp the request deadline to what is left of the budget so
                # the final part cannot overrun it either.
                part_timeout = max(1, int(remaining))
            response = self._retain_one(
                bank_id=bank_id,
                content=part,
                document_id=part_document_id(document_id, index, total),
                context=context,
                metadata=part_metadata(metadata, index, total),
                tags=tags,
                timeout=part_timeout,
                async_processing=async_processing,
                observation_scopes=observation_scopes,
            )
        if total > 1 and isinstance(response, dict):
            response = dict(response)
            response["split_parts"] = total
        return response

    def _retain_one(
        self,
        bank_id: str,
        content: str,
        document_id: str,
        context: Optional[str],
        metadata: Optional[dict],
        tags: Optional[list],
        timeout: int,
        async_processing: bool,
        observation_scopes: Optional[object] = None,
    ) -> dict:
        """POST exactly one retain item. Raises on any HTTP/transport error."""
        path = f"/v1/default/banks/{urllib.parse.quote(bank_id, safe='')}/memories"
        item = {
            "content": content,
            "document_id": document_id,
            "metadata": metadata or {},
        }
        if context:
            item["context"] = context
        if tags:
            item["tags"] = tags
        # Omitted entirely when unset — the engine default must stay in force
        # and the body must match a pre-observation_scopes client byte for byte.
        if observation_scopes:
            item["observation_scopes"] = observation_scopes
        body = {
            "items": [item],
            "async": bool(async_processing),
        }
        return self._request("POST", path, body, timeout=timeout)

    def document_exists(
        self,
        bank_id: str,
        document_id: str,
        timeout: int = 30,
    ) -> Optional[bool]:
        """TRI-STATE presence check for one document (switchroom #3596).

        ``True`` — the document is there. ``False`` — the server said 404.
        ``None`` — **unknown** (transport error, 5xx, timeout).

        The tri-state is load-bearing and must not be collapsed to a bool.
        Two callers depend on it:

        * the backlog drain's reconcile phase, which SKIPS a retain when the
          memory already exists. Treating "unknown" as ``False`` there would
          re-POST a document that is already durable — the duplicated-LLM-cost
          bug this check exists to avoid (70.4% of one measured 5,751-entry
          fleet backlog already existed as documents).
        * commit-before-delete, which only deletes a queue entry once presence
          is CONFIRMED. Treating "unknown" as ``True`` there would delete the
          last on-disk copy of a turn on a flaky GET — the #3244 silent-loss
          shape, reintroduced from the other direction.

        Deliberately does NOT reuse ``_request()``: that wraps every
        ``HTTPError`` into a ``RuntimeError``, which would make a 404
        indistinguishable from a 503 without string-matching the message.
        """
        bank = urllib.parse.quote(bank_id, safe="")
        did = urllib.parse.quote(document_id, safe="")
        url = f"{self.api_url}/v1/default/banks/{bank}/documents/{did}"
        req = urllib.request.Request(url, headers=self._headers(), method="GET")
        try:
            with urllib.request.urlopen(
                req, timeout=self._resolve_timeout(timeout)
            ) as resp:
                resp.read()
                return True
        except urllib.error.HTTPError as e:
            return False if e.code == 404 else None
        except Exception:
            return None

    def list_session_document_ids(
        self,
        bank_id: str,
        session_id: str,
        page: int = 200,
        max_pages: int = 50,
        timeout: int = 10,
    ) -> set:
        """Return the set of document ids in ``bank_id`` whose id contains
        ``session_id`` (switchroom #3244 log-driven recovery, session-level
        membership).

        Uses the daemon's server-side ``q=`` filter — a case-insensitive
        substring match on the document id (``GET .../documents?q=...``,
        ``http.py:api_list_documents``). Every per-turn transcript retain the
        live path OR this backfill ever wrote for a session carries the session
        id as an id prefix — BOTH the legacy ``{session_id}-{epoch_ms}`` scheme
        (what production banks hold today) and the new ``{session_id}-r{uuid}``
        scheme — so this ONE server-side query (paged, bounded by ``max_pages``)
        returns exactly this session's docs without a per-slice GET storm. The
        caller tests the returned ids for the ``{session_id}`` PREFIX (scheme-
        agnostic) to decide presence: ANY doc ⇒ present ⇒ skip; ZERO ⇒
        total-loss ⇒ restore.

        Raises on any HTTP/transport error so the caller can fail CLOSED (treat
        the session as PRESENT ⇒ skip) and never risk a duplicate restore.
        """
        found: set = set()
        offset = 0
        q = urllib.parse.quote(session_id, safe="")
        bank = urllib.parse.quote(bank_id, safe="")
        for _ in range(max(1, max_pages)):
            path = (
                f"/v1/default/banks/{bank}/documents"
                f"?q={q}&limit={int(page)}&offset={int(offset)}"
            )
            resp = self._request("GET", path, timeout=timeout)
            items = resp.get("items") or []
            for it in items:
                did = it.get("id") if isinstance(it, dict) else None
                if did:
                    found.add(did)
            if len(items) < page:
                break
            offset += page
        return found

    def list_directives(
        self,
        bank_id: str,
        active_only: bool = True,
        tags: Optional[list] = None,
        timeout: int = 5,
    ) -> dict:
        """List active directives for a bank.

        Switchroom-local: this method was missing in the vendored
        HindsightClient even though `lib/directives.py` (also
        switchroom-local, the workaround for upstream
        vectorize-io/hindsight#1269) calls it on every recall hook.
        Without this method the directives fetch always raised
        AttributeError → silently caught at directives.py:47-49 → no
        directives ever surfaced in the recall block.

        The upstream REST endpoint is `GET
        /v1/default/banks/{bank_id}/directives` with `active_only` and
        optional `tags` query params (see upstream
        `hindsight-clients/python/hindsight_client_api/api/directives_api.py`).

        Returns the raw response dict, expected to have an `items` list
        of directives where each item has at least `id`, `name`,
        `content`, `priority`, `is_active`, `tags`. Caller (directives.py)
        already defends against missing/malformed entries.
        """
        params = {}
        if active_only:
            # Server expects lowercase string per the OpenAPI spec.
            params["active_only"] = "true"
        if tags:
            # Hindsight accepts repeated `tags=` query params for
            # multi-tag filtering. urlencode with doseq=True handles it.
            params["tags"] = tags
        path = f"/v1/default/banks/{urllib.parse.quote(bank_id, safe='')}/directives"
        if params:
            path = f"{path}?{urllib.parse.urlencode(params, doseq=True)}"
        return self._request("GET", path, timeout=timeout)

    def set_bank_mission(
        self, bank_id: str, mission: str, retain_mission: Optional[str] = None, timeout: int = 15
    ) -> dict:
        """Set the mission/persona for a bank.

        Uses PATCH /banks/{id}/config with reflect_mission and retain_mission.
        The old PUT /banks/{id} with 'mission' field is deprecated in v0.4.19.
        """
        path = f"/v1/default/banks/{urllib.parse.quote(bank_id, safe='')}/config"
        updates = {"reflect_mission": mission}
        if retain_mission:
            updates["retain_mission"] = retain_mission
        return self._request("PATCH", path, {"updates": updates}, timeout=timeout)

    def list_mental_models(self, bank_id: str, timeout: int = 5) -> dict:
        """List the mental models for a bank (Memory v2 M5 — orientation-at-boot).

        The orientation SessionStart hook knows the orientation model by NAME
        (the configured `memoryOrientationModel`), not by its `mm-…` id, so it
        lists the bank's models and matches on name → id before reading content
        (carve-M5 §0d/§3). Read-only GET on the ungated engine REST surface;
        m5-0-probe measured the own-bank read at ~4ms on klanker.

        REST: ``GET /v1/default/banks/{bank_id}/mental-models``. Returns the raw
        response dict, expected to carry an ``items`` list where each item has at
        least ``id`` and ``name``.
        """
        path = f"/v1/default/banks/{urllib.parse.quote(bank_id, safe='')}/mental-models"
        return self._request("GET", path, timeout=timeout)

    def get_mental_model(
        self, bank_id: str, model_id: str, detail: str = "full", timeout: int = 5
    ) -> dict:
        """Read one mental model's content + freshness watermark (M5).

        REST: ``GET /v1/default/banks/{bank_id}/mental-models/{model_id}?detail=full``
        (m5-0-probe Q3/Q4 proved this returns ``content`` + the
        ``last_refreshed_at`` watermark the staleness guard keys on, ~4ms warm).
        Read-only; ungated. The caller wraps this in a generous read-timeout and
        degrades to the cold notice on any error — a slow/failed read must never
        block boot (carve §3 fail-safe).
        """
        bank = urllib.parse.quote(bank_id, safe="")
        model = urllib.parse.quote(model_id, safe="")
        path = f"/v1/default/banks/{bank}/mental-models/{model}"
        if detail:
            path = f"{path}?{urllib.parse.urlencode({'detail': detail})}"
        return self._request("GET", path, timeout=timeout)
