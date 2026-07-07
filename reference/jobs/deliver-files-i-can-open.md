---
job: get work back as a file I can actually open
outcome: When an agent makes a file, it lands somewhere the user can open it from their phone, a Telegram attachment or a share link to their own Drive, never a path on the container.
stakes: A file the user can't reach is work that didn't happen. Hand over a `/state/agent/...` path and the agent looks like it's stalling or lying; the colleague illusion breaks on the last step.
serves: standing-team
invariants: [no-self-escalation]
---

# Job Spec: get work back as a file I can actually open

> A durable Job Spec. The *how* (the `deliver-file` verb, the OneDrive and
> Google Drive uploaders, the `Switchroom/<agent>/` folder convention, the
> reply-tool 50 MB attach path, and the `DELIVERY_GUIDANCE` prompt block)
> churns underneath. The job does not. This is an explicit operator-stated
> outcome (2026-06-07): agents kept replying with container paths the user
> couldn't open.

## The job

The user asks a specialist for something that comes out as a file: a
report, a CSV export, a generated chart, a converted doc. They're on
Telegram, on their phone, not on the box the agent runs on. They want the
artifact in their hands: tap to open, save, forward. A colleague hands you
the document; they don't email you the absolute path of the document on
their laptop. The job is to make the last step, *delivery*, feel like
that. The agent runs in a container, so its native instinct is to name the
file where it sits (`/state/agent/...`, `/tmp/...`); that path is dead on
arrival. Close the gap so the user always gets something they can actually
reach.

## Good / bad

**Good looks like**

- The user gets the artifact in a form they can open from their phone: a
  Telegram attachment they tap, or a share link to a file in their own
  Drive. One tap, no copy-paste, no shell.
- Most files just arrive in the chat: the report, the CSV, the chart land
  as a Telegram attachment in the same thread, no extra step asked of the
  user.
- Files they'll keep or that are too big for chat go to a stable home,
  `Switchroom/<agent>/` in their own connected Drive, and the reply carries
  the share link, not a path. The same specialist's work collects in the
  same folder over time.
- When nothing can be delivered (no Drive connected, too big for Telegram),
  the agent says so plainly and offers the fix, never falling back to a path.
- Delivery uses only the Drive access the operator already granted, and
  writes only to the agent's own delivery folder. It never reaches into the
  user's existing documents and never prompts a per-file approval to land
  its own output.

> [!CAUTION]
> A local container path (`/state/agent/...`, `/tmp/...`) is never delivery.
> The user is not on the box; the path leads nowhere. When nothing can be
> delivered, say so plainly and offer the fix — never fall back to a path.

**Bad looks like: never ship this**

- Replying with a local container path (`/state/agent/report.csv`,
  `/tmp/out.png`) as if that were delivery. The user is not on the box; the
  path leads nowhere.
- "The file is saved" with no attachment and no link: a claim of work the
  user can't verify or open.
- Scattering files loose in the root of the user's Drive, or overwriting
  their existing documents, instead of the agent's own `Switchroom/<agent>/`
  folder.
- Routing delivery through a credential or scope the operator didn't grant,
  or self-granting Drive write to get the file out.
- Silently failing to deliver and moving on: the artifact evaporates and
  the user never learns it was ready.
- Making the user run a command, mount a volume, or SSH in to retrieve their
  own result.

## Prove it

Named by job × surface. Delivery is well covered at the unit layer but has
**no end-to-end Telegram scenario yet**, flagged honestly below.

- **Upload to the right folder + share link (unit)** —
  `src/delivery/onedrive.test.ts`, `src/delivery/gdrive.test.ts`. *Watch:*
  the file lands under `Switchroom/<agent>/` (folder created if missing,
  create-race tolerated) and a shareable link comes back, degrading to a
  sign-in item link when anonymous sharing is policy-blocked. *Invariant:*
  delivery only ever writes the agent's own folder, never the user's
  existing docs.
- **Resolve a connected drive, or fail actionably (unit)** —
  `src/cli/deliver-file.test.ts`. *Watch:* picks the connected provider,
  returns provider + link + folder; with no drive connected, errors with the
  Telegram-reply fallback instead of a path; survives a missing/empty file
  and an upload failure without crashing. *Invariant:* never returns a
  local path as the delivery result.
- **Path-traversal guard on the folder name (unit)** —
  `src/cli/deliver-file.test.ts` (`safeAgentName`). *Watch:* a name with `/`
  or `..` can't escape `Switchroom/<agent>/`. *Invariant:* `no-self-escalation`
  — the agent can't widen its write target beyond its own folder.
- **Granted-creds-only delivery** — broker token path in
  `src/cli/deliver-file.ts` (uses the auth-broker's already-granted
  Microsoft/Google access token). *Invariant:* `no-self-escalation` —
  delivery consumes operator-granted Drive scope, never elevates to obtain
  it. *(coverage gap: asserted by construction + unit seams; no scenario
  proves the broker refuses an un-granted provider end-to-end.)*
- **Telegram-attachment delivery (DM + channel)** — *(coverage gap: no
  runnable UAT scenario yet.)* Needs a `jtbd-deliver-file-dm` /
  `-channel` proving an agent that produces a file replies with a tappable
  attachment (or a Drive link when >50 MB), not a container path, in both a
  DM and a forum supergroup.

**Fuzz corpus:** vary file size (inline × upload-session × >50 MB) × file
type (image vs document) × provider (OneDrive, Google Drive, none-connected)
× share scope (anonymous vs organization vs policy-blocked) × surface (DM vs
forum channel). The invariants must hold across the corpus: the user always
gets something openable or a plain can't-deliver message, never a container
path, and delivery never touches anything outside the agent's own folder.

## Verdict

- **Done when:** every file an agent produces reaches the user as a Telegram
  attachment or a Drive share link they can open from their phone, never a
  container path, proven across providers and surfaces, including the
  no-drive-connected fallback, by the scenarios above (and once the
  end-to-end DM/channel scenario lands, by it).

## Production-readiness

- *Reliability:* a delivery either yields an openable artifact (attachment or
  link) or a plain-language can't-deliver message with the fix, never a
  silent drop and never a dead path.
- *Least privilege:* delivery writes only `Switchroom/<agent>/` using
  operator-granted Drive scope; it cannot read or overwrite the user's other
  files and cannot self-grant the scope.
- *Surface parity:* delivery must be proven in both DM and forum channel once
  the end-to-end scenario exists. Channel-routing bugs have hidden in
  DM-only coverage before.

## Related

- [`talk-to-agents-from-anywhere`](talk-to-agents-from-anywhere.md) -- the
  phone-first chat surface a deliverable has to be openable from.
- [`approve-what-my-agent-can-touch`](approve-what-my-agent-can-touch.md) --
  the operator grant behind the Drive scope delivery writes with.
- [`feel-like-a-colleague`](feel-like-a-colleague.md) -- a colleague hands
  you the document, not a path on their machine.

---

> **Implementation:** the `deliver-file` CLI verb (`src/cli/deliver-file.ts`),
> the Drive/OneDrive providers (`src/delivery/`), and the `DELIVERY_GUIDANCE`
> prompt block. Those churn; this job outlives them. No standalone design
> artifact `serves:` this job yet. Write one if the delivery design grows.
