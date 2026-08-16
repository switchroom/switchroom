- **profiles: trim fleet-wide CLAUDE.md system-prompt blocks (#4740)**

  Condensed the vault, root-tier host access, and self-service prose in
  `profiles/_shared/*.md.hbs` and `profiles/default/CLAUDE.md.hbs`
  (Memory, Session Continuity, Root-tier host access sections). An
  admin+root agent's rendered `CLAUDE.md` drops from ~31.5k to ~19.8k
  characters (~37%) with no conditional or capability dropped — every
  `{{#if}}` branch (admin, root, schedule, linearAgentEnabled) still
  renders. Takes effect fleet-wide on each agent's next `switchroom apply`
  / scaffold reconcile.
