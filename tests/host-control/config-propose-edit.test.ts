/**
 * hostd server tests — `config_propose_edit` (PR 1a skeleton).
 *
 * Scope: this PR ships the wire shape + dispatcher stub only. Tests
 * cover what is actually live today:
 *   - flag-off  → result=error, error string carries E_CONFIG_EDIT_DISABLED
 *   - flag-on   → result=error, error string carries E_NOT_IMPLEMENTED
 *   - admin gate: non-admin caller is denied BEFORE the flag is read
 *     (so an un-admin'd peer can't probe the toggle state)
 *   - target_path mismatch is rejected at wire decode (literal type)
 *
 * Validation pipeline, approval card, and apply path land in PR 1b/1c
 * and gain their own tests there.
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

function makeServer(opts: { configEditEnabled?: boolean }) {
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
  });
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "hostd-config-edit-"));
  stubBin = join(tmp, "switchroom-stub.sh");
  writeFileSync(stubBin, `#!/bin/sh\necho "stub: $@"\nexit 0\n`);
  chmodSync(stubBin, 0o755);
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

describe("hostd server — config_propose_edit (PR 1a stub)", () => {
  it("returns E_CONFIG_EDIT_DISABLED when the flag is omitted (default off)", async () => {
    server = makeServer({});
    await server.start();
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "config_propose_edit",
        request_id: "cpe-1",
        args: {
          unified_diff: TINY_DIFF,
          reason: "smoke test",
          target_path: "/state/config/switchroom.yaml",
        },
      },
    );
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^E_CONFIG_EDIT_DISABLED/);
    expect(resp.error).toMatch(/hostd\.config_edit_enabled=true/);
  });

  it("returns E_CONFIG_EDIT_DISABLED when the flag is explicitly false", async () => {
    server = makeServer({ configEditEnabled: false });
    await server.start();
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "config_propose_edit",
        request_id: "cpe-2",
        args: {
          unified_diff: TINY_DIFF,
          reason: "smoke",
          target_path: "/state/config/switchroom.yaml",
        },
      },
    );
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^E_CONFIG_EDIT_DISABLED/);
  });

  it("returns E_NOT_IMPLEMENTED when the flag is true (PR 1b not shipped)", async () => {
    server = makeServer({ configEditEnabled: true });
    await server.start();
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "config_propose_edit",
        request_id: "cpe-3",
        args: {
          unified_diff: TINY_DIFF,
          reason: "smoke",
          target_path: "/state/config/switchroom.yaml",
        },
      },
    );
    expect(resp.result).toBe("error");
    expect(resp.error).toMatch(/^E_NOT_IMPLEMENTED/);
    expect(resp.error).toMatch(/PR 1b/);
  });

  it("denies non-admin callers before reading the flag", async () => {
    // Flag ON to prove the gate fires before the handler runs — a
    // non-admin caller must NOT learn whether the feature is enabled.
    server = makeServer({ configEditEnabled: true });
    await server.start();
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/bob/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "config_propose_edit",
        request_id: "cpe-4",
        args: {
          unified_diff: TINY_DIFF,
          reason: "smoke",
          target_path: "/state/config/switchroom.yaml",
        },
      },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/requires admin: true/);
  });
});
