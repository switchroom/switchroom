---
job: extend the product without forking it
outcome: The user adds a new agent, skill, or tool by configuring it, not by editing the product. The scaffolding does the boilerplate so the user writes only what's specific to their case.
stakes: If every extension needs a code change, the product calcifies. Only the original author can grow it. The fleet stops being the user's.
---

# The job

The user wants a new capability. A new specialist for a new domain, a new
skill that teaches an existing agent to do a new thing, a new tool that
connects to a system the user cares about. The product's job is to make
that feel like configuration, not forking.

Convention over configuration is the bar. The common 90% should come for
free: lifecycle, interaction surface, memory, safety, logging, restart
behaviour, all handled by the scaffold. What the user writes is the
thing that's actually different about their agent, their skill, their
tool. If they find themselves copying a dozen files of boilerplate to
add one specialist, the product is wrong.

This also means the extension story is first-class, not an afterthought.
Documented, discoverable, and tested. A user should be able to look at
one existing agent, understand the shape, and create a peer that fits.
The product grows with them.

## Signs it's working

- Adding a new agent is a small config change, not a code change.
- The scaffolding provides sensible defaults. The user only overrides
  what's actually different.
- New skills plug into existing agents without editing those agents.
- A new tool becomes available to the agents that should have it,
  without touching unrelated agents.
- The user can read one existing agent or skill and use it as a template
  for their own, without studying the framework internals.
- Extensions inherit the product's safety, logging, and lifecycle
  behaviour automatically. The user doesn't have to reimplement it.
- Removing an extension is as clean as adding it. No residue.

## Anti-patterns: don't build this

- Boilerplate demanded up-front for every new agent. If the user has to
  write ten files to get one agent, the convention is missing.
- Extension points that require editing the core. That's forking with
  extra steps.
- A plugin system that's really just a promise, with most interesting
  capabilities hard-coded.
- Inconsistent extension shapes. If agents, skills, and tools each use
  a different pattern, the user has to learn three systems.
- Hidden coupling where a new agent silently needs five things
  configured in five other places.
- Documentation that shows the happy path but leaves the user stuck the
  moment they do something non-trivial.
- Breaking changes to the extension shape that silently orphan user
  extensions. The fleet should survive upgrades.

## UAT prompts

- **Ten-minute agent.** Stand up a new specialist in one sitting. The
  flow should feel lightweight, not like learning a framework.
- **Skill graft.** Add a new skill to an existing agent without editing
  that agent's core files.
- **Tool plug-in.** Expose a new tool to a subset of the fleet. Only
  the intended agents should get it.
- **Template-by-example.** Use an existing agent or skill as a
  reference and build a peer. It should slot in without surprises.
- **Upgrade survival.** Upgrade the product. User-added agents, skills,
  and tools should keep working.
- **Clean removal.** Delete a user extension. Nothing should be left
  behind in config, memory, or runtime.
- **Non-trivial extension.** Build something that exercises an
  intermediate capability. The documentation should cover it, not just
  the toy case.
