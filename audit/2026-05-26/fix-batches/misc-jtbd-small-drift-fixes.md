# Fix batch: small drift-minor and vision-only fixes across independent units

**Scope:** `reference/give-each-agent-its-own-workspace.md`, `reference/run-a-fleet-of-specialists.md`, `reference/extend-without-forking.md`, `reference/remember-across-sessions.md`, `reference/survive-reboots-and-real-life.md`, `reference/vision.md`, `reference/talk-to-agents-from-anywhere.md`, `reference/keep-my-subscription-honest.md`, `docs/compliance-attestation.md`, `telegram-plugin/uat/assertions.ts`.
**Verdict pattern:** drift-minor (6), drift-major (2), vision-only (2), archive-leaks (1).
**Estimated edits:** small -- 1-3 lines per file, 11 total.

Note: each finding below is self-contained and touches only its stated file. No two findings here share a file with each other or with any other batch.

## Findings in this batch

### Finding 1 -- jtbd-give-each-agent-its-own-workspace:c8

- **File:** `reference/give-each-agent-its-own-workspace.md` L104-L107
- **Quote:** "The boot card surfaces `<repo>: dirty since <ts>` as a one-line warning."
- **Verdict:** drift-major (boot-card surface claim inaccurate)
- **Proposed action:** update-text
- **Proposed text:** Change "The boot card surfaces" to "The reconcile log emits a one-line warning to stderr".
- **Evidence:** `src/repos/agent-worktree.ts` L196-L208 -- `process.stderr.write(...)` is the only output path; no boot-card.ts field for dirty-worktree state.
- **Rationale:** The boot-card claim is inaccurate even for code that exists. The larger issue (function never called) is escalated.

### Finding 2 -- jtbd-give-each-agent-its-own-workspace:c9

- **File:** `reference/give-each-agent-its-own-workspace.md` L109-L110
- **Quote:** "Removal is symmetric. `switchroom agent remove <name>` calls `git worktree remove` for each of the agent's worktrees"
- **Verdict:** drift-major
- **Proposed action:** update-text
- **Proposed text:** Correct command name to `switchroom agent destroy <name>`. Add note that `removeAgentWorktree` is not currently called from the destroy path; worktree cleanup is not wired.
- **Evidence:** `src/cli/agent.ts` L1931 -- command is `agent.command("destroy <name>")`; `removeAgentWorktree` not imported or called from destroy.
- **Rationale:** Wrong command name and misleading claim about symmetric removal.

### Finding 3 -- jtbd-run-a-fleet-of-specialists:c6

- **File:** `reference/run-a-fleet-of-specialists.md` L40-L41
- **Quote:** "Removing an agent is clean. Its memory, its state, its scheduled work all go with it, with no orphaned processes or dangling config."
- **Verdict:** drift-minor
- **Proposed action:** update-text
- **Proposed text:** Add qualifier: "Its state directory and scheduled work JSONL go with it. The Hindsight memory bank persists and requires manual cleanup via the Hindsight service. The `switchroom.yaml` config entry also requires manual removal before running `switchroom apply` to take the container down."
- **Evidence:** `src/cli/agent.ts` L1930-L1979 -- destroy does not delete Hindsight bank or YAML entry.
- **Rationale:** "No dangling config" is not fully true.

### Finding 4 -- jtbd-extend-without-forking:c7

- **File:** `reference/extend-without-forking.md` L38
- **Quote:** "Removing an extension is as clean as adding it. No residue."
- **Verdict:** drift-minor
- **Proposed action:** update-text
- **Proposed text:** "Removing an extension requires two steps: `switchroom agent destroy <name>` removes the scaffold directory, then editing `switchroom.yaml` to delete the agent entry and running `switchroom apply` removes the container. The scaffold dir is fully cleaned; the YAML entry requires a manual edit."
- **Evidence:** `src/cli/agent.ts` L1964-L1969 -- comment explicitly says yaml cleanup is a manual step.
- **Rationale:** "No residue" overstates cleanliness.

### Finding 5 -- jtbd-remember-across-sessions:c6

- **File:** `reference/remember-across-sessions.md` L40
- **Quote:** "Memory decays sensibly. Stale preferences don't haunt the user a year later."
- **Verdict:** vision-only
- **Proposed action:** mark-vision
- **Proposed text:** "Memory decays sensibly (not yet built -- Hindsight banks currently store memories indefinitely; the demote tag excludes entries from recall but does not delete them). Stale preferences don't haunt the user a year later."
- **Evidence:** `src/memory/hindsight.ts` L1-L738 -- no decay/TTL parameter anywhere.
- **Rationale:** No decay mechanism exists. Present-tense "Signs it's working" claim is misleading.

### Finding 6 -- jtbd-survive-reboots-and-real-life:c5

