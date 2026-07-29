/**
 * The hindsight API must never be reachable off host loopback — on ANY launch
 * path, under ANY configuration.
 *
 * The API is TOKENLESS: no securitySchemes, no bearer check, `GET
 * /v1/default/banks` enumerates every agent's bank and PATCH mutates them. The
 * ONLY thing keeping the fleet's memory off the LAN and the tailnet is where
 * the listener binds.
 *
 * On 2026-07-29 it was answering unauthenticated on `0.0.0.0:18888` across the
 * host's LAN and Tailscale addresses. The containment was written as
 * `-p 127.0.0.1:<port>:8888`, which docker IGNORES under `--network host`, and
 * the host-network branches pinned `HINDSIGHT_API_PORT` without ever pinning
 * `HINDSIGHT_API_HOST` — so the image default `0.0.0.0` won. The bridge path
 * was safe; the host path silently was not.
 *
 * These tests therefore do NOT assert "the string appears in the branch that
 * was edited" — that passes while a sibling branch stays wide open, which is
 * exactly how this shipped. They compute the EXPOSURE VERDICT of the real
 * artefacts (`docker run` argv from `startHindsight`, and the compose snippet)
 * across the whole space of configurations that select host networking, and
 * fail if any of them can be produced without a loopback bind.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: execFileSyncMock };
});

import {
  startHindsight,
  generateHindsightComposeSnippet,
  hindsightNeedsHostNetwork,
  hindsightContainerEnvPairs,
  HINDSIGHT_DEFAULT_API_PORT,
  HINDSIGHT_DEFAULT_UI_PORT,
  type HindsightLlmConfig,
  type LiteLLMHindsightConfig,
} from "./hindsight.js";

const API_PORT = HINDSIGHT_DEFAULT_API_PORT;
const UI_PORT = HINDSIGHT_DEFAULT_UI_PORT;
/** Loopback literals a bind address may legitimately be. Nothing else counts. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

beforeEach(() => {
  execFileSyncMock.mockReset();
  execFileSyncMock.mockReturnValue(Buffer.from(""));
});
afterEach(() => {
  vi.clearAllMocks();
});

type Case = {
  name: string;
  llm?: HindsightLlmConfig;
  litellm?: LiteLLMHindsightConfig;
};

const litellmCfg = (baseUrl: string): LiteLLMHindsightConfig => ({
  baseUrl,
  apiKey: "sk-" + "test-not-a-real-key",
  model: "claude-sonnet-5",
});

/**
 * Every configuration that puts hindsight on the host network stack — the two
 * originally-separate code paths (explicit LiteLLM config; per-op loopback
 * base URL with no LiteLLM config) and each per-op lane, so a fix applied to
 * one branch and forgotten in another goes red here.
 */
const HOST_NETWORK_CASES: Case[] = [
  { name: "explicit litellm config (loopback)", litellm: litellmCfg("http://127.0.0.1:4010") },
  { name: "explicit litellm config (remote)", litellm: litellmCfg("https://litellm.example.com") },
  {
    name: "per-op loopback base: retain",
    llm: { retain: { base_url: "http://127.0.0.1:4010", model: "m" } },
  },
  {
    name: "per-op loopback base: reflect",
    llm: { reflect: { base_url: "http://localhost:4010", model: "m" } },
  },
  {
    name: "per-op loopback base: consolidation",
    llm: { consolidation: { base_url: "http://[::1]:4010", model: "m" } },
  },
  {
    name: "per-op loopback base + non-claude provider",
    llm: {
      provider: "openai",
      model: "gpt-4o",
      reflect: { base_url: "http://127.0.0.1:11434/v1", model: "gpt-4o" },
    },
  },
  {
    name: "litellm config AND per-op loopback base",
    litellm: litellmCfg("http://127.0.0.1:4010"),
    llm: { consolidation: { base_url: "http://127.0.0.1:11434/v1", model: "m" } },
  },
];

/** Configurations that stay on the bridge — the `-p` publish must confine them. */
const BRIDGE_CASES: Case[] = [
  { name: "no llm config at all" },
  { name: "remote per-op base only", llm: { reflect: { base_url: "https://api.openai.com/v1" } } },
];

