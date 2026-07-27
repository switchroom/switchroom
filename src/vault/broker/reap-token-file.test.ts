/**
 * Tests for the dead-`.vault-token` reaper.
 *
 * Pre-fix there was no reaper at all: a token whose grant row had vanished
 * (or whose TTL had lapsed) sat on disk forever, so `switchroom doctor`'s
 * orphan probe was a permanent red and the fleet accreted one more orphan per
 * broker-recreate. Every assertion here fails against that (absent) behaviour.
 *
 * Uses real fs against a tmpdir for the outcome assertions that matter
 * (bytes actually gone, inode preserved), and the injection seams only for
 * the error path.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reapUnusableGrantToken } from "./reap-token-file.js";

const TOKEN = "vg_5e1991.deadbeefdeadbeefdeadbeefdeadbeef";

let agentsDir: string;

function writeToken(agent: string, contents: string): string {
  const dir = join(agentsDir, agent);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, ".vault-token");
  writeFileSync(p, contents, { mode: 0o600 });
  return p;
}

beforeEach(() => {
  agentsDir = mkdtempSync(join(tmpdir(), "reap-token-"));
});
afterEach(() => {
  rmSync(agentsDir, { recursive: true, force: true });
});

describe("reapUnusableGrantToken", () => {
  it("truncates the file when the grant row is gone (grant-invalid)", () => {
    const p = writeToken("clerk", TOKEN);
    const out = reapUnusableGrantToken({
      agentsDir,
      agent: "clerk",
      presentedToken: TOKEN,
      reason: "grant-invalid",
    });
    expect(out).toBe("reaped");
    expect(readFileSync(p, "utf8")).toBe("");
  });

  it("truncates the file when the grant expired", () => {
    const p = writeToken("ziggy", TOKEN);
    expect(
      reapUnusableGrantToken({
        agentsDir,
        agent: "ziggy",
        presentedToken: TOKEN,
        reason: "grant-expired",
      }),
    ).toBe("reaped");
    expect(readFileSync(p, "utf8")).toBe("");
  });

  it("preserves the inode (in-place truncate, never rename/unlink)", () => {
    // Load-bearing: the token file is a BARE-FILE bind mount inside the
    // broker container. rename(2) over it is EBUSY — observed live on every
    // mint_grant. Only an in-place O_TRUNC survives, and it keeps the file's
    // agent-UID ownership too.
    const p = writeToken("gymbro", TOKEN);
    const before = statSync(p).ino;
    reapUnusableGrantToken({
      agentsDir,
      agent: "gymbro",
      presentedToken: TOKEN,
      reason: "grant-invalid",
    });
    expect(statSync(p).ino).toBe(before);
  });

  it("KEEPS a live grant that merely doesn't cover this key", () => {
    const p = writeToken("clerk", TOKEN);
    expect(
      reapUnusableGrantToken({
        agentsDir,
        agent: "clerk",
        presentedToken: TOKEN,
        reason: "grant-key-not-allowed",
      }),
    ).toBe("kept:reason-not-reapable");
    expect(readFileSync(p, "utf8")).toBe(TOKEN);
  });

  it("KEEPS a token a concurrent mint already replaced", () => {
    const fresher = "vg_ffffff.0000000000000000000000000000ffff";
    const p = writeToken("clerk", fresher);
    expect(
      reapUnusableGrantToken({
        agentsDir,
        agent: "clerk",
        presentedToken: TOKEN,
        reason: "grant-invalid",
      }),
    ).toBe("kept:superseded");
    expect(readFileSync(p, "utf8")).toBe(fresher);
  });

  it("no-ops without a socket-bound agent identity", () => {
    expect(
      reapUnusableGrantToken({
        agentsDir,
        agent: null,
        presentedToken: TOKEN,
        reason: "grant-invalid",
      }),
    ).toBe("kept:no-agent-identity");
  });

  it("no-ops when there is nothing on disk", () => {
    expect(
      reapUnusableGrantToken({
        agentsDir,
        agent: "never-minted",
        presentedToken: TOKEN,
        reason: "grant-invalid",
      }),
    ).toBe("kept:nothing-on-disk");
  });

  it("no-ops on an already-empty token file", () => {
    writeToken("clerk", "");
    expect(
      reapUnusableGrantToken({
        agentsDir,
        agent: "clerk",
        presentedToken: TOKEN,
        reason: "grant-invalid",
      }),
    ).toBe("kept:nothing-on-disk");
  });

  it("swallows a write failure rather than throwing into the get path", () => {
    expect(
      reapUnusableGrantToken(
        { agentsDir, agent: "clerk", presentedToken: TOKEN, reason: "grant-invalid" },
        {
          readFile: () => TOKEN,
          writeFile: () => {
            throw new Error("EROFS");
          },
        },
      ),
    ).toBe("kept:io-error");
  });
});
