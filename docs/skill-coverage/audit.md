# Switchroom skill bundle audit

Companion to `inventory.md`. Read that first — this file references skills by the exact names there.

This audit feeds the probabilistic skill-coverage harness. Verdicts are biased toward "what will the fuzzer actually fire on?" rather than reading the SKILL.md charitably.

> The estimates in §5 are *predictions* (the harness has not been
> live-run end-to-end against a real agent here); read them as relative
> risk ordering, not measured precision/recall.

## 1. Executive summary

- **Pervasive missing negatives.** Many skills carry `no-negatives` — `humanizer`, `humanizer-calibrate`, `mcp-builder`, `pdf`, `pptx`, `telegram-test-harness`, `webapp-testing`. Adjacent-but-wrong phrasings will rubber-stamp a fire. The most exposed are the `pdf` / `pptx` / `webapp-testing` set.
- **Switchroom-internal cluster is the cleanest negative-control discipline in the bundle** (`switchroom-cli`, `switchroom-status`, `switchroom-manage`, `switchroom-install`, `switchroom-architecture` all cite the rivals to defer to). The harness should expect ≥0.9 F1 there.
- **`humanizer-calibrate`, `webapp-testing`, `mcp-builder` are likely under-triggers** — descriptions are abstract, no plain-language utterance enumeration. Will miss natural phrasings.
- **`switchroom-runtime` cannot be fully NL-fuzzed.** Three of its five gates are side-channel signals (env var, sentinel file) — the harness must label those triggers as non-NL.
- **Gaps:** no skill owns vault unlock flow, broker/socket recovery, `/restart` self-restart troubleshooting, agent-scheduler debugging, or progress-card editing. Operators will land in `switchroom-health` (too generic) or `file-bug` (too late). See §4.

## 2. Per-skill audit

### docx
- **Status:** OK
- **Trigger coverage assessment:** Extension-keyed + intent words ("Word doc", "report as docx"). Fires precisely.
- **Negative-control assessment:** Explicit and correct. "Do NOT use for PDFs, spreadsheets, Google Docs..." is the exemplar pattern.
- **Execution coverage assessment:** Concrete — pandoc + docx-js + python-docx workflows named.

### file-bug
- **Status:** OK
- **Trigger coverage assessment:** Strong intent triggers ("file a bug", "open an issue"). Symptom-shaped phrasings handled too.
- **Negative-control assessment:** Explicit anti-pattern section (no thin descriptions, no invented log lines, no mid-debug filing). Exemplar.
- **Execution coverage assessment:** Concrete — six-phase forced workflow with named bash commands.

### humanizer
- **Status:** NEEDS-FIX
- **Trigger coverage assessment:** Will fire on "make this sound human" but may miss "edit my text", "rewrite this draft" — abstract verb phrasings without "AI" in them.
- **Negative-control assessment:** Missing. Most plausible false-positive: *"can you proofread this paragraph"* — generic editing, not de-AI-ification.
- **Execution coverage assessment:** Body is an anti-pattern catalog + rewrite workflow; concrete enough but no single deliverable shape.
- **Recommended fix:** Add "Do NOT use for proofreading, grammar fixes, or style edits where the input wasn't AI-generated. This skill specifically removes AI tells."

### humanizer-calibrate
- **Status:** NEEDS-FIX
- **Trigger coverage assessment:** Description mentions a slash-command but won't fire on natural phrasings like "build a voice profile from my messages" or "tune the humanizer to my style". Flagged `no-triggers` in inventory.
- **Negative-control assessment:** Missing. Most plausible false-positive: *"make this sound like me"* — could mis-fire onto `humanizer` instead.
- **Execution coverage assessment:** Concrete — MCP tool calls + voice-template write path named.
- **Recommended fix:** Enumerate NL phrasings: "build my voice template", "calibrate humanizer to my style", "fresh voice profile from my Telegram". Add "Do NOT use for one-shot rewrites — that's `humanizer`."

