/**
 * #3600 review — findings 4, 5, 6 on the seam-aware reader.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  readAuditRaw,
  auditReadMaxGenerations,
  AUDIT_READ_FULL_WINDOW_BYTES,
} from "./audit-reader.js";
import { DEFAULT_HOSTD_AUDIT_MAX_FILES } from "./audit-rotation-config.js";

let dir: string;
let log: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-seam-"));
  log = path.join(dir, "host-control-audit.log");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.SWITCHROOM_HOSTD_AUDIT_MAX_FILES;
});

describe("readAuditRaw — I/O errors vs absence (finding 4)", () => {
  it("returns '' for a MISSING log in both modes (absence is not an error)", () => {
    expect(readAuditRaw(log)).toBe("");
    expect(readAuditRaw(log, { strict: true })).toBe("");
  });

  it("strict THROWS on a real I/O failure instead of reporting emptiness", () => {
    // A directory at the log path fails open(2) with EISDIR — a real I/O
    // error that is not ENOENT, and (unlike chmod 000) it still fails for
    // uid 0, so this holds in root containers too.
    fs.mkdirSync(log);
    expect(() => readAuditRaw(log, { strict: true })).toThrow();
    // Non-strict keeps the old best-effort behaviour.
    expect(readAuditRaw(log)).toBe("");
  });
});

describe("readAuditRaw — generation walk (finding 5)", () => {
  it("an EMPTY .1 does not stop the walk to .2 / .3", () => {
    fs.writeFileSync(`${log}.3`, "row-oldest\n");
    fs.writeFileSync(`${log}.2`, "row-older\n");
    fs.writeFileSync(`${log}.1`, ""); // crashed/raced rotation
    fs.writeFileSync(log, "row-newest\n");

    const raw = readAuditRaw(log);
    expect(raw).toContain("row-oldest");
    expect(raw).toContain("row-older");
    expect(raw).toContain("row-newest");
    // Oldest-first ordering preserved.
    expect(raw.indexOf("row-oldest")).toBeLessThan(raw.indexOf("row-older"));
    expect(raw.indexOf("row-older")).toBeLessThan(raw.indexOf("row-newest"));
  });

  it("an ABSENT generation ends the walk (rotation shifts contiguously)", () => {
    fs.writeFileSync(`${log}.3`, "unreachable\n");
    // no .2 → nothing older than .1 is claimed to exist
    fs.writeFileSync(`${log}.1`, "row-1\n");
    fs.writeFileSync(log, "row-active\n");
    const raw = readAuditRaw(log);
    expect(raw).toContain("row-1");
    expect(raw).toContain("row-active");
    expect(raw).not.toContain("unreachable");
  });
});

describe("auditReadMaxGenerations — no hand-mirrored constant (finding 6)", () => {
  it("defaults to the writer's retention", () => {
    expect(auditReadMaxGenerations()).toBe(DEFAULT_HOSTD_AUDIT_MAX_FILES);
  });

  it("follows SWITCHROOM_HOSTD_AUDIT_MAX_FILES so the reader can't lag the writer", () => {
    process.env.SWITCHROOM_HOSTD_AUDIT_MAX_FILES = "6";
    expect(auditReadMaxGenerations()).toBe(6);
    // A 6th generation written under that setting is actually read.
    for (let n = 1; n <= 6; n++) fs.writeFileSync(`${log}.${n}`, `gen-${n}\n`);
    fs.writeFileSync(log, "active\n");
    const raw = readAuditRaw(log);
    expect(raw).toContain("gen-6");
    expect(raw).toContain("active");
  });
});

describe("AUDIT_READ_FULL_WINDOW_BYTES (finding 3)", () => {
  it("reaches rows the default 4 MiB tail window would drop", () => {
    const marker = '{"marker":"oldest"}\n';
    // 5 MiB of noise after the marker pushes it out of the default window.
    fs.writeFileSync(log, marker + "n".repeat(5 * 1024 * 1024) + "\n");
    expect(readAuditRaw(log)).not.toContain("oldest");
    expect(
      readAuditRaw(log, { windowBytes: AUDIT_READ_FULL_WINDOW_BYTES }),
    ).toContain("oldest");
  });
});
