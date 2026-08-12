/**
 * Pure-function tests for the Phase 1a compose generator.
 *
 * Coverage targets (≥15 cases per the dispatch brief):
 *   - empty fleet
 *   - single agent
 *   - multi-agent fleet (sorted output)
 *   - klanker resource defaults
 *   - conversational profile defaults
 *   - lightweight profile defaults
 *   - coding profile defaults
 *   - unknown profile falls through to default
 *   - cap_add stripped + warning emitted
 *   - per-agent socket volume isolation invariant
 *   - byte-determinism for byte-identical input (run twice → identical)
 *   - input order independence (object insertion order doesn't matter)
 *   - allocateAgentUid is in the reserved range
 *   - allocateAgentUid is deterministic across calls
 *   - generated compose contains stop_grace_period: 45s on every agent
 *   - scheduler service emitted with docker.sock mount
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateCompose,
  allocateAgentUid,
  assertNoAgentUidCollision,
  AGENT_UID_MIN,
  AGENT_UID_MAX,
  describeAgents,
  DEFAULT_TMP_SIZE,
  resolveConfigMountSource,
  CONTAINER_CONFIG_PATH,
} from "../../src/agents/compose.js";
import type { SwitchroomConfig } from "../../src/config/schema.js";

interface MakeConfigAgent {
  extends?: string;
  settings_raw?: Record<string, unknown>;
  admin?: boolean;
  root?: boolean;
  env?: Record<string, string>;
  model?: string;
  bind_mounts?: Array<{ source: string; target?: string; mode?: "ro" | "rw" }>;
  resources?: {
    memory?: string;
    memory_reservation?: string;
    pids_limit?: number;
    cpus?: number;
    tmp_size?: string;
  };
  timezone?: string;
  network_isolation?: "host" | "strict";
  experimental?: { legacy_pty?: boolean; legacy_autoaccept_expect?: boolean };
  litellm?: {
    enabled?: boolean;
    base_url?: string;
    small_fast_model?: string;
    tags?: Record<string, string>;
  };
}

function makeConfig(
  agents: Record<string, MakeConfigAgent>,
  topLevel?: {
    host_control?: { enabled?: boolean };
    timezone?: string;
    litellm?: {
      enabled?: boolean;
      base_url?: string;
      admin_key?: string;
      team?: string;
      small_fast_model?: string;
    };
  },
): SwitchroomConfig {
  return {
    switchroom: {
      version: 1,
      agents_dir: "~/.switchroom/agents",
      skills_dir: "~/.switchroom/skills",
      timezone: topLevel?.timezone,
    },
    telegram: { bot_token: "x" },
    defaults: undefined,
    profiles: undefined,
    agents: Object.fromEntries(
      Object.entries(agents).map(([name, cfg]) => [
        name,
        {
          extends: cfg.extends,
          settings_raw: cfg.settings_raw,
          admin: cfg.admin,
          root: cfg.root,
          env: cfg.env,
          model: cfg.model,
          bind_mounts: cfg.bind_mounts,
          resources: cfg.resources,
          timezone: cfg.timezone,
          network_isolation: cfg.network_isolation,
          experimental: cfg.experimental,
          litellm: cfg.litellm,
          schedule: [],
          tools: { allow: [], deny: [] },
          hooks: undefined,
          channels: undefined,
        } as unknown as SwitchroomConfig["agents"][string],
      ]),
    ),
    drive: undefined as unknown as SwitchroomConfig["drive"],
    host_control: topLevel?.host_control,
    litellm: topLevel?.litellm,
  } as unknown as SwitchroomConfig;
}

// Discover a real colliding name pair deterministically (don't
// hard-code a brittle SHA-derived pair). 999 UID buckets → a scan of
// a few hundred candidates always finds one (birthday paradox).
function findCollidingPair(): [string, string] {
  const seen = new Map<number, string>();
  for (let i = 0; i < 20000; i++) {
    const name = `coll-agent-${i}`;
    const uid = allocateAgentUid(name);
    const prev = seen.get(uid);
    if (prev) return [prev, name];
    seen.set(uid, name);
  }
  throw new Error("no collision found in 20000 candidates (impossible for 999 buckets)");
}

/**
 * Split a generated compose file into the services it emits and the subset
 * of those that carry `switchroom.fleet: "<fleet>"`.
 *
 * Both arrays come back sorted so callers assert a SET, not emit order.
 * Counting label lines (the pre-#4637 shape) reports drift as
 * `expected 5 to be 4`, which names nothing and cannot tell "a new service
 * arrived" from "a service lost its label"; comparing the two arrays does
 * both, and vitest prints the offending name in the diff.
 *
 * Parsing is intentionally structural: service keys are the 2-space-indented
 * mapping keys under the top-level `services:` block, and a label line binds
 * to the service key that most recently opened.
 *
 * EMIT SHAPE THIS HELPER PINS. It pattern-matches generated text, so it is
 * coupled to how `src/agents/compose.ts` emits a service block. The contract,
 * and why each clause is load-bearing:
 *
 *   1. A top-level block opens at column 0 (`name:`, `services:`, `volumes:`,
 *      `networks:` — compose.ts:1515, :1517, :2075, :2134). Only lines after
 *      `services:` and before the next column-0 line count. That gate is what
 *      keeps the volume and network keys (compose.ts:2077-2136) — also
 *      2-space-indented and colon-terminated — out of `all`.
 *   2. A service key is EXACTLY 2 spaces of indent, the name, a colon, then
 *      nothing but optional trailing whitespace: the shape
 *      `lines.push(`  <name>:`)` produces. Emit sites are compose.ts:642
 *      (voice-sidecar), :1520 (vault-broker), :1769 (approval-kernel),
 *      :1862 (switchroom-auth-broker) and :2178 (agent-<name>).
 *   3. Indentation ALONE separates a service key from a nested mapping key of
 *      the same textual form. The 6-space `vault-broker:` under `depends_on:`
 *      (compose.ts:2274-2282) is byte-identical but for its indent; the
 *      `^ {2}` anchor is the only thing excluding it.
 *
 * Change any of those emit sites and this helper must change with them. A
 * GLOBAL clause-2 break (every emit site moving at once) empties `all`, which
 * would make callers assert over an empty set instead of failing
 * (`expect(labelled).toEqual(all)` is trivially true when both are empty) — so
 * the helper hard-fails on a zero-service parse. A SINGLE-SITE break leaves
 * `all` non-empty and slips past that guard silently; it is caught only by the
 * call sites' explicit `expect(all).toEqual([...])` name lists, which is why
 * those lists must stay explicit rather than degrade into a length or set
 * check. generateCompose emits the vault-broker singleton unconditionally
 * (compose.ts:1520), so zero services always means the PARSER broke, never the
 * input.
 */
