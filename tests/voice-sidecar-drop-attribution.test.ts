/**
 * A defaulted voice verdict must never remove `voice-sidecar` silently.
 *
 * The bug: both voice gates read the verdict through `loadHostCapabilities()`,
 * whose own docstring says to prefer `readHostCapabilities` "anywhere the null
 * would silently become a behaviour change". Dropping an already-emitted
 * service from the fleet compose is exactly such a change, and `absent` is
 * deliberately quiet at the reader layer — so a moved/lost
 * `host-capabilities.json` deleted a running GPU service and the operator's
 * only signal was an unattributed `compose: services removed: voice-sidecar.`
 *
 * These assert the OUTCOME the operator gets (a reason naming the verdict path,
 * on a defaulted read only), not that a particular helper was called.
 *
 * Isolation: `resolveStatePath` derives from `process.env.HOME`, so HOME points
 * at a fresh tmpdir — never the operator's real `~/.switchroom/`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveVoiceEngine,
  isDefaultedVoiceEngine,
  resetHostCapabilitiesWarnings,
  hostCapabilitiesPath,
} from "../src/setup/host-capabilities.js";
import {
  computeComposeContent,
  detectVoiceSidecarDrop,
  parseComposeServiceNames,
  _resetVoiceSidecarDropWarning,
} from "../src/cli/write-compose.js";
import { runApplyDryRun } from "../src/cli/apply.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

let home: string;
let prevHome: string | undefined;
let prevHostHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "switchroom-voicedrop-"));
  prevHome = process.env.HOME;
  prevHostHome = process.env.SWITCHROOM_HOST_HOME;
  process.env.HOME = home;
  // The compose generator's host-home resolver THROWS inside a container when
  // this is unset (the 2026-06-23 poison guard), which would turn the wiring
  // tests below into a `compose generation:` blocker instead of exercising the
  // drop path. Pin it at the same tmp home so the test is identical on a host
  // shell and in CI's container.
  process.env.SWITCHROOM_HOST_HOME = home;
  resetHostCapabilitiesWarnings();
  _resetVoiceSidecarDropWarning();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevHostHome === undefined) delete process.env.SWITCHROOM_HOST_HOME;
  else process.env.SWITCHROOM_HOST_HOME = prevHostHome;
  rmSync(home, { recursive: true, force: true });
});

/** Write a verdict file with the given engine. */
function writeVerdict(engine: "local" | "cloud"): void {
  const path = hostCapabilitiesPath();
  mkdirSync(join(home, ".switchroom"), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      voice: {
        gpuPresent: engine === "local",
        containerToolkit: engine === "local",
        engine,
        detectedAt: "2026-06-30T21:10:45.000Z",
      },
    }),
  );
}

/** Write bytes that are readable but are not a capabilities document. */
function writeGarbageVerdict(): void {
  mkdirSync(join(home, ".switchroom"), { recursive: true });
  writeFileSync(hostCapabilitiesPath(), '{"version":1}');
}

const WITH_SIDECAR = [
  "services:",
  "  clerk:",
  "    image: ghcr.io/switchroom/switchroom-agent:v1",
  "  voice-sidecar:",
  "    image: ghcr.io/switchroom/switchroom-voice:v1",
  "",
].join("\n");

const WITHOUT_SIDECAR = [
  "services:",
  "  clerk:",
  "    image: ghcr.io/switchroom/switchroom-agent:v1",
  "",
].join("\n");

