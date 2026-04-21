import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseEnvFile,
  telegramGetMe,
  checkTelegram,
  parsePythonVersion,
  parseNodeVersion,
  findChromium,
  checkDepsCacheWritable,
  checkSkillsPrerequisites,
  checkConfig,
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

describe("parsePythonVersion", () => {
  it("parses full Python 3.x.y version strings", () => {
    expect(parsePythonVersion("Python 3.12.3")).toEqual({
      major: 3,
      minor: 12,
      patch: 3,
    });
    expect(parsePythonVersion("Python 3.11.9")).toEqual({
      major: 3,
      minor: 11,
      patch: 9,
    });
  });

  it("accepts major.minor without patch", () => {
    expect(parsePythonVersion("Python 3.10")).toEqual({
      major: 3,
      minor: 10,
      patch: 0,
    });
  });

  it("handles trailing text like build suffixes", () => {
    expect(parsePythonVersion("Python 3.12.3+ (main, Jan  1 2026)")).toEqual({
      major: 3,
      minor: 12,
      patch: 3,
    });
  });

  it("returns null on unrecognized input", () => {
    expect(parsePythonVersion("bash: python3: command not found")).toBeNull();
    expect(parsePythonVersion("")).toBeNull();
    expect(parsePythonVersion("Python")).toBeNull();
  });
});

describe("parseNodeVersion", () => {
  it("parses `vX.Y.Z` output", () => {
    expect(parseNodeVersion("v22.22.2")).toEqual({
      major: 22,
      minor: 22,
      patch: 2,
    });
    expect(parseNodeVersion("v18.0.0")).toEqual({
      major: 18,
      minor: 0,
      patch: 0,
    });
  });

  it("tolerates trailing whitespace", () => {
    expect(parseNodeVersion("v20.10.0\n")).toEqual({
      major: 20,
      minor: 10,
      patch: 0,
    });
  });

  it("returns null on unrecognized input", () => {
    expect(parseNodeVersion("")).toBeNull();
    expect(parseNodeVersion("20.10.0")).toBeNull(); // missing leading v
    expect(parseNodeVersion("node: not found")).toBeNull();
  });
});

describe("findChromium", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = resolve(tmpdir(), `switchroom-doctor-chrome-${Date.now()}`);
    mkdirSync(tempHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("returns null when nothing is installed under the Playwright cache", () => {
    // Fresh empty HOME means no ~/.cache/ms-playwright. The PATH-based
    // lookups may still succeed on a dev host, so we only assert on
    // the non-null branch returning something sensible.
    const result = findChromium(tempHome);
    if (result === null) {
      expect(result).toBeNull();
    } else {
      expect(result).toContain("chrom");
    }
  });

  it("finds a chromium binary inside the Playwright cache layout", () => {
    const browserDir = join(
      tempHome,
      ".cache",
      "ms-playwright",
      "chromium-1134",
      "chrome-linux",
    );
    mkdirSync(browserDir, { recursive: true });
    const chromePath = join(browserDir, "chrome");
    writeFileSync(chromePath, "#!/bin/sh\nexit 0\n");
    chmodSync(chromePath, 0o755);

    // Temporarily scrub PATH so we only test the cache fallback.
    const origPath = process.env.PATH;
    process.env.PATH = "";
    try {
      expect(findChromium(tempHome)).toBe(chromePath);
    } finally {
      process.env.PATH = origPath;
    }
  });
});

describe("checkDepsCacheWritable", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `switchroom-doctor-deps-${Date.now()}`);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports ok and creates the deps root when missing", () => {
    const depsRoot = join(tempDir, "deps");
    const result = checkDepsCacheWritable(depsRoot);
    expect(result.status).toBe("ok");
    expect(result.detail).toBe(depsRoot);
  });

  it("reports ok when the deps root already exists", () => {
    const depsRoot = join(tempDir, "deps");
    mkdirSync(depsRoot, { recursive: true });
    const result = checkDepsCacheWritable(depsRoot);
    expect(result.status).toBe("ok");
  });

  it("reports fail when the target is under a non-directory", () => {
    // /dev/null is a character device, not a directory, so mkdir under
    // it fails with ENOTDIR immediately — portable across Linux distros
    // without needing root-owned test fixtures.
    const result = checkDepsCacheWritable("/dev/null/switchroom-deps-should-fail");
    expect(result.status).toBe("fail");
    expect(result.fix).toBeDefined();
  });
});

describe("checkSkillsPrerequisites", () => {
  it("returns one result per prerequisite in a stable order", () => {
    const results = checkSkillsPrerequisites();
    const names = results.map((r) => r.name);
    expect(names).toEqual([
      "Python 3.11+",
      "Node 18+",
      "Chromium",
      "~/.switchroom/deps writable",
    ]);
  });

  it("each result has a valid status glyph class", () => {
    const results = checkSkillsPrerequisites();
    for (const r of results) {
      expect(["ok", "warn", "fail"]).toContain(r.status);
    }
  });
});

describe("checkConfig — default subagents check", () => {
  function makeMinimalConfig(subagents?: Record<string, unknown>): SwitchroomConfig {
    const cfg: Record<string, unknown> = {
      switchroom: { version: 1 },
      telegram: { bot_token: "x", forum_chat_id: "-100" },
      agents: { assistant: {} },
    };
    if (subagents !== undefined) {
      cfg.defaults = { subagents };
    }
    return cfg as unknown as SwitchroomConfig;
  }

  it("reports ok when worker, researcher, and reviewer are all present", () => {
    const config = makeMinimalConfig({
      worker: { description: "w", model: "sonnet", prompt: "x" },
      researcher: { description: "r", model: "haiku", prompt: "x" },
      reviewer: { description: "rv", model: "sonnet", prompt: "x" },
    });
    const results = checkConfig(config, "/fake/switchroom.yaml");
    const check = results.find((r) => r.name === "default subagents configured");
    expect(check).toBeDefined();
    expect(check!.status).toBe("ok");
    expect(check!.detail).toContain("worker");
    expect(check!.detail).toContain("researcher");
    expect(check!.detail).toContain("reviewer");
    expect(check!.fix).toBeUndefined();
  });

  it("reports ok when at least one known subagent is present", () => {
    const config = makeMinimalConfig({
      worker: { description: "w", model: "sonnet", prompt: "x" },
    });
    const results = checkConfig(config, "/fake/switchroom.yaml");
    const check = results.find((r) => r.name === "default subagents configured");
    expect(check).toBeDefined();
    expect(check!.status).toBe("ok");
    expect(check!.detail).toBe("worker");
  });

  it("reports warn when defaults.subagents is absent", () => {
    const config = makeMinimalConfig(undefined);
    const results = checkConfig(config, "/fake/switchroom.yaml");
    const check = results.find((r) => r.name === "default subagents configured");
    expect(check).toBeDefined();
    expect(check!.status).toBe("warn");
    expect(check!.detail).toContain("no default subagents");
    expect(check!.fix).toContain("docs/sub-agents.md");
  });
});
