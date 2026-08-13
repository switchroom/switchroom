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
  symlinkSync,
  linkSync,
  realpathSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HostdServer,
  checkConfigPathProvenance,
  configPathProvenanceWarning,
  CONFIG_PATH_PROVENANCE_TAG,
} from "../../src/host-control/server.js";
import { CANONICAL_CONFIG_PATH } from "../../src/host-control/protocol.js";
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
  runReconcile?: (args: {
    requestId: string;
    env?: Record<string, string>;
  }) => Promise<{
    exit_code: number;
    stdout: string;
    stderr: string;
  }>;
  writeConfigFile?: (path: string, content: string) => void;
  resolveFleetConfigPath?: () => string;
  identifyForProvenance?: (p: string) => { dev: number; ino: number };
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
    writeConfigFile: opts.writeConfigFile,
    resolveFleetConfigPath: opts.resolveFleetConfigPath,
    identifyForProvenance: opts.identifyForProvenance,
  });
}

/** Build a stub ApprovalGateway with a pre-canned verdict + finalize spy. */
function stubGateway(verdict: "approve" | "deny" | "timeout") {
  const finalizeCalls: Array<{
    outcome: "applied" | "aborted_config_changed" | "reconcile_failed_rolled_back";
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
    expect(finalizeCalls.length).toBe(1);
    expect(finalizeCalls[0]!.outcome).toBe("applied");
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
    expect(finalizeCalls.length).toBe(1);
    expect(finalizeCalls[0]!.outcome).toBe("applied");
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
    expect(finalizeCalls.length).toBe(1);
    expect(finalizeCalls[0]!.outcome).toBe("applied");
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

/**
 * #3084 security audit — apply-time re-validation (TOCTOU / silent-revert).
 *
 * config_propose_edit computes the whole-file post-image at PROPOSE time, then
 * posts an operator approval card that can block for up to 60 minutes. Before
 * the fix, on approval the STALE whole-file post-image was written verbatim —
 * so any config change that landed during the approval window (a second
 * approved proposal, an operator hand-edit) was SILENTLY REVERTED, including
 * security fields like another agent's tools.allow or hostd.config_edit_enabled.
 *
 * The fix NEVER writes the propose-time whole-file post-image. Under the apply
 * mutex it re-applies the STORED DIFF against the CURRENT live file:
 *   - a concurrent edit to some OTHER region still applies cleanly, so BOTH
 *     changes survive and the apply COMPLETES (a unified diff only rewrites its
 *     own hunks — legitimate non-conflicting concurrent edits are not denied);
 *   - only a REAL conflict — the drift overlaps this diff's hunk lines so the
 *     patch no longer applies — ABORTS with E_CONFIG_CHANGED (re-propose),
 *     leaving the intervening change intact.
 */
describe("hostd config_propose_edit — apply-time re-apply guard (#3084)", () => {
  // A gateway that simulates another writer changing the live config DURING
  // the approval window: it writes `landed` to the file just before returning
  // `approve` (i.e. after propose-time validation, but before the apply runs).
  function driftingGateway(landed: string) {
    const finalizeCalls: Array<{
      outcome: "applied" | "aborted_config_changed" | "reconcile_failed_rolled_back";
      detail?: string;
    }> = [];
    const gw: ApprovalGateway = {
      async requestApproval(): Promise<ApprovalResult> {
        writeFileSync(configPath, landed);
        return {
          verdict: "approve",
          finalize: async (out) => {
            finalizeCalls.push(out);
          },
        };
      },
    };
    return { gw, finalizeCalls };
  }

  // An intervening operator hand-edit that rotated the bot token — a
  // security-relevant change on line 4, a region GOOD_DIFF's hunk (lines 1-3)
  // never touches, so the stored diff STILL APPLIES cleanly on top of it and
  // the result stays schema-valid. A whole-file post-image write would silently
  // revert the rotation; re-applying the diff preserves it.
  const NON_CONFLICTING_EDIT_LANDED =
    "switchroom:\n" +
    "  version: 1\n" +
    "telegram:\n" +
    '  bot_token: "OPERATOR-ROTATED"\n' +
    '  forum_chat_id: "1"\n' +
    "agents: {}\n";

  // A conflicting operator hand-edit: it rewrites `  version: 1` — one of the
  // exact context lines GOOD_DIFF's hunk depends on — so the stored diff NO
  // LONGER APPLIES. This is the genuine-conflict path that MUST deny.
  const CONFLICTING_HAND_EDIT =
    "switchroom:\n" +
    "  version: 2\n" +
    "telegram:\n" +
    '  bot_token: "x"\n' +
    '  forum_chat_id: "1"\n' +
    "agents: {}\n";

  it("(a) a non-conflicting concurrent edit (other region) COMPLETES and both changes survive", async () => {
    const { gw, finalizeCalls } = driftingGateway(NON_CONFLICTING_EDIT_LANDED);
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
    // GOOD_DIFF prepends a comment at the top (lines 1-3 context). The operator's
    // token rotation landed on line 4 during the window — a DIFFERENT region.
    // Re-applying the stored diff against the drifted file succeeds, so the apply
    // COMPLETES and BOTH survive. A naive whole-file post-image write would
    // silently revert the rotation.
    const resp = await send({ unified_diff: GOOD_DIFF, request_id: "drift-a" });
    expect(resp.result).toBe("completed");
    expect(reconcileInvocations).toBe(1);
    expect(finalizeCalls.length).toBe(1);
    expect(finalizeCalls[0]!.outcome).toBe("applied");
    // BOTH the intervening security-relevant rotation AND this proposal's own
    // change land.
    const live = readFile(configPath, "utf8");
    expect(live).toContain("OPERATOR-ROTATED");
    expect(live).toContain("# touched by apply-path test");
  });

  it("(b) a conflicting concurrent edit (same hunk lines) aborts with E_CONFIG_CHANGED", async () => {
    const { gw, finalizeCalls } = driftingGateway(CONFLICTING_HAND_EDIT);
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
    // The hand-edit rewrote `version: 1` → `version: 2`, a line GOOD_DIFF's
    // hunk context depends on. The stored diff no longer applies → ABORT.
    const resp = await send({ unified_diff: GOOD_DIFF, request_id: "drift-b" });
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/^E_CONFIG_CHANGED/);
    expect(resp.error_envelope?.code).toBe("E_CONFIG_CHANGED");
    // Nothing was written → reconcile never ran.
    expect(reconcileInvocations).toBe(0);
    expect(finalizeCalls.length).toBe(1);
    // Nothing was written, so the finalize outcome is the abort outcome —
    // NOT the rollback outcome (#3121 follow-up, review finding 4).
    expect(finalizeCalls[0]!.outcome).toBe("aborted_config_changed");
    expect(finalizeCalls[0]!.detail).toMatch(/config changed since proposal/);
    // The operator's conflicting edit SURVIVES; the proposal's change did NOT
    // land (the diff was never force-written over the drift).
    const live = readFile(configPath, "utf8");
    expect(live).toContain("version: 2");
    expect(live).not.toContain("# touched by apply-path test");
  });

  it("(c) the normal no-drift case still applies the re-validated diff", async () => {
    // Plain approve, no mutation during the window — the diff re-applies
    // cleanly against the unchanged base and the edit lands.
    const { gw, finalizeCalls, requests } = stubGateway("approve");
    let reconcileInvocations = 0;
    server = makeServer({
      configEditEnabled: true,
      configPath,
      approvalGateway: gw,
      runReconcile: async () => {
        reconcileInvocations += 1;
        return { exit_code: 0, stdout: "applied ok", stderr: "" };
      },
    });
    await server.start();
    const resp = await send({ unified_diff: GOOD_DIFF, request_id: "drift-c" });
    expect(resp.result).toBe("completed");
    expect(requests.length).toBe(1);
    expect(finalizeCalls[0]!.outcome).toBe("applied");
    expect(reconcileInvocations).toBe(1);
    const live = readFile(configPath, "utf8");
    expect(live).toContain("# touched by apply-path test");
  });
});

/**
 * #3121 follow-up security review — hunk-relocation guards.
 *
 * The merged #3084 fix re-applied the stored diff at apply time, but two
 * relocation vectors remained:
 *   1. `--unidiff-zero` let a zero-context hunk land purely by line number —
 *      after benign drift it could relocate into ANOTHER agent's block while
 *      still passing schema validation (non-admin privilege escalation: the
 *      self-scope gate only ran at PROPOSE time).
 *   2. Even WITH context lines, structurally identical agent blocks mean the
 *      re-applied hunk can anchor in a different agent's block after drift.
 *
 * Fixes under test: stage-1 rejection of zero-context hunks (no more
 * `--unidiff-zero`), the apply-time semantic change-set pin, and the
 * apply-time re-run of the non-admin self-scope gate. These tests FAIL on the
 * pre-fix code (the edits landed in the other agent's block / the wrong
 * outcome was finalized).
 */
// ─────────────────────────────────────────────────────────────────────
// #4661 — post-write verification. A write that neither throws nor
// lands used to flow straight into reconcile: `switchroom apply`
// re-read the UNCHANGED file, passed, and the response came back
// `result: completed, exit_code: 0` for an edit that was never applied.
// Pre-fix, case 1 below returns completed/0 — the assertions here are on
// the RESPONSE and on the file's mtime, never on "a code path ran".
// ─────────────────────────────────────────────────────────────────────
describe("hostd config_propose_edit — post-write verification (#4661)", () => {
  // A base with one real (non-comment) key we can point a semantic diff at.
  const VERIFY_BASE_YAML =
    "switchroom:\n" +
    "  version: 1\n" +
    "telegram:\n" +
    '  bot_token: "x"\n' +
    '  forum_chat_id: "1"\n' +
    "agents:\n" +
    "  bob:\n" +
    '    topic_name: "Twin"\n';

  // Approved change set: exactly ["telegram.forum_chat_id"].
  const FORUM_ID_DIFF =
    "--- a/switchroom.yaml\n" +
    "+++ b/switchroom.yaml\n" +
    "@@ -3,4 +3,4 @@\n" +
    " telegram:\n" +
    '   bot_token: "x"\n' +
    '-  forum_chat_id: "1"\n' +
    '+  forum_chat_id: "2"\n' +
    " agents:\n";

  // What a mis-targeted write lands instead: a DIFFERENT yaml path changes.
  const WRONG_PATHS_YAML =
    "switchroom:\n" +
    "  version: 1\n" +
    "telegram:\n" +
    '  bot_token: "x"\n' +
    '  forum_chat_id: "1"\n' +
    "agents:\n" +
    "  bob:\n" +
    '    topic_name: "Hijacked"\n';

  it("a write that silently does not land returns E_WRITE_NOT_OBSERVED, never 'completed'", async () => {
    // GOOD_DIFF is comment-only, so the APPROVED change set is empty and the
    // change-set pin passes trivially (both sides []). The byte compare is
    // the only thing standing between this and a false `completed` — which
    // is exactly why it exists.
    const { gw, finalizeCalls } = stubGateway("approve");
    let reconcileInvocations = 0;
    const writes: string[] = [];
    server = makeServer({
      configEditEnabled: true,
      configPath,
      approvalGateway: gw,
      // The production failure, reproduced honestly: the write returns
      // normally and throws nothing, but no bytes reach the target.
      writeConfigFile: (_p, content) => {
        writes.push(content);
      },
      runReconcile: async () => {
        reconcileInvocations += 1;
        return { exit_code: 0, stdout: "applied ok", stderr: "" };
      },
    });
    await server.start();
    const before = readFile(configPath, "utf8");
    const mtimeBefore = statSync(configPath).mtimeMs;
    const resp = await send({ unified_diff: GOOD_DIFF, request_id: "wno-1" });

    // The response is the observable: pre-fix this was completed / exit 0.
    expect(resp.result).not.toBe("completed");
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/E_WRITE_NOT_OBSERVED/);
    expect(resp.error_envelope?.code).toBe("E_WRITE_NOT_OBSERVED");
    expect(resp.error_envelope?.fix?.kind).toBe("operator_action");
    // Byte compare is the check that caught it; the (empty) change-set pin
    // could not have.
    expect(resp.error).toMatch(/not observable at/);
    expect(resp.error).not.toMatch(/change set diverged/);
    // The reconcile must NOT have run — a clean apply over an unchanged file
    // is precisely how the false success used to launder itself.
    expect(reconcileInvocations).toBe(0);
    // The target file was never touched: same bytes, same mtime.
    expect(readFile(configPath, "utf8")).toBe(before);
    expect(statSync(configPath).mtimeMs).toBe(mtimeBefore);
    // Forward write attempted once; no pointless snapshot re-write, because
    // what we read back already WAS the snapshot.
    expect(writes.length).toBe(1);
    expect(finalizeCalls.length).toBe(1);
    expect(finalizeCalls[0]!.outcome).toBe("reconcile_failed_rolled_back");
    expect(finalizeCalls[0]!.detail).toMatch(/no restore needed/);
  });

  it("a write that lands at the WRONG yaml paths returns E_WRITE_NOT_OBSERVED naming both change sets", async () => {
    writeFileSync(configPath, VERIFY_BASE_YAML);
    const { gw, finalizeCalls } = stubGateway("approve");
    let reconcileInvocations = 0;
    let writeCalls = 0;
    server = makeServer({
      configEditEnabled: true,
      configPath,
      approvalGateway: gw,
      // First call = the mis-targeted write (lands agents.bob.topic_name,
      // not the approved telegram.forum_chat_id). Later calls = the
      // rollback restore, which writes honestly.
      writeConfigFile: (p, content) => {
        writeCalls += 1;
        writeFileSync(p, writeCalls === 1 ? WRONG_PATHS_YAML : content);
      },
      runReconcile: async () => {
        reconcileInvocations += 1;
        return { exit_code: 0, stdout: "applied ok", stderr: "" };
      },
    });
    await server.start();
    const resp = await send({
      unified_diff: FORUM_ID_DIFF,
      request_id: "wno-2",
    });

    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/E_WRITE_NOT_OBSERVED/);
    // The change-set pin fired and reported the ACTUAL on-disk set — proof
    // it re-classified the file rather than trusting the intent.
    expect(resp.error).toMatch(/on-disk change set diverged/);
    expect(resp.error).toMatch(/telegram\.forum_chat_id/);
    expect(resp.error).toMatch(/agents\.bob\.topic_name/);
    expect(reconcileInvocations).toBe(0);
    // Rolled back: the hijacked value is gone and the snapshot is restored.
    const live = readFile(configPath, "utf8");
    expect(live).toBe(VERIFY_BASE_YAML);
    expect(live).not.toContain("Hijacked");
    expect(writeCalls).toBe(2); // forward write + snapshot restore
    expect(finalizeCalls[0]!.outcome).toBe("reconcile_failed_rolled_back");
    expect(finalizeCalls[0]!.detail).toMatch(/rolled back to the pre-write snapshot/);
  });

  it("verification failure whose rollback ALSO fails says so instead of implying a clean rollback", async () => {
    const { gw, finalizeCalls } = stubGateway("approve");
    let writeCalls = 0;
    server = makeServer({
      configEditEnabled: true,
      configPath,
      approvalGateway: gw,
      writeConfigFile: (p, content) => {
        writeCalls += 1;
        if (writeCalls === 1) {
          // Lands SOMETHING that is neither the intent nor the snapshot, so
          // the restore branch is genuinely required.
          writeFileSync(p, `${content}# truncated tail lost\n`);
          return;
        }
        throw new Error("EROFS: read-only file system");
      },
      runReconcile: async () => ({ exit_code: 0, stdout: "", stderr: "" }),
    });
    await server.start();
    const resp = await send({ unified_diff: GOOD_DIFF, request_id: "wno-3" });

    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/E_WRITE_NOT_OBSERVED/);
    expect(resp.error).toMatch(/SNAPSHOT RESTORE ALSO FAILED/);
    expect(resp.error).toMatch(/EROFS/);
    expect(resp.error).toMatch(/UNKNOWN state/);
    expect(writeCalls).toBe(2);
    expect(finalizeCalls[0]!.detail).toMatch(/SNAPSHOT RESTORE ALSO FAILED/);
  });

  it("happy path still completes, and echoes the resolved path + size + mtime as evidence", async () => {
    const { gw, finalizeCalls } = stubGateway("approve");
    server = makeServer({
      configEditEnabled: true,
      configPath,
      approvalGateway: gw,
      runReconcile: async () => ({ exit_code: 0, stdout: "applied ok", stderr: "" }),
    });
    await server.start();
    const resp = await send({ unified_diff: GOOD_DIFF, request_id: "wno-4" });

    expect(resp.result).toBe("completed");
    expect(resp.exit_code).toBe(0);
    expect(readFile(configPath, "utf8")).toContain("# touched by apply-path test");
    expect(finalizeCalls[0]!.outcome).toBe("applied");
    // The reconcile's own output is preserved …
    expect(resp.stdout_tail).toContain("applied ok");
    // … and the `completed` claim now names the file it is a claim about.
    const size = statSync(configPath).size;
    expect(resp.stdout_tail).toContain(`config write observed: path=${configPath}`);
    expect(resp.stdout_tail).toContain(`size=${size}`);
    expect(resp.stdout_tail).toMatch(/mtime_ms=\d+/);
  });
});

