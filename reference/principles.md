---
title: Switchroom product principles
status: the second anchor — the three checks every PR, review, and release must pass
audience: anyone designing, building, reviewing, or releasing switchroom
---

# Switchroom product principles

These aren't aspirations. They're product engineering standards, applied
in **every PR, every design review, every release**. They're how we test
whether a feature serves the vision.

If you can't answer **yes** to all three checks at the bottom of this
doc, the work isn't done. Redesign, don't ship and patch later.

These three principles cover one half of "built well": the UX and
coherence bar (docs / defaults / consistency). The other half, the
non-functional trust and safety bar, is **not** a principle you trade
off on a gradient. It's enforced as hard lines in
[`invariants.md`](invariants.md): claude-native, no-self-escalation,
on-leash, single-tenant, telegram-only,
chat-is-the-single-source-of-truth. Security, the on-leash stakes, and
the subscription-honest stakes live there as binary pass/fail gates. A
feature can ace all three principle checks and still be out of scope
because it crosses an invariant. Check both.

---

## 1. "If they need the docs, we've failed"

Nobody wants to learn switchroom. They want their agents talking back in
Telegram.

The product should teach itself: inline guidance from the CLI and from
the agent's own replies, sensible defaults, error messages that tell
you what to do next. `docs/` is the optional deep-dive, not the
required reading. If a user can't figure out the basics without
leaving the terminal or the Telegram thread, we've made them do our
job.

### Check questions

- Can a new user complete this workflow without opening `docs/`?
- Does the CLI / Telegram surface explain the *why*, not just the *what*?
- When something fails, does the error tell the user what to do next?

### Examples

- ✅ **Good:** `switchroom auth add default --via-claude` prints the
  OAuth URL inline, says *"open this in any browser, complete the sign-in
  and the token saves automatically,"* and watches for completion.
  For refreshing an existing session: `switchroom auth reauth coach`.
- ❌ **Bad:** `switchroom auth add` exits with `EAUTH_FAILED`
  and a link to `docs/auth.md`.

- ✅ **Good:** `switchroom setup` tells the user upfront: *"Before adding
  your bot to a group, disable Privacy Mode in @BotFather → Bot Settings
  → Group Privacy → Turn off. This lets the bot see all group messages."*
  The guidance appears before the step that needs it, not as a post-hoc
  error.
- ❌ **Bad:** Setup completes, the bot joins the group, and silently
  ignores messages until the user reads `docs/telegram-plugin.md`.

- ✅ **Good:** A failing skill on an agent shows up as a real `reply`
  with `accent: 'issue'`: *"⚠ skill `weekly-review` failed: missing
  `hindsight` MCP. Run `switchroom agent reconcile coach` to repair."*
- ❌ **Bad:** A bare `❌ Error` reply with no next step and a pointer
  to "check the agent logs."

- ✅ **Good:** `switchroom vault set telegram-bot-token` prompts for the
  value, masks input, confirms encryption, and prints
  `+ Secret 'telegram-bot-token' saved`. The user can then reference it
  in `switchroom.yaml` as `vault:telegram-bot-token`.
- ❌ **Bad:** `switchroom vault set` succeeds silently and requires the
  user to read `docs/vault.md` to learn the `vault:` reference syntax.

---

## 2. "Batteries included, assembly optional"

Ship the pre-built Lego set, not the bag of bricks.

`switchroom setup` should produce a **working fleet** on the first run:
a default agent, a working bot, the agent responding
conversationally on the first message. The defaults cover 80% of
cases. Power users will customise.
Make them **opt into complexity, never opt out of it**. Configuration
is work. Give them the working thing first. Let them tinker later.

### Check questions

- Does this work with zero configuration for a typical user?
- Are the defaults right for most users, or did we punt the decision
  into `switchroom.yaml`?
- Can a power user customise without losing the out-of-the-box
  experience?

### Examples

- ✅ **Good:** `switchroom setup` produces a complete `switchroom.yaml`
  with the `default` profile, a working bot, working memory, and the
  first agent already responding in Telegram before the user reads
  anything.
- ❌ **Bad:** A bare `switchroom apply` against a blank `switchroom.yaml`
  with no first agent, telling the user to read `docs/configuration.md`
  before proceeding.

- ✅ **Good:** Playwright MCP is wired by default; opt out with
  `mcp_servers: { playwright: false }`. The conversational-pacing
  prompt + silence-poke safety net are on for every agent with tuned
  thresholds.
- ❌ **Bad:** "Configure the MCP servers and silence-poke thresholds
  yourself in `settings.json`." Maximum flexibility, zero defaults.

- ✅ **Good:** `switchroom agent create exec --profile executive-assistant`
  inherits everything from the executive-assistant profile and only writes
  the two-line agent stanza. The cascade fills the rest.
- ❌ **Bad:** Each new agent requires copying ten files of boilerplate
  before it boots.

- ✅ **Good:** The upgrade flow is one command: `switchroom update` pulls
  new images, reconciles the compose file, rolls the fleet, and runs
  doctor: idempotent and the same on every host.
- ❌ **Bad:** "Run `bun run build`, then bounce each container by hand,
  then re-render the compose file, then…"

