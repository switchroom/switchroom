/**
 * `switchroom self-improve add-eval-case` / `apply-eval-case`
 * (RFC amendment §"corrections as eval cases").
 *
 * TWO commands, two halves of the sanctioned sink — the ONLY way an eval
 * case is allowed to land (the always-on skill-validate hook hard-blocks a
 * raw model Write/Edit to evals/evals.json):
 *
 *   add-eval-case   — PROPOSE-ONLY. Validates + dedups + PII/secret-scans a
 *     case, then sends a `post_eval_case_proposal` IPC to the gateway, which
 *     persists it and posts a one-tap Telegram card. Writes NOTHING to the
 *     skill (on-leash / no-self-escalation). This is what the forked review
 *     turn calls when a correction should become a regression test.
 *
 *   apply-eval-case — the DETERMINISTIC applier the GATEWAY runs (via
 *     execFileSync) when the operator taps Approve. It re-reads the stored
 *     proposal, re-runs the PII/secret scan FAIL-CLOSED (invariant I4:
 *     scanned at propose AND at approved-apply), appends the case byte-exact
 *     (no model turn — the case lands exactly as approved), then records the
 *     new evals.json as the sanctioned integrity baseline so the Stop-hook
 *     sweep doesn't mistake the applier's own write for drift.
 *
 * HONESTY (MJ2): the applier's `status === "approved"` check is
 * DEFENSE-IN-DEPTH, not an authorization boundary — the proposal record
 * lives in the agent-writable state dir. The real authorization is the
 * operator's tap: only the gateway callback sets `approved` and only it
 * invokes this applier.
 */

import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { Command } from "commander";

import { ownsSkill } from "../self-improve/apply-guard.js";
import {
  parseEvalCase,
  caseFingerprint,
  readEvalsDoc,
  appendEvalCase,
  appendHeldOutCase,
  recordEvalBaseline,
  type EvalCase,
} from "../self-improve/eval-cases.js";
import { scanForPII, summarizeFindings } from "../self-improve/pii-scan.js";
import {
  getEvalCaseProposal,
  type EvalCaseProposal,
} from "../self-improve/eval-case-proposals.js";

const IPC_CONNECT_TIMEOUT_MS = 5000;

function stateDir(): string {
  return (
    process.env.TELEGRAM_STATE_DIR ??
    join(homedir(), ".claude", "channels", "telegram")
  );
}

function gatewaySocketPath(): string {
  return (
    process.env.SWITCHROOM_GATEWAY_SOCKET ??
    join(stateDir(), "gateway.sock")
  );
}

function skillDirFor(slug: string): string {
  return join(homedir(), ".claude", "skills", slug);
}

function fail(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

/** The textual content of a case that must be PII/secret-clean. */
function caseText(ec: EvalCase): string {
  return [ec.prompt, ec.expected_output ?? "", ...(ec.expectations ?? []), ec.source ?? ""]
    .filter(Boolean)
    .join("\n");
}

/** Send an IPC payload, resolving once written (fire-and-go). */
function sendIpc(payload: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ path: gatewaySocketPath() });
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error("gateway IPC connect timeout"));
    }, IPC_CONNECT_TIMEOUT_MS);
    sock.on("connect", () => {
      clearTimeout(t);
      sock.write(JSON.stringify(payload) + "\n", () => {
        sock.end();
        resolve();
      });
    });
    sock.on("error", (err) => {
      clearTimeout(t);
      reject(new Error(`gateway IPC error: ${err.message}`));
    });
  });
}

interface AddOpts {
  skill: string;
  prompt?: string;
  case?: string;
  expectation?: string[];
  expectedOutput?: string;
  source?: string;
  heldOut?: boolean;
  chat: string;
  thread?: string;
  agent?: string;
}

function buildCaseFromOpts(opts: AddOpts): EvalCase {
  let raw: unknown;
  if (opts.case) {
    try {
      raw = JSON.parse(readFileSync(opts.case, "utf-8"));
    } catch (e) {
      fail(`failed to read/parse --case: ${(e as Error).message}`);
    }
  } else if (opts.prompt) {
    raw = {
      prompt: opts.prompt,
      ...(opts.expectedOutput ? { expected_output: opts.expectedOutput } : {}),
      ...(opts.expectation && opts.expectation.length > 0
        ? { expectations: opts.expectation }
        : {}),
      ...(opts.source ? { source: opts.source } : {}),
    };
  } else {
    fail("provide the case with --prompt <text> or --case <path-to-json>");
  }
  const parsed = parseEvalCase(raw);
  if (!parsed.ok) fail(`invalid eval case: ${parsed.error}`);
  return parsed.case;
}

