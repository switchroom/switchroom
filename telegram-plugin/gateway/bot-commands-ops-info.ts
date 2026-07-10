import type { Bot, Context, InlineKeyboard } from 'grammy'
import { hostdWillBeUsed } from './hostd-dispatch.js'
import { maskVaultKey } from '../demo-mask.js'
import { switchroomHelpText as buildSwitchroomHelpText } from '../welcome-text.js'

/**
 * Read-only ops/info slash commands extracted verbatim from gateway.ts
 * (#2996 Phase 5 leaf move): `/doctor`, `/grant`, `/dangerous`,
 * `/permissions`, `/version`, `/whoami`, `/commands`.
 *
 * These are pure info/ops surfaces (no send-path or turn-lifecycle
 * coupling). Every gateway-local helper they close over is passed in via
 * `deps` (repo factory-deps precedent) so the module never back-references
 * the gateway singleton or reads `currentTurn`. `bot` is injected so
 * grammy registration order is preserved at the original call site.
 */
export interface OpsInfoCommandDeps {
  AGENT_ADMIN: boolean
  isAuthorizedSender: (ctx: Context) => boolean
  getMyAgentName: () => string
  switchroomReply: (
    ctx: Context,
    text: string,
    options?: {
      html?: boolean
      reply_markup?: InlineKeyboard
      classification?: 'query' | 'mutation' | 'heavy'
    },
  ) => Promise<void>
  buildDoctorScopeKeyboard: () => InlineKeyboard
  renderSelfDoctor: (ctx: Context) => Promise<void>
  preBlock: (text: string) => string
  formatSwitchroomOutput: (output: string, maxLen?: number) => string
  getCommandArgs: (ctx: Context) => string
  assertSafeAgentName: (name: string) => void
  runSwitchroomCommand: (
    ctx: Context,
    args: string[],
    label: string,
    classification?: 'query' | 'mutation' | 'heavy',
  ) => Promise<void>
  switchroomExecCombined: (args: string[], timeoutMs?: number) => string
  stripAnsi: (text: string) => string
  hasDemoFlag: (args: string) => boolean
  escapeHtmlForTg: (text: string) => string
}

