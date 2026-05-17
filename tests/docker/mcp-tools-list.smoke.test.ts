/**
 * MCP tools/list smoke test — PR C Step 4.
 *
 * Boots a minimal agent container with `channels.telegram.enabled: false`
 * (no bot token required at boot — PR C step 1 wired this into the
 * start.sh template), opens an MCP `StdioClientTransport` over
 * `docker exec -i <ctr> switchroom mcp agent-config`, lists all tools,
 * and runs them through {@link validateAnthropicToolSchemas} so we
 * catch oneOf/anyOf regressions BEFORE the image promotes to `:dev`.
 *
 * Gating:
 *   - `RUN_DOCKER_SMOKE=1` in the environment turns the suite on. In
 *     normal CI / dev `npm test` runs it skips so unit-test cycles stay
 *     fast and don't require Docker.
 *   - The harness runs the SDK transport spike first
 *     (`spikeStdioOverDockerExec`) — if the underlying transport is
 *     broken in the pinned SDK version, we fail-fast with the spike's
 *     verbatim message rather than time out trying to list tools.
 *
 * Lifecycle:
 *   - The harness owns the container. Image tag taken from
 *     `SMOKE_AGENT_IMAGE` (default ghcr.io/switchroom/switchroom-agent:dev).
 *   - Container is created, started, polled-until-ready, listed, then
 *     torn down in a `finally` block — even on assertion failure.
 *   - Timeout: vitest default per-test (10s) extended to 5min via
 *     `testTimeout` below.
 */

import { describe, it, expect } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { validateAnthropicToolSchemas } from "./anthropic-tool-schema-validator.js";
import { spikeStdioOverDockerExec } from "./spike-stdio-transport.js";

const RUN = process.env.RUN_DOCKER_SMOKE === "1";
const SMOKE_IMAGE =
  process.env.SMOKE_AGENT_IMAGE ?? "ghcr.io/switchroom/switchroom-agent:dev";
const CONTAINER_NAME = `switchroom-smoke-${process.pid}`;

function dockerAvailable(): boolean {
  try {
    spawnSync("docker", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!RUN || !dockerAvailable())("mcp tools/list smoke test", () => {
  it(
    "all MCP tools pass Anthropic tool-schema constraints",
    { timeout: 5 * 60 * 1000 },
    async () => {
      let started = false;
      try {
        // 1. Start a throwaway container with telegram disabled.
        execSync(
          `docker run -d --rm --name ${CONTAINER_NAME} ` +
            `-e SWITCHROOM_RUNTIME=docker ` +
            `-e SWITCHROOM_AGENT_NAME=smoke ` +
            `-e TELEGRAM_ENABLED=false ` +
            `--entrypoint sleep ${SMOKE_IMAGE} 600`,
          { stdio: "pipe" },
        );
        started = true;

        // 2. Spike the transport BEFORE relying on it for the real call.
        await spikeStdioOverDockerExec({ containerId: CONTAINER_NAME });

        // 3. Connect for real to the agent-config MCP server.
        const transport = new StdioClientTransport({
          command: "docker",
          args: ["exec", "-i", CONTAINER_NAME, "switchroom", "mcp", "agent-config"],
        });
        const client = new Client(
          { name: "switchroom-smoke", version: "0.0.1" },
          { capabilities: {} },
        );
        await client.connect(transport);

        // 4. List tools and validate every schema.
        const result = await client.listTools();
        const issues = validateAnthropicToolSchemas(result.tools);
        await client.close();
        expect(issues, issues.join("\n")).toEqual([]);
      } finally {
        if (started) {
          try {
            execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: "ignore" });
          } catch {
            // best-effort teardown
          }
        }
      }
    },
  );
});
