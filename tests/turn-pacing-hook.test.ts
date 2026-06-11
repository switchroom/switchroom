import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

/**
 * Tests for bin/turn-pacing-hook.sh — the inject-on-change replacement for
 * the inline `printf` that previously re-emitted the full pacing directive on
 * every user turn.
 *
 * All runs use a tmp TELEGRAM_STATE_DIR to avoid touching live agent state.
 */

const HOOK = resolve(__dirname, "../bin/turn-pacing-hook.sh");

const DIRECTIVE_TEXT = "<turn-pacing>test directive content for unit tests</turn-pacing>";
const DIRECTIVE_HASH = createHash("sha256").update(DIRECTIVE_TEXT).digest("hex");

interface RunResult {
  stdout: string;
  exitCode: number;
}

function runHook(opts: {
  stateDir: string;
  sessionId?: string | null;
  directiveText?: string;
  directiveHash?: string;
  noStdin?: boolean;
}): RunResult {
  const {
    stateDir,
    sessionId = "test-session-abc123",
    directiveText = DIRECTIVE_TEXT,
    directiveHash = DIRECTIVE_HASH,
    noStdin = false,
  } = opts;

  const stdin = noStdin
    ? undefined
    : JSON.stringify({ session_id: sessionId ?? "", prompt: "hello" });

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TELEGRAM_STATE_DIR: stateDir,
    TURN_PACING_DIRECTIVE: directiveText,
    TURN_PACING_HASH: directiveHash,
  };

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

describe("turn-pacing-hook.sh", () => {
  let tmp: string;
  let stateDir: string;

  beforeEach(() => {
    // Use /var/tmp (not /tmp) because /tmp is mounted noexec in this
    // environment — shim scripts placed there can't be exec'd by PATH lookup.
    tmp = mkdtempSync(join("/var/tmp", "turn-pacing-hook-"));
    stateDir = tmp;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("emits full directive on first turn (no state file)", () => {
    const r = runHook({ stateDir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(DIRECTIVE_TEXT);
  });

  it("suppresses on second turn with same session_id and same hash", () => {
    // First turn: emit
    const a = runHook({ stateDir });
    expect(a.stdout).toContain(DIRECTIVE_TEXT);

    // Second turn: suppress
    const b = runHook({ stateDir });
    expect(b.exitCode).toBe(0);
    expect(b.stdout).toBe("");
  });

  it("re-emits when session_id changes", () => {
    // First turn: emit with session A
    const a = runHook({ stateDir, sessionId: "session-A" });
    expect(a.stdout).toContain(DIRECTIVE_TEXT);

    // Same session: suppress
    const b = runHook({ stateDir, sessionId: "session-A" });
    expect(b.stdout).toBe("");

    // New session: re-emit
    const c = runHook({ stateDir, sessionId: "session-B" });
    expect(c.exitCode).toBe(0);
    expect(c.stdout).toContain(DIRECTIVE_TEXT);
  });

  it("re-emits when directive hash changes (scaffold regenerated new text)", () => {
    const newText = "<turn-pacing>updated directive text</turn-pacing>";
    const newHash = createHash("sha256").update(newText).digest("hex");

    // First turn: emit original
    const a = runHook({ stateDir });
    expect(a.stdout).toContain(DIRECTIVE_TEXT);

    // Second turn: still same hash → suppress
    const b = runHook({ stateDir });
    expect(b.stdout).toBe("");

    // Third turn: new directive → re-emit
    const c = runHook({ stateDir, directiveText: newText, directiveHash: newHash });
    expect(c.exitCode).toBe(0);
    expect(c.stdout).toContain(newText);
  });

  it("writes state file after first emit", () => {
    runHook({ stateDir });
    const hookStateDir = join(stateDir, ".hook-state");
    expect(existsSync(hookStateDir)).toBe(true);
    const stateFile = join(hookStateDir, "turn-pacing.test-session-abc123");
    expect(existsSync(stateFile)).toBe(true);
    const contents = readFileSync(stateFile, "utf-8");
    expect(contents.trim()).toBe(DIRECTIVE_HASH);
  });

  it("fails open when state dir cannot be created (corrupted state)", () => {
    // Point to a path that cannot become a dir (e.g. an existing file at the
    // parent path). Use a file as the TELEGRAM_STATE_DIR itself so .hook-state
    // mkdir fails.
    const filePath = join(tmp, "not-a-dir");
    writeFileSync(filePath, "data");
    const r = runHook({ stateDir: filePath });
    // Should emit directive (fail-open), not suppress
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(DIRECTIVE_TEXT);
  });

  it("exits silently with no output when TURN_PACING_DIRECTIVE is empty", () => {
    const r = runHook({ stateDir, directiveText: "", directiveHash: "" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("fails open when session_id is missing from stdin JSON", () => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TELEGRAM_STATE_DIR: stateDir,
      TURN_PACING_DIRECTIVE: DIRECTIVE_TEXT,
      TURN_PACING_HASH: DIRECTIVE_HASH,
    };
    const stdout = execFileSync("bash", [HOOK], {
      env,
      input: JSON.stringify({ prompt: "no session id here" }),
      encoding: "utf-8",
    });
    // No session_id → fail-open → emit
    expect(stdout).toContain(DIRECTIVE_TEXT);
  });

  it("fails open when TURN_PACING_HASH is empty but directive is present", () => {
    const r = runHook({ stateDir, directiveHash: "" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(DIRECTIVE_TEXT);
  });
});
