# Claude Subscription DirectSDK (experimental)

Fleet vendors the official Nous Research `claude-subscription-directsdk` plugin as a mounted source plugin. It is off in the bare image: it is not installed in the Fleet image, and the image alone neither enables nor routes it. The starter overlay (`examples/overlay-repo/`) turns it on as the default main model provider when the agent's `CLAUDE_CONFIG_DIR` login is set, with no API-key fallback. Without that login the overlay renders it off and the setup check (`scripts/switchroom-doctor.py`) reports it. Nous Research labels the provider experimental.

The plugin uses the official Claude Code CLI and its own logged-in Claude account for that profile. Install and authenticate the CLI separately. Hermes profile isolation must remain intact: do not copy login state between profiles. This plugin does not provide API-key billing fallback; resolve CLI login or entitlement errors at the CLI/account boundary rather than switching to an API key.

Upstream code and manifest are preserved except for one recorded downstream patch (below). `upstream.json` records the upstream repository, exact commit, per-file SHA-256 values of the files as vendored, the upstream tree hash, the MIT license hash, and for the patched file its upstream SHA-256 (`upstream_files_sha256`) and the patch (`patches`). Review upstream changes before updating that pin, and drop the patch once upstream carries it.

## Downstream patch: `closed-client-transport-error`

- **Change:** `directsdk.py` raises `ClaudeClientClosed(ConnectionError, RuntimeError)` instead of a plain `RuntimeError('Claude client is closed')` when a call reaches a client that was already closed.
- **Why:** Hermes core classifies a plain `RuntimeError` as an unknown error, so the auxiliary ladder never fell back and the cached closed client was never evicted; every later call failed the same way. A `ConnectionError` classifies as a connection failure (reason `timeout`, `transport=connection`), which falls back and evicts the dead client. It is still a `RuntimeError`, so callers that caught the old type keep working.
- **Shape:** one marked class block and one marked `raise` line (`hermes-fleet patch: closed-client-transport-error`). Removing the block and restoring that one line gives the upstream bytes; `tests/test_directsdk_closed_client.py` proves it against `upstream_files_sha256`.
- **Upstream:** a candidate for `NousResearch/hermes-official-plugins`; not yet proposed. **Remove when** the pinned upstream revision raises a transport-classified error (or reopens lazily) after `close()`.
 The plugin's bundled README and upstream tests document its controls and limitations.

Packaging tests verify provenance, license presence, absence of household literals, and optional/non-image status. See the upstream plugin's `tests/` and `evals/` for its offline suite and loopback compatibility checks; no paid inference is part of those checks.
