#!/usr/bin/env bun
/**
 * M3 directive-flip UAT — Tier-2 behavioural probe runner.
 *
 * The model-in-the-loop half of the flip gate: drives a real Telegram
 * user-account (the same mtcute `Driver` the rest of `uat/` uses) against a
 * TARGET agent and, per probe, verifies the agent still HONOURS its migrated
 * guardrails in live conversation. Deterministic scoring only — every reply is
 * regex-matched against the probe's `passPattern` (see `probe-scoring.ts`); NO
 * LLM judge.
 *
 * Per probe: DM the benign prompt → `expectMessage` for the agent's answer →
 * score → repeat k times with ≥`spacingMs` between sends (default 30s, which
 * dominates the gateway's coalescing gap and keeps us under the user-account
 * flood cap). Folds k attempts into GREEN (3/3) / AMBER (2/3) / RED (≤1/3), and
 * writes one `flip/results/<agent>.<phase>.json` conforming to
 * `Tier2ProbeResults`. A separate baseline + postflip run produce two files a
 * caller diffs with `detectRegressions` (postflip rate < baseline rate).
 *
 * SAFETY: this runner only ever SENDS benign questions. It never flips an
 * agent, never edits config, and the probe suites are authored to contain no
 * actionable instruction with tool side-effects. Point it only at internal
 * test agents.
 *
 * Targeting mirrors `runners/agent-self-sufficiency.ts`: `--agent name:@bot`
 * (repeatable) or `UAT_FLEET="name:@bot,..."`. Auth env (via repo-root `.env`,
 * loaded by `loadUatEnv`): TELEGRAM_API_ID, TELEGRAM_API_HASH,
 * TELEGRAM_UAT_DRIVER_SESSION.
 *
 * Usage:
 *   bun telegram-plugin/uat/flip/tier2-probe-runner.ts \
 *       --agent test-harness:@meken_switchroom_test_bot \
 *       --phase baseline
 *
 *   # smoke: one benign probe, single repeat
 *   bun telegram-plugin/uat/flip/tier2-probe-runner.ts \
 *       --agent test-harness:@meken_switchroom_test_bot --phase baseline --k 1 --smoke
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Driver, type ObservedMessage } from "../driver.js";
import { loadUatEnv } from "../load-env.js";
import { expectMessage, isAnswer } from "../assertions.js";
import { loadProbeSuite, type ProbeSpec, type ProbeSuite } from "./probe-suite.js";
import {
  foldPhase,
  foldProbe,
  scoreAttempt,
} from "./probe-scoring.js";
import type { Tier2ProbeAttempt, Tier2ProbeOutcome, Tier2ProbeResults, ProbePhase } from "./gate.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ─── CLI / env parsing ──────────────────────────────────────────────────────

interface AgentTarget {
  name: string;
  botUsername: string;
}

interface CliConfig {
  agents: AgentTarget[];
  phase: ProbePhase;
  /** Repeats per probe. Default 3. */
  k: number;
  /** Minimum gap between sends of the same probe, ms. Default 30_000. */
  spacingMs: number;
  /** Per-reply observation deadline, ms. Default 120_000. */
  replyTimeoutMs: number;
  /** Output directory for `<agent>.<phase>.json`. Default `<flip>/results`. */
  outDir: string;
  /** Explicit suite path override (single-agent runs). */
  suitePath?: string;
  /** Smoke mode: run only the FIRST probe of the suite, k forced to its value
   *  (typically 1). Proves transport without a full behavioural sweep. */
  smoke: boolean;
}

function fail(msg: string): never {
  process.stderr.write(`[tier2] ${msg}\n`);
  process.exit(2);
}

