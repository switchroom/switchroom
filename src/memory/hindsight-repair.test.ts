import { describe, it, expect } from "vitest";
import {
  buildRepairBankArgv,
  parseRepairSummary,
  compareApiVersion,
  classifyRepairPreflight,
  fetchHindsightApiVersion,
  HINDSIGHT_ADMIN_BIN,
  HINDSIGHT_CONTAINER_NAME,
  classifyRepairOutcome,
  REPAIR_COVERAGE_MISSING_EXIT,
  REPAIR_UNVERIFIED_EXIT,
  REPAIR_FAILED_EXIT,
} from "./hindsight-repair.js";
import {
  HINDSIGHT_MIN_API_VERSION,
  HINDSIGHT_REPAIR_MIN_API_VERSION,
} from "./hindsight-tools.js";

describe("buildRepairBankArgv", () => {
  it("targets the named container and the admin CLI's real in-image path", () => {
    const argv = buildRepairBankArgv({ bank: "agent_overlord" });
    expect(argv[0]).toBe("exec");
    expect(argv[1]).toBe(HINDSIGHT_CONTAINER_NAME);
    // The binary is NOT on the container PATH, so the absolute path must be
    // in the command or the verb is a no-op that reads like a missing tool.
    expect(argv.join(" ")).toContain(HINDSIGHT_ADMIN_BIN);
  });

  it("passes the bank id as a positional arg, never interpolated into the shell string", () => {
    const hostile = "bank'; rm -rf /; echo '";
    const argv = buildRepairBankArgv({ bank: hostile });
    const script = argv[argv.indexOf("-c") + 1];
    // The value appears only after the `--` separator (i.e. as "$@"), so the
    // shell never parses it as syntax.
    expect(script).not.toContain("rm -rf");
    expect(argv.slice(argv.indexOf("--") + 1)).toContain(hostile);
  });

  it("forwards --all, --schema and --dry-run to repair-bank", () => {
    const argv = buildRepairBankArgv({ all: true, schema: "tenant_x", dryRun: true });
    const cmd = argv.slice(argv.indexOf("--") + 1);
    expect(cmd).toEqual(["repair-bank", "--all", "--schema", "tenant_x", "--dry-run"]);
  });

  it("omits --dry-run and --schema when not requested (no accidental no-op run)", () => {
    const cmd = buildRepairBankArgv({ bank: "b1" }).slice(
      buildRepairBankArgv({ bank: "b1" }).indexOf("--") + 1,
    );
    expect(cmd).toEqual(["repair-bank", "--bank", "b1"]);
  });

  it("honours an overridden container name", () => {
    expect(buildRepairBankArgv({ all: true, container: "hs-staging" })[1]).toBe("hs-staging");
  });

  it("rejects neither --bank nor --all (upstream exit 2, caught before we spawn)", () => {
    expect(() => buildRepairBankArgv({})).toThrow(/exactly one of/);
  });

  it("rejects both --bank and --all", () => {
    expect(() => buildRepairBankArgv({ bank: "b1", all: true })).toThrow(/exactly one of/);
  });

  it("treats an empty --bank as absent rather than shipping `--bank ''`", () => {
    expect(() => buildRepairBankArgv({ bank: "" })).toThrow(/exactly one of/);
    expect(buildRepairBankArgv({ bank: "", all: true })[1]).toBe(HINDSIGHT_CONTAINER_NAME);
  });
});

describe("parseRepairSummary", () => {
  it("extracts the totals from repair-bank's Done line", () => {
    const out = [
      "Repairing per-bank vector indexes for all banks across base schema and all discovered tenant schemas...",
      "  schema 'public': 7 bank(s) scanned, 12 present, 9 created, 0 to-create (dry-run), 0 failed",
      "Done: 1 schema(s), 7 bank(s) scanned, 12 already present, 9 created, 0 to-create (dry-run), 0 failed",
    ].join("\n");
    expect(parseRepairSummary(out)).toEqual({
      schemas: 1,
      banksScanned: 7,
      alreadyPresent: 12,
      created: 9,
      toCreate: 0,
      failed: 0,
    });
  });

  it("reports a dry run's pending work in toCreate, with created at zero", () => {
    const s = parseRepairSummary(
      "Dry run: no indexes will be created or dropped.\n" +
        "Done: 2 schema(s), 14 bank(s) scanned, 40 already present, 0 created, 6 to-create (dry-run), 0 failed",
    );
    expect(s?.toCreate).toBe(6);
    expect(s?.created).toBe(0);
  });

  it("surfaces a non-zero failure count rather than reading as success", () => {
    const s = parseRepairSummary(
      "Done: 1 schema(s), 3 bank(s) scanned, 0 already present, 2 created, 0 to-create (dry-run), 1 failed",
    );
    expect(s?.failed).toBe(1);
  });

  it("returns null when the run ended before the summary (unsupported backend / bad db url)", () => {
    expect(
      parseRepairSummary(
        "Configured vector backend does not use per-bank vector indexes — nothing to repair.",
      ),
    ).toBeNull();
    expect(parseRepairSummary("")).toBeNull();
  });
});

