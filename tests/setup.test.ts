import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

import { createServer } from "node:net";
import { validateBotToken } from "../src/setup/telegram-api.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

// Mock the vault module so importing setup.ts (which dynamic-imports
// vault.ts AND statically imports vault-broker.js → broker/server.ts
// → grants-db.ts → bun:sqlite) doesn't transitively load bun:sqlite.
// vitest doesn't ship the bun:sqlite shim. The resolveOrPromptToken
// precedence tests stub the vault read path via the vault.js mock.
vi.mock("../src/vault/vault.js", () => ({
  openVault: vi.fn(),
  createVault: vi.fn(),
  setStringSecret: vi.fn(),
}));
vi.mock("../src/vault/grants-db.ts", () => ({}));
vi.mock("../src/vault/broker/server.js", () => ({
  VaultBroker: vi.fn(),
  registerShutdownHandlers: vi.fn(),
}));

import { resolveOrPromptToken } from "../src/cli/setup.js";
import * as vaultMod from "../src/vault/vault.js";
import {
  buildAccessJson,
  findExistingClaudeJson,
  copyOnboardingState,
  copyExistingCredentials,
} from "../src/setup/onboarding.js";
import { stripOfficialTelegramPlugin } from "../src/agents/scaffold.js";
import {
  isPortFree,
  findFreePort,
  pickHindsightPorts,
  preflightHindsightPorts,
  HINDSIGHT_DEFAULT_API_PORT,
  HINDSIGHT_DEFAULT_UI_PORT,
  HINDSIGHT_DEFAULT_MCP_URL,
} from "../src/setup/hindsight.js";
import { generateHindsightMcpConfig } from "../src/memory/hindsight.js";

// ─── validateBotToken ────────────────────────────────────────────────────────

