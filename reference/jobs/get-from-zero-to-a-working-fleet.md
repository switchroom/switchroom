---
job: get from zero to a working fleet in one pass
outcome: A new operator goes from a fresh box to a paired agent replying in Telegram in one setup pass, with zero config. When something is wrong it says so, with a next step, instead of reporting success on a broken state.
stakes: First contact is the whole product. If setup half-succeeds in silence, the operator's first experience is a bot that never answers and a log they don't know to tail, and they leave before the fleet ever knows them.
serves: standing-team
invariants: []
---

# Job Spec: get from zero to a working fleet in one pass

> A durable Job Spec. The *how* (the setup wizard's steps, the pairing
> handshake, the readiness gate, what `doctor` probes) churns every
> release. This spec is framed strictly around the **outcome** (one pass,
> zero config, a real reply in Telegram, loud-not-silent on failure) so it
> survives the steps changing underneath it. The first-run failure modes
> and the phased fix plan live in the design artifact
> `reference/rfcs/onboarding-gap-analysis.md`.

## The job

Someone has just heard the pitch: a standing team of specialists they text
from Telegram, on their own subscription, on their own box. They have a
fresh Linux box and a Telegram account, and they want one agent talking back
*today*. They are not signing up to learn switchroom: they want to run one
setup, answer the prompts it asks, and watch a real reply land in their
phone. The job is to carry them across that first gap, install to first
reply, in a single pass, without tribal knowledge, without tailing a log,
and without the trap that hurts most: a setup that prints "done" while the
bot is silently dead.

> We used to require a second setup pass: the operator's Telegram id was
> only knowable after they DM'd the bot `/start`, so pairing meant run
> setup, DM the bot, rerun setup. The job underneath, *one pass to a paired,
> replying agent*, is unchanged. The second pass was always a defect, not
> the job.

## Good / bad

**Good looks like**

- One pass. The operator runs setup once, answers what it asks, and ends
  with a paired agent, never "run it again to capture your id."
- Zero config to a working fleet. A default agent, a working bot, and a
  conversational first reply come out of the box; customising is opt-in
  later, never a prerequisite.
- The proof of success is a real reply in Telegram, not a green checkmark in
  the terminal. The operator sees the bot answer.
- Every prompt explains itself in place (what it needs and why) so the
  operator never has to leave the terminal to know what to type.
- When a step can't complete, it fails loud and early, naming the broken
  thing and the next command to run. A bad bot token, an unreachable
  memory backend, a failed MCP: each is spoken, not swallowed.
- "Ready" means ready to take a message: the process is up, memory is
  reachable, and the gateway is polling. Setup/restart only reports success
  when the agent can actually answer.
- There is one command to ask "is my agent alive and OK?" and one to ask
  "what's wrong and how do I fix it?". The operator never reassembles that
  answer from `ps`, `pstree`, and a log tail.

**Bad looks like: never ship this**

- A cheerful "Restarted" / "Setup complete" while an MCP failed to boot, the
  bank doesn't exist, or the gateway isn't polling. Silent success on a
  broken state is the cardinal sin of this job.

> [!CAUTION]
> Silent success on a broken state is the cardinal sin of this job. Setup and
> restart report success only when the agent can actually take a message; a
> failed component fails loud and early, naming the broken thing and the next
> command to run.
- A failure whose only signal is a line in a service log the operator
  doesn't know exists. If they have to tail a log to learn setup failed, the
  product failed.
- A second setup pass to capture the operator's Telegram id, or any
  "now go read `docs/` and come back" detour mid-onboarding.
- An error that names a code (`EAUTH_FAILED`, a raw FK constraint) and a doc
  link instead of the broken thing and the next step.
- Silent-on-read, loud-on-write: a missing bank that looks fine until the
  first memory write blows up much later, far from the cause.
- Demanding config before the first reply: making the operator fill in
  `switchroom.yaml` to get a bot that answers at all.
- A first agent that boots burning context on unfilled template placeholders
  instead of just being ready to talk.

## Prove it

Named by job × surface. The end-to-end surface is thin today, so be honest
about it.

- **DM round-trip, first reply (DM)** — `telegram-plugin/uat/scenarios/smoke-dm-reply.test.ts`,
  `telegram-plugin/uat/scenarios/greeting-reply-dm.test.ts`. *Watch:* a bare
  DM gets a real reply in the phone, fast, not a NO_REPLY or a 300s-fallback
  silence. *Invariant:* the proof of a working agent is a reply the operator
  can see, not a terminal checkmark. *(Covers the "replies in Telegram" tail
  of the job, but spins up against an already-running `test-harness`, so it
  does not exercise the zero→working setup pass itself.)*
