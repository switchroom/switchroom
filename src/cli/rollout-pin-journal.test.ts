/**
 * Rollout pin journal — the two-phase commit that keeps a durable
 * `release.pin` from outliving a roll that failed.
 *
 * These assert OUTCOMES on a real (tmpdir) config file: after each scenario,
 * what does `release.pin` actually say, and what ELSE in the config survived?
 * A test that only checked "the journal function was called" would not have
 * failed on the original bug.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  chmodSync,
  statSync,
  mkdirSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * `pinJournalDir` has THREE precedence rules and rule 1
 * (`SWITCHROOM_PIN_JOURNAL_DIR`) short-circuits the other two. Most tests here
 * are about journal SEMANTICS, not about where the directory came from, so
 * they take rule 1 via the `beforeEach` below.
 *
 * The tests that are specifically about *where the journal lives* — the ones
 * that assert "never beside the config", which is THE production defect — must
 * NOT take rule 1, or they assert nothing: with the env var set they pass
 * verbatim against the pre-fix `dirname(resolve(configPath))` implementation.
 * They delete the env var and drive rule 3 instead, which needs `homedir()`
 * pointed somewhere hermetic. Hence this mock: `fakeHome` is null for every
 * test that doesn't opt in, so the real `homedir()` is used and nothing else
 * changes shape.
 */
let fakeHome: string | null = null;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome ?? actual.homedir() };
});

/**
 * Opt a test out of rule 1 and into rules 2/3: clear the override and give
 * `homedir()` a tmpdir. Returns the durable state dir rule 3 will land on.
 */
function useFakeHomeStateDir(): string {
  delete process.env.SWITCHROOM_PIN_JOURNAL_DIR;
  fakeHome = mkdtempSync(join(tmpdir(), "pin-journal-home-"));
  return join(fakeHome, ".switchroom");
}
import {
  pinJournalDir,
  pinJournalPath,
  hasPinJournal,
  readPinJournal,
  beginPinPersist,
  commitPinPersist,
  rollbackPinPersist,
  recoverPinJournal,
  isPidAlive,
  isJournalWriterAlive,
  isJournalFresh,
  PIN_JOURNAL_MAX_AGE_MS,
  type RolloutPinJournal,
} from "./rollout-pin-journal.js";
import { setReleasePinInConfig, getReleasePinFromConfig } from "./release-yaml.js";

const CONFIG = `telegram:
  bot_token: x # the fleet's bot credential
release:
  pin: v0.19.3 # 2026-07-01: rolled by switchroom rollout
agents:
  clerk:
    extends: default
`;

/**
 * Stand-in for the DURABLE switchroom state dir (`~/.switchroom` on the host
 * shell, the `/host-home/.switchroom` bind inside hostd). Every test points the
 * journal at a tmpdir so the suite can never touch a real state dir — and so
 * the "journal does NOT live beside the config" property is assertable.
 */
let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "pin-journal-state-"));
  process.env.SWITCHROOM_PIN_JOURNAL_DIR = stateDir;
});

afterEach(() => {
  delete process.env.SWITCHROOM_PIN_JOURNAL_DIR;
  fakeHome = null;
});

function mkConfig(text = CONFIG): string {
  const dir = mkdtempSync(join(tmpdir(), "pin-journal-"));
  const p = join(dir, "switchroom.yaml");
  writeFileSync(p, text, "utf8");
  return p;
}

/**
 * ARRANGE a config into the mid-persist state: journal on disk, new pin
 * written. This is a fixture, NOT a stand-in for production `persistPin` —
 * nothing here asserts that `rollout.ts` wires the two calls in this order, and
 * a test that read it that way would be a false green. That wiring is asserted
 * against the real `createRolloutDeps` in rollout.test.ts ("createRolloutDeps'
 * persistPin JOURNALS to disk before it writes the pin").
 */
function provisionallyPersist(configPath: string, pin: string): void {
  const before = readFileSync(configPath, "utf8");
  beginPinPersist(configPath, pin);
  writeFileSync(configPath, setReleasePinInConfig(before, pin), "utf8");
}

