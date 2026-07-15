# wake-audit-lifecycle — diagram spec

Status: current
Source of truth = `wake-audit-lifecycle.html` (Method A, HTML → 2x PNG via
`scripts/render.sh`). The `.png` is a build artifact; the legacy `.svg`/`.jpg`
are superseded and kept only for history.

One idea (the single sentence a first-time reader walks away with): if an
agent is killed or crashes mid-task, switchroom brings it back and it safely
picks up exactly where it left off, without losing your request or silently
dropping the work.

The diagram tells this as five left-to-right beats: killed mid-task (cord, the
interruption) → the turn is saved → it restarts itself → handed the unfinished
turn → resumes and tells you on your phone (brass-done, the payoff). A bottom
guardrail strip demotes the internals: the every-boot self-check (owed reply /
orphan sub-task / open todo) and the "asks before retrying a hung turn, so it
never loops forever" guard. Mechanism names (`SWITCHROOM_PENDING_TURN`,
`.wake-audit-pending`, handoff briefing, crash-pane) stay out of the primary
read and live only in the "Source of truth in code" block below.

(Prior JPG/SVG collapsed ≥4 distinct boot mechanisms into one env-line box
labelled "start.sh sources env · SWITCHROOM_PENDING_*", which both
misrepresented the boot and buried the human story. The HTML rebuild fixes
both.)

Source of truth in code:
- `profiles/_base/start.sh.hbs:253` ("Session resume policy") — `SWITCHROOM_RESUME_MODE`: handoff default / auto / continue / none
- `profiles/_base/start.sh.hbs:322` ("Session-mode signal") — `SWITCHROOM_SESSION_MODE` (continue|handoff|fresh|cold) for the greeting panel
- `profiles/_base/start.sh.hbs:349` ("Pending-turn signal") — `.pending-turn.env` → `SWITCHROOM_PENDING_TURN` (sourced + `rm`, fires once)
- `profiles/_base/start.sh.hbs:375` ("Wake audit sentinel") — `.wake-audit-pending` written every boot into `$TELEGRAM_STATE_DIR`
- `profiles/_base/start.sh.hbs:402` ("Session handoff briefing") — handoff merge into `--append-system-prompt` (handoff-briefing.sh invoked at `:432-434`)
- `src/cli/handoff.ts` + `src/agents/handoff-summarizer.ts` — Stop-hook `.handoff.md` (LLM session summary)
- `handoff-briefing.sh` — `.handoff-briefing.md` (live: Telegram tail + Hindsight recall + today's daily memory)
- `skills/switchroom-runtime/SKILL.md:83-118` — the 3-signal check + `.wake-audit-last-completed` conversation-aware dedup (name-referenced at `start.sh.hbs:396`)

Headline: "Things die. Switchroom brings it back, and it picks up where it left off." (HTML h1)
Kicker:   "WHEN AN AGENT DIES MID-TASK"
Footer:   Guardrail strip, plain-language: every boot runs a quick self-check
          (owed reply / half-done sub-task / open to-do), and a hung turn is
          re-offered rather than blindly retried, so it never loops forever.
          Tag: "Catches silent dropped work · Fires under once a week · Audited".

## Nodes (the five story beats, left to right)

1. `Killed mid-task` · crash / forced restart / timeout · cord (dark card, the
   interruption moment). Primary-read framing; the precise triggers (watchdog
   SIGTERM, `resume_watchdog_timeout`, OOM) stay in the code block below.
2. `The turn is saved` · the in-flight request is written down before death ·
   brass. (Code: `.pending-turn.env` → `SWITCHROOM_PENDING_TURN`, sourced once.)
3. `It restarts itself` · switchroom auto-boots the agent · brass. (Code:
   container restart policy + `start.sh.hbs` fresh boot, default `handoff` mode.)
4. `Handed the unfinished turn` · gets the saved request back plus a short
   recap · brass. (Code: `SWITCHROOM_PENDING_TURN` replay + handoff briefing
   `.handoff.md` / `.handoff-briefing.md` merged into `--append-system-prompt`.)
5. `Picking up where I left off` · phone/Telegram card, the payoff ·
   brass-done (emotional centre, widened beat). The agent tells you it is resuming an
   interrupted turn and continues.

Guardrail strip (below the flow, demoted internals): the every-boot
`.wake-audit-pending` sentinel + 3-signal check (owed reply · orphan sub-agent
· open todo), and the `resume_watchdog_timeout` guard that asks before retry so
a hang can't loop forever.

## Edges

- 1 → 2 → 3 → 4 · primary-flow (brass arrows for the sequence)
- 4 → 5 · primary-flow (brass arrow into the resume payoff)

## Style notes

Inherits v3, authored as Method A (HTML/CSS → 2x PNG). One-accent-role
discipline: cord = the kill (beat 1) only; brass = the recovery steps
(2–4); resume/success (beat 5, the headline highlight, the final arrow) =
the brass-filled done role — solid brass fill with a charcoal glyph, which
replaced the retired off-brand teal. Phone at beat 5 is the widened focal card. Mechanism/jargon strings
(`SWITCHROOM_PENDING_TURN`, sentinel filename, crash-pane, handoff-briefing)
are kept out of the picture entirely and cited only in the code block above.