describe("hostd config_propose_edit — relocation guards (#3121 follow-up)", () => {
  // bob is the only agent at PROPOSE time, so the generic (agent-name-free)
  // hunk context below anchors uniquely in bob's block and the self-scope
  // gate admits the edit.
  const SINGLE_BOB_CONFIG =
    "switchroom:\n" +
    "  version: 1\n" +
    "telegram:\n" +
    '  bot_token: "x"\n' +
    '  forum_chat_id: "1"\n' +
    "agents:\n" +
    "  bob:\n" +
    '    topic_name: "Twin"\n' +
    "    tools:\n" +
    "      allow:\n" +
    "        - mcp__a__one\n";

  // The drift that lands during the approval window: the operator renamed the
  // agent bob → eve (identical body). The hunk's generic context byte-matches
  // the renamed block, so `git apply` re-applies the stored diff CLEANLY —
  // but the edit now lands under agents.eve.*, not the approved agents.bob.*.
  // (Verified against real git: the re-apply succeeds; only the semantic
  // change-set pin / self-scope re-gate stop it.)
  const DRIFTED_BOB_RENAMED_TO_EVE =
    "switchroom:\n" +
    "  version: 1\n" +
    "telegram:\n" +
    '  bot_token: "x"\n' +
    '  forum_chat_id: "1"\n' +
    "agents:\n" +
    "  eve:\n" +
    '    topic_name: "Twin"\n' +
    "    tools:\n" +
    "      allow:\n" +
    "        - mcp__a__one\n";

  // Bob widens his OWN tools.allow (self-scoped at propose time). The context
  // lines carry no agent name, so after the rename drift they anchor in
  // eve's block instead.
  const GENERIC_CONTEXT_SELF_DIFF =
    "--- a/switchroom.yaml\n" +
    "+++ b/switchroom.yaml\n" +
    "@@ -9,3 +9,4 @@\n" +
    "     tools:\n" +
    "       allow:\n" +
    "         - mcp__a__one\n" +
    "+        - mcp__evil__tool\n";

  // The same edit with NO context lines at all — anchored purely by line
  // numbers. Must be rejected at intake now that --unidiff-zero is gone.
  const ZERO_CONTEXT_DIFF =
    "--- a/switchroom.yaml\n" +
    "+++ b/switchroom.yaml\n" +
    "@@ -11,0 +12,1 @@\n" +
    "+        - mcp__evil__tool\n";

  function driftingGatewayTo(landed: string) {
    const finalizeCalls: Array<{
      outcome: "applied" | "aborted_config_changed" | "reconcile_failed_rolled_back";
      detail?: string;
    }> = [];
    const gw: ApprovalGateway = {
      async requestApproval(): Promise<ApprovalResult> {
        writeFileSync(configPath, landed);
        return {
          verdict: "approve",
          finalize: async (out) => {
            finalizeCalls.push(out);
          },
        };
      },
    };
    return { gw, finalizeCalls };
  }

  it("rejects a zero-context hunk at propose time with E_PATCH_INVALID_SHAPE and writes nothing", async () => {
    writeFileSync(configPath, SINGLE_BOB_CONFIG);
    const { gw, requests } = stubGateway("approve");
    server = makeServer({
      configEditEnabled: true,
      configPath,
      approvalGateway: gw,
      runReconcile: async () => ({ exit_code: 0, stdout: "", stderr: "" }),
    });
    await server.start();
    const resp = await send({
      unified_diff: ZERO_CONTEXT_DIFF,
      request_id: "reloc-1",
    });
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^E_PATCH_INVALID_SHAPE/);
    expect(resp.error).toMatch(/zero-context/);
    // No approval card, no write — the line-number-anchored hunk never got a
    // chance to relocate anywhere.
    expect(requests.length).toBe(0);
    expect(readFile(configPath, "utf8")).toBe(SINGLE_BOB_CONFIG);
  });

  it("non-admin edit that would relocate into another agent's block after drift ABORTS (no cross-agent write)", async () => {
    writeFileSync(configPath, SINGLE_BOB_CONFIG);
    const { gw, finalizeCalls } = driftingGatewayTo(DRIFTED_BOB_RENAMED_TO_EVE);
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
    // Propose as NON-ADMIN bob: at propose time the hunk lands in bob's own
    // block, so the self-scope gate admits it and the card goes out. During
    // the window, the operator renamed bob → eve — the re-applied hunk's generic
    // context now anchors in EVE's block. Pre-fix this WROTE the rule into
    // agents.eve.tools.allow (cross-agent escalation). Now it must abort.
    const resp = await send({
      sockOwner: "bob",
      unified_diff: GENERIC_CONTEXT_SELF_DIFF,
      request_id: "reloc-2",
    });
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/^E_CONFIG_CHANGED/);
    expect(resp.error_envelope?.code).toBe("E_CONFIG_CHANGED");
    // Nothing was written: eve's allow-list did NOT grow, the drifted config
    // is byte-identical, and reconcile never ran.
    const live = readFile(configPath, "utf8");
    expect(live).toBe(DRIFTED_BOB_RENAMED_TO_EVE);
    expect(live).not.toContain("mcp__evil__tool");
    expect(reconcileInvocations).toBe(0);
    expect(finalizeCalls.length).toBe(1);
    expect(finalizeCalls[0]!.outcome).toBe("aborted_config_changed");
  });

  it("admin edit whose re-applied hunks land at DIFFERENT yaml paths after drift ABORTS with E_CONFIG_CHANGED", async () => {
    writeFileSync(configPath, SINGLE_BOB_CONFIG);
    const { gw, finalizeCalls } = driftingGatewayTo(DRIFTED_BOB_RENAMED_TO_EVE);
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
    // Same relocation mechanics, but the caller is the ADMIN agent — the
    // self-scope gate never runs, so the semantic change-set pin is the guard:
    // the operator approved a change to agents.bob.*, the re-applied diff
    // would change agents.eve.*. Apply-time effect must match what was
    // approved, for ALL callers.
    const resp = await send({
      unified_diff: GENERIC_CONTEXT_SELF_DIFF,
      request_id: "reloc-3",
    });
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/^E_CONFIG_CHANGED/);
    const live = readFile(configPath, "utf8");
    expect(live).toBe(DRIFTED_BOB_RENAMED_TO_EVE);
    expect(live).not.toContain("mcp__evil__tool");
    expect(reconcileInvocations).toBe(0);
    expect(finalizeCalls[0]!.outcome).toBe("aborted_config_changed");
  });
});

