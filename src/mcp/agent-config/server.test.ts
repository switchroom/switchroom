/**
 * Tests for the agent-config MCP shim.
 *
 * Covers:
 *   - `TOOLS` exports exactly the documented tool surface with sane shape.
 *   - `dispatchTool` happy path: stdout parsed as JSON / JSONL and returned.
 *   - `dispatchTool` failure path: non-zero CLI exit surfaces as isError.
 *   - Unknown tool name returns an error result.
 *
 * We mock `node:child_process.spawnSync` so the CLI doesn't actually
 * exec — that keeps tests hermetic and fast.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const spawnSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

// Import after vi.mock so the mock is in place.
import { TOOLS, dispatchTool, parseJsonPayload, CLI_TIMEOUT_MS } from "./server.js";

function okCall(stdout: string) {
  spawnSyncMock.mockReturnValueOnce({ stdout, stderr: "", status: 0 });
}

function failCall(stderr: string, status = 1) {
  spawnSyncMock.mockReturnValueOnce({ stdout: "", stderr, status });
}

describe("TOOLS export", () => {
  it("exposes the documented tools (read + write surface)", () => {
    const names = TOOLS.map((t) => t.name).sort();
    expect(names).toEqual([
      "audit_tail",
      "config_get",
      "cron_doctor",          // read-only cron health report
      "cron_list",
      "peers_list",            // identity / peer-awareness
      "schedule_add",
      "schedule_remove",
      "skill_clone_to_personal", // #1819 follow-up — fork shared/bundled
      "skill_edit_personal",   // #1819 Phase 1 (agent-managed personal skills)
      "skill_init_personal",   // #1819 Phase 1
      "skill_install",         // #1163 Phase 2 (shared library)
      "skill_list",
      "skill_list_personal",   // #1819 Phase 1
      "skill_remove",          // #1163 Phase 2
      "skill_remove_personal", // #1819 Phase 1
      "skill_search",          // #1819 Phase 3
      "whoami",                // legibility — "see your own sandbox"
    ]);
  });

  it("every tool has an inputSchema of type object", () => {
    for (const t of TOOLS) {
      expect(t.inputSchema.type).toBe("object");
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(10);
    }
  });

  it("schedule_add.prompt carries the future-self framing in its schema (#4740)", () => {
    // The cron-prompt perspective rule ("the prompt is what YOU receive
    // when the cron fires — write it from your future self's point of
    // view, not as a request to you") used to live only in the
    // always-loaded CLAUDE.md self-service block. Prompt text is
    // model-dependent; the schema is deterministic and arrives at call
    // time, so the rule lives here. Without it agents author
    // second-person prompts ("please send the digest") that read as
    // someone else's instruction on fire.
    const scheduleAdd = TOOLS.find((t) => t.name === "schedule_add");
    expect(scheduleAdd).toBeDefined();
    const props = scheduleAdd!.inputSchema.properties as Record<
      string,
      { description?: string }
    >;
    const promptDesc = props.prompt?.description ?? "";
    expect(promptDesc.length).toBeGreaterThan(40);
    expect(promptDesc.toLowerCase()).toContain("future-self");
    // It must say the prompt is delivered TO the agent, not to the user.
    expect(promptDesc.toLowerCase()).toMatch(/you receive|not a message sent to the user/);
  });
});

describe("dispatchTool — happy path", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it("config_get parses CLI stdout as a single JSON document", () => {
    okCall(JSON.stringify({ skills: ["calendar"], secrets: ["k"] }) + "\n");
    const res = dispatchTool("config_get", { agent: "a" });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed).toEqual({ skills: ["calendar"], secrets: ["k"] });
    // Ensure --agent was forwarded.
    const [, args] = spawnSyncMock.mock.calls[0]!;
    expect(args).toEqual(["config", "get", "--agent", "a"]);
  });

  it("whoami shells `config whoami` and parses the JSON view", () => {
    okCall(JSON.stringify({ name: "a", tier: "admin", tools: { allow: [], deny: [] } }) + "\n");
    const res = dispatchTool("whoami", { agent: "a" });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text).tier).toBe("admin");
    const [, args] = spawnSyncMock.mock.calls[0]!;
    expect(args).toEqual(["config", "whoami", "--agent", "a"]);
  });

  it("cron_list / skill_list parse JSON", () => {
    okCall(JSON.stringify([{ name: "ping" }]) + "\n");
    const cron = dispatchTool("cron_list", {});
    expect(JSON.parse(cron.content[0]!.text)).toEqual([{ name: "ping" }]);

    okCall(JSON.stringify({ skills: ["s"], bundled_skills: {} }) + "\n");
    const skill = dispatchTool("skill_list", {});
    expect(JSON.parse(skill.content[0]!.text)).toEqual({
      skills: ["s"],
      bundled_skills: {},
    });
  });

  it("cron_doctor shells `cron doctor` and parses the JSON report", () => {
    const report = { agent: "a", entry_count: 0, findings: [], healthy: true };
    okCall(JSON.stringify(report) + "\n");
    const res = dispatchTool("cron_doctor", { agent: "a" });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text)).toEqual(report);
    const [, args] = spawnSyncMock.mock.calls[0]!;
    expect(args).toEqual(["cron", "doctor", "--agent", "a"]);
  });

  it("peers_list shells out with no --agent flag (caller identity is env-pinned)", () => {
    okCall(
      JSON.stringify([
        { name: "scribe", purpose: "notes" },
        { name: "doc", purpose: "Health" },
      ]) + "\n",
    );
    const res = dispatchTool("peers_list", {});
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text)).toEqual([
      { name: "scribe", purpose: "notes" },
      { name: "doc", purpose: "Health" },
    ]);
    const [, args] = spawnSyncMock.mock.calls[0]!;
    expect(args).toEqual(["peers", "list"]);
  });

  it("peers_list forwards include_self when set", () => {
    okCall(JSON.stringify([]) + "\n");
    dispatchTool("peers_list", { include_self: true });
    const [, args] = spawnSyncMock.mock.calls[0]!;
    expect(args).toEqual(["peers", "list", "--include-self"]);
  });

  it("audit_tail parses JSONL (one row per line)", () => {
    const row1 = { ts: "t1", agent: "a", cmd: "x", args: {}, exit: 0, peer_uid: 1 };
    const row2 = { ts: "t2", agent: "a", cmd: "y", args: {}, exit: 0, peer_uid: 1 };
    okCall(JSON.stringify(row1) + "\n" + JSON.stringify(row2) + "\n");
    const res = dispatchTool("audit_tail", { limit: 5 });
    expect(res.isError).toBeFalsy();
    const rows = JSON.parse(res.content[0]!.text);
    expect(rows).toEqual([row1, row2]);
    // Ensure --limit was forwarded as a string.
    const [, args] = spawnSyncMock.mock.calls[0]!;
    expect(args).toEqual(["audit", "tail", "--limit", "5"]);
  });
});

describe("dispatchTool — failure modes", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it("non-zero CLI exit surfaces as isError with stderr in the message", () => {
    failCall("cross-agent read denied: env agent \"a\" cannot read config for \"b\"", 7);
    const res = dispatchTool("config_get", { agent: "b" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/CLI exit 7/);
    expect(res.content[0]!.text).toMatch(/cross-agent read denied/);
  });

  it("malformed JSON from CLI surfaces as a parse error", () => {
    okCall("not-json\n");
    const res = dispatchTool("config_get", {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/failed to parse/);
  });

  it("unknown tool name returns an error result without invoking CLI", () => {
    const res = dispatchTool("nope" as string, {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/unknown tool: nope/);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});

// #4181 — schedule_add/schedule_remove reported `CLI exit 1:` (empty
// body) for writes that fully succeeded on disk. Root causes: (a) the
// 15s spawnSync timeout SIGTERM'd the CLI mid-reconcile (measured
// 15–19s live) AFTER the overlay write landed, with the killed child's
// null status masked to `1` and its empty output rendered verbatim;
// (b) even a completed write failed JSON parsing because the reconcile
// path prints progress noise to stdout around the JSON result line.
describe("dispatchTool — #4181 killed/noisy subprocess regressions", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it("schedule_add succeeds when reconcile noise surrounds the JSON result line", () => {
    // Verbatim shape observed live (overlord, 2026-08-02): ownership-sweep
    // line BEFORE the JSON, Hindsight provisioning lines AFTER it.
    const payload = {
      ok: true,
      slug: "cron-438a4731e02e",
      cron_hash: "438a4731e02e",
      path: "/state/agent/home/.switchroom/agents/overlord/schedule.d/cron-438a4731e02e.yaml",
      would_recreate: false,
      restart_required: false,
      restart_hint: "Live within ~30s",
    };
    okCall(
      "[ownership-sweep] #3333 agent=overlord scope=full uid=10684 inodes=1142276 elapsedMs=8417 dir=/state/agent\n" +
        JSON.stringify(payload) +
        "\n" +
        "  ✓ Hindsight bank ready for overlord\n" +
        '  ✓ Mental model "Switchroom Fleet Rollout State" ready for overlord\n',
    );
    const res = dispatchTool("schedule_add", {
      cron_expr: "0 * * * *",
      prompt: "hourly report",
      name: "consolidation-hourly-progress",
    });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text)).toEqual(payload);
  });

  it("a timeout-killed CLI surfaces the signal and a may-have-applied warning, never an empty message", () => {
    // spawnSync on timeout: status null, signal set, no output captured.
    spawnSyncMock.mockReturnValueOnce({
      stdout: "",
      stderr: "",
      status: null,
      signal: "SIGTERM",
    });
    const res = dispatchTool("schedule_remove", { name: "consolidation-hourly-progress" });
    expect(res.isError).toBe(true);
    const msg = res.content[0]!.text;
    // The old code produced exactly "CLI exit 1: " here — assert the
    // message is substantive and truthful about what happened.
    expect(msg).toMatch(/SIGTERM/);
    expect(msg).toMatch(/timeout/i);
    expect(msg).toMatch(/may still have been applied/);
    expect(msg).toMatch(/cron_list/);
    expect(msg).not.toMatch(/CLI exit 1: *$/);
  });

  it("a genuine write failure still reports failure with the CLI's stderr", () => {
    failCall(
      JSON.stringify({ code: "E_NOT_FOUND", message: "no overlay entry found for name=nope" }),
      1,
    );
    const res = dispatchTool("schedule_remove", { name: "nope" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/CLI exit 1/);
    expect(res.content[0]!.text).toMatch(/E_NOT_FOUND/);
  });

  it("a non-zero exit with NO output still yields a non-empty diagnostic", () => {
    failCall("", 1);
    const res = dispatchTool("schedule_remove", { name: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/CLI exit 1: \(no output captured\)/);
  });

  it("a spawn-level failure (binary missing) is named, not rendered as an empty exit", () => {
    spawnSyncMock.mockReturnValueOnce({
      stdout: "",
      stderr: "",
      status: null,
      signal: null,
      error: new Error("spawnSync switchroom ENOENT"),
    });
    const res = dispatchTool("cron_list", {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/failed to exec/);
    expect(res.content[0]!.text).toMatch(/ENOENT/);
  });

  it("the subprocess timeout budget covers the measured 15–19s reconcile-heavy writes", () => {
    // The bug shipped with timeout: 15000 while `schedule remove` was
    // measured at 19.2s wall in a live container — this pins the budget
    // comfortably above that (default 120s, env-overridable).
    expect(CLI_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    okCall(JSON.stringify([]) + "\n");
    dispatchTool("cron_list", {});
    const [, , opts] = spawnSyncMock.mock.calls[0]!;
    expect((opts as { timeout: number }).timeout).toBe(CLI_TIMEOUT_MS);
  });
});

describe("parseJsonPayload", () => {
  it("parses a clean single JSON line (fast path)", () => {
    expect(parseJsonPayload('{"ok":true}\n')).toEqual({ ok: true });
  });

  it("parses a multi-line pretty-printed JSON document", () => {
    expect(parseJsonPayload('{\n  "ok": true\n}\n')).toEqual({ ok: true });
  });

  it("returns null for empty stdout", () => {
    expect(parseJsonPayload("")).toBeNull();
  });

  it("picks the LAST parseable JSON line when noise interleaves", () => {
    const out = "[sweep] pre\n" + '{"ok":true,"slug":"cron-abc"}\n' + "  ✓ post\n";
    expect(parseJsonPayload(out)).toEqual({ ok: true, slug: "cron-abc" });
  });

  it("throws when stdout has no JSON at all", () => {
    expect(() => parseJsonPayload("not-json\n")).toThrow(/no JSON payload/);
  });
});
