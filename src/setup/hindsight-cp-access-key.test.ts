/**
 * The hindsight CONTROL-PLANE dashboard must never be reachable off host
 * loopback without a login — on ANY launch path, under ANY configuration.
 *
 * `HINDSIGHT_CP_ACCESS_KEY` is the only thing that arms the CP login
 * middleware. The shipped edge bundle reads the var and short-circuits to
 * `next()` when it is falsy, so an UNSET key is not weak auth — it is no auth,
 * on every protected route. Meanwhile upstream `start-all.sh` exports
 * `HOSTNAME="${HINDSIGHT_CP_HOSTNAME:-0.0.0.0}"` before `node server.js`, and
 * `--network host` makes docker ignore `-p`. On 2026-07-29 those three facts
 * combined into an unauthenticated dashboard answering on the host's LAN and
 * Tailscale addresses on port 9999 — the CP twin of the API exposure #3976
 * closed.
 *
 * So, exactly as in `hindsight-loopback-bind.test.ts`, these tests do NOT
 * assert "the string appears in the branch that was edited". They compute the
 * EXPOSURE VERDICT of the real artefacts — the `docker run` argv
 * `startHindsight` executes, and the text `generateHindsightComposeSnippet`
 * emits — across the whole space of configurations, with and without a
 * configured key, and fail if any of them can produce a dashboard that is
 * reachable beyond loopback while the login is inert.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: execFileSyncMock };
});

import {
  startHindsight,
  generateHindsightComposeSnippet,
  hindsightCpAuthEnvPairs,
  resolveHindsightCpAccessKey,
  HINDSIGHT_CP_UNAUTHENTICATED_BIND_ADDR,
  HINDSIGHT_DEFAULT_API_PORT,
  HINDSIGHT_DEFAULT_UI_PORT,
  type HindsightLlmConfig,
  type LiteLLMHindsightConfig,
} from "./hindsight.js";

const API_PORT = HINDSIGHT_DEFAULT_API_PORT;
const UI_PORT = HINDSIGHT_DEFAULT_UI_PORT;
/** Loopback literals a bind address may legitimately be. Nothing else counts. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
/** Not a credential — assembled at runtime so push-protection scanners stay quiet. */
const ACCESS_KEY = "cp-" + "test-access-key-not-real";

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

/** Every configuration that puts hindsight on the host network stack. */
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

const ALL_CASES = [...HOST_NETWORK_CASES, ...BRIDGE_CASES];

/** The real `docker run` argv `startHindsight` would execute. */
function dockerRunArgv(c: Case, cpAccessKey?: string): string[] {
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
    cpAccessKey,
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

/** `-p` values, e.g. `127.0.0.1:19999:9999`. */
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
  return { hostNetwork: lines.includes("network_mode: host"), env, publishes };
}

function composeFor(c: Case, cpAccessKey?: string) {
  return analyzeCompose(
    generateHindsightComposeSnippet(c.llm, undefined, c.litellm, false, {
      env: {},
      processEnv: {} as NodeJS.ProcessEnv,
    }, cpAccessKey),
  );
}

/**
 * Is the DASHBOARD (port 9999) reachable from beyond host loopback?
 *
 * Host network: `-p` is inert, so the verdict is the CP process's own bind
 * address (`HINDSIGHT_CP_HOSTNAME`). Absent ⇒ upstream's `0.0.0.0` default ⇒
 * exposed. That absence IS the bug.
 *
 * Bridge: the CP binds inside its own netns, so the verdict is whether the
 * published 9999 mapping pins a loopback host-side address.
 */
function dashboardExposedBeyondLoopback(a: {
  hostNetwork: boolean;
  env: Map<string, string>;
  publishes: string[];
}): boolean {
  if (a.hostNetwork) {
    const bind = a.env.get("HINDSIGHT_CP_HOSTNAME");
    return bind === undefined || !LOOPBACK.has(bind.trim());
  }
  const ui = a.publishes.filter((p) => p.endsWith(":9999"));
  if (ui.length === 0) return false;
  return ui.some((p) => {
    const parts = p.split(":");
    if (parts.length < 3) return true;
    return !LOOPBACK.has(parts.slice(0, parts.length - 2).join(":"));
  });
}

/** The CP login is armed iff the access key reaches the container. */
function loginArmed(env: Map<string, string>): boolean {
  return (env.get("HINDSIGHT_CP_ACCESS_KEY") ?? "").trim().length > 0;
}

