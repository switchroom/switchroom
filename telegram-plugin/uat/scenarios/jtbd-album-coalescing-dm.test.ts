/**
 * Album-coalescing scenario — driver sends a 3-photo Telegram album
 * (media_group) in one shot; the gateway's A2 multi-attachment
 * coalescing (coalesce.max_attachments, default 10 since v0.14.21)
 * MUST fold all three into a SINGLE Claude turn, so the agent sees
 * image_path + image_path_2 + image_path_3 together and can report a
 * count of 3.
 *
 * Regression gate for the default-on flip (#2021): before max_attachments
 * defaulted to 10, an album bypassed coalescing (each part its own turn),
 * so the agent would only ever see ONE image per turn and answer "1".
 * A reply of "3" proves the album coalesced.
 *
 * Part of: https://github.com/switchroom/switchroom/issues/865
 *
 * ## How the signal is read robustly
 *
 * The agent's answer is a bare count, which would collide with incidental
 * digits the chat is now full of by default: the pinned progress card's
 * timer (`00:03`) and — since the worker feed went default-on fleet-wide
 * (#2009 / v0.14.19) — worker-feed lines like `🔧 Worker · … · 0:12`.
 * A "first bot message containing a digit" matcher would latch onto one of
 * those and false-fail even when coalescing is healthy (see the
 * memory-survives-restart matcher-flake note + `isWorkerFeedMessage`).
 *
 * Two defences, mirroring the sibling `jtbd-forwarded-burst-dm` gate:
 *   1. Anchor the answer on a distinctive token — the agent is told to
 *      reply `IMAGECOUNT=<n>`. "IMAGECOUNT" never appears in a card or a
 *      worker-feed line, so the matcher cannot collide with their digits.
 *   2. Drain observed messages into a per-id map (collapsing streamed
 *      edits to latest text), skip our own sends + worker-feed noise, and
 *      poll until the ANSWER token appears — rather than returning the
 *      first message that happens to match.
 *
 *   - Coalesced   → one turn sees 3 images → `IMAGECOUNT=3`.
 *   - Non-coalesced → the turn carrying the caption/question sees only its
 *     own (first) image → `IMAGECOUNT=1`. Surfaced as an explicit failure.
 *
 * Fixtures: three tiny solid-colour JPEGs under fixtures/album/, committed
 * so the gate runs without a generation step. (Regenerate with
 * `ffmpeg -f lavfi -i color=c=red:s=320x240 -frames:v 1 red.jpg`.)
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";
import { pollUntil, isWorkerFeedMessage } from "../assertions.js";
import type { ObservedMessage } from "../driver.js";

const AGENT = "test-harness";

const FIXTURE_DIR = path.resolve(__dirname, "..", "fixtures", "album");
const PHOTOS = ["red.jpg", "green.jpg", "blue.jpg"].map((f) =>
  path.join(FIXTURE_DIR, f),
);

const CAPTION =
  "I just sent you a photo album in a single message. Count the separate " +
  "image files you received in THIS ONE incoming message and reply with " +
  "ONLY the token IMAGECOUNT=<n> (e.g. IMAGECOUNT=3). Nothing else.";

// Warm TTFO on test-harness is ~7s; an album adds the (sub-second)
// coalesce window plus the model looking at three images.
const ANSWER_TIMEOUT_MS = 90_000;

// Pull the count out of an `IMAGECOUNT=<n>` token, tolerating "= : whitespace".
function imageCountIn(text: string): number | undefined {
  const m = text.match(/IMAGECOUNT\s*[:=]?\s*(\d+)/i);
  return m ? Number.parseInt(m[1], 10) : undefined;
}

describe("uat: album-coalescing DM round-trip", () => {
  it(
    "a 3-photo album folds into ONE turn — agent reports seeing 3 images",
    async () => {
      for (const p of PHOTOS) {
        if (!existsSync(p)) {
          throw new Error(
            `album fixture missing at ${p} — see scenario header to regenerate`,
          );
        }
      }
      const sc = await spinUp({ agent: AGENT });
      try {
        // Observe BEFORE sending — observeMessages only sees live updates.
        // Drain into a per-id map so streamed edits collapse to latest text;
        // skip our own sends and worker-feed noise so neither can satisfy
        // the count matcher.
        const latestById = new Map<number, ObservedMessage>();
        const stream = sc.driver.observeMessages(sc.botUserId);
        const consume = (async () => {
          for await (const m of stream) {
            if (m.senderUserId === sc.driverUserId) continue;
            if (isWorkerFeedMessage(m)) continue;
            latestById.set(m.messageId, m);
          }
        })();

        await sc.driver.sendAlbum(sc.botUserId, PHOTOS, CAPTION);

        // Poll until a bot message carries an IMAGECOUNT token.
        const answer = await pollUntil(
          () => {
            for (const m of latestById.values()) {
              if (imageCountIn(m.text) !== undefined) return m;
            }
            return undefined;
          },
          { timeout: ANSWER_TIMEOUT_MS, interval: 500 },
        ).catch(() => undefined);

        await stream[Symbol.asyncIterator]().return?.(undefined as never);
        await consume;

        if (!answer) {
          const seen = [...latestById.values()]
            .map((m) => `#${m.messageId}=${JSON.stringify(m.text.slice(0, 60))}`)
            .join(" ");
          throw new Error(
            `[album-coalescing] No bot reply carried an IMAGECOUNT token ` +
              `within ${ANSWER_TIMEOUT_MS}ms. Bot messages seen: ${seen || "(none)"}.`,
          );
        }

        const count = imageCountIn(answer.text);
        // Coalesced => 3. A non-coalescing gateway answers 1 (the question
        // rides photo #1; the other two parts spill to their own turns).
        expect(count).toBe(3);
      } finally {
        await sc.tearDown();
      }
    },
    ANSWER_TIMEOUT_MS + 30_000,
  );
});
