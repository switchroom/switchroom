# Clerk Management MCP Server

A lightweight MCP server that exposes clerk management commands as tools, allowing Claude Code agents to manage the clerk fleet without direct Bash access.

## How it works

The server is a thin wrapper around the `clerk` CLI. Each tool invocation calls the corresponding `clerk` subcommand and returns the output. The server runs as a child process of each agent via stdio transport.

## Configuration

Set the `CLERK_CONFIG` environment variable to the path of your `clerk.yaml` file. If not set, the clerk CLI will use its default config search behavior.

## Available Tools

| Tool | Description | Input |
|------|-------------|-------|
| `clerk_agent_list` | List all agents with status (name, active, uptime, template, topic) | none |
| `clerk_agent_start` | Start an agent | `{ name: string }` |
| `clerk_agent_stop` | Stop an agent | `{ name: string }` |
| `clerk_agent_restart` | Restart an agent | `{ name: string }` |
| `clerk_auth_status` | Show auth status for all agents | none |
| `clerk_topics_list` | List topic-to-agent mappings | none |
| `clerk_memory_search` | Search memories via Hindsight | `{ query: string, agent?: string }` |
| `clerk_memory_stats` | Show per-agent collection info | none |

## Usage

The server is automatically added to each agent's `settings.json` during scaffolding. Manual setup:

```json
{
  "mcpServers": {
    "clerk": {
      "command": "bun",
      "args": ["run", "/path/to/clerk-mcp/server.ts"],
      "env": {
        "CLERK_CONFIG": "/path/to/clerk.yaml"
      }
    }
  }
}
```

## Running standalone

```bash
CLERK_CONFIG=/path/to/clerk.yaml bun run server.ts
```
