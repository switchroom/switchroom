---
artifact: switchroom access model
backs: no-self-escalation
relates: jobs/approve-what-my-agent-can-touch.md
---

# Switchroom access model

This is the design record detailing **how** the
[`no-self-escalation`](../invariants.md#no-self-escalation) invariant is
enforced. It is the security contract for authorization in switchroom. It is
deliberately small. Read it before changing anything that grants,
checks, or prompts for access: secrets, tools, MCP servers, vault
grants, or host/fleet verbs. The operator-facing approval/secret-handling
outcome is the job [`approve-what-my-agent-can-touch`](../jobs/approve-what-my-agent-can-touch.md);
this doc is the agent-side mechanism beneath it.

## The deployment we actually secure

Switchroom is a **local install on a single-tenant Linux server**: one
operator, their own box, agents that are **eager to help, not
adversarial** (the [`single-tenant`](../invariants.md#single-tenant)
invariant). That reality is what lets the model be simple, so don't
import a multi-tenant or hostile-network threat model and over-build for
it.

- There is no second tenant and no remote attacker in scope. The
  operator is root.
- A **same-uid attacker is out of scope by construction** (`docs/vault.md`:
  *"the vault ACL is misconfiguration protection, not a security
  boundary"*). The real boundary is filesystem perms + the vault
  passphrase. Hardening against a process that already shares the
  agent's uid is effort spent on a threat this product doesn't have,
  and it's where the over-built proposals went (see *Closed
  directions*).
- The threat we **do** secure is escalation by a helpful agent: it
  reaches for something the operator didn't give it.

## The invariant this enforces

The line is owned by the [`no-self-escalation`](../invariants.md#no-self-escalation)
invariant: *an agent can request more access, but can never author its
own authorization; every grant is written by the operator, in a place
the agent cannot write.* This doc is the **how** beneath that line. If a
change lets an agent widen its own access without the operator, the
change is wrong. Redesign it, don't gate it after the fact.

## The one boundary — and it's free

On a single-tenant box the OS already gives the only hard boundary we
need, and it's the right one: **each agent runs as its own uid; anything
an agent must never escalate to lives behind a _different_ uid.**

- **Agent → another agent's data, sockets, credentials** — different
  uid → OS-enforced. Not reachable, full stop.
- **Agent → its own authorization** (tools, MCP servers, vault grants)
  — the authoritative source is operator-owned `switchroom.yaml`,
  bind-mounted **read-only**. The agent's own scaffold files
  (`settings.json`, `.mcp.json`) are writable by it, but they are
  **regenerated from `switchroom.yaml` on every reconcile/restart**, so a
  self-edit doesn't survive. The one sanctioned self-edit path
  (`config_propose_edit`) is **server-validated additive-to-self behind
  an operator tap**. The agent reads its sandbox; it cannot durably
  rewrite it.
- **Agent → host / fleet control** — `hostd` is a separate daemon →
  admin-gated.

The only place an agent shares a uid is with **its own gateway**. By
default that softness is inert: minting a scoped credential goes through
the operator (`vault.broker.approvalAuth: passphrase`, the default), so
the agent self-mints nothing. The agent↔gateway channel only becomes
forgeable if the operator **opts in** to single-factor posture mint for a
named agent (`approvalAuth: telegram-id` **and** adding the agent to
`vault.broker.postureMintAgents`, both default-off). Even then it's
bounded: `adminOnlyKeys` claws the sensitive keys back to
**passphrase-only**, which a same-uid agent still can't satisfy. So the
same-uid surface is an operator opt-in gated by a factor the agent lacks,
not an open door. That's why the model needs no cryptographic
proofing of the agent↔gateway channel.

## Three tiers, three minimal mechanisms

Match the enforcement to the sensitivity. Nothing heavier than the tier
requires.

| Tier | What | Enforcement |
|---|---|---|
| **Sandbox** | tools, MCP servers, standing credentials the operator declared | Authoritative `switchroom.yaml` is operator-owned + read-only; scaffold files regenerate from it on reconcile. Agent works freely inside it, **no prompts.** |
| **Ad-hoc** | something not in the sandbox | One **honest** approval card → the operator's Telegram tap. `callback_query.from.id` is Telegram-authenticated; an agent cannot fake it. |
| **Crown jewels** | irreversible actions, admin credentials | Operator **passphrase** — a secret the agent structurally never holds. The only tier above a tap. |

The passphrase, not process-isolation tricks, is the unforgeable line,
because it's a capability the agent **lacks**, not a barrier we hope it
won't cross. Mark genuinely-sensitive vault keys passphrase-required
(`vault.broker.adminOnlyKeys`) so an eager agent can't posture-mint them.

## Honest cards

An approval an agent can socially-engineer is no approval. A card must
show the **exact scope being granted**: the vault key, the fileId, the
verb, not a friendly label the agent chose. Keep the
wrapper-attested-truth vs `💬` agent-framing split (the Drive
diff-preview is the reference implementation) on every approval surface.

- ✅ **Good:** "⚠ clerk wants to write to `Q3 Plan` (`1aBc…xyz`)". The
  operator approves the exact file that becomes the scope.
- ❌ **Bad:** a card whose displayed label and granted scope come from
  different sources, so the agent can show one thing and obtain another.

## Dead-ends breed workarounds

Half of access security here is **legibility**, because an eager agent
that hits a confusing wall improvises, and improvisation is where the
leaks happen (an agent told the user to paste a raw token into chat
because the vault slot was empty; agents guess vault key names and burn
operator taps). So:

- An agent should be able to **see its own sandbox**, what it's
  authorized for, so it stops guessing and overreaching.
- When it hits the edge, the sanctioned path ("you don't have X, here's
  the one-tap request") must be **frictionless and obvious**, so it
  never routes around the gate.

A blocked-but-unclear path is a security risk, not just a UX one.

## Closed directions (do not reopen for single-tenant)

These were proposed to make the agent↔gateway channel unforgeable
against a same-uid actor. That actor is out of scope; these add real
friction and infrastructure for a threat this product doesn't have.
Park them unless the deployment model changes (untrusted agents,
multi-operator, hostile network):

- **A second Telegram bot** for approvals. Defends a descoped threat,
  doesn't fully close it (same-uid can still read the vault file /
  gateway memory), and means two BotFather bots + a second poller + the
  operator juggling two chats.
- **A host-side approval verifier** setting `origin='operator'` and
  flipping `SWITCHROOM_REQUIRE_OPERATOR_APPROVAL_MINT=1`. Same rationale;
  the flag stays **off** by default on single-tenant.
- **Tap-per-mint.** The operator already approved the credential when
  they granted it; re-tapping every scoped-token mint is babysitting.

The cheap, always-welcome hardening that *isn't* over-built: keep the
bot token in the vault rather than plaintext `.env` (one revocation
surface, no casual read), reject any wire-supplied `origin` field at the
kernel, and the honest-card + passphrase items above.

## Check questions — for any access-touching change

- Could an agent end up with access the operator never wrote down or
  tapped for? (If yes, redesign.)
- Is the grant enforced where the agent **can't write it** (different
  uid, or operator-owned read-only config), not in something the agent
  controls?
- Does the approval card show the **real scope**, sourced the same way
  it's enforced?
- For the irreversible / crown-jewel case, is it behind the
  **passphrase**, not just a tap?
- When access is denied, does the agent get a clean one-tap path to
  request it, so it won't improvise around the gate?

If you're reaching for a new daemon, a second bot, or per-action crypto
to answer these, stop. On single-tenant the uid boundary + read-only
operator config + the passphrase already answer them.
