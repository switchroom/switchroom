/**
 * Directive retirement over the Hindsight REST API — the implementation
 * behind the shim-synthesized `deactivate_directive` / `reactivate_directive`
 * MCP tools.
 *
 * ## Why REST and not MCP
 *
 * The pinned hindsight image registers exactly three directive tools —
 * `create_directive`, `list_directives`, `delete_directive` (see
 * tests/fixtures/hindsight-tools-list.snapshot.json). There is NO
 * `update_directive` on the MCP surface, so flipping `is_active` is simply
 * not expressible as a backend tool call. The REST API does expose it:
 * `PATCH /v1/default/banks/{bank_id}/directives/{directive_id}` accepts
 * `UpdateDirectiveRequest{name, content, priority, is_active, tags}`.
 *
 * Consequence: retirement was previously reachable ONLY by hand-rolled curl
 * from an agent's Bash — undiscoverable, unaudited, and unbounded (that curl
 * can equally rewrite `content` or target a peer's bank). This module is the
 * narrow, named, provenance-stamping alternative.
 *
 * ## The bank pin is a USABILITY AND PROVENANCE boundary, NOT A SECURITY ONE
 *
 * Read this before you cite it as a control. `bankId` is pinned here from the
 * agent's own `HINDSIGHT_BANK_ID` and the tool schemas expose no `bank_id`
 * property, so a *tool call* physically cannot address another agent's bank.
 * That is the entire extent of the guarantee.
 *
 * It is NOT a security boundary, because the transport underneath it is
 * unauthenticated (established by live probe, 2026-07-29): the Hindsight REST
 * server declares zero `securitySchemes`, `authorization` is `required:false`
 * and wired to nothing, `X-Bank-Id` is advisory and ignored by the REST layer,
 * and `bank_id` is a path parameter — a PATCH aimed at a foreign bank reaches
 * resource resolution and answers 404, not 401/403. Any agent with Bash can
 * still curl any bank directly, bypassing this module entirely. Closing that
 * is a separate, larger workstream (plan item P0: loopback bind, tenant API
 * key, per-agent UDS proxy) and nothing here should be read as having done it.
 *
 * So: this module makes the SANCTIONED path safe and self-documenting. It does
 * not make the unsanctioned path unavailable.
 *
 * ## Scope discipline
 *
 * The PATCH body is built by {@link buildDirectivePatchBody}, which admits
 * `is_active` and `tags` and nothing else. `name`, `content` and `priority`
 * are never sent, so no code path here can rewrite a directive's text —
 * deliberately, because a directive body is the guardrail itself and a PATCH
 * to `content` is destructive with no history table to recover from.
 *
 * ## Known limit, stated rather than papered over
 *
 * Tag updates are read-modify-write against an API with no compare-and-swap
 * and no per-directive ETag, so two supersessions racing on the SAME winner
 * can lose one of the two `supersedes:` tags. `deactivate` is the atomic unit
 * from the caller's perspective (its own pair is all-or-nothing), not a
 * serializable transaction against concurrent writers. In practice retirement
 * is an interactive, one-at-a-time operation, and there is no upstream
 * primitive that would let this module do better — so it is documented, not
 * silently assumed away.
 */

/**
 * Hard cap on how many active directives the recall hook ever injects into the
 * prompt — MUST mirror `MAX_DIRECTIVES` in
 * `vendor/hindsight-memory/scripts/lib/directives.py`. A bank with MORE active
 * directives than this has its list truncated (`directives[:30]`) in the
 * `<active_directives>` recall block: the lowest-priority directives beyond the
 * cap never reach the agent. The plugin also warns to stderr when it truncates;
 * the doctor surfaces the same condition fleet-wide (workstream C2).
 *
 * It lives here, in the memory layer, because both READERS (`switchroom
 * doctor`, which re-exports it from `cli/doctor-memory.ts`) and WRITERS (the
 * seeded directive in `hindsight-seed-directives.ts`, which must not push a
 * bank over the cap) need it, and the writer is a memory module.
 */
export const MAX_DIRECTIVES = 30;

/** Directive as returned by `GET .../directives`. */
export interface HindsightDirective {
  id: string;
  bank_id?: string;
  name: string;
  content?: string;
  priority?: number;
  is_active?: boolean;
  tags?: string[];
}

/**
 * The ONLY fields this module will ever PATCH.
 *
 * `UpdateDirectiveRequest` upstream also accepts `name`, `content` and
 * `priority`. Their absence from this type is the mechanism, not a comment:
 * there is no call path that can populate them.
 */
