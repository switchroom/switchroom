/**
 * `switchroom hindsight-bench` — the recall latency-vs-bank-size + contention
 * benchmark harness (#4475, epic #4474 phase P1).
 *
 * Serves `reference/jobs/remember-across-sessions.md`: memory is only useful if
 * recall actually answers, and the epic's goal — "consistent latency across any
 * bank size … including when we have contention on the box" — is a claim about
 * the TAIL of a distribution over two variables. Every later phase of the epic
 * (#4476, #4477, #4478) is graded by a number this command produces, so the
 * instrument itself is the deliverable.
 *
 * WHY a host CLI verb: the config-capture and contention paths need the docker
 * socket and the hindsight container's embedded pg0 instance, neither of which
 * an agent container has. Same placement rationale as `hindsight-watch`.
 *
 * Cost: **zero model tokens.** The only outbound calls are recall HTTP requests
 * and read-only psql. Nothing here invokes `claude`, an LLM lane, or the API.
 *
 * ## Blast radius — read before running with `--contention`
 *
 * This measures the LIVE fleet. A plain sweep adds `concurrency` concurrent
 * recalls, which every agent shares the box with. `--contention` deliberately
 * degrades the box while it runs: `read` evicts the recall working set from
 * `shared_buffers`, `write` adds WAL/checkpoint pressure. Defaults are
 * conservative and every knob is a flag.
 *
 * ## Modes
 *
 *   measure     (default)                 run the sweep, write a result file
 *   --plot      <files...>                regenerate the chart, no measurement
 *   --compare   <a.json> <b.json>         AC1 reproducibility verdict
 *   --contention-compare <idle> <loaded>  AC4 contention verdict
 *
 * Exit codes: 0 ok · 1 a verdict FAILED · 2 could not run (usage/IO).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";

import { anonymiseResult, formatBankMapping } from "../hindsight-bench/anonymise.js";
import { BankSelectionError, parseConcurrency, selectBanks } from "../hindsight-bench/banks.js";
import {
  DEFAULT_CONTENTION,
  noContention,
  startContention,
  type ContentionHandle,
} from "../hindsight-bench/contention.js";
import {
  DEFAULT_CONTAINER,
  assertReadOnlyOrWritesAllowed,
  readDbState,
  readInstanceState,
  resetStats,
} from "../hindsight-bench/db.js";
import { renderPlot } from "../hindsight-bench/plot.js";
import { QUERY_SET_ID } from "../hindsight-bench/recall.js";
import {
  compareContention,
  compareRuns,
  duplicateCellKeys,
  formatContention,
  formatReproducibility,
  formatSummary,
  toCsv,
  DEFAULT_TOLERANCE,
} from "../hindsight-bench/report.js";
import { runArmSweep, runSweep } from "../hindsight-bench/run.js";
import { BENCH_SCHEMA_VERSION, type BenchConfig, type BenchResult, type ContentionProfile } from "../hindsight-bench/types.js";

const DEFAULT_API_URL = "http://127.0.0.1:18888";

interface BenchOpts {
  apiUrl: string;
  container: string;
  banks: string;
  concurrency: string;
  samples: string;
  warmup: string;
  timeoutMs: string;
  settleMs: string;
  budget: string;
  maxTokens: string;
  contention?: string | boolean;
  contentionWorkers: string;
  contentionScanPct: string;
  contentionMaxSeconds: string;
  resetStats: boolean;
  allowWrites: boolean;
  arms?: string | boolean;
  label: string;
  out?: string;
  csv?: string;
  plot?: string[];
  compare?: string[];
  contentionCompare?: string[];
  tolerance: string;
  json: boolean;
}

/**
 * Exit-code contract, which callers (CI, a cron) branch on:
 *   0 — PASS / measurement completed
 *   1 — a verdict FAILED (the measurement itself was fine)
 *   2 — usage or IO error; no verdict was reached
 *
 * Keeping "a real regression" and "you typo'd the filename" on different codes
 * is the whole point: a wrapper that treats every non-zero as a regression
 * would page on a missing file.
 */
