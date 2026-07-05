# Changelog

## [Unreleased]

### Ported from upstream (vectorize-io/hindsight, `hindsight-integrations/claude-code/`)

- `c5a61db2b` — raise `_check_health` default timeout 2s→10s in
  `scripts/lib/daemon.py` to stop the busy-daemon restart/kill loop
  (applied clean; codex-integration hunk not applicable).
- `3d6c2ba8b` — label "Current time" as UTC in the recall context block
  (`lib/content.py:format_current_time`), so client LLMs in non-UTC
  timezones don't misread the timestamp as local time.
- `962140eef` — recall tag filters: `recallTags`, `recallTagsMatch`,
  `recallTagGroups`, plus per-additional-bank overrides via
  `recallAdditionalBankFilters`. Hand-ported into the switchroom recall.py
  rewrite: filters compose with sender-bank routing (per-bank overrides
  apply to sender banks too) and are part of the recall cache key
  (`_tag_filter_sig`) so a filter change can't serve stale cached results.
- `55ef70679` — optional `requestTimeoutSeconds` /
  `HINDSIGHT_REQUEST_TIMEOUT_SECONDS` global request-timeout override in
  `HindsightClient` (adapted to our `_request`). Wired into retain.py only;
  recall.py deliberately keeps its own 8s hook-budget timeout. Upstream's
  mcp_server.py hunks skipped (not vendored).

### Added

- `{user_id}` template variable for `retainTags` and `retainMetadata`, resolved
  from the `HINDSIGHT_USER_ID` env var (empty string if unset). Enables
  machine-independent per-user memory scoping without hardcoding user ids in
  `settings.json`.

### Changed

- Tags that resolve to an empty namespace content (e.g. `"user:"` when
  `HINDSIGHT_USER_ID` is unset) are now dropped from retain requests. Previously
  such tags were sent as-is. Tags without `:` are unaffected.

## [0.1.0] - 2025-03-23

### Added
- Initial release: Claude Code plugin for Hindsight long-term memory
- Auto-recall on every user prompt via `UserPromptSubmit` hook — injects relevant memories as `additionalContext`
- Auto-retain after every response via async `Stop` hook — extracts and stores conversation transcript
- Session lifecycle hooks (`SessionStart` health check, `SessionEnd` daemon cleanup)
- Three connection modes: external API, auto-managed local daemon (`uvx hindsight-embed`), existing local server
- Dynamic bank IDs with configurable granularity (`agent`, `project`, `session`, `channel`, `user`)
- Channel-agnostic: works with Claude Code Channels (Telegram, Discord, Slack) and interactive sessions
- Zero pip dependencies — pure Python stdlib (`urllib`, `fcntl`, `subprocess`)
- 34 configuration options via `settings.json` with env var overrides
- LLM auto-detection from `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`
- Chunked retention with sliding window (`retainEveryNTurns` + `retainOverlapTurns`)
- Memory tag stripping to prevent retain feedback loops
