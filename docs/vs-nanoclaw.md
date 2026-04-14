# Clerk vs NanoClaw — a NanoClaw alternative for Claude Code subscribers

NanoClaw is built on the Anthropic Agents SDK and runs agents in containers. Clerk takes a different approach: use the actual `claude` CLI, authenticate with your Claude Pro/Max subscription, and manage lifecycle with systemd.

## TL;DR

- **Clerk uses the Claude Code CLI with subscription OAuth.** NanoClaw uses the Agents SDK with an API key.
- **Clerk runs on systemd.** NanoClaw runs in containers.
- **Clerk's agents are interactive Claude Code sessions** with full CLI features. NanoClaw's agents are SDK-driven loops.

## Side-by-side

| | Clerk | NanoClaw |
|---|---|---|
| Auth | Claude Pro/Max OAuth | Anthropic API key |
| Billing | Your existing subscription | Per-token API billing |
| Runtime | Official `claude` CLI | Anthropic Agents SDK |
| Isolation | systemd unit per agent | Container per agent |
| Channels | Telegram (enhanced) | WhatsApp, Telegram, Slack |
| Memory | Hindsight (semantic) | Per-container |
| Scheduling | systemd timers | Built-in scheduler |
| Sub-agents | Native Claude Code sub-agents | N/A |
| Config | YAML with cascade | ENV vars |
| License | MIT | — |

## CLI vs SDK — why it matters

The Agents SDK is a great primitive for building new agent products from scratch. But if you want to run Claude Code itself — the thing you use in your terminal and IDE — the SDK is a reconstruction, not the real thing.

Using the unmodified `claude` binary means Clerk agents behave exactly like your local Claude Code sessions:
- Same sub-agents (Plan, Explore, general-purpose).
- Same skills system.
- Same MCP support.
- Same `--continue` session semantics.
- Same hooks (PreToolUse, PostToolUse, Stop, UserPromptSubmit).
- Same keyboard-bound workflows (`/commands`, `@mentions`).

If you've already invested in Claude Code conventions — skills, CLAUDE.md files, slash commands — Clerk inherits all of them. NanoClaw agents are their own ecosystem.

## Subscription auth vs API key

Claude Pro is $20/month; Claude Max is $100/month. For an always-on fleet, that's effectively flat-rate inference. API billing via the Agents SDK scales linearly with token usage, which for interactive/long-running agents tends to cost more.

OAuth also unifies your account: the same auth your desktop app uses, the same account history, the same rate limits.

## Config cascade vs ENV vars

NanoClaw configures agents through environment variables. That's fine for one or two agents but breaks down at fleet scale — you end up copy-pasting envs, and there's no inheritance.

Clerk's `clerk.yaml` has three layers:
1. **defaults** — applied to every agent unless overridden.
2. **profiles** — named bundles (e.g., `advisor`) that agents can extend.
3. **per-agent** — the only place you write what makes each agent unique.

Change the default model once, every agent inherits it. Create an `advisor` profile that denies `Bash`/`Edit`/`Write`, and every advisor-style agent gets the same guardrails.

## When NanoClaw might be the right call

- You want the Agents SDK specifically, not Claude Code.
- You need to deploy to a managed container platform that doesn't run systemd.
- You need channels (WhatsApp, Slack) that Clerk hasn't shipped yet.

## Migrating from NanoClaw

1. Install Clerk: `git clone https://github.com/mekenthompson/clerk.git ~/code/clerk && cd ~/code/clerk && bun install && bun link`
2. `clerk setup` — OAuth login with your Claude Pro/Max account, register Telegram bot, scaffold first agent.
3. Translate each NanoClaw agent's ENV-based config into a block under `agents:` in `clerk.yaml`. See [configuration.md](configuration.md).
4. `clerk agent start <name>` for each agent.

## See also

- [Configuration reference](configuration.md)
- [Sub-agents](sub-agents.md)
- [Session management](session-optimization.md)
- [Compliance attestation](compliance-attestation.md)
