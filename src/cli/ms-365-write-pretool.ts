/**
 * PreToolUse hook for softeria/ms-365-mcp-server write tools —
 * RFC #1873 §8 PR 4.
 *
 * Bundled to `/opt/switchroom/hooks/ms-365-write-pretool.mjs` at build
 * time so it runs inside the agent container with zero relative
 * imports. Mirrors `drive-write-pretool.ts` shape with the weak-
 * metadata simplification (RFC §8 v1).
 *
 * Claude Code PreToolUse contract:
 *   Input:  JSON on stdin — { session_id, tool_name, tool_input, ... }
 *   Output: exit 0 + empty stdout → allow.
 *           exit 0 + JSON `{ decision: "block", reason: "..." }` → block.
 *
 * Flow:
 *   1. Parse stdin. Skip (allow) if tool isn't a gated MS-365 write.
 *   2. Best-effort extract item id + display name + size from tool_input.
 *   3. (Optional) Check kernel for a standing grant at scope
 *      `ms-365:write:<itemId>`. v1: always-prompt — no standing grants.
 *      Skip this check; future PR can add a scope-key skip.
 *   4. Send `request_ms365_approval` to gateway socket.
 *   5. Poll `approval_lookup` until verdict (granted / denied / expired).
 *   6. Granted → allow. Anything else → block.
 *
 * Fail-closed:
 *   - Stdin parse fails → block (Claude Code protocol error — better
 *     to fail closed than allow an unbounded operation)
 *   - Gateway unreachable → block (operator can't see card)
 *   - Kernel unreachable for verdict → block (no way to know decision)
 *   - Timeout / no decision → block
 *
 * Fail-open ONLY when:
 *   - Tool isn't an MS-365 tool at all (wrong `mcp__ms-365__` prefix), or
 *     it's a VERIFIED read-only MS-365 tool (KNOWN_SAFE_MS365_READ_TOOLS).
 *
 * Fail-CLOSED (require approval) — deterministic, not prompt-dependent:
 *   - Any known write tool (GATED_MS365_WRITE_TOOLS).
 *   - Any UNRECOGNIZED `mcp__ms-365__` tool. A renamed or newly-added
 *     softeria write tool that isn't yet in our read allowlist must NOT
 *     sail through — an allowlist gap defaults to "require approval",
 *     never to "allow" (review 2026-07-11, W2 fail-open finding).
 *   - SWITCHROOM_AGENT_NAME missing → block (we can't identify the agent
 *     to gate, so we can't prove the operator approved this write).
 */

import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// ────────────────────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────────────────────

const HOOK_TIMEOUT_MS = 5 * 60 * 1000;
const KERNEL_POLL_INTERVAL_MS = 2000;
const IPC_CONNECT_TIMEOUT_MS = 3000;
const IPC_REPLY_TIMEOUT_MS = 10_000;
const KERNEL_RPC_TIMEOUT_MS = 3000;

const GATEWAY_SOCKET =
  process.env.SWITCHROOM_GATEWAY_SOCKET ??
  (process.env.TELEGRAM_STATE_DIR !== undefined
    ? join(process.env.TELEGRAM_STATE_DIR, "gateway.sock")
    : join(homedir(), ".claude", "channels", "telegram", "gateway.sock"));

const KERNEL_SOCKET =
  process.env.SWITCHROOM_KERNEL_SOCKET ?? "/run/switchroom/kernel/sock";

const TOOL_PREFIX = "mcp__ms-365__";

/**
 * Gated softeria write tools — AUTHORITATIVE names.
 *
 * Names are the ground-truth softeria `mcp__ms-365__*` tool names,
 * harvested from real invocations across the fleet's agent transcripts
 * (88 distinct names observed) and reconciled in the MS-365 approval
 * design review (2026-07-13). They replace the earlier conjectured names
 * (`create-event`/`update-event`/`update-message`/…) which never existed
 * upstream — softeria names calendar/mail writes as `*-calendar-event`
 * and `*-mail-message`.
 *
 * This set is primarily documentation + an explicit-gate assertion:
 * `isGatedMs365Tool` fail-closes ANY unrecognized `mcp__ms-365__` tool to
 * "require approval" regardless, so a name missing here is still gated.
 * Its load-bearing job is (a) to keep writes and reads from ever
 * overlapping and (b) to make `send-mail` / `send` explicitly gate-and-
 * allow (post a card the operator can approve) rather than riding the
 * fail-closed path implicitly.
 *
 * Fleet config currently enables `mail|calendar` only, but the OneDrive
 * writes are included so the classification stays correct on any agent
 * that enables the drive surface.
 */
