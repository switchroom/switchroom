import { describe, it, expect } from "vitest";
import {
  filterEntries,
  formatForCli,
  parseAuditLine,
  readAndFilter,
} from "../../src/host-control/audit-reader.js";

const SAMPLE_AGENT_LINE = JSON.stringify({
  ts: "2026-05-15T04:15:13.465Z",
  op: "update_apply",
  caller: { kind: "agent", name: "klanker" },
  request_id: "gw-update-1",
  result: "started",
  exit_code: null,
  duration_ms: 1,
});
const SAMPLE_OPERATOR_LINE = JSON.stringify({
  ts: "2026-05-15T04:16:01.505Z",
  op: "get_status",
  caller: { kind: "operator" },
  request_id: "op-poll-1",
  result: "error",
  exit_code: 1,
  duration_ms: 47148,
  error: "subprocess exited non-zero",
});

describe("parseAuditLine", () => {
  it("parses a well-formed agent-caller line", () => {
    const entry = parseAuditLine(SAMPLE_AGENT_LINE);
    expect(entry).not.toBeNull();
    expect(entry!.op).toBe("update_apply");
    expect(entry!.caller).toEqual({ kind: "agent", name: "klanker" });
    expect(entry!.exit_code).toBeNull();
  });

  it("parses an operator-caller line and surfaces the error field", () => {
    const entry = parseAuditLine(SAMPLE_OPERATOR_LINE);
    expect(entry).not.toBeNull();
    expect(entry!.caller).toEqual({ kind: "operator" });
    expect(entry!.error).toBe("subprocess exited non-zero");
    expect(entry!.exit_code).toBe(1);
  });

  it("returns null on malformed JSON (partial write tolerance)", () => {
    expect(parseAuditLine('{"ts":"2026-05')).toBeNull();
    expect(parseAuditLine("not json")).toBeNull();
    expect(parseAuditLine("")).toBeNull();
    expect(parseAuditLine("   ")).toBeNull();
  });

  it("returns null when required fields are missing or wrong-typed", () => {
    expect(parseAuditLine(JSON.stringify({ ts: "x", op: "y" }))).toBeNull();
    expect(
      parseAuditLine(
        JSON.stringify({
          ts: "x",
          op: "y",
          caller: { kind: "agent", name: "k" },
          request_id: "r",
          result: "ok",
          duration_ms: "not-a-number",
        }),
      ),
    ).toBeNull();
  });

  it("rejects unknown caller kinds", () => {
    expect(
      parseAuditLine(
        JSON.stringify({
          ts: "x",
          op: "y",
          caller: { kind: "wat" },
          request_id: "r",
          result: "ok",
          duration_ms: 1,
        }),
      ),
    ).toBeNull();
  });
});

describe("filterEntries", () => {
  const entries = [
    parseAuditLine(SAMPLE_AGENT_LINE)!,
    parseAuditLine(SAMPLE_OPERATOR_LINE)!,
    parseAuditLine(
      JSON.stringify({
        ts: "2026-05-15T04:20:00.000Z",
        op: "agent_restart",
        caller: { kind: "agent", name: "carrie" },
        request_id: "r2",
        result: "completed",
        exit_code: 0,
        duration_ms: 500,
      }),
    )!,
  ];

  it("filters by agent name (operator entries dropped)", () => {
    const out = filterEntries(entries, { agent: "klanker" });
    expect(out).toHaveLength(1);
    expect(out[0]!.op).toBe("update_apply");
  });

  it("filters by op", () => {
    const out = filterEntries(entries, { op: "agent_restart" });
    expect(out).toHaveLength(1);
    expect(out[0]!.result).toBe("completed");
  });

  it("errorOnly keeps error and denied; drops completed and started", () => {
    const out = filterEntries(entries, { errorOnly: true });
    expect(out).toHaveLength(1);
    expect(out[0]!.request_id).toBe("op-poll-1");
  });

  it("combines filters (AND-semantics)", () => {
    const out = filterEntries(entries, { agent: "klanker", errorOnly: true });
    // klanker's only entry is `started`, not error, so AND yields none.
    expect(out).toHaveLength(0);
  });

  it("returns input unchanged when filters are empty", () => {
    expect(filterEntries(entries, {})).toEqual(entries);
  });
});