- **File:** `reference/survive-reboots-and-real-life.md` L37-L38
- **Quote:** "Persistent failures surface. The user is told when a retry loop has stopped trying."
- **Verdict:** drift-minor
- **Proposed action:** update-text
- **Proposed text:** "Persistent named failures (credentials, quota exhaustion, crashes) surface. The user is told with an operator-event card. Note: the Telegram API retry-giveup path currently logs to stderr only and does not send a user-visible message."
- **Evidence:** `telegram-plugin/retry-api-call.ts` L169 -- `onGiveUp` is observer-only with no user message.
- **Rationale:** Coverage is real but not universal. Qualification avoids overpromising.

### Finding 7 -- contract-vision:c9

- **File:** `reference/vision.md` L127
- **Quote:** "A multi-provider orchestrator | No OpenAI, Gemini, Llama, model swapping."
- **Verdict:** drift-minor
- **Proposed action:** update-text
- **Proposed text:** "A multi-provider orchestrator | No OpenAI, Gemini, Llama, or model swapping for inference. Auxiliary services (e.g. voice transcription via Whisper) are opt-in helpers, not Claude replacements."
- **Evidence:** `telegram-plugin/voice-transcribe.ts` L1-L22 -- Whisper API used for voice transcription (opt-in, off by default).
- **Rationale:** Ambiguous table row could be read as banning any OpenAI dependency, including the opt-in Whisper feature.

### Finding 8 -- jtbd-talk-to-agents-from-anywhere:c10

- **File:** `reference/talk-to-agents-from-anywhere.md` L75-L76
- **Quote:** "Dead zone. Lose connectivity mid-task. When it comes back the user should see a sensible state, not a broken thread."
- **Verdict:** vision-only
- **Proposed action:** mark-vision or update-text
- **Proposed text:** "Dead zone. Lose connectivity mid-task. When it comes back, Telegram delivers queued messages and the agent resumes from where it stopped; in-flight turns may show a stale progress state until the next update. (No specific dead-zone recovery code exists; this relies on Telegram's natural message delivery on reconnect.)"
- **Evidence:** No specific dead-zone detector or recovery message path in `telegram-plugin/gateway/gateway.ts`.
- **Rationale:** The long-poll naturally resumes but "sensible state, not a broken thread" is aspirational.

### Finding 9 -- archived-status-card-design:c4

- **File:** `telegram-plugin/uat/assertions.ts` L343
- **Quote:** "fleet still running, see #862 / status-card-design.md §Header"
- **Verdict:** archive-leaks
- **Proposed action:** fix-referrer
- **Proposed text:** Update the comment to cite `reference/conversational-pacing.md` instead of `status-card-design.md §Header`. Remove the `progress-card.ts` reference if present (file does not exist in active source tree).
- **Evidence:** `reference/status-card-design.md` -- 6-line stub with no §Header section; the file is explicitly archived.
- **Rationale:** Directs maintainers to a non-existent section in an archived file.

### Finding 10 -- jtbd-keep-my-subscription-honest:c3

- **File:** `reference/keep-my-subscription-honest.md` L3 (frontmatter outcome)
- **Quote:** "No hidden API billing, no side-door tokens, no asks for extra keys."
- **Verdict:** drift-minor
- **Proposed action:** update-text
- **Proposed text:** "No hidden API billing, no side-door tokens, no Anthropic API keys. Opt-in third-party service keys (e.g. OpenAI Whisper for voice transcription) are stored in the vault and clearly opt-in."
- **Evidence:** `telegram-plugin/voice-transcribe.ts` L1-L19; `src/cli/telegram.ts` L158-L164 -- Whisper opt-in requires OpenAI API key stored in vault.
- **Rationale:** Anti-patterns section's "Asking the user for an API key as 'optional'" creates tension with the Whisper opt-in key without this carve-out.

### Finding 11 -- jtbd-keep-my-subscription-honest:c5

- **File:** `docs/compliance-attestation.md` (fix-referrer from JTBD c5)
- **Quote:** Attestation dated 2026-04-25, silent on the 2026-06-15 policy split.
- **Verdict:** drift-minor
- **Proposed action:** update-text
- **Proposed text:** Add a section or update the existing text to reference: (a) the 2026-06-15 Anthropic policy (interactive vs. programmatic distinction), (b) RFC #1620 elimination of all `claude -p` callsites, (c) the one remaining tracked exception (src/host-control/server.ts deep probe, issue #1798, opt-in, off by default).
- **Evidence:** `docs/compliance-attestation.md` L7-L8 -- dated 2026-04-25; CLAUDE.md L99-L109 -- 2026-06-15 policy described.
- **Rationale:** A user auditing compliance today would find the attestation silent on the most material recent policy change.

## Out of scope for this batch

- Escalated findings for jtbd-give-each-agent-its-own-workspace (c1-c4, c10) -- those are outcome-not-realized and in escalations.md.
- contract-vision:c2 (code-violates-contract) -- in escalations.md.
- Any jtbd-restart-and-know-what-im-running findings -- all escalated.
- Any jtbd-track-plan-quota-live findings beyond the escalated ones -- all escalated.