/** A start-time probe reporting a process that began AFTER `journal.at`. */
function startedAfterJournal(journal: RolloutPinJournal): () => number {
  return () => Date.parse(journal.at) + 60_000;
}

function pinOf(configPath: string): string | undefined {
  return getReleasePinFromConfig(readFileSync(configPath, "utf8"));
}

/** A clock far enough past the journal's `at` that it reads as abandoned. */
function afterTimeout(): number {
  return Date.now() + PIN_JOURNAL_MAX_AGE_MS + 1;
}

describe("pin journal — the journal must outlive the container that wrote it", () => {
  it("writes the journal into the DURABLE state dir, never beside the config", () => {
    // THE production defect: the journal used to be `dirname(configPath)`.
    // Inside hostd the config is a SINGLE-FILE bind mount
    // (`~/.switchroom/switchroom.yaml` → `/state/config/switchroom.yaml`), so
    // `/state/config` the directory is the container's writable overlay. The
    // journal landed somewhere that exists nowhere on the host and dies with
    // the container — making hostd-boot crash recovery dead code on exactly
    // the path this module targets.
    //
    // Rule 1 (`SWITCHROOM_PIN_JOURNAL_DIR`) is deliberately NOT used here: it
    // short-circuits `pinJournalDir` before the rules that ARE the fix, so
    // with it set this test passes verbatim against the pre-fix
    // `dirname(resolve(configPath))`. Rule 3 (`<homedir()>/.switchroom`) is
    // what hostd actually takes, so that is what is exercised.
    const durable = useFakeHomeStateDir();
    const cfg = mkConfig(); // a plain tmpdir — NOT named `.switchroom`, so rule 2 misses
    provisionallyPersist(cfg, "v0.19.4");

    const p = pinJournalPath(cfg);
    expect(dirname(p)).toBe(durable); // the durable, directory-bind-mounted dir
    expect(dirname(p)).not.toBe(dirname(cfg)); // NOT the config's (ephemeral) dir
    expect(existsSync(p)).toBe(true);
    // Nothing at all was dropped next to the config.
    expect(readdirSync(dirname(cfg))).toEqual(["switchroom.yaml"]);
  });

  it("takes the config's own dir ONLY when it is itself a .switchroom dir", () => {
    // Rule 2, the host-shell case. `~/.switchroom/switchroom.yaml` — here the
    // config's directory IS the durable state dir, so co-locating is correct
    // and sudo's `HOME` policy stops mattering. This is the one case where
    // "beside the config" is the right answer, and pinning it is what stops a
    // future rewrite from collapsing rules 2 and 3 into "always homedir".
    const durable = useFakeHomeStateDir();
    const opHome = mkdtempSync(join(tmpdir(), "pin-journal-ophome-"));
    const opState = join(opHome, ".switchroom");
    mkdirSync(opState);
    const cfg = join(opState, "switchroom.yaml");
    writeFileSync(cfg, CONFIG, "utf8");

    provisionallyPersist(cfg, "v0.19.4");

    expect(dirname(pinJournalPath(cfg))).toBe(opState);
    // …and NOT the `homedir()` fallback, which is a different directory here.
    expect(dirname(pinJournalPath(cfg))).not.toBe(durable);
    expect(existsSync(pinJournalPath(cfg))).toBe(true);
  });

  it("recovery still finds the journal after a container recreate wipes the config's directory", () => {
    // The failure end-to-end. Inside hostd the config is a SINGLE-FILE bind
    // mount, so `/state/config/switchroom.yaml` survives a recreate but
    // `/state/config` the DIRECTORY is a fresh overlay: the file is remounted,
    // anything else written there is gone. Modelled with a symlink into a
    // separate "container view" directory that gets emptied.
    //
    // Rule 1 is cleared for the same reason as the test above: with the env
    // override in place the journal lands in a tmpdir that the simulated
    // recreate never touches, so the scenario passes against the very bug it
    // is written to catch. Rule 3 is the one hostd takes.
    useFakeHomeStateDir();
    const real = mkConfig();
    const viewDir = mkdtempSync(join(tmpdir(), "pin-journal-view-"));
    const viewPath = join(viewDir, "switchroom.yaml");
    symlinkSync(real, viewPath); // the bind-mounted file

    provisionallyPersist(viewPath, "v0.19.4");
    expect(pinOf(real)).toBe("v0.19.4");

    // …the container is recreated: the overlay is discarded, only the
    // bind-mounted file is remounted.
    for (const entry of readdirSync(viewDir)) {
      if (entry !== "switchroom.yaml") rmSync(join(viewDir, entry), { recursive: true });
    }
    expect(existsSync(viewPath)).toBe(true);

    // A fresh hostd boots and runs recovery against the same config path.
    const note = recoverPinJournal(viewPath, { now: afterTimeout() });

    expect(note).toMatch(/reverted an UNCOMMITTED release.pin=v0\.19\.4/);
    // THE outcome: the durable pin names the last PROVEN build, so no later
    // reconcile can converge the fleet onto the one that never proved out.
    expect(pinOf(real)).toBe("v0.19.3");
  });

  it("creates the state dir when it does not exist yet", () => {
    const fresh = join(stateDir, "nested", "state");
    process.env.SWITCHROOM_PIN_JOURNAL_DIR = fresh;
    const cfg = mkConfig();
    provisionallyPersist(cfg, "v0.19.4");
    expect(existsSync(pinJournalPath(cfg))).toBe(true);
  });

  it("falls back to <home>/.switchroom when nothing overrides it", () => {
    delete process.env.SWITCHROOM_PIN_JOURNAL_DIR;
    // Not `dirname(configPath)` — the whole point. `homedir()` is the operator
    // home on the host shell and `/host-home` inside hostd (whose compose pins
    // HOME), so both resolve onto the same durable directory bind mount.
    expect(pinJournalDir().endsWith("/.switchroom")).toBe(true);
    expect(dirname(pinJournalPath("/state/config/switchroom.yaml"))).toBe(pinJournalDir());
  });
});

