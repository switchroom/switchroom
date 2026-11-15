---
title: Switchroom name and positioning
date: 2026-11-15
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
- **Headline.** "Hermes, run as a team. Each agent in its own box." Isolation stays inside the public sentence. The standing team is still an outcome. It may lead the headline only alongside isolation, never alone.
- **Credit and independence.** Built on Hermes Agent by Nous Research, said up front. Not affiliated with Nous Research. Say plainly that the image is a digest-pinned child of an exact Hermes Agent image.
- **Audience for the public surface.** Technical self-hosters, GitHub-led, early access. No five-minute install claim until a quickstart exists. The public product is also a worked example of how its owner runs AI-assisted product development, so honesty about status counts for more than reach.
- **Models.** Bring your own plans and keys (Claude, Codex, Grok, OpenRouter, local). Claude-subscription framing is not the headline. `subscription-honest` and `no-off-plan-model-call` are unchanged: the claim that ships is no API-key fallback for Claude plan logins; every other plan is held to the same rule.
- **Surfaces.** Telegram, Slack and Hermes Desktop, same bar, as before.
- **Upstream contrast.** Upstream `hermes update` now folds multi-profile installs into one multiplexed gateway. Switchroom keeps one container and one gateway per agent on purpose. Public copy says that as a deliberate opinion, not as a criticism of upstream.
- **What the site may claim.** Only what this repository ships or what its reference docs state as a rule. Unmeasured signals (for example restart persistence) are stated as the bar, not as guarantees. Chat mockups are labelled illustrative.

## Consequences

Commits us to: one public name with a fixed category line; moving this repository to `switchroom/switchroom` with redirects; keeping site copy traceable to README and `reference/`; revisiting this record if upstream ships per-agent isolation itself.

Gives up: the discoverability of a "Hermes" product name (the category line carries the search terms instead); Switchroom's old "unmodified Claude CLI on your Pro/Max" pitch.

Blind spots: public-adopter demand is still unmeasured. The `switchroom` org rejects long-lived fine-grained tokens, so the move needs a new token or org setting. A party game named Switchroom is due on Steam; different category, low risk, unverified trademark position.

## Related

- [successor-vision.md](successor-vision.md)
- [vision.md](../vision.md)
- [product-spec.md](../product-spec.md)
- Linear: [HF-695](https://linear.app/switchroom-ai/issue/HF-695/relaunch-switchroomai-home-page-for-the-hermes-based-switchroom)
