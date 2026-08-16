/**
 * `switchroom doctor` section for the hindsight-mcp-shim's REST contract —
 * design-v2.md §2.5's "engine version pin ... and a doctor contract probe",
 * called out as "not built" ("a grep of the shipped shim finds no
 * `/openapi.json` reference"). This file is that probe.
 *
 * Three things a healthy shim needs; here is doctor's existing coverage of
 * each, and what this file adds:
 *
 *   1. **The 32 backend MCP tools resolve.** Already covered by
 *      `classifyToolContract` (`doctor-memory.ts`), driven off a live
 *      `tools/list` and wired into `doctor.ts` as the "hindsight contract:
 *      <tool>" rows. NOT duplicated here.
 *   2. **The five SHIM-SYNTHESIZED tools' REST routes are present.** These
 *      tools (`deactivate_directive`, `reactivate_directive`,
 *      `search_knowledge_pages`, `get_knowledge_page`, `get_knowledge_tree`)
 *      are REST, not MCP — `tools/list` can never see one of their routes
 *      move. This was the gap: nothing in doctor previously read
 *      `/openapi.json`, so a route rename/removal underneath one of these
 *      tools was invisible until an agent's live call failed.
 *   3. **The live engine's declared version matches the pin.** Read from
 *      `/openapi.json`'s `info.version` (design-v2.md §2.5, "E-01's
 *      method") rather than `/version` (already `classifyHindsightVersionSkew`'s
 *      job), so this row is grounded in the SAME document the route check
 *      reads rather than a second probe that could disagree with the first.
 *
 * Classifiers are pure and take an already-fetched `OpenApiSpec`, so they are
 * testable without a live server. The wrapper does the one fetch and is
 * best-effort like every other live doctor probe in this file's siblings.
 */
import { compareApiVersion } from "../memory/hindsight-repair.js";
import {
  fetchHindsightOpenApi,
  missingRoutesForTool,
  SYNTHESIZED_ROUTE_TOOL_NAMES,
  type OpenApiSpec,
} from "../memory/hindsight-shim-contract.js";
import { HINDSIGHT_MIN_API_VERSION } from "../memory/hindsight-tools.js";
import type { CheckResult } from "./doctor-memory.js";

/** Shared name prefix for every row this file produces. */
export const SHIM_CONTRACT_CHECK_PREFIX = "hindsight shim contract";

/**
 * Pure: classify one synthesized tool's route presence in an already-fetched
 * spec. `null` means every route the tool depends on is present — the
 * caller omits the row rather than emitting a per-tool `ok`, matching
 * `classifyToolContract`'s "only report drift" idiom.
 */
export function classifySynthesizedToolRoute(
  spec: OpenApiSpec,
  toolName: string,
): CheckResult | null {
  const missing = missingRoutesForTool(spec, toolName);
  if (missing.length === 0) return null;
  const routeList = missing
    .map((r) => `${r.method.toUpperCase()} ${r.path}`)
    .join(", ");
  return {
    name: `${SHIM_CONTRACT_CHECK_PREFIX}: ${toolName}`,
    status: "fail",
    detail:
      `the live engine's /openapi.json no longer declares [${routeList}] — ` +
      `the REST route(s) '${toolName}' is synthesized over. Every call to ` +
      `this tool will now be loud-rejected by the shim's contract preflight ` +
      `(ShimContractPin.preflight in hindsight-mcp-shim.ts) rather than ` +
      `silently returning nothing, but the tool is effectively dead until ` +
      `this is fixed.`,
    fix:
      "If the engine renamed/moved the route, update SYNTHESIZED_TOOL_ROUTES " +
      "(src/memory/hindsight-shim-contract.ts) and the corresponding " +
      "DirectiveAdmin/KnowledgeAdmin call to match. If the engine now " +
      "registers this capability as a real MCP tool, retire the synthesis " +
      "instead — see the retirement seam in withSynthesizedTools " +
      "(src/cli/hindsight-mcp-shim.ts).",
  };
}

