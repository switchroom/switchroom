/**
 * Idempotent-apply write skipping (hostd reconcile fix).
 *
 * Background: per-agent state dirs are mode 0700 owned by per-agent
 * UIDs (v0.7+ docker model). A `switchroom apply` that rewrites
 * byte-identical scaffold files needs write access into EVERY agent's
 * dir even when nothing changed — which made hostd's in-container
 * reconcile fail fleet-wide ("Scaffolded 0/N agents … cannot write
 * without privilege escalation") after a single-agent config edit.
 *
 * The fix: content is compared before writing and identical content is
 * skipped, so an idempotent apply performs zero write syscalls for
 * untouched agents. These tests pin the two primitives:
 *   - writeFileSyncIfChanged — skip byte-identical file writes
 *   - dirContentEquals — skip the vendored-plugin rm+recopy when the
 *     deployed tree already matches (incl. the post-copy settings.json
 *     override via topLevelOverrides)
 */

import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeFileSyncIfChanged,
  dirContentEquals,
} from "../src/agents/scaffold.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "sr-idempotent-"));
}

describe("writeFileSyncIfChanged", () => {
  it("writes a new file and reports true", () => {
    const dir = tmp();
    const p = join(dir, "a.txt");
    expect(writeFileSyncIfChanged(p, "hello\n")).toBe(true);
    expect(readFileSync(p, "utf-8")).toBe("hello\n");
  });

  it("skips (returns false, no write) when content is byte-identical", () => {
    const dir = tmp();
    const p = join(dir, "a.txt");
    writeFileSync(p, "same\n", "utf-8");
    const past = new Date(Date.now() - 60_000);
    utimesSync(p, past, past);
    const mtimeBefore = statSync(p).mtimeMs;
    expect(writeFileSyncIfChanged(p, "same\n")).toBe(false);
    // No write syscall happened — mtime untouched.
    expect(statSync(p).mtimeMs).toBe(mtimeBefore);
  });

  it("does not need write permission when content is identical (the hostd case)", () => {
    const dir = tmp();
    const p = join(dir, "start.sh");
    writeFileSync(p, "#!/bin/sh\n", "utf-8");
    chmodSync(p, 0o400); // read-only — a write attempt would EACCES for non-root
    try {
      // Must NOT throw: identical content short-circuits before any write.
      expect(writeFileSyncIfChanged(p, "#!/bin/sh\n")).toBe(false);
    } finally {
      chmodSync(p, 0o600);
    }
  });

  it("rewrites when content differs and reports true", () => {
    const dir = tmp();
    const p = join(dir, "a.txt");
    writeFileSync(p, "old\n", "utf-8");
    expect(writeFileSyncIfChanged(p, "new\n")).toBe(true);
    expect(readFileSync(p, "utf-8")).toBe("new\n");
  });

  it("honours the mode option on fresh writes", () => {
    const dir = tmp();
    const p = join(dir, "secret.json");
    writeFileSyncIfChanged(p, "{}\n", 0o600);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});

describe("dirContentEquals", () => {
  function seedTree(root: string): void {
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(join(root, "settings.json"), '{"a":1}\n', "utf-8");
    writeFileSync(join(root, "hooks", "stop.sh"), "#!/bin/sh\n", "utf-8");
    chmodSync(join(root, "hooks", "stop.sh"), 0o755);
  }

  it("true for identical trees", () => {
    const a = tmp();
    const b = tmp();
    seedTree(a);
    seedTree(b);
    expect(dirContentEquals(a, b)).toBe(true);
  });

  it("false when a file's content differs", () => {
    const a = tmp();
    const b = tmp();
    seedTree(a);
    seedTree(b);
    writeFileSync(join(b, "settings.json"), '{"a":2}\n', "utf-8");
    expect(dirContentEquals(a, b)).toBe(false);
  });

  it("false when dest has an extra or missing entry", () => {
    const a = tmp();
    const b = tmp();
    seedTree(a);
    seedTree(b);
    writeFileSync(join(b, "extra.txt"), "x", "utf-8");
    expect(dirContentEquals(a, b)).toBe(false);
  });

  it("false when the executable bit differs (hook scripts)", () => {
    const a = tmp();
    const b = tmp();
    seedTree(a);
    seedTree(b);
    chmodSync(join(b, "hooks", "stop.sh"), 0o644);
    expect(dirContentEquals(a, b)).toBe(false);
  });

  it("false when dest is missing entirely", () => {
    const a = tmp();
    seedTree(a);
    expect(dirContentEquals(a, join(a, "nope"))).toBe(false);
  });

  it("topLevelOverrides: dest may carry the post-override rendering of a file", () => {
    const vendor = tmp();
    const deployed = tmp();
    seedTree(vendor);
    seedTree(deployed);
    // Deployed settings.json holds the switchroom-overridden content,
    // not the vendor bytes — exactly the installHindsightPlugin shape.
    const overridden = '{"a":1,"retainEveryNTurns":1}\n';
    writeFileSync(join(deployed, "settings.json"), overridden, "utf-8");
    expect(dirContentEquals(vendor, deployed)).toBe(false);
    expect(
      dirContentEquals(vendor, deployed, { "settings.json": overridden }),
    ).toBe(true);
    // And a drifted deployed settings.json still fails the override match.
    writeFileSync(join(deployed, "settings.json"), '{"stale":true}\n', "utf-8");
    expect(
      dirContentEquals(vendor, deployed, { "settings.json": overridden }),
    ).toBe(false);
  });
});
