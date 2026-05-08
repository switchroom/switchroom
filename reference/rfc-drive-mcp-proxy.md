# RFC: Drive MCP per-op approval proxy

| Field    | Value |
| -------- | ----- |
| Status   | Draft — awaiting Ken sign-off |
| Author   | klanker (research sub-agent) |
| Date     | 2026-05-09 |
| Depends  | RFC B (approval kernel), RFC C (gdrive integration), RFC docker-multi-container (compose substrate) |
| Supersedes | none |

## Summary

Today the agent talks straight to upstream `mcp-gdrive` over stdio. Switchroom's only chokepoint is **connect-time** approval (`src/drive/onboarding.ts`). Once the user picks "Allow my Drive (read-only)" at onboarding, every subsequent `files.get` / `files.list` / `files.create` is invisible — no per-call approval, no audit trail, no scope narrowing.

The scope grammar to fix this already exists (`src/drive/grants.ts` — `doc:gdrive:**`, `doc:gdrive:write:**`, `doc:gdrive:folder/<id>/**`, plus `canFulfill()`), but no caller in the request path consults it. This RFC specs a thin **MCP-in-front-of-MCP proxy** that sits between the agent and `mcp-gdrive`, classifies every method call into `{scope, action}`, asks the kernel, and either passes through, prompts, or denies.

## Design

### 1. Where the proxy runs — recommend (c) per-agent stdio child of the agent

Three options were considered:

- **(a) Sidecar container** — clean, but adds another container per agent on a fleet that's already at 3 (agent / broker / kernel). Compose generator gets messier; lifecycle is tied to docker-compose health rather than the agent process.
- **(b) Extend the broker** — the broker is becoming the everything daemon. Drive isn't authz/IPC, it's a domain proxy. Wrong shape.
- **(c) Per-agent stdio child** — the proxy is **just another MCP server entry in `.mcp.json`**, spawned by `claude` as a child of the agent process, exactly like the telegram gateway and hindsight today (see `compose.ts:125-130`). The proxy itself spawns `mcp-gdrive` as ITS child. Lifecycle is automatic: when the agent dies, the proxy dies, the upstream dies. No compose changes.

**Recommendation: (c).** It composes with the existing MCP supervisor model, requires zero docker work, and matches how every other MCP tool is wired today. The proxy ships as `src/drive/proxy/` and is invoked by replacing the `mcp-gdrive` line in the per-agent `.mcp.json` with `switchroom drive proxy --agent <name>`.

### 2. How upstream `mcp-gdrive` is discovered — recommend (a) child of the proxy

**(a) Spawn upstream as a child of the proxy.** Long-running shared upstreams (b) save ~50ms of startup and a few MB of RAM but introduce cross-agent fate-sharing and a new daemon to supervise. Per-agent upstream children are the simpler model and match every other MCP server we ship.

The proxy holds an stdio pipe pair to upstream and forwards JSON-RPC frames bidirectionally, intercepting `tools/call` requests for classification.

### 3. Request parser strategy — hybrid table + arg inspection

`mcp-gdrive` exposes a fixed tool surface (per its README: `gdrive_search`, `gdrive_read_file`, `gsheets_read`, `gsheets_update_cell`, `gdocs_read`, `gdocs_create`, plus a handful of file/folder ops; the precise list is small — under 20). This is small enough to **hard-code** the method→action map. Arg inspection extracts the target.

Pseudocode:

```
const TABLE = {
  gdrive_read_file:    { action: "read",  target: args => doc(args.fileId) },
  gdrive_search:       { action: "read",  target: () => all() },          // list-shape, see below
  gsheets_read:        { action: "read",  target: args => doc(args.spreadsheetId) },
  gsheets_update_cell: { action: "write", target: args => doc(args.spreadsheetId) },
  gdocs_read:          { action: "read",  target: args => doc(args.documentId) },
  gdocs_create:        { action: "write", target: () => all() },          // no pre-existing target
  // ... ~12 more
};
```

**List operations** (`gdrive_search`, anything that returns a corpus): no single target. Map them to the **broadest scope the agent currently holds**. If the agent has `doc:gdrive:**` granted (the onboarding default), `gdrive_search` is silent. If only `doc:gdrive:folder/<id>/**` is granted, list ops are scoped to that folder by injecting a `parents in '<id>'` clause into the upstream query (transparent narrowing). If no read grant exists, prompt with target=`all` and `why="agent wants to search your Drive"`.

**Unknown tools** (e.g. upstream ships a new method): see §5.

### 4. Caching strategy — lean entirely on the kernel; no proxy-side cache

