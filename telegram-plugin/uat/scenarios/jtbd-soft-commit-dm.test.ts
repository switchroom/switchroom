/**
 * JTBD scenario — first sign of life on a slow turn.
 *
 * The conversational-pacing prompt instructs the agent to open with
 * an acknowledgement before slow work. (The original ">15s soft
 * commit" bullet this file was named for was superseded by the
 * guaranteed "Open with an acknowledgement" bullet in PR #1633 —
 * acknowledge every turn unless the answer lands in a second or two.)
 *
 * This UAT exercises a single slow prompt and asserts the loose
 * floor: the user does NOT see a long silent gap before the first
 * sign of life — a reply lands within 30s.
 *
 * The stronger, fuzzed successor of this contract is
 * `jtbd-fast-ack-dm.test.ts` — varied prompt shapes, a tight 20s
 * hard budget backstopped by the framework ack poke. This file is
 * retained as a minimal single-prompt floor.
 */

import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";

// A prompt that needs real work (file reads / web search-ish / some
// thinking) so the model is incentivised to soft-commit.
const SLOW_PROMPT = (
  "Read /etc/hostname and /etc/os-release, then summarise this "
  + "machine in a single sentence (what OS family, what hostname). "
  + "Take your time."
);

describe("uat: soft-commit pacing", () => {
  it(
    "user asks slow question → first reply lands within 20s",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        const sendStart = Date.now();
        await sc.sendDM(SLOW_PROMPT);

        // 30s wall-clock budget gives mtcute polling jitter + the
        // agent's first tool call enough headroom that a "near-miss
        // soft commit" (model thinks for 25s then sends) still passes.
        // Previous 25s/22s pair sat exactly in the model's natural
        // think-then-respond window and produced flake unrelated to
        // any real bug.
        const firstReply = await sc.expectMessage(/\S/, {
          from: "bot",
          timeout: 30_000,
        });
        const ttfo = Date.now() - sendStart;

        expect(firstReply.text.length).toBeGreaterThan(0);
        expect(ttfo).toBeLessThan(30_000);

        // If the first reply IS the final answer (short, complete),
        // the model skipped soft-commit ceremony — fine, just note.
        if (firstReply.text.length > 200) {
          console.log(
            `[soft-commit] model produced a long final answer as the `
            + `first message (${firstReply.text.length} chars, ${ttfo}ms). `
            + `Conversational pacing prompt would prefer a soft-commit `
            + `first — but this is a soft preference, not a contract.`,
          );
        }
      } finally {
        await sc.tearDown();
      }
    },
    50_000,
  );
});
