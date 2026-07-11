/**
 * #3031 PR 3 — reactive-path message collapse.
 *
 * The model-unavailable card is deliberately sent BEFORE the fallback
 * outcome is known; on a SUCCESSFUL swap the announcement is folded into an
 * EDIT of that card (single evolving card). CRITICAL promise-honesty
 * constraint (2026-06-06→07 incident): every failure / no-op path must still
 * deliver a SEPARATE message — these tests pin that the collapse decision
 * can never eat a failure notice.
 */

import { describe, it, expect } from "vitest";
import {
  createModelUnavailableCardRegistry,
  decideAnnouncementDelivery,
  foldAnnouncementIntoCard,
  CARD_COLLAPSE_MAX_AGE_MS,
  type ModelUnavailableCardRecord,
  type FallbackDeliveryOutcomeKind,
} from "../fallback-card-collapse.js";

const NOW = 1_780_000_000_000;

function rec(overrides: Partial<ModelUnavailableCardRecord> = {}): ModelUnavailableCardRecord {
  return {
    messageId: 4242,
    text: "⚠️ Model unavailable — auto-failover in progress",
    atMs: NOW - 5_000,
    promisedFallback: true,
    ...overrides,
  };
}

describe("createModelUnavailableCardRegistry", () => {
  it("take returns a fresh fallback-promising card exactly once (one edit per card)", () => {
    const reg = createModelUnavailableCardRegistry();
    reg.record("123", rec());
    const first = reg.take("123", NOW);
    expect(first?.messageId).toBe(4242);
    // One-shot: a second take finds nothing (a card absorbs one announcement).
    expect(reg.take("123", NOW)).toBeNull();
    expect(reg.size()).toBe(0);
  });

  it("a stale card is not editable (belongs to a previous incident) and is cleared", () => {
    const reg = createModelUnavailableCardRegistry();
    reg.record("123", rec({ atMs: NOW - CARD_COLLAPSE_MAX_AGE_MS - 1 }));
    expect(reg.take("123", NOW)).toBeNull();
    expect(reg.size()).toBe(0);
  });

  it("a card that never promised auto-failover never absorbs the announcement", () => {
    const reg = createModelUnavailableCardRegistry();
    reg.record("123", rec({ promisedFallback: false }));
    expect(reg.take("123", NOW)).toBeNull();
  });

  it("cards are per-chat: taking one chat's card leaves the other's intact", () => {
    const reg = createModelUnavailableCardRegistry();
    reg.record("123", rec({ messageId: 1 }));
    reg.record("456", rec({ messageId: 2 }));
    expect(reg.take("123", NOW)?.messageId).toBe(1);
    expect(reg.take("456", NOW)?.messageId).toBe(2);
  });

  it("a newer card replaces the prior record for the same chat", () => {
    const reg = createModelUnavailableCardRegistry();
    reg.record("123", rec({ messageId: 1 }));
    reg.record("123", rec({ messageId: 2 }));
    expect(reg.take("123", NOW)?.messageId).toBe(2);
  });
});

describe("decideAnnouncementDelivery — promise-honesty on every error path", () => {
  it("edits ONLY on a successful swap with a fresh promising card", () => {
    expect(decideAnnouncementDelivery("switched", rec())).toBe("edit");
  });

  it("sends separately on a successful swap when no card was recorded (e.g. card-less quota_wall_detected trigger)", () => {
    expect(decideAnnouncementDelivery("switched", null)).toBe("send");
  });

  it("EVERY failure / no-op outcome is a separate send — even with a fresh card on record", () => {
    const failureKinds: FallbackDeliveryOutcomeKind[] = [
      "all-blocked",
      "no-old-active",
      "no-eligible-target",
      "error",
    ];
    for (const kind of failureKinds) {
      expect(decideAnnouncementDelivery(kind, rec()), `kind=${kind}`).toBe("send");
      expect(decideAnnouncementDelivery(kind, null), `kind=${kind} (no card)`).toBe("send");
    }
  });
});

describe("foldAnnouncementIntoCard", () => {
  it("keeps the original card text and appends the announcement (single evolving card)", () => {
    const folded = foldAnnouncementIntoCard("CARD", "ANNOUNCEMENT");
    expect(folded.startsWith("CARD")).toBe(true);
    expect(folded).toContain("ANNOUNCEMENT");
    expect(folded.indexOf("CARD")).toBeLessThan(folded.indexOf("ANNOUNCEMENT"));
  });
});
