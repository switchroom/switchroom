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
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  statSync,
  rmSync,
} from "node:fs";
import { execSync } from "node:child_process";
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
    // #1761: policy denial, not server error.
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/^E_CONFIG_EDIT_DISABLED/);
    // #1758 Phase 1: yaml-path hint moved from legacy `error` string
    // into `error_envelope.fix.yaml_path`.
    expect(resp.error_envelope?.code).toBe("E_CONFIG_EDIT_DISABLED");
    expect(resp.error_envelope?.fix).toEqual({
      kind: "flip_yaml_flag",
      yaml_path: "hostd.config_edit_enabled",
      to: true,
    });
  });

  it("returns E_CONFIG_EDIT_DISABLED when the flag is explicitly false", async () => {
    server = makeServer({ configEditEnabled: false });
    await server.start();
    const resp = await send({ unified_diff: TINY_DIFF, request_id: "cpe-2" });
    // #1761: policy denial, not server error.
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/^E_CONFIG_EDIT_DISABLED/);
  });

  it("denies a non-admin caller's NON-self-scoped edit with E_NOT_SELF_SCOPED", async () => {
    // Non-admin callers are now ADMITTED to config_propose_edit (every
    // agent gets a hostd socket) but confined to widening their OWN
    // tools.allow. This diff changes agents.bob.model — bob's own
    // block, but NOT tools.allow — so it's rejected as not-self-scoped.
    writeFileSync(configPath, BOB_CONFIG);
    server = makeServer({ configEditEnabled: true, configPath });
    await server.start();
    const notAllowDiff =
      "--- a/switchroom.yaml\n" +
      "+++ b/switchroom.yaml\n" +
      "@@ -7,3 +7,3 @@\n" +
      "   bob:\n" +
      '     topic_name: "Bob"\n' +
      '-    model: "claude-opus-4-8"\n' +
      '+    model: "claude-haiku-4-5"\n';
    const resp = await send({
      sockOwner: "bob",
      unified_diff: notAllowDiff,
      request_id: "cpe-3",
    });
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/^E_NOT_SELF_SCOPED/);
    expect(resp.error).toMatch(/agents\.bob\.tools\.allow/);
  });
});

// Shared by the self-scope tests: bob exists as a non-admin agent with
// one anchor field (model) so the always-allow diff has stable context.
const BOB_CONFIG =
  "switchroom:\n" +
  "  version: 1\n" +
  "telegram:\n" +
  '  bot_token: "x"\n' +
  '  forum_chat_id: "1"\n' +
  "agents:\n" +
  "  bob:\n" +
  '    topic_name: "Bob"\n' +
  '    model: "claude-opus-4-8"\n';