describe("validateBotToken", () => {
  // Bun's vitest compat doesn't support vi.stubGlobal(). Assign the
  // mock directly on globalThis and restore the original after.
  let origFetch: typeof fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("should return bot info on valid token", async () => {
    const mockResponse = {
      ok: true,
      result: {
        id: 123456,
        is_bot: true,
        first_name: "TestBot",
        username: "test_bot",
      },
    };

    (fetch as any).mockResolvedValue({
      json: async () => mockResponse,
    });

    const result = await validateBotToken("fake-token");

    expect(result).toEqual({
      id: 123456,
      is_bot: true,
      first_name: "TestBot",
      username: "test_bot",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/botfake-token/getMe",
    );
  });

  it("should throw on invalid token", async () => {
    const mockResponse = {
      ok: false,
      description: "Unauthorized",
    };

    (fetch as any).mockResolvedValue({
      json: async () => mockResponse,
    });

    await expect(validateBotToken("bad-token")).rejects.toThrow(
      "Invalid bot token: Unauthorized",
    );
  });

  it("should throw on network error", async () => {
    (fetch as any).mockRejectedValue(new Error("Network failure"));

    await expect(validateBotToken("any-token")).rejects.toThrow(
      "Network error validating bot token: Network failure",
    );
  });
});

// ─── buildAccessJson ─────────────────────────────────────────────────────────

describe("buildAccessJson", () => {
  it("should produce valid JSON with dmPolicy and groups", () => {
    const json = buildAccessJson("12345", "-100987654321");
    const parsed = JSON.parse(json);

    expect(parsed.dmPolicy).toBe("allowlist");
    expect(parsed.allowFrom).toEqual(["12345"]);
    expect(parsed.groups).toBeDefined();
    expect(parsed.groups["-100987654321"]).toBeDefined();
    expect(parsed.groups["-100987654321"].requireMention).toBe(false);
    expect(parsed.groups["-100987654321"].allowFrom).toEqual([]);
  });

  it("should produce consistent format regardless of topic_id", () => {
    const json = buildAccessJson("12345", "-100987654321", 42);
    const parsed = JSON.parse(json);

    // Topic ID is not needed in access.json — each bot only responds
    // to the group it's configured for
    expect(parsed.dmPolicy).toBe("allowlist");
    expect(parsed.groups["-100987654321"]).toBeDefined();
  });

  it("should not include topic_id (not needed for one-bot-per-agent)", () => {
    const json = buildAccessJson("12345", "-100987654321");
    const parsed = JSON.parse(json);

    expect(parsed).not.toHaveProperty("topic_id");
  });

  it("dmOnly=true omits the groups entry entirely (suppresses noisy boot probe)", () => {
    // DM-only bots have their own bot_token and live in a private chat.
    // The default scaffold inherits the global telegram.forum_chat_id
    // into access.json's groups, but the DM bot isn't a member of that
    // chat — the boot probe correctly emits
    // "boot-probe-failed: 400 Bad Request: chat not found" every restart
    // plus a misleading user-facing notification. Setting dmOnly drops
    // the groups entry; the probe sweeps nothing it can't reach.
    const json = buildAccessJson("12345", "-100987654321", undefined, { dmOnly: true });
    const parsed = JSON.parse(json);
    expect(parsed.dmPolicy).toBe("allowlist");
    expect(parsed.allowFrom).toEqual(["12345"]);
    expect(parsed).not.toHaveProperty("groups");
  });

  it("dmOnly=false (default) keeps the legacy groups shape for back-compat", () => {
    const json = buildAccessJson("12345", "-100987654321", undefined, { dmOnly: false });
    const parsed = JSON.parse(json);
    expect(parsed.groups["-100987654321"]).toBeDefined();
  });

  it("opts omitted entirely behaves identically to dmOnly=false", () => {
    const a = JSON.parse(buildAccessJson("12345", "-100987654321"));
    const b = JSON.parse(buildAccessJson("12345", "-100987654321", undefined, {}));
    expect(a).toEqual(b);
  });
});

// ─── findExistingClaudeJson ──────────────────────────────────────────────────

describe("findExistingClaudeJson", () => {
  let originalHome: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tempDir = mkdtempSync(join(tmpdir(), "switchroom-test-"));
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should find .claude.json in .claude-home/", () => {
    const claudeHomeDir = join(tempDir, ".claude-home");
    mkdirSync(claudeHomeDir, { recursive: true });
    writeFileSync(
      join(claudeHomeDir, ".claude.json"),
      JSON.stringify({ hasCompletedOnboarding: true }),
    );

    const result = findExistingClaudeJson();
    expect(result).toBe(join(claudeHomeDir, ".claude.json"));
  });

  it("should find .claude.json in .claude/", () => {
    const claudeDir = join(tempDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, ".claude.json"),
      JSON.stringify({ hasCompletedOnboarding: true }),
    );

    const result = findExistingClaudeJson();
    expect(result).toBe(join(claudeDir, ".claude.json"));
  });

  it("should prefer .claude-home/ over .claude/", () => {
    const claudeHomeDir = join(tempDir, ".claude-home");
    const claudeDir = join(tempDir, ".claude");
    mkdirSync(claudeHomeDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeHomeDir, ".claude.json"),
      JSON.stringify({ source: "claude-home" }),
    );
    writeFileSync(
      join(claudeDir, ".claude.json"),
      JSON.stringify({ source: "claude" }),
    );

    const result = findExistingClaudeJson();
    expect(result).toBe(join(claudeHomeDir, ".claude.json"));
  });

  it("should return null when nothing exists", () => {
    const result = findExistingClaudeJson();
    expect(result).toBeNull();
  });

  it("should find ~/.claude.json (modern Claude Code 2.x canonical path)", () => {
    // Claude Code 2.x writes onboarding state to ~/.claude.json directly.
    // The ~/.claude/ directory holds credentials/projects but NOT the
    // onboarding config. Without this candidate, fresh installs fall
    // through to the "no config" warning and skip auto-onboarding.
    writeFileSync(
      join(tempDir, ".claude.json"),
      JSON.stringify({ hasCompletedOnboarding: true, source: "home" }),
    );

    const result = findExistingClaudeJson();
    expect(result).toBe(join(tempDir, ".claude.json"));
  });

  it("should prefer ~/.claude.json over legacy .claude-home/.claude.json", () => {
    // Modern path wins when both exist — upgraded installations shouldn't
    // accidentally re-read stale onboarding state from the legacy location.
    const claudeHomeDir = join(tempDir, ".claude-home");
    mkdirSync(claudeHomeDir, { recursive: true });
    writeFileSync(
      join(tempDir, ".claude.json"),
      JSON.stringify({ source: "modern" }),
    );
    writeFileSync(
      join(claudeHomeDir, ".claude.json"),
      JSON.stringify({ source: "legacy" }),
    );

    const result = findExistingClaudeJson();
    expect(result).toBe(join(tempDir, ".claude.json"));
  });
});