export const GATED_MS365_WRITE_TOOLS = new Set<string>([
  // ── Calendar writes ──
  "create-calendar",
  "update-calendar",
  "delete-calendar",
  "create-calendar-event",
  "create-specific-calendar-event",
  "update-calendar-event",
  "update-specific-calendar-event",
  "delete-calendar-event",
  "delete-specific-calendar-event",
  "accept-calendar-event",
  "decline-calendar-event",
  "tentatively-accept-calendar-event",
  "cancel-calendar-event",
  "forward-calendar-event",
  "dismiss-calendar-event-reminder",
  "snooze-calendar-event-reminder",
  "create-my-calendar-permission",
  "update-my-calendar-permission",
  "delete-my-calendar-permission",
  // ── Mail writes ──
  "send-mail",
  "send",
  "create-draft-email",
  "update-mail-message",
  "delete-mail-message",
  "move-mail-message",
  "copy-mail-message",
  "reply-mail-message",
  "reply-all-mail-message",
  "forward-mail-message",
  "create-mail-attachment-upload-session",
  "add-mail-attachment",
  "delete-mail-attachment",
  "create-mail-folder",
  "create-mail-child-folder",
  "update-mail-folder",
  "delete-mail-folder",
  "create-mail-rule",
  "update-mail-rule",
  "delete-mail-rule",
  "update-mailbox-settings",
  // ── OneDrive writes (only reachable on agents that enable the drive surface) ──
  "upload-file-content",
  "create-upload-session",
  "create-onedrive-folder",
  "delete-onedrive-file",
  "move-rename-onedrive-item",
  "copy-drive-item",
  "share-drive-item",
  "create-drive-item-share-link",
  "delete-drive-item-permission",
]);

/**
 * VERIFIED read-only softeria tools that are safe to pass through WITHOUT
 * an approval card. This is the fail-closed pivot: `isGatedMs365Tool`
 * gates (requires approval) for any `mcp__ms-365__` tool that is NOT on
 * this allowlist — so a renamed or newly-added upstream WRITE tool defaults
 * to "require approval" rather than sailing through unrecognized.
 *
 * Names are the AUTHORITATIVE softeria read surface (design review
 * 2026-07-13): calendar reads, mail reads, OneDrive reads, and the
 * identity/session control-plane. They replace the earlier conjectured
 * names (`list-files`/`list-events`/`get-message`/`whoami`/… — none of
 * which exist upstream), which caused every REAL read (`get-calendar-view`,
 * `list-mail-messages`, `get-mail-message`, …) to be misclassified as an
 * unrecognized write and posted an approval card (Bug 1).
 *
 * The cost of an omission here is only an extra approval prompt on a read
 * (annoying, safe) — never an ungated write (unsafe).
 */
export const KNOWN_SAFE_MS365_READ_TOOLS = new Set<string>([
  // ── Calendar reads ──
  "list-calendars",
  "get-calendar-view",
  "get-specific-calendar-view",
  "list-calendar-events",
  "list-specific-calendar-events",
  "get-calendar-event",
  "get-specific-calendar-event",
  "list-calendar-event-instances",
  "list-calendar-events-delta",
  "list-calendar-view-delta",
  "list-my-calendar-permissions",
  // ── Mail reads ──
  "list-mail-messages",
  "get-mail-message",
  "get-mail-message-mime",
  "list-mail-folders",
  "list-mail-child-folders",
  "list-mail-folder-messages",
  "list-mail-folder-messages-delta",
  "list-mail-attachments",
  "list-mail-rules",
  "get-mail-tips",
  "get-mailbox-settings",
  // ── OneDrive reads (present on agents that enable the drive surface) ──
  "get-drive-item",
  "get-drive-root-item",
  "download-bytes",
  "list-drives",
  "list-folder-files",
  "search-onedrive-files",
  "get-drive-delta",
  // ── Identity / session (control-plane; no card) ──
  "login",
  "logout",
  "verify-login",
  "list-accounts",
  "select-account",
  "remove-account",
]);

/**
 * Should this tool require an operator approval card before it runs?
 *
 * Fail-CLOSED classification:
 *   - Not an `mcp__ms-365__` tool → false (not our surface; another hook
 *     or the base permission system owns it).
 *   - A verified read-only tool (KNOWN_SAFE_MS365_READ_TOOLS) → false.
 *   - Everything else on the `mcp__ms-365__` surface (known writes AND any
 *     unrecognized / renamed tool) → true (gate).
 */