describe("hostd config_propose_edit — non-admin self-scoped always-allow", () => {
  // Adds a rule to agents.bob.tools.allow — the "🔁 Always allow" path.
  const SELF_SCOPED_DIFF =
    "--- a/switchroom.yaml\n" +
    "+++ b/switchroom.yaml\n" +
    "@@ -7,3 +7,6 @@\n" +
    "   bob:\n" +
    '     topic_name: "Bob"\n' +
    '     model: "claude-opus-4-8"\n' +
    "+    tools:\n" +
    "+      allow:\n" +
    "+        - mcp__perplexity__search\n";

  it("admits the non-admin caller and applies after operator approval", async () => {
    writeFileSync(configPath, BOB_CONFIG);
    const { gw, finalizeCalls, requests } = stubGateway("approve");
    let reconcileInvocations = 0;
    server = makeServer({
      configEditEnabled: true,
      configPath,
      approvalGateway: gw,
      generateApprovalId: () => "feedface",
      runReconcile: async () => {
        reconcileInvocations += 1;
        return { exit_code: 0, stdout: "applied ok", stderr: "" };
      },
    });
    await server.start();
    const resp = await send({
      sockOwner: "bob",
      unified_diff: SELF_SCOPED_DIFF,
      request_id: "ss-1",
    });
    expect(resp.result).toBe("completed");
    expect(requests.length).toBe(1);
    expect(requests[0]!.agentName).toBe("bob");
    expect(finalizeCalls).toEqual([{ outcome: "applied" }]);
    const live = readFileSync(configPath, "utf8");
    expect(live).toContain("mcp__perplexity__search");
    expect(reconcileInvocations).toBe(1);
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
    // #1761: validation rejections now carry a structured envelope
    // (fix.kind: "bad_input") so the agent can render a targeted fix
    // hint instead of regexing the legacy string.
    expect(resp.error_envelope?.code).toBe("E_PATCH_APPLY_FAILED");
    expect(resp.error_envelope?.fix).toEqual({
      kind: "bad_input",
      field: "unified_diff",
    });
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
    // #1761: structured envelope hints operator wiring is missing.
    expect(resp.error_envelope?.code).toBe("E_NO_APPROVAL_GATEWAY");
    expect(resp.error_envelope?.fix?.kind).toBe("operator_action");
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
    // #1761: operator tap-deny is a policy denial, not server error.
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/^E_DENIED/);
    expect(resp.error_envelope?.code).toBe("E_DENIED");
    expect(resp.error_envelope?.fix?.kind).toBe("operator_action");
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
    // #1761: approval-card timeout is a policy denial path.
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/^E_APPROVAL_TIMEOUT/);
    expect(resp.error_envelope?.code).toBe("E_APPROVAL_TIMEOUT");
    expect(resp.error_envelope?.fix?.kind).toBe("operator_action");
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
    // #1771: envelope-shape assertion for E_RECONCILE_FAILED_ROLLED_BACK
    // (the shared `reconcileFailedRolledBack()` helper introduced in #1769).
    // Infra-class failure — agent cannot self-recover, so the structured
    // hint points the operator at the underlying write/reconcile output.
    expect(resp.error_envelope?.code).toBe("E_RECONCILE_FAILED_ROLLED_BACK");
    expect(resp.error_envelope?.fix?.kind).toBe("operator_action");
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

  // #1771: envelope-shape assertion for E_APPROVAL_DISPATCH_FAILED — the
  // infra-vs-policy split introduced in #1769 branches on
  // `denySource === "dispatch_failure"`. The dispatch-failure branch must
  // be an INFRA error (result: "error", fix.kind: "operator_action"),
  // distinct from an operator-tap deny (which is policy → result: "denied").
  it("deny with denySource=dispatch_failure → E_APPROVAL_DISPATCH_FAILED envelope (infra, not policy)", async () => {
    let reconcileInvocations = 0;
    const finalizeCalls: Array<{ outcome: string; detail?: string }> = [];
    const gw: ApprovalGateway = {
      async requestApproval(_req): Promise<ApprovalResult> {
        return {
          verdict: "deny",
          reason: "telegram sendMessage 400 bad request",
          denySource: "dispatch_failure",
          finalize: async (out) => {
            finalizeCalls.push(out);
          },
        };
      },
    };
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
    const resp = await send({ unified_diff: GOOD_DIFF, request_id: "ap-6" });
    // Infra-class failure — NOT a policy denial.
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^E_APPROVAL_DISPATCH_FAILED/);
    expect(resp.error_envelope?.code).toBe("E_APPROVAL_DISPATCH_FAILED");
    expect(resp.error_envelope?.fix?.kind).toBe("operator_action");
    // No write, no reconcile attempted (deny short-circuits).
    expect(reconcileInvocations).toBe(0);
    expect(readFile(configPath, "utf8")).toBe(before);
    // Gateway-side denial already shown to operator — no finalize call.
    expect(finalizeCalls.length).toBe(0);
  });

  // #1771: envelope-shape assertion for E_DISPATCH_FAILED — top-level
  // catch-all on uncaught dispatch exceptions (server.ts:663-680). Forced
  // here by injecting a `runReconcile` that throws synchronously inside
  // the handler, bubbling out past all inner try blocks to the outer
  // dispatch try/catch. Genuine server fault: no `fix` hint is set
  // (the agent cannot self-recover from an unexpected exception).
  it("uncaught dispatch exception → E_DISPATCH_FAILED envelope (no fix kind)", async () => {
    const { gw } = stubGateway("approve");
    server = makeServer({
      configEditEnabled: true,
      configPath,
      approvalGateway: gw,
      runReconcile: async () => {
        throw new Error("simulated reconcile-runner crash");
      },
    });
    await server.start();
    const resp = await send({ unified_diff: GOOD_DIFF, request_id: "ap-7" });
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^hostd dispatch failed: /);
    expect(resp.error).toMatch(/simulated reconcile-runner crash/);
    expect(resp.error_envelope?.code).toBe("E_DISPATCH_FAILED");
    // Genuine server fault — no actionable fix hint.
    expect(resp.error_envelope?.fix).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Bind-mount-safe write (EBUSY fix). /state/config/switchroom.yaml is
// itself an individual read-only bind-mount SOURCE mounted into every
// agent container. The old apply path wrote `<file>.tmp` then
// `rename(tmp, configPath)` — but you cannot rename() OVER an active
// bind-mount source/target: the kernel returns EBUSY. The fix writes
// in place (truncate + write the live inode) for both the forward apply
// and the rollback restore, so the inode is preserved and the mounts
// stay valid. These tests pin that behaviour: a rename-based writer
// would change the inode (and reset the mode to the umask default),
// failing the assertions below; the in-place writer preserves both.
// ─────────────────────────────────────────────────────────────────────
describe("hostd config_propose_edit — bind-mount-safe in-place write", () => {
  it("preserves the target inode + mode across a successful apply (no rename-over-target)", async () => {
    const { gw, finalizeCalls } = stubGateway("approve");
    // A distinctive non-default mode the rename path would not reproduce.
    chmodSync(configPath, 0o600);
    const inoBefore = statSync(configPath).ino;
    server = makeServer({
      configEditEnabled: true,
      configPath,
      approvalGateway: gw,
      runReconcile: async () => ({ exit_code: 0, stdout: "ok", stderr: "" }),
    });
    await server.start();
    const resp = await send({ unified_diff: GOOD_DIFF, request_id: "ip-1" });
    expect(resp.result).toBe("completed");
    expect(finalizeCalls).toEqual([{ outcome: "applied" }]);
    // Content updated …
    expect(readFile(configPath, "utf8")).toContain(
      "# touched by apply-path test",
    );
    const st = statSync(configPath);
    // … but the inode is the SAME (rename would have allocated a new one).
    expect(st.ino).toBe(inoBefore);
    // … and the mode is preserved (rename would reset to the umask default).
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("rollback restores via in-place write — inode preserved, snapshot restored", async () => {
    const { gw, finalizeCalls } = stubGateway("approve");
    chmodSync(configPath, 0o600);
    const inoBefore = statSync(configPath).ino;
    const snapshotBefore = readFile(configPath, "utf8");
    const reconcileExitCodes = [1, 0]; // first fails → rollback, recovery ok
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
    const resp = await send({ unified_diff: GOOD_DIFF, request_id: "ip-2" });
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^E_RECONCILE_FAILED_ROLLED_BACK/);
    // Snapshot restored byte-for-byte …
    expect(readFile(configPath, "utf8")).toBe(snapshotBefore);
    const st = statSync(configPath);
    // … via in-place write: same inode, same mode.
    expect(st.ino).toBe(inoBefore);
    expect(st.mode & 0o777).toBe(0o600);
    expect(finalizeCalls[0]!.outcome).toBe("reconcile_failed_rolled_back");
  });

  // The real-world repro: the config path is itself a bind-mount target.
  // `mount --bind` needs root + Linux, so this is gated. On a matching
  // host it proves the EBUSY class is actually defeated end-to-end — a
  // rename-over-target here would throw EBUSY and fail the apply.
  const canBindMount =
    process.platform === "linux" &&
    typeof process.getuid === "function" &&
    process.getuid() === 0;
  it.skipIf(!canBindMount)(
    "applies over a file that is itself a bind-mount target (EBUSY repro)",
    async () => {
      const { gw } = stubGateway("approve");
      // backing.yaml holds the real bytes; configPath is an empty file we
      // bind-mount the backing over, so configPath becomes a mount target.
      const backing = join(tmp, "backing.yaml");
      writeFileSync(backing, VALID_BASE_YAML);
      // configPath already exists (beforeEach) — bind backing over it.
      execSync(`mount --bind ${backing} ${configPath}`);
      try {
        server = makeServer({
          configEditEnabled: true,
          configPath,
          approvalGateway: gw,
          runReconcile: async () => ({
            exit_code: 0,
            stdout: "ok",
            stderr: "",
          }),
        });
        await server.start();
        const resp = await send({ unified_diff: GOOD_DIFF, request_id: "ip-3" });
        // The whole point: in-place write succeeds where rename → EBUSY.
        expect(resp.result).toBe("completed");
        expect(readFile(configPath, "utf8")).toContain(
          "# touched by apply-path test",
        );
      } finally {
        execSync(`umount ${configPath}`);
      }
    },
  );
});
