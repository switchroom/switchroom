/**
 * hostd server tests — `config_propose_edit` (PR 1a wire + PR 1b
 * validation pipeline).
 *
 * Coverage map:
 *   - PR 1a (still live): flag-off, admin gate.
 *   - PR 1b: the four validation stages (RFC §4) — each rejection
 *     path AND the happy path that produces E_NOT_IMPLEMENTED_APPLY_PATH
 *     (validation passed; apply still gated behind PR 1c).
 *
 * The flag-on path is tested with a real on-disk scratch config file
 * (`configPath` opt) so the validator's `git apply --check` runs
 * against something real.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostdServer } from "../../src/host-control/server.js";
import { hostdRequest } from "../../src/host-control/client.js";
import type {
  ApprovalGateway,
  ApprovalRequest,
  ApprovalResult,
} from "../../src/host-control/approval-gateway.js";

let tmp: string;
let server: HostdServer;
let stubBin: string;
let configPath: string;

const VALID_BASE_YAML =
  "switchroom:\n" +
  "  version: 1\n" +
  "telegram:\n" +
  '  bot_token: "x"\n' +
  '  forum_chat_id: "1"\n' +
  "agents: {}\n";

function makeServer(opts: {
  configEditEnabled?: boolean;
  configPath?: string;
  approvalGateway?: ApprovalGateway;
  generateApprovalId?: () => string;
  runReconcile?: (args: { requestId: string }) => Promise<{
    exit_code: number;
    stdout: string;
    stderr: string;
  }>;
}) {
  return new HostdServer({
    homeDir: tmp,
    agentUids: { klanker: 10001, bob: 10002 },
    config: {
      agents: { klanker: { admin: true }, bob: {} },
      ...(opts.configEditEnabled !== undefined
        ? { hostd: { config_edit_enabled: opts.configEditEnabled } }
        : {}),
    },
    switchroomBin: stubBin,
    auditLogPath: join(tmp, "audit.log"),
    allowNonLinux: true,
    configPath: opts.configPath,
    approvalGateway: opts.approvalGateway,
    generateApprovalId: opts.generateApprovalId,
    runReconcile: opts.runReconcile,
  });
}

/** Build a stub ApprovalGateway with a pre-canned verdict + finalize spy. */
function stubGateway(verdict: "approve" | "deny" | "timeout") {
  const finalizeCalls: Array<{
    outcome: "applied" | "reconcile_failed_rolled_back";
    detail?: string;
  }> = [];
  const requests: ApprovalRequest[] = [];
  const gw: ApprovalGateway = {
    async requestApproval(req): Promise<ApprovalResult> {
      requests.push(req);
      return {
        verdict,
        finalize: async (out) => {
          finalizeCalls.push(out);
        },
      };
    },
  };
  return { gw, finalizeCalls, requests };
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "hostd-config-edit-"));
  stubBin = join(tmp, "switchroom-stub.sh");
  writeFileSync(stubBin, `#!/bin/sh\necho "stub: $@"\nexit 0\n`);
  chmodSync(stubBin, 0o755);
  configPath = join(tmp, "switchroom.yaml");
  writeFileSync(configPath, VALID_BASE_YAML);
});

afterEach(async () => {
  if (server) await server.stop();
  rmSync(tmp, { recursive: true, force: true });
});

const TINY_DIFF =
  "--- a/switchroom.yaml\n" +
  "+++ b/switchroom.yaml\n" +
  "@@ -1,3 +1,3 @@\n" +
  " switchroom:\n" +
  "-  version: 1\n" +
  "+  version: 1  # touched\n" +
  " agents: {}\n";

async function send(args: {
  sockOwner?: string;
  unified_diff: string;
  request_id: string;
}) {
  const owner = args.sockOwner ?? "klanker";
  const sock = server.getBoundPaths().find((p) => p.endsWith(`/${owner}/sock`))!;
  return hostdRequest(
    { socketPath: sock },
    {
      v: 1,
      op: "config_propose_edit",
      request_id: args.request_id,
      args: {
        unified_diff: args.unified_diff,
        reason: "test",
        target_path: "/state/config/switchroom.yaml",
      },
    },
  );
}

