/**
 * outbox-self-improve-review.test.ts — the self-improvement review labelling
 * rule, end to end through the REAL Stop hook and the REAL outbox sweep (Ken,
 * 2026-08-07).
 *
 * THE LEAK THIS CLOSES
 * --------------------
 * A self-improvement review turn is a SYNTHESIZED inbound
 * (`source="self_improve_review"`) injected off the operator reply path. Its
 * trailing transcript prose is the agent's own reasoning. The outbox backstop
 * captured that prose and the sweep delivered it into the operator's DM as a
 * RAW, UNLABELLED message — the bug.
 *
 * THE RULE UNDER TEST
 * -------------------
 * A review-originated backstop record is delivered to the operator ONLY IF its
 * text is a well-formed self-improvement CARD (opens with the title line).
 * Everything else — the raw reasoning — is suppressed as `internal`.
 *
 *   (a) SURFACING: a review turn whose final text is a card ⇒ the card is
 *       delivered, self-labelled, journaled as a real delivery.
 *   (b) NO-OP: a review turn whose final text is raw reasoning ⇒ suppressed,
 *       zero chat sends, journaled as an internal suppression.
 *   (c) NORMAL: a non-review turn is delivered byte-for-byte unchanged.
 *
 * Every assertion drives REAL machinery: the REAL Stop hook spawned as a
 * subprocess against a REAL transcript, and the REAL `sweepOutbox` with the
 * REAL `createOutboxSend` adapter against a RECORDING fake Bot API.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { sweepOutbox, createOutboxSend } from "../gateway/outbox-sweep.js";
import { sha256Hex } from "../outbox.js";
import { SELF_IMPROVEMENT_TITLE } from "../hooks/audience-classify.mjs";

const HOOK = resolve(__dirname, "..", "hooks", "silent-end-interrupt-stop.mjs");

// Synthetic ids only (check-no-pii-secrets forbids real chat/user ids).
const DM_CHAT = "5550001";
const INBOUND_MSG_ID = 8420;

/** Raw review reasoning — the text that must never reach the operator. */
const REVIEW_REASONING = [
  "I own personal-garmin, but the script I hand-rolled against this turn was the",
  "shared garmin skill's garmin-history-pull, which only samples every 3rd day.",
  "The durable fix is a first-class hrv-trend subcommand; that is a T2 change so",
  "I logged it as a pending suggestion rather than auto-applying it here.",
].join(" ");

/** A well-formed card, exactly as `buildReviewPrompt` instructs the model. */
const REVIEW_CARD = [
  `${SELF_IMPROVEMENT_TITLE} — pending suggestion logged`,
  "- **Signal:** had to hand-roll python twice to pull daily HRV",
  "- **Suggestion:** add an `hrv-trend` command to the garmin skill",
  "- **Status:** T2, logged for your review, nothing auto-applied",
].join("\n");

/** A normal operator answer on a normal (non-review) turn. No markdown-special
 *  characters, so the rich-send path delivers it byte-for-byte (letting the
 *  "unchanged" assertion be exact equality rather than a substring). */
const NORMAL_ANSWER = "Your HRV trended up this week, sitting around thirty against last week.";

function makeStateDir(): string {
  // NEVER ~/.switchroom — a test that writes there corrupts production state.
  return mkdtempSync(join(tmpdir(), "self-improve-review-"));
}

function writeTranscript(dir: string, lines: object[]): string {
  const p = join(dir, "transcript.jsonl");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  return p;
}

function runHook(transcriptPath: string, stateDir: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("node", [HOOK], {
    input: JSON.stringify({ session_id: "s", transcript_path: transcriptPath }),
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, TELEGRAM_STATE_DIR: stateDir, ...extraEnv },
  });
}

interface RecordShape {
  turnNonce: string;
  text: string;
  audience?: string;
  reviewOriginated?: unknown;
  chatId: string | null;
  source: string;
}

