import { describe, it, expect } from "vitest";
import {
  buildThreadTags,
  partMarker,
  buildMessageTemplate,
  buildCorrectionTemplate,
  NIP29_CHANNEL_MESSAGE_KIND,
} from "./transform.js";

describe("buildThreadTags — NIP-10 marked e-tags", () => {
  it("returns [] for a top-level post (no threading)", () => {
    expect(buildThreadTags({})).toEqual([]);
  });

  it("emits distinct root + reply markers when they differ", () => {
    expect(buildThreadTags({ threadRootId: "root", replyToEventId: "parent" })).toEqual([
      ["e", "root", "", "root"],
      ["e", "parent", "", "reply"],
    ]);
  });

  it("COLLAPSES to a single reply-to-root marker when root IS the parent", () => {
    // A direct reply to the thread root must not emit two identical e-tags.
    expect(buildThreadTags({ threadRootId: "same", replyToEventId: "same" })).toEqual([
      ["e", "same", "", "root"],
    ]);
  });

  it("emits only a root marker when no direct parent is given", () => {
    expect(buildThreadTags({ threadRootId: "root" })).toEqual([["e", "root", "", "root"]]);
  });

  it("emits only a reply marker when no root is given", () => {
    expect(buildThreadTags({ replyToEventId: "parent" })).toEqual([["e", "parent", "", "reply"]]);
  });
});

describe("partMarker — multi-part chunk prefix", () => {
  it("does NOT prefix a single-part message", () => {
    expect(partMarker("body", 1, 1)).toBe("body");
  });
  it("prefixes (k/n) for a split message", () => {
    expect(partMarker("body", 2, 3)).toBe("(2/3) body");
  });
});

describe("buildMessageTemplate — kind:9 with the mandatory h-tag (F1)", () => {
  it("always carries ['h', channelId] first (the relay rejects a kind:9 without it)", () => {
    const t = buildMessageTemplate({ channelId: "grp-1", content: "hi", nowSec: 1000 });
    expect(t.kind).toBe(NIP29_CHANNEL_MESSAGE_KIND);
    expect(t.kind).toBe(9);
    expect(t.tags[0]).toEqual(["h", "grp-1"]);
    expect(t.created_at).toBe(1000);
    expect(t.content).toBe("hi");
  });

  it("appends threading tags after the h-tag when threading is given", () => {
    const t = buildMessageTemplate({
      channelId: "grp-1",
      content: "reply",
      threading: { threadRootId: "root", replyToEventId: "parent" },
      nowSec: 5,
    });
    expect(t.tags).toEqual([
      ["h", "grp-1"],
      ["e", "root", "", "root"],
      ["e", "parent", "", "reply"],
    ]);
  });
});

describe("buildCorrectionTemplate — a kind:9 reply threaded on the superseded event (F4)", () => {
  it("threads as reply-to-root on the target so it renders inline under the original", () => {
    const t = buildCorrectionTemplate({
      channelId: "grp-1",
      content: "corrected",
      targetEventId: "orig-evt",
      nowSec: 42,
    });
    // Same content-kind as a normal message (a custom kind would not render).
    expect(t.kind).toBe(9);
    expect(t.tags[0]).toEqual(["h", "grp-1"]);
    // root === parent === target → collapses to a single reply-to-root e-tag.
    expect(t.tags.slice(1)).toEqual([["e", "orig-evt", "", "root"]]);
    expect(t.content).toBe("corrected");
  });
});