/** The real `docker run` argv `startHindsight` would execute. */
function dockerRunArgv(c: Case): string[] {
  execFileSyncMock.mockReset();
  execFileSyncMock.mockReturnValue(Buffer.from(""));
  startHindsight(
    { apiPort: API_PORT, uiPort: UI_PORT },
    c.litellm,
    undefined,
    c.llm,
    undefined,
    false,
    { env: {}, processEnv: {} as NodeJS.ProcessEnv },
  );
  const run = execFileSyncMock.mock.calls
    .map((call) => call[1] as string[])
    .filter((argv) => Array.isArray(argv) && argv[0] === "run");
  expect(run.length).toBe(1);
  return run[0];
}

function envFromArgv(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "-e") continue;
    const pair = argv[i + 1] ?? "";
    const eq = pair.indexOf("=");
    if (eq > 0) out.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return out;
}

/** `-p` values, e.g. `127.0.0.1:18888:8888`. */
function publishesFromArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-p" || argv[i] === "--publish") out.push(argv[i + 1] ?? "");
  }
  return out;
}

function hasHostNetworkArg(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--network" && argv[i + 1] === "host") return true;
    if (argv[i] === "--network=host" || argv[i] === "--net=host") return true;
  }
  return false;
}

/**
 * Does this launch expose the tokenless API beyond host loopback?
 *
 * Host network: `-p` is inert, so the verdict is the application's own bind
 * address. Absent ⇒ the image default `0.0.0.0` ⇒ exposed. That absence IS the
 * bug this file exists for.
 *
 * Bridge: the container binds inside its own netns, so the verdict is whether
 * every published mapping pins a loopback host-side address.
 */
function exposesBeyondLoopback(a: {
  hostNetwork: boolean;
  env: Map<string, string>;
  publishes: string[];
}): boolean {
  if (a.hostNetwork) {
    const bind = a.env.get("HINDSIGHT_API_HOST");
    return bind === undefined || !LOOPBACK.has(bind.trim());
  }
  if (a.publishes.length === 0) return false;
  return a.publishes.some((p) => {
    const parts = p.split(":");
    // `host:hostPort:containerPort` is confined; anything shorter publishes on
    // every interface.
    if (parts.length < 3) return true;
    return !LOOPBACK.has(parts.slice(0, parts.length - 2).join(":"));
  });
}

