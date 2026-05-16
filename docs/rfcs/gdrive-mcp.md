# RFC D: Google Drive MCP integration

Status: **Implemented in v0.6.0** (2026-05-06). Originally drafted as "RFC C" — renumbered to D after `host-control-daemon.md` claimed the C slot in v0.7.x. This document is retained as the design record; the implementation is the source of truth.
Author: klanker (sub-agent draft)
Date: 2026-05-06

Prerequisite: **RFC B — Approval kernel** (`docs/rfcs/approval-kernel.md`) — landed in v0.6.0 (#762). The Drive MCP is the first real consumer.

## Implementation pointers

- Code: `src/drive/{oauth,vault-slots,onboarding,disconnect,reconciler,grants,wrapper}.ts` (+ co-located tests).
- CLI: `src/cli/drive.ts` (`switchroom drive connect|disconnect`).
- Config: `drive:` block (top-level + per-agent), schema in `src/config/schema.ts` (#768).
- Landing PRs: #763 (full integration), #766 (CLI), #767 (desktop-loopback OAuth tier), #768 (`drive:` config block).
- Still deferred (no tracking issue yet): folder picker UI (§6), Drive write operations (§12 out-of-scope; needs `doc:gdrive:write:*` scope namespace).

## 1. Summary

Add a Google Drive MCP server so agents can read and (with explicit approval) write Drive docs. OAuth refresh tokens live in the vault; every doc/folder access goes through the approval kernel; first-run onboarding flips the default away from the prompt-flood-prone per-doc shape; the reconciler treats Drive state as three-valued (present / missing / conflict); a richer folder picker is deferred to a future RFC.

## 2. MCP server choice

**Pinned:** [`taylorwilsdon/google_workspace_mcp`](https://github.com/taylorwilsdon/google_workspace_mcp), MIT-licensed, pinned to an explicit upstream **commit SHA** (a tag's deref'd commit, not a floating ref, so upstream history rewrites can't change what we run). The RFC originally targeted `v0.5.x`, but no such tag exists upstream. The live pin is single-sourced in code as `GOOGLE_WORKSPACE_MCP_PINNED_SHA` (`src/memory/scaffold-integration.ts`) — that constant, with its doc comment, is the source of truth (currently the `v1.20.4` commit); do not duplicate the literal here, it only rots. Bump deliberately per the procedure in that comment + the `tests/docker/drive-mcp-pin-smoke.test.ts` guard.

- **Runtime:** Python 3.11+, run via `uvx` so no system-wide install is required. Switchroom's existing MCP-subprocess machinery already supports `uvx`-launched servers.
- **License:** MIT.
- **Coverage:** Drive + Docs + Sheets + Calendar + Gmail in one binary. We use only the Drive + Docs surface in v1; the others are dormant and gated by their own future RFCs (Notion/Slack/Gmail RFCs may use this same server for Gmail rather than spinning up another).
- **Why this one over alternatives:**
  - `modelcontextprotocol/servers` reference Drive server (Node) is single-account-only, no refresh-token persistence — re-auth every restart, breaks headless installs.
  - `isaacphi/mcp-gdrive` is read-only and per-doc-id only; no folder traversal, which makes RFC B's folder-coalescing pointless.
  - Service-account-based servers (e.g. `googleworkspace/mcp-server`) bypass per-user OAuth, which collapses approval semantics — every access shows up as the service account, not the user.
  - `taylorwilsdon/google_workspace_mcp` is actively maintained, supports per-user OAuth with refresh-token storage, exposes folder traversal, and is the only one of the four with a non-trivial test suite.

We run the MCP server as a switchroom-managed subprocess of each agent that has Drive enabled, the same way other MCP servers are managed today. Configuration goes through the existing MCP config surface; no new config plane.

## 3. OAuth flow for headless hosts

**The MCP server's stock OAuth flow assumes a desktop browser is reachable on the host running the bot. That is wrong for switchroom** — the host is typically a Linux box reached over SSH. The connect command must support both shapes:

### 3.1 Desktop-browser flow (when available)

`switchroom drive connect <agent>` detects `$DISPLAY` (or `$WAYLAND_DISPLAY`) and an installed browser via `xdg-open`. If both present, run the stock loopback flow: open `https://accounts.google.com/o/oauth2/...` in the browser, capture the code via a transient `localhost:<port>` HTTP listener, exchange for a refresh token. This is the path for laptop installs.

### 3.2 Headless device-code / copy-paste flow (the SSH path)

If `$DISPLAY` is unset OR `--headless` is passed, use **Google's OAuth 2.0 for Limited-Input Devices** flow (the device-code grant, RFC 8628):

1. CLI calls Google's device-authorization endpoint, prints:
   ```
   On any device with a browser, visit:
       https://www.google.com/device
   And enter this code: WDJB-MJHT
   ```
2. CLI polls Google's token endpoint at the interval the response specifies (typically 5s) until the user completes consent on their phone or laptop.
3. On success, exchange the device-code response for a refresh token; write it to vault per §4.

Fallback if Google rejects the device-code flow for the requested scopes (Drive scopes are not always whitelisted for limited-input clients): print the consent URL plus a one-line instruction:

```
Open this URL on a browser-equipped machine:
    https://accounts.google.com/o/oauth2/auth?...&redirect_uri=urn:ietf:wg:oauth:2.0:oob
After consenting, paste the code below:
    >
```

Using the `urn:ietf:wg:oauth:2.0:oob` redirect (out-of-band) lets Google show the code on its consent page; the user pastes it into the SSH session. This is the universally-available fallback.

The CLI auto-selects: try device-code, fall back to OOB-paste, fall back to desktop-loopback in that order based on environment + which Google accepts for the configured scopes.

## 4. Refresh-token storage, rotation, and revocation

### 4.1 Storage

- The refresh token lands in a vault slot at `gdrive:<agent_unit>:refresh_token`. ACL grants the agent's unit only.
- Access tokens are short-lived (Google's default ~1h) and **never persisted** — the MCP wrapper holds them in process memory only and refreshes on demand using the vault-stored refresh token.
- The MCP wrapper, on startup, reads the refresh token via the broker, exchanges for an access token, and proceeds. If the broker is unreachable at startup, the wrapper exits with a clear "vault unreachable" error rather than caching a token to disk.

### 4.2 Rotation

Google rotates refresh tokens silently in two cases: (a) when the user changes their Google password, (b) when the user revokes the app's access in their Google Account dashboard. There is no callback for either. The wrapper must handle a rotated/invalidated refresh token gracefully:

- On a `invalid_grant` response from Google's token endpoint, the wrapper marks the slot as **invalid** (writes a sidecar `gdrive:<agent_unit>:refresh_token:status` slot containing `invalid_grant` + timestamp) and posts a kernel approval card titled "Drive disconnected — reconnect klanker?" with `[Reconnect]` `[Disconnect permanently]` buttons.
- `[Reconnect]` runs `switchroom drive connect <agent>` again, which overwrites the slot.
- The vault slot itself is overwrite-on-write (no version history) — there's no value in keeping invalid refresh tokens around, and Google may have already invalidated the one we held.

### 4.3 Revocation

`switchroom drive disconnect <agent>` calls Google's `https://oauth2.googleapis.com/revoke` endpoint AND deletes the slot AND writes a `mcp:gdrive` audit row to `approval_audit` (RFC B §5).

The kernel's `/revoke-all` killswitch (RFC B §9.2) iterates Drive-connected agents and calls the same revocation path before the kernel-level mass revoke. If Google's revoke endpoint fails for a given agent, the slot is still deleted locally and the failure is surfaced in the killswitch's status report — the user can manually revoke at `myaccount.google.com/permissions`.

Vault path summary:
- `gdrive:<agent_unit>:refresh_token` — the durable token.
- `gdrive:<agent_unit>:refresh_token:status` — sidecar for invalid-grant signaling. Optional; absent means healthy.

## 5. First-run onboarding card — flipping the default

Per the reviewer's prompt-flood concern: per-doc default produces 20+ prompts on day 1 (initial folder browse + readme reads + the agent finding the right doc). That's a UX failure that trains the user to tap-through rather than read.

**v1 default flips to "Allow my Drive (read-only)" — single grant, no per-doc prompts.** Per-doc remains an explicit option for security-conscious users. Onboarding copy makes the trade-off explicit so the user is choosing, not defaulting blindly:

```
🆕 Google Drive enabled for klanker.

Most users pick "Allow my Drive" — one tap now, then it just works.
"Per-doc approval" prompts you for every single file the agent opens
(20+ prompts in the first hour is typical). Pick that only if you
want a tap-by-tap audit trail.

[ ✅ Allow my Drive (read-only)  — recommended ]
[ 🔒 Per-doc approval — high-touch, high-friction ]
[ ❌ Cancel — don't enable Drive ]
```

- "Allow my Drive (read-only)" writes a single `allow_always` row at scope `doc:gdrive:**` with the `read` mode flag. Writes still prompt individually (see §9 out-of-scope re: write namespace).
- "Per-doc approval" writes nothing; every doc access goes through `requestApproval`. This is the path the reviewer flagged as prompt-flood-prone, and the copy now warns explicitly before the user picks it.
- "Cancel" exits without writing config; the operator can re-run `switchroom drive connect <agent>` later.

A "Choose folders now" option was considered and dropped — without a real folder picker (deferred per §6) it would force the user to type folder IDs, which is worse than either default.

## 6. Folder picker — deferred

A real Telegram-side folder picker (browse Drive, tap a folder, grant `doc:gdrive:folder/<id>/**`) lands in a **future RFC, not this one**. Until then, users widen via `/approvals add` post-grant if they chose per-doc and find it noisy. The batch-coalescing behavior in §7 below softens the per-doc noise meaningfully in the meantime.

## 7. Scope-prefix batch coalescing

Per RFC B §11, the kernel buffers prompts for 5 seconds; if 3+ pending share a scope-prefix, it collapses into a single card. Drive is the first surface where this matters in practice — and it is the primary mitigation for users who chose per-doc in §5.

Common pattern: an agent opens a folder, then reads 6 docs in it back-to-back. With per-doc approval, that's 6 prompts. With coalescing:

```
🔐 klanker is requesting access to 4 docs in /Work
"Q3 Strategy Notes", "Hiring plan", "Roadmap draft", "+1 more"
[ See all ]   [ ✅ Allow this folder ]   [ 🚫 Deny ]
[ ✅ Allow these 4 only ]
```

Tapping "Allow this folder" writes `allow_always` at `doc:gdrive:folder/<id>/**`. "Allow these 4 only" writes 4 `allow_once` rows. "Deny" denies all four; subsequent reads in the buffer window roll up into the same card.

The coalescing window is short (5s) so the user doesn't perceive lag.

## 8. Reconciler — three-state, not boolean

A naive `present? yes/no` reconciler is wrong for Drive. A doc the agent expected to find can be in three states, each requiring different handling:

| State | Detection | Agent behavior |
|---|---|---|
| **Present** | `files.get` returns 200 with expected `id` and `mimeType`. | Proceed normally. |
| **Missing** | `files.get` returns 404, OR returns 200 with `trashed: true`. | Surface a non-fatal "doc was deleted/trashed" notice; agent decides whether to re-find or abort. Do NOT auto-revoke the grant — the user may un-trash. |
| **Conflict** | `files.get` returns 200 but the doc's `modifiedTime` is newer than the agent's last-seen `modifiedTime` AND content hash differs, OR the doc's `mimeType` changed (e.g. converted from Doc to PDF), OR `permissions` changed in a way that excludes the agent's owner. | Surface a "doc changed since last access" notice with the diff summary; require re-confirmation before write operations; reads proceed but flag the staleness in the response. |

The reconciler runs:
- On every doc access (cheap — same `files.get` round-trip the read needs anyway).
- Lazily across the grant set when the user opens `/approvals list <agent>` — surfaces stale folder-grants where the underlying folder was deleted or renamed.

Conflict-state grants are not auto-revoked but are flagged with a `⚠️` badge in `/approvals list`. Missing-state grants beyond 30 days fold into the staleness digest (RFC B §9.1).

## 9. Card UX details

- `humanize()` for `doc:gdrive:<id>` resolves the doc title via the MCP's metadata endpoint, with the 500ms render budget specified in RFC B §8.2.
- For folder scopes, `humanize()` resolves the folder path (e.g. `/Work/2026/Q3`).
- The expand row shows the raw scope string for verification, plus the "why this access" line the agent supplied, plus the reconciler state if non-Present.

## 10. Migration / rollout

1. Land the MCP wrapper code, vault slot for refresh tokens, and `switchroom drive connect|disconnect` commands (with both desktop and headless OAuth paths).
2. Operator runs `switchroom drive connect klanker` (or whichever agent first).
3. Kernel posts the §5 onboarding card.
4. Normal usage begins.

The first week is the high-traffic window — under the new default ("Allow my Drive") expected steady-state taps drop to write-related only, which should be near-zero in v1 since writes default to per-action. Users who choose per-doc see the 10–30 taps/day burst RFC B §11 forecasts; the coalescing in §7 softens it but does not eliminate it.

## 11. Effort

~1 day. MCP wrapper subprocess management (mostly config wiring) + OAuth onboarding (both flows) + vault slot + onboarding card + reconciler three-state hookup.

## 12. Out of scope

- **Folder picker UI** — separate future RFC.
- **Drive write operations** — same approval surface, but we'll start read-only and turn on writes once the read flow has real-world miles. Writes get their own scope namespace (e.g. `doc:gdrive:write:<id>`) so a read grant never silently authorizes a write.
- **Notion, Slack, Gmail wrappers** — same shape, separate RFCs as they come up. (Gmail may piggy-back on this same MCP server.)
- **Service-account auth** — sticks with per-user OAuth so approvals remain meaningful.
- **Auto-handling of un-trashed docs** — if a missing doc returns to Present, the agent re-discovers on next access; no retro-active state-management.
