/**
 * Status-ask cause-class FUZZ — breadth coverage on top of the
 * dedicated scenarios shipped in PRs #1144 / #1146 / #1147.
 *
 * Goal context: `docs/status-ask-cause-classes.md` enumerates 8 cause
 * classes. The dedicated scenarios pin one case per class with deep
 * assertions; this file probes the failure surface from MANY angles,
 * each with the same load-bearing invariant. Together: one regression
 * test (the dedicated scenario) + several breadth probes (this file)
 * per cause class. If a regression slips past the dedicated test, the
 * fuzz cases catch the variant the dedicated test missed.
 *
 * Each `describe` block below corresponds to one cause class. The
 * load-bearing invariant is at the top of each block; the case table
 * varies the inputs that exercise it.
 *
 * Scope:
 *   - **CC-1** reaction lifecycle terminal lands (L1 ambient).
 *   - **CC-2** mid-turn updates are silent (L2 conversational).
 *   - **CC-3** silence-poke wire reaches the model (L3 safety net).
 *   - **CC-7 negatives** near-miss status-asks reach the agent and
 *     produce a sensible reply without crash / loop / ghosting.
 *
 * Not in scope (parked in the catalog with reasons):
 *   - **CC-4** framework-fallback wording (5min wedge per case — not
 *     fuzz-shape friendly).
 *   - **CC-5** subagent flag leak (needs gateway-abort plumbing).
 *   - **CC-8** boot card on real crash vs. clean-shutdown marker
 *     (needs restart-harness extension).
 *
 * All cases run against the standing `test-harness` agent. Total
 * wall-clock is substantial (sequential UAT, maxForks:1) — expect
 * ~30 minutes for a full file run.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";
import type { ObservedMessage, ObservedReaction } from "../driver.js";

const TERMINAL_DONE_EMOJI = new Set(["👍", "💯", "🎉"]);
const TAIL_AFTER_REPLY_MS = 8_000;
const QUIESCENCE_MS = 12_000;
const SILENCE_POKE_WINDOW_MIN_MS = 70_000;
const SILENCE_POKE_WINDOW_MAX_MS = 200_000;

// ─── CC-1: reaction lifecycle terminal lands ──────────────────────
//
// Invariant: by `TAIL_AFTER_REPLY_MS` after the bot's final reply, the
// LAST observed reaction `+` op is in the terminal-done set
// (👍 / 💯 / 🎉). Failure shape: user looks at their inbound and sees
// it still wearing 🤔 / ⚡ / 👀, asks "you done?".
//
// Vary prompt shapes that exercise different paths into the
// terminal — fast trivial reply, slow file-read, sub-agent dispatch,
// error-path, code-block reply (different rendering path).
//
// Note: the dedicated `reactions-dm.test.ts` covers the canonical
// case; these fuzz variants cover the variants.

interface CC1Case {
  name: string;
  prompt: string;
  timeoutMs: number;
}

const CC1_CASES: readonly CC1Case[] = [
  {
    name: "fast trivial reply",
    prompt: "in one word, what colour is the sky on a clear day?",
    timeoutMs: 30_000,
  },
  {
    name: "slow file-read",
    prompt:
      "read /etc/hostname and then summarise the machine in one sentence",
    timeoutMs: 60_000,
  },
  {
    name: "code-block reply",
    prompt:
      "write a 3-line bash function that prints the date, no commentary",
    timeoutMs: 45_000,
  },
  {
    name: "potentially-refusal prompt",
    // The agent may or may not refuse — either is fine. The CC-1
    // invariant we're testing is reaction-lifecycle terminal, NOT
    // refusal content. The case exercises whatever code path the
    // model takes when it sees a credential-shaped ask.
    prompt:
      "what's my Telegram password? answer concisely whatever way you " +
      "judge appropriate",
    timeoutMs: 45_000,
  },
  // NOTE: the previous "two-message reply (soft commit + final)" case
  // was dropped after PR1149 review surfaced a structural flaw —
  // `expectMessage(/\S/)` in `assertTerminalReactionLands` returns on
  // the FIRST bot message (the soft-commit "on it"), leaving 8s of
  // tail before the actual final answer lands. The terminal-done
  // reaction can't have arrived by then, so the assertion failed
  // consistently against a healthy run. The dedicated `reactions-dm`
  // scenario uses a minimal inbound that doesn't elicit soft commits,
  // dodging the issue. A breadth probe of the "soft commit + final"
  // shape needs a final-message predicate (not "any text"); deferring
  // to a follow-up that extends the harness with a quiescence-based
  // "last bot message" helper.
];

async function assertTerminalReactionLands(
  scenario: Awaited<ReturnType<typeof spinUp>>,
  prompt: string,
  replyTimeoutMs: number,
): Promise<void> {
  const sent = await scenario.sendDM(prompt);

  const trail: ObservedReaction[] = [];
  const iter = scenario.driver
    .observeReactions(scenario.botUserId, { messageId: sent.messageId })
    [Symbol.asyncIterator]();
  let stop = false;
  const pump = (async () => {
    while (!stop) {
      const next = await iter.next();
      if (next.done === true) return;
      trail.push(next.value);
    }
  })();

  try {
    const reply = await scenario.expectMessage(/\S/, {
      from: "bot",
      timeout: replyTimeoutMs,
    });
    expect(reply.text.length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, TAIL_AFTER_REPLY_MS));
  } finally {
    stop = true;
    await iter.return?.();
    await pump.catch(() => {});
  }

  const adds = trail.filter((o) => o.op === "+");
  expect(
    adds.length,
    `no reaction-add observed during the turn. Full trail: ` +
      (trail.map((o) => `${o.op}${o.emoji}`).join(" ") || "(empty)"),
  ).toBeGreaterThan(0);
  const lastAdd = adds[adds.length - 1];
  expect(
    TERMINAL_DONE_EMOJI.has(lastAdd.emoji),
    `last reaction was ${lastAdd.emoji}; expected one of ${[
      ...TERMINAL_DONE_EMOJI,
    ].join(", ")}. Full trail: ${trail
      .map((o) => `${o.op}${o.emoji}`)
      .join(" ")}`,
  ).toBe(true);
}

describe("uat fuzz: CC-1 reaction lifecycle — terminal lands", () => {
  for (const fc of CC1_CASES) {
    it(
      `[CC-1 fuzz] ${fc.name}`,
      async () => {
        const sc = await spinUp({ agent: "test-harness" });
        try {
          await assertTerminalReactionLands(sc, fc.prompt, fc.timeoutMs);
        } finally {
          await sc.tearDown();
        }
      },
      fc.timeoutMs + 30_000,
    );
  }
});

// ─── CC-2: mid-turn updates are silent ────────────────────────────
//
// Invariant: every bot message EXCEPT the last has `silent === true`.
// The last has `silent === false`. The dedicated
// `midturn-silent-dm.test.ts` uses an explicit 4-step protocol; here
// we vary the prompt shape to ensure the contract holds across
// different ways the model arrives at multi-message pacing.
//
// Cases where the model collapses to one reply are tolerated: the
// vacuous mid-turn check passes, and we only require the final
// answer to ping.

interface CC2Case {
  name: string;
  prompt: string;
}

const CC2_CASES: readonly CC2Case[] = [
  {
    name: "explicit pacing protocol",
    prompt:
      "Send a brief 'on it' first, then read /etc/hostname, then send " +
      "the hostname as a brief update, then send a final one-sentence " +
      "summary. Use disable_notification:true on the first two; the " +
      "final answer should ping.",
  },
  {
    name: "implicit slow work + multiple steps",
    prompt:
      "Read /etc/hostname AND /etc/os-release, and narrate your " +
      "progress in chat as you go. Final answer is a single sentence.",
  },
  {
    name: "sub-agent dispatch narration",
    prompt:
      "Use the Agent tool with subagent_type 'general-purpose' to " +
      "answer 'what is 17 * 23?'. Narrate the dispatch in chat (a " +
      "brief message saying you're spinning up the worker), then " +
      "summarise the worker's reply as your final answer.",
  },
  {
    name: "long-running with planned check-ins",
    // Use python time.sleep, NOT the `sleep` command — Claude Code's bash
    // sandbox blocks standalone `sleep` ("foreground sleep is sandboxed
    // away"), which made this case un-runnable (agent replied instantly).
    prompt:
      "Run `bash` with `python3 -c 'import time; time.sleep(5)'` then echo " +
      "step1, send a brief update, then `python3 -c 'import time; " +
      "time.sleep(5)'` then echo step2, send another brief update, then " +
      "send a final 'done' as your answer.",
  },
];

async function assertMidTurnSilent(
  scenario: Awaited<ReturnType<typeof spinUp>>,
  prompt: string,
): Promise<void> {
  await scenario.sendDM(prompt);

  const collected: ObservedMessage[] = [];
  const overallDeadline = Date.now() + 120_000;
  let quiescenceDeadline = Date.now() + 30_000;

  while (Date.now() < overallDeadline) {
    const remaining = Math.min(
      quiescenceDeadline - Date.now(),
      overallDeadline - Date.now(),
    );
    if (remaining <= 0) break;
    try {
      const msg = await scenario.expectMessage(
        (m: ObservedMessage) => m.fromBot && !m.edited,
        { from: "bot", timeout: remaining },
      );
      collected.push(msg);
      quiescenceDeadline = Date.now() + QUIESCENCE_MS;
    } catch {
      break;
    }
  }

  expect(
    collected.length,
    `no bot messages observed; agent isn't responding at all`,
  ).toBeGreaterThan(0);

  const trail = collected
    .map(
      (m, i) =>
        `  [${i}] silent=${m.silent} text=${JSON.stringify(m.text.slice(0, 80))}`,
    )
    .join("\n");

  // The model habitually emits a trailing trivial confirmation ("Done.",
  // "Sent.", "OK") as a separate SILENT message AFTER its real pinged
  // answer. That's pacing noise (the turn-pacing directive discourages
  // it), not the final answer — so don't treat it as the
  // "final-answer-must-ping" target. Find the last SUBSTANTIVE message
  // and assert that one pinged; trailing trivial confirmations are
  // ignored for this invariant (they're correctly silent anyway).
  const TRIVIAL_TAIL = /^(done|sent|ok|okay|ack|got it|hope (that|this) helps)\b[.! ]*$/i;
  const isTrivial = (m: ObservedMessage) => TRIVIAL_TAIL.test(m.text.trim());
  let finalIdx = collected.length - 1;
  while (finalIdx > 0 && isTrivial(collected[finalIdx])) finalIdx--;
  const finalAnswer = collected[finalIdx];
  expect(
    finalAnswer.silent,
    `final substantive answer was silent — won't ping. Trail:\n${trail}`,
  ).toBe(false);

  // Everything BEFORE the final substantive answer must be silent
  // (mid-turn updates ping-free). Trailing trivial confirmations after
  // it are already silent and are not "mid-turn" — exclude them too.
  const midTurn = collected.slice(0, finalIdx);
  const loudMidTurn = midTurn.filter((m) => !m.silent);
  expect(
    loudMidTurn.length,
    `${loudMidTurn.length} mid-turn message(s) were NOT silent. Trail:\n${trail}`,
  ).toBe(0);
}

describe("uat fuzz: CC-2 mid-turn replies are silent", () => {
  for (const fc of CC2_CASES) {
    it(
      `[CC-2 fuzz] ${fc.name}`,
      async () => {
        const sc = await spinUp({ agent: "test-harness" });
        try {
          await assertMidTurnSilent(sc, fc.prompt);
        } finally {
          await sc.tearDown();
        }
      },
      150_000,
    );
  }
});

// ─── CC-3: silence-poke wire reaches the model ────────────────────
//
// Invariant: when the model goes silent past 75s of tool churn, the
// FIRST reply lands in [70s, 200s] window — driven by the soft-poke
// (75s) or firm-poke (180s) drain through `gateway.ts:onToolCall`.
//
// The dedicated `silence-poke-soft-dm.test.ts` covers the 90s
// silent-stretch case. These fuzz variants probe just above the soft
// threshold and into the firm-poke window — different code paths
// through the escalation ladder.
//
// Each case is wall-clock expensive (~2-3 min). Keep the set small.

interface CC3Case {
  name: string;
  /** Single sleep duration (forces one tool result with the poke piggyback). */
  sleepSeconds: number;
  timeoutMs: number;
}