describe("readAndFilter", () => {
  it("tolerates blank lines and partial writes", () => {
    const raw =
      SAMPLE_AGENT_LINE + "\n" + "" + "\n" + "{partial" + "\n" + SAMPLE_OPERATOR_LINE + "\n";
    const out = readAndFilter(raw, {}, 50);
    expect(out).toHaveLength(2);
  });

  it("respects the limit (tail semantics — most recent N)", () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({
        ts: `2026-05-15T04:${String(i).padStart(2, "0")}:00.000Z`,
        op: "agent_start",
        caller: { kind: "agent", name: "klanker" },
        request_id: `r-${i}`,
        result: "completed",
        exit_code: 0,
        duration_ms: 100,
      }),
    );
    const out = readAndFilter(lines.join("\n"), {}, 3);
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.request_id)).toEqual(["r-7", "r-8", "r-9"]);
  });

  it("limit floor is 1 (rejects 0 / negative)", () => {
    const out = readAndFilter(SAMPLE_AGENT_LINE, {}, 0);
    expect(out).toHaveLength(1);
  });
});

describe("formatForCli", () => {
  it("emits one fixed-width row per entry with the canonical columns", () => {
    const entries = [parseAuditLine(SAMPLE_OPERATOR_LINE)!];
    const lines = formatForCli(entries);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    // ts + caller + op + result + exit + duration
    expect(line).toMatch(/^2026-05-15 04:16:01/);
    expect(line).toContain("operator");
    expect(line).toContain("get_status");
    expect(line).toContain("error");
    expect(line).toContain("47148ms");
  });

  it("renders null exit codes as a dash", () => {
    const entries = [parseAuditLine(SAMPLE_AGENT_LINE)!];
    const line = formatForCli(entries)[0]!;
    // exit_code: null → '  -' padded
    expect(line).toMatch(/\s-\s/);
  });

  it("marks terminal-phase rows with a ✓ suffix on the op", () => {
    const terminal = parseAuditLine(
      JSON.stringify({
        ts: "2026-05-15T08:00:40.000Z",
        op: "update_apply",
        phase: "terminal",
        caller: { kind: "agent", name: "klanker" },
        request_id: "gw-update-1",
        result: "error",
        exit_code: 1,
        duration_ms: 11876,
        stderr_tail: "switchroom apply failed: EACCES /state/...\nstack frame",
      }),
    )!;
    const line = formatForCli([terminal])[0]!;
    expect(line).toContain("update_apply✓");
  });

  it("verbose mode appends an indented stderr block under failed rows", () => {
    const terminal = parseAuditLine(
      JSON.stringify({
        ts: "2026-05-15T08:00:40.000Z",
        op: "update_apply",
        phase: "terminal",
        caller: { kind: "agent", name: "klanker" },
        request_id: "gw-update-1",
        result: "error",
        exit_code: 1,
        duration_ms: 11876,
        stderr_tail: "line one\nline two",
      }),
    )!;
    const out = formatForCli([terminal], { verbose: true });
    expect(out[0]).toContain("update_apply");
    expect(out.some((l) => l.includes("stderr:"))).toBe(true);
    expect(out.some((l) => l.includes("│ line one"))).toBe(true);
    expect(out.some((l) => l.includes("│ line two"))).toBe(true);
  });

  it("verbose mode falls back to the error message when no stderr_tail", () => {
    const e = parseAuditLine(
      JSON.stringify({
        ts: "2026-05-15T08:00:40.000Z",
        op: "update_apply",
        phase: "terminal",
        caller: { kind: "agent", name: "klanker" },
        request_id: "gw-update-2",
        result: "error",
        exit_code: null,
        duration_ms: 200,
        error: "spawn ENOENT",
      }),
    )!;
    const out = formatForCli([e], { verbose: true });
    expect(out.some((l) => l.includes("error:"))).toBe(true);
    expect(out.some((l) => l.includes("│ spawn ENOENT"))).toBe(true);
  });

  it("verbose mode is silent for clean (no stderr / no error) rows", () => {
    const ok = parseAuditLine(
      JSON.stringify({
        ts: "2026-05-15T08:00:40.000Z",
        op: "agent_restart",
        caller: { kind: "agent", name: "klanker" },
        request_id: "r1",
        result: "completed",
        exit_code: 0,
        duration_ms: 500,
      }),
    )!;
    expect(formatForCli([ok], { verbose: true })).toHaveLength(1);
  });

  it("clips a pathologically long stderr tail in verbose mode", () => {
    const huge = "x".repeat(5000);
    const e = parseAuditLine(
      JSON.stringify({
        ts: "2026-05-15T08:00:40.000Z",
        op: "update_apply",
        phase: "terminal",
        caller: { kind: "agent", name: "klanker" },
        request_id: "r2",
        result: "error",
        exit_code: 1,
        duration_ms: 100,
        stderr_tail: huge,
      }),
    )!;
    const out = formatForCli([e], { verbose: true }).join("\n");
    expect(out).toContain("(truncated)");
    expect(out.length).toBeLessThan(huge.length);
  });
});

