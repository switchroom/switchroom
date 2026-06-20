# Skills in switchroom

Switchroom agents use Claude Code's [skills system](https://code.claude.com/docs/skills). A skill is a `<name>/SKILL.md` directory whose frontmatter tells Claude when to invoke it. This page explains where switchroom looks for skills, how they get installed into agents, and what's bundled vs operator-managed.

## Authoring vs sharing (the mental model)

Two distinct things, two distinct mechanisms:

- **Authoring a skill for one agent** is Claude-native and needs no switchroom machinery: the agent just writes files into `$CLAUDE_CONFIG_DIR/skills/<slug>/` (its own writable, persistent dir — use the bundled `skill-creator` skill). A non-blocking PreToolUse linter nudges it toward a well-formed skill. There is **no** skill-authoring tool/CLI/broker — it's plain file writes. This is live for that agent on its next session.
- **Sharing a skill with other agents** is a deliberate, reviewed change, **not a runtime action**. A fleet-wide skill is effectively code every agent runs, so it goes through a pull request like any other code: land it in the reviewed skill set (the populations below), and it reaches agents via the normal reconcile/`switchroom apply` path. There is intentionally no in-agent "publish to the fleet" command — an agent can *propose* a skill by opening a PR; a human approves it.

> Historical note: an earlier design (`reference/rfcs/skill-authoring-native.md`, Phase 2a) added a runtime `skill_publish` broker path. It was removed — review-via-PR is the stronger, simpler gate for fleet-wide skills. The RFC is kept as a design record; this page is the current behaviour.

## Four skill populations

Switchroom distinguishes four populations, each living in a different place and serving a different audience:

| Population | Where they live | When they get installed | Audience |
|---|---|---|---|
| **Bundled-default skills** | `<repo>/skills/` — vendored Anthropic skills (skill-creator, mcp-builder, webapp-testing, pdf, docx, xlsx, pptx) + the slim universal switchroom trio (switchroom-cli, switchroom-status, switchroom-health) | Auto-symlinked into every agent's `.claude/skills/` on scaffold and on `switchroom apply`, regardless of role. Per-key opt-out via `defaults.bundled_skills`. See `reconcileAgentDefaultSkills` in `src/agents/reconcile-default-skills.ts` | **Every agent** |
| **Switchroom foreman-only skills** | `<repo>/skills/` — every `switchroom-*` skill *except* the universal trio (`switchroom-install`, `switchroom-manage`, `switchroom-architecture`, `switchroom-runtime`) | Auto-symlinked only when the agent has `role: foreman`. See `installSwitchroomSkills` in `src/agents/scaffold.ts` | Foreman agents (operator) |
| **Switchroom-bundled developer skills** | `<repo>/skills/` (without `switchroom-` prefix — e.g. `file-bug`, `telegram-test-harness`, `humanizer*`, `token-helpers`) | NOT auto-installed; a developer agent opts in via `defaults.skills:` or per-agent `skills:` in switchroom.yaml | Switchroom developers + power-user operators |
| **User-managed personal skills** | `~/.switchroom/skills/` (or wherever `switchroom.skills_dir` points) | Symlinked into agents that name them in `defaults.skills` or `agents.<name>.skills`. See `syncGlobalSkills` in `src/agents/scaffold.ts` | Fleet agents — calendar, garmin, doctor-appointments, etc. — anything personal to the operator |

## Bundled-default skills

These ship enabled on **every** Switchroom agent — both default `assistant` fleet agents and `role: foreman` agents — unless explicitly opted out. They cover broadly-useful capabilities the typical agent benefits from:

