"""Configuration management for Hindsight plugin.

Loads settings from settings.json (plugin defaults) merged with environment
variable overrides. Full config schema matching Openclaw's 30+ options.
"""

import json
import os
import re
import sys

#: Switchroom-local: strategies for the per-row curated observation scope.
#: ``curated`` (default) strips volatile provenance tags from the consolidation
#: scope, keeping stable semantic ones; ``shared`` pools every retain into one
#: bank-wide untagged scope; ``combined`` / ``off`` emit no per-row scope (the
#: pre-feature engine default). See ``compute_observation_scopes``.
OBSERVATION_SCOPE_STRATEGIES = ("curated", "shared", "combined", "off")

#: Tag patterns treated as VOLATILE per-session provenance by ``curated``:
#: ``parent_session:<id>`` and a bare RFC-4122 UUID (what the ``{session_id}``
#: retain tag resolves to on the parent path). The UUID pattern also matches
#: the sidechain-derived ``<uuid>-sub-<agent_id>`` form, because
#: ``subagent_retain.py`` sets ``sub_session_id = f"{session_id}-sub-{agent_id}"``
#: and the ``{session_id}`` retain tag resolves to that — a per-invocation-unique
#: value that, if left in scope, defeats cross-session dedup on the dominant
#: (sidechain) observation path. A tag matching ANY of these is dropped from the
#: consolidation scope but LEFT on the source fact.
#:
#: ``^source:`` (switchroom provenance tagging) is in the list for a different
#: reason than the other two, and the name of the constant undersells it: what
#: this list really means is "tags excluded from the CONSOLIDATION SCOPE, kept
#: on the source fact". ``source:transcript`` is the opposite of volatile — it
#: is stamped identically on every auto-retain, forever. That is exactly why it
#: must not reach the scope: a stable tag flips ``curated`` from the bank-wide
#: ``"shared"`` scope to an explicit ``[["source:transcript"]]`` partition, so
#: every observation consolidated after the tag ships would be isolated from
#: every observation consolidated before it. The tag is a RECALL-side filter
#: handle (``metadata`` is not filterable, tags are), not a consolidation
#: partition, so scope computation must stay byte-identical to before it
#: existed. Pinned against ``RETAIN_PROVENANCE_TAG_SCOPE_PATTERN`` in
#: ``src/memory/hindsight-retain-provenance.ts``.
DEFAULT_VOLATILE_SCOPE_PATTERNS = (
    r"^parent_session:",
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(-sub-.+)?$",
    r"^source:",
)

