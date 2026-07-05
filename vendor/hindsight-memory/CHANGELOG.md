# Changelog

## [Unreleased]

### Changed (switchroom divergence)

- **retain.py: decouple chunked window-slicing from the `retainEveryNTurns > 1`
  throttle** (switchroom Phase 6b). Previously the chunked sliding-window only
  applied when `retainEveryNTurns > 1`; with `retainEveryNTurns=1` (switchroom
  sets this in `scaffold.ts` for every-turn crash durability) chunked mode fell
  through to full-session and re-consolidated the entire accumulated transcript
  on every Stop fire. Window selection is now extracted into a pure
  `select_retain_window()` helper and slices a window of
  `max(retainEveryNTurns, 1) + retainOverlapTurns` turns whenever
  `retainMode == "chunked"`, independent of the throttle. The throttle-skip
  logic (`retain_every_n > 1` firing cadence) is unchanged, so `> 1` behaviour
  and the full-session default are equivalent. This is a deliberate switchroom
  divergence from pristine vendor and is a **candidate to upstream to
  vectorize-io/hindsight** — decoupling *what* to retain from *whether* to fire
  this turn is a general improvement, not switchroom-specific.

- **content.py: `slice_last_turns_by_user_boundary()` counts genuine HUMAN
  turns only** (switchroom Phase 6b, adversarial-review fix). Claude Code emits
  tool results as `role="user"` messages whose content is a list of
  `tool_result` blocks. The boundary counter treated every `role="user"`
  message as a turn, so on a tool-heavy turn (≥N sequential tool rounds) a
  fixed-size retain window filled with `tool_result` messages and pushed the
  actual human message OUTSIDE the window — silently dropping the fact from
  that fire and every later fire (whose window starts even further away), so it
  was never retained; on restart the fact was gone. A message whose content is
  entirely `tool_result` blocks is now skipped as a boundary
  (`_is_tool_result_only_user_message`), so "window = N turns" means N *human*
  turns regardless of tool volume. Affects both the retain window-slice and the
  recall context-slice (both want N human turns). **Candidate to upstream** —
  the same silent-loss bug exists in vendor's own `retainEveryNTurns > 1`
  chunked path. NOTE: switchroom never ran chunked before Phase 6b, so this
  changes no previously-exercised switchroom behaviour.

- **retain.py: SessionEnd `force=True` widens chunked mode to a full-session
  sweep** (switchroom Phase 6b, belt-and-braces). Per-turn fires still slice
  the window; the single forced retain at SessionEnd
  (`session_end.py` → `run_retain(force=True)`) now retains the whole session
  in chunked mode, guaranteeing a graceful shutdown always flushes everything
  even if per-turn windowing had an edge. Costs one full sweep per session (at
  end), not per turn.

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
  Note: because the key now joins an extra part (empty string when filters
  are unused), every cache key rotates ONCE across this upgrade boundary —
  the first recall per session after upgrading is a cache miss. Within a
  version, keys are unchanged as long as filters stay unused.
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
