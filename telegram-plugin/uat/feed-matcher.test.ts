import { describe, expect, it } from "bun:test";
import {
  isActivityFeedMessage,
  isWorkerFeedMessage,
  WORKER_FEED_RE,
} from "./assertions.js";

// Pins the worker-activity-feed detector (#2000) used by recall/reply
// scenarios to skip feed noise. The live UAT it guards can't run in CI
// (needs sudo + a real Telegram session), so this is the CI-verifiable
// floor for the matcher's behavior.
const feed = (text: string) => ({ text }) as Parameters<typeof isWorkerFeedMessage>[0];

describe("isWorkerFeedMessage", () => {
  it("matches the running feed header", () => {
    expect(isWorkerFeedMessage(feed("🛠 Worker · crawling changelog"))).toBe(true);
    expect(
      isWorkerFeedMessage(feed("🛠 Worker · crawling changelog\nrunning · 00:12 · 4 tools")),
    ).toBe(true);
  });

  it("matches the terminal finished status (completed/failed)", () => {
    expect(
      isWorkerFeedMessage(feed("🛠 Worker · crawl\nfinished · completed · 10 tools · 01:03")),
    ).toBe(true);
    expect(
      isWorkerFeedMessage(feed("🛠 Worker · crawl\nfinished · failed · 3 tools · 00:08")),
    ).toBe(true);
  });

  it("matches the finished status even on its own line (header-stripped edge)", () => {
    expect(isWorkerFeedMessage(feed("finished · completed · 2 tools · 00:30"))).toBe(true);
  });

  it("does NOT match an ordinary agent reply", () => {
    expect(isWorkerFeedMessage(feed("on it, pulling the logs now"))).toBe(false);
    expect(
      isWorkerFeedMessage(feed("SWITCHROOM_UAT_MEM_DEADBEEFCAFE1234")),
    ).toBe(false);
  });

  it("does NOT match a reply that merely mentions the word worker", () => {
    expect(
      isWorkerFeedMessage(feed("I'll dispatch a worker to handle the crawl.")),
    ).toBe(false);
  });

  it("exposes the regex for scenarios that assert on the feed directly", () => {
    expect(WORKER_FEED_RE.test("🛠 Worker · x")).toBe(true);
  });
});

describe("isActivityFeedMessage", () => {
  it("matches the in-progress step line", () => {
    expect(isActivityFeedMessage(feed("→ Finding the right tool"))).toBe(true);
  });

  it("matches a multi-line feed (done steps + in-progress)", () => {
    expect(
      isActivityFeedMessage(feed("✓ Reading CLAUDE.md\n→ Searching memory")),
    ).toBe(true);
  });

  it("matches the +N earlier header", () => {
    expect(
      isActivityFeedMessage(feed("✓ +3 earlier…\n✓ Reading CLAUDE.md\n→ Searching memory")),
    ).toBe(true);
  });

  it("does NOT match an ordinary agent reply", () => {
    expect(isActivityFeedMessage(feed("on it, pulling the logs now"))).toBe(false);
    expect(
      isActivityFeedMessage(feed("SWITCHROOM_UAT_MEM_DEADBEEFCAFE1234")),
    ).toBe(false);
  });

  it("does NOT match a reply that merely contains an arrow mid-text", () => {
    expect(
      isActivityFeedMessage(feed("The flow is request → response → render.")),
    ).toBe(false);
  });

  it("does NOT match an empty message", () => {
    expect(isActivityFeedMessage(feed("   "))).toBe(false);
  });
});
