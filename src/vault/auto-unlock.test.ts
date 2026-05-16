/**
 * Tests for the machine-bound auto-unlock crypto.
 *
 * These tests pass `machineId` explicitly to encrypt/decrypt so we don't
 * have to mock /etc/machine-id. They cover:
 *   - Roundtrip: encrypt + decrypt yields the original passphrase
 *   - Tag mismatch: decrypting with a different machine-id fails cleanly
 *   - Format check: malformed blob rejected with a recognizable error class
 *   - File helpers: write + read on disk, mode 0600 enforced
 */

import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Ensure the file-helper test path has a deterministic machine-id even
// on hosts without /etc/machine-id (rootless containers, fresh images).
// Production readMachineId() ignores this env var when it's unset.
const _origMachineId = process.env.SWITCHROOM_VAULT_MACHINE_ID_OVERRIDE;
beforeAll(() => {
  process.env.SWITCHROOM_VAULT_MACHINE_ID_OVERRIDE =
    "test0000000000000000000000000000";
});
afterAll(() => {
  if (_origMachineId === undefined)
    delete process.env.SWITCHROOM_VAULT_MACHINE_ID_OVERRIDE;
  else process.env.SWITCHROOM_VAULT_MACHINE_ID_OVERRIDE = _origMachineId;
});

import {
  AutoUnlockDecryptError,
  MachineIdUnavailableError,
  decryptAutoUnlock,
  encryptAutoUnlock,
  readAutoUnlockFile,
  readMachineId,
  writeAutoUnlockFile,
} from "./auto-unlock.js";

const FIXED_MACHINE_ID = "abcdef0123456789abcdef0123456789";
const OTHER_MACHINE_ID = "fedcba9876543210fedcba9876543210";

describe("encrypt/decrypt roundtrip", () => {
  it("decrypts to the original passphrase on the same machine-id", () => {
    const blob = encryptAutoUnlock("super-secret-vault-passphrase", FIXED_MACHINE_ID);
    expect(decryptAutoUnlock(blob, FIXED_MACHINE_ID)).toBe("super-secret-vault-passphrase");
  });

  it("produces fresh ciphertext on every encrypt (random nonce + salt)", () => {
    const a = encryptAutoUnlock("p", FIXED_MACHINE_ID);
    const b = encryptAutoUnlock("p", FIXED_MACHINE_ID);
    expect(a.equals(b)).toBe(false);
    // But both decrypt to the same plaintext
    expect(decryptAutoUnlock(a, FIXED_MACHINE_ID)).toBe("p");
    expect(decryptAutoUnlock(b, FIXED_MACHINE_ID)).toBe("p");
  });

  it("handles passphrases with unicode + special characters", () => {
    const passphrase = "пароль🔐 with newlines\nand\ttabs";
    const blob = encryptAutoUnlock(passphrase, FIXED_MACHINE_ID);
    expect(decryptAutoUnlock(blob, FIXED_MACHINE_ID)).toBe(passphrase);
  });
});

describe("machine-id binding", () => {
  it("fails with tag-mismatch when decrypting on a different machine-id", () => {
    const blob = encryptAutoUnlock("p", FIXED_MACHINE_ID);
    try {
      decryptAutoUnlock(blob, OTHER_MACHINE_ID);
      expect.fail("expected decrypt to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AutoUnlockDecryptError);
      expect((err as AutoUnlockDecryptError).reason).toBe("tag-mismatch");
    }
  });

  it("fails when the blob has been tampered with", () => {
    const blob = encryptAutoUnlock("p", FIXED_MACHINE_ID);
    // Flip a byte in the ciphertext region (skip past version + salt + nonce).
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 5] ^= 0xff;
    expect(() => decryptAutoUnlock(tampered, FIXED_MACHINE_ID)).toThrow(AutoUnlockDecryptError);
  });
});

