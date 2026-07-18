/**
 * Shared restart-capability probe + loud-skip announcer for the
 * restart/resume UAT scenarios.
 *
 * These scenarios (`jtbd-deliberate-restart-resumes-dm`,
 * `jtbd-interrupted-turn-resumes-dm`, `jtbd-always-on-after-restart-dm`)
 * can only exercise a REAL restart when the runner has NOPASSWD `sudo` and
 * the `switchroom` CLI on PATH. On a sandboxed runner that lacks those,
 * `vitest`'s `describe.skip` marks them skipped — but a bare skip reads as
 * a plain green in a summarised board, which is exactly how the v0.18.32
 * UAT canary over-claimed "#3315 restart/resume validated" when in fact
 * these three self-skipped (#3334 item d).
 *
 * The durable fix has two parts. Part 2 (a runner that can actually
 * restart) is infrastructure and is tracked separately. Part 1 — this file
 * — makes the skip LOUD and unmistakable: a single-source-of-truth probe
 * plus a banner printed to stderr at collection time, so a green that is
 * really a skip can never be silently indistinguishable from a green that
 * ran live.
 */

import { execSync } from "node:child_process";

/**
 * True only when the runner can drive a real agent restart: NOPASSWD
 * `sudo` is available (the scenarios shell out to
 * `sudo -n switchroom agent restart …`). A sandboxed CI runner returns
 * false, which routes the scenario to `describe.skip`.
 */
export function canShellSudo(): boolean {
  try {
    execSync("sudo -n true", { stdio: "ignore", timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Print a loud, unmissable banner to stderr when a restart/resume scenario
 * is about to self-skip because the runner cannot exercise a real restart.
 * Call this at module-collection time (top level of the scenario file) so
 * the banner lands in CI stdout/stderr regardless of the reporter's
 * skip-count rendering.
 *
 * The banner deliberately spells out that a GREEN here is a SKIP, not live
 * proof — the exact confusion #3334 item d flags as "the dangerous one".
 */
export function announceRestartSkip(scenarioTitle: string): void {
  console.warn(
    "\n" +
      "════════════════════════════════════════════════════════════════════\n" +
      "  ⚠️  UAT SKIPPED — NOT LIVE-VALIDATED (restart capability absent)\n" +
      `      scenario: ${scenarioTitle}\n` +
      "      reason:   this runner has no NOPASSWD sudo + switchroom CLI, so\n" +
      "                it cannot exercise a real agent restart. The scenario\n" +
      "                self-skips. Its GREEN is a SKIP, not live proof.\n" +
      "      see:      #3334 item (d) / #3315 — restart/resume assurance from\n" +
      "                this run rests on the unit/vitest layer, not this UAT.\n" +
      "════════════════════════════════════════════════════════════════════\n",
  );
}

/**
 * Convenience: probe capability once and, when absent, emit the loud-skip
 * banner. Returns the capability boolean so the caller can gate
 * `describe` vs `describe.skip`:
 *
 *   const sudoOk = restartCapableOrAnnounceSkip(TITLE);
 *   (sudoOk ? describe : describe.skip)(TITLE, () => { … });
 */
export function restartCapableOrAnnounceSkip(scenarioTitle: string): boolean {
  const ok = canShellSudo();
  if (!ok) announceRestartSkip(scenarioTitle);
  return ok;
}
