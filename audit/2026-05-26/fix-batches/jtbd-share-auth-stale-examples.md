# Fix batch: fix stale auth verb examples in jtbd-share-auth-across-the-fleet.md

**Scope:** `reference/share-auth-across-the-fleet.md` only.
**Verdict pattern:** jtbd-stale-example (3), drift-major (2), drift-minor (3).
**Estimated edits:** medium (~20 lines across Decision 2, Decision 6, Decision 10, and UAT prompt sections).

Note: the JTBD body is marked historical (it documents the pre-RFC-H problem statement and design). These fixes update specific stale examples within the historical body to avoid misleading readers who pick up the wrong behavior from the "Signs it's working" and UAT sections, which are not clearly scoped as historical.

## Findings in this batch

### Finding 1 -- jtbd-share-auth-across-the-fleet:c4

- **File:** `reference/share-auth-across-the-fleet.md` L62-L63 ("Signs it's working")
- **Quote:** "Adding a second, third, or sixth agent to the same Anthropic account does not require any OAuth flow. The user runs `switchroom auth enable <account> <agent>` and the agent comes up authenticated."
- **Verdict:** jtbd-stale-example
- **Proposed action:** update-text
- **Proposed text:** Replace `switchroom auth enable <account> <agent>` with: "The user runs `switchroom auth use <label>` (to set the fleet account) and restarts the agent; no new OAuth flow is needed."
- **Evidence:** `src/cli/auth.ts` L465-L803 -- no `auth enable` verb exists. Current fleet-wide verb is `auth use <label>`; per-agent edge case is `auth agent override <agent> <label>`.
- **Rationale:** `auth enable` does not exist. A user following this example would get a command-not-found error.

### Finding 2 -- jtbd-share-auth-across-the-fleet:c7

- **File:** `reference/share-auth-across-the-fleet.md` L68-L69 ("Signs it's working")
- **Quote:** "A cron-launched `claude -p` invocation in an agent's directory uses the same fresh token as that agent's main process."
- **Verdict:** jtbd-stale-example
- **Proposed action:** update-text
- **Proposed text:** "A cron-scheduled task fires via inject_inbound and uses the same account as the main process -- same broker mirror, no 401s, no env-var hand-offs."
- **Evidence:** CLAUDE.md L99-L109 -- `claude -p` is now a constraint violation (programmatic usage, separate credit); `docs/rfcs/eliminate-claude-p.md` L1-L5 -- RFC for eliminating all `claude -p` callsites.
- **Rationale:** `claude -p` is now explicitly forbidden. Showing it as a positive example in "Signs it's working" contradicts the core subscription-honest constraint and could mislead future code additions.

### Finding 3 -- jtbd-share-auth-across-the-fleet:c8

- **File:** `reference/share-auth-across-the-fleet.md` L70-L71 ("Signs it's working")
- **Quote:** "When an account hits the 5-hour cap, every agent using that account fails over to the next account on its preference list within seconds"
- **Verdict:** drift-minor
- **Proposed action:** update-text
- **Proposed text:** Replace "the next account on its preference list" with "the next account in `auth.fallback_order`".
- **Evidence:** `src/auth/broker/server.ts` L1592-L1609 -- `fanoutFailoverFor` uses the fleet-wide `auth.fallback_order`, not a per-agent preference list.
- **Rationale:** "Its preference list" implies per-agent ordering which does not exist. Fallback ordering is fleet-wide.

### Finding 4 -- jtbd-share-auth-across-the-fleet:c9

- **File:** `reference/share-auth-across-the-fleet.md` L78-L79
- **Quote:** "Removing an account is a single explicit action, refused while any agent is still enabled on it."
- **Verdict:** drift-minor
- **Proposed action:** update-text
- **Proposed text:** "Removing an account is a single explicit action, refused while it is the fleet active account or the override target for any agent."
- **Evidence:** `src/auth/broker/server.ts` L1138-L1149 -- refusal checks `auth.active` and `agents[*].auth.override`; there is no per-agent "enabled on" tracking.
- **Rationale:** "While any agent is still enabled on it" suggests per-agent enabled/disabled tracking that does not exist.

### Finding 5 -- jtbd-share-auth-across-the-fleet:c10