describe("format errors", () => {
  it("rejects truncated blobs", () => {
    try {
      decryptAutoUnlock(Buffer.from([0x01, 0x02]), FIXED_MACHINE_ID);
      expect.fail("expected throw");
    } catch (err) {
      expect((err as AutoUnlockDecryptError).reason).toBe("format");
    }
  });

  it("rejects unknown version byte", () => {
    const blob = encryptAutoUnlock("p", FIXED_MACHINE_ID);
    const wrongVersion = Buffer.from(blob);
    wrongVersion[0] = 0x99;
    try {
      decryptAutoUnlock(wrongVersion, FIXED_MACHINE_ID);
      expect.fail("expected throw");
    } catch (err) {
      expect((err as AutoUnlockDecryptError).reason).toBe("format");
    }
  });
});

describe("file helpers", () => {
  it("writes the blob with mode 0600 and reads it back", () => {
    // Note: writeAutoUnlockFile uses readMachineId internally — we can't
    // override here without mocking /etc, so we only test the disk path
    // when the host has a real machine-id (every Linux/macOS test runner).
    const tmp = mkdtempSync(join(tmpdir(), "switchroom-auto-unlock-"));
    const filePath = join(tmp, "auto-unlock.bin");

    writeAutoUnlockFile("p4ssphrase", filePath);
    const stat = statSync(filePath);
    // file mode bits — strip directory + special bits
    expect(stat.mode & 0o777).toBe(0o600);

    const decrypted = readAutoUnlockFile(filePath);
    expect(decrypted).toBe("p4ssphrase");
  });

  it("readAutoUnlockFile throws AutoUnlockDecryptError(io) for missing files", () => {
    try {
      readAutoUnlockFile("/nonexistent/path/auto-unlock.bin");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AutoUnlockDecryptError);
      expect((err as AutoUnlockDecryptError).reason).toBe("io");
    }
  });
});

describe("readMachineId — override is test-env-gated", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("ignores SWITCHROOM_VAULT_MACHINE_ID_OVERRIDE when NODE_ENV != 'test' AND VITEST is unset", () => {
    // Prod-env injection threat model: an attacker who can set
    // SWITCHROOM_VAULT_MACHINE_ID_OVERRIDE in the broker's environment
    // must NOT be able to downgrade the machine-binding to a value of
    // their choosing. Outside vitest / NODE_ENV=test the override is
    // dead env, and readMachineId falls through to the real
    // /etc/machine-id resolution. Two legitimate outcomes prove the
    // override was ignored: (a) the host has no /etc/machine-id and
    // readMachineId throws MachineIdUnavailableError, or (b) the host
    // has one and readMachineId returns the REAL id (not the override).
    // The only failure mode this test catches is the override leaking
    // into a prod-env read.
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    const override = "attacker-controlled-id-0000000000";
    vi.stubEnv("SWITCHROOM_VAULT_MACHINE_ID_OVERRIDE", override);
    let result: string | undefined;
    try {
      result = readMachineId();
    } catch (e) {
      expect(e).toBeInstanceOf(MachineIdUnavailableError);
      return;
    }
    expect(result).not.toBe(override);
  });

  it("honours SWITCHROOM_VAULT_MACHINE_ID_OVERRIDE when VITEST is set (the existing test-helper path)", () => {
    // VITEST is set by vitest itself for every test run; we re-state
    // it explicitly here to make the intent obvious (and so this test
    // doesn't accidentally pass purely because the top-level beforeAll
    // already set the override env var).
    vi.stubEnv("VITEST", "true");
    vi.stubEnv("NODE_ENV", "production"); // proves VITEST alone is enough
    vi.stubEnv("SWITCHROOM_VAULT_MACHINE_ID_OVERRIDE", "test-only-value-000000000000000000");
    expect(readMachineId()).toBe("test-only-value-000000000000000000");
  });

  it("honours SWITCHROOM_VAULT_MACHINE_ID_OVERRIDE when NODE_ENV=test (the legacy gate)", () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SWITCHROOM_VAULT_MACHINE_ID_OVERRIDE", "node-env-test-id-00000000000000");
    expect(readMachineId()).toBe("node-env-test-id-00000000000000");
  });
});

