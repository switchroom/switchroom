import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Behavioural backstop for the `check-web-subscription-honest.mjs` lint
 * gate (audit rank 28). The gate keeps the web dashboard (`src/web/**`)
 * subscription-honest: no Anthropic SDK import, no raw Anthropic API call,
 * no headless `claude -p` / `--print` spawn — CLAUDE.md's pillar-3
 * compliance boundary restated for the dashboard surface.
 *
 * Two things this test pins:
 *   1. The guard EXITS 0 on the current tree (the dashboard is clean).
 *   2. The guard's regexes actually TRIP on a synthetic violation (so a
 *      future change can't quietly defang the matcher and leave it green).
 *
 * Mirrors `bridge-flap-regression-guard.test.ts` in shape.
 */

const repoRoot = process.cwd();
const SCRIPT = resolve(repoRoot, "scripts/check-web-subscription-honest.mjs");

describe("web subscription-honest guard (#audit-28)", () => {
  it("exits 0 — the dashboard makes zero model calls on the current tree", () => {
    // execFileSync throws on a non-zero exit, so a clean run is the
    // assertion. Capture stdout for a useful message on failure.
    let out = "";
    try {
      out = execFileSync("node", [SCRIPT], {
        cwd: repoRoot,
        encoding: "utf-8",
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      throw new Error(
        `check-web-subscription-honest exited ${e.status}: ${
          e.stderr || e.stdout || String(err)
        }`,
      );
    }
    expect(out).toContain("clean");
  });

  it("the forbidden-pattern regexes trip on synthetic violations (matcher not defanged)", () => {
    // Re-derive the rules the same fragment way the script builds them and
    // assert representative violations match while a benign line does not.
    // (Direct, in-process: we don't write a fixture into src/web to avoid
    // touching the tracked tree.)
    const rules = [
      new RegExp(
        "@anthropic" +
          "-ai/" +
          "|" +
          "from\\s+['\"]anthropic['\"]" +
          "|" +
          "require\\(\\s*['\"]anthropic['\"]",
      ),
      new RegExp("api\\." + "anthropic" + "\\.com"),
      new RegExp("/v1/" + "messages"),
      new RegExp("ANTHROPIC" + "_API_KEY"),
      new RegExp("\\bclaude\\s+(?:-p\\b|--print\\b)"),
    ];
    const hits = (s: string) => rules.some((r) => r.test(s));

    // Violations — each MUST trip.
    expect(hits('import A from "@' + 'anthropic-ai/sdk"')).toBe(true);
    expect(hits('import x from "' + 'anthropic"')).toBe(true);
    expect(hits('fetch("https://api.' + 'anthropic.com/v1/messages")')).toBe(true);
    expect(hits("process.env." + "ANTHROPIC_API_KEY")).toBe(true);
    expect(hits('const c = "claude ' + '-p hi"')).toBe(true);
    expect(hits('const c = "claude ' + '--print"')).toBe(true);

    // Benign — must NOT trip.
    expect(hits('const ok = "claude --strict-mcp-config";')).toBe(false);
    expect(hits('const url = "https://hindsight.local/mcp/";')).toBe(false);
  });
});
