/**
 * `switchroom vault sweep` — retroactive secret-scrub.
 *
 * Iterates every entry in the vault and searches known content stores for
 * the raw value, rewriting matches to `vault:${slug}`. Supports `--dry-run`
 * which reports matches without modifying anything.
 *
 * Stores scanned:
 *   1. Telegram plugin SQLite history (`~/.claude/channels/telegram/history.db`
 *      or `$TELEGRAM_STATE_DIR/history.db`).
 *   2. Claude Code session transcripts under `~/.claude/projects/**\/*.jsonl`.
 *   3. Hindsight memory — per agent-bank, via the MCP Streamable-HTTP API.
 *      Client-side iteration: `list_memories` (paginated) → substring check
 *      against current vault values → `delete_memory` for hits. Hindsight
 *      has no "delete-by-substring" tool, so we do the scan in switchroom.
 *
 * This command requires the vault passphrase (via prompt or
 * SWITCHROOM_VAULT_PASSPHRASE). It never prints raw values; --dry-run
 * output uses `maskToken` for the display.
 */

import type { Command } from 'commander'
import chalk from 'chalk'
import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { loadConfig, resolvePath } from '../config/loader.js'
import { openVault, VaultError } from '../vault/vault.js'
import { isHindsightEnabled } from '../memory/hindsight.js'
import type { SwitchroomConfig } from '../config/schema.js'

function getVaultPath(configPath?: string): string {
  try {
    const config = loadConfig(configPath)
    return resolvePath(config.vault?.path ?? '~/.switchroom/vault.enc')
  } catch {
    return resolvePath('~/.switchroom/vault.enc')
  }
}

/** Partial-reveal mask — identical rule as the Telegram plugin's. */
function maskToken(s: string): string {
  if (s.length >= 18) return `${s.slice(0, 6)}...${s.slice(-4)}`
  return '***'
}

interface ScanTarget {
  kind: 'jsonl' | 'sqlite'
  path: string
}

function findClaudeTranscripts(): string[] {
  const root = join(homedir(), '.claude', 'projects')
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(p)
      } else if (p.endsWith('.jsonl')) {
        out.push(p)
      }
    }
  }
  walk(root)
  return out
}

function findTelegramHistoryDb(): string | null {
  const candidates = [
    process.env.TELEGRAM_STATE_DIR
      ? join(process.env.TELEGRAM_STATE_DIR, 'history.db')
      : null,
    join(homedir(), '.claude', 'channels', 'telegram', 'history.db'),
  ].filter(Boolean) as string[]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

interface SweepReport {
  target: string
  matches: number
  modified: boolean
}

function scrubJsonl(path: string, values: Array<{ key: string; value: string }>, dryRun: boolean): SweepReport {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return { target: path, matches: 0, modified: false }
  }
  let matches = 0
  let out = content
  for (const { key, value } of values) {
    if (!out.includes(value)) continue
    let prev
    do {
      prev = out
      out = out.split(value).join(`vault:${key}`)
      matches++
    } while (prev !== out && out.includes(value))
  }
  if (matches === 0) return { target: path, matches: 0, modified: false }
  if (!dryRun) {
    try {
      copyFileSync(path, `${path}.bak`)
      writeFileSync(path, out, 'utf8')
    } catch (err) {
      console.error(chalk.red(`  write failed for ${path}: ${(err as Error).message}`))
      return { target: path, matches, modified: false }
    }
  }
  return { target: path, matches, modified: !dryRun }
}

/**
 * Minimal Hindsight memory record shape used by the sweep. Only the fields
 * we care about — `list_memories` returns more.
 */
export interface HindsightMemory {
  id: string
  text: string
  context?: string
}

/**
 * Dependency-injectable Hindsight MCP client — lets tests provide a fake
 * without standing up a live Hindsight instance. Methods return Promises;
 * implementations may talk HTTP or mock.
 */
export interface HindsightMcpClient {
  listMemories(bankId: string, opts: { limit: number; offset: number }): Promise<{
    items: HindsightMemory[]
    total: number
  }>
  deleteMemory(bankId: string, memoryId: string): Promise<void>
}

/**
 * Default Hindsight MCP client — speaks Streamable-HTTP JSON-RPC to the
 * endpoint in `memory.config.url`. The same shape as the `createBank` /
 * `updateBankMissions` pattern in `src/memory/hindsight.ts` (init → grab
 * session id → call tool).
 */
