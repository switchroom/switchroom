# Changelog

## v0.2.2 — 2026-04-24

### Fixed
- Removed absolute source paths baked into bundled output (build hygiene). The bundler was inlining `__filename` as a developer-machine absolute path inside `dist/cli/switchroom.js`. Switched `src/memory/scaffold-integration.ts` to `import.meta.dirname` so the resolved `switchroom-mcp/server.ts` anchor is computed at runtime from the bundle's own location. No published behaviour change, no new code paths.

## v0.2.1 — 2026-04-24

### Added
- Secret-detection pipeline: per-turn scanning of tool-use content with staging, rewrite, and audit log, plus PreToolUse and Stop hook scaffolding and a gateway-side intercept so leaked credentials are caught before they leave the agent (#47, #48, #49, #51, #54).
- `switchroom vault sweep` — retroactive scrubber that walks existing transcripts and vault-isches already-stored secrets in place (#50).
- Restart-reason surfaced in the session-greeting card so each agent's greeting tells you *why* the last restart happened (planned, crash, OOM, manual, etc.) (#58).

### Changed
- Telegram gateway hardening: startup mutex prevents duplicate bridges racing on launch, a 35s SIGTERM drain lets in-flight turns finish cleanly, and state transitions are now logged for post-mortems (#52, #53).
- CI pipeline: cache-aware `bun install` and serialized eval steps cut wall time and remove flakes from parallel runs (#57).
- Gateway wiring: pid-file, session-marker, and typing-wrap are now threaded through the gateway consistently (#45).

### Fixed
- "Recovered from unexpected restart" banner no longer fires on planned shutdowns — the 30s clean-shutdown marker preserve window aligns with the 60s banner-suppression window so orderly restarts stay quiet (#55).
- Regenerated `bun.lock` to match `package.json`, unbreaking Buildkite (#56).

## v0.2.0 — 2026-04-23

Bumps the package to v0.2.0 and threads build provenance through to the greeting card so users can see which release each agent is running and how stale it is.