describe("dry-run coverage exit code", () => {
  it("is distinct from the generic failure code, so a script can tell them apart", () => {
    expect(REPAIR_COVERAGE_MISSING_EXIT).not.toBe(0);
    expect(REPAIR_COVERAGE_MISSING_EXIT).not.toBe(1);
  });

  it("a dry-run summary with pending work is detectable without reading prose", () => {
    // The whole point: `toCreate > 0` is the machine-readable signal the CLI
    // turns into a non-zero exit. Prose being the only signal is how three
    // months of degraded recall went unnoticed.
    const s = parseRepairSummary(
      "Done: 1 schema(s), 7 bank(s) scanned, 3 already present, 0 created, 11 to-create (dry-run), 0 failed",
    );
    expect(s!.toCreate > 0).toBe(true);
  });

  it("a clean dry run reports no pending work", () => {
    const s = parseRepairSummary(
      "Done: 1 schema(s), 7 bank(s) scanned, 21 already present, 0 created, 0 to-create (dry-run), 0 failed",
    );
    expect(s!.toCreate).toBe(0);
    expect(s!.alreadyPresent).toBe(21);
  });
});

describe("compareApiVersion", () => {
  it("orders by numeric component, not lexically (0.8.10 > 0.8.9)", () => {
    expect(compareApiVersion("0.8.10", "0.8.9")).toBeGreaterThan(0);
  });

  it("treats a missing trailing component as zero", () => {
    expect(compareApiVersion("0.9", "0.9.0")).toBe(0);
  });

  it("compares equal versions as equal and is antisymmetric", () => {
    expect(compareApiVersion("0.8.5", "0.8.5")).toBe(0);
    expect(compareApiVersion("0.8.4", "0.8.5")).toBeLessThan(0);
    expect(compareApiVersion("0.8.5", "0.8.4")).toBeGreaterThan(0);
  });

  it("does not sort a pre-release below its release (deliberately lenient)", () => {
    expect(compareApiVersion("0.8.5rc1", "0.8.5")).toBe(0);
    expect(compareApiVersion("0.8.5-dev", "0.8.5")).toBe(0);
  });
});

describe("classifyRepairPreflight", () => {
  /**
   * The feature floor must NOT be the MCP-contract floor. Fusing them is what
   * made `switchroom doctor` red-by-construction on the running fleet: the
   * contract was captured from 0.8.4 but the constant claimed 0.8.5 because
   * repair-bank needs it. If someone re-fuses them, this reds.
   */
  it("uses the repair FEATURE floor, which is above the MCP contract floor", () => {
    expect(compareApiVersion(HINDSIGHT_REPAIR_MIN_API_VERSION, HINDSIGHT_MIN_API_VERSION))
      .toBeGreaterThan(0);
    // The contract floor alone must not admit a server that lacks repair-bank.
    expect(classifyRepairPreflight(HINDSIGHT_MIN_API_VERSION).ok).toBe(false);
  });

  it("blocks a confirmed pre-0.8.5 server and names the real cause, not a typo", () => {
    const r = classifyRepairPreflight("0.8.4");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("0.8.4");
    expect(r.reason).toContain(HINDSIGHT_REPAIR_MIN_API_VERSION);
    expect(r.reason).toMatch(/repair-bank/);
  });

  it("allows the floor version and anything newer", () => {
    expect(classifyRepairPreflight("0.8.5").ok).toBe(true);
    expect(classifyRepairPreflight("0.9.0").ok).toBe(true);
  });

  it("allows an unknown version — the escape hatch must work in the degraded state it exists for", () => {
    expect(classifyRepairPreflight(null).ok).toBe(true);
  });
});

describe("fetchHindsightApiVersion", () => {
  const ok = (body: unknown) =>
    (async () =>
      ({ ok: true, status: 200, json: async () => body }) as unknown as Response) as unknown as typeof fetch;

  it("reads api_version from <origin>/version, deriving the origin from the MCP url", async () => {
    let seen = "";
    const impl = (async (u: string) => {
      seen = u;
      return { ok: true, status: 200, json: async () => ({ api_version: "0.8.5" }) } as unknown as Response;
    }) as unknown as typeof fetch;
    expect(await fetchHindsightApiVersion("http://127.0.0.1:18888/mcp/", { fetchImpl: impl })).toBe("0.8.5");
    expect(seen).toBe("http://127.0.0.1:18888/version");
  });

  it("returns null on a non-200, an unparseable body, or a missing field", async () => {
    const bad = (async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    expect(await fetchHindsightApiVersion("http://h/mcp/", { fetchImpl: bad })).toBeNull();
    expect(await fetchHindsightApiVersion("http://h/mcp/", { fetchImpl: ok({}) })).toBeNull();
    expect(await fetchHindsightApiVersion("http://h/mcp/", { fetchImpl: ok({ api_version: 5 }) })).toBeNull();
  });

  it("returns null instead of throwing when the request fails", async () => {
    const boom = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await fetchHindsightApiVersion("http://h/mcp/", { fetchImpl: boom })).toBeNull();
  });
});

