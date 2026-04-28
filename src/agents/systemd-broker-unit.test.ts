/**
 * Tests for generateBrokerUnit() — LoadCredentialEncrypted and Type=simple.
 *
 * Covers:
 *   - Type=simple is always present (regression guard for the earlier Type=notify bug)
 *   - LoadCredentialEncrypted= is absent when autoUnlock is not set
 *   - LoadCredentialEncrypted= is present with correct credential path when autoUnlock is set
 */

import { describe, expect, it } from "vitest";
import { generateBrokerUnit } from "./systemd.js";

const BASE_OPTS = {
  homeDir: "/home/testuser",
  bunBinDir: "/home/testuser/.bun/bin",
};

describe("generateBrokerUnit", () => {
  it("uses Type=simple (regression guard against Type=notify restart-loop bug)", () => {
    const unit = generateBrokerUnit(BASE_OPTS);
    // Exact line check — comments in the unit body mention "Type=notify" in the
    // rationale, so we match the whole directive line rather than a substring.
    expect(unit).toMatch(/^Type=simple$/m);
    expect(unit).not.toMatch(/^Type=notify$/m);
  });

  it("does not include LoadCredentialEncrypted= when autoUnlock is absent", () => {
    const unit = generateBrokerUnit(BASE_OPTS);
    expect(unit).not.toContain("LoadCredentialEncrypted=");
  });

  it("does not include LoadCredentialEncrypted= when autoUnlock is explicitly undefined", () => {
    const unit = generateBrokerUnit({ ...BASE_OPTS, autoUnlock: undefined });
    expect(unit).not.toContain("LoadCredentialEncrypted=");
  });

  it("includes LoadCredentialEncrypted= with correct path when autoUnlock is set", () => {
    const credPath = "/home/testuser/.config/credstore.encrypted/vault-passphrase";
    const unit = generateBrokerUnit({
      ...BASE_OPTS,
      autoUnlock: { credentialPath: credPath },
    });
    expect(unit).toContain(
      `LoadCredentialEncrypted=vault-passphrase:${credPath}`
    );
  });

  it("preserves Type=simple when autoUnlock is set", () => {
    const unit = generateBrokerUnit({
      ...BASE_OPTS,
      autoUnlock: { credentialPath: "/some/path/vault-passphrase" },
    });
    expect(unit).toMatch(/^Type=simple$/m);
    expect(unit).not.toMatch(/^Type=notify$/m);
  });

  it("includes ExecStart pointing to switchroom vault broker start --foreground", () => {
    const unit = generateBrokerUnit(BASE_OPTS);
    expect(unit).toContain("vault broker start --foreground");
  });

  it("ExecStart invokes bun explicitly before the switchroom CLI (fix #285)", () => {
    const unit = generateBrokerUnit(BASE_OPTS);
    expect(unit).toMatch(/^ExecStart=.*\/bun .*\/switchroom vault broker start --foreground$/m);
  });
});
