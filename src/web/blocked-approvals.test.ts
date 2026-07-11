import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readBlockedApprovals,
  handleGetBlockedApprovals,
  blockedApprovalsDir,
  formatBlockedFor,
  type BlockedApproval,
} from "./blocked-approvals-read.js";
import { deriveAttention } from "./api.js";

/**
 * The blocked-approvals surface: an agent held on an approval it could not
 * deliver to Telegram must be VISIBLE without Telegram. These pin the reader
 * and the Summary triage row it feeds.
 *
 * The failure being guarded against is a SILENTLY EMPTY page — the web
 * container runs as uid 1000 and cannot read the agent's own 0600 state, so a
 * reader that hits an unreadable file must degrade honestly (and, crucially,
 * must not hide the records it CAN read).
 */
describe("readBlockedApprovals (Telegram-independent view of a held agent)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sr-blocked-appr-"));
  });
  afterEach(() => {
    // chmod back first — a 0000 file inside can defeat the recursive rm.
    try {
      chmodSync(join(dir, "locked.json"), 0o644);
    } catch {
      /* not every case writes it */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const NOW = 1783756731607;

  function write(agent: string, rec: unknown): void {
    writeFileSync(join(dir, `${agent}.json`), JSON.stringify(rec));
  }

  const overlord: BlockedApproval = {
    agent: "overlord",
    requestId: "req-abc123",
    toolName: "Bash",
    action: "restart the gateway supervisor",
    // 47 minutes before NOW
    blockedSince: NOW - 47 * 60_000,
    undeliverableSince: NOW - 47 * 60_000,
    retryableAt: NOW + 13 * 60_000,
    reason: "flood_wait",
  };

  it("returns a blocked record written to disk, with every operator-facing field", () => {
    write("overlord", overlord);
    const blocked = readBlockedApprovals(dir);

    expect(blocked).toHaveLength(1);
    const b = blocked[0];
    // which agent
    expect(b.agent).toBe("overlord");
    // what it's blocked on
    expect(b.action).toBe("restart the gateway supervisor");
    expect(b.toolName).toBe("Bash");
    // how long (derived) — "blocked for 47 minutes", legible at a glance
    expect(formatBlockedFor(NOW - b.blockedSince)).toBe("47m");
    // when it can retry
    expect(b.retryableAt).toBe(NOW + 13 * 60_000);
    // and why
    expect(b.reason).toBe("flood_wait");
    expect(b.requestId).toBe("req-abc123");
  });

  it("is an ARRAY endpoint — honest empty [] when nothing is blocked, never null", () => {
    // dir exists, no records in it
    const blocked = readBlockedApprovals(dir);
    expect(Array.isArray(blocked)).toBe(true);
    expect(blocked).toEqual([]);
  });

  it("degrades to an honest empty [] when the record dir is absent", () => {
    // The record producer (gateway side) lands separately — until then the
    // dir simply does not exist. That is not an error state.
    const blocked = readBlockedApprovals(join(dir, "does-not-exist"));
    expect(blocked).toEqual([]);
  });

  it("degrades to empty on malformed JSON — no crash", () => {
    writeFileSync(join(dir, "overlord.json"), "{ not json");
    expect(() => readBlockedApprovals(dir)).not.toThrow();
    expect(readBlockedApprovals(dir)).toEqual([]);
  });

  it("drops a record with no usable blockedSince rather than rendering NaN", () => {
    // A "blocked NaNm" row is a lie; drop the record instead.
    write("overlord", { ...overlord, blockedSince: "whenever" });
    expect(readBlockedApprovals(dir)).toEqual([]);
  });

  it("normalizes malformed retryableAt / undeliverableSince to null, not NaN", () => {
    write("overlord", {
      ...overlord,
      retryableAt: "soon",
      undeliverableSince: undefined,
    });
    const [b] = readBlockedApprovals(dir);
    expect(b.retryableAt).toBeNull();
    expect(b.undeliverableSince).toBeNull();
  });

  it("hard-whitelists fields — an extra on-disk field never reaches the render side", () => {
    // The record is metadata only and must NEVER carry raw tool input. If a
    // producer bug ever put one there, the reader must not pass it through.
    write("overlord", {
      ...overlord,
      toolInput: { command: "rm -rf /" },
      secret: "sk-ant-" + "fake",
    });
    const [b] = readBlockedApprovals(dir);
    expect(b).not.toHaveProperty("toolInput");
    expect(b).not.toHaveProperty("secret");
    expect(Object.keys(b).sort()).toEqual([
      "action",
      "agent",
      "blockedSince",
      "reason",
      "requestId",
      "retryableAt",
      "toolName",
      "undeliverableSince",
    ]);
  });

  it("an unreadable record never hides the readable ones (the 0600 trap)", () => {
    // THE failure this guards against: the web container is uid 1000 and the
    // agent's own state files are 0600. A reader that throws on the first
    // unreadable file renders a silently empty page. Use a directory named
    // `<agent>.json` — readFileSync on it fails with EISDIR for EVERY uid
    // (including root in CI), so this is deterministic, unlike a chmod.
    mkdirSync(join(dir, "unreadable.json"));
    write("overlord", overlord);

    const blocked = readBlockedApprovals(dir);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].agent).toBe("overlord");
  });

  it.skipIf(process.getuid?.() === 0)(
    "degrades honestly on a real 0600/0000 file instead of exploding",
    () => {
      writeFileSync(join(dir, "locked.json"), JSON.stringify(overlord));
      chmodSync(join(dir, "locked.json"), 0o000);
      write("clerk", { ...overlord, agent: "clerk" });

      expect(() => readBlockedApprovals(dir)).not.toThrow();
      const blocked = readBlockedApprovals(dir);
      // The unreadable one is skipped; the readable one still surfaces.
      expect(blocked.map((b) => b.agent)).toEqual(["clerk"]);
    },
  );

  it("ranks longest-blocked first", () => {
    write("overlord", overlord); // 47m
    write("clerk", { ...overlord, agent: "clerk", blockedSince: NOW - 5 * 60_000 }); // 5m
    write("marko", { ...overlord, agent: "marko", blockedSince: NOW - 3 * 3600_000 }); // 3h

    expect(readBlockedApprovals(dir).map((b) => b.agent)).toEqual([
      "marko", // 3h — waiting longest
      "overlord", // 47m
      "clerk", // 5m
    ]);
  });

  it("ignores non-.json files in the dir", () => {
    writeFileSync(join(dir, "README"), "not a record");
    write("overlord", overlord);
    expect(readBlockedApprovals(dir)).toHaveLength(1);
  });

  it("names the agent from the filename when the record lost its own name", () => {
    // A held-and-invisible agent is the exact failure this exists to prevent:
    // name it from the file rather than dropping it.
    write("overlord", { ...overlord, agent: undefined });
    expect(readBlockedApprovals(dir)[0].agent).toBe("overlord");
  });

  it("resolves the default dir under ~/.switchroom/blocked-approvals", () => {
    // Mirrors fleetHealthLedgerPath: the web container sets HOME=/host-home,
    // bound to the operator home, so this is the same path the gateway writes.
    const home = mkdtempSync(join(tmpdir(), "sr-home-"));
    expect(blockedApprovalsDir(home)).toBe(
      join(home, ".switchroom", "blocked-approvals"),
    );
    rmSync(home, { recursive: true, force: true });
  });

  it("handleGetBlockedApprovals reads the dir it is given", () => {
    write("overlord", overlord);
    expect(handleGetBlockedApprovals(dir).map((b) => b.agent)).toEqual(["overlord"]);
  });
});

