# Changelog

## [Unreleased]

### Added (switchroom divergence)

- **Per-row `observation_scopes` on every retain.** Hindsight accepts and
  stores an `observation_scopes` field per retained item; `"shared"` makes
  consolidation write that item's observations into ONE global untagged scope
  instead of a scope per tag. The plugin had no way to send it, so a bank
  several agents write into could not pool their observations. Added as an
  explicit `observation_scopes` kwarg on `HindsightClient.retain()` /
  `_retain_one()` (`scripts/lib/client.py`), sourced from the new
  `observationScopes` config key (`scripts/lib/config.py`, default `None`,
  overridable by `HINDSIGHT_OBSERVATION_SCOPES`, which switchroom's
  `start.sh` exports only when the operator set
  `memory.observation_scopes`).

  `build_retain_payload` (`scripts/retain.py`) puts the resolved value on the
  payload, and all five hand-enumerated `client.retain()` callsites forward it:
  `retain.py` (Stop hook), `subagent_retain.py` (sidechain),
  `reconcile_tail.py` (boot reconcile), `drain_pending.py` (queue drain) and
  `backfill_transcripts.py`. Each enumerates kwargs rather than splatting the
  payload, so a missed one silently keeps writing per-tag scopes — every path
  is pinned by a test.

  Two durability properties are load-bearing. The scope rides ON the queued
  payload (`lib/pending` copies the payload wholesale), so a retain that fails
  now and drains hours later lands in the scope it was written for rather than
  whatever config says at drain time. And `drain_pending._retry_one` reads it
  with `entry.get(...)`: entries queued by a build that predates this field are
  on disk right now, and a `KeyError` there would strand the last on-disk copy
  of a turn (the #3244 silent-loss shape).

  Default behaviour is unchanged and asserted as such: with the config unset
  the kwarg is `None` and `_retain_one` omits the key from the request body
  entirely rather than sending a null, so the body is byte-identical to a
  pre-change client. Split retains carry the same scope on every part.
  Tests: `scripts/tests/test_observation_scopes.py`, plus per-path pins in
  `test_reconcile_durability.py`, `test_subagent_retain.py` and
  `test_backfill.py`.

  An off-list value RAISES rather than reaching the wire
  (`resolve_observation_scopes` in `scripts/lib/config.py`, called from
  `build_retain_payload`). Switchroom's config schema is the primary gate, but
  it cannot see a hand-edited `settings.json` or a raw
  `HINDSIGHT_OBSERVATION_SCOPES` export — and a scope is invisible after the
  write, so a value quietly ignored today reads as a bank whose observations
  never merged months later. Empty/whitespace stays UNSET, matching the
  existing "an empty export hands authority back to the config file" idiom.
  The accepted tuple (`OBSERVATION_SCOPES_VALUES`) is paired with
  `src/memory/observation-scopes.ts` on the switchroom side; widening the set
  means widening both.

### Changed (switchroom divergence)

- **SessionStart hook runs async so its durability work stops being killed
  mid-drain** (`hooks/hooks.json`, `scripts/session_start.py`). The hook does
  the recovery a prior session's abrupt death skipped — drain the
  SessionEnd-queued retains (#1071) and reconcile un-committed transcript turns
  (#3244). Those two carry independent 4s wall-clock budgets
  (`HINDSIGHT_DRAIN_BUDGET_S` / `HINDSIGHT_RECONCILE_BUDGET_S`), each sized in
  isolation against the old synchronous 5s SessionStart timeout, plus a ~2s
  Mode-1 external-server health probe. Summed, they routinely overran 5s, so
  Claude Code SIGKILLed the hook part-way through — truncating exactly the
  durability work it exists to do and letting the pending-retains backlog grow
  (fleet transcripts carry 1000+ `hook_cancelled` attachments for
  `session_start.py`, all `timedOut: true` with `durationMs > 5000`; a
  successful firing injects no `additionalContext` and so leaves no record,
  which made the failures look like ~100% of firings when the true rate is
  unmeasurable from attachments). Setting `"async": true` on the hook (the same
  non-blocking pattern the Stop-event `retain.py` already uses) detaches it from
  the SessionStart critical path: it injects no context, so nothing depends on
  it finishing first and async's dropped context costs nothing. The `timeout`
  ceiling rises 5s → 30s purely as a background-lifetime bound above the ~10s
  summed sub-budgets — it never re-introduces a startup block, because drain and
  reconcile self-cap at their budgets regardless. The drain stays in the hook
  (not deferred wholly to the `hindsight-drain` sidecar, which `start.sh` only
  starts conditionally — when it is absent this hook is the sole backlog path)
  and `reconcile_tail`, which has no sidecar equivalent, stays here and now runs
  to completion; its over-budget remainder still resumes on the next boot.
  Concurrent drain with the sidecar stays safe via `drain_pending`'s exclusive
  `fcntl.flock`. Pinned by `scripts/tests/test_session_start_durability.py`
  (drain + reconcile are still invoked, in order) and
  `tests/hindsight-session-start-async.test.ts` (the async flag + budget-clearing
  ceiling survive the scaffold's hooks-override round-trip).

- **Recall/retain hygiene guard-rail batch** (`scripts/recall.py`,
  `scripts/subagent_retain.py`, `scripts/lib/content.py`, `scripts/tests/**`).
  Closes guard-rail debt in the fork's hook scripts before extending them:
  - **#3766** — `shape_recall_query` no longer drops a single-char SUBJECT
    ('C', 'R', a single-digit version) before the stopword fallback runs. The
    `len(t) > 1` guard moved into the fallback, so a single-char content word
    survives while single-char stopwords are still removed.
  - **#3578** — `_overlap_tokens` (the #3369 transcript-fallback tokenizer) now
    accumulates alphanumeric runs (`isalnum`), so issue numbers, ports and
    versions ('3993', ':9077', 'v0') carry signal and match symmetrically on
    both the query and transcript sides. A lone digit is still dropped as noise.
  - **#3994** — the sidechain volume gate counts ONLY the chars the text-only
    retain path keeps (`retained_text_char_count` → `_extract_text_content`),
    not the `tool_use` inputs the payload drops. Gate and payload now measure
    the same char set, so a tool-heavy / prose-light fork that used to clear the
    gate and retain a near-empty document is now correctly skipped. The
    2,000-char floor was re-measured against the corrected metric —
    `docs/measurements/subagent-volume-gate-3994.md`, replay harness
    `scripts/tests/data/replay_volume_gate_3994.py`.
  - **#4001** — the "window formatted to empty despite clearing the gate" skip
    now emits an unconditional stderr line, not a debug-only log that was silent
    in shipped settings.
  - **#3999 / #3777** — rewrote the vacuous sidechain config-mutation test to
    assert on the config object the code actually receives (RED when the copy
    fix is deleted), and restored direct characterisation of `_overlap_tokens`
    (`scripts/tests/test_overlap_tokens.py`) that was deleted with the removed
    lexical gate while the tokenizer stayed load-bearing.

- **`MAX_DIRECTIVES` 15 → 30, and truncation is no longer SILENT**
  (`scripts/lib/directives.py`). Live fleet active-directive counts were 24
  (assistant), 17 (klanker), 15 (carrie) against a client-side cap of 15, so the
  busiest bank had 9 of its hard rules dropped from every turn's prompt with no
  signal anywhere: the `(+N more, omitted)` footer only tells the AGENT. 30
  clears the observed fleet maximum with headroom while staying bounded (the
  block is injected on EVERY turn — this is a per-turn token cost, not a free
  knob; the constant is commented as such). `format_active_directives_block`
  now also prints a `[Hindsight] directive truncation: …` warn line to stderr
  whenever it drops directives, and `recall.py` records the dropped count as
  `directives_omitted` on the recall_log row.

  Visibility correction (2026-07-25 review): hook stderr is NOT an operator
  channel. `docker logs --tail 20000` across all 12 live agent containers
  returns ZERO `[Hindsight]` lines, and nothing under `~/.switchroom/logs/`
  contains them either, despite months of runtime and several long-standing
  stderr paths in `recall.py` — Claude Code swallows hook stderr on a zero
  exit. The stderr line is kept as a last-resort breadcrumb; the channels that
  actually reach an operator are the `directives_omitted` recall_log field and
  `switchroom doctor`'s directive-count row. Paired switchroom-side:
  `src/cli/doctor-memory.ts` `MAX_DIRECTIVES` 15 → 30 and
  `DIRECTIVE_WARN_THRESHOLD` 12 → 24 (a drift-guard test pins the TS constant
  to the Python one). The `MAX_DIRECTIVES` cost comment now states the real
  mechanism (rebuilt every `UserPromptSubmit`, appended into the conversation,
  so cost is per-turn CUMULATIVE) with the measured live figures. Acceptance:
  `scripts/tests/test_directives.py`
  (`test_cap_is_30_and_clears_the_observed_fleet_maximum`,
  `test_truncation_emits_a_stderr_breadcrumb_naming_the_dropped_count`,
  `test_count_omitted_directives_matches_the_rendered_footer`).

- **`retainMission` rewritten with explicit, enumerated exclusions**
  (`settings.json`). The extraction model is a small local `gpt-oss-20b`, and
  the previous one-line "Ignore routine greetings and transient operational
  details" did not hold: production banks contain pure transcript traces
  ("The assistant used ToolSearch to query for hindsight bank statistics"),
  hindsight's own batch failures with the UUID inline, restatements of the
  then-current prompt, and undated transient state ("User has no unread mail",
  which then recalls forever as a standing fact). The new mission enumerates
  those noise classes as NEVER-extract bullets and adds a positive
  counterweight ("a preference revealed by a request is durable") — without it,
  an exclusion-only mission made the model return a degenerate/empty response
  on chatty-but-real turns in a 6-window live sample. The text is pinned
  byte-for-byte to switchroom's `DEFAULT_RETAIN_MISSION`
  (`src/memory/hindsight.ts`) by a drift guard, because BOTH reach the same
  extraction step: switchroom seeds the bank-side mission at scaffold, and the
  plugin independently pushes this one via `lib/bank.py: ensure_bank_mission`
  on a fresh state dir. Before this change the two texts differed.

  One 2026-07-25 review correction folded in, itself corrected by the
  re-review: the rewrite DID reach existing agents, but unsafely.
  `ensure_bank_mission` short-circuits on the already-seeded flag in
  `bank_missions.json`, so the plugin was never the propagation path — but
  `switchroom apply` re-scaffolds every agent, and scaffold pushed
  `retain_mission` unconditionally on every run. That is why all 24 live banks
  carried the 2026-07-19 text even though no agent sets `retain_mission` in
  yaml. The hazard was the unconditional overwrite, not a stuck mission.
  Switchroom now routes BOTH of its bank-op sites (scaffold and
  `reconcileAgent`) through `decideRetainMissionUpgrade`: the mission upgrades
  only when the bank's current text byte-equals a known previous default
  (`SUPERSEDED_RETAIN_MISSIONS`) or is unset, so a customized mission matches
  nothing and is never clobbered.

  A second proposed correction — narrowing the "Greetings, acknowledgements,
  and routine operational chatter" bullet and adding a personal-preference
  clause — was written and then REVERTED. Sampling did not reproduce the
  preference loss it was meant to fix, and the narrowed mission extracted MORE
  noise than both this text and the pre-PR default on a real operational
  window (8 facts vs 0 vs 4, including in-flight worker narration its own
  bullet forbids). The sampling method is also n=1-unreliable: identical input
  under the identical narrowed mission gave 0, 6, 6. No extraction-quality
  claim is made here in either direction; the mission-content question is
  deferred to switchroom#3532 (profile-scoped retain missions).

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
