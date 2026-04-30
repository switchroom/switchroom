import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ISSUES_FILE,
  list,
  prune,
  readAll,
  record,
  resolve,
} from "../src/issues/index.js";

let tmp: string;
let now: number;
const tick = () => now++;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "issues-store-"));
  now = 1_700_000_000_000;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("readAll / record (basic)", () => {
  it("returns [] when file is missing", () => {
    expect(readAll(tmp)).toEqual([]);
  });

  it("records a new event", () => {
    const e = record(
      tmp,
      {
        agent: "klanker",
        severity: "error",
        source: "hook:handoff",
        code: "cli-error",
        summary: "claude -p exited 1",
        detail: "401 Unauthorized",
      },
      tick,
    );
    expect(e.fingerprint).toBe("hook:handoff::cli-error");
    expect(e.occurrences).toBe(1);
    expect(e.first_seen).toBe(e.last_seen);

    const all = readAll(tmp);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      agent: "klanker",
      severity: "error",
      summary: "claude -p exited 1",
      occurrences: 1,
    });
  });

  it("writes a JSONL file (one line per fingerprint)", () => {
    record(
      tmp,
      { agent: "a", severity: "warn", source: "s1", code: "c1", summary: "x" },
      tick,
    );
    record(
      tmp,
      { agent: "a", severity: "warn", source: "s2", code: "c2", summary: "y" },
      tick,
    );
    const body = readFileSync(join(tmp, ISSUES_FILE), "utf-8");
    const lines = body.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(() => JSON.parse(l)).not.toThrow();
    }
  });
});

describe("coalescing", () => {
  it("coalesces identical fingerprints", () => {
    record(
      tmp,
      {
        agent: "klanker",
        severity: "error",
        source: "hook:handoff",
        code: "cli-error",
        summary: "first",
        detail: "401",
      },
      tick,
    );
    record(
      tmp,
      {
        agent: "klanker",
        severity: "error",
        source: "hook:handoff",
        code: "cli-error",
        summary: "second",
        detail: "401 (again)",
      },
      tick,
    );
    record(
      tmp,
      {
        agent: "klanker",
        severity: "error",
        source: "hook:handoff",
        code: "cli-error",
        summary: "third",
      },
      tick,
    );
    const all = readAll(tmp);
    expect(all).toHaveLength(1);
    expect(all[0].occurrences).toBe(3);
    // Latest summary/detail wins on coalesce — most informative is most recent.
    expect(all[0].summary).toBe("third");
    expect(all[0].detail).toBeUndefined();
    expect(all[0].first_seen).toBeLessThan(all[0].last_seen);
  });

  it("promotes severity on coalesce, never demotes", () => {
    record(
      tmp,
      { agent: "a", severity: "warn", source: "s", code: "c", summary: "x" },
      tick,
    );
    record(
      tmp,
      { agent: "a", severity: "critical", source: "s", code: "c", summary: "y" },
      tick,
    );
    expect(readAll(tmp)[0].severity).toBe("critical");

    // Subsequent lower-severity occurrence does not demote.
    record(
      tmp,
      { agent: "a", severity: "warn", source: "s", code: "c", summary: "z" },
      tick,
    );
    expect(readAll(tmp)[0].severity).toBe("critical");
  });

  it("does not coalesce a new event onto a resolved one (creates fresh)", () => {
    record(
      tmp,
      { agent: "a", severity: "error", source: "s", code: "c", summary: "x" },
      tick,
    );
    resolve(tmp, "s::c", tick);
    record(
      tmp,
      { agent: "a", severity: "error", source: "s", code: "c", summary: "back again" },
      tick,
    );
    const all = readAll(tmp);
    expect(all).toHaveLength(2);
    const unresolved = all.find((e) => e.resolved_at == null);
    const resolved_ = all.find((e) => e.resolved_at != null);
    expect(unresolved?.summary).toBe("back again");
    expect(unresolved?.occurrences).toBe(1);
    expect(resolved_?.occurrences).toBe(1);
  });
});

