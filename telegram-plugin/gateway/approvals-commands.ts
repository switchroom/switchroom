/**
 * `/approvals` command surface (RFC B §9).
 *
 * Self-contained module that registers `/approvals list` and
 * `/approvals revoke <id>` against a grammy Bot. Wired in from
 * `gateway.ts` with one line:
 *
 *   import { registerApprovalsCommands } from './approvals-commands.js'
 *   registerApprovalsCommands(bot, { allowFromCheck })
 *
 * Out of scope for this commit: `/approvals add` (grant wizard) and
 * `/approvals stats` (RFC §9). Those are Phase 1.5 — straightforward to
 * add on top of the same client. Tracked in the migration TODO inline.
 */

import type { Bot, Context } from "grammy";
import { richMessage } from "../rich-send.js";
import {
  approvalList,
  approvalRevoke,
} from "../../src/vault/approvals/client.js";

export interface RegisterApprovalsCommandsOpts {
  /**
   * Caller-provided gate that returns true if the message sender is
   * permitted to run /approvals commands. Mirrors the existing pattern
   * used by other administrative commands (e.g. /pending) — the gateway
   * already has its `allowFrom` check; we don't duplicate the policy
   * lookup here.
   */
  isApprover: (ctx: Context) => boolean | Promise<boolean>;
}

export function registerApprovalsCommands(
  bot: Bot,
  opts: RegisterApprovalsCommandsOpts,
): void {
  bot.command("approvals", async (ctx) => {
    if (!(await opts.isApprover(ctx))) {
      await ctx.reply("Not authorized to view approvals.", { reply_markup: undefined });
      return;
    }

    const args = (ctx.match ?? "").toString().trim().split(/\s+/).filter(Boolean);
    const sub = args[0]?.toLowerCase();

    // /approvals  → list
    if (sub === undefined || sub === "list") {
      const agentFilter = sub === "list" ? args[1] : undefined;
      const decisions = await approvalList(agentFilter);
      if (decisions === null) {
        await ctx.reply("Approval kernel unreachable (vault broker not running?).");
        return;
      }
      if (decisions.length === 0) {
        await ctx.replyWithRichMessage(richMessage(
          agentFilter
            ? `No active approvals for \`${agentFilter}\`.`
            : "No active approvals.",
        ));
        return;
      }
      // Top-level summary by agent, mirroring the GitHub-style permissions UI
      // referenced in RFC §9.
      const byAgent = new Map<string, number>();
      for (const d of decisions) byAgent.set(d.agent_unit, (byAgent.get(d.agent_unit) ?? 0) + 1);
      const summary = Array.from(byAgent.entries())
        .map(([a, n]) => `• **${escapeHtml(a)}**: ${n}`)
        .join("\n");
      const detail = decisions
        .slice(0, 20)
        .map((d) => {
          const ttl =
            d.ttl_expires_at === null
              ? "always"
              : `until ${new Date(d.ttl_expires_at).toISOString().slice(0, 16).replace("T", " ")}`;
          return (
            `\`${d.id.slice(0, 8)}\` ` +
            `${escapeHtml(d.agent_unit)} → ` +
            `\`${d.scope}\` ` +
            `(${escapeHtml(d.action)}, ${ttl}) ` +
            `· /approvals revoke ${escapeHtml(d.id)}`
          );
        })
        .join("\n");
      await ctx.replyWithRichMessage(richMessage(`**Active approvals**\n\n${summary}\n\n${detail}`));
      return;
    }

    // /approvals revoke <id>
    if (sub === "revoke") {
      const id = args[1];
      if (!id) {
        await ctx.replyWithRichMessage(richMessage("Usage: `/approvals revoke <id>`"));
        return;
      }
      const actor = ctx.from?.id?.toString() ?? "unknown";
      const ok = await approvalRevoke(id, actor, "manual /approvals revoke");
      if (ok === null) {
        await ctx.reply("Approval kernel unreachable.");
        return;
      }
      await ctx.replyWithRichMessage(richMessage(
        ok ? `Revoked \`${id}\`.` : `No such active decision \`${id}\`.`,
      ));
      return;
    }

    // /approvals add and /approvals stats — TODO Phase 1.5
    await ctx.replyWithRichMessage(richMessage(
      `Unknown subcommand \`${sub}\`. ` +
      `Use \`/approvals list\` or \`/approvals revoke <id>\`. ` +
      `(\`add\` and \`stats\` are coming in a follow-up.)`,
    ));
  });
}

function escapeHtml(s: string): string {
  return s.replace(/([\\`*_~=\[\]|])/g, "\\$1");
}
