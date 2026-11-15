# Shared skill pack

Working-method skills that every agent in a Switchroom deployment can load. They describe
*how* agents work (review, tracking, tooling, background coding jobs), not *what* any one
deployment does. They contain no credentials, identities or topology.

| Skill | Use when |
|---|---|
| [`coding-independent-review-merge`](coding-independent-review-merge/SKILL.md) | An agent opens, reviews or merges a pull request. The author never merges. |
| [`linear-work-tracking`](linear-work-tracking/SKILL.md) | An agent records meaningful outcomes in Linear while native Hermes tasks own execution. |
| [`persistent-agent-tools`](persistent-agent-tools/SKILL.md) | A tool must survive image updates, or someone asks where a dependency should live. |
| [`fleet-coding-clis`](fleet-coding-clis/SKILL.md) | An agent launches or tracks a background coding CLI such as Codex, Claude Code or Grok Build. |

## Status

This pack is the `shared-skill-pack` entry in [`contracts/plugins.json`](../contracts/plugins.json).
It is **not on by default** in the bare image. The starter overlay in
[`examples/overlay-repo/`](../examples/overlay-repo/) configures it: it
mounts this directory read-only from a checkout pinned to the image's own revision
(`vendor.lock.json`) and lists it in `skills.external_dirs`. The contract entry stays `planned`
until a real container boot proves it, and only then moves to `shipped`. Without the starter
overlay, mount it by hand as below.

## Mounting

The pack is mounted **read-only** into each agent container and listed in Hermes'
`skills.external_dirs`. Agents can load these skills but cannot edit them. A local profile
skill with the same name takes precedence, so a deployment can override one skill without
forking the pack.

In an overlay `compose.yaml` (paths are examples):

```yaml
services:
  ops:
    volumes:
      - ./vendor/hermes-fleet/skills:/opt/skill-packs/shared:ro
```

In the managed Hermes config for that agent:

```yaml
skills:
  external_dirs:
    - /opt/skill-packs/shared
```

Pin the pack the same way you pin the image: check out an exact commit of this repository in
the overlay (for example as a submodule, or a release archive with a recorded hash), not a
moving branch.

## Writing rules for this pack

- Generic guidance only. No household, business or personal names, emails, chat or user IDs,
  hostnames, IP addresses, vault references, tracker workspace URLs, real team or issue keys,
  or real profile names. Use obviously synthetic examples.
- Each skill is a directory with a `SKILL.md` whose frontmatter has `name` (matching the
  directory) and a short `description` starting with `Use when`.
- `tests/test_public_skill_pack.py` enforces membership, frontmatter and the identity
  patterns. Adding a skill means updating that test's expected list in the same change.
