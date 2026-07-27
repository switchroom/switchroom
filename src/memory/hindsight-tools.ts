/**
 * Hindsight MCP tool contract — the single source of truth for which tools
 * switchroom calls and the args they require.
 *
 * WHY THIS EXISTS: over 2026-06-06..07, FIVE switchroom→hindsight callsites
 * broke SILENTLY because the upstream server renamed/removed a tool or renamed
 * a required arg while switchroom checked only the HTTP status. A hindsight
 * `tools/call` returns HTTP 200 with `result.isError:true` on a bad/renamed/
 * unknown arg (never a transport error), so HTTP-status checks are structurally
 * insufficient — and an `isError` check ALONE still misses *silently-dropped*
 * extra args (the server ignores an unknown arg, isError:false). Incidents:
 *   1. create_mental_model arg `query` → renamed to `source_query` (isError).
 *   2. vault-sweep `delete_memory` → phantom tool.
 *   3. addMemoryTag `update_memory` → phantom tool.
 *   4. agent guidance named `delete_memory` (phantom; real is delete_document).
 *   5. user-profile existence check substring-matched the list blob.
 *
 * This module pins the contract so drift becomes a CI-red test (offline) and a
 * doctor `fail` line (live), instead of a silent fleet-wide no-op. The live
 * server's full advertised surface is the golden snapshot at
 * `tests/fixtures/hindsight-tools-list.snapshot.json`; `EXPECTED_HINDSIGHT_TOOLS`
 * covers only the tools switchroom actually uses and is cross-checked against
 * that snapshot by `tests/memory.hindsight-contract.fixture.test.ts`.
 *
 * ## 2026-07-27 re-audit against hindsight 0.8.5
 *
 * Incidents 2 and 3 above are now half stale, in opposite directions, and both
 * halves were invisible because the snapshot had not been refreshed since
 * 2026-06-07 (29 tools; the server has advertised 32 since at least 0.8.4):
 *
 *  - `invalidate_memory` and `update_memory` are REAL server tools, not
 *    phantoms. vault-sweep already migrated to `invalidate_memory`; both are
 *    now tracked here so the contract check actually covers them.
 *  - `update_memory` still cannot write tags. Its accepted props are
 *    text / context / occurred_start / occurred_end / fact_type / entities —
 *    no `tags`, no `add_tags` — and no tag-mutation route exists on the REST
 *    surface either (`PATCH .../memories/{memory_id}` takes the same field
 *    set). So `switchroom memory demote`'s `add_tags` arg is unsupported, and
 *    the only way a memory acquires a demote tag today is at retain time.
 *    Recorded structurally as {@link HindsightCallsite.knownUnsupportedArgs}
 *    so the fixture test ASSERTS the arg is still unsupported — the day
 *    upstream adds it the test goes red and tells us to un-break demote.
 *    See `addMemoryTag` in `src/memory/hindsight.ts`.
 */

export interface HindsightToolSpec {
  /** Args the server marks required (inputSchema.required). A callsite missing
   *  any of these silently no-ops (the `source_query` rename, #1). This is the
   *  hand-maintained INTENT; the golden snapshot is the captured server truth,
   *  and the fixture test asserts the two agree. (The full accepted-prop set
   *  lives in the snapshot — not duplicated here — so the silent-dropped-arg
   *  guard checks sent args against the snapshot, the single source of truth.) */
  required: string[];
}

/**
 * The hindsight MCP tools switchroom calls (TS callers, the prompt guidance,
 * and the user-profile-refresh hook), with the args the server marks required.
 * `required` is cross-checked against the golden snapshot by the fixture test —
 * a server rename of a required arg reds the suite.
 */
export const EXPECTED_HINDSIGHT_TOOLS: Record<string, HindsightToolSpec> = {
  // ── agent-invoked (named in MEMORY_GUIDANCE / fleet invariants) ──
  recall: { required: ["query"] },
  reflect: { required: ["query"] },
  retain: { required: ["content"] },
  sync_retain: { required: ["content"] },
  delete_document: { required: ["document_id"] },
  // directives — instructed in profiles/default/CLAUDE.md.hbs
  create_directive: { required: ["content", "name"] },
  list_directives: { required: [] },
  delete_directive: { required: ["directive_id"] },

  // ── host-side (src/memory/hindsight.ts, src/cli/vault-sweep.ts, src/agents/status.ts) ──
  create_bank: { required: ["bank_id"] },
  update_bank: { required: [] },
  list_banks: { required: [] },
  create_mental_model: { required: ["name", "source_query"] },
  list_mental_models: { required: [] },
  update_mental_model: { required: ["mental_model_id"] },
  refresh_mental_model: { required: ["mental_model_id"] },
  list_memories: { required: [] },
  get_memory: { required: ["memory_id"] },
  // ── memory curation (src/memory/hindsight.ts addMemoryTag, src/cli/vault-sweep.ts) ──
  // Both were mis-recorded as phantom tools in the 2026-06-07 audit; they are
  // real and have been since at least 0.8.4. Tracking them here is what puts
  // them under the live doctor contract check.
  update_memory: { required: ["memory_id"] },
  invalidate_memory: { required: ["memory_id"] },
};

