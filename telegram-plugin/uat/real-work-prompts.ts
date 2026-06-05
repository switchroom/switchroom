/**
 * Real-work UAT coverage — human-style prompts that trigger actual work
 * (multi-tool, web research, sub-agents, background workers) plus a turn
 * collector + bug detectors for the failure classes the conversational fuzz
 * never exercised.
 *
 * Why this exists: the existing fuzz scenarios send conversational prompts
 * ("hey how's it going", emoji, markdown edge-cases) → trivial fast replies.
 * The status-surface and reply-ordering bugs (live feed going dark mid-work,
 * the orphaned-reply backstop flushing a fragment then the real answer landing
 * late and out of order, late replies misrouting) only manifest when the agent
 * does REAL work — uses tools/MCPs, spawns sub-agents, researches long enough to
 * cross the silence-poke / orphaned-reply thresholds. These prompts provoke that
 * work in a human voice; `collectTurn` captures the whole bot-message sequence;
 * `analyzeTurn` flags the known bug signatures.
 *
 * Harness limits (see CLAUDE.md): mtcute observes real sendMessage/editMessageText
 * (so the activity feed `→/✓` and worker feed `🛠` ARE observable) but NOT drafts
 * or reactions, and has no forum-topic API (channel scenarios use the General
 * topic — they prove DM-vs-channel routing, not correct-topic-among-many, which
 * the gateway unit thread-assertions pin). So work-triggering is probabilistic on
 * a generic agent: the UNIVERSAL invariants (a substantive answer arrives, in the
 * right surface, not as an orphaned fragment) are hard; the work-specific surfaces
 * (feed painted, worker surfaced) are reported and only hard-checked once their
 * precondition is observed.
 */

import type { Driver, ObservedMessage } from "./driver.js";
import { isWorkerFeedMessage, isActivityFeedMessage } from "./assertions.js";

export type WorkKind =
  | "research" // web/multi-source research → multi-tool, long
  | "multitool" // several tool calls, sequential
  | "subagent" // delegates to a foreground sub-agent
  | "bgworker" // dispatches a background worker (the 🛠 feed)
  | "compound" // first X then Y then summarise — ordered multi-step
  | "web"; // current/recent info → forces a web fetch

export interface RealWorkCase {
  name: string;
  /** Human-style prompt that should provoke real work. */
  prompt: string;
  kind: WorkKind;
  /** Generous budget — deep research can run minutes. */
  timeoutMs: number;
  /** The substantive answer must be at least this long; a backstop fragment /
   *  bare ack is shorter, so this distinguishes "the answer landed" from "only a
   *  stub landed". */
  minAnswerChars: number;
  /** When true, this prompt RELIABLY triggers the named surface, so the scenario
   *  hard-asserts it appeared (not just reports it). Used for the semi-prescriptive
   *  but natural-sounding bgworker/subagent cases. */
  requireSurface?: "worker" | "activity";
}

/**
 * The case set. The first block is fully human-style (probabilistic work); the
 * `requireSurface` block phrases the dispatch naturally but reliably enough to
 * hard-assert the surface. Keep prompts provider-agnostic so they run on the
 * generic test-harness agent (no marko-specific MCPs).
 */
