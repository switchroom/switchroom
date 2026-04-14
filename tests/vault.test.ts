import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createVault,
  openVault,
  saveVault,
  setSecret,
  getSecret,
  listSecrets,
  removeSecret,
  VaultError,
} from "../src/vault/vault.js";
import {
  isVaultReference,
  parseVaultReference,
  resolveVaultReferences,
} from "../src/vault/resolver.js";
import type { ClerkConfig } from "../src/config/schema.js";

describe("vault", () => {
  let tmpDir: string;
  let vaultPath: string;
  const passphrase = "test-passphrase-123";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "clerk-vault-test-"));
    vaultPath = join(tmpDir, "vault.enc");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("createVault + openVault round-trip", () => {
    it("creates and opens an empty vault", () => {
      createVault(passphrase, vaultPath);
      expect(existsSync(vaultPath)).toBe(true);

      const secrets = openVault(passphrase, vaultPath);
      expect(secrets).toEqual({});
    });

    it("throws if vault already exists", () => {
      createVault(passphrase, vaultPath);
      expect(() => createVault(passphrase, vaultPath)).toThrow(VaultError);
    });

    it("creates parent directories if needed", () => {
      const nestedPath = join(tmpDir, "a", "b", "vault.enc");
      createVault(passphrase, nestedPath);
      expect(existsSync(nestedPath)).toBe(true);
    });
  });

  describe("set/get secret round-trip", () => {
    it("stores and retrieves a secret", () => {
      createVault(passphrase, vaultPath);
      setSecret(passphrase, vaultPath, "api-key", "sk-12345");

      const value = getSecret(passphrase, vaultPath, "api-key");
      expect(value).toBe("sk-12345");
    });

    it("overwrites an existing secret", () => {
      createVault(passphrase, vaultPath);
      setSecret(passphrase, vaultPath, "token", "old-value");
      setSecret(passphrase, vaultPath, "token", "new-value");

      const value = getSecret(passphrase, vaultPath, "token");
      expect(value).toBe("new-value");
    });

    it("returns null for non-existent key", () => {
      createVault(passphrase, vaultPath);
      const value = getSecret(passphrase, vaultPath, "missing");
      expect(value).toBeNull();
    });
  });

  describe("listSecrets", () => {
    it("returns key names only", () => {
      createVault(passphrase, vaultPath);
      setSecret(passphrase, vaultPath, "key-a", "value-a");
      setSecret(passphrase, vaultPath, "key-b", "value-b");
      setSecret(passphrase, vaultPath, "key-c", "value-c");

      const keys = listSecrets(passphrase, vaultPath);
      expect(keys).toContain("key-a");
      expect(keys).toContain("key-b");
      expect(keys).toContain("key-c");
      expect(keys).toHaveLength(3);
    });

    it("returns empty array for empty vault", () => {
      createVault(passphrase, vaultPath);
      const keys = listSecrets(passphrase, vaultPath);
      expect(keys).toEqual([]);
    });
  });

  describe("removeSecret", () => {
    it("removes an existing secret", () => {
      createVault(passphrase, vaultPath);
      setSecret(passphrase, vaultPath, "to-delete", "value");
      removeSecret(passphrase, vaultPath, "to-delete");

      const value = getSecret(passphrase, vaultPath, "to-delete");
      expect(value).toBeNull();
    });

    it("throws when removing non-existent key", () => {
      createVault(passphrase, vaultPath);
      expect(() => removeSecret(passphrase, vaultPath, "missing")).toThrow(
        VaultError
      );
    });
  });

  describe("wrong passphrase", () => {
    it("fails gracefully with wrong passphrase", () => {
      createVault(passphrase, vaultPath);
      setSecret(passphrase, vaultPath, "key", "value");

      expect(() => openVault("wrong-passphrase", vaultPath)).toThrow(
        VaultError
      );
    });
  });

  describe("vault file not found", () => {
    it("throws when opening non-existent vault", () => {
      expect(() => openVault(passphrase, "/tmp/nonexistent.enc")).toThrow(
        VaultError
      );
    });
  });
});