export function isGatedMs365Tool(toolName: string): boolean {
  if (!toolName.startsWith(TOOL_PREFIX)) return false;
  const bare = toolName.slice(TOOL_PREFIX.length);
  // Degenerate prefix-only name — not a real tool invocation.
  if (bare.length === 0) return false;
  // Verified read-only tools pass through without a card.
  if (KNOWN_SAFE_MS365_READ_TOOLS.has(bare)) return false;
  // Known write OR unrecognized MS-365 tool → require approval (fail-closed).
  return true;
}

// ────────────────────────────────────────────────────────────────────────
// Operator allowFrom discovery
// ────────────────────────────────────────────────────────────────────────

/**
 * Read the operator allowFrom set from `access.json` inside the agent
 * container. Mirrors `drive-write-pretool.ts:loadAllowFrom()` — the WORKING
 * Drive path — verbatim in mechanism.
 *
 * This is the fix for Bug 2: the verdict lookup previously passed `[]` as the
 * `current_approver_set`, which the kernel's `evaluateDecisionRow` drift check
 * compared against the decision row's canonical set (`[tapper_uid]`). `[] ≠
 * [tapper_uid]` → drift branch → `drift_revoked`, so EVERY operator Approve
 * was silently reverted to a deny. Passing the real operator set (which, in
 * the single-operator DM case, canonicalizes identically to `[tapper_uid]`)
 * makes the grant stick — exactly as it does for Drive.
 *
 * `access.json` lives at `<TELEGRAM_STATE_DIR>/access.json` inside the agent
 * container. The homedir fallback only kicks in for host-side invocations
 * (tests, debug tools). If no operator is paired the list is empty — the poll
 * then can't match the `[tapper_uid]` record and fails closed (safe).
 */
export function loadAllowFrom(): string[] {
  const stateDir =
    process.env.TELEGRAM_STATE_DIR ??
    join(homedir(), ".claude", "channels", "telegram");
  const accessPath = join(stateDir, "access.json");
  try {
    const raw = readFileSync(accessPath, "utf8");
    const j = JSON.parse(raw) as { allowFrom?: unknown };
    if (Array.isArray(j.allowFrom)) {
      return (j.allowFrom as unknown[]).filter(
        (s): s is string => typeof s === "string",
      );
    }
  } catch {
    /* not paired or no access file */
  }
  return [];
}

// ────────────────────────────────────────────────────────────────────────
// stdin parse
// ────────────────────────────────────────────────────────────────────────

