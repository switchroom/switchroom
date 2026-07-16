# RFC: Multiple Microsoft accounts per agent, each with its own tool scope

Status: Design (read-only research, no implementation)
Extends: RFC #1873 (`reference/rfcs/microsoft-workspace.md`)
Driving requirement: one agent (Marko) must bind TWO Microsoft accounts at once —
`alice@example.com` scoped to OneDrive storage tools, and
`bob@example.com` scoped to the 4 read-only mail tools.

---

## 0. Two premises in the task that the source CONTRADICTS

Before the design, two corrections grounded in the real tree — the design is built on the
corrected facts, not the task's stated premises.

1. **There is no `ENABLED_TOOLS` / launcher tool-name regex today.** The task described
   ENABLED_TOOLS as "the tool-name regex … applied over tool names" set by the launcher.
   Grep for `ENABLED_TOOLS`/`enabledTools`/`--enabled-tools` across `src/` returns nothing
   for M365. The launcher's *only* tool gate is `--org-mode`:
   `buildSofteriaArgs` (`src/cli/m365-mcp-launcher.ts:125-130`) appends `--org-mode` and
   nothing else; `getMs365McpSettingsEntry` (`src/memory/scaffold-integration.ts:251-263`)
   emits `args: ["m365-mcp-launcher", ...orgArgs]`. So **per-account tool scoping does not
   exist yet at all** — it must be *added* by this RFC, not merely extended.

2. **Tool restriction today is a PreToolUse hook, not a launcher/OAuth gate.** M365 write
   tools are gated at call time by `src/cli/ms-365-write-pretool.ts` (RFC #1873 §8): it keys
   off the `mcp__ms-365__` tool-name prefix (`ms-365-write-pretool.ts:33`), passes verified
   read-only tools (`KNOWN_SAFE_MS365_READ_TOOLS`) and fails-closed (approval card) on writes
   and unrecognized `mcp__ms-365__*` tools. OAuth scopes are **fixed broad at consent**
   (`selectMicrosoftScopes`, `src/microsoft/scopes.ts:35-37` → `SCOPE_SET_DEFAULT` includes
   `Mail.ReadWrite` + `Files.ReadWrite.All`), confirming the task's suspicion: scope is NOT
   per-account-narrowed — a token is broad and tools are meant to be restricted downstream.

3. **Multi-account-per-agent is explicitly OUT OF SCOPE in RFC #1873** (`microsoft-workspace.md`
   §12 lines 683-684, 717-724): "Multi-account-per-agent … separate RFC", with a note to first
   read softeria's own multi-account issue ("may have rough edges in its multi-account model")
   before designing switchroom's contract. This RFC is that separate RFC.

The requirement's scope strings (`drive|upload-file|create-upload-session|download-file|…`
and the 4 read-only mail verbs) are exactly a **softeria `--enabled-tools <regex>`
alternation** (upstream softeria supports `--enabled-tools`/`MS365_MCP_ENABLED_TOOLS` +
`--read-only`). NEEDS-VERIFY against the pinned `@softeria/ms-365-mcp-server@0.113.0`
(`scaffold-integration.ts:121`) that `--enabled-tools` exists and is a regex over tool
names — softeria is npx-fetched at runtime, not vendored, so I could not read its `--help`
in this tree.

---

## 1. What exists today (single-account binding), with citations

The single-account binding is a **twin-key** contract:

- **Per-agent selector** — `agents.<name>.microsoft_workspace.account` (singular string).
  Schema: `AgentMicrosoftWorkspaceConfigSchema` (`src/config/schema.ts:2250-2279`): an object
  with `account` (email regex `^[^@\s:]+@[^@\s:]+\.[^@\s:]+$`, `.transform` → trim+lowercase,
  `.optional()`) and `org_mode` (bool, optional). Mounted at `schema.ts:3250`.
- **Top-level ACL** — `microsoft_accounts.<email>.enabled_for[]` (list of agent slugs).
  Schema: `schema.ts:4156-4181`, email-keyed record, each entry `{ enabled_for: string[] }`.
