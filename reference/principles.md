---
job: keep switchroom feeling like one product, not a kit
outcome: Every PR, design review, and release is checked against three product principles. Features that fail the checks get redesigned, not shipped and patched.
stakes: Without explicit standards, "convention over configuration" decays into "configure everything." The fleet stops feeling like one product.
---

# Switchroom product principles

These aren't aspirations. They're product engineering standards, applied
in **every PR, every design review, every release**. They're how we test
whether a feature serves the vision.

If you can't answer **yes** to all three checks at the bottom of this
doc, the work isn't done. Redesign, don't ship and patch later.

---

## 1. "If they need the docs, we've failed"

Nobody wants to learn switchroom. They want their agents talking back in
Telegram.

The product should teach itself: inline guidance from the CLI and the
progress card, sensible defaults, error messages that tell you what to
do next. `docs/` is the optional deep-dive, not the required reading. If
a user can't figure out the basics without leaving the terminal or the
Telegram thread, we've made them do our job.

### Check questions

- Can a new user complete this workflow without opening `docs/`?
- Does the CLI / Telegram surface explain the *why*, not just the *what*?
- When something fails, does the error tell the user what to do next?

### Examples

- ✅ **Good:** `switchroom auth login coach` prints the OAuth URL
  inline, says *"open this in any browser — tokens save to this agent's
  CLAUDE_CONFIG_DIR, no other agent is affected,"* and watches for
  completion.
- ❌ **Bad:** `switchroom auth login coach` exits with `EAUTH_FAILED`
  and a link to `docs/auth.md`.

- ✅ **Good:** `switchroom setup` detects that the bot's privacy mode is
  still on and tells the user *"@CoachBot has Privacy Mode enabled — it
  won't see group messages. Disable it in @BotFather → Bot Settings →
  Group Privacy → Turn off, then re-run this step."*
- ❌ **Bad:** Setup completes, the bot joins the group, and silently
  ignores messages until the user reads `docs/telegram-plugin.md`.

- ✅ **Good:** A failing skill on an agent shows up in the progress card
  as *"⚠ skill `weekly-review` failed: missing `hindsight` MCP. Run
  `switchroom agent reconcile coach` to repair."*
- ❌ **Bad:** Progress card shows `❌ Error` with no next step and a
  pointer to `journalctl --user -u switchroom-coach`.

- ✅ **Good:** `switchroom vault set telegram-bot-token` prompts for the
  value, masks input, confirms encryption, and tells the user *"now
  reference this in switchroom.yaml as `vault:telegram-bot-token`."*
- ❌ **Bad:** `switchroom vault set` succeeds silently and requires the
  user to read `docs/vault.md` to learn the `vault:` reference syntax.

---

## 2. "Batteries included, assembly optional"

Ship the pre-built Lego set, not the bag of bricks.

`switchroom setup` should produce a **working fleet** on the first run
— a default agent, a working bot, a pinned progress card on the first
message. The defaults cover 80% of cases. Power users will customise;
make them **opt into complexity, never opt out of it**. Configuration
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
- ❌ **Bad:** `switchroom init` writes a blank `switchroom.yaml` and
  tells the user to read `docs/configuration.md` before proceeding.

- ✅ **Good:** Playwright MCP is wired by default; opt out with
  `mcp_servers: { playwright: false }`. Progress cards on by default
  with tuned coalescing/chunking thresholds.
- ❌ **Bad:** "Configure the MCP servers and progress card cadence
  yourself in `settings.json`." Maximum flexibility, zero defaults.

- ✅ **Good:** `switchroom agent create exec --profile executive`
  inherits everything from the executive profile and only writes the
  two-line agent stanza. The cascade fills the rest.
- ❌ **Bad:** Each new agent requires copying ten files of boilerplate
  before it boots.

- ✅ **Good:** `switchroom update` upgrades the CLI, regenerates
  systemd units, restarts each agent + gateway, and reports done. One
  command, idempotent.
