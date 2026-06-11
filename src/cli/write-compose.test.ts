/**
 * writeComposeFile — the single source of truth shared by `apply` and the
 * `agent restart` reconcile path. Pins: the written compose carries the
 * release pin's image tag, and the changed/previousImageTag drift signals
 * are correct. Writes to an isolated tmpdir — never ~/.switchroom.
 */
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SwitchroomConfig } from "../config/schema.js";
import { writeComposeFile, resolveHostSwitchroomConfigPath } from "./write-compose.js";

function mkConfig(pin?: string): SwitchroomConfig {
  return {
    telegram: { bot_token: "x", forum_chat_id: "-100" },
    ...(pin ? { release: { pin } } : {}),
    agents: { clerk: { extends: "default" } },
  } as unknown as SwitchroomConfig;
}

describe("writeComposeFile", () => {
  it("writes the compose with the release pin's image tag", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wc-"));
    const composePath = join(dir, "compose", "docker-compose.yml");
    const r = await writeComposeFile({ config: mkConfig("v0.14.92"), composePath, switchroomConfigPath: undefined });
    expect(r.imageTag).toBe("v0.14.92");
    expect(r.changed).toBe(true);
    expect(r.previousImageTag).toBeNull(); // first write, no prior file
    const content = readFileSync(composePath, "utf8");
    expect(content).toContain("switchroom-agent:v0.14.92");
  });

  it("reports the previous image tag + changed=true when the pin moves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wc-"));
    const composePath = join(dir, "docker-compose.yml");
    await writeComposeFile({ config: mkConfig("v0.14.91"), composePath, switchroomConfigPath: undefined });
    const r = await writeComposeFile({ config: mkConfig("v0.14.92"), composePath, switchroomConfigPath: undefined });
    expect(r.previousImageTag).toBe("v0.14.91");
    expect(r.imageTag).toBe("v0.14.92");
    expect(r.changed).toBe(true);
    expect(readFileSync(composePath, "utf8")).toContain("switchroom-agent:v0.14.92");
  });

  it("changed=false when re-writing the same pin (idempotent)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wc-"));
    const composePath = join(dir, "docker-compose.yml");
    await writeComposeFile({ config: mkConfig("v0.14.92"), composePath, switchroomConfigPath: undefined });
    const r = await writeComposeFile({ config: mkConfig("v0.14.92"), composePath, switchroomConfigPath: undefined });
    expect(r.changed).toBe(false);
    expect(r.previousImageTag).toBe("v0.14.92");
  });
});

// ── resolveHostSwitchroomConfigPath ──────────────────────────────────────────
//
// Regression guard for the 2026-06-11 v0.15.3 rollback incident:
// `switchroom apply` run from inside an agent container emitted the container
// path `/state/config/switchroom.yaml` as a Docker bind-mount SOURCE. Docker
// auto-created that path as an empty directory on the host; vault-broker and
// auth-broker crashed with EISDIR on every subsequent start.
//
// The fix bakes SWITCHROOM_HOST_HOME into the container env and translates
// container-internal config paths to host paths before writing compose.

