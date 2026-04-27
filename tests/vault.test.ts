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
  validateFormatHint,
  detectFormat,
  VAULT_FORMAT_HINTS,
  VaultError,
  type VaultEntry,
  type VaultFormatHint,
} from "../src/vault/vault.js";
import {
  isVaultReference,
  parseVaultReference,
  parseVaultReferenceDetailed,
  resolveVaultReferences,
  cleanupMaterializedSecrets,
} from "../src/vault/resolver.js";
import { readFileSync, statSync, existsSync } from "node:fs";
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

  describe("parseVaultReferenceDetailed", () => {
    it("returns key only when no fragment is present", () => {
      expect(parseVaultReferenceDetailed("vault:my-secret")).toEqual({
        key: "my-secret",
      });
    });

    it("splits key and filename on '#'", () => {
      expect(parseVaultReferenceDetailed("vault:garmin#oauth_token.json")).toEqual({
        key: "garmin",
        filename: "oauth_token.json",
      });
    });

    it("handles filenames with dots and dashes", () => {
      expect(parseVaultReferenceDetailed("vault:ha#id_rsa.pub")).toEqual({
        key: "ha",
        filename: "id_rsa.pub",
      });
    });
  });

  describe("files-kind materialization", () => {
    let tmpDir: string;
    let vaultPath: string;
    const passphrase = "materialize-test";

    // Pin XDG_RUNTIME_DIR to a per-test tmpdir so materialization lands
    // somewhere we can assert on and cleanly wipe.
    let origXdg: string | undefined;
    let xdgDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "switchroom-materialize-test-"));
      vaultPath = join(tmpDir, "vault.enc");
      createVault(passphrase, vaultPath);
      setFilesSecret(passphrase, vaultPath, "garmin", {
        "oauth_token.json": {
          encoding: "utf8",
          value: '{"access":"at","refresh":"rt"}',
        },
        "device_id.bin": {
          encoding: "base64",
          value: Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString("base64"),
        },
      });
      setStringSecret(passphrase, vaultPath, "plain", "plain-value");

      xdgDir = join(tmpDir, "xdg");
      origXdg = process.env.XDG_RUNTIME_DIR;
      process.env.XDG_RUNTIME_DIR = xdgDir;
    });

    afterEach(() => {
      cleanupMaterializedSecrets();
      if (origXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = origXdg;
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function buildConfig(botTokenRef: string): SwitchroomConfig {
      return {
        switchroom: { version: 1, agents_dir: "~/.switchroom/agents" },
        telegram: { bot_token: botTokenRef, forum_chat_id: "-100123" },
        vault: { path: vaultPath },
        agents: {
          test: { extends: "default", topic_name: "Test", schedule: [] },
        },
      };
    }

    it("materializes a kind=files entry to a temp dir and substitutes the path", () => {
      // Stash the files-kind ref into the telegram.bot_token slot (any
      // string field works for this test).
      const config = buildConfig("vault:garmin");
      const resolved = resolveVaultReferences(config, passphrase);

      const dir = resolved.telegram.bot_token;
      expect(typeof dir).toBe("string");
      expect(existsSync(dir)).toBe(true);

      // Files landed at the expected names.
      const tokenPath = join(dir, "oauth_token.json");
      const binPath = join(dir, "device_id.bin");
      expect(existsSync(tokenPath)).toBe(true);
      expect(existsSync(binPath)).toBe(true);

      // utf8 file round-trips verbatim.
      expect(readFileSync(tokenPath, "utf8")).toBe(
        '{"access":"at","refresh":"rt"}'
      );

      // base64 file decoded to raw bytes.
      const binBytes = readFileSync(binPath);
      expect(Array.from(binBytes)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    });

    it("writes the materialization dir with mode 0700", () => {
      const config = buildConfig("vault:garmin");
      const resolved = resolveVaultReferences(config, passphrase);
      const dir = resolved.telegram.bot_token;

      const mode = statSync(dir).mode & 0o777;
      expect(mode).toBe(0o700);
    });

    it("writes each materialized file with mode 0600", () => {
      const config = buildConfig("vault:garmin");
      const resolved = resolveVaultReferences(config, passphrase);
      const dir = resolved.telegram.bot_token;

      const tokenMode = statSync(join(dir, "oauth_token.json")).mode & 0o777;
      expect(tokenMode).toBe(0o600);
    });

    it("supports vault:<key>#<filename> to inline a specific file's contents", () => {
      const config = buildConfig("vault:garmin#oauth_token.json");
      const resolved = resolveVaultReferences(config, passphrase);
      expect(resolved.telegram.bot_token).toBe(
        '{"access":"at","refresh":"rt"}'
      );
    });

    it("throws when #<filename> targets a non-files kind", () => {
      const config = buildConfig("vault:plain#anything");
      expect(() => resolveVaultReferences(config, passphrase)).toThrow(
        /expected kind="files"/
      );
    });

    it("throws when #<filename> does not exist in the files entry", () => {
      const config = buildConfig("vault:garmin#missing.txt");
      expect(() => resolveVaultReferences(config, passphrase)).toThrow(
        /has no file named "missing.txt"/
      );
    });

    it("cleanupMaterializedSecrets wipes all materialized dirs", () => {
      const config = buildConfig("vault:garmin");
      const resolved = resolveVaultReferences(config, passphrase);
      const dir = resolved.telegram.bot_token;
      expect(existsSync(dir)).toBe(true);

      cleanupMaterializedSecrets();
      expect(existsSync(dir)).toBe(false);
    });

    it("rematerializing overwrites any stale dir from a prior resolve", () => {
      const config = buildConfig("vault:garmin");

      const first = resolveVaultReferences(config, passphrase);
      const dir1 = first.telegram.bot_token;

      // Drop a leftover file into the dir so we can observe it being wiped.
      require("node:fs").writeFileSync(join(dir1, "stale.txt"), "stale");
      expect(existsSync(join(dir1, "stale.txt"))).toBe(true);

      const second = resolveVaultReferences(config, passphrase);
      const dir2 = second.telegram.bot_token;

      // Same path (deterministic, keyed by pid+key) but the stale file
      // is gone.
      expect(dir2).toBe(dir1);
      expect(existsSync(join(dir2, "stale.txt"))).toBe(false);
      expect(existsSync(join(dir2, "oauth_token.json"))).toBe(true);
    });
  });
});