- **The "both are required" check** — the broker requires BOTH: agent's
  `microsoft_workspace.account` is set AND that account's `enabled_for[]` includes the agent.
  - Predicate: `shouldEmitMs365Mcp` (`src/config/microsoft-workspace-acl.ts:28-42`) — used by
    scaffold to decide whether to emit the `ms-365` MCP entry and by broker ACL for the vault
    client-cred grant (`isMicrosoftClientCredentialKeyForAgent`, same file:67-96).
  - Broker enforcement: `opMicrosoftGetCredentials` (`src/auth/broker/server.ts:3265-3327`):
    reads `agent.microsoft_workspace.account` (:3284); `ACCOUNT_NOT_FOUND` if unset (:3285-3294);
    `FORBIDDEN` if not in `enabled_for[]` (:3300-3309); else reads
    `readMicrosoftAccountCredentials(stateDir, account)` (:3312) →
    `state/auth-broker/microsoft/<account>/credentials.json`.
  - **Crucially, `get-credentials` carries NO account arg.** `GetCredentialsRequestSchema`
    (`src/auth/broker/protocol.ts:74-91`) has only `{v, op, id, provider?}`; the account is
    *derived server-side from config*. `client.getCredentials(provider?)`
    (`src/auth/broker/client.ts:521`) has no account param. The launcher calls
    `client.getCredentials("microsoft")` (`m365-mcp-launcher.ts:535`).
- **Launcher = one MCP process = one account, today.** `resolveMs365McpEntry`
  (`src/agents/scaffold.ts:3485-3518`) emits exactly one MCP entry keyed `ms-365`
  (`scaffold-integration.ts:257`), whose tools Claude Code namespaces as `mcp__ms-365__*`.
  The launcher spawns one softeria child in BYOT mode and refreshes it in-process
  (`runMs365McpLauncher`, `m365-mcp-launcher.ts:284-512`).
- **YAML editors** for the twin keys: `setAgentWorkspaceAccount`/`clearAgentWorkspaceAccount`
  (`src/config/agent-workspace-account.ts:34-95`, singular path
  `["agents",agent,"microsoft_workspace","account"]`) and
  `enable/disableAgentsOnMicrosoftAccount` (`src/cli/microsoft-accounts-yaml.ts`).
- **Token/scope**: `selectMicrosoftScopes(orgMode)` (`scopes.ts:35`); `microsoft_client_id`/
  `_secret` are top-level only, not per-agent (`schema.ts:2071-2117`, comment at :2247-2248).
  OAuth scopes are chosen at *consent* (`auth microsoft account add`), broad, not narrowed
  per tool.

---

## 2. Design — additive, backward-compatible

### 2.1 Config schema (zod)

Add a `tools` field and an `accounts[]` array form to
`AgentMicrosoftWorkspaceConfigSchema`, keeping the singular `account` valid.

```ts
const MicrosoftAccountBindingSchema = z.object({
  account: z.string().regex(EMAIL_RE).transform(v => v.trim().toLowerCase()),
  tools: z.array(z.string().min(1)).min(1).optional()   // softeria tool-name / regex tokens
    .describe("Per-account tool allowlist → softeria --enabled-tools. Omitted = all tools."),
  org_mode: z.boolean().optional(),
});

AgentMicrosoftWorkspaceConfigSchema = z.object({
  account:  z.string()...optional(),            // EXISTING singular — unchanged
  tools:    z.array(z.string().min(1)).min(1).optional(),  // NEW: scope for the singular form
  org_mode: z.boolean().optional(),             // EXISTING
  accounts: z.array(MicrosoftAccountBindingSchema).min(1).optional(),  // NEW plural
}).superRefine((v, ctx) => {
  const hasSingular = v.account !== undefined;
  const hasPlural   = v.accounts !== undefined;
  if (hasSingular && hasPlural)
    ctx.addIssue({ code: "custom", message:
      "microsoft_workspace: use EITHER `account` (singular) OR `accounts` (plural array), not both" });
  if (hasPlural) {
    const seen = new Set<string>();
    for (const b of v.accounts!) {
      if (seen.has(b.account))
        ctx.addIssue({ code:"custom", message:`duplicate account '${b.account}' in accounts[]` });
      seen.add(b.account);
    }
  }
  // (`tools`/`org_mode` at the block level apply to the singular form only; on the plural
  //  form they live per-binding. A block-level `tools` WITH `accounts` → error, to avoid
  //  ambiguous "which account does this scope?".)
}).optional();
```

