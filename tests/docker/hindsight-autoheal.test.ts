/**
 * Tests for `docker/hindsight-autoheal.sh` (#2910) — the host-side
 * restart-on-unhealthy loop for the standalone `switchroom-hindsight`
 * container. Docker's `--restart always` acts on process EXIT only, never on
 * health status, and the in-container maintenance loop has no docker socket —
 * so a wedged-but-not-exited API stayed `unhealthy` forever. This sidecar
 * closes that gap; it must NOT be able to restart-loop a genuinely-broken
 * hindsight (backoff + sliding-window cap + give-up).
 *
 * The pure decision core is sourced with SWITCHROOM_HINDSIGHT_AUTOHEAL_LIB_ONLY=1
 * (loads the functions without entering the poll loop) and exercised for
 * OUTCOMES: restart issued vs suppressed-when-healthy vs capped-after-N. The
 * loop body itself isn't stood up (it needs a live docker daemon); its guards
 * are pinned statically.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCRIPT = resolve(__dirname, "..", "..", "docker", "hindsight-autoheal.sh");

/** Source the script lib-only, run `expr`, return trimmed stdout. */
function sh(expr: string): string {
  const r = spawnSync(
    "sh",
    ["-c", `SWITCHROOM_HINDSIGHT_AUTOHEAL_LIB_ONLY=1 . "${SCRIPT}"; ${expr}`],
    { encoding: "utf-8", timeout: 10_000 },
  );
  if (r.status !== 0) {
    throw new Error(`sh exited ${r.status}: ${r.stderr}`);
  }
  return r.stdout.trim();
}

describe("hindsight-autoheal.sh — pure decision core", () => {
  it("does NOT enter the poll loop when sourced lib-only (returns promptly)", () => {
    // If autoheal_main ran, the 10s timeout would kill it (status !== 0).
    const out = sh('echo loaded');
    expect(out).toBe("loaded");
  });

  it("prune drops timestamps outside the window, keeps those inside", () => {
    // now=5000, window=3600 → cutoff=1400. 100,200 drop; 1400,5000 keep.
    expect(sh('autoheal_prune "100 200 1400 5000" 5000 3600')).toBe("1400 5000");
  });

  it("count returns the number of timestamps", () => {
    expect(sh('autoheal_count "1 2 3 4"')).toBe("4");
    expect(sh('autoheal_count ""')).toBe("0");
  });

  it("decide: a healthy target issues NO restart (verb=ok)", () => {
    expect(sh('autoheal_decide healthy "" 5000 3600 3')).toBe("ok|");
    // starting is also not `unhealthy` → ok
    expect(sh('autoheal_decide starting "" 5000 3600 3')).toBe("ok|");
    // a missing/unreadable container is treated as not-unhealthy (never fight a recreate)
    expect(sh('autoheal_decide missing "" 5000 3600 3')).toBe("ok|");
  });

  it("decide: an unhealthy target UNDER the cap issues a restart (now appended)", () => {
    expect(sh('autoheal_decide unhealthy "4990" 5000 3600 3')).toBe("restart|4990 5000");
    expect(sh('autoheal_decide unhealthy "" 5000 3600 3')).toBe("restart|5000");
  });

  it("decide: an unhealthy target AT the cap is SUPPRESSED (verb=capped) — no restart loop", () => {
    // 3 restarts already in-window, MAX=3 → capped, and the state is NOT grown.
    expect(sh('autoheal_decide unhealthy "4990 4995 4998" 5000 3600 3')).toBe("capped|4990 4995 4998");
  });

  it("decide: stale in-window restarts age out, re-allowing a restart later", () => {
    // 3 restarts at t=100/200/300, but now=5000 window=3600 → all pruned → restart allowed again.
    expect(sh('autoheal_decide unhealthy "100 200 300" 5000 3600 3')).toBe("restart|5000");
  });

  it("backoff is exponential in the restart count and capped at 8x base", () => {
    expect(sh('autoheal_backoff 30 0')).toBe("30");
    expect(sh('autoheal_backoff 30 1')).toBe("60");
    expect(sh('autoheal_backoff 30 2')).toBe("120");
    expect(sh('autoheal_backoff 30 3')).toBe("240");
    expect(sh('autoheal_backoff 30 9')).toBe("240"); // capped at 8*30
  });
});

describe("hindsight-autoheal.sh — static guards", () => {
  const raw = readFileSync(SCRIPT, "utf-8");

  it("routes docker access via inspect + restart ONLY (least-privilege, no rm/kill)", () => {
    expect(raw).toMatch(/docker inspect -f '\{\{\.State\.Health\.Status\}\}'/);
    expect(raw).toMatch(/docker restart "\$TARGET"/);
    expect(raw).not.toMatch(/docker\s+(rm|kill|stop)\b/);
  });

  it("emits stable structured decision lines doctor can grep", () => {
    // The doctor-side prefix + k=v shape (produced by autoheal_log's printf).
    expect(raw).toMatch(/printf 'hindsight-autoheal event=%s/);
    // The two events doctor keys on are actually emitted.
    expect(raw).toMatch(/autoheal_log restart_issued/);
    expect(raw).toMatch(/autoheal_log gave_up/);
  });

  it("honors the master kill-switch and defaults ON", () => {
    expect(raw).toMatch(/ENABLED="\$\{SWITCHROOM_HINDSIGHT_AUTOHEAL:-1\}"/);
    expect(raw).toMatch(/if \[ "\$ENABLED" = "0" \]/);
  });

  it("caps restarts with a sliding window (the loop-guard requirement)", () => {
    expect(raw).toMatch(/SWITCHROOM_HINDSIGHT_AUTOHEAL_MAX_RESTARTS:-3/);
    expect(raw).toMatch(/SWITCHROOM_HINDSIGHT_AUTOHEAL_WINDOW_S:-3600/);
    expect(raw).toMatch(/SWITCHROOM_HINDSIGHT_AUTOHEAL_COOLDOWN_S/);
  });
});
