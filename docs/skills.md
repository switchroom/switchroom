# Skills in switchroom

Switchroom agents use Claude Code's [skills system](https://code.claude.com/docs/skills). A skill is a `<name>/SKILL.md` directory whose frontmatter tells Claude when to invoke it. This page explains where switchroom looks for skills, how they get installed into agents, and what's bundled vs operator-managed.

## Three skill populations

Switchroom distinguishes three populations, each living in a different place:

| Population | Where they live | When they get installed | Audience |
|---|---|---|---|
| **Switchroom-bundled fleet skills** | `<repo>/skills/` (with `switchroom-` name prefix) | Auto-symlinked into every agent's `.claude/skills/` on `scaffoldAgent` and `reconcileAgent` (see `installSwitchroomSkills` in `src/agents/scaffold.ts`) | Every fleet agent |
| **Switchroom-bundled developer skills** | `<repo>/skills/` (without `switchroom-` prefix — e.g. `buildkite-*`, `file-bug`, `telegram-test-harness`, `humanizer*`, `token-helpers`) | NOT auto-installed; a developer agent (e.g. one working on switchroom itself) opts in via `defaults.skills:` or per-agent `skills:` in switchroom.yaml | Switchroom developers + power-user operators |
| **User-managed personal skills** | `~/.switchroom/skills/` (or wherever `switchroom.skills_dir` points) | Symlinked into agents that name them in `defaults.skills` or `agents.<name>.skills`. See `syncGlobalSkills` in `src/agents/scaffold.ts` | Fleet agents — calendar, garmin, doctor-appointments, etc. — anything personal to the operator |

### Why the split

Different populations answer different questions:

- "What does *every* agent need?" → bundled fleet skills (the `switchroom-*` ones — only when meta-agents need them; see caveat below)
- "What does a *developer* working on switchroom need?" → bundled developer skills (read in dev contexts, not auto-injected into fleet agents)
- "What does *this user's* fleet need beyond the defaults?" → user-managed personal skills

## ⚠️ Known issue: `switchroom-*` skills auto-install into every agent

`installSwitchroomSkills()` blindly symlinks every `<repo>/skills/switchroom-*/` directory into every agent's `.claude/skills/`. The current set is:

- `switchroom-architecture` — explains how switchroom works internally
- `switchroom-cli` — runs CLI operations
- `switchroom-health` — health check + diagnostics
- `switchroom-install` — installs switchroom on a fresh machine
- `switchroom-manage` — manage the fleet
- `switchroom-status` — show running agents

These are operator/foreman skills — they make sense for an agent that *manages other agents* (e.g. a foreman bot, a developer agent) but not for a fleet agent like `clerk` doing user-facing tasks. A fleet agent never needs to call `switchroom-install` or `switchroom-manage`, so injecting them adds cognitive overhead per turn for no benefit.

**Tracking issue:** the auto-install logic should be opt-in (e.g. via `agent.role: "foreman"` or `defaults.skills_auto: ["switchroom-*"]`). Until that lands, every fleet agent carries the operator skills as dead weight.

## What gets bundled vs what doesn't

Current `<repo>/skills/` inventory:

| Skill | Population | Notes |
|---|---|---|
| `switchroom-architecture` | fleet (auto) | Operator skill — see issue above |
| `switchroom-cli` | fleet (auto) | Operator skill — see issue above |
| `switchroom-health` | fleet (auto) | Operator skill — see issue above |
| `switchroom-install` | fleet (auto) | Operator skill — see issue above |
| `switchroom-manage` | fleet (auto) | Operator skill — see issue above |
| `switchroom-status` | fleet (auto) | Operator skill — see issue above |
| `humanizer` | developer (opt-in) | Strips AI-writing patterns from replies; opt in via `defaults.skills` |
| `humanizer-calibrate` | developer (opt-in) | Builds a personal voice template; companion to `humanizer` |
| `buildkite-*` (8 skills) | developer (opt-in) | Switchroom CI work; not for fleet agents |
| `file-bug` | developer (opt-in) | Files structured bug reports; switchroom dev workflow |
| `telegram-test-harness` | developer (opt-in) | Guidance for writing Telegram tests against the harness |
| `token-helpers` | developer (opt-in) | OAuth token refresh for Google Calendar / MS Graph |

Real fleet agents (clerk, klanker, etc.) load their personal skills from `~/.switchroom/skills/` — that directory holds calendar, compass, coolify, doctor-appointments, fully-kiosk, garmin, and similar. **The repo doesn't track those** — they're operator-managed.

## Configuring skills per agent

In `switchroom.yaml`:

```yaml
defaults:
  # Skills every agent gets (unioned with per-agent `skills:`).
  # Names resolve against ~/.switchroom/skills/ (or switchroom.skills_dir).
  skills: [humanizer, humanizer-calibrate]

agents:
  clerk:
    # Per-agent additions. Unioned with defaults.skills.
    skills: [calendar, doctor-appointments]
```

Skills declared but not present in the resolved skills directory produce a warning (not a hard failure) — the rest of the scaffold continues.

## Adding a new skill

For a fleet skill (one specific user wants on their agents):

1. Create the skill directory at `~/.switchroom/skills/<name>/SKILL.md` with proper frontmatter
2. Add `<name>` to `defaults.skills` (everyone) or `agents.<name>.skills` (one agent)
3. Run `switchroom agent reconcile <agent>` to apply

For a switchroom-bundled developer skill (everyone working on switchroom benefits):

1. Create the skill directory at `<repo>/skills/<name>/SKILL.md`
2. Open a PR

For a switchroom-bundled fleet skill (auto-installed everywhere):

1. **Don't.** Use the per-user model instead — auto-install for fleet agents is a known anti-pattern (see issue above) and adding more entries to it makes the problem worse. Open an issue to discuss before adding.

## Related code

- `src/agents/scaffold.ts:installSwitchroomSkills` — auto-install of `switchroom-*` skills
- `src/agents/scaffold.ts:syncGlobalSkills` — user-managed skill symlinking from `skills_dir`
- `src/config/schema.ts` — `defaults.skills` + `agents.<name>.skills` schema
- `examples/switchroom.yaml` — example config showing both forms