function outboxRecords(dir: string): RecordShape[] {
  const outbox = join(dir, "outbox");
  if (!existsSync(outbox)) return [];
  return readdirSync(outbox)
    .filter((f) => f.endsWith(".json") && f !== "delivered.jsonl")
    .map((f) => JSON.parse(readFileSync(join(outbox, f), "utf8")) as RecordShape);
}

function journalLines(dir: string): Array<Record<string, unknown>> {
  const p = join(dir, "outbox", "delivered.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** A RECORDING fake Bot API — every chat-visible method is counted. */
function recordingBot() {
  const calls: Array<{ method: string; chatId: string; text: string }> = [];
  let nextId = 900;
  return {
    chatCalls: () => calls,
    api: {
      sendRichMessage: async (chatId: string, body: { markdown: string }) => {
        calls.push({ method: "sendRichMessage", chatId, text: body.markdown });
        return { message_id: nextId++ };
      },
      sendMessage: async (chatId: string, text: string) => {
        calls.push({ method: "sendMessage", chatId, text });
        return { message_id: nextId++ };
      },
      editMessageText: async (chatId: string, _mid: number, text: string) => {
        calls.push({ method: "editMessageText", chatId, text });
        return { message_id: nextId++ };
      },
    },
  };
}

const passthroughRetry = <U>(fn: () => Promise<U>): Promise<U> => fn();

/** Drive ONE real sweep tick against the recording bot. */
async function realSweep(
  stateDir: string,
  bot: ReturnType<typeof recordingBot>,
  opts: { audienceGateEnabled?: boolean } = {},
) {
  const framingLines: string[] = [];
  const escalations: string[] = [];
  const summary = await sweepOutbox({
    send: createOutboxSend({ getBot: () => bot, retry: passthroughRetry }),
    textAlreadyDelivered: () => false,
    stateDir,
    now: () => Date.now() + 60_000,
    quietMs: 0,
    log: () => {},
    ...(opts.audienceGateEnabled === undefined
      ? {}
      : { audienceGateEnabled: () => opts.audienceGateEnabled! }),
    logSelfImprovementFraming: (l) => framingLines.push(l),
    escalateInternalSuppression: (l) => escalations.push(l),
  });
  return { summary, framingLines, escalations };
}

/**
 * The REAL review-turn shape: the synthesized review inbound (channel-wrapped,
 * carrying `source="self_improve_review"` and the real operator chat the gateway
 * fell back to), then the agent's trailing final text.
 */
function reviewTranscript(dir: string, trailing: string): string {
  return writeTranscript(dir, [
    {
      type: "queue-operation",
      operation: "enqueue",
      content:
        `<channel source="self_improve_review" chat_id="${DM_CHAT}" ` +
        `message_id="${INBOUND_MSG_ID}">[self-improvement review] The turn-end gate ` +
        `detected a learning signal. Run a focused, forked review.</channel>`,
      timestamp: 1000,
    },
    { type: "assistant", message: { content: [{ type: "text", text: trailing }] } },
  ]);
}

/**
 * #4489 shape: the review turn's OWN reply tool call throws (a
 * `disable_notification: true` interim ack, so it never qualifies as the
 * final answer — mirrors `foregroundThrowTranscript` in
 * outbox-provenance-4141.test.ts), and the trailing text is a well-formed
 * card. This is the ONLY shape that can carry both `replyToolThrewThisTurn`
 * and a card body on the same record, which is what #4489's duplicated-title
 * bug required.
 */
function reviewThrowTranscript(dir: string, trailing: string): string {
  return writeTranscript(dir, [
    {
      type: "queue-operation",
      operation: "enqueue",
      content:
        `<channel source="self_improve_review" chat_id="${DM_CHAT}" ` +
        `message_id="${INBOUND_MSG_ID}">[self-improvement review] The turn-end gate ` +
        `detected a learning signal. Run a focused, forked review.</channel>`,
      timestamp: 1000,
    },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_review_ack",
            name: "mcp__switchroom-telegram__reply",
            input: { text: "Reviewing...", disable_notification: true },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_review_ack",
            is_error: true,
            content: "Error: FLOOD_WAIT_ACTIVE — send rejected",
          },
        ],
      },
    },
    { type: "assistant", message: { content: [{ type: "text", text: trailing }] } },
  ]);
}

