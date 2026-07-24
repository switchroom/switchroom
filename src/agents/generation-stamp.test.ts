/**
 * KEN-130 — generation stamp: the hash anchor for template-surface drift
 * detection. Outcome-asserting: each test stages a real agent-dir state
 * and asserts the named finding (or its absence), not just code paths.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CLAUDE_MD_YOURS_MARKER,
  computeConfigHash,
  computeStampFilesFromDisk,
  detectStampDrift,
  hashManagedClaudeMd,
  readGenerationStamp,
  stableStringify,
  writeGenerationStamp,
} from "./generation-stamp.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stamp-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedAgentDir(): void {
  writeFileSync(join(dir, "start.sh"), "#!/bin/bash\necho hi\n");
  writeFileSync(
    join(dir, "CLAUDE.md"),
    `# Agent\nmanaged text\n\n${CLAUDE_MD_YOURS_MARKER}\n\noperator text\n`,
  );
  writeFileSync(join(dir, ".mcp.json"), '{"mcpServers":{}}\n');
}

function stampNow(config: unknown = { model: "opus" }, version = "1.0.0"): void {
  writeGenerationStamp(dir, {
    switchroomVersion: version,
    configHash: computeConfigHash(config),
    files: computeStampFilesFromDisk(dir),
  });
}

describe("stableStringify / computeConfigHash", () => {
  it("is key-order independent at every level", () => {
    const a = { b: 1, a: { z: 2, y: [1, 2] } };
    const b = { a: { y: [1, 2], z: 2 }, b: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(computeConfigHash(a)).toBe(computeConfigHash(b));
  });

  it("differs when values differ", () => {
    expect(computeConfigHash({ m: 1 })).not.toBe(computeConfigHash({ m: 2 }));
  });
});

describe("hashManagedClaudeMd", () => {
  it("ignores operator edits below the Yours marker", () => {
    const managed = `top\n${CLAUDE_MD_YOURS_MARKER}`;
    expect(hashManagedClaudeMd(`${managed}\nfoo`)).toBe(
      hashManagedClaudeMd(`${managed}\ntotally different operator section`),
    );
  });

  it("changes when the managed section changes", () => {
    expect(hashManagedClaudeMd(`a\n${CLAUDE_MD_YOURS_MARKER}\nx`)).not.toBe(
      hashManagedClaudeMd(`b\n${CLAUDE_MD_YOURS_MARKER}\nx`),
    );
  });
});

describe("detectStampDrift", () => {
  it("clean agent dir → no findings", () => {
    seedAgentDir();
    stampNow();
    const r = detectStampDrift(dir, {
      currentConfigHash: computeConfigHash({ model: "opus" }),
      currentVersion: "1.0.0",
    });
    expect(r.hasStamp).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it("no stamp → hasStamp false and zero findings (never false-drift)", () => {
    seedAgentDir();
    const r = detectStampDrift(dir);
    expect(r.hasStamp).toBe(false);
    expect(r.findings).toEqual([]);
  });

  it("edited start.sh → finding named start.sh", () => {
    seedAgentDir();
    stampNow();
    writeFileSync(join(dir, "start.sh"), "#!/bin/bash\necho TAMPERED\n");
    const r = detectStampDrift(dir);
    expect(r.findings.map((f) => f.surface)).toEqual(["start.sh"]);
    expect(r.findings[0].detail).toMatch(/modified since last apply/);
  });

  it("edited managed CLAUDE.md section → finding; below-marker edit → none", () => {
    seedAgentDir();
    stampNow();
    // Below-marker edit: operator-owned, must NOT drift.
    writeFileSync(
      join(dir, "CLAUDE.md"),
      `# Agent\nmanaged text\n\n${CLAUDE_MD_YOURS_MARKER}\n\nNEW operator prose\n`,
    );
    expect(detectStampDrift(dir).findings).toEqual([]);
    // Managed edit: must drift, named.
    writeFileSync(
      join(dir, "CLAUDE.md"),
      `# Agent\nTAMPERED managed\n\n${CLAUDE_MD_YOURS_MARKER}\n\nNEW operator prose\n`,
    );
    expect(detectStampDrift(dir).findings.map((f) => f.surface)).toEqual([
      "CLAUDE.md",
    ]);
  });

  it("edited .mcp.json → finding named .mcp.json", () => {
    seedAgentDir();
    stampNow();
    writeFileSync(join(dir, ".mcp.json"), '{"mcpServers":{"evil":{}}}\n');
    expect(detectStampDrift(dir).findings.map((f) => f.surface)).toEqual([
      ".mcp.json",
    ]);
  });

  it("deleted stamped file → 'missing' finding", () => {
    seedAgentDir();
    stampNow();
    rmSync(join(dir, "start.sh"));
    const r = detectStampDrift(dir);
    expect(r.findings).toEqual([
      { surface: "start.sh", detail: "missing (was present at last apply)" },
    ]);
  });

  it("config changed since apply → 'config' finding", () => {
    seedAgentDir();
    stampNow({ model: "opus" });
    const r = detectStampDrift(dir, {
      currentConfigHash: computeConfigHash({ model: "sonnet" }),
    });
    expect(r.findings.map((f) => f.surface)).toEqual(["config"]);
  });

  it("switchroom updated since apply → 'version' finding naming both versions", () => {
    seedAgentDir();
    stampNow({ model: "opus" }, "1.0.0");
    const r = detectStampDrift(dir, { currentVersion: "1.1.0" });
    expect(r.findings.map((f) => f.surface)).toEqual(["version"]);
    expect(r.findings[0].detail).toContain("1.0.0");
    expect(r.findings[0].detail).toContain("1.1.0");
  });

  it("stamp with files:null (partial write) reads as no-stamp, never crashes", () => {
    seedAgentDir();
    writeFileSync(
      join(dir, ".switchroom-generated.json"),
      '{"version":1,"generatedAt":"2026-01-01T00:00:00Z","switchroomVersion":"1.0.0","configHash":"x","files":null}',
    );
    const r = detectStampDrift(dir, { currentVersion: "9.9.9" });
    expect(r.hasStamp).toBe(false);
    expect(r.findings).toEqual([]);
    expect(readGenerationStamp(dir)).toBeNull();
  });

  it("stamp with files as an array reads as no-stamp", () => {
    seedAgentDir();
    writeFileSync(
      join(dir, ".switchroom-generated.json"),
      '{"version":1,"switchroomVersion":"1.0.0","configHash":"x","files":[]}',
    );
    expect(detectStampDrift(dir).hasStamp).toBe(false);
  });

  it("corrupt stamp file reads as no-stamp, not drift", () => {
    seedAgentDir();
    writeFileSync(join(dir, ".switchroom-generated.json"), "not json");
    const r = detectStampDrift(dir);
    expect(r.hasStamp).toBe(false);
    expect(r.findings).toEqual([]);
    expect(readGenerationStamp(dir)).toBeNull();
  });
});