// ─────────────────────────────────────────────────────────────────────
// #4661 follow-up — CONFIG PATH PROVENANCE. hostd wrote one file and
// reconciled a potentially different one: the write target came from the wire
// literal (`opts.configPath` is unset in production — `main.ts` never passes
// it), while the `switchroom apply` child resolved its own config through
// `findConfigFile()` (`$SWITCHROOM_CONFIG` → cwd → `~/.switchroom`). They
// agreed only because `hostd install` happens to export SWITCHROOM_CONFIG.
// On divergence: write X, reconcile Y cleanly, `completed / exit 0`, and the
// approved change is absent from the file everything else reads.
// Assertions here are on the child's ENV, on a distinct error code, and on the
// target file's bytes + mtime — never on "a code path ran".
// ─────────────────────────────────────────────────────────────────────
describe("hostd config_propose_edit — config path provenance (#4661 follow-up)", () => {
  it("pins the reconcile child's SWITCHROOM_CONFIG to the file that was just written", async () => {
    const { gw } = stubGateway("approve");
    const envs: Array<Record<string, string> | undefined> = [];
    server = makeServer({
      configEditEnabled: true,
      configPath,
      approvalGateway: gw,
      runReconcile: async ({ env }) => {
        envs.push(env);
        return { exit_code: 0, stdout: "applied ok", stderr: "" };
      },
    });
    await server.start();
    const resp = await send({ unified_diff: GOOD_DIFF, request_id: "prov-1" });

    // Happy-path regression: the pin does not change the outcome.
    expect(resp.result).toBe("completed");
    expect(resp.exit_code).toBe(0);
    // The observable: the child's environment. Pre-fix this was `undefined` —
    // the child re-derived its own config path and could name another file.
    expect(envs.length).toBe(1);
    expect(envs[0]).toBeDefined();
    expect(envs[0]!.SWITCHROOM_CONFIG).toBe(configPath);
  });

  it("pins the same SWITCHROOM_CONFIG on the ROLLBACK reconcile, not just the forward one", async () => {
    const { gw } = stubGateway("approve");
    const envs: Array<Record<string, string> | undefined> = [];
    server = makeServer({
      configEditEnabled: true,
      configPath,
      approvalGateway: gw,
      // Forward reconcile fails → rollback restore → recovery reconcile. A
      // rollback reconciled against a DIFFERENT file is the same bug wearing a
      // different hat, so the recovery spawn must carry the pin too.
      runReconcile: async ({ env }) => {
        envs.push(env);
        return { exit_code: envs.length === 1 ? 1 : 0, stdout: "", stderr: "boom" };
      },
    });
    await server.start();
    await send({ unified_diff: GOOD_DIFF, request_id: "prov-2" });

    expect(envs.length).toBe(2);
    for (const env of envs) {
      expect(env?.SWITCHROOM_CONFIG).toBe(configPath);
    }
  });

  it("returns E_CONFIG_PATH_MISMATCH — no card, no write, no reconcile — when the fleet reads a different file", async () => {
    const { gw, requests, finalizeCalls } = stubGateway("approve");
    let reconcileInvocations = 0;
    const writes: string[] = [];
    server = makeServer({
      configEditEnabled: true,
      // configPath deliberately UNSET: reproduce production, where the write
      // target is the wire literal /state/config/switchroom.yaml.
      approvalGateway: gw,
      // …while the fleet's own resolver names an entirely different file.
      resolveFleetConfigPath: () => configPath,
      writeConfigFile: (_p, content) => {
        writes.push(content);
      },
      runReconcile: async () => {
        reconcileInvocations += 1;
        return { exit_code: 0, stdout: "applied ok", stderr: "" };
      },
    });
    await server.start();
    const before = readFile(configPath, "utf8");
    const mtimeBefore = statSync(configPath).mtimeMs;
    const resp = await send({ unified_diff: GOOD_DIFF, request_id: "prov-3" });

    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^E_CONFIG_PATH_MISMATCH/);
    expect(resp.error_envelope?.code).toBe("E_CONFIG_PATH_MISMATCH");
    expect(resp.error_envelope?.fix?.kind).toBe("operator_action");
    // Both paths are named, so the operator can see WHICH two disagree.
    expect(resp.error).toContain("/state/config/switchroom.yaml");
    expect(resp.error).toContain(configPath);
    // Refused BEFORE the operator was ever asked, and before any write.
    expect(requests.length).toBe(0);
    expect(finalizeCalls.length).toBe(0);
    expect(writes.length).toBe(0);
    expect(reconcileInvocations).toBe(0);
    // The file the fleet reads is untouched: same bytes, same mtime.
    expect(readFile(configPath, "utf8")).toBe(before);
    expect(statSync(configPath).mtimeMs).toBe(mtimeBefore);
  });

  it("does NOT fire when the fleet path is an ALIAS of the write target", async () => {
    const { gw } = stubGateway("approve");
    server = makeServer({
      configEditEnabled: true,
      approvalGateway: gw,
      resolveFleetConfigPath: () => configPath,
      // Both names carry the same dev+inode — exactly the shipped install,
      // where /state/config/switchroom.yaml is a bind mount of
      // ~/.switchroom/switchroom.yaml. A string-only check would reject it,
      // and so would a realpath compare (a bind mount does not collapse).
      identifyForProvenance: () => ({ dev: 42, ino: 99 }),
      runReconcile: async () => ({ exit_code: 0, stdout: "", stderr: "" }),
    });
    await server.start();
    const resp = await send({ unified_diff: GOOD_DIFF, request_id: "prov-4" });

    // The gate passed; this request then fails further down the pipeline
    // (the wire literal does not exist in the test sandbox). What matters is
    // that the provenance gate did not claim a mismatch.
    expect(resp.error ?? "").not.toMatch(/E_CONFIG_PATH_MISMATCH/);
  });

  it("skips the gate when an embedder pins configPath explicitly", async () => {
    const { gw } = stubGateway("approve");
    server = makeServer({
      configEditEnabled: true,
      configPath,
      approvalGateway: gw,
      // A scratch config legitimately differs from whatever findConfigFile
      // finds — an explicit configPath is the documented override, so this
      // divergence must not be treated as the production bug.
      resolveFleetConfigPath: () => "/somewhere/else/switchroom.yaml",
      runReconcile: async () => ({ exit_code: 0, stdout: "applied ok", stderr: "" }),
    });
    await server.start();
    const resp = await send({ unified_diff: GOOD_DIFF, request_id: "prov-5" });
    expect(resp.result).toBe("completed");
  });
});

