/**
 * Integration tests for `switchroom memory directive reconcile <agent> <name>
 * <content...>` — Memory v2 M2's real entry point for the windows-boxes-class
 * fix (PR #4760 review M4: the skill previously pointed at a script that did
 * not exist) — and for `switchroom memory directive mark-rules-block <agent>
 * <id>`, the entry point that closes a follow-up gap in the same review: the
 * mental-model-curator skill's INTERACTIVE triage pass never went through
 * `applyDirectiveTriageBatch` (the only caller of `DirectiveAdmin.markRulesBlock`
 * before this verb existed), so a rules-block directive classified only
 * through that interactive path carried no marker and `DirectiveAdmin`'s
 * refusal chokepoint never armed for it.
 *
 * Shells out to the built CLI under bun, matching the `memory demote` CLI
 * test pattern (`tests/cli.memory.demote.test.ts`). Preflight/wiring only for
 * `reconcile`; `mark-rules-block` additionally gets a live-mock-server test
 * below that exercises the ACTUAL interactive-path gap end to end (spawns the
 * real built CLI against a hermetic mock REST server, exactly as an agent's
 * `Bash(switchroom memory directive mark-rules-block *)` call would) — the
 * create-first/deactivate-second mechanics of `reconcile` are covered
 * separately against the same kind of mock server in
 * `tests/memory.directive-triage-executor.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const execFileAsync = promisify(execFile);
import {
  DirectiveAdmin,
  RULES_BLOCK_MARKER_TAG,
  RulesBlockDeactivationRefusedError,
  type HindsightDirective,
} from "../src/memory/hindsight-directive-admin.js";

const CLI = resolve(__dirname, "..", "dist", "cli", "switchroom.js");
const BUN = process.env.BUN_PATH ?? "bun";

let cfgDir: string;
let cfgPath: string;

function run(
  args: string[],
  opts: { expectError?: boolean } = {},
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(BUN, [CLI, "--config", cfgPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: process.env as Record<string, string>,
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number;
    };
    if (!opts.expectError) throw err;
    return {
      stdout:
        typeof e.stdout === "string"
          ? e.stdout
          : (e.stdout ?? Buffer.alloc(0)).toString(),
      stderr:
        typeof e.stderr === "string"
          ? e.stderr
          : (e.stderr ?? Buffer.alloc(0)).toString(),
      status: e.status ?? 1,
    };
  }
}

beforeEach(() => {
  cfgDir = mkdtempSync(join(tmpdir(), "memory-directive-cli-"));
  cfgPath = join(cfgDir, "switchroom.yaml");
  // Hindsight pointed at a closed port so the reconcile call fails fast
  // (ECONNREFUSED) rather than hitting a real service — sufficient to prove
  // the dispatcher reaches the DirectiveAdmin/reconcile layer.
  writeFileSync(
    cfgPath,
    [
      "switchroom:",
      "  version: 1",
      "telegram:",
      '  bot_token: "vault:telegram-bot-token"',
      '  forum_chat_id: "-100"',
      "memory:",
      "  backend: hindsight",
      "  config:",
      "    url: http://127.0.0.1:1/mcp/",
      "agents:",
      "  clerk:",
      '    topic_name: "Test"',
      "",
    ].join("\n"),
  );
});

afterEach(() => {
  rmSync(cfgDir, { recursive: true, force: true });
});

describe("memory directive reconcile — argument validation", () => {
  it("--help lists the verb and its arguments", () => {
    const { stdout, status } = run(["memory", "directive", "reconcile", "--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("reconcile");
    expect(stdout).toContain("name");
    expect(stdout).toContain("content");
    expect(stdout).toContain("--priority");
  });

  it("rejects unknown agent with non-zero exit and helpful stderr", () => {
    const { status, stderr } = run(
      ["memory", "directive", "reconcile", "ghost-agent", "some-name", "new content"],
      { expectError: true },
    );
    expect(status).toBe(1);
    expect(stderr).toContain("ghost-agent");
    expect(stderr).toMatch(/not defined in switchroom\.yaml/);
  });

  it("commander rejects when content positional is missing", () => {
    const { status, stderr } = run(
      ["memory", "directive", "reconcile", "clerk", "some-name"],
      { expectError: true },
    );
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/missing required argument|usage/i);
  });

  it("rejects empty (whitespace-only) content", () => {
    const { status, stderr } = run(
      ["memory", "directive", "reconcile", "clerk", "some-name", "   "],
      { expectError: true },
    );
    expect(status).toBe(1);
    expect(stderr).toMatch(/must not be empty/);
  });
});

describe("memory directive reconcile — happy-path wiring", () => {
  it("attempts the API call when agent + name + content are valid (network failure surfaces cleanly)", () => {
    // Hindsight is pointed at port 1 (closed) so the call fails fast with a
    // connection error. A non-zero exit with a clear failure line tells us
    // the dispatcher reached DirectiveAdmin/reconcileDirectiveSuperset; the
    // actual create-first/deactivate-second wire shape is covered by
    // tests/memory.directive-triage-executor.test.ts against a hermetic
    // mock server.
    const { status, stderr } = run(
      ["memory", "directive", "reconcile", "clerk", "windows-boxes-access-and-full-stop", "new superset text"],
      { expectError: true },
    );
    expect(status).toBe(1);
    expect(stderr).toMatch(/✗/);
  });

  it("--json emits a machine-readable error envelope on failure", () => {
    const { status, stdout } = run(
      [
        "memory",
        "directive",
        "reconcile",
        "clerk",
        "windows-boxes-access-and-full-stop",
        "new superset text",
        "--json",
      ],
      { expectError: true },
    );
    expect(status).toBe(1);
    const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as {
      ok: boolean;
      error: string;
    };
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe("string");
  });
});

describe("memory directive mark-rules-block — argument validation", () => {
  it("--help lists the verb and its arguments", () => {
    const { stdout, status } = run(["memory", "directive", "mark-rules-block", "--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("mark-rules-block");
    expect(stdout).toContain("agent");
    expect(stdout).toContain("id");
  });

  it("rejects unknown agent with non-zero exit and helpful stderr", () => {
    const { status, stderr } = run(
      ["memory", "directive", "mark-rules-block", "ghost-agent", "some-id"],
      { expectError: true },
    );
    expect(status).toBe(1);
    expect(stderr).toContain("ghost-agent");
    expect(stderr).toMatch(/not defined in switchroom\.yaml/);
  });

  it("attempts the API call when agent + id are valid (network failure surfaces cleanly)", () => {
    // Hindsight pointed at a closed port (from the shared config in
    // beforeEach) — proves the dispatcher reaches DirectiveAdmin.markRulesBlock.
    const { status, stderr } = run(
      ["memory", "directive", "mark-rules-block", "clerk", "some-id"],
      { expectError: true },
    );
    expect(status).toBe(1);
    expect(stderr).toMatch(/✗/);
  });

  it("--json emits a machine-readable error envelope on failure", () => {
    const { status, stdout } = run(
      ["memory", "directive", "mark-rules-block", "clerk", "some-id", "--json"],
      { expectError: true },
    );
    expect(status).toBe(1);
    const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as {
      ok: boolean;
      error: string;
    };
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe("string");
  });
});

describe("memory directive mark-rules-block — own-agent guard", () => {
  const envKey = "SWITCHROOM_AGENT_NAME";
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env[envKey];
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env[envKey];
    else process.env[envKey] = prevEnv;
  });

  it("refuses a foreign <agent> when SWITCHROOM_AGENT_NAME is set, before ever reaching the API", () => {
    process.env[envKey] = "some-other-agent";
    // Hindsight is pointed at a closed port (beforeEach config). If the
    // guard did NOT fire first, this call would fail with a connection
    // error (matching /✗/ too) rather than the guard's own message — the
    // distinguishing assertion below is the refusal text, which can only
    // appear if the guard ran before any network call was attempted.
    const { status, stderr } = run(
      ["memory", "directive", "mark-rules-block", "clerk", "some-id"],
      { expectError: true },
    );
    expect(status).toBe(1);
    expect(stderr).toMatch(/own bank/);
    expect(stderr).toContain("some-other-agent");
    expect(stderr).toContain("clerk");
  });

  it("--json refusal for a foreign agent carries the machine-readable error envelope", () => {
    process.env[envKey] = "some-other-agent";
    const { status, stdout } = run(
      ["memory", "directive", "mark-rules-block", "clerk", "some-id", "--json"],
      { expectError: true },
    );
    expect(status).toBe(1);
    const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as {
      ok: boolean;
      error: string;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/own bank/);
  });

  it("still attempts the call for the agent's OWN bank when SWITCHROOM_AGENT_NAME matches — guard does not block legitimate use", () => {
    process.env[envKey] = "clerk";
    // Same closed-port config as the un-guarded test above: reaching the
    // network-failure `✗` (not the guard's refusal text) proves the guard
    // passed the own-agent call through to DirectiveAdmin.markRulesBlock.
    const { status, stderr } = run(
      ["memory", "directive", "mark-rules-block", "clerk", "some-id"],
      { expectError: true },
    );
    expect(status).toBe(1);
    expect(stderr).toMatch(/✗/);
    expect(stderr).not.toMatch(/own bank/);
  });
});

/**
 * The actual TDD regression test for the gap this verb closes: a rules-block
 * directive taken through the INTERACTIVE path — never through
 * `applyDirectiveTriageBatch`, the batch executor that was previously the
 * ONLY caller of `DirectiveAdmin.markRulesBlock` — must end up carrying the
 * marker tag, and a subsequent deactivate attempt against it must be refused.
 *
 * This spawns the real BUILT CLI (`switchroom memory directive
 * mark-rules-block`) against a hermetic mock hindsight REST server — the same
 * call an agent's `Bash(switchroom memory directive mark-rules-block *)` tool
 * invocation makes from inside the mental-model-curator skill's interactive
 * workflow. Before the fix (no `mark-rules-block` verb, no SKILL.md step
 * wired to call it), nothing on the interactive path ever wrote the marker,
 * so this test fails at the CLI-invocation step. After the fix, the marker
 * lands via the exact write path (`DirectiveAdmin.markRulesBlock`) the
 * refusal chokepoint checks, so a subsequent `deactivate` throws
 * `RulesBlockDeactivationRefusedError` — proving the chokepoint is armed by
 * the interactive path, not just the batch path.
 */