describe("hostd config_propose_edit — PR 1a gates (still live)", () => {
  it("returns E_CONFIG_EDIT_DISABLED when the flag is omitted (default off)", async () => {
    server = makeServer({});
    await server.start();
    const resp = await send({ unified_diff: TINY_DIFF, request_id: "cpe-1" });
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^E_CONFIG_EDIT_DISABLED/);
    expect(resp.error).toMatch(/hostd\.config_edit_enabled=true/);
  });

  it("returns E_CONFIG_EDIT_DISABLED when the flag is explicitly false", async () => {
    server = makeServer({ configEditEnabled: false });
    await server.start();
    const resp = await send({ unified_diff: TINY_DIFF, request_id: "cpe-2" });
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^E_CONFIG_EDIT_DISABLED/);
  });

  it("denies non-admin callers before reading the flag", async () => {
    server = makeServer({ configEditEnabled: true, configPath });
    await server.start();
    const resp = await send({
      sockOwner: "bob",
      unified_diff: TINY_DIFF,
      request_id: "cpe-3",
    });
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/requires admin: true/);
  });
});

describe("hostd config_propose_edit — PR 1b stage 1 (patch shape)", () => {
  beforeEach(async () => {
    server = makeServer({ configEditEnabled: true, configPath });
    await server.start();
  });

  // Note: the wire layer caps every request at MAX_FRAME_BYTES
  // (64 KB), so the >1 MB validator cap is defense-in-depth and is
  // tested directly against `validateConfigEdit` rather than over the
  // socket. See `config-edit-validator.test.ts` for that unit test.

  it("rejects a multi-file diff with E_PATCH_INVALID_SHAPE", async () => {
    const multi =
      TINY_DIFF +
      "--- a/other.yaml\n" +
      "+++ b/other.yaml\n" +
      "@@ -1 +1 @@\n" +
      "-a\n+b\n";
    const resp = await send({ unified_diff: multi, request_id: "s1-2" });
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^E_PATCH_INVALID_SHAPE/);
    expect(resp.error).toMatch(/multi-file/);
  });

  it("rejects a path-traversal header with E_PATCH_INVALID_SHAPE", async () => {
    const evil =
      "--- a/../../etc/passwd\n" +
      "+++ b/../../etc/passwd\n" +
      "@@ -1 +1 @@\n" +
      "-a\n+b\n";
    const resp = await send({ unified_diff: evil, request_id: "s1-3" });
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^E_PATCH_INVALID_SHAPE/);
  });

  it("rejects a diff targeting a non-config file with E_PATCH_INVALID_SHAPE", async () => {
    const wrong =
      "--- a/something-else.yaml\n" +
      "+++ b/something-else.yaml\n" +
      "@@ -1 +1 @@\n" +
      "-a\n+b\n";
    const resp = await send({ unified_diff: wrong, request_id: "s1-4" });
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^E_PATCH_INVALID_SHAPE/);
  });

  it("rejects an absolute-path header with E_PATCH_INVALID_SHAPE", async () => {
    const abs =
      "--- a/switchroom.yaml\n" +
      "+++ /etc/passwd\n" +
      "@@ -1 +1 @@\n" +
      "-a\n+b\n";
    const resp = await send({ unified_diff: abs, request_id: "s1-5" });
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^E_PATCH_INVALID_SHAPE/);
  });
});

describe("hostd config_propose_edit — PR 1b stage 2 (clean apply)", () => {
  beforeEach(async () => {
    server = makeServer({ configEditEnabled: true, configPath });
    await server.start();
  });

  it("rejects a context-mismatched patch with E_PATCH_APPLY_FAILED", async () => {
    const bad =
      "--- a/switchroom.yaml\n" +
      "+++ b/switchroom.yaml\n" +
      "@@ -1,3 +1,3 @@\n" +
      " switchroom:\n" +
      "-  nonexistent: true\n" +
      "+  nonexistent: false\n" +
      " agents: {}\n";
    const resp = await send({ unified_diff: bad, request_id: "s2-1" });
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^E_PATCH_APPLY_FAILED/);
  });
});