/** Compose snippet reduced to the same three facts. */
function analyzeCompose(yaml: string) {
  const lines = yaml.split("\n").map((l) => l.trim());
  const env = new Map<string, string>();
  for (const line of lines) {
    const m = /^-\s+([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) env.set(m[1], m[2]);
  }
  const publishes = lines
    .map((l) => /^-\s+"(.+)"$/.exec(l)?.[1])
    .filter((v): v is string => !!v && /^[^\s]*:?\d+:\d+$/.test(v));
  return {
    hostNetwork: lines.includes("network_mode: host"),
    env,
    publishes,
  };
}

describe("hindsight API bind — host-network launches", () => {
  it.each(HOST_NETWORK_CASES.map((c) => [c.name, c] as const))(
    "%s: docker run cannot be produced without a loopback bind",
    (_name, c) => {
      // Precondition: this case really does select host networking, so the
      // assertion below cannot pass by accidentally testing the bridge path.
      expect(hindsightNeedsHostNetwork(c.llm, c.litellm)).toBe(true);
      const argv = dockerRunArgv(c);
      expect(hasHostNetworkArg(argv)).toBe(true);
      const env = envFromArgv(argv);
      expect(
        exposesBeyondLoopback({ hostNetwork: true, env, publishes: publishesFromArgv(argv) }),
      ).toBe(false);
      // Spelled out, so the verdict helper itself can't be gutted silently.
      expect(env.get("HINDSIGHT_API_HOST")).toBe("127.0.0.1");
      // ...and the port pin still rides along, or the API binds 8888 on the
      // shared host stack and every agent's memory.config.url points at a dead
      // port (the 2026-07 outage).
      expect(env.get("HINDSIGHT_API_PORT")).toBe(String(API_PORT));
    },
  );

  it.each(HOST_NETWORK_CASES.map((c) => [c.name, c] as const))(
    "%s: the compose snippet cannot be produced without a loopback bind",
    (_name, c) => {
      const snippet = generateHindsightComposeSnippet(c.llm, undefined, c.litellm, false, {
        env: {},
        processEnv: {} as NodeJS.ProcessEnv,
      });
      const a = analyzeCompose(snippet);
      expect(a.hostNetwork).toBe(true);
      expect(exposesBeyondLoopback(a)).toBe(false);
      expect(a.env.get("HINDSIGHT_API_HOST")).toBe("127.0.0.1");
      expect(a.env.get("HINDSIGHT_API_PORT")).toBe(String(API_PORT));
    },
  );

  it("docker-run and compose agree on the bind for every host-network config", () => {
    // The twin property: the two generators may not disagree about where the
    // tokenless API listens. A fix applied to one is not a fix.
    for (const c of HOST_NETWORK_CASES) {
      const runEnv = envFromArgv(dockerRunArgv(c));
      const composeEnv = analyzeCompose(
        generateHindsightComposeSnippet(c.llm, undefined, c.litellm, false, {
          env: {},
          processEnv: {} as NodeJS.ProcessEnv,
        }),
      ).env;
      expect([c.name, composeEnv.get("HINDSIGHT_API_HOST")]).toEqual([
        c.name,
        runEnv.get("HINDSIGHT_API_HOST"),
      ]);
      expect([c.name, composeEnv.get("HINDSIGHT_API_PORT")]).toEqual([
        c.name,
        runEnv.get("HINDSIGHT_API_PORT"),
      ]);
    }
  });

  it("the pure env derivation carries the bind for every host-network config", () => {
    // `hindsightContainerEnvPairs` is what `switchroom memory setup --recreate`
    // diffs against the live container, so a bind missing HERE means a
    // recreate silently drops the containment off a running container.
    for (const c of HOST_NETWORK_CASES) {
      const env = new Map(
        hindsightContainerEnvPairs({
          apiPort: API_PORT,
          litellm: c.litellm,
          llm: c.llm,
          gpu: false,
          perf: { env: {}, processEnv: {} as NodeJS.ProcessEnv },
        }),
      );
      expect([c.name, env.get("HINDSIGHT_API_HOST")]).toEqual([c.name, "127.0.0.1"]);
    }
  });
});

describe("hindsight API bind — bridge launches", () => {
  it.each(BRIDGE_CASES.map((c) => [c.name, c] as const))(
    "%s: publishes only on host loopback",
    (_name, c) => {
      expect(hindsightNeedsHostNetwork(c.llm, c.litellm)).toBe(false);
      const argv = dockerRunArgv(c);
      expect(hasHostNetworkArg(argv)).toBe(false);
      const publishes = publishesFromArgv(argv);
      expect(publishes).toContain(`127.0.0.1:${API_PORT}:8888`);
      expect(
        exposesBeyondLoopback({ hostNetwork: false, env: envFromArgv(argv), publishes }),
      ).toBe(false);

      const a = analyzeCompose(
        generateHindsightComposeSnippet(c.llm, undefined, c.litellm, false, {
          env: {},
          processEnv: {} as NodeJS.ProcessEnv,
        }),
      );
      expect(a.hostNetwork).toBe(false);
      expect(a.publishes).toContain(`127.0.0.1:${API_PORT}:8888`);
      expect(exposesBeyondLoopback(a)).toBe(false);
    },
  );
});

describe("the exposure verdict itself", () => {
  // Without these, the helper above could be mutated to `return false` and the
  // whole file would stay green.
  it("calls an absent bind exposed under host networking", () => {
    expect(
      exposesBeyondLoopback({
        hostNetwork: true,
        env: new Map([["HINDSIGHT_API_PORT", String(API_PORT)]]),
        publishes: [],
      }),
    ).toBe(true);
  });

  it("calls a 0.0.0.0 bind exposed under host networking", () => {
    expect(
      exposesBeyondLoopback({
        hostNetwork: true,
        env: new Map([["HINDSIGHT_API_HOST", "0.0.0.0"]]),
        publishes: [`127.0.0.1:${API_PORT}:8888`],
      }),
    ).toBe(true);
  });

  it("ignores -p under host networking, the way docker does", () => {
    // The exact false-confidence that shipped the bug: loopback `-p` flags on
    // a `--network host` container mean nothing.
    expect(
      exposesBeyondLoopback({
        hostNetwork: true,
        env: new Map(),
        publishes: [`127.0.0.1:${API_PORT}:8888`, `127.0.0.1:${UI_PORT}:9999`],
      }),
    ).toBe(true);
  });

  it("calls an unqualified bridge publish exposed", () => {
    expect(
      exposesBeyondLoopback({
        hostNetwork: false,
        env: new Map(),
        publishes: [`${API_PORT}:8888`],
      }),
    ).toBe(true);
    expect(
      exposesBeyondLoopback({
        hostNetwork: false,
        env: new Map(),
        publishes: [`0.0.0.0:${API_PORT}:8888`],
      }),
    ).toBe(true);
  });
});
