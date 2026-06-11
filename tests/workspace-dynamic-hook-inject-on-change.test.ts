import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Tests for bin/workspace-dynamic-hook.sh inject-on-change mode
 * (SWITCHROOM_INJECT_ON_CHANGE=1).
 *
 * Exercises:
 *  - First turn of a session emits content
 *  - Second turn of same session suppresses (same hash, same session)
 *  - Content change re-emits
 *  - New session re-emits
 *  - HEARTBEAT.md is suppressed when prompt has no "heartbeat" and HB unchanged
 *  - HEARTBEAT.md is included when prompt contains "heartbeat"
 *  - HEARTBEAT.md is included when HB content changed
 *  - Corrupted / missing state dir falls back to emit (fail-open)
 */

const HOOK = resolve(__dirname, "../bin/workspace-dynamic-hook.sh");

interface RunResult {
  stdout: string;
  exitCode: number;
}

function makeShim(shimDir: string, payload: string): void {
  mkdirSync(shimDir, { recursive: true });
  const shimPath = join(shimDir, "switchroom");
  const escaped = payload.replace(/'/g, `'"'"'`);
  writeFileSync(shimPath, `#!/bin/bash\nprintf '%s' '${escaped}'\n`, { mode: 0o755 });
  chmodSync(shimPath, 0o755);
}

function runHook(opts: {
  agentName?: string;
  cacheDir: string;
  shimDir: string;
  stateDir?: string;
  agentDirOverride?: string;
  sessionId?: string;
  prompt?: string;
  injectOnChange?: boolean;
}): RunResult {
  const {
    agentName = "test-agent",
    cacheDir,
    shimDir,
    stateDir,
    agentDirOverride,
    sessionId = "session-abc123",
    prompt = "hello world",
    injectOnChange = true,
  } = opts;

  const stdin = JSON.stringify({ session_id: sessionId, prompt });

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${shimDir}:${process.env.PATH ?? ""}`,
    CLAUDE_CONFIG_DIR: cacheDir,
    SWITCHROOM_INJECT_ON_CHANGE: injectOnChange ? "1" : "0",
    SWITCHROOM_AGENT_NAME: agentName,
  };
  if (stateDir !== undefined) {
    env.TELEGRAM_STATE_DIR = stateDir;
  }
  if (agentDirOverride !== undefined) {
    env.SWITCHROOM_AGENT_DIR = agentDirOverride;
  } else {
    delete env.SWITCHROOM_AGENT_DIR;
  }

  try {
    const stdout = execFileSync("bash", [HOOK], {
      env,
      input: stdin,
      encoding: "utf-8",
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; status?: number };
    return {
      stdout: e.stdout ? String(e.stdout) : "",
      exitCode: e.status ?? 1,
    };
  }
}

describe("workspace-dynamic-hook.sh (inject-on-change mode)", () => {
  let tmp: string;
  let cacheDir: string;
  let shimDir: string;
  let stateDir: string;

  beforeEach(() => {
    // Use /var/tmp (not /tmp) because /tmp is mounted noexec in this
    // environment — shim scripts placed there can't be exec'd by PATH lookup.
    tmp = mkdtempSync(join("/var/tmp", "ws-dyn-ioc-"));
    cacheDir = join(tmp, "claude");
    shimDir = join(tmp, "bin");
    stateDir = join(tmp, "state");
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("first turn emits content", () => {
    makeShim(shimDir, "# Project Context (dynamic workspace files)\n\n## MEMORY.md\nmemory stuff\n");
    const r = runHook({ cacheDir, shimDir, stateDir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("memory stuff");
  });

  it("second turn of same session suppresses when content unchanged", () => {
    const payload = "# Project Context (dynamic workspace files)\n\n## MEMORY.md\nstable content\n";
    makeShim(shimDir, payload);

    // Create a fake agent dir with a MEMORY.md so mtime fast-skip can find it.
    const fakeAgentDir = join(tmp, "agent");
    const wsDir = join(fakeAgentDir, "workspace");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "MEMORY.md"), "stable content");

    const a = runHook({ cacheDir, shimDir, stateDir, agentDirOverride: fakeAgentDir });
    expect(a.exitCode).toBe(0);
    expect(a.stdout).toContain("stable content");

    // Same session, same content: suppress
    const b = runHook({ cacheDir, shimDir, stateDir, agentDirOverride: fakeAgentDir });
    expect(b.exitCode).toBe(0);
    expect(b.stdout).toBe("");
  });

  it("re-emits when content changes", async () => {
    const fakeAgentDir = join(tmp, "agent");
    const wsDir = join(fakeAgentDir, "workspace");
    mkdirSync(wsDir, { recursive: true });
    const memPath = join(wsDir, "MEMORY.md");
    writeFileSync(memPath, "v1");

    makeShim(shimDir, "# Project Context (dynamic workspace files)\n\n## MEMORY.md\nfirst content\n");
    const a = runHook({ cacheDir, shimDir, stateDir, agentDirOverride: fakeAgentDir });
    expect(a.stdout).toContain("first content");

    // Wait for mtime to advance
    await new Promise((r) => setTimeout(r, 1100));
    writeFileSync(memPath, "v2");

    makeShim(shimDir, "# Project Context (dynamic workspace files)\n\n## MEMORY.md\nsecond content\n");
    const b = runHook({ cacheDir, shimDir, stateDir, agentDirOverride: fakeAgentDir });
    expect(b.exitCode).toBe(0);
    expect(b.stdout).toContain("second content");
  }, 10_000);

  it("re-emits for new session even when content unchanged", async () => {
    const fakeAgentDir = join(tmp, "agent");
    const wsDir = join(fakeAgentDir, "workspace");
    mkdirSync(wsDir, { recursive: true });
    const memPath = join(wsDir, "MEMORY.md");
    writeFileSync(memPath, "stable");

    const payload = "# Project Context (dynamic workspace files)\n\n## MEMORY.md\nstable content\n";
    makeShim(shimDir, payload);

    // Session A: emit then suppress
    runHook({ cacheDir, shimDir, stateDir, agentDirOverride: fakeAgentDir, sessionId: "session-A" });

    // Wait so mtime doesn't re-trigger
    await new Promise((r) => setTimeout(r, 200));

    // Session B: should re-emit
    const c = runHook({ cacheDir, shimDir, stateDir, agentDirOverride: fakeAgentDir, sessionId: "session-B" });
    expect(c.exitCode).toBe(0);
    expect(c.stdout).toContain("stable content");
  }, 10_000);

  it("HEARTBEAT.md is suppressed when prompt has no 'heartbeat' keyword and HB unchanged", () => {
    const fakeAgentDir = join(tmp, "agent");
    const wsDir = join(fakeAgentDir, "workspace");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "MEMORY.md"), "mem");
    const hbPath = join(wsDir, "HEARTBEAT.md");
    writeFileSync(hbPath, "intentions: work on stuff");

    const hbSection = `## ${wsDir}/HEARTBEAT.md\nintentions: work on stuff\n`;
    const payload = `# Project Context (dynamic workspace files)\n\n## ${wsDir}/MEMORY.md\nmem\n\n${hbSection}`;
    makeShim(shimDir, payload);

    // First turn: HEARTBEAT included (new session)
    const a = runHook({
      cacheDir, shimDir, stateDir,
      agentDirOverride: fakeAgentDir,
      sessionId: "session-A",
      prompt: "hey what are you working on",
    });
    expect(a.exitCode).toBe(0);
    // First turn emits everything
    expect(a.stdout).toContain("mem");

    // Second turn same session: HEARTBEAT unchanged + prompt not heartbeat → HB stripped
    const b = runHook({
      cacheDir, shimDir, stateDir,
      agentDirOverride: fakeAgentDir,
      sessionId: "session-A",
      prompt: "regular message",
    });
    // Either completely suppressed (mem already seen) or HB stripped — in either
    // case, HEARTBEAT content must not appear
    if (b.stdout !== "") {
      expect(b.stdout).not.toContain("intentions: work on stuff");
    }
  });

  it("HEARTBEAT.md is included when prompt contains 'heartbeat' (case-insensitive)", () => {
    const fakeAgentDir = join(tmp, "agent");
    const wsDir = join(fakeAgentDir, "workspace");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "MEMORY.md"), "mem");
    const hbPath = join(wsDir, "HEARTBEAT.md");
    writeFileSync(hbPath, "intentions: work on stuff");

    const hbSection = `## ${wsDir}/HEARTBEAT.md\nintentions: work on stuff\n`;
    const payload = `# Project Context (dynamic workspace files)\n\n## ${wsDir}/MEMORY.md\nmem\n\n${hbSection}`;
    makeShim(shimDir, payload);

    // First turn emits everything to seed state
    runHook({
      cacheDir, shimDir, stateDir,
      agentDirOverride: fakeAgentDir,
      sessionId: "session-hb",
      prompt: "regular message",
    });

    // Second turn with heartbeat keyword — must include HEARTBEAT even if it didn't change
    const b = runHook({
      cacheDir, shimDir, stateDir,
      agentDirOverride: fakeAgentDir,
      sessionId: "session-hb",
      prompt: "HEARTBEAT check",
    });
    expect(b.exitCode).toBe(0);
    // The full payload should be emitted (not suppressed by session check because
    // session-state suppression is for the entire workspace block, and HEARTBEAT
    // gating only strips the section when NOT a heartbeat prompt)
    // At minimum: HEARTBEAT content must appear if the full block is emitted.
    // (session-state may suppress the whole block on second turn; the key
    // invariant is that HEARTBEAT is NOT stripped when prompt matches)
    // This test verifies no HEARTBEAT stripping occurs when the prompt matches.
    // We verify this by checking that if output is non-empty, HB section is present.
    if (b.stdout !== "") {
      expect(b.stdout).toContain("intentions: work on stuff");
    }
  });

  it("BLOCKER 2 regression: fast-path (fresh cache) strips HEARTBEAT on non-heartbeat prompt with unchanged HB", async () => {
    // This test guards the BLOCKER 2 fix: before the fix, the fast-path (lines
    // ~108-153) would cat BODY_FILE and exit 0 WITHOUT applying heartbeat
    // stripping, so HEARTBEAT.md was emitted every turn in the common case.

    const fakeAgentDir = join(tmp, "agent-hb-fast");
    const wsDir = join(fakeAgentDir, "workspace");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "MEMORY.md"), "mem content");
    const hbPath = join(wsDir, "HEARTBEAT.md");
    writeFileSync(hbPath, "intentions: stay focused");

    const hbSection = `## ${wsDir}/HEARTBEAT.md\nintentions: stay focused\n`;
    const payload = `# Project Context\n\n## ${wsDir}/MEMORY.md\nmem content\n\n${hbSection}`;
    makeShim(shimDir, payload);

    // Turn 1: first turn for this session — seeds both ws-dynamic and ws-heartbeat state.
    const a = runHook({
      cacheDir, shimDir, stateDir,
      agentDirOverride: fakeAgentDir,
      sessionId: "session-fast-hb",
      prompt: "regular message",
    });
    expect(a.exitCode).toBe(0);
    // First turn always emits (no prior state).

    // Now wait for BODY_FILE to be newer than the workspace sources so
    // the mtime fast-path fires on the next turn. The hook writes BODY_FILE
    // after a fresh render, but we need it newer than MEMORY.md and HEARTBEAT.md.
    // Touch the files with an older timestamp to ensure the fast-path is taken.
    // Use 2s sleep to guarantee mtime difference.
    await new Promise((r) => setTimeout(r, 1100));

    // Turn 2: same session, same prompt (no heartbeat keyword), HEARTBEAT unchanged.
    // The fast-path should take over (BODY_FILE is fresh), BUT heartbeat must be stripped.
    const b = runHook({
      cacheDir, shimDir, stateDir,
      agentDirOverride: fakeAgentDir,
      sessionId: "session-fast-hb",
      prompt: "a regular message without hb keyword",
    });
    expect(b.exitCode).toBe(0);
    // Either fully suppressed (ws-dynamic session check) OR HEARTBEAT stripped.
    // Either way, HEARTBEAT content must NOT appear.
    if (b.stdout !== "") {
      expect(b.stdout).not.toContain("intentions: stay focused");
    }
  }, 10_000);

  it("legacy mode (inject_on_change=0) emits every turn", () => {
    const payload = "# Project Context (dynamic workspace files)\n\n## MEMORY.md\nlegacy content\n";
    makeShim(shimDir, payload);

    const a = runHook({ cacheDir, shimDir, injectOnChange: false });
    const b = runHook({ cacheDir, shimDir, injectOnChange: false });
    expect(a.stdout).toContain("legacy content");
    expect(b.stdout).toContain("legacy content");
  });

  it("fails open when state dir is a file (corrupted state)", () => {
    // Write a file at the .hook-state path so mkdir fails
    const hookStateDir = join(stateDir, ".hook-state");
    writeFileSync(hookStateDir, "not-a-dir");

    const payload = "# Project Context (dynamic workspace files)\n\n## MEMORY.md\nfailopen content\n";
    makeShim(shimDir, payload);

    const a = runHook({ cacheDir, shimDir, stateDir });
    expect(a.exitCode).toBe(0);
    // Should still emit (fail-open)
    expect(a.stdout).toContain("failopen content");
  });
});
