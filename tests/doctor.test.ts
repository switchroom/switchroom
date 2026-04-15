import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseEnvFile,
  telegramGetMe,
  checkTelegram,
} from "../src/cli/doctor.js";
import { findConfigFile } from "../src/config/loader.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

describe("parseEnvFile", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `switchroom-doctor-env-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("parses simple KEY=VALUE pairs", () => {
    const path = join(tempDir, ".env");
    writeFileSync(path, "FOO=bar\nBAZ=qux\n");
    const env = parseEnvFile(path);
    expect(env.FOO).toBe("bar");
    expect(env.BAZ).toBe("qux");
  });

  it("strips double and single quotes", () => {
    const path = join(tempDir, ".env");
    writeFileSync(path, `TOKEN="123:ABC"\nOTHER='hello world'\n`);
    const env = parseEnvFile(path);
    expect(env.TOKEN).toBe("123:ABC");
    expect(env.OTHER).toBe("hello world");
  });

  it("ignores comments and blank lines", () => {
    const path = join(tempDir, ".env");
    writeFileSync(path, `# header\n\nFOO=bar\n# trailing\n`);
    const env = parseEnvFile(path);
    expect(env.FOO).toBe("bar");
    expect(Object.keys(env)).toHaveLength(1);
  });

  it("returns empty object when file is missing", () => {
    const env = parseEnvFile(join(tempDir, "nope.env"));
    expect(env).toEqual({});
  });
});

describe("findConfigFile search order", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origCwd: string;
  let origEnvConfig: string | undefined;

  beforeEach(() => {
    tempHome = resolve(tmpdir(), `switchroom-loader-test-${Date.now()}`);
    mkdirSync(join(tempHome, ".switchroom"), { recursive: true });
    origHome = process.env.HOME;
    origEnvConfig = process.env.SWITCHROOM_CONFIG;
    origCwd = process.cwd();
    process.env.HOME = tempHome;
    delete process.env.SWITCHROOM_CONFIG;
  });

  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origEnvConfig !== undefined) process.env.SWITCHROOM_CONFIG = origEnvConfig;
    else delete process.env.SWITCHROOM_CONFIG;
    process.chdir(origCwd);
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("resolves ~/.switchroom/switchroom.yaml when nothing is in cwd", () => {
    const home = tempHome;
    const target = join(home, ".switchroom", "switchroom.yaml");
    writeFileSync(target, "switchroom: { version: 1 }\n");

    // cwd without any config file
    const cwdDir = join(home, "workdir");
    mkdirSync(cwdDir, { recursive: true });
    process.chdir(cwdDir);

    const found = findConfigFile();
    expect(found).toBe(target);
  });

  it("honours $SWITCHROOM_CONFIG over everything else", () => {
    const override = join(tempHome, "explicit.yaml");
    writeFileSync(override, "switchroom: { version: 1 }\n");
    // Also put a valid config at the user-wide path to prove precedence.
    writeFileSync(
      join(tempHome, ".switchroom", "switchroom.yaml"),
      "switchroom: { version: 1 }\n",
    );
    process.env.SWITCHROOM_CONFIG = override;
    const cwdDir = join(tempHome, "workdir");
    mkdirSync(cwdDir, { recursive: true });
    process.chdir(cwdDir);

    const found = findConfigFile();
    expect(found).toBe(override);
  });

  it("includes ~/.switchroom/switchroom.yaml in searched paths when no config exists", () => {
    const cwdDir = join(tempHome, "workdir");
    mkdirSync(cwdDir, { recursive: true });
    process.chdir(cwdDir);

    try {
      findConfigFile();
      expect.fail("expected ConfigError");
    } catch (err) {
      const details = (err as { details?: string[] }).details ?? [];
      expect(
        details.some((d) => d.includes(join(tempHome, ".switchroom", "switchroom.yaml"))),
      ).toBe(true);
    }
  });
});

describe("telegramGetMe", () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it("returns ok + username on success", async () => {
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({ ok: true, result: { username: "switchroom_bot" } }),
      status: 200,
    })) as typeof fetch;

    const result = await telegramGetMe("123:ABC", 500);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.username).toBe("switchroom_bot");
  });

  it("returns error when Telegram returns ok:false", async () => {
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({ ok: false, description: "Unauthorized" }),
      status: 401,
    })) as typeof fetch;

    const result = await telegramGetMe("bad-token", 500);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Unauthorized");
  });

  it("returns timeout error when fetch aborts", async () => {
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as typeof fetch;

    const result = await telegramGetMe("123:ABC", 50);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("timeout");
  });
});

describe("checkTelegram", () => {
  let tempDir: string;
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `switchroom-doctor-tg-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeAgentEnv(name: string, token: string | null) {
    const envDir = join(tempDir, name, "telegram");
    mkdirSync(envDir, { recursive: true });
    if (token !== null) {
      writeFileSync(join(envDir, ".env"), `TELEGRAM_BOT_TOKEN=${token}\n`);
    }
  }

  function makeConfig(agents: Record<string, { plugin?: string }>): SwitchroomConfig {
    const obj: Record<string, unknown> = {
      switchroom: { version: 1, agents_dir: tempDir },
      telegram: { bot_token: "x", forum_chat_id: "-100" },
      agents: {} as Record<string, unknown>,
    };
    for (const [name, cfg] of Object.entries(agents)) {
      (obj.agents as Record<string, unknown>)[name] = {
        channels: cfg.plugin ? { telegram: { plugin: cfg.plugin } } : undefined,
      };
    }
    return obj as unknown as SwitchroomConfig;
  }

  it("reports ok when bot token resolves via getMe", async () => {
    writeAgentEnv("assistant", "123:ABC");
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({ ok: true, result: { username: "switchroom_bot" } }),
      status: 200,
    })) as typeof fetch;

    const results = await checkTelegram(
      makeConfig({ assistant: { plugin: "switchroom" } }),
    );
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("ok");
    expect(results[0].detail).toBe("@switchroom_bot");
  });

  it("reports fail when .env is missing TELEGRAM_BOT_TOKEN", async () => {
    writeAgentEnv("assistant", null);
    const results = await checkTelegram(
      makeConfig({ assistant: { plugin: "switchroom" } }),
    );
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("fail");
    expect(results[0].detail).toContain("TELEGRAM_BOT_TOKEN missing");
  });

  it("skips agents that do not use the switchroom telegram plugin", async () => {
    writeAgentEnv("other", "999:XYZ");
    const results = await checkTelegram(
      makeConfig({ other: { plugin: "none" } }),
    );
    expect(results).toHaveLength(0);
  });

  it("dedupes tokens across multiple agents sharing one bot", async () => {
    writeAgentEnv("agent-a", "123:ABC");
    writeAgentEnv("agent-b", "123:ABC");
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ ok: true, result: { username: "switchroom_bot" } }),
      status: 200,
    })) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    const results = await checkTelegram(
      makeConfig({
        "agent-a": { plugin: "switchroom" },
        "agent-b": { plugin: "switchroom" },
      }),
    );
    expect(results).toHaveLength(1);
    expect(results[0].name).toContain("agent-a");
    expect(results[0].name).toContain("agent-b");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