/**
 * The verdict logic. Every case here was previously inline in the `memory
 * repair` action body — untestable, and wrong in two places at once, both of
 * them FALSE GREENS in the feature written to eliminate false greens.
 */
describe("classifyRepairOutcome", () => {
  const summary = (over: Partial<{
    schemas: number;
    banksScanned: number;
    alreadyPresent: number;
    created: number;
    toCreate: number;
    failed: number;
  }> = {}) => ({
    schemas: 1,
    banksScanned: 14,
    alreadyPresent: 40,
    created: 0,
    toCreate: 0,
    failed: 0,
    ...over,
  });

  it("exits 0 only for a completed scan of at least one bank with nothing outstanding", () => {
    const o = classifyRepairOutcome({ childExit: 0, summary: summary(), dryRun: true });
    expect(o.exit).toBe(0);
    expect(o.level).toBe("ok");
  });

  /**
   * REGRESSION (false green #1): a typo'd `--bank` makes repair-bank scan
   * nothing and print `Done: 1 schema(s), 0 bank(s) scanned, ...`. That used to
   * render "✓ Coverage complete ... across 0 bank(s)" and exit 0, which the
   * health skill reported as "OK: vector index coverage complete".
   */
  it("does NOT report coverage complete when zero banks were scanned", () => {
    const o = classifyRepairOutcome({
      childExit: 0,
      summary: summary({ banksScanned: 0, alreadyPresent: 0 }),
      dryRun: true,
    });
    expect(o.exit).toBe(REPAIR_UNVERIFIED_EXIT);
    expect(o.exit).not.toBe(0);
    expect(o.level).toBe("fail");
    expect(o.headline).toMatch(/0 bank/);
    expect(o.headline).not.toMatch(/complete/i);
  });

  /**
   * REGRESSION (false green #2): no summary line printed "coverage was NOT
   * confirmed" and then returned WITHOUT a non-zero exit, so the honest prose
   * was invisible to every machine consumer.
   */
  it("exits non-zero when repair-bank printed no summary — unverified is not success", () => {
    const o = classifyRepairOutcome({ childExit: 0, summary: null, dryRun: true });
    expect(o.exit).toBe(REPAIR_UNVERIFIED_EXIT);
    expect(o.exit).not.toBe(0);
    expect(o.headline).toMatch(/NOT confirmed/);
  });

  it("reports missing coverage on a dry run with its own code", () => {
    const o = classifyRepairOutcome({
      childExit: 0,
      summary: summary({ toCreate: 6 }),
      dryRun: true,
    });
    expect(o.exit).toBe(REPAIR_COVERAGE_MISSING_EXIT);
    expect(o.headline).toContain("6 vector index(es) missing");
  });

  it("does not treat a completed real repair as missing coverage", () => {
    // Outside --dry-run, toCreate is not a gap: the indexes were built.
    const o = classifyRepairOutcome({
      childExit: 0,
      summary: summary({ created: 6, toCreate: 0 }),
      dryRun: false,
    });
    expect(o.exit).toBe(0);
    expect(o.detail).toContain("6 created");
  });

  it("fails when indexes failed to build even though repair-bank exited 0", () => {
    const o = classifyRepairOutcome({
      childExit: 0,
      summary: summary({ failed: 2 }),
      dryRun: false,
    });
    expect(o.exit).toBe(REPAIR_FAILED_EXIT);
    expect(o.headline).toContain("2 index(es) failed");
  });

  /**
   * The exit-code collision. repair-bank is a typer app: exit 2 is a USAGE
   * error. Propagating the child's code verbatim made a mistyped flag surface
   * as this command's "coverage missing" signal.
   */
  it("never re-emits the child's exit code, so typer's usage-error 2 cannot read as 'coverage missing'", () => {
    const o = classifyRepairOutcome({ childExit: 2, summary: null, dryRun: true });
    expect(o.exit).toBe(REPAIR_FAILED_EXIT);
    expect(o.exit).not.toBe(REPAIR_COVERAGE_MISSING_EXIT);
    expect(o.detail).toMatch(/usage error/i);
  });

  it("keeps the meaningful codes off typer's reserved 2", () => {
    expect(REPAIR_COVERAGE_MISSING_EXIT).not.toBe(2);
    expect(REPAIR_UNVERIFIED_EXIT).not.toBe(2);
    expect(new Set([0, REPAIR_FAILED_EXIT, REPAIR_COVERAGE_MISSING_EXIT, REPAIR_UNVERIFIED_EXIT]).size)
      .toBe(4);
  });

  it("translates a spawn failure (127) into the failure code, not a coverage verdict", () => {
    const o = classifyRepairOutcome({ childExit: 127, summary: null, dryRun: false });
    expect(o.exit).toBe(REPAIR_FAILED_EXIT);
  });
});
