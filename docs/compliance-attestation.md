# Switchroom Compliance Attestation

## Summary

Switchroom is a multi-agent orchestration tool for Claude Code. This document provides a point-in-time attestation that Switchroom's architecture is designed to comply with Anthropic's terms of service and usage policies for Claude Code.

**Attestation date:** 2026-04-25T00:00:00Z (revised; supersedes 2026-04-13)
**Model used for analysis:** Claude Opus 4.7
**Reviewed against:** Anthropic's published documentation and policies as of April 25, 2026

---

## What Switchroom Is

Switchroom is scaffolding and lifecycle management for multiple Claude Code sessions. It:

1. Creates directory structures and configuration files for each agent
2. Generates systemd units to keep agents running
3. Assigns one Telegram bot per agent, each using the official Telegram plugin
4. Provides a CLI for managing agent lifecycle (start, stop, restart, logs)
5. Manages an encrypted vault for secrets
6. Includes a fleet admin bot (foreman) for fleet-wide operational visibility
7. Provides a persistent gateway process for managing the Telegram bot connection

## What Switchroom Is NOT

Switchroom does **not**:

- Intercept, proxy, or modify Claude's inference requests or responses
- Handle, proxy, or intercept Claude Code's OAuth authentication
- Replace Claude Code's runtime — each agent IS a real `claude` CLI session
- Use the Anthropic Agent SDK or direct API access
- Route subscription credentials through any intermediary
- Modify Claude Code's binary or internal behavior

---

## Compliance Analysis

### 1. Switchroom Is Not a Third-Party Harness

**Anthropic's policy:** Anthropic's Consumer Terms of Service explicitly prohibit using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any other product, tool, or service. Anthropic clarified this position publicly on February 20, 2026 (explicitly naming the Agent SDK among the prohibited uses), and formalised the consumer-terms language on April 4, 2026. In April 2026, Anthropic removed Claude Code from the Pro plan's pricing page and began restricting new Pro signups from accessing Claude Code — affecting an initial cohort of approximately 2% of new prosumer signups, with existing subscribers unaffected. This is a packaging policy signal, not a technical restriction on the supported usage patterns described in this document.