DEFAULTS = {
    # Recall
    "autoRecall": True,
    # Switchroom fleet default: "mid". The budget sets candidate DEPTH — how
    # many nodes the engine pulls across all TEMPR retrieval stages before
    # ranking (recall_budget_fixed_low=100 / _mid=300 / _high=1000 units,
    # hindsight_api engine/memory_engine.py). It does NOT gate the reranker:
    # the cross-encoder runs at EVERY budget level and is bounded separately by
    # RERANKER_MAX_CANDIDATES (HINDSIGHT_API_RERANKER_MAX_CANDIDATES, default
    # 300), so "low" is not "vector-only, no rerank" — it is a shallower
    # candidate pool feeding the same rerank+score pipeline. "mid" (300 nodes)
    # is upstream's own default and the balanced point: deeper recall than
    # "low" without "high"'s 1000-node cold-page tail. Operators who want the
    # shallow/fast pool back set HINDSIGHT_RECALL_BUDGET=low via per-agent env
    # or write `recallBudget: "low"` into the user config file.
    "recallBudget": "mid",
    "recallMaxTokens": 1024,
    # Switchroom-local: cap on the number of memories injected into the
    # `<hindsight_memories>` block, regardless of token budget. Plugin v0.4.0
    # exposes `recallTopK` only in the Openclaw integration, not the
    # Claude Code integration, so we slice client-side in recall.py before
    # formatting. Set to 0 (or any non-positive value) to disable the cap
    # and inject everything Hindsight returns.
    "recallMaxMemories": 12,
    # Switchroom-local: per-bank slot FLOORS inside `recallMaxMemories`. The
    # merged multi-bank set is sorted globally by `scores.final` and then
    # head-sliced, which is winner-take-all across banks: when both banks return
    # more candidates than the cap, one bank's score distribution can fill every
    # slot and the agent gets a dossier about its operator with none of its own
    # working memory. These are FLOORS, not quotas: each side gets at most this
    # many slots, only if it has that many results, and only up to HALF the cap
    # between them — the other half is always awarded on pure global relevance,
    # so composition still moves with the scores. 0 disables reservation for
    # that side (the pure pre-fix head-slice). Env:
    # HINDSIGHT_RECALL_OWN_BANK_MIN_SLOTS /
    # HINDSIGHT_RECALL_ADDITIONAL_BANK_MIN_SLOTS. See recall.py's
    # `_reserve_bank_slots` and `_reservable_slots`. Vendor default is 0/0
    # (off); switchroom's scaffold opts in with 2 own / 1 additional against the
    # cap of 6 its fleet actually deploys.
    "recallOwnBankMinSlots": 0,
    "recallAdditionalBankMinSlots": 0,
    # Switchroom #3837: absolute floor on a result's engine relevance score
    # (`scores.final`) for it to be injected. 0.0 (default) DISABLES the floor
    # — nothing is dropped and the injected set is byte-identical to the
    # pre-#3837 behaviour. `recallMinScoreScope` decides which turns a
    # non-zero floor binds on: "degraded" (default) = only turns where the
    # agent's OWN bank timed out or was unreachable, which is the population
    # where a below-floor score actually predicts noise (98.4% of degraded
    # rows have a best injected score under 0.01, against 28.4% of healthy
    # ones); "all" = every turn, which #3761's replay says empties ~28% of
    # HEALTHY recalls at 0.01 and is not recommended as a fleet default. See
    # the design note above `_filter_by_min_score` in recall.py. Env:
    # HINDSIGHT_RECALL_MIN_SCORE / HINDSIGHT_RECALL_MIN_SCORE_SCOPE.
    "recallMinScore": 0.0,
    "recallMinScoreScope": "degraded",
    "recallTypes": ["world", "experience"],
    # Switchroom-local: when True (default; Ken-approved ON) recall biases
    # toward synthesized `observation`-tier facts. Escape hatch: pin off via
    # `recallPreferObservations: false` in the user config — read in recall.py.
    "recallPreferObservations": True,
    # Switchroom #2848 Stage B/C — deterministic directive capture.
    # When on (switchroom default; pinned true in the copied plugin
    # settings.json by applyHindsightSettingsOverrides), TWO deterministic
    # hooks share this knob:
    #   * Stage B (recall.py, UserPromptSubmit): regex-detects correction /
    #     standing-rule-shaped inbound and appends a terse advisory to the
    #     turn's additionalContext telling the model to persist the rule with
    #     create_directive if it IS durable.
    #   * Stage C (directive_verify.py, Stop): after the turn, re-checks the
    #     human turn against a HIGH-PRECISION durable-rule regex and, if the
    #     model recorded no create_directive call, blocks the stop ONCE to
    #     re-prompt capture (closes the "model ignored the nudge" gap).
    # Both are pure detection — no model callsite, no silent hook-side write;
    # the model authors the directive in-session (chat-legible). Operators opt
    # out per-agent via memory.directive_capture_nudge=false →
    # HINDSIGHT_DIRECTIVE_CAPTURE_NUDGE (disables BOTH hooks).
    "directiveCaptureNudge": True,
    # RFC phase4 P3 — operator-profile capture nudge (recall.py,
    # UserPromptSubmit). Regex-detects a first-person durable self-statement by
    # the operator and appends a terse advisory telling the model to persist it
    # with an explicit retain tagged `profile:ken` into the agent's OWN bank.
    # Pure detection — no model callsite, no silent hook-side write. Operators
    # opt out per-agent via memory.profile_capture_nudge=false →
    # HINDSIGHT_PROFILE_CAPTURE_NUDGE.
    "profileCaptureNudge": True,
    # Switchroom Memory v2 M3 Surface-A — directive-injection switch. When True
    # (default), recall.py injects the `<active_directives>` block on every
    # UserPromptSubmit at all three emit sites (main + prefetch/cache fast
    # paths). When False (a flipped M3 canary), that injection is SUPPRESSED —
    # the agent's standing rules come from the live rules block instead, which
    # is the change that collapses the always-on directive-token spend (E-41).
    # Suppression is fail-safe and re-checked every turn: it fires ONLY when a
    # non-empty rules block is physically present in CLAUDE.md; a False flag
    # with an empty/absent block keeps injecting AND emits a degraded-canary
    # notice, so a zero-standing-rules turn is unreachable. Operators flip a
    # canary per-agent via memory.inject_directives=false →
    # HINDSIGHT_INJECT_DIRECTIVES; the ordered flip (rules_block live → migrate
    # → this flag off) is enforced by `switchroom memory flip`.
    "injectDirectives": True,
    # Switchroom #2873/#2903 Fix 6.2 — the BLOCKING half (Stage C
    # directive_verify.py Stop hook) split out from the advisory nudge. When
    # True (default) the verifier may block the stop once to re-prompt capture;
    # when False the Stage B nudge still fires but the Stop hook NEVER blocks
    # (advisory-only mode). Lets an operator keep the gentle nudge while dropping
    # the more intrusive block. Gated UNDER directiveCaptureNudge: turning the
    # nudge off disables both regardless of this knob. Operators opt out
    # per-agent via memory.directive_capture_verify=false →
    # HINDSIGHT_DIRECTIVE_CAPTURE_VERIFY.
    "directiveCaptureVerify": True,
    # Memory v2 M5 — orientation-at-boot (Surface B). All four fail-safe by
    # default so a stripped/absent key (the Zod-strip footgun, carve §1) boots
    # exactly as pre-M5. `memoryOrientationEnabled` is the per-agent kill switch,
    # default OFF (dark build — the orientation SessionStart hook no-ops before
    # any bank resolve or network call when off). `memoryOrientationModel` is the
    # mental-model NAME the hook resolves to an id (the agent's OWN bank).
    # `memoryOrientationCadenceHours` is the per-agent refresh cadence tier
    # (klanker/overlord 24, everyone else 48) the staleness guard's per-tier
    # thresholds (1.5×/3×) key on. `memoryOrientationReinjectTurns` is the
    # epic's optional per-turn re-inject knob, default 0 = SessionStart+compaction
    # only (the cheap path; N>0 is the ~55M/30d-at-every-turn expensive variant,
    # which is why it defaults off). Delivered per-agent via the scaffold
    # settings.json stamp and overridable via the HINDSIGHT_ORIENTATION_* env.
    "memoryOrientationEnabled": False,
    "memoryOrientationModel": "orientation",
    "memoryOrientationCadenceHours": 48,
    "memoryOrientationReinjectTurns": 0,
    # Switchroom hindsight-leverage A4 — TTL (seconds) for the directives-list
    # cache on the recall critical path (see lib/directives.py). The list is
    # re-fetched at most once per TTL window for no-write turns; in-session
    # directive writes invalidate the cache immediately via directive_verify.py.
    # 0 disables the cache (live fetch every turn — the A4 rollback lever).
    "directivesCacheTtlSeconds": 120,
    # Switchroom hindsight-leverage A2 (PR2): default 2 so a bare follow-up
    # user message ("and the port?", "what about staging?") embeds together
    # with its antecedent turn, instead of recalling on the pronoun alone.
    # Bounded by recallMaxQueryChars (truncate_recall_query preserves the
    # latest turn and drops oldest context first) so the composition can never
    # blow the recall query budget; the transcript read is byte-tail-bounded
    # by recallTranscriptTailBytes so the added per-turn read stays O(1).
    "recallContextTurns": 2,
    "recallMaxQueryChars": 800,
    # Switchroom #3757 — BM25 term budget for the query put on the wire.
    # `recallMaxQueryChars` bounds CHARACTERS; the server's keyword arm costs
    # per DISTINCT TERM, because it OR-joins every token into one tsquery and
    # Postgres native FTS ranks the entire matched set before the top-60
    # heapsort. An 800-char composed query is ~96 distinct terms and matched
    # 119,510 rows on the live `overlord` bank — 14.0s for the 3-arm UNION,
    # and up to 94s under load, past the
    # per-bank client timeout, so the agent got NOTHING on 96.8% of its
    # own-bank recalls in the 7 days to 2026-07-27. 24 terms measures at
    # 48,433 rows / 2.7s on the same bank while keeping the high-signal terms
    # of the latest turn. Selection is recency-first (latest turn beats prior
    # context), then by a selectivity proxy — see lib/content.shape_recall_query.
    # 0 disables shaping entirely (rollback lever).
    # Operator knob: `memory.recall.query_max_tokens` in switchroom.yaml.
    "recallQueryMaxTokens": 24,
    # Switchroom #3757 — extra terms to drop from the BM25 query on top of the
    # built-in English stopword list. For BANK-SPECIFIC high-document-frequency
    # words a generic stoplist cannot know about: on `overlord`, `switchroom`
    # matches 27,090 of 135,443 rows (20%) and `agent` 26,496 (20%), purely
    # because that is what the corpus is about. Empty by default — an operator
    # sets it per-agent after reading `switchroom memory recall-log <agent>`.
    # Operator knob: `memory.recall.query_stop_terms` in switchroom.yaml.
    "recallQueryStopTerms": [],
    # Switchroom hindsight-leverage A2 (PR2) — latency bound for the multi-turn
    # composition. With recallContextTurns>1 now the default, EVERY recall reads
    # the transcript to slice the last N human turns. A long session's .jsonl can
    # grow to many MB, so read only the last N bytes (complete trailing lines);
    # the last 2-3 human turns always live at the tail. 0 disables the bound
    # (read the whole file — the pre-A2 behaviour / rollback lever).
    "recallTranscriptTailBytes": 262144,
    "recallRoles": ["user", "assistant"],
    # Upstream 962140eef — optional recall tag filters passed through to the
    # recall API, plus per-additional-bank overrides keyed by bank ID.
    "recallTags": [],
    "recallTagsMatch": "any",
    "recallTagGroups": None,
    "recallAdditionalBankFilters": {},
    # Switchroom (hindsight-leverage PR5) — per-tag recall score weights. A map
    # of ``{tag: multiplier}`` applied to each result's ``scores.final`` just
    # before the final relevance sort/cap in recall.py. A weight < 1.0 DEMOTES
    # (down-ranks) memories carrying that tag without DROPPING them — distinct
    # from the hard demote-tag drop filter (`_is_demoted_memory`), which removes
    # a memory from recall entirely. This is the "reduced weight" the drop
    # filter cannot express: a demoted memory still surfaces when it is the only
    # relevant hit, just below equal-scoring untagged memories. Default {} =
    # no-op (identity weighting). Switchroom's scaffold seeds
    # ``{"sidechain": 0.8}`` so delegated sub-agent process-memories rank just
    # under first-party session memories. Env: HINDSIGHT_RECALL_TAG_WEIGHTS
    # (JSON object).
    "recallTagWeights": {},
    "recallPromptPreamble": (
        "Relevant memories from past conversations (prioritize recent when "
        "conflicting). Only use memories that are directly useful to continue "
        "this conversation; ignore the rest:"
    ),
    # Retain
    "autoRetain": True,
    "retainMode": "full-session",
    "retainRoles": ["user", "assistant"],
    "retainEveryNTurns": 10,
    "retainOverlapTurns": 2,
    "retainToolCalls": True,
    # Switchroom — speaker-aware retain context. Resolved per-retain via
    # build_retain_payload's _resolve_template, which fills {agent} from
    # SWITCHROOM_AGENT_NAME and {bank_id} from the target bank. Tells the
    # consolidation LLM who is speaking on each line so first-person agent
    # actions ("experience") are not confused with the operator's world facts.
    "retainContext": (
        "Transcript of Claude Code agent '{agent}' ({bank_id}). "
        "'assistant'/tool lines are the agent's own first-person actions "
        "(experience); 'user' lines are the human operator speaking (their "
        "statements are world facts)."
    ),
    "retainTags": [],
    "retainMetadata": {},
    # Switchroom-local: per-row Hindsight `observation_scopes` on every retain.
    # `"shared"` makes consolidation write this item's observations into ONE
    # global untagged scope instead of a scope per tag — what a set of agents
    # pooling one bank needs. `None` (the default) omits the field from the
    # wire body entirely, leaving the engine's own default in force. Set by
    # start.sh from `agents.<name>.memory.observation_scopes` (cascading
    # through `defaults.memory.observation_scopes`) via
    # HINDSIGHT_OBSERVATION_SCOPES, exported ONLY when the operator opted in.
    "observationScopes": None,
    # Switchroom hindsight-leverage — CURATED observation scopes (default ON).
    # `combined` (the pre-feature engine default) makes consolidation dedup an
    # observation only against others carrying the IDENTICAL tag set. Because
    # switchroom stamps volatile per-session provenance on every retain
    # (`{session_id}` → a bare UUID tag, and `parent_session:<uuid>` /
    # `sidechain` / `agent_type:*` on sub-agent retains), that turns every
    # session into its own dedup island — cross-session dedup never happens.
    #
    # `curated` (default) strips ONLY the volatile provenance tags
    # (`observationScopeVolatilePatterns`) from the CONSOLIDATION scope, keeping
    # the stable semantic ones (`lesson`, `anti-pattern`, `agent_type:*`,
    # `sidechain`, entities). The stripped tags STAY on the source fact (still
    # queryable / recall-filterable) — only the observation's dedup scope is
    # narrowed. Non-empty stable set → the explicit scope `[[stable…]]`; empty
    # stable set (e.g. a retain tagged only with a session id) → `"shared"`,
    # one bank-wide untagged scope. This preserves recall tag-weighting on the
    # observation layer (the kept tags still ride the observation) while giving
    # cross-session dedup. Docs: https://hindsight.vectorize.io/developer/api/retain
    # ("shared") and /developer/observations (scope isolation via all_strict).
    #
    # Opt-out: set `observationScopeStrategy` to `combined` (or `off`) — both
    # emit no per-row scope, restoring the exact pre-feature engine default. A
    # manually-pinned `observationScopes` (memory.observation_scopes) STILL wins
    # over the strategy, so operators who set `per_tag` / `all_combinations` /
    # `shared` keep that behaviour unchanged.
    "observationScopeStrategy": "curated",
    # Tag patterns treated as VOLATILE (stripped from the curated scope, kept on
    # the source fact). Defaults: `parent_session:<id>` and a bare RFC-4122
    # UUID (what `{session_id}` resolves to). Overridable via settings.json /
    # ~/.hindsight/claude-code.json for a bank with an unusual provenance tag.
    "observationScopeVolatilePatterns": list(DEFAULT_VOLATILE_SCOPE_PATTERNS),
    # Switchroom hindsight-leverage E2 / PR9 (#398) — lesson & anti-pattern
    # tagging at retain time. When on (default), build_retain_payload scans the
    # formatted transcript slice for explicit lesson / anti-pattern markers and
    # attaches the matching tag(s) to the retain. This is the retain-side half of
    # #398: a transcript that captures a failure mode ("anti-pattern:", "what not
    # to do") or a self-recognised lesson ("lesson learned", "note to self:") is
    # tagged so the recall-side score-penalty weight map (recallTagWeights, PR5)
    # can DEMOTE it below clean first-party session memories — without ever hard-
    # dropping it. NON-GOAL (epic-recorded): historical corpus is NOT re-tagged;
    # this fires on NEW retains only. Detection is deterministic substring match
    # (case-insensitive), never model-dependent. Disable via
    # HINDSIGHT_LESSON_TAGGING=false (rollback lever).
    "lessonTagging": True,
    # Marker map {tag: [substrings]}. A slice whose lower-cased text contains ANY
    # of a tag's substrings gets that tag. Deliberately explicit prefixes to keep
    # false positives low — a passing mention of the word "lesson" should not tag
    # a whole transcript; an explicit "lesson learned" / "anti-pattern:" should.
    # Operators can extend/replace via HINDSIGHT_LESSON_TAG_MARKERS (JSON object).
    "lessonTagMarkers": {
        "lesson": [
            "lesson learned",
            "lessons learned",
            "lesson:",
            "note to self:",
            "for next time:",
            "takeaway:",
            "key takeaway",
        ],
        "anti-pattern": [
            "anti-pattern:",
            "anti pattern:",
            "antipattern:",
            "what not to do",
            "do not do this again",
            "don't do this again",
            "failure mode:",
        ],
    },
    # Switchroom hindsight-leverage E2 / PR9 (#398) — recall-side demotion weights
    # for the lesson/anti-pattern tags above. Merged UNDER recallTagWeights at
    # recall time (an explicit recallTagWeights entry for the same tag WINS), so
    # lesson/anti-pattern transcripts are down-ranked out of the box while the
    # PR5 sidechain seed and any operator override still compose cleanly. A raw
    # transcript that merely discusses a failure mode should rank below a clean
    # session memory of equal engine score, yet still surface when it is the only
    # relevant hit (re-rank, never drop). Set HINDSIGHT_LESSON_DEMOTION=false to
    # disable the built-in weights (rollback lever); override individual weights
    # via recallTagWeights / HINDSIGHT_RECALL_TAG_WEIGHTS.
    "lessonDemotion": True,
    "lessonDemotionWeights": {"lesson": 0.85, "anti-pattern": 0.5},
    # Switchroom #3244 — boot reconciliation of un-committed transcript tails.
    # On by default; the load-bearing recovery for work an abrupt session death
    # (SIGKILL/OOM/watchdog) skipped. Disable per-agent via
    # HINDSIGHT_RECONCILE_ON_START=false. reconcile_tail.py also honours the
    # HINDSIGHT_RECONCILE_{LOOKBACK_H,MAX_TURNS,BUDGET_S} bounds (read directly).
    "reconcileOnStart": True,
    "recallAdditionalBanks": [],
    # Switchroom hindsight-leverage A3 — parallelise multi-bank recall.
    # When on (default), the directives fetch and every bank recall run
    # concurrently in daemon threads under ONE shared deadline
    # (recallParallelDeadlineSeconds), so total critical-path latency is the
    # SLOWEST slot instead of their SUM. Set false
    # (HINDSIGHT_RECALL_PARALLEL=false) to restore the pre-A3 serial path —
    # the rollback lever if the parallel path ever misbehaves.
    "recallParallel": True,
    # Shared deadline (seconds) for the whole parallel recall section. Sized
    # at the UserPromptSubmit hook ceiling (12s, hooks.json) MINUS 2s headroom
    # for block formatting + cache write + stdout flush, so a straggler bank
    # can never push the hook past its ceiling. Slots still unfinished when the
    # deadline elapses are abandoned (daemon threads) and marked timed_out.
    "recallParallelDeadlineSeconds": 10,
    # Switchroom #3757 — per-bank HTTP read timeout (seconds) for one recall
    # request. Was a hardcoded `timeout=8` in recall.py, which made it BOTH the
    # binding constraint on a slow bank AND un-tunable without hand-editing the
    # installed plugin — and a hand-edit does not survive `switchroom apply`,
    # which re-copies the plugin from `vendor/hindsight-memory` (that revert is
    # exactly what put the 8s literal back on 2026-07-27). 12s matches the
    # UserPromptSubmit hook ceiling in hooks.json; the shared
    # `recallParallelDeadlineSeconds` (10s) is the tighter outer guard in the
    # default configuration, so this is a per-request safety net rather than
    # the primary bound. Non-positive values fall back to the default.
    # Operator knob: `memory.recall.request_timeout_seconds` in switchroom.yaml.
    "recallRequestTimeoutSeconds": 12,
    # Switchroom hindsight-leverage E1 / PR8 (#3369) — bounded transcript-grep
    # fallback. Boot reconciliation (reconcile_tail.py) closes the crash-loss
    # window at the NEXT SessionStart, but between an abrupt kill and that boot,
    # live recall returns nothing for the lost turns because the fact layer was
    # never told about them. When on (default) AND every bank returned zero
    # results AND no bank/directives slot hit its deadline (deadline_hit False —
    # so a timed-out bank can't masquerade as a genuinely empty fact layer, the
    # #3369 sequencing constraint that depends on A3's shared-deadline telemetry),
    # recall greps the CURRENT session's transcript tail for turns that mention
    # the query's terms and injects them as a clearly-labelled, lower-confidence
    # fallback block. Everything is bounded: the tail read (…MaxBytes), the number
    # of matched turns (…MaxTurns), the emitted characters (…MaxChars), and the
    # grep wall-time (…DeadlineMs). Set false (HINDSIGHT_RECALL_TRANSCRIPT_FALLBACK
    # =false) to disable — the rollback lever.
    "recallTranscriptFallback": True,
    # Tail bytes read from the session transcript for the grep. 256 KiB covers
    # many turns of recent conversation while keeping the read well inside the
    # hook budget; only the LAST max_bytes are read (partial first line dropped).
    "recallTranscriptFallbackMaxBytes": 262144,
    # Hard ceiling on matched turns injected into the fallback block.
    "recallTranscriptFallbackMaxTurns": 6,
    # Hard ceiling on the fallback block's excerpt characters.
    "recallTranscriptFallbackMaxChars": 2000,
    # Wall-clock bound (ms) on the grep itself — abandons scanning older turns
    # once exceeded so the fallback can never eat the recall critical path.
    "recallTranscriptFallbackDeadlineMs": 1500,
    # Connection
    "hindsightApiUrl": None,
    "hindsightApiToken": None,
    "apiPort": 9077,
    "daemonIdleTimeout": 0,
    "embedVersion": "latest",
    "embedPackagePath": None,
    # Upstream 55ef70679 — optional global HTTP request timeout override
    # (seconds). None = keep each call's own default. NOTE: switchroom's
    # recall.py deliberately does NOT wire this override into its client —
    # recall carries its own 8s hook-budget timeout (see recall.py). This
    # mainly benefits retain's 15s timeout on slow/loaded servers.
    "requestTimeoutSeconds": None,
    # Bank
    "bankId": None,
    "bankIdPrefix": "",
    "dynamicBankId": False,
    "dynamicBankGranularity": ["agent", "project"],
    "bankMission": "",
    "retainMission": None,
    "agentName": "claude-code",
    # LLM (for daemon mode)
    "llmProvider": None,
    "llmModel": None,
    "llmApiKeyEnv": None,
    # Misc
    "debug": False,
}