function servicesByFleetLabel(
  yaml: string,
  fleet: string,
): { all: string[]; labelled: string[] } {
  const all: string[] = [];
  const labelled: string[] = [];
  let inServices = false;
  let current: string | null = null;
  for (const line of yaml.split("\n")) {
    // A non-indented, non-comment line opens a new top-level block
    // (`services:`, `volumes:`, ...).
    if (/^[^\s#]/.test(line)) {
      inServices = line.startsWith("services:");
      current = null;
      continue;
    }
    if (!inServices) continue;
    const key = /^ {2}([A-Za-z0-9._-]+):\s*$/.exec(line);
    if (key) {
      current = key[1];
      all.push(current);
      continue;
    }
    if (current && line.trim() === `switchroom.fleet: "${fleet}"`) {
      labelled.push(current);
    }
  }
  // Fail loudly on a vacuous parse. See clause 2/3 above: the only way a
  // generated compose has no services is that the emit shape moved out from
  // under this matcher.
  if (all.length === 0) {
    throw new Error(
      "servicesByFleetLabel parsed 0 services — generateCompose always emits " +
        "at least `  vault-broker:` (src/agents/compose.ts:1520), so the " +
        "service emit shape this helper pins has changed. Update the matcher " +
        "and the docblock above it.",
    );
  }
  return { all: all.sort(), labelled: labelled.sort() };
}

describe("assertNoAgentUidCollision — sec WS6-F4 (#1419)", () => {
  it("passes for a distinct-UID fleet", () => {
    expect(() =>
      assertNoAgentUidCollision(makeConfig({ klanker: {}, bob: {} })),
    ).not.toThrow();
  });

  it("HARD-FAILS (not warn) when two agents share a UID", () => {
    const [a, b] = findCollidingPair();
    expect(allocateAgentUid(a)).toBe(allocateAgentUid(b));
    expect(() =>
      assertNoAgentUidCollision(makeConfig({ [a]: {}, [b]: {} })),
    ).toThrow(/UID collision.*WS6-F4|WS6-F4.*collision/s);
  });

  it("generateCompose refuses to emit on a collision (fail-closed)", () => {
    const [a, b] = findCollidingPair();
    expect(() =>
      generateCompose({ config: makeConfig({ [a]: {}, [b]: {} }) }),
    ).toThrow(/UID collision/);
    // …and still emits normally for a clean fleet.
    expect(() =>
      generateCompose({ config: makeConfig({ klanker: {}, bob: {} }) }),
    ).not.toThrow();
  });
});

describe("resolveConfigMountSource — config bind source must be a HOST path (2026-06-11 outage)", () => {
  const HOME = "/home/op";
  const CANON = `${HOME}/.switchroom/switchroom.yaml`;

  it("undefined → undefined (back-compat: no config mount)", () => {
    expect(resolveConfigMountSource(undefined, HOME)).toBeUndefined();
  });
  it("a real host path passes through untouched", () => {
    expect(resolveConfigMountSource(CANON, HOME)).toBe(CANON);
    expect(resolveConfigMountSource("/home/op/custom/switchroom.yaml", HOME)).toBe("/home/op/custom/switchroom.yaml");
  });
  it("the in-container config path → canonical host path (the bug: apply run inside a container)", () => {
    expect(resolveConfigMountSource(CONTAINER_CONFIG_PATH, HOME)).toBe(CANON);
    expect(resolveConfigMountSource("/state/config/switchroom.yaml", HOME)).toBe(CANON);
  });
  it("any /state/… container path → canonical host path", () => {
    expect(resolveConfigMountSource("/state/whatever.yaml", HOME)).toBe(CANON);
  });
});

describe("generateCompose config mount is never a container path", () => {
  it("rewrites a container-path switchroomConfigPath to the host source (broker/kernel/auth-broker)", () => {
    const yaml = generateCompose({
      config: makeConfig({ klanker: {} }),
      homeDir: "/home/op",
      // Simulate `apply` running inside a container: the running process reads
      // its config from the in-container path. This must NOT leak into a bind
      // source — that auto-created an empty host dir → EISDIR broker crash.
      switchroomConfigPath: "/state/config/switchroom.yaml",
    });
    // No bind line uses the container path as a SOURCE…
    expect(yaml).not.toMatch(/- \/state\/config\/switchroom\.yaml:\/state\/config\/switchroom\.yaml/);
    // …and the config IS mounted from the canonical host path.
    expect(yaml).toContain("/home/op/.switchroom/switchroom.yaml:/state/config/switchroom.yaml:ro");
  });

  it("preserves a genuine host switchroomConfigPath as the source", () => {
    const yaml = generateCompose({
      config: makeConfig({ klanker: {} }),
      homeDir: "/home/op",
      switchroomConfigPath: "/home/op/.switchroom/switchroom.yaml",
    });
    expect(yaml).toContain("/home/op/.switchroom/switchroom.yaml:/state/config/switchroom.yaml:ro");
  });
});

describe("generateCompose — refuses a /host-home prefix (2026-06-11/12 fleet outages)", () => {
  it("throws when homeDir is the in-container host-home mount point", () => {
    // homedir() inside the hostd container returns /host-home when
    // SWITCHROOM_HOST_HOME is unset — emitting it as a bind source killed the
    // fleet (agent scaffold mount empty → start.sh missing → exec 127; broker
    // EISDIR). The generator must fail loud, not produce a fleet-killer.
    expect(() =>
      generateCompose({ config: makeConfig({ klanker: {} }), homeDir: "/host-home" }),
    ).toThrow(/in-container mount point|host path/i);
  });
  it("throws for any path under /host-home/", () => {
    expect(() =>
      generateCompose({ config: makeConfig({ klanker: {} }), homeDir: "/host-home/nested" }),
    ).toThrow(/host-home/);
  });
  it("accepts a real host home", () => {
    expect(() =>
      generateCompose({
        config: makeConfig({ klanker: {} }),
        homeDir: "/home/op",
        switchroomConfigPath: "/home/op/.switchroom/switchroom.yaml",
      }),
    ).not.toThrow();
  });
});

describe("generateCompose — refuses /state/agent/home prefix (2026-06-23 fleet outage)", () => {
  it("throws when homeDir is /state/agent/home — the agent container HOME", () => {
    // The 2026-06-23 outage: a deploy ran inside an agent container whose HOME
    // was /state/agent/home. With SWITCHROOM_HOST_HOME unset the generator fell
    // back to homedir() = /state/agent/home and baked it as the bind-mount
    // source prefix. Docker auto-created empty root-owned dirs at those paths on
    // the host → vault-broker couldn't open switchroom.yaml (EISDIR), grants DB
    // became a directory (SQLite "unable to open"), fleet dead.
    // assertPlausibleHostHome must catch /state/agent/home — the original
    // /host-home-only guard let it sail through.
    expect(() =>
      generateCompose({ config: makeConfig({ klanker: {} }), homeDir: "/state/agent/home" }),
    ).toThrow();
  });
  it("throws for the /state parent prefix", () => {
    expect(() =>
      generateCompose({ config: makeConfig({ klanker: {} }), homeDir: "/state" }),
    ).toThrow();
  });
  it("throws for arbitrary /state/… sub-paths", () => {
    expect(() =>
      generateCompose({ config: makeConfig({ klanker: {} }), homeDir: "/state/config" }),
    ).toThrow();
  });
});

describe("allocateAgentUid", () => {
  it("returns UID in the reserved range", () => {
    for (const name of ["klanker", "coach", "finn", "ziggy", "alpha", "z9"]) {
      const uid = allocateAgentUid(name);
      expect(uid).toBeGreaterThanOrEqual(AGENT_UID_MIN);
      expect(uid).toBeLessThanOrEqual(AGENT_UID_MAX);
    }
  });

  it("is deterministic across calls", () => {
    expect(allocateAgentUid("klanker")).toBe(allocateAgentUid("klanker"));
    expect(allocateAgentUid("coach")).toBe(allocateAgentUid("coach"));
  });

  it("differs across distinct names (probabilistically — sanity)", () => {
    const uids = new Set(["a", "b", "c", "d", "e"].map(allocateAgentUid));
    expect(uids.size).toBeGreaterThan(1);
  });
});

describe("generateCompose", () => {
  it("handles an empty fleet", () => {
    const out = generateCompose({ config: makeConfig({}) });
    expect(out).toContain("vault-broker:");
    expect(out).toContain("approval-kernel:");
    // The switchroom-cron singleton was removed in Phase 4 (cron-fold-in
    // cutover) — every agent runs cron in-container now. The compose
    // file should NOT emit a singleton scheduler service.
    expect(out).not.toContain("switchroom-cron");
    expect(out).not.toContain("agent-");
  });

  it("emits a single agent", () => {
    const out = generateCompose({ config: makeConfig({ coach: {} }) });
    expect(out).toContain("agent-coach:");
    expect(out).toContain("container_name: switchroom-coach");
  });

  it("defaults container_name prefix to 'switchroom' (production behavior)", () => {
    const out = generateCompose({ config: makeConfig({ coach: {} }) });
    expect(out).toContain("container_name: switchroom-vault-broker");
    expect(out).toContain("container_name: switchroom-approval-kernel");
    expect(out).toContain("container_name: switchroom-coach");
  });

  it("honors containerNamePrefix override (test prod-safety guard)", () => {
    // Phase tests pass their own per-pid project name to keep singleton
    // names from colliding with a live production fleet on a shared
    // host. See tests/docker/_prod-snapshot.ts:productionFleetIsLive
    // for the broader story.
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }),
      containerNamePrefix: "phase1c-iso-12345",
    });
    expect(out).toContain("container_name: phase1c-iso-12345-vault-broker");
    expect(out).toContain("container_name: phase1c-iso-12345-approval-kernel");
    expect(out).toContain("container_name: phase1c-iso-12345-alice");
    expect(out).toContain("container_name: phase1c-iso-12345-bob");
    // Prefix MUST NOT leak into compose project name, service keys,
    // or socket paths — those stay fixed on the production shape so
    // operator tooling and runtime contracts don't drift.
    expect(out).toContain("name: switchroom\n");
    expect(out).toContain("  vault-broker:");
    expect(out).toContain("  approval-kernel:");
    // Per-agent broker volume mount on the broker side stays
    // `/run/switchroom/broker/<agent>` regardless of the
    // containerNamePrefix — it's the broker's view, not a name. The
    // per-agent socket file (`<dir>/sock`) is created by the broker at
    // runtime, not emitted into the compose YAML.
    expect(out).toContain("broker-alice-sock:/run/switchroom/broker/alice");
    // The fleet label IS parametrized (PR #939 follow-up): test
    // fleets carry switchroom.fleet=<prefix>, so a parallel vitest
    // fork's productionFleetIsLive() filter on switchroom.fleet=
    // switchroom doesn't false-positive on a sibling test fleet.
    expect(out).toContain('switchroom.fleet: "phase1c-iso-12345"');
    expect(out).not.toContain('switchroom.fleet: "switchroom"');
  });

  // Critical for productionFleetIsLive() to keep working: the default-emit
  // path MUST stamp `switchroom.fleet=switchroom` on EVERY service so
  // `docker ps --filter label=switchroom.fleet=switchroom` finds them.
  //
  // Both cases pin `voiceEngine` explicitly. Omitting it sends the generator
  // down `opts.voiceEngine ?? loadHostCapabilities()?.voice.engine ??
  // "cloud"` (src/agents/compose.ts), which reads the DEVELOPER'S
  // ~/.switchroom/host-capabilities.json — so on a GPU box the extra
  // `voice-sidecar` service appeared and the old count assertion failed with
  // `expected 5 to be 4` (#4637). Pinning the option is what the option is
  // for, and asserting the service SET (not a magic count) means the next
  // drift fails with a diff that NAMES the service that arrived or lost its
  // label.
  it("default containerNamePrefix labels every service — cloud verdict", () => {
    const out = generateCompose({
      config: makeConfig({ coach: {} }),
      voiceEngine: "cloud",
    });
    const { all, labelled } = servicesByFleetLabel(out, "switchroom");
    expect(all).toEqual([
      "agent-coach",
      "approval-kernel",
      "switchroom-auth-broker",
      "vault-broker",
    ]);
    expect(labelled).toEqual(all);
  });

  // The `local` companion: nothing else covers that the OPTIONAL service is
  // labelled at all, and productionFleetIsLive() depends on it being found.
  it("default containerNamePrefix labels the voice-sidecar too — local verdict", () => {
    const out = generateCompose({
      config: makeConfig({ coach: {} }),
      voiceEngine: "local",
    });
    const { all, labelled } = servicesByFleetLabel(out, "switchroom");
    expect(all).toEqual([
      "agent-coach",
      "approval-kernel",
      "switchroom-auth-broker",
      "vault-broker",
      "voice-sidecar",
    ]);
    expect(labelled).toEqual(all);
  });

  it("emits agents in sorted order", () => {
    const out = generateCompose({ config: makeConfig({ zebra: {}, alpha: {}, mango: {} }) });
    const a = out.indexOf("agent-alpha:");
    const m = out.indexOf("agent-mango:");
    const z = out.indexOf("agent-zebra:");
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(m);
    expect(m).toBeLessThan(z);
  });

  it("klanker gets 8g/4g reservation, 2000 PIDs, 2.0 cpus", () => {
    const out = generateCompose({ config: makeConfig({ klanker: {} }) });
    expect(out).toMatch(/agent-klanker:[\s\S]*?mem_limit: 8g/);
    expect(out).toMatch(/agent-klanker:[\s\S]*?mem_reservation: 4g/);
    expect(out).toMatch(/agent-klanker:[\s\S]*?pids_limit: 2000/);
    expect(out).toMatch(/agent-klanker:[\s\S]*?cpus: 2\.0/);
  });

  it("conversational profile → 3g/256m, 500 PIDs, 1.0", () => {
    const out = generateCompose({ config: makeConfig({ coach: { extends: "conversational" } }) });
    expect(out).toMatch(/agent-coach:[\s\S]*?mem_limit: 3g/);
    expect(out).toMatch(/agent-coach:[\s\S]*?mem_reservation: 256m/);
    expect(out).toMatch(/agent-coach:[\s\S]*?pids_limit: 500/);
    expect(out).toMatch(/agent-coach:[\s\S]*?cpus: 1\.0/);
  });

  it("lightweight profile → 1g/128m, 500 PIDs, 0.5", () => {
    const out = generateCompose({ config: makeConfig({ ziggy: { extends: "lightweight" } }) });
    expect(out).toMatch(/agent-ziggy:[\s\S]*?mem_limit: 1g/);
    expect(out).toMatch(/agent-ziggy:[\s\S]*?mem_reservation: 128m/);
    expect(out).toMatch(/agent-ziggy:[\s\S]*?pids_limit: 500/);
    expect(out).toMatch(/agent-ziggy:[\s\S]*?cpus: 0\.5/);
  });

  it("coding profile → 4g/512m, 1000 PIDs, 2.0", () => {
    const out = generateCompose({ config: makeConfig({ worker: { extends: "coding" } }) });
    expect(out).toMatch(/agent-worker:[\s\S]*?mem_limit: 4g/);
    expect(out).toMatch(/agent-worker:[\s\S]*?mem_reservation: 512m/);
    expect(out).toMatch(/agent-worker:[\s\S]*?pids_limit: 1000/);
    expect(out).toMatch(/agent-worker:[\s\S]*?cpus: 2\.0/);
  });

  it("unknown profile → default 3g/256m, 500 PIDs, 1.0", () => {
    const out = generateCompose({ config: makeConfig({ misc: { extends: "made-up" } }) });
    expect(out).toMatch(/agent-misc:[\s\S]*?mem_limit: 3g/);
    expect(out).toMatch(/agent-misc:[\s\S]*?mem_reservation: 256m/);
    expect(out).toMatch(/agent-misc:[\s\S]*?pids_limit: 500/);
    expect(out).toMatch(/agent-misc:[\s\S]*?cpus: 1\.0/);
  });

  it("SWITCHROOM_AGENT_PROFILE env = the agent's profile (LiteLLM profile: spend tag)", () => {
    // Regression: start.sh.hbs / cron-session.sh.hbs emit
    // `profile:${SWITCHROOM_AGENT_PROFILE:-default}` but the env var was
    // never written, so the per-profile spend tag was always "default".
    const out = generateCompose({ config: makeConfig({ worker: { extends: "coding" } }) });
    expect(out).toMatch(/agent-worker:[\s\S]*?SWITCHROOM_AGENT_PROFILE: "coding"/);
  });

  it("SWITCHROOM_AGENT_PROFILE defaults to 'default' when no extends set", () => {
    const out = generateCompose({ config: makeConfig({ misc: {} }) });
    expect(out).toMatch(/agent-misc:[\s\S]*?SWITCHROOM_AGENT_PROFILE: "default"/);
  });

  it("agent.resources.memory overrides the profile default", () => {
    const out = generateCompose({
      config: makeConfig({ tiny: { extends: "conversational", resources: { memory: "512m" } } }),
    });
    expect(out).toMatch(/agent-tiny:[\s\S]*?mem_limit: 512m/);
    // cpus still falls back to the profile default (1.0 for conversational)
    expect(out).toMatch(/agent-tiny:[\s\S]*?cpus: 1\.0/);
  });

  it("agent.resources.memory_reservation emits mem_reservation under the agent service", () => {
    const out = generateCompose({
      config: makeConfig({
        klanker: { resources: { memory_reservation: "4g" } },
      }),
    });
    expect(out).toMatch(/agent-klanker:[\s\S]*?mem_reservation: 4g/);
    // and the existing mem_limit/cpus are still emitted
    expect(out).toMatch(/agent-klanker:[\s\S]*?mem_limit: 8g/);
    expect(out).toMatch(/agent-klanker:[\s\S]*?cpus: 2\.0/);
  });

  it("agent.resources.pids_limit emits pids_limit under the agent service", () => {
    const out = generateCompose({
      config: makeConfig({ klanker: { resources: { pids_limit: 2000 } } }),
    });
    expect(out).toMatch(/agent-klanker:[\s\S]*?pids_limit: 2000/);
  });

  // NOTE: the pre-PR β "absent when unset" test was removed because every
  // entry in RESOURCE_BY_PROFILE now ships with memReservation and
  // pidsLimit defaults. The emission code in compose.ts is still
  // conditional (`if (memReservation !== undefined)`) so a future
  // profile entry that omits the fields would still emit minimal
  // output — but constructing a config that exercises that path would
  // require mocking the resource table, which is testing implementation
  // not behavior. The conditional emission is implicitly covered by
  // the agent-override tests (which set only one of the new fields and
  // assert the other ISN'T emitted in some shape).

  it("defaults.resources cascades down to per-agent (per-field merge with agent winning)", () => {
    // defaults.resources sets pids_limit; agent.resources sets memory.
    // Resolved should have BOTH applied.
    const config = makeConfig({ coach: { extends: "conversational", resources: { memory: "768m" } } });
    config.defaults = { ...(config.defaults ?? {}), resources: { pids_limit: 500 } };
    const out = generateCompose({ config });
    expect(out).toMatch(/agent-coach:[\s\S]*?mem_limit: 768m/);
    expect(out).toMatch(/agent-coach:[\s\S]*?pids_limit: 500/);
    expect(out).toMatch(/agent-coach:[\s\S]*?cpus: 1\.0/);
  });

  it("profile.resources (inline profile) cascades down to per-agent", () => {
    // Inline profile sets memory_reservation; the agent extends it.
    // resolveAgentConfig folds profile through mergeAgentConfig, which
    // means our resources cascade clause must apply at the profile
    // layer too (not just defaults). Pin it.
    const config = makeConfig({ alice: { extends: "tight" } });
    config.profiles = {
      tight: { resources: { memory_reservation: "192m", pids_limit: 300 } },
    } as unknown as typeof config.profiles;
    const out = generateCompose({ config });
    expect(out).toMatch(/agent-alice:[\s\S]*?mem_reservation: 192m/);
    expect(out).toMatch(/agent-alice:[\s\S]*?pids_limit: 300/);
    // memory still defaults — "tight" isn't in RESOURCE_BY_PROFILE so
    // it falls through to the catch-all default 3g.
    expect(out).toMatch(/agent-alice:[\s\S]*?mem_limit: 3g/);
  });

  it("agent.resources.cpus overrides profile (fractional accepted)", () => {
    const out = generateCompose({
      config: makeConfig({ ziggy: { extends: "lightweight", resources: { cpus: 0.25 } } }),
    });
    expect(out).toMatch(/agent-ziggy:[\s\S]*?cpus: 0\.3/); // toFixed(1) rounds
    expect(out).toMatch(/agent-ziggy:[\s\S]*?mem_limit: 1g/); // unchanged
  });

  // --- /tmp tmpfs sizing (resources.tmp_size) ---
  //
  // The size used to be hard-coded `1g` at the emit site with no way to
  // change it short of hand-editing generated compose (which `apply`
  // overwrites). It is now cascade-resolved, defaulting to
  // DEFAULT_TMP_SIZE (2g).

  it("emits DEFAULT_TMP_SIZE for an agent with no tmp_size anywhere", () => {
    const out = generateCompose({ config: makeConfig({ coach: { extends: "conversational" } }) });
    expect(out).toMatch(
      new RegExp(`agent-coach:[\\s\\S]*?- /tmp:size=${DEFAULT_TMP_SIZE},mode=1777`),
    );
  });

  it("the fleet-wide /tmp default is 2g (pin — a silent bump must fail here)", () => {
    // Raised from 1g on 2026-07-27: overlord hit 90% of a 1.0 GiB /tmp
    // (917M used) from concurrent sub-agent repo clones + bun caches.
    expect(DEFAULT_TMP_SIZE).toBe("2g");
    const out = generateCompose({ config: makeConfig({ solo: {} }) });
    expect(out).toContain("- /tmp:size=2g,mode=1777");
    expect(out).not.toContain("- /tmp:size=1g,mode=1777");
  });

  it("agent.resources.tmp_size overrides it for THAT agent only", () => {
    const out = generateCompose({
      config: makeConfig({
        big: { extends: "coding", resources: { tmp_size: "8g" } },
        small: { extends: "coding" },
      }),
    });
    expect(out).toMatch(/agent-big:[\s\S]*?- \/tmp:size=8g,mode=1777/);
    // The non-overridden sibling still gets the default — proves the
    // override is scoped, not a global mutation.
    expect(out).toMatch(/agent-small:[\s\S]*?- \/tmp:size=2g,mode=1777/);
    // Unrelated resource fields untouched by the new knob.
    expect(out).toMatch(/agent-big:[\s\S]*?mem_limit: 4g/);
  });

  it("defaults.resources.tmp_size cascades, and per-agent wins over it", () => {
    const config = makeConfig({
      pinned: { resources: { tmp_size: "512m" } },
      inherits: {},
    });
    config.defaults = { ...(config.defaults ?? {}), resources: { tmp_size: "4g" } };
    const out = generateCompose({ config });
    expect(out).toMatch(/agent-inherits:[\s\S]*?- \/tmp:size=4g,mode=1777/);
    expect(out).toMatch(/agent-pinned:[\s\S]*?- \/tmp:size=512m,mode=1777/);
  });

  it("profile.resources.tmp_size cascades to agents extending it", () => {
    const config = makeConfig({ alice: { extends: "roomy" } });
    config.profiles = {
      roomy: { resources: { tmp_size: "6g" } },
    } as unknown as typeof config.profiles;
    const out = generateCompose({ config });
    expect(out).toMatch(/agent-alice:[\s\S]*?- \/tmp:size=6g,mode=1777/);
  });

  it("root-tier agents (no hardening block) still get the resolved tmp_size", () => {
    // The root agent skips security_opt/cap_drop/read_only but NOT tmpfs;
    // the emit site sits outside that `if (!a.root)` branch.
    const out = generateCompose({
      config: makeConfig({ overseer: { root: true, resources: { tmp_size: "16g" } } }),
    });
    expect(out).toMatch(/agent-overseer:[\s\S]*?- \/tmp:size=16g,mode=1777/);
  });

  it("strips cap_add and emits a warning", () => {
    const warns: string[] = [];
    const out = generateCompose({
      config: makeConfig({ rogue: { settings_raw: { cap_add: ["SYS_ADMIN", "NET_ADMIN"] } } }),
      warn: (m) => warns.push(m),
    });
    // The agent service must not contain cap_add or the smuggled caps.
    const agentBlock = /agent-rogue:[\s\S]*?(?=\n  agent-|\nvolumes:|$)/.exec(out)?.[0] ?? "";
    expect(agentBlock).not.toContain("cap_add");
    expect(agentBlock).not.toContain("SYS_ADMIN");
    expect(out).not.toContain("SYS_ADMIN");
    expect(out).not.toContain("NET_ADMIN");
    expect(warns.some((w) => /cap_add/.test(w) && /rogue/.test(w))).toBe(true);
  });

  it("each agent mounts ONLY its own broker socket volume", () => {
    // NB: "c" hashes to the same UID as "a" (10939) — pre-#1419 this
    // fixture silently demonstrated the exact WS6-F4 collision; the
    // new hard-fail guard rejects it. Use "d" (distinct UID) so the
    // test exercises the broker-socket scoping, not the guard.
    const out = generateCompose({ config: makeConfig({ a: {}, b: {}, d: {} }) });
    // Pull the volumes block of agent-a; it must only mention broker-a-sock.
    const aBlock = /agent-a:[\s\S]*?(?=\n  agent-|\nvolumes:)/.exec(out)?.[0] ?? "";
    expect(aBlock).toContain("broker-a-sock");
    expect(aBlock).not.toContain("broker-b-sock");
    expect(aBlock).not.toContain("broker-d-sock");
  });

  it("byte-determinism: same input → same output", () => {
    const cfg = makeConfig({ klanker: {}, coach: { extends: "conversational" } });
    const a = generateCompose({ config: cfg });
    const b = generateCompose({ config: cfg });
    expect(a).toBe(b);
  });

  it("input order independence", () => {
    const a = generateCompose({ config: makeConfig({ alpha: {}, zebra: {} }) });
    const b = generateCompose({ config: makeConfig({ zebra: {}, alpha: {} }) });
    expect(a).toBe(b);
  });

  it("emits stop_grace_period 45s on every agent", () => {
    const out = generateCompose({ config: makeConfig({ a: {}, b: {} }) });
    const matches = out.match(/stop_grace_period: 45s/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("does NOT emit a singleton scheduler service or docker.sock mount (Phase 4 cutover)", () => {
    const out = generateCompose({ config: makeConfig({ alice: {} }) });
    expect(out).not.toContain("switchroom-cron");
    // No service mounts the docker daemon socket — the singleton was
    // the only thing that needed it (`docker exec claude -p`). Every
    // agent now runs cron in-container against the gateway's IPC.
    expect(out).not.toContain("/var/run/docker.sock");
  });

  it("emits per-agent named volumes for broker AND kernel", () => {
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    expect(out).toMatch(/^volumes:\s*$/m);
    expect(out).toContain("broker-a-sock:");
    expect(out).toContain("kernel-a-sock:");
  });

  // ── regression: tilde in volume sources ────────────────────────────
  // Docker Compose does NOT expand ~ in volume sources; it creates a
  // literal "./~/..." directory. We must emit ${HOME}/... so compose's
  // env-var interpolation handles it.
  it("never emits a tilde in any volume source", () => {
    const out = generateCompose({
      config: makeConfig({ klanker: {}, coach: { extends: "conversational" } }),
    });
    // Any line that mentions a host-path volume mount (the source side
    // of a bind mount) must not start the source with "~/".
    for (const line of out.split("\n")) {
      const m = /^\s*-\s+([^:]+):/.exec(line);
      if (!m) continue;
      const source = m[1]!;
      expect(source, `tilde in volume source: ${line}`).not.toMatch(/^~/);
    }
    // And there should be no bare ~ anywhere on a volume line.
    const tildeLines = out.split("\n").filter((l) => /^\s+-\s+~/.test(l));
    expect(tildeLines).toEqual([]);
  });

  it("uses ${HOME} for host-path bind mounts when no homeDir is given", () => {
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    // v0.7.12: vault parent dir bind-mounted RW (was single-file `:ro`
    // pre-fix; that prevented atomic-rename → broker writes EBUSY-d).
    // Plan v3 §3 — broker reads /state/vault/vault.enc.
    expect(out).toContain("${HOME}/.switchroom/vault:/state/vault:rw");
    // The legacy single-file mount is gone.
    expect(out).not.toContain("vault.enc:/state/vault.enc");
    expect(out).toContain("${HOME}/.switchroom/approvals:/state/approvals");
    // The legacy `~/.switchroom:/state/config:ro` directory mount used
    // to be emitted on the singleton scheduler when no explicit
    // switchroomConfigPath was given. Phase 4 removed that singleton.
    expect(out).not.toContain("${HOME}/.switchroom:/state/config:ro");
    expect(out).toContain("${HOME}/.switchroom/agents/a:/state/agent");
    // Same-path dual mount for agents — see compose.ts for the rationale
    // (start.sh bakes host paths at scaffold time, so the same paths
    // must resolve inside the container).
    expect(out).toContain("${HOME}/.switchroom/agents/a:${HOME}/.switchroom/agents/a");
  });

  it("v0.7.12 vault layout: parent-dir RW mount + canonical inner path", () => {
    // Plan v3 §3: broker mounts the vault PARENT DIRECTORY RW (not
    // the file directly). atomicWriteFileSync's write-temp-then-
    // rename works because temp + dest are on the same fs. Inside
    // the broker the vault is at /state/vault/vault.enc.
    const out = generateCompose({
      config: makeConfig({ a: {} }),
      homeDir: "/home/op",
    });
    // The mount line uses :rw and points at the parent dir.
    expect(out).toContain("/home/op/.switchroom/vault:/state/vault:rw");
    // The broker reads the canonical inner path.
    expect(out).toContain("SWITCHROOM_VAULT_PATH: /state/vault/vault.enc");
    // Pre-v0.7.12 single-file mount must NOT appear.
    expect(out).not.toMatch(/vault\.enc:\/state\/vault\.enc/);
    expect(out).not.toMatch(/SWITCHROOM_VAULT_PATH:\s*\/state\/vault\.enc[^/]/);
  });

  it("bakes the absolute homeDir into bind sources when given (sudo-safe)", () => {
    // Why: under `sudo docker compose`, ${HOME} resolves to /root, not
    // the operator's home. apply.ts passes os.homedir() so the YAML
    // captures the right path independent of who runs compose.
    const out = generateCompose({
      config: makeConfig({ a: {} }),
      homeDir: "/home/op",
    });
    expect(out).toContain("/home/op/.switchroom/vault:/state/vault:rw");
    expect(out).not.toContain("/home/op/.switchroom/vault.enc:/state/vault.enc");
    expect(out).toContain("/home/op/.switchroom/approvals:/state/approvals");
    // The legacy scheduler-only `:/state/config:ro` directory mount
    // is gone since Phase 4.
    expect(out).not.toContain("/home/op/.switchroom:/state/config:ro");
    // Dual mount: canonical /state/agent path AND same-path host path.
    expect(out).toContain("/home/op/.switchroom/agents/a:/state/agent");
    expect(out).toContain("/home/op/.switchroom/agents/a:/home/op/.switchroom/agents/a");
    expect(out).toContain("/home/op/.switchroom/logs/a:/var/log/switchroom");
    expect(out).toContain("/home/op/.switchroom/logs/a:/home/op/.switchroom/logs/a");
    expect(out).toContain("/home/op/.claude/projects/a:/state/.claude");
    expect(out).toContain("/home/op/.claude/projects/a:/home/op/.claude/projects/a");
    expect(out).not.toContain("${HOME}");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The blocked-approvals surface (#3084 follow-up). When an approval card
  // can't be delivered, the gateway HOLDS the approval — it never auto-denies —
  // and writes a world-readable record into this SHARED dir so the operator can
  // see the block without Telegram. Every agent gets the mount, which makes it
  // the highest-blast-radius line in this generator: on 2026-06-23 a bind source
  // whose root resolved to a CONTAINER path made docker auto-create root-owned
  // dirs, the brokers crashed, and the fleet stuck in `Created`.
  //
  // reference/jobs/approve-what-my-agent-can-touch.md
  // ───────────────────────────────────────────────────────────────────────────
  it("mounts the shared blocked-approvals dir for EVERY agent, under the host-home prefix", () => {
    const out = generateCompose({
      config: makeConfig({ a: {}, b: {} }),
      homeDir: "/home/op",
    });

    // Shared TOP-LEVEL dir, not per-agent state: switchroom-web reads every
    // agent's record from one place. Writable (:rw) — the agent writes it.
    const line = "/home/op/.switchroom/blocked-approvals:/state/blocked-approvals:rw";
    expect(out).toContain(line);
    // Once per agent. A record the gateway cannot write is a block the operator
    // never sees, so a missing mount on ANY agent is a silent hole.
    expect(out.split(line).length - 1).toBe(2);

    // The bind SOURCE is the host-home prefix — never a container path. This is
    // the 2026-06-23 outage in one assertion: a `/state/...` or `/host-home/...`
    // source root is what took the fleet down.
    expect(out).not.toContain("/state/agent/home/.switchroom/blocked-approvals");
    expect(out).not.toContain("/host-home/.switchroom/blocked-approvals:");
  });

  it("cannot emit a blocked-approvals mount rooted at a container path", () => {
    // assertPlausibleHostHome is the guard, and it fires BEFORE any line is
    // emitted — so the dangerous mount is unrepresentable, not merely unlikely.
    for (const bad of ["/state/agent/home", "/host-home", "/state"]) {
      expect(() =>
        generateCompose({ config: makeConfig({ a: {} }), homeDir: bad }),
      ).toThrow(/host-home prefix/);
    }
  });

  it("emits skills (fleet-wide) + PER-AGENT credentials :ro mount (sec WS6-F2)", async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "compose-mounts-"));
    mkdirSync(join(tmp, ".switchroom", "skills"), { recursive: true });
    // Per-agent credentials dir for agent "a" + a different agent's
    // dir that must NOT leak into "a" post-WS6-F2.
    mkdirSync(join(tmp, ".switchroom", "credentials", "a"), {
      recursive: true,
    });
    mkdirSync(join(tmp, ".switchroom", "credentials", "b-other"), {
      recursive: true,
    });
    try {
      const out = generateCompose({
        config: makeConfig({ a: {} }),
        homeDir: tmp,
      });
      // skills/ stays fleet-wide (operator-authored, non-secret).
      expect(out).toContain(
        `${tmp}/.switchroom/skills:${tmp}/.switchroom/skills:ro`,
      );
      // credentials are PER-AGENT: agent "a" sees only its own subdir,
      // mounted at the canonical flat in-container path.
      expect(out).toContain(
        `${tmp}/.switchroom/credentials/a:${tmp}/.switchroom/credentials:ro`,
      );
      // WS6-F2 regression guard: the OLD fleet-wide flat mount
      // (which let any agent read every other agent's/purpose's
      // credentials) must NEVER be emitted again, and agent "a" must
      // not receive b-other's dir.
      expect(out).not.toContain(
        `${tmp}/.switchroom/credentials:${tmp}/.switchroom/credentials:ro`,
      );
      expect(out).not.toContain(`/.switchroom/credentials/b-other`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("emits a per-agent :rw mount for ~/.switchroom-config/agents/<a>/personal-skills (#1846)", async () => {
    // Auto-mirror of personal skills (PR #1844) writes to
    // ~/.switchroom-config/agents/<agent>/personal-skills/. For the
    // dominant in-container caller to see that dir, the slice must
    // be bind-mounted into each agent container. Per-agent isolation
    // matches the audit-dir mount above.
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "compose-config-mirror-"));
    mkdirSync(join(tmp, ".switchroom-config"), { recursive: true });
    try {
      const out = generateCompose({
        config: makeConfig({ a: {}, b: {} }),
        homeDir: tmp,
      });
      // Agent "a" mounts ONLY its own slice.
      expect(out).toContain(
        `${tmp}/.switchroom-config/agents/a/personal-skills:${tmp}/.switchroom-config/agents/a/personal-skills:rw`,
      );
      // Agent "b" mounts ONLY its own slice.
      expect(out).toContain(
        `${tmp}/.switchroom-config/agents/b/personal-skills:${tmp}/.switchroom-config/agents/b/personal-skills:rw`,
      );
      // Agent "a" does NOT see agent "b"'s mirror.
      const lineA = out.split("\n").find((l) => l.includes("agent-b/personal-skills") && l.includes("agent-a"));
      expect(lineA).toBeUndefined();
      // The parent ~/.switchroom-config/ itself is NEVER mounted —
      // would leak every other agent's mirror + the operator's
      // switchroom.yaml etc. into each agent.
      expect(out).not.toContain(
        `${tmp}/.switchroom-config:${tmp}/.switchroom-config`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does NOT emit the config-mirror mount when operator hasn't opted in (#1846)", async () => {
    // Operator without ~/.switchroom-config/ → no mount line. Mirror
    // silently no-ops (vault-backup precedent: only when opted in).
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "compose-no-config-"));
    try {
      const out = generateCompose({
        config: makeConfig({ a: {} }),
        homeDir: tmp,
      });
      expect(out).not.toContain(".switchroom-config");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("emits a :ro mount for the operator's mcp-launchers/ dir when present (#1786 follow-up)", async () => {
    // Operators who declare user-level MCP servers with a host `command:`
    // path (e.g. defaults.mcp_servers.perplexity.command:
    // /home/<op>/.switchroom/mcp-launchers/perplexity-mcp.sh) need that
    // path to resolve INSIDE the agent container too — otherwise the
    // .mcp.json entry lands but the launcher ENOENTs at spawn. Same-
    // path :ro mount makes the operator's yaml command Just Work.
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "compose-mcp-launchers-"));
    mkdirSync(join(tmp, ".switchroom", "mcp-launchers"), { recursive: true });
    try {
      const out = generateCompose({
        config: makeConfig({ a: {} }),
        homeDir: tmp,
      });
      expect(out).toContain(
        `${tmp}/.switchroom/mcp-launchers:${tmp}/.switchroom/mcp-launchers:ro`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("omits the mcp-launchers mount when the host dir doesn't exist", async () => {
    // Same `:ro` source absent guard as skills/credentials — docker
    // compose `up` hard-fails on a missing source. Operators without
    // any user-declared command-based MCPs simply have no
    // ~/.switchroom/mcp-launchers/ dir; the mount must be omitted.
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "compose-no-launchers-"));
    try {
      const out = generateCompose({
        config: makeConfig({ a: {} }),
        homeDir: tmp,
      });
      expect(out).not.toContain(`/.switchroom/mcp-launchers`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("emits a :ro mount for the fleet dir when present (epic #1850 / issue #1852)", async () => {
    // The fleet directory holds the agent prompt cascade's lane 1
    // (release-pinned invariants) and lane 2 (operator-owned fleet
    // defaults). Reaches each agent's `claude` process via
    // `--add-dir ~/.switchroom/fleet` in start.sh.hbs — Claude Code
    // native CLAUDE.md auto-discovery loads the `.md` files from
    // there into the system prompt.
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "compose-fleet-"));
    mkdirSync(join(tmp, ".switchroom", "fleet"), { recursive: true });
    try {
      const out = generateCompose({
        config: makeConfig({ a: {} }),
        homeDir: tmp,
      });
      expect(out).toContain(
        `${tmp}/.switchroom/fleet:${tmp}/.switchroom/fleet:ro`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("omits the fleet mount when the host dir doesn't exist (pre-apply state)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "compose-no-fleet-"));
    try {
      const out = generateCompose({
        config: makeConfig({ a: {} }),
        homeDir: tmp,
      });
      expect(out).not.toContain(`/.switchroom/fleet`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("emits each mount independently when only one host dir exists (#907)", async () => {
    // Vault-only operators commonly have populated skills/ but no
    // filesystem credentials/ (everything via vault). The two
    // existsSync probes must be independent — emitting one mount
    // mustn't depend on the other being present.
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "compose-asym-"));
    mkdirSync(join(tmp, ".switchroom", "skills"), { recursive: true });
    try {
      const out = generateCompose({
        config: makeConfig({ a: {} }),
        homeDir: tmp,
      });
      expect(out).toContain(
        `${tmp}/.switchroom/skills:${tmp}/.switchroom/skills:ro`,
      );
      expect(out).not.toContain(`${tmp}/.switchroom/credentials`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("emits a :ro mount for the bundled-skills pool dir (dangling-skill fix)", async () => {
    // reconcileAgentDefaultSkills creates symlinks under
    // <agent>/.claude/skills/<key> pointing at the absolute host path
    // <poolDir>/<key>. Without mounting <poolDir> into the container,
    // those targets dangle (boot card shows "N/M dangling: skill-creator,
    // mcp-builder, ...").
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "compose-pool-"));
    const poolDir = join(tmp, "skills-pool");
    mkdirSync(poolDir, { recursive: true });
    try {
      const out = generateCompose({
        config: makeConfig({ a: {} }),
        homeDir: tmp,
        bundledSkillsPoolDir: poolDir,
      });
      expect(out).toContain(`${poolDir}:${poolDir}:ro`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("omits the bundled-skills pool mount when the dir doesn't exist", async () => {
    // Skip emission gracefully — docker compose `up` hard-fails on
    // missing `:ro` sources, and there are exotic test setups where the
    // pool path simply doesn't resolve to a real dir.
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "compose-no-pool-"));
    try {
      const out = generateCompose({
        config: makeConfig({ a: {} }),
        homeDir: tmp,
        bundledSkillsPoolDir: join(tmp, "does-not-exist"),
      });
      expect(out).not.toContain(`${tmp}/does-not-exist`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips the bundled-skills pool mount when it's already inside ~/.switchroom/skills", async () => {
    // If an operator has placed their bundled pool under
    // ~/.switchroom/skills (e.g. a custom packaging), the existing
    // operator-skills mount already covers it — emitting a second
    // identical-path entry would be a duplicate volume.
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "compose-pool-overlap-"));
    const opSkills = join(tmp, ".switchroom", "skills");
    const nestedPool = join(opSkills, "_builtin");
    mkdirSync(nestedPool, { recursive: true });
    try {
      const out = generateCompose({
        config: makeConfig({ a: {} }),
        homeDir: tmp,
        bundledSkillsPoolDir: nestedPool,
      });
      expect(out).toContain(`${opSkills}:${opSkills}:ro`);
      expect(out).not.toContain(`${nestedPool}:${nestedPool}:ro`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("omits skills/credentials mounts when host dirs are absent (#907)", async () => {
    // docker compose `up` hard-fails if a `:ro` source path is missing.
    // Many operators keep all secrets in vault and never create
    // `.switchroom/credentials/`; we must skip emission rather than
    // refuse to generate compose at all.
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "compose-no-mounts-"));
    try {
      const out = generateCompose({
        config: makeConfig({ a: {} }),
        homeDir: tmp,
      });
      expect(out).not.toContain(`${tmp}/.switchroom/skills`);
      expect(out).not.toContain(`${tmp}/.switchroom/credentials`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("emits webkite binary + cloakbrowser + config mounts when present", async () => {
    // Webkite binary is private-beta + operator-staged; cloakbrowser
    // chromium is shared across the fleet via a host bind mount; the
    // optional config.toml is operator-tunable defaults. All three are
    // existsSync-guarded — docker compose `up` hard-fails on a missing
    // `:ro` source.
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "compose-webkite-present-"));
    try {
      mkdirSync(join(tmp, ".switchroom", "bin"), { recursive: true });
      writeFileSync(join(tmp, ".switchroom", "bin", "webkite"), "#!/bin/sh\n");
      mkdirSync(join(tmp, ".switchroom", "cloakbrowser", "chromium-1"), { recursive: true });
      mkdirSync(join(tmp, ".switchroom", "webkite"), { recursive: true });
      writeFileSync(join(tmp, ".switchroom", "webkite", "config.toml"), "");
      const out = generateCompose({
        config: makeConfig({ a: {} }),
        homeDir: tmp,
      });
      expect(out).toContain(
        `${tmp}/.switchroom/bin/webkite:/usr/local/bin/webkite:ro`,
      );
      expect(out).toContain(
        `${tmp}/.switchroom/cloakbrowser:/opt/switchroom/cloakbrowser-cache:ro`,
      );
      expect(out).toContain(
        `${tmp}/.switchroom/webkite/config.toml:/state/agent/home/.config/webkite/config.toml:ro`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("omits webkite + cloakbrowser mounts when host sources are absent", async () => {
    // Mirrors the skills/credentials guard — a fresh install without
    // the webkite binary staged or cloakbrowser installed should still
    // produce valid compose. Webkite degrades gracefully (no MCP
    // server resolves on first call — model gets a clear error).
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "compose-webkite-absent-"));
    try {
      const out = generateCompose({
        config: makeConfig({ a: {} }),
        homeDir: tmp,
      });
      expect(out).not.toContain(`/.switchroom/bin/webkite:`);
      expect(out).not.toContain(`/.switchroom/cloakbrowser:`);
      expect(out).not.toContain(`/.switchroom/webkite/config.toml:`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("emits top-level project name 'switchroom' for collision protection", () => {
    // Belt-and-braces vs Coolify-managed (or other) compose stacks on
    // the same host. Pinning name: at file scope means
    // `docker compose -f <path>` always targets the same project.
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    expect(out).toMatch(/^name: switchroom$/m);
  });

  // ── security hardening defaults ────────────────────────────────────
  it("emits no-new-privileges + cap_drop ALL on every agent service", () => {
    const out = generateCompose({ config: makeConfig({ a: {}, b: {} }) });
    // Each agent block must contain both directives.
    for (const name of ["a", "b"]) {
      const block = new RegExp(
        `agent-${name}:[\\s\\S]*?(?=\\n  [a-z]|\\nvolumes:)`,
      ).exec(out)?.[0] ?? "";
      expect(block, `agent-${name} security_opt`).toContain('no-new-privileges:true');
      expect(block, `agent-${name} cap_drop`).toMatch(/cap_drop:\s*\n\s*-\s*"ALL"/);
      expect(block, `agent-${name} read_only`).toContain("read_only: true");
      expect(block, `agent-${name} tmpfs`).toContain(`/tmp:size=${DEFAULT_TMP_SIZE}`);
    }
  });

  it("emits no-new-privileges + cap_drop ALL on broker and kernel", () => {
    const out = generateCompose({ config: makeConfig({}) });
    // Split into top-level service blocks.
    const blocks: Record<string, string> = {};
    const re = /^  ([a-z][a-z0-9-]*):\n((?:    [^\n]*\n|\n)+)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(out)) !== null) {
      blocks[m[1]!] = m[0]!;
    }
    for (const svc of ["vault-broker", "approval-kernel"]) {
      const block = blocks[svc] ?? "";
      expect(block, `${svc} block found`).toContain(`${svc}:`);
      expect(block, `${svc} security_opt`).toContain("no-new-privileges:true");
      expect(block, `${svc} cap_drop`).toMatch(/cap_drop:\s*\n\s*-\s*"ALL"/);
    }
  });

  it("broker keeps CHOWN + FOWNER (needed to chown per-agent sockets)", () => {
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    const block = /vault-broker:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).toContain("CHOWN");
    expect(block).toContain("FOWNER");
  });

  it("broker adds DAC_READ_SEARCH so root can read host-owned vault files (v0.7.4)", () => {
    // Without this cap the broker boots, fails to read
    // /state/vault-auto-unlock (mode 0600 owned by host UID), and silently
    // falls back to interactive unlock. Verified against a v0.7.3 cutover.
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    const block = /vault-broker:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).toContain("DAC_READ_SEARCH");
  });

  it("broker adds DAC_OVERRIDE so op:put can write to the host-owned vault dir (v0.7.13)", () => {
    // Without this cap, broker can READ the vault dir (DAC_READ_SEARCH)
    // but rejects mkdir + write into it. Surfaced post-v0.7.12 deploy
    // as `EACCES: permission denied, mkdir '/state/vault/vault.enc.lock'`
    // when ms_graph_token.py's broker put attempted the saveVault flock
    // sentinel-dir. The host vault dir is mode 0700 owned by the
    // operator UID; broker runs as container-root which doesn't bypass
    // perms under cap_drop ALL without DAC_OVERRIDE.
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    const block = /vault-broker:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).toContain("DAC_OVERRIDE");
  });

  it("broker mounts /etc/machine-id so auto-unlock key derivation matches host (v0.7.4)", () => {
    // The auto-unlock blob is sealed with an AES key derived from the
    // host's /etc/machine-id. Without passing it through, the broker
    // image (no /etc/machine-id baked in) errors "Cannot derive
    // machine-bound key" and falls back to interactive unlock.
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    const block = /vault-broker:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).toMatch(/-\s+\/etc\/machine-id:\/etc\/machine-id:ro/);
  });

  it("broker bind-mounts the host vault-audit.log onto /root/.switchroom/vault-audit.log (#1025)", () => {
    // fails when: the broker writes its audit log to a container-local
    // path that evaporates on recreate and is invisible to both the
    // host CLI (`switchroom vault audit`) and the admin-agent :ro
    // mount wired up by #1024. Broker resolves the log path via
    // `os.homedir()` (`src/vault/broker/audit-log.ts:101`); broker
    // runs as root so HOME=/root inside the container. Without this
    // mount the host file never sees a single entry — exactly the
    // failure mode #1024's Recent-denials section was meant to
    // surface, masked by missing data. Mount is RW (not :ro) because
    // the broker appends; `ensureHostMountSources()` in apply.ts
    // pre-creates the source file so docker doesn't auto-create a
    // directory at the mount path.
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    const block = /vault-broker:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).toMatch(
      /-\s+\$\{HOME\}\/\.switchroom\/vault-audit\.log:\/root\/\.switchroom\/vault-audit\.log(?!:ro)/,
    );
  });

  it("broker bind-mounts the host vault-broker DIRECTORY onto /root/.switchroom/vault-broker (#1737 / #3289 WAL durability)", () => {
    // fails when: the broker writes the capability-grants SQLite (and its
    // WAL sidecars) to a container-local path that evaporates on recreate.
    // Token files on disk (~/.switchroom/agents/<agent>/.vault-token) persist
    // via the per-agent bind mounts and reference grant IDs that no longer
    // exist in the fresh broker DB — every `switchroom vault get` from inside
    // an agent container returns `VAULT-BROKER-DENIED [DENIED]: key 'X' not in
    // ACL for agent 'Y'` because the #1496 fall-through routes the unusable
    // token to the standing schedule.secrets ACL, which usually denies (the
    // whole reason a grant was minted in the first place).
    //
    // #3289: the mount is now the whole `vault-broker` DIRECTORY (not the bare
    // `vault-grants.db` file) so the WAL `-wal`/`-shm` sidecars persist on the
    // host fs alongside the main DB. Mounting only the single file left the
    // sidecars in the container's ephemeral overlayfs, so committed grants sat
    // in the container-local WAL until a rare checkpoint and were lost on
    // recreate.
    //
    // Surfaced 2026-05-24 when clerk's vg_5e1991 grant for `ha/access-token`
    // disappeared after the v0.13.31 broker recreate.
    //
    // Mount is RW (not :ro) because the broker writes new rows on every
    // mint_grant call; `ensureHostMountSources()` in apply.ts pre-creates the
    // source DIRECTORY mode 0700 (secrets material) so docker doesn't
    // auto-create a root-owned path at the mount source.
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    const block = /vault-broker:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).toMatch(
      /-\s+\$\{HOME\}\/\.switchroom\/vault-broker:\/root\/\.switchroom\/vault-broker(?!:ro)/,
    );
    // And the OLD single-file mount must be gone (regression guard for #3289).
    expect(block).not.toMatch(
      /vault-grants\.db:\/root\/\.switchroom\/vault-grants\.db/,
    );
  });

  it("broker bind-mounts each per-agent .vault-token file at /root/.switchroom/agents/<name>/.vault-token", () => {
    // fails when: mint_grant writes the new token to
    // `os.homedir() + .switchroom/agents/<agent>/.vault-token` —
    // inside the broker container that path is `/root/.switchroom/...`,
    // ephemeral, and invisible to both the operator host and the agent
    // container. The agent's in-container `switchroom vault get` then
    // can't read the freshly-minted token, so the broker falls back to
    // the peercred ACL path and denies any user-declared MCP that
    // relies on standing grants (e.g. perplexity).
    //
    // Surfaced 2026-05-25 after a fleet-wide `switchroom vault grant`
    // cycle for perplexity/api-key produced grants in the DB (visible
    // via `vault grants`) but stale on-host token files — every agent
    // hit VAULT-BROKER-DENIED on perplexity launcher startup.
    //
    // Mount is RW (broker writes the token on every mint); pre-created
    // by `ensureHostMountSources()` in apply.ts so docker doesn't
    // auto-create a root-owned directory at the mount path.
    const out = generateCompose({ config: makeConfig({ a: {}, b: {} }) });
    const block = /vault-broker:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).toMatch(
      /-\s+\$\{HOME\}\/\.switchroom\/agents\/a\/\.vault-token:\/root\/\.switchroom\/agents\/a\/\.vault-token(?!:ro)/,
    );
    expect(block).toMatch(
      /-\s+\$\{HOME\}\/\.switchroom\/agents\/b\/\.vault-token:\/root\/\.switchroom\/agents\/b\/\.vault-token(?!:ro)/,
    );
  });

  it("kernel keeps CHOWN + FOWNER (mirrors broker socket-ownership flow)", () => {
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    const block = /approval-kernel:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).toContain("CHOWN");
    expect(block).toContain("FOWNER");
  });

  it("kernel has DAC_READ_SEARCH so the healthcheck probe can read 0700 agent dirs", () => {
    // The bind-presence healthcheck (PR #898) runs as root inside the
    // kernel container, but per-agent socket dirs are mode 0700 owned
    // by the agent UID after the kernel chowns them. Without
    // DAC_READ_SEARCH, root can't traverse those dirs, so the probe
    // always fails — kernel reports unhealthy in production while
    // actually serving traffic correctly. Verified against the live
    // fleet on 2026-05-10.
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    const block = /approval-kernel:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).toContain("DAC_READ_SEARCH");
  });

  it("kernel has DAC_OVERRIDE so it can write the SQLite db to the host-owned approvals dir", () => {
    // /state/approvals is bind-mounted from ~/.switchroom/approvals on
    // the host (owned by the operator user). Kernel runs as root inside
    // the container; without DAC_OVERRIDE, root can't open the SQLite
    // db for writes (not owner, "other" doesn't have write). The kernel
    // then crash-loops with "SQLiteError: unable to open database file"
    // on fresh installs. Install-validation finding #18.
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    const block = /approval-kernel:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).toContain("DAC_OVERRIDE");
  });

  // Operator socket — host-shell-reachable broker surface.
  // Pre-fix v0.7 docker mode bound the broker's data + unlock sockets
  // only inside the container; the host CLI defaulted to a v0.6 socket
  // path that didn't exist, so every host-shell broker verb returned
  // "broker unreachable". Now compose emits a host-bound dir mount
  // (`~/.switchroom/broker-operator → /run/switchroom/broker/operator`)
  // and SWITCHROOM_BROKER_OPERATOR_UID, so the broker chowns the
  // operator socket to the host UID and the CLI can connect through
  // the bind. Both halves of the contract are pinned here.
  it("emits operator bind + UID env when operatorUid is set", () => {
    const out = generateCompose({
      config: makeConfig({ a: {} }),
      operatorUid: 1000,
    });
    const block = /vault-broker:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).toMatch(/SWITCHROOM_BROKER_OPERATOR_UID:\s*"1000"/);
    expect(block).toMatch(
      /-\s+\$\{HOME\}\/\.switchroom\/broker-operator:\/run\/switchroom\/broker\/operator/,
    );
  });

  it("omits operator bind + UID env when operatorUid is not set (back-compat)", () => {
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    const block = /vault-broker:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).not.toContain("SWITCHROOM_BROKER_OPERATOR_UID");
    expect(block).not.toContain("broker-operator:/run/switchroom/broker/operator");
  });

  it("bakes the absolute operator-bind host path under homeDir override", () => {
    // Sudo-runs lose ${HOME} interpolation; apply.ts already passes
    // homedir() so all bind sources come out absolute. The operator
    // bind has to follow the same shape or it'd silently mis-resolve
    // to /root under sudo docker compose.
    const out = generateCompose({
      config: makeConfig({ a: {} }),
      operatorUid: 1000,
      homeDir: "/home/op",
    });
    const block = /vault-broker:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).toContain("/home/op/.switchroom/broker-operator:/run/switchroom/broker/operator");
  });

  // auth-broker mirrors the vault-broker operator-socket contract under
  // its own env var name (SWITCHROOM_AUTH_BROKER_OPERATOR_UID) so the
  // host CLI's `switchroom auth …` verbs can reach the broker. Without
  // this the operator-dir bind mount the generator already emits is
  // unused dead weight and the broker never binds an operator listener.
  it("emits SWITCHROOM_AUTH_BROKER_OPERATOR_UID on the auth-broker when operatorUid is set", () => {
    const out = generateCompose({
      config: makeConfig({ a: {} }),
      operatorUid: 1000,
    });
    const block = /switchroom-auth-broker:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).toMatch(/SWITCHROOM_AUTH_BROKER_OPERATOR_UID:\s*"1000"/);
  });

  it("omits SWITCHROOM_AUTH_BROKER_OPERATOR_UID when operatorUid is not set (back-compat)", () => {
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    const block = /switchroom-auth-broker:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).not.toContain("SWITCHROOM_AUTH_BROKER_OPERATOR_UID");
  });

  // The agent container's gateway webhook ingest server peercred-gates its
  // dedicated webhook.sock to the host operator UID. The generator surfaces
  // that UID into the agent env so the gateway knows which peer to trust.
  it("emits SWITCHROOM_WEBHOOK_RECEIVER_UID on the agent when operatorUid is set", () => {
    const out = generateCompose({
      config: makeConfig({ a: {} }),
      operatorUid: 1000,
    });
    const block = /agent-a:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).toMatch(/SWITCHROOM_WEBHOOK_RECEIVER_UID:\s*"1000"/);
  });

  it("omits SWITCHROOM_WEBHOOK_RECEIVER_UID when operatorUid is not set (back-compat)", () => {
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    const block = /agent-a:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).not.toContain("SWITCHROOM_WEBHOOK_RECEIVER_UID");
  });

  // The approval-kernel mirrors the same operator-socket bind so
  // host-side `approvalList` (the web dashboard) can read decision
  // metadata. SWITCHROOM_KERNEL_OPERATOR_UID enables the kernel's
  // READ-ONLY operator listener (approval_list only — the kernel
  // enforces that, not compose). Both halves pinned.
  it("emits kernel operator bind + UID env when operatorUid is set", () => {
    const out = generateCompose({
      config: makeConfig({ a: {} }),
      operatorUid: 1000,
    });
    const block = /approval-kernel:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).toMatch(/SWITCHROOM_KERNEL_OPERATOR_UID:\s*"1000"/);
    expect(block).toMatch(
      /-\s+\$\{HOME\}\/\.switchroom\/state\/kernel-operator:\/run\/switchroom\/kernel\/operator/,
    );
  });

  it("omits kernel operator bind + UID env when operatorUid is not set (back-compat)", () => {
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    const block = /approval-kernel:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).not.toContain("SWITCHROOM_KERNEL_OPERATOR_UID");
    expect(block).not.toContain("kernel-operator:/run/switchroom/kernel/operator");
  });

  it("bakes the absolute kernel operator-bind host path under homeDir override", () => {
    const out = generateCompose({
      config: makeConfig({ a: {} }),
      operatorUid: 1000,
      homeDir: "/home/op",
    });
    const block = /approval-kernel:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).toContain(
      "/home/op/.switchroom/state/kernel-operator:/run/switchroom/kernel/operator",
    );
  });

  // PR #1278: the auth-broker entry script reads `--operator-uid` as a
  // CLI flag, not an env var. The env var above is a fallback the
  // broker entry consumes (PR #1277) but the canonical wiring is a
  // `command:` override that appends the flag. Without this, the
  // bare CMD in docker/Dockerfile.auth-broker leaves operatorUid
  // undefined inside the broker → bindOperatorListener never fires →
  // operator socket never gets created. Caught live on 2026-05-15
  // during the RFC H redeploy.
  it("emits `command:` with --operator-uid flag when operatorUid is set", () => {
    const out = generateCompose({
      config: makeConfig({ a: {} }),
      operatorUid: 1000,
    });
    const block = /switchroom-auth-broker:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).toMatch(
      /command:\s*\["bun",\s*"\/opt\/switchroom\/dist\/auth-broker\/index\.js",\s*"--operator-uid",\s*"1000"\]/,
    );
  });

  it("omits the `command:` override when operatorUid is not set (back-compat)", () => {
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    const block = /switchroom-auth-broker:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).not.toMatch(/^\s+command:/m);
  });

  // The host-side operator bind mount must mirror the env / command
  // gating — otherwise a no-operatorUid install ends up with an empty
  // bind dir on disk that confuses operators reading the compose file.
  it("emits the operator-socket bind mount when operatorUid is set", () => {
    const out = generateCompose({
      config: makeConfig({ a: {} }),
      operatorUid: 1000,
    });
    const block = /switchroom-auth-broker:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).toMatch(
      /\$\{HOME\}\/\.switchroom\/state\/auth-broker-operator:\/run\/switchroom\/auth-broker\/operator/,
    );
  });

  it("omits the operator-socket bind mount when operatorUid is not set", () => {
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    const block = /switchroom-auth-broker:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).not.toContain("auth-broker-operator:/run/switchroom/auth-broker/operator");
  });

});

describe("agent service env (Phase 2c F2 — IPC wiring)", () => {
  // Phase 2a (broker IPC) and Phase 2b (kernel IPC) both expect agent
  // containers to receive these env vars at boot — without them an agent
  // can't find its broker or kernel socket and silently falls back to
  // legacy / disabled paths. Neither phase included a generator-level
  // assertion, so this test pins the contract.
  //
  // Path shape MUST match the kernel-server / broker-server bind shape
  // (`/run/switchroom/<broker|kernel>/<agent>/sock`) — same as the per-
  // agent volume mount the generator already emits.
  function envBlockFor(yml: string, agent: string): string {
    const re = new RegExp(
      `  agent-${agent}:[\\s\\S]*?    environment:([\\s\\S]*?)\\n    volumes:`,
    );
    return re.exec(yml)?.[1] ?? "";
  }

  it("sets SWITCHROOM_RUNTIME=docker on each agent container", () => {
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }),
    });
    for (const a of ["alice", "bob"]) {
      const env = envBlockFor(out, a);
      expect(env).toMatch(/SWITCHROOM_RUNTIME:\s*"docker"/);
    }
  });

  // Claude-runtime invariants for the pinned-image, cache-engineered
  // 24/7 fleet. DISABLE_AUTOUPDATER keeps the running `claude` binary
  // identical to the audited/digest-pinned image (sec WS9-F4 #1418);
  // CLAUDE_CODE_ATTRIBUTION_HEADER=0 complements the deliberate
  // cache-stable prompt prefix (bin/timezone-hook.sh 900s bucket).
  it("sets the pinned-fleet Claude-runtime env on each agent container", () => {
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }),
    });
    for (const a of ["alice", "bob"]) {
      const env = envBlockFor(out, a);
      expect(env).toMatch(/DISABLE_AUTOUPDATER:\s*"1"/);
      expect(env).toMatch(/CLAUDE_CODE_ATTRIBUTION_HEADER:\s*"0"/);
    }
  });

  // KEN-126: 1-hour extended prompt-cache TTL. Idle-heavy Telegram agents
  // lose the default 5-minute prompt cache between messages; the claude
  // CLI (verified on 2.1.219) honors ENABLE_PROMPT_CACHING_1H as a
  // deterministic force-on for the extended-cache-ttl-2025-04-11 beta
  // (its built-in default is a remote statsig gate). Emitted as an
  // operator-overridable default: applied only when the agent's `env:`
  // block doesn't set the key itself.
  it("defaults ENABLE_PROMPT_CACHING_1H=1 on each agent container", () => {
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }),
    });
    for (const a of ["alice", "bob"]) {
      const env = envBlockFor(out, a);
      expect(env).toMatch(/ENABLE_PROMPT_CACHING_1H:\s*"1"/);
    }
  });

  it("operator env: ENABLE_PROMPT_CACHING_1H override wins over the default", () => {
    const out = generateCompose({
      config: makeConfig({
        alice: { env: { ENABLE_PROMPT_CACHING_1H: "0" } },
        bob: {},
      }),
    });
    expect(envBlockFor(out, "alice")).toMatch(
      /ENABLE_PROMPT_CACHING_1H:\s*"0"/,
    );
    expect(envBlockFor(out, "bob")).toMatch(/ENABLE_PROMPT_CACHING_1H:\s*"1"/);
  });

  it("sets TINI_KILL_PROCESS_GROUP=1 so SIGTERM reaches the gateway sidecar", () => {
    // Without this env, tini forwards SIGTERM only to its direct child
    // (tmux at PID 7); the gateway/scheduler/autoaccept sidecars share
    // PGID=7 but are NOT direct children of tini, so they get SIGKILL'd
    // at stop_grace_period without running the shutdown handler. The
    // handler writes clean-shutdown.json — without it, every graceful
    // container stop boots as 'crash recovery' on the next start.
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }),
    });
    for (const a of ["alice", "bob"]) {
      const env = envBlockFor(out, a);
      expect(env).toMatch(/TINI_KILL_PROCESS_GROUP:\s*"1"/);
    }
  });

  it("sets SWITCHROOM_KERNEL_SOCKET to the agent-perspective socket path", () => {
    // The agent mounts `kernel-<name>-sock` at `/run/switchroom/kernel`
    // (compose.ts line ~608 — directly at the parent dir, not at a
    // per-agent subdir). So the kernel socket inside the agent is at
    // `/run/switchroom/kernel/sock`, not `/run/switchroom/kernel/
    // <name>/sock` (which is the kernel CONTAINER's view). Pre-fix
    // the env value was the kernel-side path → didn't exist inside
    // the agent → client fell through to the legacy fallback.
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }),
    });
    for (const a of ["alice", "bob"]) {
      const env = envBlockFor(out, a);
      expect(env).toMatch(
        /SWITCHROOM_KERNEL_SOCKET:\s*"\/run\/switchroom\/kernel\/sock"/,
      );
      // Pin the regression: the per-agent-subdir form is the kernel-
      // side bind path, NOT what should land in agent env.
      expect(env).not.toMatch(
        new RegExp(`SWITCHROOM_KERNEL_SOCKET:\\s*"/run/switchroom/kernel/${a}/sock"`),
      );
    }
  });

  it("sets SWITCHROOM_VAULT_BROKER_SOCK (canonical name) to the agent-perspective path", () => {
    // The compose generator pre-fix emitted `SWITCHROOM_BROKER_SOCKET`
    // (the broker SERVER's bind-path env), which the broker CLIENT
    // (`src/vault/broker/client.ts:293`) and the secret-guard hook
    // (`telegram-plugin/hooks/secret-guard-pretool.mjs:36`) do NOT
    // read — they read `SWITCHROOM_VAULT_BROKER_SOCK`. So the env var
    // was set but ignored. Plus the value was the broker's view of
    // the per-agent subdir, which doesn't exist inside the agent
    // container. Both fixed: canonical name + agent-perspective path.
    // Surfaced as klanker's "VAULT-BROKER-DENIED" on 2026-05-10.
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }),
    });
    for (const a of ["alice", "bob"]) {
      const env = envBlockFor(out, a);
      expect(env).toMatch(
        /SWITCHROOM_VAULT_BROKER_SOCK:\s*"\/run\/switchroom\/broker\/sock"/,
      );
      // Regression pins:
      //   1. The wrong NAME (server-side env) is no longer set.
      //   2. The wrong PATH (broker's per-agent-subdir view) is gone.
      expect(env).not.toMatch(/SWITCHROOM_BROKER_SOCKET:/);
      expect(env).not.toMatch(
        new RegExp(`/run/switchroom/broker/${a}/sock`),
      );
    }
  });

  it("sets SWITCHROOM_AGENT_NAME identity on each agent container", () => {
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }),
    });
    for (const a of ["alice", "bob"]) {
      const env = envBlockFor(out, a);
      expect(env).toMatch(
        new RegExp(`SWITCHROOM_AGENT_NAME:\\s*"${a}"`),
      );
    }
  });

  it("admin agents get a read-only vault-audit.log mount when the host log exists", async () => {
    // fails when: the audit-log mount is dropped from admin agent
    // compose. The bot in the admin agent container reads
    // `${HOME}/.switchroom/vault-audit.log` (telegram-plugin/
    // gateway/gateway.ts:6346 — `readRecentDenialsForAgent`).
    // Container HOME is `/state/agent/home`, so the host audit log
    // must be mounted there. Without the mount, the bot silently
    // returns 0 recent denials regardless of how many actually
    // fired, breaking the /vault audit one-tap allow UX from #969 P2b.
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "compose-audit-mount-"));
    try {
      mkdirSync(join(tmp, ".switchroom"), { recursive: true });
      writeFileSync(join(tmp, ".switchroom", "vault-audit.log"), "");
      const out = generateCompose({
        config: makeConfig({
          alice: { admin: true },
          bob: {},
        }),
        homeDir: tmp,
      });
      expect(out).toMatch(
        /agent-alice:[\s\S]*?\.switchroom\/vault-audit\.log:\/state\/agent\/home\/\.switchroom\/vault-audit\.log:ro/,
      );
      // Non-admin gets no host audit-log mount — operator state is
      // not exposed to ordinary agents.
      expect(out).not.toMatch(
        /agent-bob:[\s\S]*?vault-audit\.log(?![\s\S]*?  (?:agent|vault|approval|kernel))/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips the admin-agent audit-log mount on fresh installs where the host log doesn't exist yet (no docker compose hard-fail)", async () => {
    // fails when: the existsSync guard on the AGENT-side :ro mount
    // is dropped — docker compose `up` hard-fails when a `:ro`
    // source path is missing. Before #1025 the audit log was created
    // lazily by the broker on the first ACL decision, so a fresh
    // install (no denials ever fired) could break admin agent
    // startup. #1025 then made `ensureHostMountSources()` pre-create
    // the file, which closes the timing window — but we keep the
    // existsSync guard on the agent-side mount as belt-and-braces
    // for the `compose-only-without-apply` codepath (tests, manual
    // re-generation). The broker-side RW mount is intentionally
    // unconditional: apply always pre-creates it, and the broker
    // image already expects to write there.
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "compose-audit-fresh-"));
    try {
      // No vault-audit.log created — simulates fresh install.
      const out = generateCompose({
        config: makeConfig({ alice: { admin: true } }),
        homeDir: tmp,
      });
      // Agent-side :ro mount must NOT appear without the host file.
      expect(out).not.toMatch(
        /agent-alice:[\s\S]*?vault-audit\.log:\/state\/agent\/home\/\.switchroom\/vault-audit\.log:ro/,
      );
      // Broker-side RW mount IS still emitted (apply pre-creates the
      // source). The broker depends on it for audit-log persistence
      // across container recreate (#1025).
      expect(out).toMatch(
        /vault-broker:[\s\S]*?vault-audit\.log:\/root\/\.switchroom\/vault-audit\.log/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("admin agents get a read-only host-control-audit.log mount when the host log exists (#1328 follow-up)", async () => {
    // fails when: the hostd-audit-log mount is dropped from admin
    // agent compose. /audit hostd in DM (#1328) shells out to
    // `switchroom hostd audit` inside the agent container, which
    // reads `${HOME}/.switchroom/host-control-audit.log` via
    // defaultAuditLogPath(). Without the mount the lookup resolves
    // to a path that doesn't exist inside the container and the
    // command returns "log not found" regardless of real log state.
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "compose-hostd-audit-mount-"));
    try {
      mkdirSync(join(tmp, ".switchroom"), { recursive: true });
      writeFileSync(join(tmp, ".switchroom", "host-control-audit.log"), "");
      const out = generateCompose({
        config: makeConfig({
          alice: { admin: true },
          bob: {},
        }),
        homeDir: tmp,
      });
      expect(out).toMatch(
        /agent-alice:[\s\S]*?\.switchroom\/host-control-audit\.log:\/state\/agent\/home\/\.switchroom\/host-control-audit\.log:ro/,
      );
      // Non-admin: no audit-log mount. Operator state never reaches
      // an ordinary agent's container.
      expect(out).not.toMatch(
        /agent-bob:[\s\S]*?host-control-audit\.log/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips the hostd-audit-log mount on fresh installs where the host log doesn't exist yet (no docker compose hard-fail)", async () => {
    // fails when: the existsSync guard on the host-control-audit.log
    // mount is dropped. Hostd creates the log lazily on the first
    // privileged-verb request, so a brand-new install may not have it
    // yet — without the guard, docker compose `up` would hard-fail
    // on a missing :ro source. Same pattern as the vault-audit.log
    // guard above.
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "compose-hostd-audit-fresh-"));
    try {
      const out = generateCompose({
        config: makeConfig({ alice: { admin: true } }),
        homeDir: tmp,
      });
      expect(out).not.toMatch(
        /agent-alice:[\s\S]*?host-control-audit\.log/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("admin agents get NO operator-socket mount or routing env (#1021 Design B handles grant-mgmt server-side)", () => {
    // fails when: a refactor re-introduces the pre-#1021 attempt of
    // mounting the operator socket directly into admin agents. That
    // approach (#1020 originally) didn't work because the operator
    // socket file is 0600 owned by the HOST operator UID — the
    // agent UID can't connect through the bind mount. #1021 Design B
    // moved the gate into the broker (server-side admin allowlist
    // check), so the agent doesn't need any extra socket plumbing.
    // Pinning the absence here keeps a future "let me just add an
    // operator-socket mount back" PR from getting through.
    const out = generateCompose({
      config: makeConfig({
        alice: { admin: true },
        bob: {},
      }),
    });
    const aliceEnv = envBlockFor(out, "alice");
    expect(aliceEnv).not.toMatch(/SWITCHROOM_VAULT_BROKER_OPERATOR_SOCK/);
    // Confirm alice's service block doesn't carry an operator bind
    // (search up to the next service entry).
    expect(out).not.toMatch(
      /agent-alice:[\s\S]*?\.switchroom\/broker-operator(?![\s\S]*?  (?:agent|vault|approval|kernel))/,
    );
  });

  it("surfaces yaml admin: true as SWITCHROOM_AGENT_ADMIN=true on the agent container", () => {
    // fails when: the compose generator stops propagating the
    // schema-level `admin: true` flag to the gateway's runtime env.
    // The gateway gates `/vault`, `/agents`, `/logs`, `/grant`,
    // `/update` etc. on `SWITCHROOM_AGENT_ADMIN === "true"`
    // (telegram-plugin/gateway/gateway.ts:514). Without this
    // propagation the yaml field is silently a no-op — the
    // operator sets `admin: true`, restarts, and the bot still
    // rejects `/vault` with "this agent isn't admin-flagged".
    // Discovered while setting up the UAT harness's
    // `test-harness` agent for vault-UX scenarios.
    const out = generateCompose({
      config: makeConfig({
        alice: { admin: true },
        bob: {},
      }),
    });
    const aliceEnv = envBlockFor(out, "alice");
    const bobEnv = envBlockFor(out, "bob");
    expect(aliceEnv).toMatch(/SWITCHROOM_AGENT_ADMIN:\s*"true"/);
    expect(bobEnv).not.toMatch(/SWITCHROOM_AGENT_ADMIN/);
  });

  // Layer 1 (persistent agent HOME). The agent container runs as a
  // numeric UID with no /etc/passwd entry; without HOME pointed at a
  // writable dir, every tool that writes ~/.config / ~/.cache / ~/.local
  // fails on the read-only root fs. compose.ts pins HOME inside the
  // existing /state/agent bind mount so writes survive restart, and
  // sets NPM_CONFIG_PREFIX so `npm install -g` lands under HOME instead
  // of /usr/local (which is read-only).
  it("sets HOME=/state/agent/home on each agent container", () => {
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }),
    });
    for (const a of ["alice", "bob"]) {
      const env = envBlockFor(out, a);
      expect(env).toMatch(/HOME:\s*"\/state\/agent\/home"/);
    }
  });

  it("sets NPM_CONFIG_PREFIX under HOME so npm -g installs persist", () => {
    const out = generateCompose({
      config: makeConfig({ alice: {} }),
    });
    const env = envBlockFor(out, "alice");
    expect(env).toMatch(
      /NPM_CONFIG_PREFIX:\s*"\/state\/agent\/home\/\.npm-global"/,
    );
  });

  // Layer 1 followup: PEP 668. Debian 12's system Python is marked
  // externally-managed, which makes `pip install --user foo` refuse
  // even though Layer 1 made ~/.local writable. Both env vars together
  // route writes to ~/.local (PIP_USER) and override the PEP 668 guard
  // (PIP_BREAK_SYSTEM_PACKAGES). Without both, an agent's first
  // `pip install` fails opaquely inside a tool-call retry loop.
  it("sets PIP_USER + PIP_BREAK_SYSTEM_PACKAGES so `pip install foo` lands in ~/.local", () => {
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }),
    });
    for (const a of ["alice", "bob"]) {
      const env = envBlockFor(out, a);
      expect(env).toMatch(/PIP_USER:\s*"1"/);
      expect(env).toMatch(/PIP_BREAK_SYSTEM_PACKAGES:\s*"1"/);
    }
  });

  // Per-agent timezone wiring (#1198).
  //
  // Pre-fix, compose.ts emitted no `TZ` or `SWITCHROOM_TIMEZONE` env var
  // for agent services, so every container inherited the Debian base
  // image's `Etc/UTC` default. node-cron inside the container read
  // process.env.TZ (undefined) and evaluated every cron expression
  // against UTC — `0 8 * * *` fired at 08:00 UTC instead of 08:00 in
  // the operator's local zone, a 10-11 hour skew for Melbourne. The
  // `resolveTimezone` cascade existed (agent → profile → switchroom →
  // server detect → UTC) but its output never reached the container —
  // it was only consumed by a scaffold-time CLI warning and the legacy
  // (removed in #906) systemd unit's [Service] block. Restored here:
  // emit both names so existing Unix tooling (`TZ`) and the
  // UserPromptSubmit hook's stale-detection check (SWITCHROOM_TIMEZONE)
  // both see the operator-intended zone.

  it("emits TZ + SWITCHROOM_TIMEZONE from agent.timezone when set at the agent layer (#1198)", () => {
    const out = generateCompose({
      config: makeConfig({ clerk: { timezone: "Australia/Melbourne" } }),
    });
    const env = envBlockFor(out, "clerk");
    expect(env).toMatch(/TZ:\s*"Australia\/Melbourne"/);
    expect(env).toMatch(/SWITCHROOM_TIMEZONE:\s*"Australia\/Melbourne"/);
  });

  it("emits TZ + SWITCHROOM_TIMEZONE from switchroom.timezone (global default) when no agent layer set it", () => {
    // The global cascade entry: `switchroom.timezone: "Region/City"` at
    // the top of switchroom.yaml. Resolves through the cascade to every
    // agent that doesn't declare its own zone.
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }, { timezone: "America/New_York" }),
    });
    for (const a of ["alice", "bob"]) {
      const env = envBlockFor(out, a);
      expect(env).toMatch(/TZ:\s*"America\/New_York"/);
      expect(env).toMatch(/SWITCHROOM_TIMEZONE:\s*"America\/New_York"/);
    }
  });

  it("per-agent timezone wins over the global default", () => {
    const out = generateCompose({
      config: makeConfig(
        {
          clerk: { timezone: "Australia/Melbourne" },
          alice: {},
        },
        { timezone: "America/New_York" },
      ),
    });
    expect(envBlockFor(out, "clerk")).toMatch(/TZ:\s*"Australia\/Melbourne"/);
    expect(envBlockFor(out, "alice")).toMatch(/TZ:\s*"America\/New_York"/);
  });

  it("emits a TZ env var unconditionally — never absent", () => {
    // resolveTimezone always returns a string (final fallback "UTC" via
    // server detection). The compose generator must therefore always
    // emit TZ. A missing-TZ container would silently regress to UTC,
    // re-introducing the #1198 bug without an obvious signal.
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }), // no timezone anywhere
    });
    for (const a of ["alice", "bob"]) {
      const env = envBlockFor(out, a);
      expect(env).toMatch(/^\s*TZ:\s*"/m);
      expect(env).toMatch(/^\s*SWITCHROOM_TIMEZONE:\s*"/m);
    }
  });

  it("describeAgents() surfaces the resolved timezone on each agent's metadata", () => {
    // The doctor checks + tests want to know the resolved zone without
    // re-parsing YAML, so the resolution is exposed on AgentServiceData.
    const agents = describeAgents(
      makeConfig({ clerk: { timezone: "Australia/Melbourne" } }),
    );
    const clerk = agents.find((a) => a.name === "clerk");
    expect(clerk?.timezone).toBe("Australia/Melbourne");
  });
});

