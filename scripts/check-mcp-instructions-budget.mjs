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
 * by configuration. Writing a longer string just means the tail is discarded.
 *
 * ─── DESIGN: MEASURE THE RUNTIME VALUE, DO NOT PARSE SOURCE ────────────────
 *
 * An earlier revision of this guard parsed the source of the instructions
 * array and summed the string literals it recognised. Adversarial review broke
 * it in three ways, all the same root cause — a static parser cannot see what
 * JavaScript will actually produce:
 *
 *     instructions: MCP_INSTRUCTIONS + 'X'.repeat(9000)   // parser saw nothing
 *     instructions: buildInstructions()                   // parser saw nothing
 *     `${PAD}` inside a measured element                  // counted as 5 chars
 *
 * Worse, each of those fell through to a "no shapes matched" path that printed
 * OK and exited 0 — the guard reported success on ZERO coverage.
 *
 * So this guard no longer parses the string at all. Instead:
 *
 *   1. Every MCP server construction must pass `instructions` as a BARE
 *      IDENTIFIER (`instructions: MCP_INSTRUCTIONS,`). Any expression — a
 *      call, a concatenation, a template literal, an inline array or string —
 *      FAILS CLOSED. This is what makes step 2 sound: nothing can be bolted
 *      onto the value between the constant and the wire.
 *   2. That identifier's module is IMPORTED (in a child Node, using Node's
 *      built-in TypeScript stripping — no bundler dependency), and the real runtime
 *      `.length` is measured. Template interpolation, concatenation and
 *      computed content inside the module are therefore all counted correctly.
 *   3. Coverage is asserted: if fewer than EXPECTED_INSTRUCTION_SERVERS
 *      servers were actually measured, the guard FAILS rather than reporting
 *      a vacuous OK. Deleting the module or dropping the field is a failure,
 *      not a pass.
 *
 * Mirrors the other structural guards (check-stale-tool-descriptions, etc.)
 * wired into `npm run lint`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Imposed by the Claude Code CLIENT (minified constant `LB`), verified in
// @anthropic-ai/claude-code v2.1.219. Not ours to change: a longer string is
// not rejected, it is silently cut.
const CLIENT_HARD_LIMIT = 2048;

/**
 * How many MCP servers in this repo are expected to declare `instructions`.
 * Today: telegram-plugin/bridge only. If a server legitimately gains or drops
 * an instructions field, update this deliberately — the point is that a
 * SILENT drop to zero coverage can never masquerade as a pass.
 */
const EXPECTED_INSTRUCTION_SERVERS = 1;

/**
 * Hard cap on a single measurement subprocess. Importing a module runs its
 * top-level side effects; without a bound, one live timer or transport connect
 * hangs `npm run lint` until the CI job timeout with no diagnostic.
 */
const MEASURE_TIMEOUT_MS = 30_000;

/**
 * Node's built-in TypeScript stripping landed in 22.6 (behind
 * --experimental-strip-types) and became the default in 23.6. Used only to
 * produce an actionable message on older runtimes, where importing a .ts file
 * fails with an opaque ERR_UNKNOWN_FILE_EXTENSION.
 */
const MIN_NODE_FOR_TYPE_STRIPPING = "22.6.0";

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
    let st;
    // NIT (review): statSync must be inside the try — a broken symlink in the
    // tree would otherwise crash lint with an unhelpful ENOENT stack.
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (/\.ts$/.test(p) && !/\.(test|spec)\.ts$/.test(p)) out.push(p);
  }
  return out;
}

const ALL_FILES = ROOTS.flatMap((r) => walk(r));
const failures = [];
const checked = [];