interface HookInput {
  session_id?: string;
  tool_name?: string;
  tool_input?: unknown;
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function parseHookInput(): HookInput | null {
  const raw = readStdin();
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as HookInput;
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Preview extraction — best-effort from tool_input shape
// ────────────────────────────────────────────────────────────────────────

export interface Ms365PreviewExtract {
  itemId: string;
  itemDisplayName: string;
  deepLink?: string;
  sizeBytesAfter?: number;
}

/**
 * Best-effort extract the preview-shape fields from softeria's
 * tool_input. softeria's exact param names vary per tool — we look for
 * the common shapes and fall through to "(unknown)" defaults.
 *
 * **This is pure heuristics**. UAT in PR 5 validates against actual
 * tool_input shapes; if a tool's params don't match these patterns,
 * the card shows "(unknown)" for the field — the operator can still
 * make a decision based on tool name + agent rationale, just without
 * the item-level context.
 */
export function extractMs365Preview(
  toolName: string,
  toolInput: unknown,
): Ms365PreviewExtract {
  const o = (toolInput && typeof toolInput === "object")
    ? (toolInput as Record<string, unknown>)
    : {};

  // itemId common shapes: itemId, item_id, id, driveItemId, eventId, messageId
  let itemId = "(new)";
  for (const k of ["itemId", "item_id", "id", "driveItemId", "eventId", "messageId", "message_id"]) {
    if (typeof o[k] === "string" && (o[k] as string).length > 0) {
      itemId = o[k] as string;
      break;
    }
  }

  // Display name shapes: name, fileName, file_name, displayName, subject, title
  let itemDisplayName = "(unknown)";
  for (const k of ["name", "fileName", "file_name", "displayName", "subject", "title"]) {
    if (typeof o[k] === "string" && (o[k] as string).length > 0) {
      itemDisplayName = o[k] as string;
      break;
    }
  }

  // Deep link shapes: webUrl, web_url, url, link
  let deepLink: string | undefined;
  for (const k of ["webUrl", "web_url", "url", "link"]) {
    if (typeof o[k] === "string" && (o[k] as string).startsWith("http")) {
      deepLink = o[k] as string;
      break;
    }
  }

  // Size shapes: contentSize, content_size, fileSize, size (for upload tools)
  let sizeBytesAfter: number | undefined;
  for (const k of ["contentSize", "content_size", "fileSize", "size"]) {
    if (typeof o[k] === "number" && Number.isFinite(o[k])) {
      sizeBytesAfter = o[k] as number;
      break;
    }
  }
  // For inline base64-encoded content, derive size from the encoded
  // string length. Approximate (off by 0/1/2 bytes depending on `=`
  // padding) — accurate enough for the operator's card. Surfaced as
  // "approx N bytes" downstream if we ever care to be exact.
  if (sizeBytesAfter === undefined && typeof o.content === "string") {
    const len = (o.content as string).length;
    sizeBytesAfter = Math.floor((len * 3) / 4);
  }

  return { itemId, itemDisplayName, deepLink, sizeBytesAfter };
}

// ────────────────────────────────────────────────────────────────────────
// IPC — gateway + kernel
// ────────────────────────────────────────────────────────────────────────

interface IpcOk { ok: true; value: unknown }
interface IpcErr { ok: false; reason: string }
type IpcResult = IpcOk | IpcErr;

async function sendGatewayRequest(
  socket: string,
  payload: Record<string, unknown>,
  matchType: string,
  correlationId: string,
): Promise<IpcResult> {
  return new Promise((resolve) => {
    const conn = createConnection(socket);
    let buf = "";
    const cleanup = () => {
      try {
        conn.destroy();
      } catch {
        /* ignore */
      }
    };
    const replyTimer = setTimeout(() => {
      cleanup();
      resolve({ ok: false, reason: "gateway reply timeout" });
    }, IPC_REPLY_TIMEOUT_MS);
    const connectTimer = setTimeout(() => {
      cleanup();
      resolve({ ok: false, reason: "gateway connect timeout" });
    }, IPC_CONNECT_TIMEOUT_MS);

    conn.once("error", (err) => {
      clearTimeout(replyTimer);
      clearTimeout(connectTimer);
      resolve({ ok: false, reason: `gateway: ${err.message}` });
    });
    conn.once("connect", () => {
      clearTimeout(connectTimer);
      conn.write(JSON.stringify(payload) + "\n");
    });
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      while (true) {
        const lineEnd = buf.indexOf("\n");
        if (lineEnd === -1) break;
        const line = buf.slice(0, lineEnd);
        buf = buf.slice(lineEnd + 1);
        try {
          const parsed = JSON.parse(line) as {
            type?: string;
            correlationId?: string;
          };
          if (
            parsed?.type === matchType &&
            parsed?.correlationId === correlationId
          ) {
            clearTimeout(replyTimer);
            cleanup();
            resolve({ ok: true, value: parsed });
            return;
          }
        } catch {
          /* drop malformed line; keep reading */
        }
      }
    });
  });
}

async function rpcKernel(payload: Record<string, unknown>): Promise<IpcResult> {
  return new Promise((resolve) => {
    const conn = createConnection(KERNEL_SOCKET);
    let buf = "";
    const cleanup = () => {
      try {
        conn.destroy();
      } catch {
        /* ignore */
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve({ ok: false, reason: "kernel rpc timeout" });
    }, KERNEL_RPC_TIMEOUT_MS);
    conn.once("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `kernel: ${err.message}` });
    });
    conn.once("connect", () => {
      conn.write(JSON.stringify(payload) + "\n");
    });
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lineEnd = buf.indexOf("\n");
      if (lineEnd === -1) return;
      const line = buf.slice(0, lineEnd);
      clearTimeout(timer);
      cleanup();
      try {
        resolve({ ok: true, value: JSON.parse(line) });
      } catch (err) {
        resolve({ ok: false, reason: `kernel parse: ${String(err)}` });
      }
    });
  });
}