describe("memory directive mark-rules-block — closes the interactive-path gap (PR #4760 follow-up)", () => {
  interface MockApi {
    baseUrl: string;
    server: Server;
    close: () => Promise<void>;
  }

  let api: MockApi;
  let interactiveCfgDir: string;
  let interactiveCfgPath: string;
  const BANK = "clerk";
  let bank: HindsightDirective[];

  async function startMockApi(): Promise<MockApi> {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const path = req.url ?? "";
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        const rawPath = path.split("?")[0] ?? "";
        const m = /^\/v1\/default\/banks\/([^/]+)\/directives(?:\/([^/]+))?$/.exec(rawPath);
        if (!m) return send(404, { detail: "not found" });
        const bankId = decodeURIComponent(m[1]!);
        const directiveId = m[2] ? decodeURIComponent(m[2]) : undefined;
        if (bankId !== BANK) return send(404, { detail: "no such bank" });

        if (req.method === "GET" && !directiveId) {
          return send(200, { items: bank });
        }
        if (req.method === "PATCH" && directiveId) {
          const target = bank.find((d) => d.id === directiveId);
          if (!target) return send(404, { detail: "no such directive" });
          for (const key of Object.keys(body ?? {})) {
            (target as Record<string, unknown>)[key] = (body as Record<string, unknown>)[key];
          }
          return send(200, target);
        }
        return send(405, { detail: "method not allowed" });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      server,
      close: () => new Promise((r) => server.close(() => r())),
    };
  }

  beforeEach(async () => {
    bank = [
      {
        id: "d-rules-block",
        name: "rules-block-row",
        content: "belongs in the CLAUDE.md rules block",
        priority: 8,
        is_active: true,
        tags: [],
      },
    ];
    api = await startMockApi();
    interactiveCfgDir = mkdtempSync(join(tmpdir(), "memory-directive-mark-cli-"));
    interactiveCfgPath = join(interactiveCfgDir, "switchroom.yaml");
    writeFileSync(
      interactiveCfgPath,
      [
        "switchroom:",
        "  version: 1",
        "telegram:",
        '  bot_token: "vault:telegram-bot-token"',
        '  forum_chat_id: "-100"',
        "memory:",
        "  backend: hindsight",
        "  config:",
        `    url: ${api.baseUrl}/mcp/`,
        "agents:",
        "  clerk:",
        '    topic_name: "Test"',
        "",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await api.close();
    rmSync(interactiveCfgDir, { recursive: true, force: true });
  });

  it("stamps the marker via the real CLI, and a subsequent deactivate is refused — never carries the marker before the call", async () => {
    // Precondition proving this is genuinely the interactive path, not a
    // pre-seeded fixture: the directive starts with NO rules-block marker,
    // exactly as it would after a skill classifies it in-context (no bank
    // write happens from classification alone).
    expect(bank[0]!.tags).not.toContain(RULES_BLOCK_MARKER_TAG);

    // Async spawn, not `execFileSync`: this test's mock HTTP server runs
    // IN-PROCESS (same event loop as the test itself), so a synchronous
    // spawn would block that event loop and the server could never answer
    // the subprocess's request — a self-deadlock, not a real bug in the CLI.
    let stdout: string;
    try {
      const result = await execFileAsync(BUN, [
        CLI,
        "--config",
        interactiveCfgPath,
        "memory",
        "directive",
        "mark-rules-block",
        "clerk",
        "d-rules-block",
      ]);
      stdout = result.stdout;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      throw new Error(`CLI failed. stdout=${err.stdout ?? ""} stderr=${err.stderr ?? ""}`);
    }
    expect(stdout).toMatch(/✓/);

    // The marker is now persisted on the directive, via the CLI call alone —
    // no other code path touched this bank.
    expect(bank[0]!.tags).toContain(RULES_BLOCK_MARKER_TAG);

    // The refusal chokepoint now arms for this directive, on the SAME
    // DirectiveAdmin surface any deactivation attempt (including the
    // skill's own `deactivate_directive` MCP call) must go through.
    const admin = new DirectiveAdmin({ apiBaseUrl: api.baseUrl, bankId: BANK });
    await expect(admin.deactivate({ name: "rules-block-row" })).rejects.toBeInstanceOf(
      RulesBlockDeactivationRefusedError,
    );
    expect(bank[0]!.is_active).not.toBe(false);
  });

  it("--json emits a machine-readable success envelope on a successful stamp", async () => {
    expect(bank[0]!.tags).not.toContain(RULES_BLOCK_MARKER_TAG);

    let stdout: string;
    try {
      const result = await execFileAsync(BUN, [
        CLI,
        "--config",
        interactiveCfgPath,
        "memory",
        "directive",
        "mark-rules-block",
        "clerk",
        "d-rules-block",
        "--json",
      ]);
      stdout = result.stdout;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      throw new Error(`CLI failed. stdout=${err.stdout ?? ""} stderr=${err.stderr ?? ""}`);
    }

    const parsed = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as {
      ok: boolean;
      agent: string;
      id: string;
      message: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.agent).toBe("clerk");
    expect(parsed.id).toBe("d-rules-block");
    expect(typeof parsed.message).toBe("string");
    expect(parsed.message.length).toBeGreaterThan(0);

    expect(bank[0]!.tags).toContain(RULES_BLOCK_MARKER_TAG);
  });

  it("without ever calling mark-rules-block, the same directive is NOT protected — demonstrates the gap this verb closes", async () => {
    // No CLI call this time — this is the pre-fix interactive-path shape:
    // the skill classifies the directive rules-block in its own reasoning
    // but nothing persists that to the bank.
    const admin = new DirectiveAdmin({ apiBaseUrl: api.baseUrl, bankId: BANK });
    const result = await admin.deactivate({ name: "rules-block-row" });
    expect(result).toMatch(/Deactivated/);
    expect(bank[0]!.is_active).toBe(false);
  });

  it("own-agent guard: a foreign SWITCHROOM_AGENT_NAME never reaches the API, so the bank is never stamped", async () => {
    expect(bank[0]!.tags).not.toContain(RULES_BLOCK_MARKER_TAG);

    let stdout = "";
    let stderr = "";
    let status = 0;
    try {
      const result = await execFileAsync(
        BUN,
        [
          CLI,
          "--config",
          interactiveCfgPath,
          "memory",
          "directive",
          "mark-rules-block",
          "clerk",
          "d-rules-block",
        ],
        { env: { ...process.env, SWITCHROOM_AGENT_NAME: "some-other-agent" } },
      );
      stdout = result.stdout;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; code?: number };
      stdout = err.stdout ?? "";
      stderr = err.stderr ?? "";
      status = err.code ?? 1;
    }
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/own bank/);
    void stdout;

    // The refusal happened before any bank write — no marker landed, unlike
    // the own-agent case above.
    expect(bank[0]!.tags).not.toContain(RULES_BLOCK_MARKER_TAG);
  });
});
