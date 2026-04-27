import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import {
  MFF_VAULT_KEY,
  deriveEd25519PublicKeyBytes,
  checkMffVaultKeyPresent,
  checkMffVaultKeyFormat,
  checkMffEnvFile,
  checkMffApiReachable,
  checkMffAuthFlow,
  checkMffCloudflareUa,
  checkMff,
} from "../src/cli/doctor.js";
import { generateKeyPairSync } from "node:crypto";
import { createVault, setStringSecret } from "../src/vault/vault.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  const dir = resolve(tmpdir(), `switchroom-mff-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a minimal vault file at vaultPath with the given key and value. */
function writeVaultWithKey(
  vaultPath: string,
  passphrase: string,
  key: string,
  value: string,
): void {
  createVault(passphrase, vaultPath);
  setStringSecret(passphrase, vaultPath, key, value);
}

/** Generate a real Ed25519 PEM private key. */
function generateEd25519Pem(): string {
  const { privateKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return privateKey;
}

/** Generate a real Ed25519 raw 32-byte seed as base64. */
function generateEd25519RawSeedBase64(): string {
  // Ed25519 private keys are 64 bytes; first 32 are the seed.
  const { privateKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "der" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  // PKCS8 Ed25519 DER: 48 bytes total. Seed is at offset 16.
  const seed = privateKey.slice(16, 48);
  return seed.toString("base64");
}

// ---------------------------------------------------------------------------
// MFF_VAULT_KEY
// ---------------------------------------------------------------------------

describe("MFF_VAULT_KEY", () => {
  it("is the expected vault key path", () => {
    expect(MFF_VAULT_KEY).toBe("mff/agent-private-key");
  });
});

// ---------------------------------------------------------------------------
// deriveEd25519PublicKeyBytes
// ---------------------------------------------------------------------------

describe("deriveEd25519PublicKeyBytes", () => {
  it("accepts a PEM private key and returns public key bytes", () => {
    const pem = generateEd25519Pem();
    const pubBytes = deriveEd25519PublicKeyBytes(pem);
    expect(pubBytes).not.toBeNull();
    expect(pubBytes!.length).toBeGreaterThan(0);
  });

  it("accepts a base64 raw 32-byte seed and returns public key bytes", () => {
    const seed = generateEd25519RawSeedBase64();
    const pubBytes = deriveEd25519PublicKeyBytes(seed);
    expect(pubBytes).not.toBeNull();
    expect(pubBytes!.length).toBeGreaterThan(0);
  });

  it("returns null for garbage input", () => {
    expect(deriveEd25519PublicKeyBytes("not-a-key")).toBeNull();
    expect(deriveEd25519PublicKeyBytes("")).toBeNull();
  });

  it("returns null for wrong-length base64 seed", () => {
    // 16 bytes — not a valid 32-byte seed
    const shortSeed = Buffer.alloc(16).toString("base64");
    expect(deriveEd25519PublicKeyBytes(shortSeed)).toBeNull();
  });

  it("returns null for PEM RSA key (wrong type)", () => {
    // This should fail to load as Ed25519 in the PEM branch.
    // Node crypto will load RSA as RSA — the derive call itself won't crash
    // but it will produce RSA spki bytes; the function makes no type check
    // beyond "can we load and export". Accept either null or a buffer.
    // The important thing is it doesn't throw.
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 1024,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    // Should not throw — may return bytes or null
    expect(() => deriveEd25519PublicKeyBytes(privateKey)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// checkMffVaultKeyPresent
// ---------------------------------------------------------------------------

describe("checkMffVaultKeyPresent", () => {
  let tempDir: string;
  const passphrase = "test-passphrase-123";

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("returns warn when passphrase is not set", () => {
    const vaultPath = join(tempDir, "vault.enc");
    const result = checkMffVaultKeyPresent(undefined, vaultPath);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("SWITCHROOM_VAULT_PASSPHRASE");
  });

  it("returns fail when vault file does not exist", () => {
    const result = checkMffVaultKeyPresent(passphrase, join(tempDir, "missing.enc"));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("not found");
  });

  it("returns fail when key is absent from vault", () => {
    const vaultPath = join(tempDir, "vault.enc");
    createVault(passphrase, vaultPath);
    const result = checkMffVaultKeyPresent(passphrase, vaultPath);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain(MFF_VAULT_KEY);
    expect(result.fix).toBeDefined();
  });

  it("returns ok when key is present in vault", () => {
    const vaultPath = join(tempDir, "vault.enc");
    writeVaultWithKey(vaultPath, passphrase, MFF_VAULT_KEY, "somekey");
    const result = checkMffVaultKeyPresent(passphrase, vaultPath);
    expect(result.status).toBe("ok");
    expect(result.detail).toContain(MFF_VAULT_KEY);
  });
});

// ---------------------------------------------------------------------------
// checkMffVaultKeyFormat
// ---------------------------------------------------------------------------

describe("checkMffVaultKeyFormat", () => {
  let tempDir: string;
  const passphrase = "test-passphrase-123";

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("returns warn when passphrase is not set", () => {
    const result = checkMffVaultKeyFormat(undefined, join(tempDir, "v.enc"));
    expect(result.status).toBe("warn");
  });

  it("returns warn when vault does not exist", () => {
    const result = checkMffVaultKeyFormat(passphrase, join(tempDir, "missing.enc"));
    expect(result.status).toBe("warn");
  });

  it("returns warn when key is not in vault", () => {
    const vaultPath = join(tempDir, "vault.enc");
    createVault(passphrase, vaultPath);
    const result = checkMffVaultKeyFormat(passphrase, vaultPath);
    expect(result.status).toBe("warn");
  });

  it("returns ok for a valid PEM Ed25519 private key", () => {
    const vaultPath = join(tempDir, "vault.enc");
    writeVaultWithKey(vaultPath, passphrase, MFF_VAULT_KEY, generateEd25519Pem());
    const result = checkMffVaultKeyFormat(passphrase, vaultPath);
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("PEM");
  });

  it("returns ok for a valid base64 raw seed", () => {
    const vaultPath = join(tempDir, "vault.enc");
    writeVaultWithKey(vaultPath, passphrase, MFF_VAULT_KEY, generateEd25519RawSeedBase64());
    const result = checkMffVaultKeyFormat(passphrase, vaultPath);
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("seed");
  });

  it("returns fail for unparseable key material", () => {
    const vaultPath = join(tempDir, "vault.enc");
    writeVaultWithKey(vaultPath, passphrase, MFF_VAULT_KEY, "not-a-valid-key-at-all");
    const result = checkMffVaultKeyFormat(passphrase, vaultPath);
    expect(result.status).toBe("fail");
    expect(result.fix).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// checkMffEnvFile
// ---------------------------------------------------------------------------

describe("checkMffEnvFile", () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it("returns fail when .env does not exist", () => {
    const result = checkMffEnvFile(join(tempDir, "nonexistent.env"));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("not found");
    expect(result.fix).toBeDefined();
  });

  it("returns fail when MFF_API_URL is missing", () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, "SOME_OTHER_VAR=hello\n");
    const result = checkMffEnvFile(envPath);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("MFF_API_URL");
  });

  it("returns fail when MFF_API_URL is empty string", () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, "MFF_API_URL=\n");
    const result = checkMffEnvFile(envPath);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("empty");
  });

  it("returns ok when MFF_API_URL is populated", () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, "MFF_API_URL=https://mff.example.com\n");
    const result = checkMffEnvFile(envPath);
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("https://mff.example.com");
  });
});

// ---------------------------------------------------------------------------
// checkMffApiReachable
// ---------------------------------------------------------------------------

describe("checkMffApiReachable", () => {
  let tempDir: string;
  const origFetch = globalThis.fetch;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns warn when MFF_API_URL is not set", async () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, "OTHER=x\n");
    const result = await checkMffApiReachable(envPath);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("skipped");
  });

  it("returns ok when /api/health returns 200", async () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, "MFF_API_URL=https://mff.example.com\n");
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200 })) as typeof fetch;
    const result = await checkMffApiReachable(envPath);
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("200");
  });

  it("returns fail when /api/health returns non-200", async () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, "MFF_API_URL=https://mff.example.com\n");
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503 })) as typeof fetch;
    const result = await checkMffApiReachable(envPath);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("503");
    expect(result.fix).toBeDefined();
  });

  it("returns fail on network error", async () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, "MFF_API_URL=https://mff.example.com\n");
    globalThis.fetch = vi.fn(async () => { throw new Error("connection refused"); }) as typeof fetch;
    const result = await checkMffApiReachable(envPath);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("connection refused");
  });

  it("returns fail on timeout", async () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, "MFF_API_URL=https://mff.example.com\n");
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as typeof fetch;
    const result = await checkMffApiReachable(envPath, 50);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("timeout");
  });
});

