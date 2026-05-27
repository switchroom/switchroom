# Fix batch: update jtbd-idempotent-update-and-restart to name `switchroom update`

**Scope:** `reference/idempotent-update-and-restart.md` only.
**Verdict pattern:** drift-major (3), drift-minor (3).
**Estimated edits:** medium (~25 lines across multiple sections).

## Findings in this batch

### Finding 1 -- jtbd-idempotent-update-and-restart:c1

- **File:** `reference/idempotent-update-and-restart.md` L3 (frontmatter `outcome:` field)
- **Quote:** "After the upgrade flow finishes (`switchroom apply` + `docker compose pull` + `docker compose up -d --remove-orphans`), the entire stack -- CLI, agent containers, broker, kernel, scheduler, MCP servers, memory backend -- is at the version switchroom declared and tested as a unit."
- **Verdict:** drift-major
- **Proposed action:** update-text
- **Proposed text:** "After running `switchroom update`, the entire stack -- CLI, agent containers, broker, kernel, scheduler, hostd, MCP servers, bundled skills, memory backend -- is at the version switchroom declared and tested as a unit. After any restart, the agent comes back with fresh code, fresh MCP servers, fresh settings, and intact context. The user does not lose their thread."
- **Evidence:** `src/cli/update.ts` L1-L36 -- `switchroom update` wraps pull-images, apply-config, refresh-hostd, sync-bundled-skills, recreate-containers, and doctor (PR #918). hostd and skills pool are missing from the current stack list.
- **Rationale:** The frontmatter outcome is the first thing readers see. It still names the three-command pre-#918 incantation.

### Finding 2 -- jtbd-idempotent-update-and-restart:c2

- **File:** `reference/idempotent-update-and-restart.md` L9-L11
- **Quote:** "The user runs the upgrade flow (`switchroom apply` + `docker compose pull` + `docker compose up -d --remove-orphans`)."
- **Verdict:** drift-major
- **Proposed action:** update-text
- **Proposed text:** Rewrite the opening paragraph to name `switchroom update` as the primary flow. The individual steps (apply, pull, up -d) are what it orchestrates internally and can be mentioned as the underlying mechanics.
- **Evidence:** `src/cli/update.ts` L882-L944; CLAUDE.md L749-L760 -- `switchroom update` is the canonical single-step upgrade command.
- **Rationale:** The body's opening section defines the upgrade flow for the user. It still names the replaced pattern.

### Finding 3 -- jtbd-idempotent-update-and-restart:c5

- **File:** `reference/idempotent-update-and-restart.md` L39-L42
- **Quote:** "A user can re-run `switchroom apply` + `docker compose up -d` and `switchroom agent restart` any number of times, in any order, and end up in the same valid state every time."
- **Verdict:** drift-minor
- **Proposed action:** update-text
- **Proposed text:** Acknowledge `switchroom update` as the idempotent form. Note that `switchroom apply` + `docker compose up -d` remain valid sub-flows for operators who want finer control.
- **Evidence:** `src/cli/update.ts` L448-L465 -- `up -d` is described as "cheap and idempotent"; `src/cli/apply.ts` L627-L640 -- apply is idempotent.
- **Rationale:** Minor surface drift -- the idempotency claim is correct but the named surface is stale.

### Finding 4 -- jtbd-idempotent-update-and-restart:c9

- **File:** `reference/idempotent-update-and-restart.md` L88-L90 ("What the user needs from the surface" section)
- **Quote:** "A small, fixed set of commands (`switchroom apply`, `docker compose pull`, `docker compose up -d --remove-orphans`) that do the right thing for the whole stack."
- **Verdict:** drift-major
- **Proposed action:** update-text
- **Proposed text:** "A single command (`switchroom update`) that does the right thing for the whole stack -- pull new images, refresh scaffolds, recreate containers, and run a post-bounce doctor sweep. Operators who want finer control can still run `switchroom apply`, `docker compose pull`, and `docker compose up -d --remove-orphans` individually."
- **Evidence:** `src/cli/update.ts` L882-L888 -- command description: "Update switchroom on this host: pull images, refresh scaffolds, recreate containers."
- **Rationale:** This is the surface-definition sentence that defines the user need. Naming the old three-command pattern as the answer to that need is the most prominent piece of stale copy in the JTBD.

### Finding 5 -- jtbd-idempotent-update-and-restart:c13

- **File:** `reference/idempotent-update-and-restart.md` L113-L117
- **Quote:** "Pull fetches the matched set of GHCR images at the new release tag; the rolling `up -d` replaces each agent + scheduler + broker container in turn."
- **Verdict:** drift-minor
- **Proposed action:** update-text
- **Proposed text:** Note that `up -d --remove-orphans` recreates services whose image or config changed (not strictly serial), and that the scheduler is now an in-container sibling process rather than a separate container.
- **Evidence:** `src/cli/update.ts` L229-L243; `src/agents/compose.ts` L1-L10 -- scheduler was retired as a separate container in Phase 4.
- **Rationale:** "Agent + scheduler + broker container" misstates the container topology. Scheduler is in-container since Phase 4.

### Finding 6 -- jtbd-idempotent-update-and-restart:c15

- **File:** `reference/idempotent-update-and-restart.md` L145-L149
- **Quote:** "`switchroom doctor` detects the host's claude is far behind the version baked into the running agent image, flags the drift as informational, and offers a one-liner to upgrade the host CLI."
- **Verdict:** drift-minor
- **Proposed action:** update-text
- **Proposed text:** "`switchroom doctor` detects that the host's claude version differs from the version declared in the current switchroom manifest, flags the drift, and tells the user to run `switchroom update` to realign."
- **Evidence:** `src/manifest.ts` L162-L172 -- `probeClaudeVersion()` probes host PATH and compares against `dependencies.json`, not the running container image; `src/cli/doctor.ts` L2391-L2416 -- fix message is "Update <component> to match the manifest, or re-run switchroom update", not a one-liner for the host CLI.
- **Rationale:** Two inaccuracies: doctor compares against the manifest, not the container image; and the fix message points at `switchroom update`, not a dedicated CLI upgrade command.

## Out of scope for this batch

- Edits to `reference/principles.md:c8` (same three-command example) -- in `principles-stale-examples` batch.
- Adding Anti-patterns and UAT prompts sections to this file (structural conformance with other 13 JTBDs) -- this is new content, not a drift fix, and needs a separate product decision.
