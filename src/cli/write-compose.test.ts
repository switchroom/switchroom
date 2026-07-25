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
import {
  writeComposeFile,
  resolveHostSwitchroomConfigPath,
  shouldBackupCompose,
  restoreComposeBackup,
  composeImageTag,
  composeServiceNames,
} from "./write-compose.js";

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

  // Regression guard for #2558:
  // On the hostd rollout path, `apply --pin vX` correctly wrote the compose
  // with the target tag. But the subsequent `agent restart <canary> --wait
  // --force` called `writeComposeFile` WITHOUT `releaseOverride`, re-reading
  // the stale `release.pin` from config and overwriting the compose — putting
  // the canary on the old image. The fix: thread `releaseOverride` through
  // `ReconcileAndRestartOpts` so `reconcileAndRestartAgent` can pass it to
  // `writeComposeFile`, and have the rollout's restart-agent step supply it
  // on the hostd path.
  it("releaseOverride pin wins over stale release.pin in config (#2558 regression)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wc-2558-"));
    const composePath = join(dir, "docker-compose.yml");
    // Config has the OLD pin (v0.15.59); the rollout target is v0.15.61.
    const config = mkConfig("v0.15.59");
    const r = await writeComposeFile({
      config,
      composePath,
      switchroomConfigPath: undefined,
      releaseOverride: { pin: "v0.15.61" },
    });
    expect(r.imageTag).toBe("v0.15.61");
    const content = readFileSync(composePath, "utf8");
    // Every agent image ref must use the TARGET pin, not the stale config pin.
    expect(content).toContain("switchroom-agent:v0.15.61");
    expect(content).not.toContain("switchroom-agent:v0.15.59");
    // Singleton images must also use the target (belt-and-braces — singletons
    // honor --pin via a separate reconcile path but the compose must be consistent).
    expect(content).toContain("switchroom-broker:v0.15.61");
    expect(content).not.toContain("switchroom-broker:v0.15.59");
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

// ── The compose backup must survive a roll ───────────────────────────────
//
// The old rule backed up on EVERY write. But `writeComposeFile` runs on every
// `agent restart` too (src/cli/agent.ts — the restart reconcile regenerates
// the WHOLE-fleet compose), so during a staggered roll the FIRST agent's
// restart backed up the pre-roll compose and the SECOND agent's restart
// immediately overwrote that backup with the post-bump file. Verified on the
// production host: `cmp docker-compose.yml docker-compose.yml.bak` matched,
// 58803 bytes each, same mtime — zero recovery value. The write-side comment
// also claimed src/cli/update.ts could roll back to it; no such code existed
// (`grep -n '\.bak\|rollback\|revert' src/cli/update.ts` → nothing).

describe("shouldBackupCompose", () => {
  const at = (tag: string) => `services:\n  x:\n    image: ghcr.io/o/switchroom-agent:${tag}\n`;

  it("skips the first-ever write (nothing to back up)", () => {
    expect(shouldBackupCompose(null, at("v1.0.0"), null)).toBe(false);
  });

  it("backs up when the image tag is genuinely moving", () => {
    expect(shouldBackupCompose(at("v1.0.0"), at("v1.0.1"), null)).toBe(true);
    expect(shouldBackupCompose(at("v1.0.0"), at("v1.0.1"), "v0.9.0")).toBe(true);
  });

  it("does NOT clobber the backup on a no-op regeneration", () => {
    // Agents 2..N of a roll all rewrite the same already-bumped compose.
    expect(shouldBackupCompose(at("v1.0.1"), at("v1.0.1"), "v1.0.0")).toBe(false);
  });

  it("does NOT clobber a pre-bump backup with a same-version write", () => {
    const prev = at("v1.0.1") + "# unrelated edit\n";
    expect(shouldBackupCompose(prev, at("v1.0.1"), "v1.0.0")).toBe(false);
  });

  it("still creates a first backup for a tag-neutral edit when none exists", () => {
    const prev = at("v1.0.1") + "# unrelated edit\n";
    expect(shouldBackupCompose(prev, at("v1.0.1"), null)).toBe(true);
  });
});

