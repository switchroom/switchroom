---
job: approve what my agent can touch, without ever leaking the secret
outcome: From Telegram, the operator grants or denies an agent's request for a secret, tool, MCP server, or host action with one tap. Access is per-resource, the agent can ask for more but can never self-grant, and the raw credential never appears in the chat.
stakes: Get this wrong two ways. Make granting hard or opaque and a helpful agent improvises around the gate, tells the user to paste a token into chat, guesses key names, burns taps. Make it loose and "helpful" silently becomes "escalated", with no one in the loop. Either failure leaks a credential or hands an agent access the operator never gave it.
serves: hold-the-leash
invariants: [no-self-escalation, claude-native]
---

# Job Spec: approve what my agent can touch, without ever leaking the secret

> A durable Job Spec. The *how* (the broker, the approval kernel, the
> three auth paths, the per-key ACL, the redaction detector, the
> posture-mint opt-in) lives in the design artifact
> `reference/rfcs/access-model.md`. That implementation churns; this job does
> not. This spec is the **operator-facing** approval/secret-handling
> outcome; the agent-side authorization mechanism is detailed in
> `reference/rfcs/access-model.md`, the design record backing the
> `no-self-escalation` invariant, and stays distinct.

## The job

The operator's agent hits the edge of what it was given: it needs a
credential, a tool, an MCP server, or a host action it doesn't hold. The
operator wants to make that call from their phone, in the same chat, with
the full picture (*which* agent wants *what*) and decide in one tap. And
they want a hard guarantee under it: the agent can ask, but it can never
grant itself; and whatever secret is involved is never exposed in the
conversation. The job is to make granting access frictionless and honest
without ever turning the chat into a place a raw credential lives.

## Good / bad

**Good looks like**

- The agent that needs more never asks the user to paste a secret into
  chat. It requests; the operator gets a card; the value is provided once,
  securely, and is gone from history.
- The approval card shows the **exact scope** (this agent, this key, this
  file, this verb), sourced the same way it's enforced, not a friendly
  label the agent picked.
- One tap grants or denies. A grant is per-resource: approving one key
  doesn't hand over the next.
- A granted request **auto-resumes the turn**. The operator taps Allow and
  the agent picks up where it left off, without a nudge.
- If the operator pastes a secret anyway, the bot deletes the original
  message and confirms. The plaintext leaves the chat, the value lands in
  the vault, the agent never receives it.
- The agent can see its own sandbox and the denied path offers a clean
  one-tap request, so it stops guessing and never routes around the gate.
- The irreversible / admin-credential case sits behind the operator
  passphrase, a secret the agent structurally never holds, not just a tap.

> [!CAUTION]
> A raw credential surviving in chat history, logs, or being returned to the
> agent is a leak, not a regression — a single occurrence is a defect. The
> agent can request access but can never self-grant.

**Bad looks like: never ship this**

- The agent telling the user to paste a token into chat because a slot was
  empty. The improvisation *is* the leak.
- A raw credential surviving in chat history, logs, or being returned to
  the agent after the operator provided it.
- A card whose displayed label and granted scope come from different
  sources, so the agent can show one thing and obtain another.
- A blanket grant: one tap silently widening the agent's access beyond the
  one resource on the card.
- Any path where an agent ends up with access the operator never wrote down
  or tapped for: a self-edit that survives reconcile, a wire-supplied
  identity, a posture mint of a crown-jewel key.
- A grant that lands but the turn dies anyway, forcing the operator to
  re-prompt the work they already approved.
- A false-positive redaction that eats the operator's ordinary question
  just because it said the word "token".

## Prove it

Named by job × surface, pointing at real scenarios in
`telegram-plugin/uat/scenarios/`.

- **Agent requests a secret, never asks for a paste (DM)** —
  `jtbd-request-secret-dm`. *Watch:* the agent calls the secure-request
  flow; the operator provides the value once; the raw value never lands in
  history/logs and is never returned to the agent. *Invariant:*
  `no-self-escalation` — the agent obtains the secret only via an operator
  action, and never holds the plaintext.
- **Pasted secret is redacted (DM)** — `secret-redaction-deletes-original-dm`.
  *Watch:* operator pastes a real-shaped secret; the bot deletes the
  original message and posts a redaction card; the plaintext leaves the
  chat. *Invariant:* `no-self-escalation` — a credential never persists in
  the conversation surface.
