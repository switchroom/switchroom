# Changelog

## [Unreleased]

### Changed (switchroom divergence)

- **`recallContextTurns` default `1` → `2`** (switchroom hindsight-leverage
  PR2, workstream A2). A bare follow-up user message ("and the port?", "what
  about staging?") now embeds together with its antecedent human turn in the
  recall query, instead of recalling on the pronoun alone. Depends on PR1's
  (#3435) `<channel>` envelope strip so the composed 2-turn query stays
  envelope-free (both the trailing latest segment and the `Prior context:`
  lines). The composition is bounded by `recallMaxQueryChars` (800) —
  `truncate_recall_query` preserves the latest turn and drops oldest context
  first, so a large antecedent can never blow the recall query budget.
- **New `recallTranscriptTailBytes` (default `262144`)** — latency bound for
  multi-turn recall. With `recallContextTurns > 1` now the default, every
  recall reads the transcript to slice prior turns; `read_transcript_messages`
  now byte-tail-bounds that read (seek to `EOF - tail_bytes`, discard the
  partial first line, parse only complete trailing lines) so the added
  per-recall read stays O(1) regardless of session `.jsonl` size. `0` reads the
  whole file (rollback lever). Env: `HINDSIGHT_RECALL_TRANSCRIPT_TAIL_BYTES`.

### Added (switchroom divergence)

- **retain.py + recall.py: lesson/anti-pattern tagging → recall demotion**
  (switchroom hindsight-leverage PR9, workstream E2, #398). Closes the corpus-
  hygiene half of #398: a retained transcript that captures a self-recognised
  lesson ("lesson learned", "note to self:") or a failure mode ("anti-pattern:",
  "what not to do") is now deterministically tagged (`lesson` / `anti-pattern`)
  at retain time by `retain.detect_lesson_tags` — a case-insensitive substring
  match against the configurable `lessonTagMarkers` map (NOT model-dependent),
  wired into `build_retain_payload` so it applies to both Stop-hook and sidechain
  retains without clobbering configured `retainTags`. Recall then DEMOTES those
  tags via the PR5 score-penalty weight map: `recall._effective_tag_weights`
  merges built-in `lessonDemotionWeights` (`{lesson: 0.85, anti-pattern: 0.5}`)
  UNDER `recallTagWeights`, so a failure-mode-adjacent transcript ranks below a
  clean equal-score session memory yet is NEVER hard-dropped (re-rank, not the
  demote-tag DROP filter) and still surfaces when it is the only relevant hit.
  Precedence: an explicit `recallTagWeights` entry wins over the built-in for the
  same tag; the PR5 `sidechain: 0.8` seed composes cleanly. Toggles:
  `HINDSIGHT_LESSON_TAGGING=false` (retain side), `HINDSIGHT_LESSON_DEMOTION=false`
  (recall side) as rollback levers; `HINDSIGHT_LESSON_TAG_MARKERS` /
  `HINDSIGHT_LESSON_DEMOTION_WEIGHTS` (JSON) for overrides. NON-GOAL
  (epic-recorded): the historical corpus is NOT re-tagged — this fires on NEW
  retains only. Acceptance: `scripts/tests/test_lesson_tagging.py`.

- **recall.py: parallel multi-bank recall under one shared deadline**
  (switchroom hindsight-leverage PR3, workstream A3 stage 2). The directives
  fetch and every bank recall (own + additional/profile/shared/sender banks)
  now run CONCURRENTLY in daemon threads via `lib/parallel_recall.py`
  (`run_parallel`), bounded by ONE shared deadline
  (`recallParallelDeadlineSeconds`, default 10 = the 12s UserPromptSubmit hook
  ceiling minus 2s headroom). Serially the round-trips SUM, so a heavy
  multi-bank agent could breach the ceiling and drop recall entirely; parallel
  makes the critical path the SLOWEST slot. A slot still running at the deadline
  is abandoned (daemon thread, reaped on process exit) and marked `timed_out` —
  a straggler bank can never hold the hook open past its ceiling; `recall.py`'s
  `__main__` additionally `os._exit(0)`s (after a stdout flush) as a
  belt-and-suspenders. The directives slot is dedicated and composes with the A4
  directives cache (a cache HIT returns near-instantly with no HTTP). Env-gated
  rollback: `HINDSIGHT_RECALL_PARALLEL=false` restores the pre-A3 serial path.
  The `deadline_hit` telemetry field (shipped interim in PR1) is FINALIZED:
  True when any bank raised a hard per-request timeout OR any bank/directives
  slot was abandoned at the shared deadline; serial mode reduces to the pre-A3
  per-bank-only form so both modes' `recall_log.jsonl` rows stay comparable in
  the breach baseline. New log fields: `recall_mode`, `deadline_budget_ms`
  (the CONFIGURED budget), `deadline_effective_ms` (the smaller wait the slots
  actually got after pre-fan-out spend; null in serial mode / on cache hits),
  `directives_timed_out`. Acceptance: `scripts/tests/test_recall_parallel_deadline.py`
  (stub-timing tests proving a 3s bank cannot breach a 0.6s deadline).

- **SubagentStop sidechain retain** (switchroom hindsight-leverage PR5). New
  `scripts/subagent_retain.py`, registered on the `SubagentStop` event in
  `hooks/hooks.json` (async, 15s). Delegated (Task-tool / sub-agent) work was
  the biggest systematic memory hole — the main-session Stop retain only reads
  the parent `transcript_path`, so a worker's process facts reached memory only
  as its terse final report. This hook retains a bounded window (last 40 human
  turns) of the *sidechain* transcript, tagged `sidechain` +
  `parent_session:<id>`, with a deterministic content-derived `document_id` in a
  distinct namespace (`{session}-sub-{agent}-r{start}-{end}`) so re-fires upsert.
  Failures enqueue to the same `pending-retains` durability queue the Stop retain
  uses. A **volume gate** (< 6 human turns OR < 2,000 chars of non-tool-result
  text) skips trivial forks (every Task fires SubagentStop, including
  10-second ones). Empirically probed on Claude Code 2.1.215: the hook input
  carries a first-class `agent_transcript_path` pointing at
  `<project>/<session>/subagents/agent-<agent_id>.jsonl` (used as the primary
  path), with a directory-scan of the newest `isSidechain:true` jsonl as the
  fallback for CLIs that omit the field. `reconcile_tail.py` and any transcript
  sweeper now **skip** sidechain transcripts (shared
  `content.transcript_first_line_is_sidechain` predicate) so the boot reconciler
  cannot re-retain a sub-agent fork as a pseudo-session — untagged, at full
  recall weight, bypassing the volume gate — which its recursive `**/*.jsonl`
  glob would otherwise do one restart after any worker.

- **recall.py: `recallTagWeights` per-tag score penalty** (switchroom
  hindsight-leverage PR5). A `{tag: multiplier}` config map (default `{}`,
  env `HINDSIGHT_RECALL_TAG_WEIGHTS`) applied to each result's `scores.final`
  immediately before the relevance sort. Unlike the demote-tag DROP filter
  (`_is_demoted_memory`), which removes a tagged memory from recall entirely,
  this DEMOTES (down-ranks) a memory while keeping it recallable when it is the
  only relevant hit — the "reduced weight" the drop filter cannot express.
  Switchroom's scaffold seeds `{"sidechain": 0.8}` so delegated-worker
  process-memories rank just below first-party session memory. **Candidate to
  upstream** — a general recall-shaping primitive, not switchroom-specific.

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