/**
 * Pure: classify the live engine's declared version (`/openapi.json`'s
 * `info.version`) against the floor the shim's route contract is pinned to.
 * Shape mirrors `classifyHindsightVersionSkew` (older/equal/newer →
 * fail/ok/warn) but is a DELIBERATELY SEPARATE row, scoped to the same
 * document the route rows above read — see this file's header for why
 * `/openapi.json`, not `/version`, is the source here.
 */
export function classifyShimContractVersion(spec: OpenApiSpec): CheckResult {
  const name = `${SHIM_CONTRACT_CHECK_PREFIX}: version`;
  const live = spec.info?.version;
  if (typeof live !== "string" || live.length === 0) {
    return {
      name,
      status: "warn",
      detail:
        "/openapi.json has no info.version — cannot confirm the shim's " +
        "REST route contract is pinned to a known engine version.",
    };
  }
  const cmp = compareApiVersion(live, HINDSIGHT_MIN_API_VERSION);
  if (cmp === 0) {
    return {
      name,
      status: "ok",
      detail: `/openapi.json info.version ${live} matches the pinned ${HINDSIGHT_MIN_API_VERSION}`,
    };
  }
  if (cmp < 0) {
    return {
      name,
      status: "fail",
      detail:
        `/openapi.json info.version ${live} is OLDER than the pinned ` +
        `${HINDSIGHT_MIN_API_VERSION} — the REST route contract the five ` +
        `synthesized tools depend on may not exist on this server.`,
      fix:
        "Same remediation as the `hindsight version` check: update the " +
        "pinned image, or deliberately re-pin HINDSIGHT_MIN_API_VERSION to " +
        "this older version.",
    };
  }
  return {
    name,
    status: "warn",
    detail:
      `/openapi.json info.version ${live} is NEWER than the pinned ` +
      `${HINDSIGHT_MIN_API_VERSION} — the engine may have grown a native ` +
      `MCP tool that makes one of the five synthesized tools obsolete; ` +
      `re-check the retirement seam (withSynthesizedTools, ` +
      `hindsight-mcp-shim.ts).`,
  };
}

/**
 * Pure: assemble every row for an already-fetched spec — the version row,
 * one row per synthesized tool with a route problem, and a single rollup
 * `ok` row when every synthesized route is present (never one `ok` row per
 * tool — same "report drift, not health" idiom as `classifyToolContract`).
 */
export function classifyHindsightShimContract(spec: OpenApiSpec): CheckResult[] {
  const results: CheckResult[] = [classifyShimContractVersion(spec)];
  const routeRows = SYNTHESIZED_ROUTE_TOOL_NAMES.map((tool) =>
    classifySynthesizedToolRoute(spec, tool),
  ).filter((r): r is CheckResult => r !== null);
  if (routeRows.length === 0) {
    results.push({
      name: `${SHIM_CONTRACT_CHECK_PREFIX}: routes`,
      status: "ok",
      detail: `all ${SYNTHESIZED_ROUTE_TOOL_NAMES.length} synthesized tools' REST routes are present in /openapi.json`,
    });
  } else {
    results.push(...routeRows);
  }
  return results;
}

/**
 * Best-effort live wrapper: fetch `/openapi.json` and classify it.
 *
 * An unreachable/malformed spec produces NO rows at all — same idiom as
 * `classifyHindsightVersionSkew`'s "live === null → return null" and
 * `checkHindsightContainerHealth`'s "not a local container → return []":
 * reachability itself is already `hindsight` TCP-reach / `hindsight /health`
 * / `hindsight version`'s job in `doctor.ts`, and a second red row for the
 * exact same outage would be noise, not signal.
 */
export async function runHindsightShimContractCheck(
  mcpUrl: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<CheckResult[]> {
  const origin = mcpUrl.replace(/\/mcp\/?$/, "").replace(/\/$/, "");
  const spec = await fetchHindsightOpenApi(origin, opts);
  if (!spec) return [];
  return classifyHindsightShimContract(spec);
}