describe("resolveHostSwitchroomConfigPath", () => {
  // Stash and restore SWITCHROOM_RUNTIME and SWITCHROOM_HOST_HOME so tests
  // don't bleed into each other or affect the outer test environment.
  let savedRuntime: string | undefined;
  let savedHostHome: string | undefined;

  beforeEach(() => {
    savedRuntime = process.env.SWITCHROOM_RUNTIME;
    savedHostHome = process.env.SWITCHROOM_HOST_HOME;
  });

  afterEach(() => {
    if (savedRuntime === undefined) {
      delete process.env.SWITCHROOM_RUNTIME;
    } else {
      process.env.SWITCHROOM_RUNTIME = savedRuntime;
    }
    if (savedHostHome === undefined) {
      delete process.env.SWITCHROOM_HOST_HOME;
    } else {
      process.env.SWITCHROOM_HOST_HOME = savedHostHome;
    }
  });

  it("returns the path unchanged on the host (non-docker)", () => {
    delete process.env.SWITCHROOM_RUNTIME;
    delete process.env.SWITCHROOM_HOST_HOME;
    expect(resolveHostSwitchroomConfigPath("/home/op/.switchroom/switchroom.yaml"))
      .toBe("/home/op/.switchroom/switchroom.yaml");
  });

  it("returns the path unchanged on the host even for /state/config/ paths (operator edge case)", () => {
    // An operator who physically has their config at /state/config/… on the
    // host should not have it translated.
    delete process.env.SWITCHROOM_RUNTIME;
    delete process.env.SWITCHROOM_HOST_HOME;
    expect(resolveHostSwitchroomConfigPath("/state/config/switchroom.yaml"))
      .toBe("/state/config/switchroom.yaml");
  });

  it("translates /state/config/switchroom.yaml to host path inside a container", () => {
    // This is the core regression guard: when running inside docker with
    // SWITCHROOM_HOST_HOME set, the container path must become the host path.
    process.env.SWITCHROOM_RUNTIME = "docker";
    process.env.SWITCHROOM_HOST_HOME = "/home/testop";
    expect(resolveHostSwitchroomConfigPath("/state/config/switchroom.yaml"))
      .toBe("/home/testop/.switchroom/switchroom.yaml");
  });

  it("preserves non-/state/config/ paths inside a container (explicit --config bind-mount)", () => {
    // An operator who bind-mounts their config to a non-standard container
    // path passes it via --config. It starts with '/mnt/...' not '/state/config/',
    // so the translator must leave it alone.
    process.env.SWITCHROOM_RUNTIME = "docker";
    process.env.SWITCHROOM_HOST_HOME = "/home/testop";
    expect(resolveHostSwitchroomConfigPath("/mnt/host/switchroom.yaml"))
      .toBe("/mnt/host/switchroom.yaml");
  });

  it("throws a clear error when inside a container with a /state/config/ path but no SWITCHROOM_HOST_HOME", () => {
    // This is the "old fleet" case: container was built by a pre-fix switchroom
    // that didn't bake SWITCHROOM_HOST_HOME. The safe behaviour is to refuse
    // rather than emit a broken compose that auto-creates the dir on the host.
    process.env.SWITCHROOM_RUNTIME = "docker";
    delete process.env.SWITCHROOM_HOST_HOME;
    expect(() => resolveHostSwitchroomConfigPath("/state/config/switchroom.yaml"))
      .toThrow(/SWITCHROOM_HOST_HOME is not set/);
    expect(() => resolveHostSwitchroomConfigPath("/state/config/switchroom.yaml"))
      .toThrow(/run.*switchroom apply.*from the HOST/i);
  });

  it("writeComposeFile uses the translated host path in the compose bind-mount (container context)", async () => {
    // Full integration: run writeComposeFile in simulated container context.
    // The resulting compose must have the HOST path, not the container path,
    // as the bind-mount source for switchroom.yaml.
    process.env.SWITCHROOM_RUNTIME = "docker";
    process.env.SWITCHROOM_HOST_HOME = "/home/testop";
    const dir = mkdtempSync(join(tmpdir(), "wc-container-"));
    const composePath = join(dir, "docker-compose.yml");
    await writeComposeFile({
      config: mkConfig("v0.15.3"),
      composePath,
      // Simulate the container-internal SWITCHROOM_CONFIG value that
      // findConfigFile() returns inside an agent container.
      switchroomConfigPath: "/state/config/switchroom.yaml",
    });
    const content = readFileSync(composePath, "utf8");
    // Must have the HOST path as source.
    expect(content).toContain("/home/testop/.switchroom/switchroom.yaml:/state/config/switchroom.yaml:ro");
    // Must NOT have the container path as source — that's the bug.
    expect(content).not.toContain("/state/config/switchroom.yaml:/state/config/switchroom.yaml:ro");
  });
});