export const REAL_WORK_CASES: RealWorkCase[] = [
  {
    name: "deep research, take your time",
    prompt:
      "Can you research the current state of WebAssembly outside the browser — " +
      "the main server-side runtimes, who's actually using it in production, and " +
      "the real limitations today? Take your time and give me a proper rundown, " +
      "not a one-liner.",
    kind: "research",
    timeoutMs: 180_000,
    minAnswerChars: 400,
  },
  {
    name: "current info, forces a lookup",
    prompt:
      "What's the latest with the Bun JavaScript runtime — the recent releases " +
      "and whether people consider it production-ready yet? Check, don't guess.",
    kind: "web",
    timeoutMs: 150_000,
    minAnswerChars: 300,
  },
  {
    name: "multi-angle investigation",
    prompt:
      "Dig into Postgres vs SQLite for a small SaaS backend — look at it from a " +
      "few angles (concurrency, ops burden, cost at scale) and tell me which " +
      "you'd actually pick and why.",
    kind: "multitool",
    timeoutMs: 150_000,
    minAnswerChars: 400,
  },
  {
    name: "compound sequential ask",
    prompt:
      "First work out what today's date is, then how many days are left until the " +
      "end of this quarter, then suggest three concrete milestones I could hit " +
      "before then. Do it in that order.",
    kind: "compound",
    timeoutMs: 120_000,
    minAnswerChars: 250,
  },
  {
    name: "invite delegation",
    prompt:
      "I need a proper comparison of Stripe vs Paddle vs Lemon Squeezy for selling " +
      "a digital product — pricing, who handles sales tax, and payout timing. Farm " +
      "it out to a sub-agent if that's faster; just give me the bottom line at the end.",
    kind: "subagent",
    timeoutMs: 180_000,
    minAnswerChars: 350,
  },
  {
    name: "long sourced briefing (crosses thresholds)",
    prompt:
      "Give me a thorough, well-sourced briefing on the EU AI Act — what it covers, " +
      "the risk tiers, the key deadlines, and what a small AI startup actually has to " +
      "do. Be comprehensive; I'd rather wait and get depth.",
    kind: "research",
    timeoutMs: 360_000,
    minAnswerChars: 500,
  },
  // ── reliably-triggering, still natural voice ──────────────────────────────
  {
    name: "background worker, ping me when done",
    prompt:
      "Don't answer this inline — actually dispatch a background worker for it " +
      "(Task / Agent with run_in_background: true) so I can keep chatting while it " +
      "runs, and ping me when it's done. The task: go through, ONE step at a time " +
      "with a one-line note on each (run a quick command or jot a note per step so " +
      "there's visible progress), the eight most common email-deliverability " +
      "mistakes a solo founder makes — SPF, DKIM, DMARC, warmup, list hygiene, " +
      "content, sending cadence, monitoring. Pace it over a couple of minutes; do " +
      "all eight, then hand back the summary.",
    kind: "bgworker",
    // Generous: if the agent declines to background it and composes inline, a
    // paced 8-step answer can run past 5 min (and, with no tracked tool in
    // flight, trip the 300s silence-poke — see the 2026-06-05 UAT finding).
    timeoutMs: 360_000,
    minAnswerChars: 250,
    requireSurface: "worker",
  },
  {
    name: "step-by-step so the feed paints",
    prompt:
      "Walk through, ONE step at a time (run a quick command or note for each so I " +
      "can see progress), how you'd debug a Linux box that's suddenly out of disk " +
      "space — six steps: df, du on the big dirs, find large files, check logs, " +
      "check deleted-but-open files, then a cleanup plan. Then give me the recap.",
    kind: "multitool",
    timeoutMs: 180_000,
    minAnswerChars: 300,
    requireSurface: "activity",
  },
];

/** What the collector observed across one turn. */
export interface TurnObservation {
  /** Every bot message (initial sends only; edits tracked separately). */
  botMessages: ObservedMessage[];
  /** Edit events seen (worker/activity feeds grow via edits). */
  edits: ObservedMessage[];
  /** The first substantive answer (non-feed, >= minAnswerChars), or null. */
  answer: ObservedMessage | null;
  /** ms from send to the answer (or to timeout). */
  answerLatencyMs: number;
  /** Whether an activity feed (`→/✓`) message was seen. */
  sawActivityFeed: boolean;
  /** Whether a worker feed (`🛠 Worker`) message was seen. */
  sawWorkerFeed: boolean;
}

/**
 * Send `prompt` and collect the bot's message sequence until a substantive
 * answer lands (+ a short settle to catch trailing/late sends — the very window
 * the orphaned-reply bug lives in) or `timeoutMs` elapses. Observing starts
 * BEFORE the send so nothing is missed.
 */
export async function collectTurn(
  driver: Driver,
  chatId: number,
  driverUserId: number,
  prompt: string,
  opts: { timeoutMs: number; minAnswerChars: number; settleMs?: number },
): Promise<TurnObservation> {
  const settleMs = opts.settleMs ?? 6_000;
  const botMessages: ObservedMessage[] = [];
  const edits: ObservedMessage[] = [];
  let answer: ObservedMessage | null = null;
  let sawActivityFeed = false;
  let sawWorkerFeed = false;

  const startedAt = Date.now();
  const iterator = driver.observeMessages(chatId)[Symbol.asyncIterator]();
  // Begin observing, then send (observeMessages backfills nothing, but the send
  // round-trips after the iterator is live).
  await driver.sendText(chatId, prompt);

  let settleDeadline = Number.POSITIVE_INFINITY;
  while (true) {
    const remaining =
      Math.min(opts.timeoutMs - (Date.now() - startedAt), settleDeadline - Date.now());
    if (remaining <= 0) break;
    const next = await Promise.race([
      iterator.next(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), Math.max(0, remaining)),
      ),
    ]);
    if (next.done || next.value == null) {
      // timed out (either overall or settle) — stop
      break;
    }
    const m = next.value as ObservedMessage;
    if (m.senderUserId === driverUserId) continue; // our own echo
    if (m.edited) {
      edits.push(m);
      if (isWorkerFeedMessage(m)) sawWorkerFeed = true;
      if (isActivityFeedMessage(m)) sawActivityFeed = true;
      continue;
    }
    botMessages.push(m);
    if (isWorkerFeedMessage(m)) sawWorkerFeed = true;
    else if (isActivityFeedMessage(m)) sawActivityFeed = true;
    else if (answer == null && m.text.trim().length >= opts.minAnswerChars) {
      answer = m;
      // Got the answer; keep collecting for `settleMs` to catch a late
      // fragment/duplicate/misrouted trailing send.
      settleDeadline = Date.now() + settleMs;
    }
  }
  void iterator.return?.();
  return {
    botMessages,
    edits,
    answer,
    answerLatencyMs: answer ? answer.date.getTime() - startedAt : Date.now() - startedAt,
    sawActivityFeed,
    sawWorkerFeed,
  };
}