export type HindsightCallSurface = "ts" | "hook" | "prompt";

export interface HindsightCallsite {
  /** Human label: file:line (or the carrier name). */
  where: string;
  /** The tool the callsite invokes. */
  tool: string;
  /** The arg keys the callsite SENDS. */
  argKeys: string[];
  surface: HindsightCallSurface;
  /** Known-broken callsite kept for honesty: it calls a phantom tool and is
   *  isError-guarded so it fails loudly, but the feature is non-functional
   *  until a rework. Excluded from "must be a real tool" so the suite stays
   *  green while still tracking it. */
  knownBrokenPhantom?: boolean;
  /** Args this callsite sends that the server does NOT accept. The tool is
   *  real and the callsite is isError-guarded, so the feature fails loudly
   *  rather than silently — but it cannot work until upstream grows the arg.
   *
   *  These are excluded from the "every sent arg is accepted" guard AND
   *  asserted to be genuinely ABSENT from the snapshot, so the entry is
   *  self-invalidating: when upstream adds the arg the fixture test goes red
   *  and points at the feature waiting to be un-broken. A stale exemption
   *  therefore cannot linger the way a bare comment can. */
  knownUnsupportedArgs?: string[];
}

/**
 * Every host-side hindsight `tools/call` switchroom makes, with the exact arg
 * keys sent. The fixture test cross-checks each against EXPECTED_HINDSIGHT_TOOLS:
 * the tool must exist, every required arg must be sent, and every sent arg must
 * be an accepted prop (the silent-drop guard). Keep in lockstep with the code.
 */
export const HINDSIGHT_TS_CALLSITES: HindsightCallsite[] = [
  { where: "src/memory/hindsight.ts ensureUserProfileMentalModel:list", tool: "list_mental_models", argKeys: [], surface: "ts" },
  { where: "src/memory/hindsight.ts ensureUserProfileMentalModel:create", tool: "create_mental_model", argKeys: ["name", "source_query"], surface: "ts" },
  { where: "src/memory/hindsight.ts createBank", tool: "create_bank", argKeys: ["bank_id"], surface: "ts" },
  { where: "src/memory/hindsight.ts updateBankMissions", tool: "update_bank", argKeys: ["bank_id", "mission", "config_updates"], surface: "ts" },
  { where: "src/agents/status.ts probeHindsight", tool: "list_banks", argKeys: [], surface: "ts" },
  { where: "src/cli/vault-sweep.ts listMemories", tool: "list_memories", argKeys: ["bank_id", "limit", "offset"], surface: "ts" },
  { where: "src/cli/vault-sweep.ts deleteMemory", tool: "invalidate_memory", argKeys: ["memory_id", "reason"], surface: "ts" },
  // `add_tags` is not an accepted prop of `update_memory` on 0.8.5 (nor on
  // 0.8.4) — `switchroom memory demote` therefore fails honestly via the
  // isError guard and cannot work until upstream grows a tag-write path.
  {
    where: "src/memory/hindsight.ts addMemoryTag",
    tool: "update_memory",
    argKeys: ["bank_id", "memory_id", "add_tags"],
    surface: "ts",
    knownUnsupportedArgs: ["add_tags"],
  },
];

/** Tools the agent model is INSTRUCTED to call (MEMORY_GUIDANCE + the fleet
 *  invariants + the directive guidance). Every one must be a real server tool —
 *  this list is what the prompt-carrier guard cross-checks. */
export const HINDSIGHT_PROMPT_TOOLS: string[] = [
  "recall",
  "reflect",
  "sync_retain",
  "retain",
  "delete_document",
  "create_directive",
  "list_directives",
  "delete_directive",
];

/** Tools the user-profile-refresh Stop hook (bin/user-profile-refresh-hook.sh)
 *  invokes over MCP. */
export const HINDSIGHT_HOOK_TOOLS: string[] = ["list_mental_models", "refresh_mental_model"];
