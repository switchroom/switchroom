---
artifact: First-class users — identity → profile → agent assignment
relates: jobs/feel-like-a-colleague.md, rfcs/per-speaker-memory-routing.md, rfcs/access-model.md
backs: single-tenant
status: proposal (2026-06-19) — design, not yet scheduled
---

# First-class users

A **user** is a trusted person the operator's fleet serves, identified by
their Telegram account, carrying their own memory profile. This RFC makes
"user" a first-class config entity so the operator defines a person *once*
and assigns them to agents, instead of hand-maintaining parallel
`allowFrom`, `sender_banks`, and `additional_banks` maps per agent.

This is the clean form of "variant A" from
[`per-speaker-memory-routing`](per-speaker-memory-routing.md), now unblocked:
the [`single-tenant`](../invariants.md#single-tenant) invariant already
states that multiple **trusted users within one tenant** are supported, and
that agents should isolate memory per user. This RFC is how that's expressed.

## Why: the problem

After per-speaker routing shipped, wiring a multi-user fleet means repeating
the same person across three unrelated places, per agent:

- `access.allowFrom` — who may drive the agent (the existing access model).
- `memory.recall.sender_banks` — whose profile to recall when they speak.
- `memory.recall.additional_banks` — whose profile the agent always knows.

These all key on the same thing, a person's Telegram identity, but the
operator keeps them in sync by hand, per agent. There is no entity that says
"this is Lisa: here are her ids, here is her memory." That entity is the
missing abstraction, and it's also the natural anchor for everything
identity-keyed that comes later.

## Two semantics this must keep distinct

| Need | Trigger | Mechanism today |
|---|---|---|
| **Speaker context** — "*Lisa is talking* → load Lisa's profile" | who SENT the message | `sender_banks` (per-speaker routing) |
| **Subject knowledge** — "Ken asks gymbro *about* Lisa → it should know her" | who the turn is ABOUT | `additional_banks` (always-on, recall-ranked) |

They compose. An agent can speaker-route one user **and** always-know
another as a subject. The user concept must let the operator express both
without thinking about the underlying banks.

## The design

### A `users:` block (top-level)

```yaml
users:
  ken:
    name: Ken Thompson
    telegram_ids: ["mekenthompson", "11111111"]   # username and/or numeric id; leading @ optional
    profile_bank: ken-profile
  lisa:
    name: Lisa Thompson
    telegram_ids: ["8201250670"]
    profile_bank: lisa-profile
```

A user has Telegram identities (one or more, username and/or numeric id,
since the gateway emits `from.username ?? String(from.id)`) and a
`profile_bank` (their memory, authored via `switchroom memory profile`).

### Agent assignment: `serves` and `knows`

```yaml
agents:
  ziggy:  { serves: [lisa] }                 # Lisa's own agent
  marko:  { serves: [ken, lisa] }            # serves both
  lawgpt: { serves: [ken, lisa] }
  gymbro: { serves: [ken] }                  # Ken only
  clerk:  { serves: [ken], knows: [lisa, kids] }   # Ken drives; always knows the family
```

- **`serves: [<user>…]`** — the users this agent works *for*. They may drive
  it, and when one of them is speaking their profile is recalled.
- **`knows: [<user-or-bank>…]`** — profiles the agent should always have as
  *subjects*, even if that person never talks to it. Accepts a user name
  (resolves to their `profile_bank`) **or** a raw bank name, so non-users
  like the kids (a `kids` profile bank with no Telegram identity) can be
  known without being modelled as users.

### What the assignment generates (config resolution / scaffold)

| From | Generates | Effect |
|---|---|---|
| `serves[].telegram_ids` | `access.allowFrom` entries | the served users may drive the agent — **unifies** with the existing access model |
| `serves[] → profile_bank` | `memory.recall.sender_banks` | speaker routing: the talking user's profile is prioritized |
| `knows[] → bank` | `memory.recall.additional_banks` | subject knowledge: always-available, recall-ranked |

The recall hook is unchanged. It already reads `sender_banks` and
`additional_banks` (shipped in #2441/#2442). This RFC is a **config + scaffold
resolution layer only; no vendor-hook change.**

### Your fleet, expressed once

The table above *is* the wiring you'd otherwise hand-maintain: `ziggy`=Lisa,
`marko`/`lawgpt`=both, the rest Ken, and `clerk` additionally *knows* the
family, so "what does Lisa want for dinner?" resolves there even though Ken
is the one asking.

## Invariant & access-model compliance

- **`single-tenant`** — users are the **operator's** trusted people, defined
  in the operator's config, with profile banks that are all the operator's
  data in the operator's instance. This is the multi-trusted-user case the
  invariant explicitly blesses, not multi-tenancy. The user entity never
  exposes one tenant's data to another.
- **`no-self-escalation`** ([`access-model`](access-model.md)) — `allowFrom`
  remains **operator-authored**: it's derived from a `users:` block the
  operator writes, never from anything an agent or a sender can set at
  runtime. The sender→profile routing is **additive recall scoping, never an
  authorization decision**. `serves` widening `allowFrom` is the operator
  granting access by editing config, identical in trust to editing
  `allowFrom` directly today. An agent cannot add a user, widen its own
  `serves`, or self-grant.

## Backward compatibility & precedence

`access.allowFrom`, `memory.recall.sender_banks`, and
`memory.recall.additional_banks` remain valid as direct, low-level config.
`users:` is the higher layer that *generates* them. Precedence (decided,
see Open Question 1): `resolveUsers()` computes the generated values and
**unions** any explicit per-agent `allowFrom` / `sender_banks` /
`additional_banks` on top, additive, so an explicit value *extends* the
generated set rather than replacing it.

Crucially, this union is done **inside `resolveUsers()`**, not by leaning on
the default config cascade. The `memory.recall` cascade
(`src/config/merge.ts`) merges one level per-key and **replaces** an
array/map value wholesale (an override's `additional_banks` array or
`sender_banks` map replaces the base, it does not extend it), so relying on
it would silently drop the generated wiring. `resolveUsers()` therefore
produces the final unioned maps itself, before scaffold emits them. A fleet
with no `users:` block generates empty maps and behaves exactly as today.

## Effort

~PR1/PR2-sized: config + scaffold, no vendor change:

- Schema: top-level `users` block + agent `serves`/`knows` (with a
  validation that referenced users exist; `knows` accepts user-or-bank).
- Config resolution: a `resolveUsers()` step that, per agent, expands
  `serves`/`knows` into `allowFrom` / `sender_banks` / `additional_banks`,
  merged under any explicit per-agent values.
- Scaffold/start.sh: unchanged emit path (already serializes the generated
  maps via #2441/#2442).
- Tests: resolution (serves→allowFrom+sender_banks; knows→additional_banks;
  user-or-bank in knows; explicit-override merge; cascade); a schema
  round-trip; an invariant guard that `serves` never *narrows* operator
  intent.

## Out of scope (future, anchored on the user entity)

- **Per-user *retain* routing** — today routing is recall-only; a user's new
  facts still land in the agent's bank, not their profile. Routing retains to
  the speaker's profile is a natural follow-on, now that `user` exists.
- **Identity-keyed approvals / scheduling / quotas** — the `user` entity is
  the anchor; those are separate RFCs.
- **A user driving from a non-Telegram channel** — out by `telegram-only`.

## Open questions

1. **Generated-vs-explicit precedence — decided: union.** Explicit per-agent
   `allowFrom` / `sender_banks` / `additional_banks` **union** with the
   `serves`/`knows`-generated values (additive, safest), computed in
   `resolveUsers()` rather than the replace-by-default cascade (see Backward
   compatibility above). One source of truth: removing a served user's access
   is a `serves` edit, not a subtractive override. Open sub-question: do we
   ever need a *subtractive* per-agent exclusion ("serves Lisa fleet-wide but
   not on this agent")? Deferred; add an explicit `excludes:` only if a real
   need appears.
2. **Served vs known overlap** — a `serves` user is speaker-routed; should
   they *also* be always-known (subject) on that agent? Recommend **no** by
   default (speaker routing already loads them when they talk; add them to
   `knows` if you want them surfaced when *another* user asks about them);
   keeps the always-on recall arms minimal.
3. **Kids / non-driver people** — modelled as `knows:` bank names (no user
   entity) for v1. Promote to users only if/when they get a Telegram account.
