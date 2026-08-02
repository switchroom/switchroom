import { describe, it, expect } from "vitest";
import { createDedupStore, type DedupFsLike } from "./dedup.js";

/** In-memory fake filesystem implementing DedupFsLike. Shared across store
 *  instances to simulate a sidecar restart against the same journal. */
function makeFakeFs(): DedupFsLike & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const fdPaths = new Map<number, string>();
  let nextFd = 3;
  return {
    files,
    dirs,
    existsSync: (p) => files.has(p) || dirs.has(p),
    mkdirSync: (p) => { dirs.add(p); },
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT ${p}`);
      return files.get(p)!;
    },
    writeFileSync: (p, data) => { files.set(p, data); },
    renameSync: (from, to) => {
      files.set(to, files.get(from) ?? "");
      files.delete(from);
    },
    openSync: (p) => {
      if (!files.has(p)) files.set(p, "");
      const fd = nextFd++;
      fdPaths.set(fd, p);
      return fd;
    },
    writeSync: (fd, data) => {
      const p = fdPaths.get(fd)!;
      files.set(p, (files.get(p) ?? "") + data);
    },
    fsyncSync: () => { /* no-op */ },
    closeSync: (fd) => { fdPaths.delete(fd); },
  };
}

const JP = "/state/buzz/journal.jsonl";

describe("createDedupStore", () => {
  it("records and recalls ids", () => {
    const fs = makeFakeFs();
    const store = createDedupStore({ journalPath: JP, fs });
    expect(store.has("aaa")).toBe(false);
    store.record("aaa");
    expect(store.has("aaa")).toBe(true);
    expect(store.size()).toBe(1);
    store.close();
  });

  it("is idempotent — recording the same id twice writes one journal line", () => {
    const fs = makeFakeFs();
    const store = createDedupStore({ journalPath: JP, fs });
    store.record("dup");
    store.record("dup");
    store.close();
    const lines = (fs.files.get(JP) ?? "").split("\n").filter((l) => l.trim());
    expect(lines).toEqual([JSON.stringify({ id: "dup" })]);
  });

  it("persists across a simulated restart (same journal → id still known)", () => {
    const fs = makeFakeFs();
    const s1 = createDedupStore({ journalPath: JP, fs });
    s1.record("evt-1");
    s1.record("evt-2");
    s1.close();

    const s2 = createDedupStore({ journalPath: JP, fs });
    expect(s2.has("evt-1")).toBe(true);
    expect(s2.has("evt-2")).toBe(true);
    expect(s2.has("evt-3")).toBe(false);
    s2.close();
  });

  it("evicts the oldest id past capacity (LRU bound)", () => {
    const fs = makeFakeFs();
    const store = createDedupStore({ journalPath: JP, fs, capacity: 2 });
    store.record("a");
    store.record("b");
    store.record("c"); // evicts 'a'
    expect(store.has("a")).toBe(false);
    expect(store.has("b")).toBe(true);
    expect(store.has("c")).toBe(true);
    store.close();
  });

  it("compacts to capacity on boot and tolerates a torn final line", () => {
    const fs = makeFakeFs();
    // Pre-seed a journal with 3 ids plus a torn (unparseable) trailing line.
    fs.files.set(
      JP,
      [JSON.stringify({ id: "x1" }), JSON.stringify({ id: "x2" }), JSON.stringify({ id: "x3" }), "{ id: \"torn"].join("\n") + "\n",
    );
    const store = createDedupStore({ journalPath: JP, fs, capacity: 2 });
    // Compaction keeps only the last 2 valid ids.
    expect(store.has("x1")).toBe(false);
    expect(store.has("x2")).toBe(true);
    expect(store.has("x3")).toBe(true);
    // The journal was rewritten compacted (2 lines, no torn line).
    const lines = (fs.files.get(JP) ?? "").split("\n").filter((l) => l.trim());
    expect(lines.length).toBe(2);
    store.close();
  });
});