function fail(msg: string): never {
  process.stderr.write(chalk.red(`hindsight-bench: ${msg}\n`));
  process.exit(2);
}

function readResult(path: string): BenchResult {
  let parsed: BenchResult;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as BenchResult;
  } catch (e) {
    fail(`cannot read ${path}: ${(e as Error).message}`);
  }
  if (!Array.isArray(parsed.cells) || parsed.config === undefined) {
    fail(`${path} is not a hindsight-bench result file (no cells/config)`);
  }
  if (parsed.schema !== BENCH_SCHEMA_VERSION) {
    // Loud rather than best-effort: silently comparing across schema versions
    // is how a "regression" turns out to be a field rename.
    fail(`${path} is schema v${parsed.schema}, this build reads v${BENCH_SCHEMA_VERSION}`);
  }
  const dupes = duplicateCellKeys(parsed.cells);
  if (dupes.length > 0) {
    // A verdict keyed on (bank, concurrency) would keep only the last of each
    // duplicate and still print a confident PASS/FAIL over the wrong pairing.
    fail(`${path} has duplicate cells (${dupes.join(", ")}) — cannot be graded`);
  }
  return parsed;
}

function writeOut(path: string, body: string): void {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  process.stderr.write(`${chalk.green("✓")} wrote ${abs}\n`);
}

/** `--contention` accepts a bare flag (⇒ `read`) or an explicit profile. */
function resolveProfile(v: string | boolean | undefined): ContentionProfile {
  if (v === undefined || v === false) return "off";
  if (v === true || v === "") return "read";
  if (v === "off" || v === "read" || v === "write") return v;
  fail(`--contention must be one of off|read|write (got "${String(v)}")`);
}

function intOpt(raw: string, name: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) fail(`${name} must be a non-negative integer (got "${raw}")`);
  return n;
}

export function registerHindsightBenchCommand(program: Command): void {
  program
    .command("hindsight-bench")
    .description(
      "Measure Hindsight recall latency as a function of bank size and concurrency. " +
        "Percentiles, not means. Read-only by default; --contention degrades the live box.",
    )
    .option("--api-url <url>", "Hindsight REST base", DEFAULT_API_URL)
    .option("--container <name>", "hindsight container for the psql probes", DEFAULT_CONTAINER)
    .option("--banks <spec>", "all | top:<n> | spread:<n> | comma list", "spread:5")
    .option("--concurrency <list>", "comma-separated concurrency levels", "1,4,8,16")
    .option("--samples <n>", "recorded recalls per cell", "60")
    .option("--warmup <n>", "discarded recalls per cell before recording", "8")
    .option("--timeout-ms <ms>", "per-recall timeout", "30000")
    .option("--settle-ms <ms>", "quiet period between cells", "2000")
    .option("--budget <budget>", "recall budget", "mid")
    .option("--max-tokens <n>", "recall max_tokens", "4096")
    .option(
      "--contention [profile]",
      "run the sweep under synthetic load: read (cache churn, SELECT-only) or " +
        "write (adds a WAL storm against a harness-owned scratch table; needs --allow-writes)",
    )
    .option("--contention-workers <n>", "concurrent load backends", String(DEFAULT_CONTENTION.workers))
    .option("--contention-scan-pct <pct>", "TABLESAMPLE percentage per churn scan", String(DEFAULT_CONTENTION.scanPct))
    .option(
      "--contention-max-seconds <s>",
      "absolute in-SQL deadline for every load backend (orphan guard)",
      String(DEFAULT_CONTENTION.maxSeconds),
    )
    .option("--reset-stats", "call pg_stat_reset() before the sweep (never implicit)", false)
    .option("--allow-writes", "authorise a writable database session (AC5 gate)", false)
    .option("--arms [n]", "additionally run a traced per-arm attribution pass (n samples/bank, default 5)")
    .option("--label <text>", "free-form label recorded in the result file", "")
    .option("--out <path>", "write the JSON result file (or the SVG in --plot mode)")
    .option("--csv <path>", "also write a flat per-cell CSV")
    .option("--plot <files...>", "render the chart from result files instead of measuring")
    // Variadic, not `<a> <b>`: commander binds exactly ONE value to a
    // non-variadic option, so `--compare a.json b.json` parsed b.json as a
    // positional and died with "too many arguments". Verified against the
    // built CLI, not assumed.
    .option("--compare <files...>", "AC1 reproducibility verdict over two result files")
    .option("--contention-compare <files...>", "AC4 contention verdict over two result files")
    .option("--tolerance <fraction>", "AC1 tolerance", String(DEFAULT_TOLERANCE))
    .option("--json", "emit machine-readable JSON for the verdict modes", false)
    .action(async (opts: BenchOpts) => {
      if (opts.plot !== undefined) return runPlotMode(opts);
      if (opts.compare !== undefined) return runCompareMode(opts);
      if (opts.contentionCompare !== undefined) return runContentionCompareMode(opts);
      await runMeasureMode(opts);
    });
}

