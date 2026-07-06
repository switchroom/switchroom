import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock execFileSync so `docker run` never actually fires. We capture
// the args to assert on the command shape.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import {
  startHindsight,
  ensureHindsightConsumer,
  HINDSIGHT_CONSUMER_NAME,
  HINDSIGHT_DEFAULT_UID,
  HINDSIGHT_BROKER_SOCK_VOLUME,
  HINDSIGHT_IMAGE,
  HINDSIGHT_DEFAULT_SHM_SIZE,
  HINDSIGHT_DEFAULT_MODEL,
  getRunningHindsightPorts,
  HINDSIGHT_DEFAULT_API_PORT,
  HINDSIGHT_DEFAULT_UI_PORT,
} from "../../src/setup/hindsight.js";
import { SWITCHROOM_DEFAULT_MAIN_MODEL } from "../../src/agents/scaffold.js";

const mockedExec = execFileSync as unknown as ReturnType<typeof vi.fn>;

function findRunArgs(): string[] {
  const runCall = mockedExec.mock.calls.find(
    (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "run",
  );
  expect(runCall).toBeDefined();
  return runCall![1] as string[];
}

describe("hindsight broker-fed mode (#1245)", () => {
  beforeEach(() => {
    mockedExec.mockReset();
    mockedExec.mockReturnValue("");
  });

  it("does NOT pass any LLM API key via -e or --env-file", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    expect(args).not.toContain("--env-file");

    // No -e value should look like an API-key var.
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-e") {
        const val = args[i + 1] as string;
        expect(val).not.toMatch(/^HINDSIGHT_API_LLM_API_KEY=/);
        expect(val).not.toMatch(/^OPENAI_API_KEY=/);
        expect(val).not.toMatch(/^ANTHROPIC_API_KEY=/);
      }
    }
  });

  it("does NOT pass an entrypoint shim (broker-fed mode uses the image's ENTRYPOINT)", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    expect(args).not.toContain("--entrypoint");
  });

  it("adds a container healthcheck that marks a wedged API unhealthy (visibility, not auto-restart)", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    expect(args).toContain("--health-cmd");
    const cmd = args[args.indexOf("--health-cmd") + 1] as string;
    // Hits /health via python3 (always in the image; curl/wget are not).
    expect(cmd).toContain("python3");
    expect(cmd).toContain("/health");
    expect(args).toContain("--health-interval");
  });

  it("mounts a SEPARATE backups volume so a data-volume loss is recoverable", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    let found = false;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-v" && args[i + 1] === "switchroom-hindsight-backups:/backups") {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
    // Must NOT co-locate backups on the data volume (defeats the point).
    expect(args).not.toContain("switchroom-hindsight-data:/backups");
  });

  it("bind-mounts the auth-broker consumer socket volume", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    // Look for `-v auth-broker-hindsight-sock:/run/switchroom/auth-broker`.
    let found = false;
    for (let i = 0; i < args.length - 1; i++) {
      if (
        args[i] === "-v" &&
        args[i + 1] === `${HINDSIGHT_BROKER_SOCK_VOLUME}:/run/switchroom/auth-broker`
      ) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it("sets up a tmpfs at /run/claude-creds for the credential dotfile", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    let found = false;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "--tmpfs" && (args[i + 1] as string).startsWith("/run/claude-creds")) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it("passes --shm-size so PostgreSQL doesn't fail on Docker's 64MB default shm (2026-06-06 outage)", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    // Single-token form: `--shm-size=2g`.
    expect(args).toContain(`--shm-size=${HINDSIGHT_DEFAULT_SHM_SIZE}`);
    // And the default must be larger than Docker's 64MB so the bug can't
    // silently regress to the broken default.
    const m = /^(\d+)g$/.exec(HINDSIGHT_DEFAULT_SHM_SIZE);
    expect(m, "HINDSIGHT_DEFAULT_SHM_SIZE should be N gigabytes").not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(1);
  });

  it("sets HINDSIGHT_API_LLM_PROVIDER=claude-code (subscription-honest path)", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    const envPairs: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-e") envPairs.push(args[i + 1] as string);
    }
    expect(envPairs).toContain("HINDSIGHT_API_LLM_PROVIDER=claude-code");
  });

  it("pins HINDSIGHT_API_LLM_MODEL to the switchroom default sonnet", () => {
    // Without this override the upstream hindsight image silently picks
    // its own default (an older date-pinned sonnet from
    // PROVIDER_DEFAULT_MODELS in /app/api/hindsight_api/config.py) and
    // drifts behind the rest of the fleet on every upstream pull.
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    const envPairs: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-e") envPairs.push(args[i + 1] as string);
    }
    expect(envPairs).toContain("HINDSIGHT_API_LLM_MODEL=claude-sonnet-5");
    // For the claude-code provider the embedded `claude` CLI reads
    // ANTHROPIC_MODEL, not HINDSIGHT_API_LLM_MODEL — without it the CLI
    // falls back to its own default (opus) and silently burns quota.
    expect(envPairs).toContain("ANTHROPIC_MODEL=claude-sonnet-5");
  });

  it("raises the reflect wall timeout (vendor 300s times out large-bank mental-model refresh)", async () => {
    const { HINDSIGHT_DEFAULT_REFLECT_WALL_TIMEOUT_S: t } = await import("../../src/setup/hindsight.js");
    expect(t).toBeGreaterThan(300);
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    const envPairs: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-e") envPairs.push(args[i + 1] as string);
    }
    expect(envPairs).toContain(`HINDSIGHT_API_REFLECT_WALL_TIMEOUT=${t}`);
    // Parity in the compose path.
    const { generateHindsightComposeSnippet } = await import("../../src/setup/hindsight.js");
    expect(generateHindsightComposeSnippet()).toContain(`HINDSIGHT_API_REFLECT_WALL_TIMEOUT=${t}`);
  });

  it("sets modest consolidation throughput knobs (batch size + slots) on both emit paths", async () => {
    const h = await import("../../src/setup/hindsight.js");
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    const envPairs: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-e") envPairs.push(args[i + 1] as string);
    }
    expect(envPairs).toContain(`HINDSIGHT_API_CONSOLIDATION_LLM_BATCH_SIZE=${h.HINDSIGHT_DEFAULT_CONSOLIDATION_LLM_BATCH_SIZE}`);
    expect(envPairs).toContain(`HINDSIGHT_API_WORKER_CONSOLIDATION_MAX_SLOTS=${h.HINDSIGHT_DEFAULT_CONSOLIDATION_MAX_SLOTS}`);
    expect(envPairs).toContain(`HINDSIGHT_API_CONSOLIDATION_LLM_PARALLELISM=${h.HINDSIGHT_DEFAULT_CONSOLIDATION_LLM_PARALLELISM}`);
    expect(envPairs).toContain(`HINDSIGHT_API_CONSOLIDATION_MAX_MEMORIES_PER_ROUND=${h.HINDSIGHT_DEFAULT_CONSOLIDATION_MAX_MEMORIES_PER_ROUND}`);
    // Subscription-honest ceiling: concurrent model calls = slots × parallelism.
    // #2894 throttled this to a hard ceiling of 1 × 2 = 2 after an 18-way
    // fan-out exhausted the shared failover quota (2026-07-06 token-burn).
    // The old guard (≤24) let that exact 18-way fan-out pass — this pins the
    // ceiling at ≤2 so any regression that re-raises slots/parallelism trips it.
    expect(h.HINDSIGHT_DEFAULT_CONSOLIDATION_MAX_SLOTS * h.HINDSIGHT_DEFAULT_CONSOLIDATION_LLM_PARALLELISM).toBeLessThanOrEqual(2);
    const snippet = h.generateHindsightComposeSnippet();
    expect(snippet).toContain(`HINDSIGHT_API_CONSOLIDATION_LLM_PARALLELISM=${h.HINDSIGHT_DEFAULT_CONSOLIDATION_LLM_PARALLELISM}`);
    expect(snippet).toContain(`HINDSIGHT_API_CONSOLIDATION_MAX_MEMORIES_PER_ROUND=${h.HINDSIGHT_DEFAULT_CONSOLIDATION_MAX_MEMORIES_PER_ROUND}`);
  });

  it("raises the memory limit to give the throughput bump headroom (8g, was 4g)", async () => {
    const h = await import("../../src/setup/hindsight.js");
    // Baseline RSS ~3.4g; 4g was tight, and more in-flight consolidation
    // raises it. Both emit paths must carry the bumped limit.
    const m = /^(\d+)g$/.exec(h.HINDSIGHT_DEFAULT_MEM_LIMIT);
    expect(m, "mem limit should be N gigabytes").not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(8);
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    expect(findRunArgs()).toContain(`--memory=${h.HINDSIGHT_DEFAULT_MEM_LIMIT}`);
    expect(h.generateHindsightComposeSnippet()).toMatch(
      new RegExp(`mem_limit:\\s*${h.HINDSIGHT_DEFAULT_MEM_LIMIT}\\b`),
    );
  });

  it("enables stateless MCP (HINDSIGHT_API_MCP_STATELESS=true) so a hindsight bounce doesn't strand agent-side MCP sessions", () => {
    // Stateful MCP makes the server assign an Mcp-Session-Id on
    // initialize that the client must echo on every subsequent call.
    // When hindsight restarts, its in-memory session table is wiped
    // but every agent's claude MCP client keeps caching the now-stale
    // id — retain fails with "Session not found" until each agent is
    // also restarted. Stateless mode makes every request self-contained.
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    const envPairs: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-e") envPairs.push(args[i + 1] as string);
    }
    expect(envPairs).toContain("HINDSIGHT_API_MCP_STATELESS=true");
  });

  it("uses the switchroom-hindsight image, not upstream", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    expect(args).toContain(HINDSIGHT_IMAGE);
    // Upstream image MUST NOT be used — that one is missing
    // claude-agent-sdk + the claude CLI.
    expect(args).not.toContain("ghcr.io/vectorize-io/hindsight:latest");
  });

  // #2752 fix 1 — a version-pinned rollout threads its target through as
  // imageTag so the standalone recreate pulls + runs the SAME pinned image
  // (`:vX.Y.Z`) the rest of the fleet moved to, not floating `:latest`.
  it("runs the PINNED :vX.Y.Z image when an imageTag is provided", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 }, undefined, "v0.15.18");
    const args = findRunArgs();
    expect(args).toContain("ghcr.io/switchroom/switchroom-hindsight:v0.15.18");
    expect(args).not.toContain(HINDSIGHT_IMAGE); // NOT floating :latest
  });

  it("normalizes a bare (v-less) tag to the :vX.Y.Z form the workflow publishes", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 }, undefined, "0.15.18");
    const args = findRunArgs();
    expect(args).toContain("ghcr.io/switchroom/switchroom-hindsight:v0.15.18");
  });

  it("falls back to floating :latest when no imageTag is given (standalone memory setup)", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    expect(args).toContain(HINDSIGHT_IMAGE);
  });

  // Regression — without uid/gid on the tmpfs, the mount lands root-owned
  // and the entrypoint shim's `chmod 0700 /run/claude-creds` (running as
  // the image's pinned USER hindsight, UID 11000) fails EACCES → boot
  // exits non-zero → docker `--restart unless-stopped` crash-loops.
  it("tmpfs at /run/claude-creds carries uid + gid matching HINDSIGHT_DEFAULT_UID", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    let tmpfsArg: string | undefined;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "--tmpfs" && (args[i + 1] as string).startsWith("/run/claude-creds")) {
        tmpfsArg = args[i + 1] as string;
        break;
      }
    }
    expect(tmpfsArg).toBeDefined();
    expect(tmpfsArg).toMatch(/uid=11000\b/);
    expect(tmpfsArg).toMatch(/gid=11000\b/);
    // Sanity: the existing mode + rw flags survive the addition.
    expect(tmpfsArg).toMatch(/mode=0700\b/);
    expect(tmpfsArg).toMatch(/\brw\b/);
  });

  // Regression — the standalone `docker run` path mounts the broker
  // socket volume by name. The auth-broker compose declares the volume
  // with an explicit `name:` override (see compose-generator.test.ts
  // "auth-broker per-consumer volume naming"), so the actual docker
  // volume name has NO project prefix. setup.ts must reference that
  // unprefixed name; if it ever silently picks up the prefixed name, a
  // fresh empty volume gets created and the entrypoint times out on
  // the missing UDS.
  it("mounts the broker socket volume by the unprefixed canonical name", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    let volArg: string | undefined;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-v" && (args[i + 1] as string).includes("/run/switchroom/auth-broker")) {
        volArg = args[i + 1] as string;
        break;
      }
    }
    expect(volArg).toBe("auth-broker-hindsight-sock:/run/switchroom/auth-broker");
    // Must NOT have the docker-compose project prefix.
    expect(volArg).not.toMatch(/^switchroom_/);
  });
});

