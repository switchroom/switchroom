---
artefact: agent-managed skills phase 0 findings
serves: jobs/extend-without-forking.md
status: design decisions, ready to drive PR-3 implementation
---

# Phase 0 findings — agent-managed-skills (RFC #1814)

Status: design decisions, ready to drive PR-3 implementation
Date: 2026-05-25
Closes: #1818

This doc resolves the seven load-bearing unknowns surfaced by the four
parallel Opus reviewers on RFC v3. Each section gives evidence + a
binding decision. PR-3 (#1819) implementation follows the decisions
recorded here.

---

## Q1 — Claude-code subdir discovery semantics

**Decision: Personal skills live at `<agentDir>/.claude/skills/personal-<name>/SKILL.md`** (flat path, `personal-` name prefix as the namespace separator).

**Evidence**:

Claude Code v2.x's skill discovery is **depth-1** — the glob is
`<root>/<skill-name>/SKILL.md`. Nested subdirs are NOT scanned. This
was verified two ways:

- Official Anthropic docs (code.claude.com/docs/en/skills) explicitly
  document the four tiers, each at depth-1: enterprise (managed),
  personal (`~/.claude/skills/<skill-name>/SKILL.md`), project
  (`.claude/skills/<skill-name>/SKILL.md`), plugin (namespaced
  `plugin:skill-name`).

- Direct extraction from the Claude Code v2.1.150 binary at
  `~/.local/share/claude/versions/2.1.150` — string
  extract confirms the discovery glob is depth-1, hard-coded to
  `.claude/skills/` and `~/.claude/skills/`. No "personal" subdir
  keyword anywhere in the binary.

**Implication**: the originally-proposed `.claude/skills/personal/<name>/`
subdir layout (RFC v2's design) is **silently broken** — claude-code
would never discover those skills. The `personal-` name-prefix layout
works today with zero shim.

**Collision risk with Anthropic's tier model**: zero. Anthropic's
"personal" is a *root location* (`~/.claude/skills/`), not a name
prefix. Plugin namespace uses `:` separators, structurally distinct
from `-`. The `personal-` prefix is a switchroom convention; nothing
in Anthropic's current or signaled future surface conflicts.

**Migration cost if Anthropic later ships a colliding feature**: ~30
agent-minutes (rename the prefix or move under a defensive path).
Comparable to the cost of pre-building Option C up-front, with the
durable bonus of operational legibility (everything lives under
`.claude/skills/` where docs/operators expect skills to live).

---

## Q2 — Trash-dir exclusion from claude-code skill scan

**Decision: Trash dir lives at `<agentDir>/.claude/skills-trash/<name>-<unix-ts>/`** (sibling to `.claude/skills/`, NOT nested under it).

**Evidence**:

- Claude-code's depth-1 discovery glob targets `.claude/skills/`.
  Anything under `.claude/skills-trash/` is outside the discovery
  root — guaranteed not scanned.
- Putting trash inside `.claude/skills/.trash/` would *probably* work
  (the dotfile prefix + missing SKILL.md should silently skip), but
  the convention is implicit and fragile to future upstream changes.
  A sibling dir is explicit and absolute.
- Switchroom's own validator code (`skill-common.ts`) has no
  awareness of either trash location — no false-positive risk either
  way. The sibling-dir choice is purely about clarity and
  futureproofing.

**Rejected**: dotfile-nested `.claude/skills/.trash/` (implicit
exclusion, fragile) and `<agentDir>/.skill-trash/` (outside `.claude/`
namespace, less clean).

---

## Q3 — `skill-creator` bundled skill overlap

**Decision: Phase 1 ships without modifying `skill-creator`. A follow-up PR (to be filed) updates `skill-creator`'s "Switchroom agent instructions" section to delegate skill writes to the new `skill_init_personal` MCP op once PR-3 lands.**

**Evidence**:

The `skill-creator` skill (Anthropic-vendored, lives at
`skills/skill-creator/`) is an *authoring workflow* — it teaches the
agent end-to-end (draft → test → eval → improve → optimize
description → package). It runs `claude -p` as a subprocess in
three places (`scripts/improve_description.py:26,174` and
`scripts/run_eval.py:71-78`) to power its eval framework — these are
bundled-skill operator-sourced invocations, not content-delivery
calls.

The skill's *output* (the skill the agent authors using it) lands at
`$CLAUDE_CONFIG_DIR/skills/<name>/` via direct Write/Edit tool calls
inside the agent — same path PR-3 will route through
`skill_init_personal`. So the **path collides** but the **mechanism
differs**:

- skill-creator today: agent uses Claude Code's native Write/Edit
  tools to write SKILL.md + scripts directly. No validator, no
  symlink safety, no trash recovery, no `claude -p` content scan.
- PR-3 tomorrow: agent calls `skill_init_personal(name, files)` MCP
  op. Server-side validator, symlink-safe writes, trash recovery,
  `claude -p` rejection.

**Recommendation: (b) Supersede in a follow-up PR** (not Phase 1).
Once PR-3 ships, modify `skills/skill-creator/SKILL.md`'s
"Switchroom agent instructions" section to instruct agents to use
`skill_init_personal` instead of native Write. Same end-state path;
agents that ignore the new instruction still work but lose the
safety net.

**Tracked**: file a follow-up issue after PR-3 merges.

**Pre-existing pillar-3 compliance flag (separate issue)**: the
bundled `skill-creator`'s own scripts invoke `claude -p` to power
its eval framework. That's programmatic usage under Anthropic's
2026-06-15 policy. **Switchroom inherits this from upstream
Anthropic** (the skill is vendored as-is from
`https://github.com/anthropics/skills`). Worth filing upstream
with Anthropic, NOT a switchroom code issue. Memo only.

---

## Q4 — Defensive namespace vs. Anthropic's `.claude/` tree

**Decision: Personal skills live INSIDE `.claude/skills/` (using the `personal-` name prefix from Q1).** No defensive `<agentDir>/.switchroom/personal-skills/` symlinked-into-discovery layout.

**Evidence**:

Q1's research found no Anthropic-signaled "personal skills" feature
in the upstream pipeline that would collide with switchroom's
`personal-` prefix. Anthropic's tier model is location-based
(`~/.claude/skills/` vs `<project>/.claude/skills/`), not
prefix-based. The collision space is essentially empty.

Migration cost if Anthropic *does* later ship a `personal-*`-prefixed
feature: ~30 agent-minutes (rename the prefix or migrate to the
defensive layout we're declining now). Same cost as pre-building the
defensive layout, with the durable bonus of operator legibility (no
hidden `.switchroom/` content + symlink dance).

**Option held in reserve**: if a concrete collision symptom appears
post-launch, the migration to `<agentDir>/.switchroom/personal-skills/<name>/`
+ symlink-into-discovery is a known fallback. Don't pre-build it.

---

## Q5 — Path-conflict risk with existing reconcile/cleanup

**Decision: zero conflict.** PR-3's `personal-<name>` prefix is safe to ship.

**Evidence**:

Comprehensive grep across `src/` confirmed:

- `CRON_SCRIPT_BASENAME_RE` (`/^cron-[0-9a-f]{12}\.sh$/`) and
  `LEGACY_CRON_SCRIPT_BASENAME_RE` (`/^cron-(\d+)\.sh$/`) only match
  `.sh` files. A `personal-<name>/` directory doesn't match.
- `scaffold.ts`'s symlink-cleanup paths (lines 773, 811, 902, 930)
  all filter on `linkTarget.startsWith(skillsPool)` or
  `isOwnedStaleLink()`. A real-directory `personal-<name>/` (no
  symlink to the global pool) is left alone.
- `reconcileAgentDefaultSkills` (`src/agents/reconcile-default-skills.ts`)
  iterates per-agent dirs but doesn't touch arbitrary subdirs of
  `.claude/skills/`.
- The `agent-config skill install --source bundled:<name>` overlay
  path (`~/.switchroom/agents/<name>/skills.d/<slug>.yaml`) is a
  completely different filesystem location — no conflict with
  in-skills-dir personal skills.

**Greppable receipts** (every regex match assessed):

| Code site | Pattern | Risk | Verdict |
|---|---|---|---|
| `scaffold.ts:23, 2435` | `CRON_SCRIPT_BASENAME_RE` | `cron-*.sh` only | no collision |
| `scaffold.ts:773,811` | `linkTarget.startsWith(skillsPool)` | only follows symlinks INTO the pool | no collision |
| `scaffold.ts:902,930` | `isOwnedStaleLink()` | only acts on switchroom-owned symlinks | no collision |
| `reconcile-default-skills.ts:173,219` | scans per-agent dirs | doesn't recurse into skill subdirs | no collision |
| `import-openclaw-credentials.ts` | `"anthropic-personal-api-key"` | vault key string, not a skill path | false positive |

---

## Q6 — Where does the trash-dir sweep run?

**Decision: Hybrid lazy + boot-time sweep, both in the agent's MCP server (no host-side cron).**

Switchroom retired host-side cron in Phase 4 (cron-fold-in, #890-#893;
`src/agents/lifecycle.ts:841`). PR-3 will NOT introduce a new
host-side scheduling primitive. Instead:

1. **Lazy sweep on every `skill_*_personal` MCP call.** Each op
   (init, edit, remove, list, search) ends with a fast scan of the
   trash dir; entries with mtime > 24h ago are unlinked. Average op
   inspects ≤5 entries; overhead negligible.

2. **Boot-time sweep in scaffold.** When `switchroom apply` runs (or
   the agent container restarts), scaffold sweeps the trash dir
   once. This covers the dormant-agent case (no recent skill_*
   ops) and the operator-driven recovery case.

**Why not agent-scheduler-baked entry**: scheduler runs in the agent
container as a sibling process; a compromised agent could
deregister its own sweep via filesystem mutation. The hybrid above
is enforced by the MCP-op path (every op sweeps) AND scaffold (every
apply sweeps), neither of which an in-agent attacker can disable.

**Recovery window guarantee**: 24h from the `skill_remove_personal`
call until the next sweep finalises. If the agent never invokes
another MCP op AND the container never restarts in 24h, the trash
entry lives indefinitely — degraded behavior, not a security
problem (the operator just sees more disk usage). Acceptable.

---

## Q7 — Plan C: wait for upstream

**Decision: not invoked.** Q1's research found no Anthropic personal-
skills feature in the pipeline. Phase 1 proceeds.

If Plan C *were* invoked (i.e., Anthropic announced a personal-skills
feature with conflicting semantics): the fallback is to delay PR-3
by 30 days, monitor the upstream announcement for collision
symptoms, then either proceed as-is (no collision) or pivot to the
defensive `<agentDir>/.switchroom/personal-skills/<name>/` + symlink
layout. The migration cost is symmetric to pre-building; not paid
unless required.

---

## Net layout for PR-3

| Concern | Path | Rationale |
|---|---|---|
| Personal-skill content | `<agentDir>/.claude/skills/personal-<name>/SKILL.md` | Q1 — depth-1 discovery compatible |
| Personal-skill trash | `<agentDir>/.claude/skills-trash/<name>-<unix-ts>/` | Q2 — sibling dir, zero discovery risk |
| Trash sweep mechanism | Lazy-on-MCP-op + boot-time via scaffold | Q6 — no host-cron needed |
| Bundled `skill-creator` | Unmodified in Phase 1; follow-up PR delegates writes to `skill_init_personal` | Q3 — phased, not blocking |
| Defensive `.switchroom/personal-skills/` | NOT built. Held as fallback if upstream collision symptoms appear | Q4 — pre-building costs > observed risk |

## Open questions for PR-3 (out of Phase 0 scope)

- Permissions on `.claude/skills-trash/<name>-<ts>/` — mode 0700 owned
  by agent UID (same as parent `.claude/skills/`)? Confirm during
  implementation; should be the obvious default.
- Race condition on lazy sweep vs concurrent `skill_remove_personal`
  — likely handled by file-by-file unlink with `ENOENT` tolerance,
  but verify during implementation.
- Whether the scaffold boot-time sweep is part of `switchroom apply`
  or `switchroom agent restart` — both are needed for full coverage,
  but `apply` is the more frequently-invoked operator verb.

These are Phase-1-implementation-detail; they don't gate the design
decisions above.

## References

- RFC: `reference/rfcs/agent-managed-skills.md`
- v3 reviewer findings: PR #1814 review comments (4 Opus passes +
  synthesis pass)
- `src/cli/skill-common.ts:151-226` — SKILL.md validator (will be
  reused server-side in PR-3)
- `src/cli/skill.ts` — PR-1's `switchroom skill apply` CLI verb
  (#1822), the tactical bridge that ships before this Phase 0 doc
- Q3 evidence: `skills/skill-creator/scripts/{improve_description,run_eval}.py`
- Q4 evidence: claude-code v2.1.150 binary at
  `~/.local/share/claude/versions/2.1.150`,
  code.claude.com/docs/en/skills
