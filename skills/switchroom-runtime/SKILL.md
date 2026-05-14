---
name: switchroom-runtime
description: |
  Use ONLY when the user is asking the AGENT ITSELF about its own
  runtime state in a specific runtime-context — i.e. the message
  refers to an actual crash, restart, hand-off resume, or mid-turn
  interrupt event. Required disambiguator: the prompt must reference
  one of these runtime-specific signals — "why did you restart",
  "did you crash", "you went away", "stop you mid-turn", "interrupt
  you", "are you still there after the restart", "resume the
  interrupted turn", "wake audit", "owed reply", "clean-shutdown"
  — OR start with the hard-prefix "For switchroom runtime hand-offs,".
  Also invoked on boot signals: SWITCHROOM_PENDING_TURN=true
  (interrupted-turn resume) or sentinel file
  $TELEGRAM_STATE_DIR/.wake-audit-pending (wake audit: scan for
  owed replies, orphan sub-agents, stale todos before answering).
  Triggers on phrasings like "Why did you restart, please.", "you
  went away.", "can I stop you mid-turn.", "why did you restart.",
  "how do I interrupt you", "did you crash?", indirect signals like
  "the switchroom-runtime thing is weird", "something is going on
  with switchroom-runtime", and typo'd variants such as "stil there
  after restart?". Whenever the user's message starts with the
  phrase "For switchroom runtime hand-offs," — regardless of what
  follows — use this skill. Surface the audit trail from
  clean-shutdown.json + container/journal logs.
  CRITICAL NEGATIVE GUARD — bare terse pings like "still there?",
  "any update?", "alive?", "you there?" are NOT sufficient on their
  own; they only route here when they appear AFTER an unexplained
  silence the agent should have explained (a real restart / crash
  event), not as conversational opener. When unsure, do NOT fire.
  Do NOT use for "reprovision my agents", "reinstall my agents",
  "manage my agents", "add a new agent", "remove an agent" — those
  are about the fleet, use `switchroom-manage`. Do NOT use when the
  user's message starts with "In switchroom (the CLI),", "In
  switchroom agent management,", or any other rival hard-prefix —
  those prefixes win over this skill. Do NOT use for "sync my
  config", "apply my config changes", "Please sync my config.",
  "upgrade switchroom", "Upgrade switchroom, please.", "what version
  is running", "what version", "apply my config", "check the
  journal", "logs", "show me the logs" — those are CLI operations,
  use `switchroom-cli`. Do NOT use for filing a bug or reporting an
  issue on GitHub — that's `file-bug`. Do NOT use for "what's wrong"
  / health-check style diagnostics — that's `switchroom-health`.
  Do NOT use for normal Telegram conversation, formatting questions,
  voice/sticker/Telegraph behavior, MCP tool questions, or persona /
  voice / Execution-Bias rules — those live in your always-loaded
  CLAUDE.md.
allowed-tools: Bash Read Grep
---

# Switchroom Runtime Protocols

This skill holds the runtime protocols that fire on specific boot signals or user phrases. The always-loaded `CLAUDE.md` points at these sections; this is where the implementation detail lives. Each section is gated by a distinct trigger — jump to the one that fires.

---

## Resume protocol — interrupted turns

**Trigger:** the env var `SWITCHROOM_PENDING_TURN=true` is set when your session boots. The previous gateway died mid-turn (SIGTERM, restart, or a crash that bypassed the SIGTERM handler) and the user's last message was likely never fully answered. The accompanying env vars tell you what was in flight:

- `SWITCHROOM_PENDING_CHAT_ID` — the chat the interrupted turn belonged to
- `SWITCHROOM_PENDING_THREAD_ID` — the forum topic id (empty if not a forum)
- `SWITCHROOM_PENDING_USER_MSG_ID` — the inbound message_id that started the turn (you can quote-reply to it for context)
- `SWITCHROOM_PENDING_ENDED_VIA` — `restart` (user ran `switchroom agent restart`), `sigterm` (systemd/manual kill), `timeout` (watchdog), or `unknown` (crash before stamp)
- `SWITCHROOM_PENDING_STARTED_AT` — unix-ms when the turn started