**Coexistence / migration rule (the one-liner):** singular `account` XOR plural `accounts`;
both present → schema error. Singular `account` is interpreted as a one-element
`accounts` list `[{ account, tools?, org_mode? }]` by a `normalizeMicrosoftBindings(agentCfg)`
helper that every consumer (broker, scaffold, launcher, ACL predicate) calls — so there is
exactly one code path and the singular form can never drift from the plural one. No config
rewrite/migration is forced; existing `account:` configs keep working byte-for-byte.

### 2.2 Launcher approach — N processes, one per account (RECOMMENDED)

**Recommendation: N MCP instances (one launcher process + one softeria child per bound
account), NOT one MCP multiplexing N accounts.** Evidence:

- **softeria identifies its account by the single injected `MS365_MCP_OAUTH_TOKEN`** (BYOT,
  `SOFTERIA_TOKEN_ENV`, `m365-mcp-launcher.ts:47`, `buildSofteriaEnv:137-144`). It has no
  concept of "call tool X as account A vs B" — one process = one token = one account. A
  multiplexer would have to fork softeria per account internally anyway, i.e. N processes with
  extra plumbing.
- **Tool-name collision under multiplexing.** All of softeria's tools carry the same names
  (`download-file`, `list-mail-messages`, …). Claude Code namespaces per MCP-server key, so
  two accounts under one `ms-365` server would present two `mcp__ms-365__download-file` tools —
  the agent cannot address the right account. Distinct server keys are the natural namespace.
- **Per-account tool scope is a per-process softeria flag** (`--enabled-tools`/`--read-only`);
  N processes let each child get its own scope with zero cross-talk.
- **Blast radius**: one crash-looping account (the launcher's `#2586` backoff,
  `m365-mcp-launcher.ts:340-391`) doesn't take down the other account's tools.

**Naming / namespacing (N processes):** emit one MCP entry per binding, keyed
`ms-365-<slug>` where `<slug>` is a deterministic short label derived from the account
(local-part + hash suffix, sanitized to `[a-z0-9-]`), e.g. `ms-365-lisa-goodfellow`,
`ms-365-lisa-thinksolve`. Tools then namespace as `mcp__ms-365-lisa-goodfellow__download-file`
etc., which the agent addresses unambiguously. **Backward-compat pin:** a single-account agent
(singular `account`, or a one-element `accounts`) keeps the bare `ms-365` key so existing
`.mcp.json`, the pretool hook prefix, and habits don't break. Only 2+ bindings introduce the
`ms-365-<slug>` keys.

`resolveMs365McpEntry` becomes `resolveMs365McpEntries` (plural) returning
`{key,value}[]`; each entry's launcher args gain `--account <email>` and
`--enabled-tools <joined>` (and `--org-mode` per-binding). The
`IntegrationMcpResolver` registry (`scaffold.ts:3595+`) — which currently assumes one
key per integration — must accept a resolver that returns N keys and a set of retraction
keys; the reconcile sites that `delete` stale keys must delete all `ms-365*` keys not in the
current emit set.

### 2.3 Broker change — account-parameterized get-credentials

`get-credentials` must learn *which* account the caller wants:

- Add optional `account?: string` to `GetCredentialsRequestSchema`
  (`protocol.ts:74-91`) and `client.getCredentials(provider?, account?)` (`client.ts:521`).
- `opMicrosoftGetCredentials` (`server.ts:3265`): if `req.account` is present, validate it is
  one of the agent's bound accounts (`normalizeMicrosoftBindings(agent).some(b => b.account===req.account)`)
  AND `microsoft_accounts[req.account].enabled_for[]` includes the agent (the existing
  `enabled_for` gate, :3300, now per requested account); then read that account's
  credentials.json. If `req.account` absent → current single-account behavior (back-compat).
  Both a missing binding and an ACL miss keep their existing error codes
  (`ACCOUNT_NOT_FOUND` / `FORBIDDEN`) so nothing silently downgrades.
