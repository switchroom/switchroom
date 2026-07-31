/**
 * Regression test for #4069 — the "kernel record failed" false toast.
 *
 * The kernel's approval_consume_record reply carries `decision_id`, but
 * the client decodes every reply through ResponseSchema (a plain
 * z.union, first-match wins, unknown keys stripped). With
 * OkApprovalConsumeResponseSchema ordered before
 * OkApprovalConsumeRecordResponseSchema, the consume_record reply
 * matched the prefix schema and `decision_id` was silently stripped —
 * so handleApprovalCallback hit its defensive `!result.decision_id`
 * branch, toasted "kernel record failed", and returned before editing
 * the card to its granted state. Deterministic on EVERY `apv:` approval
 * tap. The audit row was never lost — the kernel committed it — this
 * was purely the client's mangled view of the reply.
 *
 * This test drives handleApprovalCallback end-to-end against a fake
 * kernel serving a REAL wire frame through the REAL
 * rpcRaw/decodeResponse path (the kernel suites parse the wire with raw
 * JSON.parse and bypass decodeResponse — which is exactly why they
 * missed this). It asserts the tap lands: no "kernel record failed"
 * toast, and the card advances to its granted body carrying the
 * decision_id revoke hint.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as net from "node:net";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Context } from "grammy";
import { handleApprovalCallback } from "./approval-callback.js";

const REQUEST_ID = "0123456789abcdef0123456789abcdef";
const DECISION_ID = "dec-4069";

/** One-shot fake kernel: replies to the first request line with `reply`. */
function startFakeKernel(
  socketPath: string,
  reply: Record<string, unknown>,
  seen: string[],
): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((conn) => {
      let buf = "";
      conn.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const idx = buf.indexOf("\n");
        if (idx === -1) return;
        seen.push(buf.slice(0, idx));
        conn.write(JSON.stringify(reply) + "\n");
      });
    });
    server.on("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}

function makeFakeCtx(): {
  ctx: Context;
  toasts: string[];
  edits: Array<{ markdown: string }>;
} {
  const toasts: string[] = [];
  const edits: Array<{ markdown: string }> = [];
  const ctx = {
    from: { id: 42 },
    answerCallbackQuery: async (args?: { text?: string }) => {
      toasts.push(args?.text ?? "");
      return true;
    },
    editMessageText: async (body: { markdown: string }) => {
      edits.push(body);
      return true;
    },
  } as unknown as Context;
  return { ctx, toasts, edits };
}

describe("handleApprovalCallback × real decodeResponse (#4069)", () => {
  let server: net.Server | undefined;
  let tmpDir: string | undefined;
  const savedEnv = process.env.SWITCHROOM_KERNEL_SOCKET;

  afterEach(async () => {
    if (server) await new Promise((r) => server!.close(r));
    server = undefined;
    if (savedEnv === undefined) delete process.env.SWITCHROOM_KERNEL_SOCKET;
    else process.env.SWITCHROOM_KERNEL_SOCKET = savedEnv;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it("approve tap records + advances the card — no false 'kernel record failed'", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sr4069-"));
    const socketPath = path.join(tmpDir, "kernel.sock");
    const seen: string[] = [];
    server = await startFakeKernel(
      socketPath,
      {
        ok: true,
        consumed: true,
        decision_id: DECISION_ID,
        agent_unit: "clerk",
        scope: "doc:gdrive:D1",
        action: "write",
        why: null,
      },
      seen,
    );
    process.env.SWITCHROOM_KERNEL_SOCKET = socketPath;

    const { ctx, toasts, edits } = makeFakeCtx();
    await handleApprovalCallback(ctx, `apv:${REQUEST_ID}:once`);

    // The fake kernel really received the atomic consume+record op.
    expect(seen.length).toBe(1);
    expect(JSON.parse(seen[0]!)).toMatchObject({
      op: "approval_consume_record",
      request_id: REQUEST_ID,
      decision: "allow_once",
    });

    // Outcome: the tap must land as Approved, never the false-failure
    // toast, and the card must advance to its granted body carrying the
    // decision_id revoke hint.
    expect(toasts).not.toContain("kernel record failed");
    expect(toasts).toContain("Approved");
    expect(edits.length).toBe(1);
    expect(edits[0]!.markdown).toContain(DECISION_ID);
    expect(edits[0]!.markdown).toContain("granted once");
  });
});
