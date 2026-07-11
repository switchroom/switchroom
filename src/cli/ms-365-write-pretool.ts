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
 * Gated softeria write tools — RFC §8.
 *
 * **OneDrive writes** — upload-file-content (≤4MB inline),
 * create-upload-session (>4MB chunked).
 *
 * **Calendar writes** — create-event, update-event, delete-event.
 *
 * **Mail edits** — update-message, delete-message. Mail.Send is NOT in
 * v1 scope (drafts only); the gated set doesn't include send tools to
 * defend against scope creep.
 *
 * Tool-name conjecture: softeria's MCP server publishes tool names as
 * `<verb>-<surface>` (e.g. `upload-file-content`). Claude Code
 * namespaces them as `mcp__<server-key>__<tool-name>`. The exact
 * tool-name list is verified at UAT time in PR 5.
 */
export const GATED_MS365_WRITE_TOOLS = new Set<string>([
  "upload-file-content",
  "create-upload-session",
  "create-event",
  "update-event",
  "delete-event",
  "update-message",
  "delete-message",
]);

/**
 * VERIFIED read-only softeria tools that are safe to pass through WITHOUT
 * an approval card. This is the fail-closed pivot: `isGatedMs365Tool`
 * gates (requires approval) for any `mcp__ms-365__` tool that is NOT on
 * this allowlist — so a renamed or newly-added upstream WRITE tool defaults
 * to "require approval" rather than sailing through unrecognized.
 *
 * Names are sourced from softeria's read surface (docs/microsoft-workspace
 * + RFC #1873): OneDrive reads, calendar reads, mail reads, and identity.
 * The cost of an omission here is only an extra approval prompt on a read
 * (annoying, safe) — never an ungated write (unsafe). When UAT (PR 5)
 * confirms softeria's exact read-tool names, add any missing ones here.
 */
export const KNOWN_SAFE_MS365_READ_TOOLS = new Set<string>([
  // OneDrive / Drive reads
  "list-files",
  "list-drive-items",
  "get-drive-item",
  "download-bytes",
  "search-files",
  // Calendar reads
  "list-events",
  "get-event",
  "list-calendars",
  "get-calendar",
  // Mail reads
  "list-messages",
  "get-message",
  "search-mail",
  "list-mail-folders",
  "get-mail-folder",
  // Identity / account
  "whoami",
  "get-current-user",
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
  // We don't know the approver_set in the hook — pass an empty list; the
  // kernel uses the snapshot taken at register time.
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, KERNEL_POLL_INTERVAL_MS));
    const lookup = await approvalLookupByRequest(agentName, requestId, []);
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
