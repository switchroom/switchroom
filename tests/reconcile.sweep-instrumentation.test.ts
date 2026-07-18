/**
 * #3333 stage 1 — instrumentation for the reconcile ownership sweep.
 *
 * The scoped-sweep work (stage 2+) narrows the chown from the full ~620k-inode
 * agent tree to the ~5k state dirs. Before flipping that on, stage 1 adds pure
 * observation (elapsed time + inode count) so a real roll can validate the
 * scoping thesis. These tests pin that the instrumentation:
 *   - reads the inode count via the injectable seam (so it's measured, not guessed)
 *   - times the sweep and logs it
 *   - NEVER changes sweep behaviour, even when the count itself fails
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  alignAgentTreeOwnershipIfRoot,
  ownershipRuntime,
} from "../src/agents/agent-owned-tree.js";
import { allocateAgentUid } from "../src/agents/agent-uid.js";

const AGENT = "instr-agent";

const realGeteuid = ownershipRuntime.geteuid;
const realChownTree = ownershipRuntime.chownTree;
const realNow = ownershipRuntime.now;
const realCountInodes = ownershipRuntime.countInodes;

describe("ownership sweep instrumentation (#3333 stage 1)", () => {
  afterEach(() => {
    ownershipRuntime.geteuid = realGeteuid;
    ownershipRuntime.chownTree = realChownTree;
    ownershipRuntime.now = realNow;
    ownershipRuntime.countInodes = realCountInodes;
    vi.restoreAllMocks();
  });

  it("counts inodes and logs elapsed time around the sweep", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchroom-instr-"));
    try {
      ownershipRuntime.geteuid = () => 0;
      ownershipRuntime.chownTree = () => {};
      ownershipRuntime.countInodes = () => 4242;
      let t = 1000;
      ownershipRuntime.now = () => (t += 7); // first call 1007, second 1014 → 7ms
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      const uid = alignAgentTreeOwnershipIfRoot(AGENT, dir);

      expect(uid).toBe(allocateAgentUid(AGENT));
      const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes("[ownership-sweep]"));
      expect(line).toBeDefined();
      expect(line).toContain("inodes=4242");
      expect(line).toContain("elapsedMs=7");
      expect(line).toContain(`agent=${AGENT}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still sweeps (behaviour unchanged) when inode counting fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchroom-instr-"));
    try {
      const calls: string[] = [];
      ownershipRuntime.geteuid = () => 0;
      ownershipRuntime.chownTree = (_u, _g, d) => calls.push(d);
      ownershipRuntime.countInodes = () => null; // count failed
      vi.spyOn(console, "log").mockImplementation(() => {});

      expect(alignAgentTreeOwnershipIfRoot(AGENT, dir)).toBe(allocateAgentUid(AGENT));
      expect(calls).toEqual([dir]); // sweep ran exactly as before
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("real countInodes returns a positive count for a populated dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchroom-instr-"));
    try {
      const n = ownershipRuntime.countInodes(dir);
      expect(n).not.toBeNull();
      expect(n as number).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
