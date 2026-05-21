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
  });
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

describe("hostd config_propose_edit — PR 1b happy path", () => {
  it("returns E_NOT_IMPLEMENTED_APPLY_PATH on a valid diff (apply still pending PR 1c)", async () => {
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
    expect(resp.error).toMatch(/^E_NOT_IMPLEMENTED_APPLY_PATH/);
    expect(resp.error).toMatch(/PR 1c/);
  });
});