# Map env var names to config keys and their types
ENV_OVERRIDES = {
    "HINDSIGHT_API_URL": ("hindsightApiUrl", str),
    "HINDSIGHT_API_TOKEN": ("hindsightApiToken", str),
    "HINDSIGHT_BANK_ID": ("bankId", str),
    "HINDSIGHT_AGENT_NAME": ("agentName", str),
    "HINDSIGHT_AUTO_RECALL": ("autoRecall", bool),
    "HINDSIGHT_AUTO_RETAIN": ("autoRetain", bool),
    "HINDSIGHT_RETAIN_MODE": ("retainMode", str),
    # Switchroom-local: auto-retain cadence knobs. These had a DEFAULTS entry and
    # a settings.json stamp (applyHindsightSettingsOverrides) but NO env channel,
    # so env — the TOP of the config precedence chain (DEFAULTS → settings.json →
    # ~/.hindsight/claude-code.json → env) — could not reach them at all. That
    # broke parity with the recall knobs and left the only override paths as a
    # settings.json rewrite (scaffold-time) or a hand-edit that `switchroom apply`
    # re-copies away. Adding the env keys lets `memory.retain.*` (or an agent
    # `env:` map, or a docker-exec'd retain that does not inherit the supervised
    # env) drive them, and makes the env value authoritative when set.
    # `retainEveryNTurns` / `retainOverlapTurns` mirror the yaml surface
    # (`memory.retain.every_n_turns` / `.overlap_turns`); `retainContext` /
    # `retainTags` have no yaml surface yet but gain the same env channel as the
    # other retain knobs for consistency and exec-path overrides.
    "HINDSIGHT_RETAIN_EVERY_N_TURNS": ("retainEveryNTurns", int),
    "HINDSIGHT_RETAIN_OVERLAP_TURNS": ("retainOverlapTurns", int),
    "HINDSIGHT_RETAIN_CONTEXT": ("retainContext", str),
    "HINDSIGHT_RETAIN_TAGS": ("retainTags", list),
    # `retainToolCalls` (RFC memory-redesign P4): whether retain stores tool_use
    # inputs + tool_result content. Had a DEFAULTS entry (True) but — like the
    # cadence knobs before them — no env channel and no scaffold stamp, so an
    # operator could not opt an agent out and a docker-exec'd retain/backfill
    # could not be steered. Adding the env key mirrors the yaml surface
    # (`memory.retain.tool_calls`) and closes the same drift class. `false`
    # (via `false`/`0`/`no`) resolves to Python False and lands over the True
    # default; unset keeps True, byte-identical.
    "HINDSIGHT_RETAIN_TOOL_CALLS": ("retainToolCalls", bool),
    # Switchroom-local: per-row observation scope on retains. Set by start.sh
    # from agents.<name>.memory.observation_scopes (cascading through
    # defaults.memory.observation_scopes) ONLY when the operator set it; unset
    # leaves `observationScopes` None and the field off the wire entirely.
    "HINDSIGHT_OBSERVATION_SCOPES": ("observationScopes", str),
    # Opt-out / override the curated default. `combined` or `off` restore the
    # pre-feature engine default; `curated` (the shipped default) / `shared`
    # select the computed strategies. Off-list values fall back to `curated`
    # (shouted, never raised) — see compute_observation_scopes.
    "HINDSIGHT_OBSERVATION_SCOPE_STRATEGY": ("observationScopeStrategy", str),
    # Switchroom hindsight-leverage E2 / PR9 (#398) — lesson/anti-pattern tagging
    # + recall demotion toggles and overrides.
    "HINDSIGHT_LESSON_TAGGING": ("lessonTagging", bool),
    "HINDSIGHT_LESSON_TAG_MARKERS": ("lessonTagMarkers", dict),
    "HINDSIGHT_LESSON_DEMOTION": ("lessonDemotion", bool),
    "HINDSIGHT_LESSON_DEMOTION_WEIGHTS": ("lessonDemotionWeights", dict),
    # Switchroom #3244 — boot reconciliation on/off (default on).
    "HINDSIGHT_RECONCILE_ON_START": ("reconcileOnStart", bool),
    "HINDSIGHT_RECALL_BUDGET": ("recallBudget", str),
    "HINDSIGHT_RECALL_MAX_TOKENS": ("recallMaxTokens", int),
    # Switchroom-local: count cap. Set by start.sh from
    # agents.<name>.memory.recall.max_memories (cascading through
    # defaults.memory.recall.max_memories) when present in switchroom.yaml.
    "HINDSIGHT_RECALL_MAX_MEMORIES": ("recallMaxMemories", int),
    # Switchroom-local: per-bank slot floors inside the count cap. Set by
    # start.sh from agents.<name>.memory.recall.own_bank_min_slots /
    # .additional_bank_min_slots (cascading through defaults). 0 = off.
    "HINDSIGHT_RECALL_OWN_BANK_MIN_SLOTS": ("recallOwnBankMinSlots", int),
    "HINDSIGHT_RECALL_ADDITIONAL_BANK_MIN_SLOTS": ("recallAdditionalBankMinSlots", int),
    # Switchroom #3837: absolute `scores.final` floor + the population it binds
    # on. Set by start.sh from agents.<name>.memory.recall.min_score /
    # .min_score_scope (cascading through defaults), exported only when the
    # operator opted in. 0.0 = off (the default, and the shipped behaviour).
    "HINDSIGHT_RECALL_MIN_SCORE": ("recallMinScore", float),
    "HINDSIGHT_RECALL_MIN_SCORE_SCOPE": ("recallMinScoreScope", str),
    # Switchroom-local: recall fact types (comma-separated). Set by start.sh
    # from agents.<name>.memory.recall.types only when the operator overrode
    # the switchroom default (world,experience,observation) — i.e. the
    # opt-out path for the synthesized `observation` tier.
    "HINDSIGHT_RECALL_TYPES": ("recallTypes", list),
    # Switchroom-local: trivial-turn recall skip (Phase 6a). Set by start.sh
    # from agents.<name>.memory.recall.skip_trivial only on override; the
    # switchroom default is on (recall.py falls back to True).
    "HINDSIGHT_RECALL_SKIP_TRIVIAL": ("recallSkipTrivial", bool),
    # Switchroom #3841: the last three recall settings that had a config key but
    # no env channel at all, so switchroom.yaml could not reach them and a
    # hand-edit of the installed plugin did not survive `switchroom apply`. Set
    # by start.sh from agents.<name>.memory.recall.prefer_observations / .roles /
    # .prompt_preamble (cascading through defaults), always exported at their
    # existing effective values, so an operator who sets none of them sees no
    # change. The other #3841 knobs (budget, max_tokens, context_turns,
    # max_query_chars, transcript_tail_bytes, tags, tags_match, tag_groups,
    # tag_weights, additional_bank_filters, transcript_fallback, parallel)
    # already had entries in this table and only needed the yaml surface.
    "HINDSIGHT_RECALL_PREFER_OBSERVATIONS": ("recallPreferObservations", bool),
    "HINDSIGHT_RECALL_ROLES": ("recallRoles", list),
    "HINDSIGHT_RECALL_PROMPT_PREAMBLE": ("recallPromptPreamble", str),
    # Switchroom #2848 Stage B: directive-capture nudge on/off. Set by
    # start.sh from agents.<name>.memory.directive_capture_nudge only when
    # the operator overrode it; the switchroom default is on (settings.json
    # pins true; recall.py falls back to True).
    "HINDSIGHT_DIRECTIVE_CAPTURE_NUDGE": ("directiveCaptureNudge", bool),
    # RFC phase4 P3: operator-profile capture nudge on/off. Set by start.sh from
    # agents.<name>.memory.profile_capture_nudge only when the operator overrode
    # it; the switchroom default is on (settings.json pins true; recall.py falls
    # back to True).
    "HINDSIGHT_PROFILE_CAPTURE_NUDGE": ("profileCaptureNudge", bool),
    # Switchroom Memory v2 M3 Surface-A: directive-injection switch on/off. Set
    # by start.sh from agents.<name>.memory.inject_directives only when the
    # operator overrode it; the switchroom default is on (settings.json pins
    # true; recall.py falls back to True). False SUPPRESSES the
    # <active_directives> injection for a flipped canary, fail-safe on a live
    # rules block (see recall.py directive_injection_decision).
    "HINDSIGHT_INJECT_DIRECTIVES": ("injectDirectives", bool),
    # Switchroom #2873/#2903 Fix 6.2: the Stage C block on/off, independent of
    # the Stage B nudge. Set by start.sh from
    # agents.<name>.memory.directive_capture_verify only when the operator
    # overrode it; the switchroom default is on.
    "HINDSIGHT_DIRECTIVE_CAPTURE_VERIFY": ("directiveCaptureVerify", bool),
    # Memory v2 M5 — orientation-at-boot. Env override channel for the four
    # orientation knobs (settings.json carries the per-agent value; env wins for
    # a docker-exec'd hook or an agent `env:` map). `memoryOrientationEnabled`
    # is the per-agent kill switch (default off); the model NAME, cadence tier,
    # and reinject count follow. See DEFAULTS above and carve-M5 §4.
    "HINDSIGHT_ORIENTATION_ENABLED": ("memoryOrientationEnabled", bool),
    "HINDSIGHT_ORIENTATION_MODEL": ("memoryOrientationModel", str),
    "HINDSIGHT_ORIENTATION_CADENCE_HOURS": ("memoryOrientationCadenceHours", int),
    "HINDSIGHT_ORIENTATION_REINJECT_TURNS": ("memoryOrientationReinjectTurns", int),
    # Switchroom hindsight-leverage A4 — directives-list cache TTL (seconds).
    # 0 disables the cache (rollback lever).
    "HINDSIGHT_DIRECTIVES_CACHE_TTL_SECONDS": ("directivesCacheTtlSeconds", int),
    # Switchroom hindsight-leverage A3 — parallel multi-bank recall toggle +
    # shared deadline. HINDSIGHT_RECALL_PARALLEL=false is the serial rollback
    # lever; the deadline is the ceiling-minus-2s hard budget (see DEFAULTS).
    "HINDSIGHT_RECALL_PARALLEL": ("recallParallel", bool),
    "HINDSIGHT_RECALL_PARALLEL_DEADLINE_SECONDS": ("recallParallelDeadlineSeconds", int),
    # Switchroom hindsight-leverage E1 / PR8 (#3369) — transcript-grep fallback
    # toggle + bounds. HINDSIGHT_RECALL_TRANSCRIPT_FALLBACK=false is the rollback
    # lever; the others tune the byte / turn / char / time bounds.
    "HINDSIGHT_RECALL_TRANSCRIPT_FALLBACK": ("recallTranscriptFallback", bool),
    "HINDSIGHT_RECALL_TRANSCRIPT_FALLBACK_MAX_BYTES": ("recallTranscriptFallbackMaxBytes", int),
    "HINDSIGHT_RECALL_TRANSCRIPT_FALLBACK_MAX_TURNS": ("recallTranscriptFallbackMaxTurns", int),
    "HINDSIGHT_RECALL_TRANSCRIPT_FALLBACK_MAX_CHARS": ("recallTranscriptFallbackMaxChars", int),
    "HINDSIGHT_RECALL_TRANSCRIPT_FALLBACK_DEADLINE_MS": ("recallTranscriptFallbackDeadlineMs", int),
    "HINDSIGHT_RECALL_MAX_QUERY_CHARS": ("recallMaxQueryChars", int),
    # Switchroom #3757 — BM25 query shaping + per-request timeout.
    "HINDSIGHT_RECALL_QUERY_MAX_TOKENS": ("recallQueryMaxTokens", int),
    "HINDSIGHT_RECALL_QUERY_STOP_TERMS": ("recallQueryStopTerms", list),
    "HINDSIGHT_RECALL_REQUEST_TIMEOUT_SECONDS": ("recallRequestTimeoutSeconds", int),
    "HINDSIGHT_RECALL_CONTEXT_TURNS": ("recallContextTurns", int),
    # Switchroom hindsight-leverage A2 — byte-tail bound for the multi-turn
    # transcript read (0 = read whole file / rollback lever).
    "HINDSIGHT_RECALL_TRANSCRIPT_TAIL_BYTES": ("recallTranscriptTailBytes", int),
    # Upstream 962140eef — recall tag filters. The tags env var accepts JSON
    # or a comma-separated list; the others must be JSON.
    "HINDSIGHT_RECALL_TAGS": ("recallTags", list),
    "HINDSIGHT_RECALL_TAGS_MATCH": ("recallTagsMatch", str),
    "HINDSIGHT_RECALL_TAG_GROUPS": ("recallTagGroups", dict),
    "HINDSIGHT_RECALL_TAG_WEIGHTS": ("recallTagWeights", dict),
    "HINDSIGHT_RECALL_ADDITIONAL_BANK_FILTERS": ("recallAdditionalBankFilters", dict),
    "HINDSIGHT_API_PORT": ("apiPort", int),
    "HINDSIGHT_DAEMON_IDLE_TIMEOUT": ("daemonIdleTimeout", int),
    # Upstream 55ef70679 — global request timeout override.
    "HINDSIGHT_REQUEST_TIMEOUT_SECONDS": ("requestTimeoutSeconds", int),
    "HINDSIGHT_EMBED_VERSION": ("embedVersion", str),
    "HINDSIGHT_EMBED_PACKAGE_PATH": ("embedPackagePath", str),
    "HINDSIGHT_DYNAMIC_BANK_ID": ("dynamicBankId", bool),
    "HINDSIGHT_BANK_MISSION": ("bankMission", str),
    "HINDSIGHT_LLM_PROVIDER": ("llmProvider", str),
    "HINDSIGHT_LLM_MODEL": ("llmModel", str),
    "HINDSIGHT_DEBUG": ("debug", bool),
}