describe("vault set CLI — multi-line values", () => {
  const binPath = fileURLToPath(new URL("../bin/clerk.ts", import.meta.url));
  const passphrase = "cli-test-passphrase";
  let tmpDir: string;
  let vaultPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "clerk-vault-cli-test-"));
    vaultPath = join(tmpDir, "vault.enc");
    createVault(passphrase, vaultPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runCli(args: string[], input?: string) {
    // Pass --config via a throwaway path; we only need `vault set` to run.
    // The vault path is resolved from the default loader fallback, so we
    // override it via CLERK_VAULT_PATH-like behavior by writing a minimal
    // config. Simpler: invoke with --config pointing at a tiny yaml that
    // sets vault.path.
    const configPath = join(tmpDir, "clerk.yaml");
    writeFileSync(
      configPath,
      `clerk:\n  version: 1\n  agents_dir: ${tmpDir}/agents\nvault:\n  path: ${vaultPath}\ntelegram:\n  bot_token: x\n  forum_chat_id: "-1"\nagents: {}\n`
    );
    return spawnSync(
      "bun",
      [binPath, "--config", configPath, "vault", ...args],
      {
        input,
        env: { ...process.env, CLERK_VAULT_PASSPHRASE: passphrase },
        encoding: "utf8",
      }
    );
  }

  it("preserves multi-line value piped via non-TTY stdin", () => {
    const multiLine = "line-a\nline-b\nline-c";
    const result = runCli(["set", "multi"], multiLine);
    expect(result.status).toBe(0);

    const stored = getSecret(passphrase, vaultPath, "multi");
    expect(stored).toBe(multiLine);
  });

  it("preserves a PEM-like value piped via non-TTY stdin", () => {
    const pem =
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDa\nabc\n-----END PRIVATE KEY-----\n";
    const result = runCli(["set", "pem"], pem);
    expect(result.status).toBe(0);

    const stored = getSecret(passphrase, vaultPath, "pem");
    expect(stored).toBe(pem);
  });

  it("reads value verbatim from --file flag", () => {
    const json = '{\n  "key": "value",\n  "nested": {"x": 1}\n}\n';
    const filePath = join(tmpDir, "secret.json");
    writeFileSync(filePath, json);

    const result = runCli(["set", "cfg", "--file", filePath]);
    expect(result.status).toBe(0);

    const stored = getSecret(passphrase, vaultPath, "cfg");
    expect(stored).toBe(json);
  });
}, 30_000);

describe("vault resolver", () => {
  describe("isVaultReference", () => {
    it("returns true for vault references", () => {
      expect(isVaultReference("vault:my-secret")).toBe(true);
      expect(isVaultReference("vault:")).toBe(true);
    });

    it("returns false for non-vault strings", () => {
      expect(isVaultReference("not-a-vault-ref")).toBe(false);
      expect(isVaultReference("")).toBe(false);
      expect(isVaultReference("VAULT:upper")).toBe(false);
    });
  });

  describe("parseVaultReference", () => {
    it("extracts the key name", () => {
      expect(parseVaultReference("vault:my-secret")).toBe("my-secret");
      expect(parseVaultReference("vault:telegram-bot-token")).toBe(
        "telegram-bot-token"
      );
    });

    it("throws for non-vault strings", () => {
      expect(() => parseVaultReference("not-a-ref")).toThrow();
    });
  });

  describe("resolveVaultReferences", () => {
    let tmpDir: string;
    let vaultPath: string;
    const passphrase = "test-resolve-passphrase";

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "clerk-resolve-test-"));
      vaultPath = join(tmpDir, "vault.enc");
      createVault(passphrase, vaultPath);
      setSecret(passphrase, vaultPath, "telegram-bot-token", "123:ABC");
      setSecret(passphrase, vaultPath, "api-key", "sk-secret");
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("resolves vault references in config", () => {
      const config: ClerkConfig = {
        clerk: { version: 1, agents_dir: "~/.clerk/agents" },
        telegram: {
          bot_token: "vault:telegram-bot-token",
          forum_chat_id: "-100123",
        },
        vault: { path: vaultPath },
        agents: {
          test: {
            extends: "default",
            topic_name: "Test",
            schedule: [],
          },
        },
      };

      const resolved = resolveVaultReferences(config, passphrase);
      expect(resolved.telegram.bot_token).toBe("123:ABC");
      expect(resolved.telegram.forum_chat_id).toBe("-100123");
    });

    it("leaves non-vault strings unchanged", () => {
      const config: ClerkConfig = {
        clerk: { version: 1, agents_dir: "~/.clerk/agents" },
        telegram: {
          bot_token: "plain-token",
          forum_chat_id: "-100123",
        },
        vault: { path: vaultPath },
        agents: {
          test: {
            extends: "default",
            topic_name: "Test",
            schedule: [],
          },
        },
      };

      const resolved = resolveVaultReferences(config, passphrase);
      expect(resolved.telegram.bot_token).toBe("plain-token");
    });
  });
});
