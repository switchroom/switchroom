import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cleanShutdownMarkerPathForAgent,
  writeRestartReasonMarker,
  buildCliRestartReason,
} from "../src/agents/lifecycle.js";

/**
 * Regression tests for the restart-reason writer (PR
 * feat/restart-reason-greeting). These pin the contract that every
 * restart initiator (CLI, update, reconcile, watchdog, user slash)
 * depends on: the agent-side clean-shutdown marker is at the exact path
 * the gateway consumes on boot, and preserveExisting lets earlier
 * writers (gateway /restart) win the race against later writers
 * (downstream CLI restart).
 */

describe("lifecycle: restart-reason marker", () => {
  let tmpRoot: string;
  let prevAgentsDir: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "sw-lifecycle-"));
    prevAgentsDir = process.env.SWITCHROOM_AGENTS_DIR;
    process.env.SWITCHROOM_AGENTS_DIR = tmpRoot;
  });

  afterEach(() => {
    if (prevAgentsDir === undefined) delete process.env.SWITCHROOM_AGENTS_DIR;
    else process.env.SWITCHROOM_AGENTS_DIR = prevAgentsDir;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("cleanShutdownMarkerPathForAgent mirrors the gateway's per-agent path", () => {
    // The gateway uses `${STATE_DIR}/clean-shutdown.json` where STATE_DIR
    // is the agent's telegram/ subdir. Our helper MUST resolve to the
    // same literal filename or greetings will go dark.
    const p = cleanShutdownMarkerPathForAgent("clerk");
    expect(p).toBe(join(tmpRoot, "clerk", "telegram", "clean-shutdown.json"));
  });

  it("writeRestartReasonMarker creates the dir and writes a valid CleanShutdownMarker JSON", () => {
    writeRestartReasonMarker("agent-a", "cli: restart");
    const p = cleanShutdownMarkerPathForAgent("agent-a");
    expect(existsSync(p)).toBe(true);
    const m = JSON.parse(readFileSync(p, "utf-8")) as {
      ts: number;
      signal: string;
      reason: string;
    };
    expect(typeof m.ts).toBe("number");
    expect(m.signal).toBe("SIGTERM");
    expect(m.reason).toBe("cli: restart");
  });

  it("writeRestartReasonMarker is best-effort when the agent dir is missing (no throw)", () => {
    // We configured SWITCHROOM_AGENTS_DIR but the per-agent subdir
    // doesn't exist. The writer should mkdir-p it and succeed — the
    // important contract is "the restart still proceeds even if
    // stamping fails."
    expect(() => writeRestartReasonMarker("brand-new", "cli: restart")).not.toThrow();
    expect(existsSync(cleanShutdownMarkerPathForAgent("brand-new"))).toBe(true);
  });

  it("preserveExisting keeps a fresh prior marker (cooperative race: gateway write wins over CLI)", () => {
    // Simulate the production sequence: the gateway's /restart handler
    // writes "user: /restart from chat" before spawning the detached
    // `switchroom agent restart` CLI. The CLI later calls our writer
    // with "cli: restart" — preserveExisting: true MUST leave the user
    // attribution in place so the greeting card shows who asked.
    const p = cleanShutdownMarkerPathForAgent("agent-user");
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({ ts: Date.now(), signal: "SIGTERM", reason: "user: /restart from chat" }),
    );

    writeRestartReasonMarker("agent-user", "cli: restart", { preserveExisting: true });

    const after = JSON.parse(readFileSync(p, "utf-8")) as { reason: string };
    expect(after.reason).toBe("user: /restart from chat");
  });

  it("preserveExisting overwrites a stale prior marker (>30s old)", () => {
    const p = cleanShutdownMarkerPathForAgent("agent-stale");
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({
        ts: Date.now() - 60_000,
        signal: "SIGTERM",
        reason: "user: ancient marker",
      }),
    );

    writeRestartReasonMarker("agent-stale", "cli: restart", { preserveExisting: true });

    const after = JSON.parse(readFileSync(p, "utf-8")) as { reason: string };
    expect(after.reason).toBe("cli: restart");
  });

  it("preserveExisting: false always overwrites (the default path for non-race callers)", () => {
    const p = cleanShutdownMarkerPathForAgent("agent-clobber");
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({ ts: Date.now(), signal: "SIGTERM", reason: "watchdog: flap" }),
    );

    writeRestartReasonMarker("agent-clobber", "cli: restart");

    const after = JSON.parse(readFileSync(p, "utf-8")) as { reason: string };
    expect(after.reason).toBe("cli: restart");
  });
});

describe("lifecycle: restartAgent ordering (#177)", () => {
  // Pre-#177 fix: gateway service was restarted FIRST, agent service
  // SECOND. Problem: when a detached child of the gateway calls
  // restartAgent, that child is in the gateway's cgroup. systemctl
  // restart of the gateway cgroup-kills the child mid-flight, before
  // the second `systemctl restart` (the agent service) ever runs.
  // The user types /new, sees the gateway bounce, but the session
  // doesn't actually rotate.
  //
  // This test pins the source ordering so a future re-edit can't
  // silently regress.
  it("calls systemctl restart on the agent service BEFORE the gateway service", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, join: joinPath } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const TEST_DIR = resolve(fileURLToPath(import.meta.url), "..");
    const REPO_ROOT = resolve(TEST_DIR, "..");
    const src = readFileSync(joinPath(REPO_ROOT, "src/agents/lifecycle.ts"), "utf-8");

    // Find the restartAgent function body and inspect ordering.
    const funcStart = src.indexOf("export function restartAgent(");
    const funcEnd = src.indexOf("\n}\n", funcStart);
    expect(funcStart).toBeGreaterThan(0);
    const body = src.slice(funcStart, funcEnd);

    const agentRestartIdx = body.indexOf('systemctl(["restart", serviceName(name)])');
    const gatewayRestartIdx = body.indexOf('systemctlIfExists("restart", gatewayServiceName(name))');
    expect(agentRestartIdx).toBeGreaterThan(0);
    expect(gatewayRestartIdx).toBeGreaterThan(0);
    // Agent first, gateway second — the post-#177 fix.
    expect(agentRestartIdx).toBeLessThan(gatewayRestartIdx);
  });
});

describe("lifecycle: buildCliRestartReason", () => {
  it("returns 'cli: restart' when buildCommit is null (npm-installed, no build-info)", () => {
    expect(buildCliRestartReason({ buildCommit: null })).toBe("cli: restart");
  });

  it("falls back to 'cli: restart' when git is unavailable / not in a repo", () => {
    // Drive the non-repo path by pointing cwd at /tmp (which is not a
    // git checkout). The helper must swallow the failure rather than
    // crash the restart.
    const reason = buildCliRestartReason({
      buildCommit: "deadbee",
      cwd: tmpdir(),
    });
    expect(reason).toBe("cli: restart");
  });
});
