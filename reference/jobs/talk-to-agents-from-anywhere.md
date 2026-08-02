---
job: talk to my agents from anywhere
outcome: The user can drive their fleet from a phone on the train as naturally as from a laptop at a desk. The interaction surface is where the user already is.
stakes: If the product requires the user to be at a machine, it's a dev tool, not an assistant. Most of the user's life happens away from the keyboard.
serves: always-available
invariants: [telegram-and-buzz-only]
---

# Job Spec: talk to my agents from anywhere

## The job

An agent that only works when the user is sat at a terminal is a toy. The
user wants to pick something up while walking to the shops, finish thinking
about it on the train, hand off to the agent, and get a result while
they're making dinner. The job is to make that loop feel native on a phone,
with one hand. The chat surface is first-class, not a bolted-on
notification channel. Everything the user needs to steer, inspect, correct,
or pause their agents must be reachable from where they already are.

> [!IMPORTANT]
> If a capability only exists on the desktop, the user is tethered and the
> product stops being theirs.

This is not porting a CLI to mobile. It's accepting
the phone as the primary surface and designing back from there. The desktop
benefits from that discipline rather than being diminished by it — and it
has its own first-class surface, Buzz
([`use-my-team-from-the-desktop`](use-my-team-from-the-desktop.md)); this
job owns the phone.

## Good / bad

**Good looks like**

- The user starts, steers, and finishes real work from a phone, with no
  moment where they wish they were at the laptop.
- Inbound messages feel acknowledged instantly, not "processing" for ten
  seconds before anything appears.
- Formatting reads naturally on a phone. No wide code blocks that need
  horizontal scroll, no structure that collapses on a narrow screen.
- Attachments the user sends (a photo, a file) are treated as real input,
  not stripped or ignored.
- Notifications tell the user something they actually need to know. They
  don't fire on every edit, and they don't go silent when it mattered.
- The user can hand off a task, lock the phone, come back an hour later, and
  pick up where the agent left off without re-explaining.
- Multiple agents in the same app feel like one fleet, not a drawer of
  disconnected bots the user has to remember how to address.

**Bad looks like: never ship this**

- A mobile experience that's really a web view of the desktop UI. If the
  user has to pinch to zoom, it wasn't designed for a phone.
- Relying on a dashboard the user has to open to see state. If the
  important information isn't in the chat, it isn't in the user's life.
- Long walls of text, deep markdown, or multi-column output that only
  renders on a wide screen.
- Notification storms on every intermediate step. The user mutes the app,
  then misses the one message that mattered.
- Going silent when something took long enough that the user walked away.
  Silence on mobile reads as "dead," not "working."
- Requiring the user to be in a specific view, or tap through a settings
  panel, to steer a task that's already running.
- A third human-facing chat channel bolted on beside the two. Telegram in
  the pocket, Buzz at the desk, each done properly — never an open
  multi-channel bridge.

## Prove it

Named by job × surface, pointing at real scenarios.

- **Drive real work from the chat (DM)** — `tests/jtbd-talk-from-anywhere.test.ts`,
  `jtbd-fast-trivial-dm`, `fuzz-real-work-dm`. *Watch:* a task runs
  start-to-finish entirely in chat, with no punt to a terminal or
  dashboard. *Invariant:* every steer/inspect/correct/pause capability is
  reachable from the chat surface alone.
- **Instant acknowledgement (DM)** — `jtbd-fast-ack-dm`,
  `jtbd-fast-trivial-dm`. *Watch:* an inbound is acknowledged within ~1s,
  before any answer. *Invariant:* the user never faces a silent gap between
  "I sent it" and "something's happening."
- **One-handed correction mid-flight (DM)** — `jtbd-rapid-followup-dm`,
  `jtbd-interrupt-marker-dm`. *Watch:* a short reply course-corrects a
  running turn. *Invariant:* steering an in-flight turn needs no view
  switch or settings panel, just a message.
- **Attachments are real input (DM)** — `voice-inbound-dm`,
  `location-inbound-dm`, `jtbd-album-coalescing-dm`. *Watch:* a photo,
  voice note, or location the user sends is acted on, not discarded.
  *Invariant:* user-sent attachments are usable input, never silently
  dropped.
- **Hand off, lock the phone, come back (DM)** —
  `jtbd-always-on-after-restart-dm`, `silent-end-recovery-dm`. *Watch:* the
  user can leave and return to a finished result; a long turn never ends in
  silence. *Invariant:* the agent never goes silent on a turn the user
  walked away from.
- **No notification storm (DM)** — `jtbd-soft-commit-dm`,
  `fuzz-status-ask-dm`. *Watch:* mid-turn progress is ambient, not a buzz
  per step. *Invariant:* notifications fire on what the user needs, never on
  every intermediate edit.
- **One fleet, addressable across surfaces (DM + channel)** —
  `jtbd-supergroup-reply-channel`, `fuzz-multitopic-routing-channel`.
  *Watch:* multiple agents are addressed naturally in DM and forum channel
  alike. *Invariant:* the fleet stays one coherent conversation on the two
  sanctioned surfaces — Telegram authoritative, Buzz mirroring it — never a
  third.

**Fuzz corpus:** vary input type (text × photo × voice × location × album)
× message timing (idle × mid-turn × rapid follow-up) × turn length (trivial
× long-running with screen off) × surface (DM vs forum channel) ×
connectivity (steady vs dead-zone reconnect). The invariants must hold
across the corpus: reachable from chat alone, instant ack, never a silent
walk-away, the two sanctioned channels only.

## Verdict

- **Done when:** the user can run, steer, and finish real work entirely
  from a phone. Instant ack, attachments honoured, no notification storm,
  no silent walk-away, never a punt to the desktop. Proven across DM and
  channel by the scenarios above.

## Production-readiness

- *Availability:* the chat surface is the product, so it has to be reachable
  whenever the user is. A dead-zone or reconnect never costs the user their
  place; the agent picks up the conversation after the gap rather than
  starting over.
- *Delivery integrity:* no turn is silently dropped. Every inbound is
  acknowledged, every user-sent attachment (photo, voice, location, album)
  is received as real input or fails loudly, and an outbound that matters
  reaches the user's device rather than dying in a buffer.
- *Latency:* an inbound is acknowledged within ~1s, before any answer.
  On mobile a silent gap reads as "dead," so perceived responsiveness is a
  hard property, not a nicety.
- *Reliability:* a long turn never ends in silence. The user can hand off,
  lock the phone, and return to a finished result or an honest status,
  never to a turn that quietly stalled while they were away.
- *Notification discipline:* alerts fire on what the user needs to know and
  stay quiet on intermediate steps, so the channel never trains the user to
  mute it and miss the one message that mattered.

## Related

- [`know-what-my-agent-is-doing`](know-what-my-agent-is-doing.md) — the ambient
  in-chat liveness this surface depends on.
- [`steer-or-queue-mid-flight`](steer-or-queue-mid-flight.md) — one-handed
  correction of a running turn.
- [`deliver-files-i-can-open`](deliver-files-i-can-open.md) — files and
  attachments as first-class input and output on a phone.
- [`use-my-team-from-the-desktop`](use-my-team-from-the-desktop.md) — the
  desk half of the same loop: Buzz as co-channel, Telegram authoritative.
