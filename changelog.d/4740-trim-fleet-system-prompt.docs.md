- **profiles: trim fleet-wide CLAUDE.md system-prompt blocks (#4740)**

  Condensed the vault, root-tier host access, and self-service prose in
  `profiles/_shared/*.md.hbs` and `profiles/default/CLAUDE.md.hbs`
  (Memory, Session Continuity, Root-tier host access sections). An
  admin+root agent's rendered `CLAUDE.md` drops from ~31.5k to ~20k
  characters (~36%) with no conditional or capability dropped — every
  `{{#if}}` branch (admin, root, schedule, linearAgentEnabled) still
  renders. Takes effect fleet-wide on each agent's next `switchroom apply`
  / scaffold reconcile.

  Review follow-ups, all inside the trimmed budget:

  - The self-service block again names the deferred (ToolSearch-gated)
    skill tools — `skill_search`, `skill_init_personal`,
    `skill_clone_to_personal`, `skill_edit_personal` — plus the
    fork-and-fix trigger, which no tool schema can supply because those
    schemas aren't loaded until the agent already decided to look.
  - The cron-prompt future-self framing moved from prompt text into the
    `schedule_add` `prompt` **schema description**, so the rule is
    delivered deterministically at call time instead of depending on
    prompt recall.
  - Corrected a false claim that a directive-cap overflow is silent and
    "your only warning": `switchroom doctor` warns above
    `DIRECTIVE_WARN_THRESHOLD` (24) and fails above `MAX_DIRECTIVES` (30),
    and `recall_log.directives_omitted` records it
    (`src/cli/doctor-memory.ts`).
  - Session-handoff mechanics (`.handoff.md`, `handoff-briefing.sh`,
    `session_continuity.resume_mode`) now live in the
    `switchroom-runtime` skill the trimmed template points at, so the
    pointer resolves.
  - `profiles.test.ts` now pins the load-bearing rules of the rendered
    default template — never-exfiltrate-secret-values, announce-before-
    host-mutation, the `chown --reference` overlay rule, the
    `MAX_DIRECTIVES` cap, the wake-audit sentinel, the resume branches —
    and `tests/scaffold.persona.test.ts` matches on whitespace-collapsed
    text so a template rewrap can neither red a guard nor satisfy a
    `not.toContain` leak guard vacuously. Byte ratchet lowered
    30620 → 20555.