**Your first action on a `SWITCHROOM_PENDING_TURN=true` boot must be to acknowledge the gap and confirm direction.** Don't silently pick up where you left off. The user has no way to know whether you remember what you were doing. Use `reply` with `accent: 'issue'` to make it obvious. Quote-reply to `SWITCHROOM_PENDING_USER_MSG_ID` so the original message is in view. Sample wording (adapt to the situation):

> ⚠️ Issue
>
> I was killed mid-turn. Looks like my previous shutdown was via `<endedVia>`. Don't have full context on what I'd already done. Want me to: (a) start over from your last message, (b) summarize what I think was in flight and continue, or (c) drop it and move on?

The env vars are one-shot (start.sh deletes the file after sourcing), so this prompt only fires on the immediately-following session, not every restart afterward. If you genuinely don't remember anything useful about the prior turn (Hindsight didn't catch it, no handoff briefing landed), say so explicitly rather than guessing.

If `SWITCHROOM_PENDING_TURN` is unset or empty, do nothing special: the previous turn ended cleanly.

---

## Wake audit — every fresh boot

**Trigger:** the sentinel file `$TELEGRAM_STATE_DIR/.wake-audit-pending` exists. `start.sh` drops it on every process boot. On your first turn after a fresh boot, before answering whatever the user just sent, gate-check then run the audit. This complements the resume protocol above: `SWITCHROOM_PENDING_TURN` covers "killed mid-turn"; the wake audit covers "anything else owed since last seen."

**Conversation-aware dedup.** start.sh re-writes the sentinel on every process boot, including `--continue` respawns triggered by watchdog/bridge restarts. To avoid re-firing an already-handled audit on the same conversation, gate by `$TELEGRAM_STATE_DIR/.wake-audit-last-completed`:

```bash
# Step 0: is an audit pending?
[ -f "$TELEGRAM_STATE_DIR/.wake-audit-pending" ] || exit 0

# Step 1: have we already audited since the most recent user message?
# If `.wake-audit-last-completed` is newer than the latest inbound user
# message in any active topic, the audit was handled by a prior boot in
# this conversation. Clear the sentinel and skip.
#   - Compare the marker mtime to the max user-message ts from
#     `mcp__switchroom-telegram__get_recent_messages` across the topics
#     you might owe a reply in.
#   - If marker_mtime >= latest_user_msg_ts: rm -f the sentinel, exit.
```

If you proceed past the gate, run all three checks:

1. **Owed replies** (the most common "you forgot me" failure). Use `mcp__switchroom-telegram__get_recent_messages` for each topic the user contacts you in. If the most recent message in the topic is from the user (role=`user`) AND your most recent assistant turn is older than that, you owe a reply. Quote-reply to the user message with `accent: 'issue'` and acknowledge: _"I see your message from <relative-time> ago that I never answered (restart in between). Want me to handle it now?"_

2. **Orphan sub-agents** (jobs the watchdog killed mid-flight). Run:
   ```bash
   find "$CLAUDE_CONFIG_DIR/projects" -path '*/subagents/*.jsonl' -mmin -1440 -print 2>/dev/null
   ```
   For each, check the LAST line. If it's not a terminal record (`type:result` / `type:final` / `subtype:end`), the sub-agent was killed before completing. Tell the user what was being attempted (read the first user-message record from the file for context) and ask whether to retry: _"My `<task-summary>` sub-agent was killed at <ts> by a restart. Want me to redispatch?"_

3. **Open todos** (in-process work that never finished). Scan recent task state:
   ```bash
   find "$CLAUDE_CONFIG_DIR/tasks" -name '*.json' -mmin -1440 -print 2>/dev/null
   ```
   If any have items with `status: in_progress` whose mtime predates your session start, those are stale. Only mention them if relevant to the conversation. Don't recite the whole list.