The kernel already has the right primitives: decision rows carry `mode ∈ {allow_always, allow_session, allow_once}` and TTLs (`approvalRecord`'s `ttl_ms`). The proxy MUST NOT add a second cache layer — that's how cache-invalidation bugs ship.

Per-call sequence:

1. Classify request → `{scope, action}`.
2. Call `approvalLookup({agent_unit, scope, action, current_approver_set})`.
3. On `granted` → forward to upstream.
4. On `no_decision` → call `approvalRequest`, wait via `waitForApproval`, on grant forward, on deny return MCP error.
5. On `pending` (someone else asked, still waiting) → wait on the same request_id.
6. On `denied | expired | drift_revoked` → return MCP error to agent.

TTL semantics map to the existing kernel modes:
- **allow_once** — single forward, decision row marked consumed via `approvalConsume`.
- **allow_session** — TTL = agent process lifetime. The proxy emits a `session_id` derived from agent boot time; on agent restart the kernel rows for this session naturally expire on their TTL clock (set to e.g. 24h, generous enough for normal sessions).
- **allow_always** — durable until revoked.

**Invalidation** is the kernel's job (`approvalRevoke`, `drift_revoked`) — proxy just re-asks every call.

### 5. Unknown-method policy — force-prompt with full method+args

Block-with-deny is too brittle (upstream ships a new tool, agent breaks). Pass-through-with-audit defeats the point. **Recommend: force-prompt**, scope = `doc:gdrive:unknown:<method_name>`, action = `unknown`, `why` includes the redacted args. The user sees "Agent X wants to call new method `gdrive_foo` — Allow once / Allow always / Deny." First decision teaches the table; subsequent calls hit the kernel cache.

### 6. UX — reuse the existing approval card primitive

The kernel approval card (`telegram-plugin/gateway/approval-card.ts`) already renders `{agent_unit, scope, action, why}` with Allow/Deny/Always buttons. Drive prompts plug straight in. The only Drive-specific surface is the `why` body builder:

> `clerk wants to read "Q2 board deck" (1A2b3C…) in folder "Board". Allow once / Allow this folder always / Deny.`

The "Allow this folder always" shortcut needs the proxy to widen the scope from `doc:gdrive:1A2b3C` to `doc:gdrive:folder/<parent_id>/**` on the click. Implement as an extra option in the card spec, not a new card shape.

### 7. Failure modes

| Failure | Behaviour |
| ------- | --------- |
| Proxy crashes mid-request | MCP frame loss → agent's MCP client errors → next agent retry restarts the proxy (it's a child of `claude`'s MCP supervisor). |
| Kernel unreachable | **Deny-all.** Fail closed. Drive ops are not load-bearing for agent liveness; an outage means "no Drive for now," not "leak everything." |
| User non-response within request TTL | Kernel marks `expired` → proxy returns MCP error to agent. Default request TTL = 5 min (matches existing kernel default). |
| Upstream `mcp-gdrive` exits | Proxy restarts it once with backoff; on second failure surfaces an error and stays up so the kernel doesn't fire spurious reconnect cards. |

## Alternatives considered

- **Patch upstream `mcp-gdrive`** — fork-and-maintain risk, no upstream merge incentive. Rejected.
- **Approval at the OAuth-scope layer only** — Google's scope grammar is too coarse (drive.readonly is all-or-nothing). Rejected.
- **In-broker proxy** — see §1.

## Implementation plan — three PRs, ~1 day opus-worker each

### Phase A — observe-only (PR #1)
Proxy skeleton: stdio in/out, spawns upstream, classifies every `tools/call`, **logs the classification + decision-that-would-have-been-made to journald, then forwards unconditionally**. No enforcement.

Acceptance:
- Proxy runs as MCP child for one canary agent (klanker).
- Every Drive call produces a structured journal line with `{method, scope, action, target}`.
- Zero agent-visible behaviour change (no prompts, no denials).
- One week of canary data lets us validate the method→scope table against reality before turning on enforcement.

### Phase B — read enforcement (PR #2)
Wire `approvalLookup`/`approvalRequest`/`waitForApproval` for read methods only. Write methods stay observe-only.

Acceptance:
- Read calls with no grant → Telegram prompt → on grant forward, on deny error.
- Existing onboarding `doc:gdrive:**` grant satisfies all reads silently (parity with today).
- `gdrive_search` honours folder narrowing when grant is folder-scoped.
- Kernel-down → deny-all + clear error.

### Phase C — write enforcement (PR #3)
Wire enforcement for write methods. Always prompt unless `doc:gdrive:write:**` (or narrower write scope) is held.

Acceptance:
- First write per scope per session prompts.
- `allow_session` writes are silent for the rest of the agent process lifetime.
- Unknown-method force-prompt (§5) lands in this PR.
- Drift: revoking the write grant from the auth dashboard kills in-flight write authorization on the next call.

## Open questions for Ken

1. **Folder narrowing for `gdrive_search`** — is silently rewriting the upstream query (`parents in '<id>'`) acceptable, or do you want the proxy to refuse search entirely when only folder-scoped read is granted? Silent rewrite is more useful but slightly magic.
2. **Default TTL for `allow_session`** — 24h hard cap, or tied literally to the agent process (and re-prompt on every restart)? Process-tied is more secure but noisier across watchdog restarts.
3. **Phase A canary length** — one week feels right to me; you may want longer if Drive usage is light and we need volume to validate the table.
4. **Unknown-method policy if Ken disagrees with §5** — is force-prompt OK, or would you rather block-and-page so unknown methods become a maintenance signal?
5. **Write-namespace onboarding** — RFC C onboarding currently only offers read. Do we add a fourth onboarding option ("Allow my Drive (read + write)") in PR #3, or keep writes per-call-prompt forever? Recommend per-call forever — writes are rarer and the friction is the feature.