- ✅ **Good:** Sensible default skills on each profile (health-coach
  ships with `check-in` and `weekly-review`); operator skills
  (`humanizer`) stay opt-in via `defaults.skills`.
- ❌ **Bad:** Every agent inherits every bundled skill as dead weight,
  or every agent ships with no skills and tells the user to pick.

---

## 3. "One mind built this"

The whole product should feel like one person designed it.

No seams between layers. Consistent CLI shape, consistent Telegram UX,
shared config cascade, unified vault and OAuth model. When you learn
how one part works, you've learned how the rest works. This is about
**cognitive load**, not visual design. Every new interaction model
asks users to re-learn the product.

### Check questions

- Does this follow the same patterns as adjacent features?
- Would this feel jarring next to the last thing we shipped?
- Is the quality bar the same as our best work, or "good enough for
  this corner"?

### Examples

- ✅ **Good:** Every top-level CLI verb is `switchroom <noun> <verb>`:
  `agent start`, `vault set`, `topics sync`, `auth add`. One
  shape. One file per noun in `src/cli/`.
- ❌ **Bad:** `switchroom agent start` next to `switchroom
  restart-agent` next to `switchroom start_telegram`.

- ✅ **Good:** Every long-running operation (interactive reply,
  scheduled task, sub-agent delegation) uses the same conversational
  pacing rhythm. Soft-commit, mid-turn updates at meaningful
  punctuation, final answer pings once. Sub-agent work is narrated in
  the same thread as the parent.
- ❌ **Bad:** Scheduled tasks render their output as a plain
  `sendMessage` with no soft-commit, sub-agent work hides behind a
  separate UI surface, interactive replies have different update
  cadence than agent-initiated narration.

- ✅ **Good:** Every config field has a documented cascade mode
  (union / override / per-key merge / concat / deep-merge) and behaves
  the same way across `defaults`, profiles, and agents. See
  `src/config/merge.ts` and `docs/configuration.md`.
- ❌ **Bad:** Some fields cascade, some override, some concat, with no
  documented mode, so users have to read the merge logic to predict
  behaviour.

- ✅ **Good:** Secrets are referenced uniformly as `vault:<key>`
  anywhere in `switchroom.yaml`. The vault CLI, the cascade resolver,
  and the bootstrap layer all know that prefix.
- ❌ **Bad:** Tokens via `vault:`, API keys via `${env.FOO}`, group
  IDs via plain literals: three idioms for "this came from somewhere
  else."

- ✅ **Good:** `switchroom agent restart` always reconciles first
  (regenerates the runtime config if changed), so a restart is also a
  mini-deploy. One mental model: *restart = pick up the latest of
  everything*.
- ❌ **Bad:** `restart` only restarts the process, `reconcile` only
  rewrites config, and you have to know which one to run when.

- ✅ **Good:** Same Telegram UX surface for every agent: same `/auth`
  router, same reaction lifecycle, same conversational pacing, same
  silence-poke safety net, regardless of profile.
- ❌ **Bad:** Custom one-off Telegram behaviours per profile that look
  slightly different in each topic.

### Sub-principle: "The chat IS the artifact"

Framework UI elements that mirror the conversation (cards, pinned
widgets, status bars) cover for the model's failure to communicate
naturally. We've been here once already (the pinned progress card,
retired in #1122). Build the model to communicate; let the framework
be the safety net, not the headline. Single source of truth for "what
is the agent doing": the chat itself, paced by the model. The
framework's job is to escalate the *reaction* (ambient) and fire a
backstop message at 5min silence (safety net), not to mirror state
in parallel.

When you're tempted to add a new pinned card / status bar / live
widget, ask: would the model sending a real `reply` cover this? If
yes, change the prompt instead.

---

## Applying the principles

Before you open a PR, ask:

1. **Docs test:** Can someone use this without reading `docs/`? If not,
   what's missing from the CLI surface, the agent's own messaging, or
   the error message?
2. **Defaults test:** Does this work immediately on a fresh
   `switchroom setup`, or does the user have to configure it first?
   Can you ship better defaults?
3. **Consistency test:** Does this feel like it belongs next to the
   rest of switchroom? Does it use the same CLI shape, the same
   cascade, the same conversational rhythm, the same vault reference
   syntax? Does it respect the "chat IS the artifact" sub-principle?

> [!IMPORTANT]
> If you can't answer **yes** to all three, you're not done. Redesign,
> don't ship and patch later.

And the three principle checks aren't the whole gate. The
non-functional trust bar (security, the on-leash stakes, the
subscription-honest stakes) is owned as binary lines in
[`invariants.md`](invariants.md), not as anything you weigh here:
claude-native, no-self-escalation, on-leash, single-tenant,
telegram-only, chat-is-the-single-source-of-truth. Before you open the
PR, confirm the change crosses none of them. A "yes" on all three
principle checks plus a crossed invariant is still out of scope.

These principles don't replace the existing JTBDs in `reference/`.
They *judge* them. A feature can satisfy a JTBD outcome and still fail
all three principle checks. When that happens, the JTBD outcome is the
goal, and the principles are how we get there without making the product
feel like a kit.