// ─── stripOfficialTelegramPlugin ─────────────────────────────────────────────

describe("stripOfficialTelegramPlugin", () => {
  it("removes telegram@claude-plugins-official from the plugins map", () => {
    const input = JSON.stringify(
      {
        plugins: {
          "telegram@claude-plugins-official": { enabled: true },
          "other@vendor": { enabled: true },
        },
      },
      null,
      2,
    );
    const out = stripOfficialTelegramPlugin(input);
    const parsed = JSON.parse(out);
    expect(parsed.plugins).not.toHaveProperty(
      "telegram@claude-plugins-official",
    );
    expect(parsed.plugins).toHaveProperty("other@vendor");
  });

  it("returns input unchanged when plugin entry is absent", () => {
    const input = JSON.stringify({ plugins: { "other@vendor": {} } }, null, 2);
    expect(stripOfficialTelegramPlugin(input)).toBe(input);
  });

  it("returns input unchanged when payload is malformed JSON", () => {
    const garbage = "{ not json ";
    expect(stripOfficialTelegramPlugin(garbage)).toBe(garbage);
  });

  it("returns input unchanged when payload has no plugins key", () => {
    const input = JSON.stringify({ other: "data" });
    expect(stripOfficialTelegramPlugin(input)).toBe(input);
  });

  it("returns input unchanged when plugins is not an object", () => {
    const input = JSON.stringify({ plugins: "not-an-object" });
    expect(stripOfficialTelegramPlugin(input)).toBe(input);
  });

  it("preserves other plugin entries unchanged", () => {
    const input = JSON.stringify(
      {
        plugins: {
          "telegram@claude-plugins-official": { bot_token: "xxx" },
          "memory@vendor": { configured: true, detail: { nested: "value" } },
        },
        version: 1,
      },
      null,
      2,
    );
    const parsed = JSON.parse(stripOfficialTelegramPlugin(input));
    expect(parsed.plugins["memory@vendor"]).toEqual({
      configured: true,
      detail: { nested: "value" },
    });
    expect(parsed.version).toBe(1);
  });
});

// ─── copyOnboardingState ─────────────────────────────────────────────────────

describe("copyOnboardingState", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "switchroom-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should copy config.json to agent .claude dir", () => {
    const sourceFile = join(tempDir, "source.json");
    writeFileSync(
      sourceFile,
      JSON.stringify({ hasCompletedOnboarding: true, numStartups: 5 }),
    );

    const agentDir = join(tempDir, "agent-test");
    mkdirSync(agentDir, { recursive: true });

    copyOnboardingState(sourceFile, agentDir);

    const destPath = join(agentDir, ".claude", ".claude.json");
    expect(existsSync(destPath)).toBe(true);

    const content = JSON.parse(readFileSync(destPath, "utf-8"));
    expect(content.hasCompletedOnboarding).toBe(true);
    expect(content.numStartups).toBe(5);
  });

  it("should not overwrite existing config.json", () => {
    const sourceFile = join(tempDir, "source.json");
    writeFileSync(sourceFile, JSON.stringify({ source: "new" }));

    const agentDir = join(tempDir, "agent-test");
    const claudeDir = join(agentDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, ".claude.json"),
      JSON.stringify({ source: "original" }),
    );

    copyOnboardingState(sourceFile, agentDir);

    const content = JSON.parse(
      readFileSync(join(claudeDir, ".claude.json"), "utf-8"),
    );
    expect(content.source).toBe("original");
  });

  it("should create .claude directory if missing", () => {
    const sourceFile = join(tempDir, "source.json");
    writeFileSync(sourceFile, JSON.stringify({ test: true }));

    const agentDir = join(tempDir, "new-agent");
    // Don't create agentDir or .claude beforehand

    copyOnboardingState(sourceFile, agentDir);

    expect(existsSync(join(agentDir, ".claude", ".claude.json"))).toBe(true);
  });
});

