#!/usr/bin/env bun
/**
 * Telegram channel for Claude Code — Switchroom fork with topic/forum routing.
 *
 * Entrypoint dispatcher. Two paths:
 *
 *   1. **Gateway running** (socket reachable) → delegates to the thin
 *      bridge (`bridge/bridge.ts`) which proxies MCP ↔ gateway IPC.
 *      The gateway owns the bot connection, polling, admin commands,
 *      and all Telegram API calls. The bridge is an ephemeral MCP
 *      adapter that lives only as long as the Claude Code session.
 *
 *   2. **No gateway** → exits with a clear "run `switchroom setup`"
 *      message. The legacy in-process monolith was removed in the
 *      Wave 3 F4 cleanup (see `telegram-plugin/docs/gateway-server-split.md`)
 *      because it was double-maintenance every PR had to pay against
 *      a 6661-line file that hadn't been the production path for
 *      months.
 *
 * Forked from the official Telegram plugin. Switchroom-specific
 * features all live in `gateway/gateway.ts`:
 * - TELEGRAM_TOPIC_ID env var to filter messages by forum topic
 * - message_thread_id in inbound notification metadata
 * - Thread-aware reply / photo / document / voice / video / sticker
 * - Auto-capture of thread_id per chat for seamless topic replies
 * - Markdown-to-HTML conversion for rich formatting (default)
 * - Smart HTML chunking that preserves tag boundaries
 * - Inbound message coalescing (debounce rapid messages)
 * - Typing indicator auto-refresh with exponential backoff
 * - Robust error handling: 429 retry, thread-not-found fallback, network retry
 * - SQLite history buffer (history.ts) for cross-restart recovery
 * - Vault-grant inline-keyboard wizard
 * - Pinned progress card with sub-agent visibility
 *
 * State (access.json / pairing / allowlists) lives at
 * ~/.claude/channels/telegram/ — managed by the /telegram:access skill.
 */

import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { installPluginLogger } from './plugin-logger.js'
import {
  readPidFile,
  isPidAlive,
  shouldFallBackToLegacy,
} from './gateway/pid-file.js'

// Route all process.stderr.write calls to a rotating file at
// ~/.switchroom/logs/telegram-plugin.log. Claude Code does not forward the
// bun subprocess's stderr anywhere, so without this the plugin is blind to
// its own logs in production. Override path via SWITCHROOM_TELEGRAM_LOG_PATH.
installPluginLogger()

// ─── Dual-mode detection ─────────────────────────────────────────────────
// If the persistent gateway is running (socket exists AND accepts connections),
// delegate to the thin bridge. Just checking file existence is not enough:
// if the gateway crashes without cleanup, a stale socket file remains on disk
// and every new session would silently fail to deliver messages.
//
// IMPORTANT: never rmSync the socket here. A transient Bun.connect failure
// against a LIVE gateway (EAGAIN, EMFILE, accept-backlog saturation, race
// with the gateway's Bun.listen handshake) would otherwise delete the
// gateway's socket file and orphan the listener. Once orphaned, every
// subsequent sidecar sees existsSync===false, falls through to the no-
// gateway branch (was: spawn a second poller; is now: exit with error),
// breaking the chat surface. The gateway self-heals stale sockets at its
// own startup (see ipc-server.ts unlinkSync), so the correct posture here
// is to fall through on probe failure WITHOUT touching the socket file.
{
  const _stateDir = process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
  const _gatewaySocket = process.env.SWITCHROOM_GATEWAY_SOCKET ?? join(_stateDir, 'gateway.sock')
  const _gatewayPidPath = process.env.SWITCHROOM_GATEWAY_PID_FILE ?? join(_stateDir, 'gateway.pid.json')

  let _gatewayLive = false

  async function probeSocketOnce(): Promise<void> {
    if (!existsSync(_gatewaySocket)) return
    try {
      await Bun.connect({
        unix: _gatewaySocket,
        socket: {
          open(s) { s.end() },
          data() {},
          close() {},
          error() {},
          drain() {},
        },
      })
      _gatewayLive = true
    } catch {
      /* swallow — caller inspects _gatewayLive */
    }
  }

  // Retry-before-fallback: if the socket is momentarily unreachable
  // but the gateway PID file exists AND the PID is alive, the gateway
  // is just briefly not listening (accept-backlog, handshake race, or
  // a sub-ms window during gateway's own restart). Retry with backoff
  // rather than immediately failing. See pid-file.ts for the
  // 2026-04-22 incident this closes.
  await probeSocketOnce()
  if (!_gatewayLive) {
    const BACKOFFS_MS = [200, 500, 1000, 2000, 4000]
    for (const delay of BACKOFFS_MS) {
      const rec = readPidFile(_gatewayPidPath)
      const pidFileExists = rec !== null
      const pidAlive = rec != null && isPidAlive(rec.pid)
      const decision = shouldFallBackToLegacy({
        socketReachable: false,
        pidFileExists,
        pidAlive,
      })
      if (decision) break
      process.stderr.write(
        `telegram channel: socket ${_gatewaySocket} unreachable but gateway PID ${rec?.pid} alive — retrying in ${delay}ms\n`,
      )
      await new Promise((r) => setTimeout(r, delay))
      await probeSocketOnce()
      if (_gatewayLive) break
    }
  }

  if (_gatewayLive) {
    process.stderr.write(`telegram channel: gateway detected at ${_gatewaySocket}, running as bridge\n`)
    await import('./bridge/bridge.js')
    await new Promise(() => {})
  }

  // Final fallback-or-not decision after retries exhausted. We reach
  // here only if the socket is still not reachable.
  const _finalRec = readPidFile(_gatewayPidPath)
  const _finalPidFileExists = _finalRec !== null
  const _finalPidAlive = _finalRec != null && isPidAlive(_finalRec.pid)
  if (!shouldFallBackToLegacy({
    socketReachable: false,
    pidFileExists: _finalPidFileExists,
    pidAlive: _finalPidAlive,
  })) {
    // The PID is alive but the socket stayed unreachable across all
    // retries. Something is genuinely wrong with the gateway — exit
    // quietly so we don't make it worse by spawning a competing client.
    process.stderr.write(
      `telegram channel: gateway PID ${_finalRec?.pid} alive but socket ${_gatewaySocket} unreachable after retries — ` +
      `exiting sidecar (would 409-conflict against live gateway).\n`,
    )
    process.exit(0)
  }

  // No gateway socket at all. Pre-#235-Wave-3-F4 (the legacy monolith era),
  // server.ts would spin up a full in-process Telegram bot here. That path
  // was removed because:
  //   - It was double-maintenance every PR (the gateway was the production
  //     path; the monolith was a 6661-line backup that drifted on every
  //     change — witness `/issues`, `/authfallback`, `/usage` landing only
  //     in gateway).
  //   - It silently masked broken setups: an agent without the gateway
  //     daemon would kinda-sorta work via the monolith, then hit subtle
  //     missing-feature bugs (no /issues card, no quota notifications, no
  //     graceful failover). A clean error is more honest.
  //
  // To install the gateway: `switchroom setup` provisions the
  // `switchroom-telegram-gateway` systemd unit. Inspect with
  // `systemctl --user status switchroom-telegram-gateway`.
  process.stderr.write(
    `telegram channel: no gateway socket at ${_gatewaySocket}. ` +
    `Run \`switchroom setup\` to install the gateway daemon, or check ` +
    `\`systemctl --user status switchroom-telegram-gateway\`. Exiting sidecar.\n`,
  )
  process.exit(1)
}
