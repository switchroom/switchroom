/**
 * Memory-backend health checks for `switchroom doctor`.
 *
 * The existing hindsight checks (`checkHindsight`) confirm the backend is
 * *reachable and speaking MCP* — but the 2026-06-06 outage proved that's not
 * enough: the container was up and serving MCP while every memory write
 * silently failed. Two distinct failure modes hid behind a healthy-looking
 * port:
 *
 *   1. **shm exhaustion** — PostgreSQL needs ~533MB+ of shared memory for
 *      large query/sort segments; Docker's 64MB default made every write fail
 *      with `could not resize shared memory segment ... No space left on
 *      device`. (Now prevented at launch by --shm-size, #2190 — but a
 *      pre-#2190 container or a hand-rolled one can still hit it.)
 *   2. **OAuth quota exhaustion** — hindsight's fact-extraction `claude` calls
 *      hit the account's weekly limit (429), so retains were accepted but
 *      extracted 0 facts → nothing became recallable.
 *
 * Neither is visible over the MCP port. Both ARE visible in the container's
 * shm config and recent logs. These checks surface them so the next outage is
 * caught by `doctor`, not by a user noticing their agents went amnesiac.
 *
 * The pure classifiers below are unit-tested against real log/shm samples; the
 * docker wrapper is best-effort and silently skips when hindsight isn't a
 * local container (remote URL / no docker / inside an agent container).
 */
import { execFileSync } from "node:child_process";
import { EXPECTED_HINDSIGHT_TOOLS } from "../memory/hindsight-tools.js";

export interface CheckResult {
  name: string;
  status: "ok" | "warn" | "fail";
  detail?: string;
  fix?: string;
}

/** 1 GiB in bytes — the floor below which PostgreSQL's shared segments fail. */
export const MIN_HINDSIGHT_SHM_BYTES = 1024 * 1024 * 1024;

/** Pure: classify a container's ShmSize (bytes) into a health result. */
export function classifyShmSize(bytes: number): CheckResult {
  const mib = Math.round(bytes / 1024 / 1024);
  if (bytes < MIN_HINDSIGHT_SHM_BYTES) {
    return {
      name: "hindsight shm-size",
      status: "fail",
      detail:
        `${mib}MB — PostgreSQL needs ~533MB+ for shared segments; writes will ` +
        `fail with "No space left on device"`,
      fix:
        "Recreate hindsight with a larger shm. The launch path now sets " +
        "--shm-size=2g (#2190); pull a release that includes it and run " +
        "`switchroom memory --restart`, or recreate the container manually " +
        "preserving the `switchroom-hindsight-data` volume.",
    };
  }
  const gib = (bytes / 1024 / 1024 / 1024).toFixed(bytes % (1024 ** 3) === 0 ? 0 : 1);
  return { name: "hindsight shm-size", status: "ok", detail: `${gib}g` };
}

/**
 * Pure: classify recent hindsight logs for fact-extraction health. Catches the
 * two silent-write failure modes by their log signatures.
 */