// (Removed: a regression test for the legacy host-side volume probe in
// `checkHindsightConsumer`. PR #1313 replaced that approach with a
// container-side `docker exec` probe that doesn't construct paths at
// all — the bug class this test covered is structurally impossible
// in the new shape. Coverage for the canonical-volume-name shape is
// preserved in compose-generator.test.ts and the broker-mount tests.)

// Regression — the compose snippet (used by operators who run hindsight
// in its OWN compose project rather than via `docker run`) had the same
// tmpfs ownership bug. Pin the tmpfs flag shape here so the two
// codepaths can't drift.
describe("getRunningHindsightPorts — host-network env fallback (#2903 fix 5.2)", () => {
  beforeEach(() => {
    mockedExec.mockReset();
  });

  it("reads HINDSIGHT_API_PORT from `docker inspect` env when `docker port` is empty (--network host)", () => {
    // A `--network host` container publishes no port mappings, so
    // `docker port` returns "" — the code must then recover the real host
    // port from the container's environment.
    mockedExec.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "port") return ""; // host-network: no mappings
      if (args[0] === "inspect") {
        // `{{.Config.Env}}` renders as a bracketed, space-separated Go list.
        return "[PATH=/usr/bin HINDSIGHT_API_PORT=28888 ANTHROPIC_BASE_URL=http://127.0.0.1:4010/anthropic]\n";
      }
      return "";
    });
    const ports = getRunningHindsightPorts();
    expect(ports).toEqual({ apiPort: 28888, uiPort: 19999 });
  });

  it("still prefers `docker port` output when the container publishes mappings", () => {
    mockedExec.mockImplementation((_cmd: string, args: string[]) => {
      // args = ["port", "switchroom-hindsight", "<containerPort>/tcp"]
      if (args[0] === "port" && args[2] === "8888/tcp") return "127.0.0.1:18888\n";
      if (args[0] === "port" && args[2] === "9999/tcp") return "127.0.0.1:9999\n";
      return "";
    });
    const ports = getRunningHindsightPorts();
    expect(ports).toEqual({ apiPort: HINDSIGHT_DEFAULT_API_PORT, uiPort: HINDSIGHT_DEFAULT_UI_PORT });
  });

  it("returns null when neither `docker port` nor inspect env yield an API port", () => {
    mockedExec.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "port") return "";
      if (args[0] === "inspect") return "[PATH=/usr/bin FOO=bar]\n";
      return "";
    });
    expect(getRunningHindsightPorts()).toBeNull();
  });
});

