/**
 * Rollout pin journal — the two-phase commit that keeps a durable
 * `release.pin` from outliving a roll that failed.
 *
 * These assert OUTCOMES on a real (tmpdir) config file: after each scenario,
 * what does `release.pin` actually say, and what ELSE in the config survived?
 * A test that only checked "the journal function was called" would not have
 * failed on the original bug.
 */

import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pinJournalPath,
  hasPinJournal,
  readPinJournal,
  beginPinPersist,
  commitPinPersist,
  rollbackPinPersist,
  recoverPinJournal,
  isPidAlive,
  isJournalFresh,
  PIN_JOURNAL_MAX_AGE_MS,
  type RolloutPinJournal,
} from "./rollout-pin-journal.js";
import { setReleasePinInConfig, getReleasePinFromConfig } from "./release-yaml.js";

const CONFIG = `telegram:
  bot_token: x
release:
  pin: v0.19.3 # 2026-07-01: rolled by switchroom rollout
agents:
  clerk:
    extends: default
`;

function mkConfig(text = CONFIG): string {
  const dir = mkdtempSync(join(tmpdir(), "pin-journal-"));
  const p = join(dir, "switchroom.yaml");
  writeFileSync(p, text, "utf8");
  return p;
}

/** Simulate the production persistPin: journal, then write the new pin. */
function provisionallyPersist(configPath: string, pin: string): void {
  const before = readFileSync(configPath, "utf8");
  beginPinPersist(configPath, pin);
  writeFileSync(configPath, setReleasePinInConfig(before, pin), "utf8");
}

function pinOf(configPath: string): string | undefined {
  return getReleasePinFromConfig(readFileSync(configPath, "utf8"));
}

/** A clock far enough past the journal's `at` that it reads as abandoned. */
function afterTimeout(): number {
  return Date.now() + PIN_JOURNAL_MAX_AGE_MS + 1;
}

describe("pin journal — two-phase commit", () => {
  it("a provisional write changes the pin but leaves a journal", () => {
    const cfg = mkConfig();
    provisionallyPersist(cfg, "v0.19.4");
    expect(pinOf(cfg)).toBe("v0.19.4");
    expect(hasPinJournal(cfg)).toBe(true);
    const j = readPinJournal(cfg);
    expect(j?.pin).toBe("v0.19.4");
    expect(j?.priorPin).toBe("v0.19.3");
    // Liveness marker, so recovery can tell "died" from "still running".
    expect(j?.pid).toBe(process.pid);
    // The journal records pin VALUES only — never a config snapshot, whose
    // restore would silently discard unrelated edits made in the meantime.
    expect(JSON.stringify(j)).not.toContain("bot_token");
  });

  it("commit makes the pin durable and clears the journal", () => {
    const cfg = mkConfig();
    provisionallyPersist(cfg, "v0.19.4");
    expect(commitPinPersist(cfg)).toBeNull();
    expect(pinOf(cfg)).toBe("v0.19.4");
    expect(hasPinJournal(cfg)).toBe(false);
    // A later recovery pass must NOT undo a committed roll.
    expect(recoverPinJournal(cfg, { now: afterTimeout() })).toBeNull();
    expect(pinOf(cfg)).toBe("v0.19.4");
  });

  it("rollback restores the prior pin and touches NOTHING else", () => {
    const cfg = mkConfig();
    provisionallyPersist(cfg, "v0.19.4");
    const out = rollbackPinPersist(cfg);
    expect(out.reverted).toBe(true);
    expect(out.pin).toBe("v0.19.4");
    expect(out.priorPin).toBe("v0.19.3");
    expect(pinOf(cfg)).toBe("v0.19.3");
    // Every other key and its comments survive the targeted edit.
    const text = readFileSync(cfg, "utf8");
    expect(text).toContain("bot_token: x");
    expect(text).toContain("clerk:");
    expect(hasPinJournal(cfg)).toBe(false);
  });

  it("does NOT discard config edits made after the provisional write", () => {
    // THE mirror-image bug a whole-file snapshot restore would have: on the
    // hostd path the pin lands right after the canary and the remaining
    // agents take minutes. Anything that edits the config in that window —
    // an operator adding an agent, an approved config_propose_edit — must
    // survive the rollback.
    const cfg = mkConfig();
    provisionallyPersist(cfg, "v0.19.4");
    writeFileSync(
      cfg,
      readFileSync(cfg, "utf8") + "  archivist:\n    extends: default\n",
      "utf8",
    );

    expect(rollbackPinPersist(cfg).reverted).toBe(true);

    const text = readFileSync(cfg, "utf8");
    expect(pinOf(cfg)).toBe("v0.19.3"); // pin reverted…
    expect(text).toContain("archivist:"); // …and the unrelated edit kept.
  });

  it("rollback DELETES the pin when the config was unpinned before the roll", () => {
    const unpinned = `telegram:\n  bot_token: x\nagents:\n  clerk:\n    extends: default\n`;
    const cfg = mkConfig(unpinned);
    provisionallyPersist(cfg, "v0.19.4");
    expect(pinOf(cfg)).toBe("v0.19.4");
    const out = rollbackPinPersist(cfg);
    expect(out.reverted).toBe(true);
    expect(out.priorPin).toBeUndefined();
    expect(pinOf(cfg)).toBeUndefined();
    // No `release: {}` husk left behind — that fails the schema refine.
    expect(readFileSync(cfg, "utf8")).not.toMatch(/release:/);
  });

  it("commit and rollback are both idempotent", () => {
    const cfg = mkConfig();
    provisionallyPersist(cfg, "v0.19.4");
    expect(rollbackPinPersist(cfg).reverted).toBe(true);
    // Second rollback is a no-op — it must NOT re-revert over a later,
    // legitimate pin write.
    provisionallyPersist(cfg, "v0.19.5");
    expect(commitPinPersist(cfg)).toBeNull();
    expect(commitPinPersist(cfg)).toBeNull();
    expect(rollbackPinPersist(cfg).reverted).toBe(false);
    expect(pinOf(cfg)).toBe("v0.19.5");
  });

  it("writes the journal atomically and owner-only", () => {
    const cfg = mkConfig();
    chmodSync(cfg, 0o600);
    provisionallyPersist(cfg, "v0.19.4");
    expect(statSync(pinJournalPath(cfg)).mode & 0o077).toBe(0);
    // tmp+rename leaves no debris beside the journal.
    expect(existsSync(`${pinJournalPath(cfg)}.${process.pid}.tmp`)).toBe(false);
  });
});