describe("pin journal — two writers must not share one journal", () => {
  it("keys the journal by config path, so hostd and a host shell stay separate", () => {
    // Moving BOTH writers into one durable directory is what creates this
    // hazard: hostd rolls against `/state/config/switchroom.yaml` while an
    // operator's `sudo switchroom rollout` rolls against
    // `~/.switchroom/switchroom.yaml`. Same file, different paths.
    const hostd = pinJournalPath("/state/config/switchroom.yaml");
    const shell = pinJournalPath("/home/op/.switchroom/switchroom.yaml");
    expect(dirname(hostd)).toBe(dirname(shell)); // same durable directory…
    expect(hostd).not.toBe(shell); // …different journals.
  });

  it("a failing roll does NOT revert to the other roll's priorPin", () => {
    // THE damage a shared journal would do, asserted as an outcome. Roll A
    // (hostd view) writes v2 over v1; roll B (host-shell view of the SAME
    // file) then writes v3 over v2. With one shared journal, A's failure
    // reverts to B's recorded priorPin (v2) and deletes B's journal, so B
    // commits a no-op and reports success on a pin nobody proved.
    const dir = mkdtempSync(join(tmpdir(), "pin-journal-two-"));
    const real = join(dir, "switchroom.yaml");
    writeFileSync(real, CONFIG.replace("v0.19.3", "v1"), "utf8");
    // A second path onto the SAME file — the symlink stands in for hostd's
    // single-file bind mount of `~/.switchroom/switchroom.yaml` onto
    // `/state/config/switchroom.yaml`.
    const asShell = real;
    const asHostd = join(dir, "state-config.yaml");
    symlinkSync(real, asHostd);

    beginPinPersist(asHostd, "v2");
    writeFileSync(real, setReleasePinInConfig(readFileSync(real, "utf8"), "v2"), "utf8");
    beginPinPersist(asShell, "v3");
    writeFileSync(real, setReleasePinInConfig(readFileSync(real, "utf8"), "v3"), "utf8");

    // Roll A fails and reverts. It must restore ITS OWN prior pin (v1)…
    expect(rollbackPinPersist(asHostd).priorPin).toBe("v1");
    // …and must not have destroyed roll B's journal.
    expect(hasPinJournal(asShell)).toBe(true);
    expect(readPinJournal(asShell)?.priorPin).toBe("v2");
  });

  it("REFUSES to open a second journal while the first writer is alive", () => {
    // Per-writer keying separates hostd from a host shell, but two rolls
    // against the SAME config path would still collide. This is the exclusive
    // gate: the second begin throws, so the caller never writes an
    // unjournalled (or mis-journalled) provisional pin.
    const cfg = mkConfig();
    provisionallyPersist(cfg, "v0.19.4"); // journal pid = this live process

    expect(() => beginPinPersist(cfg, "v0.19.5")).toThrow(/held by a LIVE roll/);
    // The first roll's journal is intact, so ITS revert still works.
    expect(readPinJournal(cfg)?.pin).toBe("v0.19.4");
    expect(readPinJournal(cfg)?.priorPin).toBe("v0.19.3");
  });

  it("does NOT exclude the hostd/host-shell pair — that is the fleet lock's job", () => {
    // The limitation, pinned so the module header cannot drift back into
    // claiming "two rolls against the same config path cannot interleave".
    // The gate is keyed by journal path, i.e. by config-path STRING. The only
    // two contending writers in this system reach the SAME physical file
    // through two different strings (`cli/hostd.ts` bind-mounts
    // `~/.switchroom/switchroom.yaml` onto `/state/config/switchroom.yaml`), so
    // both begins succeed and the gate never fires between them.
    const dir = mkdtempSync(join(tmpdir(), "pin-journal-pair-"));
    const asShell = join(dir, "switchroom.yaml");
    writeFileSync(asShell, CONFIG, "utf8");
    const asHostd = join(dir, "state-config.yaml");
    symlinkSync(asShell, asHostd);

    const a = beginPinPersist(asShell, "v0.19.4"); // live writer: this process
    // Same file, other path. If exclusivity spanned the pair this would throw.
    expect(() => beginPinPersist(asHostd, "v0.19.5")).not.toThrow();
    // Two live journals against one file, each intact and each correct about
    // its OWN write — which is what keeps the dangerous failure (a cross-roll
    // revert) impossible even though the benign one is not prevented here.
    expect(readPinJournal(asShell)?.pin).toBe(a.pin);
    expect(readPinJournal(asHostd)?.pin).toBe("v0.19.5");
    expect(pinJournalPath(asShell)).not.toBe(pinJournalPath(asHostd));
  });

  it("overwrites (with a warning) a journal whose writer is gone", () => {
    // The other half: a crashed predecessor must not block every future roll.
    const cfg = mkConfig();
    provisionallyPersist(cfg, "v0.19.4");
    const warnings: string[] = [];
    // Journal aged past the cutoff = abandoned.
    const j = beginPinPersist(cfg, "v0.19.5", {
      warn: (m) => warnings.push(m),
      now: afterTimeout(),
    });
    expect(j.pin).toBe("v0.19.5");
    expect(warnings.join("")).toMatch(/overwriting an ABANDONED journal/);
    expect(readPinJournal(cfg)?.pin).toBe("v0.19.5");
  });
});

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
    // Every other key AND its comments survive the targeted edit. Asserting
    // the keys alone would pass under a comment-stripping rewrite
    // (`yaml.stringify(obj)`), which is the failure mode this module bans, so
    // the unrelated comment is asserted byte-for-byte…
    const text = readFileSync(cfg, "utf8");
    expect(text).toContain("bot_token: x # the fleet's bot credential");
    expect(text).toContain("clerk:");
    // …and nothing outside the `release:` block moved at all.
    const untouched = (s: string) =>
      s.split("\n").filter((l) => !/^\s*pin:/.test(l)).join("\n");
    expect(untouched(text)).toBe(untouched(CONFIG));
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
    // The roll SYNTHESIZED the whole `release:` block, so the revert removes
    // it again and the file is byte-identical to the pre-roll one.
    expect(readFileSync(cfg, "utf8")).not.toMatch(/release:/);
    expect(readFileSync(cfg, "utf8")).toBe(unpinned);
  });

  it("does NOT destroy a documented `release:` block added during the roll", () => {
    // The window this whole module exists for: the pin lands after the canary
    // and the remaining agents take minutes. If an operator (or an approved
    // config_propose_edit) adds a DOCUMENTED `release:` block in that window,
    // the revert deletes the `pin` key it wrote — and must leave their
    // documentation alone. Dropping the now-empty husk would take the
    // `commentBefore` block with it.
    const unpinned = `telegram:\n  bot_token: x\nagents:\n  clerk:\n    extends: default\n`;
    const cfg = mkConfig(unpinned);
    provisionallyPersist(cfg, "v0.19.4");
    // …the operator documents the block mid-roll.
    writeFileSync(
      cfg,
      readFileSync(cfg, "utf8").replace(
        /^release:$/m,
        "# Release channel / pin.\n# `channel` and `pin` are mutually exclusive.\n# Set by `switchroom rollout --pin`.\nrelease:",
      ),
      "utf8",
    );
    const commentLines = (s: string) => s.split("\n").filter((l) => l.trim().startsWith("#"));
    expect(commentLines(readFileSync(cfg, "utf8"))).toHaveLength(3);

    expect(rollbackPinPersist(cfg).reverted).toBe(true);

    const text = readFileSync(cfg, "utf8");
    expect(pinOf(cfg)).toBeUndefined(); // the pin IS reverted…
    // …and every comment line survives, byte for byte.
    expect(commentLines(text)).toEqual([
      "# Release channel / pin.",
      "# `channel` and `pin` are mutually exclusive.",
      "# Set by `switchroom rollout --pin`.",
    ]);
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

  it("reverts a journal whose pid was REUSED by a container recreate", () => {
    // THE systematic false-alive. Container PID namespaces restart at 1, so a
    // roll inside hostd records a small pid (tens); when hostd is recreated —
    // the primary recovery trigger — the new process tree occupies the same
    // low range, `kill(pid, 0)` succeeds against an unrelated process, and a
    // bare liveness probe declines recovery essentially always. The start-time
    // discriminator is what tells the two apart: a process that started AFTER
    // the journal was written cannot be the journal's writer.
    const cfg = mkConfig();
    provisionallyPersist(cfg, "v0.19.4");
    const journal = readPinJournal(cfg)!;
    // pid IS alive (it's this process) — only the start time says otherwise.
    expect(isPidAlive(journal.pid)).toBe(true);

    const note = recoverPinJournal(cfg, { startTimeMs: startedAfterJournal(journal) });

    // Reverted WITHOUT waiting out the 15-minute age backstop.
    expect(note).toMatch(/reverted an UNCOMMITTED release.pin=v0\.19\.4/);
    expect(pinOf(cfg)).toBe("v0.19.3");
    expect(hasPinJournal(cfg)).toBe(false);
  });

  it("reverts once the journal ages past the cutoff, even if the writer looks alive", () => {
    // The residual backstop, for the cases start time cannot resolve
    // (non-Linux, unreadable /proc) — both of which are treated conservatively
    // as alive, so age is the only thing left.
    const cfg = mkConfig();
    provisionallyPersist(cfg, "v0.19.4");
    const note = recoverPinJournal(cfg, {
      now: afterTimeout(),
      startTimeMs: () => null, // "cannot tell" → conservatively alive
    });
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

  it("isJournalWriterAlive is conservative when it cannot decide", () => {
    const j: RolloutPinJournal = {
      v: 1,
      configPath: "/c",
      pin: "v1",
      pid: process.pid,
      at: new Date().toISOString(),
    };
    // Started before the journal → the writer.
    expect(isJournalWriterAlive(j, () => Date.parse(j.at) - 1000)).toBe(true);
    // Started after → pid reuse / a recreated container's tree.
    expect(isJournalWriterAlive(j, () => Date.parse(j.at) + 1000)).toBe(false);
    // Unknown start time → conservatively alive (age is the backstop).
    expect(isJournalWriterAlive(j, () => null)).toBe(true);
    // Undateable journal → conservatively alive.
    expect(
      isJournalWriterAlive({ ...j, at: "not-a-date" }, () => Date.now()),
    ).toBe(true);
    // A dead pid short-circuits before start time is consulted.
    expect(isJournalWriterAlive({ ...j, pid: 0x3fffffff }, () => 0)).toBe(false);
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