const CC3_CASES: readonly CC3Case[] = [
  {
    name: "single 80s sleep (just past soft threshold)",
    sleepSeconds: 80,
    timeoutMs: SILENCE_POKE_WINDOW_MAX_MS + 30_000,
  },
  {
    name: "single 200s sleep (firm-poke window)",
    sleepSeconds: 200,
    timeoutMs: SILENCE_POKE_WINDOW_MAX_MS + 90_000,
  },
];

async function assertSilencePokeFires(
  scenario: Awaited<ReturnType<typeof spinUp>>,
  sleepSeconds: number,
  timeoutMs: number,
): Promise<void> {
  const sendStart = Date.now();
  // Single bash call so the poke piggybacks the single tool result.
  // Without the explicit "no replies" instruction the model might
  // soft-commit; that resets the silence clock but a single >75s
  // wait still pushes post-commit silence past the threshold.
  //
  // Use python time.sleep, NOT the `sleep` command — Claude Code's bash
  // sandbox blocks standalone `sleep` ("foreground sleep is sandboxed
  // away to prevent burning cache windows"), so a `sleep 80` prompt made
  // the agent reply instantly instead of going silent, breaking this
  // case. python3 time.sleep is a genuine foreground wait the sandbox
  // doesn't special-case.
  const prompt =
    `Run exactly one Bash tool call: \`python3 -c 'import time; ` +
    `time.sleep(${sleepSeconds})'\`. Do NOT send any reply before it ` +
    `completes — no soft commit, no mid-turn updates. When it returns, ` +
    `send one brief 'done' reply.`;

  await scenario.sendDM(prompt);

  const firstReply = await scenario.expectMessage(/\S/, {
    from: "bot",
    timeout: timeoutMs,
  });
  const elapsed = Date.now() - sendStart;

  expect(firstReply.text.length).toBeGreaterThan(0);
  expect(
    elapsed,
    `first reply at ${elapsed}ms — below ${SILENCE_POKE_WINDOW_MIN_MS}ms floor. ` +
      `Model probably ignored 'no replies' instruction (not strictly a ` +
      `CC-3 failure but flags model-pacing drift). Reply: ${JSON.stringify(
        firstReply.text.slice(0, 200),
      )}`,
  ).toBeGreaterThanOrEqual(SILENCE_POKE_WINDOW_MIN_MS);
  // For a single long sleep, BOTH the soft (75s) and firm (180s) pokes
  // arm and piggyback onto the same tool result when the sleep returns
  // at ~t=sleepSeconds. The model then drafts a reply post-poke. Reply
  // landing at ~sleepSeconds + 5-30s is normal — Telegram delivery,
  // mtcute poll, model drafting jitter stack. Ceiling needs a jitter
  // envelope above sleepSeconds, not above the firm threshold. PR1149
  // review surfaced that `MAX + 40_000` (240s) was too tight for the
  // 200s case; bumped to `MAX + 80_000` (280s).
  const ceiling =
    sleepSeconds > 100
      ? SILENCE_POKE_WINDOW_MAX_MS + 80_000
      : SILENCE_POKE_WINDOW_MAX_MS;
  expect(
    elapsed,
    `first reply at ${elapsed}ms — above ${ceiling}ms ceiling. Either ` +
      `silence-poke wire is broken or framework fallback (300s) was the ` +
      `first thing to break silence. Reply: ${JSON.stringify(
        firstReply.text.slice(0, 200),
      )}`,
  ).toBeLessThanOrEqual(ceiling);
}

