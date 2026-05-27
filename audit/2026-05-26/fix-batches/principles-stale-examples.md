# Fix batch: update stale CLI examples in principles.md

**Scope:** `reference/principles.md` only.
**Verdict pattern:** contract-example-stale (6 findings).
**Estimated edits:** medium (~40 lines across 6 example blocks).

## Findings in this batch

### Finding 1 -- contract-principles:c1

- **File:** `reference/principles.md` L38-L41
- **Quote:** "`switchroom auth login coach` prints the OAuth URL inline, says 'open this in any browser -- tokens save to this agent's CLAUDE_CONFIG_DIR, no other agent is affected,' and watches for completion."
- **Verdict:** contract-example-stale
- **Proposed action:** update-text
- **Proposed text:** Replace `switchroom auth login coach` with `switchroom auth add default --via-claude` (first-time add) or `switchroom auth reauth coach` (refresh). Drop the `CLAUDE_CONFIG_DIR` detail -- the fleet model no longer uses per-agent credential dirs as the primary framing.
- **Evidence:** `src/cli/auth.ts` L815-L820 -- `auth.command("reauth <agent>")` exists; `auth.command("login")` does not exist in the registered verbs list. RFC H removed `auth login` entirely.
- **Rationale:** `auth login` is not a registered command. The closest current verb for first-time OAuth is `switchroom auth add <label> --via-claude`; for refreshing an existing agent's session it is `switchroom auth reauth <agent>`.

### Finding 2 -- contract-principles:c2

- **File:** `reference/principles.md` L45-L50
- **Quote:** "`switchroom setup` detects that the bot's privacy mode is still on and tells the user '@CoachBot has Privacy Mode enabled ...'"
- **Verdict:** contract-example-stale
- **Proposed action:** update-text
- **Proposed text:** Replace the dynamic-detection example with what setup actually does: setup prints a static upfront instruction to disable privacy mode before adding the bot to a group. The good example should show the upfront-guidance pattern, not a detect-and-report error that is not shipped.
- **Evidence:** `src/cli/setup.ts` L293-L301; `src/setup/botfather-walkthrough.ts` L198 -- both show static advisory text, no detection logic.
- **Rationale:** No code path detects that privacy mode is currently on and surfaces the quoted dynamic error message. The example describes unshipped behavior.

### Finding 3 -- contract-principles:c4

- **File:** `reference/principles.md` L58-L62
- **Quote:** "`switchroom vault set telegram-bot-token` ... confirms encryption, and tells the user 'now reference this in switchroom.yaml as `vault:telegram-bot-token`'"
- **Verdict:** contract-example-stale
- **Proposed action:** update-text
- **Proposed text:** Update the success-message portion to match actual output: `+ Secret 'telegram-bot-token' saved`. If the principle intent is that vault set should tell the user about `vault:` syntax, either add the hint to the vault set output or update the example to show what currently ships.
- **Evidence:** `src/cli/vault.ts` L665-L668 -- success output is `+ Secret '${key}' saved` with no mention of `vault:` reference syntax.
- **Rationale:** The `vault:` reference hint is not emitted by the shipped command. Masking/prompting behaviors are accurate (L572), but the claimed success message is not.

### Finding 4 -- contract-principles:c7

- **File:** `reference/principles.md` L102-L105
- **Quote:** "`switchroom agent create exec --profile executive` inherits everything from the executive profile"
- **Verdict:** contract-example-stale
- **Proposed action:** update-text
- **Proposed text:** Replace `--profile executive` with `--profile executive-assistant`. The profile was named `executive-assistant` from the start; this is a shorthand typo in the example.
- **Evidence:** `profiles/` directory contains `executive-assistant` but not `executive`; `docs/cli-reference.md` L43 lists `executive-assistant` as the correct slug.
- **Rationale:** `--profile executive` would fail at runtime. The correct slug is `executive-assistant`.

### Finding 5 -- contract-principles:c8

- **File:** `reference/principles.md` L108-L111
- **Quote:** "The upgrade flow -- `switchroom apply` + `docker compose pull` + `docker compose up -d --remove-orphans` -- is three lines, idempotent, and the same on every host."
- **Verdict:** contract-example-stale
- **Proposed action:** update-text
- **Proposed text:** Replace the three-command example with the current single-command idiom: `switchroom update` runs pull-images, apply, docker compose up, and doctor in one step (PR #918). The three individual commands were the pre-#918 pattern.
- **Evidence:** `src/cli/update.ts` L1-L24 -- explicitly documents that `switchroom update` was introduced in #918 to replace the multi-command flow; CLAUDE.md "Operator update" section.
- **Rationale:** `switchroom update` has been the canonical single-command surface since PR #918. The example now describes a replaced pattern.

### Finding 6 -- contract-principles:c9

- **File:** `reference/principles.md` L115-L118
- **Quote:** "operator skills (`humanizer`, `buildkite-*`) stay opt-in via `defaults.skills_auto`"
- **Verdict:** contract-example-stale
- **Proposed action:** update-text
- **Proposed text:** Replace `defaults.skills_auto` with `defaults.skills` (the actual config field per `docs/skills.md` L125). Remove `buildkite-*` skills reference -- no such skills exist in the `skills/` directory.
- **Evidence:** `src/config/schema.ts` -- `skills_auto` field does not exist; `docs/skills.md` L125-L126 confirms humanizer is opt-in via `defaults.skills`.
- **Rationale:** `defaults.skills_auto` is not a real field. Using it in an example of the Defaults principle is self-defeating.

### Finding 7 -- contract-principles:c10

- **File:** `reference/principles.md` L143-L145
- **Quote:** "Every top-level CLI verb is `switchroom <noun> <verb>` -- `agent start`, `vault set`, `topics sync`, `auth login`. One shape."
- **Verdict:** contract-example-stale
- **Proposed action:** update-text
- **Proposed text:** Replace `auth login` in the example list with `auth add` or `auth reauth`. The structural claim (noun-verb shape, one file per noun) remains accurate.
- **Evidence:** `src/cli/auth.ts` L9-L16 -- no `auth login` verb; `auth add`, `auth use`, `auth reauth` exist.
- **Rationale:** `auth login` was removed by RFC H. The structural principle is correct; only the inline example needs the stale verb swapped.

## Out of scope for this batch

- Edits to `CLAUDE.md` for the JTBD count (`contract-reference-readme:c11`) -- that lives in `reference-readme-index-corrections` batch.
- Edits to `reference/README.md` -- that lives in `reference-readme-index-corrections` batch.
- Any `docs/` changes -- separate batches.
