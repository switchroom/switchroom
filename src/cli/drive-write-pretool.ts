/**
 * PreToolUse hook entry — RFC E §4.2 Cut 2. Bundled to a self-
 * contained .mjs at build time (`scripts/build.mjs` → `dist/cli/
 * drive-write-pretool.mjs`) so it can run inside the agent
 * container with zero relative imports.
 *
 * Claude Code PreToolUse protocol (v1):
 *   Input:  JSON on stdin — { session_id, tool_name, tool_input, ... }
 *   Output: exit 0 + empty stdout → allow.
 *           exit 0 + JSON on stdout with `decision: "block"` + `reason` → block.
 *
 * Flow:
 *   1. Read tool_input. If tool isn't a gated Drive write, exit 0 (allow).
 *   2. Check kernel for an existing always-grant on doc:gdrive:write:<file_id>.
 *      If granted, exit 0 (allow). The user already said yes for this doc.
 *   3. Fetch Google access token via auth-broker.
 *   4. Fetch documents.get for the target doc.
 *   5. Build DiffPreviewInput via buildWritePreview.
 *   6. Send IPC `request_drive_approval` to the gateway socket; the
 *      gateway posts the card to Telegram and replies with
 *      `drive_approval_posted` carrying the kernel request_id.
 *   7. Poll approval_lookup until verdict (granted / denied / expired)
 *      or the kernel-side expires_at_ms deadline.
 *   8. Return decision: granted → allow, anything else → block.
 *
 * Fail-closed:
 *   - Broker unreachable → block (user can't see card; can't approve).
 *   - Gateway unreachable → block.
 *   - Docs.get failure → block (no wrapper-attested location to show).
 *   - Timeout / no decision → block.
 *
 * Fail-open ONLY when:
 *   - Tool isn't in the gated set (unknown / non-gated upstream tools).
 *   - stdin parse fails (Claude Code protocol error — not our concern).
 *   - SWITCHROOM_AGENT_NAME missing (we don't know which agent we're
 *     gating).
 */

import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { fetchDocumentSnapshot } from "../drive/docs-get.js";
import { loadFromAuthBroker } from "../drive/wrapper-broker.js";
import {
  GATED_DRIVE_WRITE_TOOLS,
  buildWritePreview,
  stripPrefix,
} from "../drive/write-preview.js";
import {
  evaluateGatedWrite,
  requireOperatorApprovalForWrites,
  type GatedWriteLookup,
} from "../vault/approvals/gated-write-policy.js";

// ─── Tunables ─────────────────────────────────────────────────────────────

const HOOK_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — matches kernel default TTL
const KERNEL_POLL_INTERVAL_MS = 2000;
const IPC_CONNECT_TIMEOUT_MS = 3000;
const IPC_REPLY_TIMEOUT_MS = 10_000;
const KERNEL_RPC_TIMEOUT_MS = 3000;

// Gateway IPC socket. Compose / start.sh export TELEGRAM_STATE_DIR
// into every agent-container child process; `gateway.sock` lives at
// `<TELEGRAM_STATE_DIR>/gateway.sock` (see gateway.ts:362-363 for the
// gateway side of this contract). The `SWITCHROOM_GATEWAY_SOCKET`
// override lets tests / host invocations point elsewhere.
const GATEWAY_SOCKET =
  process.env.SWITCHROOM_GATEWAY_SOCKET ??
  (process.env.TELEGRAM_STATE_DIR !== undefined
    ? join(process.env.TELEGRAM_STATE_DIR, "gateway.sock")
    : join(homedir(), ".claude", "channels", "telegram", "gateway.sock"));

// ─── Stdin parse ──────────────────────────────────────────────────────────

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// ─── Decision helpers ─────────────────────────────────────────────────────

function allow(): never {
  process.exit(0);
}

function block(reason: string): never {
  // Truncate reason to keep the toast readable — Claude Code surfaces this
  // back to the user as "tool blocked: <reason>" or similar.
  const safe = String(reason)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .slice(0, 200);
  process.stdout.write(JSON.stringify({ decision: "block", reason: safe }));
  process.exit(0);
}

