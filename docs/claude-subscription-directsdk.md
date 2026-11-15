# Claude Subscription DirectSDK (experimental)

Fleet vendors the official Nous Research `claude-subscription-directsdk` plugin as a mounted source plugin. It is off in the bare image: it is not installed in the Fleet image, and the image alone neither enables nor routes it. The starter overlay (`examples/overlay-repo/`) turns it on as the default main model provider when the agent's `CLAUDE_CONFIG_DIR` login is set, with no API-key fallback. Without that login the overlay renders it off and the setup check (`scripts/switchroom-doctor.py`) reports it. Nous Research labels the provider experimental.

The plugin uses the official Claude Code CLI and its own logged-in Claude account for that profile. Install and authenticate the CLI separately. Hermes profile isolation must remain intact: do not copy login state between profiles. This plugin does not provide API-key billing fallback; resolve CLI login or entitlement errors at the CLI/account boundary rather than switching to an API key.

Upstream code and manifest are preserved unmodified. `upstream.json` records the upstream repository, exact commit, per-file SHA-256 values, canonical tree hash and MIT license hash. Review upstream changes before updating that pin. The plugin's bundled README and upstream tests document its controls and limitations.

Packaging tests verify provenance, license presence, absence of household literals, and optional/non-image status. See the upstream plugin's `tests/` and `evals/` for its offline suite and loopback compatibility checks; no paid inference is part of those checks.