describe("self-improvement review — the card gate, end to end", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeStateDir();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("(a) SURFACING: a review turn ending in a CARD delivers it, self-labelled", async () => {
    const t = reviewTranscript(dir, REVIEW_CARD);
    expect(runHook(t, dir).status).toBe(0);

    const records = outboxRecords(dir);
    expect(records).toHaveLength(1);
    // Detected as review-originated, and the card routes to the operator.
    expect(records[0].reviewOriginated).toBe(true);
    expect(records[0].audience).toBe("user");

    const bot = recordingBot();
    const run = await realSweep(dir, bot);

    // Delivered exactly once, carrying the card verbatim (title first).
    expect(bot.chatCalls()).toHaveLength(1);
    expect(run.summary.delivered).toBe(1);
    expect(run.summary.audienceSuppressed).toBeUndefined();
    const sent = bot.chatCalls()[0].text;
    expect(sent).toContain(SELF_IMPROVEMENT_TITLE);
    expect(sent).toContain("add an `hrv-trend` command");
    expect(sent.startsWith(SELF_IMPROVEMENT_TITLE)).toBe(true);
    expect(bot.chatCalls()[0].chatId).toBe(DM_CHAT);

    // Journaled as a real delivery (carries a message id, not a suppression).
    const journal = journalLines(dir);
    expect(journal).toHaveLength(1);
    expect(journal[0].tgMessageId).toBeDefined();
    expect(journal[0].suppressedAudience).toBeUndefined();
  });

  it("(b) NO-OP: a review turn ending in RAW REASONING is suppressed — zero sends", async () => {
    const t = reviewTranscript(dir, REVIEW_REASONING);
    expect(runHook(t, dir).status).toBe(0);

    const records = outboxRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0].reviewOriginated).toBe(true);
    // The leak text classifies internal by construction.
    expect(records[0].audience).toBe("internal");

    const bot = recordingBot();
    const run = await realSweep(dir, bot);

    // The bug, closed: nothing reaches the operator.
    expect(bot.chatCalls()).toEqual([]);
    expect(run.summary.delivered ?? 0).toBe(0);
    expect(run.summary.audienceSuppressed).toBe(1);
    expect(journalLines(dir)[0].suppressedAudience).toBe("internal");
  });

  it("(b') REVERT CHECK: with the audience gate OFF the leak reproduces — but TITLED", async () => {
    // Same raw reasoning; only the gate differs. This proves (b) is load-bearing
    // AND that the residual framing labels the gate-off delivery so it is never
    // raw/unlabelled — the task's minimum guarantee.
    const t = reviewTranscript(dir, REVIEW_REASONING);
    expect(runHook(t, dir).status).toBe(0);

    const bot = recordingBot();
    const run = await realSweep(dir, bot, { audienceGateEnabled: false });

    expect(bot.chatCalls()).toHaveLength(1);
    const sent = bot.chatCalls()[0].text;
    // The raw reasoning is present (the pre-change leak) BUT now titled.
    expect(sent).toContain(REVIEW_REASONING);
    expect(sent.startsWith(SELF_IMPROVEMENT_TITLE)).toBe(true);
    expect(run.summary.selfImprovementFramed).toBe(1);
    expect(run.framingLines).toHaveLength(1);
    expect(journalLines(dir)[0].framedSelfImprovement).toBe("self-improve");
  });

  it("(c) NORMAL: a non-review record is delivered byte-for-byte, no review handling", async () => {
    // A normal foreground turn is delivered LIVE by the turn-flush path and
    // writes no outbox record at all (verified: the real hook elects
    // `flush-will-deliver` for a `source="telegram"` turn). The invariant this
    // case guards is the sweep side: a non-review outbox record — the shape the
    // sweep DOES handle, e.g. a background handback or a flood-queued reply — is
    // untouched by any of the self-improvement machinery. Constructed directly
    // on disk (mirrors the LEGACY pattern in outbox-provenance-4141.test.ts) so
    // "byte-for-byte unchanged" can be asserted as exact equality.
    const outbox = join(dir, "outbox");
    mkdirSync(outbox, { recursive: true });
    const nonce = `${DM_CHAT}:_#7788`;
    const normal = {
      turnNonce: nonce,
      chatId: DM_CHAT,
      threadId: null,
      text: NORMAL_ANSWER,
      textSha256: sha256Hex(NORMAL_ANSWER),
      // Inside the max-age window ⇒ no delivery prefix, so exact equality holds.
      createdAt: Date.now(),
      source: "task-notification",
      audience: "user",
    };
    // The review fields simply do not exist on a normal record.
    expect(Object.keys(normal)).not.toContain("reviewOriginated");
    writeFileSync(join(outbox, `${nonce}.json`), JSON.stringify(normal), "utf8");

    const bot = recordingBot();
    const run = await realSweep(dir, bot);

    // Delivered, verbatim, with no self-improvement title anywhere.
    expect(bot.chatCalls()).toHaveLength(1);
    expect(run.summary.delivered).toBe(1);
    expect(bot.chatCalls()[0].text).toBe(NORMAL_ANSWER);
    expect(bot.chatCalls()[0].text).not.toContain(SELF_IMPROVEMENT_TITLE);
    expect(run.summary.selfImprovementFramed).toBeUndefined();
    expect(run.summary.audienceSuppressed).toBeUndefined();
    // Journal parity: a plain delivery, keyed on the raw text, unframed.
    expect(journalLines(dir)[0].textSha256).toBe(sha256Hex(NORMAL_ANSWER));
    expect(journalLines(dir)[0].framedSelfImprovement).toBeUndefined();
  });

  // ───────────────────────────────────────────────────────────────────────
  // #4489 — a review record that is BOTH a card AND `replyToolThrewThisTurn`
  // must never acquire a second, duplicated title. `decideOutboxSweep`
  // applies the reply-throw provenance banner BEFORE the self-improvement
  // title, so by the time the self-improvement framing decision ran on the
  // COMPOSED body (banner + card), `applySelfImprovementFraming`'s own
  // idempotency check — which only inspects what it was handed — could no
  // longer see that the underlying text already opened with the title. Fixed
  // by gating the framing DECISION on the raw `record.text`, not the
  // provenance-composed body.
  // ───────────────────────────────────────────────────────────────────────
  it("#4489: a review record that is both a CARD and reply-throw gets exactly one title", async () => {
    const t = reviewThrowTranscript(dir, REVIEW_CARD);
    expect(runHook(t, dir).status).toBe(0);

    const records = outboxRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0].reviewOriginated).toBe(true);
    expect(records[0].replyToolThrewThisTurn).toBe(true);
    // The card routes `user` regardless of the throw (card gate wins).
    expect(records[0].audience).toBe("user");

    const bot = recordingBot();
    // Audience gate OFF per the issue's repro shape — makes the self-improve
    // framing layer the one under test here, isolated from the card gate
    // (which already suppresses the leak for a non-card body; see (b)/(b')
    // above). A card's audience is `user` regardless of the gate, so this
    // does not change which branch delivers it — only removes a confound.
    const run = await realSweep(dir, bot, { audienceGateEnabled: false });

    expect(bot.chatCalls()).toHaveLength(1);
    const sent = bot.chatCalls()[0].text;
    // REGRESSION GUARD: exactly one occurrence of the title, not two. Before
    // the fix this was 2 — the reply-throw banner is prepended in front of
    // the card, so the composed body no longer opens with the title even
    // though the raw card does, and the framing decision (running on the
    // composed body) could not tell.
    const titleOccurrences = sent.split(SELF_IMPROVEMENT_TITLE).length - 1;
    expect(titleOccurrences).toBe(1);
    expect(sent).toContain("add an `hrv-trend` command");
  });
});