describe("resolveVoiceEngine — reports HOW the engine was decided", () => {
  it("a readable local verdict is a read, not a default", () => {
    writeVerdict("local");
    const r = resolveVoiceEngine();
    expect(r.engine).toBe("local");
    expect(r.reason).toBe("verdict");
    expect(isDefaultedVoiceEngine(r)).toBe(false);
  });

  it("a readable cloud verdict is a read, not a default", () => {
    writeVerdict("cloud");
    const r = resolveVoiceEngine();
    expect(r.engine).toBe("cloud");
    expect(r.reason).toBe("verdict");
    expect(isDefaultedVoiceEngine(r)).toBe(false);
  });

  it("an absent verdict defaults to cloud and says so", () => {
    const r = resolveVoiceEngine();
    expect(r.engine).toBe("cloud");
    expect(r.reason).toBe("no-verdict");
    expect(isDefaultedVoiceEngine(r)).toBe(true);
    // The path is what makes the message actionable.
    expect(r.path).toBe(hostCapabilitiesPath());
  });

  // `unreadable` is the LOUD trigger the reader singles out (a root-owned 0600
  // file in a uid-1000 home): the file is there and we were denied, which is
  // NOT "no GPU" and NOT "malformed bytes" — each points the operator at a
  // different fix. Root bypasses mode bits, so this can only run unprivileged.
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  it.skipIf(asRoot)(
    "an unreadable verdict is distinguishable from malformed — different fix",
    () => {
      mkdirSync(join(home, ".switchroom"), { recursive: true });
      writeFileSync(hostCapabilitiesPath(), "{}");
      chmodSync(hostCapabilitiesPath(), 0o000);
      const r = resolveVoiceEngine();
      expect(r.engine).toBe("cloud");
      expect(r.reason).toBe("unreadable");
      expect(isDefaultedVoiceEngine(r)).toBe(true);
      expect(r.detail).not.toBe("");
    },
  );

  // The EACCES case above cannot run as root, and CI is not the only place
  // this suite runs. A directory in the way of the path is the same
  // `unreadable` fact (EISDIR) and is uid-independent, so the branch is never
  // left wholly unexercised — without one of these, a typo folding
  // `unreadable` into `malformed` ships, and the operator is told to fix the
  // file's BYTES when the actual fix is its PERMISSIONS.
  it("a verdict path blocked by a directory is unreadable, not malformed", () => {
    mkdirSync(hostCapabilitiesPath(), { recursive: true });
    const r = resolveVoiceEngine();
    expect(r.engine).toBe("cloud");
    expect(r.reason).toBe("unreadable");
    expect(isDefaultedVoiceEngine(r)).toBe(true);
    expect(r.detail).not.toBe("");
  });

  it("a malformed verdict defaults to cloud and is distinguishable from absent", () => {
    writeGarbageVerdict();
    const r = resolveVoiceEngine();
    expect(r.engine).toBe("cloud");
    expect(r.reason).toBe("malformed");
    expect(isDefaultedVoiceEngine(r)).toBe(true);
    expect(r.detail).not.toBe("");
  });
});

describe("detectVoiceSidecarDrop — fires only when a default costs a service", () => {
  it("attributes the removal when the verdict file is missing", () => {
    const drop = detectVoiceSidecarDrop(
      WITH_SIDECAR,
      WITHOUT_SIDECAR,
      resolveVoiceEngine(),
    );
    expect(drop).not.toBeNull();
    expect(drop!.reason).toBe("no-verdict");
    // The operator must be told WHERE to look and that this is not a
    // GPU-absence finding — that conflation is the bug.
    expect(drop!.message).toContain(hostCapabilitiesPath());
    expect(drop!.message).toContain("REMOVED");
    expect(drop!.message).toContain("could not tell");
  });

  it("attributes the removal when the verdict file is unusable", () => {
    writeGarbageVerdict();
    const drop = detectVoiceSidecarDrop(
      WITH_SIDECAR,
      WITHOUT_SIDECAR,
      resolveVoiceEngine(),
    );
    expect(drop).not.toBeNull();
    expect(drop!.reason).toBe("malformed");
    expect(drop!.message).toContain("malformed");
  });

  it("stays quiet on a genuine cloud verdict — that removal is intended", () => {
    writeVerdict("cloud");
    expect(
      detectVoiceSidecarDrop(WITH_SIDECAR, WITHOUT_SIDECAR, resolveVoiceEngine()),
    ).toBeNull();
  });

  it("stays quiet on a fresh install with no previous compose", () => {
    expect(
      detectVoiceSidecarDrop(null, WITHOUT_SIDECAR, resolveVoiceEngine()),
    ).toBeNull();
  });

  it("stays quiet when the previous compose never had the sidecar", () => {
    expect(
      detectVoiceSidecarDrop(WITHOUT_SIDECAR, WITHOUT_SIDECAR, resolveVoiceEngine()),
    ).toBeNull();
  });

  it("stays quiet when the sidecar survives the regeneration", () => {
    writeVerdict("local");
    expect(
      detectVoiceSidecarDrop(WITH_SIDECAR, WITH_SIDECAR, resolveVoiceEngine()),
    ).toBeNull();
  });
});

describe("parseComposeServiceNames — the single parse both surfaces use", () => {
  it("extracts top-level service keys only", () => {
    expect(parseComposeServiceNames(WITH_SIDECAR)).toEqual([
      "clerk",
      "voice-sidecar",
    ]);
  });
});

/**
 * The helpers above are pure and would all stay green if the WIRING that
 * carries their answer to the operator were deleted — the `voiceSidecarDrop`
 * field on `computeComposeContent`'s result and the `warnings.push` in
 * `runApplyDryRun`. These drive the real seam end to end instead: a config in,
 * an `ApplyDryRunResult` out, asserting the operator-visible OUTCOME (which
 * REPORT BUCKET the attribution lands in), not that a helper was called.
 */
