/**
 * Unit tests for the in-process schedule hot-reload — the fix for the
 * "frozen schedule at boot" class: an agent self-authors a cron (or an
 * operator edits the schedule.d overlay), but without a reload the edit
 * never takes effect until the container restarts, so a REMOVED entry
 * keeps firing (a zombie that burns a wasted turn every interval) and a
 * NEW entry never runs.
 *
 * createScheduleReloader is pure orchestration (fs + node-cron behind
 * injected callbacks), so these drive it with fakes — no filesystem, no
 * node-cron, no container.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SchedulerEntry } from "../scheduler/dispatch.js";
import {
  createScheduleReloader,
  loadAgentEntriesStrict,
  scheduleSignature,
  resolveReloadPollMs,
  isHotReloadEnabled,
  type ScheduleReloader,
  type RegisteredTask,
} from "./index.js";

function entry(over: Partial<SchedulerEntry> = {}): SchedulerEntry {
  return {
    agent: "clerk",
    scheduleIndex: 0,
    cron: "*/30 * * * *",
    prompt: "sweep",
    promptKey: "k0",
    ...over,
  } as SchedulerEntry;
}

/** A fake registered task that counts stops, so we can assert the old
 *  task set is torn down on reload. */
function fakeTask(): RegisteredTask & { stopped: number } {
  const t = {
    entry: entry(),
    stopped: 0,
    task: { stop: () => { t.stopped += 1; } },
  };
  return t;
}

function makeReloader(opts: {
  initialEntries: SchedulerEntry[];
  sequence: Array<SchedulerEntry[] | Error>; // what loadEntries returns per tick
}): {
  reloader: ScheduleReloader;
  registrations: SchedulerEntry[][];
  logs: string[];
  errors: string[];
  initialTask: RegisteredTask & { stopped: number };
} {
  const registrations: SchedulerEntry[][] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const initialTask = fakeTask();
  let cursor = 0;
  const reloader = createScheduleReloader({
    loadEntries: () => {
      const next = opts.sequence[cursor++];
      if (next instanceof Error) throw next;
      return next ?? [];
    },
    register: (es) => {
      registrations.push(es);
      // one task per entry, so currentTasks().length tracks entry count
      return es.map(() => fakeTask());
    },
    initialTasks: [initialTask],
    initialEntries: opts.initialEntries,
    log: (m) => logs.push(m),
    onError: (e) => errors.push(e.message),
  });
  return { reloader, registrations, logs, errors, initialTask };
}

describe("scheduleSignature", () => {
  it("is stable for identical schedules and differs on any change", () => {
    const a = [entry({ cron: "*/30 * * * *", promptKey: "k1" })];
    const b = [entry({ cron: "*/30 * * * *", promptKey: "k1" })];
    expect(scheduleSignature(a)).toBe(scheduleSignature(b));

    // cron change
    expect(scheduleSignature(a)).not.toBe(
      scheduleSignature([entry({ cron: "*/10 * * * *", promptKey: "k1" })]),
    );
    // prompt change
    expect(scheduleSignature(a)).not.toBe(
      scheduleSignature([entry({ cron: "*/30 * * * *", promptKey: "k1", prompt: "other" })]),
    );
    // entry added
    expect(scheduleSignature(a)).not.toBe(scheduleSignature([a[0], entry({ promptKey: "k2" })]));
    // entry removed
    expect(scheduleSignature(a)).not.toBe(scheduleSignature([]));
  });
});