export interface TurnViolation {
  code:
    | "no-answer"
    | "orphaned-fragment"
    | "surface-missing"
    | "wrong-surface";
  detail: string;
}

/**
 * Bug detectors over a collected turn. Splits HARD violations (the universal
 * invariants that must always hold) from SOFT warnings (work-specific surfaces
 * that are probabilistic on a generic agent — whether it dispatches a worker /
 * sub-agent is its judgment, so a missing feed is reported, not failed).
 *
 * Hard violations:
 *  - no-answer: no substantive reply arrived at all (the answer never landed).
 *  - orphaned-fragment: a short non-ack bot text landed, THEN ≥8s later a much
 *    longer answer — the orphaned-reply backstop signature (fragment flushed,
 *    real reply late). A short message that is itself the only substantive reply,
 *    or a brief "on it" ack followed promptly, does not count.
 *  - wrong-surface (channel): a bot message landed outside the expected chat.
 *
 * Soft warnings:
 *  - surface-missing: a `requireSurface` case never showed its feed. The agent
 *    may have answered inline (a legitimate choice) — reported for the bug hunt,
 *    not a hard fail. When the feed DOES appear, the summary + gateway telemetry
 *    confirm it surfaced correctly.
 */
export function analyzeTurn(
  obs: TurnObservation,
  expected: { requireSurface?: "worker" | "activity"; chatId: number },
): { violations: TurnViolation[]; warnings: TurnViolation[] } {
  const violations: TurnViolation[] = [];
  const warnings: TurnViolation[] = [];
  if (obs.answer == null) {
    violations.push({
      code: "no-answer",
      detail: `no substantive reply within budget (saw ${obs.botMessages.length} bot msg(s), ` +
        `activityFeed=${obs.sawActivityFeed} workerFeed=${obs.sawWorkerFeed})`,
    });
  }

  // orphaned-fragment: a non-feed text shorter than 150 chars, sent ≥8s before
  // the answer, that isn't a quick ack right before the answer.
  if (obs.answer != null) {
    const fragments = obs.botMessages.filter(
      (m) =>
        m.messageId !== obs.answer!.messageId &&
        !isWorkerFeedMessage(m) &&
        !isActivityFeedMessage(m) &&
        m.text.trim().length > 0 &&
        m.text.trim().length < 150 &&
        obs.answer!.date.getTime() - m.date.getTime() >= 8_000,
    );
    if (fragments.length > 0) {
      violations.push({
        code: "orphaned-fragment",
        detail: `${fragments.length} stub message(s) landed ≥8s before the answer ` +
          `(e.g. ${JSON.stringify(fragments[0]!.text.slice(0, 60))}) — the orphaned-reply ` +
          `backstop signature.`,
      });
    }
  }

  if (expected.requireSurface === "worker" && !obs.sawWorkerFeed) {
    warnings.push({ code: "surface-missing", detail: "expected a 🛠 worker feed; agent likely answered inline" });
  }
  if (expected.requireSurface === "activity" && !obs.sawActivityFeed && !obs.sawWorkerFeed) {
    warnings.push({ code: "surface-missing", detail: "expected a →/✓ activity feed; none appeared" });
  }

  const stray = [...obs.botMessages, ...obs.edits].filter((m) => m.chatId !== expected.chatId);
  if (stray.length > 0) {
    violations.push({
      code: "wrong-surface",
      detail: `${stray.length} bot message(s) landed in chat ${stray[0]!.chatId}, expected ${expected.chatId}`,
    });
  }
  return { violations, warnings };
}

/** One-line human summary of a turn for the test log (bug-hunt forensics). */
export function summarizeTurn(name: string, obs: TurnObservation): string {
  return (
    `[real-work] ${name}: answer=${obs.answer ? `${obs.answer.text.trim().length}ch@${Math.round(obs.answerLatencyMs / 1000)}s` : "NONE"} ` +
    `botMsgs=${obs.botMessages.length} edits=${obs.edits.length} ` +
    `activityFeed=${obs.sawActivityFeed} workerFeed=${obs.sawWorkerFeed}`
  );
}