describe("pin journal — liveness gate (a live roll must not be reverted)", () => {
  it("leaves the pin alone while the writing process is alive and the journal is young", () => {
    // THE regression this gate exists for: hostd restarts MID-ROLL (the
    // host-shell path refreshes hostd as its last step; a self-bump recreates
    // it outright). Boot recovery must not revert the pin of a roll that is
    // still running — or one that already succeeded and is about to commit.
    const cfg = mkConfig();
    provisionallyPersist(cfg, "v0.19.4"); // pid = this live process
    const note = recoverPinJournal(cfg);
    expect(note).toMatch(/still looks live/);
    expect(pinOf(cfg)).toBe("v0.19.4"); // NOT reverted
    expect(hasPinJournal(cfg)).toBe(true); // journal preserved for later
  });

  it("reverts once the journal ages past the cutoff, even if the pid still resolves", () => {
    // Pids are recycled and a recreated hostd can land on the recorded one,
    // so age is the backstop that guarantees eventual recovery.
    const cfg = mkConfig();
    provisionallyPersist(cfg, "v0.19.4");
    const note = recoverPinJournal(cfg, { now: afterTimeout() });
    expect(note).toMatch(/reverted an UNCOMMITTED release.pin=v0\.19\.4/);
    expect(pinOf(cfg)).toBe("v0.19.3");
  });

  it("the rollout's own failure path reverts immediately, without the gate", () => {
    // requireStale defaults to false: that caller IS the writer and knows the
    // roll failed, so waiting out a 15-minute cutoff would be absurd.
    const cfg = mkConfig();
    provisionallyPersist(cfg, "v0.19.4");
    expect(rollbackPinPersist(cfg).reverted).toBe(true);
    expect(pinOf(cfg)).toBe("v0.19.3");
  });

  it("isPidAlive / isJournalFresh behave at their edges", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    // A pid far above the kernel's pid_max cannot exist.
    expect(isPidAlive(0x3fffffff)).toBe(false);

    const base = { v: 1 as const, configPath: "/c", pin: "v1", pid: 1 };
    const now = Date.now();
    expect(isJournalFresh({ ...base, at: new Date(now).toISOString() }, now)).toBe(true);
    expect(
      isJournalFresh(
        { ...base, at: new Date(now - PIN_JOURNAL_MAX_AGE_MS - 1).toISOString() },
        now,
      ),
    ).toBe(false);
    // An undateable journal is NOT fresh — we cannot claim it is in flight.
    expect(isJournalFresh({ ...base, at: "not-a-date" } as RolloutPinJournal, now)).toBe(
      false,
    );
  });
});