/**
 * Poll the verdict for the SPECIFIC request_id this hook registered.
 *
 * We correlate by request_id, NOT by scope: two concurrent MS-365 writes
 * can share a scope (e.g. `ms-365:write:(new)` for two new-file uploads),
 * and a scope-keyed lookup would let one write's approval satisfy the
 * other's gate — a fail-open mis-attribution. `approval_lookup_by_request`
 * resolves the nonce by request_id and returns only that request's own
 * decision. (review 2026-07-11, W2 verdict-correlation finding.)
 */
async function approvalLookupByRequest(
  agentUnit: string,
  requestId: string,
  approverSet: string[],
): Promise<{ state?: string } | null> {
  const res = await rpcKernel({
    v: 1,
    op: "approval_lookup_by_request",
    agent_unit: agentUnit,
    request_id: requestId,
    current_approver_set: approverSet,
  });
  if (!res.ok) return null;
  return res.value as { state?: string };
}

// ────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────

function fail(reason: string): never {
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: `ms-365 write blocked: ${reason}`,
    }),
  );
  process.exit(0);
}

function allow(): never {
  process.exit(0);
}

async function main(): Promise<void> {
  const input = parseHookInput();
  if (!input) fail("malformed stdin");

  const toolName = input.tool_name;
  if (typeof toolName !== "string" || !isGatedMs365Tool(toolName)) {
    // Not a gated tool — allow through.
    allow();
  }

  const agentName = process.env.SWITCHROOM_AGENT_NAME;
  if (!agentName) {
    // No agent identity — we can't register/correlate an approval for a
    // known-write path, so we can't prove the operator authorized it.
    // Fail CLOSED (review 2026-07-11, W2). The write is already confirmed
    // gated at this point (isGatedMs365Tool returned true above).
    fail("SWITCHROOM_AGENT_NAME unset — cannot identify agent to gate write");
  }

  const accountEmail = process.env.SWITCHROOM_MICROSOFT_ACCOUNT ?? "(unknown)";

  const extract = extractMs365Preview(toolName, input.tool_input);
  const preview = {
    agentName,
    toolName,
    itemId: extract.itemId,
    itemDisplayName: extract.itemDisplayName,
    accountEmail,
    deepLink: extract.deepLink,
    sizeBytesAfter: extract.sizeBytesAfter,
    // No agentRationale yet — softeria doesn't pass one, and we
    // don't have a sidecar channel for the agent to supply it.
  };

  const correlationId = randomBytes(16).toString("hex");
  const requestResult = await sendGatewayRequest(
    GATEWAY_SOCKET,
    {
      type: "request_ms365_approval",
      correlationId,
      agentName,
      preview,
      ttlMs: HOOK_TIMEOUT_MS,
    },
    "ms365_approval_posted",
    correlationId,
  );

  if (!requestResult.ok) fail(requestResult.reason);
  const response = requestResult.value as {
    ok: boolean;
    requestId?: string;
    expiresAtMs?: number;
    reason?: string;
  };
  if (!response.ok || !response.requestId) {
    fail(response.reason ?? "gateway returned ok=false");
  }

  const requestId = response.requestId;
  const deadline = response.expiresAtMs ?? Date.now() + HOOK_TIMEOUT_MS;
  // Correlate strictly by the request_id we just registered — not by scope
  // (concurrent same-scope writes would otherwise cross-attribute verdicts).
  // Pass the REAL operator allowFrom set (Bug 2 fix): the kernel's
  // evaluateDecisionRow drift check compares this against the decision row's
  // canonical set. Passing `[]` (the old bug) always drifted → drift_revoked,
  // so no Approve ever stuck. Mirror the working Drive pretool and pass the
  // loaded allowFrom.
  const approverSet = loadAllowFrom();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, KERNEL_POLL_INTERVAL_MS));
    const lookup = await approvalLookupByRequest(agentName, requestId, approverSet);
    if (!lookup) continue;
    const state = lookup.state;
    if (state === "granted") allow();
    if (state === "denied" || state === "drift_revoked" || state === "expired") {
      fail(`operator ${state}`);
    }
  }
  fail("approval timed out");
}

// Only invoke main() when run as a script — not when imported by tests.
// The hook is bundled by scripts/build.mjs into a standalone .mjs that
// IS run as a script in the agent container; the gating below is
// satisfied by bun's bundler exposing `import.meta.main` (true at
// entrypoint, false on imports). At test-import time the predicate is
// false so main() doesn't fire (and hang on readFileSync(0)).
if ((import.meta as { main?: boolean }).main) {
  main().catch((err) => {
    const m = err instanceof Error ? err.message : String(err);
    fail(`hook error: ${m}`);
  });
}
