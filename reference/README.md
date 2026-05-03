# `reference/` — the design contract

Three documents, three questions. Read in this order.

| Doc | Question it answers |
|---|---|
| [`vision.md`](vision.md) | *Should we build this?* — the four outcomes, who it's for, what it isn't |
| [`principles.md`](principles.md) | *Did we build it well?* — three PR checks (docs / defaults / consistency) |
| JTBDs (below) | *Did it do the user's job?* — outcome-focused jobs, one per file |

The verdict rule lives in `CLAUDE.md` ("Design contract" section): a
change ships only when it advances one of the four outcomes, satisfies
its JTBD, and passes all three principle checks.

## Use this directory cheaply

Each JTBD has a three-line frontmatter — `job:` / `outcome:` /
`stakes:` — that captures 80% of the doc.

```bash
# Survey every job in one read:
head -5 reference/*.md
```

Read a JTBD in full only when your change touches it. The body's
*Signs it's working*, *Anti-patterns*, and *UAT prompts* sections are
where the design teeth are — open them before designing a UX surface
that touches the job.

## JTBD index — grouped by vision outcome

### Visibility — *see every step, pinned to the chat*

- [`know-what-my-agent-is-doing.md`](know-what-my-agent-is-doing.md) — know what my agent is actually doing
- [`restart-and-know-what-im-running.md`](restart-and-know-what-im-running.md) — know what I'm running after a restart, without asking
- [`track-plan-quota-live.md`](track-plan-quota-live.md) — track my plan quota live, without a dashboard
- [`steer-or-queue-mid-flight.md`](steer-or-queue-mid-flight.md) — steer or queue while the agent is mid-flight

### Multi-agent fleet — *specialists, not one generalist*

- [`run-a-fleet-of-specialists.md`](run-a-fleet-of-specialists.md) — run a fleet of specialists, not one generalist
- [`give-each-agent-its-own-workspace.md`](give-each-agent-its-own-workspace.md) — give each agent its own working copy of the code
- [`remember-across-sessions.md`](remember-across-sessions.md) — remember across sessions without being re-told
- [`extend-without-forking.md`](extend-without-forking.md) — extend the product without forking it

### Subscription-honest — *your Pro or Max is the ceiling*

- [`keep-my-subscription-honest.md`](keep-my-subscription-honest.md) — keep my subscription the only thing I'm paying for
- [`share-auth-across-the-fleet.md`](share-auth-across-the-fleet.md) — log into Anthropic once per account, not once per agent

### Always-on — *runs while you sleep or work offline*

- [`survive-reboots-and-real-life.md`](survive-reboots-and-real-life.md) — survive reboots and real life
- [`idempotent-update-and-restart.md`](idempotent-update-and-restart.md) — update switchroom and trust everything's running the new version
- [`talk-to-agents-from-anywhere.md`](talk-to-agents-from-anywhere.md) — talk to my agents from anywhere

## Working docs (not part of the design contract)

- [`onboarding-gap-analysis.md`](onboarding-gap-analysis.md) — phased fix plan from a real onboarding session; tracks gaps as they close, not a durable JTBD.
