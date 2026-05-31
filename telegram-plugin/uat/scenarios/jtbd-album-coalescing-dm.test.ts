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
 * Fixtures: three tiny solid-colour JPEGs under fixtures/album/, committed
 * so the gate runs without a generation step. (Regenerate with
 * `ffmpeg -f lavfi -i color=c=red:s=320x240 -frames:v 1 red.jpg`.)
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

const FIXTURE_DIR = path.resolve(__dirname, "..", "fixtures", "album");
const PHOTOS = ["red.jpg", "green.jpg", "blue.jpg"].map((f) =>
  path.join(FIXTURE_DIR, f),
);

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
      const sc = await spinUp({ agent: "test-harness" });
      try {
        await sc.driver.sendAlbum(
          sc.botUserId,
          PHOTOS,
          "I just sent you a photo album in a single message. How many " +
            "separate image files did you receive in this one message? " +
            "Reply with only the number.",
        );
        // The first non-activity reply that carries a digit is the answer.
        // Activity beats render as "→ …" lines; skip them (see the known
        // matcher-flake note in memory).
        const reply = await sc.expectMessage(
          (m) => !m.text.trimStart().startsWith("→") && /\d/.test(m.text),
          { from: "bot", timeout: 90_000 },
        );
        // Coalesced => 3. A non-coalescing gateway would answer "1".
        expect(reply.text).toMatch(/\b3\b|three/i);
      } finally {
        await sc.tearDown();
      }
    },
    120_000,
  );
});
