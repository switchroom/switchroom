/**
 * Architectural pin for PR #496 — placeholder text must not end with
 * a trailing ellipsis (`…` or `...`). The draft transport already
 * animates a "typing" indicator on the user's Telegram client; a
 * trailing ellipsis stacks redundant visual noise.
 *
 * Three production strings are pinned here:
 *   1. gateway.ts pre-alloc      — "🔵 thinking"
 *   2. recall.py hook start      — "📚 recalling memories"
 *   3. recall.py post-recall     — "💭 thinking"
 *
 * The pure unit tests for the gateway placeholder live in
 * `pre-alloc-decision.test.ts` (the constant is exported from
 * `pre-alloc-decision.ts`). This file pins the recall.py strings
 * structurally so a future Python refactor can't quietly re-add
 * the ellipsis.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..', '..')
const RECALL_PY = readFileSync(
  resolve(REPO_ROOT, 'vendor', 'hindsight-memory', 'scripts', 'recall.py'),
  'utf8',
)
const GATEWAY_TS = readFileSync(
  resolve(REPO_ROOT, 'telegram-plugin', 'gateway', 'gateway.ts'),
  'utf8',
)

describe('placeholder text — no trailing ellipsis (PR #496 regression guard)', () => {
  describe('recall.py — Hindsight hook placeholders', () => {
    it('hook-start placeholder is "📚 recalling memories" (no `…`)', () => {
      // Locate the call: update_placeholder(placeholder_chat_id, "...")
      // at the start of the recall hook.
      expect(RECALL_PY).toContain('update_placeholder(placeholder_chat_id, "📚 recalling memories")')
      expect(RECALL_PY).not.toContain('"📚 recalling memories…"')
      expect(RECALL_PY).not.toContain('"📚 recalling…"')
    })

    it('post-recall placeholder is "💭 thinking" (no `…`)', () => {
      // After Hindsight finishes, switch the placeholder so the user
      // doesn't keep staring at "📚 recalling" during the model's TTFT.
      expect(RECALL_PY).toContain('update_placeholder(placeholder_chat_id, "💭 thinking")')
      expect(RECALL_PY).not.toContain('"💭 thinking…"')
    })

    it('no recall.py update_placeholder call ends with ellipsis', () => {
      // Catch-all: any update_placeholder("X…") in recall.py is a
      // regression of #496, regardless of what `X` is. Future
      // additions of new placeholder transitions need to follow the
      // no-trailing-ellipsis rule.
      const ellipsisCalls = RECALL_PY.match(/update_placeholder\([^)]*…"\)/g) ?? []
      expect(ellipsisCalls).toEqual([])
    })
  })

  describe('gateway.ts — pre-alloc placeholder', () => {
    it('does NOT contain a literal "🔵 thinking…" anywhere', () => {
      // The gateway uses PRE_ALLOC_PLACEHOLDER_TEXT from
      // pre-alloc-decision.ts; this pin guards against anyone
      // sneaking a literal back in for "performance" or by accident.
      // Comments are the one allowed place — they reference the
      // historical pre-#496 value for context — so we only forbid
      // the literal in code (not docstring/comment surfaces).
      const codeOnly = GATEWAY_TS.replace(/\/\/.*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
      expect(codeOnly).not.toContain("'🔵 thinking…'")
      expect(codeOnly).not.toContain('"🔵 thinking…"')
    })
  })
})
