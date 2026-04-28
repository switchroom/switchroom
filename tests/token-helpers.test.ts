import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import {
  createVault,
  setStringSecret,
  getStringSecret,
} from "../src/vault/vault.js";

function hasBin(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const HAVE_CURL = hasBin("curl");
const HAVE_JQ = hasBin("jq");
const HAVE_BASH = hasBin("bash");

const runSkipCondition = !(HAVE_CURL && HAVE_JQ && HAVE_BASH);

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const binPath = resolve(repoRoot, "bin/switchroom.ts");
const googleScript = resolve(
  repoRoot,
  "skills/token-helpers/scripts/google-cal-token.sh"
);
const msGraphScript = resolve(
  repoRoot,
  "skills/token-helpers/scripts/ms-graph-token.sh"
);

interface CapturedRequest {
  path: string;
  body: string;
  headers: IncomingMessage["headers"];
}

interface ScriptResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runScript(
  script: string,
  env: NodeJS.ProcessEnv
): Promise<ScriptResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("bash", [script], { env, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });
    child.on("error", rejectRun);
    child.on("close", (code) => {
      resolveRun({ status: code, stdout, stderr });
    });
  });
}

interface MockServer {
  url: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

async function startMockOAuth(
  respond: (req: CapturedRequest) => { status: number; body: string }
): Promise<MockServer> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const captured: CapturedRequest = {
        path: req.url ?? "",
        body,
        headers: req.headers,
      };
      requests.push(captured);
      const { status, body: responseBody } = respond(captured);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(responseBody);
    });
  });

  await new Promise<void>((resolveStart) => {
    server.listen(0, "127.0.0.1", () => resolveStart());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("failed to bind mock server");
  }
  const url = `http://127.0.0.1:${addr.port}/token`;

  return {
    url,
    requests,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      }),
  };
}

