/**
 * Directive-triage apply-batch executor — Memory v2 M2 (carve-M2.md T3, §4b;
 * redteam-M2.md §3, §6, §7; PR #4760 review B1/B2/M1/M2/M3).
 *
 * Two operations, both operating on a SINGLE agent's own bank via the
 * shipped, pre-approved `DirectiveAdmin` (Shape α — carve-M2.md §3, Ken's
 * approved decision 2). Every REST call this module makes goes THROUGH the
 * `admin` instance the caller passes in — there is no `apiBaseUrl`/`bankId`
 * anywhere in this file's own surface, so cross-bank reach is impossible by
 * construction, not by caller discipline (review M3).
 *
 *   1. {@link applyDirectiveTriageBatch} — walks a card's rows SEQUENTIALLY
 *      (never concurrently — redteam-M2.md §7: the tag PATCH is
 *      read-modify-write with no compare-and-swap). Rows resolve by `id`,
 *      never `name` (review M1): once a windows-boxes-class reconcile is in
 *      flight, two directives briefly share a name, and a by-name
 *      `deactivate` would hit `resolve()`'s "ambiguous" error and abort
 *      mid-batch, discarding partial progress.
 *
 *      Decision 3 (rules-block stays ACTIVE until M3) is enforced at the
 *      REAL chokepoint now: `DirectiveAdmin.deactivate*` itself refuses any
 *      directive carrying `RULES_BLOCK_MARKER_TAG`
 *      ({@link RulesBlockDeactivationRefusedError}) — an invariant read off
 *      the directive's own persisted state, not off this executor's (or the
 *      card generator's) classification of it (review B2). This function's
 *      own `row.category === "rules-block"` check is defense in depth, and
 *      it does something the admin-level check alone cannot: it STAMPS the
 *      marker (`admin.markRulesBlock`) at staging time, so the invariant
 *      persists on the bank itself — reachable by the interactive
 *      `mental-model-curator` skill path too, which calls
 *      `deactivate_directive` directly and never goes through this function
 *      at all.
 *
 *   2. {@link reconcileDirectiveSuperset} — the windows-boxes-class fix
 *      (carve-M2.md §0a-A, path (A), Ken's approved decision 1):
 *      create-the-superset-copy-FIRST, then deactivate-the-stale-copies-
 *      SECOND. Create-first is deliberate (redteam-M2.md §6): if the create
 *      fails, the ORIGINAL directive is untouched — never a window with
 *      zero active copies of the guardrail. Idempotent/recoverable (review
 *      M2): a retry after a deactivate-step failure detects the already-
 *      created superset copy by content match and reuses it instead of
 *      creating a THIRD, then deactivates every remaining stale active by
 *      id — never leaving two actives behind. Does NOT touch
 *      `hindsight-directive-admin.ts`'s `buildDirectivePatchBody` field
 *      whitelist — M1's content-PATCH refusal stays exactly as shipped. The
 *      stale copies are retired via `deactivateByIdWithTag`, which never
 *      resolves a "winner" by name (the new copy shares the OLD copy's
 *      name, so a by-name resolution here would itself hit the ambiguous
 *      error this whole by-id surface exists to avoid).
 *
 * A real, runnable entry point for #2 lives at
 * `switchroom memory directive reconcile <agent> <name> <content...>`
 * (`src/cli/memory-directive.ts`, review M4) — this module is the library
 * code behind it, not a standalone harness an operator has to hand-write.
 */

import {
  DirectiveAdmin,
  RulesBlockDeactivationRefusedError,
  supersededByTag,
  supersedesTag,
  type HindsightDirective,
} from "./hindsight-directive-admin.js";
import type { DirectiveTriageRow } from "./directive-triage.js";

export { RulesBlockDeactivationRefusedError };

export interface ApplyDirectiveTriageBatchOptions {
  /** Throw {@link RulesBlockDeactivationRefusedError} instead of skipping. */
  throwOnRulesBlockRow?: boolean;
}

export interface ApplyDirectiveTriageBatchResult {
  /** Directive names actually deactivated this run. */
  deactivated: string[];
  /**
   * Rows categorised rules-block — never deactivated. `markRulesBlock` was
   * called on each, stamping the durable marker tag so the admin-level
   * chokepoint refuses any FUTURE deactivation attempt too, independent of
   * this executor.
   */
  stagedRulesBlock: string[];
  /**
   * Rows the admin-level chokepoint refused despite this executor believing
   * it was safe to deactivate them (`row.category !== "rules-block"`) — the
   * scenario the chokepoint exists for: a classifier bug, a stale tag, or a
   * hand-built row cannot get past `DirectiveAdmin` even if it gets past
   * this function's own pre-check.
   */
  refusedRulesBlock: string[];
  /** Rows left untouched because their action was keep. */
  kept: string[];
}

/**
 * Apply one triage card's decisions to the calling agent's OWN bank.
 *
 * Rows run in array order, one at a time, awaited before the next starts —
 * never `Promise.all`. See the module header for why.
 */
