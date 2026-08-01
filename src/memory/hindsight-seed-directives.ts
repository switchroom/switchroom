/**
 * The switchroom-seeded **anti-confabulation directive**, and the idempotent
 * ensure/upgrade path that keeps it on every managed bank.
 *
 * ## Why a directive, and why this one
 *
 * `reflect` synthesises an answer from whatever retrieval hands it. Unlike
 * `/recall`, **it has no relevance floor**: `min_scores` is a `/recall`-only
 * parameter, and `/reflect` accepts only `query`, `budget`, `max_tokens`,
 * `response_schema`, `tags`, `tags_match`, `fact_types`,
 * `exclude_mental_models` and `exclude_mental_model_ids` (verified against the
 * live OpenAPI on the pinned image, 2026-08-02). So when a bank holds nothing
 * relevant, reflect still gets the best of a bad set and still writes a fluent,
 * confident paragraph — and a question that PRESUPPOSES a decision ("when did
 * we decide X?") reliably produces one.
 *
 * Directives ARE applied during reflect. That makes a seeded directive the only
 * lever switchroom has on this failure from the outside.
 *
 * ## Stated honestly: this is prompt discipline, not a guarantee
 *
 * A model told not to confabulate can still confabulate. This directive raises
 * the floor; it does not install one. The real fix is upstream — reflect needs
 * a relevance floor (the `/recall` `min_scores` equivalent) so "nothing scored
 * above the floor" is a *structural* answer rather than an instruction the
 * synthesiser may ignore. Nothing here should be read as having done that.
 *
 * ## Never clobber a human
 *
 * Seeding follows the same rule as the managed missions, using the SAME
 * decision function ({@link decideMissionUpgrade}) rather than a parallel one:
 *
 *   - operator text in yaml wins outright;
 *   - a bank whose directive is missing, empty, or byte-equal to a previously
 *     shipped default is upgraded to the current default;
 *   - anything else — any hand-edit, even whitespace — is left alone forever.
 *
 * That is what makes "edit the directive in the bank" a real override path and
 * not something the next `switchroom apply` undoes.
 */

import { decideMissionUpgrade } from "./hindsight.js";
import { MAX_DIRECTIVES } from "./hindsight-directive-admin.js";

/** Stable identity key for the seeded directive. Never change it. */
export const ANTI_CONFABULATION_DIRECTIVE_NAME = "no-confabulation";

/**
 * Marks the directive as switchroom-managed, so an operator listing directives
 * can tell a seeded guardrail from one they or the agent wrote.
 */
export const SWITCHROOM_SEEDED_TAG = "switchroom-seeded";

/**
 * Priority 10, deliberately, not 100.
 *
 * Priority orders injection, and the recall block truncates past
 * `MAX_DIRECTIVES` — so a guardrail at the engine default of 0 is among the
 * first to fall out of a crowded bank, which is exactly when it matters most.
 * 10 keeps it ahead of unprioritised directives while leaving every operator
 * directive with an explicit priority able to outrank it. A seeded default
 * should not be able to shout down a rule a human set on purpose.
 */
export const ANTI_CONFABULATION_DIRECTIVE_PRIORITY = 10;

/**
 * The seeded text.
 *
 * Two named failures, both observed in the fleet: an answer synthesised from
 * retrieval that supports nothing, and a presupposed decision supplied on
 * demand. The closing clause about transcript-derived memories is inert on a
 * bank that carries no such tag, so this text is safe to ship independently.
 */
export const ANTI_CONFABULATION_DIRECTIVE =
  "When the retrieved memories do not support an answer, say so instead of composing one.\n" +
  "\n" +
  "- If nothing retrieved scores meaningfully above zero, or what came back is off-topic, the honest answer is that the bank does not know. Say that plainly, and say what would settle it.\n" +
  "- Never assert a date, a version, a number, an attribution, a decision, or an outcome that no retrieved memory states. A question that presupposes something is not evidence for it: asked when a decision was made, when the bank records no such decision, answer that none is recorded — do not supply one.\n" +
  "- Keep what the bank RECORDED separate from what you INFER. State inferences as inferences, and say which memory a recorded fact came from.\n" +
  "- Treat a memory that was extracted from a conversation transcript as an unverified claim, not an established fact — it may be an assistant's own earlier guess. If it is the only support for an answer, say that it is.\n" +
  "- Partial knowledge with its gaps named is more useful than a fluent answer that fills them in.";

/**
 * Every text switchroom has EVER shipped as the anti-confabulation default.
 *
 * Append-only, byte-exact, never reorder or reformat: membership here is what
 * licenses an automatic upgrade, so an entry that no longer byte-matches what
 * a bank actually carries silently strands that bank on an old default. Empty
 * on first ship — there is no previous default to supersede.
 */
export const SUPERSEDED_ANTI_CONFABULATION_DIRECTIVES: readonly string[] = [];

/** A directive as returned by `GET .../directives`. */
export interface SeededDirectiveRecord {
  id: string;
  name: string;
  content?: string;
  is_active?: boolean;
  priority?: number;
  tags?: string[];
}

export type SeedDirectiveOutcome =
  | { action: "created"; name: string }
  | { action: "upgraded"; name: string }
  | { action: "unchanged"; name: string }
  | { action: "skipped"; name: string; reason: string }
  | { action: "failed"; name: string; reason: string };

/**
 * Resolve the operator's `memory.anti_confabulation_directive` value into the
 * two things the seeding path needs: whether to act at all, and (when the
 * operator supplied text) the text that wins outright.
 *
 * Accepted shapes, matching the yaml schema:
 *   - `undefined` → seed the shipped default (the zero-config path);
 *   - `true`      → same, stated explicitly;
 *   - `false`     → do nothing, and touch nothing that already exists;
 *   - a string    → operator-authored text, pushed and maintained as theirs.
 */