#: Switchroom-local: the `observation_scopes` values Hindsight accepts as a
#: bare string (`MemoryItem.observation_scopes`, typed
#: `Literal["per_tag","combined","all_combinations","shared"] | list[list[str]]
#: | None` server-side). The explicit list-of-lists tag matrix is deliberately
#: NOT exposed through switchroom config: unbounded, no safe fleet-wide
#: default, no caller needs it. Paired with `OBSERVATION_SCOPES` in
#: src/memory/observation-scopes.ts, which the zod enum reads — widening the
#: set means widening BOTH.
OBSERVATION_SCOPES_VALUES = ("per_tag", "combined", "all_combinations", "shared")


#: Switchroom-local: the fact types Hindsight's recall endpoint accepts. Sending
#: any other value makes the 0.9.0 engine return HTTP 422 ("Invalid fact type(s):
#: … Must be one of: experience, observation, world") — a validation that was
#: silently tolerated before vectorize-io/hindsight#3062. A 422 fails the WHOLE
#: recall for the turn, so an operator typo in `memory.recall.types` (e.g.
#: "observations", "fact") would otherwise kill memory injection on EVERY turn.
#: Verified against the live engine's 422 detail string and /openapi.json
#: RecallRequest; widening this set means widening it server-side too.
RECALL_FACT_TYPES = ("world", "experience", "observation")

