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

import { describe, it, expect } from "vitest";
import {
  generateCompose,
  allocateAgentUid,
  assertNoAgentUidCollision,
  AGENT_UID_MIN,
  AGENT_UID_MAX,
  describeAgents,
} from "../../src/agents/compose.js";
import type { SwitchroomConfig } from "../../src/config/schema.js";

interface MakeConfigAgent {
  extends?: string;
  settings_raw?: Record<string, unknown>;
  admin?: boolean;
  env?: Record<string, string>;
  bind_mounts?: Array<{ source: string; target?: string; mode?: "ro" | "rw" }>;
  resources?: { memory?: string; memory_reservation?: string; pids_limit?: number; cpus?: number };
  timezone?: string;
  network_isolation?: "host" | "strict";
}

function makeConfig(
  agents: Record<string, MakeConfigAgent>,
  topLevel?: { host_control?: { enabled?: boolean }; timezone?: string },
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
          env: cfg.env,
          bind_mounts: cfg.bind_mounts,
          resources: cfg.resources,
          timezone: cfg.timezone,
          network_isolation: cfg.network_isolation,
          schedule: [],
          tools: { allow: [], deny: [] },
          hooks: undefined,
          channels: undefined,
        } as unknown as SwitchroomConfig["agents"][string],
      ]),
    ),
    drive: undefined as unknown as SwitchroomConfig["drive"],
    host_control: topLevel?.host_control,
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

  it("default containerNamePrefix preserves the production fleet label", () => {
    // Critical for productionFleetIsLive() to keep working: the
    // default-emit path MUST still stamp `switchroom.fleet=switchroom`
    // on every service so `docker ps --filter
    // label=switchroom.fleet=switchroom` finds them.
    const out = generateCompose({ config: makeConfig({ coach: {} }) });
    // One label line per service: vault-broker + approval-kernel +
    // switchroom-auth-broker + 1 agent = 4.
    const matches = out.match(/switchroom\.fleet: "switchroom"/g) ?? [];
    expect(matches.length).toBe(4);
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

  it("klanker gets 6g/4g reservation, 2000 PIDs, 2.0 cpus", () => {
    const out = generateCompose({ config: makeConfig({ klanker: {} }) });
    expect(out).toMatch(/agent-klanker:[\s\S]*?mem_limit: 6g/);
    expect(out).toMatch(/agent-klanker:[\s\S]*?mem_reservation: 4g/);
    expect(out).toMatch(/agent-klanker:[\s\S]*?pids_limit: 2000/);
    expect(out).toMatch(/agent-klanker:[\s\S]*?cpus: 2\.0/);
  });

  it("conversational profile → 1.5g/256m, 500 PIDs, 1.0", () => {
    const out = generateCompose({ config: makeConfig({ coach: { extends: "conversational" } }) });
    expect(out).toMatch(/agent-coach:[\s\S]*?mem_limit: 1\.5g/);
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

  it("coding profile → 2g/512m, 1000 PIDs, 2.0", () => {
    const out = generateCompose({ config: makeConfig({ worker: { extends: "coding" } }) });
    expect(out).toMatch(/agent-worker:[\s\S]*?mem_limit: 2g/);
    expect(out).toMatch(/agent-worker:[\s\S]*?mem_reservation: 512m/);
    expect(out).toMatch(/agent-worker:[\s\S]*?pids_limit: 1000/);
    expect(out).toMatch(/agent-worker:[\s\S]*?cpus: 2\.0/);
  });

  it("unknown profile → default 1.5g/256m, 500 PIDs, 1.0", () => {
    const out = generateCompose({ config: makeConfig({ misc: { extends: "made-up" } }) });
    expect(out).toMatch(/agent-misc:[\s\S]*?mem_limit: 1\.5g/);
    expect(out).toMatch(/agent-misc:[\s\S]*?mem_reservation: 256m/);
    expect(out).toMatch(/agent-misc:[\s\S]*?pids_limit: 500/);
    expect(out).toMatch(/agent-misc:[\s\S]*?cpus: 1\.0/);
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
    expect(out).toMatch(/agent-klanker:[\s\S]*?mem_limit: 6g/);
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
    // it falls through to the catch-all default 1.5g.
    expect(out).toMatch(/agent-alice:[\s\S]*?mem_limit: 1\.5g/);
  });

  it("agent.resources.cpus overrides profile (fractional accepted)", () => {
    const out = generateCompose({
      config: makeConfig({ ziggy: { extends: "lightweight", resources: { cpus: 0.25 } } }),
    });
    expect(out).toMatch(/agent-ziggy:[\s\S]*?cpus: 0\.3/); // toFixed(1) rounds
    expect(out).toMatch(/agent-ziggy:[\s\S]*?mem_limit: 1g/); // unchanged
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
      expect(block, `agent-${name} tmpfs`).toContain("/tmp:size=256m");
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
  // Admin agents get an extra per-agent UDS bind mount when
  // host_control.enabled is true AND the host-side directory
  // exists (compose `up` hard-fails on missing bind sources).
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

  it("does NOT emit the hostd bind mount on non-admin agents even when enabled", async () => {
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
      expect(out).not.toMatch(
        /agent-bob:[\s\S]*?\.switchroom\/hostd\/bob:\/run\/switchroom\/hostd\/bob/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("emits the hostd bind mount when admin AND enabled AND host dir exists", async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "hostd-mount-on-"));
    try {
      mkdirSync(join(tmp, ".switchroom/hostd/klanker"), { recursive: true });
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
      // bob (non-admin) does not get the mount even on the same fleet.
      expect(out).not.toMatch(
        /agent-bob:[\s\S]*?\.switchroom\/hostd\/bob:/,
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

describe("PR B: /skills-rw admin bind-mount for global skill authoring", () => {
  // The agent-config skill-author CLI (scope:"global") writes under
  // /skills-rw inside the container, which is the host's skills_dir
  // bind-mounted :rw. The mount is implicit on `admin: true` — no
  // schema field — and MUST NOT appear for non-admin agents.

  it("admin agent gets the /skills-rw bind when skills dir exists on host", async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "compose-skills-rw-"));
    mkdirSync(join(tmp, ".switchroom", "skills"), { recursive: true });
    try {
      const out = generateCompose({
        config: makeConfig({ alice: { admin: true } }),
        homeDir: tmp,
      });
      expect(out).toMatch(new RegExp(
        `agent-alice:[\\s\\S]*?- ${tmp}/.switchroom/skills:/skills-rw:rw`,
      ));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("non-admin agent does NOT get /skills-rw even when skills dir exists", async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "compose-skills-rw-deny-"));
    mkdirSync(join(tmp, ".switchroom", "skills"), { recursive: true });
    try {
      const out = generateCompose({
        config: makeConfig({ bob: { admin: false } }),
        homeDir: tmp,
      });
      expect(out).not.toContain("/skills-rw:rw");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("admin agent skips /skills-rw when host skills dir is missing", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "compose-skills-rw-empty-"));
    try {
      const out = generateCompose({
        config: makeConfig({ alice: { admin: true } }),
        homeDir: tmp,
      });
      expect(out).not.toContain("/skills-rw:rw");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
