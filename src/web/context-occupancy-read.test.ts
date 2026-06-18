import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readContextOccupancy } from "./api.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ctx-read-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeSnap(name: string, body: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "context-occupancy.json"), body);
}

describe("readContextOccupancy", () => {
  it("reads a valid snapshot from <agentsDir>/<name>/context-occupancy.json", () => {
    writeSnap("marko", JSON.stringify({ occupancy: 250000, cap: 300000, headroom: 50000, pct: 0.833, state: "tight", computedAt: 1 }));
    const s = readContextOccupancy(dir, "marko");
    expect(s).toMatchObject({ occupancy: 250000, cap: 300000, state: "tight" });
  });

  it("returns null when the snapshot is absent (agent idle since boot)", () => {
    expect(readContextOccupancy(dir, "clerk")).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    writeSnap("clerk", "{not json");
    expect(readContextOccupancy(dir, "clerk")).toBeNull();
  });

  it("returns null when occupancy isn't a number (shape guard)", () => {
    writeSnap("clerk", JSON.stringify({ cap: 300000 }));
    expect(readContextOccupancy(dir, "clerk")).toBeNull();
  });
});