| Skill | Source | What it does |
|---|---|---|
| `skill-creator` | [anthropics/skills](https://github.com/anthropics/skills) (vendored) | Build new SKILL.md skills with the right frontmatter shape |
| `mcp-builder` | [anthropics/skills](https://github.com/anthropics/skills) (vendored) | Build MCP servers (Node + Python references, evaluation harness) |
| `webapp-testing` | [anthropics/skills](https://github.com/anthropics/skills) (vendored) | Drive web UIs end-to-end; pairs with the bundled Playwright MCP |
| `pdf` | [anthropics/skills](https://github.com/anthropics/skills) (vendored) | Extract, fill, and render PDFs (forms, bounding boxes, etc.) |
| `docx` | [anthropics/skills](https://github.com/anthropics/skills) (vendored) | Author and edit Word documents (tracked changes, comments, OOXML) |
| `xlsx` | [anthropics/skills](https://github.com/anthropics/skills) (vendored) | Author and edit Excel workbooks |
| `pptx` | [anthropics/skills](https://github.com/anthropics/skills) (vendored) | Author and edit PowerPoint decks |
| `switchroom-cli` | switchroom (this repo) | Run switchroom CLI operations on existing agents (logs, restart, version, config, schedule) |
| `switchroom-status` | switchroom (this repo) | Show running agents, uptime, fleet health |
| `switchroom-health` | switchroom (this repo) | "Something is broken" diagnostic flow |

The Anthropic skills are vendored under `skills/<name>/` with a `VENDORED.md` recording the upstream pin commit. Resync with the snippet at the bottom of each `VENDORED.md`.

### Opting out

Per-agent or in `defaults`:

```yaml
defaults:
  bundled_skills:
    pdf: false              # nobody on this fleet handles PDFs
    pptx: false
    skill-creator: false    # operator builds skills outside agents

agents:
  fast-bot:
    bundled_skills:
      docx: false           # this agent doesn't touch Word files
```

Per-agent values override `defaults.bundled_skills` (so an agent can re-enable a skill the operator opted out of globally).

`switchroom apply` reconciles bundled-default skills into every agent on disk — additive only, never removes existing entries, leaves operator-placed real dirs/files alone, honours opt-outs.

### Why the split

Different populations answer different questions:

- "What does *every* agent need?" → bundled-default skills (anthropic-vendored + the universal `switchroom-cli`/`status`/`health` trio, see section above)
- "What does an operator running the *whole fleet* need?" → switchroom foreman-only skills (`role: foreman` auto-installs them)
- "What does a *developer* working on switchroom need?" → bundled developer skills (opt in via `defaults.skills`, not auto-injected)
- "What does *this user's* fleet need beyond the defaults?" → user-managed personal skills

## Foreman-only switchroom skills

The fleet-management trio is role-gated — only agents with `role: "foreman"` in their config get them auto-symlinked into `.claude/skills/`. Default `assistant` role (the implicit default for fleet agents) gets none of them.

```yaml
agents:
  clerk:
    topic_name: "General"
    # role omitted → assistant → bundled-defaults only, no fleet-mgmt skills
  foreman:
    topic_name: "Fleet manager"
    role: foreman   # → bundled defaults + switchroom-install/manage/architecture
```

Reconcile honors role flips both ways: `assistant → foreman` installs the symlinks, `foreman → assistant` retracts them (only switchroom-installed symlinks; never real dirs the operator placed manually).

The foreman-only skills (the gate auto-installs every `switchroom-*`
skill **except** the universal `cli`/`status`/`health` trio — see
`universalDefaultSkills` in `src/agents/scaffold.ts`):

- `switchroom-install` — bootstrap switchroom on a fresh machine
- `switchroom-manage` — add/remove/reinstall/list agents (fleet-level)
- `switchroom-architecture` — internal design context for fleet-management decisions
- `switchroom-runtime` — conditional runtime protocols: the agent
  answering for *itself* about a crash, restart, hand-off resume, or
  mid-turn interrupt ("why did you restart?", "did you crash?", "still
  there after the restart?"). Three of its gates are side-channel
  signals (env var / sentinel file), not natural-language triggers.

A fleet agent like `clerk` doing user-facing tasks never needs to call `switchroom-install` or `switchroom-manage`, so the assistant default keeps their tool list focused. The slim `switchroom-cli` / `switchroom-status` / `switchroom-health` trio every agent benefits from is bundled-default (see the section above).

## What gets bundled vs what doesn't

Current `<repo>/skills/` inventory:

| Skill | Population | Notes |
|---|---|---|
| `skill-creator` | bundled-default (every agent) | Vendored from anthropics/skills |
| `mcp-builder` | bundled-default (every agent) | Vendored from anthropics/skills |
| `webapp-testing` | bundled-default (every agent) | Vendored from anthropics/skills; pairs with Playwright MCP |
| `pdf` | bundled-default (every agent) | Vendored from anthropics/skills |
| `docx` | bundled-default (every agent) | Vendored from anthropics/skills |
| `xlsx` | bundled-default (every agent) | Vendored from anthropics/skills |
| `pptx` | bundled-default (every agent) | Vendored from anthropics/skills |
| `switchroom-cli` | bundled-default (every agent) | Logs / restart / version / config / schedule |
| `switchroom-status` | bundled-default (every agent) | Show running agents + fleet health |
| `switchroom-health` | bundled-default (every agent) | "Something is broken" diagnostics |
| `switchroom-install` | foreman-only (auto when `role: foreman`) | First-time bootstrap on a fresh machine |
| `switchroom-manage` | foreman-only (auto when `role: foreman`) | Add/remove/reinstall/list agents (fleet-level) |
| `switchroom-architecture` | foreman-only (auto when `role: foreman`) | Internal design context for fleet-mgmt decisions |
| `switchroom-runtime` | foreman-only (auto when `role: foreman`) | Agent answering for itself about crash/restart/interrupt/hand-off |
| `humanizer` | developer (opt-in) | Strips AI-writing patterns from replies; opt in via `defaults.skills` |
| `humanizer-calibrate` | developer (opt-in) | Builds a personal voice template; companion to `humanizer` |
| `file-bug` | developer (opt-in) | Files structured bug reports via `gh issue create` |
| `telegram-test-harness` | developer (opt-in) | Guidance for writing Telegram tests against the harness |
| `token-helpers` | developer (opt-in) | Library skill — OAuth token refresh for Google Calendar / MS Graph |

That's the full `skills/` tree (19 directories: 7 vendored Anthropic +
7 `switchroom-*` + `humanizer`/`humanizer-calibrate` + `file-bug` +
`telegram-test-harness` + `token-helpers`). Verify with `ls skills/`.

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

For a switchroom-bundled foreman skill (auto-installed when `role: foreman`):

1. Create the skill directory at `<repo>/skills/switchroom-<name>/SKILL.md`
2. Document it in the table above
3. Open a PR

For a switchroom-bundled fleet-default skill (every agent regardless of role):

1. **Don't auto-install.** Add it as a developer-pool skill instead and let operators opt in via `defaults.skills`. Auto-injecting into every agent's tool list adds cognitive overhead per turn for users who'll never call it. The `role: foreman` opt-in is the right escape hatch for the operator-skill case.

## Self-improvement (agents fix their own skills)

Agents get better the longer they run: when a correction recurs, or the
same manual fix shows up twice, the agent can land a small, tested,
reversible edit to a skill **it already owns** — silently — and surface
anything bigger as a proposal. This is on by default (opt-out), built on
the skill-authoring path above. See the
[RFC](../reference/rfcs/agent-self-improvement.md) and
[job spec](../reference/jobs/get-better-the-longer-they-run.md).

How it works (slice 1):

1. **Gate (cheap, every turn).** A switchroom-owned async **Stop hook**
   (`self-improve-stop`) runs a *deterministic* triage over the
   just-finished turn — an operator correction, a repeated manual fix, or
   a standing rule that didn't bind. A turn with no signal costs ~nothing
   (no model call, no IO beyond the transcript read). The second
   occurrence trips ("correct once, never again").
2. **Forked review (only when the gate trips).** The hook injects a
   review turn into the live session (`inject_inbound`, the same
   primitive cron uses — never a new `claude -p` spawn, keeping it
   subscription-honest). The review is restricted to memory + skill
   read/write tools and runs off the reply path.
3. **Tier router.** The review classifies the change by blast radius —
   **T1** (small, reversible, single-file edit to an owned skill) lands
   automatically; **T2/T3** (medium / shared / new-cron / new-skill /
   cross-agent / irreversible) are written to a per-agent
   pending-suggestions queue and never auto-applied.
4. **Eval gate on T1.** Before a T1 edit lands, the skill's
   `evals/evals.json` runs through the skill-creator grader +
   `aggregate_benchmark.py`; the edit lands only if evals pass and don't
   regress baseline. A skill with no evals downgrades to a T2 proposal.
5. **Audit/rollback.** T1 edits go through the existing skill-write path,
   so the validator hook + git history are the audit and rollback. The
   only new state is the pending-queue file.

Defaults (tunable via env; first measured on `clerk`):

| Knob | Env | Default |
|---|---|---|
| Disable entirely | `SWITCHROOM_SELF_IMPROVE` | `1` (set `0` to opt out) |
| Repetition threshold | `SWITCHROOM_SELF_IMPROVE_THRESHOLD` | `2` |
| T1 auto-apply diff cap (lines) | `SWITCHROOM_SELF_IMPROVE_T1_MAX_LINES` | `30` |
| Max auto-applies/day | `SWITCHROOM_SELF_IMPROVE_MAX_AUTO_PER_DAY` | `3` |
| Max outstanding pending | `SWITCHROOM_SELF_IMPROVE_MAX_PENDING` | `5` |

Pending suggestions live at `<stateDir>/self-improve-pending.jsonl`
(one-tap Telegram / Linear surfacing is a later slice).

## Related code

- `src/agents/scaffold.ts:installSwitchroomSkills` — auto-install of `switchroom-*` skills
- `src/agents/scaffold.ts:syncGlobalSkills` — user-managed skill symlinking from `skills_dir`
- `src/agents/scaffold.ts:buildSettingsHooksBlock` — wires the `self-improve-stop` Stop gate
- `src/cli/self-improve-stop.ts` — the gate hook (bundled to `dist/cli/self-improve-stop.mjs`)
- `src/self-improve/` — gate, tier router, eval gate, pending queue, rate limit, review prompt
- `src/config/schema.ts` — `defaults.skills` + `agents.<name>.skills` schema
- `examples/switchroom.yaml` — example config showing both forms
