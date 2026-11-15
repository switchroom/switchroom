---
title: Switchroom product vision
last_reviewed: 2026-11-15
---

# Switchroom product vision

Switchroom is an opinionated Hermes Agent distribution. Opinionated isolated Hermes: one agent per container and gateway, no shared credentials.

Public headline: "Hermes agents that work your projects, not just your chats." Sub-line: "One box per agent. Linear holds the thread. Tuned for the Claude plan you already pay for." Name and positioning, including the 2026-11-15 Linear-first amendment: [rfcs/switchroom-positioning.md](rfcs/switchroom-positioning.md). This repository keeps the working name `hermes-fleet` until it moves to the `switchroom` org.

The public product is that isolation layer plus the opinions that make an isolated agent worth leaving running: Linear as the thread for long-running work, Claude-first (not Claude-only) on the principal's own plan, and infrastructure-grade operation. A standing team of specialists is an **outcome**, not the tagline. Chat surfaces (Telegram, Slack, Hermes Desktop) are standard Hermes. They keep the same bar but are not what Switchroom adds. A private deployment may dogfood it. The household is not the product.

## Personas

- **Principal.** Hands work to specialists from Linear or from whichever chat is to hand, expects the same one back, on the plan they already pay for, asking before consequences. Often has many pieces of work running across several agents at once. Success: Trusted turns they did not sit through, and work they can follow per project and issue without reading chat history.
- **Operator.** Stands the team up, isolates them, changes one without touching the others. Often the same human on a different day. Success: after an intended change, every in-scope agent still independently working and the target has the change.
- **Public adopter.** A technical self-hoster who reads the repository before running anything. Early access: no quickstart yet. Success: they can tell what Switchroom adds to Hermes, and what is shipped versus aimed at, without asking.

## North Star

**Trusted unsupervised turns (TUTR).** Of all turns the principal did not sit through, the share that were Trusted.

A turn is Trusted when it was Unsupervised, completed without a human rescue, stayed inside the granted tools, and made no off-plan model call. Telegram, Slack, and Desktop are scored with the same bar.

If that number does not move, nothing else about Fleet matters.

N of N after an intended change (every in-scope agent still independently working, and the target actually has the change) is a **leash signal**, not the headline.

## Time horizon

When the dogfood production deployment runs the **public Fleet image** (not a private child), principals text the team on Telegram, Slack, and Desktop, and TUTR is the number we score.

## Why now

The same job that lived on a Claude-native specialist runtime now runs on isolated Hermes. Operators still need blast radius of one. Principals still need a team they can hand work to, on the plan they already pay for, that asks before consequences. As that work runs longer and spreads across agents, a chat thread stops being a place to follow it.

## What winning looks like

Outcome and Signal pairs. No numeric targets. Signals are defined in the product spec; repeated here so the vision can be read alone.

- **standing-team.** Named specialists, each with its own identity, memory, tools, and credentials. Signal: share of in-scope specialists that a principal can address as themselves, with unshared memory and credentials.
- **on-a-leash.** One agent cannot see another's secrets; a change to A leaves B alone; failed upgrades recover without touching the others. Signal: intended-change hold rate.
- **there-when-you-reach.** Telegram, Slack, and Desktop all work; a move or restart does not drop identity, tools, or sessions. Signal: first-class surface hold rate.
- **subscription-honest.** Claude-first, not Claude-only. Claude stays on the granted plan login, not a silent API meter, and every other plan the principal brings follows the same rule. Signal: off-plan model-call rate.
- **works-your-projects.** A person running many parallel pieces of work across several agents can see, per project and issue, who owns it, what was done and what is next, without reading chat history. Signal: readable-issue rate, the share of active issues whose owner, latest checkpoint and next action can be read from the issue alone (unmeasured).

## What losing looks like

- A "fleet" that is one shared runtime with profile names.
- Isolation that strips the agent of the integrations that make Hermes useful.
- One messaging surface treated as proof of the others.
- Chat surfaces sold as the product, or long-running work that can only be followed by scrolling chat history.
- A green publication or unit run reported as production.
- Recreating a profile or borrowing another agent's credentials to get past a blocker.
- Off-plan model calls billed as if they were the subscription.
- Docs, CI, and live state telling three different stories, with the author grading their own work.

## Not this product

- Household identity, live topology, bot tokens, or vault IDs in the public tree.
- Buzz as a Hermes surface.
- Another Hermes. Switchroom isolates and operates it.
- An official Nous Research product, or a name that implies one ("Hermes Fleet" is not the public name).
- A control-plane UI, ledger, or scoreboard.
- Telegram-only, or Slack replacing Telegram.