#: The recall types used when a configured `recallTypes` filters down to empty
#: (mirrors the `recallTypes` DEFAULTS entry). Falling back to this — rather than
#: sending an empty/invalid set — keeps recall running with the shipped behaviour
#: instead of degrading to nothing.
DEFAULT_RECALL_FACT_TYPES = ("world", "experience")


def filter_recall_types(config: dict):
    """Filter ``recallTypes`` to the set Hindsight's recall endpoint accepts.

    Returns the value to send as the recall ``types`` argument. THIS FUNCTION
    MUST NEVER RAISE: an invalid ``memory.recall.types`` value is a
    misconfiguration, and both raising here and passing the bad value through
    have the same catastrophic outcome — a 422 that fails the recall and drops
    memory injection for the turn. This mirrors the degrade-don't-raise contract
    of :func:`compute_observation_scopes` (a bad config degrades the FEATURE,
    never loses the turn).

    * ``None`` / unset → ``None``: omit the field entirely, letting the engine
      apply its own default (world + experience). Byte-identical to the wire
      body a pre-filter client sent.
    * a list/tuple     → keep the members in :data:`RECALL_FACT_TYPES` (order
      and de-duplicated), dropping every unknown value WITH a stderr warning
      that names it. If nothing valid survives, fall back to
      :data:`DEFAULT_RECALL_FACT_TYPES` so recall still runs.
    * anything else     → shout and fall back to :data:`DEFAULT_RECALL_FACT_TYPES`.
    """
    raw = config.get("recallTypes")
    if raw is None:
        return None
    if not isinstance(raw, (list, tuple)):
        print(
            f"[Hindsight] recallTypes={raw!r} is not a list; falling back to "
            f"{list(DEFAULT_RECALL_FACT_TYPES)}. Set it via `memory.recall.types` "
            "in switchroom.yaml.",
            file=sys.stderr,
        )
        return list(DEFAULT_RECALL_FACT_TYPES)
    valid = []
    for fact_type in raw:
        if isinstance(fact_type, str) and fact_type in RECALL_FACT_TYPES:
            if fact_type not in valid:
                valid.append(fact_type)
        else:
            print(
                f"[Hindsight] recallTypes entry {fact_type!r} is not a valid "
                f"Hindsight fact type ({', '.join(RECALL_FACT_TYPES)}); dropping "
                "it. An invalid type 422s the recall and drops memory injection "
                "for the turn — fix it via `memory.recall.types` in switchroom.yaml.",
                file=sys.stderr,
            )
    if not valid:
        print(
            f"[Hindsight] recallTypes={raw!r} left no valid fact types after "
            f"filtering; falling back to {list(DEFAULT_RECALL_FACT_TYPES)}.",
            file=sys.stderr,
        )
        return list(DEFAULT_RECALL_FACT_TYPES)
    return valid


