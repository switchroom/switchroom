#!/usr/bin/env bun
/**
 * Agent-self-sufficiency UAT runner.
 *
 * Drives a real Telegram user-account against the live agent fleet to
 * verify the four acceptance criteria from the
 * "agent-self-sufficiency" goal:
 *
 *   1. Self-management (skill_list, cron_list, audit_tail, config_get)
 *   2. Identity awareness (honest self-ID, knows its name, knows peers)
 *   3. Admin surface (non-admin refusal naming the admin agent)
 *      — admin reads (3a/3b) are covered by the hostd vitest suite
 *        rather than live fuzz, because they require a docker stub.
 *   4. The fuzzy UAT IS this runner.
 *
 * Usage:
 *
 *   bun telegram-plugin/uat/runners/agent-self-sufficiency.ts \\
 *       --agent klanker:@klanker_bot \\
 *       --agent scribe:@scribe_bot \\
 *       --agent doc:@doc_bot \\
 *       --admin-agent klanker \\
 *       --report ./uat-report.md
 *
 *   # OR — discover from env (CI-friendly):
 *   UAT_FLEET="klanker:@klanker_bot,scribe:@scribe_bot,doc:@doc_bot" \\
 *   UAT_ADMIN_AGENTS="klanker" \\
 *   bun telegram-plugin/uat/runners/agent-self-sufficiency.ts
 *
 * Auth env (same as the existing uat harness — see
 * telegram-plugin/uat/SETUP.md):
 *
 *   TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_UAT_DRIVER_SESSION
 *
 * **Why a user-account session, not bot tokens.** The acceptance-
 * criteria text mentioned `TELEGRAM_BOT_TOKEN_<agent>` env vars, but
 * Telegram's Bot API forbids bots from reading other bots' messages
 * (https://core.telegram.org/bots/faq) — a bot can send to another
 * bot's chat but can't observe the reply. The only way to drive the
 * fleet AND capture every agent's reply is an mtcute user-account
 * session, which is what the existing telegram-plugin/uat harness
 * uses. This runner inherits that machinery wholesale; the env-var
 * rename is forced by the platform, not a design choice.
 *
 * Missing creds fail loud, not silent — the goal explicitly demands
 * no silent skips on missing UAT credentials.
 */

import { writeFileSync } from "node:fs";
import { Driver, type ObservedMessage } from "../driver.js";
import { loadUatEnv } from "../load-env.js";
import { CRITERIA, type CriterionSpec } from "./paraphrases.js";
import { scoreReply, type CaseResult, type Outcome } from "./scorer.js";
import { renderMarkdown } from "./report.js";

loadUatEnv();

// ─── CLI / env parsing ─────────────────────────────────────────────────────

interface AgentTarget {
  name: string;
  botUsername: string;
  admin: boolean;
}

interface CliConfig {
  agents: AgentTarget[];
  reportPath: string;
  jsonPath: string;
  /** Per-case reply timeout, ms. Default 60s. */
  replyTimeoutMs: number;
  /** Inter-message settle, ms. Default 4s — keeps us under Telegram's
   *  global outbound rate cap and gives the agent time to finish its
   *  previous turn before the next inbound. */
  settleMs: number;
}

function parseCli(argv: readonly string[]): CliConfig {
  const agents = new Map<string, AgentTarget>();
  const adminSet = new Set<string>();
  let reportPath = process.env.UAT_REPORT ?? "./uat-agent-self-sufficiency.md";
  let jsonPath = process.env.UAT_REPORT_JSON ?? "./uat-agent-self-sufficiency.json";
  let replyTimeoutMs = Number.parseInt(process.env.UAT_REPLY_TIMEOUT_MS ?? "60000", 10);
  let settleMs = Number.parseInt(process.env.UAT_SETTLE_MS ?? "4000", 10);

  const envFleet = process.env.UAT_FLEET;
  if (envFleet) {
    for (const tok of envFleet.split(",")) {
      const [name, bot] = tok.split(":").map((s) => s.trim());
      if (name && bot) agents.set(name, { name, botUsername: bot, admin: false });
    }
  }
  const envAdmin = process.env.UAT_ADMIN_AGENTS;
  if (envAdmin) {
    for (const tok of envAdmin.split(",")) {
      const name = tok.trim();
      if (name) adminSet.add(name);
    }
  }

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (!v) fail(`${tok}: missing value`);
      return v;
    };
    switch (tok) {
      case "--agent": {
        const v = next();
        const [name, bot] = v.split(":").map((s) => s.trim());
        if (!name || !bot)
          fail(`--agent expects "<name>:@<bot-username>"; got "${v}"`);
        agents.set(name, { name, botUsername: bot, admin: false });
        break;
      }
      case "--admin-agent": {
        adminSet.add(next());
        break;
      }
      case "--report":
        reportPath = next();
        break;
      case "--json":
        jsonPath = next();
        break;
      case "--reply-timeout-ms":
        replyTimeoutMs = Number.parseInt(next(), 10);
        break;
      case "--settle-ms":
        settleMs = Number.parseInt(next(), 10);
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

  for (const name of adminSet) {
    const t = agents.get(name);
    if (t) t.admin = true;
  }

  if (agents.size === 0) {
    fail(
      "no agents to target. Pass --agent <name>:@<bot> at least once, or set UAT_FLEET env",
    );
  }
  if (agents.size < 3) {
    process.stderr.write(
      `[uat] WARNING: only ${agents.size} agent(s) targeted; goal calls for ≥3 to prove shared infra.\n`,
    );
  }

  return {
    agents: [...agents.values()],
    reportPath,
    jsonPath,
    replyTimeoutMs,
    settleMs,
  };
}

