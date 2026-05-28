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
 * flag — cannot silently reintroduce the flap. As of RFC #1620 the
 * codebase has *zero* headless-`claude` spawners at all (the handoff
 * builder and webhook dispatch were both moved off `claude -p`); this
 * guard keeps any future one honest.
 *
 * NOTE: source is comment-stripped before every check. A naive
 * file-wide substring scan would be defeated by the doc comments that
 * *describe* `--strict-mcp-config` — a callsite could lose the real
 * argv entry and still pass because the prose mentions the flag. The
 * behavioural backstop (a flap reintroduced by some other mechanism)
 * is the `bridge-flap-resilience-dm` UAT scenario.
 */

const ROOTS = ["src", "telegram-plugin"];

/**
 * Files that spawn `claude` WITHOUT `--strict-mcp-config`, knowingly.
 * Every entry MUST cite a tracking issue. This list may only ever
 * shrink — when the gap is fixed the entry must be deleted, and the
 * "no stale entries" test below enforces that.
 *
 * Currently empty: webhook-dispatch.ts (the last entry, #1617) was
 * migrated off `claude -p` to the `inject_inbound` path — every
 * headless-`claude` callsite now passes `--strict-mcp-config`, or
 * spawns no `claude` at all.
 */
const KNOWN_GAPS: Record<string, string> = {};

