/**
 * `switchroom self-improve propose-skill` (#2670, one-tap self-improvement).
 *
 * The weekly skill-synthesis cron drafts a candidate personal skill from
 * accumulated signal, then invokes this command to SURFACE it as a one-tap
 * Telegram Approve/Dismiss card. The command:
 *
 *   1. Reads the drafted skill bundle from a JSON file (`{ "SKILL.md": ...,
 *      "scripts/foo.sh": ... }`) — passed by the synthesis turn.
 *   2. Sends a `post_skill_proposal` IPC to the gateway socket. The gateway
 *      persists the proposal (full draft) to the self-improve proposal
 *      store and posts the card. The Approve tap is handled gateway-side:
 *      it injects a `skill_proposal_apply` turn so the agent writes the
 *      stored draft through `skill_*_personal` (secret-scan runs; the agent
 *      never self-applies — the operator tap is the authorization).
 *
 * The command does NOT write the skill itself — that is the whole point of
 * "propose, don't write" (on-leash / no-self-escalation).
 */

import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { Command } from "commander";

const IPC_CONNECT_TIMEOUT_MS = 5000;

function gatewaySocketPath(): string {
  return (
    process.env.SWITCHROOM_GATEWAY_SOCKET ??
    (process.env.TELEGRAM_STATE_DIR
      ? join(process.env.TELEGRAM_STATE_DIR, "gateway.sock")
      : join(homedir(), ".claude", "channels", "telegram", "gateway.sock"))
  );
}

/** Allowed proposal-provenance values (mirrors `ProposalOrigin`). */
const ALLOWED_ORIGINS = ["skill-synthesis", "failure-synthesis"] as const;
type ProposalOrigin = (typeof ALLOWED_ORIGINS)[number];

interface ProposeOpts {
  slug: string;
  lesson: string;
  evidence?: string;
  edit?: boolean;
  draft: string;
  chat: string;
  thread?: string;
  agent?: string;
  origin?: string;
}

function fail(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

/** Send the post_skill_proposal IPC, resolving once written (fire-and-go). */
function sendProposal(payload: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ path: gatewaySocketPath() });
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error("gateway IPC connect timeout"));
    }, IPC_CONNECT_TIMEOUT_MS);
    sock.on("connect", () => {
      clearTimeout(t);
      sock.write(JSON.stringify(payload) + "\n", () => {
        // Give the gateway a tick to read, then close cleanly.
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

export function registerSelfImproveProposeSkillCommand(program: Command): void {
  const parent =
    program.commands.find((c) => c.name() === "self-improve") ??
    program.command("self-improve").description("Agent self-improvement ops");

  parent
    .command("propose-skill")
    .description(
      "Surface a drafted personal skill as a one-tap Telegram approval card",
    )
    .requiredOption("--slug <slug>", "target personal-skill slug")
    .requiredOption("--lesson <text>", "one-line lesson the skill captures")
    .option("--evidence <text>", "evidence line (e.g. 'seen across 3 sessions')", "")
    .option("--edit", "this is an edit to an existing personal skill (not new)")
    .requiredOption(
      "--draft <path>",
      "path to a JSON file mapping skill-relative paths to file contents",
    )
    .requiredOption("--chat <id>", "agent's own chat id to post the card to")
    .option("--thread <id>", "forum topic thread id")
    .option("--agent <name>", "agent name (defaults to $SWITCHROOM_AGENT_NAME)")
    .option(
      "--origin <origin>",
      `proposal provenance (${ALLOWED_ORIGINS.join(" | ")}); absent ⇒ skill-synthesis`,
    )
    .action((opts: ProposeOpts) => {
      const agent = opts.agent ?? process.env.SWITCHROOM_AGENT_NAME;
      if (!agent) fail("agent name required (--agent or $SWITCHROOM_AGENT_NAME)");

      let origin: ProposalOrigin | undefined;
      if (opts.origin != null) {
        if (!ALLOWED_ORIGINS.includes(opts.origin as ProposalOrigin)) {
          fail(
            `--origin must be one of: ${ALLOWED_ORIGINS.join(", ")} (got "${opts.origin}")`,
          );
        }
        origin = opts.origin as ProposalOrigin;
      }

      let draft: Record<string, string>;
      try {
        draft = JSON.parse(readFileSync(opts.draft, "utf-8")) as Record<string, string>;
      } catch (e) {
        fail(`failed to read/parse --draft: ${(e as Error).message}`);
      }
      if (typeof draft! !== "object" || draft === null || Array.isArray(draft)) {
        fail("--draft must be a JSON object of { path: content }");
      }
      if (typeof draft!["SKILL.md"] !== "string" || draft!["SKILL.md"].length === 0) {
        fail("--draft must contain a non-empty SKILL.md");
      }

      const payload: Record<string, unknown> = {
        type: "post_skill_proposal",
        agentName: agent,
        chatId: opts.chat,
        skillSlug: opts.slug,
        isNew: opts.edit !== true,
        lesson: opts.lesson,
        evidence: opts.evidence ?? "",
        draft,
      };
      if (origin != null) payload.origin = origin;
      if (opts.thread != null) {
        const n = Number.parseInt(opts.thread, 10);
        if (Number.isInteger(n)) payload.threadId = n;
      }

      sendProposal(payload)
        .then(() => {
          console.log(
            JSON.stringify({ ok: true, action: "propose-skill", slug: opts.slug, agent }),
          );
        })
        .catch((err: Error) => {
          fail(`propose-skill failed: ${err.message}`);
        });
    });
}