### mcp-builder
- **Status:** NEEDS-FIX
- **Trigger coverage assessment:** "Build an MCP server" fires cleanly. Misses "add a tool to my MCP", "wrap this API as MCP" implicitly.
- **Negative-control assessment:** Missing. Most plausible false-positive: *"create a new skill"* — sibling meta-skill `skill-creator` should win, but no explicit deferral.
- **Execution coverage assessment:** Four-phase workflow but body-heavy and prose-shaped, not deliverable-shaped.
- **Recommended fix:** Add "Do NOT use for skill authoring (that's `skill-creator`) or client-side MCP wiring."

### pdf
- **Status:** NEEDS-FIX
- **Trigger coverage assessment:** Extension-keyed; fires on any `.pdf` mention.
- **Negative-control assessment:** Missing. Most plausible false-positive: *"generate a report"* (no extension given) — could route to `docx`, `pptx`, or here ambiguously.
- **Execution coverage assessment:** Concrete — pypdf/pdfplumber/reportlab/pdftotext.
- **Recommended fix:** Add explicit "Do NOT use for Word, slides, or spreadsheet deliverables — `.pdf` must be the input or output." (Trivial fix, large precision win in fuzz.)

### pptx
- **Status:** NEEDS-FIX
- **Trigger coverage assessment:** Fires on "deck", "slides", "presentation", ".pptx". Strong.
- **Negative-control assessment:** Missing. Most plausible false-positive: *"draft a one-pager presentation as a Word doc"* — "presentation" trigger will grab it despite the deliverable being `.docx`.
- **Execution coverage assessment:** Concrete — python-pptx + pptxgenjs + design QA loop.
- **Recommended fix:** Add "Do NOT use when the deliverable is `.docx`, `.pdf`, or a non-slide format, even if the user says 'presentation'."

### skill-creator
- **Status:** OK
- **Trigger coverage assessment:** Clear verb-set ("create a skill", "optimize a skill"). Fires only on meta-skill work.
- **Negative-control assessment:** Implicit (verbs are skill-specific). Missing explicit but low risk.
- **Execution coverage assessment:** Concrete — scaffolding + parallel eval runs.

### switchroom-architecture
- **Status:** OUT-OF-SCOPE-FOR-HARNESS
- **Trigger coverage assessment:** `user-invocable: false` per inventory; explainer-only, no Bash. Triggers are conceptual single words ("architecture"). Don't NL-fuzz.
- **Negative-control assessment:** Has explicit deferral to `switchroom-install` — good.
- **Execution coverage assessment:** Read-only prose, by design.

### switchroom-cli
- **Status:** OK
- **Trigger coverage assessment:** Exhaustive verb list with synonyms ("bounce", "kick", "it's stuck"). Will fire reliably.
- **Negative-control assessment:** Explicit three-way deferral (manage / install / health). Highest disambiguation hygiene in the inventory.
- **Execution coverage assessment:** Concrete Bash surface for every verb.

### switchroom-health
- **Status:** OK
- **Trigger coverage assessment:** Strong on diagnostic phrasings ("my agents are broken", "diagnose", "what's wrong"). Cleanly distinguished from `switchroom-cli logs` ("specific crash" vs generic failure).
- **Negative-control assessment:** Explicit prefer-this-over-logs clause; cites sibling.
- **Execution coverage assessment:** Concrete — `switchroom doctor --json` + named fallback probes.

### switchroom-install
- **Status:** OK
- **Trigger coverage assessment:** Onboarding phrasings well-covered ("first-time setup", "I'm new", "bootstrap from scratch").
- **Negative-control assessment:** Explicit "not for managing existing agents → switchroom-manage".
- **Execution coverage assessment:** Concrete — six-step bootstrap with named commands.

### switchroom-manage
- **Status:** OK
- **Trigger coverage assessment:** Fleet-level verbs enumerated. "Reinstall my agents" disambiguated against `switchroom-install` explicitly — load-bearing.
- **Negative-control assessment:** Explicit.
- **Execution coverage assessment:** Concrete — Bash table mapping verbs to `switchroom agent <verb>`.