describe("pin journal — crash recovery", () => {
  it("reverts an uncommitted pin left by a rollout that was killed mid-roll", () => {
    const cfg = mkConfig();
    // The roll persisted the pin after a green canary, then the process was
    // SIGKILLed before it could commit OR revert. Nothing in-process runs.
    provisionallyPersist(cfg, "v0.19.4");
    expect(pinOf(cfg)).toBe("v0.19.4");

    // A fresh hostd boots and runs recovery, long enough after the fact that
    // the journal reads as abandoned.
    const note = recoverPinJournal(cfg, { now: afterTimeout() });
    expect(note).toMatch(/reverted an UNCOMMITTED release.pin=v0\.19\.4/);
    // THE outcome: the durable pin names the last PROVEN version, so a later
    // reconcile / `compose up -d` cannot converge the fleet onto v0.19.4.
    expect(pinOf(cfg)).toBe("v0.19.3");
    expect(existsSync(pinJournalPath(cfg))).toBe(false);
  });

  it("is a no-op when no roll was in flight", () => {
    const cfg = mkConfig();
    expect(recoverPinJournal(cfg)).toBeNull();
    expect(readFileSync(cfg, "utf8")).toBe(CONFIG);
  });

  it("WARNS LOUDLY about a malformed journal instead of failing silently", () => {
    // A journal we cannot parse means a pin write may be uncommitted with no
    // way to know what to revert to. Silence there is the worst outcome: the
    // operator never learns the fleet may be pinned to an unproven build.
    const cfg = mkConfig();
    writeFileSync(pinJournalPath(cfg), '{"v":1,"configPath":', "utf8");
    const warnings: string[] = [];
    expect(recoverPinJournal(cfg, { warn: (m) => warnings.push(m) })).toBeNull();
    // Config untouched — a malformed journal must never clobber it.
    expect(readFileSync(cfg, "utf8")).toBe(CONFIG);
    const w = warnings.join("");
    expect(w).toMatch(/rollout pin journal/);
    expect(w).toMatch(/not valid JSON/);
    expect(w).toMatch(/check it host-side/i);
  });

  it("warns and refuses when the journal names a different config", () => {
    const cfg = mkConfig();
    provisionallyPersist(cfg, "v0.19.4");
    const j = JSON.parse(readFileSync(pinJournalPath(cfg), "utf8")) as RolloutPinJournal;
    writeFileSync(
      pinJournalPath(cfg),
      JSON.stringify({ ...j, configPath: "/elsewhere/switchroom.yaml" }),
      "utf8",
    );
    const warnings: string[] = [];
    const out = rollbackPinPersist(cfg, { warn: (m) => warnings.push(m) });
    expect(out.reverted).toBe(false);
    expect(out.error).toBe("configPath mismatch");
    expect(warnings.join("")).toMatch(/Refusing to revert/);
    expect(pinOf(cfg)).toBe("v0.19.4"); // untouched
  });

  it("surfaces a commit that could not clear the journal", () => {
    // A commit whose unlink fails is the input that makes the NEXT boot
    // revert a proven pin — so it must be reported, not swallowed.
    const cfg = mkConfig();
    // A DIRECTORY at the journal path makes unlink fail (EISDIR/EPERM) for
    // every uid including root, so this asserts deterministically rather than
    // depending on the test runner's privileges.
    mkdirSync(pinJournalPath(cfg));
    const err = commitPinPersist(cfg);
    expect(err).toMatch(/FAILED to clear/);
    expect(err).toMatch(/may revert a proven/);
  });

  it("reports (never throws) when the restore write fails", () => {
    const cfg = mkConfig();
    provisionallyPersist(cfg, "v0.19.4");
    const note = recoverPinJournal(cfg, {
      now: afterTimeout(),
      writeConfig: () => {
        throw new Error("EROFS: read-only file system");
      },
    });
    expect(note).toMatch(/FAILED to revert/);
    expect(note).toMatch(/EROFS/);
    // Journal is preserved so a later, working recovery can still act.
    expect(hasPinJournal(cfg)).toBe(true);
    expect(pinOf(cfg)).toBe("v0.19.4");
  });
});