- **File:** `reference/share-auth-across-the-fleet.md` L142-L149 (Decision 2)
- **Quote:** "Agents are consumers, not owners. An agent declares an ordered list of accounts it can use, in `switchroom.yaml`: `agents: foo: auth: accounts: [work-pro, personal-max]`"
- **Verdict:** drift-major
- **Proposed action:** update-text
- **Proposed text:** Replace the YAML example with: `agents: foo: {} # inherits fleet active` (common case) or `agents: klanker: auth: override: work # edge case: pin to specific account`. The `auth.accounts: [...]` per-agent list was the pre-RFC-H schema and is migrated away on install.
- **Evidence:** `src/config/schema.ts` L1263-L1280 -- per-agent auth block has only `override: string`; `src/auth/migrate-schema.ts` -- in-place upgrade from the old `auth.accounts` list shape.
- **Rationale:** The YAML example in Decision 2 would be migrated away by `migrate-schema.ts`. Showing it as current encourages a configuration pattern that no longer works.

### Finding 6 -- jtbd-share-auth-across-the-fleet:c13

- **File:** `reference/share-auth-across-the-fleet.md` L177-L181 (Decision 6)
- **Quote:** "Drop the per-agent slot pool entirely. The `<agentDir>/.claude/accounts/<slot>/` directory tree ... all go away."
- **Verdict:** drift-minor
- **Proposed action:** update-text
- **Proposed text:** Add a note: "(Note: `src/auth/accounts.ts` is retained for back-compat and migration paths only; it is not the active runtime path.)"
- **Evidence:** `src/auth/accounts.ts` L1-L16 -- explicitly marked `LEGACY (post-RFC-H) ... retained for back-compat and migration paths only`.
- **Rationale:** "All go away" overstates the cleanup. The file ships; it is just legacy.

### Finding 7 -- jtbd-share-auth-across-the-fleet:c14

- **File:** `reference/share-auth-across-the-fleet.md` L206-L215 (Decision 10)
- **Quote:** "No migration shipped. This is a new-install design ... no `switchroom auth migrate` verb, no legacy slot-pool code paths kept 'for now,' no compatibility shims."
- **Verdict:** drift-major
- **Proposed action:** update-text
- **Proposed text:** Replace with: "No migration CLI verb shipped. However, `src/auth/migrate-schema.ts` provides an in-place YAML upgrade algorithm (tested against three fixture shapes) that schema comments say runs on first `switchroom apply`. Legacy slot-pool code (`src/auth/accounts.ts`) is retained for back-compat."
- **Evidence:** `src/auth/migrate-schema.ts` L1-L56 -- shipped and tested migration algorithm; `src/auth/accounts.ts` L1-L16 -- explicitly retained.
- **Rationale:** Decision 10 says "no migration shipped" but a migration algorithm exists in the repo. The distinction the RFC authors intended (no CLI verb, no shims for new schema shape) is accurate, but the current text is literally false.

### Finding 8 -- jtbd-share-auth-across-the-fleet:c16

- **File:** `reference/share-auth-across-the-fleet.md` L265-L266 (UAT prompt)
- **Quote:** "Read the output of `switchroom auth account list`. Does it show your accounts and which agents use each, on one screen?"
- **Verdict:** jtbd-stale-example
- **Proposed action:** update-text
- **Proposed text:** "Read the output of `switchroom auth show`. Does it show your accounts and which agents use each, on one screen?"
- **Evidence:** `src/cli/auth.ts` L589-L605 -- `auth show [agent]` and `auth list` exist; `auth account list` does not.
- **Rationale:** `switchroom auth account list` is not a registered command. A UAT engineer following this prompt would get an error.

### Finding 9 -- jtbd-share-auth-across-the-fleet:c18

- **File:** `reference/share-auth-across-the-fleet.md` L279-L280 (UAT prompt)
- **Quote:** "Migrate from a per-agent-slot install. Did you have to re-`claude setup-token` any account, or did the existing tokens carry over?"
- **Verdict:** drift-minor
- **Proposed action:** update-text
- **Proposed text:** Add a note: "Requires an explicit `switchroom apply` to trigger the in-place schema upgrade in `src/auth/migrate-schema.ts`."
- **Evidence:** `src/auth/migrate-schema.ts` exists but is not imported from any production code path. Whether the migration actually runs depends on wiring not confirmed in scope.
- **Rationale:** The UAT prompt assumes seamless migration. The wiring is uncertain; flagging that an explicit apply is required is safer than leaving the prompt ambiguous.

## Out of scope for this batch

- Edits to `reference/principles.md` for `auth login` in the consistency-test example (c10) -- that is in `principles-stale-examples` batch.