### switchroom-runtime
- **Status:** OK (with caveat)
- **Trigger coverage assessment:** Five gated protocols. Triggers 1 and 2 are side-channel (env var / sentinel file) — **harness must label these non-NL**; triggers 3–5 are NL ("why did you restart?", "how do I cancel", "still there?") and concrete.
- **Negative-control assessment:** Explicit — "Do NOT invoke for normal Telegram conversation, formatting, voice/sticker, MCP tool questions, persona". Strong.
- **Execution coverage assessment:** Concrete — file reads + Bash + journal/container log probes per protocol.

### switchroom-status
- **Status:** OK
- **Trigger coverage assessment:** "What agents are running" / "list agents" fires reliably.
- **Negative-control assessment:** Explicit two-way deferral (version → `switchroom-cli`; broken → `switchroom-health`).
- **Execution coverage assessment:** Concrete — mandates literal `switchroom agent list` invocation.

### telegram-test-harness
- **Status:** NEEDS-FIX
- **Trigger coverage assessment:** Strong on testing intents ("test progress card", "mock the bot api"). Fires on the named harness fixtures.
- **Negative-control assessment:** Missing. Most plausible false-positive: *"how do I render the progress card in production"* — fires on "progress card" but is a runtime concern (no skill owns this today — see §4).
- **Execution coverage assessment:** Concrete — defers to HARNESS.md but names the fake-bot-api / update-factory entry points.
- **Recommended fix:** Add "Do NOT use for live progress-card behavior or telegram-plugin runtime questions — this is strictly for writing Bun tests under `telegram-plugin/tests/`."

### token-helpers
- **Status:** OUT-OF-SCOPE-FOR-HARNESS
- **Trigger coverage assessment:** Library skill with empty `trigger_phrases`. Explicitly "not directly by the user". Harness must label non-target.
- **Negative-control assessment:** Has the library-skill clause.
- **Execution coverage assessment:** Concrete — two named shell scripts.

### webapp-testing
- **Status:** NEEDS-FIX
- **Trigger coverage assessment:** Short description (~250 chars), no enumerated NL phrasings. Will fire on "Playwright" or "test local web app" but miss "click through my UI", "automate this dashboard", "snapshot the frontend".
- **Negative-control assessment:** Missing. Most plausible false-positive: *"test the telegram bot"* — both are "test" verbs; needs explicit cross-deferral to `telegram-test-harness`.
- **Execution coverage assessment:** Concrete — `with_server.py` + Playwright scripts.
- **Recommended fix:** Enumerate NL triggers; add "Do NOT use for Bot-API tests (`telegram-test-harness`), CLI tests (vitest under `tests/`), or non-web UI testing."

### xlsx
- **Status:** OK
- **Trigger coverage assessment:** Extension + casual phrasings ("the xlsx in my downloads") covered. Strong.
- **Negative-control assessment:** Explicit ban on Word / HTML / Python-script / DB-pipeline / Sheets-API deliverables. Exemplar.
- **Execution coverage assessment:** Concrete — pandas + openpyxl + xlsxwriter standards.

## 3. Overlap clusters

### Cluster A: switchroom-cli vs switchroom-health vs switchroom-status vs switchroom-manage vs switchroom-install
- **Conflict:** Five-way fleet-of-skills cluster. The bundle already does the heavy lifting via cross-deferrals; harness just needs to score against the documented rules.
- **Competing skills:** all five.
- **Disambiguation rule for the harness:**
  - "Bootstrap / first install / fresh machine / new to switchroom" → `switchroom-install`
  - "Add agent / remove agent / reinstall agents / list my agents" → `switchroom-manage` (note: "reinstall *agents*" ≠ "reinstall *switchroom*")
  - "Broken / diagnose / health check / something's wrong" generic → `switchroom-health`
  - "What agents are running / uptime / how long has X been up" → `switchroom-status`
  - All other runtime verbs against existing agents (logs, restart, update, version, apply, cron) → `switchroom-cli`

### Cluster B: humanizer vs humanizer-calibrate
- **Conflict:** Both touch voice / style of writing. Calibrate produces a template; humanizer applies edits.
- **Competing skills:** `humanizer`, `humanizer-calibrate`.
- **Disambiguation rule:** "Make this text sound human / remove AI tells / rewrite this draft" → `humanizer`. "Build / refresh my voice profile / sound like *me* (no specific text in hand)" → `humanizer-calibrate`. Slash-prefix `/humanizer-calibrate` always wins for calibrate.