export interface DirectivePatchBody {
  is_active?: boolean;
  tags?: string[];
}

/**
 * Build a PATCH body from an explicit whitelist.
 *
 * Exported so a test can assert the key set directly rather than inferring it
 * from behaviour — a regression that reintroduced `content` here would be a
 * silent guardrail-rewrite primitive.
 */
export function buildDirectivePatchBody(fields: {
  isActive?: boolean;
  tags?: string[];
}): DirectivePatchBody {
  const body: DirectivePatchBody = {};
  if (fields.isActive !== undefined) body.is_active = fields.isActive;
  if (fields.tags !== undefined) body.tags = [...fields.tags];
  return body;
}

/** Provenance tag written on the directive being retired. */
export function supersededByTag(winnerName: string): string {
  return `superseded-by:${winnerName}`;
}

/** Provenance tag written on the directive that replaces it. */
export function supersedesTag(retiredName: string): string {
  return `supersedes:${retiredName}`;
}

/**
 * Marker tag stamped on a directive that Memory v2 M2 triage has classified
 * `rules-block` (E-45). This is the ONE chokepoint {@link DirectiveAdmin}
 * checks before any deactivation — not the triage card's per-call
 * `category` field, which a caller (buggy classifier, hand-rolled row, a
 * stale `superseded-by` tag racing a real rules-block classification) can
 * get wrong. Once a directive carries this tag, `deactivate`/`deactivateById`
 * refuse it unconditionally, regardless of what name/id/pairing the caller
 * passes — an invariant read from the directive's OWN persisted state, not
 * from anything the caller asserts about it (M2 redteam B1/B2).
 *
 * Decision 3 (M2, Ken-approved): rules-block directives stay ACTIVE, staged
 * + measured only, until M3 flips the agent's rules-block replacement live.
 * Removing the marker (an operator/M3 action, not exposed here) is what
 * unlocks a subsequent deactivation.
 */
export const RULES_BLOCK_MARKER_TAG = "triage-category:rules-block";

/** True when `tags` carries the rules-block marker. */
export function hasRulesBlockMarker(tags: string[] | undefined): boolean {
  return (tags ?? []).includes(RULES_BLOCK_MARKER_TAG);
}

/**
 * Thrown by {@link DirectiveAdmin.deactivate} / `deactivateById` /
 * `deactivateByIdWithTag` when the target directive carries
 * {@link RULES_BLOCK_MARKER_TAG}. This is the code-enforced form of Decision
 * 3 — it fires from directive STATE, not from a caller's classification, so
 * it cannot be routed around by a card generator bug, a stale tag, or a
 * hand-built row.
 */
export class RulesBlockDeactivationRefusedError extends Error {
  constructor(readonly directiveName: string) {
    super(
      `Refusing to deactivate '${directiveName}': it carries the ` +
        `${RULES_BLOCK_MARKER_TAG} marker. M2 leaves rules-block-category ` +
        "directives ACTIVE (staged + measured only) until M3 flips this " +
        "agent's rules-block replacement live — deactivating one now would " +
        "open a guardrail gap with nothing enforcing the behaviour in " +
        "between. This is enforced inside DirectiveAdmin itself, on every " +
        "call path (MCP shim, apply-batch executor, reconcile) — not left " +
        "to a caller's classification. Do not route around it.",
    );
    this.name = "RulesBlockDeactivationRefusedError";
  }
}

export interface DirectiveAdminOptions {
  /** REST base, e.g. `http://127.0.0.1:18888` (no trailing slash). */
  apiBaseUrl: string;
  /**
   * The agent's OWN bank. Pinned: every request path this module builds
   * embeds this value, and no caller-supplied input can reach it.
   */
  bankId: string;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
}

export const DIRECTIVE_ADMIN_TIMEOUT_MS = 15_000;

/**
 * Thrown when a supersession pair could not be left consistent: the winner's
 * tag was written, the loser's write failed, AND the rollback of the winner
 * also failed. The message names both directives and the exact repair, because
 * this is the one state the caller cannot infer from a generic failure.
 */
export class DirectivePairInconsistentError extends Error {
  constructor(
    readonly retiredName: string,
    readonly winnerName: string,
    readonly cause1: unknown,
    readonly cause2: unknown,
  ) {
    super(
      `INCONSISTENT STATE — the supersession pair is half-written. ` +
        `'${winnerName}' now carries the tag ${supersedesTag(retiredName)} but ` +
        `'${retiredName}' was NOT deactivated (${String(cause1)}), and the ` +
        `rollback of '${winnerName}' also failed (${String(cause2)}). ` +
        `Repair manually: remove ${supersedesTag(retiredName)} from ` +
        `'${winnerName}', or complete the retirement of '${retiredName}'. ` +
        `Do not assume either directive is in the state you asked for.`,
    );
    this.name = "DirectivePairInconsistentError";
  }
}