describe("agent service env — LiteLLM routing injection (opt-in)", () => {
  function envBlockFor(yml: string, agent: string): string {
    const re = new RegExp(
      `  agent-${agent}:[\\s\\S]*?    environment:([\\s\\S]*?)\\n    volumes:`,
    );
    return re.exec(yml)?.[1] ?? "";
  }

  it("injects ANTHROPIC_BASE_URL + ANTHROPIC_SMALL_FAST_MODEL + SWITCHROOM_LITELLM when enabled AND key confirmed", () => {
    const out = generateCompose({
      config: makeConfig({
        clerk: {
          litellm: {
            enabled: true,
            base_url: "http://127.0.0.1:4010",
            small_fast_model: "claude-haiku-4-5-20251001",
          },
        },
      }),
      litellmConfirmedAgents: new Set(["clerk"]),
    });
    const env = envBlockFor(out, "clerk");
    // claude → Anthropic pass-through (<root>/anthropic), NOT the model-mapped
    // /v1/messages route (which re-chunks the SSE stream and stalls opus).
    expect(env).toMatch(/ANTHROPIC_BASE_URL:\s*"http:\/\/127\.0\.0\.1:4010\/anthropic"/);
    // Root proxy URL kept for start.sh's health probe + gateway /model/info.
    expect(env).toMatch(/SWITCHROOM_LITELLM_BASE:\s*"http:\/\/127\.0\.0\.1:4010"/);
    expect(env).toMatch(/ANTHROPIC_SMALL_FAST_MODEL:\s*"claude-haiku-4-5-20251001"/);
    expect(env).toMatch(/SWITCHROOM_LITELLM:\s*"1"/);
  });

  it("points ANTHROPIC_BASE_URL at /anthropic pass-through and normalizes a trailing slash on the root", () => {
    const out = generateCompose({
      config: makeConfig({
        clerk: {
          litellm: { enabled: true, base_url: "http://127.0.0.1:4010/" },
        },
      }),
      litellmConfirmedAgents: new Set(["clerk"]),
    });
    const env = envBlockFor(out, "clerk");
    // trailing slash collapsed → exactly one /anthropic, no //
    expect(env).toMatch(/ANTHROPIC_BASE_URL:\s*"http:\/\/127\.0\.0\.1:4010\/anthropic"/);
    expect(env).toMatch(/SWITCHROOM_LITELLM_BASE:\s*"http:\/\/127\.0\.0\.1:4010"/);
    expect(env).not.toMatch(/anthropic\/anthropic/);
  });

  it("does NOT inject when enabled but the key is NOT confirmed in the vault (blocker-2 gate)", () => {
    // The load-bearing decoupling: opting in is not enough — a missing key
    // must NOT yield routing env, or the agent boots a dead unauthenticated
    // proxy route. Confirmed set is empty here.
    const out = generateCompose({
      config: makeConfig({
        clerk: {
          litellm: { enabled: true, base_url: "http://127.0.0.1:4010" },
        },
      }),
      litellmConfirmedAgents: new Set(),
    });
    const env = envBlockFor(out, "clerk");
    expect(env).not.toMatch(/SWITCHROOM_LITELLM:/);
    expect(env).not.toMatch(/ANTHROPIC_BASE_URL:/);
    expect(env).not.toMatch(/ANTHROPIC_SMALL_FAST_MODEL:/);
  });

  it("does NOT inject when the confirmed set is omitted entirely (fail-safe default)", () => {
    const out = generateCompose({
      config: makeConfig({
        clerk: {
          litellm: { enabled: true, base_url: "http://127.0.0.1:4010" },
        },
      }),
      // litellmConfirmedAgents omitted → no agent confirmed.
    });
    const env = envBlockFor(out, "clerk");
    expect(env).not.toMatch(/SWITCHROOM_LITELLM:/);
  });

  it("does NOT inject any LiteLLM env when the feature is off (default)", () => {
    const out = generateCompose({
      config: makeConfig({ clerk: {} }),
      litellmConfirmedAgents: new Set(["clerk"]), // confirmed but not enabled
    });
    const env = envBlockFor(out, "clerk");
    expect(env).not.toMatch(/ANTHROPIC_BASE_URL:/);
    expect(env).not.toMatch(/SWITCHROOM_LITELLM:/);
    // ANTHROPIC_SMALL_FAST_MODEL must not leak in when routing is off.
    expect(env).not.toMatch(/ANTHROPIC_SMALL_FAST_MODEL:/);
  });

  it("does NOT inject when an agent explicitly disables litellm.enabled", () => {
    const out = generateCompose({
      config: makeConfig({ clerk: { litellm: { enabled: false } } }),
      litellmConfirmedAgents: new Set(["clerk"]),
    });
    const env = envBlockFor(out, "clerk");
    expect(env).not.toMatch(/SWITCHROOM_LITELLM:/);
  });

  it("inherits the top-level fleet litellm default (enabled + base_url) for a confirmed agent", () => {
    const out = generateCompose({
      config: makeConfig(
        { clerk: {} },
        {
          litellm: {
            enabled: true,
            base_url: "http://127.0.0.1:4010",
            small_fast_model: "claude-haiku-4-5-20251001",
          },
        },
      ),
      litellmConfirmedAgents: new Set(["clerk"]),
    });
    const env = envBlockFor(out, "clerk");
    expect(env).toMatch(/ANTHROPIC_BASE_URL:\s*"http:\/\/127\.0\.0\.1:4010\/anthropic"/);
    expect(env).toMatch(/SWITCHROOM_LITELLM_BASE:\s*"http:\/\/127\.0\.0\.1:4010"/);
    expect(env).toMatch(/SWITCHROOM_LITELLM:\s*"1"/);
    expect(env).toMatch(/ANTHROPIC_SMALL_FAST_MODEL:\s*"claude-haiku-4-5-20251001"/);
  });

  it("per-agent litellm.enabled=false overrides the fleet-on default", () => {
    const out = generateCompose({
      config: makeConfig(
        { clerk: { litellm: { enabled: false } } },
        { litellm: { enabled: true, base_url: "http://127.0.0.1:4010" } },
      ),
      litellmConfirmedAgents: new Set(["clerk"]),
    });
    const env = envBlockFor(out, "clerk");
    expect(env).not.toMatch(/SWITCHROOM_LITELLM:/);
  });

  it("falls back to the default small_fast_model when none is configured", () => {
    const out = generateCompose({
      config: makeConfig({
        clerk: { litellm: { enabled: true, base_url: "http://h:1" } },
      }),
      litellmConfirmedAgents: new Set(["clerk"]),
    });
    const env = envBlockFor(out, "clerk");
    expect(env).toMatch(/ANTHROPIC_SMALL_FAST_MODEL:\s*"claude-haiku-4-5-20251001"/);
  });

  it("never emits the secret key in the compose env (key is vault-fetched at boot)", () => {
    const out = generateCompose({
      config: makeConfig({
        clerk: { litellm: { enabled: true, base_url: "http://h:1" } },
      }),
      litellmConfirmedAgents: new Set(["clerk"]),
    });
    const env = envBlockFor(out, "clerk");
    expect(env).not.toMatch(/ANTHROPIC_CUSTOM_HEADERS:/);
    expect(env).not.toMatch(/api-key/i);
  });

  it("describeAgents() marks keyConfirmed only for agents in the confirmed set", () => {
    const cfg = makeConfig({
      clerk: { litellm: { enabled: true, base_url: "http://h:1" } },
      bob: { litellm: { enabled: true, base_url: "http://h:1" } },
    });
    const agents = describeAgents(cfg, new Set(["clerk"]));
    const clerk = agents.find((a) => a.name === "clerk");
    const bob = agents.find((a) => a.name === "bob");
    expect(clerk?.litellm.enabled).toBe(true);
    expect(clerk?.litellm.keyConfirmed).toBe(true);
    expect(bob?.litellm.enabled).toBe(true);
    expect(bob?.litellm.keyConfirmed).toBe(false);
  });
});