- ❌ **Bad:** "Run `bun run build`, then `systemctl --user
  daemon-reload`, then restart each agent yourself."

- ✅ **Good:** Sensible default skills on each profile (health-coach
  ships with `check-in` and `weekly-review`); operator skills
  (`humanizer`, `buildkite-*`) stay opt-in via
  `defaults.skills_auto`.
- ❌ **Bad:** Every agent inherits every bundled skill as dead weight,
  or every agent ships with no skills and tells the user to pick.

---

## 3. "One mind built this"

The whole product should feel like one person designed it.

No seams between layers. Consistent CLI shape, consistent Telegram UX,
shared config cascade, unified vault and OAuth model. When you learn
how one part works, you've learned how the rest works. This is about
**cognitive load**, not visual design — every new interaction model
asks users to re-learn the product.

### Check questions

- Does this follow the same patterns as adjacent features?
- Would this feel jarring next to the last thing we shipped?
- Is the quality bar the same as our best work, or "good enough for
  this corner"?

### Examples

- ✅ **Good:** Every top-level CLI verb is `switchroom <noun> <verb>`
  — `agent start`, `vault set`, `topics sync`, `auth login`. One
  shape. One file per noun in `src/cli/`.
- ❌ **Bad:** `switchroom agent start` next to `switchroom
  restart-agent` next to `switchroom start_telegram`.

- ✅ **Good:** Every long-running operation — interactive reply,
  scheduled task, sub-agent delegation — produces the same progress
  card with the same step formatting and the same coalesce / chunk /
  pin rules.
- ❌ **Bad:** Scheduled tasks render their output as a plain
  `sendMessage`, sub-agent work hides behind a different label, and
  the progress card only shows up for interactive replies.

- ✅ **Good:** Every config field has a documented cascade mode
  (union / override / per-key merge / concat / deep-merge) and behaves
  the same way across `defaults`, profiles, and agents. See
  `src/config/merge.ts` and `docs/configuration.md`.
- ❌ **Bad:** Some fields cascade, some override, some concat, with no
  documented mode — users have to read the merge logic to predict
  behaviour.

- ✅ **Good:** Secrets are referenced uniformly as `vault:<key>`
  anywhere in `switchroom.yaml`. The vault CLI, the cascade resolver,
  and the bootstrap layer all know that prefix.
- ❌ **Bad:** Tokens via `vault:`, API keys via `${env.FOO}`, group
  IDs via plain literals — three idioms for "this came from somewhere
  else."

- ✅ **Good:** `switchroom agent restart` always reconciles first
  (regenerates systemd units + daemon-reload if changed), so a restart
  is also a mini-deploy. One mental model: *restart = pick up the
  latest of everything*.
- ❌ **Bad:** `restart` only restarts the process, `reconcile` only
  rewrites units, and you have to know which one to run when.

- ✅ **Good:** Same Telegram UX surface for every agent — same `/auth`
  router, same progress card, same emoji reactions, same chunking
  rules, regardless of profile.
- ❌ **Bad:** Custom one-off Telegram behaviours per profile that look
  slightly different in each topic.

---

## Applying the principles

Before you open a PR, ask:

1. **Docs test:** Can someone use this without reading `docs/`? If not,
   what's missing from the CLI, the progress card, or the error
   message?
2. **Defaults test:** Does this work immediately on a fresh
   `switchroom setup`, or does the user have to configure it first?
   Can you ship better defaults?
3. **Consistency test:** Does this feel like it belongs next to the
   rest of switchroom? Does it use the same CLI shape, the same
   cascade, the same progress card, the same vault reference syntax?

If you can't answer **yes** to all three, you're not done. Redesign,
don't ship and patch later.

These principles don't replace the existing JTBDs in `reference/` —
they *judge* them. A feature can satisfy a JTBD outcome and still fail
all three principle checks. When that happens, the JTBD outcome is the
goal; the principles are how we get there without making the product
feel like a kit.