def classify_observation_scopes(config: dict):
    """Classify ``observationScopes`` WITHOUT raising: ``(value, error)``.

    Exactly one of the two is non-``None``:

    * ``(None, None)``   — unset. Do not put the field on the wire at all;
      the shipped default, byte-for-byte the pre-plumbing request body.
    * ``(value, None)``  — a valid member of :data:`OBSERVATION_SCOPES_VALUES`.
    * ``(None, reason)`` — an off-list or non-string value, with a
      human-readable reason naming the accepted set.

    THIS FUNCTION MUST NEVER RAISE, and callers on the retain path must never
    turn its ``error`` into one. A bad scope is a misconfiguration; losing the
    turn is data loss. Those are not the same severity and must not share a
    failure mode — see ``retain.build_retain_payload`` for the consequence
    chain (a raise there propagated out of ``run_retain`` and past
    ``retain.main``'s ``pending_enqueue``, so the turn was never queued,
    the watermark never advanced, and the boot reconciler swallowed the same
    raise into ``debug_log`` — the memory was gone, permanently and silently).
    That is switchroom #3244's shape, which this very feature cites.

    An empty/whitespace-only value is treated as UNSET, matching the plugin's
    existing "an empty export hands authority back to the config file" idiom
    (see ``_cast_env``): an absent knob, not a typo'd one.
    """
    raw = config.get("observationScopes")
    if raw is None:
        return None, None
    if not isinstance(raw, str):
        return None, (
            "observationScopes must be a string, one of "
            f"{', '.join(OBSERVATION_SCOPES_VALUES)}; got {type(raw).__name__} ({raw!r}). "
            "Set it via `memory.observation_scopes` in switchroom.yaml."
        )
    value = raw.strip()
    if not value:
        return None, None
    if value not in OBSERVATION_SCOPES_VALUES:
        return None, (
            f"observationScopes={raw!r} is not a valid Hindsight observation scope. "
            f"Accepted values: {', '.join(OBSERVATION_SCOPES_VALUES)}. "
            "Set it via `memory.observation_scopes` in switchroom.yaml "
            "(a typo there is rejected at `switchroom apply`)."
        )
    return value, None


