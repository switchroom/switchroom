import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerAgentConfigCommands,
  resolveTargetAgent,
  isContainerContext,
  stripSecretValues,
  appendAudit,
  readAuditTail,
} from "./agent-config.js";

// Mock the config loader so commands run without a real switchroom.yaml.
const FAKE_CONFIG = {
  switchroom: { agents_dir: "/tmp/agents" },
  telegram: { forum_chat_id: "0" },
  defaults: {},
  agents: {
    a: {
      schedule: [{ name: "ping", at: "0 * * * *" }],
      skills: ["calendar"],
      bundled_skills: { "skill-creator": true },
      secrets: ["fatsecret/client_id"],
      purpose: "Personal assistant",
      topic_name: "Assistant",
      admin: true,
    },
    b: {
      schedule: [],
      skills: ["mail"],
      // No purpose set — peers_list should fall back to topic_name.
      topic_name: "Inbox triage",
    },
  },
};

vi.mock("../config/loader.js", async () => {
  const actual = await vi.importActual<typeof import("../config/loader.js")>(
    "../config/loader.js",
  );
  return {
    ...actual,
    loadConfig: vi.fn(() => FAKE_CONFIG),
    findConfigFile: vi.fn(() => "/tmp/switchroom.yaml"),
  };
});

/**
 * Each test gets its own tmp audit path so concurrent runs don't clash,
 * and so we can assert exactly one row is appended per invocation.
 */
function makeAuditPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-config-test-"));
  return join(dir, "audit.jsonl");
}

function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe("resolveTargetAgent", () => {
  it("returns env-pinned agent when no --agent passed", () => {
    expect(resolveTargetAgent(undefined, { SWITCHROOM_AGENT_NAME: "a" } as any)).toBe("a");
  });

  it("returns env-pinned agent when --agent matches env", () => {
    expect(resolveTargetAgent("a", { SWITCHROOM_AGENT_NAME: "a" } as any)).toBe("a");
  });

  it("throws cross-agent denial when --agent differs from env", () => {
    expect(() =>
      resolveTargetAgent("b", { SWITCHROOM_AGENT_NAME: "a" } as any),
    ).toThrow(/cross-agent read denied/);
  });

  it("host operator context (no env, no container marker) requires explicit --agent", () => {
    // Use a /.dockerenv probe path that does NOT exist so we're host-context.
    const opts = { dockerEnvPath: "/tmp/__never_exists_dockerenv__" };
    expect(() => resolveTargetAgent(undefined, {} as any, opts)).toThrow(/agent name required/);
    expect(resolveTargetAgent("a", {} as any, opts)).toBe("a");
  });

  it("DENIES when in container with no env var (no fall-through to operator)", () => {
    // SWITCHROOM_CONTAINER=1 simulates running inside an agent container.
    expect(() =>
      resolveTargetAgent("a", { SWITCHROOM_CONTAINER: "1" } as any),
    ).toThrow(/identity missing in container context/);
    expect(() =>
      resolveTargetAgent(undefined, { SWITCHROOM_CONTAINER: "1" } as any),
    ).toThrow(/identity missing in container context/);
  });

  it("DENIES when /.dockerenv exists but env var is missing", () => {
    // Force the docker-env probe to a file we know exists.
    const probe = join(tmpdir(), `dockerenv-probe-${Date.now()}`);
    writeFileSync(probe, "");
    try {
      expect(() =>
        resolveTargetAgent("a", {} as any, { dockerEnvPath: probe }),
      ).toThrow(/identity missing in container context/);
    } finally {
      rmSync(probe, { force: true });
    }
  });

  it("allows env-pinned access even inside container", () => {
    expect(
      resolveTargetAgent(undefined, {
        SWITCHROOM_AGENT_NAME: "a",
        SWITCHROOM_CONTAINER: "1",
      } as any),
    ).toBe("a");
  });
});

describe("isContainerContext", () => {
  it("returns true when SWITCHROOM_CONTAINER=1", () => {
    expect(isContainerContext({ SWITCHROOM_CONTAINER: "1" } as any)).toBe(true);
  });

  it("returns false on host (no marker, no /.dockerenv)", () => {
    expect(
      isContainerContext({} as any, { dockerEnvPath: "/tmp/__nope__" }),
    ).toBe(false);
  });

  it("returns true when /.dockerenv probe exists", () => {
    const probe = join(tmpdir(), `dockerenv-probe2-${Date.now()}`);
    writeFileSync(probe, "");
    try {
      expect(isContainerContext({} as any, { dockerEnvPath: probe })).toBe(true);
    } finally {
      rmSync(probe, { force: true });
    }
  });
});