// ─── copyExistingCredentials ─────────────────────────────────────────────────

describe("copyExistingCredentials", () => {
  let originalHome: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tempDir = mkdtempSync(join(tmpdir(), "switchroom-test-"));
    process.env.HOME = tempDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should copy credentials from .claude-home/", () => {
    const claudeHomeDir = join(tempDir, ".claude-home");
    mkdirSync(claudeHomeDir, { recursive: true });
    writeFileSync(
      join(claudeHomeDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "test" } }),
    );

    const agentDir = join(tempDir, "agent-test");
    mkdirSync(agentDir, { recursive: true });

    const result = copyExistingCredentials(agentDir);
    expect(result).toBe(true);
    expect(
      existsSync(join(agentDir, ".claude", ".credentials.json")),
    ).toBe(true);
  });

  it("should return false when no credentials exist", () => {
    const agentDir = join(tempDir, "agent-test");
    mkdirSync(agentDir, { recursive: true });

    const result = copyExistingCredentials(agentDir);
    expect(result).toBe(false);
  });

  it("should return true if credentials already exist in agent dir", () => {
    const agentDir = join(tempDir, "agent-test");
    const claudeDir = join(agentDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, ".credentials.json"),
      JSON.stringify({ existing: true }),
    );

    const result = copyExistingCredentials(agentDir);
    expect(result).toBe(true);
  });
});

// ─── Hindsight port detection ────────────────────────────────────────────────

/**
 * Open a TCP listener on 127.0.0.1:port and return the server so the test
 * can close it. Used to simulate "port already in use".
 */
function bindPort(port: number): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.once("listening", () => resolve(server));
    server.listen(port, "127.0.0.1");
  });
}

describe("isPortFree / findFreePort", () => {
  it("returns true for a free port", async () => {
    // Use a high port unlikely to be bound
    const free = await isPortFree(45123);
    expect(free).toBe(true);
  });

  it("returns false when something is listening on the port", async () => {
    const server = await bindPort(45124);
    try {
      const free = await isPortFree(45124);
      expect(free).toBe(false);
    } finally {
      server.close();
    }
  });

  it("findFreePort skips occupied ports and returns the next free one", async () => {
    const server = await bindPort(45125);
    try {
      const port = await findFreePort(45125, 5);
      expect(port).not.toBeNull();
      expect(port).toBeGreaterThan(45125);
    } finally {
      server.close();
    }
  });

  it("findFreePort returns null when all attempts are taken", async () => {
    // Bind a contiguous range of 3 ports
    const a = await bindPort(45200);
    const b = await bindPort(45201);
    const c = await bindPort(45202);
    try {
      const port = await findFreePort(45200, 3);
      expect(port).toBeNull();
    } finally {
      a.close();
      b.close();
      c.close();
    }
  });
});