def resolve_observation_scopes(config: dict):
    """Strict form of :func:`classify_observation_scopes` — raises on a bad value.

    ``None`` means "do not put the field on the wire at all".

    Raises ``ValueError`` on any value outside
    :data:`OBSERVATION_SCOPES_VALUES`. This is the VALIDATOR, for callers that
    genuinely want to fail — a config check, a test, a hand-run script that
    should stop before it writes anything. **It is deliberately NOT what the
    retain path calls**: a retain must never be destroyed by a config typo, so
    ``retain.build_retain_payload`` uses the non-raising classifier and shouts
    instead. See ``classify_observation_scopes``.
    """
    value, error = classify_observation_scopes(config)
    if error:
        raise ValueError(error)
    return value


def _volatile_scope_matchers(config: dict):
    """Compile ``observationScopeVolatilePatterns`` to regexes, skipping bad ones.

    NEVER raises: a malformed pattern is dropped (and shouted about) rather than
    allowed to kill a retain. Falls back to the built-in defaults when the
    config value is absent or not a list.
    """
    raw = config.get("observationScopeVolatilePatterns")
    if not isinstance(raw, (list, tuple)):
        raw = DEFAULT_VOLATILE_SCOPE_PATTERNS
    matchers = []
    for pat in raw:
        if not isinstance(pat, str):
            continue
        try:
            matchers.append(re.compile(pat))
        except re.error as e:
            print(
                f"[Hindsight] observationScopeVolatilePatterns entry {pat!r} is not "
                f"a valid regex ({e}); ignoring it for scope curation.",
                file=sys.stderr,
            )
    return matchers


