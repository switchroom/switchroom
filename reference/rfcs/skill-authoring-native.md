---
artifact: native-by-default skill authoring
serves: extend-without-forking
advances-outcome: standing-team
status: Implemented (Phase 1 + 3); Phase 2a superseded
---

# RFC: Native-by-default skill authoring

> **SUPERSEDED IN PART (post-implementation).** Phase 1 (native
> agent-scope authoring + the non-blocking validator hook) and Phase 3
> (deleting the deprecated create/edit/read/delete shim) shipped and
> stand. **Phase 2a's runtime `skill_publish`/`skill_unpublish` path
> was removed.** Fleet-wide sharing is a reviewed pull request
> (bundled-default opt-out / `skills:` cascade), not a runtime broker
> write, because PR review is the stronger and simpler gate for code
> every agent runs. The `--adopt` idea (§3.5/§7) was dropped for the
> same reason. Current behaviour: `docs/skills.md`. This RFC is kept
> as the design record of how we got here.

Status: Implemented (Phase 1 + 3); Phase 2a/`--adopt` superseded by
review-via-PR, see banner above
Author: Ken (via Claude pair-design)
Date: 2026-05-18
Relates: #1490 (PR A), #1491 (PR B), #1492/#1494 (the `--version`
collision that motivated this), #1163 (skill install/remove,
orthogonal, see §3.4)

> **v2 changelog (independent review + code-validation pass):**
> §2.2 persistence citation corrected to the same-path mount and
> *why* it (not the `/state/*` mount) is load-bearing; §3.3 stops
> claiming cron-deny is "kept": it is **inert in production today**
> and is now an explicit non-goal with a stated accepted residual;
> §3.5 promotes `skill_publish` marker-write atomicity into a stated
> contract with the crash-after-copy self-lockout named; §3.3/§3.5
> correct the `--adopt` reconcile-trigger claim (the cron reconcile
> bridge excludes skills; `--adopt` only edits the cascade layer and
> rides the *existing* reconcile path); §4 Phase-1 deprecation text
> now points explicitly at the native path; §7 Q3 → resolved as
> decision D1 (routes through approval-kernel).

## 1. Summary

Make **agent-scope** skill authoring 100% Claude-native: an agent
creates and edits its own skills with the bundled `skill-creator`
skill and ordinary `Write`/`Edit` into
`$CLAUDE_CONFIG_DIR/skills/<slug>/`, a directory that is already
persistent, reconcile-safe, and auto-discovered. Delete the
agent-scope `skill_create/edit/read/delete` MCP tools, their
`switchroom skill create|edit|read|delete` CLI verbs, the
JSON-over-stdout shim (`spawnSyncWithStdin`), and the
optimistic-concurrency version-token machinery.

Keep the privileged broker **only** where it is irreducible, the
**global / cross-agent** writes the agent UID physically cannot make.
Collapse that surface from four verbs to **one**: `skill_publish`
(plus `skill_unpublish`). An admin agent authors and tests a skill
natively in agent scope, then promotes a known-good copy with one
explicit, audited, admin-gated action.

Fleet pick-up is unchanged: the `skills:` config cascade +
reconcile-managed symlinks. `skill_publish --adopt <layer>` folds the
"declare it, then reconcile" two-step into the publish call so the
operator/admin does one thing, not three.

## 2. Motivation

### 2.1 The shim is a structural fragility, not a one-off bug

#1492: `switchroom skill edit --version <token>` collided with the
root program's commander `.version()` flag. Commander's version
printer intercepted `--version`, printed `0.11.1` to stdout, exited
0. The edit never ran, nothing landed on disk, and the MCP server's
`JSON.parse("0.11.1")` threw "Unable to parse JSON string". `skill_read`
/`skill_create` (no `--version` flag) worked, and #1491's only E2E
covered `create`, so CI stayed green over the gap.

That bug class **only exists because there is a CLI + JSON-over-stdout
shim in front of what is, for agent scope, a plain file write into the
agent's own writable directory.** Argv parsing, stdout discipline,
JSON round-tripping, version tokens, `--scope` plumbing: every one of
those is surface area that does not exist in the native model.

> **Note — #1492 is already patched in-band.** #1494 renamed the
> colliding CLI flag `--version` → `--expect-version` (the
> agent-facing MCP `version` arg unchanged) and added an E2E
> regression. That is the *tactical* stop-gap so the surface works
> until Phase 3 deletes it; this RFC is the *structural* fix. The two
> don't conflict. Phase 3 removes the flag (and the whole shim)
> entirely, retiring the patched code along with the bug class.