describe("hostd config_propose_edit — PR 1b stage 3 (yaml + schema)", () => {
  beforeEach(async () => {
    server = makeServer({ configEditEnabled: true, configPath });
    await server.start();
  });

  it("rejects a patch that introduces a `!!`-tag with E_YAML_UNSAFE_CONSTRUCT", async () => {
    const bad =
      "--- a/switchroom.yaml\n" +
      "+++ b/switchroom.yaml\n" +
      "@@ -4,3 +4,4 @@\n" +
      '   bot_token: "x"\n' +
      '   forum_chat_id: "1"\n' +
      " agents: {}\n" +
      "+evil: !!str danger\n";
    const resp = await send({ unified_diff: bad, request_id: "s3-1" });
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^E_YAML_UNSAFE_CONSTRUCT/);
  });

  it("rejects a patch that introduces an `&` anchor with E_YAML_UNSAFE_CONSTRUCT", async () => {
    const bad =
      "--- a/switchroom.yaml\n" +
      "+++ b/switchroom.yaml\n" +
      "@@ -1,5 +1,6 @@\n" +
      " switchroom:\n" +
      "   version: 1\n" +
      "+anchored: &myref hello\n" +
      " telegram:\n" +
      '   bot_token: "x"\n' +
      '   forum_chat_id: "1"\n';
    const resp = await send({ unified_diff: bad, request_id: "s3-2" });
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^E_YAML_UNSAFE_CONSTRUCT/);
  });

  it("rejects a patch that introduces a `<<:` merge key with E_YAML_UNSAFE_CONSTRUCT", async () => {
    const bad =
      "--- a/switchroom.yaml\n" +
      "+++ b/switchroom.yaml\n" +
      "@@ -4,3 +4,5 @@\n" +
      '   bot_token: "x"\n' +
      '   forum_chat_id: "1"\n' +
      " agents: {}\n" +
      "+merged:\n" +
      "+  <<: {a: 1}\n";
    const resp = await send({ unified_diff: bad, request_id: "s3-3" });
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^E_YAML_UNSAFE_CONSTRUCT/);
  });

  it("rejects schema-invalid post-apply yaml with E_SCHEMA_INVALID", async () => {
    const bad =
      "--- a/switchroom.yaml\n" +
      "+++ b/switchroom.yaml\n" +
      "@@ -1,5 +1,5 @@\n" +
      " switchroom:\n" +
      "-  version: 1\n" +
      "+  version: 2\n" +
      " telegram:\n" +
      '   bot_token: "x"\n' +
      '   forum_chat_id: "1"\n';
    const resp = await send({ unified_diff: bad, request_id: "s3-4" });
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^E_SCHEMA_INVALID/);
  });
});

