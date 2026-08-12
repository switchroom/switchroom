import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
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
 * Does this process actually get told "no" by a file mode?
 *
 * uid 0 does NOT — root reads a 0000 file happily — and neither do some CI
 * filesystems. A chmod-based guard is therefore VACUOUS for those runs, and the
 * uid check it replaces was only ever a proxy for this question. Probe the real
 * capability instead, and say so LOUDLY when it is absent, so a skipped guard
 * can never be mistaken for a passing one.
 *
 * Only the two tests whose SUBJECT is real kernel mode enforcement use this.
 * Every other unreadable-record case is driven by EISDIR (a directory named
 * `<agent>.json`), which fails for every uid including root.
 */
function fileModesEnforced(): boolean {
  const probeRoot = mkdtempSync(join(tmpdir(), "sr-mode-probe-"));
  const probe = join(probeRoot, "probe");
  try {
    writeFileSync(probe, "x");
    chmodSync(probe, 0o000);
    try {
      readFileSync(probe);
      return false; // read succeeded through a 0000 mode — root, or a mode-less fs
    } catch {
      return true;
    }
  } finally {
    try {
      chmodSync(probe, 0o644);
    } catch {
      /* best effort */
    }
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

const MODES_ENFORCED = fileModesEnforced();
if (!MODES_ENFORCED) {
  // eslint-disable-next-line no-console
  console.warn(
    "blocked-approvals.test.ts: file modes are NOT enforced for this process " +
      `(uid ${process.getuid?.() ?? "?"}) — the two guards that assert on a REAL ` +
      "0600/0000 record are SKIPPED, not passing. Run the suite as a non-root uid " +
      "to exercise them.",
  );
}

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

  it.skipIf(!MODES_ENFORCED)(
    "degrades honestly on a real 0600/0000 file instead of exploding " +
      "(skipped when file modes are not enforced — e.g. running as root)",
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

    it.skipIf(!MODES_ENFORCED)(
      "a real 0600 root-owned-style record counts as unreadable, not as absent " +
        "(skipped when file modes are not enforced — e.g. running as root)",
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
     * The production trigger, faithfully: the SHARED dir cannot be WRITTEN by
     * this uid (docker auto-creates the bind source root-owned while the agent
     * runs as uid 10001+), while still being readable/enumerable by the web
     * reader.
     *
     * This used to be simulated by `chmod 0500` on the shared dir's parent.
     * **That guard was vacuous whenever the suite ran as root** — uid 0 ignores
     * file modes, so the shared write SUCCEEDED and the fallback branch was
     * never entered. `is written world-readable` and `clears both locations`
     * then passed while describing the SHARED record, and the two tests that
     * assert on the fallback PATH went red. Root is not exotic: it is how the
     * fleet's debug container runs the suite.
     *
     * A filesystem artifact cannot replace the chmod either — anything planted
     * in the shared dir to make the write fail is also seen by the READER and
     * counted as an unreadable record, which is precisely what
     * `unreadable === 0` below measures. So the EACCES is INJECTED (see
     * `BlockedApprovalStoreDeps`): the store's real branch logic runs, the
     * refusal is deterministic for every uid, and the shared dir stays a clean,
     * honestly-empty directory from the reader's side.
     */
    let sharedRoot: string; // stands in for `~/.switchroom`
    let sharedDir: string; // its `blocked-approvals` — writes here are refused
    let agentsRoot: string; // its `agents` sibling — the fallback root

    beforeEach(() => {
      sharedRoot = join(root, "held");
      sharedDir = join(sharedRoot, "blocked-approvals");
      agentsRoot = join(sharedRoot, "agents");
      mkdirSync(agentsRoot, { recursive: true });
    });

    /** EACCES in the shape the kernel raises it for a root-owned shared dir. */
    function eacces(path: string): NodeJS.ErrnoException {
      const e: NodeJS.ErrnoException = new Error(
        `EACCES: permission denied, open '${path}'`,
      );
      e.code = "EACCES";
      e.errno = -13;
      e.syscall = "open";
      e.path = path;
      return e;
    }

    /** The real gateway store, with the SHARED write refused (uid-independent). */
    function heldStore(agent: string) {
      const ownDir = join(agentsRoot, agent);
      mkdirSync(ownDir, { recursive: true });
      const s = createBlockedApprovalStore(sharedDir, agent, ownDir, {
        writeFileSync: ((file, data, opts) => {
          if (String(file).startsWith(sharedDir + sep)) throw eacces(String(file));
          return writeFileSync(file, data, opts);
        }) as typeof writeFileSync,
      });
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
      // The 0600-mode trap, expressed as EISDIR: a DIRECTORY named
      // `blocked-approval.json` is unreadable by `readFileSync` for EVERY uid,
      // including root, and lands on the same non-ENOENT branch a real EACCES
      // does. A `chmod 0000` here was vacuous-then-red under uid 0 — root reads
      // a 0000 file, so the record surfaced as blocked and `unreadable` was 0.
      const s = store("overlord");
      mkdirSync(join(s.ownDir, "blocked-approval.json"), { recursive: true });

      const { blocked, unreadable } = readBlockedApprovalsWithErrors(dir);
      expect(blocked).toEqual([]);
      // "I could not look" — NEVER "nothing is blocked".
      expect(unreadable).toBe(1);
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