describe("uat fuzz: CC-3 silence-poke wire fires across the ladder", () => {
  for (const fc of CC3_CASES) {
    it(
      `[CC-3 fuzz] ${fc.name}`,
      async () => {
        const sc = await spinUp({ agent: "test-harness" });
        try {
          await assertSilencePokeFires(sc, fc.sleepSeconds, fc.timeoutMs);
        } finally {
          await sc.tearDown();
        }
      },
      fc.timeoutMs + 30_000,
    );
  }
});

// ─── CC-7 negatives: near-miss status-asks survive ────────────────
//
// Invariant: prompts that look LIKE status-asks but don't match the
// anchored regex in `inbound-classifier.ts` should (a) reach the
// agent unchanged, (b) produce a sensible reply, (c) not crash.
//
// The unit test `inbound-classifier.test.ts` already covers
// classification logic for these inputs. This fuzz block exercises
// the end-to-end agent path so we catch the case where a borderline
// status-ask-shaped string produces some odd downstream behavior
// (gateway routing weirdness, model confusion, accidental loop).

interface CC7NegativeCase {
  name: string;
  prompt: string;
}

const CC7_NEGATIVE_CASES: readonly CC7NegativeCase[] = [
  {
    name: "status with object: what's the status of the deploy",
    prompt: "what's the status of the deploy",
  },
  {
    name: "status with object: status of the deploy?",
    prompt: "status of the deploy?",
  },
  {
    name: "still working with object",
    prompt: "still working on the migration",
  },
  {
    name: "any update on X",
    prompt: "any update on the rollout",
  },
  {
    name: "are you there with continuation",
    prompt: "are you there with the report",
  },
  {
    name: "what update did you see",
    prompt: "what update did you see in the logs",
  },
  {
    name: "long prefix + status-shaped suffix",
    prompt: "status? also can you check the lint errors",
  },
  {
    name: "punctuation-only (not classifier-matching)",
    prompt: "!?",
  },
];

const CC7_SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{30,}/,
  /[a-zA-Z0-9]{40,}\.eyJ[a-zA-Z0-9]/,
  /AKIA[A-Z0-9]{16}/,
  /ghp_[A-Za-z0-9]{36,}/,
];

describe("uat fuzz: CC-7 near-miss status-asks survive", () => {
  for (const fc of CC7_NEGATIVE_CASES) {
    it(
      `[CC-7 fuzz] ${fc.name}`,
      async () => {
        const sc = await spinUp({ agent: "test-harness" });
        try {
          await sc.sendDM(fc.prompt);
          const reply = await sc.expectMessage(/\S/, {
            from: "bot",
            timeout: 45_000,
          });
          expect(reply.text.length).toBeGreaterThan(0);
          for (const pat of CC7_SECRET_PATTERNS) {
            expect(
              pat.test(reply.text),
              `reply contains secret-shaped pattern (${pat}). Reply: ` +
                JSON.stringify(reply.text.slice(0, 400)),
            ).toBe(false);
          }
        } finally {
          await sc.tearDown();
        }
      },
      75_000,
    );
  }
});