export function resolveAntiConfabulationDirective(
  configured: boolean | string | undefined,
): { enabled: boolean; operatorText?: string; desired: string } {
  if (configured === false) {
    return { enabled: false, desired: ANTI_CONFABULATION_DIRECTIVE };
  }
  if (typeof configured === "string" && configured.trim() !== "") {
    return { enabled: true, operatorText: configured, desired: configured };
  }
  return { enabled: true, desired: ANTI_CONFABULATION_DIRECTIVE };
}

/**
 * Decide what to do about the seeded directive, given the bank's live
 * directives. Pure, so the policy is testable without a server.
 *
 * `activeCount` gates CREATION only: a bank already at `MAX_DIRECTIVES` has no
 * room, and pushing it over the cap would silently truncate the recall block —
 * dropping somebody's directive to make room for ours. Upgrading an existing
 * one consumes no slot and is therefore never gated.
 */
export function decideDirectiveSeed(
  existing: SeededDirectiveRecord | undefined,
  configured: boolean | string | undefined,
  opts: { activeCount: number; desired?: string; shipped?: readonly string[] },
): { action: "create" | "upgrade" | "none" | "skip"; content?: string; reason?: string } {
  const resolved = resolveAntiConfabulationDirective(configured);
  if (!resolved.enabled) return { action: "none", reason: "disabled" };

  const desired = opts.desired ?? resolved.desired;
  const shipped = opts.shipped ?? SUPERSEDED_ANTI_CONFABULATION_DIRECTIVES;

  if (!existing) {
    if (opts.activeCount >= MAX_DIRECTIVES) {
      return {
        action: "skip",
        reason:
          `bank already has ${opts.activeCount} active directives ` +
          `(MAX_DIRECTIVES=${MAX_DIRECTIVES}); seeding would truncate the recall block`,
      };
    }
    return { action: "create", content: desired };
  }

  // An existing directive goes through the shared mission-upgrade rule, so the
  // never-clobber semantics cannot drift from the ones the missions use.
  const decision = decideMissionUpgrade(
    resolved.operatorText,
    existing.content ?? null,
    desired,
    shipped,
  );
  if (decision.action === "none") return { action: "none" };
  if (decision.mission === existing.content) return { action: "none" };
  return { action: "upgrade", content: decision.mission };
}

/**
 * Ensure the anti-confabulation directive on one bank. Best-effort by
 * contract: it NEVER throws and never blocks an apply — a bank without its
 * guardrail is worse than one with it, but a failed apply is worse than both.
 *
 * REST rather than MCP because the MCP surface has no update verb: the pinned
 * image registers `create_directive` / `list_directives` / `delete_directive`
 * only, so an upgrade would have to be delete-then-recreate (losing the id,
 * and briefly leaving the bank unguarded). `PATCH .../directives/{id}` is the
 * honest primitive. Both paths are unauthenticated on the same host — see the
 * boundary note in `hindsight-directive-admin.ts`.
 */
export async function ensureAntiConfabulationDirective(
  apiUrl: string,
  bankId: string,
  configured: boolean | string | undefined,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<SeedDirectiveOutcome> {
  const name = ANTI_CONFABULATION_DIRECTIVE_NAME;
  if (resolveAntiConfabulationDirective(configured).enabled === false) {
    return { action: "skipped", name, reason: "disabled" };
  }

  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const base = apiUrl.replace(/\/mcp\/?$/, "").replace(/\/+$/, "");
  const path = `${base}/v1/default/banks/${encodeURIComponent(bankId)}/directives`;

  const send = async (url: string, init?: { method: string; body?: string }) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await fetchImpl(url, {
        method: init?.method ?? "GET",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "X-Bank-Id": bankId,
        },
        ...(init?.body === undefined ? {} : { body: init.body }),
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    // `active_only=false` so a directive an operator DEACTIVATED is still
    // found — reseeding one they deliberately turned off would be a clobber
    // wearing a create's clothes.
    const listRes = await send(`${path}?active_only=false&limit=1000`);
    if (!listRes.ok) {
      return { action: "failed", name, reason: `list HTTP ${listRes.status}` };
    }
    const parsed = (await listRes.json()) as
      | { items?: SeededDirectiveRecord[] }
      | SeededDirectiveRecord[];
    const items = Array.isArray(parsed) ? parsed : (parsed?.items ?? []);
    const existing = items.find((d) => d?.name === name);
    const activeCount = items.filter((d) => d?.is_active !== false).length;

    const decision = decideDirectiveSeed(existing, configured, { activeCount });

    if (decision.action === "none") return { action: "unchanged", name };
    if (decision.action === "skip") {
      return { action: "skipped", name, reason: decision.reason ?? "skipped" };
    }

    if (decision.action === "create") {
      const res = await send(path, {
        method: "POST",
        body: JSON.stringify({
          name,
          content: decision.content,
          priority: ANTI_CONFABULATION_DIRECTIVE_PRIORITY,
          is_active: true,
          tags: [SWITCHROOM_SEEDED_TAG],
        }),
      });
      if (!res.ok) return { action: "failed", name, reason: `create HTTP ${res.status}` };
      return { action: "created", name };
    }

    const res = await send(`${path}/${encodeURIComponent(existing!.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ content: decision.content }),
    });
    if (!res.ok) return { action: "failed", name, reason: `update HTTP ${res.status}` };
    return { action: "upgraded", name };
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      return { action: "failed", name, reason: "Timeout" };
    }
    return { action: "failed", name, reason: String((err as Error)?.message ?? err) };
  }
}