export class DirectiveAdmin {
  constructor(private readonly opts: DirectiveAdminOptions) {}

  private get fetchImpl(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  /**
   * Base path for THIS agent's directives. The bank segment comes from
   * `opts.bankId` only — there is no parameter, so no caller can redirect it.
   */
  private directivesPath(): string {
    const base = this.opts.apiBaseUrl.replace(/\/+$/, "");
    return `${base}/v1/default/banks/${encodeURIComponent(this.opts.bankId)}/directives`;
  }

  private async send(
    url: string,
    init: { method: string; body?: string },
  ): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(
      () => ctl.abort(),
      this.opts.timeoutMs ?? DIRECTIVE_ADMIN_TIMEOUT_MS,
    );
    try {
      return await this.fetchImpl(url, {
        method: init.method,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          // Advisory only — the REST layer ignores it. Sent for parity with
          // the shim's MCP path and so request logs carry the intent.
          ...(this.opts.bankId ? { "X-Bank-Id": this.opts.bankId } : {}),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * All directives in the pinned bank, ACTIVE AND INACTIVE.
   *
   * Both query params are load-bearing, not defensive:
   *   • `active_only` defaults to **true** upstream, so a bare GET returns
   *     only active directives — `reactivate_directive` would then never be
   *     able to find the very directives it exists to restore.
   *   • `limit` defaults to 100. `MAX_DIRECTIVES` is 30 today, but the cap is
   *     on ACTIVE directives, and retirement is exactly the thing that grows
   *     the inactive pile — so the paged default would start silently hiding
   *     retired directives from reactivation once a bank accumulated 100.
   *     1000 is the schema maximum.
   */
  async list(): Promise<HindsightDirective[]> {
    const res = await this.send(
      `${this.directivesPath()}?active_only=false&limit=1000`,
      { method: "GET" },
    );
    if (!res.ok) {
      throw new Error(
        `listing directives in bank '${this.opts.bankId}' failed: HTTP ${res.status}`,
      );
    }
    const parsed = (await res.json()) as
      | { items?: HindsightDirective[] }
      | HindsightDirective[];
    const items = Array.isArray(parsed) ? parsed : (parsed.items ?? []);
    return items;
  }

  /**
   * PATCH one directive. Body is whitelist-built; `directiveId` always comes
   * from a prior `list()` of the pinned bank, never from caller input.
   */
  private async patch(
    directiveId: string,
    fields: { isActive?: boolean; tags?: string[] },
  ): Promise<void> {
    const body = buildDirectivePatchBody(fields);
    const res = await this.send(
      `${this.directivesPath()}/${encodeURIComponent(directiveId)}`,
      { method: "PATCH", body: JSON.stringify(body) },
    );
    if (!res.ok) {
      throw new Error(
        `updating directive ${directiveId} failed: HTTP ${res.status}`,
      );
    }
  }

  /** Exact-name resolution within the pinned bank. Ambiguity is an error. */
  private resolve(
    all: HindsightDirective[],
    name: string,
    label: string,
  ): HindsightDirective {
    const hits = all.filter((d) => d.name === name);
    if (hits.length === 0) {
      const known = all
        .map((d) => d.name)
        .sort()
        .join(", ");
      throw new Error(
        `no directive named '${name}' in bank '${this.opts.bankId}' (${label}). ` +
          `Known directives: ${known || "(none)"}`,
      );
    }
    if (hits.length > 1) {
      throw new Error(
        `'${name}' is ambiguous — ${hits.length} directives in bank ` +
          `'${this.opts.bankId}' share that name (${label}). Resolve the ` +
          `duplicate before retiring either.`,
      );
    }
    return hits[0];
  }

  /**
   * Id resolution — never ambiguous (ids are unique), and unaffected by a
   * name collision (e.g. an in-flight windows-boxes-class reconcile, where
   * two directives briefly share a name). Callers that already hold a row's
   * `id` (the triage card, the reconcile path) should resolve this way, not
   * by name — see M1/redteam-M2.md.
   */
  private resolveById(
    all: HindsightDirective[],
    id: string,
    label: string,
  ): HindsightDirective {
    const hit = all.find((d) => d.id === id);
    if (!hit) {
      throw new Error(
        `no directive with id '${id}' in bank '${this.opts.bankId}' (${label}).`,
      );
    }
    return hit;
  }

  /** Union that preserves existing order and never duplicates. */
  private withTag(existing: string[] | undefined, tag: string): string[] {
    const tags = [...(existing ?? [])];
    if (!tags.includes(tag)) tags.push(tag);
    return tags;
  }

  /**
   * The rules-block refusal chokepoint (Decision 3, M2 redteam B2). Every
   * deactivation path (`deactivate`, `deactivateById`,
   * `deactivateByIdWithTag`) routes through this one check, reading the
   * marker straight off `target.tags` as fetched by `list()` — never off a
   * caller-supplied classification. There is no way to reach a `patch()`
   * call that flips `is_active: false` on a rules-block-marked directive
   * without going through this function first.
   */
  private refuseIfRulesBlock(target: HindsightDirective): void {
    if (hasRulesBlockMarker(target.tags)) {
      throw new RulesBlockDeactivationRefusedError(target.name);
    }
  }

  /**
   * Shared core for `deactivate`/`deactivateById`: `target` is already
   * resolved (by name or by id — the resolution strategy is the only thing
   * that differs between the two public entry points).
   *
   * Set `is_active: false` on `target`, optionally recording that
   * `supersededBy` replaces it (resolved BY NAME — only safe when the
   * winner's name cannot collide with `target`'s; the windows-boxes-class
   * reconcile path, where old and new share a name, uses
   * `deactivateByIdWithTag` instead, which never resolves a winner by name).
   *
   * Ordering is the atomicity mechanism. The winner (B) is tagged FIRST
   * because that write is non-destructive and leaves the retiring directive
   * (A) fully intact if it fails — so a failure there is a clean no-op. Only
   * once B is stamped is A deactivated; if THAT fails, B's tags are restored
   * to their exact prior value. If the restore fails too we throw
   * {@link DirectivePairInconsistentError}, which states the residue
   * explicitly. There is no path that returns success on a half-written pair.
   */
  private async deactivateResolved(
    all: HindsightDirective[],
    target: HindsightDirective,
    supersededBy?: string,
  ): Promise<string> {
    this.refuseIfRulesBlock(target);

    if (!supersededBy) {
      await this.patch(target.id, { isActive: false });
      return (
        `Deactivated directive '${target.name}' in bank '${this.opts.bankId}'. ` +
        `It is no longer injected as a hard rule. Reverse with ` +
        `reactivate_directive.`
      );
    }

    const winner = this.resolve(all, supersededBy, "the superseding directive");
    if (winner.id === target.id) {
      throw new Error(
        `'${target.name}' cannot supersede itself — pass the name of the ` +
          `directive that REPLACES it as superseded_by.`,
      );
    }

    const winnerTagsBefore = [...(winner.tags ?? [])];
    // Step 1 — stamp the winner. Non-destructive; A untouched if this throws.
    await this.patch(winner.id, {
      tags: this.withTag(winnerTagsBefore, supersedesTag(target.name)),
    });
    // Step 2 — retire the loser.
    try {
      await this.patch(target.id, {
        isActive: false,
        tags: this.withTag(target.tags, supersededByTag(winner.name)),
      });
    } catch (err) {
      try {
        await this.patch(winner.id, { tags: winnerTagsBefore });
      } catch (rollbackErr) {
        throw new DirectivePairInconsistentError(
          target.name,
          winner.name,
          err,
          rollbackErr,
        );
      }
      throw new Error(
        `Deactivating '${target.name}' failed (${String(err)}). The ` +
          `supersession tag on '${winner.name}' was rolled back, so both ` +
          `directives are unchanged — nothing was half-written. Retry once ` +
          `the cause is cleared.`,
      );
    }
    return (
      `Deactivated directive '${target.name}' in bank '${this.opts.bankId}', ` +
      `superseded by '${winner.name}'. Provenance recorded: ` +
      `'${target.name}' tagged ${supersededByTag(winner.name)}, ` +
      `'${winner.name}' tagged ${supersedesTag(target.name)}.`
    );
  }

  /**
   * Set `is_active: false` on `name`, optionally recording that
   * `supersededBy` replaces it. See {@link deactivateResolved} for the
   * mechanism and the rules-block refusal.
   */
  async deactivate(args: {
    name: string;
    supersededBy?: string;
  }): Promise<string> {
    const all = await this.list();
    const target = this.resolve(all, args.name, "the directive to deactivate");
    return this.deactivateResolved(all, target, args.supersededBy);
  }

  /**
   * Same as {@link deactivate}, but resolves the target by `id` rather than
   * `name` (M2 redteam M1). Callers that already hold a row's `id` — the
   * triage apply-batch executor in particular — MUST use this, not
   * `deactivate({name})`: once a windows-boxes-class reconcile has run, two
   * directives can briefly share a name, and `deactivate({name})` would hit
   * `resolve()`'s "ambiguous" error and abort mid-batch, discarding partial
   * progress.
   */
  async deactivateById(args: {
    id: string;
    supersededBy?: string;
  }): Promise<string> {
    const all = await this.list();
    const target = this.resolveById(all, args.id, "the directive to deactivate");
    return this.deactivateResolved(all, target, args.supersededBy);
  }

  /**
   * Deactivate `id` and append one arbitrary provenance `tag` — no winner
   * pairing, no by-name resolution anywhere. For callers like the
   * windows-boxes-class reconcile, where the "winner" (the new superset
   * copy) shares `target`'s exact name, so resolving it by name would hit
   * the ambiguous-name error this whole by-id surface exists to avoid.
   * Still refuses on the rules-block marker, same chokepoint as every other
   * deactivation path.
   */
  async deactivateByIdWithTag(args: { id: string; tag: string }): Promise<string> {
    const all = await this.list();
    const target = this.resolveById(all, args.id, "the directive to deactivate");
    this.refuseIfRulesBlock(target);
    await this.patch(target.id, {
      isActive: false,
      tags: this.withTag(target.tags, args.tag),
    });
    return (
      `Deactivated directive '${target.name}' (id ${target.id}) in bank ` +
      `'${this.opts.bankId}', tagged ${args.tag}.`
    );
  }

  /** Set `is_active: true` on `name`. Nothing else changes. */
  async reactivate(args: { name: string }): Promise<string> {
    const all = await this.list();
    const target = this.resolve(all, args.name, "the directive to reactivate");
    await this.patch(target.id, { isActive: true });
    return (
      `Reactivated directive '${target.name}' in bank '${this.opts.bankId}'. ` +
      `It is injected as a hard rule again. Any superseded-by tag was left ` +
      `in place as a record — clear it manually if the supersession is off.`
    );
  }

  /**
   * Stamp {@link RULES_BLOCK_MARKER_TAG} on `id` — the durable, persisted
   * form of a triage pass's "this directive is rules-block category"
   * classification (M2 redteam B2). Once stamped, EVERY future
   * deactivation attempt against this directive is refused by
   * {@link refuseIfRulesBlock}, regardless of what any later triage pass,
   * card, or row believes about it. Idempotent: re-stamping an
   * already-marked directive is a no-op.
   */
  async markRulesBlock(args: { id: string }): Promise<string> {
    const all = await this.list();
    const target = this.resolveById(all, args.id, "the directive to mark rules-block");
    if (hasRulesBlockMarker(target.tags)) {
      return (
        `'${target.name}' already carries ${RULES_BLOCK_MARKER_TAG} — no change.`
      );
    }
    await this.patch(target.id, {
      tags: this.withTag(target.tags, RULES_BLOCK_MARKER_TAG),
    });
    return (
      `Marked '${target.name}' rules-block in bank '${this.opts.bankId}'. ` +
      `deactivate_directive now refuses it until the marker is removed ` +
      `(an M3-flip action, not exposed here).`
    );
  }

  /**
   * Create a new directive in the pinned bank. Public so callers like the
   * windows-boxes-class reconcile never need their own raw fetch/REST-path
   * plumbing — `apiBaseUrl`/`bankId` stay pinned to THIS instance, the same
   * guarantee every other method on this class already gives (M2 redteam
   * M3: Shape α by construction, not by caller discipline).
   */
  async create(args: {
    name: string;
    content: string;
    isActive?: boolean;
    priority?: number;
    tags?: string[];
  }): Promise<HindsightDirective> {
    const body: Record<string, unknown> = {
      name: args.name,
      content: args.content,
      is_active: args.isActive ?? true,
    };
    if (args.priority !== undefined) body.priority = args.priority;
    if (args.tags !== undefined) body.tags = [...args.tags];
    const res = await this.send(this.directivesPath(), {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(
        `creating directive '${args.name}' in bank '${this.opts.bankId}' failed: HTTP ${res.status}`,
      );
    }
    return (await res.json()) as HindsightDirective;
  }

  /** The bank this instance is pinned to — read-only, for error messages
   *  and callers that need it for display, never for redirecting a request. */
  get bankId(): string {
    return this.opts.bankId;
  }
}
