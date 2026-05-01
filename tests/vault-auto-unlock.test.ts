/**
 * Tests for the vault auto-unlock encryption cascade and YAML mutation.
 *
 * The cascade is intentionally minimal: host-scope encrypt with `--with-key=host`
 * (no TPM dependency, decryptable in user units), tried as user first and
 * escalated to sudo when the host secret is root-only-readable.
 *
 *   1. host secret readable to user (rare on default Ubuntu) → host-as-user wins
 *   2. host secret root-only (default Ubuntu 24.04+) → polkit-denies-as-user → sudo
 *   3. polkit denies + non-TTY → cannot auto-escalate; EncryptFailedError
 *   4. user declines sudo → EncryptCancelledError
 *   5. host secret missing → straight to sudo (root creates it on first encrypt)
 *
 * We exercise each by mocking `spawnSync` and existsSync.
 */

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted spawnSync mock — both `tryEncrypt` and `runSudoEncrypt` call into
// node:child_process.spawnSync, so we drive the whole cascade from one queue.
const spawnQueue: Array<{ status: number; stderr?: string }> = [];

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: vi.fn((_cmd: string, _args: string[]) => {
      const next = spawnQueue.shift();
      if (!next) {
        throw new Error("spawnSync called more times than the test queued responses");
      }
      return {
        status: next.status,
        stderr: next.stderr ?? "",
        stdout: "",
        signal: null,
        output: [null, "", next.stderr ?? ""],
        pid: 0,
      };
    }),
  };
});

// existsSync is hit for the host keystore probe; mock it per-test.
const existsMock = vi.fn<(p: string) => boolean>();
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn((p: string) => existsMock(p)),
  };
});

// askYesNo is awaited inside encryptCredential when sudo escalation is
// considered. We swap the implementation per-test.
const askYesNoMock = vi.fn<() => Promise<boolean>>();
vi.mock("../src/setup/prompt.js", () => ({
  askYesNo: vi.fn(() => askYesNoMock()),
  isInteractive: vi.fn(() => true),
}));

import {
  classifyEncryptStderr,
  encryptCredential,
  EncryptCancelledError,
  EncryptFailedError,
  HOST_SECRET,
  setVaultBrokerAutoUnlock,
} from "../src/cli/vault-auto-unlock.js";

describe("classifyEncryptStderr", () => {
  it("recognizes polkit interactive-auth errors", () => {
    expect(classifyEncryptStderr("Failed to encrypt: io.systemd.InteractiveAuthenticationRequired"))
      .toBe("polkit-required");
  });

  it("recognizes io.systemd.System (varlink unreachable)", () => {
    expect(classifyEncryptStderr("Failed to encrypt: io.systemd.System")).toBe("varlink-unreachable");
  });

  it("does not match io.systemd.SystemdSomething (avoid false positive)", () => {
    expect(classifyEncryptStderr("Failed to encrypt: io.systemd.Systemctl")).not.toBe("varlink-unreachable");
  });

  it("recognizes missing host keystore", () => {
    expect(classifyEncryptStderr("/var/lib/systemd/credential.secret: No such file or directory"))
      .toBe("no-host-keystore");
  });

  it("falls back to other for unknown classes", () => {
    expect(classifyEncryptStderr("some unrelated error")).toBe("other");
  });
});

