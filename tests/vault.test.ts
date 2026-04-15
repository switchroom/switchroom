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
  setStringSecret,
  setFilesSecret,
  getSecret,
  getStringSecret,
  listSecrets,
  removeSecret,
  VaultError,
  type VaultEntry,
} from "../src/vault/vault.js";
import {
  isVaultReference,
  parseVaultReference,
  resolveVaultReferences,
} from "../src/vault/resolver.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

describe("vault", () => {
  let tmpDir: string;
  let vaultPath: string;
  const passphrase = "test-passphrase-123";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-vault-test-"));
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
    it("stores and retrieves a string secret via the convenience helper", () => {
      createVault(passphrase, vaultPath);
      setStringSecret(passphrase, vaultPath, "api-key", "sk-12345");

      expect(getStringSecret(passphrase, vaultPath, "api-key")).toBe("sk-12345");
      expect(getSecret(passphrase, vaultPath, "api-key")).toEqual({
        kind: "string",
        value: "sk-12345",
      });
    });

    it("overwrites an existing secret", () => {
      createVault(passphrase, vaultPath);
      setStringSecret(passphrase, vaultPath, "token", "old-value");
      setStringSecret(passphrase, vaultPath, "token", "new-value");

      expect(getStringSecret(passphrase, vaultPath, "token")).toBe("new-value");
    });

    it("returns null for non-existent key", () => {
      createVault(passphrase, vaultPath);
      expect(getSecret(passphrase, vaultPath, "missing")).toBeNull();
      expect(getStringSecret(passphrase, vaultPath, "missing")).toBeNull();
    });

    it("setSecret accepts a full VaultEntry directly", () => {
      createVault(passphrase, vaultPath);
      const entry: VaultEntry = { kind: "string", value: "direct" };
      setSecret(passphrase, vaultPath, "explicit", entry);
      expect(getSecret(passphrase, vaultPath, "explicit")).toEqual(entry);
    });
  });

  describe("binary kind round-trip", () => {
    it("stores and retrieves a base64-encoded binary secret", () => {
      createVault(passphrase, vaultPath);
      const bytes = Buffer.from([0x00, 0xff, 0x42, 0xde, 0xad]).toString("base64");
      setSecret(passphrase, vaultPath, "blob", { kind: "binary", value: bytes });

      const got = getSecret(passphrase, vaultPath, "blob");
      expect(got).toEqual({ kind: "binary", value: bytes });
    });

    it("getStringSecret refuses a non-string entry", () => {
      createVault(passphrase, vaultPath);
      setSecret(passphrase, vaultPath, "blob", { kind: "binary", value: "AAA=" });
      expect(() => getStringSecret(passphrase, vaultPath, "blob")).toThrow(
        VaultError
      );
    });
  });

  describe("files kind round-trip", () => {
    it("stores and retrieves a multi-file secret", () => {
      createVault(passphrase, vaultPath);
      const files = {
        "oauth_token.json": {
          encoding: "utf8" as const,
          value: '{"access":"a","refresh":"r"}',
        },
        "cert.pem": {
          encoding: "utf8" as const,
          value: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
        },
        "keystore.bin": {
          encoding: "base64" as const,
          value: Buffer.from([1, 2, 3, 4]).toString("base64"),
        },
      };
      setFilesSecret(passphrase, vaultPath, "garmin-tokens", files);

      const got = getSecret(passphrase, vaultPath, "garmin-tokens");
      expect(got).toEqual({ kind: "files", files });
    });

    it("getStringSecret refuses a files entry with a helpful error", () => {
      createVault(passphrase, vaultPath);
      setFilesSecret(passphrase, vaultPath, "dir", {
        "a.txt": { encoding: "utf8", value: "hi" },
      });
      expect(() => getStringSecret(passphrase, vaultPath, "dir")).toThrow(
        /kind="files"/
      );
    });
  });

  describe("legacy auto-migration", () => {
    it("reads a vault with bare string values and wraps them as kind=\"string\"", () => {
      // Hand-craft a legacy vault: write a VaultFile whose decrypted
      // plaintext contains `{"secrets":{"legacy":"bare-string"}}` —
      // the format openclaw/older switchroom used before the VaultEntry
      // union landed.
      createVault(passphrase, vaultPath);

      // Re-encrypt a payload in legacy shape.
      const legacyPayload = JSON.stringify({ secrets: { legacy: "bare-string" } });
      const raw = JSON.parse(
        require("node:fs").readFileSync(vaultPath, "utf8")
      ) as { salt: string; iv: string; data: string; tag: string };
      const salt = Buffer.from(raw.salt, "hex");
      const key = require("node:crypto").scryptSync(passphrase, salt, 32, {
        N: 16384,
        r: 8,
        p: 1,
      }) as Buffer;
      const iv = require("node:crypto").randomBytes(12);
      const cipher = require("node:crypto").createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([
        cipher.update(legacyPayload, "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      require("node:fs").writeFileSync(
        vaultPath,
        JSON.stringify(
          {
            salt: raw.salt,
            iv: iv.toString("hex"),
            data: encrypted.toString("hex"),
            tag: tag.toString("hex"),
          },
          null,
          2
        )
      );

      const secrets = openVault(passphrase, vaultPath);
      expect(secrets.legacy).toEqual({ kind: "string", value: "bare-string" });

      // getStringSecret transparently unwraps it.
      expect(getStringSecret(passphrase, vaultPath, "legacy")).toBe("bare-string");
    });
  });

  describe("listSecrets", () => {
    it("returns key names only", () => {
      createVault(passphrase, vaultPath);
      setStringSecret(passphrase, vaultPath, "key-a", "value-a");
      setStringSecret(passphrase, vaultPath, "key-b", "value-b");
      setFilesSecret(passphrase, vaultPath, "key-c", {
        "f.txt": { encoding: "utf8", value: "c" },
      });

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
      setStringSecret(passphrase, vaultPath, "to-delete", "value");
      removeSecret(passphrase, vaultPath, "to-delete");

      expect(getSecret(passphrase, vaultPath, "to-delete")).toBeNull();
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
      setStringSecret(passphrase, vaultPath, "key", "value");

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
  const binPath = fileURLToPath(new URL("../bin/switchroom.ts", import.meta.url));
  const passphrase = "cli-test-passphrase";
  let tmpDir: string;
  let vaultPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-vault-cli-test-"));
    vaultPath = join(tmpDir, "vault.enc");
    createVault(passphrase, vaultPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runCli(args: string[], input?: string) {
    // Pass --config via a throwaway path; we only need `vault set` to run.
    // The vault path is resolved from the default loader fallback, so we
    // override it via SWITCHROOM_VAULT_PATH-like behavior by writing a minimal
    // config. Simpler: invoke with --config pointing at a tiny yaml that
    // sets vault.path.
    const configPath = join(tmpDir, "switchroom.yaml");
    writeFileSync(
      configPath,
      `switchroom:\n  version: 1\n  agents_dir: ${tmpDir}/agents\nvault:\n  path: ${vaultPath}\ntelegram:\n  bot_token: x\n  forum_chat_id: "-1"\nagents: {}\n`
    );
    return spawnSync(
      "bun",
      [binPath, "--config", configPath, "vault", ...args],
      {
        input,
        env: { ...process.env, SWITCHROOM_VAULT_PASSPHRASE: passphrase },
        encoding: "utf8",
      }
    );
  }

  it("preserves multi-line value piped via non-TTY stdin", () => {
    const multiLine = "line-a\nline-b\nline-c";
    const result = runCli(["set", "multi"], multiLine);
    expect(result.status).toBe(0);

    expect(getStringSecret(passphrase, vaultPath, "multi")).toBe(multiLine);
  });

  it("preserves a PEM-like value piped via non-TTY stdin", () => {
    const pem =
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDa\nabc\n-----END PRIVATE KEY-----\n";
    const result = runCli(["set", "pem"], pem);
    expect(result.status).toBe(0);

    expect(getStringSecret(passphrase, vaultPath, "pem")).toBe(pem);
  });

  it("reads value verbatim from --file flag", () => {
    const json = '{\n  "key": "value",\n  "nested": {"x": 1}\n}\n';
    const filePath = join(tmpDir, "secret.json");
    writeFileSync(filePath, json);

    const result = runCli(["set", "cfg", "--file", filePath]);
    expect(result.status).toBe(0);

    expect(getStringSecret(passphrase, vaultPath, "cfg")).toBe(json);
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
      tmpDir = mkdtempSync(join(tmpdir(), "switchroom-resolve-test-"));
      vaultPath = join(tmpDir, "vault.enc");
      createVault(passphrase, vaultPath);
      setStringSecret(passphrase, vaultPath, "telegram-bot-token", "123:ABC");
      setStringSecret(passphrase, vaultPath, "api-key", "sk-secret");
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("resolves vault references in config", () => {
      const config: SwitchroomConfig = {
        switchroom: { version: 1, agents_dir: "~/.switchroom/agents" },
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
      const config: SwitchroomConfig = {
        switchroom: { version: 1, agents_dir: "~/.switchroom/agents" },
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
