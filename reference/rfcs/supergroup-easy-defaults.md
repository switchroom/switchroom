---
artifact: supergroup easy-mode defaults (zero-config "agent owns a working room")
serves: talk-to-agents-from-anywhere
advances-outcome: always-available
status: Phase 1 implemented
---

# RFC: Supergroup easy-mode defaults (zero-config "agent owns a working room")

**Status:** Phase 1 implemented (this PR)
**Owner:** Ken Thompson
**Date:** 2026-06-02
**Related:** [supergroup-mode.md](./supergroup-mode.md) (the topology this builds on),
`reference/principles.md`, `reference/jobs/extend-without-forking.md`,
`reference/jobs/talk-to-agents-from-anywhere.md`.

## 1. Summary

Make the supergroup-owned topology **zero-config easy mode**: an operator
points an agent at a Telegram supergroup and it Just Works: responds to
every message, in every topic (including ones created later), with DMs
still served, without hand-editing `access.json` or picking a default
topic.

This came out of enabling marko in the "Panorama Marketing" group, which
required: discovering the `group_unknown` drop, knowing `access.json` is
`writeIfMissing`, hand-merging the group, and hand-picking `default_topic_id`.
None of that is something a user should have to do.

## 2. Which outcome / JTBD it serves

- **Outcome 1 — "a standing team that knows you":** *"Add a specialist in
  ten lines of YAML. You don't fork the product."* A supergroup specialist
  should be the same: a couple of config lines, not surgery.
- **JTBD `extend-without-forking`:** *"adds a new agent… by configuring it,
  not by editing the product. The scaffolding does the boilerplate."*
- **JTBD `talk-to-agents-from-anywhere`:** a dedicated working room per
  specialist is a natural surface.

**Leash check (outcome 2):** unchanged. "Responds to everything" only
affects which messages the agent *reads* in a group it *owns*; **actions**
(tools, credentials, sends) still go through Allow/Deny cards, and
`allowFrom` still gates *who* can talk to it. No self-elevation, no new
blast radius.

## 3. The three principle checks (the verdict rule)

- **P1 "If they need the docs, we've failed":** Today the bot joins a group
  and **silently drops** every message (`group_unknown`) until the operator
  reads docs + edits JSON. This is *verbatim* the ❌ example in
  `principles.md`. Phase 1 fixes the silent-config-gap half (config drives
  registration). Phase 2 adds the in-Telegram "enable this group?" nudge so
  the silent-drop is gone end-to-end. **Pass (P1) after phase 2; phase 1 is
  the load-bearing half.**
- **P2 "Batteries included, assembly optional":** was punting two decisions
  into `switchroom.yaml` (group registration + `default_topic_id`). Now
  both have smart defaults; complexity (mention-only, per-topic deny, a
  pinned default topic) is opt-*in*. **Pass.**
- **P3 "One mind built this":** reuses the existing config-cascade + the
  `access.json` reconcile model; the phase-2 CLI on-ramp will use the
  established `switchroom agent <verb> --topology` shape. **Pass.**

## 4. Design

### Phase 1 (this PR): the zero-config core
1. **Config-driven group registration.** `reconcileConfiguredGroup`
   (scaffold) idempotently merges the agent's configured supergroup
   (`channels.telegram.chat_id`, which overrides the fleet
   `telegram.forum_chat_id`) into `access.json` on every reconcile,
   strictly additive: only adds the group if absent, preserves
   `allowFrom` / pairings / other groups / operator policy overrides.
   This closes the `writeIfMissing` gap that made a post-scaffold
   supergroup never register (the marko case). Smart default for the
   new group: `requireMention: false` (a room the agent owns answers
   everything), all topics covered (the gate is per-group, not per-topic).
2. **`default_topic_id` defaults to General (1).** Setting `chat_id` no
   longer *requires* `default_topic_id`; it falls back to General (the
   outbound wrapper strips `thread_id === 1` on send). Operators pin a
   different fallback only if they want one.

Net phase-1 easy path:
```yaml
agents:
  marko:
    channels:
      telegram:
        chat_id: "-1001234567890"   # that's it — answers everywhere, DMs still work
```

### Phase 2 (follow-up PRs)
3. **CLI on-ramp:** `switchroom agent add --topology supergroup --chat-id <id>`
   and `agent set-topology <name> supergroup` (convert an existing agent):
   writes the stanza + reconciles, so no YAML editing at all.
4. **Kill the silent drop (P1 completion):** when a bot is in a group it
   isn't enabled for, post a one-tap "enable this group for <agent>?"
   prompt to the operator DM instead of dropping `group_unknown` in silence.

## 5. Overrides (opt-in complexity, preserved)

- `requireMention: true` per group — for a shared channel where the agent
  should only answer when @-mentioned.
- per-group `topic_deny: [...]` (phase 2) — active everywhere *except* listed
  topics (the inverse of the default auto-join-all).
- `default_topic_id` / `topic_aliases` — pin a fallback topic + name topics
  for cron targeting.

## 6. Tests

- `tests/scaffold.reconcile-group.test.ts` — additive merge, preservation of
  allowFrom/pairings/other-groups, no-overwrite of operator policy,
  idempotency, dm_only / no-forum / absent-file no-ops.
- `src/config/schema.test.ts` — `default_topic_id` defaults to General when
  `chat_id` is set alone; explicit value preserved; still rejects
  `default_topic_id` without `chat_id`.