describe("agent bind_mounts (#1164)", () => {
  // Admin-gated escalation: admin agents can declare extra host paths
  // to bind-mount into the container, on top of the standard dual-mount
  // baseline. Use case: dogfooding switchroom from a switchroom agent.

  it("emits a single :ro bind_mount under an admin agent's volumes", () => {
    const out = generateCompose({
      config: makeConfig({
        klanker: {
          admin: true,
          bind_mounts: [{ source: "/home/me/code/switchroom" }],
        },
      }),
    });
    // Default mode is ro; default target is the same as source.
    expect(out).toMatch(
      /agent-klanker:[\s\S]*?- \/home\/me\/code\/switchroom:\/home\/me\/code\/switchroom:ro/,
    );
  });

  it("emits :rw when mode is rw, and omits the suffix (docker default)", () => {
    const out = generateCompose({
      config: makeConfig({
        klanker: {
          admin: true,
          bind_mounts: [{ source: "/home/me/code/switchroom", mode: "rw" }],
        },
      }),
    });
    expect(out).toMatch(
      /- \/home\/me\/code\/switchroom:\/home\/me\/code\/switchroom\n/,
    );
    // The :ro suffix must not appear on the rw entry.
    expect(out).not.toMatch(
      /- \/home\/me\/code\/switchroom:\/home\/me\/code\/switchroom:ro/,
    );
  });

  it("honours an explicit target distinct from source", () => {
    const out = generateCompose({
      config: makeConfig({
        klanker: {
          admin: true,
          bind_mounts: [
            { source: "/host/path", target: "/in/container", mode: "ro" },
          ],
        },
      }),
    });
    expect(out).toMatch(/- \/host\/path:\/in\/container:ro/);
  });

  it("emits multiple bind_mounts in declared order", () => {
    const out = generateCompose({
      config: makeConfig({
        klanker: {
          admin: true,
          bind_mounts: [
            { source: "/a", mode: "ro" },
            { source: "/b", mode: "rw" },
          ],
        },
      }),
    });
    const idxA = out.indexOf("- /a:/a:ro");
    const idxB = out.indexOf("- /b:/b\n");
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxA).toBeLessThan(idxB);
  });

  it("throws when a non-admin agent declares bind_mounts", () => {
    // fails when: the admin gate in emitAgentService is dropped. The
    // operator could then silently grant filesystem reach to a
    // non-admin agent just by adding bind_mounts to that agent's
    // block — exactly the privilege escalation #1164's gating is
    // meant to prevent.
    expect(() =>
      generateCompose({
        config: makeConfig({
          bob: {
            bind_mounts: [{ source: "/home/me/code/switchroom" }],
          },
        }),
      }),
    ).toThrow(/agent "bob" declares bind_mounts but is not admin: true/);
  });

  it("non-admin agents emit no bind_mounts when none are declared (no regression)", () => {
    const out = generateCompose({
      config: makeConfig({ bob: {} }),
    });
    // No host path that doesn't already exist in the baseline.
    expect(out).not.toMatch(/- \/home\/me\/code\/switchroom/);
  });

  it("rejects denylisted system-path sources", () => {
    for (const bad of [
      "/etc",
      "/etc/passwd",
      "/proc",
      "/proc/1/environ",
      "/sys/fs/cgroup",
      "/dev",
      "/run/foo",
      "/var/run/whatever",
      "/boot",
      "/var/lib/docker/volumes",
    ]) {
      expect(() =>
        generateCompose({
          config: makeConfig({
            klanker: {
              admin: true,
              bind_mounts: [{ source: bad }],
            },
          }),
        }),
      ).toThrow(/denylisted system path/);
    }
  });

  it("rejects the docker socket explicitly (root-equivalent host control)", () => {
    expect(() =>
      generateCompose({
        config: makeConfig({
          klanker: {
            admin: true,
            bind_mounts: [{ source: "/var/run/docker.sock" }],
          },
        }),
      }),
    ).toThrow(/docker socket/);
  });

  it("rejects '/' itself as a source (would mount the entire host)", () => {
    expect(() =>
      generateCompose({
        config: makeConfig({
          klanker: {
            admin: true,
            bind_mounts: [{ source: "/" }],
          },
        }),
      }),
    ).toThrow(/denylisted system path/);
  });

  it("rejects relative or tilde-prefixed sources (no implicit expansion)", () => {
    for (const bad of ["~/code/switchroom", "code/switchroom", "./foo"]) {
      expect(() =>
        generateCompose({
          config: makeConfig({
            klanker: {
              admin: true,
              bind_mounts: [{ source: bad }],
            },
          }),
        }),
      ).toThrow(/must be an absolute path/);
    }
  });

  it("rejects sources containing '..'", () => {
    expect(() =>
      generateCompose({
        config: makeConfig({
          klanker: {
            admin: true,
            bind_mounts: [{ source: "/home/me/../etc/passwd" }],
          },
        }),
      }),
    ).toThrow(/contains '\.\.'/);
  });

  it("accepts sources whose path merely starts with '/' (not the literal root)", () => {
    // Sanity that the BIND_MOUNT_SOURCE_DENYLIST '/' entry doesn't poison
    // every legitimate absolute path.
    const out = generateCompose({
      config: makeConfig({
        klanker: {
          admin: true,
          bind_mounts: [{ source: "/home/me/code/switchroom" }],
        },
      }),
    });
    expect(out).toContain("/home/me/code/switchroom:/home/me/code/switchroom:ro");
  });

  // ── follow-up hardening (post-#1166 reviewer nits) ────────────────

  it("normalizes collapsed-slash sources before applying the denylist (//etc → /etc)", () => {
    // fails when: the textual denylist check is applied to the raw
    // source instead of the normalized form. Without normalization
    // `//etc` (which Linux/Docker collapse to `/etc` at mount time)
    // would pass the textual check despite being a clear attempt to
    // mount /etc. Admin-only blast radius, but the fix is one regex.
    for (const bad of [
      "//etc",
      "//etc/passwd",
      "//proc",
      "/etc//passwd",
    ]) {
      expect(() =>
        generateCompose({
          config: makeConfig({
            klanker: {
              admin: true,
              bind_mounts: [{ source: bad }],
            },
          }),
        }),
        `should refuse normalized source "${bad}"`,
      ).toThrow(/denylisted system path/);
    }
  });

  it("normalizes '.' segments before applying the denylist (/etc/. → /etc)", () => {
    // fails when: `.` segments aren't stripped before the denylist
    // prefix-match. An input like `/etc/.` resolves to `/etc` at mount
    // time but bypasses the textual check.
    for (const bad of ["/etc/.", "/./etc", "/etc/./passwd"]) {
      expect(() =>
        generateCompose({
          config: makeConfig({
            klanker: {
              admin: true,
              bind_mounts: [{ source: bad }],
            },
          }),
        }),
        `should refuse normalized source "${bad}"`,
      ).toThrow(/denylisted system path/);
    }
  });

  it("emits normalized paths in the generated compose (byte-stability)", () => {
    // Two textually-different inputs that normalize to the same canonical
    // form should produce byte-identical compose lines. Catches the
    // would-be regression of emitting the raw source verbatim.
    const a = generateCompose({
      config: makeConfig({
        klanker: { admin: true, bind_mounts: [{ source: "/home/me/proj" }] },
      }),
    });
    const b = generateCompose({
      config: makeConfig({
        klanker: { admin: true, bind_mounts: [{ source: "//home/me/proj/" }] },
      }),
    });
    // The bind-mount line itself should be identical, even if other
    // bytes differ (e.g. analytics IDs not present in tests).
    expect(a).toContain("- /home/me/proj:/home/me/proj:ro");
    expect(b).toContain("- /home/me/proj:/home/me/proj:ro");
    expect(b).not.toContain("//home/me/proj");
  });

  it("rejects targets that shadow switchroom-owned container paths", () => {
    // fails when: an admin agent can declare a target under /state,
    // /run/switchroom, /opt/switchroom, or /var/log/switchroom and
    // shadow the runtime mounts. Self-harm only (admin-trusted), but
    // the surprise mode (agent boots and silently misbehaves) is
    // worse than a clear error at compose-generation time.
    for (const bad of [
      "/state",
      "/state/agent",
      "/state/.claude",
      "/run/switchroom",
      "/run/switchroom/broker",
      "/opt/switchroom",
      "/opt/switchroom/switchroom.js",
      "/var/log/switchroom",
    ]) {
      expect(() =>
        generateCompose({
          config: makeConfig({
            klanker: {
              admin: true,
              bind_mounts: [{ source: "/home/me/dummy", target: bad }],
            },
          }),
        }),
        `should refuse switchroom-owned target "${bad}"`,
      ).toThrow(/denylisted container path/);
    }
  });

  it("rejects targets that shadow OS paths inside the container", () => {
    // Admin-only blast radius, but mounting host-anything at /etc
    // inside the container is almost certainly a misconfig — refuse
    // up front rather than letting the agent boot with surprising state.
    for (const bad of [
      "/etc",
      "/etc/passwd",
      "/bin",
      "/sbin",
      "/usr/bin",
      "/usr/sbin",
      "/lib",
      "/lib64",
      "/usr/lib",
      "/proc",
      "/sys",
      "/dev",
      "/boot",
    ]) {
      expect(() =>
        generateCompose({
          config: makeConfig({
            klanker: {
              admin: true,
              bind_mounts: [{ source: "/home/me/dummy", target: bad }],
            },
          }),
        }),
        `should refuse OS-shadow target "${bad}"`,
      ).toThrow(/denylisted container path/);
    }
  });

  it("rejects targets containing '..'", () => {
    expect(() =>
      generateCompose({
        config: makeConfig({
          klanker: {
            admin: true,
            bind_mounts: [
              { source: "/home/me/x", target: "/state/../etc/passwd" },
            ],
          },
        }),
      }),
    ).toThrow(/target.*contains '\.\.'/);
  });

  it("accepts well-formed targets outside the denylist", () => {
    // Sanity check — common operator targets must still work.
    const out = generateCompose({
      config: makeConfig({
        klanker: {
          admin: true,
          bind_mounts: [
            { source: "/home/me/shared", target: "/home/agent/shared", mode: "ro" },
            { source: "/home/me/notes", mode: "rw" },
          ],
        },
      }),
    });
    expect(out).toContain("- /home/me/shared:/home/agent/shared:ro");
    expect(out).toContain("- /home/me/notes:/home/me/notes\n");
  });
});