describe("hostd config_propose_edit — PR 1b stage 4 (secret-leak guard)", () => {
  it("rejects in-lining of a previously-vaulted secret with E_SECRET_LEAK_DETECTED", async () => {
    writeFileSync(
      configPath,
      "switchroom:\n" +
        "  version: 1\n" +
        "telegram:\n" +
        '  bot_token: "vault:telegram/bot_token"\n' +
        '  forum_chat_id: "1"\n' +
        "agents: {}\n",
    );
    server = makeServer({ configEditEnabled: true, configPath });
    await server.start();
    const bad =
      "--- a/switchroom.yaml\n" +
      "+++ b/switchroom.yaml\n" +
      "@@ -1,6 +1,6 @@\n" +
      " switchroom:\n" +
      "   version: 1\n" +
      " telegram:\n" +
      '-  bot_token: "vault:telegram/bot_token"\n' +
      '+  bot_token: "1234567890:AAEhBOOLBOOLBOOLBOOLBOOLBOOLBOOLB"\n' +
      '   forum_chat_id: "1"\n' +
      " agents: {}\n";
    const resp = await send({ unified_diff: bad, request_id: "s4-1" });
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^E_SECRET_LEAK_DETECTED/);
    expect(resp.error).toMatch(/vault reference/);
  });

  it("rejects a literal `sk-...` value with E_SECRET_LEAK_DETECTED", async () => {
    server = makeServer({ configEditEnabled: true, configPath });
    await server.start();
    const bad =
      "--- a/switchroom.yaml\n" +
      "+++ b/switchroom.yaml\n" +
      "@@ -4,3 +4,4 @@\n" +
      '   bot_token: "x"\n' +
      '   forum_chat_id: "1"\n' +
      " agents: {}\n" +
      '+openai_token: "sk-abcdefghijklmnopqrstuvwxyz0123456789"\n';
    const resp = await send({ unified_diff: bad, request_id: "s4-2" });
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^E_SECRET_LEAK_DETECTED/);
    expect(resp.error).toMatch(/openai-key|literal/);
  });

  it("rejects a literal `ghp_...` value with E_SECRET_LEAK_DETECTED", async () => {
    server = makeServer({ configEditEnabled: true, configPath });
    await server.start();
    const bad =
      "--- a/switchroom.yaml\n" +
      "+++ b/switchroom.yaml\n" +
      "@@ -4,3 +4,4 @@\n" +
      '   bot_token: "x"\n' +
      '   forum_chat_id: "1"\n' +
      " agents: {}\n" +
      '+github_token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789"\n';
    const resp = await send({ unified_diff: bad, request_id: "s4-3" });
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^E_SECRET_LEAK_DETECTED/);
    expect(resp.error).toMatch(/github-pat|literal/);
  });
});