export function makeHttpHindsightClient(
  apiUrl: string,
  opts?: { fetchImpl?: typeof fetch; timeoutMs?: number },
): HindsightMcpClient {
  const fetchImpl = opts?.fetchImpl ?? fetch
  const timeoutMs = opts?.timeoutMs ?? 10_000

  // Returns the session-id string if the server issued one, or null for a
  // stateless server (HINDSIGHT_DEFAULT_MCP_STATELESS=true). The MCP spec
  // makes mcp-session-id optional — hard-failing on its absence broke the
  // sweep against the default Hindsight deployment. Mirror the tolerant
  // pattern at src/memory/hindsight.ts:~394-401.
  async function initSession(bankId: string): Promise<string | null> {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await fetchImpl(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'X-Bank-Id': bankId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'switchroom-vault-sweep', version: '0.1' },
          },
        }),
        signal: controller.signal,
      })
      if (!resp.ok) throw new Error(`initialize HTTP ${resp.status}`)
      // Hindsight runs stateless by default — mcp-session-id is optional per
      // the MCP spec. Only forward the header when the server actually issues
      // one; a missing header is not an error.
      const sid = resp.headers.get('mcp-session-id')
      // Drain body so the connection can be reused.
      await resp.text()
      return sid
    } finally {
      clearTimeout(t)
    }
  }

  async function callTool(bankId: string, sessionId: string | null, name: string, args: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), timeoutMs)
    // Only include mcp-session-id when the server issued one (stateful mode).
    const sessionHeader: Record<string, string> = sessionId ? { 'mcp-session-id': sessionId } : {}
    try {
      const resp = await fetchImpl(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'X-Bank-Id': bankId,
          ...sessionHeader,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Math.floor(Math.random() * 1_000_000),
          method: 'tools/call',
          params: { name, arguments: args },
        }),
        signal: controller.signal,
      })
      if (!resp.ok) throw new Error(`tools/call(${name}) HTTP ${resp.status}`)
      const body = await resp.text()
      // Hindsight responds as SSE (event-stream). Parse the first data: line.
      for (const line of body.split('\n')) {
        if (line.startsWith('data: ')) {
          const p = JSON.parse(line.slice(6))
          if (p.result?.isError) {
            throw new Error(`tools/call(${name}) reported error`)
          }
          const inner = p.result?.structuredContent?.result
          if (typeof inner === 'string') {
            return JSON.parse(inner)
          }
          return p.result?.structuredContent ?? null
        }
      }
      // Fallback — some transports send plain JSON.
      const p = JSON.parse(body)
      const inner = p.result?.structuredContent?.result
      if (typeof inner === 'string') return JSON.parse(inner)
      return p.result?.structuredContent ?? null
    } finally {
      clearTimeout(t)
    }
  }

  return {
    async listMemories(bankId, { limit, offset }) {
      const sid = await initSession(bankId)
      const res = (await callTool(bankId, sid, 'list_memories', {
        bank_id: bankId,
        limit,
        offset,
      })) as { items: HindsightMemory[]; total: number }
      return { items: res.items ?? [], total: res.total ?? 0 }
    },
    async deleteMemory(bankId, memoryId) {
      // Soft-delete the matched memory unit via the `invalidate_memory` MCP
      // tool, which is the by-id single-memory primitive that was missing when
      // the honest-failure stub was written. Unlike the phantom `delete_memory`
      // or the document-granularity `delete_document`, `invalidate_memory`
      // takes the memory-unit id directly from `list_memories` and marks it
      // as redacted without requiring a document→memory mapping.
      const sid = await initSession(bankId)
      await callTool(bankId, sid, 'invalidate_memory', {
        memory_id: memoryId,
        reason: 'vault-sweep secret redaction',
      })
    },
  }
}

/**
 * Sweep a single Hindsight bank for vault values. Returns a report of
 * memory IDs that matched (and were deleted, unless dryRun). Pagination
 * is done in 100-row pages until `total` is exhausted.
 *
 * Matching rule: a memory matches if any vault value appears as a plain
 * substring in `text` OR `context`. We delete the whole memory — there is
 * no API to surgically redact a subfield. This is aggressive but
 * appropriate: a leaked secret in memory is a bank integrity failure.
 */