describe("encryptCredential cascade", () => {
  const credPath = join(tmpdir(), "vault-auto-unlock-test.cred");

  beforeEach(() => {
    spawnQueue.length = 0;
    existsMock.mockReset();
    askYesNoMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("host-as-user succeeds when host secret is readable", async () => {
    existsMock.mockImplementation((p: string) => p === HOST_SECRET);
    spawnQueue.push({ status: 0 }); // host-scope encrypt as user succeeds

    const scope = await encryptCredential("p4ss", credPath, {
      isTTY: true,
      log: () => {},
      err: () => {},
    });
    expect(scope).toBe("host");
  });

  it("escalates to sudo when polkit denies and user confirms (the Ubuntu 24.04+ path)", async () => {
    existsMock.mockImplementation((p: string) => p === HOST_SECRET);
    askYesNoMock.mockResolvedValue(true);

    spawnQueue.push({ status: 1, stderr: "Failed to encrypt: io.systemd.InteractiveAuthenticationRequired" }); // polkit denies
    spawnQueue.push({ status: 0 }); // sudo systemd-creds encrypt
    spawnQueue.push({ status: 0 }); // sudo -n chown

    const scope = await encryptCredential("p4ss", credPath, {
      isTTY: true,
      log: () => {},
      err: () => {},
    });
    expect(scope).toBe("host-sudo");
    expect(askYesNoMock).toHaveBeenCalledOnce();
  });

  it("refuses to auto-escalate when stdin is not a TTY", async () => {
    existsMock.mockImplementation((p: string) => p === HOST_SECRET);
    spawnQueue.push({ status: 1, stderr: "InteractiveAuthenticationRequired" });

    await expect(
      encryptCredential("p4ss", credPath, {
        isTTY: false,
        log: () => {},
        err: () => {},
      }),
    ).rejects.toBeInstanceOf(EncryptFailedError);
    expect(askYesNoMock).not.toHaveBeenCalled();
  });

  it("aborts with EncryptCancelledError when user declines sudo", async () => {
    existsMock.mockImplementation((p: string) => p === HOST_SECRET);
    askYesNoMock.mockResolvedValue(false);

    spawnQueue.push({ status: 1, stderr: "InteractiveAuthenticationRequired" });

    await expect(
      encryptCredential("p4ss", credPath, {
        isTTY: true,
        log: () => {},
        err: () => {},
      }),
    ).rejects.toBeInstanceOf(EncryptCancelledError);
  });

  it("escalates straight to sudo when host keystore is absent (no host-as-user attempt)", async () => {
    existsMock.mockReturnValue(false); // no HOST_SECRET
    askYesNoMock.mockResolvedValue(true);

    spawnQueue.push({ status: 0 }); // sudo encrypt
    spawnQueue.push({ status: 0 }); // sudo -n chown

    const scope = await encryptCredential("p4ss", credPath, {
      isTTY: true,
      log: () => {},
      err: () => {},
    });
    expect(scope).toBe("host-sudo");
    // exactly 2 spawnSync calls (no host-as-user attempt): sudo-encrypt + sudo-chown
    expect(spawnQueue.length).toBe(0);
  });

  it("always passes --with-key=host to systemd-creds (regression: TPM auto-default broke decrypt at unit start)", async () => {
    // Capture argv from spawnSync so we can assert.
    const seenArgs: string[][] = [];
    spawnQueue.push({ status: 0 });
    existsMock.mockImplementation((p: string) => p === HOST_SECRET);

    const cp = await import("node:child_process");
    const original = vi.mocked(cp.spawnSync);
    original.mockImplementationOnce((_cmd: string, args: string[]) => {
      seenArgs.push(args);
      const next = spawnQueue.shift()!;
      return {
        status: next.status,
        stderr: next.stderr ?? "",
        stdout: "",
        signal: null,
        output: [null, "", next.stderr ?? ""],
        pid: 0,
      } as ReturnType<typeof cp.spawnSync>;
    });

    await encryptCredential("p4ss", credPath, {
      isTTY: true,
      log: () => {},
      err: () => {},
    });

    expect(seenArgs[0]).toContain("--with-key=host");
  });
});

describe("setVaultBrokerAutoUnlock", () => {
  let tmp: string;
  let configPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "switchroom-yaml-"));
    configPath = join(tmp, "switchroom.yaml");
  });

  it("creates vault.broker.autoUnlock when config has none of those keys", () => {
    writeFileSync(
      configPath,
      "# header comment\nagents:\n  alice:\n    extends: default\n",
      "utf-8",
    );
    setVaultBrokerAutoUnlock(configPath, true);
    const after = readFileSync(configPath, "utf-8");
    expect(after).toContain("autoUnlock: true");
    expect(after).toContain("# header comment"); // comment preserved
    expect(after).toContain("alice:"); // existing keys preserved
  });

  it("flips an existing false value to true without disturbing siblings", () => {
    writeFileSync(
      configPath,
      [
        "vault:",
        "  path: ~/.switchroom/vault.enc",
        "  broker:",
        "    autoUnlock: false  # toggled by enable-auto-unlock",
        "    socket: ~/.switchroom/vault-broker.sock",
        "agents: {}",
        "",
      ].join("\n"),
      "utf-8",
    );
    setVaultBrokerAutoUnlock(configPath, true);
    const after = readFileSync(configPath, "utf-8");
    expect(after).toMatch(/autoUnlock: true/);
    expect(after).toContain("path: ~/.switchroom/vault.enc"); // sibling preserved
    expect(after).toContain("socket: ~/.switchroom/vault-broker.sock"); // sibling preserved
    // Inline comment near autoUnlock survives YAML round-trip
    expect(after).toContain("# toggled by enable-auto-unlock");
  });
});
