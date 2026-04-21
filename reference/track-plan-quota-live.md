---
job: track my plan quota live, without a dashboard
outcome: The user knows where they are against their rolling subscription limits at a glance, and hears about approaching caps before they're blocked.
stakes: A user who gets silently blocked by a quota mid-task loses trust in the product. A user who has to open a dashboard to check quota has to stop to think about something that should be ambient.
---

# The job

The user is on a subscription with rolling-window quotas. They don't
want to think about those limits, they want to know when they should.
The job is to make usage visible without making it the main show,
and to raise a flag before the user hits a wall.

"At a glance" is the key. The user shouldn't need to run a command, open
a browser, or ask for a status report to understand where they are. It
should be where they already are, at the weight of information that
matches its importance. Low usage is ambient background, approaching
a cap is a nudge, over the cap is a clear message with a sensible
next step.

Accuracy matters too. If the displayed number lags reality by an hour,
the user plans around a phantom. Whatever the product shows, it needs
to be current enough to act on.

## Signs it's working

- The user can answer "am I close to my limit?" without stopping what
  they're doing.
- Approaching a cap produces a visible signal at a point where the user
  can still act on it.
- Hitting a cap produces an honest message. The user knows they're
  blocked, why, and when they won't be.
- Usage shown matches reality closely enough that the user trusts it
  for planning.
- Different plans and different limits are handled correctly without
  the user configuring anything.
- The signal scales with the stakes. Background when there's headroom,
  louder when there isn't.
- When the window rolls, the user sees the recovery without having to
  refresh anything.

## Anti-patterns: don't build this

- Quota visible only in a separate dashboard or a command. If the user
  has to go looking, they won't, and they'll hit the wall.
- Silent blocking. Agent refuses to act with no explanation of why.
- Over-alerting. Every small usage tick produces a notification until
  the user mutes the product.
- Numbers that are stale by hours and misleading by more.
- Conflating different windows or different plan limits into one
  blurred signal.
- "You've used 87% of your quota" with no sense of whether that's
  routine or concerning for this user.
- Telling the user they're blocked without telling them when they
  won't be.

## UAT prompts

- **Ambient check.** Glance at the chat while usage is normal. Usage
  information should be available without being in the way.
- **Approach a cap.** Drive usage to near-limit. The signal should
  change in a way the user can't miss, at a point where they can
  still act.
- **Hit a cap.** Cross the line. The block message should be honest,
  specific, and include recovery timing.
- **Plan variance.** Run on a different plan. Limits and signals
  should adjust without re-configuring.
- **Recovery.** Let the window roll. The user should see usage
  free up without having to refresh.
- **Multiple windows.** Have more than one active limit. Each should
  be legible, not collapsed into a single number.
- **Accuracy spot-check.** Compare the shown usage to authoritative
  data. They should agree closely.
