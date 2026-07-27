import { describe, expect, it } from "bun:test";
import {
  isActivityFeedMessage,
  isFrameworkFallbackText,
  isLivenessCardMessage,
  isWorkerFeedMessage,
  stripCardNesting,
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

  it("matches the FLUSH worker card as Telegram delivers it (#3842)", () => {
    // #3842 removed the whole-card `└─ ` prefix and whole-card indent that
    // #3820/#3821 put on worker cards, so the single-worker card arrives flush.
    const flush = "🛠 WORKER · crawling changelog\n55s · 9 tools · opus 5";
    expect(isWorkerFeedMessage(feed(flush))).toBe(true);
  });
});

describe("#3842 the surviving step indent is transparent to the matchers", () => {
  it("classifies a flush agent-shaped worker card as the liveness card, not an answer", () => {
    const flush =
      "🛠 WORKER · crawl\n12s · 3 tools\n✓ Reading CLAUDE.md\n→ Searching memory";
    expect(isLivenessCardMessage(feed(flush))).toBe(true);
    expect(isActivityFeedMessage(feed(flush))).toBe(true);
  });

  it("classifies a combined card whose step lines carry WORKER_STEP_INDENT", () => {
    // The one indent that survives #3842: step lines under a worker row header
    // on the 2+ worker card. `String.trim()` does NOT remove U+2800 (category
    // So, not whitespace), so the matchers must normalise it explicitly or a
    // recall/reply scenario latches onto the combined card as an answer.
    const combined =
      "🛠 WORKERS · 2 running · oldest 55s · 13 tools\n" +
      "1. crawl · 55s · 9 tools\n⠀⠀⠀✓ Reading CLAUDE.md\n⠀⠀⠀→ Searching memory";
    expect(isWorkerFeedMessage(feed(combined))).toBe(true);
  });

  it("strips the step indent and leaves ordinary prose alone", () => {
    expect(stripCardNesting("⠀⠀⠀→ Searching memory")).toBe("→ Searching memory");
    expect(stripCardNesting("🛠 WORKER · crawl")).toBe("🛠 WORKER · crawl");
    expect(stripCardNesting("on it, pulling the logs now")).toBe(
      "on it, pulling the logs now",
    );
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

  // The regression that silently broke the whole liveness-climb test wall
  // (deterministic-turn-liveness.md Phase 4a): the climb card carries the
  // two-line `renderActivityHeader`, which the pure-arrow predicate could
  // never match — so it was classified as the answer and every climb test
  // exited vacuously. isActivityFeedMessage must now recognise the header.
  it("matches the Phase-1 climb card (two-line header + Working… body)", () => {
    expect(
      isActivityFeedMessage(feed("🤖 Agent\n12s · 0 tools\n→ Working…")),
    ).toBe(true);
    expect(
      isActivityFeedMessage(feed("🤖 Agent\n2m05s · 0 tools\n→ Working…")),
    ).toBe(true);
  });

  it("matches a headered narration card (header + narrated → step)", () => {
    expect(
      isActivityFeedMessage(feed("🤖 Agent\n18s · 2 tools\n✓ Checking the hostname\n→ Writing the file")),
    ).toBe(true);
  });
});

describe("isLivenessCardMessage", () => {
  it("matches the climbing Working… card (running header)", () => {
    expect(isLivenessCardMessage(feed("🤖 Agent\n12s · 0 tools\n→ Working…"))).toBe(true);
    expect(isLivenessCardMessage(feed("🤖 Agent\n1m41s · 3 tools\n→ Working…"))).toBe(true);
  });

  it("matches the done header shape", () => {
    expect(isLivenessCardMessage(feed("🤖 Agent\ndone · 3 tools · 41s\n✓ Ran the check"))).toBe(true);
  });

  it("matches a header with a description on line 1", () => {
    expect(isLivenessCardMessage(feed("🤖 Agent · summarising the logs\n8s · 1 tool\n→ Working…"))).toBe(true);
  });

  it("does NOT match a plain reply", () => {
    expect(isLivenessCardMessage(feed("done! I created the file and listed it."))).toBe(false);
  });

  it("does NOT match a reply that opens with an emoji but is prose", () => {
    expect(
      isLivenessCardMessage(feed("🤖 Agent here — I finished the task.\nAll four steps done.")),
    ).toBe(false);
  });

  it("does NOT match when prose follows the header", () => {
    expect(
      isLivenessCardMessage(feed("🤖 Agent\n12s · 0 tools\nHere is your answer.")),
    ).toBe(false);
  });

  it("does NOT match a bare single header line", () => {
    expect(isLivenessCardMessage(feed("🤖 Agent"))).toBe(false);
  });
});

describe("isFrameworkFallbackText", () => {
  it("flags the mid-turn / dark-turn fallback wording", () => {
    expect(isFrameworkFallbackText("⚠️ still working… (no update from agent in 5 min)")).toBe(true);
    expect(isFrameworkFallbackText("The agent finished working but didn't send a reply.")).toBe(true);
    expect(isFrameworkFallbackText("I'm blocked — waiting for your approval to proceed.")).toBe(true);
  });

  it("does NOT flag an ordinary answer", () => {
    expect(isFrameworkFallbackText("Done — I created /tmp/foo and wrote a file in it.")).toBe(false);
  });
});