describe("host-control daemon bind mount (RFC C Phase 1)", () => {
  // EVERY agent gets a per-agent UDS bind mount when
  // host_control.enabled is true AND the host-side directory
  // exists (compose `up` hard-fails on missing bind sources).
  // Binding a socket ≠ granting admin: the socket is mounted for
  // admin and non-admin agents alike so "🔁 Always allow" can persist
  // fleet-wide via the self-scoped config_propose_edit path; every
  // privileged verb is still gated server-side in hostd's checkGate.
  // Since RFC C Phase 2 default-flip the schema defaults `enabled`
  // to true, so the bind mount appears when the block is absent.

  it("does NOT emit the hostd bind mount when host_control.enabled is explicitly false", async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "hostd-mount-off-"));
    try {
      mkdirSync(join(tmp, ".switchroom/hostd/klanker"), { recursive: true });
      const out = generateCompose({
        config: makeConfig(
          { klanker: { admin: true } },
          { host_control: { enabled: false } },
        ),
        homeDir: tmp,
      });
      expect(out).not.toMatch(
        /agent-klanker:[\s\S]*?\.switchroom\/hostd\/klanker:\/run\/switchroom\/hostd\/klanker/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("emits the hostd bind mount when host_control is absent (default-on since RFC C Phase 2)", async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "hostd-mount-default-on-"));
    try {
      mkdirSync(join(tmp, ".switchroom/hostd/klanker"), { recursive: true });
      const out = generateCompose({
        // No host_control block — schema default kicks in.
        config: makeConfig({ klanker: { admin: true } }),
        homeDir: tmp,
      });
      expect(out).toMatch(
        /agent-klanker:[\s\S]*?\.switchroom\/hostd\/klanker:\/run\/switchroom\/hostd\/klanker/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("DOES emit the hostd bind mount on non-admin agents when enabled (binding a socket ≠ admin)", async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "hostd-mount-nonadmin-"));
    try {
      mkdirSync(join(tmp, ".switchroom/hostd/bob"), { recursive: true });
      const out = generateCompose({
        config: makeConfig(
          { bob: {} },
          { host_control: { enabled: true } },
        ),
        homeDir: tmp,
      });
      // Non-admin bob gets the socket so its operator-tapped
      // "🔁 Always allow" grants persist via self-scoped config_propose_edit.
      expect(out).toMatch(
        /agent-bob:[\s\S]*?\.switchroom\/hostd\/bob:\/run\/switchroom\/hostd\/bob/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("emits the hostd bind mount for both admin and non-admin agents when enabled AND host dir exists", async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "hostd-mount-on-"));
    try {
      mkdirSync(join(tmp, ".switchroom/hostd/klanker"), { recursive: true });
      mkdirSync(join(tmp, ".switchroom/hostd/bob"), { recursive: true });
      const out = generateCompose({
        config: makeConfig(
          { klanker: { admin: true }, bob: {} },
          { host_control: { enabled: true } },
        ),
        homeDir: tmp,
      });
      expect(out).toMatch(
        new RegExp(
          `agent-klanker:[\\s\\S]*?${tmp.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}/\\.switchroom/hostd/klanker:/run/switchroom/hostd/klanker(?!:)`,
        ),
      );
      // bob (non-admin) gets the mount on the same fleet too.
      expect(out).toMatch(
        new RegExp(
          `agent-bob:[\\s\\S]*?${tmp.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}/\\.switchroom/hostd/bob:/run/switchroom/hostd/bob(?!:)`,
        ),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips the hostd bind mount when host dir doesn't exist (no compose hard-fail)", async () => {
    // Same pattern as the vault-audit.log guard: docker compose `up`
    // hard-fails when a bind source is missing. On a fresh install
    // before the daemon has booted, the per-agent dir won't exist
    // yet — emit nothing rather than blocking compose.
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "hostd-mount-fresh-"));
    try {
      // No mkdir — directory absent.
      const out = generateCompose({
        config: makeConfig(
          { klanker: { admin: true } },
          { host_control: { enabled: true } },
        ),
        homeDir: tmp,
      });
      expect(out).not.toMatch(/\.switchroom\/hostd\/klanker/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("agent service network (v0.7.4 — host networking)", () => {
  // Scaffolded start.sh hard-codes host-loopback URLs (e.g.
  // http://127.0.0.1:18888 for hindsight) and operator LAN IPs (HA,
  // smart-home gear). The default bridge network reaches none of those.
  // network_mode: host puts the agent on the host's network namespace,
  // so existing scaffolds with absolute hostnames Just Work without
  // a regen of every start.sh / settings.json. Tradeoff: no
  // inter-agent network isolation (the trust model assumed shared-
  // host operation anyway).
  it("emits network_mode: host on every agent service", () => {
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }),
    });
    for (const a of ["alice", "bob"]) {
      const re = new RegExp(`  agent-${a}:[\\s\\S]*?(?=\\n  [a-z])`);
      const block = re.exec(out)?.[0] ?? "";
      expect(block, `${a} block`).toMatch(/network_mode:\s*host/);
    }
  });

  it("does NOT emit network_mode: host on broker / kernel", () => {
    // Only agents need host networking — the singletons talk via UDS.
    const out = generateCompose({
      config: makeConfig({ a: {} }),
    });
    for (const svc of ["vault-broker", "approval-kernel"]) {
      const re = new RegExp(`  ${svc}:[\\s\\S]*?(?=\\n  [a-z]|\\nvolumes:)`);
      const block = re.exec(out)?.[0] ?? "";
      expect(block, `${svc} block`).not.toMatch(/network_mode:\s*host/);
    }
  });

  it("drops `hostname:` on agents (incompatible with network_mode: host)", () => {
    // docker emits a warning when both are set; cleaner to just not emit.
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }),
    });
    for (const a of ["alice", "bob"]) {
      const re = new RegExp(`  agent-${a}:[\\s\\S]*?(?=\\n  [a-z])`);
      const block = re.exec(out)?.[0] ?? "";
      expect(block, `${a} block`).not.toMatch(/^\s+hostname:/m);
    }
  });
});