- The launcher passes its `--account` value into `getCredentials("microsoft", account)`.

### 2.4 Two-part-binding validation, array form

Add cross-field validation (alongside `shouldEmitMs365Mcp`): for the plural form, **every**
`accounts[].account` must have `microsoft_accounts.<account>.enabled_for[]` containing the
agent — else a load-time config error naming the offending `(agent, account)` pair (mirror the
broker's FORBIDDEN message so operators get the same `switchroom auth microsoft enable …`
hint). `shouldEmitMs365Mcp` gains a plural sibling `bindingsForAgent(agentName, agentCfg,
microsoftAccounts)` returning the subset of bindings that pass the twin-key gate; scaffold
emits one MCP entry per passing binding (and none for a binding whose ACL is missing — same
"emit iff enabled" semantics as today, per-account).

### 2.5 ENABLED_TOOLS (per account)

Thread each binding's `tools[]` into the launcher as `--enabled-tools <regex>` (joined with
`|`) and/or `--read-only` when the token set is exactly softeria's read-only subset. Because
the OAuth token is broad (scopes fixed at consent), tool scope is enforced at the softeria
process, **and** the existing PreToolUse write-gate (`ms-365-write-pretool.ts`) still runs.
Update that hook's prefix match from the literal `mcp__ms-365__` to `mcp__ms-365(-[a-z0-9-]+)?__`
so it continues to gate writes on the per-account server keys (otherwise multi-account write
tools would sail through un-gated — a fail-open regression).

### 2.6 Apply / reconcile / restart implications

- Config schema + broker + scaffold changes ship in the switchroom build. Editing an agent's
  `microsoft_workspace.accounts` is a `switchroom.yaml` edit → needs
  `switchroom apply`/reconcile to rewrite the agent's `.mcp.json`/`settings.json` (new
  `ms-365-<slug>` MCP entries) and then an **agent container restart** to pick up the new MCP
  server set (same as any MCP-entry change today). The broker re-reads config on its own
  boot/reload; the `get-credentials` account param is runtime, no restart needed on the broker
  beyond loading the new build.
- Backward-compat: agents on singular `account` get byte-identical output (bare `ms-365` key,
  no `--account`, `get-credentials` with no account param).

---

## 3. Test plan (assert OUTCOMES)

Existing coverage of the singular path to keep green:
`src/config/microsoft-workspace-acl.test.ts` (`shouldEmitMs365Mcp` 9 cases,
`isMicrosoftClientCredentialKeyForAgent`); `src/cli/m365-mcp-launcher.test.ts`
(`buildSofteriaArgs` org-mode on/off, `buildSofteriaEnv`, refresh timing, `runMs365McpLauncher`
spawns one child); `src/config/agent-workspace-account.test.ts`;
`src/cli/microsoft-accounts-yaml.test.ts`; broker `server-microsoft.test.ts`.

New tests:
1. **Schema accept/reject** — accept singular `account`; accept plural `accounts:[{account,tools},…]`;
   reject BOTH present; reject duplicate account in `accounts[]`; reject block-level `tools`
   together with `accounts`; reject empty `accounts:[]` and empty `tools:[]`. Assert the specific
   `superRefine` messages.
2. **normalizeMicrosoftBindings** — singular → one-element list identical to explicit
   one-element plural (the drift guard).
3. **Scaffold emits N entries** — 2 bound+enabled accounts → two MCP keys `ms-365-<slugA>`,
   `ms-365-<slugB>` with distinct `--account`/`--enabled-tools`; 1 account → bare `ms-365`
   key (back-compat). A binding whose account lacks the agent in `enabled_for[]` → NOT emitted.
4. **Per-account tool scoping** — `buildSofteriaArgs` includes `--enabled-tools <joined>` for a
   binding with `tools`, omits it when `tools` absent; storage binding gets the OneDrive verbs,
   mail binding gets the 4 read verbs (assert exact arg array).
5. **Launcher spawns per account with the right token** — `runMs365McpLauncher` with
   `--account X` calls `getCredentials("microsoft", "X")` and injects THAT account's token
   (assert the account threaded into the broker stub, and the env token).