### 2.2 Agent scope needs none of it

Verified wiring (file:line):

- **Persistent.** The load-bearing mount is the **same-path** bind
  `~/.switchroom/agents/<name>:~/.switchroom/agents/<name>`
  (`src/agents/compose.ts:1661`), *not* the `:/state/agent` mount at
  `:1658`. This matters: `start.sh.hbs:173` sets
  `CLAUDE_CONFIG_DIR={{agentDir}}/.claude` where `{{agentDir}}` is the
  *host* path `~/.switchroom/agents/<name>` (`scaffold.ts` resolves it
  from the agents state dir), so the path Claude actually writes to is
  the host path, made identical inside the container by the same-path
  mount. Writes survive `switchroom agent restart` / compose recreate.
- **Reconcile-safe.** `syncGlobalSkills` only ever removes symlinks it
  owns (targets inside the skills pool); a real, agent-authored
  directory is explicitly left untouched
  (`src/agents/scaffold.ts:793-795`, `:831-834`).
- **Auto-discovered.** Claude scans `$CLAUDE_CONFIG_DIR/skills/`;
  `CLAUDE_CONFIG_DIR=<agentDir>/.claude`
  (`profiles/_base/start.sh.hbs:173`), exactly where agent-scope
  skills resolve (`src/cli/skill-common.ts:189`, the
  `join(base, ".claude", "skills")`).
- **Writable.** It is the agent's own scaffold dir, owned by the
  per-agent container UID.

So for agent scope the four-tool shim adds **no capability**, only
audit/caps/concurrency/identity-pin *policy*, none of which require a
CLI for the agent's own persistent, reconcile-safe directory. Audit
and caps are better expressed as a non-blocking validator hook on the
native write path (§3.3).

### 2.3 The bundled authoring path has no blessed destination

`skills/skill-creator/SKILL.md` is already a bundled default
(`src/agents/reconcile-default-skills.ts`), but it is destination-
agnostic: it talks about producing a skill *directory* / `.skill`
package and even warns "direct writes may fail due to permissions,
stage in `/tmp/` first" (SKILL.md:461). Nothing tells the agent that
`$CLAUDE_CONFIG_DIR/skills/<slug>/` is the canonical, writable,
live-next-turn home. Closing *that* gap, a few lines of skill-creator
guidance plus a documented path, is the actual work for agent scope.
Not four MCP tools.

### 2.4 It fails the product principles (see §6)

