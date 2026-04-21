---
job: keep my subscription the only thing I'm paying for
outcome: The agents run on the user's Claude Pro or Max subscription, transparently and compliantly. No hidden API billing, no side-door tokens, no asks for extra keys.
stakes: If the product quietly routes to paid API or mixes billing models, the user loses trust and the product loses its licence to operate.
---

# The job

The user pays Anthropic for a subscription. They chose that plan knowing
what it costs and what it covers. The agents are an extension of that
relationship, not a way around it. The job is to make the product
honest about what it uses, who pays, and under what terms.

That means no quiet fallback to API billing when the subscription runs
low. No prompt caching schemes that look like subscription use but bill
through a different door. No "you also need an API key to unlock
feature X." If a feature can't run on the subscription, the product
either says so clearly or doesn't offer it.

Transparency beats cleverness here. If there's any ambiguity about what
the agent is using, the user should be able to find out in seconds, and
the answer should match what Anthropic's terms permit.

## Signs it's working

- The user can state in one sentence what they're paying for and what
  the product uses. Those two answers match.
- There's no second billing surface the user didn't ask for.
- The product is clear about which plans it supports and what it does
  when a plan can't run a feature.
- When the user hits a plan limit, the product says so honestly. It
  doesn't silently spend elsewhere.
- The compliance posture is documented and the documentation matches
  the runtime behaviour. A user auditing the product doesn't find
  surprises.
- Plan changes (upgrade, downgrade, cancel) are handled gracefully.
  The product adapts, doesn't break, and doesn't bill around them.
- The user can trust the agent to refuse a shortcut that would violate
  the terms, rather than take it.

## Anti-patterns: don't build this

- Silent fallback to API billing when the subscription is rate-limited.
- Asking the user for an API key as "optional" when core features need
  it. Either the subscription supports the feature, or it doesn't.
- Proxying subscription auth through the product in a way that bends
  the terms.
- Feature marketing that implies subscription support when the real
  path is API billing.
- Hiding usage from the user so they can't tell what's billed where.
- Workarounds that technically comply but obviously violate the spirit
  of the terms.
- Breakage when the user's plan legitimately changes. The product
  should adapt without the user unpicking secrets.

## UAT prompts

- **Fresh install, subscription only.** Set up the product with nothing
  but a subscription. Everything the product advertises as
  subscription-supported should work.
- **Plan-limit hit.** Exhaust the plan's window. The product should
  say so, not quietly bill elsewhere.
- **Audit.** From a cold read, the user should be able to confirm
  what's being used and who pays, in under a minute.
- **Plan change.** Upgrade or downgrade the plan mid-use. The product
  should adapt without the user re-wiring things.
- **No-key refusal.** Try to trigger a code path that would require
  unsupported billing. The product should refuse cleanly, not attempt.
- **Docs-vs-reality check.** Compare the compliance docs to the actual
  behaviour. They should agree.
- **Cancellation.** Cancel the subscription. The product's state should
  be honest about that, not continue running on phantom credit.
