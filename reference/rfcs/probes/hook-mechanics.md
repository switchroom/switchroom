# Probe: hook mechanics — E-72 (async Stop recall) and E-51/E-62 (compaction re-injection)

Probed 2026-08-16 against: official docs (`code.claude.com/docs/en/hooks.md`, `context-window.md`, via claude-code-guide agent, fetched today), the **shipped CLI binary v2.1.233** (`/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`, bun-compiled ELF, strings-extracted minified JS — cites below are verbatim extracted code), and the **parent session's own transcript** (`/state/agent/.claude/projects/-home-kenthompson--switchroom-agents-klanker/2ce96d60-67c7-4ebb-a8f3-59bbdf4ded60.jsonl`), which contains 4 real auto-compactions (JSONL lines 466, 702, 1194, 1566). No live settings were touched; no `claude -p` was run.

---

## Assumption 1 — off-reply-path recall via `async: true` Stop hook (gates step 6a)

**Verdict: mechanism CONFIRMED; the timing guarantee is REFUTED. E-72's "natively express Hermes's pattern" over-claims: the queue-at-N / read-at-N+1 shape exists, but the CLI provides NO equivalent of Hermes's drain wait. We must build the join ourselves.**

### Confirmed, with evidence

1. **`async: true` exists on hooks (incl. Stop).** Docs: *"If `true`, runs in the background without blocking"* (hooks.md, Common fields). Binary schema: `async:Gt().optional().describe("If true, hook runs in background without blocking")`. Also found `asyncRewake` — *"runs in background and wakes the model on exit code 2 (blocking error). Implies async"* — with `rewakeMessage`/`rewakeSummary` (summary default "Stop hook feedback").
2. **The async hook is a real detached child process — its file writes persist.** Binary: on async dispatch the hook returns immediately with `{stdout:"",stderr:"",output:"",status:0,backgrounded:!0}` and the process is registered in a background registry (`"Hooks: Config-based async hook, backgrounding process ..."`). A buffer file it writes is ordinary filesystem state; nothing discards it.
3. **Stdout is NOT discarded — it's delivered as a next-turn attachment, late.** Docs: *"Hook output is delivered on the next conversation turn. If the session is idle, the response waits until the next user interaction."* Binary: a `checkForNewResponses` pass collects completed registry entries (`responseAttachmentSent`, `"produced no response payload — skipping attachment"`). For the buffer-file pattern this is irrelevant (we'd write a file, not stdout), but it means a noisy recall hook will ALSO dump its stdout into turn N+1 — the hook should stay silent on stdout.
4. **UserPromptSubmit default timeout = 30s: CONFIRMED.** Docs: defaults are *"600 for `command`, `http`, and `mcp_tool`"* and *"`UserPromptSubmit` lowers the `command`, `http`, and `mcp_tool` default to 30"*, rationale: *"Because this hook runs before every prompt and blocks model processing until it completes, a stuck hook stalls the session."* (E-64's 30s-window premise stands; note the general default is 600s, not 60s.)
5. **Concurrency model.** Hooks matching one event run in parallel with each other (*"All matching hooks run in parallel"*); a synchronous UserPromptSubmit blocks the model turn (quote above); an async hook runs concurrently with everything, including the next model turn.

### Refuted — the crux

**Nothing makes turn N+1 wait for the async Stop hook from turn N.** Docs, explicitly: async hooks *"can't block or control Claude's behavior"* — and the delivery-on-next-turn rule above is about delivery of output, not completion. Binary confirms: the collection pass takes completed entries and leaves running ones running; there is no join, no drain, no freshness check. **If the user replies in 2s and recall takes 8s, UserPromptSubmit at N+1 reads the PREVIOUS turn's buffer (stale) or nothing.** Hermes's `prefetch_waits_for_retain` + 3s join has no native equivalent.

Two additional rails E-72 didn't surface:

- **`asyncTimeout` default is 15000ms** (binary: `let c=r.asyncTimeout||15000` at async-hook registration). A recall pipeline slower than 15s gets killed (registry handles `status==="killed"`) unless `asyncTimeout` is raised in the hook config. Set it explicitly.
- The async process also survives session idle — but on session END its fate is unverified; don't design a cross-restart dependency on it.

### What the design must add (cost of the refuted half)

The join must live in the **UserPromptSubmit hook itself**, which is exactly where it can live: the hook is synchronous and blocks model processing, so a bounded sentinel-poll inside it (write `buffer.done` last from the Stop hook; UserPromptSubmit polls for a sentinel newer than last-consumed, capped at ~2-3s, then reads whatever exists — Hermes's 3s join, hand-rolled) gives the same guarantee within the 30s window. This is a small script change, not an architecture change, but it is OUR code providing the guarantee, not the harness — step 6a's description should say so, and the stale-buffer fallback (inject last turn's recall, marked stale, or skip) must be specified because it WILL happen on fast replies.

### Residual test that would settle the remainder

A live two-turn run with a throwaway project dir: Stop hook = `sleep 8 && date > buffer`, reply within 2s, UserPromptSubmit cats buffer + mtime. Requires an interactive session (can't be driven by a sub-agent under the no-`claude -p` rule); 5 minutes of operator time. It would convert the doc+binary conclusion above into an observed one — but doc and binary already agree, so this is confirmation, not open risk.

---

## Assumption 2 — preserved `# --- Yours ---` section re-injected after compaction (gates step 5)

**Verdict: CONFIRMED at doc + mechanism level. The E-62 worry ("does the preserved section count as unscoped?") dissolves: the unscoped/path-scoped distinction is a FILE-level distinction, not a section-level one. Claude Code has no concept of sections inside root CLAUDE.md — the whole file is one injection unit.**

### Evidence

1. **Doc quote (context-window.md, "What survives compaction"):** *"Project-root CLAUDE.md survives compaction: after `/compact`, Claude re-reads it from disk and re-injects it into the session. Nested CLAUDE.md files in subdirectories and rules with `paths:` frontmatter are not re-injected automatically; they reload the next time Claude reads a file in that subdirectory or a file matching the rule's patterns."* — "unscoped rules" means rule files without `paths:` frontmatter; "path-scoped" means `paths:` rules and nested CLAUDE.md. Sections of the root file are never distinguished.
2. **Whole-file injection observed live, this CLI version:** this probe session's own context (v2.1.233, launched today) carries the root CLAUDE.md as a single `# claudeMd` block containing the ENTIRE file — regenerated template AND the `# --- Yours ---` marker line and everything after it, verbatim. The `# --- Yours ---` marker is a switchroom `apply`-time convention; the CLI is blind to it.
3. **Empirical limit, stated honestly:** the parent session compacted 4 times (auto; JSONL lines 466/702/1194/1566, e.g. `preTokens:168556 → postTokens:11662`), but the JSONL does **not** persist the claudeMd injection (it's assembled at API-call time), so the transcript cannot directly show the post-compaction call's CLAUDE.md content. The in-situ probe the RFC named (mutate the preserved section → force `/compact` → ask the model for the mutated text) has NOT been run and remains the definitive test; it needs an interactive session and ~5 minutes. Given the doc statement is explicit and the injection is provably whole-file, step 5 is safe to gate on docs + that cheap probe as a post-migration canary rather than a precondition.

### PreCompact / PostCompact — the E-51 "undocumented" gap is now closed, and there's a better tool

- **PreCompact contract (now documented):** input = common fields + `trigger` ("manual"|"auto") + `custom_instructions` (the `/compact` argument; empty for auto). Matcher = `manual`|`auto`. It CAN block compaction (exit 2 or `"decision":"block"`; blocking an over-limit auto-compact surfaces the context-limit error and fails the request). Its `systemMessage` and `continue` are **discarded** — so PreCompact **cannot inject content** post-compaction. Not an injection vehicle.
- **PostCompact exists in v2.1.233** (absent from E-51's read). Binary schema: `hook_event_name:Tt("PostCompact"), trigger:Pr(["manual","auto"]), compact_summary:B().describe("The conversation summary produced by compaction")`. Whether PostCompact stdout/additionalContext injects into the fresh context is **unverified** — the docs pass didn't cover it. Residual test if wanted.
- **The deterministic alternative is ALREADY RUNNING in production: `SessionStart` with source `compact`.** Empirical, from the parent session, immediately after the line-1566 compaction: JSONL line 1573 is a `hook_success` attachment, `hookName:"SessionStart:compact"`, whose content begins `<compact-recovery source="switchroom working-state-reload hook"` — 14.7KB injected, persisted at `.claude/projects/-home-kenthompson--switchroom-agents-klanker/2ce96d60-.../tool-results/hook-ec96a78b-e7e7-4e62-b5f6-328936db8958-stdout.txt`. So switchroom already owns a post-compaction injection hook with documented `additionalContext` semantics (E-51: SessionStart injects via `hookSpecificOutput.additionalContext`, no documented size cap). If step 5 ever needs a belt-and-braces guarantee beyond CLAUDE.md re-read, this hook is the place — it exists, it fires, it injected 14.7KB in this very session.

---

## Deltas the ledger should absorb (not edited here — concurrent writers)

- E-72: add the refutation — no native completion guarantee; join must be self-built in UserPromptSubmit (sentinel poll); `asyncTimeout` default 15s must be raised for slow recalls; async hook stdout arrives as a next-turn attachment unless suppressed; general hook default timeout is 600s (not 60s).
- E-51: PreCompact contract now documented (blocker-capable, injection-incapable); `PostCompact` event exists in 2.1.233 with `compact_summary`; `SessionStart:compact` is the proven post-compaction injection path.
- E-62/step 5: the "does the preserved section count" question is malformed — the unit is the file, and the file is re-read whole. Keep the mutate-and-compact probe as a cheap post-step-5 canary.