describe("createScheduleReloader", () => {
  it("does nothing when the schedule is unchanged", () => {
    const { reloader, registrations, logs, initialTask } = makeReloader({
      initialEntries: [entry()],
      sequence: [[entry()], [entry()]], // same signature both ticks
    });
    reloader.tick();
    reloader.tick();
    expect(registrations).toHaveLength(0); // never re-registered
    expect(initialTask.stopped).toBe(0); // boot tasks left running
    expect(logs).toHaveLength(0);
    expect(reloader.currentTasks()).toHaveLength(1); // still the boot task
  });

  it("removes a zombie entry: */10 dropped, */30 remains → re-registers with the new set", () => {
    // The exact reported bug: boot schedule had a */10 sweep + a daily;
    // the overlay edit removed */10 and added */30. After reload only the
    // surviving entries are registered — the zombie */10 is gone.
    const tenMin = entry({ cron: "*/10 * * * *", promptKey: "zombie" });
    const daily = entry({ cron: "0 8 * * *", promptKey: "daily", scheduleIndex: 1 });
    const thirtyMin = entry({ cron: "*/30 * * * *", promptKey: "v3", scheduleIndex: 2 });
    const { reloader, registrations, logs, initialTask } = makeReloader({
      initialEntries: [tenMin, daily],
      sequence: [[daily, thirtyMin]],
    });
    reloader.tick();
    expect(initialTask.stopped).toBe(1); // old task set torn down
    expect(registrations).toEqual([[daily, thirtyMin]]); // re-registered without the zombie
    expect(reloader.currentTasks()).toHaveLength(2);
    expect(logs[0]).toMatch(/schedule reloaded: 1 → 2 task/);
  });

  it("activates the first cron (0 → 1) on reload", () => {
    const { reloader, registrations } = makeReloader({
      initialEntries: [],
      sequence: [[entry()]],
    });
    // boot had 0 entries but reloader was given the boot task list; here
    // simulate the active-path reloader seeing entries appear.
    reloader.tick();
    expect(registrations).toEqual([[entry()]]);
    expect(reloader.currentTasks()).toHaveLength(1);
  });

  it("drains to zero tasks when all entries are removed (N → 0)", () => {
    const { reloader, registrations, initialTask } = makeReloader({
      initialEntries: [entry()],
      sequence: [[]],
    });
    reloader.tick();
    expect(initialTask.stopped).toBe(1);
    expect(registrations).toEqual([[]]);
    expect(reloader.currentTasks()).toHaveLength(0);
  });

  it("keeps the current schedule on a transient load error (overlay mid-write)", () => {
    const { reloader, registrations, errors, initialTask } = makeReloader({
      initialEntries: [entry()],
      sequence: [new Error("yaml parse error"), [entry({ cron: "*/15 * * * *" })]],
    });
    reloader.tick(); // load throws → keep current, no re-register
    expect(registrations).toHaveLength(0);
    expect(initialTask.stopped).toBe(0);
    expect(errors).toEqual(["yaml parse error"]);
    expect(reloader.currentTasks()).toHaveLength(1); // boot task untouched

    reloader.tick(); // recovers → now applies the changed schedule
    expect(registrations).toHaveLength(1);
    expect(initialTask.stopped).toBe(1);
  });

  it("re-registers exactly once per distinct change across many no-op ticks", () => {
    const e1 = [entry({ cron: "*/30 * * * *" })];
    const e2 = [entry({ cron: "*/45 * * * *" })];
    const { reloader, registrations } = makeReloader({
      initialEntries: e1,
      sequence: [e1, e1, e2, e2, e2], // change happens once (tick 3)
    });
    for (let i = 0; i < 5; i++) reloader.tick();
    expect(registrations).toEqual([e2]); // exactly one re-register
  });
});

