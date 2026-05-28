/**
 * Shared scaffold-wiring doctor probe — verifies that a per-agent
 * MCP integration's wiring is intact on disk, not just declared in
 * config.
 *
 * Originally lifted from `doctor-drive.ts:checkScaffoldWiring` after
 * the v0.12.x bug-8 (env-block missing) and bug-9 (scaffold-ordering
 * vs `enabledMcpjsonServers` trust) incidents. m365 + notion have
 * exactly the same drift surface — same `.mcp.json` + `.claude.json`
 * shape, same scaffold pipeline — so a single shared helper captures
 * the probe with the integration's MCP key as the only varying input.
 *
 * Inputs:
 *   - `label` — operator-facing tag in probe names ("drive", "ms-365",
 *     "notion").
 *   - `mcpKey` — the mcpServers key the resolver emits (one of
 *     `INTEGRATION_MCP_RESOLVERS[*].emitKey`).
 *   - `agents` — the set of agents the integration's
 *     `shouldEmit*` predicate would return true for. Computed by
 *     each caller via its own `compute*Agents` helper.
 *   - `agentsDir` — resolved agents directory; when undefined a
 *     single warn-status result is emitted.
 *   - `deps` — filesystem-injection seam for unit tests.
 *
 * Failure-mode classification mirrors the original drive probe:
 *   - `absent`     → no scaffold yet, warn ("run `switchroom apply`")
 *   - `unreadable` → 0600 EACCES from the host operator, skip
 *     (NOT a real failure — agent UID reads it fine)
 *   - `corrupt`    → file present but invalid JSON, fail
 *   - `ok`         → JSON parsed; check the MCP key + env block, and
 *     the .claude.json trust list
 */

import { join, resolve } from "node:path";

import type { CheckStatus } from "./doctor-status.js";

export interface ScaffoldWiringCheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

export interface ScaffoldWiringDeps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string) => string;
}

type ReadJsonResult =
  | { kind: "ok"; data: Record<string, unknown> }
  | { kind: "absent" }
  | { kind: "unreadable" }
  | { kind: "corrupt" };

function readJson(d: ScaffoldWiringDeps, path: string): ReadJsonResult {
  if (!d.existsSync(path)) return { kind: "absent" };
  let raw: string;
  try {
    raw = d.readFileSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EACCES" || code === "EPERM") return { kind: "unreadable" };
    return { kind: "absent" };
  }
  try {
    return { kind: "ok", data: JSON.parse(raw) as Record<string, unknown> };
  } catch {
    return { kind: "corrupt" };
  }
}

export function checkIntegrationScaffoldWiring(args: {
  label: string;
  mcpKey: string;
  agents: string[];
  agentsDir: string | undefined;
  deps: ScaffoldWiringDeps;
}): ScaffoldWiringCheckResult[] {
  const { label, mcpKey, agents, agentsDir, deps } = args;
  const results: ScaffoldWiringCheckResult[] = [];

  if (agents.length === 0) return results;

  if (agentsDir === undefined) {
    return [
      {
        name: `${label}: scaffold wiring`,
        status: "warn",
        detail:
          "could not resolve the agents directory (no switchroom block) — skipped scaffold wiring check",
      },
    ];
  }

  for (const name of agents) {
    const agentDir = resolve(agentsDir, name);
    if (!deps.existsSync(agentDir)) {
      results.push({
        name: `${label}: ${name} scaffold`,
        status: "warn",
        detail: `${agentDir} not scaffolded yet — run \`switchroom apply\``,
      });
      continue;
    }

    const mcpPath = join(agentDir, ".mcp.json");
    const claudeJsonPath = join(agentDir, ".claude", ".claude.json");

    const mcpRead = readJson(deps, mcpPath);
    const trustRead = readJson(deps, claudeJsonPath);

    if (mcpRead.kind === "unreadable" || trustRead.kind === "unreadable") {
      results.push({
        name: `${label}: ${name} scaffold`,
        status: "skip",
        detail:
          "scaffold files are agent-UID-owned (mode 0600) — unverifiable from the host operator; the agent process reads them fine. Verify in-container if needed: `docker exec switchroom-" +
          name +
          " sh -lc 'python3 -m json.tool /state/agent/.mcp.json >/dev/null && echo ok'`",
      });
      continue;
    }

    // .mcp.json must carry the integration's MCP server WITH a non-
    // empty env block. (Claude Code spawns MCP servers with a
    // sanitized env, so without an env block the launcher can't
    // reach switchroom.yaml / the broker — bug-8 class.)
    let mcpOk = false;
    let mcpDetail = `no .mcp.json`;
    if (mcpRead.kind === "ok") {
      const mcpServers = (mcpRead.data?.mcpServers as
        | Record<string, { env?: Record<string, unknown> }>
        | undefined) ?? {};
      const entry = mcpServers[mcpKey];
      if (!entry) {
        mcpDetail = `.mcp.json has no ${mcpKey} server`;
      } else if (!entry.env || Object.keys(entry.env).length === 0) {
        mcpDetail =
          `${mcpKey} entry has no env block — Claude spawns MCP with a sanitized env; the launcher can't reach switchroom.yaml/the broker (bug-8 class)`;
      } else {
        mcpOk = true;
      }
    } else if (mcpRead.kind === "corrupt") {
      mcpDetail = ".mcp.json exists but is not valid JSON (corrupt)";
    }

    // .claude.json must TRUST the integration's MCP key under the
    // agent's project key (bug-9 / scaffold-ordering class).
    let trustOk = false;
    let trustDetail = "no .claude/.claude.json";
    if (trustRead.kind === "ok") {
      const projects = (trustRead.data?.projects as
        | Record<string, { enabledMcpjsonServers?: unknown }>
        | undefined) ?? {};
      const proj = projects[resolve(agentDir)];
      const enabled: unknown = proj?.enabledMcpjsonServers;
      if (Array.isArray(enabled) && enabled.includes(mcpKey)) {
        trustOk = true;
      } else {
        trustDetail =
          `${mcpKey} not in projects[].enabledMcpjsonServers — Claude silently ignores the un-allowlisted server (bug-9 / scaffold-ordering class)`;
      }
    } else if (trustRead.kind === "corrupt") {
      trustDetail = ".claude.json exists but is not valid JSON (corrupt)";
    }

    if (mcpOk && trustOk) {
      results.push({
        name: `${label}: ${name} scaffold`,
        status: "ok",
        detail: `${mcpKey} wired in .mcp.json (with env) and trusted in .claude.json`,
      });
    } else {
      results.push({
        name: `${label}: ${name} scaffold`,
        status: "fail",
        detail: !mcpOk ? mcpDetail : trustDetail,
        fix: "`switchroom agent restart " + name + "` (reconcile regenerates .mcp.json + re-trusts); if it persists, this is a scaffold bug — report it",
      });
    }
  }
  return results;
}