/**
 * Import a .ts module in a child Node and report the real runtime facts we
 * need: the type and `.length` of the named export, plus the module's authored
 * budget.
 *
 * Deliberately uses Node's BUILT-IN TypeScript stripping rather than a bundler.
 * An earlier revision called `esbuild`, which is present locally only as a
 * hoisted transitive dependency of vitest — it is not declared in package.json,
 * so `npm run lint` failed in CI with "Cannot find package 'esbuild'". Lint
 * must not depend on an undeclared package. (It failed CLOSED, which is the
 * correct direction, but it still blocked the build.)
 *
 * Node >= 22.6 exposes this behind --experimental-strip-types; from Node 23.6
 * it is on by default and the flag may be unrecognised. So: try with the flag,
 * and on a flag-related startup failure retry without it.
 */
function measureModule(file, name) {
  const url = pathToFileURL(resolve(file)).href;
  const child =
    `const m = await import(${JSON.stringify(url)});\n` +
    `const v = m[${JSON.stringify(name)}];\n` +
    `process.stdout.write(JSON.stringify({\n` +
    `  type: typeof v,\n` +
    `  len: typeof v === "string" ? v.length : null,\n` +
    `  budget: m.MCP_INSTRUCTIONS_BUDGET ?? null,\n` +
    `}));`;

  const attempts = [
    ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", child],
    ["--no-warnings", "--input-type=module", "-e", child],
  ];

  let lastErr = "";
  for (const args of attempts) {
    // A bounded wait is mandatory: the module being imported is ordinary
    // application code, and importing it RUNS its top-level side effects. If
    // MCP_INSTRUCTIONS is ever moved back into bridge.ts, importing that file
    // installs the plugin logger and connects the stdio transport, and an
    // unbounded spawnSync would hang `npm run lint` until the CI job timeout
    // with no diagnostic at all. Same for any module holding a live timer.
    const r = spawnSync(process.execPath, args, {
      encoding: "utf8",
      timeout: MEASURE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });

    if (r.status === 0 && r.stdout) {
      try {
        return JSON.parse(r.stdout);
      } catch {
        lastErr = `unparseable measurement output: ${r.stdout.slice(0, 400)}`;
        continue;
      }
    }

    if (r.error?.code === "ETIMEDOUT" || r.signal === "SIGKILL") {
      throw new Error(
        `timed out after ${MEASURE_TIMEOUT_MS}ms importing ${file} (killed with ` +
          `SIGKILL).\n` +
          `      Importing that module did not terminate, so its \`${name}\` ` +
          `could not be measured.\n` +
          `      This usually means the module has top-level side effects that ` +
          `keep the event loop alive — a server/transport connect, a listener, ` +
          `or a setInterval. The instructions constant must live in a module ` +
          `that is INERT on import (see telegram-plugin/bridge/mcp-instructions.ts: ` +
          `constants only, no imports, no side effects).`,
      );
    }

    lastErr = (r.stderr || r.error?.message || `exit ${r.status}`).trim();

    // Node < 22.6 has no TypeScript stripping at all, so importing a .ts file
    // fails with an opaque ERR_UNKNOWN_FILE_EXTENSION. Say what is actually
    // wrong instead of making the next person decode that.
    if (/ERR_UNKNOWN_FILE_EXTENSION|Unknown file extension/.test(lastErr)) {
      throw new Error(
        `this Node (${process.version}) cannot import TypeScript directly, so ` +
          `\`${name}\` cannot be measured.\n` +
          `      This guard needs Node >= ${MIN_NODE_FOR_TYPE_STRIPPING} ` +
          `(built-in type stripping: --experimental-strip-types on 22.6-23.5, ` +
          `on by default from 23.6). CI and every docker/Dockerfile.* image in ` +
          `this repo run Node 22, so this only bites a local checkout on an ` +
          `older runtime.\n` +
          `      Upgrade Node to >= ${MIN_NODE_FOR_TYPE_STRIPPING} and re-run ` +
          `\`npm run lint\`.`,
      );
    }
  }
  throw new Error(lastErr || "unknown failure");
}

/** Every file under ROOTS that declares `export const <name>`. */
function filesExporting(name) {
  const re = new RegExp(`export\\s+const\\s+${name}\\b`);
  return ALL_FILES.filter((f) => re.test(readFileSync(f, "utf8")));
}