export async function applyDirectiveTriageBatch(
  admin: DirectiveAdmin,
  rows: readonly DirectiveTriageRow[],
  opts: ApplyDirectiveTriageBatchOptions = {},
): Promise<ApplyDirectiveTriageBatchResult> {
  const result: ApplyDirectiveTriageBatchResult = {
    deactivated: [],
    stagedRulesBlock: [],
    refusedRulesBlock: [],
    kept: [],
  };

  for (const row of rows) {
    // M1: an already-inactive row (a stale superseded copy, or one already
    // retired by a prior pass) is never re-retired.
    if (!row.isActive) {
      result.kept.push(row.name);
      continue;
    }

    // Decision 3, defense in depth: never even attempt a deactivation for a
    // rules-block row, regardless of what `row.action` says. Stamp the
    // durable marker instead, so the REAL chokepoint (DirectiveAdmin) can
    // enforce this on every future call, on every path, including the
    // interactive skill's direct `deactivate_directive` calls.
    if (row.category === "rules-block") {
      await admin.markRulesBlock({ id: row.id });
      result.stagedRulesBlock.push(row.name);
      continue;
    }

    if (row.action !== "retire") {
      result.kept.push(row.name);
      continue;
    }

    try {
      await admin.deactivateById({
        id: row.id,
        ...(row.supersededBy ? { supersededBy: row.supersededBy } : {}),
      });
      result.deactivated.push(row.name);
    } catch (err) {
      if (err instanceof RulesBlockDeactivationRefusedError) {
        if (opts.throwOnRulesBlockRow) throw err;
        result.refusedRulesBlock.push(row.name);
        continue;
      }
      throw err;
    }
  }

  return result;
}

// ─── windows-boxes-class reconciliation (create-first, deactivate-second) ──

export interface ReconcileDirectiveSupersetArgs {
  /** Shared name both the stale and the new (superset) copy carry. */
  name: string;
  newContent: string;
  priority?: number;
  /** Extra tags for the NEW copy. `supersedes:<name>` is always appended,
   *  regardless of this option (provenance symmetry with the stale copies'
   *  `superseded-by:<name>`). */
  newTags?: string[];
}

export interface ReconcileDirectiveSupersetResult {
  createdId: string;
  /** Ids of every stale active copy that was deactivated this call — plural
   *  because a recovered retry can find more than one (review M2). */
  deactivatedOldIds: string[];
  /** True when an existing superset copy (content byte-identical to
   *  `newContent`) was found and reused instead of creating a new one — the
   *  idempotent-retry path (review M2). */
  reused: boolean;
}

/**
 * The windows-boxes-class fix (Ken's approved decision 1, path A).
 *
 * Order is the safety mechanism (redteam-M2.md §6):
 *   1. List the bank; find every ACTIVE directive named `args.name`.
 *   2. Reuse an existing active copy whose `content` already matches
 *      `args.newContent` (idempotent — a prior call may have created it and
 *      then failed before deactivating the stale copies), or CREATE a new
 *      one. If create throws, every existing copy is untouched — no
 *      guardrail gap, and no partial state to clean up.
 *   3. Deactivate every OTHER active same-name copy by id, tagging each
 *      `superseded-by:<name>` — never via a by-name winner resolution
 *      (which would be ambiguous, since the winner shares the losers'
 *      name).
 *
 * A failure in step 3 leaves one or more stale copies active alongside the
 * new one — a benign transient duplicate. Calling this function again with
 * the SAME `newContent` recovers cleanly: step 2 finds and reuses the copy
 * already created, and step 3 retries deactivating whatever is still
 * active. It never creates a third copy and never leaves two actives behind
 * on a clean run.
 */
export async function reconcileDirectiveSuperset(
  admin: DirectiveAdmin,
  args: ReconcileDirectiveSupersetArgs,
): Promise<ReconcileDirectiveSupersetResult> {
  const before = await admin.list();
  const activeSameName = before.filter(
    (d) => d.name === args.name && d.is_active !== false,
  );
  if (activeSameName.length === 0) {
    throw new Error(
      `no ACTIVE directive named '${args.name}' in bank '${admin.bankId}' to reconcile`,
    );
  }

  let created: HindsightDirective | undefined = activeSameName.find(
    (d) => d.content === args.newContent,
  );
  const reused = created !== undefined;
  if (!created) {
    created = await admin.create({
      name: args.name,
      content: args.newContent,
      isActive: true,
      ...(args.priority !== undefined ? { priority: args.priority } : {}),
      tags: [...(args.newTags ?? []), supersedesTag(args.name)],
    });
  }

  const staleActives = activeSameName.filter((d) => d.id !== created!.id);
  const deactivatedOldIds: string[] = [];
  for (const old of staleActives) {
    await admin.deactivateByIdWithTag({
      id: old.id,
      tag: supersededByTag(args.name),
    });
    deactivatedOldIds.push(old.id);
  }

  return { createdId: created.id, deactivatedOldIds, reused };
}
