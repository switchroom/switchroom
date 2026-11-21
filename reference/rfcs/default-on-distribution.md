---
title: Default-on distribution
date: 2026-11-15
---

# Decision: a reviewed default-on set

## Context

Until now the rule was simple: every optional plugin stays off until the operator turns it on. `contracts/plugins.json` said so with an empty `default_enabled_plugins` list, and [principles.md](../principles.md), `AGENTS.md` and the README all repeated it.

That rule kept the public image honest, but it made the distribution a kit. An adopter got an isolated agent with none of the integrations that make it useful, and had to rediscover the configuration that the reference deployment already runs every day. [vision.md](../vision.md) already says isolation that strips the integrations is a loss.

[switchroom-positioning.md](switchroom-positioning.md) calls Switchroom "an opinionated Hermes Agent distribution". An opinion nobody gets by default is not much of one.

## Decision

The human owner decided on 2026-11-15: everything the reference deployment runs daily becomes part of the distribution, **on by default, with smart defaults and opt-out**. The goal is an optimised default Hermes configuration that makes the most of a Claude subscription's quota and tooling. Claude Subscription DirectSDK is the default model path. Claude ACP stays in the distribution so agents get Claude account connectors through the `claude-account-connectors` plugin.

This replaces the old rule. Plugins are no longer off until the operator enables them. Instead, a **reviewed default set** recorded below and in `contracts/plugins.json` may be on by default. Anything outside that set stays off.

### How defaults behave

- **Lean image, mounted plugins.** The image stays lean. Plugins stay mounted read-only, not baked. This decision changes no Dockerfile or image input.
- **A starter overlay owns the defaults.** A default starter overlay turns the default set on. The public image does not.
- **Missing credentials degrade, never block.** A default whose credential is missing turns itself off, says so in a setup check, and never stops an agent from starting. Each default declares its degrade behaviour in the contract.
- **Opt-out is one line per agent.** Turning a default off for one agent is a single line in that agent's overlay config.

### Guardrail

No default may add a model or paid path the principal did not grant. [`no-off-plan-model-call`](../invariants.md) is unchanged. Each default declares its billing in the contract as one of: `none`, `principal_plan_login` (the agent's own plan login, no API-key fallback) or `operator_supplied_key` (used only when the operator has put the key there). Model fallback chains are built only from providers the principal granted.

### The reviewed default set

| Default | Credential | When the credential is missing |
| --- | --- | --- |
| Working doctrine config: system prompt, smart approvals, queue-first chat, verify-on-stop | none | always on |
| One gateway per agent, pinned with `gateway.multiplex_profiles: false` | none | always on |
| 1Password Connect secrets per container | that agent's Connect token | falls back to an env file and reports it |
| Coding CLIs | each agent's own CLI login | that CLI is off and reported |
| Model roles with fallback chains | granted providers only | the missing provider drops out of the chain and is reported |
| Claude Subscription DirectSDK as the default model provider, no API-key fallback | the agent's own Claude Code login | off and reported |
| Claude ACP provider plus `claude-account-connectors` | the agent's own Claude login | off and reported |
| Linear | that agent's Linear authorization | off and reported |
| Kokoro voice and local transcription | local sidecar URL | text-only replies, reported |
| Honcho memory | Honcho endpoint | built-in memory, reported |
| Web search, with Perplexity when a key exists | optional operator key | default web backend, reported |
| Camoufox browser on the Bot Desktop (in-image service, official `camofox` plugin, `camoufox-desktop`), Chromium `browser_exec` as backup | per-container local key, created on first start | Chromium only, reported |
| Quota, session-reset-policy, security-guidance, disk-cleanup (report-only) | none | always on |
| Shared skill pack | none | always on |

### Opt-in, not default

Browser handoff (the sidecar Camofox with a public origin and VNC proxies), A2A between agents, and artifact publishing stay opt-in. Each one reaches outside the agent's box (a public browser origin, another agent's trust, a publication target), so it remains an explicit per-deployment decision.

Amendment 2026-11-21 (HF-773, decided by the principal): Camoufox inside the agent's own container is a default. It stays inside the box: the camofox-browser service binds loopback only, needs a per-container access key, sends no telemetry, and its window is on the agent's own Bot Desktop behind the existing Take over lease. The bare image installs it and supervises the service, which costs nothing until something browses; the camofox and camoufox-desktop plugins stay off until an overlay enables them.

### Honest status

- **Nothing is on by default yet.** Every default is `planned` until the starter overlay actually enables it. Only then may it be marked `shipped`. In this decision, nothing is `shipped`.
- **DirectSDK is experimental.** Its author, Nous Research, labels the Claude Subscription DirectSDK provider experimental. It is the default anyway, and the docs say so.
- **Connectors are read-only qualified.** `claude-account-connectors` has read-only acceptance only. Writes need separate acceptance.
- **Honcho is AGPL-3.0.** Switchroom references the upstream Honcho image by digest. It does not vendor Honcho source.
- Several defaults (quota, session-reset-policy, security-guidance, disk-cleanup, the shared skill pack, the doctrine config) are not yet published in this repository. Publishing them is part of the starter-overlay work.

## Consequences

Commits us to: a default starter overlay (Wave 1) that turns on the set above; a setup check that reports every default that turned itself off; keeping `contracts/plugins.json`, this record, the anchors and the README in agreement; contract tests that fail if a default lacks a degrade behaviour, declares an ungranted paid path, or appears outside the reviewed list.

Gives up: the simple "nothing is on" story. A default can now surprise an operator, so each default must justify itself in review and degrade cleanly.

Blind spots: DirectSDK is experimental and could change under us. Default-on Linear and memory assume an adopter wants them; opt-out is the escape hatch, and adopter demand is still unmeasured.

## Related

- [switchroom-positioning.md](switchroom-positioning.md)
- [principles.md](../principles.md)
- [invariants.md](../invariants.md)
- `contracts/plugins.json`
- Linear: [HF-696](https://linear.app/switchroom-ai/issue/HF-696/wave-0-record-the-default-on-decision-and-change-the-public-contract)
