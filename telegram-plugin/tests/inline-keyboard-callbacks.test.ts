/**
 * Unit tests for #271's agent-callback prefix wrapping + parsing.
 *
 * These pin the wire-format contract so the gateway's callback_query
 * dispatcher and the inline_keyboard validation in executeReply /
 * executeStreamReply stay in sync. If anyone adds a new infrastructure
 * prefix in callback_query routing, these tests still pass — but the
 * contract that `agent:` is reserved for round-tripping is enforced
 * by the parser.
 */

import { describe, it, expect } from 'vitest'
import {
  AGENT_CALLBACK_PREFIX,
  AGENT_CALLBACK_DATA_MAX,
  wrapAgentCallbacks,
  redactAgentKeyboard,
  parseAgentCallback,
  validateAndWrapAgentKeyboard,
  extractAgentButtonMeta,
  buildButtonConfirmation,
  resolveTapAnnotation,
  escapeHtmlEntities,
  applyTapAnnotationEdit,
} from '../inline-keyboard-callbacks.js'
import { redact } from '../secret-detect/redact.js'

describe('inline-keyboard-callbacks (#271)', () => {
  describe('AGENT_CALLBACK_DATA_MAX', () => {
    it('reserves room for the prefix within Telegram\'s 64-byte limit', () => {
      // Sanity: prefix bytes + agent budget == Telegram limit (64).
      const prefixBytes = new TextEncoder().encode(AGENT_CALLBACK_PREFIX).byteLength
      expect(prefixBytes + AGENT_CALLBACK_DATA_MAX).toBe(64)
    })
  })

  describe('wrapAgentCallbacks', () => {
    it('prepends `agent:` to every callback_data field', () => {
      const wrapped = wrapAgentCallbacks([
        [{ text: 'Approve', callback_data: 'approve_pr_547' }],
        [{ text: 'Hold', callback_data: 'hold' }],
      ])
      expect(wrapped[0]![0]!.callback_data).toBe('agent:approve_pr_547')
      expect(wrapped[1]![0]!.callback_data).toBe('agent:hold')
    })

    it('passes URL buttons through unchanged', () => {
      const wrapped = wrapAgentCallbacks([
        [{ text: 'Open docs', url: 'https://example.com' }],
      ])
      expect(wrapped[0]![0]).toEqual({ text: 'Open docs', url: 'https://example.com' })
      expect(wrapped[0]![0]!.callback_data).toBeUndefined()
    })

    it('handles mixed URL + callback_data buttons in one row', () => {
      const wrapped = wrapAgentCallbacks([
        [
          { text: 'Open', url: 'https://x.test' },
          { text: 'Approve', callback_data: 'ok' },
        ],
      ])
      expect(wrapped[0]![0]!.url).toBe('https://x.test')
      expect(wrapped[0]![0]!.callback_data).toBeUndefined()
      expect(wrapped[0]![1]!.callback_data).toBe('agent:ok')
      expect(wrapped[0]![1]!.url).toBeUndefined()
    })

    it('returns a fresh array — does not mutate input', () => {
      const original = [[{ text: 'A', callback_data: 'a' }]]
      const wrapped = wrapAgentCallbacks(original)
      expect(original[0]![0]!.callback_data).toBe('a')
      expect(wrapped[0]![0]!.callback_data).toBe('agent:a')
      expect(wrapped).not.toBe(original)
      expect(wrapped[0]).not.toBe(original[0])
    })

    it('throws when an agent-supplied callback_data exceeds the 58-byte budget', () => {
      const tooLong = 'x'.repeat(AGENT_CALLBACK_DATA_MAX + 1)
      expect(() =>
        wrapAgentCallbacks([[{ text: 'X', callback_data: tooLong }]]),
      ).toThrow(/exceeds 58-byte agent budget/)
    })

    it('accepts callback_data exactly at the 58-byte budget', () => {
      const atLimit = 'x'.repeat(AGENT_CALLBACK_DATA_MAX)
      const wrapped = wrapAgentCallbacks([[{ text: 'X', callback_data: atLimit }]])
      const wireBytes = new TextEncoder().encode(wrapped[0]![0]!.callback_data as string).byteLength
      expect(wireBytes).toBe(64) // hits Telegram's hard limit exactly
    })

    it('counts BYTES not chars for multi-byte UTF-8', () => {
      // '🔐' is 4 bytes in UTF-8. 14 of them = 56 bytes — under the
      // 58-byte budget, so should pass. 15 of them = 60 bytes — over.
      const ok = '🔐'.repeat(14)
      expect(() =>
        wrapAgentCallbacks([[{ text: 'X', callback_data: ok }]]),
      ).not.toThrow()

      const bad = '🔐'.repeat(15)
      expect(() =>
        wrapAgentCallbacks([[{ text: 'X', callback_data: bad }]]),
      ).toThrow(/exceeds 58-byte agent budget/)
    })

    it('handles an empty keyboard without crashing', () => {
      expect(wrapAgentCallbacks([])).toEqual([])
    })
  })

  describe('parseAgentCallback', () => {
    it('strips the prefix and returns the raw payload', () => {
      const result = parseAgentCallback('agent:approve_pr_547')
      expect(result).toEqual({ raw: 'approve_pr_547' })
    })

    it('returns null for non-agent prefixes (lets dispatcher fall through)', () => {
      expect(parseAgentCallback('auth:rotate:clerk')).toBeNull()
      expect(parseAgentCallback('op:dismiss:klanker')).toBeNull()
      expect(parseAgentCallback('vd:unlock:abc')).toBeNull()
      expect(parseAgentCallback('aq:0:xyz')).toBeNull()
      expect(parseAgentCallback('perm:allow:abcde')).toBeNull()
      expect(parseAgentCallback('something_random')).toBeNull()
    })

    it('returns empty raw payload when the agent emitted bare prefix', () => {
      // Edge case: agent emits `callback_data: ''` (zero-length). After
      // wrap we'd send `agent:`. Round-tripping returns { raw: '' }.
      // Validation upstream should reject empty callback_data; this is
      // a defensive check.
      expect(parseAgentCallback('agent:')).toEqual({ raw: '' })
    })
  })

  describe('validateAndWrapAgentKeyboard', () => {
    it('returns ok=true with wrapped keyboard on a valid input', () => {
      const result = validateAndWrapAgentKeyboard([
        [{ text: 'Approve', callback_data: 'ok' }],
      ])
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.wrapped[0]![0]!.callback_data).toBe('agent:ok')
      }
    })

    it('returns ok=false with errors when validation fails', () => {
      // Empty text fails the existing validateInlineKeyboard.
      const result = validateAndWrapAgentKeyboard([
        [{ text: '', callback_data: 'ok' }],
      ])
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.errors.length).toBeGreaterThan(0)
        expect(result.errors[0]!.field).toBe('text')
      }
    })
  })

  // ─── #789 button-choice-confirmation ("✅ You chose: X") ────────────────
  describe('inline_keyboard_confirm meta plumbing (#789)', () => {
    it('captures inline_keyboard_confirm into the per-button meta map', () => {
      const meta = extractAgentButtonMeta([
        [{ text: 'Approve', callback_data: 'ok', inline_keyboard_confirm: true }],
        [{ text: 'Hold', callback_data: 'hold', inline_keyboard_confirm: false }],
      ])
      expect(meta.get('ok')).toEqual({ inline_keyboard_confirm: true })
      expect(meta.get('hold')).toEqual({ inline_keyboard_confirm: false })
    })

    it('strips inline_keyboard_confirm from the wrapped Telegram payload', () => {
      const wrapped = wrapAgentCallbacks([
        [{ text: 'Approve', callback_data: 'ok', inline_keyboard_confirm: true }],
      ])
      expect(wrapped[0]![0]).toEqual({ text: 'Approve', callback_data: 'agent:ok' })
      expect('inline_keyboard_confirm' in wrapped[0]![0]!).toBe(false)
    })
  })

  describe('buildButtonConfirmation (#789)', () => {
    // Fixed clock: 14:05 local. Use a UTC-explicit date and read via the
    // matching timezone accessor so the assertion is host-TZ independent.
    const fixedUtc = new Date('2026-07-11T14:05:00Z')

    it('renders the default template with a bold, escaped label + HH:MM (utc)', () => {
      const line = buildButtonConfirmation({
        template: '✅ You chose: {label} · {time}',
        label: 'Approve',
        timezone: 'utc',
        escapeLabel: (s) => s,
        now: fixedUtc,
      })
      expect(line).toBe('✅ You chose: <b>Approve</b> · 14:05')
    })

    it('collapses newlines in the label to a single line', () => {
      const line = buildButtonConfirmation({
        template: '✅ You chose: {label} · {time}',
        label: 'Line one\nLine two',
        timezone: 'utc',
        escapeLabel: (s) => s,
        now: fixedUtc,
      })
      expect(line).toBe('✅ You chose: <b>Line one Line two</b> · 14:05')
      expect(line).not.toContain('\n')
    })

    it('trims a long label to 60 chars and applies the injected escaper', () => {
      const line = buildButtonConfirmation({
        template: '{label}',
        label: 'x'.repeat(80),
        timezone: 'utc',
        escapeLabel: (s) => `[esc:${s.length}]`,
        now: fixedUtc,
      })
      expect(line).toBe('<b>[esc:60]</b>')
    })
  })

  describe('resolveTapAnnotation (#789)', () => {
    const escapeLabel = (s: string) => s
    const now = new Date('2026-07-11T09:30:00Z')
    const base = {
      escapeLabel,
      now,
      parseMode: 'html' as const,
      singleUse: true,
      sourceText: 'Deploy to prod?',
      label: 'Approve',
    }

    it('annotates when the agent default is ON and the keyboard is single-use', () => {
      const r = resolveTapAnnotation({
        ...base,
        config: { enabled: true, timezone: 'utc' },
      })
      expect(r.annotate).toBe(true)
      expect(r.text).toBe('Deploy to prod?\n\n✅ You chose: <b>Approve</b> · 09:30')
      expect(r.warnParseMode).toBe(false)
      expect(r.warnSingleUseMismatch).toBe(false)
    })

    it('per-message inline_keyboard_confirm:false overrides an ON agent default', () => {
      const r = resolveTapAnnotation({
        ...base,
        config: { enabled: true, timezone: 'utc' },
        perMessageOverride: false,
      })
      expect(r.annotate).toBe(false)
      expect(r.text).toBeUndefined()
      expect(r.warnParseMode).toBe(false)
    })

    it('per-message inline_keyboard_confirm:true fires even when the default is OFF', () => {
      const r = resolveTapAnnotation({
        ...base,
        config: { enabled: false, timezone: 'utc' },
        perMessageOverride: true,
      })
      expect(r.annotate).toBe(true)
      expect(r.text).toBe('Deploy to prod?\n\n✅ You chose: <b>Approve</b> · 09:30')
    })

    it('replaces (not duplicates) a prior annotation on retap', () => {
      const priorBody = 'Deploy to prod?\n\n✅ You chose: <b>Hold</b> · 08:15'
      const r = resolveTapAnnotation({
        ...base,
        sourceText: priorBody,
        config: { enabled: true, timezone: 'utc' },
      })
      expect(r.annotate).toBe(true)
      expect(r.text).toBe('Deploy to prod?\n\n✅ You chose: <b>Approve</b> · 09:30')
      // Exactly one confirmation line survives.
      expect((r.text!.match(/✅ You chose:/g) ?? []).length).toBe(1)
    })

    it('strips a prior annotation whose label carried a stray newline (dotAll)', () => {
      const priorBody = 'Deploy to prod?\n\n✅ You chose: <b>Hold\nnow</b> · 08:15'
      const r = resolveTapAnnotation({
        ...base,
        sourceText: priorBody,
        config: { enabled: true, timezone: 'utc' },
      })
      expect(r.text).toBe('Deploy to prod?\n\n✅ You chose: <b>Approve</b> · 09:30')
    })

    it('skips annotation + flags parseMode warning on a non-html parse mode', () => {
      const r = resolveTapAnnotation({
        ...base,
        parseMode: 'markdownv2',
        config: { enabled: true, timezone: 'utc' },
      })
      expect(r.annotate).toBe(false)
      expect(r.warnParseMode).toBe(true)
    })

    it('never annotates a re-tappable (single_use:false) keyboard, flags mismatch', () => {
      const r = resolveTapAnnotation({
        ...base,
        singleUse: false,
        config: { enabled: true, timezone: 'utc' },
      })
      expect(r.annotate).toBe(false)
      expect(r.warnSingleUseMismatch).toBe(true)
      // No parseMode warning — we bail on single-use before the parse gate.
      expect(r.warnParseMode).toBe(false)
    })

    it('skips annotation when the source message has no text (caption-only)', () => {
      const r = resolveTapAnnotation({
        ...base,
        sourceText: undefined,
        config: { enabled: true, timezone: 'utc' },
      })
      expect(r.annotate).toBe(false)
      expect(r.warnParseMode).toBe(false)
    })
  })

  // ─── real HTML-entity escaping (#789 round-2 blocker) ────────────────────
  describe('escapeHtmlEntities + real-escaper wiring (#789)', () => {
    const now = new Date('2026-07-11T09:30:00Z')

    it('escapes exactly &, <, > — and nothing else (no markdown garbling)', () => {
      expect(escapeHtmlEntities('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
      // The GFM escaper would turn Do_it into Do\_it; the HTML escaper must not.
      expect(escapeHtmlEntities('Do_it `now` *bold*')).toBe('Do_it `now` *bold*')
      // & first: no double-escaping of produced entities.
      expect(escapeHtmlEntities('&lt;')).toBe('&amp;lt;')
    })

    it('is the DEFAULT escaper: labels with & < > render Telegram-parseable HTML', () => {
      const line = buildButtonConfirmation({
        template: '✅ You chose: {label} · {time}',
        label: 'Yes & <no>',
        timezone: 'utc',
        now,
      })
      expect(line).toBe('✅ You chose: <b>Yes &amp; &lt;no&gt;</b> · 09:30')
    })

    it('escapes the BASE source text too, not just the label', () => {
      const r = resolveTapAnnotation({
        parseMode: 'html',
        singleUse: true,
        sourceText: 'Deploy <feature/x> & friends?',
        label: 'Approve',
        config: { enabled: true, timezone: 'utc' },
        now,
      })
      expect(r.annotate).toBe(true)
      expect(r.text).toBe(
        'Deploy &lt;feature/x&gt; &amp; friends?\n\n✅ You chose: <b>Approve</b> · 09:30',
      )
      // Only the tags WE emit remain — no raw user-supplied angle brackets.
      expect(r.text!.replace(/<\/?b>/g, '')).not.toMatch(/[<>]/)
    })

    it('retap dedup matches the annotation as Telegram returns it (plain text, no <b> tags)', () => {
      // Telegram's message.text is plain text — entities are separate — so a
      // real retap sees the prior line WITHOUT tags.
      const r = resolveTapAnnotation({
        parseMode: 'html',
        singleUse: true,
        sourceText: 'Deploy to prod?\n\n✅ You chose: Hold · 08:15',
        label: 'Approve',
        config: { enabled: true, timezone: 'utc' },
        now,
      })
      expect(r.text).toBe('Deploy to prod?\n\n✅ You chose: <b>Approve</b> · 09:30')
      expect((r.text!.match(/✅ You chose:/g) ?? []).length).toBe(1)
    })

    it('String.replace special patterns ($&, $\') in labels are inert', () => {
      const line = buildButtonConfirmation({
        template: '✅ You chose: {label} · {time}',
        label: "$& $' $` $1",
        timezone: 'utc',
        now,
      })
      expect(line).toBe("✅ You chose: <b>$&amp; $' $` $1</b> · 09:30")
    })
  })

  // ─── keyboard-strip fallback when the annotate edit rejects (#789) ───────
  describe('applyTapAnnotationEdit (#789)', () => {
    it('annotates via a single editMessageText call on success', async () => {
      const calls: string[] = []
      const outcome = await applyTapAnnotationEdit(
        {
          editMessageText: async (text, other) => {
            calls.push(`text:${text}:${other.parse_mode}`)
            expect(other.reply_markup).toEqual({ inline_keyboard: [] })
          },
          editMessageReplyMarkup: async () => {
            calls.push('markup')
          },
        },
        'body\n\n✅ You chose: <b>Approve</b> · 09:30',
      )
      expect(outcome).toBe('annotated')
      expect(calls).toEqual(['text:body\n\n✅ You chose: <b>Approve</b> · 09:30:HTML'])
    })

    it('strips the keyboard via editMessageReplyMarkup when the edit rejects', async () => {
      const calls: unknown[] = []
      const outcome = await applyTapAnnotationEdit(
        {
          editMessageText: async () => {
            throw new Error('400: Bad Request: can\'t parse entities')
          },
          editMessageReplyMarkup: async other => {
            calls.push(other)
          },
        },
        'whatever',
      )
      expect(outcome).toBe('stripped-fallback')
      // Single-use protection held: the keyboard WAS stripped.
      expect(calls).toEqual([{ reply_markup: { inline_keyboard: [] } }])
    })

    it('reports failed (without throwing) when both edits reject', async () => {
      const outcome = await applyTapAnnotationEdit(
        {
          editMessageText: async () => {
            throw new Error('400')
          },
          editMessageReplyMarkup: async () => {
            throw new Error('400')
          },
        },
        'whatever',
      )
      expect(outcome).toBe('failed')
    })
  })

  // ─── #3148 fast-follow: agent-authored keyboard secret scrub ──────────────
  //
  // wrapAgentCallbacks rewrites ONLY callback_data; the visible `text` label,
  // the `ack_text` toast, and any `copy_text.text` clipboard payload passed
  // through VERBATIM before this fix — so a secret an agent placed in any of
  // them transmitted to Telegram unmasked and resurfaced on tap (echo, toast,
  // "✅ You chose" annotation). redactAgentKeyboard masks those three fields at
  // the outbound boundary using the SAME redact() the reply body uses, while
  // leaving the routing key (callback_data) exact.
  describe('redactAgentKeyboard (#3148 fast-follow)', () => {
    // Assemble the fixture at runtime so this source file never carries a
    // contiguous token that trips push-protection / secretlint (CLAUDE.md).
    const GITHUB_PAT = 'ghp' + '_' + '16C7e42F292c6912E7710c838347Ae178B4a'

    it('masks a secret in a button `text` label in the sent payload (real redact)', () => {
      const raw = [
        [{ text: `Use ${GITHUB_PAT}`, callback_data: 'use_token' }],
      ]
      // Mirror the gateway pipeline: redact BEFORE wrap.
      const wrapped = wrapAgentCallbacks(redactAgentKeyboard(raw, redact))
      const btn = wrapped[0]![0]!
      // OUTCOME: the label bytes actually shipped to Telegram carry no secret.
      expect(btn.text as string).not.toContain(GITHUB_PAT)
      expect(btn.text as string).toContain('[REDACTED')
      expect((btn.text as string).length).toBeGreaterThan(0)
      // Routing key untouched (only the agent: namespace prefix was added).
      expect(btn.callback_data).toBe(`${AGENT_CALLBACK_PREFIX}use_token`)
    })

    it('masks a secret in `ack_text` in the extracted per-button meta (real redact)', () => {
      const raw = [
        [{ text: 'Deploy', callback_data: 'deploy', ack_text: `token ${GITHUB_PAT}` }],
      ]
      // Mirror the gateway: extract meta from the REDACTED keyboard so the
      // stashed toast (shown via answerCallbackQuery on tap) is masked.
      const meta = extractAgentButtonMeta(redactAgentKeyboard(raw, redact))
      const ack = meta.get('deploy')!.ack_text!
      expect(ack).not.toContain(GITHUB_PAT)
      expect(ack).toContain('[REDACTED')
    })

    it('masks a secret in `copy_text.text` clipboard payload (real redact)', () => {
      const raw = [
        [{ text: 'Copy token', callback_data: 'copy', copy_text: { text: GITHUB_PAT } }],
      ]
      const [[btn]] = redactAgentKeyboard(raw, redact)
      const ct = (btn as { copy_text: { text: string } }).copy_text.text
      expect(ct).not.toContain(GITHUB_PAT)
      expect(ct).toContain('[REDACTED')
    })

    it('never empties a label that is ENTIRELY a secret (non-empty invariant)', () => {
      const raw = [[{ text: GITHUB_PAT, callback_data: 'x' }]]
      const [[btn]] = redactAgentKeyboard(raw, redact)
      expect((btn.text as string).length).toBeGreaterThan(0)
      expect(btn.text as string).not.toContain(GITHUB_PAT)
    })

    it('leaves a legit (secret-free) label unchanged', () => {
      const raw = [
        [{ text: 'Approve PR #547', callback_data: 'approve', ack_text: 'Approved ✓' }],
        [{ text: 'Hold', callback_data: 'hold' }],
      ]
      const out = redactAgentKeyboard(raw, redact)
      expect(out[0]![0]!.text).toBe('Approve PR #547')
      expect(out[0]![0]!.ack_text).toBe('Approved ✓')
      expect(out[1]![0]!.text).toBe('Hold')
    })

    it('NEVER passes callback_data through the redactor (routing key stays exact)', () => {
      // A fake redactor that mangles everything it sees; anything the routing
      // key touched would be corrupted. Proves copy_text/url/callback_data are
      // handled correctly by field, not blanket-scrubbed.
      const seen: string[] = []
      const mangle = (s: string) => {
        seen.push(s)
        return `X${s}X`
      }
      const raw = [
        [
          { text: 'Label', callback_data: 'route_key_do_not_touch', ack_text: 'toast' },
          { text: 'Link', url: 'https://example.com/keep' },
          { text: 'Clip', callback_data: 'c2', copy_text: { text: 'secret-clip' } },
        ],
      ]
      const out = redactAgentKeyboard(raw, mangle)
      // callback_data + url are byte-exact.
      expect(out[0]![0]!.callback_data).toBe('route_key_do_not_touch')
      expect(out[0]![1]!.url).toBe('https://example.com/keep')
      expect(out[0]![2]!.callback_data).toBe('c2')
      // Only free-text fields were routed through the redactor.
      expect(out[0]![0]!.text).toBe('XLabelX')
      expect(out[0]![0]!.ack_text).toBe('XtoastX')
      expect((out[0]![2]! as { copy_text: { text: string } }).copy_text.text).toBe('Xsecret-clipX')
      expect(seen).toEqual(['Label', 'toast', 'Link', 'Clip', 'secret-clip'])
      expect(seen).not.toContain('route_key_do_not_touch')
      expect(seen).not.toContain('https://example.com/keep')
      expect(seen).not.toContain('c2')
    })

    it('preserves keyboard structure, row/column order, and does not mutate input', () => {
      const raw = [
        [{ text: 'A', callback_data: 'a' }, { text: 'B', callback_data: 'b' }],
        [{ text: 'C', callback_data: 'c' }],
      ]
      const out = redactAgentKeyboard(raw, (s) => s)
      expect(out.map((r) => r.map((b) => b.callback_data))).toEqual([
        ['a', 'b'],
        ['c'],
      ])
      // Fresh objects — input untouched.
      expect(out[0]![0]).not.toBe(raw[0]![0])
      expect(raw[0]![0]!.text).toBe('A')
    })
  })
})