function registerAdd(parent: Command): void {
  parent
    .command("add-eval-case")
    .description(
      "Propose an eval case for a skill as a one-tap Telegram approval card",
    )
    .requiredOption("--skill <slug>", "target skill slug (a skill you own)")
    .option("--prompt <text>", "the correction, framed as a test prompt")
    .option("--case <path>", "path to a JSON eval-case object (alternative to --prompt)")
    .option(
      "--expectation <text>",
      "an assertion the grader should check (repeatable)",
      (v: string, acc: string[]) => {
        acc.push(v);
        return acc;
      },
      [] as string[],
    )
    .option("--expected-output <text>", "optional reference/expected output")
    .option("--source <text>", "provenance note (e.g. which correction)")
    .option("--held-out", "route to the held-out sink (not evals.json)")
    .requiredOption("--chat <id>", "agent's own chat id to post the card to")
    .option("--thread <id>", "forum topic thread id")
    .option("--agent <name>", "agent name (defaults to $SWITCHROOM_AGENT_NAME)")
    .action((opts: AddOpts) => {
      const agent = opts.agent ?? process.env.SWITCHROOM_AGENT_NAME;
      if (!agent) fail("agent name required (--agent or $SWITCHROOM_AGENT_NAME)");

      const dir = skillDirFor(opts.skill);
      if (!ownsSkill(dir)) {
        fail(
          `skill "${opts.skill}" is not an owned skill dir at ${dir} ` +
            `(missing, or a shared/bundled symlink) — can't add an eval case to it`,
        );
      }

      const ec = buildCaseFromOpts(opts);
      const fp = caseFingerprint(ec.prompt);

      // Dedup against the skill's existing evals (idempotent sink).
      const doc = readEvalsDoc(dir);
      if (
        doc &&
        doc.evals.some(
          (e) => typeof e?.prompt === "string" && caseFingerprint(e.prompt) === fp,
        )
      ) {
        fail(`this correction is already an eval case for "${opts.skill}" (no-op)`);
      }

      // PII/secret scan — FAIL-CLOSED at propose time (invariant I4).
      const scan = scanForPII(caseText(ec));
      if (!scan.ok) {
        fail(
          `eval case rejected — PII/secret scan found: ${summarizeFindings(scan.findings)}. ` +
            `Redact the correction before proposing it as a test case.`,
        );
      }

      const payload: Record<string, unknown> = {
        type: "post_eval_case_proposal",
        agentName: agent,
        chatId: opts.chat,
        skillSlug: opts.skill,
        skillDir: dir,
        case: ec,
        fingerprint: fp,
        heldOut: opts.heldOut === true,
      };
      if (opts.thread != null) {
        const n = Number.parseInt(opts.thread, 10);
        if (Number.isInteger(n)) payload.threadId = n;
      }

      sendIpc(payload)
        .then(() => {
          console.log(
            JSON.stringify({
              ok: true,
              action: "add-eval-case",
              skill: opts.skill,
              fingerprint: fp,
              held_out: opts.heldOut === true,
              agent,
            }),
          );
        })
        .catch((err: Error) => fail(`add-eval-case failed: ${err.message}`));
    });
}

interface ApplyOpts {
  id: string;
}

function registerApply(parent: Command): void {
  parent
    .command("apply-eval-case")
    .description(
      "Deterministically apply an operator-approved eval-case proposal " +
        "(invoked by the gateway on Approve; not for manual use)",
    )
    .requiredOption("--id <proposalId>", "the approved proposal id")
    .action((opts: ApplyOpts) => {
      const sd = stateDir();
      const proposal: EvalCaseProposal | undefined = getEvalCaseProposal(sd, opts.id);
      if (!proposal) fail(`no eval-case proposal ${opts.id} in ${sd}`);

      // DEFENSE-IN-DEPTH (MJ2), not an authorization boundary: the store is
      // agent-writable. The real authorization is the operator's tap — only
      // the gateway callback sets `approved` and only it invokes this applier.
      if (proposal.status !== "approved") {
        fail(
          `proposal ${opts.id} is "${proposal.status}", not "approved" — refusing to apply`,
        );
      }

      const ec = proposal.case;
      // Re-scan FAIL-CLOSED at apply time (invariant I4: propose AND apply).
      const scan = scanForPII(caseText(ec));
      if (!scan.ok) {
        fail(
          `apply refused — PII/secret scan found: ${summarizeFindings(scan.findings)}`,
        );
      }

      if (proposal.held_out) {
        appendHeldOutCase(sd, proposal.skill_slug, ec);
        console.log(
          JSON.stringify({
            ok: true,
            action: "apply-eval-case",
            applied: true,
            held_out: true,
            skill: proposal.skill_slug,
          }),
        );
        process.exit(0);
      }

      const dir = proposal.skill_dir;
      if (!existsSync(dir)) fail(`skill dir gone: ${dir}`);

      const res = appendEvalCase(dir, proposal.skill_slug, ec);
      if (!res.ok) {
        if (res.duplicate) {
          // Idempotent: already present. Not an error.
          console.log(
            JSON.stringify({
              ok: true,
              action: "apply-eval-case",
              applied: false,
              reason: "duplicate",
              skill: proposal.skill_slug,
            }),
          );
          process.exit(0);
        }
        fail(`append failed: ${res.reason}`);
      }

      // Record the new evals.json as the sanctioned integrity baseline, so the
      // Stop-hook sweep does NOT read the applier's own write as out-of-band
      // drift and revert it. This is what keeps the applier the single writer.
      recordEvalBaseline(sd, proposal.skill_slug, dir);

      console.log(
        JSON.stringify({
          ok: true,
          action: "apply-eval-case",
          applied: true,
          skill: proposal.skill_slug,
          case_id: res.ok ? res.case.id : undefined,
          total: res.ok ? res.total : undefined,
        }),
      );
    });
}

export function registerSelfImproveEvalCaseCommands(program: Command): void {
  const parent =
    program.commands.find((c) => c.name() === "self-improve") ??
    program.command("self-improve").description("Agent self-improvement ops");
  registerAdd(parent);
  registerApply(parent);
}