describe("agent service tty (v0.7.4 — claude interactive mode)", () => {
  // Without tty + stdin_open, claude detects no-TTY at boot and falls
  // back to --print mode, which then errors "Input must be provided
  // either through stdin or as a prompt argument when using --print"
  // because start.sh exec's claude with no stdin pipe. Container
  // crash-loops forever. v0.6's systemd path got the PTY via the
  // tmux ExecStart wrapper; under docker we ask compose for it.
  it("emits tty: true and stdin_open: true on every agent service", () => {
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }),
    });
    for (const a of ["alice", "bob"]) {
      const re = new RegExp(`  agent-${a}:[\\s\\S]*?(?=\\n  [a-z])`);
      const block = re.exec(out)?.[0] ?? "";
      expect(block, `${a} block`).toMatch(/tty:\s*true/);
      expect(block, `${a} block`).toMatch(/stdin_open:\s*true/);
    }
  });

  it("does NOT emit tty / stdin_open on broker / kernel", () => {
    // Singletons run a long-lived server loop with no stdin reads;
    // forcing a TTY would just waste a fd.
    const out = generateCompose({
      config: makeConfig({ a: {} }),
    });
    for (const svc of ["vault-broker", "approval-kernel"]) {
      const re = new RegExp(`  ${svc}:[\\s\\S]*?(?=\\n  [a-z]|\\nvolumes:)`);
      const block = re.exec(out)?.[0] ?? "";
      expect(block, `${svc} block`).not.toMatch(/^\s+tty:\s*true/m);
      expect(block, `${svc} block`).not.toMatch(/^\s+stdin_open:\s*true/m);
    }
  });
});

describe("generateCompose — switchroomConfigPath bind-mount (v0.7 P0 fix)", () => {
  // Regression: without the config bind-mount, the broker container boots
  // with `ConfigError: No switchroom.yaml found` and restart-loops. The
  // fix bind-mounts the resolved switchroom.yaml into broker, kernel, and
  // scheduler at /state/config/switchroom.yaml, with SWITCHROOM_CONFIG
  // pointing at it so the in-container loader skips its cwd auto-detect.
  const CONFIG = "/home/op/switchroom.yaml";

  function blockFor(yml: string, service: string): string {
    const re = new RegExp(`  ${service}:[\\s\\S]*?(?=\\n  [a-z]|\\nvolumes:)`);
    return re.exec(yml)?.[0] ?? "";
  }

  it("bind-mounts switchroom.yaml + sets SWITCHROOM_CONFIG on the broker", () => {
    const out = generateCompose({
      config: makeConfig({ a: {} }),
      switchroomConfigPath: CONFIG,
    });
    const block = blockFor(out, "vault-broker");
    expect(block).toContain(`${CONFIG}:/state/config/switchroom.yaml:ro`);
    expect(block).toMatch(/SWITCHROOM_CONFIG:\s*\/state\/config\/switchroom\.yaml/);
  });

  it("bind-mounts switchroom.yaml + sets SWITCHROOM_CONFIG on the approval-kernel", () => {
    const out = generateCompose({
      config: makeConfig({ a: {} }),
      switchroomConfigPath: CONFIG,
    });
    const block = blockFor(out, "approval-kernel");
    expect(block).toContain(`${CONFIG}:/state/config/switchroom.yaml:ro`);
    expect(block).toMatch(/SWITCHROOM_CONFIG:\s*\/state\/config\/switchroom\.yaml/);
  });

  // Phase 4 cron-fold-in cutover removed the singleton scheduler
  // service from compose, so the per-scheduler bind-mount + env-var
  // assertions that lived here have been retired with it. Per-agent
  // services bind-mount switchroom.yaml read-only at the same path —
  // see the agent-service env tests below.

  it("back-compat: omitting switchroomConfigPath leaves broker/kernel without the mount", () => {
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    const broker = blockFor(out, "vault-broker");
    expect(broker).not.toContain(":/state/config/switchroom.yaml");
    const kernel = blockFor(out, "approval-kernel");
    expect(kernel).not.toContain(":/state/config/switchroom.yaml");
  });

  it("bind-mounts switchroom.yaml + sets SWITCHROOM_CONFIG on each agent (v0.7.6)", () => {
    // The in-container telegram-plugin gateway sidecar shells out to
    // the switchroom CLI for handoff / vault / topic operations and
    // passes `--config $SWITCHROOM_CONFIG`. Without this mount the
    // gateway boots, fails to resolve the config, and access-control
    // checks default to deny.
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }),
      switchroomConfigPath: CONFIG,
    });
    const re = (a: string) =>
      new RegExp(`  agent-${a}:[\\s\\S]*?(?=\\n  [a-z])`);
    for (const a of ["alice", "bob"]) {
      const block = re(a).exec(out)?.[0] ?? "";
      expect(block, `${a} bind-mount`).toContain(
        `${CONFIG}:/state/config/switchroom.yaml:ro`,
      );
      expect(block, `${a} env`).toMatch(
        /SWITCHROOM_CONFIG:\s*"\/state\/config\/switchroom\.yaml"/,
      );
    }
  });

  it("back-compat: omitting switchroomConfigPath leaves agent without the mount", () => {
    const out = generateCompose({ config: makeConfig({ alice: {} }) });
    const re = /  agent-alice:[\s\S]*?(?=\n  [a-z])/;
    const block = re.exec(out)?.[0] ?? "";
    expect(block).not.toContain(":/state/config/switchroom.yaml");
    expect(block).not.toMatch(/SWITCHROOM_CONFIG:/);
  });
});