function fail(msg: string): never {
  process.stderr.write(`[uat] ${msg}\n`);
  process.exit(2);
}

function printHelp(): void {
  process.stdout.write(`agent-self-sufficiency UAT runner

Required env (or fail loud):
  TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_UAT_DRIVER_SESSION

Flags:
  --agent NAME:@BOT      Add an agent target. Repeatable.
  --admin-agent NAME     Mark NAME as admin: true (skips 3d for that agent).
  --report PATH          Markdown report path. Default ./uat-agent-self-sufficiency.md
  --json PATH            JSON sidecar with all results. Default ./uat-agent-self-sufficiency.json
  --reply-timeout-ms N   Per-case timeout. Default 60000.
  --settle-ms N          Inter-message settle. Default 4000.

Env equivalents:
  UAT_FLEET="name1:@bot1,name2:@bot2,..."
  UAT_ADMIN_AGENTS="name1,name2"
  UAT_REPORT, UAT_REPORT_JSON, UAT_REPLY_TIMEOUT_MS, UAT_SETTLE_MS
`);
}

// ─── Driver wrapper: send + observe ─────────────────────────────────────────

interface ReplyOutcome {
  reply: string;
  outcome: Outcome;
  durationMs: number;
  errorMessage?: string;
}

/**
 * Send one inbound to the agent and wait for a meaningful reply.
 *
 * We subscribe to the chat's message stream BEFORE sending so we don't
 * miss the bot's reply if it lands faster than we can start observing
 * (yes, this happens). Then:
 *
 *   1. Send the inbound.
 *   2. Consume the stream until we see the first non-empty bot message
 *      with messageId > our sent.messageId. That's the reply head.
 *   3. Continue consuming for an "edit window" (3s by default) to
 *      absorb any edits the gateway makes to its first chunk (stream-
 *      reply pattern: bot sends "thinking…" then edits with the final
 *      answer). The final post-edit text is what we score.
 *   4. Bail out with `timeout` if we never see a head.
 */
async function sendAndScore(
  driver: Driver,
  botUserId: number,
  driverUserId: number,
  spec: CriterionSpec,
  prompt: string,
  agentName: string,
  timeoutMs: number,
): Promise<ReplyOutcome> {
  const startedAt = Date.now();
  // Start observing FIRST so we don't race the bot's reply.
  const stream = driver.observeMessages(botUserId)[Symbol.asyncIterator]();

  let sentMessageId: number;
  try {
    const sent = await driver.sendText(botUserId, prompt);
    sentMessageId = sent.messageId;
  } catch (err) {
    try {
      await stream.return?.(undefined);
    } catch {
      /* ignore */
    }
    return {
      reply: "",
      outcome: "error",
      durationMs: Date.now() - startedAt,
      errorMessage: `send failed: ${(err as Error).message}`,
    };
  }

  const deadline = startedAt + timeoutMs;
  const EDIT_WINDOW_MS = 3000;
  let headSeenAt = 0;
  let replyMessageId = 0;
  let replyText = "";

  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const winSize = headSeenAt
        ? Math.max(0, EDIT_WINDOW_MS - (Date.now() - headSeenAt))
        : remaining;
      if (headSeenAt && winSize === 0) break;
      const slice = await pullOneWithTimeout(stream, Math.min(remaining, Math.max(250, winSize)));
      if (slice === "timeout") {
        if (headSeenAt) break; // edit window elapsed
        continue;
      }
      if (slice === "done") break;
      const m: ObservedMessage = slice;
      if (m.senderUserId === driverUserId) continue;
      if (m.messageId <= sentMessageId) continue;
      const t = (m.text ?? "").trim();
      if (!t) continue;
      // Either this is the head, or it's an edit/replacement of the
      // bot's reply. Track the most recent.
      replyMessageId = m.messageId;
      replyText = t;
      if (!headSeenAt) headSeenAt = Date.now();
    }
  } finally {
    try {
      await stream.return?.(undefined);
    } catch {
      /* ignore */
    }
  }

  const durationMs = Date.now() - startedAt;
  if (!replyMessageId) {
    return { reply: "", outcome: "timeout", durationMs };
  }
  const outcome = scoreReply(spec, replyText, { agentName });
  return { reply: replyText, outcome, durationMs };
}

