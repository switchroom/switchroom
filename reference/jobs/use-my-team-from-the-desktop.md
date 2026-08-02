---
job: use my team from the desktop
outcome: The user at a desk drives the same fleet, in the same agent sessions, over Buzz — the desktop co-channel — while Telegram stays the authoritative surface. Every agent answer lands on Telegram first; Buzz only ever shows mirrors of it. Pocket and desk are two doors into one conversation, never two conversations.
stakes: A phone-first surface alone tethers deep work to a thumb. But the moment a second surface becomes a second conversation — its own record, its own approvals, its own voice — the single source of truth is gone and the leash frays. The desktop surface earns its place only as a co-channel on Telegram's terms, dark by default, fail-closed by construction.
serves: always-available
invariants: [telegram-and-buzz-only, chat-is-the-single-source-of-truth, no-self-escalation, single-tenant]
---

# Job Spec: use my team from the desktop

## The job

The phone owns the away-from-keyboard loop
([`talk-to-agents-from-anywhere`](talk-to-agents-from-anywhere.md)). This
job owns the desk: during work hours the user lives in a desktop client,
and reaching for the phone to talk to their own team is a tax. The job is
to make the desk a first-class door into the same fleet — send a turn from
the desktop, see the answers there — without ever forking the
conversation. Buzz (a closed NIP-29 Nostr relay, one per-agent sidecar) is
that door, and it is the *only* other door there will be.

> [!IMPORTANT]
> Buzz is a co-channel, not a peer authority. Telegram remains the
> authoritative record and the sole approval/consent surface. Every Buzz
> outbound is a mirror of a message Telegram already delivered.

## Good / bad

**Good looks like**

- A message sent from the desk lands as an ordinary turn in the agent's
  one session — same memory, same thread of work, injected exactly like a
  cron fire — and the answer appears on both surfaces, Telegram first.
- Every agent answer the user reads on Buzz is one the Telegram thread
  already delivered: mirrors publish only after Telegram delivery, and a
  Telegram edit mirrors as a correction.
- The channel ships dark. Enabling it is a deliberate operator act per
  agent (`channels.buzz.enabled`), and with it off, behaviour is
  byte-identical to a Buzz-less fleet.
- Only signed events from the operator-pinned allowlist ever become
  turns; the default allowlist is the operator alone.
- A relay outage costs nothing: Telegram answers land exactly as before,
  and the desk surface catches up when the relay returns.

**Bad looks like: never ship this**

- A Buzz-only send path — an answer, status, or aside that exists on Buzz
  but not in the Telegram thread. That is a second conversation.
- An approve/deny/grant action tappable from Buzz. The human-validated
  Telegram tap is the sole approval surface (`no-self-escalation`).
- The agent reasoning about which channel to answer on. Routing is
  deterministic mechanism in the gateway, never model judgement.
- An open relay, a default allowlist that grows, or unsigned inbound
  becoming a turn.
- Generalising the sidecar into a channel SDK, adapter interface, or
  "just one more" surface. The third channel is the line
  (`telegram-and-buzz-only`).
- Blocking, delaying, or failing a Telegram answer because the mirror
  publish failed.

## Prove it

Named by mechanism, pointing at the shipped tests.

- **Desk turn in, fail-closed** — `src/buzz-gateway/auth-gate.test.ts`,
  `src/buzz-gateway/inbound-map.test.ts`,
  `telegram-plugin/tests/buzz-origin-stamp-gate.test.ts`. *Watch:* a
  signed, allowlisted event becomes an ordinary synthesized turn
  (`meta.source="buzz"`); anything unsigned or unlisted never does.
  *Invariant:* inbound is fail-closed; default allowlist is operator-only.
- **Mirror, never a second voice** —
  `telegram-plugin/tests/buzz-mirror.test.ts`,
  `telegram-plugin/tests/ipc-server-buzz-peer.test.ts`. *Watch:* a Buzz
  event is emitted only after the Telegram copy has landed; edits mirror
  as corrections; a dead peer never fails the Telegram answer.
  *Invariant:* no agent-facing Buzz-only send path exists.
- **Dark by default** — `src/buzz-gateway/config.test.ts`,
  `src/agents/compose-buzz-env.test.ts`. *Watch:* an absent or disabled
  `channels.buzz` forks no sidecar and changes nothing. *Invariant:*
  enabling the co-channel is an explicit operator act.
- **One turn, once** — `src/buzz-gateway/dedup.test.ts`,
  `telegram-plugin/tests/ipc-server-buzz-dedup.test.ts`,
  `src/buzz-gateway/limits.test.ts`. *Watch:* replayed or duplicate relay
  events inject one turn; volume is bounded. *Invariant:* the relay can
  never storm the session.

**Fuzz corpus:** vary origin (Telegram × Buzz) × mirror mode (`both` ×
`off`) × relay state (up × down × flapping) × sender (operator ×
allowlisted × stranger × unsigned). The invariants must hold across the
corpus: Telegram record complete, approvals only on Telegram, fail-closed
inbound, no third channel.

## Verdict

- **Done when:** the user can work a full desk session over Buzz — send
  turns, read answers and corrections — while every agent answer lands on
  Telegram first and Buzz shows only mirrors of it, approvals never leave
  Telegram, and disabling Buzz returns the fleet to byte-identical
  pre-Buzz behaviour.

## Production-readiness

- *Availability:* Buzz failing never degrades Telegram. Mirror publishes
  are fire-and-forget with a bounded retry queue
  (`src/buzz-gateway/retry-queue.ts`); the authoritative surface answers
  regardless.
- *Security:* NIP-42 auth to a closed relay; signature + allowlist before
  any event becomes a turn; the agent's Nostr key is broker-fetched
  in-process at sidecar boot, never written to env or logs.
- *Leak discipline:* outbound text passes the Telegram scrub (layer 1)
  and the sidecar re-scrubs before signing (layer 2); a secret never
  reaches the relay.
- *Honest scope:* mirror modes `both` and `off` are live; `origin` is
  deferred (degrades to `off`). A desk-typed question is injected into
  the session like a cron fire; its Telegram-feed copy is a later phase,
  so today Telegram shows the answer, not the desk question itself.
  Approvals, reactions, and other interactive affordances on Buzz are not
  built; until a contract change says otherwise, they stay on Telegram.

## Related

- [`talk-to-agents-from-anywhere`](talk-to-agents-from-anywhere.md) — the
  pocket half of the same loop; this spec is its desk counterpart.
- [`approve-what-my-agent-can-touch`](approve-what-my-agent-can-touch.md)
  — the approval surface Buzz must never grow.
- [`know-what-my-agent-is-doing`](know-what-my-agent-is-doing.md) — the
  in-chat liveness that stays on the authoritative surface.