describe("parseAuditLine — persisted tails (#22)", () => {
  it("captures phase, stdout_tail, stderr_tail when present", () => {
    const e = parseAuditLine(
      JSON.stringify({
        ts: "2026-05-15T08:00:40.000Z",
        op: "update_apply",
        phase: "terminal",
        caller: { kind: "operator" },
        request_id: "r3",
        result: "completed",
        exit_code: 0,
        duration_ms: 1234,
        stdout_tail: "ok",
        stderr_tail: "warn: foo",
      }),
    );
    expect(e).not.toBeNull();
    expect(e!.phase).toBe("terminal");
    expect(e!.stdout_tail).toBe("ok");
    expect(e!.stderr_tail).toBe("warn: foo");
  });

  it("tolerates the legacy row shape (no phase / tails)", () => {
    const e = parseAuditLine(SAMPLE_AGENT_LINE);
    expect(e).not.toBeNull();
    expect(e!.phase).toBeUndefined();
    expect(e!.stderr_tail).toBeUndefined();
  });

  it("round-trips PR-B enrichment fields (channel, pin, resolved_sha, install_context)", () => {
    const row = {
      ts: "2026-05-17T01:02:03.000Z",
      op: "update_apply",
      caller: { kind: "operator" },
      request_id: "ua-1",
      result: "completed",
      exit_code: 0,
      duration_ms: 12345,
      phase: "terminal",
      channel: "dev",
      pin: "v0.11.1",
      resolved_sha: {
        "ghcr.io/switchroom/switchroom-agent:dev": "sha256:abc123",
      },
      install_context: {
        install_type: "binary",
        detected_at: "2026-05-17T01:00:00.000Z",
      },
    };
    const e = parseAuditLine(JSON.stringify(row));
    expect(e).not.toBeNull();
    expect(e!.channel).toBe("dev");
    expect(e!.pin).toBe("v0.11.1");
    expect(e!.resolved_sha).toEqual({
      "ghcr.io/switchroom/switchroom-agent:dev": "sha256:abc123",
    });
    expect(e!.install_context).toEqual({
      install_type: "binary",
      detected_at: "2026-05-17T01:00:00.000Z",
    });
  });

  it("ignores malformed enrichment fields rather than rejecting the row", () => {
    const row = {
      ts: "2026-05-17T01:02:03.000Z",
      op: "update_apply",
      caller: { kind: "operator" },
      request_id: "ua-2",
      result: "completed",
      exit_code: 0,
      duration_ms: 1,
      channel: 42, // wrong type
      resolved_sha: "not-an-object",
      install_context: { install_type: "binary" /* missing detected_at */ },
    };
    const e = parseAuditLine(JSON.stringify(row));
    expect(e).not.toBeNull();
    expect(e!.channel).toBeUndefined();
    expect(e!.resolved_sha).toBeUndefined();
    expect(e!.install_context).toBeUndefined();
  });
});