/**
 * The module specifier `serverSrc` actually imports `name` from, or null.
 *
 * Resolving the REAL import is what makes the measurement sound. An earlier
 * revision looked the name up across the whole repo and took the first hit
 * (ROOTS order: `src` before `telegram-plugin`), so a decoy or a stale
 * duplicate got measured instead of the module the server actually ships:
 *
 *     src/zz-decoy.ts: export const MCP_INSTRUCTIONS = 'tiny'
 *     -> OK (1 measured) MCP_INSTRUCTIONS=4/2048   // real module was 10899 chars
 *
 * Same failure shape as the round-1 hole: a confident OK while measuring the
 * wrong thing.
 */
function importSpecifierFor(serverSrc, name) {
  const re = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(serverSrc))) {
    const bound = m[1]
      .split(",")
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    if (bound.includes(name)) return m[2];
  }
  return null;
}

/** Map a relative import specifier to the .ts source file it refers to. */
function specifierToFile(serverFile, spec) {
  if (!spec.startsWith(".")) return null; // bare/package specifier — out of scope
  const base = resolve(dirname(serverFile), spec);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    `${base}.ts`,
    join(base, "index.ts"),
    base,
  ];
  for (const p of candidates) {
    try {
      // Report repo-relative paths so messages match the other lint guards.
      if (statSync(p).isFile()) return relative(process.cwd(), p) || p;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

function fail(file, name, len, budget) {
  const over = len - budget;
  return (
    `${file}: MCP instructions ${name} is ${len} chars — ${over} over the ` +
    `${budget}-char authored budget (client hard limit ${CLIENT_HARD_LIMIT}).\n` +
    `      The Claude Code CLIENT truncates MCP server instructions at ` +
    `${CLIENT_HARD_LIMIT} chars, silently and mid-word. There is no env ` +
    `override. Everything past char ${CLIENT_HARD_LIMIT} will NOT reach the ` +
    `agent.\n` +
    `      Cut ${over} chars. Prefer MOVING mechanical per-tool detail into ` +
    `that tool's \`description\` field (tool descriptions are NOT capped) ` +
    `over deleting it. Keep safety/trust rules here.`
  );
}

for (const file of ALL_FILES) {
  const src = readFileSync(file, "utf8");
  // Only MCP server constructions are in scope.
  if (!/new Server\(/.test(src)) continue;

  const m = src.match(/^[ \t]*instructions:[ \t]*(.*)$/m);
  if (!m) continue; // server declares no instructions — nothing to measure

  const rawValue = m[1].replace(/,\s*$/, "").trim();

  // ── Step 1: fail closed unless the value is a bare identifier. ───────────
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(rawValue)) {
    failures.push(
      `${file}: \`instructions\` must be a BARE IDENTIFIER referring to an ` +
        `exported constant (e.g. \`instructions: MCP_INSTRUCTIONS,\`), but is:\n` +
        `        instructions: ${rawValue}\n` +
        `      An expression (concatenation, call, template literal, inline ` +
        `array/string) is rejected because this guard measures the constant's ` +
        `RUNTIME value — anything appended after that point would reach the ` +
        `client unmeasured and be silently truncated at ${CLIENT_HARD_LIMIT} chars.\n` +
        `      Move the whole string into an exported constant in its own module ` +
        `(see telegram-plugin/bridge/mcp-instructions.ts).`,
    );
    continue;
  }

  // ── Step 2: resolve the module the server ACTUALLY imports, then measure. ─
  //
  // Resolution is by import specifier, not by name lookup across the repo:
  // measuring a same-named constant from some other file would be a false pass.
  const declaresLocally = new RegExp(
    `export\\s+const\\s+${rawValue}\\b`,
  ).test(src);
  const spec = importSpecifierFor(src, rawValue);

  let exporter = null;
  if (spec) {
    exporter = specifierToFile(file, spec);
    if (!exporter) {
      failures.push(
        `${file}: \`instructions: ${rawValue}\` is imported from '${spec}', ` +
          `which does not resolve to a .ts source file under [${ROOTS.join(", ")}]. ` +
          `This guard measures the module the server actually imports and refuses ` +
          `to guess. Keep the constant in a relative .ts module (e.g. ` +
          `'./mcp-instructions.js' -> mcp-instructions.ts).`,
      );
      continue;
    }
  } else if (declaresLocally) {
    exporter = file; // declared in the server file itself
  } else {
    failures.push(
      `${file}: \`instructions: ${rawValue}\` — cannot resolve \`${rawValue}\`: ` +
        `the file neither declares \`export const ${rawValue}\` nor imports it ` +
        `by name from a relative module. This guard cannot measure what it ` +
        `cannot resolve, and refuses to pass silently.`,
    );
    continue;
  }

  // Backstop for the resolution above: an ambiguous name anywhere under ROOTS
  // is itself the bug (a stale duplicate left by a refactor, or a second MCP
  // server whose constant shares the name). Fail rather than silently rely on
  // having picked correctly.
  const duplicates = filesExporting(rawValue);
  if (duplicates.length > 1) {
    failures.push(
      `${file}: \`${rawValue}\` is exported by ${duplicates.length} files under ` +
        `[${ROOTS.join(", ")}]:\n` +
        duplicates.map((d) => `        ${d}`).join("\n") +
        `\n      An ambiguous instructions constant is rejected: whichever one ` +
        `this guard measured, a reader cannot tell which one ships, and a stale ` +
        `duplicate can hide an over-budget string behind a green lint. Delete ` +
        `the duplicate or rename it.`,
    );
    continue;
  }

  let measured;
  try {
    measured = measureModule(exporter, rawValue);
  } catch (err) {
    failures.push(
      `${file}: failed to import ${exporter} to measure \`${rawValue}\`: ` +
        `${err && err.message ? err.message : err}`,
    );
    continue;
  }

  if (measured.type !== "string") {
    failures.push(
      `${exporter}: \`${rawValue}\` must export a string (got ` +
        `${measured.type}). The MCP client receives a string; anything else ` +
        `cannot be budget-checked.`,
    );
    continue;
  }

  // The module owns its own authored budget; honour it, and require it to sit
  // under the client's hard limit.
  const budget = measured.budget;
  if (typeof budget === "number" && budget > CLIENT_HARD_LIMIT) {
    failures.push(
      `${exporter}: authored budget ${budget} exceeds the client's hard limit ` +
        `${CLIENT_HARD_LIMIT}. The budget must be <= the limit; raising it ` +
        `does not stop the client truncating.`,
    );
    continue;
  }
  const effective =
    typeof budget === "number" && budget > 0 ? budget : CLIENT_HARD_LIMIT;

  const len = measured.len;
  checked.push({ file: exporter, name: rawValue, len, budget: effective });

  if (len > effective) failures.push(fail(exporter, rawValue, len, effective));
}

// ── Step 3: coverage. A guard that measured nothing has proven nothing. ────
if (checked.length < EXPECTED_INSTRUCTION_SERVERS) {
  failures.push(
    `coverage: measured ${checked.length} MCP server instructions string(s), ` +
      `expected at least ${EXPECTED_INSTRUCTION_SERVERS}.\n` +
      `      Reporting OK here would be a FALSE PASS — the previous revision ` +
      `of this guard did exactly that and shipped an unguarded string.\n` +
      `      Either an instructions field was removed/renamed, its module was ` +
      `deleted, or the detection above no longer matches. Investigate rather ` +
      `than lowering EXPECTED_INSTRUCTION_SERVERS.`,
  );
}

if (failures.length) {
  console.error("check-mcp-instructions-budget: FAIL\n");
  for (const f of failures) console.error("  - " + f + "\n");
  process.exit(1);
}

console.error(
  `check-mcp-instructions-budget: OK (${checked.length} measured) ` +
    checked
      .map(
        (c) =>
          `${c.name}=${c.len}/${c.budget} (limit ${CLIENT_HARD_LIMIT}) [${c.file}]`,
      )
      .join(" "),
);
