#!/usr/bin/env node
/**
 * check-foreign-db-readonly — a FOREIGN process must never open a gateway /
 * broker SQLite database READ-WRITE.
 *
 * Root cause this gate pins (#4595 detects it after the fact; this gate stops
 * it being created):
 *
 *   The gateway holds `history.db` (bun:sqlite, WAL) open for the process
 *   lifetime. SQLite's close path checkpoints and then UNLINKS the `-wal` /
 *   `-shm` sidecars when the closing connection is the LAST connection. A
 *   foreign process that opens the same DB read-write — `sqlite3.connect(path)`
 *   in Python, `new Database(path)` in bun:sqlite, a bare `sqlite3 <db> "..."`
 *   shellout — therefore has the power to delete those sidecars out from under
 *   any handle still mapped to the old inodes. Those handles keep writing into
 *   deleted files: every INSERT reports success and every row vanishes at the
 *   next restart. Signature:
 *
 *       /proc/<pid>/fd/13 -> history.db-wal (deleted)
 *
 *   `bin/handoff-briefing.sh` did exactly this at agent boot — precisely when
 *   the gateway is down or starting and the briefing IS the last connection.
 *
 * A read-ONLY connection has no such power: it cannot checkpoint and cannot
 * unlink a sidecar. So the rule is simply: if you are not the process that
 * OWNS the database, open it read-only.
 *
 * What this gate scans
 * --------------------
 * Only the surfaces where a foreign process can reach an owned DB:
 *
 *   - `bin/**` (boot + hook shell scripts — where the incident came from)
 *   - `src/**` (the `switchroom` CLI; the gateway is not in src/)
 *   - `telegram-plugin/hooks/**` (hook processes, separate from the gateway)
 *
 * `telegram-plugin/{history,registry,gateway}` and `src/vault/**-db.ts` /
 * `kernel-server.ts` are the DB OWNERS and are deliberately out of scope: they
 * must open read-write.
 *
 * Exemption
 * ---------
 * Put `// allow-rw-db-open: <reason>` (or `# allow-rw-db-open: <reason>` in
 * shell/python) on the line preceding the open (a 5-line lookback, so the marker
 * can sit above a multi-line call). A reason is
 * required. Drift-proof: the marker moves with the code.
 *
 * Exempt only when the process genuinely OWNS the database or is a deliberate
 * writer (e.g. `switchroom vault sweep` scrubbing secrets out of history). If
 * the callsite only ever SELECTs, don't exempt it — make it read-only:
 *
 *   python   sqlite3.connect("file:" + quote(p) + "?mode=ro", uri=True)
 *   bun      new Database(p, { readonly: true })
 *   node     new DatabaseSync(p, { readOnly: true })
 *   CLI      sqlite3 -readonly <db> "SELECT ..."
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Directories a FOREIGN process's code lives in. */
const ROOTS = ["bin", "src", "telegram-plugin/hooks"];

const SCAN_EXT = new Set([".ts", ".mts", ".cts", ".mjs", ".js", ".sh", ".py"]);

/** Skipped everywhere: tests own their own throwaway fixture DBs. */
const SKIP_RE =
  /(^|\/)(node_modules|dist|coverage|__snapshots__)(\/|$)|\.test\.[cm]?[tj]s$|(^|\/)tests?(\/)/;

const RULES = [
  {
    id: "python-sqlite3-connect",
    // sqlite3.connect(<not a file:...?mode=ro URI>)
    re: /\bsqlite3\.connect\s*\(\s*(?!["'`]file:)(?!.*mode=ro)/,
    hint: 'use sqlite3.connect("file:" + quote(path) + "?mode=ro", uri=True)',
  },
  {
    id: "bun-sqlite-new-database",
    // new Database(x) / new Database(x, {...}) without readonly
    re: /\bnew\s+Database\s*\(/,
    reject: (line) => !/\breadonly\s*:\s*true\b/.test(line),
    // `:memory:` is not a file — it cannot have sidecars.
    skip: (line) => /:memory:/.test(line),
    hint: "pass { readonly: true }",
  },
  {
    id: "node-sqlite-databasesync",
    re: /\bnew\s+DatabaseSync\s*\(/,
    reject: (line) => !/\breadOnly\s*:\s*true\b/.test(line),
    skip: (line) => /:memory:/.test(line),
    hint: "pass { readOnly: true }",
  },
  {
    id: "sqlite3-cli",
    // A `sqlite3` shellout: the binary named as a quoted argv[0] (execFileSync
    // / spawn / spawnSync / docker exec …). argv is routinely spread over
    // several lines, so `-readonly` / `-version` are looked for in a window
    // AFTER the match rather than on the same line — see `window` below.
    re: /(['"`])sqlite3\1\s*[,)\]]/,
    window: 8,
    reject: (windowText) =>
      !/-readonly/.test(windowText) && !/-version/.test(windowText),
    hint: "pass -readonly",
  },
];

/** `// allow-rw-db-open: reason` or `# allow-rw-db-open: reason`. */
const MARKER_RE = /(?:\/\/|#|\*)\s*allow-rw-db-open:\s*\S/;

/** How many lines above a match are searched for the exemption marker. */
const MARKER_LOOKBACK = 5;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const rel = relative(ROOT, full);
    if (SKIP_RE.test(rel)) continue;
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (SCAN_EXT.has(name.slice(name.lastIndexOf("."))) || !name.includes("."))
      out.push(full);
  }
  return out;
}

const violations = [];

for (const root of ROOTS) {
  for (const file of walk(join(ROOT, root))) {
    const rel = relative(ROOT, file);
    let lines;
    try {
      lines = readFileSync(file, "utf8").split("\n");
    } catch {
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      // Comment-only lines: this gate's own prose names every pattern.
      if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("#")
      )
        continue;
      for (const rule of RULES) {
        if (!rule.re.test(line)) continue;
        if (rule.skip?.(line)) continue;
        // `window` rules inspect the match line plus the next N lines, so a
        // flag on a later line of a multi-line argv array still counts.
        const subject = rule.window
          ? lines.slice(i, i + 1 + rule.window).join("\n")
          : line;
        if (rule.reject && !rule.reject(subject)) continue;
        // Inline marker on one of the immediately preceding lines. A short
        // lookback (not just `i - 1`) because the open is often a multi-line
        // `execFileSync(\n  "sqlite3",\n  [...]` and the marker naturally sits
        // above the CALL, not above the argv element the regex matched.
        const back = lines.slice(Math.max(0, i - MARKER_LOOKBACK), i);
        if (back.some((l) => MARKER_RE.test(l))) continue;
        violations.push({ rel, line: i + 1, text: trimmed, rule });
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    `check-foreign-db-readonly: ${violations.length} read-write open(s) of a SQLite DB from a foreign process:`,
  );
  for (const v of violations) {
    console.error(`  ${v.rel}:${v.line}: ${v.text}`);
    console.error(`      [${v.rule.id}] ${v.rule.hint}`);
  }
  console.error("");
  console.error(
    "A read-write handle that closes as the LAST connection checkpoints and UNLINKS",
  );
  console.error(
    "the -wal/-shm sidecars, orphaning any other process's mapped fds — every",
  );
  console.error(
    "subsequent write reports success and is lost at the next restart (#4595).",
  );
  console.error("");
  console.error(
    "If the process genuinely OWNS this DB or must write, add on the PRECEDING line:",
  );
  console.error("  // allow-rw-db-open: <reason>   (or # in shell/python)");
  process.exit(1);
}

console.log(
  "check-foreign-db-readonly: clean (no foreign read-write SQLite opens)",
);