describe("the CP access key reaches the container on every launch path", () => {
  it.each(ALL_CASES.map((c) => [c.name, c] as const))(
    "docker run argv carries HINDSIGHT_CP_ACCESS_KEY — %s",
    (_name, c) => {
      // Pre-fix this was absent on every path: the var was never emitted at
      // all, so the dashboard's middleware was inert no matter what the
      // operator put in switchroom.yaml.
      const env = envFromArgv(dockerRunArgv(c, ACCESS_KEY));
      expect(env.get("HINDSIGHT_CP_ACCESS_KEY")).toBe(ACCESS_KEY);
    },
  );

  it.each(ALL_CASES.map((c) => [c.name, c] as const))(
    "compose snippet carries HINDSIGHT_CP_ACCESS_KEY — %s",
    (_name, c) => {
      expect(composeFor(c, ACCESS_KEY).env.get("HINDSIGHT_CP_ACCESS_KEY")).toBe(ACCESS_KEY);
    },
  );

  it("docker-run and compose agree about the CP auth env on every case", () => {
    // The parity property #3976 established for the API bind, applied to CP
    // auth: a fix present on one emitter and forgotten on the other is the
    // recurring shape of this defect.
    for (const c of ALL_CASES) {
      for (const key of [ACCESS_KEY, undefined]) {
        const run = envFromArgv(dockerRunArgv(c, key));
        const comp = composeFor(c, key).env;
        for (const v of ["HINDSIGHT_CP_ACCESS_KEY", "HINDSIGHT_CP_HOSTNAME"]) {
          expect(comp.get(v), `${c.name} / key=${key ? "set" : "unset"} / ${v}`).toBe(
            run.get(v),
          );
        }
      }
    }
  });
});

describe("a dashboard reachable beyond loopback always has a login", () => {
  it.each(ALL_CASES.map((c) => [c.name, c] as const))(
    "docker run: exposed ⇒ login armed — %s",
    (_name, c) => {
      for (const key of [ACCESS_KEY, undefined]) {
        const argv = dockerRunArgv(c, key);
        const env = envFromArgv(argv);
        const exposed = dashboardExposedBeyondLoopback({
          hostNetwork: hasHostNetworkArg(argv),
          env,
          publishes: publishesFromArgv(argv),
        });
        // THE invariant. Not "the env var is present" — the verdict.
        expect(
          !exposed || loginArmed(env),
          `${c.name} (key ${key ? "set" : "unset"}): dashboard exposed beyond ` +
            "loopback with no access key",
        ).toBe(true);
      }
    },
  );

  it.each(ALL_CASES.map((c) => [c.name, c] as const))(
    "compose: exposed ⇒ login armed — %s",
    (_name, c) => {
      for (const key of [ACCESS_KEY, undefined]) {
        const a = composeFor(c, key);
        expect(
          !dashboardExposedBeyondLoopback(a) || loginArmed(a.env),
          `${c.name} (key ${key ? "set" : "unset"}): compose exposes the ` +
            "dashboard with no access key",
        ).toBe(true);
      }
    },
  );

  it.each(HOST_NETWORK_CASES.map((c) => [c.name, c] as const))(
    "no key + host network ⇒ CP pinned to loopback, not merely warned about — %s",
    (_name, c) => {
      // Deterministic containment, not prompt/doc discipline: with no key the
      // launch itself confines the loginless dashboard.
      const env = envFromArgv(dockerRunArgv(c, undefined));
      expect(env.get("HINDSIGHT_CP_HOSTNAME")).toBe(HINDSIGHT_CP_UNAUTHENTICATED_BIND_ADDR);
      expect(env.has("HINDSIGHT_CP_ACCESS_KEY")).toBe(false);
      expect(composeFor(c, undefined).env.get("HINDSIGHT_CP_HOSTNAME")).toBe(
        HINDSIGHT_CP_UNAUTHENTICATED_BIND_ADDR,
      );
    },
  );

  it.each(HOST_NETWORK_CASES.map((c) => [c.name, c] as const))(
    "key set + host network ⇒ dashboard is served to the LAN/tailnet — %s",
    (_name, c) => {
      // The operator WANTS LAN/Tailscale reachability; the fix must not be a
      // disguised lockout. With the login armed the bind opens back up.
      const env = envFromArgv(dockerRunArgv(c, ACCESS_KEY));
      expect(env.get("HINDSIGHT_CP_HOSTNAME")).toBe("0.0.0.0");
      expect(
        dashboardExposedBeyondLoopback({
          hostNetwork: true,
          env,
          publishes: [],
        }),
      ).toBe(true);
    },
  );

  it("never pins the CP bind on the bridge path (it would break the -p publish)", () => {
    // On bridge, docker-proxy dials the container's bridge IP; a 127.0.0.1
    // in-netns bind makes `-p 127.0.0.1:19999:9999` connect-refuse. The `-p`
    // mapping is already the containment there.
    for (const c of BRIDGE_CASES) {
      for (const key of [ACCESS_KEY, undefined]) {
        expect(envFromArgv(dockerRunArgv(c, key)).has("HINDSIGHT_CP_HOSTNAME")).toBe(false);
        expect(composeFor(c, key).env.has("HINDSIGHT_CP_HOSTNAME")).toBe(false);
      }
    }
  });
});