export function classifyExtractionLogs(logs: string): CheckResult {
  const noSpace = /No space left on device|could not resize shared memory/i.test(logs);
  // What hindsight's OWN logs show when fact-extraction `claude` calls fail
  // (quota/429, auth, or model error): the provider logs an "error result" and
  // extraction yields 0 facts. The literal "429"/"weekly limit" string lives in
  // the headless-CLI result envelope, not hindsight's logs — so match the
  // provider error instead.
  const llmError = /Claude Code returned an error result|claude_code_llm[\s\S]{0,80}error|Fact extraction failed|Content extraction failed/i.test(logs);
  const quotaHint = /weekly limit|api_error_status["':\s]+429|\b429\b|hit your[\s\S]{0,24}limit/i.test(logs);
  const zeroFacts = (logs.match(/Extract facts:\s*0 facts/gi) ?? []).length;
  const okFacts = (logs.match(/Extract facts:\s*[1-9]\d* facts/gi) ?? []).length;

  if (noSpace) {
    return {
      name: "hindsight extraction",
      status: "fail",
      detail: "shared-memory exhaustion in recent logs — memory writes are failing",
      fix: "See the `hindsight shm-size` check — the container's /dev/shm is too small.",
    };
  }
  if (llmError && okFacts === 0) {
    return {
      name: "hindsight extraction",
      status: "fail",
      detail:
        "fact-extraction LLM calls are failing" +
        (quotaHint ? " (429 / weekly-limit detected)" : "") +
        " — retains are accepted but extract 0 facts, so nothing becomes recallable",
      fix:
        "Usually hindsight's `auth.consumers[hindsight].account` is quota-" +
        "exhausted or its OAuth broke. Repoint it to an account with quota in " +
        "switchroom.yaml, then `docker restart switchroom-auth-broker` and " +
        "`docker restart switchroom-hindsight` (single-file config mount needs " +
        "the broker restart to re-read). Confirm with a headless `claude` run " +
        "inside the container.",
    };
  }
  if (zeroFacts >= 3 && okFacts === 0) {
    return {
      name: "hindsight extraction",
      status: "warn",
      detail:
        `${zeroFacts} recent extractions produced 0 facts and none succeeded — ` +
        "fact extraction may be failing",
      fix: "Inspect `docker logs switchroom-hindsight` for the extraction error.",
    };
  }
  return {
    name: "hindsight extraction",
    status: "ok",
    detail: okFacts > 0
      ? `healthy (${okFacts} recent successful extractions)`
      : "no recent extraction activity to assess",
  };
}

/**
 * Best-effort: inspect the local `switchroom-hindsight` container's shm + recent
 * logs. Returns [] (silently skipped) when hindsight isn't a local container —
 * a remote `memory.config.url`, no docker, or running inside an agent container.
 */
export function checkHindsightContainerHealth(
  opts?: { exec?: (cmd: string, args: string[]) => string; containerName?: string },
): CheckResult[] {
  const name = opts?.containerName ?? "switchroom-hindsight";
  const exec =
    opts?.exec ??
    ((cmd: string, args: string[]) =>
      execFileSync(cmd, args, { stdio: ["ignore", "pipe", "ignore"], timeout: 8000 }).toString());

  const results: CheckResult[] = [];

  let shmRaw: string;
  try {
    shmRaw = exec("docker", ["inspect", name, "--format", "{{.HostConfig.ShmSize}}"]).trim();
  } catch {
    return []; // not a local container / no docker — nothing to check here
  }
  const shmBytes = parseInt(shmRaw, 10);
  if (Number.isFinite(shmBytes) && shmBytes > 0) {
    results.push(classifyShmSize(shmBytes));
  }

  try {
    const logs = exec("docker", ["logs", "--since", "10m", name]);
    results.push(classifyExtractionLogs(logs));
  } catch {
    // logs unavailable — skip the extraction check rather than fail the run
  }

  return results;
}

/**
 * An advertised hindsight tool as returned by tools/list — just the bits the
 * contract check needs.
 */
export interface AdvertisedTool {
  name: string;
  required: string[];
}

/**
 * Pure: diff the live server's advertised tools against the tools switchroom
 * actually uses (EXPECTED_HINDSIGHT_TOOLS). This is THE contract-drift detector
 * — it would have caught all 5 of the 2026-06-06..07 incidents the moment the
 * server changed (every mocked unit test stays green through an upstream
 * rename; only a live diff catches it).
 *
 * Returns one CheckResult per drift (so each surfaces as its own doctor line)
 * plus a single rollup `ok` line when the contract is clean. Two drift classes:
 *  - MISSING TOOL: switchroom calls a tool the server no longer advertises
 *    (renamed/removed) → every callsite silently no-ops (delete_memory,
 *    update_memory, query→source_query at the tool level).
 *  - REQUIRED-ARG DRIFT: the server now requires an arg switchroom doesn't
 *    track (the source_query rename, at the arg level).
 */
export function classifyToolContract(advertised: AdvertisedTool[]): CheckResult[] {
  const byName = new Map(advertised.map((t) => [t.name, t]));
  const results: CheckResult[] = [];

  for (const [tool, spec] of Object.entries(EXPECTED_HINDSIGHT_TOOLS)) {
    const real = byName.get(tool);
    if (real === undefined) {
      results.push({
        name: `hindsight contract: ${tool}`,
        status: "fail",
        detail:
          `switchroom calls \`${tool}\` but the server no longer advertises it ` +
          `(renamed/removed upstream) — every callsite silently no-ops`,
        fix:
          "Upstream hindsight changed its MCP tool contract. Update the callsite " +
          "+ EXPECTED_HINDSIGHT_TOOLS (src/memory/hindsight-tools.ts) to the new " +
          "name, refresh tests/fixtures/hindsight-tools-list.snapshot.json, or pin " +
          "the prior hindsight image.",
      });
      continue;
    }
    const missing = spec.required.filter((arg) => !real.required.includes(arg));
    const added = real.required.filter((arg) => !spec.required.includes(arg));
    if (added.length > 0) {
      results.push({
        name: `hindsight contract: ${tool}`,
        status: "fail",
        detail:
          `server now requires [${added.join(", ")}] on \`${tool}\` which ` +
          `switchroom does not track — calls may silently no-op`,
        fix:
          "Reconcile EXPECTED_HINDSIGHT_TOOLS + the callsite args with the new " +
          "server schema, then refresh the snapshot fixture.",
      });
    } else if (missing.length > 0) {
      // We think it's required but the server dropped it — informational, the
      // callsite still works (sending an unneeded arg the server may drop).
      results.push({
        name: `hindsight contract: ${tool}`,
        status: "warn",
        detail:
          `switchroom treats [${missing.join(", ")}] as required on \`${tool}\` ` +
          `but the server no longer does (loosened upstream) — harmless, but the ` +
          `fixture is stale`,
        fix: "Refresh EXPECTED_HINDSIGHT_TOOLS + the snapshot fixture.",
      });
    }
  }

  if (results.length === 0) {
    const used = Object.keys(EXPECTED_HINDSIGHT_TOOLS).length;
    results.push({
      name: "hindsight contract",
      status: "ok",
      detail: `${used} used tools present, required args satisfied (${advertised.length} advertised)`,
    });
  }
  return results;
}