def _is_volatile_scope_tag(tag: str, matchers) -> bool:
    return any(m.search(tag) for m in matchers)


def compute_observation_scopes(tags, config: dict):
    """Resolve the per-row ``observation_scopes`` value for one retain.

    Returns ``(value, error)`` — exactly like :func:`classify_observation_scopes`
    — and MUST NEVER RAISE (a bad config must degrade the SCOPE, never lose the
    turn; see ``retain.build_retain_payload``). ``value`` is what goes on the
    wire: ``None`` (omit the field entirely → engine default), a bare string
    (``"shared"`` / an operator-pinned Hindsight scope), or an explicit
    ``list[list[str]]`` tag matrix. The wire body is byte-identical to the
    pre-feature client whenever ``value`` is ``None``.

    Precedence:

    1. A manually-pinned ``observationScopes`` (``memory.observation_scopes``)
       WINS — its classified value (or its degrade-to-None-with-error on a typo)
       is returned unchanged, so existing operator overrides keep working.
    2. Otherwise ``observationScopeStrategy`` decides:

       * ``combined`` / ``off`` → ``None`` (pre-feature engine default; opt-out).
       * ``shared``             → ``"shared"`` uniformly.
       * ``curated`` (default)  → strip volatile provenance tags from the scope
         (keeping them on the source fact); non-empty stable set → ``[[stable…]]``
         (deterministically sorted), empty stable set → ``"shared"``.
       * anything else          → treated as ``curated`` and shouted about.

    Docs: https://hindsight.vectorize.io/developer/api/retain (``shared`` == the
    explicit ``[[]]`` scope; a custom ``list[list[str]]`` is consolidated with
    ``all_strict`` matching so scopes stay isolated) and /developer/observations.
    """
    # 1. Operator-pinned scope wins (back-compat). Only fall through to the
    #    strategy when observationScopes is genuinely UNSET — a typo'd pin
    #    degrades to the engine default WITH its error, never silently curated.
    manual, manual_error = classify_observation_scopes(config)
    if manual is not None or manual_error is not None:
        return manual, manual_error

    strategy_raw = config.get("observationScopeStrategy")
    strategy = strategy_raw.strip().lower() if isinstance(strategy_raw, str) else ""
    if not strategy:
        strategy = "curated"

    error = None
    if strategy not in OBSERVATION_SCOPE_STRATEGIES:
        error = (
            f"observationScopeStrategy={strategy_raw!r} is not one of "
            f"{', '.join(OBSERVATION_SCOPE_STRATEGIES)}; using 'curated'."
        )
        strategy = "curated"

    if strategy in ("combined", "off"):
        return None, error
    if strategy == "shared":
        return "shared", error

    # curated
    matchers = _volatile_scope_matchers(config)
    stable = sorted(
        {t for t in (tags or []) if isinstance(t, str) and t and not _is_volatile_scope_tag(t, matchers)}
    )
    if stable:
        return [stable], error
    return "shared", error


def _cast_env(value: str, typ):
    """Cast environment variable string to target type. Returns None on failure."""
    try:
        if typ is bool:
            return value.lower() in ("true", "1", "yes")
        if typ is int:
            return int(value)
        if typ is float:
            return float(value)
        if typ is list:
            # JSON list first (upstream 962140eef). A value that parses as
            # JSON but is NOT a list (e.g. `42`, `"x"`, `{}`) is a config
            # mistake, not a comma-separated string — return None so the
            # default is kept (matches upstream; fail-open). Only values
            # that don't parse as JSON at all take the comma-split path.
            try:
                parsed = json.loads(value)
            except ValueError:
                if value.lstrip().startswith(("[", "{")):
                    # Looks like intended JSON but doesn't parse —
                    # malformed config, not a comma list. Keep default.
                    return None
                # Comma-separated → list of trimmed, non-empty strings.
                return [t.strip() for t in value.split(",") if t.strip()]
            return parsed if isinstance(parsed, list) else None
        if typ is dict:
            # JSON only (dict or list accepted — tag_groups may be a list).
            parsed = json.loads(value)
            if isinstance(parsed, (dict, list)):
                return parsed
            return None
        return value
    except (ValueError, AttributeError):
        return None


def _load_settings_file(path: str, config: dict) -> None:
    """Merge a settings.json file into config in-place. Silently skips if missing."""
    if not os.path.exists(path):
        return
    try:
        with open(path) as f:
            file_config = json.load(f)
        config.update({k: v for k, v in file_config.items() if v is not None})
    except (json.JSONDecodeError, OSError) as e:
        debug_log(config, f"Failed to load {path}: {e}")


def load_config() -> dict:
    """Load plugin configuration from settings.json + env overrides.

    Loading order (later entries win):
      1. Built-in defaults
      2. Plugin default settings.json  (CLAUDE_PLUGIN_ROOT/settings.json)
      3. User config                   (~/.hindsight/claude-code.json)
      4. Environment variable overrides

    ~/.hindsight/claude-code.json is the recommended place to configure the
    plugin — same convention as ~/.openclaw/openclaw.json. It is stable across
    plugin updates and marketplace changes.
    """
    config = dict(DEFAULTS)

    # 1. Plugin default settings.json (ships with the plugin, version-specific path)
    plugin_root = os.environ.get("CLAUDE_PLUGIN_ROOT", "")
    if not plugin_root:
        plugin_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    _load_settings_file(os.path.join(plugin_root, "settings.json"), config)

    # 2. User config — stable, version-independent, matches openclaw convention
    user_config_path = os.path.join(os.path.expanduser("~"), ".hindsight", "claude-code.json")
    _load_settings_file(user_config_path, config)

    # Apply environment variable overrides
    for env_name, (key, typ) in ENV_OVERRIDES.items():
        val = os.environ.get(env_name)
        if val is not None:
            cast_val = _cast_env(val, typ)
            if cast_val is not None:
                config[key] = cast_val

    return config


def debug_log(config: dict, *args):
    """Log to stderr if debug mode is enabled."""
    if config.get("debug"):
        print("[Hindsight]", *args, file=sys.stderr)
