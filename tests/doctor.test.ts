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
  checkStartShStale,
  checkStartShSessionModelCarrier,
} from "../src/cli/doctor.js";
import { findConfigFile } from "../src/config/loader.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

describe("classifyReadError + tryReadHostFile", () => {
  let tempDir: string;
  beforeEach(() => {
    tempDir = resolve(tmpdir(), `switchroom-doctor-readerr-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });
  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  it("classifies ENOENT correctly", async () => {
    const { classifyReadError } = await import("../src/cli/doctor.js");
    expect(classifyReadError({ code: "ENOENT" } as NodeJS.ErrnoException)).toBe("enoent");
  });

  it("classifies EACCES and EPERM as eacces", async () => {
    const { classifyReadError } = await import("../src/cli/doctor.js");
    expect(classifyReadError({ code: "EACCES" } as NodeJS.ErrnoException)).toBe("eacces");
    expect(classifyReadError({ code: "EPERM" } as NodeJS.ErrnoException)).toBe("eacces");
  });

  it("classifies unknown codes as other", async () => {
    const { classifyReadError } = await import("../src/cli/doctor.js");
    expect(classifyReadError({ code: "EBUSY" } as NodeJS.ErrnoException)).toBe("other");
    expect(classifyReadError(new Error("totally generic"))).toBe("other");
  });

  it("tryReadHostFile returns ok with content when readable", async () => {
    const { tryReadHostFile } = await import("../src/cli/doctor.js");
    const path = join(tempDir, "ok.txt");
    writeFileSync(path, "hello\n");
    const result = tryReadHostFile(path);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.content).toBe("hello\n");
  });

  it("tryReadHostFile returns enoent when file is missing", async () => {
    const { tryReadHostFile } = await import("../src/cli/doctor.js");
    const result = tryReadHostFile(join(tempDir, "nope.txt"));
    expect(result.kind).toBe("enoent");
  });

  it.skipIf(process.getuid?.() === 0)(
    "tryReadHostFile returns eacces when file exists but is unreadable",
    async () => {
      // Root reads through chmod 0o000, so this branch is unreachable
      // when the test process is uid=0 (hosted Buildkite agents run as
      // root). The EACCES classification itself is covered by the
      // pure-function test above.
      const { tryReadHostFile } = await import("../src/cli/doctor.js");
      const path = join(tempDir, "secret.txt");
      writeFileSync(path, "x");
      chmodSync(path, 0o000);
      try {
        const result = tryReadHostFile(path);
        expect(result.kind).toBe("eacces");
        if (result.kind === "eacces") expect(result.error).toMatch(/EACCES|permission/i);
      } finally {
        chmodSync(path, 0o600);
      }
    },
  );
});

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

  it.skipIf(process.getuid?.() === 0)(
    "reports skip (not warn/fail) when .env exists but is unreadable from host UID (EACCES)",
    async () => {
    // Per-agent state files are mode 0600 owned by the agent UID
    // (compose.ts allocates 10001-10999); when `switchroom doctor`
    // runs as the host operator, open(2) fails with EACCES even
    // though the agent itself reads the file fine. Pre-fix this
    // produced a false "TELEGRAM_BOT_TOKEN missing" fail per agent
    // — the 2026-05-10 post-deploy doctor false-positive.
    //
    // Simulate by writing the file with mode 0000 (so existsSync
    // still returns true but readFileSync throws EACCES).
    // Skipped when running as root (uid=0) — chmod 0o000 doesn't
    // block root reads, so the EACCES branch is unreachable.
    // Hosted Buildkite agents run as root; this test is exercised
    // locally and in any non-root CI environment.
    writeAgentEnv("assistant", "123:ABC");
    const envPath = join(tempDir, "assistant", "telegram", ".env");
    chmodSync(envPath, 0o000);
    try {
      const results = await checkTelegram(
        makeConfig({ assistant: { plugin: "switchroom" } }),
      );
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("skip");
      expect(results[0].detail).toContain("unreadable from host");
      expect(results[0].detail).toContain("agent reads it fine");
      // Crucially: the row must NOT claim TELEGRAM_BOT_TOKEN is "missing".
      expect(results[0].detail).not.toContain("missing");
    } finally {
      // Restore so afterEach's rmSync can clean up.
      chmodSync(envPath, 0o600);
    }
    },
  );

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
      expect(findChromium(tempHome, "")).toBe(chromePath);
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("honors PLAYWRIGHT_BROWSERS_PATH for v0.7.13+ baked layout (closes #960)", () => {
    // v0.7.13 baked Playwright + chromium into the agent image with
    // browsers at /opt/playwright/browsers/. Pre-fix the doctor probe
    // only checked ~/.cache/ms-playwright/ which is empty in the
    // baked-image case, producing 'chromium: not found' noise on
    // every doctor run inside an agent. The fix consults
    // PLAYWRIGHT_BROWSERS_PATH first, then falls back to ~/.cache/.
    const bakedDir = join(tempHome, "opt", "playwright", "browsers");
    const browserDir = join(bakedDir, "chromium-1217", "chrome-linux64");
    mkdirSync(browserDir, { recursive: true });
    const chromePath = join(browserDir, "chrome");
    writeFileSync(chromePath, "#!/bin/sh\nexit 0\n");
    chmodSync(chromePath, 0o755);

    const origPath = process.env.PATH;
    process.env.PATH = "";
    try {
      // Pass the env value directly so the test doesn't depend on
      // the host's actual PLAYWRIGHT_BROWSERS_PATH.
      expect(findChromium(tempHome, bakedDir)).toBe(chromePath);
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("PLAYWRIGHT_BROWSERS_PATH wins over ~/.cache/ms-playwright when both exist", () => {
    // Edge case: operator upgrades to v0.7.13 on a host that has the
    // legacy on-demand cache from earlier. Both paths exist; baked
    // path takes priority because that's what the running browser is.
    const bakedDir = join(tempHome, "opt", "playwright", "browsers");
    const bakedBin = join(
      bakedDir, "chromium-1217", "chrome-linux64", "chrome",
    );
    mkdirSync(join(bakedDir, "chromium-1217", "chrome-linux64"), { recursive: true });
    writeFileSync(bakedBin, "#!/bin/sh\nexit 0\n");
    chmodSync(bakedBin, 0o755);

    const legacyDir = join(tempHome, ".cache", "ms-playwright");
    const legacyBin = join(
      legacyDir, "chromium-1134", "chrome-linux", "chrome",
    );
    mkdirSync(join(legacyDir, "chromium-1134", "chrome-linux"), { recursive: true });
    writeFileSync(legacyBin, "#!/bin/sh\nexit 0\n");
    chmodSync(legacyBin, 0o755);

    const origPath = process.env.PATH;
    process.env.PATH = "";
    try {
      expect(findChromium(tempHome, bakedDir)).toBe(bakedBin);
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("falls back to the image-baked /opt layout when env + HOME caches are empty (#playwright-skew)", () => {
    // Since #playwright-skew the runtime PLAYWRIGHT_BROWSERS_PATH points
    // at the per-agent HOME cache, not the /opt bake — doctor must still
    // find the baked chromium directly (e.g. before start.sh's boot
    // seeding has linked it into the HOME cache).
    const bakedDir = join(tempHome, "opt", "playwright", "browsers");
    const browserDir = join(bakedDir, "chromium-1228", "chrome-linux64");
    mkdirSync(browserDir, { recursive: true });
    const chromePath = join(browserDir, "chrome");
    writeFileSync(chromePath, "#!/bin/sh\nexit 0\n");
    chmodSync(chromePath, 0o755);

    const origPath = process.env.PATH;
    process.env.PATH = "";
    try {
      // env empty ("" — not undefined, which would fall back to the
      // HOST's real PLAYWRIGHT_BROWSERS_PATH when the suite runs inside
      // an agent container) + empty HOME cache → only the baked-path
      // fallback hits.
      expect(findChromium(tempHome, "", bakedDir)).toBe(chromePath);
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("finds chromium_headless_shell binaries (Playwright >=1.40 layout)", () => {
    // Playwright 1.40+ ships a separate `chromium_headless_shell-*`
    // browser whose binary is `headless_shell`, not `chrome`. v0.7.13's
    // bake includes this directory.
    const bakedDir = join(tempHome, "opt", "playwright", "browsers");
    const shellDir = join(bakedDir, "chromium_headless_shell-1217", "chrome-linux64");
    mkdirSync(shellDir, { recursive: true });
    const shellBin = join(shellDir, "headless_shell");
    writeFileSync(shellBin, "#!/bin/sh\nexit 0\n");
    chmodSync(shellBin, 0o755);

    const origPath = process.env.PATH;
    process.env.PATH = "";
    try {
      expect(findChromium(tempHome, bakedDir)).toBe(shellBin);
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

// The #1978 merge-400 was an upstream claude-CLI streaming-merge bug, fixed in
// claude-code 2.1.156 (pinned by switchroom v0.14.8; docker/Dockerfile.base now
// pins 2.1.219). The guard's scope is legacy pinned Opus 4.x only, so a modern
// Opus 5 / `opus`-alias fleet at medium effort must NOT produce an operator warn.
describe("checkConfig — thinking_effort × adaptive model", () => {
  const CHECK = "thinking_effort × adaptive model";

  function makeConfig(
    defaults: Record<string, unknown>,
    agents: Record<string, unknown>,
  ): SwitchroomConfig {
    return {
      switchroom: { version: 1 },
      telegram: { bot_token: "x", forum_chat_id: "-100" },
      defaults,
      agents,
    } as unknown as SwitchroomConfig;
  }

  it("reports ok for the `opus` alias fleet at medium effort", () => {
    const config = makeConfig(
      { model: "opus", thinking_effort: "medium" },
      { assistant: {}, sysadmin: {} },
    );
    const check = checkConfig(config, "/fake/switchroom.yaml").find(
      (r) => r.name === CHECK,
    );
    expect(check).toBeDefined();
    expect(check!.status).toBe("ok");
    expect(check!.detail).toBe("no risky model/effort combos");
    expect(check!.fix).toBeUndefined();
  });

  it("reports ok for a pinned claude-opus-5 agent overriding to medium", () => {
    const config = makeConfig(
      { model: "opus", thinking_effort: "low" },
      { assistant: {}, sysadmin: { model: "claude-opus-5", thinking_effort: "medium" } },
    );
    const check = checkConfig(config, "/fake/switchroom.yaml").find(
      (r) => r.name === CHECK,
    );
    expect(check!.status).toBe("ok");
  });

  it("still warns for a pinned Opus 4.x agent above the low floor", () => {
    const config = makeConfig(
      { model: "opus", thinking_effort: "low" },
      { assistant: {}, legacy: { model: "claude-opus-4-8", thinking_effort: "high" } },
    );
    const check = checkConfig(config, "/fake/switchroom.yaml").find(
      (r) => r.name === CHECK,
    );
    expect(check!.status).toBe("warn");
    // Pin the full operator-facing string, not a substring: this is what the
    // operator reads at `doctor`/`apply` time, and it must not drift from the
    // Opus 4.x-only scope documented in docs/configuration.md and CLAUDE.md.
    // Naming only `legacy` also proves the `assistant` agent (on the `opus`
    // alias at the inherited `low`) is not swept in.
    expect(check!.detail).toBe(
      "1 agent(s) on pinned Opus 4.x with thinking_effort > low: legacy",
    );
    // The fix text is the operator's next step; assert the load-bearing parts
    // (scope + the CLI build that fixed #1978) so a reword can't quietly
    // reintroduce blanket "pin low on Opus" advice.
    expect(check!.fix).toContain("pinned Opus 4.x");
    expect(check!.fix).toContain("2.1.156");
  });
});

describe("checkStartShStale", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `switchroom-doctor-startsh-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("warns when start.sh is missing entirely", () => {
    const result = checkStartShStale("clerk", join(tempDir, "missing.sh"));
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("not found");
    expect(result.fix).toContain("switchroom apply");
  });

  it("fails when start.sh lacks the agent-scheduler supervisor block (#909)", () => {
    // Hand-craft a pre-Phase-4 start.sh: gateway + autoaccept supervisors
    // only, no agent-scheduler reference.
    const startShPath = join(tempDir, "start.sh");
    writeFileSync(
      startShPath,
      [
        "#!/usr/bin/env bash",
        "_switchroom_supervise gateway /var/log/switchroom/gateway.log bun gateway.js &",
        "_switchroom_supervise autoaccept /var/log/switchroom/autoaccept.log bun autoaccept-poll.js &",
        "exec tmux new-session -A -s clerk bash -l \"$0\"",
      ].join("\n"),
    );
    const result = checkStartShStale("clerk", startShPath);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("agent-scheduler");
    expect(result.fix).toContain("switchroom apply");
    expect(result.fix).toContain("docker compose");
  });

  it("fails when start.sh only mentions agent-scheduler in a comment (false-positive guard)", () => {
    // Catches the loose-grep regression: a stale start.sh that
    // happens to mention the token in a TODO/comment must still
    // be diagnosed as broken — the supervisor invocation is what
    // actually keeps cron alive.
    const startShPath = join(tempDir, "start.sh");
    writeFileSync(
      startShPath,
      [
        "#!/usr/bin/env bash",
        "# TODO: wire agent-scheduler post-upgrade",
        "_switchroom_supervise gateway /var/log/switchroom/gateway.log bun gateway.js &",
      ].join("\n"),
    );
    const result = checkStartShStale("clerk", startShPath);
    expect(result.status).toBe("fail");
  });

  it("reports ok when the supervisor block is present", () => {
    const startShPath = join(tempDir, "start.sh");
    writeFileSync(
      startShPath,
      [
        "#!/usr/bin/env bash",
        "_switchroom_supervise agent-scheduler /var/log/switchroom/agent-scheduler.log \\",
        "  bun /opt/switchroom/agent-scheduler/index.js &",
      ].join("\n"),
    );
    const result = checkStartShStale("clerk", startShPath);
    expect(result.status).toBe("ok");
  });
});

describe("checkStartShSessionModelCarrier", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `switchroom-doctor-sm-carrier-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("warns when start.sh is missing entirely", () => {
    const result = checkStartShSessionModelCarrier(
      "klanker",
      join(tempDir, "missing.sh"),
    );
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("not found");
    expect(result.fix).toContain("switchroom apply");
  });

  it("fails legacy-only .session-model-override primary (live pre-rev5 start.sh)", () => {
    // Mirrors the live stale klanker start.sh signature:_header comments
    // the override carrier, file-tests ONLY `.session-model-override`, never
    // has a bare `.session-model` apply path or JSON shape.
    const startShPath = join(tempDir, "start.sh");
    writeFileSync(
      startShPath,
      [
        "#!/usr/bin/env bash",
        "# --- Session-only model override (carrier: .session-model-override) ---",
        'if [ -f "/home/x/.switchroom/agents/klanker/.session-model-override" ]; then',
        '  _override="$(tr -d \'[:space:]\' < "/home/x/.switchroom/agents/klanker/.session-model-override" 2>/dev/null || true)"',
        '  rm -f "/home/x/.switchroom/agents/klanker/.session-model-override"',
        '  echo "session-model: applied override $_override" >&2',
        "fi",
        // Comments that merely mention the rev5 name must not pass:
        "# note: someday migrate to .session-model JSON",
      ].join("\n"),
    );
    const result = checkStartShSessionModelCarrier("klanker", startShPath);
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/legacy|\.session-model-override|yaml pin/i);
    expect(result.fix).toContain("switchroom apply");
    expect(result.fix).toMatch(/rev5|\.session-model/);
  });

  it("fails when a comment mentions .session-model but there is no file-test (false-positive guard)", () => {
    const startShPath = join(tempDir, "start.sh");
    writeFileSync(
      startShPath,
      [
        "#!/usr/bin/env bash",
        "# TODO: honor .session-model carrier from gateway",
        'echo "session-model: nothing wired" >&2',
      ].join("\n"),
    );
    const result = checkStartShSessionModelCarrier("clerk", startShPath);
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/missing rev5|\.session-model/);
  });

  it("fails file-test of sibling paths only (.session-model-alert / boot-attempts / override)", () => {
    const startShPath = join(tempDir, "start.sh");
    writeFileSync(
      startShPath,
      [
        "#!/usr/bin/env bash",
        'if [ -f "/a/.session-model-alert" ]; then cat "/a/.session-model-alert"; fi',
        'if [ -f "/a/.session-model-boot-attempts" ]; then cat "/a/.session-model-boot-attempts"; fi',
        'if [ -f "/a/.session-model-override" ]; then cat "/a/.session-model-override"; fi',
        // Looking like JSON apply without the bare carrier path must still fail.
        'echo configuredDefaultAtWrite',
      ].join("\n"),
    );
    const result = checkStartShSessionModelCarrier("clerk", startShPath);
    expect(result.status).toBe("fail");
  });

  it("fails bare .session-model file-test without rev5 JSON apply markers", () => {
    const startShPath = join(tempDir, "start.sh");
    writeFileSync(
      startShPath,
      [
        "#!/usr/bin/env bash",
        'if [ -f "/a/.session-model" ]; then',
        '  cat "/a/.session-model"',
        "fi",
      ].join("\n"),
    );
    const result = checkStartShSessionModelCarrier("clerk", startShPath);
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/JSON|configuredDefaultAtWrite|boot-attempts/);
  });

  it("ok for rev5 hbs shape: bare .session-model test + JSON apply + legacy migration shim", () => {
    const startShPath = join(tempDir, "start.sh");
    // Minimal reduction of profiles/_base/start.sh.hbs rev5 block.
    writeFileSync(
      startShPath,
      [
        "#!/usr/bin/env bash",
        "# --- Session model resolution (consume-once .session-model carrier) ---",
        // Migration shim (reads override, WRITES .session-model) — OK.
        'if [ -f "/a/.session-model-override" ]; then',
        '  _mig="$(tr -d \'[:space:]\' < "/a/.session-model-override" 2>/dev/null || true)"',
        '  rm -f "/a/.session-model-override"',
        '  printf \'{"model":"%s","configuredDefaultAtWrite":"%s","ts":1}\\n\' "$_mig" "opus" > "/a/.session-model"',
        "fi",
        'if [ -f "/a/.session-model" ]; then',
        '  _smf="$(cat "/a/.session-model" 2>/dev/null || true)"',
        '  _sm_model="$(printf \'%s\' "$_smf" | sed -n \'s/.*"model":"\\([^"]*\\)".*/\\1/p\')"',
        '  _sm_cfg="$(printf \'%s\' "$_smf" | sed -n \'s/.*"configuredDefaultAtWrite":"\\([^"]*\\)".*/\\1/p\')"',
        '  _sm_attempts="$(cat "/a/.session-model-boot-attempts" 2>/dev/null | tr -dc \'0-9\' || true)"',
        '  echo "session-model: applying $_sm_model (cfg=$_sm_cfg)" >&2',
        "fi",
      ].join("\n"),
    );
    const result = checkStartShSessionModelCarrier("clerk", startShPath);
    expect(result.status).toBe("ok");
    expect(result.detail).toMatch(/rev5|\.session-model/);
  });
});


describe("checkStartShSessionModelCarrier (rev5 /model)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `switchroom-doctor-smcarrier-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("warns when start.sh is missing", () => {
    const result = checkStartShSessionModelCarrier(
      "klanker",
      join(tempDir, "missing.sh"),
    );
    expect(result.status).toBe("warn");
    expect(result.fix).toMatch(/switchroom apply/);
  });

  it("fails legacy-only .session-model-override start.sh (live pre-rev5 shape)", () => {
    // Mirrors live klanker start.sh before apply — silent /model miss class.
    const startShPath = join(tempDir, "start.sh");
    writeFileSync(
      startShPath,
      [
        "#!/usr/bin/env bash",
        "# --- Session-only model override (carrier: .session-model-override) ---",
        'if [ -f "/home/x/.switchroom/agents/klanker/.session-model-override" ]; then',
        '  _override="$(cat "/home/x/.switchroom/agents/klanker/.session-model-override")"',
        '  rm -f "/home/x/.switchroom/agents/klanker/.session-model-override"',
        '  _EFFECTIVE_MODEL="$_override"',
        "fi",
      ].join("\n"),
    );
    const result = checkStartShSessionModelCarrier("klanker", startShPath);
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/session-model-override/);
    expect(result.fix).toMatch(/switchroom apply/);
  });

  it("fails when only comments mention .session-model (no real file test)", () => {
    const startShPath = join(tempDir, "start.sh");
    writeFileSync(
      startShPath,
      [
        "#!/usr/bin/env bash",
        "# TODO: wire .session-model rev5 carrier",
        "# configuredDefaultAtWrite goes here someday",
        'if [ -f "/tmp/unrelated" ]; then true; fi',
      ].join("\n"),
    );
    const result = checkStartShSessionModelCarrier("klanker", startShPath);
    expect(result.status).toBe("fail");
  });

  it("ok for rev5 hbs shape: bare .session-model file test + JSON parse markers", () => {
    const startShPath = join(tempDir, "start.sh");
    writeFileSync(
      startShPath,
      [
        "#!/usr/bin/env bash",
        'if [ -f "/home/x/agents/a/.session-model-override" ]; then',
        '  printf \'{"model":"%s","configuredDefaultAtWrite":"%s"}\' "x" "y" > "/home/x/agents/a/.session-model"',
        "fi",
        'if [ -f "/home/x/agents/a/.session-model" ]; then',
        '  _smf="$(cat "/home/x/agents/a/.session-model" 2>/dev/null || true)"',
        "  : configuredDefaultAtWrite",
        '  _sm_attempts="$(cat "/home/x/agents/a/.session-model-boot-attempts" 2>/dev/null || true)"',
        "fi",
      ].join("\n"),
    );
    const result = checkStartShSessionModelCarrier("klanker", startShPath);
    expect(result.status).toBe("ok");
    expect(result.detail).toMatch(/rev5/);
  });
});

describe("checkLeakedHomeSwitchroom (#933)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = resolve(tmpdir(), `switchroom-doctor-leaked-${Date.now()}-${Math.random()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("ok when $HOME/.switchroom doesn't exist (fresh agent or post-#910 first boot)", async () => {
    const { checkLeakedHomeSwitchroom } = await import("../src/cli/doctor.js");
    const r = checkLeakedHomeSwitchroom("clerk", tempDir);
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("no leaked state");
  });

  it("ok when $HOME/.switchroom is a symlink (post-#910 boot succeeded)", async () => {
    const { symlinkSync } = await import("node:fs");
    mkdirSync(join(tempDir, "home"), { recursive: true });
    symlinkSync("/home/operator/.switchroom", join(tempDir, "home", ".switchroom"));
    const { checkLeakedHomeSwitchroom } = await import("../src/cli/doctor.js");
    const r = checkLeakedHomeSwitchroom("clerk", tempDir);
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("symlink in place");
  });

  it("fails when $HOME/.switchroom is a real directory (leaked state from pre-#910)", async () => {
    // Replicate the production observation: agent10821-owned dir with
    // analytics-id, logs/, quota-cache.json files.
    const leakedDir = join(tempDir, "home", ".switchroom");
    mkdirSync(leakedDir, { recursive: true });
    writeFileSync(join(leakedDir, "analytics-id"), "abc123\n");
    mkdirSync(join(leakedDir, "logs"), { recursive: true });
    writeFileSync(join(leakedDir, "quota-cache.json"), "{}\n");

    const { checkLeakedHomeSwitchroom } = await import("../src/cli/doctor.js");
    const r = checkLeakedHomeSwitchroom("clerk", tempDir);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("real directory");
    expect(r.detail).toContain("tilde paths");
    expect(r.fix).toContain("docker exec switchroom-clerk");
    expect(r.fix).toContain("rm -rf $HOME/.switchroom");
    expect(r.fix).toContain("switchroom agent restart clerk");
  });
});

// NOTE (#1094): the old host-scoped `checkPendingRetainsQueue(dir)` was
// replaced by the per-agent container probe `checkPendingRetainsQueues`.
// Its aggregation/classification is covered in
// `src/cli/doctor-pending-retains.test.ts` with the docker-exec seam mocked.