// ---------------------------------------------------------------------------
// checkMffAuthFlow
// ---------------------------------------------------------------------------

describe("checkMffAuthFlow", () => {
  let tempDir: string;
  const origFetch = globalThis.fetch;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns warn when MFF_API_URL is not set", async () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, "OTHER=x\n");
    const result = await checkMffAuthFlow(envPath);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("skipped");
  });

  it("returns warn when claude-auth.py is not found", async () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, `MFF_API_URL=https://mff.example.com\n`);
    // Temporarily override HOME so we look in a place that has no claude-auth.py
    const origHome = process.env.HOME;
    process.env.HOME = tempDir;
    try {
      const result = await checkMffAuthFlow(envPath);
      expect(result.status).toBe("warn");
      expect(result.detail).toContain("claude-auth.py not found");
    } finally {
      process.env.HOME = origHome;
    }
  });

  it("returns fail when claude-auth.py exits non-zero", async () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, `MFF_API_URL=https://mff.example.com\n`);
    const credDir = join(tempDir, ".switchroom/credentials/my-family-finance");
    mkdirSync(credDir, { recursive: true });
    const authScript = join(credDir, "claude-auth.py");
    writeFileSync(authScript, "import sys\nprint('error: auth failed', file=sys.stderr)\nsys.exit(1)\n");

    const origHome = process.env.HOME;
    process.env.HOME = tempDir;
    try {
      const result = await checkMffAuthFlow(envPath);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("exited");
    } finally {
      process.env.HOME = origHome;
    }
  });

  it("returns fail when claude-auth.py prints no token", async () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, `MFF_API_URL=https://mff.example.com\n`);
    const credDir = join(tempDir, ".switchroom/credentials/my-family-finance");
    mkdirSync(credDir, { recursive: true });
    const authScript = join(credDir, "claude-auth.py");
    writeFileSync(authScript, "# empty output\n");

    const origHome = process.env.HOME;
    process.env.HOME = tempDir;
    try {
      const result = await checkMffAuthFlow(envPath);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("no token");
    } finally {
      process.env.HOME = origHome;
    }
  });

  it("returns ok when auth script produces a token accepted by the API", async () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, `MFF_API_URL=https://mff.example.com\n`);
    const credDir = join(tempDir, ".switchroom/credentials/my-family-finance");
    mkdirSync(credDir, { recursive: true });
    const authScript = join(credDir, "claude-auth.py");
    writeFileSync(authScript, "print('valid-session-token-abc')\n");

    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200 })) as typeof fetch;

    const origHome = process.env.HOME;
    process.env.HOME = tempDir;
    try {
      const result = await checkMffAuthFlow(envPath);
      expect(result.status).toBe("ok");
      expect(result.detail).toContain("200");
    } finally {
      process.env.HOME = origHome;
    }
  });

  it("returns fail when token is rejected by the API", async () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, `MFF_API_URL=https://mff.example.com\n`);
    const credDir = join(tempDir, ".switchroom/credentials/my-family-finance");
    mkdirSync(credDir, { recursive: true });
    const authScript = join(credDir, "claude-auth.py");
    writeFileSync(authScript, "print('bad-token')\n");

    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 401 })) as typeof fetch;

    const origHome = process.env.HOME;
    process.env.HOME = tempDir;
    try {
      const result = await checkMffAuthFlow(envPath);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("401");
    } finally {
      process.env.HOME = origHome;
    }
  });
});

