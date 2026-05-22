/**
 * Unit tests for the vault/broker test-isolation guard.
 *
 * These run under vitest, so `isTestRuntime()` is true throughout — the
 * redirect behaviour is exercised directly.
 */
import { describe, it, expect } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  isTestRuntime,
  isUnderRealSwitchroomHome,
  safeVaultPath,
  safeAuditLogPath,
} from "./test-isolation-guard.js";

const realHome = resolve(homedir(), ".switchroom");
const realTmp = resolve(tmpdir());

describe("test-isolation-guard", () => {
  it("isTestRuntime() is true under the test runner", () => {
    expect(isTestRuntime()).toBe(true);
  });

  describe("isUnderRealSwitchroomHome", () => {
    it("is true for the ~/.switchroom dir itself and paths inside it", () => {
      expect(isUnderRealSwitchroomHome(realHome)).toBe(true);
      expect(isUnderRealSwitchroomHome(join(realHome, "vault", "vault.enc"))).toBe(true);
      expect(isUnderRealSwitchroomHome(join(realHome, "vault-audit.log"))).toBe(true);
    });

    it("is false for an isolated tmpdir path", () => {
      expect(isUnderRealSwitchroomHome(join(realTmp, "x", "vault.enc"))).toBe(false);
    });

    it("is not fooled by a sibling prefix (~/.switchroom-config)", () => {
      // `${home}.switchroom-config` shares the `.switchroom` prefix but
      // is NOT inside the `.switchroom/` dir — the sep check guards this.
      expect(isUnderRealSwitchroomHome(realHome + "-config/x")).toBe(false);
    });
  });

  describe("safeVaultPath", () => {
    it("redirects a production vault path to an isolated tmpdir", () => {
      const prod = join(realHome, "vault", "vault.enc");
      const safe = safeVaultPath(prod);
      expect(safe).not.toBe(prod);
      expect(isUnderRealSwitchroomHome(safe)).toBe(false);
      expect(safe.startsWith(realTmp)).toBe(true);
      expect(safe.endsWith("vault.enc")).toBe(true);
    });

    it("returns an already-isolated tmp path unchanged", () => {
      const isolated = join(realTmp, "sw-test-xyz", "vault.enc");
      expect(safeVaultPath(isolated)).toBe(isolated);
    });

    it("hands out a FRESH dir per call so two brokers never collide", () => {
      const prod = join(realHome, "vault.enc");
      expect(safeVaultPath(prod)).not.toBe(safeVaultPath(prod));
    });

    it("honours the SWITCHROOM_ALLOW_PROD_VAULT_IN_TEST escape hatch", () => {
      const prod = join(realHome, "vault.enc");
      const prev = process.env.SWITCHROOM_ALLOW_PROD_VAULT_IN_TEST;
      process.env.SWITCHROOM_ALLOW_PROD_VAULT_IN_TEST = "1";
      try {
        expect(safeVaultPath(prod)).toBe(prod);
      } finally {
        if (prev === undefined) delete process.env.SWITCHROOM_ALLOW_PROD_VAULT_IN_TEST;
        else process.env.SWITCHROOM_ALLOW_PROD_VAULT_IN_TEST = prev;
      }
    });
  });

  describe("safeAuditLogPath", () => {
    it("redirects a production audit-log path to an isolated tmp file", () => {
      const prod = join(realHome, "vault-audit.log");
      const safe = safeAuditLogPath(prod);
      expect(safe).not.toBe(prod);
      expect(isUnderRealSwitchroomHome(safe)).toBe(false);
      expect(safe.startsWith(realTmp)).toBe(true);
    });

    it("returns an already-isolated tmp path unchanged", () => {
      const isolated = join(realTmp, "sw-test-audit-xyz", "vault-audit.log");
      expect(safeAuditLogPath(isolated)).toBe(isolated);
    });

    it("reuses one shared tmp file per process (append-only telemetry)", () => {
      const prod = join(realHome, "vault-audit.log");
      expect(safeAuditLogPath(prod)).toBe(safeAuditLogPath(prod));
    });
  });
});
