---
title: Switchroom name and positioning
date: 2026-11-15
amended: 2026-11-15
---

# Decision: Switchroom name and positioning

## Context

[successor-vision.md](successor-vision.md) made this repository the successor to the way Switchroom ran specialist agents. It kept the working name Hermes Fleet and left public naming and positioning open.

Three facts forced the question:

- The old Switchroom (a Claude Code harness) is retired. Its name, domain and GitHub org are free to carry the successor.
- "Hermes Fleet" is already a public name. AIowa-LLC/hermes-fleet ships a native iPhone app called Hermes Fleet, and its author ships a "Hermes Fleet connector" plugin on the Hermes marketplace. At least two other public repositories use `hermes-fleet`.
- Upstream already uses "fleet" as a common noun (`hermes update` fleet checks, the `local-fleet` plugin's `hermes fleet` command). A "Hermes X" name reads as an official Nous Research product.

The human owner ratified the answer in a positioning interview on 2026-11-15, with adversarial review from developer, product-leader and founder viewpoints.

## Decision

- **Name.** The public product is **Switchroom**. `hermes-fleet` stays as the repository, image and internal codename until the repository moves to the `switchroom` org. "Hermes Fleet" is not a public product name, and "fleet" is used only as a common noun.
- **Category line.** "An opinionated Hermes Agent distribution." It appears wherever the name does: site hero, README first line, repository description, social image.
- **Headline.** "Hermes agents that work your projects, not just your chats." Sub-line: "One box per agent. Linear holds the thread. Tuned for the Claude plan you already pay for." Isolation stays in the public sentence through the sub-line. The standing team is still an outcome and does not lead. *Amended 2026-11-15; the first headline was "Hermes, run as a team. Each agent in its own box." See [Amendment](#amendment-2026-11-15-linear-first-positioning).*
- **Credit and independence.** Built on Hermes Agent by Nous Research, said up front. Not affiliated with Nous Research. Say plainly that the image is a digest-pinned child of an exact Hermes Agent image.
- **Audience for the public surface.** Technical self-hosters, GitHub-led, early access. No five-minute install claim until a quickstart exists. The public product is also a worked example of how its owner runs AI-assisted product development, so honesty about status counts for more than reach.
- **Models.** Claude-first, not Claude-only. Switchroom is tuned for the Claude plan the principal already pays for: Claude Subscription DirectSDK is the planned default model path and Claude ACP provides claude.ai connectors. Other plans and keys (Codex, Grok, OpenRouter, local) still work. `subscription-honest` and `no-off-plan-model-call` are unchanged: the claim that ships is no API-key fallback for Claude plan logins; every other plan is held to the same rule. *Amended 2026-11-15; this replaces the earlier model-agnostic wording ("Bring your own plans and keys. Claude-subscription framing is not the headline."). See [Amendment](#amendment-2026-11-15-linear-first-positioning).*
- **Surfaces.** Telegram, Slack and Hermes Desktop keep the same bar, as before. They are standard Hermes, not a differentiator, and public copy gives them one sentence at most. *Amended 2026-11-15. See [Amendment](#amendment-2026-11-15-linear-first-positioning).*
- **Upstream contrast.** Upstream `hermes update` now folds multi-profile installs into one multiplexed gateway. Switchroom keeps one container and one gateway per agent on purpose. Public copy says that as a deliberate opinion, not as a criticism of upstream.
- **What the site may claim.** Only what this repository ships or what its reference docs state as a rule. Unmeasured signals (for example restart persistence) are stated as the bar, not as guarantees. Chat mockups are labelled illustrative.

## Amendment, 2026-11-15: Linear-first positioning

Later the same day the human owner ratified a second positioning pass, after the switchroom.ai Home page was rewritten around Linear ([HF-702](https://linear.app/switchroom-ai/issue/HF-702)) and the default-on decision was recorded in [default-on-distribution.md](default-on-distribution.md). The Decision bullets above are edited in place so this record holds one current answer; each amended bullet quotes the wording it replaced.

**Why it changed.** Telegram, Slack and Hermes Desktop come with any Hermes install, so leading with "a team you text" sold upstream's features as ours. What a person running many pieces of work across several agents does not get from plain Hermes is a durable thread per project and issue, isolation strong enough to leave agents running, and a configuration tuned for the plan they already pay for. "Bring your own plans and keys" was true but stated no opinion. The reference deployment runs Claude first, and the default-on decision makes that the planned default.

**Decisions.**

- **Category line unchanged.** "An opinionated Hermes Agent distribution." Product name Switchroom.
- **Headline.** "Hermes agents that work your projects, not just your chats."
- **Sub-line.** "One box per agent. Linear holds the thread. Tuned for the Claude plan you already pay for."
- **Chat is not a differentiator.** Telegram, Slack and Hermes Desktop are standard Hermes. They keep the same bar in the North Star and in `there-when-you-reach`, but public copy gives them one sentence at most: Telegram on the run, Slack or Desktop at your desk, and Linear keeps you from losing the thread across issues, projects and agents.
- **Claude-first, not Claude-only.** Claude Subscription DirectSDK is the planned default model path and Claude ACP stays for claude.ai connectors, as [default-on-distribution.md](default-on-distribution.md) records. Other plans work and follow the same no-off-plan rule. This replaces the model-agnostic wording. It does not change `subscription-honest` or `no-off-plan-model-call`.
- **Four proofs, in this order.**
  1. **Works your projects.** The Linear plugin: long-running work, one owning agent and durable task per issue, checkpoints as regular issue comments, follow-ups from any chat reaching the same task, and several agents on one project with handoff. Outcome: `works-your-projects` in [product-spec.md](../product-spec.md).
  2. **Safe to leave running.** One box per agent, per-agent vaulted credentials, isolated by default. Agent-to-agent (A2A) is an explicit, gated opt-in per deployment, never a default.
  3. **Tuned for your Claude plan.** Claude-first, not Claude-only, as above.
  4. **Runs like infrastructure.** Digest-pinned image, config as code, and a private overlay for identity and secrets.

**Honest status that public copy must keep.**

- **Nothing is on by default yet.** Linear, DirectSDK, Claude ACP and the connectors are in the reviewed default set but stay `planned` until the starter overlay enables them. In the bare image they are off.
- **Linear outcome evidence is not in.** The plugin source is published and disabled by default. The end-to-end cases in [entrust-ongoing-work](../jobs/entrust-ongoing-work.md) are still to validate.
- **DirectSDK is experimental.** Its author, Nous Research, labels the provider experimental.
- **Connectors are read-only qualified.** Writes need separate acceptance.
- **No endorsement.** Nothing may say or imply that Anthropic or Nous Research endorses, approves or partners with Switchroom. A Claude plan login is the principal's own account.
- **Demand is unmeasured.** Whether public adopters want a Linear-first agent distribution is a guess.

**Consequences.** Commits us to: the site, README, vision and product spec leading with the headline, sub-line and four proofs in this order; a `works-your-projects` outcome that the Linear job serves; dropping "a team you text" from the lead. Gives up: chat surfaces as a selling point, and vendor neutrality in the pitch. Blind spots: a Linear-first pitch narrows the audience to people who already run Linear, and the Linear outcome UAT is unvalidated.

## Consequences

Commits us to: one public name with a fixed category line; moving this repository to `switchroom/switchroom` with redirects; keeping site copy traceable to README and `reference/`; revisiting this record if upstream ships per-agent isolation itself.

Gives up: the discoverability of a "Hermes" product name (the category line carries the search terms instead); Switchroom's old "unmodified Claude CLI on your Pro/Max" pitch.

Blind spots: public-adopter demand is still unmeasured. The `switchroom` org rejects long-lived fine-grained tokens, so the move needs a new token or org setting. A party game named Switchroom is due on Steam; different category, low risk, unverified trademark position.

## Related

- [successor-vision.md](successor-vision.md)
- [vision.md](../vision.md)
- [product-spec.md](../product-spec.md)
- [default-on-distribution.md](default-on-distribution.md)
- [jobs/entrust-ongoing-work.md](../jobs/entrust-ongoing-work.md)
- Linear: [HF-704](https://linear.app/switchroom-ai/issue/HF-704)
- Linear: [HF-695](https://linear.app/switchroom-ai/issue/HF-695/relaunch-switchroomai-home-page-for-the-hermes-based-switchroom)