describe("formatBlockedFor (humanized hold duration)", () => {
  it("reads legibly at a glance across the range", () => {
    expect(formatBlockedFor(35_000)).toBe("35s");
    expect(formatBlockedFor(47 * 60_000)).toBe("47m");
    expect(formatBlockedFor(60 * 60_000)).toBe("1h");
    expect(formatBlockedFor(133 * 60_000)).toBe("2h 13m");
    expect(formatBlockedFor(28 * 3600_000)).toBe("1d 4h");
  });

  it("clamps a future blockedSince (clock skew) to 0 instead of emitting a negative", () => {
    expect(formatBlockedFor(-5000)).toBe("0s");
  });
});

describe("deriveAttention — a blocked agent reaches the Summary tab", () => {
  const NOW = 1783756731607;

  const blocked: BlockedApproval = {
    agent: "overlord",
    requestId: "req-abc123",
    toolName: "Bash",
    action: "restart the gateway supervisor",
    blockedSince: NOW - 47 * 60_000,
    undeliverableSince: NOW - 47 * 60_000,
    retryableAt: NOW + 13 * 60_000,
    reason: "flood_wait",
  };

  it("raises a critical row naming the agent and how long it has been held", () => {
    // The whole point: Ken SEES a blocked agent on the default tab, rather
    // than discovering one an hour later.
    const items = deriveAttention({ blockedApprovals: [blocked] }, NOW);
    const row = items.find((i) => i.title.includes("overlord"));

    expect(row).toBeDefined();
    expect(row!.severity).toBe("critical");
    expect(row!.title).toBe("overlord — blocked 47m");
    // it points at the tab that shows the detail
    expect(row!.tab).toBe("approvals");
    // and says what it's blocked on, and why
    expect(row!.detail).toContain("restart the gateway supervisor");
    expect(row!.detail).toContain("flood_wait");
  });

  it("contributes nothing when nothing is blocked (no false alarm)", () => {
    expect(deriveAttention({ blockedApprovals: [] }, NOW)).toEqual([]);
    expect(deriveAttention({ blockedApprovals: null }, NOW)).toEqual([]);
    expect(deriveAttention({}, NOW)).toEqual([]);
  });

  it("raises one row per held agent", () => {
    const items = deriveAttention(
      {
        blockedApprovals: [
          blocked,
          { ...blocked, agent: "clerk", blockedSince: NOW - 5 * 60_000 },
        ],
      },
      NOW,
    );
    expect(items.map((i) => i.title)).toEqual([
      "overlord — blocked 47m",
      "clerk — blocked 5m",
    ]);
  });
});
