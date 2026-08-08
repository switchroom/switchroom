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
 *    no `tags`, no `add_tags` — and no PER-MEMORY tag-mutation route exists on
 *    the REST surface either (`PATCH .../memories/{memory_id}` takes the same
 *    field set; `PATCH .../documents/{document_id}` DOES rewrite a document's
 *    memory-unit tags, but it is document-scoped, replaces rather than appends,
 *    needs a non-null document_id and re-triggers consolidation, so it cannot
 *    demote a single memory — #3772). So `switchroom memory demote`'s
 *    `add_tags` arg is unsupported, and the only way a memory acquires a demote
 *    tag today is at retain time. Recorded structurally as
 *    {@link HindsightCallsite.knownUnsupportedArgs} so the fixture test ASSERTS
 *    the arg is still unsupported — the day upstream adds it the test goes red
 *    and tells us to un-break demote.
 *    See `addMemoryTag` in `src/memory/hindsight.ts`.
 *
 * ## An `isError` guard is NOT a silent-drop guard
 *
 * Worth stating plainly, because this repo asserted the opposite for a while:
 * `result.isError` fires for an unknown TOOL, never for an unknown ARGUMENT.
 * Probed live on 0.8.4, `update_memory{memory_id, add_tags}` and
 * `update_memory{memory_id}` return byte-identical bodies, both isError:false;
 * only a genuinely unknown tool name (`delete_memory`) yields isError:true.
 * Application errors are invisible to it too — a missing memory answers
 * isError:false with the body `{"error": "Memory '…' not found"}`.
 *
 * So a callsite that sends an arg listed in `knownUnsupportedArgs` cannot rely
 * on the server to tell it anything. The only honest verification is to read
 * the intended effect back out of the response body, which is what
 * `addMemoryTag` does. The static guards here — the offline fixture test and
 * the live doctor contract check — are what catch this drift; the MCP error
 * envelope will not.
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
 * The hindsight API version the committed MCP contract was captured from, and
 * the FLOOR switchroom's tool/arg surface requires.
 *
 * This tracks `tests/fixtures/hindsight-tools-list.snapshot.json` and NOTHING
 * ELSE. It is deliberately NOT the floor for any individual backend feature —
 * see {@link HINDSIGHT_REPAIR_MIN_API_VERSION}. Conflating the two is what made
 * an earlier revision of this branch ship a doctor row that was guaranteed red
 * on the running fleet: the snapshot described 0.8.4, the constant claimed
 * 0.8.5 because `repair-bank` needs 0.8.5, and every `switchroom doctor` run
 * printed a failure the operator could do nothing about. A flagship check that
 * is red by construction trains people to ignore it. The two values COINCIDE
 * today (#3768 bumped the pinned image to 0.8.5, the version that first ships
 * `repair-bank`) — that is a coincidence of the moment, not a licence to fuse
 * them again. This one moves only when the snapshot is re-captured.
 *
 * A floor, not an equality pin, and the distinction is deliberate:
 *  - **Below it** is a hard problem: the snapshot (and therefore
 *    `EXPECTED_HINDSIGHT_TOOLS`, the shim's fallback manifest, and every arg
 *    the CLI sends) describes a surface the running server may not have.
 *  - **Above it** is not an error, because upstream's MCP changes have been
 *    additive. It IS a staleness signal: a newer server may advertise tools and
 *    props the snapshot has never heard of, and a capability switchroom cannot
 *    see is a capability the fleet does not have. Not hypothetical — the
 *    snapshot sat weeks stale while hiding three whole tools.
 *
 * `tests/memory.hindsight-contract.fixture.test.ts` asserts this equals the
 * snapshot's `_meta.hindsight_api_version` (which in turn must equal the
 * api_version `docker/Dockerfile.hindsight` pins), so the three cannot drift
 * apart: bumping one without re-capturing the others reds the suite.
 *
 * 2026-08-01: moved to 0.8.6 with the base bump, alongside a re-capture of the
 * snapshot from the new digest. The two values no longer coincide with
 * {@link HINDSIGHT_REPAIR_MIN_API_VERSION} (still 0.8.5, where `repair-bank`
 * first shipped) — which is the separation working as designed, not drift.
 *
 * 2026-08-08: moved to 0.9.0 with the base bump (switchroom #4525/#4529), again
 * alongside a re-capture of the snapshot from the new digest. The MCP surface
 * itself did not move: `mcp_tools.py`, `api/mcp.py` and `extensions/mcp.py` are
 * byte-identical between the v0.8.6 and v0.9.0 tags, so the re-capture is
 * expected to change only `_meta`. That is the reassuring outcome, not a reason
 * to skip the capture — "we assumed it was identical" is exactly how the
 * snapshot went weeks stale last time.
 */
export const HINDSIGHT_MIN_API_VERSION = "0.9.0";

/**
 * The hindsight version that first ships `hindsight-admin repair-bank`
 * (vectorize-io/hindsight#2645) — the only supported way to rebuild a bank's
 * missing per-(bank, fact_type) vector-index coverage.
 *
 * A FEATURE floor, separate from {@link HINDSIGHT_MIN_API_VERSION} on purpose.
 * It gates exactly one thing — `switchroom memory repair`'s preflight, which
 * turns typer's misleading `No such command 'repair-bank'` into the real
 * sentence — and it deliberately does NOT gate the MCP contract or produce a
 * standing doctor row. The image pin caught up in #3768, so on the fleet this
 * floor is now satisfied; the separation stays because the NEXT feature floor
 * will not be, and the operator should learn about a gap at the moment they
 * try to use the feature — the only moment the information is actionable.
 */
export const HINDSIGHT_REPAIR_MIN_API_VERSION = "0.8.5";

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
   *  real, so the server SILENTLY DROPS the arg and answers isError:false —
   *  an isError guard cannot detect this. A callsite listed here must verify
   *  the intended effect out of the response body instead (see `addMemoryTag`),
   *  or it will report success while doing nothing.
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
  // `add_tags` is not an accepted prop of `update_memory` on 0.8.4 (nor on
  // 0.8.5). The server drops it silently and still answers isError:false, so
  // `addMemoryTag` verifies by reading the tag back out of the returned memory
  // unit; `switchroom memory demote` fails honestly on that read-back and
  // cannot work until upstream grows a per-memory tag-write path (#3772).
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