describe("apply --dry-run — the attribution reaches the operator's report", () => {
  /** Minimal config that generates a compose with one agent. */
  function config(): SwitchroomConfig {
    return { agents: { clerk: { purpose: "test agent" } }, defaults: {} } as unknown as SwitchroomConfig;
  }

  /** Seed a previous on-disk compose that DOES declare the sidecar. */
  function seedPreviousCompose(content = WITH_SIDECAR): string {
    mkdirSync(join(home, ".switchroom"), { recursive: true });
    const composePath = join(home, ".switchroom", "docker-compose.yml");
    writeFileSync(composePath, content);
    return composePath;
  }

  /** Run the dry-run against a seeded compose, with docker detection stubbed. */
  async function dryRun(composePath: string) {
    return runApplyDryRun(
      config(),
      { outPath: composePath },
      { writeOut: () => {}, writeErr: () => {}, detectComposeV2: () => null },
    );
  }

  it("warns (not info, not blocking) when a defaulted verdict drops a running sidecar", async () => {
    const composePath = seedPreviousCompose();
    // No host-capabilities.json in this HOME → `no-verdict` → engine defaults
    // to cloud → the regenerated compose has no voice-sidecar.
    const res = await dryRun(composePath);

    const attributed = res.warnings.filter((w) => w.includes("voice-sidecar is being REMOVED"));
    expect(attributed).toHaveLength(1);
    // Actionable: names the verdict path, and refuses the GPU-absence framing
    // that conflation is the whole bug.
    expect(attributed[0]).toContain(hostCapabilitiesPath());
    expect(attributed[0]).toContain("could not tell");

    // The removal itself is deliberately UN-GATED — attributing it must not
    // start failing an apply that used to succeed.
    expect(res.blocking.filter((b) => b.includes("voice-sidecar"))).toEqual([]);
    expect(res.wouldSucceed).toBe(true);

    // And it must not be demoted into the info stream, where it reads as an
    // intended change alongside the unattributed `services removed:` line.
    expect(res.info.filter((i) => i.includes("is being REMOVED"))).toEqual([]);
    expect(res.removedServices).toContain("voice-sidecar");
  });

  it("stays quiet on a genuine cloud verdict — the same removal, deliberately", async () => {
    writeVerdict("cloud");
    const composePath = seedPreviousCompose();
    const res = await dryRun(composePath);

    // Same observable removal…
    expect(res.removedServices).toContain("voice-sidecar");
    // …but no attribution anywhere, because the operator's own verdict said so.
    // Without this, "always warn" would satisfy the test above.
    expect(res.warnings.filter((w) => w.includes("voice-sidecar"))).toEqual([]);
    expect(res.blocking.filter((b) => b.includes("voice-sidecar"))).toEqual([]);
  });

  it("stays quiet when the previous compose never had the sidecar", async () => {
    const composePath = seedPreviousCompose(WITHOUT_SIDECAR);
    const res = await dryRun(composePath);

    expect(res.removedServices).not.toContain("voice-sidecar");
    expect(res.warnings.filter((w) => w.includes("voice-sidecar"))).toEqual([]);
  });
});

describe("computeComposeContent — the drop is returned AND warned once", () => {
  /** Seed a previous compose declaring the sidecar; return its path. */
  function seed(): string {
    mkdirSync(join(home, ".switchroom"), { recursive: true });
    const composePath = join(home, ".switchroom", "docker-compose.yml");
    writeFileSync(composePath, WITH_SIDECAR);
    return composePath;
  }

  async function compute(composePath: string) {
    return computeComposeContent({
      config: { agents: { clerk: { purpose: "test agent" } }, defaults: {} } as unknown as SwitchroomConfig,
      composePath,
      buildMode: "pull",
      buildContext: undefined,
    });
  }

  it("emits the stderr warning exactly ONCE per process, not per caller", async () => {
    const composePath = seed();
    const captured: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stderr.write = ((chunk: any, ...rest: any[]) => {
      captured.push(String(chunk));
      return original(chunk, ...(rest as []));
    }) as typeof process.stderr.write;
    try {
      // Every caller of this seam (apply, dry-run, `agent restart`'s
      // reconcile, doctor drift) hits it in one process; the operator must
      // not be spammed, but must still get it back structurally each time.
      const first = await compute(composePath);
      const second = await compute(composePath);
      expect(first.voiceSidecarDrop).not.toBeNull();
      expect(second.voiceSidecarDrop).not.toBeNull();
      expect(
        captured.filter((c) => c.includes("voice-sidecar is being REMOVED")),
      ).toHaveLength(1);
    } finally {
      process.stderr.write = original;
    }
  });

  it("_resetVoiceSidecarDropWarning re-arms the once-guard for the next process", async () => {
    const composePath = seed();
    await compute(composePath);
    _resetVoiceSidecarDropWarning();

    const captured: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stderr.write = ((chunk: any, ...rest: any[]) => {
      captured.push(String(chunk));
      return original(chunk, ...(rest as []));
    }) as typeof process.stderr.write;
    try {
      await compute(composePath);
      expect(
        captured.filter((c) => c.includes("voice-sidecar is being REMOVED")),
      ).toHaveLength(1);
    } finally {
      process.stderr.write = original;
    }
  });
});
