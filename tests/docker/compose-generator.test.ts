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
  AGENT_UID_MIN,
  AGENT_UID_MAX,
  describeAgents,
} from "../../src/agents/compose.js";
import type { SwitchroomConfig } from "../../src/config/schema.js";

function makeConfig(agents: Record<string, { extends?: string; settings_raw?: Record<string, unknown> }>): SwitchroomConfig {
  return {
    switchroom: { version: 1, agents_dir: "~/.switchroom/agents", skills_dir: "~/.switchroom/skills" },
    telegram: { bot_token: "x" },
    defaults: undefined,
    profiles: undefined,
    agents: Object.fromEntries(
      Object.entries(agents).map(([name, cfg]) => [
        name,
        {
          extends: cfg.extends,
          settings_raw: cfg.settings_raw,
          schedule: [],
          tools: { allow: [], deny: [] },
          hooks: undefined,
          channels: undefined,
        } as unknown as SwitchroomConfig["agents"][string],
      ]),
    ),
    drive: undefined as unknown as SwitchroomConfig["drive"],
  } as unknown as SwitchroomConfig;
}

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

  it("emits agents in sorted order", () => {
    const out = generateCompose({ config: makeConfig({ zebra: {}, alpha: {}, mango: {} }) });
    const a = out.indexOf("agent-alpha:");
    const m = out.indexOf("agent-mango:");
    const z = out.indexOf("agent-zebra:");
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(m);
    expect(m).toBeLessThan(z);
  });

  it("klanker gets 6g mem_limit + 2.0 cpus", () => {
    const out = generateCompose({ config: makeConfig({ klanker: {} }) });
    expect(out).toMatch(/agent-klanker:[\s\S]*?mem_limit: 6g/);
    expect(out).toMatch(/agent-klanker:[\s\S]*?cpus: 2\.0/);
  });

  it("conversational profile → 1.5g / 1.0", () => {
    const out = generateCompose({ config: makeConfig({ coach: { extends: "conversational" } }) });
    expect(out).toMatch(/agent-coach:[\s\S]*?mem_limit: 1\.5g/);
    expect(out).toMatch(/agent-coach:[\s\S]*?cpus: 1\.0/);
  });

  it("lightweight profile → 1g / 0.5", () => {
    const out = generateCompose({ config: makeConfig({ ziggy: { extends: "lightweight" } }) });
    expect(out).toMatch(/agent-ziggy:[\s\S]*?mem_limit: 1g/);
    expect(out).toMatch(/agent-ziggy:[\s\S]*?cpus: 0\.5/);
  });

  it("coding profile → 2g / 2.0", () => {
    const out = generateCompose({ config: makeConfig({ worker: { extends: "coding" } }) });
    expect(out).toMatch(/agent-worker:[\s\S]*?mem_limit: 2g/);
    expect(out).toMatch(/agent-worker:[\s\S]*?cpus: 2\.0/);
  });

  it("unknown profile → default 1.5g / 1.0", () => {
    const out = generateCompose({ config: makeConfig({ misc: { extends: "made-up" } }) });
    expect(out).toMatch(/agent-misc:[\s\S]*?mem_limit: 1\.5g/);
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
    const out = generateCompose({ config: makeConfig({ a: {}, b: {}, c: {} }) });
    // Pull the volumes block of agent-a; it must only mention broker-a-sock.
    const aBlock = /agent-a:[\s\S]*?(?=\n  agent-|\nvolumes:)/.exec(out)?.[0] ?? "";
    expect(aBlock).toContain("broker-a-sock");
    expect(aBlock).not.toContain("broker-b-sock");
    expect(aBlock).not.toContain("broker-c-sock");
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
    // Vault file mounted directly (not as a parent dir) — see compose.ts
    // for the rationale (#v0.7.1 vault file path fix).
    expect(out).toContain("${HOME}/.switchroom/vault.enc:/state/vault.enc:ro");
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

  it("bakes the absolute homeDir into bind sources when given (sudo-safe)", () => {
    // Why: under `sudo docker compose`, ${HOME} resolves to /root, not
    // the operator's home. apply.ts passes os.homedir() so the YAML
    // captures the right path independent of who runs compose.
    const out = generateCompose({
      config: makeConfig({ a: {} }),
      homeDir: "/home/op",
    });
    expect(out).toContain("/home/op/.switchroom/vault.enc:/state/vault.enc:ro");
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
    // Shared pools (#907): skills + credentials bind-mounted read-only at
    // their canonical host paths so prompts and env vars resolve identically
    // inside the container.
    expect(out).toContain("/home/op/.switchroom/skills:/home/op/.switchroom/skills:ro");
    expect(out).toContain("/home/op/.switchroom/credentials:/home/op/.switchroom/credentials:ro");
    expect(out).not.toContain("${HOME}");
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

  it("broker mounts /etc/machine-id so auto-unlock key derivation matches host (v0.7.4)", () => {
    // The auto-unlock blob is sealed with an AES key derived from the
    // host's /etc/machine-id. Without passing it through, the broker
    // image (no /etc/machine-id baked in) errors "Cannot derive
    // machine-bound key" and falls back to interactive unlock.
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    const block = /vault-broker:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).toMatch(/-\s+\/etc\/machine-id:\/etc\/machine-id:ro/);
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

  it("sets SWITCHROOM_KERNEL_SOCKET to the per-agent kernel-server bind path", () => {
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }),
    });
    for (const a of ["alice", "bob"]) {
      const env = envBlockFor(out, a);
      expect(env).toMatch(
        new RegExp(
          `SWITCHROOM_KERNEL_SOCKET:\\s*"/run/switchroom/kernel/${a}/sock"`,
        ),
      );
    }
  });

  it("sets SWITCHROOM_BROKER_SOCKET to the per-agent broker-server bind path", () => {
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }),
    });
    for (const a of ["alice", "bob"]) {
      const env = envBlockFor(out, a);
      expect(env).toMatch(
        new RegExp(
          `SWITCHROOM_BROKER_SOCKET:\\s*"/run/switchroom/broker/${a}/sock"`,
        ),
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
});

describe("agent service network (v0.7.4 — host networking)", () => {
  // Scaffolded start.sh hard-codes host-loopback URLs (e.g.
  // http://127.0.0.1:18888 for hindsight) and operator LAN IPs (HA,
  // smart-home gear). The default bridge network reaches none of those.
  // network_mode: host puts the agent on the host's network namespace,
  // matching the v0.6 systemd-era behavior so existing scaffolds Just
  // Work without a regen of every start.sh / settings.json.
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
    expect(out).toContain(`"ls /run/switchroom/broker/*/sock 2>/dev/null | head -1 | grep -q ."`);
    expect(out).toContain(`"ls /run/switchroom/kernel/*/sock 2>/dev/null | head -1 | grep -q ."`);
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