- **Redaction doesn't false-positive (DM)** —
  `secret-redaction-no-false-positive-dm`. *Watch:* the operator talks
  casually about tokens/secrets and the message is left intact. *Invariant:*
  the safety net never eats ordinary conversation. A confusing wall is
  itself a leak risk.
- **Request → approve → access, end to end (DM)** —
  `vault-request-access-end-to-end-dm`. *Watch:* agent requests access,
  operator approves, the agent's read then succeeds, and only for the
  approved key. *Invariant:* `no-self-escalation` — access flows from the
  operator tap, enforced where the agent can't write it.
- **Per-resource grant under concurrency (DM)** —
  `vault-request-access-concurrent-dm`. *Watch:* with overlapping requests
  the agent can read only the most-recently-approved key; a racing second
  Approve doesn't widen scope. *Invariant:* `no-self-escalation` — a grant
  is per-resource and a race never escalates it.
- **Granted request auto-resumes the turn (DM)** —
  `vault-grant-auto-resume-dm`, `jtbd-grant-resume-telegram-id-dm`.
  *Watch:* the agent does nothing further until approval, then the turn
  resumes on the operator's Allow tap without a re-prompt. *Invariant:*
  `claude-native` — the resume is a synthesized turn injected into the
  interactive session, not a new programmatic model call.
- **One-tap allow off the audit log (DM)** — `vault-audit-allow-dm`.
  *Watch:* operator taps Allow on a recent denial and the agent's next read
  succeeds. *Invariant:* `no-self-escalation` — the denied path offers a
  frictionless operator-tap grant, so the agent never improvises around it.
- **Single-factor approve posture (DM)** —
  `vault-approval-posture-telegram-id-dm`. *Watch:* the opt-in
  telegram-id approve path is wired so the Telegram-authenticated tap, not
  the agent, authorizes the mint. *Invariant:* `no-self-escalation` — even
  in the relaxed posture the deciding factor is one the agent lacks, and
  admin keys claw back to passphrase.

**Fuzz corpus:** vary secret shape (token / key / file scope / host verb) ×
provide-vs-paste × approve / deny / ignore × concurrent overlapping
requests × race on the Approve tap × restart-mid-grant × crown-jewel
(passphrase) vs ad-hoc (tap) tier. The invariants must hold across the
corpus: never a self-grant, never a raw credential in chat, every grant
per-resource, every resume a synthesized turn.

## Verdict

- **Done when:** the operator can grant or deny exactly what an agent asks
  for with one honest tap, the agent can request but never self-grant, the
  raw secret never appears in chat, and a granted request resumes the turn
  on its own. Proven by the scenarios above.

## Production-readiness

- *Confidentiality:* a raw credential never persists in chat history, logs,
  or the agent's view: provided-once, deleted-on-paste, never returned.
  This is the load-bearing security property; a single leak is a defect, not
  a regression budget.
- *Authorization integrity:* every grant is enforced where the agent can't
  rewrite it (different uid, or operator-owned read-only config); a self-edit
  never survives reconcile; a wire-supplied identity is rejected.
- *Scope fidelity:* the card's displayed scope equals the granted scope,
  sourced the same way; per-resource, never blanket.
- *Tiering:* irreversible / admin-credential actions sit behind the operator
  passphrase, a factor the agent structurally lacks, never a tap alone.
- *Reliability:* an approval that lands resumes the turn; a denied or
  restart-interrupted grant never strands the agent silently.

## Related

- [`share-auth-across-the-fleet`](share-auth-across-the-fleet.md) -- the
  credential plane the grants draw on; this job gates what that pool hands out.
- [`act-in-my-tools-with-an-identity`](act-in-my-tools-with-an-identity.md) --
  what the agent does with a granted identity once the operator has approved it.
- [`operate-the-fleet-from-telegram`](operate-the-fleet-from-telegram.md) --
  the other one-tap, in-chat operator control surface.

---

> **Implementation:** the *how* lives in `reference/rfcs/access-model.md` (the
> agent-side authorization contract and the three-tier mechanism it points
> at). That artifact churns; this Job Spec outlives it.