describe("hindsight/scaffold model pin (#2903 fix 5.4)", () => {
  it("HINDSIGHT_DEFAULT_MODEL stays in lockstep with SWITCHROOM_DEFAULT_MAIN_MODEL", () => {
    // A fleet model bump must move memory ops too; if these drift, hindsight's
    // retain/reflect/consolidation silently run on a stale model.
    expect(HINDSIGHT_DEFAULT_MODEL).toBe(SWITCHROOM_DEFAULT_MAIN_MODEL);
  });
});

describe("generateHindsightComposeSnippet — tmpfs ownership", () => {
  it("emits uid + gid on the /run/claude-creds tmpfs entry", async () => {
    const { generateHindsightComposeSnippet } = await import("../../src/setup/hindsight.js");
    const snippet = generateHindsightComposeSnippet();
    // Find the tmpfs block — it's a `- /run/claude-creds:rw,...` line.
    const tmpfsLine = snippet
      .split("\n")
      .find((l) => l.includes("/run/claude-creds:rw"));
    expect(tmpfsLine).toBeDefined();
    expect(tmpfsLine).toMatch(/uid=11000\b/);
    expect(tmpfsLine).toMatch(/gid=11000\b/);
    expect(tmpfsLine).toMatch(/mode=0700\b/);
  });

  it("publishes both ports on 127.0.0.1 only — the tokenless API must never bind 0.0.0.0 (Fix 1.1)", async () => {
    const { generateHindsightComposeSnippet, HINDSIGHT_DEFAULT_API_PORT } =
      await import("../../src/setup/hindsight.js");
    const snippet = generateHindsightComposeSnippet();
    const portLines = snippet
      .split("\n")
      .filter((l) => /^\s+-\s+"[\d.:]+:\d+"\s*$/.test(l));
    // Both the API and UI published ports must be present and loopback-bound.
    expect(portLines.length).toBeGreaterThanOrEqual(2);
    for (const line of portLines) {
      expect(line, `port binding must be loopback-only: ${line}`).toMatch(
        /"127\.0\.0\.1:/,
      );
    }
    expect(snippet).toContain(`"127.0.0.1:${HINDSIGHT_DEFAULT_API_PORT}:8888"`);
    expect(snippet).toContain('"127.0.0.1:19999:9999"');
    // Guard against a regression that drops the host-IP prefix entirely.
    expect(snippet).not.toMatch(/-\s+"\d+:8888"/);
    expect(snippet).not.toMatch(/-\s+"\d+:9999"/);
  });

  it("emits shm_size so the compose path matches the docker-run shm fix (2026-06-06 outage)", async () => {
    const { generateHindsightComposeSnippet, HINDSIGHT_DEFAULT_SHM_SIZE: shm } =
      await import("../../src/setup/hindsight.js");
    const snippet = generateHindsightComposeSnippet();
    expect(snippet).toMatch(new RegExp(`shm_size:\\s*${shm}\\b`));
  });

  it("emits a healthcheck + separate backups volume (parity with the docker-run path)", async () => {
    const { generateHindsightComposeSnippet } = await import("../../src/setup/hindsight.js");
    const snippet = generateHindsightComposeSnippet();
    expect(snippet).toMatch(/healthcheck:/);
    expect(snippet).toContain("/health");
    expect(snippet).toContain("- switchroom-hindsight-backups:/backups");
    // The backups volume must be declared under top-level `volumes:`.
    expect(snippet).toMatch(/^ {2}switchroom-hindsight-backups:/m);
    // Backups must not share the data volume mount.
    expect(snippet).not.toContain("switchroom-hindsight-data:/backups");
  });
});

