/**
 * Provenance tagging for auto-retained transcript content.
 *
 * ## The defect this closes
 *
 * The hindsight plugin's Stop hook posts the recent transcript window to
 * Hindsight, which runs LLM fact extraction over it. That window contains the
 * agent's OWN output as well as the user's — so when the agent synthesises
 * something (a `reflect` answer, a recap, an inferred date), the extractor can
 * lift that synthesis out as a `fact_type: world` unit with a clean
 * `event_date`, and the next session's `recall` serves it back as ground truth.
 * Model output re-entering the bank as evidence.
 *
 * Before this module, the ONLY thing distinguishing such a unit from an
 * operator-curated profile-bank fact was:
 *
 * ```json
 * "tags": ["4c386b32-ddfd-40d1-b557-da8135b294af"],
 * "metadata": { "session_id": "4c386b32…", "message_count": "36" }
 * ```
 *
 * — a bare session UUID and some metadata. Hindsight's own best-practices page
 * is explicit that **metadata is not filterable and tags are**
 * (<https://hindsight.vectorize.io/best-practices>, "Metadata Schema — Use for
 * source tracking and downstream linking. Not filterable — use tags for
 * filtering", and the anti-patterns table: "Using metadata for filtering →
 * Metadata is not filterable → Use tags for anything you'll filter on"). A raw
 * session UUID is filterable but carries no semantics: nothing downstream can
 * ask "was this asserted by a human, or extracted out of a transcript?".
 *
 * {@link RETAIN_PROVENANCE_TAG} is that semantic marker, stamped at retain
 * time on every auto-retained transcript slice, following the docs' own
 * `<kind>:<name>` tag-naming convention.
 *
 * ## What it deliberately does NOT claim
 *
 * It does not separate agent-synthesised text from user-authored text. One
 * Stop-hook retain carries ONE blended transcript slice (`retainRoles` is
 * `["user", "assistant"]`) with a single content-derived `document_id`;
 * splitting it per role would double the retain count, break the deterministic
 * id that the pending-retains drainer and the compaction tracker key on, and
 * strip the conversational structure the docs say the extractor depends on
 * ("Pass the richest representation available. Never pre-summarize."). So the
 * tag says *how this content got here*, not *who said which sentence*. The
 * lever against extracting assertions out of assistant synthesis is the
 * extraction mission (`DEFAULT_RETAIN_MISSION` in `./hindsight.ts`), which is
 * where that half of the fix lives.
 *
 * ## Scope neutrality is part of the contract
 *
 * `observationScopeStrategy: "curated"` (the switchroom default) computes a
 * retain's consolidation scope from its STABLE tags: an all-volatile tag set
 * yields the bank-wide `"shared"` scope, a non-empty stable set yields an
 * explicit `[[tag…]]` scope. A naively-added stable tag would therefore move
 * every future retain from `"shared"` into a brand-new
 * `[["source:transcript"]]` partition, isolating it from every observation the
 * bank has already consolidated — a silent migration discontinuity, and one
 * that also lands the whole bank in a single scope against
 * `HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE`. So the paired vendor change adds
 * `^source:` to `DEFAULT_VOLATILE_SCOPE_PATTERNS` in
 * `vendor/hindsight-memory/scripts/lib/config.py`: the tag rides the source
 * fact (filterable, exactly as intended) and is dropped from the consolidation
 * scope, leaving scope computation byte-identical to before.
 * {@link RETAIN_PROVENANCE_TAG_SCOPE_PATTERN} pins the two halves together.
 */

/**
 * The provenance tag stamped on every auto-retained transcript slice.
 *
 * `<kind>:<name>` per the docs' tag-naming conventions table. Stable across
 * sessions, agents and banks — that stability is the point: a filter written
 * once keeps working, which a session UUID can never do.
 */
export const RETAIN_PROVENANCE_TAG = "source:transcript";

/**
 * The regex the vendored `config.py` must carry in
 * `DEFAULT_VOLATILE_SCOPE_PATTERNS` so {@link RETAIN_PROVENANCE_TAG} is
 * excluded from the consolidation scope. Pinned by test against the vendor
 * file — the two cannot drift.
 */
export const RETAIN_PROVENANCE_TAG_SCOPE_PATTERN = "^source:";

/**
 * The `retainTags` switchroom stamps into every agent's installed
 * `settings.json`.
 *
 * `{session_id}` is the vendor default and is KEPT: `retain.py` resolves it to
 * the raw session UUID, `switchroom memory` surfaces it, and the curated
 * observation-scope strategy relies on recognising it as volatile. The
 * provenance tag is appended, not substituted.
 *
 * Order is fixed so the stamped value is byte-stable across applies (a
 * reordering would rewrite settings.json on every reconcile).
 */
export const RETAIN_TAGS_DEFAULT: readonly string[] = Object.freeze([
  "{session_id}",
  RETAIN_PROVENANCE_TAG,
]);