describe("generateCompose — buildMode (pull vs local)", () => {
  it("default mode emits ghcr.io image refs and no build: blocks", () => {
    const out = generateCompose({ config: makeConfig({ alice: {} }) });
    expect(out).toContain("image: ghcr.io/switchroom/switchroom-broker:latest");
    expect(out).toContain("image: ghcr.io/switchroom/switchroom-kernel:latest");
    expect(out).toContain("image: ghcr.io/switchroom/switchroom-agent:latest");
    // Phase 4 cron-fold-in cutover: the singleton scheduler image was
    // retired with the singleton service.
    expect(out).not.toContain("switchroom-scheduler:");
    expect(out).not.toContain("build:");
    expect(out).not.toMatch(/dockerfile: docker\/Dockerfile/);
  });

  it("buildMode=local emits build: blocks pointing at the supplied context", () => {
    const ctx = "/abs/path/to/switchroom";
    const out = generateCompose({
      config: makeConfig({ alice: {} }),
      buildMode: "local",
      buildContext: ctx,
    });
    expect(out).not.toMatch(/image: ghcr\.io\//);
    // Three Dockerfiles after Phase 4 — agent, broker, kernel.
    for (const df of ["agent", "broker", "kernel"]) {
      expect(out).toContain(`dockerfile: docker/Dockerfile.${df}`);
    }
    expect(out).not.toContain("Dockerfile.scheduler");
    expect(out).toContain(`context: ${ctx}`);
    expect(out.match(/dockerfile: docker\/Dockerfile\.agent/g)?.length).toBe(1);
  });

  it("buildMode=local without buildContext throws", () => {
    expect(() =>
      generateCompose({
        config: makeConfig({ alice: {} }),
        buildMode: "local",
      }),
    ).toThrow(/buildContext/);
  });

  it("imageTag flows through in pull mode", () => {
    const out = generateCompose({
      config: makeConfig({ alice: {} }),
      imageTag: "v0.7.3",
    });
    expect(out).toContain("image: ghcr.io/switchroom/switchroom-broker:v0.7.3");
    expect(out).toContain("image: ghcr.io/switchroom/switchroom-agent:v0.7.3");
  });
});

describe("agent service env — user-declared env propagation", () => {
  // Operator-declared env vars (the `env:` block in switchroom.yaml)
  // must land in the compose `environment:` block, not just in
  // start.sh's later `export` lines. The gateway sidecar is forked
  // BEFORE start.sh exports user env (start.sh.hbs:88) — without
  // compose-level propagation the gateway never sees these vars,
  // silently breaking knobs like SWITCHROOM_SUBAGENT_STALL_TERMINAL_MS
  // (the UAT enablement knobs from #1110). Surfaced 2026-05-12 when
  // a live-edit was the only way to feed env vars into the gateway.
  function envBlockFor(yml: string, agent: string): string {
    const re = new RegExp(
      `  agent-${agent}:[\\s\\S]*?    environment:([\\s\\S]*?)\\n    volumes:`,
    );
    return re.exec(yml)?.[1] ?? "";
  }

  it("emits operator-declared env vars in the compose environment block", () => {
    const out = generateCompose({
      config: makeConfig({
        alice: {
          env: {
            SWITCHROOM_SUBAGENT_STALL_TERMINAL_MS: "10000",
            CUSTOM_KNOB: "hello",
          },
        },
      }),
    });
    const env = envBlockFor(out, "alice");
    expect(env).toMatch(/SWITCHROOM_SUBAGENT_STALL_TERMINAL_MS:\s*"10000"/);
    expect(env).toMatch(/CUSTOM_KNOB:\s*"hello"/);
  });

  it("system-managed keys (HOME, SWITCHROOM_RUNTIME) win on collision with user env", () => {
    // An operator can't override the runtime contract from yaml —
    // the compose-level defaults stay authoritative. Without this
    // guard a yaml typo could silently re-target HOME away from
    // /state/agent/home and break the agent's writable mounts.
    const out = generateCompose({
      config: makeConfig({
        bob: {
          env: {
            HOME: "/tmp/operator-takeover",
            SWITCHROOM_RUNTIME: "host",
          },
        },
      }),
    });
    const env = envBlockFor(out, "bob");
    expect(env).toMatch(/HOME:\s*"\/state\/agent\/home"/);
    expect(env).toMatch(/SWITCHROOM_RUNTIME:\s*"docker"/);
    expect(env).not.toMatch(/HOME:\s*"\/tmp\/operator-takeover"/);
  });

  it("agents without env: declared still emit the standard system env", () => {
    const out = generateCompose({ config: makeConfig({ charlie: {} }) });
    const env = envBlockFor(out, "charlie");
    expect(env).toMatch(/SWITCHROOM_RUNTIME:\s*"docker"/);
    expect(env).toMatch(/HOME:\s*"\/state\/agent\/home"/);
  });
});

describe("SWITCHROOM_TMUX_SUPERVISOR env provisioning (#725 enabler)", () => {
  // The gateway's deterministic in-chat `/auth add` OAuth flow
  // (telegram-plugin/gateway/auth-add-flow.ts) HARD-REFUSES to launch
  // unless SWITCHROOM_TMUX_SUPERVISOR === "1". The guard shipped in
  // v0.19.2 with NO provisioning — nothing in the compose render, start.sh,
  // or the container env ever set it — so the flow was unreachable on every
  // agent. These tests assert the OUTCOME the bug was: the var is present
  // (=="1") on a default (tmux-supervisor) agent and "0" on a legacy_pty
  // agent, not merely that some code path ran. The value is emitted in BOTH
  // branches (never omitted) so it is always system-authoritative — an
  // operator env: override can never smuggle "1" onto a legacy_pty agent.
  function envBlockFor(yml: string, agent: string): string {
    const re = new RegExp(
      `  agent-${agent}:[\\s\\S]*?    environment:([\\s\\S]*?)\\n    volumes:`,
    );
    return re.exec(yml)?.[1] ?? "";
  }

  it("emits SWITCHROOM_TMUX_SUPERVISOR=\"1\" for a default (tmux-supervisor) agent", () => {
    const out = generateCompose({ config: makeConfig({ klanker: {} }) });
    const env = envBlockFor(out, "klanker");
    expect(env).toMatch(/SWITCHROOM_TMUX_SUPERVISOR:\s*"1"/);
  });

  it("emits it for an agent that explicitly sets experimental.legacy_pty=false", () => {
    const out = generateCompose({
      config: makeConfig({ klanker: { experimental: { legacy_pty: false } } }),
    });
    const env = envBlockFor(out, "klanker");
    expect(env).toMatch(/SWITCHROOM_TMUX_SUPERVISOR:\s*"1"/);
  });

  it("emits SWITCHROOM_TMUX_SUPERVISOR=\"0\" when the operator opted into experimental.legacy_pty=true", () => {
    const out = generateCompose({
      config: makeConfig({ klanker: { experimental: { legacy_pty: true } } }),
    });
    const env = envBlockFor(out, "klanker");
    expect(env).toMatch(/SWITCHROOM_TMUX_SUPERVISOR:\s*"0"/);
    expect(env).not.toMatch(/SWITCHROOM_TMUX_SUPERVISOR:\s*"1"/);
  });

  it("is system-authoritative under legacy_pty — an operator env: override can't smuggle \"1\" onto a non-tmux agent", () => {
    // Finding A1: before the fix the key was left UNSET under legacy_pty, so
    // the userEnv merge (which only fills undefined keys) let an operator
    // `env: { SWITCHROOM_TMUX_SUPERVISOR: "1" }` (the interim workaround)
    // pass straight through and wrongly launch the tmux auth-add flow on a
    // legacy-PTY agent with no tmux supervisor. Emitting "0" here makes the
    // system value win and the override is rejected.
    const out = generateCompose({
      config: makeConfig({
        klanker: {
          experimental: { legacy_pty: true },
          env: { SWITCHROOM_TMUX_SUPERVISOR: "1" },
        },
      }),
    });
    const env = envBlockFor(out, "klanker");
    expect(env).toMatch(/SWITCHROOM_TMUX_SUPERVISOR:\s*"0"/);
    expect(env).not.toMatch(/SWITCHROOM_TMUX_SUPERVISOR:\s*"1"/);
  });

  it("is system-authoritative — an operator env: block can't clobber it on a supervisor agent", () => {
    // The pre-fix interim workaround was to hand-set this in `env:`; now it
    // is compose-provisioned and the "1" must win over any yaml value so a
    // stale/typo'd override can't silently disable the auth-add flow.
    const out = generateCompose({
      config: makeConfig({
        klanker: { env: { SWITCHROOM_TMUX_SUPERVISOR: "0" } },
      }),
    });
    const env = envBlockFor(out, "klanker");
    expect(env).toMatch(/SWITCHROOM_TMUX_SUPERVISOR:\s*"1"/);
    expect(env).not.toMatch(/SWITCHROOM_TMUX_SUPERVISOR:\s*"0"/);
  });

  it("describeAgents surfaces tmuxSupervisor true by default and false under legacy_pty", () => {
    const [dflt] = describeAgents(makeConfig({ klanker: {} }));
    expect(dflt!.tmuxSupervisor).toBe(true);
    const [legacy] = describeAgents(
      makeConfig({ klanker: { experimental: { legacy_pty: true } } }),
    );
    expect(legacy!.tmuxSupervisor).toBe(false);
  });
});

describe("describeAgents", () => {
  it("returns sorted agents with allocated UIDs", () => {
    const agents = describeAgents(makeConfig({ zebra: {}, alpha: {} }));
    expect(agents.map((a) => a.name)).toEqual(["alpha", "zebra"]);
    for (const a of agents) {
      expect(a.uid).toBeGreaterThanOrEqual(AGENT_UID_MIN);
      expect(a.uid).toBeLessThanOrEqual(AGENT_UID_MAX);
    }
  });
});

describe("singleton healthchecks (silent-down regression — see plans/singleton-healthchecks.md)", () => {
  // The compose file used to emit `restart: unless-stopped` on every
  // service with NO `healthcheck:` anywhere. Docker could only see
  // "process running"; a hung-but-not-crashed broker or one that
  // exited cleanly was invisible to `docker compose ps`. The fix is
  // a bind-presence probe on each singleton — confirms at least one
  // per-agent socket has been bound by the daemon.
  //
  // We pin the emitted block byte-for-byte so a future operator
  // can't silently drop the probe with a refactor.
  function blockFor(yml: string, service: string): string {
    const re = new RegExp(`  ${service}:[\\s\\S]*?(?=\\n  [a-z]|\\nvolumes:|$)`);
    return re.exec(yml)?.[0] ?? "";
  }

  it("emits a healthcheck on vault-broker", () => {
    const out = generateCompose({ config: makeConfig({ alice: {} }) });
    const block = blockFor(out, "vault-broker");
    expect(block).toContain("healthcheck:");
    // CMD-SHELL form — the probe is shell-piping `ls | head -1 | grep`
    // and won't work as a bare exec list.
    expect(block).toMatch(/test:\s*\[\s*"CMD-SHELL"\s*,/);
    expect(block).toContain("/run/switchroom/broker/*/sock");
    expect(block).toMatch(/interval:\s*30s/);
    expect(block).toMatch(/timeout:\s*5s/);
    expect(block).toMatch(/retries:\s*3/);
    // start_period gives the broker time to bind its first socket
    // before the probe starts firing — without it, the broker spends
    // the first ~10s flagged unhealthy on every cold start.
    expect(block).toMatch(/start_period:\s*20s/);
  });

  it("emits a healthcheck on approval-kernel mirroring the broker shape", () => {
    const out = generateCompose({ config: makeConfig({ alice: {} }) });
    const block = blockFor(out, "approval-kernel");
    expect(block).toContain("healthcheck:");
    expect(block).toMatch(/test:\s*\[\s*"CMD-SHELL"\s*,/);
    expect(block).toContain("/run/switchroom/kernel/*/sock");
    expect(block).toMatch(/interval:\s*30s/);
    expect(block).toMatch(/timeout:\s*5s/);
    expect(block).toMatch(/retries:\s*3/);
    expect(block).toMatch(/start_period:\s*20s/);
  });

  it("does NOT emit healthchecks on agents (higher-fidelity signal lives in boot-card / tmux)", () => {
    const out = generateCompose({ config: makeConfig({ alice: {}, bob: {} }) });
    for (const a of ["alice", "bob"]) {
      const block = blockFor(out, `agent-${a}`);
      expect(block, `agent-${a} should have no healthcheck:`).not.toMatch(/^\s+healthcheck:/m);
    }
  });

  it("probes use the per-agent socket path (path-as-identity invariant)", () => {
    // The broker/kernel use socketPathToAgent(/run/switchroom/<svc>/<agent>/sock)
    // for peer auth. The healthcheck must probe the same path shape so
    // it actually exercises the binding code, not some sibling pidfile
    // or status sentinel. Pin the exact glob.
    const out = generateCompose({ config: makeConfig({ alice: {} }) });
    expect(out).toContain(`"ls /run/switchroom/broker/*/sock 2>/dev/null | head -1 | grep -q . && test -f /run/switchroom/broker/.ready"`);
    expect(out).toContain(`"ls /run/switchroom/kernel/*/sock 2>/dev/null | head -1 | grep -q ."`);
  });

  it("broker health = serving AND unlocked (RFC J Phase 4 readiness sentinel)", () => {
    // A locked broker reading "healthy" (bind-presence only) masked
    // the install-validation 2026-05-17 incident. The probe now also
    // requires the readiness sentinel the broker writes on unlock /
    // unlinks on lock, fed via SWITCHROOM_VAULT_BROKER_READY_PATH.
    const out = generateCompose({ config: makeConfig({ alice: {} }) });
    const block = blockFor(out, "vault-broker");
    expect(block).toContain("SWITCHROOM_VAULT_BROKER_READY_PATH: /run/switchroom/broker/.ready");
    expect(block).toContain("test -f /run/switchroom/broker/.ready");
    // kernel healthcheck unchanged (no readiness sentinel there).
    const kblock = blockFor(out, "approval-kernel");
    expect(kblock).not.toContain(".ready");
  });
});

describe("Phase 4 cutover: agent-scheduler is default-on", () => {
  // Phase 3 used `experimental.inline_scheduler: true` + a per-agent
  // SWITCHROOM_INLINE_SCHEDULER=1 env emission to canary the in-agent
  // scheduler one agent at a time. Phase 4 removed both — the start.sh
  // sidecar starts unconditionally (gated only by the bundle existing
  // at /opt/switchroom/agent-scheduler/index.js + bun on PATH), and
  // operators can disable per-container by setting the env var to "0".

  it("does not emit SWITCHROOM_INLINE_SCHEDULER (no longer per-agent config)", () => {
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }),
    });
    expect(out).not.toContain("SWITCHROOM_INLINE_SCHEDULER");
  });

  it("emits no scheduler container at all", () => {
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }),
    });
    expect(out).not.toContain("switchroom-cron");
    expect(out).not.toContain("switchroom-scheduler");
  });
});

// Regression — cross-project consumer volume naming. The auth-broker
// binds a per-consumer UDS at /run/switchroom/auth-broker/<consumer>/sock
// inside a named docker volume (`auth-broker-<consumer>-sock`). Per-agent
// volumes use the same shape but live inside this same compose project,
// so the docker-compose `<project>_` prefix is invisible to their
// consumer (the agent service, in the same project).
//
// Per-CONSUMER volumes are different: the consumer container (e.g.
// hindsight, started via `startHindsight()` / `docker run`) lives outside
// the switchroom compose project. It references the volume by the name
// declared in src/setup/hindsight.ts (`auth-broker-hindsight-sock`). If
// docker-compose project-prefixes the volume to
// `switchroom_auth-broker-hindsight-sock`, the consumer's `-v` mount
// resolves to a NEW empty volume → the consumer's entrypoint times out
// on the missing UDS and the container crash-loops.
//
// The generator must therefore declare per-consumer volumes with an
// explicit `name:` override that suppresses the project prefix.
describe("auth-broker per-consumer volume naming (cross-project)", () => {
  function makeConfigWithConsumer(name: string) {
    const cfg = makeConfig({ a: {} }) as unknown as Record<string, unknown>;
    cfg.auth = {
      active: "k@example.com",
      consumers: [{ name, account: "k@example.com", uid: 11000 }],
    };
    return cfg as unknown as SwitchroomConfig;
  }

  it("declares the per-consumer volume with an unprefixed `name:` override", () => {
    const out = generateCompose({ config: makeConfigWithConsumer("hindsight") });
    // The volumes: block must contain the consumer volume AND a `name:`
    // line right under it. The `name:` keeps docker-compose's project
    // prefix off so the cross-project consumer can mount it by the
    // documented name.
    expect(out).toMatch(
      /^ {2}auth-broker-hindsight-sock:\n {4}name: auth-broker-hindsight-sock$/m,
    );
  });

  it("still binds the consumer's per-consumer dir inside the broker", () => {
    const out = generateCompose({ config: makeConfigWithConsumer("hindsight") });
    expect(out).toContain(
      "- auth-broker-hindsight-sock:/run/switchroom/auth-broker/hindsight",
    );
  });

  it("does NOT add a `name:` override on per-agent volumes (intra-project, prefix is fine)", () => {
    const out = generateCompose({ config: makeConfig({ alice: {} }) });
    // The per-agent volume declaration is a bare `  alice-...:` line —
    // no `    name:` continuation line under it. (Per-consumer volumes
    // get the override; per-agent volumes don't because they're
    // consumed inside this same compose project.)
    expect(out).not.toMatch(
      /^ {2}auth-broker-alice-sock:\n {4}name:/m,
    );
  });

  it("emits an override line for every consumer (not just hindsight)", () => {
    const cfg = makeConfig({ a: {} }) as unknown as Record<string, unknown>;
    cfg.auth = {
      active: "k@example.com",
      consumers: [
        { name: "hindsight", account: "k@example.com", uid: 11000 },
        { name: "indexer", account: "k@example.com", uid: 11001 },
      ],
    };
    const out = generateCompose({ config: cfg as unknown as SwitchroomConfig });
    expect(out).toMatch(/^ {2}auth-broker-hindsight-sock:\n {4}name: auth-broker-hindsight-sock$/m);
    expect(out).toMatch(/^ {2}auth-broker-indexer-sock:\n {4}name: auth-broker-indexer-sock$/m);
  });
});

describe("network_isolation — sec WS6-F1 / feature #1413", () => {
  it("ZERO regression: default fleet still emits network_mode: host, no networks block", () => {
    const out = generateCompose({ config: makeConfig({ klanker: {}, bob: {} }) });
    expect(out).toContain("network_mode: host");
    // None of the strict-mode tokens leak into a default fleet.
    expect(out).not.toContain("switchroom-net-");
    expect(out).not.toContain("host.docker.internal:host-gateway");
    expect(out).not.toMatch(/^networks:$/m);
  });

  it("explicit network_isolation: host is identical to the default", () => {
    const def = generateCompose({ config: makeConfig({ klanker: {} }) });
    const explicit = generateCompose({
      config: makeConfig({ klanker: { network_isolation: "host" } }),
    });
    expect(explicit).toBe(def);
  });

  it("strict: dedicated per-agent network + host-gateway, no network_mode host", () => {
    const out = generateCompose({
      config: makeConfig({ klanker: { network_isolation: "strict" } }),
    });
    // Service block: joins ONLY its own net, reaches host via gateway.
    expect(out).toMatch(/agent-klanker:[\s\S]*?networks:\n {6}- switchroom-net-klanker/);
    expect(out).toMatch(
      /agent-klanker:[\s\S]*?extra_hosts:\n {6}- "host\.docker\.internal:host-gateway"/,
    );
    const klankerBlock =
      /agent-klanker:[\s\S]*?(?=\n {2}agent-|\nvolumes:)/.exec(out)?.[0] ?? "";
    expect(klankerBlock).not.toContain("network_mode: host");
    // Top-level networks block defines the dedicated bridge.
    expect(out).toMatch(/^networks:\n {2}switchroom-net-klanker:\n {4}driver: bridge/m);
  });

  it("cascades from defaults (global opt-in) to an agent with no override", () => {
    const cfg = makeConfig({ klanker: {} });
    (cfg as unknown as { defaults: Record<string, unknown> }).defaults = {
      network_isolation: "strict",
    };
    const out = generateCompose({ config: cfg });
    const block =
      /agent-klanker:[\s\S]*?(?=\n {2}agent-|\nvolumes:)/.exec(out)?.[0] ?? "";
    expect(block).toContain("switchroom-net-klanker");
    expect(block).not.toContain("network_mode: host");
  });

  it("per-agent override beats the global default", () => {
    const cfg = makeConfig({ klanker: { network_isolation: "host" } });
    (cfg as unknown as { defaults: Record<string, unknown> }).defaults = {
      network_isolation: "strict",
    };
    const out = generateCompose({ config: cfg });
    const block =
      /agent-klanker:[\s\S]*?(?=\n {2}agent-|\nvolumes:)/.exec(out)?.[0] ?? "";
    expect(block).toContain("network_mode: host");
    expect(block).not.toContain("switchroom-net-klanker");
  });

  it("mixed fleet: host agent unchanged, only strict agents get a network", () => {
    const out = generateCompose({
      config: makeConfig({
        hostagent: {},
        isolated: { network_isolation: "strict" },
      }),
    });
    const hostBlock =
      /agent-hostagent:[\s\S]*?(?=\n {2}agent-|\nvolumes:)/.exec(out)?.[0] ?? "";
    expect(hostBlock).toContain("network_mode: host");
    expect(hostBlock).not.toContain("switchroom-net-");
    const isoBlock =
      /agent-isolated:[\s\S]*?(?=\n {2}agent-|\nvolumes:)/.exec(out)?.[0] ?? "";
    expect(isoBlock).toContain("switchroom-net-isolated");
    expect(isoBlock).not.toContain("network_mode: host");
    // Top-level networks lists ONLY the strict agent's net.
    expect(out).toContain("switchroom-net-isolated:");
    expect(out).not.toContain("switchroom-net-hostagent:");
  });
});

describe("root-tier debugging agent (root: true)", () => {
  // Extract just the named agent's service block from the compose YAML.
  function blockFor(out: string, name: string): string {
    return (
      new RegExp(`agent-${name}:[\\s\\S]*?(?=\\n {2}agent-|\\nvolumes:)`).exec(out)?.[0] ?? ""
    );
  }

  it("runs as uid 0 and skips the per-agent hardening", () => {
    const out = generateCompose({ config: makeConfig({ overlord: { root: true } }) });
    const block = blockFor(out, "overlord");
    expect(block).toContain(`user: "0:0"`);
    expect(block).not.toContain(`user: "1`); // no allocated 10001-10999 UID
    // The root tier deliberately drops the hardening — docker.sock already
    // makes it root-on-host, so the hardening would only block its job.
    expect(block).not.toContain("no-new-privileges");
    expect(block).not.toContain("read_only: true");
    expect(block).not.toMatch(/cap_drop:\s*\n\s*-\s*"ALL"/);
    // tmpfs /tmp is still present (RAM-backed, capped).
    expect(block).toContain(`/tmp:size=${DEFAULT_TMP_SIZE}`);
  });

  it("mounts docker.sock, the whole ~/.switchroom tree, and the host root fs", () => {
    const out = generateCompose({ config: makeConfig({ overlord: { root: true } }) });
    const block = blockFor(out, "overlord");
    expect(block).toContain("/var/run/docker.sock:/var/run/docker.sock:rw");
    expect(block).toContain("/.switchroom:/host-home/.switchroom:rw");
    expect(block).toContain("- /:/host:rw");
  });

  it("implies admin: emits SWITCHROOM_AGENT_ADMIN and SWITCHROOM_AGENT_ROOT", () => {
    const out = generateCompose({ config: makeConfig({ overlord: { root: true } }) });
    const block = blockFor(out, "overlord");
    expect(block).toContain("SWITCHROOM_AGENT_ROOT: \"true\"");
    expect(block).toContain("SWITCHROOM_AGENT_ADMIN: \"true\"");
    // describeAgents reports admin true for a root agent (gate fan-out).
    const meta = describeAgents(makeConfig({ overlord: { root: true } }));
    expect(meta[0]?.root).toBe(true);
    expect(meta[0]?.admin).toBe(true);
  });

  it("does NOT leak root privileges to a normal agent", () => {
    const out = generateCompose({
      config: makeConfig({ overlord: { root: true }, coach: {} }),
    });
    const coach = blockFor(out, "coach");
    expect(coach).not.toContain("/var/run/docker.sock");
    expect(coach).not.toContain("- /:/host:rw");
    expect(coach).not.toContain("SWITCHROOM_AGENT_ROOT");
    expect(coach).not.toContain(`user: "0:0"`);
    // Normal agent keeps its hardening.
    expect(coach).toContain("no-new-privileges:true");
    expect(coach).toContain("read_only: true");
  });

  it("a plain admin agent is NOT granted the root mount set", () => {
    const out = generateCompose({ config: makeConfig({ chief: { admin: true } }) });
    const block = blockFor(out, "chief");
    expect(block).toContain("SWITCHROOM_AGENT_ADMIN: \"true\"");
    expect(block).not.toContain("SWITCHROOM_AGENT_ROOT");
    expect(block).not.toContain("/var/run/docker.sock");
    expect(block).not.toContain("- /:/host:rw");
    expect(block).toContain("read_only: true");
  });
});