describe("ensureHindsightConsumer (#1245)", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "switchroom-setup-test-"));
    configPath = join(dir, "switchroom.yaml");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds an `auth.consumers[hindsight]` entry pinned to the active account", async () => {
    writeFileSync(
      configPath,
      [
        "telegram: {}",
        "agents: {}",
        "auth:",
        "  active: me@example.com",
        "",
      ].join("\n"),
      "utf-8",
    );
    const result = await ensureHindsightConsumer(configPath, "me@example.com");
    expect(result.added).toBe(true);
    const raw = readFileSync(configPath, "utf-8");
    expect(raw).toMatch(/consumers:/);
    expect(raw).toMatch(/name: hindsight/);
    expect(raw).toMatch(/account: me@example\.com/);
    expect(raw).toMatch(new RegExp(`uid: ${HINDSIGHT_DEFAULT_UID}`));
    expect(result.reason).toBe("added");
  });

  it("is idempotent when an entry named `hindsight` already exists", async () => {
    writeFileSync(
      configPath,
      [
        "auth:",
        "  active: me@example.com",
        "  consumers:",
        "    - name: hindsight",
        "      account: prior@example.com",
        "      uid: 12345",
        "",
      ].join("\n"),
      "utf-8",
    );
    const result = await ensureHindsightConsumer(configPath, "me@example.com");
    expect(result.added).toBe(false);
    const raw = readFileSync(configPath, "utf-8");
    // Prior entry untouched (account stays at prior@, uid stays at 12345).
    expect(raw).toMatch(/account: prior@example\.com/);
    expect(raw).toMatch(/uid: 12345/);
    expect(raw).not.toMatch(/account: me@example\.com/);
  });

  it("creates the `auth.consumers` array when missing", async () => {
    writeFileSync(
      configPath,
      [
        "auth:",
        "  active: me@example.com",
        "",
      ].join("\n"),
      "utf-8",
    );
    const result = await ensureHindsightConsumer(configPath, "me@example.com");
    expect(result.added).toBe(true);
    const raw = readFileSync(configPath, "utf-8");
    expect(raw).toMatch(/consumers:\s*\n\s+- name: hindsight/);
  });

  it("creates the entire `auth:` block when missing", async () => {
    writeFileSync(configPath, "telegram: {}\nagents: {}\n", "utf-8");
    const result = await ensureHindsightConsumer(configPath, "me@example.com");
    expect(result.added).toBe(true);
    const raw = readFileSync(configPath, "utf-8");
    expect(raw).toMatch(/auth:/);
    expect(raw).toMatch(/name: hindsight/);
  });

  it("does NOT write any OpenAI key or HINDSIGHT_API_LLM_API_KEY to the yaml", async () => {
    writeFileSync(configPath, "auth:\n  active: me@example.com\n", "utf-8");
    await ensureHindsightConsumer(configPath, "me@example.com");
    const raw = readFileSync(configPath, "utf-8");
    expect(raw).not.toMatch(/openai/i);
    expect(raw).not.toMatch(/api_key/i);
    expect(raw).not.toMatch(/HINDSIGHT_API_LLM_API_KEY/);
  });

  it("uses the canonical consumer slug", () => {
    expect(HINDSIGHT_CONSUMER_NAME).toBe("hindsight");
  });
});