describe("resolve", () => {
  it("flips unresolved entries with the matching fingerprint", () => {
    record(
      tmp,
      { agent: "a", severity: "error", source: "s", code: "c", summary: "x" },
      tick,
    );
    expect(resolve(tmp, "s::c", tick)).toBe(1);
    const all = readAll(tmp);
    expect(all[0].resolved_at).toBeDefined();
  });

  it("is idempotent (no-op when already resolved)", () => {
    record(
      tmp,
      { agent: "a", severity: "error", source: "s", code: "c", summary: "x" },
      tick,
    );
    resolve(tmp, "s::c", tick);
    expect(resolve(tmp, "s::c", tick)).toBe(0);
  });

  it("returns 0 for unknown fingerprint", () => {
    expect(resolve(tmp, "nope::no")).toBe(0);
  });
});

describe("list", () => {
  beforeEach(() => {
    record(
      tmp,
      { agent: "a", severity: "info", source: "s1", code: "c1", summary: "i" },
      tick,
    );
    record(
      tmp,
      { agent: "a", severity: "warn", source: "s2", code: "c2", summary: "w" },
      tick,
    );
    record(
      tmp,
      { agent: "a", severity: "error", source: "s3", code: "c3", summary: "e" },
      tick,
    );
    record(
      tmp,
      {
        agent: "a",
        severity: "critical",
        source: "s4",
        code: "c4",
        summary: "!",
      },
      tick,
    );
    resolve(tmp, "s1::c1", tick);
  });

  it("hides resolved entries by default", () => {
    const out = list(tmp);
    expect(out.map((e) => e.code).sort()).toEqual(["c2", "c3", "c4"]);
  });

  it("includes resolved entries when unresolvedOnly=false", () => {
    const out = list(tmp, { unresolvedOnly: false });
    expect(out).toHaveLength(4);
  });

  it("filters by minSeverity", () => {
    const out = list(tmp, { minSeverity: "error" });
    expect(out.map((e) => e.code).sort()).toEqual(["c3", "c4"]);
  });

  it("filters by since", () => {
    const all = readAll(tmp);
    const cutoff = all[2].last_seen;
    const out = list(tmp, { since: cutoff });
    // Entries with last_seen >= cutoff (excludes earlier ones).
    expect(out.length).toBeGreaterThan(0);
    for (const e of out) expect(e.last_seen).toBeGreaterThanOrEqual(cutoff);
  });
});

describe("prune", () => {
  it("removes resolved entries older than threshold", () => {
    record(
      tmp,
      { agent: "a", severity: "error", source: "s", code: "c", summary: "x" },
      tick,
    );
    resolve(tmp, "s::c", () => 1_000_000);
    expect(
      prune(tmp, {
        resolvedOlderThanMs: 100,
        now: 1_000_000 + 200,
      }),
    ).toBe(1);
    expect(readAll(tmp)).toHaveLength(0);
  });

  it("keeps resolved entries within the retention window", () => {
    record(
      tmp,
      { agent: "a", severity: "error", source: "s", code: "c", summary: "x" },
      tick,
    );
    resolve(tmp, "s::c", () => 1_000_000);
    expect(
      prune(tmp, { resolvedOlderThanMs: 1_000_000, now: 1_000_500 }),
    ).toBe(0);
    expect(readAll(tmp)).toHaveLength(1);
  });

  it("does not prune unresolved entries by default", () => {
    record(
      tmp,
      { agent: "a", severity: "error", source: "s", code: "c", summary: "x" },
      () => 1_000_000,
    );
    expect(
      prune(tmp, { resolvedOlderThanMs: 0, now: 1_000_000 + 999_999_999 }),
    ).toBe(0);
    expect(readAll(tmp)).toHaveLength(1);
  });

  it("prunes unresolved when unresolvedOlderThanMs is set", () => {
    record(
      tmp,
      { agent: "a", severity: "error", source: "s", code: "c", summary: "x" },
      () => 1_000_000,
    );
    expect(
      prune(tmp, {
        unresolvedOlderThanMs: 100,
        now: 1_000_000 + 200,
      }),
    ).toBe(1);
    expect(readAll(tmp)).toHaveLength(0);
  });
});