6. **Broker mismatch validation** — `get-credentials` with `account` not in the agent's
   bindings → `ACCOUNT_NOT_FOUND`; account bound but agent not in `enabled_for[]` → `FORBIDDEN`;
   valid pair → returns that account's creds (assert the returned `account` field).
7. **Two-part array validation** — load config where one of two `accounts[]` is missing from
   `enabled_for[]` → load-time error naming that pair.
8. **PreToolUse prefix** — `mcp__ms-365-lisa-goodfellow__delete-file` is still gated
   (fail-closed) by the updated prefix regex; a read tool passes.

---

## 4. Red-team of this design

- **Same account listed twice in `accounts[]`** → collides on slug/server-key and doubles
  softeria processes. Handled: `superRefine` duplicate-account reject (test 1).
- **Account in `accounts[]` but not in `enabled_for[]`** → an emitted MCP entry whose broker
  fetch would `FORBIDDEN`, giving the agent a dead tool namespace. Handled: scaffold emits
  per-binding **iff** the twin-key gate passes (§2.4), so a non-enabled binding produces no MCP
  entry; plus a load-time validation error (test 7) so the operator sees the misconfig loudly
  rather than a silent missing tool.
- **Token missing for one of N** (`credentials.json` absent for one account) → that launcher's
  initial `fetchCreds` fails and it exits 1 (`m365-mcp-launcher.ts:479-483`); Claude Code shows
  that one `ms-365-<slug>` server as failed while the other account's tools keep working. The N-process
  design contains the failure; a multiplexer would have risked taking both down. Doctor/heartbeat
  must become per-account: `heartbeatPath` (`m365-mcp-launcher.ts:195-201`) is currently a single
  fixed path `/state/agent/m365-launcher.heartbeat.json` — with N launchers they'd clobber each
  other; make it `m365-launcher-<slug>.heartbeat.json` and teach the PR-5 doctor probe to read all.
  **This is a concrete must-fix, not optional.**
- **One softeria crashes** → per-process `#2586` crash-loop backoff already isolates it
  (`m365-mcp-launcher.ts:340-391`); the other account is unaffected (N-process win).
- **Slug collision** (two different emails mapping to the same sanitized slug, e.g.
  `lisa@a.com` vs `lisa@b.com` both → `ms-365-lisa`) → append a short stable hash of the full
  email to the slug; assert uniqueness across an agent's bindings at scaffold time (fail loud).
- **Broad OAuth scope vs narrow tool scope** — `tools` restricts the *tool surface*, but the
  token still carries `Mail.ReadWrite`/`Files.ReadWrite.All`. A read-only mail binding is
  read-only only because softeria isn't given the write tools + the PreToolUse gate blocks
  writes — NOT because the token can't write. Acceptable for v1 (matches today's model) but
  document it: true least-privilege at the token level needs per-account scope-at-consent,
  which is a larger change (re-consent flow) and explicitly deferred.
- **PreToolUse fail-open regression** — the biggest correctness risk: if the hook's prefix
  isn't widened to the `ms-365-<slug>` keys, every multi-account write tool bypasses the
  approval card. Covered by §2.5 + test 8; call it out as a merge-blocker.
- **Registry single-key assumption** — `IntegrationMcpResolver` and the 4 mcpServers-assembly
  sites (`scaffold.ts` comment :3567-3593) assume one key per integration; the plural resolver
  and multi-key retraction must be handled at every site or stale `ms-365-<slug>` entries leak
  across reconciles when bindings shrink.

---

## 5. Concrete config for the driving requirement

```yaml
agents:
  marko:
    microsoft_workspace:
      accounts:
        - account: alice@example.com
          tools: [drive, upload-file, create-upload-session, download-file, delete-file, list-drives]
        - account: bob@example.com
          tools: [list-mail-messages, get-mail-message, list-mail-folders, search-mail]  # 4 read-only
microsoft_accounts:
  alice@example.com:
    enabled_for: [marko]
  bob@example.com:
    enabled_for: [marko]
```
(Exact softeria tool-name tokens are NEEDS-VERIFY against `@softeria/ms-365-mcp-server@0.113.0`.)