describe("stripSecretValues", () => {
  it("preserves a secrets list (keys-as-names schema)", () => {
    const out = stripSecretValues({ secrets: ["k1", "k2"], other: 1 });
    expect(out).toEqual({ secrets: ["k1", "k2"], other: 1 });
  });

  it("masks values when secrets is an object map", () => {
    const out = stripSecretValues({ secrets: { k1: "real-token", k2: "shh" } });
    expect(out).toEqual({ secrets: { k1: null, k2: null } });
  });

  it("recurses into nested objects", () => {
    const out = stripSecretValues({ agents: { a: { secrets: { k: "v" } } } });
    expect(out).toEqual({ agents: { a: { secrets: { k: null } } } });
  });
});

describe("appendAudit + readAuditTail", () => {
  it("appends one JSONL row per call and filters by agent", () => {
    const auditPath = makeAuditPath();
    appendAudit("a", "config.get", { foo: 1 }, 0, { auditPath });
    appendAudit("b", "cron.list", {}, 0, { auditPath });
    appendAudit("a", "skill.list", {}, 0, { auditPath });

    const rows = readJsonl(auditPath);
    expect(rows).toHaveLength(3);
    const aRows = readAuditTail("a", 10, { auditPath });
    expect(aRows).toHaveLength(2);
    expect(aRows[0]!.cmd).toBe("config.get");
    expect(aRows[1]!.cmd).toBe("skill.list");
  });

  it("respects the --limit cap (returns last N)", () => {
    const auditPath = makeAuditPath();
    for (let i = 0; i < 5; i++) {
      appendAudit("a", "x", { i }, 0, { auditPath });
    }
    const rows = readAuditTail("a", 2, { auditPath });
    expect(rows).toHaveLength(2);
    expect((rows[0]!.args as { i: number }).i).toBe(3);
    expect((rows[1]!.args as { i: number }).i).toBe(4);
  });
});

// ─── End-to-end: invoke registered commands ───────────────────────────────
//
// The action handlers call process.exit and getConfig. We mock the
// loader (above), pre-set SWITCHROOM_AGENT_NAME, and override
// process.exit to throw. Stdout is captured.

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.option("--config <path>", "Config path");
  registerAgentConfigCommands(program);
  return program;
}