describe("hostd config_propose_edit — PR 1b happy path (no approval gateway wired)", () => {
  it("returns E_NO_APPROVAL_GATEWAY when validation passes but no gateway is configured", async () => {
    server = makeServer({ configEditEnabled: true, configPath });
    await server.start();
    const good =
      "--- a/switchroom.yaml\n" +
      "+++ b/switchroom.yaml\n" +
      "@@ -1,3 +1,4 @@\n" +
      "+# touched by config_propose_edit happy-path test\n" +
      " switchroom:\n" +
      "   version: 1\n" +
      " telegram:\n";
    const resp = await send({ unified_diff: good, request_id: "happy-1" });
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^E_NO_APPROVAL_GATEWAY/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// #1623 PR 1c — full apply path (approval card + atomic write +
// reconcile + rollback). All four transitions covered with a stub
// ApprovalGateway and a stub reconcile runner — no docker / no real
// gateway socket.
// ─────────────────────────────────────────────────────────────────────

import { readFileSync as readFile } from "node:fs";

const GOOD_DIFF =
  "--- a/switchroom.yaml\n" +
  "+++ b/switchroom.yaml\n" +
  "@@ -1,3 +1,4 @@\n" +
  "+# touched by apply-path test\n" +
  " switchroom:\n" +
  "   version: 1\n" +
  " telegram:\n";

describe("hostd config_propose_edit — apply path (#1623)", () => {
  it("approves → writes the new content + invokes reconcile + finalizes 'applied'", async () => {
    const { gw, finalizeCalls, requests } = stubGateway("approve");
    let reconcileInvocations = 0;
    server = makeServer({
      configEditEnabled: true,
      configPath,
      approvalGateway: gw,
      generateApprovalId: () => "deadbeef",
      runReconcile: async () => {
        reconcileInvocations += 1;
        return { exit_code: 0, stdout: "applied ok", stderr: "" };
      },
    });
    await server.start();
    const resp = await send({ unified_diff: GOOD_DIFF, request_id: "ap-1" });
    expect(resp.result).toBe("completed");
    expect(resp.exit_code).toBe(0);
    // Card was rendered with the right payload + finalized to 'applied'.
    expect(requests.length).toBe(1);
    expect(requests[0]!.requestId).toBe("deadbeef");
    expect(requests[0]!.agentName).toBe("klanker");
    expect(requests[0]!.unifiedDiff).toBe(GOOD_DIFF);
    expect(finalizeCalls).toEqual([{ outcome: "applied" }]);
    // Live file actually contains the post-patch content.
    const live = readFile(configPath, "utf8");
    expect(live).toContain("# touched by apply-path test");
    expect(reconcileInvocations).toBe(1);
  });

  it("deny tap → returns E_DENIED, no write, no reconcile", async () => {
    const { gw, finalizeCalls } = stubGateway("deny");
    let reconcileInvocations = 0;
    server = makeServer({
      configEditEnabled: true,
      configPath,
      approvalGateway: gw,
      runReconcile: async () => {
        reconcileInvocations += 1;
        return { exit_code: 0, stdout: "", stderr: "" };
      },
    });
    await server.start();
    const before = readFile(configPath, "utf8");
    const resp = await send({ unified_diff: GOOD_DIFF, request_id: "ap-2" });
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^E_DENIED/);
    expect(finalizeCalls.length).toBe(0); // gateway already showed 'denied'
    expect(reconcileInvocations).toBe(0);
    // Live file untouched.
    expect(readFile(configPath, "utf8")).toBe(before);
  });

  it("timeout → returns E_APPROVAL_TIMEOUT, no write, no reconcile", async () => {
    const { gw } = stubGateway("timeout");
    let reconcileInvocations = 0;
    server = makeServer({
      configEditEnabled: true,
      configPath,
      approvalGateway: gw,
      runReconcile: async () => {
        reconcileInvocations += 1;
        return { exit_code: 0, stdout: "", stderr: "" };
      },
    });
    await server.start();
    const before = readFile(configPath, "utf8");
    const resp = await send({ unified_diff: GOOD_DIFF, request_id: "ap-3" });
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^E_APPROVAL_TIMEOUT/);
    expect(reconcileInvocations).toBe(0);
    expect(readFile(configPath, "utf8")).toBe(before);
  });

  it("reconcile failure → rolls back to snapshot + re-runs reconcile + finalizes 'rolled back'", async () => {
    const { gw, finalizeCalls } = stubGateway("approve");
    const snapshotBefore = readFile(configPath, "utf8");
    const reconcileExitCodes = [1, 0]; // first fails, recovery succeeds
    server = makeServer({
      configEditEnabled: true,
      configPath,
      approvalGateway: gw,
      runReconcile: async () => {
        const ec = reconcileExitCodes.shift() ?? 0;
        return {
          exit_code: ec,
          stdout: ec === 0 ? "ok" : "",
          stderr: ec === 0 ? "" : "reconcile boom",
        };
      },
    });
    await server.start();
    const resp = await send({ unified_diff: GOOD_DIFF, request_id: "ap-4" });
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^E_RECONCILE_FAILED_ROLLED_BACK/);
    expect(resp.error).toMatch(/rolled back successfully/);
    // Snapshot restored — live file matches the pre-write content.
    expect(readFile(configPath, "utf8")).toBe(snapshotBefore);
    // Card finalized to the failure state.
    expect(finalizeCalls.length).toBe(1);
    expect(finalizeCalls[0]!.outcome).toBe("reconcile_failed_rolled_back");
    expect(finalizeCalls[0]!.detail).toMatch(/rolled back successfully/);
  });

  it("double-tap protection happens gateway-side (server only sees one verdict)", async () => {
    // Simulate the contract: even if the operator double-taps, the
    // gateway dedups and we receive exactly one resolution. We assert
    // the server does NOT call requestApproval again on retries
    // within the same in-process call — i.e. a single approve verdict
    // produces a single apply + finalize pair.
    const { gw, finalizeCalls, requests } = stubGateway("approve");
    server = makeServer({
      configEditEnabled: true,
      configPath,
      approvalGateway: gw,
      runReconcile: async () => ({ exit_code: 0, stdout: "", stderr: "" }),
    });
    await server.start();
    const resp = await send({ unified_diff: GOOD_DIFF, request_id: "ap-5" });
    expect(resp.result).toBe("completed");
    expect(requests.length).toBe(1);
    expect(finalizeCalls.length).toBe(1);
  });
});
