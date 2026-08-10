/**
 * Tests for `scripts/check-foreign-db-readonly.mjs`.
 *
 * The gate's job: fail CI when a FOREIGN process (boot script, CLI, hook)
 * opens a gateway/broker SQLite database READ-WRITE. A read-write handle that
 * closes as the LAST connection checkpoints and UNLINKS the `-wal`/`-shm`
 * sidecars, orphaning any handle still mapped to the old inodes — after which
 * writes succeed into deleted files and vanish at the next restart (#4595).
 *
 * These assert the OUTCOME (does the gate go red on the actual bug shape?),
 * not merely that the script runs: each synthetic fixture is the real
 * regression written back in, one per binding.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const SCRIPT_REL = "scripts/check-foreign-db-readonly.mjs";

function run(cwd: string): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [join(cwd, SCRIPT_REL)], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      ok: false,
      stdout: e.stdout?.toString?.() ?? "",
      stderr: e.stderr?.toString?.() ?? "",
    };
  }
}

/**
 * A throwaway repo containing only the gate + the fixture files. The gate
 * resolves its scan roots relative to the SCRIPT, so copying the script into
 * `<tmp>/scripts/` is what scopes it to the fixtures.
 */
function sandbox(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "foreign-db-ro-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  cpSync(join(REPO, SCRIPT_REL), join(dir, SCRIPT_REL));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

describe("scripts/check-foreign-db-readonly.mjs (#4595 generator gate)", () => {
  it("passes against the live repo (regression gate)", () => {
    const r = run(REPO);
    expect(r.ok, `${r.stdout}\n${r.stderr}`).toBe(true);
    expect(r.stdout).toContain("clean");
  });

  it("fails on the exact bug: python sqlite3.connect(path) in a boot script", () => {
    const dir = sandbox({
      "bin/briefing.sh": [
        "#!/bin/sh",
        "python3 - <<'PY'",
        "import sqlite3",
        "conn = sqlite3.connect(db_path)",
        "PY",
      ].join("\n"),
    });
    try {
      const r = run(dir);
      expect(r.ok).toBe(false);
      expect(r.stderr).toContain("bin/briefing.sh:4");
      expect(r.stderr).toContain("python-sqlite3-connect");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts the mode=ro URI form", () => {
    const dir = sandbox({
      "bin/briefing.sh": [
        "#!/bin/sh",
        "python3 - <<'PY'",
        "import sqlite3",
        'conn = sqlite3.connect("file:" + quote(db_path) + "?mode=ro", uri=True)',
        "PY",
      ].join("\n"),
    });
    try {
      expect(run(dir).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails on bun:sqlite `new Database(p)` without readonly, and passes with it", () => {
    const bad = sandbox({
      "src/cli/x.ts": "const db = new Database(dbPath, { create: false });\n",
    });
    const good = sandbox({
      "src/cli/x.ts":
        "const db = new Database(dbPath, { create: false, readonly: true });\n",
    });
    try {
      const r = run(bad);
      expect(r.ok).toBe(false);
      expect(r.stderr).toContain("bun-sqlite-new-database");
      expect(run(good).ok).toBe(true);
    } finally {
      rmSync(bad, { recursive: true, force: true });
      rmSync(good, { recursive: true, force: true });
    }
  });

  it("fails on node:sqlite `new DatabaseSync(p)` without readOnly", () => {
    const dir = sandbox({
      "telegram-plugin/hooks/h.mjs": "const db = new DatabaseSync(dbPath)\n",
    });
    try {
      const r = run(dir);
      expect(r.ok).toBe(false);
      expect(r.stderr).toContain("node-sqlite-databasesync");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails on a bare `sqlite3` shellout and passes with -readonly, across a multi-line argv", () => {
    const bad = sandbox({
      "src/agents/s.ts": [
        "const out = execFileSync(",
        '  "sqlite3",',
        "  [",
        "    historyDbPath,",
        '    "SELECT role FROM messages",',
        "  ],",
        ");",
      ].join("\n"),
    });
    const good = sandbox({
      "src/agents/s.ts": [
        "const out = execFileSync(",
        '  "sqlite3",',
        "  [",
        '    "-readonly",',
        "    historyDbPath,",
        '    "SELECT role FROM messages",',
        "  ],",
        ");",
      ].join("\n"),
    });
    try {
      const r = run(bad);
      expect(r.ok).toBe(false);
      expect(r.stderr).toContain("sqlite3-cli");
      // The flag sits 2 lines below the matched argv[0] — the window rule is
      // what makes this pass rather than a same-line check.
      expect(run(good).ok).toBe(true);
    } finally {
      rmSync(bad, { recursive: true, force: true });
      rmSync(good, { recursive: true, force: true });
    }
  });

  it("honours a REASONED inline marker but not a bare one", () => {
    const reasoned = sandbox({
      "src/vault/g.ts": [
        "// allow-rw-db-open: the broker OWNS this DB",
        "const db = new Database(dbPath, { create: true });",
      ].join("\n"),
    });
    const bare = sandbox({
      "src/vault/g.ts": [
        "// allow-rw-db-open:",
        "const db = new Database(dbPath, { create: true });",
      ].join("\n"),
    });
    try {
      expect(run(reasoned).ok).toBe(true);
      expect(run(bare).ok).toBe(false);
    } finally {
      rmSync(reasoned, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("does not flag `:memory:` databases (no files, no sidecars)", () => {
    const dir = sandbox({
      "src/x.ts": 'const db = new Database(":memory:");\n',
    });
    try {
      expect(run(dir).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