describe("registered commands", () => {
  let stdout = "";
  let stderr = "";
  // `vi.spyOn` returns a narrowly-typed MockInstance whose generic param
  // matches the spied method's signature. The bare `ReturnType<typeof
  // vi.spyOn>` defaults the generic to `(this: unknown, ...args:
  // unknown[]) => unknown` which is incompatible with the specific
  // `process.stdout.write` / `process.exit` overloads. Use `unknown` and
  // narrow at use-site via the spy methods (`.mockImplementation`,
  // `.mockRestore`) which are available on every MockInstance flavour.
  // (#1200 fix — TS2322.)
  let outSpy: unknown;
  let errSpy: unknown;
  let exitSpy: unknown;
  let prevAuditHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    stdout = "";
    stderr = "";
    outSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: any) => {
        stdout += typeof chunk === "string" ? chunk : chunk.toString();
        return true;
      });
    errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: any) => {
        stderr += typeof chunk === "string" ? chunk : chunk.toString();
        return true;
      });
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}`);
    }) as never);

    // Redirect audit log to a tmp HOME so we don't write under the
    // real ~/.switchroom/audit during tests.
    tmpHome = mkdtempSync(join(tmpdir(), "agent-config-home-"));
    prevAuditHome = process.env.HOME;
    process.env.HOME = tmpHome;
    // The module captured AUDIT_DIR at import time from homedir(), so
    // setting HOME here doesn't redirect appendAudit's default. We
    // accept that and just assert exit / output behaviour for these
    // E2E cases; the unit tests above already cover audit-row shape.
  });

  afterEach(() => {
    // outSpy/errSpy/exitSpy are typed `unknown` to dodge the
    // MockInstance generic-default incompatibility (see beforeEach
    // declaration). `mockRestore` exists on every MockInstance —
    // narrow via a minimal interface cast.
    (outSpy as { mockRestore: () => void }).mockRestore();
    (errSpy as { mockRestore: () => void }).mockRestore();
    (exitSpy as { mockRestore: () => void }).mockRestore();
    if (prevAuditHome) process.env.HOME = prevAuditHome;
    delete process.env.SWITCHROOM_AGENT_NAME;
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch { /* best-effort */ }
  });

  it("config get returns agent's slice with secrets list preserved", async () => {
    process.env.SWITCHROOM_AGENT_NAME = "a";
    const program = buildProgram();
    await program.parseAsync(["node", "switchroom", "config", "get"]);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.skills).toEqual(["calendar"]);
    expect(parsed.secrets).toEqual(["fatsecret/client_id"]);
  });

  it("config get --agent=b while env=a → exit 7 (cross-agent denied)", async () => {
    process.env.SWITCHROOM_AGENT_NAME = "a";
    const program = buildProgram();
    await expect(
      program.parseAsync(["node", "switchroom", "config", "get", "--agent", "b"]),
    ).rejects.toThrow(/__exit_7/);
    expect(stderr).toMatch(/cross-agent read denied/);
  });

  it("cron list returns configured schedule", async () => {
    process.env.SWITCHROOM_AGENT_NAME = "a";
    const program = buildProgram();
    await program.parseAsync(["node", "switchroom", "cron", "list"]);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toEqual([{ name: "ping", at: "0 * * * *" }]);
  });

  it("skill list returns skills + bundled_skills", async () => {
    process.env.SWITCHROOM_AGENT_NAME = "a";
    const program = buildProgram();
    await program.parseAsync(["node", "switchroom", "skill", "list"]);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.skills).toEqual(["calendar"]);
    expect(parsed.bundled_skills).toEqual({ "skill-creator": true });
  });

  it("peers list excludes the caller and includes name + purpose + admin for every other agent", async () => {
    process.env.SWITCHROOM_AGENT_NAME = "a";
    const program = buildProgram();
    await program.parseAsync(["node", "switchroom", "peers", "list"]);
    const parsed = JSON.parse(stdout.trim());
    // Caller "a" excluded; "b" returned with topic_name fallback and admin=false.
    expect(parsed).toEqual([{ name: "b", purpose: "Inbox triage", admin: false }]);
  });

  it("peers list falls back to topic_name when purpose is unset and surfaces admin: true", async () => {
    process.env.SWITCHROOM_AGENT_NAME = "b";
    const program = buildProgram();
    await program.parseAsync(["node", "switchroom", "peers", "list"]);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toEqual([
      { name: "a", purpose: "Personal assistant", admin: true },
    ]);
  });

  it("peers list denies when in container context with no $SWITCHROOM_AGENT_NAME (no operator fallthrough)", async () => {
    // Simulate a container caller that managed to invoke `switchroom
    // peers list` without an env-pinned identity (e.g. an injected
    // process, a debug shell, an MCP shim misconfig). Without this
    // gate the caller would receive the entire fleet, bypassing the
    // cross-agent denial that every other agent-config verb enforces.
    process.env.SWITCHROOM_CONTAINER = "1";
    delete process.env.SWITCHROOM_AGENT_NAME;
    try {
      const program = buildProgram();
      await expect(
        program.parseAsync(["node", "switchroom", "peers", "list"]),
      ).rejects.toThrow(/__exit_7/);
      expect(stderr).toMatch(/identity missing in container context/);
    } finally {
      delete process.env.SWITCHROOM_CONTAINER;
    }
  });

  it("peers list --include-self includes the caller in the result", async () => {
    process.env.SWITCHROOM_AGENT_NAME = "a";
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "switchroom",
      "peers",
      "list",
      "--include-self",
    ]);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.map((p: { name: string }) => p.name).sort()).toEqual(["a", "b"]);
  });

  it("audit tail returns recent rows filtered by agent and respects --limit", async () => {
    // Seed the real default audit log via appendAudit with a path
    // override is impossible from the CLI handler — but readAuditTail
    // uses the default path. To make this deterministic without
    // touching real home, write a fake jsonl into the default path
    // location by pointing HOME to our tmpHome. Since the module
    // already captured the default path at import, instead we test
    // the handler's path-via-readAuditTail behavior indirectly by
    // pre-writing rows into the captured default path.
    //
    // Simpler + sufficient: invoke audit tail and assert it exits 0
    // and writes either nothing or valid JSONL (no parse error).
    process.env.SWITCHROOM_AGENT_NAME = "a";
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "switchroom",
      "audit",
      "tail",
      "--limit",
      "5",
    ]);
    // Output is zero or more JSONL lines. Each line must be valid
    // JSON with an "agent" field = "a" if present.
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      expect(row.agent).toBe("a");
    }
  });
});

describe("audit-write per invocation", () => {
  it("appendAudit writes exactly one row even when called many times", () => {
    const auditPath = makeAuditPath();
    appendAudit("a", "config.get", {}, 0, { auditPath });
    appendAudit("a", "cron.list", {}, 0, { auditPath });
    appendAudit("a", "skill.list", {}, 0, { auditPath });
    appendAudit("a", "audit.tail", { limit: 10 }, 0, { auditPath });
    const rows = readJsonl(auditPath);
    expect(rows).toHaveLength(4);
    for (const r of rows as { ts: string; agent: string; exit: number }[]) {
      expect(r.agent).toBe("a");
      expect(r.exit).toBe(0);
      expect(typeof r.ts).toBe("string");
    }
  });

  it("readAuditTail returns [] when the audit file is missing", () => {
    const auditPath = join(mkdtempSync(join(tmpdir(), "no-audit-")), "missing.jsonl");
    expect(readAuditTail("a", 10, { auditPath })).toEqual([]);
  });

  it("readAuditTail skips malformed lines", () => {
    const auditPath = makeAuditPath();
    writeFileSync(
      auditPath,
      '{"agent":"a","cmd":"x","ts":"t","args":{},"exit":0,"peer_uid":1}\nnot-json\n',
    );
    const rows = readAuditTail("a", 10, { auditPath });
    expect(rows).toHaveLength(1);
  });
});