describe("hindsightCpAuthEnvPairs", () => {
  it("treats a whitespace-only key as no key", () => {
    expect(hindsightCpAuthEnvPairs({ accessKey: "   ", hostNetwork: true })).toEqual([
      ["HINDSIGHT_CP_HOSTNAME", HINDSIGHT_CP_UNAUTHENTICATED_BIND_ADDR],
    ]);
  });

  it("emits nothing at all on bridge with no key", () => {
    expect(hindsightCpAuthEnvPairs({ hostNetwork: false })).toEqual([]);
  });

  it("trims the key it emits", () => {
    expect(
      hindsightCpAuthEnvPairs({ accessKey: `  ${ACCESS_KEY}\n`, hostNetwork: false }),
    ).toEqual([["HINDSIGHT_CP_ACCESS_KEY", ACCESS_KEY]]);
  });
});

describe("a switchroom.yaml line actually reaches the container", () => {
  // Reachability, not schema shape: the defect class here is a knob an
  // operator sets that never changes the launch. Walk the whole chain —
  // parse → resolve (vault) → docker-run argv.
  it("hindsight.cp_access_key: vault:<key> ends up as HINDSIGHT_CP_ACCESS_KEY", async () => {
    const { HindsightConfigSchema } = await import("../config/schema.js");
    const parsed = HindsightConfigSchema.parse({
      cp_access_key: "vault:hindsight_cp_access_key",
    });
    expect(parsed.cp_access_key).toBe("vault:hindsight_cp_access_key");

    const resolved = await resolveHindsightCpAccessKey(
      { hindsight: parsed },
      {
        getViaBrokerStructured: vi
          .fn()
          .mockResolvedValue({ kind: "ok", entry: { kind: "string", value: ACCESS_KEY } }) as never,
      },
    );
    const env = envFromArgv(
      dockerRunArgv({ name: "litellm", litellm: litellmCfg("http://127.0.0.1:4010") }, resolved),
    );
    expect(env.get("HINDSIGHT_CP_ACCESS_KEY")).toBe(ACCESS_KEY);
    expect(env.get("HINDSIGHT_CP_HOSTNAME")).toBe("0.0.0.0");
  });
});

describe("the access key never reaches the operator's terminal", () => {
  it("the recreate env-drift report redacts HINDSIGHT_CP_ACCESS_KEY", async () => {
    // The drift report dumps the live container's env when a recreate would
    // drop a var. Introducing a credential into that env makes the report a
    // new leak surface, so pin the redaction rather than trusting the regex.
    const { diffDroppedHindsightEnv, formatDroppedHindsightEnvReport, REDACTED_ENV_VALUE } =
      await import("./hindsight-env-drift.js");
    const dropped = diffDroppedHindsightEnv([`HINDSIGHT_CP_ACCESS_KEY=${ACCESS_KEY}`], [], []);
    expect(dropped.map((d) => d.key)).toContain("HINDSIGHT_CP_ACCESS_KEY");
    const report = formatDroppedHindsightEnvReport(dropped, {
      gpu: false,
      localLlm: false,
    }).join("\n");
    expect(report).toContain(REDACTED_ENV_VALUE);
    expect(report).not.toContain(ACCESS_KEY);
  });
});

