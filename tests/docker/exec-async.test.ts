/**
 * Guard for `_exec-async.ts` — the property that fixes the hindsight-probe
 * flake is EVENT-LOOP LIVENESS, so that is what these assert.
 *
 * The bug (run 31575484897, job 94046556074): 5/5 tests passed and vitest
 * exited 1 on `[vitest-worker]: Timeout calling "onTaskUpdate"`. vitest's
 * worker→main RPC has a hard-coded 60 s birpc timeout with no config knob;
 * a worker blocked in `execFileSync` for longer than that cannot read the
 * main process's reply, and the timers phase then fires the timeout before
 * the poll phase delivers the reply that would have cleared it.
 *
 * `execLiveness` below measures exactly that: how many macrotask ticks the
 * loop gets while a child runs. `execFileSync` scores 0 (that IS the bug);
 * `execFileAsync` must keep ticking. A regression that reintroduces a
 * blocking call fails here rather than as a merge-queue ejection.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { execFileAsync, ExecFailure } from "./_exec-async.js";

/** Ticks a 20 ms interval while `body` runs; returns the tick count. */
async function execLiveness(body: () => void | Promise<void>): Promise<number> {
  let ticks = 0;
  const handle = setInterval(() => {
    ticks += 1;
  }, 20);
  try {
    await body();
  } finally {
    clearInterval(handle);
  }
  return ticks;
}

const SLEEP = ["-c", "sleep 0.6"];

describe("execFileAsync — event-loop liveness (the onTaskUpdate flake)", () => {
  it("keeps the event loop turning while the child runs", async () => {
    const ticks = await execLiveness(async () => {
      await execFileAsync("sh", SLEEP);
    });
    // 0.6 s / 20 ms ≈ 30 ticks; assert a floor well clear of scheduler noise.
    expect(
      ticks,
      "the loop must keep running during the child — a starved loop is what " +
        "times out vitest's onTaskUpdate RPC",
      ).toBeGreaterThan(5);
  });

  it("execFileSync starves it completely (the shape being fixed)", async () => {
    const ticks = await execLiveness(() => {
      execFileSync("sh", SLEEP, { stdio: "ignore" });
    });
    // Not a style preference: a sync child of this length lets through zero
    // timer ticks, so 60 s of them accrue a full RPC timeout.
    expect(ticks, "execFileSync must be shown to block, or this suite proves nothing").toBe(0);
  });

  it("stays live across a chain of children, like a probe leg does", async () => {
    const ticks = await execLiveness(async () => {
      await execFileAsync("sh", ["-c", "sleep 0.2"]);
      await execFileAsync("sh", ["-c", "sleep 0.2"]);
      await execFileAsync("sh", ["-c", "sleep 0.2"]);
    });
    expect(ticks).toBeGreaterThan(5);
  });
});

describe("execFileAsync — execFileSync-compatible semantics", () => {
  it("resolves with captured stdout on exit 0", async () => {
    const r = await execFileAsync("sh", ["-c", "echo hello; echo warn >&2"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("hello\n");
    expect(r.stderr).toBe("warn\n");
  });

  it("rejects with .status/.stdout/.stderr on a non-zero exit", async () => {
    const err = await execFileAsync("sh", [
      "-c",
      "echo partial; echo boom >&2; exit 7",
    ]).then(
      () => null,
      (e: unknown) => e as ExecFailure
    );
    expect(err, "a non-zero exit must reject, as execFileSync throws").toBeTruthy();
    expect(err).toBeInstanceOf(ExecFailure);
    // The probe call sites read exactly these two fields off the caught error.
    expect(err!.status).toBe(7);
    expect(err!.stdout).toBe("partial\n");
    expect(err!.stderr).toContain("boom");
  });

  it("writes `input` to stdin and closes it", async () => {
    const r = await execFileAsync("sh", ["-c", "cat"], { input: "piped-probe\n" });
    expect(r.stdout).toBe("piped-probe\n");
  });

  it("closes stdin even with no input, so `cat` cannot hang the suite", async () => {
    const r = await execFileAsync("sh", ["-c", "cat; echo done"]);
    expect(r.stdout).toBe("done\n");
  });

  it("passes env through to the child", async () => {
    const r = await execFileAsync("sh", ["-c", "echo $SR_PROBE_MARKER"], {
      env: { ...process.env, SR_PROBE_MARKER: "marker-42" },
    });
    expect(r.stdout.trim()).toBe("marker-42");
  });

  it("reports a spawn failure as status -1 rather than hanging", async () => {
    const err = await execFileAsync("definitely-not-a-real-binary-xyz", []).then(
      () => null,
      (e: unknown) => e as ExecFailure
    );
    expect(err).toBeInstanceOf(ExecFailure);
    expect(err!.status).toBe(-1);
  });

  it("kills the child and rejects when timeoutMs elapses", async () => {
    const started = Date.now();
    const err = await execFileAsync("sh", ["-c", "sleep 30"], {
      timeoutMs: 300,
    }).then(
      () => null,
      (e: unknown) => e as ExecFailure
    );
    expect(err).toBeInstanceOf(ExecFailure);
    expect(err!.status).toBe(-1);
    expect(Date.now() - started, "must not wait out the full sleep").toBeLessThan(10_000);
  });
});
