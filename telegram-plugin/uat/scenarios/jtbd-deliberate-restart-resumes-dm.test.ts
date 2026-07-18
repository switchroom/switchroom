/**
 * JTBD scenario named by `reference/jobs/survive-reboots-and-real-life.md`
 * § Prove it — "Deliberate restart resumes, bounded (DM)".
 *
 * Contract under test (#2988): a DELIBERATE restart (operator
 * `switchroom agent restart`, i.e. a clean SIGTERM shutdown with a
 * clean-shutdown marker) that lands MID-TURN resumes the interrupted turn
 * like a crash-class interruption. The quota-saving suppression applies only
 * when nothing was in flight — it never swallows mid-turn work. And the
 * resume is bounded: AT MOST ONCE per interruption (the loop-guard caps the
 * resume chain), so we also assert no second resume-framed turn fires after
 * the first completes.
 *
 * Sibling: `jtbd-interrupted-turn-resumes-dm.test.ts` (same interruption
 * mechanics; this scenario adds the deliberate-restart class + the
 * at-most-once bound). Decision-level twin: `decideBootResumeKind` cases in
 * `tests/resume-inbound-builder.test.ts` (BOUNDED CHAIN) and
 * `shouldSuppressBootResume` in `tests/gateway-clean-shutdown-marker.test.ts`.
 *
 * Self-skips green without NOPASSWD sudo.
 */

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { spinUp } from "../harness.js";
import { restartCapableOrAnnounceSkip } from "../restart-capability.js";

const AGENT = "test-harness";
const SCENARIO_TITLE =
  "uat: deliberate restart mid-turn resumes exactly once (DM, #2988)";
const MID_TURN_MS = 10_000;        // let the turn get in-flight before the bounce
const RESUME_BUDGET_MS = 180_000;  // boot + resume + reply
const QUIET_WINDOW_MS = 90_000;    // after the resume completes, no second resume may fire
// Messages landing within this window of the FIRST resume-framed reply are
// treated as the same resumed turn (e.g. a progress line plus the final
// answer of one turn) — only a resume-framed message AFTER it counts as a
// second resume for the at-most-once bound.
const SAME_TURN_GRACE_MS = 20_000;

const RESUME_FRAMING = /resum|picking .*back|interrupted|cut off|just restarted/i;

function kickRestartDetached(name: string): void {
  // A deliberate operator restart: clean SIGTERM path, clean-shutdown marker
  // written — the exact class #2988 makes resume in-flight work through.
  const child = spawn(
    "sudo",
    ["-n", "env", `PATH=${process.env.PATH}`, `HOME=${process.env.HOME}`,
      "switchroom", "agent", "restart", name, "--force"],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

const sudoOk = restartCapableOrAnnounceSkip(SCENARIO_TITLE);

(sudoOk ? describe : describe.skip)(
  SCENARIO_TITLE,
  () => {
    it(
      "an operator restart mid-turn resumes the work once, and never a second time",
      async () => {
        const sc = await spinUp({ agent: AGENT, settleMs: 0 });
        try {
          // A task long enough to still be in flight at MID_TURN_MS.
          await sc.sendDM(
            `Please write a thorough, detailed ~300-word explanation of how a ` +
            `player piano's pneumatic action reads a music roll, step by step. ` +
            `Take your time and be complete.`,
          );

          await new Promise((r) => setTimeout(r, MID_TURN_MS));
          kickRestartDetached(AGENT);

          // 1. In-flight work resumes: quota-saving suppression must NOT
          //    swallow a turn that was mid-flight at the bounce. Edits are
          //    excluded — a progress-card edit must not satisfy this; only
          //    a genuinely NEW message from the resumed turn counts.
          const reply = await sc.expectMessage(
            (m) => !m.edited && RESUME_FRAMING.test(m.text),
            { from: "bot", timeout: RESUME_BUDGET_MS },
          );
          expect(reply.text).toMatch(RESUME_FRAMING);
          expect(reply.text.length).toBeGreaterThan(40);

          // 2. Bounded chain: with the interruption resolved, no SECOND
          //    resume-framed turn may fire (at-most-once per interruption).
          //    Edits are excluded, and messages within SAME_TURN_GRACE_MS of
          //    the first reply are deduped as part of the SAME resumed turn
          //    (two resume-ish lines in one turn are not a second resume).
          const firstReplyAt = reply.date.getTime();
          let second: unknown = null;
          try {
            second = await sc.expectMessage(
              (m) =>
                !m.edited &&
                m.messageId !== reply.messageId &&
                m.date.getTime() > firstReplyAt + SAME_TURN_GRACE_MS &&
                RESUME_FRAMING.test(m.text),
              { from: "bot", timeout: QUIET_WINDOW_MS },
            );
          } catch {
            // timeout is the PASS: no repeat resume.
          }
          expect(second).toBeNull();
        } finally {
          await sc.tearDown();
        }
      },
      RESUME_BUDGET_MS + QUIET_WINDOW_MS + 120_000,
    );
  },
);