// ─── Agent name ───────────────────────────────────────────────────────────

const agentName = process.env.SWITCHROOM_AGENT_NAME;
if (!agentName) {
  // Hook can't function without the agent context. Fail-open here is the
  // safe choice — secret-guard-pretool.mjs makes the same call.
  allow();
}

// ─── Kernel client (NDJSON over UDS) ──────────────────────────────────────
//
// Canonical env name is `SWITCHROOM_KERNEL_SOCKET` (the docker compose
// generator sets this, see `src/agents/compose.ts`); the canonical
// in-container path is `/run/switchroom/kernel/sock` — there's no
// per-agent subdirectory on the agent side, the kernel multiplexes by
// peercred. Mirroring `src/vault/approvals/client.ts:resolveKernelSocketPath`.

const KERNEL_SOCKET =
  process.env.SWITCHROOM_KERNEL_SOCKET ?? "/run/switchroom/kernel/sock";

interface KernelResponse {
  ok?: boolean;
  state?: string;
  [k: string]: unknown;
}

async function rpcKernel(
  payload: Record<string, unknown>,
  timeoutMs = KERNEL_RPC_TIMEOUT_MS,
): Promise<KernelResponse | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const finalize = (v: KernelResponse | null) => {
      if (resolved) return;
      resolved = true;
      try {
        sock?.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    let sock: ReturnType<typeof createConnection> | null = null;
    const timer = setTimeout(() => finalize(null), timeoutMs);
    try {
      sock = createConnection({ path: KERNEL_SOCKET });
    } catch {
      clearTimeout(timer);
      finalize(null);
      return;
    }
    let buf = "";
    sock.on("connect", () => {
      sock!.write(JSON.stringify(payload) + "\n");
    });
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        const line = buf.slice(0, nl);
        clearTimeout(timer);
        try {
          finalize(JSON.parse(line));
        } catch {
          finalize(null);
        }
      }
    });
    sock.on("error", () => {
      clearTimeout(timer);
      finalize(null);
    });
  });
}

/**
 * Look the scope up in the kernel. Returns BOTH the lifecycle state and
 * the decision's server-stamped `origin` — `state` alone cannot
 * distinguish an operator tap from a decision this agent recorded for
 * itself on this same socket (see gated-write-policy.ts).
 */
async function approvalLookup(
  scope: string,
  approverSet: string[],
): Promise<GatedWriteLookup> {
  const r = await rpcKernel({
    v: 1,
    op: "approval_lookup",
    agent_unit: agentName,
    scope,
    action: "write",
    current_approver_set: approverSet,
  });
  if (r === null || r.ok !== true) return { state: null };
  const dec = r.decision as { origin?: unknown } | null | undefined;
  const origin =
    dec != null && (dec.origin === "operator" || dec.origin === "agent")
      ? dec.origin
      : undefined;
  return {
    state: typeof r.state === "string" ? r.state : null,
    origin,
  };
}

/** Read once at hook start — the gate must not change mid-poll. */
const REQUIRE_OPERATOR_ORIGIN = requireOperatorApprovalForWrites();

// ─── Operator allowFrom discovery ─────────────────────────────────────────

