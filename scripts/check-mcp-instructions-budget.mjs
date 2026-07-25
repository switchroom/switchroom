#!/usr/bin/env node
/**
 * Guard: no MCP server's `instructions` string may exceed the Claude Code
 * client's hard truncation limit.
 *
 * The failure this prevents (#3562): the Claude Code native binary truncates
 * MCP server instructions at a hard-coded 2048 chars —
 *
 *     if (I && I.length > LB) R = ma(I, LB) + "… [truncated]"     // LB = 2048
 *
 * — SILENTLY and MID-WORD. Nothing errors, nothing logs to the agent, the
 * server starts fine. The telegram bridge's instructions had grown to 4645
 * chars, so 56% of the text was discarded on every agent on every session,
 * including the /telegram:access prompt-injection defence — a security
 * guardrail that consequently never reached a single agent.
 *
 * There is no env override for this limit (MAX_MCP_CONFIG_BYTES and
 * MAX_MCP_OUTPUT_TOKENS are unrelated paths), so the budget cannot be raised
 * by configuration. Writing a longer string just means the tail is thrown away.
 *
 * Scope: every `new Server(...)` construction in the repo that passes an
 * `instructions` field. Today that is only telegram-plugin/bridge, but the
 * check is written to catch a future MCP server that adds one.
 *
 * Mirrors the other structural guards (check-stale-tool-descriptions, etc.)
 * wired into `npm run lint`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Imposed by the Claude Code CLIENT (minified constant `LB`), verified in
// @anthropic-ai/claude-code v2.1.219. Not ours to change.
const CLIENT_HARD_LIMIT = 2048;

const ROOTS = ["src", "telegram-plugin"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "uat"]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.ts$/.test(p) && !/\.(test|spec)\.ts$/.test(p)) out.push(p);
  }
  return out;
}

const failures = [];
const checked = [];

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const src = readFileSync(file, "utf8");
    if (!/^\s*instructions:/m.test(src)) continue;

    // Case 1: instructions is a reference to an exported constant living in a
    // dedicated module (the pattern we want). Resolve and measure it.
    const ref = src.match(/^\s*instructions:\s*([A-Z][A-Z0-9_]*)\s*,/m);
    if (ref) {
      const name = ref[1];
      // Find the module that defines it.
      let defined = null;
      for (const r2 of ROOTS) {
        for (const f2 of walk(r2)) {
          const s2 = readFileSync(f2, "utf8");
          const re = new RegExp(
            `export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\.join\\(`,
          );
          const m2 = s2.match(re);
          if (m2) {
            defined = { file: f2, body: m2[1] };
            break;
          }
        }
        if (defined) break;
      }
      if (!defined) {
        failures.push(
          `${file}: instructions references ${name}, but this guard could not ` +
            `locate its definition to measure it. Keep the constant as an ` +
            `\`export const ${name} = [ ... ].join('\\n')\` array literal so the ` +
            `budget stays checkable.`,
        );
        continue;
      }
      const len = measureJoinedArray(defined.body);
      checked.push({ file: defined.file, name, len });
      if (len > CLIENT_HARD_LIMIT) {
        failures.push(fail(defined.file, name, len));
      }
      continue;
    }

    // Case 2: an inline array literal (the pre-#3562 shape). Measure in place.
    const inline = src.match(/^\s*instructions:\s*\[([\s\S]*?)\]\.join\(/m);
    if (inline) {
      const len = measureJoinedArray(inline[1]);
      checked.push({ file, name: "<inline>", len });
      if (len > CLIENT_HARD_LIMIT) failures.push(fail(file, "<inline>", len));
      continue;
    }

    // Case 3: something we do not recognise. Fail closed rather than silently
    // letting an unmeasurable instructions string through.
    if (/^\s*instructions:\s*['"`]/m.test(src)) {
      failures.push(
        `${file}: instructions is an inline string literal this guard cannot ` +
          `measure reliably. Move it to an exported ` +
          `\`[ ... ].join('\\n')\` constant (see ` +
          `telegram-plugin/bridge/mcp-instructions.ts).`,
      );
    }
  }
}

/**
 * Measure the joined length of an array-of-string-literals source body.
 * We count the literal text of each element plus one '\n' per join seam —
 * matching `[...].join('\n')`. Comment-only lines are ignored.
 */
function measureJoinedArray(body) {
  const parts = [];
  const re = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1\s*(?:,|$)/g;
  // Strip // comments so a commented-out example string is not counted.
  const cleaned = body
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
  let m;
  while ((m = re.exec(cleaned))) {
    // Unescape the common sequences so the measured length matches runtime.
    const raw = m[2].replace(/\\(['"`\\])/g, "$1").replace(/\\n/g, "\n");
    parts.push(raw);
  }
  return parts.join("\n").length;
}

function fail(file, name, len) {
  const over = len - CLIENT_HARD_LIMIT;
  return (
    `${file}: MCP instructions ${name} is ${len} chars — ${over} over the ` +
    `${CLIENT_HARD_LIMIT}-char budget.\n` +
    `      The Claude Code CLIENT truncates MCP server instructions at ` +
    `${CLIENT_HARD_LIMIT} chars, silently and mid-word. There is no env ` +
    `override. Everything past char ${CLIENT_HARD_LIMIT} will NOT reach the ` +
    `agent.\n` +
    `      Cut ${over} chars. Prefer MOVING mechanical per-tool detail into ` +
    `that tool's \`description\` field (tool descriptions are NOT capped) ` +
    `over deleting it. Keep safety/trust rules here.`
  );
}

if (failures.length) {
  console.error("check-mcp-instructions-budget: FAIL\n");
  for (const f of failures) console.error("  - " + f + "\n");
  process.exit(1);
}

console.error(
  `check-mcp-instructions-budget: OK (${checked.length} checked) ` +
    checked.map((c) => `${c.name}=${c.len}/${CLIENT_HARD_LIMIT}`).join(" "),
);