**Idempotency**: after the audit (whether anything was found or not), stamp the dedup marker AND clear the sentinel:

```bash
touch "$TELEGRAM_STATE_DIR/.wake-audit-last-completed"
rm -f "$TELEGRAM_STATE_DIR/.wake-audit-pending"
```

The marker's mtime defines "audit complete for this conversation up to now". A future `--continue` respawn that finds the marker newer than the latest user message will skip the audit. The sentinel's absence means "audit complete for this process boot."

**Don't be noisy**: if all three checks come back clean, say nothing about the audit. Just answer whatever the user asked. The audit is a guardrail against silent dropped work, not a status broadcast. The "I owed you a reply" surface should fire less than once a week on a healthy system.

---

## "Why did you restart?" — read the audit trail

**Trigger:** the user asks something like "why did you restart?", "did you crash?", "you went away", "what happened earlier". The `SWITCHROOM_PENDING_*` env vars are one-shot (cleared by start.sh on first read), so by the time a user asks this, they're long gone. Don't answer from memory, don't say "no restart on my end". Three durable on-disk sources have the actual reason. Check them in order:

1. **`$TELEGRAM_STATE_DIR/clean-shutdown.json`** — single-line JSON `{ts, signal, reason}` written before EVERY restart by whoever initiated it (CLI, gateway SIGTERM handler, watchdog). Fastest answer for "what was THIS boot's reason." Example: `cat "$TELEGRAM_STATE_DIR/clean-shutdown.json"` → `{"ts":1777677708190,"signal":"SIGTERM","reason":"watchdog: bridge disconnected for 612s"}`.

2. **Container/unit history.** Under v0.7 docker mode (default), check `docker logs --since 2h switchroom-$SWITCHROOM_AGENT_NAME` for the container's recent stderr (boot card timestamps, SIGTERM reasons, panics) and `docker inspect switchroom-$SWITCHROOM_AGENT_NAME` for the full state JSON (look at `.State.StartedAt` for the last start time and `.State.RestartCount` for cumulative restarts). Under legacy systemd installs, the equivalents are `journalctl --user -u switchroom-$SWITCHROOM_AGENT_NAME --since "2 hours ago"` and `systemctl --user show switchroom-$SWITCHROOM_AGENT_NAME -p NRestarts`.

3. **Watchdog audit log.** Under systemd, `journalctl --user -t switchroom-watchdog --since "2 hours ago"` (every watchdog action: `[restart] / [skip] / [detect] / [error]` with `agent=NAME reason=KIND threshold=Ns observed=Ns ...`). Under docker the watchdog is disabled (no NRestarts equivalent without the docker socket), so this source is silent. Fall back to `clean-shutdown.json` plus the container logs above.

Quote the `reason` field verbatim when answering. Don't paraphrase. If `clean-shutdown.json` is older than the unit's current uptime, it's stale and the new boot wasn't a clean shutdown (likely OOM or panic). Say that explicitly. If all three sources are silent and uptime is fresh, the user might be looking at a "back up" card from a much older restart that's just scrolled into view; ask them to point at the specific card.

---

## `!` interrupt marker — implementation detail

**Trigger:** the user asks how to stop you mid-turn AND you want to give more than the one-liner answer (which lives in your always-loaded prompt). The one-liner answer is: *"Start your message with `!` — it interrupts whatever I'm doing and treats the rest as a fresh request."*

Implementation detail:

The gateway treats a Telegram message starting with `!` (single bang, not `!!` or `!!!`) as a deliberate interrupt: SIGINT to the active turn, strip the `!`, deliver the rest as a fresh turn. Under tmux-default, the SIGINT is delivered via `tmux send-keys C-c` to whatever has focus in the agent's pane (typically the claude REPL, but if claude has spawned a child Bash for a tool call, the child gets the C-c, which usually matches operator intent). A cgroup-wide kill fallback (legacy systemd: `systemctl kill --signal=INT`) fires only if send-keys fails.

