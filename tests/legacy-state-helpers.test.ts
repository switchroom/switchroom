/**
 * Tests for the legacy-state deprecation safety rails (#1373 / #1375):
 *
 * 1. src/config/paths.ts `warnLegacyStateOnce`:
 *    - Writes exactly one stderr line per process across multiple legacy hits.
 *    - Writes zero lines when only the canonical `~/.switchroom` tree exists.
 *
 * 2. src/cli/doctor.ts `checkLegacyState()`:
 *    - Returns `status: "ok"` on a clean (migrated) host.
 *    - Returns `status: "warn"` for the `~/.clerk` dir and the v0.6
 *      `~/.switchroom/vault-broker.sock` (including a DANGLING symlink,
 *      since detection uses lstatSync).
 *    - Never returns `status: "fail"` — doctor exit code is unaffected.
 *
 * These are the safety rails that have to keep working right up to the
 * v0.13.0 removal of the `.clerk` dual-read shim. The dual-read is the
 * only silent-catastrophic deprecation in the tree — deleting it while
 * a host is still on `~/.clerk` makes vault/agents/auth read as absent
 * with no error. Coverage here gives the removal PR a green floor.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  mkdtempSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("warnLegacyStateOnce (src/config/paths.ts)", () => {
  let tmp: string;
  let origHome: string | undefined;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "switchroom-legacy-state-"));
    origHome = process.env.HOME;
    process.env.HOME = tmp;
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // Reset module state so `_legacyStateWarned` starts fresh per test.
    vi.resetModules();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    if (origHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = origHome;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("emits zero stderr lines when only the canonical ~/.switchroom tree exists", async () => {
    mkdirSync(join(tmp, ".switchroom", "agents"), { recursive: true });
    const { resolveStatePath } = await import("../src/config/paths.js");

    const got = resolveStatePath("agents");
    expect(got).toBe(join(tmp, ".switchroom", "agents"));

    const deprecationCalls = stderrSpy.mock.calls.filter((c) =>
      String(c[0]).includes("DEPRECATED: reading legacy state"),
    );
    expect(deprecationCalls).toHaveLength(0);
  });

  it("emits exactly one stderr line per process across multiple legacy hits", async () => {
    // Only ~/.clerk/<frag> exists → resolveStatePath falls back to legacy and
    // warns. Two consecutive calls must produce a single deprecation line.
    mkdirSync(join(tmp, ".clerk", "agents"), { recursive: true });
    mkdirSync(join(tmp, ".clerk", "vault.enc.d"), { recursive: true });
    const { resolveStatePath } = await import("../src/config/paths.js");

    const a = resolveStatePath("agents");
    const b = resolveStatePath("vault.enc.d");
    expect(a).toBe(join(tmp, ".clerk", "agents"));
    expect(b).toBe(join(tmp, ".clerk", "vault.enc.d"));

    const deprecationCalls = stderrSpy.mock.calls.filter((c) =>
      String(c[0]).includes("DEPRECATED: reading legacy state"),
    );
    expect(deprecationCalls).toHaveLength(1);
    // Sanity-check the message body — the removal-version pointer is the
    // load-bearing part for the operator.
    expect(String(deprecationCalls[0][0])).toMatch(/REMOVED in v0\.13\.0/);
  });

  it("the resolveDualPath callsite also dedups against resolveStatePath", async () => {
    // Both helpers funnel through the same module-level _legacyStateWarned
    // flag. Hitting both should still produce exactly one stderr line.
    mkdirSync(join(tmp, ".clerk", "vault.enc.d"), { recursive: true });
    mkdirSync(join(tmp, ".clerk", "agents", "x"), { recursive: true });
    const { resolveStatePath, resolveDualPath } = await import("../src/config/paths.js");

    resolveStatePath("vault.enc.d");
    resolveDualPath("~/.switchroom/agents/x");

    const deprecationCalls = stderrSpy.mock.calls.filter((c) =>
      String(c[0]).includes("DEPRECATED: reading legacy state"),
    );
    expect(deprecationCalls).toHaveLength(1);
  });
});

describe("checkLegacyState (src/cli/doctor.ts)", () => {
  let tmp: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "switchroom-doctor-legacy-"));
    origHome = process.env.HOME;
    process.env.HOME = tmp;
  });

  afterEach(() => {
    if (origHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = origHome;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns status=ok for both probes when neither legacy artifact exists", async () => {
    const { checkLegacyState } = await import("../src/cli/doctor.js");
    const results = checkLegacyState();

    expect(results).toHaveLength(1); // only the clerk-dir probe runs when no socket
    for (const r of results) {
      expect(r.status).toBe("ok");
      expect(r.status).not.toBe("fail");
    }
  });

  it("returns status=warn (never fail) when ~/.clerk is present", async () => {
    mkdirSync(join(tmp, ".clerk"), { recursive: true });
    const { checkLegacyState } = await import("../src/cli/doctor.js");

    const results = checkLegacyState();
    const clerk = results.find((r) => r.name.includes("legacy ~/.clerk"));
    expect(clerk).toBeDefined();
    expect(clerk?.status).toBe("warn");
    expect(clerk?.status).not.toBe("fail");
    expect(clerk?.detail).toContain(join(tmp, ".clerk"));
    expect(clerk?.fix).toMatch(/mv ~\/\.clerk ~\/\.switchroom/);
  });

  it("returns status=warn for the v0.6 broker socket when it exists as a real file", async () => {
    mkdirSync(join(tmp, ".switchroom"), { recursive: true });
    writeFileSync(join(tmp, ".switchroom", "vault-broker.sock"), "");
    const { checkLegacyState } = await import("../src/cli/doctor.js");

    const results = checkLegacyState();
    const sock = results.find((r) => r.name.includes("legacy v0.6 broker socket"));
    expect(sock).toBeDefined();
    expect(sock?.status).toBe("warn");
    expect(sock?.status).not.toBe("fail");
    expect(sock?.fix).toMatch(/LEGACY_SOCKET_PATH/);
  });

  it("returns status=warn for a DANGLING symlink at the broker-socket path (lstatSync detection)", async () => {
    // Detection uses lstatSync, not statSync, so a dangling symlink still
    // surfaces. Pre-#1373 the probe missed this case and let the operator
    // hit the silent-fallback failure mode on a v0.13.0 upgrade.
    mkdirSync(join(tmp, ".switchroom"), { recursive: true });
    symlinkSync(
      join(tmp, "nonexistent-target"),
      join(tmp, ".switchroom", "vault-broker.sock"),
    );
    const { checkLegacyState } = await import("../src/cli/doctor.js");

    const results = checkLegacyState();
    const sock = results.find((r) => r.name.includes("legacy v0.6 broker socket"));
    expect(sock).toBeDefined();
    expect(sock?.status).toBe("warn");
    expect(sock?.detail).toContain("symlink");
  });

  it("never returns status=fail under any combination — doctor exit code stays 0", async () => {
    // Both legacy artifacts present at once.
    mkdirSync(join(tmp, ".clerk"), { recursive: true });
    mkdirSync(join(tmp, ".switchroom"), { recursive: true });
    writeFileSync(join(tmp, ".switchroom", "vault-broker.sock"), "");
    const { checkLegacyState } = await import("../src/cli/doctor.js");

    const results = checkLegacyState();
    for (const r of results) {
      expect(r.status).not.toBe("fail");
    }
  });
});