describe("checkConfigPathProvenance (unit)", () => {
  it("passes on an identical path string without touching the filesystem", () => {
    let statCalls = 0;
    const prov = checkConfigPathProvenance(
      "/state/config/switchroom.yaml",
      () => "/state/config/switchroom.yaml",
      (_p) => {
        statCalls += 1;
        return { dev: 1, ino: 1 };
      },
    );
    expect(prov.ok).toBe(true);
    expect(statCalls).toBe(0);
  });

  it("passes on a REAL symlink to the config (same inode, different string)", () => {
    const link = join(tmp, "aliased.yaml");
    symlinkSync(configPath, link);
    const prov = checkConfigPathProvenance(link, () => configPath);
    expect(prov.ok).toBe(true);
    expect(prov.identityChecked).toBe(true);
    expect(prov.detail).toMatch(/two names for the SAME file/);
  });

  it("passes on a REAL hard link — which a realpath compare would have rejected", () => {
    const hard = join(tmp, "hardlinked.yaml");
    linkSync(configPath, hard);
    // realpathSync(hard) === hard !== realpathSync(configPath), so a realpath
    // compare calls these different files. They are the same inode: a write
    // through either name is visible through the other, so refusing the apply
    // here would be a pure false alarm.
    expect(realpathSync(hard)).not.toBe(realpathSync(configPath));
    const prov = checkConfigPathProvenance(hard, () => configPath);
    expect(prov.ok).toBe(true);
    expect(prov.identityChecked).toBe(true);
  });

  it("fails on two genuinely different real files and names both", () => {
    const other = join(tmp, "other.yaml");
    writeFileSync(other, VALID_BASE_YAML);
    const prov = checkConfigPathProvenance(configPath, () => other);
    expect(prov.ok).toBe(false);
    expect(prov.identityChecked).toBe(true);
    expect(prov.detail).toContain(configPath);
    expect(prov.detail).toContain(other);
    expect(prov.detail).toMatch(/DIFFERENT file/);
  });

  it("passes (and says why) when the fleet resolver cannot name a config at all", () => {
    const prov = checkConfigPathProvenance(configPath, () => {
      throw new Error("No switchroom.yaml found");
    });
    // Nothing to compare against is NOT evidence of divergence, and the child
    // would fail loudly on its own — so this must not block an apply.
    expect(prov.ok).toBe(true);
    expect(prov.resolvedPath).toBeNull();
    expect(prov.detail).toMatch(/could not name a config file/);
  });

  it("falls back to the string compare — and admits it — when stat throws", () => {
    const prov = checkConfigPathProvenance(
      "/state/config/switchroom.yaml",
      () => configPath,
      () => {
        throw new Error("ENOENT: no such file or directory");
      },
    );
    expect(prov.ok).toBe(false);
    expect(prov.identityChecked).toBe(false);
    expect(prov.detail).toMatch(/compared as strings, not inodes/);
    expect(prov.detail).toMatch(/ENOENT/);
  });
});

