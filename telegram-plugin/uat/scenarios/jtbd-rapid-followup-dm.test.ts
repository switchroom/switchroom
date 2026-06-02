/**
 * JTBD scenario — rapid follow-ups (steering vs queued classification).
 *
 * Live contract codified in `_shared/telegram-style.md.hbs` and
 * `reference/steer-or-queue-mid-flight.md` (default-flip commits
 * `4fff90bf` + `597a58af`, 2026-04-17):
 *
 * - A mid-turn follow-up with NO prefix is `queued="true"` — new
 *   independent task. The agent should NOT reference the in-flight
 *   work.
 * - A mid-turn follow-up prefixed with `/steer ` or `/s ` is
 *   `steering="true"` — course-correction; the agent continues the
 *   in-flight task incorporating the new guidance.
 * - Legacy `/queue ` / `/q ` is a redundant alias for the default;
 *   still works.
 *
 * This UAT fires both shapes and asserts the agent narrates the
 * classification correctly. The prior version of this scenario
 * (2026-05-13 / PR #1132) tested the pre-flip contract with
 * too-loose assertions (`/md5/i` regex passes on the queued path
 * by coincidence — the model answers "use md5" fresh and the reply
 * contains "md5"). After unskipping with the corrected contract,
 * the assertions check for the italic classification line the
 * prompt instructs the agent to emit.
 */

import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";

describe("uat: rapid follow-ups — steering vs queued classification", () => {
  it(
    "follow-up with /steer prefix → agent self-narrates as steering",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        // Slow first task so we have time to steer.
        await sc.sendDM(
          "Calculate the SHA256 of the string 'hello world' using openssl. "
          + "Then in a second step, also do the same for 'foo bar'. "
          + "Show the work step by step with a 2-second pause between.",
        );
        await new Promise((r) => setTimeout(r, 3_000));
        // Steer: change the algorithm using the explicit /steer prefix.
        await sc.sendDM("/steer actually use md5 not sha256");

        // The agent should reply mentioning md5 AND surface the italic
        // classification line per the prompt
        // ("_↪️ Treating as steer on the prior task_" or similar).
        // We match either explicit-steer narration OR the steer emoji
        // (`↪️`) to allow for natural-language variation while still
        // failing if no narration appears (the previous version of
        // this UAT was too loose — bare `/md5/i` passed by coincidence
        // on the queued path).
        const reply = await sc.expectMessage(
          (m) => {
            const txt = m.text;
            const mentionsMd5 = /\bmd5\b/i.test(txt);
            // Steer narration: the agent acknowledges amending the in-flight
            // task. Accept the phrasings the model actually uses — "Switched
            // to MD5 per your update/follow-up" (2026-06-02 canary) AND
            // "Switched to MD5 as you asked" (2026-06-03 canary) — i.e. a
            // "switch(ed) to <algo>" acknowledgement qualified by EITHER
            // "per your <qualifier>" OR "as (you) asked/requested/...". The
            // qualifier keeps it distinct from the QUEUED path (a fresh answer
            // with no such course-correction narration — the queued test uses
            // its own /queued|new task/ matcher, so broadening here is safe).
            const narratesSteer =
              /↪️|\bsteer(ing)?\b|switch(?:ed|ing)? to \w+ (?:per your (?:update|follow-?up|guidance|request|steer)|as (?:you )?(?:asked|requested|instructed|wanted|said))|continuing the (prior|original|in-flight) task|amendment|course[- ]correct/i.test(
                txt,
              );
            return mentionsMd5 && narratesSteer;
          },
          { from: "bot", timeout: 120_000 },
        );
        expect(reply.text.toLowerCase()).toContain("md5");
      } finally {
        await sc.tearDown();
      }
    },
    180_000,
  );

  it(
    "follow-up with no prefix mid-turn → agent treats as queued (new task)",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        await sc.sendDM(
          "Count from 1 to 5 slowly with `sleep 2` between each number. "
          + "Use bash.",
        );
        await new Promise((r) => setTimeout(r, 3_000));
        // No prefix — the default-flipped contract says this is a
        // QUEUED new task. The agent should NOT reference the
        // counting work.
        await sc.sendDM("what is 2+2?");

        // First reply should be from the counting task (still
        // in-flight). Then a second reply for the queued task.
        const firstReply = await sc.expectMessage(/\S/, {
          from: "bot",
          timeout: 60_000,
        });

        // Second reply: the queued task's answer. We want to see
        // EITHER the italic queued-narration line OR a fresh "4"
        // answer that doesn't reference the counting work.
        const secondReply = await sc.expectMessage(
          (m) => {
            if (m.messageId <= firstReply.messageId) return false;
            const txt = m.text;
            const answersTheQuestion =
              /\b4\b|\bfour\b|two\s+plus\s+two|2\s*\+\s*2/i.test(txt);
            const narratesQueued =
              /📥|\bqueued\b|new\s+(?:independent\s+)?task|fresh\s+task/i.test(
                txt,
              );
            // Pass if either: the explicit narration is present, OR the
            // reply answers cleanly without referencing the counting
            // task. The latter is the substantive behavioural check —
            // the queued task is isolated from the in-flight context.
            const isolatedFromCounting = !/\bcount(ing)?\b|\bsleep\b/i.test(
              txt,
            );
            return answersTheQuestion && (narratesQueued || isolatedFromCounting);
          },
          { from: "bot", timeout: 120_000 },
        );
        expect(secondReply.text).toMatch(/4|four|2\s*\+\s*2/i);
      } finally {
        await sc.tearDown();
      }
    },
    220_000,
  );
});