describe.skipIf(runSkipCondition)("token-helpers/google-cal-token.sh", () => {
  let tmpDir: string;
  let vaultPath: string;
  let configPath: string;
  let shimDir: string;
  const passphrase = "test-tokens-pass";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-token-test-"));
    vaultPath = join(tmpDir, "vault.enc");
    createVault(passphrase, vaultPath);
    setStringSecret(
      passphrase,
      vaultPath,
      "google-cal-refresh-token",
      "refresh-abc"
    );
    setStringSecret(passphrase, vaultPath, "google-cal-client-id", "cid-123");
    setStringSecret(
      passphrase,
      vaultPath,
      "google-cal-client-secret",
      "csecret-xyz"
    );

    configPath = join(tmpDir, "switchroom.yaml");
    // Point vault.broker.socket to a non-existent path so the CLI bypasses
    // the live system broker and falls through to direct vault access.
    // Without this, `switchroom vault get` hits the real broker daemon running
    // on ~/.switchroom/vault-broker.sock, which is locked and rejects non-TTY
    // callers with VAULT-BROKER-DENIED.
    writeFileSync(
      configPath,
      `switchroom:\n  version: 1\n  agents_dir: ${tmpDir}/agents\nvault:\n  path: ${vaultPath}\n  broker:\n    socket: ${tmpDir}/no-broker.sock\ntelegram:\n  bot_token: x\n  forum_chat_id: "-1"\nagents: {}\n`
    );

    // Shim that substitutes `switchroom` on PATH with the repo's
    // bin/switchroom.ts running under bun + the test config.
    shimDir = join(tmpDir, "bin");
    require("node:fs").mkdirSync(shimDir, { recursive: true });
    const shimPath = join(shimDir, "switchroom");
    writeFileSync(
      shimPath,
      `#!/usr/bin/env bash\nexec bun ${binPath} --config ${configPath} "$@"\n`
    );
    chmodSync(shimPath, 0o755);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("refreshes, writes the new token back to the vault, and prints it to stdout", async () => {
    const mock = await startMockOAuth(() => ({
      status: 200,
      body: JSON.stringify({
        access_token: "new-access-token-456",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    }));

    try {
      const result = await runScript(googleScript, {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH}`,
        GOOGLE_OAUTH_TOKEN_URL: mock.url,
        SWITCHROOM_VAULT_PASSPHRASE: passphrase,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("new-access-token-456");

      // New access token persisted to the vault.
      expect(
        getStringSecret(passphrase, vaultPath, "google-cal-access-token")
      ).toBe("new-access-token-456");

      // The OAuth endpoint saw the expected form-encoded payload.
      expect(mock.requests).toHaveLength(1);
      const reqBody = mock.requests[0].body;
      expect(reqBody).toContain("grant_type=refresh_token");
      expect(reqBody).toContain("refresh_token=refresh-abc");
      expect(reqBody).toContain("client_id=cid-123");
      expect(reqBody).toContain("client_secret=csecret-xyz");
    } finally {
      await mock.close();
    }
  }, 30_000);

  it("honors custom vault key env vars", async () => {
    setStringSecret(
      passphrase,
      vaultPath,
      "my-custom-refresh",
      "alt-refresh"
    );
    setStringSecret(passphrase, vaultPath, "my-custom-id", "alt-id");
    setStringSecret(passphrase, vaultPath, "my-custom-secret", "alt-secret");

    const mock = await startMockOAuth(() => ({
      status: 200,
      body: JSON.stringify({ access_token: "alt-access", expires_in: 3600 }),
    }));

    try {
      const result = await runScript(googleScript, {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH}`,
        GOOGLE_OAUTH_TOKEN_URL: mock.url,
        SWITCHROOM_VAULT_PASSPHRASE: passphrase,
        GOOGLE_CAL_REFRESH_TOKEN_KEY: "my-custom-refresh",
        GOOGLE_CAL_CLIENT_ID_KEY: "my-custom-id",
        GOOGLE_CAL_CLIENT_SECRET_KEY: "my-custom-secret",
        GOOGLE_CAL_ACCESS_TOKEN_KEY: "my-custom-access",
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("alt-access");
      expect(
        getStringSecret(passphrase, vaultPath, "my-custom-access")
      ).toBe("alt-access");
      expect(mock.requests[0].body).toContain("refresh_token=alt-refresh");
    } finally {
      await mock.close();
    }
  }, 30_000);

  it("exits non-zero when OAuth endpoint returns an error payload", async () => {
    const mock = await startMockOAuth(() => ({
      status: 400,
      body: JSON.stringify({ error: "invalid_grant" }),
    }));

    try {
      const result = await runScript(googleScript, {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH}`,
        GOOGLE_OAUTH_TOKEN_URL: mock.url,
        SWITCHROOM_VAULT_PASSPHRASE: passphrase,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("access_token");
      // Old access token (or no access token) — must NOT have written
      // anything bogus into the vault.
      expect(
        getStringSecret(passphrase, vaultPath, "google-cal-access-token")
      ).toBeNull();
    } finally {
      await mock.close();
    }
  }, 30_000);

  it("exits non-zero when the required vault key is missing", async () => {
    // Drop the refresh token so the first vault_get call fails.
    // A fresh vault without the key — just re-create.
    rmSync(vaultPath);
    createVault(passphrase, vaultPath);
    setStringSecret(passphrase, vaultPath, "google-cal-client-id", "cid-123");
    setStringSecret(
      passphrase,
      vaultPath,
      "google-cal-client-secret",
      "csecret-xyz"
    );
    // Intentionally NOT setting google-cal-refresh-token.

    const result = await runScript(googleScript, {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH}`,
      GOOGLE_OAUTH_TOKEN_URL: "http://127.0.0.1:1/unused",
      SWITCHROOM_VAULT_PASSPHRASE: passphrase,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("google-cal-refresh-token");
  }, 30_000);
});

describe.skipIf(runSkipCondition)("token-helpers/ms-graph-token.sh", () => {
  let tmpDir: string;
  let vaultPath: string;
  let configPath: string;
  let shimDir: string;
  const passphrase = "test-msgraph-pass";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-msgraph-test-"));
    vaultPath = join(tmpDir, "vault.enc");
    createVault(passphrase, vaultPath);
    setStringSecret(
      passphrase,
      vaultPath,
      "ms-graph-refresh-token",
      "ms-refresh-zzz"
    );
    setStringSecret(passphrase, vaultPath, "ms-graph-client-id", "ms-cid");

    configPath = join(tmpDir, "switchroom.yaml");
    // Point vault.broker.socket to a non-existent path so the CLI bypasses
    // the live system broker and falls through to direct vault access.
    // Without this, `switchroom vault get` hits the real broker daemon running
    // on ~/.switchroom/vault-broker.sock, which is locked and rejects non-TTY
    // callers with VAULT-BROKER-DENIED.
    writeFileSync(
      configPath,
      `switchroom:\n  version: 1\n  agents_dir: ${tmpDir}/agents\nvault:\n  path: ${vaultPath}\n  broker:\n    socket: ${tmpDir}/no-broker.sock\ntelegram:\n  bot_token: x\n  forum_chat_id: "-1"\nagents: {}\n`
    );

    shimDir = join(tmpDir, "bin");
    require("node:fs").mkdirSync(shimDir, { recursive: true });
    const shimPath = join(shimDir, "switchroom");
    writeFileSync(
      shimPath,
      `#!/usr/bin/env bash\nexec bun ${binPath} --config ${configPath} "$@"\n`
    );
    chmodSync(shimPath, 0o755);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("refreshes against the MS v2.0 token endpoint (public client, no secret)", async () => {
    const mock = await startMockOAuth(() => ({
      status: 200,
      body: JSON.stringify({
        access_token: "ms-access-789",
        expires_in: 3600,
      }),
    }));

    try {
      const result = await runScript(msGraphScript, {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH}`,
        MS_OAUTH_TOKEN_URL: mock.url,
        SWITCHROOM_VAULT_PASSPHRASE: passphrase,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("ms-access-789");

      expect(
        getStringSecret(passphrase, vaultPath, "ms-graph-access-token")
      ).toBe("ms-access-789");

      const reqBody = mock.requests[0].body;
      expect(reqBody).toContain("grant_type=refresh_token");
      expect(reqBody).toContain("refresh_token=ms-refresh-zzz");
      expect(reqBody).toContain("client_id=ms-cid");
      expect(reqBody).toContain("scope=");
      // Public client: no client_secret in the body.
      expect(reqBody).not.toContain("client_secret=");
    } finally {
      await mock.close();
    }
  }, 30_000);

  it("sends client_secret when it is set in the vault (confidential client)", async () => {
    setStringSecret(
      passphrase,
      vaultPath,
      "ms-graph-client-secret",
      "ms-csecret"
    );

    const mock = await startMockOAuth(() => ({
      status: 200,
      body: JSON.stringify({
        access_token: "ms-access-conf",
        expires_in: 3600,
      }),
    }));

    try {
      const result = await runScript(msGraphScript, {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH}`,
        MS_OAUTH_TOKEN_URL: mock.url,
        SWITCHROOM_VAULT_PASSPHRASE: passphrase,
      });

      expect(result.status).toBe(0);
      expect(mock.requests[0].body).toContain("client_secret=ms-csecret");
    } finally {
      await mock.close();
    }
  }, 30_000);
});
