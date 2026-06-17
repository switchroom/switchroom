---
job: extend the product without forking it
outcome: The user adds a new agent, skill, or tool by configuring it, not by editing the product. The scaffolding does the boilerplate so the user writes only what's specific to their case.
stakes: If every extension needs a code change, the product calcifies. Only the original author can grow it. The fleet stops being the user's.
serves: standing-team
invariants: [no-self-escalation]
---

# Job Spec: extend the product without forking it

## The job

The user wants a new capability — a new specialist for a new domain, a new
skill that teaches an existing agent a new trick, a new tool that connects
to a system they care about. The product's job is to make that feel like
configuration, not forking. Convention over configuration is the bar: the
common 90% — lifecycle, interaction surface, memory, safety, logging,
restart behaviour — comes for free from the scaffold. What the user writes
is the thing that's actually different about their agent, skill, or tool.
If they copy a dozen files of boilerplate to add one specialist, the
product is wrong. The extension story is first-class: documented,
discoverable, and tested, so the user can read one existing agent,
understand the shape, and create a peer that fits. The product grows with
them.

## Good / bad

**Good looks like**

- Adding a new agent is a small config change, not a code change.
- The scaffold provides sensible defaults; the user overrides only what's
  actually different.
- A new skill plugs into an existing agent without editing that agent's
  core files.
- A new tool reaches exactly the agents that should have it, without
  touching unrelated ones.
- The user reads one existing agent or skill and uses it as a template,
  without studying framework internals.
- Extensions inherit the product's safety, logging, and lifecycle
  automatically; the user doesn't reimplement them.
- Upgrading the product leaves user-added agents, skills, and tools working.

**Bad looks like — never ship this**

- Boilerplate demanded up front: ten files to get one agent means the
  convention is missing.
- Extension points that require editing the core — forking with extra
  steps.
- A plugin system that's really a promise, with the interesting
  capabilities hard-coded.
- Inconsistent extension shapes, so the user has to learn three systems for
  agents, skills, and tools.
- Hidden coupling where a new agent silently needs five things configured in
  five other places.
- A new tool that quietly lands on agents it wasn't meant for — capability
  must follow the operator's config, never spread itself
  (`no-self-escalation`).
- Breaking changes to the extension shape that silently orphan user
  extensions on upgrade.

## Prove it

- **Add an agent by config, scaffold supplies the rest** —
  `tests/cli.agent-create-profile.test.ts`, `tests/scaffold.persona.test.ts`.
  *Watch:* a new specialist stands up from a small config change; defaults
  fill the 90%. *Invariant:* adding an agent is configuration, not a code
  change.
- **Skill grafts onto an existing agent** — `tests/skill.test.ts`,
  `tests/skill-validate-pretool.test.ts`. *Watch:* a skill plugs in without
  editing the agent's core files. *Invariant:* skills extend without
  forking the agent.
- **A bundled tool actually delivers in chat (live, DM)** —
  `jtbd-webkite-read-dm`. *Watch:* an agent uses a bundled MCP tool
  (webkite) to fetch a JS-rendered page and answer in chat, with no code
  change. *Invariant:* a configured extension reaches the user as a working
  capability, not just a registry entry.
- **Tool reaches only its intended agents** —
  `tests/scaffold.integration-registry.test.ts`,
  `tests/doctor.user-declared-mcps.test.ts`. *Watch:* a declared tool is
  available to the configured agents and no others. *Invariant:* capability
  follows operator config and never spreads to unrelated agents
  (`no-self-escalation`).
- **Template-by-example on-ramp** — `tests/plugin-onramp-manifest.test.ts`.
  *Watch:* the fresh-user install surface stays intact so one example is
  enough to build a peer. *Invariant:* the extension on-ramp is first-class
  and discoverable, not docs-only.
- **Upgrade survival** — `tests/reconcile.skip-profile-templates.test.ts`,
  `tests/manifest.test.ts`. *Watch:* a reconcile after upgrade keeps
  user extensions working and detects drift. *Invariant:* an upgrade never
  silently orphans a user extension.

**Fuzz corpus:** vary extension type (agent / skill / tool) × number of
existing agents × overlapping vs disjoint tool grants × upgrade across
versions; the convention holds, scope stays bounded, and extensions survive
the upgrade.

## Verdict

- **Done when:** the user adds an agent, skill, or tool by configuring it,
  the scaffold supplies the boilerplate and safety, capability reaches only
  its intended agents, and upgrades don't orphan extensions — proven by the
  scenarios above.

## Production-readiness

- *Compatibility:* the extension shape is stable across upgrades; existing
  user extensions keep working.
- *Containment:* a new tool or skill reaches only the agents the operator
  declared, never others.