describe("pickHindsightPorts", () => {
  it("uses upstream defaults when both are free", async () => {
    // If something on the test host happens to be using 8888/9999, skip.
    const apiFree = await isPortFree(HINDSIGHT_DEFAULT_API_PORT);
    const uiFree = await isPortFree(HINDSIGHT_DEFAULT_UI_PORT);
    if (!apiFree || !uiFree) {
      // Test host has 8888/9999 occupied — skip the assertion that depends
      // on them being free, but the pickHindsightPorts call should still
      // succeed by falling back.
      const ports = await pickHindsightPorts();
      expect(ports.apiPort).toBeGreaterThanOrEqual(1024);
      expect(ports.uiPort).toBeGreaterThanOrEqual(1024);
      return;
    }

    const ports = await pickHindsightPorts();
    expect(ports.apiPort).toBe(HINDSIGHT_DEFAULT_API_PORT);
    expect(ports.uiPort).toBe(HINDSIGHT_DEFAULT_UI_PORT);
  });

  it("falls back to alternative ports when 8888 is taken", async () => {
    const apiFree = await isPortFree(HINDSIGHT_DEFAULT_API_PORT);
    if (!apiFree) {
      // Already taken on this host; the fallback path is already exercised
      // by the test above. Skip the bind step.
      const ports = await pickHindsightPorts();
      expect(ports.apiPort).not.toBe(HINDSIGHT_DEFAULT_API_PORT);
      return;
    }

    const blocker = await bindPort(HINDSIGHT_DEFAULT_API_PORT);
    try {
      const ports = await pickHindsightPorts();
      expect(ports.apiPort).not.toBe(HINDSIGHT_DEFAULT_API_PORT);
      expect(ports.apiPort).toBeGreaterThanOrEqual(18888);
    } finally {
      blocker.close();
    }
  });
});

