/**
 * Directive-triage apply-batch executor — Memory v2 M2 (carve-M2.md T3, §4b;
 * redteam-M2.md §3, §6, §7).
 *
 * Two operations, both operating on a SINGLE agent's own bank via the
 * shipped, pre-approved `DirectiveAdmin` (Shape α — carve-M2.md §3, Ken's
 * approved decision 2). No caller-supplied `bank_id`, no cross-bank reach:
 * `DirectiveAdmin` here is always the one instance constructed with the
 * calling agent's own `HINDSIGHT_BANK_ID`, same as the shim.
 *
 *   1. {@link applyDirectiveTriageBatch} — walks a card's rows and retires
 *      the ones marked `action: "retire"`, SEQUENTIALLY (never concurrently
 *      — redteam-M2.md §7: the tag PATCH is read-modify-write with no
 *      compare-and-swap, so two overlapping writes in the same batch can
 *      lose a `supersedes:` tag). Refuses, in code, to deactivate any row
 *      categorised `rules-block` (Ken's approved decision 3) — this is not
 *      a filter the card generator alone is trusted to have applied; the
 *      executor re-checks independently.
 *
 *   2. {@link reconcileDirectiveSuperset} — the windows-boxes-class fix
 *      (carve-M2.md §0a-A, path (A), Ken's approved decision 1):
 *      create-the-superset-copy-FIRST, then deactivate-the-old-copy-SECOND.
 *      Create-first is deliberate (redteam-M2.md §6): if the create fails,
 *      the ORIGINAL directive is untouched — never a window with zero
 *      active copies of the guardrail. Does NOT touch
 *      `hindsight-directive-admin.ts` and does NOT widen
 *      `buildDirectivePatchBody`'s field whitelist — M1's content-PATCH
 *      refusal stays exactly as shipped. The old copy is retired by ID
 *      (captured before the create), not by `DirectiveAdmin.deactivate()`'s
 *      name-based resolve(): once the new copy exists, TWO directives share
 *      the reconciled name, and `resolve()` deliberately throws "ambiguous"
 *      on >1 name hit (a real correctness gap in the carve's "zero new
 *      mutation code" framing — see the PR description). The by-id PATCH
 *      below reuses the exact same `buildDirectivePatchBody` whitelist
 *      (is_active + tags only) imported from the admin module, so the
 *      content-immutability guarantee cannot drift between the two call
 *      sites.
 */

import {
  DirectiveAdmin,
  buildDirectivePatchBody,
  supersededByTag,
  DIRECTIVE_ADMIN_TIMEOUT_MS,
  type HindsightDirective,
} from "./hindsight-directive-admin.js";
import type { DirectiveTriageRow } from "./directive-triage.js";

/**
 * Thrown to make the rules-block refusal loud in a caller that expects
 * `throwOnRefusal: true`. The default (non-throwing) mode instead records
 * the refusal in the result so a batch with a mix of legitimate retirements
 * and a mis-tagged rules-block row can still make progress on the rest.
 */
export class RulesBlockDeactivationRefusedError extends Error {
  constructor(readonly directiveName: string) {
    super(
      `Refusing to deactivate '${directiveName}': it is categorised ` +
        "rules-block. M2 leaves rules-block-category directives ACTIVE " +
        "(staged + measured only) until M3 flips this agent's rules-block " +
        "replacement live — deactivating one now would open a guardrail " +
        "gap with nothing enforcing the behaviour in between. This is " +
        "enforced in code (applyDirectiveTriageBatch), not left to " +
        "reviewer discipline. Do not route around it.",
    );
    this.name = "RulesBlockDeactivationRefusedError";
  }
}

export interface ApplyDirectiveTriageBatchOptions {
  /** Throw {@link RulesBlockDeactivationRefusedError} instead of skipping. */
  throwOnRulesBlockRow?: boolean;
}