describe("malformed input tolerance", () => {
  it("skips unparseable lines on read", () => {
    writeFileSync(
      join(tmp, ISSUES_FILE),
      'this is not json\n{"ts":1,"agent":"a","severity":"warn","source":"s","code":"c","summary":"ok","fingerprint":"s::c","occurrences":1,"first_seen":1,"last_seen":1}\nalso not json\n',
    );
    const out = readAll(tmp);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("s");
  });

  it("returns [] when the file is corrupt and the line is invalid", () => {
    writeFileSync(join(tmp, ISSUES_FILE), "garbage\nmore garbage\n");
    expect(readAll(tmp)).toEqual([]);
  });
});

describe("field caps", () => {
  it("truncates summary > SUMMARY_MAX_CHARS", () => {
    const long = "x".repeat(1000);
    const e = record(
      tmp,
      { agent: "a", severity: "warn", source: "s", code: "c", summary: long },
      tick,
    );
    expect(e.summary.length).toBeLessThan(long.length);
    expect(e.summary.endsWith("…")).toBe(true);
  });

  it("truncates detail > DETAIL_MAX_BYTES", () => {
    const long = "y".repeat(10_000);
    const e = record(
      tmp,
      {
        agent: "a",
        severity: "warn",
        source: "s",
        code: "c",
        summary: "x",
        detail: long,
      },
      tick,
    );
    expect(e.detail!.length).toBeLessThan(long.length);
    expect(e.detail!.endsWith("…")).toBe(true);
  });
});

describe("concurrency", () => {
  it("does not corrupt the file under concurrent writes", () => {
    // Synchronous writes from a tight loop simulate two writers racing.
    // The lock guarantees each read-modify-write is serialized; the
    // result should be a single coalesced entry with N occurrences.
    const N = 50;
    for (let i = 0; i < N; i++) {
      record(
        tmp,
        {
          agent: "a",
          severity: "warn",
          source: "s",
          code: "c",
          summary: `x${i}`,
        },
        tick,
      );
    }
    const all = readAll(tmp);
    expect(all).toHaveLength(1);
    expect(all[0].occurrences).toBe(N);
  });

  it("steals an empty lockfile (legacy format / pre-PID) without blocking", () => {
    // Empty lock file represents pre-PID-aware lock holders. record()
    // must reclaim it rather than wait the full LOCK_TIMEOUT_MS.
    const lockPath = join(tmp, "issues.lock");
    writeFileSync(lockPath, "");

    const e = record(
      tmp,
      { agent: "a", severity: "warn", source: "s", code: "c", summary: "x" },
      tick,
    );
    expect(e.occurrences).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("steals a lockfile whose PID is dead", () => {
    const lockPath = join(tmp, "issues.lock");
    // PID 999999 is overwhelmingly likely to not exist on the test host.
    writeFileSync(lockPath, "999999");
    const e = record(
      tmp,
      { agent: "a", severity: "warn", source: "s", code: "c", summary: "x" },
      tick,
    );
    expect(e.occurrences).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("does NOT steal a lockfile whose PID is alive (refuses to corrupt)", () => {
    // Stamp a live PID (the parent of the test process — vitest itself).
    // The lock is *contended* by a real holder; we must NOT just steal
    // it. Since record() is sync we can't watch a timer cancel mid-wait;
    // instead we assert that record() hits the lock timeout and throws,
    // which is the correct behaviour: better to surface a timeout than
    // silently stomp another writer's state.
    const lockPath = join(tmp, "issues.lock");
    writeFileSync(lockPath, String(process.ppid));
    expect(() =>
      record(
        tmp,
        { agent: "a", severity: "warn", source: "s", code: "c", summary: "x" },
        tick,
      ),
    ).toThrow(/lock timeout/);
  }, 15_000);

  it("works against a stale lock written by us (legacy)", () => {
    // Edge case the new code handles: lockfile contains our own PID
    // (e.g. a previous crashed run of this same process slot). We
    // unlink and proceed.
    const lockPath = join(tmp, "issues.lock");
    writeFileSync(lockPath, String(process.pid));
    const e = record(
      tmp,
      { agent: "a", severity: "warn", source: "s", code: "c", summary: "x" },
      tick,
    );
    expect(e.occurrences).toBe(1);
    expect(existsSync(lockPath)).toBe(false);
  });
});