/**
 * Race the next stream item against a timeout. Returns the item, or
 * the literal `"timeout"` / `"done"` sentinels. `done` is rare in
 * practice — the observer doesn't naturally close until we tell it to.
 */
async function pullOneWithTimeout(
  it: AsyncIterator<ObservedMessage>,
  ms: number,
): Promise<ObservedMessage | "timeout" | "done"> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve("timeout");
    }, ms);
    it.next().then(
      (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (r.done) resolve("done");
        else resolve(r.value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve("done");
      },
    );
  });
}

// ─── Main orchestration ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));

  // Hard-fail on missing UAT creds — goal: never silently skip.
  const apiId = Number.parseInt(process.env.TELEGRAM_API_ID ?? "", 10);
  if (!Number.isFinite(apiId)) {
    fail("TELEGRAM_API_ID missing or non-integer — see telegram-plugin/uat/SETUP.md");
  }
  const apiHash = process.env.TELEGRAM_API_HASH ?? "";
  if (!apiHash) fail("TELEGRAM_API_HASH missing — see SETUP.md");
  const session = process.env.TELEGRAM_UAT_DRIVER_SESSION ?? "";
  if (!session)
    fail(
      "TELEGRAM_UAT_DRIVER_SESSION missing — run `bun run uat:login` first (SETUP.md §4)",
    );

  process.stdout.write(
    `[uat] connecting to Telegram as the UAT driver account...\n`,
  );
  const driver = new Driver({ apiId, apiHash, session });
  await driver.connect();
  const driverUserId = await driver.getMyUserId();
  process.stdout.write(`[uat] driver user_id=${driverUserId}\n`);

  // Resolve every agent's bot user_id up front so a missing username
  // fails before we waste any time on the run.
  const resolved: { target: AgentTarget; botUserId: number }[] = [];
  for (const a of cli.agents) {
    try {
      const id = await driver.resolveBotUserId(a.botUsername);
      resolved.push({ target: a, botUserId: id });
      process.stdout.write(
        `[uat] resolved ${a.name} ${a.botUsername} → bot_user_id=${id}` +
          (a.admin ? " (admin)" : "") +
          "\n",
      );
    } catch (err) {
      process.stderr.write(
        `[uat] FAILED to resolve ${a.botUsername} for agent ${a.name}: ${(err as Error).message}\n`,
      );
      process.exit(3);
    }
  }

  // Run!
  const startedAt = new Date();
  const t0 = Date.now();
  const results: CaseResult[] = [];

  for (const { target, botUserId } of resolved) {
    process.stdout.write(`\n[uat] ─── agent: ${target.name} ─────────────\n`);
    for (const spec of CRITERIA) {
      // Skip 3d (non-admin refusal) on admin agents — they're legitimately
      // capable of those operations, so a "I can't" reply would be wrong.
      if (spec.id === "3d_admin_refusal" && target.admin) {
        process.stdout.write(
          `[uat]   skip ${spec.id} on ${target.name} (admin: true)\n`,
        );
        continue;
      }

      for (const para of spec.paraphrases) {
        const r = await sendAndScore(
          driver,
          botUserId,
          driverUserId,
          spec,
          para.text,
          target.name,
          cli.replyTimeoutMs,
        );
        const tag =
          r.outcome === "pass" ? "✓" : r.outcome === "fail" ? "✗" : "·";
        process.stdout.write(
          `[uat]   ${tag} ${spec.id}/${para.label} (${r.outcome}, ${r.durationMs}ms)\n`,
        );
        results.push({
          agent: target.name,
          criterion: spec.id,
          paraphrase: para,
          outcome: r.outcome,
          reply: r.reply,
          durationMs: r.durationMs,
          ...(r.errorMessage ? { errorMessage: r.errorMessage } : {}),
        });
        // Inter-message settle: keep below Telegram's user-account
        // outbound cap and let the agent finish its prior turn.
        await new Promise((res) => setTimeout(res, cli.settleMs));
      }
    }
  }

  const durationSeconds = (Date.now() - t0) / 1000;
  await driver.disconnect().catch(() => undefined);

  const md = renderMarkdown(results, {
    startedAt,
    durationSeconds,
    agents: resolved.map((r) => r.target.name),
  });
  writeFileSync(cli.reportPath, md, "utf-8");
  writeFileSync(
    cli.jsonPath,
    JSON.stringify(
      { startedAt: startedAt.toISOString(), durationSeconds, results },
      null,
      2,
    ),
    "utf-8",
  );
  process.stdout.write(`\n[uat] report → ${cli.reportPath}\n`);
  process.stdout.write(`[uat] json   → ${cli.jsonPath}\n`);

  const passes = results.filter((r) => r.outcome === "pass").length;
  process.stdout.write(
    `[uat] overall: ${passes}/${results.length} passed (${results.length > 0 ? ((passes / results.length) * 100).toFixed(1) : "0"}%)\n`,
  );

  // Exit non-zero if anything failed, so the runner is CI-actionable.
  process.exit(passes === results.length ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`[uat] FATAL: ${(err as Error).stack ?? err}\n`);
  process.exit(4);
});