/** Both verdict modes take exactly two result files; anything else is a typo. */
function expectTwo(files: string[], flag: string): [string, string] {
  if (files.length !== 2) fail(`${flag} takes exactly two result files (got ${files.length})`);
  return [files[0] as string, files[1] as string];
}

function runPlotMode(opts: BenchOpts): void {
  const results = (opts.plot as string[]).map(readResult);
  const svg = renderPlot(results);
  if (opts.out === undefined) {
    process.stdout.write(svg + "\n");
    return;
  }
  writeOut(opts.out, svg + "\n");
}

function runCompareMode(opts: BenchOpts): void {
  const [pa, pb] = expectTwo(opts.compare as string[], "--compare");
  const tolerance = Number(opts.tolerance);
  // An unparseable tolerance would make every `relDelta <= NaN` false and
  // report a universal FAIL that looks like a real regression.
  if (!Number.isFinite(tolerance) || tolerance < 0) fail(`--tolerance must be a non-negative number`);
  const rep = compareRuns(readResult(pa), readResult(pb), tolerance);
  process.stdout.write((opts.json ? JSON.stringify(rep, null, 2) : formatReproducibility(rep)) + "\n");
  if (!rep.pass) process.exitCode = 1;
}

function runContentionCompareMode(opts: BenchOpts): void {
  const [pi, pl] = expectTwo(opts.contentionCompare as string[], "--contention-compare");
  const rep = compareContention(readResult(pi), readResult(pl));
  process.stdout.write((opts.json ? JSON.stringify(rep, null, 2) : formatContention(rep)) + "\n");
  if (!rep.pass) process.exitCode = 1;
}