// chmod 0o000 does not stop root from reading — the unreadable-file
// simulation below only works for an unprivileged test uid.
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe.skipIf(runningAsRoot)(
  "hot-reload × unreadable schedule.d overlay — OUTCOME (clerk EACCES incident)",
  () => {
    // End-to-end through the REAL loader stack (loadConfig →
    // applyAgentOverlays → collectScheduleEntries) with a real tmp
    // filesystem — only node-cron is faked. Pre-fix, the reloader's
    // loadEntries used the non-strict pipeline: an EACCES'd overlay file
    // yielded a config silently missing that file's entries, the reload
    // diff saw "entry removed", and the live cron was UNREGISTERED
    // ("schedule reloaded: 11 → 10") — every fire lost until the file's
    // ownership was fixed (weeks, on the live fleet). This test asserts
    // the outcome: a cron file that turns unreadable NEVER costs the
    // registration.

    let tmpHome: string;
    let prevHome: string | undefined;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      tmpHome = mkdtempSync(join(tmpdir(), "hot-reload-eacces-"));
      prevHome = process.env.HOME;
      process.env.HOME = tmpHome;
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      warnSpy.mockRestore();
      try {
        rmSync(tmpHome, { recursive: true, force: true });
      } catch { /* best-effort */ }
    });

    const AGENT = "relay";

    function writeFixture(): { configPath: string; overlayPath: string } {
      const configPath = join(tmpHome, "switchroom.yaml");
      writeFileSync(
        configPath,
        [
          "switchroom:",
          "  version: 1",
          "telegram:",
          '  bot_token: "x"',
          '  forum_chat_id: "1"',
          "agents:",
          `  ${AGENT}:`,
          '    bot_token: "vault:relay-bot"',
          "    forum_chat_id: 1",
          `    topic_name: "${AGENT}"`,
          "",
        ].join("\n"),
      );
      const dir = join(tmpHome, ".switchroom", "agents", AGENT, "schedule.d");
      mkdirSync(dir, { recursive: true });
      const overlayPath = join(dir, "cron-abcdefabcdef.yaml");
      writeFileSync(
        overlayPath,
        "schedule:\n  - cron: '*/30 * * * *'\n    prompt: overlay-cron\n",
      );
      return { configPath, overlayPath };
    }

    it("a schedule.d file that turns unreadable never unregisters its live cron", () => {
      const { configPath, overlayPath } = writeFixture();

      // Boot: overlay readable → entry loads and registers.
      const boot = loadAgentEntriesStrict(configPath, AGENT);
      expect(boot.map((e) => e.prompt)).toEqual(["overlay-cron"]);

      const registrations: SchedulerEntry[][] = [];
      const errors: string[] = [];
      let stops = 0;
      const register = (es: SchedulerEntry[]): RegisteredTask[] => {
        registrations.push(es);
        return es.map((e) => ({ entry: e, task: { stop: () => { stops += 1; } } }));
      };
      const initialTasks = register(boot);
      registrations.length = 0; // boot registration isn't a reload

      // Wired exactly as main() wires it post-fix.
      const reloader = createScheduleReloader({
        loadEntries: () => loadAgentEntriesStrict(configPath, AGENT),
        register,
        initialTasks,
        initialEntries: boot,
        log: () => {},
        onError: (e) => errors.push(e.message),
      });

      // The incident: file becomes unreadable (foreign-owner 0600 ≙ chmod 000).
      chmodSync(overlayPath, 0o000);
      reloader.tick();
      reloader.tick();

      // OUTCOME: the live cron is still registered — no stop, no shrink.
      expect(stops).toBe(0);
      expect(registrations).toHaveLength(0);
      expect(reloader.currentTasks().map((t) => t.entry.prompt)).toEqual(["overlay-cron"]);
      // And the refusal is surfaced, naming the file and errno.
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("EACCES");
      expect(errors[0]).toContain(overlayPath);

      // Heal the perms: schedule matches the live one → still no churn.
      chmodSync(overlayPath, 0o600);
      reloader.tick();
      expect(stops).toBe(0);
      expect(reloader.currentTasks().map((t) => t.entry.prompt)).toEqual(["overlay-cron"]);
    });

    it("a genuinely REMOVED overlay file still unregisters (no false retention)", () => {
      const { configPath, overlayPath } = writeFixture();
      const boot = loadAgentEntriesStrict(configPath, AGENT);
      const registrations: SchedulerEntry[][] = [];
      const register = (es: SchedulerEntry[]): RegisteredTask[] =>
        (registrations.push(es), es.map((e) => ({ entry: e, task: { stop: () => {} } })));
      const initialTasks = register(boot);
      registrations.length = 0;
      const reloader = createScheduleReloader({
        loadEntries: () => loadAgentEntriesStrict(configPath, AGENT),
        register,
        initialTasks,
        initialEntries: boot,
        log: () => {},
        onError: () => {},
      });
      rmSync(overlayPath);
      reloader.tick();
      // The zombie-cron fix stays intact: deletion really unregisters.
      expect(registrations).toEqual([[]]);
      expect(reloader.currentTasks()).toEqual([]);
    });
  },
);

describe("resolveReloadPollMs", () => {
  it("defaults to 30s and floors sub-1s overrides", () => {
    expect(resolveReloadPollMs({})).toBe(30_000);
    expect(resolveReloadPollMs({ SWITCHROOM_SCHEDULER_RELOAD_POLL_MS: "5000" })).toBe(5000);
    expect(resolveReloadPollMs({ SWITCHROOM_SCHEDULER_RELOAD_POLL_MS: "500" })).toBe(30_000);
    expect(resolveReloadPollMs({ SWITCHROOM_SCHEDULER_RELOAD_POLL_MS: "garbage" })).toBe(30_000);
  });
});

describe("isHotReloadEnabled", () => {
  it("is on by default and only '0' disables it", () => {
    expect(isHotReloadEnabled({})).toBe(true);
    expect(isHotReloadEnabled({ SWITCHROOM_SCHEDULER_HOT_RELOAD: "1" })).toBe(true);
    expect(isHotReloadEnabled({ SWITCHROOM_SCHEDULER_HOT_RELOAD: "0" })).toBe(false);
  });
});
