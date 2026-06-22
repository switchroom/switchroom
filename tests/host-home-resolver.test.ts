/**
 * Tests for resolveHostHomeForCompose() in src/cli/write-compose.ts.
 *
 * This function is the by-construction fix for the 2026-06-23 fleet outage:
 * it refuses to fall back to homedir() inside a container (which would bake
 * container paths like /state/agent/home as bind-mount sources, causing Docker
 * to auto-create empty dirs on the host and crashing the brokers with EISDIR).
 *
 * Three coverage axes:
 *   1. SWITCHROOM_HOST_HOME explicitly set — validate + use it (good & bad values).
 *   2. Unset + container context — THROWS (the incident).
 *   3. Unset + host context — falls back to homedir().
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { resolveHostHomeForCompose } from "../src/cli/write-compose.js";

// Snapshot env keys we'll mutate so afterEach can restore them.
const MANAGED_KEYS = ["SWITCHROOM_HOST_HOME", "SWITCHROOM_CONTAINER"] as const;
type ManagedKey = (typeof MANAGED_KEYS)[number];

let savedEnv: Partial<Record<ManagedKey, string | undefined>>;

beforeEach(() => {
  savedEnv = {};
  for (const k of MANAGED_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of MANAGED_KEYS) {
    if (savedEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = savedEnv[k];
    }
  }
});

// ---------------------------------------------------------------------------
// SWITCHROOM_HOST_HOME explicitly set
// ---------------------------------------------------------------------------

describe("SWITCHROOM_HOST_HOME set to a valid host path", () => {
  it("returns the configured value unchanged", () => {
    process.env.SWITCHROOM_HOST_HOME = "/home/kenthompson";
    const result = resolveHostHomeForCompose();
    expect(result).toBe("/home/kenthompson");
  });

  it("accepts ${HOME} legacy placeholder", () => {
    process.env.SWITCHROOM_HOST_HOME = "${HOME}";
    const result = resolveHostHomeForCompose();
    expect(result).toBe("${HOME}");
  });
});

describe("SWITCHROOM_HOST_HOME set to an invalid in-container path", () => {
  it("THROWS for /state/agent/home — the 2026-06-23 poison value", () => {
    // This was the exact value that triggered the outage: a deploy ran inside
    // an agent container whose HOME was /state/agent/home and SWITCHROOM_HOST_HOME
    // was set to that container path (or derived from the container's HOME). The
    // validator must reject it before baking it into the compose file.
    process.env.SWITCHROOM_HOST_HOME = "/state/agent/home";
    expect(() => resolveHostHomeForCompose()).toThrow();
  });

  it("THROWS for /state (parent container root)", () => {
    process.env.SWITCHROOM_HOST_HOME = "/state";
    expect(() => resolveHostHomeForCompose()).toThrow();
  });

  it("THROWS for /host-home (the 2026-06-11/12 outage value)", () => {
    process.env.SWITCHROOM_HOST_HOME = "/host-home";
    expect(() => resolveHostHomeForCompose()).toThrow();
  });

  it("THROWS for non-absolute path", () => {
    process.env.SWITCHROOM_HOST_HOME = "relative/path";
    expect(() => resolveHostHomeForCompose()).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Unset + container context → THROWS
// ---------------------------------------------------------------------------

describe("SWITCHROOM_HOST_HOME unset + container context", () => {
  it("THROWS via SWITCHROOM_CONTAINER=1 — cannot derive host home from container", () => {
    // SWITCHROOM_HOST_HOME is NOT set, SWITCHROOM_CONTAINER=1 flags us as inside
    // a container. Falling back to homedir() here would return the container HOME
    // (e.g. /state/agent/home) and bake it as a bind-source, which is exactly
    // the 2026-06-23 outage. Must throw.
    delete process.env.SWITCHROOM_HOST_HOME;
    process.env.SWITCHROOM_CONTAINER = "1";
    expect(() => resolveHostHomeForCompose()).toThrow(/container|SWITCHROOM_HOST_HOME/i);
  });
});

// ---------------------------------------------------------------------------
// Unset + host context → falls back to homedir()
// ---------------------------------------------------------------------------

describe("SWITCHROOM_HOST_HOME unset + host context", () => {
  it("returns homedir() on a real host shell (no container marker)", () => {
    // Both env vars are unset (beforeEach clears them) and /.dockerenv doesn't
    // exist in the vitest process's environment. This simulates the happy path:
    // an operator running `switchroom apply` from their shell.
    delete process.env.SWITCHROOM_HOST_HOME;
    delete process.env.SWITCHROOM_CONTAINER;
    // We can't inject the /.dockerenv probe directly, but since vitest doesn't
    // run under Docker normally, the isContainerContext() check returns false and
    // we should get homedir().
    const result = resolveHostHomeForCompose();
    expect(result).toBe(homedir());
  });
});
