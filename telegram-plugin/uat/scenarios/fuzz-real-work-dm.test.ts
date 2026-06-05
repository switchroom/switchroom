/**
 * Real-work UAT (DM) — human-style prompts that trigger genuine work
 * (multi-tool / web research / sub-agents / background workers), asserting the
 * status-surface + reply-ordering invariants the conversational fuzz never
 * exercised. The status-dark, orphaned-reply-fragment, and late-reply bugs only
 * appear when the agent actually does work; these prompts provoke it in a human
 * voice, `collectTurn` captures the whole bot-message sequence, and `analyzeTurn`
 * flags the known bug signatures. See real-work-prompts.ts for rationale + the
 * mtcute harness limits.
 */
import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";
import {
  REAL_WORK_CASES,
  collectTurn,
  analyzeTurn,
  summarizeTurn,
} from "../real-work-prompts.js";

describe("uat: real-work DM — status surface + ordering under genuine work", () => {
  for (const fc of REAL_WORK_CASES) {
    it(
      `[real-work] ${fc.name} (${fc.kind}) — answer lands, surface holds`,
      async () => {
        const sc = await spinUp({ agent: "test-harness" });
        try {
          const obs = await collectTurn(
            sc.driver,
            sc.botUserId,
            sc.driverUserId,
            fc.prompt,
            { timeoutMs: fc.timeoutMs, minAnswerChars: fc.minAnswerChars },
          );
          // Forensic log — the bug hunt reads these to spot dark feeds, late
          // fragments, and surface gaps even on cases that "pass".
          console.log(summarizeTurn(fc.name, obs));
          if (obs.answer != null) {
            console.log(
              `[real-work] ${fc.name} answer: ${JSON.stringify(obs.answer.text.slice(0, 180))}`,
            );
          }

          const { violations, warnings } = analyzeTurn(obs, {
            requireSurface: fc.requireSurface,
            chatId: sc.botUserId,
          });
          for (const w of warnings) {
            console.warn(`[real-work] ${fc.name}: WARN ${w.code}: ${w.detail}`);
          }
          if (violations.length > 0) {
            throw new Error(
              `[real-work] ${fc.name}: ${violations.length} invariant violation(s):\n` +
                violations.map((x) => `  - ${x.code}: ${x.detail}`).join("\n"),
            );
          }
          expect(obs.answer).not.toBeNull();
        } finally {
          await sc.tearDown();
        }
      },
      fc.timeoutMs + 45_000,
    );
  }
});
