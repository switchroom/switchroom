#!/usr/bin/env bun
/**
 * switchroom-worktree MCP Server
 *
 * Exposes three tools for parallel sub-agent code isolation via git worktrees:
 *
 *   claim_worktree  — reserve a fresh git worktree branch for a task
 *   release_worktree — tear down a worktree when done
 *   list_worktrees  — operator visibility into active claims
 *
 * Runs as a stdio MCP server. Add to an agent's settings.json mcpServers:
 *
 *   "switchroom-worktree": {
 *     "command": "bun",
 *     "args": ["<path>/switchroom-worktree-mcp/server.ts"],
 *     "env": {
 *       "SWITCHROOM_AGENT_NAME": "klanker",
 *       "SWITCHROOM_CODE_REPOS": "[{\"name\":\"switchroom\",\"source\":\"~/code/switchroom\",\"concurrency\":5}]"
 *     }
 *   }
 *
 * The code_repos list is read from SWITCHROOM_CODE_REPOS (JSON-encoded array
 * of { name, source, concurrency? } objects). When unset, any absolute path
 * can be passed to claim_worktree directly.
 *
 * Registry lives at ~/.switchroom/worktrees/ (overridable via
 * SWITCHROOM_WORKTREE_DIR). Worktree checkouts at
 * ~/.switchroom/worktree-checkouts/ (overridable via SWITCHROOM_WORKTREE_BASE).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { claimWorktree } from "../src/worktree/claim.js";
import { releaseWorktree } from "../src/worktree/release.js";
import { listWorktrees } from "../src/worktree/list.js";
import { touchHeartbeat } from "../src/worktree/registry.js";
import type { CodeRepoEntry } from "../src/worktree/types.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const AGENT_NAME = process.env.SWITCHROOM_AGENT_NAME ?? undefined;

function loadCodeRepos(): CodeRepoEntry[] | undefined {
  const raw = process.env.SWITCHROOM_CODE_REPOS;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    return parsed as CodeRepoEntry[];
  } catch {
    process.stderr.write(
      `switchroom-worktree-mcp: failed to parse SWITCHROOM_CODE_REPOS: ${raw}\n`,
    );
    return undefined;
  }
}

const CODE_REPOS = loadCodeRepos();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function textResult(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "switchroom-worktree", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// ─── Tool definitions ─────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "claim_worktree",
      description:
        "Reserve a fresh git worktree for a code task. Returns a unique id, " +
        "the worktree path, and the auto-generated branch name. " +
        "Pass the path to the sub-agent's working directory so it edits " +
        "an isolated branch. Call release_worktree when the task is done, " +
        "or let the reaper handle cleanup if you forget.",
      inputSchema: {
        type: "object" as const,
        properties: {
          repo: {
            type: "string",
            description:
              "Repo alias from code_repos (e.g. 'switchroom') or an absolute path. " +
              "Available aliases: " +
              (CODE_REPOS?.map(r => r.name).join(", ") ?? "(none configured — use absolute path)"),
          },
          taskName: {
            type: "string",
            description:
              "Human-readable suffix for the branch name (e.g. 'fix-login-bug'). " +
              "Alphanumeric, hyphens, underscores only. The actual branch will be " +
              "task/<taskName>-<shortId> to guarantee uniqueness.",
          },
        },
        required: ["repo"],
      },
    },
    {
      name: "release_worktree",
      description:
        "Release a previously claimed worktree. Runs git worktree remove and " +
        "cleans the registry record. Best-effort — if git fails, the record is " +
        "still removed. The reaper will handle any remnants.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "string",
            description: "The worktree claim ID returned by claim_worktree.",
          },
        },
        required: ["id"],
      },
    },
    {
      name: "list_worktrees",
      description:
        "List all active worktree claims. Useful for operator visibility and " +
        "debugging. Shows id, repo, branch, path, age, and heartbeat recency " +
        "for each active claim.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "heartbeat_worktree",
      description:
        "Update the heartbeat timestamp for a claimed worktree. Call every " +
        "60 seconds while actively working in the worktree to prevent the " +
        "reaper from reclaiming it. The reaper removes worktrees whose " +
        "heartbeat is more than 10 minutes stale.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "string",
            description: "The worktree claim ID returned by claim_worktree.",
          },
        },
        required: ["id"],
      },
    },
  ],
}));

// ─── Tool handlers ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "claim_worktree": {
      const { repo, taskName } = args as { repo: string; taskName?: string };
      if (typeof repo !== "string" || repo.length === 0) {
        return textResult("Error: 'repo' must be a non-empty string.");
      }
      try {
        const result = await claimWorktree(
          { repo, taskName, ownerAgent: AGENT_NAME },
          CODE_REPOS,
        );
        return jsonResult({
          id: result.id,
          path: result.path,
          branch: result.branch,
          instructions:
            `Worktree ready. Set this as the working directory for your sub-agent: ${result.path}. ` +
            `Branch: ${result.branch}. ` +
            `Call heartbeat_worktree({ id: "${result.id}" }) every 60s if the task is long-running. ` +
            `Call release_worktree({ id: "${result.id}" }) when done.`,
        });
      } catch (err) {
        return textResult(`Error: ${(err as Error).message}`);
      }
    }

    case "release_worktree": {
      const { id } = args as { id: string };
      if (typeof id !== "string" || id.length === 0) {
        return textResult("Error: 'id' must be a non-empty string.");
      }
      try {
        const result = releaseWorktree({ id });
        return jsonResult(result);
      } catch (err) {
        return textResult(`Error: ${(err as Error).message}`);
      }
    }

    case "list_worktrees": {
      try {
        const result = listWorktrees();
        return jsonResult(result);
      } catch (err) {
        return textResult(`Error: ${(err as Error).message}`);
      }
    }

    case "heartbeat_worktree": {
      const { id } = args as { id: string };
      if (typeof id !== "string" || id.length === 0) {
        return textResult("Error: 'id' must be a non-empty string.");
      }
      try {
        touchHeartbeat(id);
        return jsonResult({ id, updated: true, timestamp: new Date().toISOString() });
      } catch (err) {
        return textResult(`Error: ${(err as Error).message}`);
      }
    }

    default:
      return textResult(`Unknown tool: ${name}`);
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("switchroom-worktree-mcp: server started\n");
  if (CODE_REPOS) {
    process.stderr.write(
      `switchroom-worktree-mcp: code_repos loaded: ${CODE_REPOS.map(r => r.name).join(", ")}\n`,
    );
  }
}

main().catch((err) => {
  process.stderr.write(`switchroom-worktree-mcp: fatal error: ${err}\n`);
  process.exit(1);
});