describe("conditional-mount probe home (in-hostd apply — marko meta_pages regression)", () => {
  // When apply runs INSIDE hostd, homeDir is the real HOST home
  // (SWITCHROOM_HOST_HOME=/home/op — what the agent must see, baked into the
  // mount source), but that path does NOT exist in hostd's own filesystem;
  // the operator's dirs are bind-mounted at /host-home. The existsSync probes
  // that gate optional mounts must therefore use probeHomeDir (the
  // container-real home), not homeDir — else every conditional mount
  // (mcp-launchers, skills, fleet, …) is silently dropped and agents recreated
  // by an in-hostd reconcile lose them. 2026-06-15 marko outage.
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-probe-home-"));
    mkdirSync(join(tmpDir, ".switchroom", "mcp-launchers"), { recursive: true });
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits the mcp-launchers mount using homeDir when the dir exists at probeHomeDir", () => {
    const yaml = generateCompose({
      config: makeConfig({ klanker: {} }),
      homeDir: "/home/op", // baked source — does NOT exist on this filesystem
      probeHomeDir: tmpDir, // real filesystem home (mirrors /host-home in hostd)
    });
    // Probe hit at probeHomeDir → mount emitted, SOURCE baked from homeDir.
    expect(yaml).toContain(
      "/home/op/.switchroom/mcp-launchers:/home/op/.switchroom/mcp-launchers:ro",
    );
  });

  it("DROPS the mount when probeHomeDir is omitted (defaults to homeDir — the bug)", () => {
    const yaml = generateCompose({
      config: makeConfig({ klanker: {} }),
      homeDir: "/home/op", // probeHome defaults to this; /home/op has no launchers dir here
    });
    // existsSync(/home/op/.switchroom/mcp-launchers) is false → not mounted.
    // This is exactly the in-hostd failure mode the probeHomeDir split fixes.
    expect(yaml).not.toContain("/.switchroom/mcp-launchers:");
  });

  // #TBD: the cloakbrowser shared-Chromium mount used to probe (and bake)
  // `~/.cloakbrowser`, which sits OUTSIDE the only subtree hostd bind-mounts
  // (`~/.switchroom/`). So on every in-hostd generation the existsSync guard
  // was false and the mount was silently never emitted — each agent then
  // downloaded its own private ~697MB Chromium (5 agents ≈ 3.4GB observed).
  // Moving the source under `~/.switchroom/` makes the probe truthful in the
  // hostd context. This test fails on pristine main.
  it("emits the shared cloakbrowser mount on an in-hostd apply (#TBD)", () => {
    // Mirror hostd exactly: only ~/.switchroom is visible at probeHomeDir.
    mkdirSync(join(tmpDir, ".switchroom", "cloakbrowser", "chromium-146.0"), {
      recursive: true,
    });
    const yaml = generateCompose({
      config: makeConfig({ klanker: {} }),
      homeDir: "/home/op", // baked source — does NOT exist on this filesystem
      probeHomeDir: tmpDir, // container-real home (mirrors /host-home in hostd)
    });
    expect(yaml).toContain(
      "/home/op/.switchroom/cloakbrowser:/opt/switchroom/cloakbrowser-cache:ro",
    );
    // The legacy HOME-shadowing target must be gone: cloakbrowser resolves
    // the cache via CLOAKBROWSER_CACHE_DIR, not via $HOME/.cloakbrowser.
    expect(yaml).not.toContain("/state/agent/home/.cloakbrowser");
  });

  it("keeps the shared cloakbrowser mount read-only (#TBD)", () => {
    // Load-bearing: a shared WRITABLE browser cache would let one agent
    // rewrite a Chromium binary every other agent executes as itself.
    mkdirSync(join(tmpDir, ".switchroom", "cloakbrowser", "chromium-146.0"), {
      recursive: true,
    });
    const yaml = generateCompose({
      config: makeConfig({ klanker: {} }),
      homeDir: "/home/op",
      probeHomeDir: tmpDir,
    });
    expect(yaml).not.toContain(
      "/home/op/.switchroom/cloakbrowser:/opt/switchroom/cloakbrowser-cache:rw",
    );
  });

  // #2387: a conditional dir that is a symlink to an ABSOLUTE host path
  // (skills -> /home/op/.switchroom-config/skills) is dropped by plain
  // existsSync inside hostd (follows the link to /home/op, unresolvable there).
  it("keeps a symlinked conditional dir (skills→absolute host path) on in-hostd apply (#2387)", () => {
    // skills is a symlink to an absolute HOST path; the target only resolves
    // when translated to the container-real home (probeHomeDir).
    mkdirSync(join(tmpDir, ".switchroom-config", "skills"), { recursive: true });
    symlinkSync("/home/op/.switchroom-config/skills", join(tmpDir, ".switchroom", "skills"));
    const yaml = generateCompose({
      config: makeConfig({ klanker: {} }),
      homeDir: "/home/op",
      probeHomeDir: tmpDir,
    });
    // The symlink-aware probe resolves the target via probeHome → mount emitted
    // with the HOST-rooted source (docker follows the symlink host-side).
    expect(yaml).toContain("/home/op/.switchroom/skills:/home/op/.switchroom/skills:ro");
  });

  // #2512: hostd only mounts ~/.switchroom into its container — NOT
  // ~/.switchroom-config or any other operator dir. A symlink like
  //   ~/.switchroom/skills -> /home/op/.switchroom-config/skills
  // points at a host-rooted path. The translated target becomes
  // /host-home/.switchroom-config/skills which does NOT exist inside the
  // container (because .switchroom-config isn't mounted). The #2387 fix
  // translated the target and then checked existsSync on the translated path —
  // still false → mount dropped again. The correct behaviour: a symlink whose
  // target starts with hostHome is unambiguously host-rooted; docker resolves
  // it host-side at bind-mount time regardless of whether the translated path
  // is reachable inside the container.
  it("keeps a symlinked skills dir even when the symlink target is not reachable in the container (#2512)", () => {
    // Simulate the production setup: ~/.switchroom/skills is a symlink to
    // /home/op/.switchroom-config/skills, but ~/.switchroom-config/ is NOT
    // mounted into probeHomeDir (hostd only mounts ~/.switchroom).
    // So the translated target /probeHomeDir/.switchroom-config/skills does not exist.
    mkdirSync(join(tmpDir, ".switchroom"), { recursive: true });
    // Only create the symlink, NOT the target inside tmpDir — mirrors hostd.
    symlinkSync("/home/op/.switchroom-config/skills", join(tmpDir, ".switchroom", "skills"));
    const yaml = generateCompose({
      config: makeConfig({ klanker: {} }),
      homeDir: "/home/op",
      probeHomeDir: tmpDir,
    });
    // Symlink exists and its target is host-home-rooted → mount must be emitted.
    // Docker resolves the symlink host-side; we must not drop it because the
    // translated target happens to be outside the container's bind tree.
    expect(yaml).toContain("/home/op/.switchroom/skills:/home/op/.switchroom/skills:ro");
  });

  // #2383: a bundled-skills pool OUTSIDE ~/.switchroom/skills must bake a
  // HOST-rooted mount source, not the container-real /host-home path.
  it("bakes a host-rooted source for an out-of-skills bundled pool on in-hostd apply (#2383)", () => {
    const pool = join(tmpDir, "ext-skills-pool");
    mkdirSync(pool, { recursive: true });
    const yaml = generateCompose({
      config: makeConfig({ klanker: {} }),
      homeDir: "/home/op",
      probeHomeDir: tmpDir,
      bundledSkillsPoolDir: pool, // probeHome-rooted (container-real)
    });
    // Emitted with the translated HOST path, NOT the container-real tmpDir path.
    expect(yaml).toContain("/home/op/ext-skills-pool:/home/op/ext-skills-pool:ro");
    expect(yaml).not.toContain(`${pool}:${pool}:ro`);
  });
});

// ── voice-sidecar service (PR-B2) ─────────────────────────────────────
// The local GPU STT sidecar is emitted ONLY on a `local` voice verdict.
// Both branches are pinned here so a regression that emits the GPU service
// on a cloud host — or drops it on a local host — fails CI.
describe("generateCompose — voice-sidecar (PR-B2)", () => {
  it("emits the voice-sidecar service + volume on a local verdict", () => {
    const out = generateCompose({
      config: makeConfig({ coach: {} }),
      voiceEngine: "local",
    });
    expect(out).toContain("voice-sidecar:");
    expect(out).toContain("container_name: switchroom-voice-sidecar");
    // GPU reservation.
    expect(out).toContain("driver: nvidia");
    expect(out).toContain('capabilities: ["gpu"]');
    // Published on all interfaces (host-net + strict-isolation reachable).
    expect(out).toContain('"0.0.0.0:18900:8126"');
    // Healthcheck on /healthz, probed via python3 stdlib — NOT curl. The
    // sidecar image ships no curl, so a curl probe would stay unhealthy
    // forever (PR-B3).
    expect(out).toContain("/healthz");
    const sidecarBlock = out.slice(out.indexOf("voice-sidecar:"));
    const healthLine = sidecarBlock
      .split("\n")
      .find((l) => l.includes("test: [") && l.includes("/healthz"));
    expect(healthLine).toBeDefined();
    expect(healthLine).not.toContain("curl");
    expect(healthLine).toContain("python3");
    expect(healthLine).toContain("urllib.request");
    // Token is a docker interpolation, NOT a literal secret in the YAML.
    expect(out).toContain("VOICE_SIDECAR_TOKEN: ${VOICE_SIDECAR_TOKEN}");
    // Model-cache named volume declared.
    expect(out).toContain("voice-model-cache:");
  });

  it("emits NEITHER service NOR volume on a cloud verdict", () => {
    const out = generateCompose({
      config: makeConfig({ coach: {} }),
      voiceEngine: "cloud",
    });
    expect(out).not.toContain("voice-sidecar:");
    expect(out).not.toContain("switchroom-voice-sidecar");
    expect(out).not.toContain("voice-model-cache");
    expect(out).not.toContain("VOICE_SIDECAR_TOKEN");
  });

  // PR-B3: the host voice verdict must reach EVERY agent container as the
  // SWITCHROOM_VOICE_ENGINE env var. Without it the in-container gateway
  // never sees the host verdict (the constructed in-container ~/.switchroom
  // doesn't carry host-capabilities.json) and silently defaults to `cloud`,
  // so the local GPU sidecar is never called even on a GPU host.
  function envBlockFor(yml: string, agent: string): string {
    const re = new RegExp(
      `  agent-${agent}:[\\s\\S]*?    environment:([\\s\\S]*?)\\n    volumes:`,
    );
    return re.exec(yml)?.[1] ?? "";
  }

  it("propagates SWITCHROOM_VOICE_ENGINE=local to every agent on a local verdict", () => {
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }),
      voiceEngine: "local",
    });
    for (const a of ["alice", "bob"]) {
      const env = envBlockFor(out, a);
      expect(env).toContain('SWITCHROOM_VOICE_ENGINE: "local"');
    }
  });

  it("propagates SWITCHROOM_VOICE_ENGINE=cloud to every agent on a cloud verdict", () => {
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }),
      voiceEngine: "cloud",
    });
    for (const a of ["alice", "bob"]) {
      const env = envBlockFor(out, a);
      expect(env).toContain('SWITCHROOM_VOICE_ENGINE: "cloud"');
    }
  });

  it("defaults to NO sidecar when the verdict is unset (fail-safe cloud)", () => {
    // No voiceEngine + no persisted host-capabilities file → defaults to
    // cloud → never emits a GPU service on an unconfirmed host. Point HOME
    // at an empty tmp dir so loadHostCapabilities() finds no verdict file
    // (don't read the operator's real ~/.switchroom on this dev host).
    const emptyHome = mkdtempSync(join(tmpdir(), "voice-no-verdict-"));
    const prevHome = process.env.HOME;
    process.env.HOME = emptyHome;
    try {
      const out = generateCompose({ config: makeConfig({ coach: {} }) });
      expect(out).not.toContain("voice-sidecar:");
      expect(out).not.toContain("voice-model-cache");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  // PR-B3 regression, production provenance (v0.16.38 fleet-wide voice
  // outage): the earlier propagate tests inject `voiceEngine` DIRECTLY,
  // bypassing loadHostCapabilities(). But in production the generator resolves
  // the verdict from the persisted ~/.switchroom/host-capabilities.json — and
  // it was a STALE compose (regenerated by a pre-PR-B3 CLI, then reused on a
  // container recreate) that shipped WITHOUT the env var, so every gateway
  // defaulted to `cloud` and kokoro TTS silently no-op'd. This case exercises
  // the REAL resolution path: write a `local` verdict file, call generateCompose
  // with NO voiceEngine option, and assert every voice-enabled agent still gets
  // SWITCHROOM_VOICE_ENGINE=local (plus the sidecar is emitted). A regression
  // that drops the emit, or fails to read the host verdict at gen-time, reds here.
  it("emits SWITCHROOM_VOICE_ENGINE=local via loadHostCapabilities() when the host verdict is local", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "voice-local-verdict-"));
    mkdirSync(join(homeDir, ".switchroom"), { recursive: true });
    writeFileSync(
      join(homeDir, ".switchroom", "host-capabilities.json"),
      JSON.stringify({
        version: 1,
        voice: {
          gpuPresent: true,
          containerToolkit: true,
          engine: "local",
          detectedAt: "2026-07-01T00:00:00.000Z",
        },
      }) + "\n",
      { mode: 0o600 },
    );
    const prevHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      // No `voiceEngine` — force the generator down the real
      // loadHostCapabilities() path that broke in production.
      const out = generateCompose({ config: makeConfig({ alice: {}, bob: {} }) });
      for (const a of ["alice", "bob"]) {
        const env = envBlockFor(out, a);
        expect(
          env,
          `agent-${a} must carry the resolved host voice verdict`,
        ).toContain('SWITCHROOM_VOICE_ENGINE: "local"');
      }
      // And the local verdict emits the GPU sidecar with the curl-free probe.
      expect(out).toContain("container_name: switchroom-voice-sidecar");
      const sidecarBlock = out.slice(out.indexOf("voice-sidecar:"));
      const healthLine = sidecarBlock
        .split("\n")
        .find((l) => l.includes("test: [") && l.includes("/healthz"));
      expect(healthLine).toBeDefined();
      expect(healthLine).not.toContain("curl");
      expect(healthLine).toContain("python3");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe("generateCompose — LiteLLM ANTHROPIC_BASE_URL model-class routing", () => {
  // A Claude default rides the `<root>/anthropic` raw pass-through (dodges the
  // Opus SSE re-chunk stall). A non-Claude DEFAULT (`model: sr-glm-5`) has no
  // `.session-model-override` carrier, so it MUST be pointed at the model-mapped
  // router root at compose time or it 4xxs on every call against the pass-
  // through. Mirrors the isClaudeModel split src/setup/hindsight.ts applies.
  const ROOT = "http://litellm.internal:4010";

  function composeFor(model: string | undefined, confirmed = true): string {
    const config = makeConfig(
      { router: { model } },
      { litellm: { enabled: true, base_url: ROOT } },
    );
    return generateCompose({
      config,
      litellmConfirmedAgents: confirmed ? new Set(["router"]) : undefined,
    });
  }

  it("non-Claude configured model → ANTHROPIC_BASE_URL has NO /anthropic suffix (router root)", () => {
    const out = composeFor("sr-glm-5");
    expect(out).toContain(`ANTHROPIC_BASE_URL: "${ROOT}"`);
    expect(out).not.toContain(`ANTHROPIC_BASE_URL: "${ROOT}/anthropic"`);
    // Router markers still present.
    expect(out).toContain(`SWITCHROOM_LITELLM_BASE: "${ROOT}"`);
    expect(out).toContain('SWITCHROOM_LITELLM: "1"');
  });

  it("Claude configured model → ANTHROPIC_BASE_URL keeps the /anthropic pass-through", () => {
    const out = composeFor("claude-opus-4-8");
    expect(out).toContain(`ANTHROPIC_BASE_URL: "${ROOT}/anthropic"`);
  });

  it("unset model (fleet default is Claude) → keeps the /anthropic pass-through", () => {
    const out = composeFor(undefined);
    expect(out).toContain(`ANTHROPIC_BASE_URL: "${ROOT}/anthropic"`);
  });

  it("no virtual key confirmed → NO routing env injected at all (fail-safe)", () => {
    const out = composeFor("sr-glm-5", false);
    // keyConfirmed false ⇒ agent routing env is skipped (no unauthenticated
    // proxy calls from the *agent*). The auth-broker still gets a
    // SWITCHROOM_LITELLM_BASE for get-external-spend (fleet /usage card) —
    // that is intentional and authenticated with the master key inside
    // the broker, not with a missing agent VK. Scope the assert to the
    // agent service block, not the whole compose document.
    const agentBlock =
      /agent-router:[\s\S]*?(?=\n  [a-zA-Z]|\nvolumes:|\nnetworks:|$)/.exec(out)?.[0] ?? "";
    expect(agentBlock).not.toContain(ROOT);
    expect(agentBlock).not.toMatch(/ANTHROPIC_BASE_URL:/);
    expect(agentBlock).not.toMatch(/SWITCHROOM_LITELLM:/);
    // Broker still receives the base (non-loopback ROOT → passed through).
    const ab =
      /switchroom-auth-broker:[\s\S]*?(?=\n  [a-zA-Z]|\nvolumes:|$)/.exec(out)?.[0] ?? "";
    expect(ab).toMatch(/SWITCHROOM_LITELLM_BASE:/);
  });
});


describe("generateCompose — auth-broker LiteLLM base for external spend", () => {
  it("loopback base_url → host network + verbatim URL (not host.docker.internal)", () => {
    // host.docker.internal/host-gateway routes to the host BRIDGE IP, not to
    // a 127.0.0.1-bound host port — so a loopback-published proxy is only
    // reachable when the broker joins the host network. See the dedicated
    // compose-auth-broker-litellm.test.ts for the full matrix.
    const out = generateCompose({
      config: makeConfig(
        { router: {} },
        { litellm: { enabled: true, base_url: "http://127.0.0.1:4010" } },
      ),
    });
    const block =
      /switchroom-auth-broker:[\s\S]*?(?=\n  [a-zA-Z]|\nvolumes:|$)/.exec(out)?.[0] ?? "";
    expect(block).toContain(
      'SWITCHROOM_LITELLM_BASE: "http://127.0.0.1:4010"',
    );
    expect(block).not.toContain("host.docker.internal");
    expect(block).not.toContain("extra_hosts");
    expect(block).toContain("network_mode: host");
  });

  it("passes non-loopback base_url through unchanged", () => {
    const out = generateCompose({
      config: makeConfig(
        { router: {} },
        { litellm: { enabled: true, base_url: "http://litellm.internal:4010" } },
      ),
    });
    const block =
      /switchroom-auth-broker:[\s\S]*?(?=\n  [a-zA-Z]|\nvolumes:|$)/.exec(out)?.[0] ?? "";
    expect(block).toContain(
      'SWITCHROOM_LITELLM_BASE: "http://litellm.internal:4010"',
    );
  });

  it("omits SWITCHROOM_LITELLM_BASE + extra_hosts on auth-broker when litellm base_url unset", () => {
    const out = generateCompose({
      config: makeConfig({ router: {} }),
    });
    const block =
      /switchroom-auth-broker:[\s\S]*?(?=\n  [a-zA-Z]|\nvolumes:|$)/.exec(out)?.[0] ?? "";
    expect(block).not.toMatch(/SWITCHROOM_LITELLM_BASE:/);
    expect(block).not.toContain("host.docker.internal:host-gateway");
  });
});

describe("generateCompose is HOME-hermetic — no writes to the real \$HOME under test (#3127)", () => {
  // #3127: `generateCompose` pre-creates host-side per-agent dirs (audit,
  // blocked-approvals, schedule.d) via mkdirSync. When a caller omits both
  // `homeDir` and `probeHomeDir`, `probeHome` silently fell back to the
  // ambient `process.env.HOME` — the operator's REAL production state tree —
  // so a full test-suite run created `~/.switchroom/blocked-approvals` (and
  // chmod 1777'd it) in the operator's home (real incident 2026-05-22 class).
  //
  // These tests scope `$HOME` to a mkdtemp dir so they are hermetic even on
  // the buggy code, and then assert generateCompose creates NOTHING under it
  // when no home is supplied. Against pre-fix main the assertions FAIL (the
  // dirs get created); with the pre-create gated on an explicit home they pass.
  let realHome: string | undefined;
  let scopedHome: string;

  beforeEach(() => {
    realHome = process.env.HOME;
    scopedHome = mkdtempSync(join(tmpdir(), "compose-home-hermeticity-"));
    process.env.HOME = scopedHome;
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(scopedHome, { recursive: true, force: true });
  });

  it("creates no ~/.switchroom side-effect dirs when no home is supplied", () => {
    const out = generateCompose({ config: makeConfig({ klanker: {}, bob: {} }) });
    // The compose string is still produced normally…
    expect(out).toContain("klanker");
    expect(out).toContain("bob");
    // …but nothing is written under the ambient (scoped) HOME.
    expect(existsSync(join(scopedHome, ".switchroom"))).toBe(false);
    expect(existsSync(join(scopedHome, ".switchroom", "blocked-approvals"))).toBe(false);
    expect(existsSync(join(scopedHome, ".switchroom", "audit", "klanker"))).toBe(false);
    expect(existsSync(join(scopedHome, ".switchroom", "agents", "klanker", "schedule.d"))).toBe(false);
  });

  it("explicit precreateHostDirs:false suppresses the writes even when a home IS supplied", () => {
    const out = generateCompose({
      config: makeConfig({ klanker: {} }),
      homeDir: scopedHome,
      precreateHostDirs: false,
    });
    expect(out).toContain("klanker");
    expect(existsSync(join(scopedHome, ".switchroom", "blocked-approvals"))).toBe(false);
  });

  it("pre-creates the dirs in the SCOPED home (never the real \$HOME) when a home IS supplied", () => {
    generateCompose({ config: makeConfig({ klanker: {} }), homeDir: scopedHome });
    // The production side effects land in the scoped home, proving the writes
    // are addressed by the injected home rather than the ambient one.
    expect(existsSync(join(scopedHome, ".switchroom", "blocked-approvals"))).toBe(true);
    expect(existsSync(join(scopedHome, ".switchroom", "audit", "klanker"))).toBe(true);
  });
});