### Cluster C: switchroom-runtime vs file-bug
- **Conflict:** Inventory flags `overlap:file-bug` on `switchroom-runtime`. The "status?" UX-failure handler offers to file an RCA via `/file-bug`.
- **Disambiguation rule:** Runtime is the *handler* for the UX-failure signal; if the user explicitly says "file a bug" → `file-bug` wins. If the user sends bare "status?" / "still there?" → `switchroom-runtime` wins and may then chain to `file-bug` as a follow-up offer.

## 4. Gaps — common agent needs without a skill

1. **Vault unlock flow / auto-unlock recovery.** Operators routinely hit "broker is locked, what now?" — `switchroom vault broker unlock`, `enable-auto-unlock`, interactive unlock from a Telegram DM. `switchroom-health` will *detect* the lock but not own the unlock recipe. Currently falls between `switchroom-cli` and `switchroom-health`.
2. **Self-restart / `/restart` troubleshooting.** The CLAUDE.md describes a load-bearing detached-spawn + restart-marker dance. When `/restart`, `/new`, `/reset`, or `/update apply` from Telegram doesn't return a boot card, the operator needs a recipe to read the restart marker, check the sweep, and confirm the detached spawn fired. No skill owns this.
3. **Broker / kernel socket recovery.** Path-as-identity model: a missing `/run/switchroom/broker/<agent>/sock` after a recreate is a known failure mode. The canonical question "how do I reset the broker socket for agent X" has no skill — operators end up in `switchroom-health`'s doctor sweep, which reports but doesn't fix.
4. **Agent-scheduler (in-container cron) debugging.** Phase-4 fold-in introduced `/state/agent/scheduler.jsonl`, the boot replay window, and the `SWITCHROOM_INLINE_SCHEDULER=0` kill-switch. "My cron didn't fire" is a JTBD; `switchroom-cli` lists schedules but doesn't debug them.
5. **Progress-card editing / rendering.** Telegram-plugin's pinned progress card is the headline feature. `telegram-test-harness` only covers writing *tests* for it; no skill covers reading the current card state or editing the renderer/templates for a live agent.
6. **Hostd / host-control daemon ops.** New separate compose project (per CLAUDE.md memory). `switchroom hostd install`, `switchroom update`'s hostd refresh path, and "why is hostd unhealthy" diagnostics — no skill owns the hostd surface yet, and the canonical CLAUDE.md flags it as load-bearing for `/update apply` on docker hosts.

## 5. Threshold-prediction

Predictions are for *as-is* skills (no fixes applied) against ≥0.9 F1 / ≥0.95 execution success.

| Skill | Predicted F1 ≥0.9? | Predicted exec ≥0.95? | Rationale |
|---|---|---|---|
| humanizer | Borderline (≈0.85) | Yes | Generic-editing phrasings will false-positive. |
| humanizer-calibrate | No (≈0.55) | Yes | `no-triggers` flag — natural utterances will route to `humanizer`. Almost certainly misses threshold. |
| mcp-builder | Borderline (≈0.80) | Borderline | Body is prose-shaped; deliverable not crisp. Could miss exec threshold on first-shot scaffolding. |
| pdf | Yes (≈0.92) | Yes | Extension-keyed precision saves it despite missing negatives. |
| pptx | Borderline (≈0.85) | Yes | "Presentation" trigger leaks into docx territory. |
| telegram-test-harness | Borderline (≈0.85) | Yes | "Test progress card" phrasing ambiguous with live-runtime questions. |
| webapp-testing | No (≈0.65) | Yes | `short, no-triggers, no-negatives` triple-flag. Almost certainly misses threshold; will under-fire on natural NL utterances and over-fire on generic "test" phrasings.

**Likely-to-miss-threshold-even-after-fixes if not also expanded:** `humanizer-calibrate` and `webapp-testing`. Both need real trigger enumeration, not just a negative clause, because the *positive* coverage is thin.
