import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readBlockedApprovals,
  readBlockedApprovalsWithErrors,
  handleGetBlockedApprovals,
  handleGetBlockedApprovalsStatus,
  blockedApprovalsDir,
  formatBlockedFor,
  type BlockedApproval,
} from "./blocked-approvals-read.js";
import { deriveAttention, handleGetSummary } from "./api.js";
// The REAL gateway-side writer. The fallback contract below is a two-module
// contract (writer picks the path, reader has to scan it); testing either half
// alone is how it shipped broken.
import { createBlockedApprovalStore } from "../../telegram-plugin/gateway/approval-hold.js";

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
  let root: string;
  let dir: string;

  beforeEach(() => {
    // Mirror the production layout: the shared dir has an `agents` SIBLING (the
    // per-agent fallback root the reader also scans). A bare mkdtemp dir would
    // make that sibling resolve to `<tmp>/agents` — outside the fixture, and so
    // not hermetic.
    root = mkdtempSync(join(tmpdir(), "sr-blocked-appr-"));
    dir = join(root, "blocked-approvals");
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    // chmod back first — a 0000 file inside can defeat the recursive rm.
    try {
      chmodSync(join(dir, "locked.json"), 0o644);
    } catch {
      /* not every case writes it */
    }
    rmSync(root, { recursive: true, force: true });
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

  // ── "I could not look" must never render as "nothing is blocked" ──────
  //
  // THE blocker this feature must not have. An unreadable record (0600 —
  // exactly how pending-perm-cards.json is written today, and exactly how the
  // Hermes registry.db bug happened) means an agent MAY be held right now.
  // Reporting that as an empty list makes the page print a confident
  // "No agent is blocked on an undeliverable approval" over a hanging agent.
  describe("an unreadable record is never reported as an honest empty", () => {
    it("counts a record it could not read, separately from one that isn't there", () => {
      // EISDIR: unreadable for EVERY uid including root in CI, so this is
      // deterministic where a chmod is not.
      mkdirSync(join(dir, "overlord.json"));

      const { blocked, unreadable } = readBlockedApprovalsWithErrors(dir);
      expect(blocked).toEqual([]);
      // The list is empty, but we did NOT verify that nothing is blocked.
      expect(unreadable).toBe(1);
    });

    it("an absent dir is a TRUE empty — unreadable 0 (nothing to warn about)", () => {
      const { blocked, unreadable } = readBlockedApprovalsWithErrors(
        join(dir, "does-not-exist"),
      );
      expect(blocked).toEqual([]);
      // ENOENT is honest emptiness, not blindness. It must NOT warn — a
      // permanent false alarm would train the operator to ignore the surface.
      expect(unreadable).toBe(0);
    });

    it("an empty dir is a TRUE empty — unreadable 0", () => {
      expect(readBlockedApprovalsWithErrors(dir)).toEqual({
        blocked: [],
        unreadable: 0,
      });
    });

    it("malformed JSON is a parse-miss, not blindness — we looked", () => {
      writeFileSync(join(dir, "overlord.json"), "{ not json");
      expect(readBlockedApprovalsWithErrors(dir).unreadable).toBe(0);
    });

    it("an unreadable record still reports the readable ones AND the blind spot", () => {
      mkdirSync(join(dir, "clerk.json"));
      write("overlord", overlord);

      const { blocked, unreadable } = readBlockedApprovalsWithErrors(dir);
      expect(blocked.map((b) => b.agent)).toEqual(["overlord"]);
      expect(unreadable).toBe(1);
    });

    it.skipIf(process.getuid?.() === 0)(
      "a real 0600 root-owned-style record counts as unreadable, not as absent",
      () => {
        writeFileSync(join(dir, "locked.json"), JSON.stringify(overlord));
        chmodSync(join(dir, "locked.json"), 0o000);

        const { blocked, unreadable } = readBlockedApprovalsWithErrors(dir);
        expect(blocked).toEqual([]);
        expect(unreadable).toBe(1);
      },
    );

    it("the status endpoint surfaces the blind spot out-of-band", () => {
      // It cannot ride on /api/blocked-approvals (bare array, Hermes
      // contract) and must NOT be a synthesized fake row in that array.
      mkdirSync(join(dir, "overlord.json"));
      expect(handleGetBlockedApprovalsStatus(dir)).toEqual({
        blocked: 0,
        unreadable: 1,
      });
    });

    it("the bare-array endpoint keeps its Hermes contract even when blind", () => {
      mkdirSync(join(dir, "overlord.json"));
      const arr = handleGetBlockedApprovals(dir);
      expect(Array.isArray(arr)).toBe(true);
      expect(arr).toEqual([]); // no fake row synthesized into the array
    });

    it("deriveAttention raises a CRITICAL row when records are unreadable", () => {
      // The surface must not claim health. This is the assertion that goes
      // RED if the read ever silently returns [] again.
      const items = deriveAttention(
        { blockedApprovals: [], blockedApprovalsUnreadable: 1 },
        NOW,
      );
      expect(items).toHaveLength(1);
      expect(items[0].severity).toBe("critical");
      expect(items[0].title).toContain("Cannot read");
      expect(items[0].tab).toBe("approvals");
      expect(items[0].detail).toContain("may be held");
    });

    it("deriveAttention stays silent when the read was clean and empty", () => {
      // No false alarm on the honest-empty path (the pre-producer state).
      expect(
        deriveAttention(
          { blockedApprovals: [], blockedApprovalsUnreadable: 0 },
          NOW,
        ),
      ).toEqual([]);
    });
  });

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

  // ───────────────────────────────────────────────────────────────────────────
  // THE FALLBACK CONTRACT (#3109 gap). The gateway's store writes the shared
  // record when it can and falls back to the agent's OWN state dir when the
  // shared dir isn't writable by the agent's uid. That fallback shipped writing
  // a DIFFERENT filename in a DIFFERENT directory from the only one this reader
  // scanned — so the record existed, the agent was held, and the dashboard said
  // "No agent is blocked". These drive the REAL writer against the REAL reader.
  // ───────────────────────────────────────────────────────────────────────────
  describe("the FALLBACK record (agent's own state dir) reaches the dashboard", () => {
    /**
     * The production trigger, faithfully: the SHARED dir cannot be written by
     * this uid. In prod that is docker auto-creating the bind source root-owned
     * while the agent runs as uid 10001+. A test can't chown, and it can't just
     * chmod the shared dir either — `tryWrite` chmods its own parent back to
     * 1777, and in-test we OWN it, so that would succeed and no fallback fires.
     * So make the shared dir UNCREATABLE by locking its parent (the pattern from
     * telegram-plugin/tests/approval-hold-record.test.ts). Same `tryWrite` →
     * false → fallback branch, no root required.
     */
    let locked: string; // read-only parent
    let sharedDir: string; // the (uncreatable) shared dir under it
    let agentsRoot: string; // its `agents` sibling — the fallback root

    beforeEach(() => {
      locked = join(root, "locked");
      sharedDir = join(locked, "blocked-approvals");
      agentsRoot = join(locked, "agents");
      mkdirSync(agentsRoot, { recursive: true });
    });
    afterEach(() => {
      try {
        chmodSync(locked, 0o755);
      } catch {
        /* not every case locks it */
      }
    });

    /** The real gateway store, pointed at the locked layout. */
    function heldStore(agent: string) {
      const ownDir = join(agentsRoot, agent);
      mkdirSync(ownDir, { recursive: true });
      const s = createBlockedApprovalStore(sharedDir, agent, ownDir);
      chmodSync(locked, 0o500); // shared dir now uncreatable — fallback territory
      return { store: s, ownDir };
    }

    /** The real gateway store, writing into the WRITABLE outer fixture. */
    function store(agent: string) {
      const ownDir = join(root, "agents", agent);
      mkdirSync(ownDir, { recursive: true });
      return { store: createBlockedApprovalStore(dir, agent, ownDir), ownDir };
    }

    const rec = (agent: string) => ({
      agent,
      requestId: "req-held-1",
      toolName: "Bash",
      action: "run shell commands",
      blockedSince: NOW - 47 * 60_000,
      undeliverableSince: NOW - 47 * 60_000,
      retryableAt: NOW + 13 * 60_000,
      reason: "flood_wait" as const,
    });

    it("is READ by the web reader when the shared dir is unwritable", () => {
      const s = heldStore("overlord");
      s.store.write(rec("overlord"));

      // The record landed in the agent's OWN dir, not the shared one…
      expect(s.store.path).toBe(join(s.ownDir, "blocked-approval.json"));
      // …and the reader finds it anyway. Before this fix: [] — a held agent,
      // a record on disk, and a dashboard saying "No agent is blocked".
      const blocked = readBlockedApprovals(sharedDir);
      expect(blocked.map((b) => b.agent)).toEqual(["overlord"]);
      expect(blocked[0].requestId).toBe("req-held-1");
      expect(blocked[0].reason).toBe("flood_wait");
      // And it is not miscounted as a read FAILURE — the surface must say
      // "overlord is blocked", not "I could not look".
      expect(readBlockedApprovalsWithErrors(sharedDir).unreadable).toBe(0);
    });

    it("is written world-readable — a 0600 fallback would be invisible to web", () => {
      // The web container is uid 1000 and the agent dir is agent-uid-owned. The
      // dir is traversable (0775); it is the FILE's mode that decides whether
      // web can read it. 0600 here = a silently empty dashboard.
      const s = heldStore("overlord");
      s.store.write(rec("overlord"));
      expect(statSync(s.store.path).mode & 0o004).toBe(0o004);
    });

    it("does not double-report an agent that also has a shared record", () => {
      // The store unlinks its fallback once a shared write succeeds, so a
      // leftover fallback is stale by definition. Belt-and-braces: even if both
      // files exist, the agent surfaces ONCE, from the canonical shared record.
      const s = store("overlord");
      mkdirSync(s.ownDir, { recursive: true });
      writeFileSync(
        join(s.ownDir, "blocked-approval.json"),
        JSON.stringify({ ...rec("overlord"), requestId: "req-STALE" }),
      );
      write("overlord", { ...rec("overlord"), requestId: "req-LIVE" });

      const blocked = readBlockedApprovals(dir);
      expect(blocked).toHaveLength(1);
      expect(blocked[0].requestId).toBe("req-LIVE");
    });

    it("clears both locations, so a resolved hold leaves nothing behind", () => {
      const s = heldStore("overlord");
      s.store.write(rec("overlord"));
      expect(readBlockedApprovals(sharedDir)).toHaveLength(1);
      s.store.clear();
      // A stale record would keep the dashboard shouting about a block that is
      // over — the mirror image of the invisible-block bug, equally corrosive.
      expect(readBlockedApprovals(sharedDir)).toEqual([]);
    });

    it("ranks a fallback record alongside shared ones by hold age", () => {
      write("clerk", { ...rec("clerk"), blockedSince: NOW - 5 * 60_000 });
      const s = store("marko");
      mkdirSync(s.ownDir, { recursive: true });
      writeFileSync(
        join(s.ownDir, "blocked-approval.json"),
        JSON.stringify({ ...rec("marko"), blockedSince: NOW - 3 * 3600_000 }),
      );
      // marko (3h, fallback) has been waiting longest and must lead.
      expect(readBlockedApprovals(dir).map((b) => b.agent)).toEqual(["marko", "clerk"]);
    });

    it("an agents dir with no held agent is an honest empty, not an 'unreadable'", () => {
      mkdirSync(join(root, "agents", "clerk"), { recursive: true });
      mkdirSync(join(root, "agents", "overlord"), { recursive: true });
      expect(readBlockedApprovalsWithErrors(dir)).toEqual({ blocked: [], unreadable: 0 });
    });

    it("counts an UNREADABLE fallback record rather than implying all-clear", () => {
      const s = store("overlord");
      const f = join(s.ownDir, "blocked-approval.json");
      writeFileSync(f, JSON.stringify(rec("overlord")));
      chmodSync(f, 0o000); // the 0600-mode trap, in its extreme form
      try {
        const { blocked, unreadable } = readBlockedApprovalsWithErrors(dir);
        expect(blocked).toEqual([]);
        // "I could not look" — NEVER "nothing is blocked".
        expect(unreadable).toBe(1);
      } finally {
        chmodSync(f, 0o644);
      }
    });
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

  it("carries the unreadable count through handleGetSummary to the Summary tab", async () => {
    // The services rail reads `blockedApprovalsUnreadable` to decide whether
    // it may print "all nominal". Pin that it actually arrives.
    const nullPart = <T,>(value: T) => async () => ({ value, dataAsOf: NOW });
    const summary = await handleGetSummary(
      {
        agents: nullPart(null as never),
        systemHealth: nullPart(null as never),
        approvals: nullPart(null as never),
        schedule: nullPart(null as never),
        accounts: nullPart(null as never),
        memoryHealth: nullPart(null as never),
        blockedApprovals: () => ({ blocked: [], unreadable: 2 }),
      },
      NOW,
    );

    expect(summary.blockedApprovals).toEqual([]);
    expect(summary.blockedApprovalsUnreadable).toBe(2);
    // and it must surface as a critical row, not as silence
    expect(summary.attention.some((i) => i.severity === "critical")).toBe(true);
  });

  it("reports a blind spot (not an all-clear) if the whole read throws", async () => {
    const nullPart = <T,>(value: T) => async () => ({ value, dataAsOf: NOW });
    const summary = await handleGetSummary(
      {
        agents: nullPart(null as never),
        systemHealth: nullPart(null as never),
        approvals: nullPart(null as never),
        schedule: nullPart(null as never),
        accounts: nullPart(null as never),
        memoryHealth: nullPart(null as never),
        blockedApprovals: () => {
          throw new Error("disk exploded");
        },
      },
      NOW,
    );

    // Degrades without taking the summary down, but does NOT claim health.
    expect(summary.blockedApprovals).toEqual([]);
    expect(summary.blockedApprovalsUnreadable).toBe(1);
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