describe("compose backup across a simulated staggered roll", () => {
  it("keeps .bak on the PRE-ROLL version after every agent restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wc-bak-"));
    const composePath = join(dir, "docker-compose.yml");
    const bak = composePath + ".bak";

    // Fleet settled on v0.19.3 (an apply, then some restarts).
    await writeComposeFile({ config: mkConfig("v0.19.3"), composePath, switchroomConfigPath: undefined });
    await writeComposeFile({ config: mkConfig("v0.19.3"), composePath, switchroomConfigPath: undefined });

    // The roll: `apply --pin v0.19.4`, then one whole-fleet compose
    // regeneration per agent restart (12 agents).
    await writeComposeFile({ config: mkConfig("v0.19.4"), composePath, switchroomConfigPath: undefined });
    for (let i = 0; i < 12; i++) {
      await writeComposeFile({ config: mkConfig("v0.19.4"), composePath, switchroomConfigPath: undefined });
    }

    expect(readFileSync(composePath, "utf8")).toContain("switchroom-agent:v0.19.4");
    // THE outcome the old code got wrong: the backup is the PRE-ROLL compose,
    // not a copy of the live one.
    const bakContent = readFileSync(bak, "utf8");
    expect(bakContent).toContain("switchroom-agent:v0.19.3");
    expect(bakContent).not.toContain("switchroom-agent:v0.19.4");
    expect(bakContent).not.toBe(readFileSync(composePath, "utf8"));
    expect(composeImageTag(bakContent)).toBe("v0.19.3");
  });

  it("restoreComposeBackup actually puts the fleet back on the prior compose", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wc-restore-"));
    const composePath = join(dir, "docker-compose.yml");
    await writeComposeFile({ config: mkConfig("v0.19.3"), composePath, switchroomConfigPath: undefined });
    await writeComposeFile({ config: mkConfig("v0.19.4"), composePath, switchroomConfigPath: undefined });

    const res = await restoreComposeBackup(composePath);

    expect(res.restored).toBe(true);
    expect(res.imageTag).toBe("v0.19.3");
    expect(readFileSync(composePath, "utf8")).toContain("switchroom-agent:v0.19.3");
    expect(readFileSync(composePath, "utf8")).not.toContain("switchroom-agent:v0.19.4");
  });

  it("restoreComposeBackup reports (never throws) when there is no backup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wc-nobak-"));
    const composePath = join(dir, "docker-compose.yml");
    await writeComposeFile({ config: mkConfig("v0.19.3"), composePath, switchroomConfigPath: undefined });
    const res = await restoreComposeBackup(composePath);
    expect(res.restored).toBe(false);
    expect(res.reason).toMatch(/no usable compose backup/);
    // The live compose is untouched.
    expect(readFileSync(composePath, "utf8")).toContain("switchroom-agent:v0.19.3");
  });

  it("refuses to restore an empty/truncated backup over a good compose", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wc-emptybak-"));
    const composePath = join(dir, "docker-compose.yml");
    await writeComposeFile({ config: mkConfig("v0.19.3"), composePath, switchroomConfigPath: undefined });
    writeFileSync(composePath + ".bak", "   \n", "utf8");
    const res = await restoreComposeBackup(composePath);
    expect(res.restored).toBe(false);
    expect(res.reason).toMatch(/empty/);
    expect(readFileSync(composePath, "utf8")).toContain("switchroom-agent:v0.19.3");
  });

  it("REFUSES a backup that predates an agent being added", async () => {
    // The backup is deliberately preserved across many writes, so it can be
    // arbitrarily old. Restoring one generated before `archivist` existed
    // would silently delete a live agent's service — worse than the bad
    // compose it is replacing.
    const dir = mkdtempSync(join(tmpdir(), "wc-drift-add-"));
    const composePath = join(dir, "docker-compose.yml");
    const twoAgents = {
      telegram: { bot_token: "x", forum_chat_id: "-100" },
      release: { pin: "v0.19.4" },
      agents: { clerk: { extends: "default" }, archivist: { extends: "default" } },
    } as unknown as SwitchroomConfig;

    await writeComposeFile({ config: mkConfig("v0.19.3"), composePath, switchroomConfigPath: undefined });
    await writeComposeFile({ config: twoAgents, composePath, switchroomConfigPath: undefined });

    const live = readFileSync(composePath, "utf8");
    expect(composeServiceNames(live)).toContain("agent-archivist");

    const res = await restoreComposeBackup(composePath);

    expect(res.restored).toBe(false);
    expect(res.reason).toMatch(/does not match the current fleet/);
    expect(res.reason).toMatch(/missing: agent-archivist/);
    // THE outcome: the live compose is untouched, so no agent is dropped.
    expect(readFileSync(composePath, "utf8")).toBe(live);
  });

  it("refuses a backup carrying a service the fleet no longer has", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wc-drift-rm-"));
    const composePath = join(dir, "docker-compose.yml");
    await writeComposeFile({ config: mkConfig("v0.19.3"), composePath, switchroomConfigPath: undefined });
    // Backup names a retired agent.
    writeFileSync(
      composePath + ".bak",
      readFileSync(composePath, "utf8").replace(/^services:$/m, "services:\n  retired:\n    image: x"),
      "utf8",
    );
    const res = await restoreComposeBackup(composePath);
    expect(res.restored).toBe(false);
    expect(res.reason).toMatch(/unknown: retired/);
  });

  it("force bypasses the coherence gate for a deliberate operator restore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wc-force-"));
    const composePath = join(dir, "docker-compose.yml");
    const twoAgents = {
      telegram: { bot_token: "x", forum_chat_id: "-100" },
      release: { pin: "v0.19.4" },
      agents: { clerk: { extends: "default" }, archivist: { extends: "default" } },
    } as unknown as SwitchroomConfig;
    await writeComposeFile({ config: mkConfig("v0.19.3"), composePath, switchroomConfigPath: undefined });
    await writeComposeFile({ config: twoAgents, composePath, switchroomConfigPath: undefined });

    const res = await restoreComposeBackup(composePath, { force: true });

    expect(res.restored).toBe(true);
    expect(res.imageTag).toBe("v0.19.3");
  });

  it("still restores when the fleet is unchanged (the gate is not a blanket refusal)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wc-same-"));
    const composePath = join(dir, "docker-compose.yml");
    await writeComposeFile({ config: mkConfig("v0.19.3"), composePath, switchroomConfigPath: undefined });
    await writeComposeFile({ config: mkConfig("v0.19.4"), composePath, switchroomConfigPath: undefined });
    const res = await restoreComposeBackup(composePath);
    expect(res.restored).toBe(true);
    expect(res.imageTag).toBe("v0.19.3");
  });

  it("composeServiceNames reads only top-level service keys", () => {
    const text = [
      "version: '3'",
      "services:",
      "  clerk:",
      "    image: x",
      "    environment:",
      "      foo: bar",
      "  # a comment",
      "  archivist:",
      "    image: y",
      "volumes:",
      "  data:",
    ].join("\n");
    expect(composeServiceNames(text)).toEqual(["clerk", "archivist"]);
    expect(composeServiceNames("garbage")).toEqual([]);
  });
});