// ─── Issue #172: format hints ────────────────────────────────────────────────

describe("validateFormatHint", () => {
  it("accepts a valid PEM string", () => {
    const pem =
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEA\n-----END PRIVATE KEY-----\n";
    expect(validateFormatHint(pem, "pem")).toBeNull();
  });

  it("rejects a non-PEM value for --format pem", () => {
    expect(validateFormatHint("not pem", "pem")).toMatch(/PEM/);
  });

  it("accepts a valid 32-byte base64-raw-seed", () => {
    const seed = Buffer.alloc(32).toString("base64"); // 32 zero bytes
    expect(validateFormatHint(seed, "base64-raw-seed")).toBeNull();
  });

  it("rejects a short base64 value for --format base64-raw-seed", () => {
    const short = Buffer.alloc(16).toString("base64"); // only 16 bytes
    const result = validateFormatHint(short, "base64-raw-seed");
    expect(result).toMatch(/32-byte/);
  });

  it("accepts valid base64 for --format base64", () => {
    expect(validateFormatHint(Buffer.alloc(20).toString("base64"), "base64")).toBeNull();
  });

  it("accepts valid JSON for --format json", () => {
    expect(validateFormatHint('{"key":"value"}', "json")).toBeNull();
  });

  it("rejects invalid JSON for --format json", () => {
    expect(validateFormatHint("not json", "json")).toMatch(/JSON/i);
  });

  it("accepts anything for --format string", () => {
    expect(validateFormatHint("any text at all", "string")).toBeNull();
  });
});

describe("detectFormat", () => {
  it("detects PEM strings", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQI=\n-----END PRIVATE KEY-----\n";
    expect(detectFormat(pem)).toBe("pem");
  });

  it("detects a 32-byte base64-raw-seed", () => {
    const seed = Buffer.alloc(32).toString("base64");
    expect(detectFormat(seed)).toBe("base64-raw-seed");
  });

  it("returns null for plain text", () => {
    expect(detectFormat("hello world")).toBeNull();
  });
});

describe("format hint roundtrip via setStringSecret / getSecret", () => {
  let tmpDir: string;
  let vaultPath: string;
  const passphrase = "fmt-test-pass";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-fmt-test-"));
    vaultPath = join(tmpDir, "vault.enc");
    createVault(passphrase, vaultPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores and retrieves the format hint", () => {
    const pem =
      "-----BEGIN PRIVATE KEY-----\nMIIEvQI=\n-----END PRIVATE KEY-----\n";
    setStringSecret(passphrase, vaultPath, "mykey", pem, "pem");

    const entry = getSecret(passphrase, vaultPath, "mykey");
    expect(entry).not.toBeNull();
    expect(entry?.kind).toBe("string");
    if (entry?.kind === "string") {
      expect(entry.format).toBe("pem");
      expect(entry.value).toBe(pem);
    }
  });

  it("entries without a format hint have format=undefined", () => {
    setStringSecret(passphrase, vaultPath, "plain", "hello");
    const entry = getSecret(passphrase, vaultPath, "plain");
    expect(entry?.kind).toBe("string");
    if (entry?.kind === "string") {
      expect(entry.format).toBeUndefined();
    }
  });

  it("all VAULT_FORMAT_HINTS are listed and non-empty", () => {
    expect(VAULT_FORMAT_HINTS.length).toBeGreaterThan(0);
    for (const hint of VAULT_FORMAT_HINTS) {
      expect(hint).toBeTruthy();
    }
  });
});

