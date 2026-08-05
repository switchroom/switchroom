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

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

// ---------------------------------------------------------------------------
// self-improve correction tag (PR4 — slice 4a)
// ---------------------------------------------------------------------------

/**
 * The tag stamped on a turn's auto-retain when the deterministic self-improve
 * gate (`src/self-improve/gate.ts`) fired on an `operator-correction` signal.
 * PR5's failure-synthesis cron recalls correction turns cheaply by filtering on
 * it (metadata is not filterable, tags are — same rationale as
 * {@link RETAIN_PROVENANCE_TAG}).
 *
 * `<kind>:<name>` per the docs' tag-naming conventions.
 *
 * ## STABLE, by contract — and deliberately NOT excluded from the scope
 *
 * Unlike {@link RETAIN_PROVENANCE_TAG} (stamped on EVERY retain, hence forced
 * volatile so it never re-partitions the whole bank), this tag rides only the
 * rare correction turns. It MUST NOT match `^source:` — or any entry of the
 * vendored `DEFAULT_VOLATILE_SCOPE_PATTERNS` — so it stays STABLE and the
 * correction turns it marks consolidate together in their own
 * `[["self-improve:correction"]]` scope, which is exactly the partition PR5
 * synthesises over. Because the tag is absent on every non-correction turn, the
 * bank-wide `"shared"` scope those turns compute is byte-identical to before
 * this shipped — the all-volatile → `"shared"` invariant is untouched.
 *
 * Pinned to the vendored retain hook's copy (`SELF_IMPROVE_CORRECTION_TAG` in
 * `vendor/hindsight-memory/scripts/retain.py`) by
 * `tests/scaffold.retain-provenance.test.ts`.
 */
export const SELF_IMPROVE_CORRECTION_TAG = "self-improve:correction";

/**
 * Per-turn sentinel filename the self-improve Stop hook drops into the agent
 * state dir when the gate fires on an `operator-correction`. The auto-retain
 * hook (a SEPARATE process — `retain.py`) reads-and-clears it and, when present,
 * adds {@link SELF_IMPROVE_CORRECTION_TAG} to that retain's tag set. The Stop
 * hook and the retain hook cannot share env, so this file in the shared state
 * dir is the seam between them.
 *
 * Pinned to `SELF_IMPROVE_CORRECTION_PENDING_FILE` in
 * `vendor/hindsight-memory/scripts/retain.py` by
 * `tests/scaffold.retain-provenance.test.ts`.
 */
export const SELF_IMPROVE_CORRECTION_PENDING_FILE = "self-improve-correction-pending";

function correctionPendingPath(stateDir: string): string {
  return join(stateDir, SELF_IMPROVE_CORRECTION_PENDING_FILE);
}

/**
 * Drop the per-turn correction sentinel. Called by the self-improve Stop hook
 * at gate-trip time (operator-correction signal only). Best-effort — a marker
 * write must never fail the turn (the Stop hook is fail-open); worst case the
 * next retain simply carries no correction tag.
 */
export function writeCorrectionPending(stateDir: string): void {
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true, mode: 0o755 });
  }
  // Content is immaterial — presence is the whole signal. A stamp aids forensics.
  writeFileSync(correctionPendingPath(stateDir), new Date().toISOString(), "utf-8");
}

/**
 * Read-once: true iff the sentinel is present, clearing it as a side effect so
 * exactly one retain carries the tag. The production reader is the Python
 * `retain.py`; this mirrors the contract in TS for symmetry and unit tests.
 * Best-effort; never throws.
 */
export function readAndClearCorrectionPending(stateDir: string): boolean {
  const p = correctionPendingPath(stateDir);
  if (!existsSync(p)) return false;
  try {
    rmSync(p, { force: true });
  } catch {
    /* nothing to do */
  }
  return true;
}
