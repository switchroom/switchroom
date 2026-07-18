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
import { execFileSync } from "node:child_process";
import {
  findAgentUnreadablePaths,
  ownershipRuntime,
  scopedAssertCandidates,
  SCOPED_TOP_LEVEL_CRITICAL,
} from "../src/agents/agent-owned-tree.js";
import { allocateAgentUid } from "../src/agents/agent-uid.js";
import { reconcileAgent, scaffoldAgent } from "../src/agents/scaffold.js";
import type {
  AgentConfig,
  SwitchroomConfig,
  TelegramConfig,
} from "../src/config/schema.js";

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

describe("union assert at the REAL call site — reconcileAgent (#3363 review fix 1)", () => {
  // The inline-union tests above replicate the scaffold expression; a
  // regression that drops the `changes` term AT THE CALL SITE
  // (scaffold.ts's post-sweep `critical` construction) would still pass
  // them. This drives the real path end-to-end:
  //
  //   1. scaffold an agent WITH a subagent → `.claude/agents/helper.md`
  //      exists — a file NOT named by scopedAssertCandidates
  //   2. tamper it on disk so the next reconcile detects a diff, rewrites
  //      it, and pushes it to `changes`
  //   3. run reconcile as fake-root with a sweep stub that makes the tree
  //      readable EXCEPT that one file (left 0600, foreign-to-agent-uid —
  //      the #3168 poison shape)
  //   4. reconcile MUST throw naming helper.md — it is only reachable via
  //      the dynamic `changes` term of the union. Drop the union → green
  //      reconcile → this test fails.
  const AGENT = "union-real-agent";
  const telegramConfig: TelegramConfig = {
    bot_token: "123456:ABC-DEF",
    forum_chat_id: "-1001234567890",
  };
  const switchroomConfig: SwitchroomConfig = {
    agents: {},
    telegram: telegramConfig,
    defaults: {},
  };
  const config = {
    extends: "default",
    topic_name: "Union Real",
    schedule: [],
    subagents: {
      helper: { description: "test helper", prompt: "You help." },
    },
  } as unknown as AgentConfig;

  const realGeteuid = ownershipRuntime.geteuid;
  const realChownTree = ownershipRuntime.chownTree;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-union-real-"));
  });

  afterEach(() => {
    ownershipRuntime.geteuid = realGeteuid;
    ownershipRuntime.chownTree = realChownTree;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fails reconcile when a changes-tracked file OUTSIDE the static set is left unreadable", () => {
    const { agentDir } = scaffoldAgent(AGENT, config, tmpDir, telegramConfig);
    const helperMd = join(agentDir, ".claude", "agents", "helper.md");
    // Sanity: the file exists and the static set does NOT name it — the
    // ONLY route into the assert is the dynamic `changes` union.
    writeFileSync(helperMd, "tampered — reconcile must rewrite me");
    expect(scopedAssertCandidates(agentDir)).not.toContain(helperMd);

    ownershipRuntime.geteuid = () => 0;
    ownershipRuntime.chownTree = (_uid, _gid, rootDir) => {
      // Sweep stand-in: make everything agent-readable EXCEPT the
      // changes-tracked helper.md, which stays owner-only under a uid
      // foreign to the agent's 10001+ — the incident combination.
      execFileSync("chmod", ["-R", "a+rX", rootDir]);
      chmodSync(helperMd, 0o600);
    };

    // Single invocation (a second reconcile would find helper.md already
    // regenerated and push nothing): capture the one thrown error and
    // assert both the loud-assert shape and the culprit file.
    let thrown: Error | null = null;
    try {
      reconcileAgent(AGENT, config, tmpDir, telegramConfig, switchroomConfig);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toMatch(/agent-unreadable files/);
    expect(thrown!.message).toMatch(/helper\.md/);
  });
});