export interface ApplyDirectiveTriageBatchResult {
  /** Directive names actually deactivated this run. */
  deactivated: string[];
  /** Rows marked retire but categorised rules-block — refused, left active. */
  refusedRulesBlock: string[];
  /** Rows left untouched because their action was keep / stage-for-m3. */
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
    refusedRulesBlock: [],
    kept: [],
  };

  for (const row of rows) {
    if (row.action !== "retire") {
      result.kept.push(row.name);
      continue;
    }
    if (row.category === "rules-block") {
      if (opts.throwOnRulesBlockRow) {
        throw new RulesBlockDeactivationRefusedError(row.name);
      }
      result.refusedRulesBlock.push(row.name);
      continue;
    }
    await admin.deactivate({
      name: row.name,
      ...(row.supersededBy ? { supersededBy: row.supersededBy } : {}),
    });
    result.deactivated.push(row.name);
  }

  return result;
}

// ─── windows-boxes-class reconciliation (create-first, deactivate-second) ──

export interface ReconcileDirectiveSupersetArgs {
  /** Same REST base `DirectiveAdmin` was constructed with. */
  apiBaseUrl: string;
  /** The calling agent's OWN bank — never caller-supplied cross-bank. */
  bankId: string;
  /** Shared name both the old and the new (superset) copy carry. */
  name: string;
  newContent: string;
  priority?: number;
  /** Tags for the NEW copy. The OLD copy always gets `superseded-by:<name>`
   *  appended to its existing tags, regardless of this option. */
  newTags?: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ReconcileDirectiveSupersetResult {
  createdId: string;
  deactivatedOldId: string;
}

function directivesPath(apiBaseUrl: string, bankId: string): string {
  const base = apiBaseUrl.replace(/\/+$/, "");
  return `${base}/v1/default/banks/${encodeURIComponent(bankId)}/directives`;
}

async function sendJson(
  url: string,
  init: { method: string; body?: unknown; bankId: string },
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<HindsightDirective> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: init.method,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "X-Bank-Id": init.bankId,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      throw new Error(`${init.method} ${url} failed: HTTP ${res.status}`);
    }
    return (await res.json()) as HindsightDirective;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The windows-boxes-class fix (Ken's approved decision 1, path A).
 *
 * Order is the safety mechanism (redteam-M2.md §6):
 *   1. Resolve the OLD active directive's id via `admin.list()` — captured
 *      BEFORE any write, so the by-id PATCH in step 3 cannot be confused by
 *      the name collision step 2 is about to create.
 *   2. CREATE the new superset copy (additive). If this throws, the old
 *      directive is completely untouched — no guardrail gap.
 *   3. PATCH the OLD copy by id — `is_active: false` plus a
 *      `superseded-by:<name>` tag — using the SAME whitelisted body builder
 *      (`buildDirectivePatchBody`) the admin module uses, so this cannot
 *      drift from the is_active/tags-only guarantee.
 *
 * A failure in step 3 leaves BOTH copies active — a benign transient
 * duplicate, reconciled on retry (never a state with zero active copies).
 */
export async function reconcileDirectiveSuperset(
  admin: DirectiveAdmin,
  args: ReconcileDirectiveSupersetArgs,
): Promise<ReconcileDirectiveSupersetResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const timeoutMs = args.timeoutMs ?? DIRECTIVE_ADMIN_TIMEOUT_MS;

  const before = await admin.list();
  const old = before.find((d) => d.name === args.name && d.is_active !== false);
  if (!old) {
    throw new Error(
      `no ACTIVE directive named '${args.name}' in bank '${args.bankId}' to reconcile`,
    );
  }

  const path = directivesPath(args.apiBaseUrl, args.bankId);

  const created = await sendJson(
    path,
    {
      method: "POST",
      bankId: args.bankId,
      body: {
        name: args.name,
        content: args.newContent,
        is_active: true,
        ...(args.priority !== undefined ? { priority: args.priority } : {}),
        ...(args.newTags !== undefined ? { tags: args.newTags } : {}),
      },
    },
    fetchImpl,
    timeoutMs,
  );

  const patchBody = buildDirectivePatchBody({
    isActive: false,
    tags: [...(old.tags ?? []), supersededByTag(args.name)],
  });
  await sendJson(
    `${path}/${encodeURIComponent(old.id)}`,
    { method: "PATCH", bankId: args.bankId, body: patchBody },
    fetchImpl,
    timeoutMs,
  );

  return { createdId: created.id, deactivatedOldId: old.id };
}