// ─── Hindsight port-collision regression (2026-07 outage) ────────────────────
//
// The bundled Hindsight container runs `--network host` and binds
// HINDSIGHT_API_PORT directly on the host. When it defaulted to 8888 it
// collided with a foreign listener (nginx-tunnel-gateway on 127.0.0.1:8888)
// and crash-looped for ~9h while fleet memory was silently down. These pins
// guard the three invariants that fix locks in.
describe("Hindsight port-collision regression", () => {
  it("defaults the API port to 18888 (guards against silent revert to 8888)", () => {
    // The exact revert that would re-open the outage.
    expect(HINDSIGHT_DEFAULT_API_PORT).toBe(18888);
    expect(HINDSIGHT_DEFAULT_API_PORT).not.toBe(8888);
  });

  it("scaffolded memory.config.url port matches the launcher's default port", () => {
    // The url/port drift that caused the outage: agents on 18888 while the
    // container bound 8888. Both must derive from the same constant.
    expect(HINDSIGHT_DEFAULT_MCP_URL).toContain(`:${HINDSIGHT_DEFAULT_API_PORT}/`);

    // The default the scaffolder actually writes into an agent's .mcp.json
    // (no operator override) must equal that URL — same port, no drift.
    const cfg = generateHindsightMcpConfig("shared", {
      backend: "hindsight",
      config: {},
    } as never);
    // Default entry is the stdio shim — the backend URL rides its env.
    const cfgUrl = cfg.env?.HINDSIGHT_MCP_URL;
    expect(cfgUrl).toBe(HINDSIGHT_DEFAULT_MCP_URL);
    const urlPort = new URL(cfgUrl as string).port;
    expect(Number(urlPort)).toBe(HINDSIGHT_DEFAULT_API_PORT);
  });

  it("preflight reports the occupied port when a foreign listener holds it", async () => {
    // Use a high, almost-certainly-free port to simulate the foreign listener
    // (the default may already be held by a live hindsight on the test host).
    const PORT = 45211;
    if (!(await isPortFree(PORT))) return; // host busy — skip rather than flake
    const blocker = await bindPort(PORT);
    try {
      const conflict = await preflightHindsightPorts({
        apiPort: PORT,
        uiPort: HINDSIGHT_DEFAULT_UI_PORT,
      });
      expect(conflict).not.toBeNull();
      expect(conflict?.port).toBe(PORT);
    } finally {
      blocker.close();
    }
  });

  it("preflight returns null when both chosen ports are free", async () => {
    // Pick a high, almost-certainly-free pair rather than the defaults (CI
    // may already run hindsight). 45201/45202 are outside any service range.
    const a = await isPortFree(45201);
    const b = await isPortFree(45202);
    if (!a || !b) return; // host busy on these — skip rather than flake
    const conflict = await preflightHindsightPorts({ apiPort: 45201, uiPort: 45202 });
    expect(conflict).toBeNull();
  });

  it("port selection never hands an occupied port to docker run", async () => {
    // Occupy the preferred default (if it's free to occupy); the resolver must
    // return a DIFFERENT, actually-bindable port — never the occupied one
    // (the crash-loop input). If the default is ALREADY held on this host, the
    // fallback path is exercised without us binding it.
    const defaultFree = await isPortFree(HINDSIGHT_DEFAULT_API_PORT);
    const blocker = defaultFree ? await bindPort(HINDSIGHT_DEFAULT_API_PORT) : null;
    try {
      const ports = await pickHindsightPorts();
      expect(ports.apiPort).not.toBe(HINDSIGHT_DEFAULT_API_PORT);
      // The selected port must be free RIGHT NOW (what preflight verifies
      // before docker run) — never an occupied port handed to `docker run`.
      expect(await isPortFree(ports.apiPort)).toBe(true);
      const conflict = await preflightHindsightPorts(ports);
      expect(conflict).toBeNull();
    } finally {
      blocker?.close();
    }
  });

  // The `switchroom setup` Hindsight step (setup.ts) was the last uncovered
  // crash-loop path: it called `startHindsight(undefined, litellmCfg)` with no
  // ports arg, bypassing the pick+preflight guard `switchroom memory` applies,
  // so a fresh install with 18888 occupied would crash-loop. It must route the
  // launch through the SAME pick+preflight helpers.
  it("the setup memory step routes its Hindsight launch through the pick+preflight guard", () => {
    // `stepMemoryBackend` — and with it this launch — was extracted out of
    // setup.ts into src/cli/setup-memory-backend.ts. Read the file that
    // actually owns the call site, or this guard passes vacuously.
    const src = readFileSync(
      resolve(import.meta.dirname, "../src/cli/setup-memory-backend.ts"),
      "utf-8",
    );
    // Must no longer blind-launch on the default port. Whitespace-tolerant:
    // the call site may be formatted multi-line (#2578 added trailing args).
    expect(src).not.toMatch(/startHindsight\(\s*undefined/);
    // Must use the shared guard helpers (not a parallel implementation) and
    // hand the chosen ports to the launch as the first argument.
    expect(src).toContain("pickHindsightPorts");
    expect(src).toContain("preflightHindsightPorts");
    // The launch goes through an injectable seam (setup-verification review H2
    // needed a docker-free test of "started but did not stay running"), so
    // accept either name at the call site. The first argument is the
    // guard-derived ports object: `ports` straight from pick+preflight, or
    // `basePorts` — the recall-pool split's re-anchoring of that same object
    // (resolveHindsightLaunchPorts takes `reuseApiPort: ports.apiPort`), never
    // `undefined` or a raw default. Pin that the seam's DEFAULT is still the
    // real `startHindsight`.
    expect(src).toMatch(/(?:startHindsight|startContainer)\(\s*(?:ports|basePorts)\b/);
    expect(src).toMatch(/deps\.startContainer \?\? startHindsight/);
  });

  it("setup's port guard selects a free port instead of binding the occupied default", async () => {
    // Mirror the exact pick+preflight sequence setup.ts now performs, proving
    // it selects a bindable port when the default (18888) is occupied rather
    // than blindly handing 18888 to `docker run`.
    const defaultFree = await isPortFree(HINDSIGHT_DEFAULT_API_PORT);
    const blocker = defaultFree ? await bindPort(HINDSIGHT_DEFAULT_API_PORT) : null;
    try {
      let ports = await pickHindsightPorts();
      let conflict = await preflightHindsightPorts(ports);
      if (conflict) {
        ports = await pickHindsightPorts();
        conflict = await preflightHindsightPorts(ports);
      }
      expect(conflict).toBeNull();
      expect(ports.apiPort).not.toBe(HINDSIGHT_DEFAULT_API_PORT);
      expect(await isPortFree(ports.apiPort)).toBe(true);
    } finally {
      blocker?.close();
    }
  });
});

// ─── resolveOrPromptToken precedence (install-validation #31) ────────────────
//
// Regression pins for the bug a multi-bot fleet hit in Phase 4 of the
// install-validation goal-loop: per-agent `vault:` refs were silently
// overridden by a global TELEGRAM_BOT_TOKEN env var, so every agent
// ended up polling the same bot and Telegram returned 409 conflicts.
//
// Precedence (after #1256):
//   1. Agent-scoped env var: TELEGRAM_BOT_TOKEN_<LABEL>
//   2. Vault ref (`vault:<key>` resolves via SWITCHROOM_VAULT_PASSPHRASE)
//   3. Literal config value
//   4. Global TELEGRAM_BOT_TOKEN env var
//   5. Interactive prompt (only when stdin is a TTY)

describe("resolveOrPromptToken precedence", () => {
  // Save + restore env so tests don't leak into each other.
  const envKeys = [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_BOT_TOKEN_ADMIN",
    "TELEGRAM_BOT_TOKEN_AGENT",
    "SWITCHROOM_VAULT_PASSPHRASE",
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of envKeys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function makeConfig(vaultPath?: string): SwitchroomConfig {
    return {
      switchroom: { version: 1 },
      telegram: { bot_token: "", forum_chat_id: "0" },
      agents: {},
      vault: vaultPath ? { path: vaultPath } : undefined,
      defaults: {},
      memory: { backend: "none" },
    } as unknown as SwitchroomConfig;
  }

  it("(1) agent-scoped env var TELEGRAM_BOT_TOKEN_<LABEL> wins over everything", async () => {
    process.env.TELEGRAM_BOT_TOKEN_ADMIN = "from-agent-env";
    process.env.TELEGRAM_BOT_TOKEN = "from-global-env";
    const token = await resolveOrPromptToken(
      "literal-in-config",
      "admin",
      makeConfig(),
      true,
    );
    expect(token).toBe("from-agent-env");
  });

  it("(2) vault: ref beats global TELEGRAM_BOT_TOKEN env var (the #31 regression pin)", async () => {
    // Create an empty vault file so existsSync passes; openVault is mocked
    // at the module level (top of this file) and returns the secret shape
    // resolveOrPromptToken expects.
    const tmp = mkdtempSync(join(tmpdir(), "switchroom-resolve-token-vault-"));
    const vaultPath = join(tmp, "vault.enc");
    try {
      writeFileSync(vaultPath, "stub vault placeholder");
      vi.mocked(vaultMod.openVault).mockReturnValueOnce({
        "telegram-admin-bot-token": { kind: "string", value: "from-vault" },
      } as unknown as ReturnType<typeof vaultMod.openVault>);
      process.env.SWITCHROOM_VAULT_PASSPHRASE = "test-passphrase";
      process.env.TELEGRAM_BOT_TOKEN = "from-global-env";
      const token = await resolveOrPromptToken(
        "vault:telegram-admin-bot-token",
        "admin",
        makeConfig(vaultPath),
        true,
      );
      expect(token).toBe("from-vault");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("(3) literal non-empty config value beats global env (config-as-source-of-truth)", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "from-global-env";
    const token = await resolveOrPromptToken(
      "literal-from-config",
      "admin",
      makeConfig(),
      true,
    );
    expect(token).toBe("literal-from-config");
  });

  it("(4) empty literal config falls through to global TELEGRAM_BOT_TOKEN", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "from-global-env";
    const token = await resolveOrPromptToken("", "admin", makeConfig(), true);
    expect(token).toBe("from-global-env");
  });

  it("(5) non-interactive with nothing set throws and names all three keys", async () => {
    await expect(
      resolveOrPromptToken("", "admin", makeConfig(), true),
    ).rejects.toThrow(/TELEGRAM_BOT_TOKEN_ADMIN.*TELEGRAM_BOT_TOKEN.*vault/s);
  });
});