function loadAllowFrom(): string[] {
  // Mirrors the gateway's loadAccess() (see gateway.ts:362-363).
  // access.json lives at `<TELEGRAM_STATE_DIR>/access.json` inside
  // the agent container; the host scaffold path
  // `~/.switchroom/agents/<agent>/.switchroom/state/telegram-plugin/access.json`
  // doesn't exist in the container. Fallback only kicks in for
  // host-side invocations (tests, debug tools).
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

// ─── Gateway IPC (NDJSON over UDS) ────────────────────────────────────────

interface GatewayReply {
  ok: boolean;
  reason?: string;
  requestId?: string;
  expiresAtMs?: number;
}

async function requestDriveApprovalViaGateway(
  correlationId: string,
  preview: Record<string, unknown>,
): Promise<GatewayReply> {
  return new Promise((resolve) => {
    let resolved = false;
    const finalize = (v: GatewayReply) => {
      if (resolved) return;
      resolved = true;
      try {
        sock?.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    let sock: ReturnType<typeof createConnection> | null = null;
    const connectTimer = setTimeout(
      () => finalize({ ok: false, reason: "gateway IPC connect timeout" }),
      IPC_CONNECT_TIMEOUT_MS,
    );
    try {
      sock = createConnection({ path: GATEWAY_SOCKET });
    } catch (err) {
      clearTimeout(connectTimer);
      finalize({
        ok: false,
        reason: `gateway IPC connect failed: ${(err as Error).message}`,
      });
      return;
    }
    let buf = "";
    let replyTimer: NodeJS.Timeout | null = null;
    sock.on("connect", () => {
      clearTimeout(connectTimer);
      sock!.write(
        JSON.stringify({
          type: "request_drive_approval",
          correlationId,
          agentName,
          preview,
          ttlMs: HOOK_TIMEOUT_MS,
        }) + "\n",
      );
      replyTimer = setTimeout(
        () => finalize({ ok: false, reason: "gateway reply timeout" }),
        IPC_REPLY_TIMEOUT_MS,
      );
    });
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (
          msg.type === "drive_approval_posted" &&
          msg.correlationId === correlationId
        ) {
          if (replyTimer) clearTimeout(replyTimer);
          finalize({
            ok: msg.ok === true,
            reason: typeof msg.reason === "string" ? msg.reason : undefined,
            requestId:
              typeof msg.requestId === "string" ? msg.requestId : undefined,
            expiresAtMs:
              typeof msg.expiresAtMs === "number" ? msg.expiresAtMs : undefined,
          });
          return;
        }
      }
    });
    sock.on("error", (err: Error) => {
      clearTimeout(connectTimer);
      if (replyTimer) clearTimeout(replyTimer);
      finalize({ ok: false, reason: `gateway IPC error: ${err.message}` });
    });
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const raw = readStdin().trim();
  if (!raw) allow();
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    allow();
    return;
  }
  const toolName = event.tool_name;
  const toolInput = event.tool_input;
  if (typeof toolName !== "string" || toolInput == null) allow();
  const tn = toolName as string;

  // 1. Fast no-gate path — anything that isn't an upstream Drive write
  // we whitelisted falls through ungated.
  const fn = stripPrefix(tn);
  if (fn === null || !GATED_DRIVE_WRITE_TOOLS.has(fn)) allow();

  // 2. Fast already-allowed path. If the user previously tapped Always
  // on a card for this doc, lookup returns 'granted' and we let the
  // tool through with no card.
  const input = toolInput as Record<string, unknown>;
  const documentId =
    typeof input.document_id === "string" ? input.document_id : null;
  if (documentId === null) {
    block("upstream tool_input missing document_id (cannot gate)");
  }
  const scope = `doc:gdrive:write:${documentId}`;
  const allowFrom = loadAllowFrom();
  if (allowFrom.length === 0) {
    // No paired operator → no one can approve. Fail closed.
    block("no operator paired — cannot post approval card");
  }
  const existing = await approvalLookup(scope, allowFrom);
  const existingAction = evaluateGatedWrite(existing, REQUIRE_OPERATOR_ORIGIN);
  if (existingAction.kind === "allow") {
    allow();
  }
  if (existingAction.kind === "block") {
    // A live grant that is NOT operator-verified. Refuse HERE — before
    // the auth-broker call, the documents.get, and the card post below.
    // The verdict already exists and can never become allowable, so
    // carrying on would spend a live Google API call and show the
    // operator a fresh approval card that the poll site would instantly
    // self-refuse. (review 2026-07-25 F2: "fail closed immediately" was
    // true of ms-365 but not of this hook. Now it is true of both.)
    block(`Drive write refused: ${existingAction.reason}`);
  }

  // 3. Auth-broker access token.
  let handle: { access_token: string } | null;
  try {
    handle = await loadFromAuthBroker();
  } catch (err) {
    block(`auth-broker error: ${(err as Error).message}`);
  }
  if (handle === null) {
    block("auth-broker unreachable — Google not connected for this agent");
  }

  // 4. Fetch doc snapshot for the wrapper-attested location.
  let doc;
  try {
    doc = await fetchDocumentSnapshot({
      access_token: handle!.access_token,
      document_id: documentId as string,
    });
  } catch (err) {
    block(`documents.get failed: ${(err as Error).message}`);
  }

  // 5. Build the preview spec.
  const previewResult = buildWritePreview({
    agentName: agentName as string,
    toolName: tn,
    toolInput: input,
    doc: doc!,
    mimeType: "application/vnd.google-apps.document",
  });
  if (!previewResult.ok) {
    // Unrecognised tool shape — defensive default is allow, since the
    // GATED_DRIVE_WRITE_TOOLS filter at step 1 should already have caught
    // this case. If we hit it, the upstream MCP added a new tool we
    // haven't taught the previewer about; better to let it through than
    // block silently.
    if (previewResult.reason === "unrecognized_tool") allow();
    else block(`preview build failed: ${previewResult.detail}`);
    return;
  }

  // 6. IPC to gateway — register kernel request + post card.
  const correlationId = randomBytes(8).toString("hex");
  const ipcReply = await requestDriveApprovalViaGateway(
    correlationId,
    previewResult.preview as unknown as Record<string, unknown>,
  );
  if (!ipcReply.ok) {
    block(`gateway: ${ipcReply.reason ?? "unknown"}`);
  }
  const expiresAtMs = ipcReply.expiresAtMs ?? Date.now() + HOOK_TIMEOUT_MS;

  // 7. Poll kernel until verdict. The deadline is the kernel's own
  // expires_at (gateway-computed) plus one poll interval of slack so
  // a grant that lands in the last sub-poll window before kernel
  // expiry is still observed.
  const deadline = Math.min(
    Date.now() + HOOK_TIMEOUT_MS,
    expiresAtMs + KERNEL_POLL_INTERVAL_MS,
  );
  // Immediate first poll — the user could already have tapped the
  // card by the time the IPC reply lands (gateway sends synchronously,
  // the round-trip is ms). Polling after a 2s sleep on the first
  // iteration would wait unnecessarily.
  for (let first = true; Date.now() < deadline; first = false) {
    if (!first) {
      await new Promise((r) => setTimeout(r, KERNEL_POLL_INTERVAL_MS));
    }
    const lookup = await approvalLookup(scope, allowFrom);
    const state = lookup.state;
    // Same shared classifier as the pre-card fast path above — the
    // provenance rule lives in ONE unit-tested function so it cannot be
    // present at one gate site and missing at the other.
    const action = evaluateGatedWrite(lookup, REQUIRE_OPERATOR_ORIGIN);
    if (action.kind === "allow") {
      allow();
    }
    if (action.kind === "block") {
      // Granted but not operator-verified — the operator tapped and the
      // kernel recorded an agent-origin row, which is not proof of a tap.
      // Fail closed rather than spin to the deadline on a decision we
      // will never accept.
      //
      // COVERAGE BOUNDARY (measured, review 2026-07-25 F1): this branch is
      // defence-in-depth only, and mutation-testing confirms deleting it
      // leaves the hook suite green — because a pre-existing bad grant is
      // already refused by the fast path above, so an end-to-end test can
      // never reach here. It fires only for a decision recorded AFTER the
      // fast path ran (mid-poll). The rule it enforces is not untested:
      // `evaluateGatedWrite` is unit-tested in gated-write-policy.test.ts
      // (deleting its block branch fails BOTH suites), which is precisely
      // why the logic was hoisted out of the call sites.
      block(`Drive write refused: ${action.reason}`);
    }
    if (state === "denied" || state === "drift_revoked") {
      block(`user denied Drive write (kernel verdict: ${state})`);
    }
    if (state === "expired") {
      block("approval timed out");
    }
    // 'pending' / 'no_decision' / null → continue polling
  }
  block("approval timed out — user did not tap within 5 min");
}

main().catch((err) => {
  // Last-resort catch — anything we haven't handled cleanly above falls
  // here. Block fails closed.
  try {
    block(`hook crash: ${(err as Error).message ?? String(err)}`);
  } catch {
    process.exit(0);
  }
});
