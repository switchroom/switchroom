import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Regression guard for the bridge-flap wedge class (#1613 / #1616).
 *
 * A headless `claude -p` subprocess auto-discovers the agent's project
 * `.mcp.json` and starts every MCP server in it — including
 * `switchroom-telegram`, which spins up a *second* telegram bridge.
 * That parasitic bridge registers against the same gateway socket as
 * the live agent's real bridge, and the two collide under the
 * gateway's register-race close — the "bridge reconnect race" flap.
 *
 * `--strict-mcp-config` (with no `--mcp-config`) makes a headless
 * `claude` load zero MCP servers, and is the fix (#1616).
 *
 * This test fails the build if any source file spawns `claude`
 * without `--strict-mcp-config`, so a new callsite — or a removed
 * flag — cannot silently reintroduce the flap. The behavioural
 * backstop (a flap reintroduced by some other mechanism) is the
 * `bridge-flap-resilience-dm` UAT scenario.
 */

const ROOTS = ["src", "telegram-plugin"];

/**
 * Files that spawn `claude` WITHOUT `--strict-mcp-config`, knowingly.
 * Every entry MUST cite a tracking issue. This list may only ever
 * shrink — when the gap is fixed the entry must be deleted, and the
 * "no stale entries" test below enforces that.
 */
const KNOWN_GAPS: Record<string, string> = {
  "src/web/webhook-dispatch.ts":
    "#1617 — migrating to inject_inbound (RFC docs/rfcs/eliminate-claude-p.md, Workstream A)",
};

/** Matches `spawn("claude"`, `spawnSync('claude'`, `execFile("claude"`, etc. */
const SPAWN_CLAUDE =
  /(?:spawn|spawnSync|execFile|execFileSync)[A-Za-z]*\(\s*['"]claude['"]/;

function walkTs(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      out.push(...walkTs(p));
    } else if (e.endsWith(".ts") && !e.endsWith(".test.ts") && !e.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

describe("bridge-flap regression guard — headless claude must use --strict-mcp-config (#1613/#1616)", () => {
  const repoRoot = process.cwd();
  const claudeSpawners = ROOTS.flatMap((r) => walkTs(join(repoRoot, r)))
    .filter((f) => SPAWN_CLAUDE.test(readFileSync(f, "utf8")))
    .map((f) => relative(repoRoot, f).replace(/\\/g, "/"));

  it("the source scan still finds claude spawners (scan-not-broken sanity)", () => {
    // If the regex silently stops matching, every per-file check below
    // vacuously passes — this guards the guard.
    expect(claudeSpawners.length).toBeGreaterThan(0);
  });

  for (const rel of claudeSpawners) {
    it(`${rel} passes --strict-mcp-config`, () => {
      if (rel in KNOWN_GAPS) {
        expect(KNOWN_GAPS[rel]).toMatch(/#\d+/);
        return; // documented, issue-tracked exception
      }
      const src = readFileSync(join(repoRoot, rel), "utf8");
      expect(
        src.includes("--strict-mcp-config"),
        `${rel} spawns a headless 'claude' but does not pass --strict-mcp-config. ` +
          `Without it the subprocess auto-loads the agent's .mcp.json, starts ` +
          `switchroom-telegram, and spawns a parasitic bridge → the #1613 flap. ` +
          `Add --strict-mcp-config, or (if genuinely intentional) add the file to ` +
          `KNOWN_GAPS with a tracking-issue reference.`,
      ).toBe(true);
    });
  }

  it("KNOWN_GAPS has no stale entries", () => {
    for (const rel of Object.keys(KNOWN_GAPS)) {
      expect(
        claudeSpawners,
        `${rel} is allowlisted in KNOWN_GAPS but no longer spawns claude — ` +
          `delete the entry.`,
      ).toContain(rel);
    }
  });
});