export async function sweepHindsightBank(
  client: HindsightMcpClient,
  bankId: string,
  vaultValues: Array<{ key: string; value: string }>,
  opts: { dryRun: boolean; pageSize?: number } = { dryRun: false },
): Promise<{ matched: Array<{ id: string; vaultKey: string }>; deleted: number }> {
  const pageSize = opts.pageSize ?? 100
  const matched: Array<{ id: string; vaultKey: string }> = []
  let offset = 0
  let total = Infinity

  while (offset < total) {
    const page = await client.listMemories(bankId, { limit: pageSize, offset })
    total = page.total
    if (page.items.length === 0) break
    for (const mem of page.items) {
      const haystack = `${mem.text ?? ''}\n${mem.context ?? ''}`
      for (const v of vaultValues) {
        if (v.value.length >= 8 && haystack.includes(v.value)) {
          matched.push({ id: mem.id, vaultKey: v.key })
          break // one match per memory is enough to mark it for deletion
        }
      }
    }
    offset += page.items.length
    // Guard against a server that returns fewer items than pageSize even
    // though more remain — advance by page.items.length which is what we
    // actually saw, not pageSize.
    if (page.items.length < pageSize) break
  }

  let deleted = 0
  if (!opts.dryRun) {
    let warnedOnce = false
    for (const m of matched) {
      try {
        await client.deleteMemory(bankId, m.id)
        deleted++
      } catch (err) {
        // Surface WHY a matched secret could not be deleted (once) instead of
        // swallowing it — a vault scrub that finds leaked secrets but cannot
        // remove them must say so, or the operator wrongly believes the bank is
        // clean. `deleted` stays below `matched.length`, and the reason prints.
        if (!warnedOnce) {
          warnedOnce = true
          process.stderr.write(
            `vault-sweep: ${matched.length} secret(s) matched in bank '${bankId}' but ` +
              `could NOT be auto-deleted: ${(err as Error).message}\n`,
          )
        }
      }
    }
  }
  return { matched, deleted }
}

/**
 * Collect the list of Hindsight banks to sweep from switchroom.yaml. One
 * bank per agent (bank_id = collection override, default = agent name).
 */
export function getBanksToSweep(config: SwitchroomConfig | undefined): string[] {
  if (!config || !config.agents) return []
  const out = new Set<string>()
  for (const [name, agent] of Object.entries(config.agents)) {
    const coll = agent.memory?.collection ?? name
    out.add(coll)
  }
  return [...out]
}

export function registerVaultSweep(vault: Command, program: Command): void {
  vault
    .command('sweep')
    .description('Retroactively scan history + transcripts for stored vault values and redact them')
    .option('--dry-run', 'Report matches without rewriting any files')
    .action(async (opts: { dryRun?: boolean }) => {
      const parentOpts = program.opts()
      const vaultPath = getVaultPath(parentOpts.config)
      const pp = process.env.SWITCHROOM_VAULT_PASSPHRASE
      if (!pp) {
        console.error(chalk.red('SWITCHROOM_VAULT_PASSPHRASE must be set (non-interactive mode only for now).'))
        process.exit(1)
      }
      let secrets: Awaited<ReturnType<typeof openVault>>
      try {
        secrets = openVault(pp, vaultPath)
      } catch (err) {
        const msg = err instanceof VaultError || err instanceof Error ? err.message : String(err)
        console.error(chalk.red(`Vault error: ${msg}`))
        process.exit(1)
      }
      // Only string/binary entries are sweepable; files are directories.
      const values: Array<{ key: string; value: string }> = []
      for (const [key, entry] of Object.entries(secrets)) {
        if (entry.kind === 'string' || entry.kind === 'binary') {
          if (entry.value.length >= 8) values.push({ key, value: entry.value })
        }
      }
      if (values.length === 0) {
        console.log(chalk.dim('No sweepable vault entries (need kind=string|binary).'))
        return
      }

      const targets: ScanTarget[] = []
      const db = findTelegramHistoryDb()
      if (db) targets.push({ kind: 'sqlite', path: db })
      for (const p of findClaudeTranscripts()) targets.push({ kind: 'jsonl', path: p })

      console.log(chalk.dim(`scanning ${targets.length} files across ${values.length} vault entries...`))
      const reports: SweepReport[] = []
      for (const t of targets) {
        if (t.kind === 'jsonl') {
          reports.push(scrubJsonl(t.path, values, opts.dryRun === true))
        } else {
          // SQLite: we use a minimal sqlite3 CLI shellout to avoid pulling a
          // native SQLite dep into switchroom's runtime. If sqlite3 isn't on
          // PATH, the file is skipped with a warning.
          const res = scrubSqlite(t.path, values, opts.dryRun === true)
          if (res != null) reports.push(res)
        }
      }
      const hit = reports.filter((r) => r.matches > 0)
      if (hit.length === 0) {
        console.log(chalk.green('✓ nothing to scrub — no matches.'))
        return
      }
      for (const r of hit) {
        const verb = r.modified ? 'scrubbed' : 'would scrub'
        console.log(`${chalk.yellow(verb)}: ${r.target} — ${r.matches} match${r.matches === 1 ? '' : 'es'}`)
      }
      console.log('')
      console.log(chalk.dim(`masked values for display only:`))
      for (const v of values) {
        console.log(`  vault:${v.key} → ${maskToken(v.value)}`)
      }
      if (opts.dryRun) {
        console.log(chalk.yellow('dry-run — no files modified. Rerun without --dry-run to apply.'))
      }

      // --- Hindsight sweep (per-bank client-side iteration) ---
      let fullConfig: SwitchroomConfig | undefined
      try {
        fullConfig = loadConfig(parentOpts.config)
      } catch {
        fullConfig = undefined
      }
      const hindsightUrl = (fullConfig?.memory?.config?.url as string | undefined)
      if (isHindsightEnabled(fullConfig) && hindsightUrl) {
        const banks = getBanksToSweep(fullConfig)
        if (banks.length === 0) {
          console.log(chalk.dim('note: no Hindsight banks configured — skipping memory sweep.'))
        } else {
          const client = makeHttpHindsightClient(hindsightUrl)
          console.log(chalk.dim(`scanning ${banks.length} Hindsight bank(s)...`))
          let totalMatched = 0
          let totalDeleted = 0
          for (const bankId of banks) {
            try {
              const { matched, deleted } = await sweepHindsightBank(client, bankId, values, { dryRun: opts.dryRun === true })
              totalMatched += matched.length
              totalDeleted += deleted
              if (matched.length > 0) {
                const verb = opts.dryRun ? 'would delete' : 'deleted'
                console.log(`${chalk.yellow(verb)}: hindsight:${bankId} — ${matched.length} memor${matched.length === 1 ? 'y' : 'ies'}`)
              }
            } catch (err) {
              console.warn(chalk.yellow(`  hindsight:${bankId} sweep failed: ${(err as Error).message}`))
            }
          }
          if (totalMatched === 0) {
            console.log(chalk.green('  no Hindsight memories contained vault values.'))
          } else if (!opts.dryRun) {
            console.log(chalk.dim(`  deleted ${totalDeleted}/${totalMatched} memories across ${banks.length} bank(s).`))
          }
        }
      } else {
        console.log(chalk.dim('note: Hindsight sweep skipped (memory backend is not "hindsight" or no url configured).'))
      }
    })
}

