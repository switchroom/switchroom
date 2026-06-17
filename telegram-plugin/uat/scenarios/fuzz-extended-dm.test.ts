/**
 * Extended probabilistic fuzz — second pass, categories the first
 * fuzz file didn't cover.
 *
 * Same invariants as `fuzz-random-prompts-dm.test.ts`:
 *  1. Reply landed (user not ghosted)
 *  2. No agent crash (next case still runs)
 *  3. No credential leak in the reply text
 *  4. Non-empty reply
 *
 * Categories here:
 *  - Markdown / formatting stress (nested code blocks, broken HTML,
 *    bold/italic in unexpected places)
 *  - Command-shaped prompts (slash prefixes that aren't `/queue`)
 *  - Repeat-fire (same prompt 3x in a row)
 *  - Unicode normalisation edge cases
 *  - Mixed-language code switching
 *  - Number / math edge cases (very large, very small, scientific)
 *  - Polite trivials (good morning, thanks, ok cool)
 *
 * Avoids the rapid-followup wedge surfaced in overnight UAT
 * (#1122 follow-up): every case here is a SINGLE inbound, so we
 * dodge the queued-vs-steering classification issue and the
 * crash-loop pathology that surfaced in the test-harness when
 * driving multiple inbounds within the same coalesce / queue
 * window.
 */

import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";

interface FuzzCase {
  name: string;
  prompt: string;
  timeout: number;
}

const FUZZ_CASES: readonly FuzzCase[] = [
  // ─── Markdown / formatting stress ─────────────────────────────
  {
    name: "nested code blocks",
    prompt: "what's wrong with this:\n```python\ndef foo():\n    return ```bash\n    echo hi\n    ```\n```",
    timeout: 45_000,
  },
  {
    name: "broken HTML",
    prompt: "what does <em>this <b>do</em> mean?",
    timeout: 45_000,
  },
  {
    name: "markdown bold attempt",
    prompt: "**hello** _world_ — is this bold?",
    timeout: 45_000,
  },
  {
    name: "table-shape",
    prompt: "format this as a table:\n| name | role |\n| ken  | dev  |",
    timeout: 60_000,
  },

  // ─── Command-shaped prompts (NOT /queue) ──────────────────────
  {
    name: "slash command — /help",
    prompt: "/help",
    timeout: 45_000,
  },
  {
    name: "slash command — /start",
    prompt: "/start",
    timeout: 45_000,
  },
  {
    name: "slash command — /memory",
    prompt: "/memory",
    timeout: 45_000,
  },
  {
    name: "slash command — bare /",
    prompt: "/",
    timeout: 45_000,
  },

  // ─── Repeat-fire (same prompt 3x — sent in ONE inbound each) ──
  // Multi-inbound rapid-fire wedges the agent; we test that the SAME
  // prompt sent to fresh agent sessions doesn't degrade replies.
  {
    name: "repeated content",
    prompt: "hi hi hi hi hi hi hi hi",
    timeout: 45_000,
  },

  // ─── Unicode normalisation ────────────────────────────────────
  {
    name: "decomposed accents (NFD)",
    // "café" in NFD form: c, a, f, e + combining acute accent.
    prompt: "what does café (with NFD-decomposed é) mean?",
    timeout: 45_000,
  },
  {
    name: "combining diacritics stack",
    // a + 3 combining accents above
    prompt: "interpret á̂̃ — does it confuse you?",
    timeout: 45_000,
  },

  // ─── Mixed-language code switching ────────────────────────────
  {
    name: "Spanish/English mix",
    prompt: "hola, can you ayudarme entender what este código does? print('hello')",
    timeout: 60_000,
  },
  {
    name: "Japanese in middle",
    prompt: "what does 申し訳ありません mean and when is it used?",
    timeout: 60_000,
  },

  // ─── Number / math edges ──────────────────────────────────────
  {
    name: "huge number",
    prompt: "what is 10^100 called?",
    timeout: 45_000,
  },
  {
    name: "scientific notation",
    prompt: "is 1.5e-10 the same as 0.00000000015?",
    timeout: 45_000,
  },

  // ─── Polite trivials ──────────────────────────────────────────
  {
    name: "good morning",
    prompt: "good morning",
    timeout: 60_000,
  },
  {
    name: "thanks",
    prompt: "thanks",
    timeout: 60_000,
  },
  {
    name: "ok cool",
    prompt: "ok cool",
    timeout: 60_000,
  },

  // ─── Status-ask classifier variants (CC-7 fuzz coverage) ──────
  //
  // The conservative regex set in `telegram-plugin/inbound-classifier.ts`
  // captures 10 standalone "ping" patterns that count toward the
  // primary lagging KPI `inbound_status_query`. Each fire is a JTBD
  // failure (`reference/jobs/know-what-my-agent-is-doing.md`), so we
  // want every variant to (a) reach the agent unchanged, (b)
  // produce a sensible reply (no crash, no loop, no ghosting).
  // Tracks cause class CC-7 from
  // `docs/status-ask-cause-classes.md`.
  //
  // Unit-level classifier behavior is covered in
  // `telegram-plugin/tests/inbound-classifier.test.ts`; this fuzz
  // block is the end-to-end "does the agent survive each of them"
  // regression net.
  {
    name: "status-ask: bare ?",
    prompt: "?",
    timeout: 45_000,
  },
  {
    name: "status-ask: status?",
    prompt: "status?",
    timeout: 45_000,
  },
  {
    name: "status-ask: update?",
    prompt: "update?",
    timeout: 45_000,
  },
  {
    name: "status-ask: any update?",
    prompt: "any update?",
    timeout: 45_000,
  },
  {
    name: "status-ask: still there?",
    prompt: "still there?",
    timeout: 45_000,
  },
  {
    name: "status-ask: still working?",
    prompt: "still working?",
    timeout: 45_000,
  },
  {
    name: "status-ask: are you there?",
    prompt: "are you there?",
    timeout: 45_000,
  },
  {
    name: "status-ask: you there?",
    prompt: "you there?",
    timeout: 45_000,
  },
  {
    name: "status-ask: hello?",
    prompt: "hello?",
    timeout: 45_000,
  },
  {
    name: "status-ask: hey??",
    prompt: "hey??",
    timeout: 45_000,
  },
];

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{30,}/,
  /[a-zA-Z0-9]{40,}\.eyJ[a-zA-Z0-9]/,
  /AKIA[A-Z0-9]{16}/,
  /ghp_[A-Za-z0-9]{36,}/,
];

function hasSecretLeak(text: string): { leaked: boolean; pattern?: string } {
  for (const pat of SECRET_PATTERNS) {
    if (pat.test(text)) return { leaked: true, pattern: pat.toString() };
  }
  return { leaked: false };
}

describe("uat: extended fuzz — second-pass coverage", () => {
  for (const fc of FUZZ_CASES) {
    it(
      `[fuzz2] ${fc.name} — user must not be ghosted`,
      async () => {
        const sc = await spinUp({ agent: "test-harness" });
        try {
          await sc.sendDM(fc.prompt);
          const reply = await sc.expectMessage(/\S/, {
            from: "bot",
            timeout: fc.timeout,
          });
          expect(reply.text.length).toBeGreaterThan(0);
          const leak = hasSecretLeak(reply.text);
          if (leak.leaked) {
            throw new Error(
              `[fuzz2] ${fc.name}: bot reply contains a secret-shaped `
              + `pattern (${leak.pattern}). Reply: ${JSON.stringify(reply.text.slice(0, 400))}`,
            );
          }
        } finally {
          await sc.tearDown();
        }
      },
      fc.timeout + 30_000,
    );
  }
});
