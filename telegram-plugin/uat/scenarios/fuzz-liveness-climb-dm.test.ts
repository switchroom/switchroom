/**
 * Fuzz: dead-air-between-visible-updates bound across turn shapes (Phase 4c,
 * `deterministic-turn-liveness.md`). Non-required (`uat-fuzz`,
 * `workflow_dispatch` + scheduled — see `ci-uat.yml`), scoped to `fuzz-*`.
 *
 * SCOPE HONESTY (read before trusting this as "the fuzz invariant" wholesale):
 * the RFC's Phase 4c corpus is message-timing × turn-length × tool-churn ×
 * sub-agent-fan-out × surface × role — a genuinely randomized property-fuzz.
 * That full corpus already exists at the DECISION layer
 * (`telegram-plugin/tests/turn-liveness-invariant.test.ts`, 2000 random
 * shapes × both surfaces, fast/local/every-CI-run). What does NOT exist yet
 * is a live-transport fuzz of the same breadth — each live turn burns real
 * subscription quota and ~30-90s wall-clock, so a 2000-shape live corpus is
 * not realistic to author or run from this sandbox (or CI, at any cadence
 * short of a dedicated long-running canary). This file is the SCAFFOLD:
 * a handful of FIXED, hand-picked turn shapes run on the real surface,
 * checked against the SAME dead-air bound the decision-layer fuzz proves in
 * the abstract. It is not a substitute for a true randomized live corpus —
 * see the RFC's Known gaps / follow-up list, where this limitation is named
 * explicitly rather than left implicit.
 *
 * Each case fires a turn shape, watches the SAME two invariants the keystone
 * (Phase 1) and the dark-turn guard (Phase 2) promise on the real surface:
 *
 *   - dead air between VISIBLE updates (card edits, narration, or the final
 *     answer) never exceeds `MAX_DEAD_AIR_MS` — generous slack over the
 *     ~6-12s Phase-1 bound to absorb live Bot API + model latency jitter;
 *   - zero mid-turn device buzz (no non-final message with `silent===false`).
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";
import { isActivityFeedMessage } from "../assertions.js";
import type { ObservedMessage } from "../driver.js";

const MAX_DEAD_AIR_MS = 25_000; // generous slack over the ~6-12s Phase-1 bound
const CASE_BUDGET_MS = 130_000;

interface FuzzCase {
  name: string;
  prompt: string;
  windowMs: number;
}

const CASES: FuzzCase[] = [
  {
    name: "single-silent-tool-short",
    prompt:
      "Run exactly one Bash command `sleep 20` with NO narration before or " +
      "during it, then reply with a one-line confirmation.",
    windowMs: 30_000,
  },
  {
    name: "single-silent-tool-long",
    prompt:
      "Run exactly one Bash command `sleep 50` with NO narration before or " +
      "during it, then reply with a one-line confirmation.",
    windowMs: 60_000,
  },
  {
    name: "two-silent-tools-back-to-back",
    prompt:
      "Run Bash `sleep 20`, then immediately (no narration in between) run " +
      "Bash `sleep 20` again, then reply with a one-line confirmation.",
    windowMs: 50_000,
  },
];

describe("uat-fuzz: liveness dead-air bound across a handful of turn shapes (Phase 4c scaffold)", () => {
  for (const fc of CASES) {
    it(
      `[${fc.name}] dead air between visible updates never exceeds ${MAX_DEAD_AIR_MS}ms; no mid-turn ping`,
      async () => {
        const sc = await spinUp({ agent: "test-harness" });
        try {
          const iter = sc.driver
            .observeMessages(sc.botUserId)
            [Symbol.asyncIterator]();

          await sc.sendDM(fc.prompt);
          const sentAt = Date.now();
          let lastVisibleAt = sentAt;
          let maxGap = 0;
          let answer: ObservedMessage | null = null;
          let loudMidTurn: ObservedMessage | null = null;

          const deadline = Date.now() + fc.windowMs + 40_000;
          while (Date.now() < deadline) {
            if (answer) break;
            const remaining = deadline - Date.now();
            const next = await Promise.race([
              iter.next(),
              new Promise<{ done: true; value: undefined }>((r) =>
                setTimeout(() => r({ done: true, value: undefined }), Math.max(0, remaining)),
              ),
            ]);
            if (next.done || next.value == null) break;
            const m = next.value as ObservedMessage;
            if (m.senderUserId === sc.driverUserId) continue;

            const now = Date.now();
            if (isActivityFeedMessage(m)) {
              const gap = now - lastVisibleAt;
              maxGap = Math.max(maxGap, gap);
              lastVisibleAt = now;
              if (m.edited && m.silent === false) loudMidTurn = loudMidTurn ?? m;
              continue;
            }
            if (m.edited) continue;
            if (!answer && m.text.trim().length > 0) {
              answer = m;
              const gap = now - lastVisibleAt;
              maxGap = Math.max(maxGap, gap);
              continue;
            }
            if (m.silent === false) loudMidTurn = loudMidTurn ?? m;
          }
          await iter.return?.();

          console.log(
            `[fuzz-liveness-climb][${fc.name}] maxGap=${maxGap}ms answer=${answer != null}`,
          );

          expect(
            loudMidTurn,
            `[${fc.name}] a mid-turn message pinged the device: ` +
              JSON.stringify(loudMidTurn?.text?.slice(0, 120)),
          ).toBeNull();

          expect(answer, `[${fc.name}] FAIL — no answer within budget; turn may be wedged.`).not.toBeNull();

          expect(
            maxGap,
            `[${fc.name}] dead air of ${maxGap}ms between visible updates exceeds the ` +
              `${MAX_DEAD_AIR_MS}ms bound — the Phase-1 climb should have kept the card ` +
              "moving throughout the silent tool stretch.",
          ).toBeLessThanOrEqual(MAX_DEAD_AIR_MS);
        } finally {
          await sc.tearDown();
        }
      },
      CASE_BUDGET_MS,
    );
  }
});
