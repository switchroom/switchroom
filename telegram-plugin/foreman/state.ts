/**
 * Foreman conversation state — SQLite-backed per-chat state for multi-turn
 * flows. Survives foreman restarts so a create-agent flow started before a
 * restart can resume cleanly.
 *
 * Location: ~/.switchroom/foreman/state.sqlite
 * Override via SWITCHROOM_FOREMAN_DIR env var.
 *
 * Schema:
 *   CREATE TABLE IF NOT EXISTS create_flow (
 *     chat_id TEXT PRIMARY KEY,
 *     step TEXT NOT NULL,   -- 'asked-name' | 'asked-profile' | 'asked-bot-token' | 'asked-oauth-code' | 'done'
 *     name TEXT,
 *     profile TEXT,
 *     bot_token TEXT,
 *     auth_session_name TEXT,
 *     login_url TEXT,
 *     started_at INTEGER NOT NULL,
 *     updated_at INTEGER NOT NULL
 *   );
 */

import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// ─── Types ────────────────────────────────────────────────────────────────

export type CreateFlowStep =
  | 'asked-name'
  | 'asked-profile'
  | 'asked-bot-token'
  | 'asked-oauth-code'
  | 'done'

export interface CreateFlowState {
  chatId: string
  step: CreateFlowStep
  name: string | null
  profile: string | null
  botToken: string | null
  authSessionName: string | null
  loginUrl: string | null
  startedAt: number
  updatedAt: number
}

// ─── DB singleton ─────────────────────────────────────────────────────────

let _db: Database | null = null

function getDb(): Database {
  if (_db) return _db

  const foremanDir =
    process.env.SWITCHROOM_FOREMAN_DIR ?? join(homedir(), '.switchroom', 'foreman')

  // 0o700 on the directory + 0o600 on the DB: this file stores in-flight
  // BotFather tokens during /create-agent flows. On a multi-user host,
  // default umask (0o022) would leave tokens world-readable otherwise.
  mkdirSync(foremanDir, { recursive: true, mode: 0o700 })

  const dbPath = join(foremanDir, 'state.sqlite')
  _db = new Database(dbPath)
  try {
    chmodSync(dbPath, 0o600)
  } catch {
    // best-effort — fall through if chmod isn't supported
  }

  _db.exec(`
    CREATE TABLE IF NOT EXISTS create_flow (
      chat_id TEXT PRIMARY KEY,
      step TEXT NOT NULL,
      name TEXT,
      profile TEXT,
      bot_token TEXT,
      auth_session_name TEXT,
      login_url TEXT,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)

  return _db
}

// ─── Public API ───────────────────────────────────────────────────────────

/** Upsert the state for a given chat. */
export function setState(state: CreateFlowState): void {
  const db = getDb()
  db.prepare(`
    INSERT INTO create_flow
      (chat_id, step, name, profile, bot_token, auth_session_name, login_url, started_at, updated_at)
    VALUES
      ($chatId, $step, $name, $profile, $botToken, $authSessionName, $loginUrl, $startedAt, $updatedAt)
    ON CONFLICT(chat_id) DO UPDATE SET
      step = excluded.step,
      name = excluded.name,
      profile = excluded.profile,
      bot_token = excluded.bot_token,
      auth_session_name = excluded.auth_session_name,
      login_url = excluded.login_url,
      updated_at = excluded.updated_at
  `).run({
    $chatId: state.chatId,
    $step: state.step,
    $name: state.name,
    $profile: state.profile,
    $botToken: state.botToken,
    $authSessionName: state.authSessionName,
    $loginUrl: state.loginUrl,
    $startedAt: state.startedAt,
    $updatedAt: state.updatedAt,
  })
}

/** Retrieve the state for a given chat, or null if none exists. */
export function getState(chatId: string): CreateFlowState | null {
  const db = getDb()
  const row = db.prepare<{
    chat_id: string
    step: string
    name: string | null
    profile: string | null
    bot_token: string | null
    auth_session_name: string | null
    login_url: string | null
    started_at: number
    updated_at: number
  }, [string]>(`
    SELECT chat_id, step, name, profile, bot_token, auth_session_name, login_url, started_at, updated_at
    FROM create_flow
    WHERE chat_id = ?
  `).get(chatId)

  if (!row) return null

  return {
    chatId: row.chat_id,
    step: row.step as CreateFlowStep,
    name: row.name,
    profile: row.profile,
    botToken: row.bot_token,
    authSessionName: row.auth_session_name,
    loginUrl: row.login_url,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  }
}

/** Remove the state for a given chat (flow completed or cancelled). */
export function clearState(chatId: string): void {
  const db = getDb()
  db.prepare('DELETE FROM create_flow WHERE chat_id = ?').run(chatId)
}

/**
 * List all in-progress flows updated within the last `maxAgeMs` ms.
 * Used at foreman startup to resume flows that survived a restart.
 */
export function listActiveFlows(maxAgeMs = 60 * 60 * 1000): CreateFlowState[] {
  const db = getDb()
  const cutoff = Date.now() - maxAgeMs
  const rows = db.prepare<{
    chat_id: string
    step: string
    name: string | null
    profile: string | null
    bot_token: string | null
    auth_session_name: string | null
    login_url: string | null
    started_at: number
    updated_at: number
  }, [number]>(`
    SELECT chat_id, step, name, profile, bot_token, auth_session_name, login_url, started_at, updated_at
    FROM create_flow
    WHERE step != 'done' AND updated_at > ?
    ORDER BY updated_at DESC
  `).all(cutoff)

  return rows.map(row => ({
    chatId: row.chat_id,
    step: row.step as CreateFlowStep,
    name: row.name,
    profile: row.profile,
    botToken: row.bot_token,
    authSessionName: row.auth_session_name,
    loginUrl: row.login_url,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  }))
}

/** Reset the DB singleton (useful in tests to avoid sharing state). */
export function _resetDbForTest(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}