async function runMeasureMode(opts: BenchOpts): Promise<void> {
  const profile = resolveProfile(opts.contention);
  const container = opts.container;
  const sqlOpts = { container };

  if (profile === "write" && !opts.allowWrites) {
    fail("--contention write opens a writable session for its scratch table; pass --allow-writes to authorise it");
  }

  // AC5, before anything else runs. A harness that discovers it could have
  // written only after the sweep is not a gate.
  try {
    assertReadOnlyOrWritesAllowed(opts.allowWrites, sqlOpts);
  } catch (e) {
    fail((e as Error).message);
  }

  let db;
  try {
    db = readDbState(sqlOpts);
  } catch (e) {
    fail(`could not read database state: ${(e as Error).message}`);
  }
  const instance = readInstanceState(sqlOpts);

  let banks: string[];
  let concurrency: number[];
  try {
    banks = selectBanks(db.bankRows, opts.banks);
    concurrency = parseConcurrency(opts.concurrency);
  } catch (e) {
    if (e instanceof BankSelectionError) fail(e.message);
    throw e;
  }

  if (opts.resetStats) {
    try {
      resetStats(sqlOpts);
      process.stderr.write(`${chalk.yellow("!")} pg_stat_reset() called — cumulative statistics were discarded\n`);
    } catch (e) {
      fail(`--reset-stats failed: ${(e as Error).message}`);
    }
  }

  const config: BenchConfig = {
    startedAt: new Date().toISOString(),
    apiUrl: opts.apiUrl,
    container,
    banks,
    concurrency,
    samples: intOpt(opts.samples, "--samples"),
    warmup: intOpt(opts.warmup, "--warmup"),
    timeoutMs: intOpt(opts.timeoutMs, "--timeout-ms"),
    contention: profile,
    contentionWorkers: profile === "off" ? 0 : intOpt(opts.contentionWorkers, "--contention-workers"),
    statsReset: opts.resetStats,
    allowWrites: opts.allowWrites,
    querySet: QUERY_SET_ID,
    budget: opts.budget,
    maxTokens: intOpt(opts.maxTokens, "--max-tokens"),
    label: opts.label,
  };

  const armSamples = opts.arms === undefined ? 0 : opts.arms === true || opts.arms === "" ? 5 : Number(opts.arms);
  if (!Number.isFinite(armSamples) || armSamples < 0) fail(`--arms must be a non-negative integer`);

  process.stderr.write(
    `sweeping ${banks.length} bank(s) × ${concurrency.length} concurrency level(s) = ` +
      `${banks.length * concurrency.length} cells, ${config.samples} samples each ` +
      `(+${config.warmup} warm-up) · contention=${profile}\n`,
  );

  const t0 = Date.now();
  let load: ContentionHandle = noContention();
  let result: BenchResult;
  try {
    if (profile !== "off") {
      load = await startContention({
        profile,
        workers: config.contentionWorkers,
        scanPct: Number(opts.contentionScanPct),
        maxSeconds: intOpt(opts.contentionMaxSeconds, "--contention-max-seconds"),
        container,
      });
      process.stderr.write(
        `${chalk.yellow("!")} contention "${profile}" running: ${load.liveBackends} of ` +
          `${load.workers} worker(s) confirmed attached to PostgreSQL — ` +
          "the live fleet is degraded until this finishes\n",
      );
      // Ctrl-C does not run a `finally`, and an abandoned churn loop keeps
      // hammering production until its in-SQL deadline. Wire the signals
      // explicitly so an interrupted run cleans up like a completed one.
      const onSignal = (): void => {
        load.stop();
        process.exit(130);
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      // Let the load reach steady state before the first cell is recorded,
      // otherwise cell 1 measures a half-warm box and the sweep's own ordering
      // becomes a confound.
      await new Promise((r) => setTimeout(r, 5000));
    }

    const cells = await runSweep({
      config,
      db,
      settleMs: intOpt(opts.settleMs, "--settle-ms"),
      deps: { log: (m) => process.stderr.write(`${m}\n`) },
    });
    const arms =
      armSamples > 0
        ? await runArmSweep({ config, samples: armSamples, deps: { log: (m) => process.stderr.write(`${m}\n`) } })
        : null;
    result = {
      schema: BENCH_SCHEMA_VERSION,
      config,
      db,
      instance,
      cells,
      arms,
      durationS: (Date.now() - t0) / 1000,
    };
  } finally {
    load.stop();
  }

  // The terminal summary keeps REAL bank names — it is the operator's own
  // screen, not a file, and it is what makes the run readable while it happens.
  process.stdout.write(formatSummary(result) + "\n");

  // Everything that reaches DISK is anonymised first (#4499). Result files are
  // committed to a public repo as regression baselines, and a real bank id in
  // one publishes the operator's private fleet roster. This is the only write
  // path for a `BenchResult`, so the guarantee holds without anyone
  // remembering to ask for it.
  const { result: safeResult, mapping } = anonymiseResult(result);
  if (opts.out !== undefined || opts.csv !== undefined) {
    process.stderr.write(
      `${chalk.cyan("i")} bank names are pseudonymised in the written file(s); this mapping is NOT persisted:\n` +
        `${formatBankMapping(mapping)}\n`,
    );
  }
  if (opts.out !== undefined) writeOut(opts.out, JSON.stringify(safeResult, null, 2) + "\n");
  if (opts.csv !== undefined) writeOut(opts.csv, toCsv(safeResult) + "\n");
  if (opts.out === undefined && opts.csv === undefined) {
    process.stderr.write(
      chalk.yellow("! no --out given — this run's samples were not persisted and cannot be diffed later\n"),
    );
  }
}
