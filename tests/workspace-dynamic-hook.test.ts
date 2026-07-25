import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Exercises bin/workspace-dynamic-hook.sh end-to-end with a stub
 * `switchroom` shim on PATH that we control. Verifies:
 *   - byte-stable output across two consecutive invocations with
 *     identical render input (the whole point of the dedupe sidecar)
 *   - empty render → empty stdout, but the empty body IS cached so the
 *     fast-skip engages next turn (see #3546 part 1)
 *   - changed render → updated cache + new body emitted
 *   - the source watch set is derived from LOCAL time, matching the
 *     renderer (#3546 part 2)
 *   - a source mutated during the render window, and a deleted source,
 *     both invalidate the cache (#3546 parts 3 and 4)
 */
const HOOK = resolve(__dirname, "../bin/workspace-dynamic-hook.sh");

interface RunResult {
  stdout: string;
  exitCode: number;
}

function runHook(opts: {
  agentName?: string;
  cacheDir: string;
  shimDir: string;
  /** Override the workspace dir the mtime fast-skip walks. Default is
   * `~/.switchroom/agents/<agentName>/workspace`. Tests use this to
   * point at a tmp tree so they can touch source files to invalidate
   * the cache deterministically. */
  agentDirOverride?: string;
  /** Override the timezone the hook derives its "today"/"yesterday"
   * daily-memory filenames from. */
  tz?: string;
}): RunResult {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PATH: `${opts.shimDir}:${process.env.PATH ?? ""}`,
    CLAUDE_CONFIG_DIR: opts.cacheDir,
  };
  if (opts.tz !== undefined) {
    env.TZ = opts.tz;
  }
  if (opts.agentName !== undefined) {
    env.SWITCHROOM_AGENT_NAME = opts.agentName;
  } else {
    delete env.SWITCHROOM_AGENT_NAME;
  }
  if (opts.agentDirOverride !== undefined) {
    env.SWITCHROOM_AGENT_DIR = opts.agentDirOverride;
  } else {
    delete env.SWITCHROOM_AGENT_DIR;
  }
  try {
    const stdout = execFileSync("bash", [HOOK], { env, encoding: "utf-8" });
    return { stdout, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; status?: number };
    return {
      stdout: e.stdout ? String(e.stdout) : "",
      exitCode: e.status ?? 1,
    };
  }
}

/**
 * Write a `switchroom` shim that prints a fixed payload when invoked
 * with `workspace render <agent> --dynamic ...`. The hook only inspects
 * stdout, so the shim doesn't need to be a real CLI — just a bash
 * script that echoes whatever we tell it to.
 */
function makeShim(shimDir: string, payload: string): void {
  mkdirSync(shimDir, { recursive: true });
  const shimPath = join(shimDir, "switchroom");
  // Use a tiny heredoc-driven shell script. Escape single quotes in the
  // payload by closing/reopening the quoted block.
  const escaped = payload.replace(/'/g, `'"'"'`);
  writeFileSync(
    shimPath,
    `#!/bin/bash\nprintf '%s' '${escaped}'\n`,
    { mode: 0o755 },
  );
  chmodSync(shimPath, 0o755);
}

describe("workspace-dynamic-hook.sh", () => {
  let tmp: string;
  let cacheDir: string;
  let shimDir: string;

  // The hook date-keys cache filenames so the calendar-day rollover
  // invalidates yesterday's cache (the renderer embeds today's daily
  // path in the body). Compute the same LOCAL date the script does —
  // the hook must agree with `dailyMemoryRelativePath` in
  // src/agents/workspace.ts, which is local-time by design.
  function dateIn(tz: string, date: Date = new Date()): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  }

  function todayLocal(): string {
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  }

  const DAY_MS = 86_400_000;

  /**
   * Pick a timezone, plus a daily-memory filename, such that the file is
   * a genuine renderer source (local today or local yesterday) but is
   * NOT in the watch set a UTC-based hook would build ({utc today, utc
   * yesterday}).
   *
   * UTC+14 leads UTC's date whenever the UTC hour is >= 10; UTC-11 lags
   * it whenever the UTC hour is < 11 — so one of the two always
   * qualifies, making this deterministic at any wall-clock time. (Both
   * fixed-offset zones, so no DST to complicate the -1 day arithmetic.)
   */
  function pickTzAndUnwatchedDailyFile(): { tz: string; date: string; role: string } {
    const now = new Date();
    const utcSet = new Set([
      now.toISOString().slice(0, 10),
      new Date(now.getTime() - DAY_MS).toISOString().slice(0, 10),
    ]);
    for (const tz of ["Etc/GMT-14", "Etc/GMT+11"]) {
      const candidates: Array<[string, string]> = [
        ["today", dateIn(tz, now)],
        ["yesterday", dateIn(tz, new Date(now.getTime() - DAY_MS))],
      ];
      for (const [role, date] of candidates) {
        if (!utcSet.has(date)) return { tz, date, role };
      }
    }
    throw new Error("no timezone yields a local daily file outside the UTC watch set");
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ws-dyn-hook-"));
    cacheDir = join(tmp, "claude");
    shimDir = join(tmp, "bin");
    mkdirSync(cacheDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns empty stdout and caches the empty body when render is empty", () => {
    const fakeAgentDir = join(tmp, "agent");
    mkdirSync(join(fakeAgentDir, "workspace"), { recursive: true });
    makeShim(shimDir, "");
    const r = runHook({ agentName: "klanker", cacheDir, shimDir, agentDirOverride: fakeAgentDir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    // The empty body IS cached (#3546 part 1): the fast-skip re-derives
    // the source signature every turn, so a MEMORY.md that later appears
    // still invalidates it. Not caching meant empty-render agents paid
    // the full ~825ms render on every single message.
    const dir = join(cacheDir, "switchroom-hookcache");
    const date = todayLocal();
    expect(existsSync(join(dir, `workspace-dynamic.${date}.hash`))).toBe(true);
    expect(existsSync(join(dir, `workspace-dynamic.${date}.body`))).toBe(true);
    expect(readFileSync(join(dir, `workspace-dynamic.${date}.body`), "utf-8")).toBe("");
  });

  it("fast-skips the renderer on the turn after an empty render", () => {
    const fakeAgentDir = join(tmp, "agent");
    mkdirSync(join(fakeAgentDir, "workspace"), { recursive: true });
    const marker = join(tmp, "shim-invoked");

    // Shim records each invocation so we can assert the second turn
    // never reaches the (~825ms) renderer at all.
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(
      join(shimDir, "switchroom"),
      `#!/bin/bash\necho x >> '${marker}'\n`,
      { mode: 0o755 },
    );
    chmodSync(join(shimDir, "switchroom"), 0o755);

    const a = runHook({ agentName: "klanker", cacheDir, shimDir, agentDirOverride: fakeAgentDir });
    expect(a.stdout).toBe("");
    expect(readFileSync(marker, "utf-8").trim().split("\n").length).toBe(1);

    const b = runHook({ agentName: "klanker", cacheDir, shimDir, agentDirOverride: fakeAgentDir });
    expect(b.exitCode).toBe(0);
    expect(b.stdout).toBe("");
    // Still exactly one invocation — turn two took the fast path.
    expect(readFileSync(marker, "utf-8").trim().split("\n").length).toBe(1);
  });

  it("emits the rendered payload and caches it", () => {
    const payload = "MEMORY:\n  - thing one\n  - thing two\n";
    makeShim(shimDir, payload);
    const r = runHook({ agentName: "klanker", cacheDir, shimDir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("thing one");
    expect(r.stdout).toContain("thing two");

    const date = todayLocal();
    const hashFile = join(cacheDir, "switchroom-hookcache", `workspace-dynamic.${date}.hash`);
    const bodyFile = join(cacheDir, "switchroom-hookcache", `workspace-dynamic.${date}.body`);
    expect(existsSync(hashFile)).toBe(true);
    expect(existsSync(bodyFile)).toBe(true);
    expect(readFileSync(bodyFile, "utf-8")).toContain("thing one");
  });

  it("emits byte-identical stdout for back-to-back invocations with the same render", () => {
    const payload = "stable-payload-" + "X".repeat(50);
    makeShim(shimDir, payload);
    const a = runHook({ agentName: "klanker", cacheDir, shimDir });
    const b = runHook({ agentName: "klanker", cacheDir, shimDir });
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(b.stdout).toBe(a.stdout);
    expect(a.stdout).toContain("stable-payload-");
  });

  it("re-emits and re-caches when the render output changes", async () => {
    // The mtime-fastskip path emits the cached body when no workspace
    // source file is newer than it. To exercise the content-changed
    // path deterministically we use a tmp agent dir + touch a source
    // file between runs. Without this the fast-skip would short-circuit
    // and the second runHook would never call the new shim.
    const fakeAgentDir = join(tmp, "agent");
    const wsDir = join(fakeAgentDir, "workspace");
    mkdirSync(wsDir, { recursive: true });
    const memPath = join(wsDir, "MEMORY.md");
    writeFileSync(memPath, "v1");

    makeShim(shimDir, "first body content");
    const a = runHook({
      agentName: "klanker",
      cacheDir,
      shimDir,
      agentDirOverride: fakeAgentDir,
    });
    expect(a.stdout).toContain("first body");

    // Sleep ≥ 1s so the next stat-based mtime tick is observable
    // (stat -c %Y returns whole seconds).
    await new Promise((r) => setTimeout(r, 1100));
    writeFileSync(memPath, "v2"); // bumps mtime past the body file

    makeShim(shimDir, "second body content");
    const b = runHook({
      agentName: "klanker",
      cacheDir,
      shimDir,
      agentDirOverride: fakeAgentDir,
    });
    expect(b.stdout).toContain("second body");
    expect(b.stdout).not.toBe(a.stdout);

    const date = todayLocal();
    const bodyFile = join(cacheDir, "switchroom-hookcache", `workspace-dynamic.${date}.body`);
    expect(readFileSync(bodyFile, "utf-8")).toContain("second body");
  });

  it("watches the LOCAL-time daily memory file, not the UTC one (#3546 part 2)", async () => {
    // The renderer reads `memory/<local-today>.md`
    // (dailyMemoryRelativePath, src/agents/workspace.ts:257-262 — local
    // by design). When the hook derived its watch set from `date -u`,
    // a write to the renderer's today-file was invisible for the hours
    // where the local date leads/lags UTC, and a stale body was served.
    const { tz, date: localDate, role } = pickTzAndUnwatchedDailyFile();
    expect(["today", "yesterday"]).toContain(role);

    const fakeAgentDir = join(tmp, "agent");
    const memDir = join(fakeAgentDir, "workspace", "memory");
    mkdirSync(memDir, { recursive: true });

    makeShim(shimDir, "first body content");
    const a = runHook({ agentName: "klanker", cacheDir, shimDir, agentDirOverride: fakeAgentDir, tz });
    expect(a.stdout).toContain("first body");

    await new Promise((r) => setTimeout(r, 1100));
    // Write a daily-memory file the renderer genuinely reads (local
    // today or local yesterday) but that a UTC-derived watch set misses.
    writeFileSync(join(memDir, `${localDate}.md`), "daily note");

    makeShim(shimDir, "second body content");
    const b = runHook({ agentName: "klanker", cacheDir, shimDir, agentDirOverride: fakeAgentDir, tz });
    expect(b.stdout).toContain("second body");
  });

  it("re-renders when a source is deleted (#3546 part 4)", async () => {
    // A missing source used to contribute mtime 0, which never exceeded
    // the body's mtime — so deleting MEMORY.md served the cached body
    // forever. The source-set signature records MISSING explicitly.
    const fakeAgentDir = join(tmp, "agent");
    const wsDir = join(fakeAgentDir, "workspace");
    mkdirSync(wsDir, { recursive: true });
    const memPath = join(wsDir, "MEMORY.md");
    writeFileSync(memPath, "remembered things");

    makeShim(shimDir, "first body content");
    const a = runHook({ agentName: "klanker", cacheDir, shimDir, agentDirOverride: fakeAgentDir });
    expect(a.stdout).toContain("first body");

    rmSync(memPath);

    makeShim(shimDir, "second body content");
    const b = runHook({ agentName: "klanker", cacheDir, shimDir, agentDirOverride: fakeAgentDir });
    expect(b.stdout).toContain("second body");
  });

  it("picks up a source mutated during the render window (#3546 part 3)", async () => {
    // Sources are read by the renderer; the body is written after it
    // returns. A source touched in between used to end up OLDER than
    // the body and became invisible to a max-mtime fast-skip forever.
    // The signature is captured BEFORE the render, so the change shows
    // up on the next turn.
    const fakeAgentDir = join(tmp, "agent");
    const wsDir = join(fakeAgentDir, "workspace");
    mkdirSync(wsDir, { recursive: true });
    const memPath = join(wsDir, "MEMORY.md");
    writeFileSync(memPath, "v1");

    // Shim mutates MEMORY.md *during* the render, then stalls past the
    // 1s stat granularity so the body lands with a strictly newer mtime
    // than the source — exactly the condition that hid the write.
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(
      join(shimDir, "switchroom"),
      `#!/bin/bash\nprintf 'v2-during-render' > '${memPath}'\nsleep 1.2\nprintf '%s' 'first body content'\n`,
      { mode: 0o755 },
    );
    chmodSync(join(shimDir, "switchroom"), 0o755);

    const a = runHook({ agentName: "klanker", cacheDir, shimDir, agentDirOverride: fakeAgentDir });
    expect(a.stdout).toContain("first body");
    expect(readFileSync(memPath, "utf-8")).toBe("v2-during-render");

    makeShim(shimDir, "second body content");
    const b = runHook({ agentName: "klanker", cacheDir, shimDir, agentDirOverride: fakeAgentDir });
    expect(b.stdout).toContain("second body");
  });

  it("exits silently with no output when SWITCHROOM_AGENT_NAME is unset", () => {
    makeShim(shimDir, "should not run");
    const r = runHook({ cacheDir, shimDir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });
});
