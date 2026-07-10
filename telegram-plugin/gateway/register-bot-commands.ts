import type { Bot } from 'grammy'
import {
  TELEGRAM_BASE_COMMANDS,
  TELEGRAM_SWITCHROOM_COMMANDS,
} from '../welcome-text.js'

/**
 * Register the bot's slash-command menu with Telegram (`setMyCommands`).
 *
 * Extracted verbatim from gateway.ts (#2996 Phase 5 leaf move). The `bot`
 * singleton is injected rather than imported so this stays a pure leaf with
 * no back-reference into the gateway module.
 *
 * Slash-menu is deliberately trimmed from the full command catalogue.
 * See telegram-plugin/welcome-text.ts TELEGRAM_MENU_COMMANDS for the
 * rationale (mobile UX focus; ops primitives stay typable but out of
 * the autocomplete clutter). /commands surfaces the full list.
 */
export async function registerSwitchroomBotCommands(bot: Bot): Promise<void> {
  await bot.api.setMyCommands(
    [...TELEGRAM_BASE_COMMANDS, ...TELEGRAM_SWITCHROOM_COMMANDS],
    { scope: { type: 'all_private_chats' } },
  )
  // Group chats don't support /start pairing, so only the switchroom
  // commands are registered there.
  await bot.api.setMyCommands(
    TELEGRAM_SWITCHROOM_COMMANDS,
    { scope: { type: 'all_group_chats' } },
  )
}
