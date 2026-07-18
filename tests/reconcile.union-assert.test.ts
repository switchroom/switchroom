/**
 * #3333 stage 3 — widened UNION assert (amendment B).
 *
 * The post-sweep readability assert must be the UNION of:
 *   - the static scoped candidate set (derived from the same scope constants
 *     the sweep uses, so scope-of-sweep == scope-of-assert), and
 *   - this run's dynamic `changes` list (touched-but-out-of-scope files).
 *
 * It must NEVER replace the `changes` term with a static set — that would
 * narrow today's coverage of touched files outside the static names.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findAgentUnreadablePaths,
  scopedAssertCandidates,
  SCOPED_TOP_LEVEL_CRITICAL,
} from "../src/agents/agent-owned-tree.js";
import { allocateAgentUid } from "../src/agents/agent-uid.js";

describe("scopedAssertCandidates (#3333 stage 3)", () => {
  it("includes the settings/mcp critical files and the leak-list top-level files", () => {
    const dir = "/agents/x";
    const cands = scopedAssertCandidates(dir);
    expect(cands).toContain(join(dir, ".claude", "settings.json"));
    expect(cands).toContain(join(dir, ".claude-cron", ".mcp.json"));
    // finding-1 leak-list entries are now asserted candidates
    expect(cands).toContain(join(dir, "cron-session.sh"));
    expect(cands).toContain(join(dir, ".resume-mode-migration-warned"));
    expect(cands).toContain(join(dir, "CLAUDE.md"));
    expect(cands).toContain(join(dir, "start.sh"));
    expect(cands).toContain(join(dir, ".mcp.json"));
    // derived from the shared constant
    for (const f of SCOPED_TOP_LEVEL_CRITICAL) {
      expect(cands).toContain(join(dir, f));
    }
  });
});

describe("union assert coverage (#3333 stage 3, amendment B)", () => {
  const foreignUid = allocateAgentUid("union-agent"); // never the test process uid
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "switchroom-union-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("catches a leak-list top-level file left root-owned 0600 (static term)", () => {
    const cron = join(dir, "cron-session.sh");
    writeFileSync(cron, "#!/bin/sh\n", { mode: 0o600 });
    chmodSync(cron, 0o600); // umask-proof; owner-only, foreign uid
    const bad = findAgentUnreadablePaths(scopedAssertCandidates(dir), foreignUid);
    expect(bad).toContain(cron);
  });

  it("catches a touched-but-out-of-scope file present ONLY in the changes term", () => {
    // A file the static set does not name, but reconcile pushed to `changes`.
    const touched = join(dir, "novel-top-level-file");
    writeFileSync(touched, "x", { mode: 0o600 });
    chmodSync(touched, 0o600);

    // Replicate the scaffold union: static ∪ changes.
    const changes = [touched];
    const critical = [
      ...new Set([...scopedAssertCandidates(dir), ...changes]),
    ];
    const bad = findAgentUnreadablePaths(critical, foreignUid);
    expect(bad).toContain(touched); // dropped if `changes` term were removed

    // And with the changes term REMOVED it would be missed — pin the regression.
    const staticOnly = findAgentUnreadablePaths(scopedAssertCandidates(dir), foreignUid);
    expect(staticOnly).not.toContain(touched);
  });

  it("dedups a file present in both terms", () => {
    const settings = join(dir, ".claude", "settings.json");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(settings, "{}", { mode: 0o600 });
    chmodSync(settings, 0o600);
    const changes = [settings]; // also in the static set
    const critical = [
      ...new Set([...scopedAssertCandidates(dir), ...changes]),
    ];
    const bad = findAgentUnreadablePaths(critical, foreignUid);
    expect(bad.filter((p) => p === settings)).toHaveLength(1);
  });
});
