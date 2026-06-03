/**
 * JTBD — always-on: a turn interrupted by a restart is RESUMED without
 * re-prompting, and the resume turn runs to completion (it is not silently
 * dropped into a not-ready session). Regression gate for v0.14.50 / #2122.
 *
 * Flow: send a long-running task, let it get in-flight, then restart the agent
 * (--force, NOT --wait, so it interrupts rather than draining). On boot the
 * gateway finds the orphaned turn and injects the `resume_interrupted`
 * synthetic. With #2122 that synthetic carries meta.chat_id + message_id, so the
 * resumed turn (a) builds a currentTurn (progress card + silence-poke), (b)
 * routes its reply to the originating chat, and (c) re-enrols in
 * deliver-until-acked so a drop into a still-booting session is rescued rather
 * than lost.
 *
 * Assertion: a reply arrives after the interrupting restart whose FRAMING shows
 * the agent is resuming ("picking this back up" / "interrupted" / "cut off by a
 * restart"). We deliberately do NOT assert an end-token: the resume synthetic
 * only carries the first ~160 chars of the original prompt (promptClause
 * truncation), so instructions in the prompt's tail are not guaranteed to
 * survive — the resume FRAMING is the stable, builder-guaranteed signal.
 *
 * Self-skips green without NOPASSWD sudo.
 */

import { describe, it, expect } from "vitest";
import { execSync, spawn } from "node:child_process";
import { spinUp } from "../harness.js";

const AGENT = "test-harness";
const MID_TURN_MS = 10_000;        // let the turn enqueue (become a recorded interrupted turn)
const RESUME_BUDGET_MS = 180_000;  // boot + resume + reply

// The resume builder tells the model to "briefly let the user know you're
// resuming what was interrupted" — so the reply always opens with this framing.
const RESUME_FRAMING = /resum|picking .*back|interrupted|cut off|just restarted/i;

function canShellSudo(): boolean {
  try {
    execSync("sudo -n true", { stdio: "ignore", timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

function kickRestartDetached(name: string): void {
  // --force WITHOUT --wait → recreate now, interrupting the in-flight turn.
  const child = spawn(
    "sudo",
    ["-n", "env", `PATH=${process.env.PATH}`, `HOME=${process.env.HOME}`,
      "switchroom", "agent", "restart", name, "--force"],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

const sudoOk = canShellSudo();

(sudoOk ? describe : describe.skip)("uat: interrupted turn resumes after restart (DM)", () => {
  it(
    "a turn interrupted by a restart is resumed and the resume turn completes",
    async () => {
      const sc = await spinUp({ agent: AGENT, settleMs: 0 });
      try {
        // A task long enough that it's still in-flight at MID_TURN_MS.
        await sc.sendDM(
          `Please write a thorough, detailed ~300-word explanation of how a ` +
          `mechanical typewriter's typebar mechanism works, step by step. Take ` +
          `your time and be complete.`,
        );

        await new Promise((r) => setTimeout(r, MID_TURN_MS));
        kickRestartDetached(AGENT);

        // After boot, the resume synthetic should make the agent pick the work
        // back up and say so. (The newest interrupted turn — this one — is the
        // one findLatestTurnIfInterrupted resumes.)
        const reply = await sc.expectMessage((m) => RESUME_FRAMING.test(m.text), {
          from: "bot",
          timeout: RESUME_BUDGET_MS,
        });
        expect(reply.text).toMatch(RESUME_FRAMING);
        expect(reply.text.length).toBeGreaterThan(40); // a substantive resumed reply, not a stub
      } finally {
        await sc.tearDown();
      }
    },
    RESUME_BUDGET_MS + 60_000,
  );
});