/**
 * Best-effort SQLite scrub via the `sqlite3` CLI. Returns null if we can't
 * operate on the DB (cli missing, file locked, etc.) — the caller treats
 * null as "skipped."
 */
function scrubSqlite(path: string, values: Array<{ key: string; value: string }>, dryRun: boolean): SweepReport | null {
  // We only know the `messages` table from telegram history; if other tables
  // exist we leave them alone (tight scope == safer scrub).
  let hasSqlite = true
  try {
    execFileSync('sqlite3', ['-version'], { timeout: 2000, stdio: 'ignore' })
  } catch {
    hasSqlite = false
  }
  if (!hasSqlite) {
    console.warn(chalk.yellow(`  sqlite3 CLI not found, skipping ${path}`))
    return null
  }
  // Count matches with a LIKE per value. `%` escaped isn't straightforward —
  // we use parameter binding indirectly by writing the value to a tempfile
  // and using `.read`... OK honestly the SQL injection surface here is
  // ourselves so we just escape single quotes.
  let matches = 0
  for (const { value } of values) {
    const esc = value.replace(/'/g, "''")
    try {
      const out = execFileSync(
        'sqlite3',
        // `-readonly` — the counting pass is a pure SELECT and must not be
        // able to checkpoint-and-unlink the sidecars of a DB the gateway may
        // still hold open (#4595). The UPDATE pass below is the deliberate
        // writer.
        ['-readonly', path, `SELECT COUNT(*) FROM messages WHERE text LIKE '%${esc}%'`],
        { encoding: 'utf8', timeout: 10000 },
      )
      const n = parseInt(out.trim(), 10)
      if (!Number.isNaN(n)) matches += n
    } catch {
      /* ignore — table may not exist */
    }
  }
  if (matches === 0) return { target: path, matches: 0, modified: false }
  if (!dryRun) {
    try {
      copyFileSync(path, `${path}.bak`)
      for (const { key, value } of values) {
        const esc = value.replace(/'/g, "''")
        const replacement = `vault:${key}`.replace(/'/g, "''")
        // allow-rw-db-open: `vault sweep` is the deliberate writer here — it
        // scrubs leaked secrets out of history; a .bak copy is taken first.
        execFileSync(
          'sqlite3',
          [path, `UPDATE messages SET text = replace(text, '${esc}', '${replacement}')`],
          { timeout: 15000 },
        )
      }
      return { target: path, matches, modified: true }
    } catch (err) {
      console.error(chalk.red(`  sqlite UPDATE failed for ${path}: ${(err as Error).message}`))
      return { target: path, matches, modified: false }
    }
  }
  return { target: path, matches, modified: false }
}