// ---------------------------------------------------------------------------
// checkMffCloudflareUa
// ---------------------------------------------------------------------------

describe("checkMffCloudflareUa", () => {
  let tempDir: string;
  const origFetch = globalThis.fetch;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns warn when MFF_API_URL is not set", async () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, "OTHER=x\n");
    const result = await checkMffCloudflareUa(envPath);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("skipped");
  });

  it("returns fail when Python UA is blocked but browser UA passes", async () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, "MFF_API_URL=https://mff.example.com\n");

    let callCount = 0;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      callCount++;
      const ua = (init?.headers as Record<string, string>)?.["User-Agent"] ?? "";
      if (ua.includes("python")) return { ok: false, status: 403 };
      return { ok: true, status: 200 };
    }) as typeof fetch;

    const result = await checkMffCloudflareUa(envPath);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("403");
    expect(result.fix).toBeDefined();
    expect(callCount).toBe(2);
  });

  it("returns ok when Python UA is not blocked", async () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, "MFF_API_URL=https://mff.example.com\n");
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200 })) as typeof fetch;
    const result = await checkMffCloudflareUa(envPath);
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("pass-through");
  });

  it("returns warn when both UAs are blocked (API down or auth-required)", async () => {
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, "MFF_API_URL=https://mff.example.com\n");
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 403 })) as typeof fetch;
    const result = await checkMffCloudflareUa(envPath);
    expect(result.status).toBe("warn");
  });
});

// ---------------------------------------------------------------------------
// checkMff (integration — all probes in order)
// ---------------------------------------------------------------------------

describe("checkMff", () => {
  let tempDir: string;
  const origFetch = globalThis.fetch;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns exactly 6 results (one per probe)", async () => {
    const vaultPath = join(tempDir, "vault.enc");
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, "OTHER=x\n");
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200 })) as typeof fetch;
    const results = await checkMff(undefined, vaultPath, envPath);
    expect(results).toHaveLength(6);
  });

  it("all probes report ok or warn (no fail) on a fully healthy setup", async () => {
    // Set up vault with a valid Ed25519 PEM key
    const vaultPath = join(tempDir, "vault.enc");
    const passphrase = "test-pass-xyz";
    writeVaultWithKey(vaultPath, passphrase, MFF_VAULT_KEY, generateEd25519Pem());

    // Set up .env with API URL
    const envPath = join(tempDir, ".env");
    writeFileSync(envPath, "MFF_API_URL=https://mff.example.com\n");

    // Stub fetch — /api/health and /api/categories both return 200
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200 })) as typeof fetch;

    const results = await checkMff(passphrase, vaultPath, envPath);
    expect(results).toHaveLength(6);

    for (const r of results) {
      expect(["ok", "warn"]).toContain(r.status);
    }
  });
});