describe("configPathProvenanceWarning (boot assertion, #4661 follow-up)", () => {
  it("is silent when the fleet resolver names the canonical wire path", () => {
    expect(configPathProvenanceWarning(() => CANONICAL_CONFIG_PATH)).toBeNull();
  });

  it("is silent when the canonical path is another name for the fleet path", () => {
    expect(
      configPathProvenanceWarning(
        () => configPath,
        () => ({ dev: 7, ino: 7 }),
      ),
    ).toBeNull();
  });

  it("emits one greppable, actionable line on a genuine mismatch", () => {
    const other = join(tmp, "elsewhere.yaml");
    writeFileSync(other, VALID_BASE_YAML);
    let ino = 0;
    const line = configPathProvenanceWarning(
      () => other,
      () => ({ dev: 1, ino: (ino += 1) }),
    );
    expect(line).not.toBeNull();
    expect(line!).toContain(CONFIG_PATH_PROVENANCE_TAG);
    expect(line!).toContain(CANONICAL_CONFIG_PATH);
    expect(line!).toContain(other);
    // Names the consequence and the fix, not just the fact.
    expect(line!).toMatch(/E_CONFIG_PATH_MISMATCH/);
    expect(line!).toMatch(/SWITCHROOM_CONFIG/);
    // One line — a multi-line warning gets truncated by log collectors.
    expect(line!.includes("\n")).toBe(false);
  });

  it("does not refuse: the boot check only ever returns a string or null", () => {
    // The deliberate design choice — a config-layout change must not take the
    // whole daemon down (rollouts included) to protect one verb that refuses
    // on its own at apply time. Assert the shape that makes that true.
    let ino = 0;
    const line = configPathProvenanceWarning(
      () => "/nope/switchroom.yaml",
      () => ({ dev: 1, ino: (ino += 1) }),
    );
    expect(typeof line).toBe("string");
  });
});