If the user sends `! actually never mind, do X instead`, you'll boot up and see `actually never mind, do X instead` with no record of what you were doing before. That's intentional.

Doubled `!!` (typo / emphasis) reaches you verbatim. Empty `!` gets a "Send your replacement instruction now" reply from the gateway and never reaches you. The interrupt wakes a fresh `SWITCHROOM_PENDING_TURN` cycle, so the resume protocol above will fire on the next turn. Keep that pairing in mind when acknowledging.

---

## "status?" / "still there?" — UX-failure signal

**Trigger:** the user sends a short, low-content message asking whether you're alive — "status?", "still there?", "any update?", "you working?". The progress card and stream-reply pattern exist precisely so the user never has to ask. When you see one of those messages, treat it as a defect signal: something about the in-flight turn made the user feel uncertain. The product expectation (per `reference/know-what-my-agent-is-doing.md`) is that this rate trends to zero.

Your response should:

1. Answer the literal question: say what you're doing and where you are in it (one sentence).
2. **Offer to file an RCA issue.** Something like _"Want me to file this as an RCA so the progress surface gets fixed?"_ If the user says yes, invoke the bundled `/file-bug` skill which handles the log-pull + RCA structure + `gh issue create --label incident-rca`.

Pre-emptively reach for `/file-bug` only when the user clearly indicates they want it filed. Don't auto-file from a single "status?". That creates noise. The offer-then-confirm shape is the right friction.

The companion telemetry already in place (`gateway.ts` logs every `status?` to stderr with chat_id + agent, see #109) lets the maintainer track the rate over time even when no RCA is filed. Your job is to make sure the user's *current* concern doesn't go unaddressed.

---

## Bash shell wedge — KillBash, then ask for restart

**Trigger:** you receive a tool-result preamble from the framework that says `[wedge-detect] N consecutive empty-result Bash calls`, OR you notice trivial Bash calls (`echo ok`, `true`, `ls`) returning exit-1 with empty stdout/stderr two or three times in a row.

This is **the persistent-shell wedge.** Claude Code keeps a single `bash` subprocess per session for state continuity (so `cd` carries across calls). When that shell's IO state desyncs (typically after a long-running or interrupted command like `npm test` that was `!`-interrupted) every subsequent Bash call comes back exit-1-empty. Even `true` fails. The wedge is sticky for the session.

**Do not retry the same command.** The shell is dead to you; loops just burn the user's time. Two recovery steps in order:

1. **Try `KillBash`.** Claude Code exposes a `KillBash` tool that drops the wedged shell session; the next Bash call gets a fresh shell. This works in some wedge modes but not all (sentinel-parsing wedges sometimes don't release until a full session restart). Worth trying first because it's cheap.

2. **Ask the user for `switchroom agent restart <self>`.** If `KillBash` didn't recover (next Bash call is still exit-1-empty), the persistent shell needs the whole `claude` process to restart. Tell the user on Telegram with `accent: 'issue'`:

   > ⚠️ Issue
   >
   > My Bash shell is wedged. Every command including `true` returns exit-1 with empty output. Tried `KillBash`, didn't recover. Run `switchroom agent restart <self>` on the host to bounce me. State that survives the restart: Hindsight memory, handoff briefing, Telegram history. State that doesn't: anything I was about to write that's not yet on disk.

   Adapt the wording.

**Triggering causes to avoid.** The wedge most often follows: (a) a long `npm test` / `bun test` run, (b) any command that was `!`-interrupted mid-flight, (c) heredoc-style commands the shell's stdin couldn't fully consume. Prevention: dispatch heavy test suites to a worker sub-agent (so the wedge dies with the worker) rather than running them in your own session, and use `run_in_background: true` for long jobs.

A sentinel file at `$TELEGRAM_STATE_DIR/wedge-detected.json` records the most recent wedge detection. Operators can `cat` it for forensic timestamps; you don't normally need to read it yourself.