**Source:** [Legal and compliance - Claude Code Docs](https://code.claude.com/docs/en/legal-and-compliance) (OAuth prohibition); [Anthropic clarifies ban on third-party tool access to Claude — The Register, 2026-02-20](https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access/) (Agent SDK and third-party tools clarification); [Anthropic tests removing Claude Code from Pro — The Register, 2026-04-22](https://www.theregister.com/2026/04/22/anthropic_removes_claude_code_pro/) (pricing-page packaging change)

**Switchroom's compliance:** Switchroom leverages Claude Code natively — no Agent SDK, no direct API usage, no custom runtime. Each agent is an unmodified `claude` CLI process started the same way a user would start one, authenticated via Claude Code's own OAuth flow completed in the terminal. Switchroom reads the OAuth token from the agent's local `.credentials.json` solely to manage multi-account slot rotation on the same machine (writing a companion slot file, `accounts/<slot>/.oauth-token`). The token is never transmitted off-device, never forwarded to a third party, and never used by switchroom to make inference calls on the user's behalf. All inference happens between the user's Claude Code session and Anthropic's servers directly, via Claude Code's built-in client.

Switchroom's auth flow Phase 1 (`src/auth/pane-ready-probe.ts`) automates only keystroke entry into the terminal during the OAuth flow. The authentication relationship is directly between the user's Claude Code session and Anthropic.

### 2. Telegram Plugin: Switchroom Fork by Default, Official Available as Opt-Out

**Anthropic's documentation:** Claude Code supports an official plugin marketplace including a Telegram channel plugin (`--channels plugin:telegram@claude-plugins-official`), and a documented mechanism for loading unpublished MCP-based channels during development (`--dangerously-load-development-channels server:<name>`).

**Source:** [Plugins - Claude Code Docs](https://code.claude.com/docs/en/plugins); [Channels - Claude Code Docs](https://code.claude.com/docs/en/channels); [Channels Reference - Claude Code Docs](https://code.claude.com/docs/en/channels-reference)

**Switchroom's compliance:** Switchroom ships a forked Telegram plugin (`telegram-plugin/`, loaded as a Claude Code development channel) and uses it as the **default** for all agents. Operators can opt out per-agent with `channels.telegram.plugin: official` in `switchroom.yaml`, which falls back to the upstream marketplace plugin.

Both modes are compliance-equivalent:

- **Default (switchroom fork):** launches with `claude --dangerously-load-development-channels server:switchroom-telegram`. The fork is a standard MCP server using the first-party `--dangerously-load-development-channels` flag. It adds HTML formatting, smart chunking, message coalescing, status reactions, persistent SQLite history, forum-topic routing, and bot commands — all client-side message-handling concerns.
- **Opt-out (`channels.telegram.plugin: official`):** launches with `claude --channels plugin:telegram@claude-plugins-official` — the upstream marketplace plugin, unmodified.

In both modes:
- Each agent gets its own Telegram bot token in `telegram/.env`
- Agent configuration uses an `access.json` file for group/topic policy
- The plugin polls Telegram independently with the agent's own bot token
- Neither plugin modifies the `claude` binary, intercepts OAuth tokens, or routes subscription credentials anywhere other than directly between the user's Claude Code session and Anthropic

Operators who require strict use of Anthropic-published code paths should set `channels.telegram.plugin: official`. The default is the switchroom fork because it provides the production-quality streaming, formatting, and history features needed for a long-running agent fleet.

### 3. MCP Servers Are Explicitly Supported

**Anthropic's documentation:** "Claude Code supports the Model Context Protocol (MCP) for connecting to external tools and data sources."

**Source:** [Connect Claude Code to tools via MCP - Claude Code Docs](https://code.claude.com/docs/en/mcp)

**Switchroom's compliance:** The switchroom-telegram plugin is a standard MCP server using the official `@modelcontextprotocol/sdk` package (confirmed in `telegram-plugin/package.json` v1.0.0) and follows the documented MCP protocol. (The legacy `switchroom-mcp/` management server was removed under #235; its 4 tools were dormant and the functionality is now covered natively by Hindsight's MCP and Claude Code's built-in `Read`/`Grep`.)

### 4. systemd/tmux Process Management Is Standard Operations

**Anthropic's documentation:** "For an always-on setup you run Claude in a background process or persistent terminal." The Telegram channel documentation specifically notes using persistent terminals.

**Source:** [Channels - Claude Code Docs](https://code.claude.com/docs/en/channels)

**Switchroom's compliance:** Switchroom generates systemd user units that keep Claude Code sessions running. This is standard Linux process management — the same as running Claude Code in tmux, screen, or any other process supervisor. Anthropic explicitly acknowledges this use case in their channels documentation.

### 5. No Modification of Claude Code

Switchroom does not:
- Patch, modify, or replace the `claude` binary
- Inject code into Claude Code's runtime
- Override Claude Code's internal behavior
- Bypass Claude Code's permission system (unless the user explicitly opts in via `dangerous_mode` config)

Each agent runs an unmodified `claude` CLI session with standard command-line flags.

---

## New Architecture Components (Added Since April 13, 2026)

### Foreman Admin Bot (Fleet Operational Dashboard)

**What it is:** A standalone Telegram bot (`telegram-plugin/foreman/foreman.ts`) that provides fleet-wide read-only and administrative visibility (Phase 3a/3b).

**Compliance take:** The foreman bot is **out of scope for the third-party harness restriction** because:
1. It does NOT run Claude Code or route Claude inference
2. It does NOT touch authentication or subscription credentials
3. It does NOT proxy or intercept any user requests
4. It is purely an operational admin interface using Telegram's bot API

The foreman runs on its own isolated Telegram bot token, is not connected to Claude Code, and serves only to display fleet status via `switchroom agent list` and manage agent lifecycle (restart, logs, create). Users must explicitly grant access via sender allowlists in `access.json`.

### Gateway Process (Persistent Telegram Connection Manager)

**What it is:** A separate long-lived process (`telegram-plugin/gateway/gateway.ts`) that owns the Telegram bot connection, polling, and message routing for individual agents.

**Compliance take:** The gateway is **compliant** because:
1. It is a passive message router — it does NOT call Claude inference
2. It polls Telegram's API using the agent's own bot token
3. It IPC-bridges inbound Telegram messages to the Claude Code session's plugin
4. It routes outbound Claude Code responses back through Telegram
5. It never handles, stores, or forwards OAuth tokens or subscription credentials

The gateway stays alive across Claude Code session restarts (via systemd), allowing persistent Telegram connectivity without restarting the OAuth flow. This is explicitly permissible per Anthropic's documentation on persistent terminals.

### Auth Flow Phase 1 (OAuth Keystroke Automation)

**What it is:** Terminal automation (`src/auth/pane-ready-probe.ts` + `src/cli/auth.ts`) that waits for the OAuth browser login to complete, then pastes the OAuth code into the terminal.

**Compliance take:** This is **compliant** because:
1. It only automates manual keystroke entry (pasting the code shown in the browser)
2. The token is written directly by `claude setup-token` into `.credentials.json` in the agent's local Claude directory
3. Switchroom reads the token locally from `.credentials.json` solely to write the companion slot file (`accounts/<slot>/.oauth-token`) for multi-account rotation — it does not route the token through any external infrastructure
4. The token never leaves the machine

---

## Architecture Evidence

### Each agent is a real Claude Code session:
```
ExecStart=/usr/bin/script -qfc "/bin/bash -l {agentDir}/start.sh" {logFile}
```

### start.sh runs the unmodified claude CLI with one of the two channel modes:
```bash
# Default (switchroom fork):
exec claude --dangerously-load-development-channels server:switchroom-telegram

# Opt-out (channels.telegram.plugin: official):
exec claude --channels plugin:telegram@claude-plugins-official
```

In both cases the binary is the official `claude` CLI installed via `npm install -g @anthropic-ai/claude-code`. Switchroom does not patch, repackage, or shim it.

### Each agent has its own bot token:
```
# telegram/.env
TELEGRAM_BOT_TOKEN=<agent-specific-token>
```

### Message flow (per agent):
```
User → Telegram API → Telegram Plugin (switchroom fork or official) → Claude Code
Claude Code → Telegram Plugin → Telegram API → User
```

At no point does any Switchroom component sit between Claude Code and Anthropic's inference API. There is no daemon or router — each agent's plugin polls Telegram independently using the agent's own bot token. The foreman bot and gateway process do not participate in inference routing.

---

## Referenced Anthropic Documentation

| Document | URL | Accessed |
|----------|-----|----------|
| Channels | https://code.claude.com/docs/en/channels | 2026-04-25 |
| Channels Reference | https://code.claude.com/docs/en/channels-reference | 2026-04-25 |
| Legal and Compliance | https://code.claude.com/docs/en/legal-and-compliance | 2026-04-25 |
| MCP | https://code.claude.com/docs/en/mcp | 2026-04-25 |
| Plugins | https://code.claude.com/docs/en/plugins | 2026-04-25 |

## Limitations of This Attestation

- This attestation reflects Anthropic's published documentation and policies as of April 25, 2026
- Anthropic may change their terms of service, usage policies, or technical requirements at any time
- This analysis was performed by an AI model (Claude Opus 4.7) and should be reviewed by legal counsel for formal compliance verification
- Switchroom's compliance depends on users deploying it per the documented architecture (one session per agent, official claude CLI binary, no token proxying, no inference routing)

## Recommendation

Users and organizations deploying Switchroom should:
1. Review Anthropic's current terms of service before deployment
2. Monitor Anthropic's policy updates for changes affecting plugins or multi-agent usage
3. Ensure all agents run the official `claude` CLI with no patching
4. Confirm that channels are configured to either use the official Telegram plugin or the documented switchroom fork via `--dangerously-load-development-channels`
5. Consult legal counsel if compliance is critical to their use case
