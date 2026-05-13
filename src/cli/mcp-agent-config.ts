/**
 * `switchroom mcp agent-config` — start the agent-config stdio MCP
 * server. Wired by the agent scaffold into .mcp.json so the agent's
 * Claude session can call the four read-only tools without ever
 * touching the host filesystem directly.
 */

import type { Command } from "commander";

export function registerAgentConfigMcpCommand(program: Command): void {
  const mcp = program.commands.find((c) => c.name() === "mcp")
    ?? program.command("mcp").description("MCP server entry points");
  mcp
    .command("agent-config")
    .description(
      "Run the agent-config stdio MCP server (4 read-only tools: " +
      "config_get, cron_list, skill_list, audit_tail). Identity pinned " +
      "via $SWITCHROOM_AGENT_NAME.",
    )
    .action(async () => {
      // Lazy-import so the (heavier) MCP SDK isn't pulled in for
      // unrelated CLI commands.
      const { runAgentConfigMcpServer } = await import(
        "../mcp/agent-config/server.js"
      );
      await runAgentConfigMcpServer();
    });
}
