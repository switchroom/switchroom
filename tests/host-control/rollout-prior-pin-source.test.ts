/**
 * `prior_pin` must name the version the FLEET was running, not the one
 * the config file happened to say.
 *
 * THE BUG THESE GUARD
 *
 * `launchRollout` used to read `release.pin` out of `switchroom.yaml` to
 * stamp `prior_pin`. The roll's own `persist-pin` step writes that same
 * field, so whenever the pin was ALREADY set to the target before the
 * roll ran, `prior_pin` came out equal to `pin` — and `rollout
 * --allow-downgrade` (which defaults its target to the last completed
 * row's `prior_pin`) resolved a rollback target identical to the version
 * already deployed. Rollback silently became a no-op. Recorded live on
 * the operator host on 2026-07-29:
 *
 *   {"op":"rollout","result":"completed","pin":"v0.19.32",
 *    "prior_pin":"v0.19.32"}
 *
 * while every agent had actually been running v0.19.30.
 *
 * THESE TESTS FAIL ON THAT BUG. The first one puts the config pin at the
 * TARGET before the roll starts — the exact precondition that produced
 * the bad row — and asserts `prior_pin` is the RUNNING fleet version.
 * Under the old config-derived code it read back `v2.0.0` (the target),
 * which is the failure. It is an outcome assertion on the recorded audit
 * entry, not a check that some function was called.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HostdServer } from "../../src/host-control/server.js";
import type { ServerOptions } from "../../src/host-control/server.js";
import type { ComponentVersion } from "../../src/cli/component-versions.js";

const TARGET = "v2.0.0";
/** What the fleet is actually running — the true rollback target. */
const RUNNING = "v1.9.0";

const AGENT_IMAGE = "ghcr.io/switchroom/switchroom-agent";

function agent(name: string, version: string): ComponentVersion {
  return {
    name: `switchroom-${name}`,
    kind: "container",
    version,
    imageRef: `${AGENT_IMAGE}:${version}`,
  };
}

/** Every server built here, stopped in afterEach. */
const started: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  while (started.length > 0) await started.pop()!.stop();
});

interface Launched {
  entry: Record<string, unknown>;
}

/**
 * Launch a roll against a config whose `release.pin` is `configPin`, with
 * `components` as the running-container inventory, and return the status
 * entry hostd recorded.
 *
 * The child is stubbed out entirely: `prior_pin` is captured BEFORE the
 * child spawns, so the roll's outcome is irrelevant to what these assert.
 */
function launch(
  configPin: string,
  components: ComponentVersion[],
  agents?: string[],
): Launched {
  const dir = mkdtempSync(join(tmpdir(), "prior-pin-src-"));
  const configPath = join(dir, "switchroom.yaml");
  // A config that genuinely PARSES is load-bearing here, not incidental.
  // The old derivation read `release.pin` through `loadConfig` inside a
  // `try {} catch {}`; against an invalid fixture it would throw, swallow,
  // and yield `undefined` — so these tests would red for the wrong reason
  // and could not show the actual bug signature (`prior_pin === pin`).
  writeFileSync(
    configPath,
    [
      "switchroom:",
      "  version: 1",
      "telegram:",
      '  bot_token: "vault:telegram-bot-token"',
      '  forum_chat_id: "-1001234567890"',
      "release:",
      `  pin: ${configPin}`,
      "agents:",
      "  clerk:",
      "    extends: default",
      "    topic_name: Clerk",
      "",
    ].join("\n"),
    "utf8",
  );
  const server = new HostdServer({
    homeDir: dir,
    configPath,
    agentUids: {},
    config: { agents: { "test-harness": {}, overlord: { admin: true } } },
    auditLogPath: join(dir, "audit.log"),
    selfVersion: "v99.0.0",
    allowNonLinux: true,
    fleetComponents: () => components,
  } as unknown as ServerOptions);
  started.push(server);
  const s = server as unknown as {
    spawnRollout: (args: string[], entry: Record<string, unknown>) => void;
    launchRollout: (
      args: { pin: string; agents?: string[] },
      request_id: string,
      caller: unknown,
      started_at: number,
    ) => Record<string, unknown>;
  };
  // Neutralise the child spawn — we are asserting what was captured at
  // launch, before any child could run.
  s.spawnRollout = () => {};
  const entry = s.launchRollout(
    { pin: TARGET, ...(agents ? { agents } : {}) },
    "req-prior-pin-src",
    { kind: "agent", name: "overlord" },
    Date.now(),
  );
  return { entry };
}

describe("prior_pin is derived from the running fleet, not release.pin", () => {
  it("records the RUNNING version when the config pin was already the target (the #live-2026-07-29 bug)", () => {
    // The precondition that produced the bad row: yaml already names the
    // target, but every agent is still on the older build.
    const { entry } = launch(TARGET, [agent("clerk", RUNNING), agent("marko", RUNNING)]);

    expect(entry.pin).toBe(TARGET);
    // The regression: the old derivation returned TARGET here.
    expect(entry.prior_pin).toBe(RUNNING);
    expect(entry.prior_pin).not.toBe(entry.pin);
    expect(entry.prior_pin_source).toBe("running-fleet");
    // Uniform fleet — nothing extra to disclose.
    expect(entry.prior_pin_observed).toBeUndefined();
  });

  it("ignores a config pin that disagrees with the fleet in the other direction too", () => {
    // Config says something no agent is running. The fleet is still the fact.
    const { entry } = launch("v0.0.1", [agent("clerk", RUNNING)]);
    expect(entry.prior_pin).toBe(RUNNING);
  });

  it("never records the target, even when SOME agents already sit on it", () => {
    // Mid-roll shapes / a retried roll: the canary already advanced.
    const { entry } = launch(TARGET, [agent("clerk", TARGET), agent("marko", RUNNING)]);
    expect(entry.prior_pin).toBe(RUNNING);
    expect(entry.prior_pin).not.toBe(TARGET);
    // The fleet was NOT uniform — say so rather than implying it was.
    expect(entry.prior_pin_observed).toEqual([TARGET, RUNNING]);
  });

  it("records NO prior_pin when every agent already runs the target", () => {
    const { entry } = launch(TARGET, [agent("clerk", TARGET), agent("marko", TARGET)]);
    expect(entry.prior_pin).toBeUndefined();
    expect(entry.prior_pin_source).toBe("all-on-target");
    expect(entry.prior_pin_observed).toEqual([TARGET]);
  });

  it("records NO prior_pin — and never falls back to the config — when the inventory is unreadable", () => {
    // `docker ps` failed. The old code would have happily used the config
    // pin here; that fallback IS the defect, so absence is the contract.
    const { entry } = launch(TARGET, []);
    expect(entry.prior_pin).toBeUndefined();
    expect(entry.prior_pin_source).toBe("unobserved");
  });

  it("honours the --agents subset: an out-of-scope agent's version is not the prior pin", () => {
    const { entry } = launch(
      TARGET,
      [agent("clerk", RUNNING), agent("marko", "v0.5.0")],
      ["clerk"],
    );
    expect(entry.prior_pin).toBe(RUNNING);
  });
});
