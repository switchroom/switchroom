# RFC: Agent-managed skills — fleet capability lifecycle

Status: Draft v1
Date: 2026-05-25
Companion to: `reference/vision.md` (pillars 1 & 4 — *standing team of
specialists*, *always available*), `reference/principles.md` (defaults
test, consistency test)

## 1. Summary

Today every change to the global skills pool requires the operator on
the host. Skill authoring, editing, validation, deployment, and
retirement all sit on a write-barrier the agents can't cross. This
RFC closes that gap by making **skills a first-class capability
that the fleet co-manages with the operator**, not operator-installed
software.

Three tiers of skill ownership land in this RFC:

| Tier | Lives at | Author | Approval | Blast radius |
|---|---|---|---|---|
| **Personal** | `<agentDir>/.claude/skills/personal/<name>/` | Owning agent | None (own workspace) | 1 agent |
| **Shared pool** | `~/.switchroom/skills/<name>/` (today's global) | Any agent proposes | Operator approval card | Fleet subset that opts in |
| **Bundled** | `skills/_bundled/<name>/` (ships with CLI) | Source PR only | Code review on switchroom repo | Universal opt-out |

The shipping primitive is **two new hostd verbs** (`skill_propose_publish`,
`skill_propose_edit`) mirroring the `config_propose_edit` pattern
(RFC `admin-agent-config-edit.md`), plus a writable per-agent personal-
skill dir for the lowest tier. The agent-config MCP gains a
`skill_init_personal` op so agents can bootstrap their own toolkit
without operator touch. Approval card UX, audit log, and apply path
all reuse existing machinery.

The change is **outcome-driven, not feature-driven**: the goal is
removing operator-bottleneck for skill maintenance so the fleet can
evolve its own toolkit unattended (pillar 4 — *always available*).
The proof point is when an agent says "I keep doing this manually,
should be a skill" and the next time the same task comes up, the
skill exists — without the operator having to be at a terminal in
between.

## 2. JTBDs this RFC solves

Each is currently a Ken-bottleneck. None of them are solved by the
narrow "diff a file" pattern — they need the lifecycle.

### JTBD-1 — "I keep doing X manually. Should be a skill."

Today the agent can describe the script it wishes existed, paste it
in Telegram, and hope you'll save it later. The work-product
evaporates the moment the conversation moves on.

After: the agent writes the skill in its personal workspace, tests
it, uses it itself the next time the task comes up. No operator
involvement. If it proves useful across runs, the agent can later
propose it for promotion to the shared pool.

### JTBD-2 — "This shared skill has a bug. Here's the fix."

Today the agent says "the fully-kiosk hang-watcher is missing
`screenLocked`, let me draft the fix in Telegram." Then I paste it
on the host. We did this twice tonight.

After: the agent forks the shared skill to its personal workspace,
fixes it, dry-runs against a fixture, then submits a
`skill_propose_edit` with the diff. I tap approve once. Same
end-state, zero rounds of paste-and-relay.

### JTBD-3 — "Promote my personal skill to shared."

Today: doesn't exist. A personal skill stays personal forever
because there's no path to make it shared.

After: the agent submits `skill_propose_publish` with the personal
skill's content + a one-line rationale + the agents it thinks
should opt in. I see the JTBD summary, the file list, the blast
radius, and tap approve. The skill lands in `~/.switchroom/skills/`
and the listed agents auto-opt-in.

### JTBD-4 — "Has anyone already built X?"

Today: agents reinvent. No discovery mechanism beyond the operator's
memory.

After: a `skill_search` op (read-only, no approval needed) lets any
agent enumerate the pool with metadata (JTBD summary, last edit,
authors, current opt-ins). Agents check before authoring.

### JTBD-5 — "Retire skills nothing uses anymore."

Today: skill dirs accumulate. Operator manually prunes when remembered.

After: a periodic reflection job (running on an admin agent's cron)
lists pool entries with zero opt-ins for N days; admin agent proposes
removal via `skill_propose_remove`; operator approves bulk.

### JTBD-6 — "Author a new skill end-to-end in the chat."

Today: the operator does it. Agents help draft, but the *making* is
a host-side activity.

After: agent does the full author-test-publish-roll-out flow itself,
operator only touches an approval card. The operator's job shifts
from "do skill maintenance" to "approve skill maintenance proposals."

## 3. Outcome being optimized for

Quoting `reference/vision.md` pillar 4 (*always available*) — *"there
in Telegram the second you reach for it; survives reboots, runs its
schedules."* A fleet whose toolkit can't evolve without the operator
at a terminal does not fully meet this pillar. Tonight's debug session
proved it: two consecutive skill patches each took a 9-step
choreographed pasting loop. That's not always-available — that's the
operator being on-call for skill maintenance.

Quoting pillar 1 (*standing team of specialists*) — skills are the
toolkit each specialist carries. Letting the specialists maintain
their own toolkit is the difference between handing someone a wrench
and equipping them to set up the workshop.

The principle test:

- **Docs test** — "can someone use this without opening `docs/`?"
  After this RFC, the agent itself authors via skill-creator (already
  bundled), no doc-reading by the operator required.
- **Defaults test** — "does it work on a fresh `switchroom setup`?"
  Yes — the personal-skill dir is part of scaffold, no extra config.
- **Consistency test** — same CLI shape, cascade, vault syntax,
  progress card as adjacent features? Yes — `skill_propose_*` mirrors
  `config_propose_edit` exactly; same approval-card shape; same audit
  log entries.

## 4. Current state (what works today)

Mapped from `src/agents/scaffold.ts` + `src/cli/skill-common.ts` +
`src/config/overlay-writer.ts`:

### 4.1 Two pools, fully read-only from agents

- **Bundled** (`~/.switchroom/skills/_bundled/<name>/`) populated by
  `switchroom update` mirroring `skills/_bundled/` from the CLI tree.
- **Operator pool** (`~/.switchroom/skills/<name>/`) populated by the
  operator (often via the private `~/.switchroom-config` git repo's
  `sync.sh`).

Both mount read-only into the agent. There is no agent-writable
skill location anywhere today.

### 4.2 Per-agent opt-in via symlink

`<agentDir>/.claude/skills/<name>` is a symlink into the pool,
created by `scaffold.ts:syncGlobalSkills` (`src/agents/scaffold.ts:
720-814`). Idempotent — broken symlinks are refreshed; correct ones
skipped; foreign files left alone.

### 4.3 Agents CAN opt themselves IN to bundled skills

The agent-config MCP already exposes `skill install --source
bundled:<name>` (`src/cli/agent-config-skill-write.ts:348-463`).
The agent writes an overlay file at
`~/.switchroom/agents/<name>/skills.d/<slug>.yaml` via the existing
`overlay-writer.ts` (atomic write + flock), and on next reconcile
the symlink lands.

**Important**: this means **half of the JTBDs above are already
50% solved** — agents can opt in to bundled skills today, without
operator approval, and the precedent for per-agent overlay-driven
skill management exists. What's missing is everything *upstream* of
that — actually authoring a new skill, editing pool content,
publishing personal → shared.

### 4.4 SKILL.md validator already exists

`src/cli/skill-common.ts:151-226` validates:
- Required: `name` (must match dir slug), `description` (1-1024 chars)
- File allowlist (depth-limited tree: `SKILL.md`, `README.md`,
  `scripts/*.{sh,py}`, `assets/...`, `reference/*.md`)
- Per-skill 2 MB cap, per-file 256 KB cap, max 50 files
- Duplicate-key detection via line-scan before YAML parse

The validator is **the exact gate** the RFC's `skill_propose_*` verbs
need at the hostd entry. We don't re-invent validation; we call
existing.

### 4.5 Role gating + bundled defaults are already a thing

`installSwitchroomSkills` + `reconcileAgentDefaultSkills` already
handle role-gated skills (`foreman` vs `assistant`) and bundled
defaults with per-agent opt-outs (`bundled_skills: {key: false}`).
The mental model "different agents see different skill sets" is
already realised in code.

## 5. What's missing

The four gaps the RFC closes:

### 5.1 Writable personal-skill scope per agent

No directory exists today where an agent can write a skill without
the operator-owned read-only mount blocking it. Need:
`<agentDir>/.claude/skills/personal/<name>/` mode 0700 owned by the
agent UID, claude-code discovers it alongside the symlinked pool
skills.

### 5.2 No write-to-pool primitive

No code path exists for an agent to land content under
`~/.switchroom/skills/<name>/`. The pool is operator-owned + r/o
from agents by intent. Need a host-side write primitive (hostd verb)
with an approval gate.

### 5.3 No declarative skill metadata for routing decisions

SKILL.md frontmatter has `name` + `description` only. The approval
card needs to render: declared vault keys, blast radius (which agents
opt in), author, last edit, the JTBD the skill claims to solve.

Need an additive (back-compat) frontmatter extension:

```yaml
---
name: fully-kiosk
description: ...
# new fields, optional, default-empty
jtbd: "Detect and recover from frozen Fully Kiosk display"
vault_keys: [fully-kiosk/password, fully-kiosk/bot-token]
dependencies:
  apt: [python3-cryptography]
authored_by: clerk
last_edited_at: 2026-05-25T21:16:54+10:00
tier: shared           # personal | shared | bundled
---
```

Existing validator at `skill-common.ts:151-226` already rejects
unknown frontmatter? Check — if yes, we extend the schema; if no,
the additive fields are silently ignored on the existing path
(safe).

### 5.4 No search / discovery surface

No `skill_search` MCP op exists. Need a read-only enumerator that
returns: pool entries, JTBD summary, current opt-ins per skill,
date authored, recent edits. Cheaply built on top of `readdir` +
SKILL.md frontmatter parse — no new state.

## 6. Proposed model

Same shape as `config_propose_edit` (RFC `admin-agent-config-edit.md`)
— a tightly-scoped hostd write primitive gated by the operator's
existing approval-card UI. Reuses every load-bearing component.

### 6.1 Two new hostd verbs

**`skill_propose_publish`** — agent proposes a NEW skill into the
shared pool.

```typescript
{
  op: "skill_propose_publish",
  name: string,                // becomes pool dir name; must match
                               // /^[a-z][a-z0-9-]{0,63}$/
  files: {                     // path → content, relative to skill root
    "SKILL.md": string,        // required; validator at skill-common.ts
                               // runs server-side before approval card
    [path: string]: string,    // other files per the allowlist
  },
  rationale: string,           // free-text shown on the card; 1-500 chars
  proposed_opt_ins?: string[], // optional list of agents to auto-opt-in
                               // on approve
  source_personal?: {          // optional: this is a personal-skill
    agent: string,             // promotion. lets the card render "this
    name: string,              // was personal on klanker; now shared."
  },
}
```

Approval card shape:

```
🛠 Skill publish proposal — fully-kiosk
Proposer: klanker (admin)
JTBD: Detect and recover from frozen Fully Kiosk display

3 files, 4.2 KB total:
  SKILL.md (1.1 KB)
  scripts/hang-watcher.sh (3.0 KB, +x)
  scripts/fkb.sh (0.1 KB, +x)

Declared vault keys: fully-kiosk/password, fully-kiosk/bot-token
Proposed opt-ins: clerk, finn (2 agents would auto-install)

[ View diff ]  [ Approve ]  [ Deny ]
```

**`skill_propose_edit`** — agent proposes an edit to an existing
shared skill.

```typescript
{
  op: "skill_propose_edit",
  name: string,
  diff: string,                // unified diff against current pool content
  rationale: string,
}
```

Server-side flow on both:

1. Validate name regex + path allowlist + per-file/total size caps
   via existing `skill-common.ts` validator.
2. For `edit`: dry-apply diff to a tmp copy of the pool dir; re-run
   validator on the result.
3. Render approval card with the rationale, file list, byte changes,
   declared vault-keys delta, current vs proposed opt-ins.
4. Operator taps Approve → write to pool via atomic stage-rename;
   audit-log entry tagged with proposer agent + sha256 of final tree
   + approval-card msg id.
5. Run `switchroom apply` if `proposed_opt_ins` includes any current
   agent (so symlinks get materialised).

### 6.2 New agent-config MCP op for personal-skill scope

**`skill_init_personal`** — agent creates a personal skill in its
own workspace. No approval needed — agent's own files.

```typescript
{
  op: "skill_init_personal",
  name: string,
  files: { "SKILL.md": string, [path: string]: string },
}
```

Writes to `<agentDir>/.claude/skills/personal/<name>/`. Validator
runs same as shared (so personal skills are well-formed and
promotable later without rework).

Mirror ops:
- `skill_edit_personal` — overwrite a personal skill's files
- `skill_remove_personal` — unlink the personal-skill dir
- `skill_list_personal` — enumerate own personal skills

### 6.3 Read-only discovery — `skill_search`

Exposed via agent-config MCP. No approval, no write.

```typescript
{
  op: "skill_search",
  query?: string,              // matches against name + jtbd + description
  tier?: "personal" | "shared" | "bundled" | "any",
  installed_by?: string,       // filter by current opt-in
}
```

Returns SKILL.md frontmatter + path + size + last-edit + current
opt-in count per match.

### 6.4 SKILL.md frontmatter extension (back-compat)

Adds (all optional):

```yaml
jtbd: string                   # 1-200 chars, the job-to-be-done
vault_keys: [string, ...]      # declared vault-key dependencies
dependencies:
  apt: [string, ...]           # apt packages
  skills: [string, ...]        # other skills this depends on
authored_by: string            # agent name; "operator" for hand-authored
last_edited_at: ISO-8601       # written by the hostd verb on every edit
tier: "personal" | "shared" | "bundled"   # informational
```

Existing validator extended with `passthroughUnknown: false` once
the schema lands; until then, unknown fields are silently kept (so
adopting the extension doesn't break existing skills).

### 6.5 Vault-key auto-grant on opt-in (stretch)

If a skill declares `vault_keys: [garmin/credentials]` and an agent
opts in via `skill install bundled:garmin`, the skill's declared
vault keys could be **proposed for grant** to that agent (separate
approval card, mirroring the existing vault grant flow). Keeps the
"skill is a self-contained capability" invariant — installing the
skill installs everything it needs.

Out of scope for v1 (covered by the existing
`vault_request_access` flow which agents can already trigger), but
the metadata to support it lands in this RFC.

## 7. Approval & trust model

Quoting memory `project_hostd_admin_privilege_human_approval`:
*"don't remove cross-agent/host verbs; gate them with the approval
card; autonomous only for self+read-only; grant duration scales
inverse to blast radius."*

Mapping to this RFC:

| Op | Trust | Approval | Why |
|---|---|---|---|
| `skill_init_personal` (own workspace) | autonomous | none | self-scoped, blast radius = 1 |
| `skill_edit_personal` (own workspace) | autonomous | none | same |
| `skill_remove_personal` | autonomous | none | same |
| `skill_search` | autonomous | none | read-only |
| `skill_propose_publish` | gated | Telegram approval card | new pool entry, fleet exposure |
| `skill_propose_edit` | gated | Telegram approval card | mutates pool, affects all opt-ins |
| `skill_propose_remove` | gated | Telegram approval card | mutates pool, may break opt-ins |
| (Future) auto-approve small edits from same-author admin agent | discretionary | bypass on rules | tracked in `KNOWN_AUTO_APPROVE_RULES`, off by default |

The approval card itself uses the existing
`approval-kernel` infrastructure (same shape as
`config_propose_edit`'s card). No new approval surface.

Audit log entry on every op (approved, denied, errored, or
agent-self-initiated personal write):

```json
{
  "ts": "ISO-8601",
  "verb": "skill_propose_publish",
  "agent": "klanker",
  "skill": "fully-kiosk",
  "outcome": "approved",
  "sha256_after": "...",
  "approval_msg_id": "12321"
}
```

Existing hostd audit log; just a new verb tag.

## 8. Phased rollout

Order matches blast-radius (low → high). Each phase is independently
shippable and independently useful.

### Phase 1 — Personal-skill autonomy (estimated 4-6 agent-hours)

- Scaffold writes `<agentDir>/.claude/skills/personal/` dir mode 0700
- Agent-config MCP gains `skill_init_personal` / `skill_edit_personal`
  / `skill_remove_personal` / `skill_list_personal` ops
- New tests covering happy paths + validator rejections
- No host approval involved
- **Outcome**: agents can author + use their own scripts without
  asking. Half the JTBD-1 / JTBD-2 friction gone immediately.

### Phase 2 — Shared-pool publish/edit via hostd (estimated 8-12 agent-hours)

- New hostd verbs `skill_propose_publish` / `skill_propose_edit` /
  `skill_propose_remove`
- Approval-card UI extension (multi-file diff preview; mostly reuses
  `config_propose_edit`'s renderer)
- Audit log integration
- `proposed_opt_ins` triggers a follow-on `switchroom apply` on
  approve so the listed agents materialise the symlinks
- **Outcome**: agents can ship to the shared pool. JTBD-2 and JTBD-3
  shipped.

### Phase 3 — Discovery + reflection (estimated 3-4 agent-hours)

- `skill_search` op
- Background reflection job (cron on an admin agent) listing
  pool entries by opt-in count, surfacing retirement candidates
- **Outcome**: JTBD-4 and JTBD-5 shipped.

### Phase 4 — Metadata extension (estimated 2 agent-hours)

- SKILL.md frontmatter extension (back-compat, optional fields)
- Skill-creator bundled skill updated to author the new fields
- **Outcome**: approval cards get richer; vault-key
  auto-grant becomes possible (next RFC if/when we want it).

Total: ~17-24 agent-hours. Phaseable; each phase delivers a real
outcome.

## 9. Open questions / unknowns

Caught during research; flagging for design discussion.

### 9.1 Personal-skill discovery in claude-code

Does claude-code 2.x auto-discover skills in arbitrary subdirs of
`.claude/skills/`, or does it only scan the top level? If the
latter, the `personal/` subdir convention won't work and we'd need
to either flat-mount personal skills alongside shared ones (risking
naming collisions) or wait for upstream support.

**Action**: verify before Phase 1 starts. If subdir-blocked, fall
back to a name-prefix convention (`<agentDir>/.claude/skills/
personal-<name>/`).

### 9.2 Trust model for promoted personal skills

When an agent promotes its personal skill to shared via
`skill_propose_publish`, do we count that as the agent "vouching for"
the skill? Or is every shared-pool publication a fresh operator
review regardless?

Default: fresh review. The proposer is a *signal* on the card
("klanker built this and uses it") but not a substitute for the
operator looking at the diff.

### 9.3 Skill-creator bundled skill collision

The `skill-creator` bundled skill (per research, comes from
Anthropic's `https://github.com/anthropics/skills`) already lets
agents author skills. What does it do today? Does it write
somewhere already? Coordinate to avoid two skill-authoring surfaces
that disagree.

**Action**: read `skill-creator/SKILL.md` and either: (a) align
this RFC's primitives with what skill-creator does, or (b) supersede
skill-creator with a thinner version that just wires into the
new hostd verbs.

### 9.4 Vault-key dependency declaration vs. agent-config

Today: `secrets:` on a *cron schedule entry* declares vault-key
needs (`schema.ts:79-91`). Tomorrow: `vault_keys:` in *SKILL.md
frontmatter* declares the same for the skill as a whole. Two
mechanisms saying the same thing about different scopes —
acceptable, or should the schedule-entry one fold into the skill
one (skills declare needs; schedule entries reference skills)?

Default: keep both; they have different scopes (a cron is a
specific invocation, a skill is a capability). Re-evaluate after
Phase 4 lands.

### 9.5 Bundled-skill edit path

Bundled skills (in `skills/_bundled/` shipped with the CLI) are
source-PR-authored today. Do we want any in-fleet edit path for
bundled skills, or do we explicitly keep them PR-only?

Default: keep PR-only. Bundled is the equivalent of
platform-shipped; in-fleet edits would create per-host bundled
drift which violates the consistency principle. Agents that want
to modify a bundled skill should fork it (publish a shared-pool
copy with the override).

### 9.6 Schema migration for `skills:` in switchroom.yaml

Today `agents.x.skills: [foo]` lists skill names. After this RFC,
the same field can list personal/shared/bundled by convention but
nothing in the schema captures tier. Do we need a tier-aware schema
extension or is the unprefixed name + pool-resolution-order enough?

Default: pool-resolution-order is enough. Lookup goes:
`personal/<name>` → `~/.switchroom/skills/<name>` →
`_bundled/<name>` → fail. First match wins. Documented in
`docs/skills.md` (new doc, this RFC).

## 10. Out of scope

- **Multi-host fleets**. This RFC assumes a single switchroom host.
  A future multi-host RFC would have to address pool replication.
- **Skill versioning**. We're not adding semver to skills. Content
  hash + last-edit timestamp is the audit trail; rollback is
  "submit a new edit reverting." Versioning can land later if pain
  emerges.
- **Skill marketplaces** / cross-fleet skill exchange. Out of scope.
  Each fleet manages its own pool.
- **Auto-promotion** of personal → shared based on usage signal.
  Out of scope; explicit operator approval on every share.
- **`claude -p`** anything. RFC `eliminate-claude-p.md` stays the
  hard constraint. All skill execution is in-session.

## 11. Acceptance criteria

- **AC-1**: An admin agent can author a new personal skill end-to-end
  in a Telegram chat (no operator host-touch) and use it on the next
  turn.
- **AC-2**: An admin agent can submit `skill_propose_edit` for a
  shared-pool skill; the operator's only action is one approval-card
  tap; the edit lands + reconcile picks it up automatically.
- **AC-3**: An admin agent can search the pool via `skill_search` and
  get JTBD summaries before authoring (no duplicate-skill creation).
- **AC-4**: Audit log shows every skill mutation tagged with proposer
  agent + outcome + sha256.
- **AC-5**: SKILL.md frontmatter extension is back-compat — existing
  skills without `jtbd:`/`vault_keys:` keep validating and working.
- **AC-6**: Bundled skills remain source-PR only (no in-fleet edit
  path); this verb-set never writes under `skills/_bundled/`.

## 12. References

- `reference/vision.md` pillar 1 (standing team), pillar 4
  (always available)
- `reference/principles.md` (docs / defaults / consistency)
- `docs/rfcs/admin-agent-config-edit.md` — direct shape parallel;
  this RFC reuses the approval-card + hostd-verb pattern
- `docs/rfcs/eliminate-claude-p.md` — hard constraint that no skill
  proposal can introduce a `claude -p` path
- `docs/rfcs/approval-kernel.md` — the approval surface
- `src/agents/scaffold.ts:syncGlobalSkills` (720-814) — opt-in
  symlink mechanism
- `src/cli/skill-common.ts:151-226` — SKILL.md validator (reused
  server-side)
- `src/cli/agent-config-skill-write.ts:348-463` — existing agent-
  self-service skill opt-in via overlay (precedent for personal-
  skill MCP ops)
- `src/config/overlay-writer.ts:107-212` — atomic-write + flock
  primitive (reused for personal-skill writes)
- `src/agents/reconcile-default-skills.ts:69-71`, `:104-198` —
  bundled-skill defaults + role-gated install mechanics
