/**
 * Regression test for #1393 / M1 — the CONSUMER mirror write path.
 *
 * BUG (pre-PR1): `mirrorAccountToConsumer` (auth-broker, runs as root
 * with CAP_DAC_OVERRIDE) wrote the effective-account OAuth mirror into
 * `<consumer.mirror_dir>/.credentials.json` with a raw
 * `mkdirSync({recursive}) + atomicWriteFileSync + chownSync(path)` and
 * ZERO symlink guard — unlike the per-agent path which already had
 * `resolveMirrorPathsSafe`. `mirror_dir` is consumer-writable, so a
 * prompt-injected / compromised consumer could pre-plant `mirror_dir`
 * (or a symlinked ancestor of a not-yet-existing `mirror_dir`) as a
 * symlink and have the root broker dereference it on the next
 * fanout → a root-owned credential write at an arbitrary host path,
 * plus a path-based `chownSync` that follows the same symlink.
 *
 * FIX (PR1): both mirror paths share one `safeMirrorWrite` primitive.
 * The consumer resolver `resolveConsumerMirrorPathsSafe` lstat-validates
 * `mirror_dir` (real dir, or absent → created only through a real,
 * non-symlink parent) and the target file (absent or a regular file,
 * never a symlink), then `safeMirrorWrite` re-pins the containing dir's
 * canonical realpath and writes via the O_NOFOLLOW|O_EXCL tempfile +
 * fd-based fchmod/fchown + rename (never a path-based chown). Fail
 * closed: skip that consumer's mirror, log + audit, never crash the
 * fanout (one poisoned consumer must not DoS the fleet).
 *
 * These tests drive the real boot fanout (`broker.start()` →
 * `fanoutAllConsumers`) through a temp HOME, exactly like
 * `server-mirror-symlink-guard.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// fchown swallow test: the broker runs as root in some CI/dev contexts
// (fchown succeeds) and non-root in others (fchown EPERM). To exercise
// the swallow path deterministically we wrap `fchownSync` behind a hoisted
// flag and force EPERM only for that one test. Everything else delegates
// to the real fs.
const mockState = vi.hoisted(() => ({ throwEpermOnFchown: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    fchownSync: (fd: number, uid: number, gid: number) => {
      if (mockState.throwEpermOnFchown) {
        const err = new Error("EPERM: operation not permitted, fchown");
        (err as NodeJS.ErrnoException).code = "EPERM";
        throw err;
      }
      return actual.fchownSync(fd, uid, gid);
    },
  };
});

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthBroker } from "./server.js";
import { accountCredentialsPath, accountDir } from "../account-store.js";
import type { SwitchroomConfig } from "../../config/schema.js";

interface Harness {
  tmp: string;
  home: string;
  agentsDir: string;
  stateDir: string;
  socketRoot: string;
}

let harnesses: Harness[] = [];

function makeHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "auth-broker-consumer-symlink-guard-test-"));
  const home = join(tmp, "home");
  const agentsDir = join(home, ".switchroom", "agents");
  const stateDir = join(home, ".switchroom", "state", "auth-broker");
  const socketRoot = join(tmp, "run", "switchroom", "auth-broker");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  const h: Harness = { tmp, home, agentsDir, stateDir, socketRoot };
  harnesses.push(h);
  return h;
}

afterEach(() => {
  mockState.throwEpermOnFchown = false;
  for (const h of harnesses) {
    try {
      rmSync(h.tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  harnesses = [];
});

function makeConfig(h: Harness, consumers: object[]): SwitchroomConfig {
  return {
    switchroom: { version: 1, agents_dir: h.agentsDir },
    telegram: {},
    agents: {},
    auth: { active: "default", consumers },
  } as unknown as SwitchroomConfig;
}

function writeSourceCreds(h: Harness, label: string): void {
  mkdirSync(accountDir(label, h.home), { recursive: true });
  writeFileSync(
    accountCredentialsPath(label, h.home),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "at-default",
        refreshToken: "rt-default",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    }),
  );
}

function readAudit(h: Harness): string {
  const p = join(h.stateDir, "audit.jsonl");
  return existsSync(p) ? readFileSync(p, "utf-8") : "";
}

async function bootFanout(h: Harness, consumers: object[]): Promise<void> {
  const broker = new AuthBroker(makeConfig(h, consumers), {
    home: h.home,
    stateDir: h.stateDir,
    socketRoot: h.socketRoot,
    disableRefreshLoop: true,
  });
  await broker.start(); // boot fanout (fanoutAllConsumers) fires here
  broker.stop();
}

describe("AuthBroker — symlink-guarded per-consumer mirror (#1393 / M1)", () => {
  it("REFUSES to write through a pre-planted `mirror_dir` symlink and keeps mirroring other consumers", async () => {
    const h = makeHarness();
    writeSourceCreds(h, "default");

    // Poisoned consumer: `mirror_dir` itself is a symlink to an
    // attacker-chosen escape directory.
    const escapeTarget = join(h.tmp, "escape-target");
    mkdirSync(escapeTarget, { recursive: true });
    const evilDir = join(h.tmp, "evil-mirror");
    symlinkSync(escapeTarget, evilDir);

    // Legit consumer: a real (not-yet-existing) mirror dir the broker
    // safely creates.
    const goodDir = join(h.tmp, "good-mirror");

    await bootFanout(h, [
      { name: "evil", uid: 0, mirror_dir: evilDir },
      { name: "good", uid: 0, mirror_dir: goodDir },
    ]);

    // The broker must NOT have dereferenced the symlink into the escape.
    expect(existsSync(join(escapeTarget, ".credentials.json"))).toBe(false);
    // The symlink is left intact (not replaced by a real dir/file).
    expect(lstatSync(evilDir).isSymbolicLink()).toBe(true);

    // The refusal is audited as a structured security event.
    const audit = readAudit(h);
    expect(audit).toContain('"op":"mirror-symlink-refused"');
    expect(audit).toContain('"peer":"consumer:evil"');
    expect(audit).toContain("mirror_dir:is-a-symlink");

    // The legit consumer still got a correct mirror — no fleet DoS.
    const good = JSON.parse(readFileSync(join(goodDir, ".credentials.json"), "utf-8"));
    expect(good.claudeAiOauth.accessToken).toBe("at-default");
  });

  it("REFUSES a pre-planted `.credentials.json` symlink pointing outside; the outside file is untouched", async () => {
    const h = makeHarness();
    writeSourceCreds(h, "default");

    const mirrorDir = join(h.tmp, "consumer-mirror");
    mkdirSync(mirrorDir, { recursive: true });
    const escapeFile = join(h.tmp, "escape-file");
    writeFileSync(escapeFile, "original-secret");
    symlinkSync(escapeFile, join(mirrorDir, ".credentials.json"));

    await bootFanout(h, [{ name: "c1", uid: 0, mirror_dir: mirrorDir }]);

    // The outside file must not have been overwritten with creds.
    expect(readFileSync(escapeFile, "utf-8")).toBe("original-secret");
    const audit = readAudit(h);
    expect(audit).toContain('"op":"mirror-symlink-refused"');
    expect(audit).toContain(".credentials.json:is-a-symlink");
  });

  it("REFUSES to CREATE a not-yet-existing `mirror_dir` through a symlinked ancestor", async () => {
    const h = makeHarness();
    writeSourceCreds(h, "default");

    // A symlinked PARENT of a not-yet-existing mirror_dir. Current
    // (pre-fix) code `mkdirSync({recursive})` would traverse the symlink
    // and create + write into the escape target.
    const escapeTarget = join(h.tmp, "escape-parent");
    mkdirSync(escapeTarget, { recursive: true });
    const symlinkedParent = join(h.tmp, "planted-parent");
    symlinkSync(escapeTarget, symlinkedParent);
    const mirrorDir = join(symlinkedParent, "mirror"); // does not exist yet

    await bootFanout(h, [{ name: "c1", uid: 0, mirror_dir: mirrorDir }]);

    // No escape write, and the leaf was never created under the escape.
    expect(existsSync(join(escapeTarget, "mirror", ".credentials.json"))).toBe(false);
    expect(existsSync(join(escapeTarget, "mirror"))).toBe(false);
    const audit = readAudit(h);
    expect(audit).toContain('"op":"mirror-symlink-refused"');
    expect(audit).toContain("mirror_dir-parent:is-a-symlink");
  });

  it("happy path: creates the mirror, mode 0600, content enriched, canonical (non-symlink) path", async () => {
    const h = makeHarness();
    writeSourceCreds(h, "default");

    const consumerUid = process.getuid && process.getuid() === 0 ? 12345 : (process.getuid?.() ?? 0);
    const mirrorDir = join(h.tmp, "consumer-mirror");

    await bootFanout(h, [{ name: "c1", uid: consumerUid, mirror_dir: mirrorDir }]);

    const target = join(mirrorDir, ".credentials.json");
    expect(existsSync(target)).toBe(true);
    // Real file at the expected path — never a symlink.
    expect(realpathSync(target)).toBe(target);
    const st = lstatSync(target);
    expect(st.isFile()).toBe(true);
    // Exact 0600 regardless of umask (fchmod on the fd).
    expect(st.mode & 0o777).toBe(0o600);
    // Ownership is only assertable when the broker actually holds
    // CAP_CHOWN (running as root); otherwise fchown EPERM is swallowed.
    if (process.getuid && process.getuid() === 0) {
      expect(st.uid).toBe(consumerUid);
    }

    // enrichMirrorContent is applied (defense-in-depth): the mirror is
    // valid JSON carrying the source access token.
    const mirror = JSON.parse(readFileSync(target, "utf-8"));
    expect(mirror.claudeAiOauth.accessToken).toBe("at-default");
    expect(mirror.claudeAiOauth.refreshToken).toBe("rt-default");

    // No spurious refusal audited on the happy path.
    expect(readAudit(h)).not.toContain("mirror-symlink-refused");
  });

  it("fchown EPERM (no CAP_CHOWN) does NOT abort the write — the mirror still lands 0600", async () => {
    const h = makeHarness();
    writeSourceCreds(h, "default");

    const mirrorDir = join(h.tmp, "consumer-mirror");
    mockState.throwEpermOnFchown = true;

    await bootFanout(h, [{ name: "c1", uid: 4321, mirror_dir: mirrorDir }]);

    const target = join(mirrorDir, ".credentials.json");
    // The write completed despite the fchown EPERM.
    expect(existsSync(target)).toBe(true);
    const st = lstatSync(target);
    expect(st.isFile()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    const mirror = JSON.parse(readFileSync(target, "utf-8"));
    expect(mirror.claudeAiOauth.accessToken).toBe("at-default");
    // Not a security refusal — the swallow path must not audit one.
    expect(readAudit(h)).not.toContain("mirror-symlink-refused");
  });
});