/** Matches `spawn("claude"`, `spawnSync('claude'`, `execFile("claude"`, etc. */
const SPAWN_CLAUDE =
  /(?:spawn|spawnSync|execFile|execFileSync)[A-Za-z]*\(\s*['"]claude['"]/;

/**
 * Strip line and block comments so the checks below see code only,
 * not prose. Without this a doc comment that mentions
 * `--strict-mcp-config` would mask a callsite that no longer actually
 * passes the flag.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

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
  // { rel, code } where code is the comment-stripped source.
  const spawners = ROOTS.flatMap((r) => walkTs(join(repoRoot, r)))
    .map((f) => ({
      rel: relative(repoRoot, f).replace(/\\/g, "/"),
      code: stripComments(readFileSync(f, "utf8")),
    }))
    .filter((x) => SPAWN_CLAUDE.test(x.code));

  it("the SPAWN_CLAUDE scan regex still matches a claude spawn (scan-not-broken sanity)", () => {
    // Post-#1620 the codebase has zero headless-`claude` spawners, so
    // we cannot assert "a spawner exists". Instead verify the scan
    // regex itself still matches the canonical spawn shapes — if it
    // silently broke, every per-file check below would vacuously pass.
    expect(SPAWN_CLAUDE.test('spawn("claude", args, opts)')).toBe(true);
    expect(SPAWN_CLAUDE.test("spawnFn('claude', ['-p'])")).toBe(true);
    expect(SPAWN_CLAUDE.test('execFile("claude")')).toBe(true);
    expect(SPAWN_CLAUDE.test('spawn("bun", args)')).toBe(false);
  });

  for (const { rel, code } of spawners) {
    it(`${rel} passes --strict-mcp-config`, () => {
      if (rel in KNOWN_GAPS) {
        expect(KNOWN_GAPS[rel]).toMatch(/#\d+/);
        return; // documented, issue-tracked exception
      }
      // `code` is comment-stripped — a doc comment that merely
      // *describes* the flag cannot satisfy this check.
      expect(
        code.includes("--strict-mcp-config"),
        `${rel} spawns a headless 'claude' but does not pass --strict-mcp-config ` +
          `(checked against comment-stripped source). Without it the subprocess ` +
          `auto-loads the agent's .mcp.json, starts switchroom-telegram, and ` +
          `spawns a parasitic bridge → the #1613 flap. Add --strict-mcp-config, ` +
          `or (if genuinely intentional) add the file to KNOWN_GAPS with a ` +
          `tracking-issue reference.`,
      ).toBe(true);
    });
  }

  it("KNOWN_GAPS has no stale entries", () => {
    const found = spawners.map((s) => s.rel);
    for (const rel of Object.keys(KNOWN_GAPS)) {
      expect(
        found,
        `${rel} is allowlisted in KNOWN_GAPS but no longer spawns claude — ` +
          `delete the entry.`,
      ).toContain(rel);
    }
  });

  // ── Tightening (#1798) — also catch `claude -p` in string-template form ──
  //
  // The spawn-callsite regex above only catches direct spawn() / execFile()
  // invocations. The bridge flap we hunted on 2026-05-25 came from a
  // different shape: `src/agents/scaffold.ts` was building bash scripts as
  // template strings containing literal `claude -p '<prompt>'`, writing
  // them to `~/.switchroom/agents/<name>/telegram/cron-*.sh` on every
  // `switchroom apply`. The CI guard missed it because the TS source had
  // no `spawn("claude", …)` callsite — the violation was in the *string
  // template* the source emits to disk.
  //
  // Match shape: a TS string literal (single or double quote, or
  // template-literal backtick) that contains ` claude -p` (claude as a
  // word, immediately followed by `-p`). Comment-stripped scan rules out
  // doc-comment mentions.
  const CLAUDE_P_TEMPLATE =
    /['"`][^'"`\n]*\bclaude -p\b[^'"`\n]*['"`]|`[^`]*\bclaude -p\b[^`]*`/;

  it("the CLAUDE_P_TEMPLATE scan regex matches a string template containing 'claude -p'", () => {
    // Single-quoted, double-quoted, backtick (template) — all caught.
    expect(CLAUDE_P_TEMPLATE.test(`const s = 'claude -p \\'hi\\'';`)).toBe(true);
    expect(CLAUDE_P_TEMPLATE.test(`const s = "claude -p \\"hi\\"";`)).toBe(true);
    expect(CLAUDE_P_TEMPLATE.test('const s = `claude -p ${prompt}`;')).toBe(true);
    // String that doesn't contain `claude -p` does not match.
    expect(CLAUDE_P_TEMPLATE.test(`const s = 'claude --strict-mcp-config';`)).toBe(false);
    expect(CLAUDE_P_TEMPLATE.test(`const s = "spawn claude with --print";`)).toBe(false);
  });

  /**
   * Allowlist for the `claude -p` string-template check, mirroring
   * KNOWN_GAPS for the spawn-callsite check. Every entry MUST cite a
   * tracking issue. Shrink-only — when the offender migrates off the
   * `claude -p` template, delete the entry. The "no stale entries" test
   * below enforces that.
   */
  const KNOWN_TEMPLATE_GAPS: Record<string, string> = {
    // #1798 resolved: `claude -p ok` deep probe replaced with a
    // token-introspect check against .credentials.json (no model call).
  };

  it("no source file emits a `claude -p` string template to disk (#1798)", () => {
    const repoRoot = process.cwd();
    const allTs = ROOTS.flatMap((r) => walkTs(join(repoRoot, r)));
    const offenders: string[] = [];
    for (const f of allTs) {
      const rel = relative(repoRoot, f).replace(/\\/g, "/");
      if (rel in KNOWN_TEMPLATE_GAPS) {
        expect(KNOWN_TEMPLATE_GAPS[rel]).toMatch(/#\d+/);
        continue;
      }
      const code = stripComments(readFileSync(f, "utf8"));
      if (CLAUDE_P_TEMPLATE.test(code)) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      `These source files contain a string template that emits 'claude -p' ` +
        `to disk — when written to a shell script and executed, each fire ` +
        `spawns a parasitic claude code session that loads the agent's full ` +
        `.mcp.json (including switchroom-telegram), connects a 2nd bridge ` +
        `to the gateway, and triggers the #1613/#1616 reconnect-race storm. ` +
        `Worse: 'claude -p' is *programmatic* usage under Anthropic's ` +
        `2026-06-15 policy (off the subscription) — a pillar-3 compliance ` +
        `violation independent of the bridge flap. Route the work through ` +
        `the live interactive claude session via 'inject_inbound' IPC ` +
        `(scheduler / webhook / cron-fold-in patterns) instead. If genuinely ` +
        `intentional, add the file to KNOWN_TEMPLATE_GAPS with a tracking-` +
        `issue reference.\n\nOffending file(s):\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("KNOWN_TEMPLATE_GAPS has no stale entries", () => {
    const repoRoot = process.cwd();
    const allTs = ROOTS.flatMap((r) => walkTs(join(repoRoot, r)));
    for (const rel of Object.keys(KNOWN_TEMPLATE_GAPS)) {
      const f = join(repoRoot, rel);
      const code = stripComments(readFileSync(f, "utf8"));
      expect(
        CLAUDE_P_TEMPLATE.test(code),
        `${rel} is allowlisted in KNOWN_TEMPLATE_GAPS but no longer ` +
          `contains a 'claude -p' string template — delete the entry.`,
      ).toBe(true);
    }
  });
});