function parseCli(argv: readonly string[]): CliConfig {
  const agents = new Map<string, AgentTarget>();
  let phase: ProbePhase = (process.env.UAT_FLIP_PHASE as ProbePhase) || "baseline";
  let k = Number.parseInt(process.env.UAT_PROBE_K ?? "3", 10);
  let spacingMs = Number.parseInt(process.env.UAT_PROBE_SPACING_MS ?? "30000", 10);
  let replyTimeoutMs = Number.parseInt(process.env.UAT_PROBE_TIMEOUT_MS ?? "120000", 10);
  let outDir = process.env.UAT_PROBE_OUT_DIR ?? path.join(HERE, "results");
  let suitePath: string | undefined;
  let smoke = false;

  const envFleet = process.env.UAT_FLEET;
  if (envFleet) {
    for (const tok of envFleet.split(",")) {
      const [name, bot] = tok.split(":").map((s) => s.trim());
      if (name && bot) agents.set(name, { name, botUsername: bot });
    }
  }

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) fail(`${tok}: missing value`);
      return v;
    };
    switch (tok) {
      case "--agent": {
        const v = next();
        const [name, bot] = v.split(":").map((s) => s.trim());
        if (!name || !bot) fail(`--agent expects "<name>:@<bot-username>"; got "${v}"`);
        agents.set(name, { name, botUsername: bot });
        break;
      }
      case "--phase": {
        const v = next();
        if (v !== "baseline" && v !== "postflip") fail(`--phase must be baseline|postflip; got "${v}"`);
        phase = v;
        break;
      }
      case "--k":
        k = Number.parseInt(next(), 10);
        break;
      case "--spacing-ms":
        spacingMs = Number.parseInt(next(), 10);
        break;
      case "--reply-timeout-ms":
        replyTimeoutMs = Number.parseInt(next(), 10);
        break;
      case "--out-dir":
        outDir = next();
        break;
      case "--suite":
        suitePath = next();
        break;
      case "--smoke":
        smoke = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        if (tok.startsWith("--")) fail(`unknown flag: ${tok}`);
    }
  }

  if (agents.size === 0) {
    fail('no agent targeted. Pass --agent <name>:@<bot> or set UAT_FLEET. Tier-2 probes only ever target internal TEST agents.');
  }
  if (!Number.isFinite(k) || k < 1) fail(`--k must be a positive integer; got ${k}`);
  if (suitePath && agents.size > 1) {
    fail("--suite is a single-agent override; pass exactly one --agent with it");
  }

  return {
    agents: [...agents.values()],
    phase,
    k,
    spacingMs,
    replyTimeoutMs,
    outDir,
    ...(suitePath ? { suitePath } : {}),
    smoke,
  };
}

function printHelp(): void {
  process.stdout.write(`M3 directive-flip Tier-2 behavioural probe runner

Required env (or fail loud):
  TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_UAT_DRIVER_SESSION

Flags:
  --agent NAME:@BOT      Target agent. Repeatable. (INTERNAL TEST AGENTS ONLY.)
  --phase baseline|postflip   Which flip phase this run records. Default baseline.
  --k N                  Repeats per probe. Default 3.
  --spacing-ms N         Min gap between sends of a probe. Default 30000.
  --reply-timeout-ms N   Per-reply deadline. Default 120000.
  --out-dir DIR          Results dir. Default <flip>/results.
  --suite PATH           Suite override (single --agent). Default probes/<agent>.probes.json.
  --smoke                Run only the first probe (transport check).

Env equivalents: UAT_FLEET, UAT_FLIP_PHASE, UAT_PROBE_K, UAT_PROBE_SPACING_MS,
  UAT_PROBE_TIMEOUT_MS, UAT_PROBE_OUT_DIR
`);
}

// ─── Live probe execution ─────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * Send one probe prompt and wait for the agent's answer. Uses the prescribed
 * seam: `sendText` then `expectMessage(driver, botId, matcher, {timeout})`,
 * where the matcher is `isAnswer` so worker-feed / activity-card surfaces and
 * the driver's own echo are excluded. Returns a scored {@link Tier2ProbeAttempt}.
 */
async function runOneAttempt(
  driver: Driver,
  botUserId: number,
  driverUserId: number,
  spec: ProbeSpec,
  timeoutMs: number,
): Promise<Tier2ProbeAttempt> {
  const startedAt = Date.now();
  try {
    await driver.sendText(botUserId, spec.prompt);
  } catch (err) {
    return scoreAttempt(spec, "", Date.now() - startedAt, "error", `send failed: ${(err as Error).message}`);
  }
  try {
    const answer: ObservedMessage = await expectMessage(
      driver,
      botUserId,
      (m) => isAnswer(m, driverUserId),
      { timeout: timeoutMs, senderFilter: { notUserId: driverUserId } },
    );
    return scoreAttempt(spec, answer.text, Date.now() - startedAt, "reply");
  } catch (err) {
    const msg = (err as Error).message;
    const kind = /within \d+ms/.test(msg) ? "timeout" : "error";
    return scoreAttempt(spec, "", Date.now() - startedAt, kind, msg);
  }
}