export function registerOpsInfoCommands(bot: Bot, deps: OpsInfoCommandDeps): void {
  const {
    AGENT_ADMIN,
    isAuthorizedSender,
    getMyAgentName,
    switchroomReply,
    buildDoctorScopeKeyboard,
    renderSelfDoctor,
    preBlock,
    formatSwitchroomOutput,
    getCommandArgs,
    assertSafeAgentName,
    runSwitchroomCommand,
    switchroomExecCombined,
    stripAnsi,
    hasDemoFlag,
    escapeHtmlForTg,
  } = deps

  /** Compact HTML card from the `config whoami` JSON view. Names/booleans only.
   *  `demo` (the `/whoami demo` suffix) masks the vault key NAMES via maskVaultKey
   *  for screen recordings — agent/MCP/model/skills topology is left untouched
   *  (out of scope). Off by default. */
  function formatWhoamiCard(v: {
    name?: string; persona?: string | null; model?: string | null; tier?: string;
    tools?: { allow?: string[]; deny?: string[] }; mcpServers?: string[]; skills?: string[];
    vault?: { key: string; readable: boolean }[];
    powers?: { admin?: boolean; root?: boolean; configEdit?: boolean; crossAgentHostVerbs?: boolean };
    scheduleCount?: number; memoryBackend?: string | null;
  }, demo = false): string {
    const esc = escapeHtmlForTg
    const yn = (b?: boolean) => (b ? '✓' : '✗')
    const lines: string[] = []
    lines.push(`👤 **${esc(v.name ?? '?')}** · ${esc(v.tier ?? 'standard')}`)
    if (v.persona) lines.push(esc(v.persona))
    if (v.model) lines.push(`Model: ${esc(v.model)}`)
    const allow = v.tools?.allow ?? []
    lines.push(`Tools: ${allow.length ? esc(allow.slice(0, 8).join(', ')) + (allow.length > 8 ? ` …(+${allow.length - 8})` : '') : '—'}`)
    if ((v.tools?.deny ?? []).length) lines.push(`Denied: ${esc((v.tools!.deny!).join(', '))}`)
    if ((v.mcpServers ?? []).length) lines.push(`MCP: ${esc(v.mcpServers!.join(', '))}`)
    if ((v.skills ?? []).length) lines.push(`Skills: ${esc(v.skills!.join(', '))}`)
    if ((v.vault ?? []).length) {
      lines.push(`Vault keys (names only): ${v.vault!.map(k => `${esc(demo ? maskVaultKey(k.key) : k.key)} ${yn(k.readable)}`).join(', ')}`)
    }
    const p = v.powers ?? {}
    lines.push(`Powers: admin ${yn(p.admin)} · root ${yn(p.root)} · config-edit ${yn(p.configEdit)} · cross-agent verbs ${yn(p.crossAgentHostVerbs)}`)
    lines.push(`Schedule: ${v.scheduleCount ?? 0} cron · Memory: ${esc(v.memoryBackend ?? 'none')}`)
    return lines.join('\n')
  }

  bot.command('doctor', async ctx => {
    if (!isAuthorizedSender(ctx)) return
    try {
      // Admin agents with hostd reachable choose scope (one tap, no
      // approval card — doctor is read-only). Everyone else keeps the
      // original zero-extra-tap in-container behaviour.
      if (AGENT_ADMIN && hostdWillBeUsed(getMyAgentName())) {
        await switchroomReply(ctx, '🩺 **Doctor** — which scope?', {
          html: true,
          reply_markup: buildDoctorScopeKeyboard(),
        })
        return
      }
      await renderSelfDoctor(ctx)
    } catch (err: unknown) {
      await switchroomReply(ctx, `**doctor failed:**\n${preBlock(formatSwitchroomOutput((err as any).message ?? 'unknown error'))}`, { html: true })
    }
  })

  bot.command('grant', async ctx => {
    if (!isAuthorizedSender(ctx)) return
    const parts = getCommandArgs(ctx).split(/\s+/).filter(Boolean)
    if (parts.length === 0) { await switchroomReply(ctx, 'Usage: /grant <tool>  or  /grant <agent> <tool>'); return }
    let agentName: string; let tool: string
    if (parts.length === 1) { agentName = getMyAgentName(); tool = parts[0] }
    else { agentName = parts[0]; tool = parts.slice(1).join(' ') }
    try { assertSafeAgentName(agentName) } catch { await switchroomReply(ctx, 'Invalid agent name.'); return }
    await runSwitchroomCommand(ctx, ['agent', 'grant', agentName, tool], `grant ${agentName} ${tool}`)
  })

  bot.command('dangerous', async ctx => {
    if (!isAuthorizedSender(ctx)) return
    const parts = getCommandArgs(ctx).split(/\s+/).filter(Boolean)
    let agentName: string; let off = false
    if (parts.length === 0) { agentName = getMyAgentName() }
    else if (parts.length === 1 && parts[0] === 'off') { agentName = getMyAgentName(); off = true }
    else { agentName = parts[0]; if (parts[1] === 'off') off = true }
    try { assertSafeAgentName(agentName) } catch { await switchroomReply(ctx, 'Invalid agent name.'); return }
    const args = ['agent', 'dangerous', agentName]; if (off) args.push('--off')
    await runSwitchroomCommand(ctx, args, `dangerous ${agentName}${off ? ' off' : ''}`)
  })

  bot.command('permissions', async ctx => {
    if (!isAuthorizedSender(ctx)) return
    const agentName = (typeof ctx.match === "string" ? ctx.match : "").trim() || getMyAgentName()
    try { assertSafeAgentName(agentName) } catch { await switchroomReply(ctx, 'Invalid agent name.'); return }
    await runSwitchroomCommand(ctx, ['agent', 'permissions', agentName], `permissions ${agentName}`)
  })

  // Drive-by cleanup (#927): the dead /update handler that lived here
  // was a pre-#919 stub. Grammy registers in order so the comprehensive
  // /update handler at line ~6516 (added in #919, hardened in #924,
  // docker-guarded in #934) fired first and this one never ran.
  // Removed to avoid future confusion.

  bot.command('version', async ctx => {
    if (!isAuthorizedSender(ctx)) return
    try {
      let output: string
      try { output = switchroomExecCombined(['version'], 10000) }
      catch (err: unknown) { output = (err as any).stdout ?? (err as any).message ?? 'version failed' }
      const trimmed = stripAnsi(output).trim()
      if (!trimmed) { await switchroomReply(ctx, 'version: no output'); return }
      await switchroomReply(ctx, preBlock(formatSwitchroomOutput(trimmed)), { html: true })
    } catch (err: unknown) {
      await switchroomReply(ctx, `**version failed:**\n${preBlock(formatSwitchroomOutput((err as any).message ?? 'unknown error'))}`, { html: true })
    }
  })


  // /whoami — the operator's view of THIS agent's sandbox (the same
  // `config whoami` the agent itself can call as an MCP tool, and the host CLI
  // exposes). Read-only, isAuthorizedSender-gated like /version — surfaces
  // tools / MCP / vault key-NAMES (never values) / powers so the operator can
  // see at a glance what this agent is authorized for.
  bot.command('whoami', async ctx => {
    if (!isAuthorizedSender(ctx)) return
    const demo = hasDemoFlag(getCommandArgs(ctx))
    try {
      let raw: string
      try { raw = switchroomExecCombined(['config', 'whoami'], 10000) }
      catch (err: unknown) { raw = (err as any).stdout ?? (err as any).message ?? 'whoami failed' }
      const trimmed = stripAnsi(raw).trim()
      let card: string
      try { card = formatWhoamiCard(JSON.parse(trimmed.split('\n').pop() ?? trimmed), demo) }
      catch { card = preBlock(formatSwitchroomOutput(trimmed || 'whoami: no output')) }
      await switchroomReply(ctx, card, { html: true })
    } catch (err: unknown) {
      await switchroomReply(ctx, `**whoami failed:**\n${preBlock(formatSwitchroomOutput((err as any).message ?? 'unknown error'))}`, { html: true })
    }
  })

  bot.command('commands', async ctx => {
    if (!isAuthorizedSender(ctx)) return
    await switchroomReply(ctx, buildSwitchroomHelpText(getMyAgentName()), { html: true })
  })
}