// ─── Issue #172: vault set CLI --format integration ──────────────────────────

describe("vault set CLI --format integration", () => {
  const binPath = fileURLToPath(new URL("../bin/switchroom.ts", import.meta.url));
  const passphrase = "fmt-cli-test-passphrase";
  let tmpDir: string;
  let vaultPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-fmt-cli-test-"));
    vaultPath = join(tmpDir, "vault.enc");
    createVault(passphrase, vaultPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runCli(args: string[], input?: string) {
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

  it("stores format hint when --format pem is passed with a valid PEM", () => {
    const pem =
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAAS\n-----END PRIVATE KEY-----\n";
    const result = runCli(["set", "pem-key", "--format", "pem"], pem);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("format: pem");

    const entry = getSecret(passphrase, vaultPath, "pem-key");
    expect(entry?.kind).toBe("string");
    if (entry?.kind === "string") {
      expect(entry.format).toBe("pem");
    }
  });

  it("rejects a non-PEM value with --format pem and exits non-zero", () => {
    const result = runCli(["set", "bad-key", "--format", "pem"], "not a pem value");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/format validation failed/);
  });

  it("rejects an unknown --format value", () => {
    const result = runCli(["set", "x", "--format", "unknown-format"], "value");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unknown format/);
  });

  it("vault get --expect warns to stderr when stored format mismatches", () => {
    // Store a seed but tell the consumer it's a PEM
    const seed = Buffer.alloc(32).toString("base64");
    const setResult = runCli(["set", "seed-key", "--format", "base64-raw-seed"], seed);
    expect(setResult.status).toBe(0);

    // Get with --expect pem should warn but still print the value (warn-and-proceed)
    const getResult = runCli(["get", "seed-key", "--expect", "pem", "--no-broker"]);
    expect(getResult.status).toBe(0);
    expect(getResult.stderr).toMatch(/VAULT-FORMAT-MISMATCH/);
  });

  it("vault get --expect --strict-format exits 4 on mismatch", () => {
    const seed = Buffer.alloc(32).toString("base64");
    runCli(["set", "seed-key2", "--format", "base64-raw-seed"], seed);

    const getResult = runCli(["get", "seed-key2", "--expect", "pem", "--strict-format", "--no-broker"]);
    expect(getResult.status).toBe(4);
    expect(getResult.stderr).toMatch(/VAULT-FORMAT-MISMATCH/);
  });

  it("vault get --expect passes when formats match", () => {
    const pem =
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAAS\n-----END PRIVATE KEY-----\n";
    runCli(["set", "ok-pem", "--format", "pem"], pem);

    const getResult = runCli(["get", "ok-pem", "--expect", "pem", "--no-broker"]);
    expect(getResult.status).toBe(0);
    expect(getResult.stderr).not.toMatch(/VAULT-FORMAT-MISMATCH/);
  });
}, 30_000);

// ─── Issue #173: broker-denied error surface ──────────────────────────────────

describe("broker-denied error message format", () => {
  it("VAULT-BROKER-DENIED prefix is stable (grep-friendly)", () => {
    // The prefix is a contract — scripts grep for it. Verify it appears in
    // the ACL deny path by simulating a non-TTY caller against a running
    // broker that will deny them.
    //
    // Rather than spinning up a real broker (covered by the integration
    // test), we verify the prefix is used in the cli/vault.ts source via
    // a string match — the prefix must not be changed without updating the
    // docs and this test.
    const src = require("node:fs").readFileSync(
      require("node:path").join(
        require("node:url").fileURLToPath(new URL("../src/cli/vault.ts", import.meta.url))
      ),
      "utf8"
    ) as string;
    expect(src).toContain("VAULT-BROKER-DENIED");
    // The prefix should appear in both the "locked" and "denied" paths.
    const count = (src.match(/VAULT-BROKER-DENIED/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("VAULT-FORMAT-MISMATCH prefix appears in vault CLI source", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").join(
        require("node:url").fileURLToPath(new URL("../src/cli/vault.ts", import.meta.url))
      ),
      "utf8"
    ) as string;
    expect(src).toContain("VAULT-FORMAT-MISMATCH");
  });
});
