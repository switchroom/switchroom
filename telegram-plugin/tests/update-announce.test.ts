import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readLastTerminalUpdateAudit,
  renderUpdateOutcomeLine,
  claimUpdateAnnouncement,
  maybeRenderUpdateAnnouncement,
} from "../gateway/update-announce.js";

function makeRow(o: Record<string, unknown>): string {
  return JSON.stringify(o) + "\n";
}

describe("update-announce — PR C boot-card surfacing", () => {
  let tmp: string;
  let auditPath: string;
  let stateDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "update-announce-"));
    auditPath = join(tmp, "host-control-audit.log");
    stateDir = join(tmp, "state");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when audit log missing", () => {
    expect(readLastTerminalUpdateAudit({ auditLogPath: auditPath })).toBeNull();
  });

  it("returns most recent terminal update_apply row within lookback", () => {
    const now = Date.parse("2026-05-17T12:00:00.000Z");
    const lines =
      makeRow({
        ts: "2026-05-17T11:59:00.000Z",
        op: "update_apply",
        caller: { kind: "operator" },
        request_id: "req-1",
        result: "ok",
        exit_code: 0,
        duration_ms: 1234,
        phase: "terminal",
        channel: "dev",
        resolved_sha: { "switchroom-agent": "sha256:abcdef1234567890" },
        install_context: { install_type: "binary", detected_at: "2026-05-17T11:00:00Z" },
      }) +
      makeRow({
        ts: "2026-05-17T11:58:00.000Z",
        op: "update_apply",
        caller: { kind: "operator" },
        request_id: "req-0",
        result: "started",
        exit_code: null,
        duration_ms: 0,
      });
    writeFileSync(auditPath, lines, "utf-8");
    const entry = readLastTerminalUpdateAudit({ auditLogPath: auditPath, now });
    expect(entry).not.toBeNull();
    expect(entry!.request_id).toBe("req-1");
  });

  it("skips entries outside lookback window", () => {
    const now = Date.parse("2026-05-17T12:00:00.000Z");
    writeFileSync(auditPath, makeRow({
      ts: "2026-05-17T11:00:00.000Z", // 60 minutes ago
      op: "update_apply",
      caller: { kind: "operator" },
      request_id: "stale",
      result: "ok",
      exit_code: 0,
      duration_ms: 1,
      phase: "terminal",
    }), "utf-8");
    expect(readLastTerminalUpdateAudit({ auditLogPath: auditPath, now, lookbackMs: 10 * 60 * 1000 })).toBeNull();
  });

  it("renders success line with channel + short sha", () => {
    const line = renderUpdateOutcomeLine({
      ts: "2026-05-17T11:59:00.000Z",
      op: "update_apply",
      caller: { kind: "operator" },
      request_id: "req-1",
      result: "ok",
      exit_code: 0,
      duration_ms: 100,
      phase: "terminal",
      channel: "dev",
      resolved_sha: { "switchroom-agent": "sha256:abcdef1234567890aaaa" },
    });
    expect(line).toContain("✅ update completed");
    expect(line).toContain("channel:dev");
    expect(line).toContain("sha:abcdef123456");
  });

  it("renders failure line with stderr + recovery hint for binary install", () => {
    const line = renderUpdateOutcomeLine({
      ts: "2026-05-17T11:59:00.000Z",
      op: "update_apply",
      caller: { kind: "operator" },
      request_id: "req-2",
      result: "error",
      exit_code: 1,
      duration_ms: 100,
      phase: "terminal",
      stderr_tail: "compose pull failed: registry timeout",
      install_context: { install_type: "binary", detected_at: "2026-05-17T11:00:00Z" },
    });
    expect(line).toContain("❌ update failed at update_apply");
    expect(line).toContain("compose pull failed");
    expect(line).toContain("Recovery:");
    expect(line).toContain("install.sh");
  });

  it("renders unknown recovery hint when install_type missing", () => {
    const line = renderUpdateOutcomeLine({
      ts: "2026-05-17T11:59:00.000Z",
      op: "update_apply",
      caller: { kind: "operator" },
      request_id: "req-3",
      result: "error",
      exit_code: 1,
      duration_ms: 100,
      phase: "terminal",
    });
    expect(line).toContain("Cannot auto-detect install type");
  });

  it("claimUpdateAnnouncement is atomic — second call returns false", () => {
    expect(claimUpdateAnnouncement("req-abc", { stateDir })).toBe(true);
    expect(claimUpdateAnnouncement("req-abc", { stateDir })).toBe(false);
  });

  it("maybeRenderUpdateAnnouncement dedupes on second call", () => {
    const now = Date.parse("2026-05-17T12:00:00.000Z");
    writeFileSync(auditPath, makeRow({
      ts: "2026-05-17T11:59:00.000Z",
      op: "update_apply",
      caller: { kind: "operator" },
      request_id: "req-dedup",
      result: "ok",
      exit_code: 0,
      duration_ms: 1,
      phase: "terminal",
      channel: "dev",
    }), "utf-8");
    const first = maybeRenderUpdateAnnouncement({ auditLogPath: auditPath, now, stateDir });
    expect(first).not.toBeNull();
    const second = maybeRenderUpdateAnnouncement({ auditLogPath: auditPath, now, stateDir });
    expect(second).toBeNull();
  });
});
