/**
 * compose-generator-localtime.test.ts
 *
 * Verifies that the compose generator bind-mounts the host zoneinfo
 * file onto /etc/localtime for the agent service, derived from the
 * resolved per-agent timezone (#1198 follow-up).
 *
 * Rationale: `TZ` / `SWITCHROOM_TIMEZONE` env vars cover every tool that
 * reads `TZ`, but statically-linked Go binaries and some Java runtimes
 * read `/etc/localtime` directly and ignore `TZ`. The agent process runs
 * unprivileged on a read-only rootfs, so it cannot fix the symlink from
 * inside start.sh — a docker-daemon bind mount is the correct layer.
 *
 * Pure compose-string assertions — no docker invocation. That is a real
 * blind spot, not a stylistic one: the emitted string stayed correct
 * throughout the period when this mount was silently overwriting
 * /usr/share/zoneinfo/Etc/UTC, because Docker resolves the mount
 * DESTINATION through the stock tzdata symlink before mounting. The
 * mount SEMANTICS are covered by
 * `tests/docker/localtime-mount-symlink.test.ts`; this file covers
 * generation only.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCompose } from "../../src/agents/compose.js";
import type { SwitchroomConfig } from "../../src/config/schema.js";

function makeConfig(timezone?: string): SwitchroomConfig {
  return {
    switchroom: {
      version: 1,
      agents_dir: "~/.switchroom/agents",
      skills_dir: "~/.switchroom/skills",
      timezone,
    },
    telegram: { bot_token: "x" },
    defaults: undefined,
    profiles: undefined,
    agents: {
      coach: {
        extends: undefined,
        settings_raw: undefined,
        admin: undefined,
        env: undefined,
        schedule: [],
        tools: { allow: [], deny: [] },
        hooks: undefined,
        channels: undefined,
      } as unknown as SwitchroomConfig["agents"][string],
    },
    drive: undefined as unknown as SwitchroomConfig["drive"],
  } as unknown as SwitchroomConfig;
}

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "compose-localtime-test-"));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("compose-generator — /etc/localtime zoneinfo bind mount", () => {
  it("mounts the resolved zoneinfo file onto /etc/localtime read-only", () => {
    // UTC is present in tzdata on every Debian/Ubuntu host (the CI base
    // and the production agent image both ship tzdata). Guard anyway so
    // the suite is hermetic on an exotic host that lacks the file.
    if (!existsSync("/usr/share/zoneinfo/UTC")) return;
    const out = generateCompose({ config: makeConfig("UTC"), homeDir: tmpHome });
    expect(out).toContain("- /usr/share/zoneinfo/UTC:/etc/localtime:ro");
  });

  it("uses the operator-declared zone, not a hardcoded one", () => {
    if (!existsSync("/usr/share/zoneinfo/Australia/Melbourne")) return;
    const out = generateCompose({
      config: makeConfig("Australia/Melbourne"),
      homeDir: tmpHome,
    });
    expect(out).toContain(
      "- /usr/share/zoneinfo/Australia/Melbourne:/etc/localtime:ro",
    );
  });

  it("omits the mount when the host lacks the zoneinfo file", () => {
    // A bogus zone the host can't have — docker compose `up` would
    // hard-fail on a missing bind source, so the generator must skip it.
    const out = generateCompose({
      config: makeConfig("Mars/Olympus_Mons"),
      homeDir: tmpHome,
    });
    expect(out).not.toContain(":/etc/localtime:ro");
  });

  it("rejects a non-IANA / traversal zone before it reaches the bind source", () => {
    // `resolveTimezone` returns `switchroom.timezone` verbatim — the
    // server-detection fallback is NOT re-validated — so the generator
    // must guard with `isValidTimezone` before interpolating into the
    // mount path. A `..` zone must never appear in the bind source.
    const out = generateCompose({
      config: makeConfig("../../etc/hostname"),
      homeDir: tmpHome,
    });
    expect(out).not.toContain(":/etc/localtime:ro");
    expect(out).not.toContain("/usr/share/zoneinfo/../");
  });
});
