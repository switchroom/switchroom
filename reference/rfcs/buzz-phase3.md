---
artifact: Buzz Phase 3 — scope + the telegram-and-buzz-only contract partition
serves: use-my-team-from-the-desktop
advances-outcome: always-available
status: rfc — scope record. Partitions Phase 3 work into CONTRACT-SAFE
  (buildable additively) vs CONTRACT-BLOCKED (needs a `telegram-and-buzz-only`
  amendment first). PR-0 of the Phase 3b plan — this record lands before any
  Phase 3b code, so subsequent PRs land against a written spec.
relates: "jobs/use-my-team-from-the-desktop.md invariants.md
  jobs/approve-what-my-agent-can-touch.md rfcs/fleet-dashboard.md #4208"
---

# Buzz Phase 3 — scope + the `telegram-and-buzz-only` partition

## Why this record exists

Buzz shipped Phase 1 (inbound fan-in sidecar, default off — PR #4208) and
Phase 2 (outbound mirror). The next wave of desktop work — threading, patch
rendering, reactions, audit — had **no durable in-repo record of its scope
or its contract boundary** before this file. The only in-repo "Phase 3"
reference was PR #4208's own body, which defines Phase 3 narrowly as
**approvals** ("Approvals (Phase 3) will ride kind:9 + an operator CLI
signing helper"). That definition is now **contract-blocked**: approvals on
Buzz cross `no-self-escalation` and the outbound-mirror clause of
[`telegram-and-buzz-only`](../invariants.md) — Telegram remains the sole
approval surface.

This record does two things: (1) fixes the Phase 3 scope to the desktop-UX
wave the job spec actually needs, and (2) partitions that wave by the
governing invariant so implementers know what is buildable additively and
what requires an explicit operator contract decision **before any code**.

Governing invariant: [`invariants.md` § `telegram-and-buzz-only`](../invariants.md).
Job spec: [`jobs/use-my-team-from-the-desktop.md`](../jobs/use-my-team-from-the-desktop.md)
(read its *Honest scope* clause — reactions and interactive affordances "stay
on Telegram until a contract change says otherwise").

## The contract rule, stated crisply

The whole partition turns on one line, worth stating before the table:

> **kind:7 (reactions) desktop↔desktop is safe. kind:7 crossing into the
> gateway inject socket is blocked.**

A reaction rendered client-side between two desktop clients on the relay
never becomes a turn and never touches the one agent session — it is
zero-repo, zero-contract-surface. The moment a `kind:7` (or any relay event)
is injected as a turn — in *any* form, including "just a signal", a
command, or an approval — it crosses the same wall Phase 3a signed approvals
hit: it gives Buzz an inbound authority the invariant reserves for the
signed, allowlisted, fail-closed path, and (for approvals/commands) an
approval/consent surface `no-self-escalation` keeps on Telegram.

## Phase 3b scope

The desktop-UX wave. Four areas:

1. **NIP-10 threading** — reply/root `e`-tag threading so desktop mirrors
   render as conversations, not a flat feed.
2. **NIP-34 patch (kind 1617) rendering / mirror** — surfacing code-patch
   events on the desktop.
3. **Reactions (kind:7)** — emoji/reaction rendering.
4. **Audit / observability** — a surface for what crossed the co-channel.

## Partition

### CONTRACT-SAFE — buildable additively

These extend the existing mirror/inbound-surfacing paths without granting
Buzz any new authority. No invariant amendment required.

- **T1 — Telegram-origin mirror thread continuity.** Carry NIP-10 `e`-tag
  threading on *outbound mirrors* so a Telegram thread renders as a thread on
  the desktop. Pure mirror enrichment; no new inbound authority.
- **T2 — inbound reply-parent surfacing.** When an allowlisted inbound event
  carries a reply parent, surface that parent context in the synthesized
  turn. The event already becomes a turn through the existing fail-closed
  path; this only enriches an already-authorized inject.
- **A1 — audit surface.** Observability over what crossed the co-channel
  (inbound accepted/rejected, outbound mirrored). Read-only; no send path, no
  approval action.
- **P1 — NIP-34 patch outbound mirror.** Mirroring a patch event outbound is
  safe *in principle* (it is a mirror, not a second voice) but is **gated on a
  live kind-support spike**: Phase-0 finding F4 recorded that custom Nostr
  kinds do not render in the Buzz desktop client. Ship P1 only after a spike
  confirms kind 1617 renders; otherwise it mirrors into a void.
- **R1 — desktop-to-desktop reaction rendering.** Reactions rendered
  client-side between desktop clients on the relay. **Zero repo work** — it is
  relay + client behaviour and never touches the gateway. Listed here to
  record that it is explicitly *in* the safe zone.

### CONTRACT-BLOCKED — require a `telegram-and-buzz-only` amendment before any code

Same wall as Phase 3a signed approvals. Do **not** write code for these until
an explicit operator contract decision amends the invariant.

- **R3 — inbound kind:7 injected as a turn, in any form.** A reaction that
  crosses the gateway inject socket to become (or trigger) a turn. Blocked
  regardless of framing ("just a signal", a lightweight ack, etc.): crossing
  the inject socket is the line.
- **R4 — reactions-as-commands.** Using a reaction to drive an action
  (approve, run, retry, …). Doubly blocked: it crosses the inject socket
  *and* it is an approval/command surface `no-self-escalation` keeps on
  Telegram.

### OUT OF SCOPE

- **P2 — inbound kind:1617 becoming a turn.** A desktop-authored patch event
  injected as a turn. Not planned for Phase 3; noted here so it is not
  mistaken for a P1 follow-on. (If ever pursued it is also contract-blocked
  under the same inject-socket rule.)

## Gated on an explicit operator contract decision

Two things wait on an operator decision to amend `telegram-and-buzz-only`
(and, for approvals, `no-self-escalation`):

- **Phase 3a — signed approvals on Buzz** (the PR #4208 "Phase 3" definition).
- **R3 / R4** — any inbound reaction crossing the inject socket.

Until that decision, these do not get built. The safe items (T1, T2, A1, P1,
R1) proceed independently and do not depend on it.

## Grounding notes — two stale references found during planning

Recorded here so the corrections are traceable and the ghost reference is
grounded.

1. **`docs/phase0-findings.md` is NOT the Buzz Nostr Phase-0 findings.** That
   committed file is the **tmux / broker path-derived-socket-identity spike**
   (2026-05-08) — it has no Nostr content. The Buzz Phase-0 findings (F1–F6:
   e.g. F2 NIP-42 AUTH, F4 custom-kind non-rendering, F5 NIP-29 kind:9) were
   **never committed as a doc** — they survive only in the PR #4208 body and
   in `src/buzz-gateway/` code (chiefly `nostr-protocol.ts`). The
   `source` citation in `src/buzz-gateway/fixtures/relay-contract.json` pointed
   at `docs/phase0-findings.md` for F2/F5 and has been corrected to reflect the
   real provenance (this PR). The fixture digest is unaffected — it covers only
   `auth_tags` / `message_kind` / `nip42_auth_kind`
   (`compat-check.ts:computeContractDigest`), not the `source` string.
2. **The Buzz "design doc §3.x" cited in code comments does not exist.**
   `src/buzz-gateway/publisher.ts:170` and `publisher.test.ts:88` cite a Buzz
   "design §3.1"; `telegram-plugin/gateway/buzz-mirror.ts:162` cites "design
   §3.3". No such design doc was ever committed to `reference/` (there was no
   Buzz RFC before this file, and no §9.6 exists in current source at all).
   Those section anchors are a **ghost reference**. They are deliberately left
   in place rather than mass-rewritten; this record grounds them so a reader
   who chases "design §3.1" lands here and learns the doc was never committed.
   If a future PR re-homes those comments, point them at this RFC and the
   fail-closed tests they describe (`publisher.test.ts`, `buzz-mirror.test.ts`).