describe("resolveHindsightCpAccessKey", () => {
  const brokerOk = (value: string) =>
    vi.fn().mockResolvedValue({ kind: "ok", entry: { kind: "string", value } });

  // These tests reason about the exact opts object handed to the broker, which
  // depends on SWITCHROOM_AGENT_NAME / SWITCHROOM_AGENTS_DIR. The harness may
  // itself run inside an agent container where those are set, so pin them for
  // determinism and restore afterwards.
  let savedName: string | undefined;
  let savedDir: string | undefined;
  beforeEach(() => {
    savedName = process.env.SWITCHROOM_AGENT_NAME;
    savedDir = process.env.SWITCHROOM_AGENTS_DIR;
    delete process.env.SWITCHROOM_AGENT_NAME;
    delete process.env.SWITCHROOM_AGENTS_DIR;
  });
  afterEach(() => {
    if (savedName === undefined) delete process.env.SWITCHROOM_AGENT_NAME;
    else process.env.SWITCHROOM_AGENT_NAME = savedName;
    if (savedDir === undefined) delete process.env.SWITCHROOM_AGENTS_DIR;
    else process.env.SWITCHROOM_AGENTS_DIR = savedDir;
  });

  it("returns undefined when nothing is configured", async () => {
    await expect(resolveHindsightCpAccessKey({})).resolves.toBeUndefined();
    await expect(
      resolveHindsightCpAccessKey({ hindsight: { cp_access_key: "  " } }),
    ).resolves.toBeUndefined();
  });

  it("passes a literal through without touching the broker", async () => {
    const get = brokerOk("unused");
    await expect(
      resolveHindsightCpAccessKey(
        { hindsight: { cp_access_key: ACCESS_KEY } },
        { getViaBrokerStructured: get as never },
      ),
    ).resolves.toBe(ACCESS_KEY);
    expect(get).not.toHaveBeenCalled();
  });

  it("reads a `vault:` reference through the broker, by bare key", async () => {
    const get = brokerOk(ACCESS_KEY);
    await expect(
      resolveHindsightCpAccessKey(
        { hindsight: { cp_access_key: "vault:hindsight_cp_access_key" } },
        { getViaBrokerStructured: get as never },
      ),
    ).resolves.toBe(ACCESS_KEY);
    // No SWITCHROOM_AGENT_NAME in this test's env ⇒ token stays undefined ⇒
    // the opts object is empty. The empty-opts call is wire-identical to the
    // pre-fix bare-key call (getViaBrokerStructured omits `token` from the
    // payload when absent), so the host-operator peercred path is unaffected.
    expect(get).toHaveBeenCalledWith("hindsight_cp_access_key", {});
  });

  it("fails CLOSED on a denied/missing/erroring vault reference", async () => {
    // An unresolvable ref must read as "no key" — which pins the dashboard to
    // loopback — never as "carry on and serve it open".
    for (const get of [
      vi.fn().mockResolvedValue({ kind: "denied" }),
      vi.fn().mockResolvedValue({ kind: "ok", entry: { kind: "json", value: {} } }),
      vi.fn().mockResolvedValue({ kind: "ok", entry: { kind: "string", value: "  " } }),
      vi.fn().mockRejectedValue(new Error("broker down")),
    ]) {
      await expect(
        resolveHindsightCpAccessKey(
          { hindsight: { cp_access_key: "vault:hindsight_cp_access_key" } },
          { getViaBrokerStructured: get as never },
        ),
      ).resolves.toBeUndefined();
    }
  });

  it("forwards the agent capability token to the broker when a token file exists", async () => {
    // The bug: in-process resolvers called the broker WITHOUT the agent's
    // capability token, so the broker denied on the peercred ACL and the
    // `.catch(() => null)` swallowed it — HINDSIGHT_CP_ACCESS_KEY never
    // resolved under `memory setup --recreate`. The fix mirrors the working
    // `vault get` path: read the token file and thread `{ token }` into the
    // broker opts. This asserts the forwarding actually happens; it FAILS
    // against the unpatched resolver, which passes only the bare key.
    const dir = fs.mkdtempSync(join(os.tmpdir(), "sr-vault-token-"));
    const slug = "test-agent";
    const token = "vault-cap-" + "token-not-real";
    fs.mkdirSync(join(dir, slug), { recursive: true });
    const tokenPath = join(dir, slug, ".vault-token");
    fs.writeFileSync(tokenPath, token + "\n");
    fs.chmodSync(tokenPath, 0o600); // readVaultTokenFile refuses non-0600 files
    process.env.SWITCHROOM_AGENTS_DIR = dir;
    process.env.SWITCHROOM_AGENT_NAME = slug;

    try {
      const get = brokerOk(ACCESS_KEY);
      await expect(
        resolveHindsightCpAccessKey(
          { hindsight: { cp_access_key: "vault:hindsight_cp_access_key" } },
          { getViaBrokerStructured: get as never },
        ),
      ).resolves.toBe(ACCESS_KEY);
      expect(get).toHaveBeenCalledWith("hindsight_cp_access_key", { token });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