The shim is a *different interaction model* from how Claude-native
skills work and from how every other switchroom extension works
(`skills:` config + reconcile). That is precisely the
"inconsistent extension shapes" anti-pattern in
`reference/jobs/extend-without-forking.md` and a Principle 3 ("one mind
built this") failure. Per the design contract, that is a redesign,
not a follow-up.

## 3. Design

### 3.1 Current (as-is)

Both scopes funnel through the same machinery:

```
agent ─> agent-config MCP ─> switchroom skill CLI ─> (broker) ─> disk
         skill_create        JSON over stdout
         skill_edit          --version optimistic-concurrency tokens
         skill_read          --scope agent|global
         skill_delete        spawnSyncWithStdin, identity-pin, caps, audit
```

| | Agent scope | Global scope |
|---|---|---|
| Store | `~/.switchroom/agents/<a>/.claude/skills/<s>/` | `~/.switchroom/skills/<s>/` (`:ro` to agents, `/skills-rw` to admins) |
| Author | 4 MCP tools + version tokens + JSON shim | same 4 tools, `scope:"global"` |
| Privilege | **none needed** (own writable dir) | **broker required** (UID can't write the `:ro` mount) |
| Pick-up | native (`$CLAUDE_CONFIG_DIR/skills/`) | `skills:` cascade → reconcile symlink → next turn |

### 3.2 Target (to-be)

**Agent scope — pure native, zero switchroom surface:**

```
agent ─> skill-creator (native) ─> Write/Edit ─> <agentDir>/.claude/skills/<s>/
                                                  persistent · reconcile-safe · discovered next turn
```

**Global scope — native authoring + ONE privileged verb:**

```
admin agent ─> skill-creator (native, AGENT scope) ─> iterate/test ─┐
                                                                     │ one explicit action
                                                                     ▼
                                       skill_publish <slug> [--adopt <layer>]
                                       (admin-gated · authorship-marker · audited · atomic)
                                                                     │
                                                                     ▼
                                       broker copies the known-good dir into
                                       ~/.switchroom/skills/<slug>/ ; refreshes
                                       .authored-by-<agent> ; (if --adopt) edits
                                       the skills: layer + triggers reconcile
```

`skill_publish` is the **only** broker-backed write. It is a
deliberate, atomic *replace-by-publish* of a complete skill directory
with no per-file edits, no version tokens, no `--from-stdin`. The agent
already iterated in its own scope; publish promotes the result.

### 3.3 Delete / keep / new

| | Item | Disposition |
|---|---|---|
| **Delete** | `skill_create/edit/read/delete` MCP tools (agent scope) | removed |
| | `switchroom skill create\|edit\|read\|delete` CLI verbs | removed |
| | `spawnSyncWithStdin`, `--from-stdin`, JSON-over-stdout author shim | removed |
| | `--version`/`--expect-version` tokens, `E_SKILL_VERSION_STALE`, version-token code | removed (the entire #1492 bug class) |
| | `--scope agent` plumbing | removed (agent scope is native) |
| | `agent-config-skill-author.test.ts`, `…author.global.test.ts`, author paths in `server.author.test.ts` | removed/rewritten for publish |
| **Keep** | The broker, reached by **one** verb (`skill_publish`/`unpublish`) | kept, narrowed |
| | Authorship marker (`authorshipMarkerName`/`hasAuthorshipMarker`, `.authored-by-<agent>`, `E_SKILL_OPERATOR_OWNED`) | kept — still the operator-curated immutability guard |
| | Validators (`validateSkillName/RelPath/SkillMd`, `safeWriteFile`, size/file caps) | kept, refactored into a shared lib used by the validator hook + `skill_publish` (no longer a CLI entrypoint) |
| | Identity-pin | kept, enforced **only on `skill_publish`** (the sole privileged path) — an agent writing into its own UID-owned dir natively cannot impersonate a peer, so the pin is only meaningful for the cross-boundary write |
| | Cron-deny | **dropped as a non-goal — see §3.5.** It is *inert in production today*: `isCronTurn()` reads `SWITCHROOM_TURN_SOURCE` (`src/cli/skill-common.ts:208`) which **has no production setter** (only `*.test.ts` set it; the doc-comment claim that "the gateway sets it per turn" is unimplemented). The RFC will not claim to preserve a control that does not function. |
| | `skills:` union cascade (`src/config/merge.ts:551`), `syncGlobalSkills`, `reconcileDefaultSkills`, `_bundled` pool | kept, unchanged — the consistent extension shape |
| **New** | `skill_publish` / `skill_unpublish` MCP tools + `switchroom skill publish\|unpublish` CLI (broker path only) | new |
| | `skill_publish --adopt <defaults\|profile:X\|agent:Y>` — also edits the named `skills:` cascade layer | new (collapses *declare* into the publish call; **materialisation still rides the existing reconcile path**, not a new in-broker reconcile — see §3.5) |
| | Non-blocking **validator hook** (`PreToolUse` on Write/Edit under `$CLAUDE_CONFIG_DIR/skills/`) — lints frontmatter/size/path, **warns, does not block** | new |
| | `skill-creator/SKILL.md` addendum: canonical destination is `$CLAUDE_CONFIG_DIR/skills/<slug>/`, live next turn | new (few lines) |

### 3.4 Explicitly out of scope

`skill_install` / `skill_remove` (#1163 Phase 2) are **orthogonal**:
they adopt/drop a *pool* skill into an agent's declared `skills:`
list, a config edit materialised by reconcile, not authoring. They
stay as-is. (They are a candidate for a later "this is just a
`skills:` cascade edit" simplification, but not in this RFC.)

### 3.5 Publish contract & accepted residuals

**`skill_publish` atomicity (stated requirement, not an open
question).** Publish MUST be ordered: (1) copy the agent's
already-iterated skill dir into a temp dir under the pool root,
(2) `fsync` the copied files, (3) write `.authored-by-<agent>`
*inside the temp dir*, (4) `fsync` the marker and the temp dir,
(5) atomic-rename the temp dir into `~/.switchroom/skills/<slug>/`.
The marker is stamped **before** the rename so the published dir is
never observable without its marker; the step-(4) fsync (marker +
temp-dir dirent) before the rename is the Phase-2 implementation
detail that makes "stamped before observable" durable across a crash. Rationale, the failure mode this
prevents: if publish copied the dir but crashed before stamping the
marker, the next `skill_publish`/`skill_unpublish` would see an
unmarked dir, classify it operator-owned (`E_SKILL_OPERATOR_OWNED`),
and the authoring admin agent could no longer manage *its own* just-
published skill (a self-inflicted lockout). `skill_unpublish` is the
symmetric atomic remove and MUST refuse when the
`.authored-by-<agent>` marker is absent (same guard the deleted
`skill_delete scope:global` enforced).

**`--adopt` materialisation rides the existing reconcile path — by
design.** Validation found the cron reconcile bridge
(`src/cli/reconcile-bridge.ts`) is *cron-only*; skill changes are not
in its change set, and agent containers have no docker socket. So
`--adopt` deliberately does **not** synthesise a new in-broker skill-
reconcile. It only edits the named `skills:` cascade layer (the same
declarative edit `skill_install` makes to its overlay). Symlink
materialisation happens on the **next ordinary reconcile**
(`switchroom apply` / a hostd-mediated `agent restart`), exactly the
declare-then-reconcile gate this RFC already defends as the
opt-in safety boundary (§5, alternative 3). This is *more* consistent
(Principle 3), not a limitation: `--adopt` removes the "remember to
also edit `skills:`" step; it does not and should not bypass
reconcile. `skill_unpublish --adopt <layer>` MUST remove the matching
`skills:` entry it added, otherwise the next reconcile emits a
permanent "skill not found in pool" config lint
(`scaffold.ts:825-828`).

**Accepted residual — agent-scope authoring has no turn-source
guard.** With cron-deny inert (§3.3) and the validator hook
non-blocking (§7 Q1), a natively authored agent-scope skill is
subject to no hard gate regardless of turn source. This is a
**deliberate accepted residual**, documented here in the same spirit
as switchroom's other stated residuals (e.g. the `strict`-off CI
posture in `CLAUDE.md`): the blast radius is the **authoring agent's
own UID-owned, per-agent directory**. It cannot reach a peer or the
global pool without the privileged, admin-gated, marker-guarded
`skill_publish`. A prompt-injected turn could rewrite that agent's own
skills, which is strictly bounded by the agent's existing trust
domain. If a real turn-source guard is later wanted, wiring a
production `SWITCHROOM_TURN_SOURCE` (or a hook-readable cron signal)
is a *separate* prerequisite deliverable. This RFC does not
pretend the current code provides it.

## 4. Migration / phasing

Three PRs, each through the standard reviewer → auto-merge flow.

- **Phase 1 — native agent scope (low risk, immediate UX win).**
  Document the canonical writable destination in
  `skill-creator/SKILL.md` (and that the skill is live on the *next*
  turn, not mid-turn, see §7 Q3); replace its actively-wrong "direct
  writes may fail due to permissions, stage in `/tmp/` first"
  guidance (`SKILL.md:460-461`), which is false for the agent-scope
  case. Add the non-blocking validator hook. Mark the four
  agent-scope tools **deprecated**, and the deprecation string in
  each MCP tool description MUST point explicitly at the native path
  (*"deprecated: author into `$CLAUDE_CONFIG_DIR/skills/<slug>/`
  directly with Write/Edit; this tool is removed in Phase 3"*) so the
  still-live tools and the new skill-creator guidance do not give
  conflicting instructions during the Phase 1→3 overlap. Note the
  overlap hazard: the legacy `skill_create` path errors
  `E_SKILL_ALREADY_EXISTS` (exit 13) on a slug a native write already
  created. The deprecation text must say "if this errors, the skill
  already exists; just edit the files directly." No deletions yet.
  Ships the entire agent-scope benefit with zero capability loss.
- **Phase 2 — collapse global.** Ship `skill_publish`/`skill_unpublish`
  + `--adopt`. Migrate global authoring off `create/edit/delete`.
  Remove `--scope` from the deprecated tools (agent-only now).
- **Phase 3 — delete.** Remove the four author tools, their CLI verbs,
  `spawnSyncWithStdin`, the version-token code, the now-dead tests;
  refactor validators into the shared lib; update `docs/skills.md` and
  the CLI reference.

Rollback: Phase 1 is additive (revert = drop the hook + doc lines).
Phases 2–3 revert by restoring the deleted files from git; no on-disk
data migration (skills are plain dirs, unchanged in place).

## 5. Alternatives considered

1. **Keep four tools, just fix bugs as they appear.** Rejected: the
   fragility is structural (argv/stdout/JSON/version surface), and it
   permanently fails Principle 3. #1492 is the second flag-class bug
   in this surface in a week.
2. **Thin local validator CLI for agent-scope writes (no broker, no
   JSON).** Rejected: still a non-native interaction model the agent
   must learn and drive. The `PreToolUse` hook delivers the same
   validation with zero new surface (native Claude users already
   live with hooks).
3. **Auto-propagate a published global skill to the whole fleet
   (skip the `skills:` declare step).** Rejected: breaks the
   opt-in safety gate (a confused/compromised admin agent could push
   a skill every agent loads at boot) and the cascade-consistency
   story. The declare+reconcile gate is deliberate;
   `--adopt` makes it ergonomic without removing it.
4. **Per-file `skill_publish` with version tokens (port the old
   model).** Rejected: reintroduces the exact concurrency/argv surface
   we are deleting. Replace-by-publish of a whole, already-iterated
   directory is simpler and matches "the agent tested it in its own
   scope first".

## 6. Design-contract checks

**JTBD — `reference/jobs/extend-without-forking.md`:** "New skills plug
into existing agents without editing those agents… Consistent
extension shapes." Target collapses skill authoring onto the same
shape as every other extension (native files + `skills:` cascade +
reconcile). Removes the inconsistent-extension-shape anti-pattern.

**Principle 1 — "if they need the docs, we've failed":** Today an
agent must know a four-tool MCP protocol with opaque version tokens to
author a skill. Target: it uses the bundled `skill-creator` skill the
way any Claude user does; the validator hook's message tells it what
to fix. ✅ after redesign.

**Principle 2 — "batteries included, assembly optional":**
`skill-creator` is already a bundled default; the only missing battery
is a blessed writable destination, which Phase 1 supplies. Global
publish is one verb with a sane default (`--adopt` optional). ✅

**Principle 3 — "one mind built this":** Removes a bespoke
interaction model; global pick-up rides the existing `skills:` cascade
+ reconcile (same mental model as profiles, tools, memory). One
privileged verb shaped like `switchroom <noun> <verb>`. ✅

Verdict per the contract's rule: advances the **multi-agent fleet**
and **subscription-honest / no custom runtime** outcomes, satisfies
the extend-without-forking JTBD, and passes all three principle checks
*after* the redesign, which is exactly why it is a redesign and not a
patch.

## 7. Decisions & open questions

**Decided (were "open" in v1; resolved after review):**

- **D1 — `--adopt profile:X` / `--adopt agent:Y` route through the
  approval-kernel.** Not "tentative." Editing another agent's or a
  profile's `skills:` layer is a cross-agent-blast-radius write;
  consistency with the documented "admin privilege kept, gated by
  human approval for cross-agent blast radius" posture (hostd/kernel)
  requires it. `--adopt defaults:` is fleet-wide and likewise gated.
  An admin agent adopting into *its own* `skills:` is self-scope and
  needs only the existing admin gate. This is a Phase-2 design
  constraint, not a discovery.
- **D2 — `skill_publish` marker-write atomicity** is a stated contract
  (§3.5), not an open question: copy → fsync → stamp marker →
  atomic-rename; crash-after-copy self-lockout named.
- **D3 — `skill_unpublish --adopt <layer>`** must remove the matching
  `skills:` entry it added (§3.5), else a permanent post-reconcile
  config lint.

**Genuinely open (non-blocking for Phase 1):**

1. **Validator hook: warn vs. block?** Lean **warn**. Native Claude
   doesn't block skill writes, and Principle 3's "let the model
   communicate" sub-principle argues against a hard gate. Hard-cap
   only the one thing with real blast radius (total skill bytes), as a
   hook-level reject with a clear message. *Note the interaction:*
   with cron-deny inert (§3.3) and the hook non-blocking, agent-scope
   authoring has no hard turn-source gate. That is the deliberate
   accepted residual stated in §3.5, not an oversight.
2. **`skill_publish` dry-run/diff.** Probably yes, mirror
   `switchroom update --check`: `skill_publish --check` prints what
   would change in the pool (new/overwrite, marker state) without
   writing. Consistency with the existing `--check` idiom.
3. **Discovery latency.** A natively authored skill is live on the
   *next* turn (Claude scans at session boot), not mid-turn. Same is
   true today via the CLI. Acceptable, but the skill-creator addendum
   MUST say so explicitly (folded into the Phase 1 deliverable, §4)
   so the agent doesn't report success then act confused when it
   can't invoke the skill in the same turn.

## 8. Verdict / next steps

Recommend proceeding with **Phase 1 now** (native agent scope: doc +
hook + deprecation flag): it is low-risk, additive, reversible, and
delivers the whole agent-scope UX win immediately. Phases 2–3 follow
as separate PRs once the `skill_publish` contract in §3.5 and open
questions 2–3 are nailed down.