- **Readiness gate — "ready" means can-answer** — `tests/agent.status.test.ts`
  (`readinessGaps`, `waitForAgentReady`). *Watch:* status reports `fail` when
  the process is down, the gateway isn't polling, memory is unreachable, or
  the bank is missing. Overall state is `fail`, with a distinct detail per
  cause. *Invariant:* no component reports ready unless it can actually take
  a message; loud-not-silent on a broken boot.
- **Boot self-test surfaces auth breakage loudly, never blocks boot** —
  `tests/boot-self-test.test.ts`. *Watch:* missing/expired/refresh-less
  credentials each record a named issue; boot still exits 0 so a broken auth
  state is *reported*, not hidden behind a crash-loop. *Invariant:* a
  first-run auth problem is named with a next step, never silent.
- **Memory bank exists before first write** — `tests/memory.create-bank.test.ts`,
  `tests/agent.status.probe-hindsight.test.ts`. *Watch:* a new agent's bank
  is created idempotently; a reachable-but-bankless backend reports
  `bankExists:false` rather than a false "unreachable" or a deferred
  write-time FK crash. *Invariant:* silent-on-read / loud-on-write is closed.
  A missing bank is named at setup, not at the first `retain`.
- **Bot token validated at setup, not at first message** — `tests/setup.test.ts`
  (`validateBotToken`, `buildAccessJson`), `tests/doctor.test.ts`
  (`checkTelegram`, `telegramGetMe`). *Watch:* an invalid token throws a
  named error during setup; `access.json` is built in one shape. *Invariant:*
  a bad token fails loud in the setup pass, never as a silently-ignored DM
  later.
- **Zero-config default agent comes up from a profile** —
  `tests/cli.agent-create-profile.test.ts`, `tests/scaffold.fresh-agent-mcp-trust.test.ts`.
  *Watch:* a default-profile agent scaffolds and reconciles with no
  hand-written boilerplate. *Invariant:* batteries-included, a working agent
  out of the box, customisation opt-in.
- **One-pass setup: pairing captures the operator id in-session (DM)** —
  *(coverage gap: no runnable scenario yet)*. *Watch:* the operator runs
  setup once, DMs `/start` when prompted, and the id is captured into
  `access.json` without a second pass. *Invariant:* one pass to a paired
  agent, and the historical two-pass defect never returns. The unit shape is
  pinned by `tests/setup.test.ts:buildAccessJson`, but no end-to-end scenario
  drives the live pairing handshake.
- **Fresh-box install → first reply, end to end (DM)** —
  *(coverage gap: no runnable scenario yet)*. *Watch:* from a clean box,
  `switchroom setup` produces a paired agent that answers a real DM, in one
  pass, with no manual config. *Invariant:* the headline outcome of this job.
  Today this is proven only piecewise (the unit + smoke tests above); no
  single scenario walks zero → working fleet.

**Fuzz corpus:** vary bot-token validity × memory backend
reachable/bankless/down × MCP boot success/failure × auth
present/expired/refresh-less × pairing-id-known/unknown-at-start ×
network-flaky-during-setup. The invariants must hold across the corpus: a
broken component is always *named with a next step*, and setup/restart
reports success only on a state that can actually take a message, never a
cheerful "done" over a silently-dead agent.

## Verdict

- **Done when:** a new operator on a fresh box runs setup once, with zero
  hand-written config, and watches their agent reply to a real DM in
  Telegram, and any broken step along the way fails loud with a next step,
  never reporting success on a broken state. Proven end to end by a
  fresh-box → first-reply scenario (the named coverage gap above).

## Production-readiness

> First contact is the moment the product is won or lost, so the
> loud-not-silent floor is a hard reliability bar, not a nicety.

- *Reliability:* setup and restart are idempotent and report success only on
  a ready state (process up, memory reachable, gateway polling). A failed
  component yields a non-zero exit and a named error, never a false green.
- *Observability:* every first-run failure mode is operator-visible from the
  CLI or the agent's own reply, never log-only. There is a single
  `is-it-alive` command and a single `what's-wrong` command.
- *Defaults:* a fresh setup produces a working, conversational agent with no
  required config. The "batteries included" principle check is the gate.

## Related

- [`run-a-fleet-of-specialists`](run-a-fleet-of-specialists.md) -- the fleet
  this job bootstraps from a clean box.
- [`extend-without-forking`](extend-without-forking.md) -- growing the fleet
  after first contact, config only.
- [`restart-and-know-what-im-running`](restart-and-know-what-im-running.md) --
  the same loud-not-silent readiness bar, applied to every later restart.

---

> **Implementation:** the how (the setup-wizard steps, the pairing
> handshake, the readiness gate, the boot self-test, and the per-gap fix plan)
> lives in `reference/rfcs/onboarding-gap-analysis.md` (it enumerates the real
> first-run failure modes this job exists to close). That artifact churns;
> this Job Spec outlives it.