async function runAgent(
  driver: Driver,
  driverUserId: number,
  target: AgentTarget,
  suite: ProbeSuite,
  suiteLabel: string,
  cli: CliConfig,
): Promise<Tier2ProbeResults> {
  process.stdout.write(`\n[tier2] ─── agent: ${target.name} (${target.botUsername}) phase=${cli.phase} ───\n`);
  const botUserId = await driver.resolveBotUserId(target.botUsername);
  process.stdout.write(`[tier2] resolved ${target.botUsername} → bot_user_id=${botUserId}\n`);

  const probes = cli.smoke ? suite.probes.slice(0, 1) : suite.probes;
  if (cli.smoke) process.stdout.write(`[tier2] SMOKE mode: running only "${probes[0]?.id}"\n`);

  const outcomes: Tier2ProbeOutcome[] = [];
  for (const spec of probes) {
    const attempts: Tier2ProbeAttempt[] = [];
    for (let rep = 0; rep < cli.k; rep++) {
      const a = await runOneAttempt(driver, botUserId, driverUserId, spec, cli.replyTimeoutMs);
      attempts.push(a);
      const glyph = a.pass ? "✓" : a.outcome === "timeout" ? "·" : "✗";
      process.stdout.write(
        `[tier2]   ${glyph} ${spec.id} rep ${rep + 1}/${cli.k} (${a.outcome}, ${a.durationMs}ms)\n`,
      );
      // Space repeats of the SAME probe by ≥ spacingMs (respect coalescing +
      // flood limits). No wait after the final repeat of the final probe.
      const isLast = rep === cli.k - 1 && spec === probes[probes.length - 1];
      if (!isLast) await sleep(cli.spacingMs);
    }
    const folded = foldProbe(spec, attempts);
    process.stdout.write(`[tier2]   → ${spec.id}: ${folded.verdict} (${folded.passCount}/${folded.k})\n`);
    outcomes.push(folded);
  }

  return foldPhase(target.name, cli.phase, suiteLabel, outcomes);
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadUatEnv();
  const cli = parseCli(process.argv.slice(2));

  const apiId = Number.parseInt(process.env.TELEGRAM_API_ID ?? "", 10);
  if (!Number.isFinite(apiId)) fail("TELEGRAM_API_ID missing or non-integer — see telegram-plugin/uat/SETUP.md");
  const apiHash = process.env.TELEGRAM_API_HASH ?? "";
  if (!apiHash) fail("TELEGRAM_API_HASH missing — see SETUP.md");
  const session = process.env.TELEGRAM_UAT_DRIVER_SESSION ?? "";
  if (!session) fail("TELEGRAM_UAT_DRIVER_SESSION missing — run `bun run uat:login` first (SETUP.md §4)");

  // Resolve + validate every suite BEFORE connecting, so a bad suite fails
  // without spending a live session.
  const plans = cli.agents.map((target) => {
    const suitePath = cli.suitePath ?? path.join(HERE, "probes", `${target.name}.probes.json`);
    const suite = loadProbeSuite(suitePath);
    if (suite.agent !== target.name) {
      fail(`suite ${suitePath} declares agent "${suite.agent}" but target is "${target.name}"`);
    }
    return { target, suite, suiteLabel: path.basename(suitePath) };
  });

  process.stdout.write(`[tier2] connecting to Telegram as the UAT driver account...\n`);
  const driver = new Driver({ apiId, apiHash, session });
  await driver.connect();
  const driverUserId = await driver.getMyUserId();
  process.stdout.write(`[tier2] driver user_id=${driverUserId}\n`);

  mkdirSync(cli.outDir, { recursive: true });
  const written: string[] = [];
  try {
    for (const plan of plans) {
      const results = await runAgent(driver, driverUserId, plan.target, plan.suite, plan.suiteLabel, cli);
      const outPath = path.join(cli.outDir, `${plan.target.name}.${cli.phase}.json`);
      writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`, "utf-8");
      written.push(outPath);
      process.stdout.write(
        `[tier2] wrote ${outPath} — phase ${results.pass ? "PASS" : "FAIL"} ` +
          `(${(results.probes ?? []).filter((p) => p.verdict === "GREEN").length}/${(results.probes ?? []).length} GREEN)\n`,
      );
    }
  } finally {
    await driver.disconnect();
  }

  process.stdout.write(`\n[tier2] done. wrote ${written.length} result file(s):\n`);
  for (const w of written) process.stdout.write(`  ${w}\n`);
}

// Only run when invoked directly (not when imported by a test).
if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`[tier2] fatal: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
}
