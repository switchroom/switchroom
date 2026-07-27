/**
 * #3751 — `mint_grant`'s `.vault-token` publish must be an IN-PLACE
 * `O_TRUNC` write, and must throw when it does not land.
 *
 * These assert real outcomes on real files in a tmpdir:
 *   - the bytes are actually on disk afterwards;
 *   - the INODE is preserved across a rewrite (the property that makes the
 *     write survive a bare-file bind mount and keeps agent-UID ownership) —
 *     the tmp+rename implementation this replaces fails this assertion;
 *   - no tmp sibling is left behind / created at any point;
 *   - a genuine fs failure (EISDIR) and a silent short write both surface as
 *     a thrown `TokenFileWriteError`, never a swallowed log line.
 *
 * Hermetic: everything happens under `mkdtempSync`; `os.homedir()` is never
 * consulted (see scripts/check-vault-test-hermeticity.mjs).
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeAgentTokenFile, TokenFileWriteError } from "./write-token-file.js";

const AGENT = "testagent";
const TOKEN_A = "vg_aaaaaa.11111111111111111111111111111111";
const TOKEN_B = "vg_bbbbbb.22222222222222222222222222222222";

describe("writeAgentTokenFile (#3751)", () => {
  let agentsDir: string;
  let tokenPath: string;

  beforeEach(() => {
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-token-write-"));
    tokenPath = path.join(agentsDir, AGENT, ".vault-token");
  });

  afterEach(() => {
    fs.rmSync(agentsDir, { recursive: true, force: true });
  });

  it("writes the token bytes to disk, creating the agent dir", () => {
    const res = writeAgentTokenFile({ agentsDir, agent: AGENT, token: TOKEN_A });

    expect(res.tokenPath).toBe(tokenPath);
    expect(fs.readFileSync(tokenPath, "utf8")).toBe(TOKEN_A);
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it("preserves the inode when the file already exists (the bind-mount property)", () => {
    // `apply` pre-creates the mount source; the broker only ever rewrites it.
    fs.mkdirSync(path.join(agentsDir, AGENT), { recursive: true });
    fs.writeFileSync(tokenPath, TOKEN_A, { mode: 0o600 });
    const before = fs.statSync(tokenPath);

    writeAgentTokenFile({ agentsDir, agent: AGENT, token: TOKEN_B });

    const after = fs.statSync(tokenPath);
    // The load-bearing assertion. A tmp+rename publish installs a NEW inode
    // here (and would fail outright with EBUSY over a real bind mount).
    expect(after.ino).toBe(before.ino);
    expect(after.dev).toBe(before.dev);
    expect(fs.readFileSync(tokenPath, "utf8")).toBe(TOKEN_B);
  });

  it("preserves the existing owner/mode on rewrite — no chown is attempted", () => {
    fs.mkdirSync(path.join(agentsDir, AGENT), { recursive: true });
    // A mode the writer never sets itself, so "0640 afterwards" can only
    // mean the original inode survived (writeFileSync's `mode` applies on
    // creation only).
    fs.writeFileSync(tokenPath, TOKEN_A, { mode: 0o640 });
    const before = fs.statSync(tokenPath);

    let chownCalls = 0;
    const res = writeAgentTokenFile(
      { agentsDir, agent: AGENT, token: TOKEN_B },
      { chown: () => { chownCalls += 1; } },
    );

    const after = fs.statSync(tokenPath);
    expect(after.mode & 0o777).toBe(0o640);
    expect(after.uid).toBe(before.uid);
    expect(after.gid).toBe(before.gid);
    expect(chownCalls).toBe(0);
    expect(res.chownWarning).toBeNull();
  });

  it("chowns to the agent UID only when it had to CREATE the file", () => {
    const chowned: Array<[string, number, number]> = [];
    const res = writeAgentTokenFile(
      { agentsDir, agent: AGENT, token: TOKEN_A },
      { chown: (p, uid, gid) => { chowned.push([p, uid, gid]); }, agentUid: () => 4242 },
    );

    expect(chowned).toEqual([[tokenPath, 4242, 4242]]);
    expect(res.chownWarning).toBeNull();
  });

  it("degrades a create-path chown failure to a warning, not a throw", () => {
    const res = writeAgentTokenFile(
      { agentsDir, agent: AGENT, token: TOKEN_A },
      { chown: () => { throw new Error("EPERM: operation not permitted"); } },
    );

    // The bytes still landed — the token is usable over IPC — so this must
    // not fail the mint.
    expect(fs.readFileSync(tokenPath, "utf8")).toBe(TOKEN_A);
    expect(res.chownWarning).toContain("EPERM");
  });

  it("never creates a tmp sibling (regression guard against tmp+rename)", () => {
    const dir = path.join(agentsDir, AGENT);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tokenPath, TOKEN_A, { mode: 0o600 });

    writeAgentTokenFile({ agentsDir, agent: AGENT, token: TOKEN_B });

    expect(fs.readdirSync(dir)).toEqual([".vault-token"]);
  });

  it("throws TokenFileWriteError on a real fs failure (EISDIR)", () => {
    // A directory at the token path is a genuine, un-mocked write failure —
    // the same class as the EBUSY the live broker hits on a bind mount.
    fs.mkdirSync(tokenPath, { recursive: true });

    expect(() => writeAgentTokenFile({ agentsDir, agent: AGENT, token: TOKEN_A })).toThrow(
      TokenFileWriteError,
    );
  });

  it("throws when the write silently does not land (read-back verification)", () => {
    // Models the exact #3751 failure mode: the write path reports success
    // but the bytes are not what the caller believes are on disk.
    fs.mkdirSync(path.join(agentsDir, AGENT), { recursive: true });
    fs.writeFileSync(tokenPath, TOKEN_A, { mode: 0o600 });

    expect(() =>
      writeAgentTokenFile(
        { agentsDir, agent: AGENT, token: TOKEN_B },
        { writeFile: () => { /* pretend it worked; write nothing */ } },
      ),
    ).toThrow(/did not verify after write/);
  });

  it("throws when the agent dir cannot be created", () => {
    // agentsDir itself is a file → mkdir of the child fails with ENOTDIR.
    const filePath = path.join(agentsDir, "not-a-dir");
    fs.writeFileSync(filePath, "x");

    expect(() =>
      writeAgentTokenFile({ agentsDir: filePath, agent: AGENT, token: TOKEN_A }),
    ).toThrow(TokenFileWriteError);
  });
});
