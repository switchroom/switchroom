---
job: talk to my agents from anywhere
outcome: The user can drive their fleet from a phone on the train as naturally as from a laptop at a desk. The interaction surface is where the user already is.
stakes: If the product requires the user to be at a machine, it's a dev tool, not an assistant. Most of the user's life happens away from the keyboard.
---

# The job

An agent that only works when the user is sat in a terminal is a toy. The
reality is the user wants to pick something up while walking to the shops,
finish thinking about it on the train, hand off to the agent, and get a
result while they're making dinner. The job is to make that loop feel
native.

That means the chat surface is first-class, not a bolted-on notification
channel. Everything the user needs to steer, inspect, correct, or pause
their agents has to be reachable from a phone with one hand. If a capability
only exists on the desktop, the user is tethered, and the product stops
being theirs.

This is not about porting a CLI to mobile. It's about accepting that the
phone is the primary surface and designing from there back. The desktop
experience should benefit from that discipline, not be diminished by it.

## Signs it's working

- A user can start, steer, and finish real work from their phone, with no
  moment where they wish they were at the laptop.
- Inbound messages feel acknowledged instantly, not "processing" for ten
  seconds before anything appears.
- Formatting on a phone screen reads naturally. No wide code blocks that
  require horizontal scroll, no nested structure that collapses on mobile.
- Attachments the user sends (a photo, a file) are treated as real input,
  not stripped or ignored.
- Notifications tell the user something they actually need to know. They
  don't fire on every edit, they don't go silent when something important
  happened.
- The user can hand off a task, lock the phone, come back an hour later,
  and pick up where the agent left off without re-explaining.
- Multiple agents in the same app feel like one fleet, not a drawer of
  disconnected bots the user has to remember how to address.

## Anti-patterns: don't build this

- A mobile experience that's really a web view of the desktop UI. If the
  user has to pinch to zoom to use it, it wasn't designed for a phone.
- Relying on a dashboard the user has to open to see state. If the
  important information isn't in the chat, it isn't in the user's life.
- Long walls of text, deep markdown, or multi-column output that only
  renders on a wide screen.
- Notification storms on every intermediate step. The user mutes the app,
  then they miss the one message that mattered.
- Going silent when something took long enough that the user walked away.
  Silence on mobile reads as "dead," not "working."
- Requiring the user to be in a specific chat view, or tap through a
  settings panel, to steer a task that's already running.
- Attachments that only work one direction, or only for some file types,
  without saying so.

## UAT prompts

- **Phone-only session.** Drive a real task start-to-finish from a phone,
  walking, on cellular. The experience should not feel like a compromise.
- **Commute handoff.** Start a task on desktop, continue it on phone
  without re-stating context. The agent should behave as if it's one
  conversation.
- **Long-running work with the screen off.** Kick off something slow, lock
  the phone, come back when it's done. The user should know it finished
  and what it produced.
- **Send a photo.** Attach a picture and ask the agent to act on it. The
  photo should be usable input, not discarded.
- **Noisy day.** Run several tasks across the morning. The user should not
  end the day with a muted chat because the agent over-notified.
- **Dead zone.** Lose connectivity mid-task. When it comes back the user
  should see a sensible state, not a broken thread.
- **One-handed correction.** Spot the agent going the wrong way while
  holding a coffee. A short reply should be enough to course-correct.
