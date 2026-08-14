/**
 * Unit tests for normalizeForSpeech — the speech-normalization pass applied
 * to a reply BEFORE it is synthesized to a voice note. Covers every case the
 * operator reported (tilde, asterisks, backticks, headings, links, code
 * fences) plus the documented behavioural choices.
 */

import { describe, it, expect } from 'bun:test'
import { normalizeForSpeech, decodeHtmlEntities } from '../voice-normalize-text.js'

describe('normalizeForSpeech — reported markdown/symbol cases', () => {
  it('drops stray tildes (never spoken as "tilde")', () => {
    expect(normalizeForSpeech('It costs ~5 dollars')).toBe('It costs 5 dollars')
    expect(normalizeForSpeech('done ~ ok')).toBe('done ok')
  })

  it('strips bold/italic asterisks and underscores, keeping the words', () => {
    expect(normalizeForSpeech('This is **bold** text')).toBe('This is bold text')
    expect(normalizeForSpeech('This is *italic* text')).toBe('This is italic text')
    expect(normalizeForSpeech('This is _emphasis_ text')).toBe('This is emphasis text')
    expect(normalizeForSpeech('***all*** three')).toBe('all three')
  })

  it('strips strikethrough ~~text~~ to plain text', () => {
    expect(normalizeForSpeech('~~gone~~ kept')).toBe('gone kept')
  })

  it('removes backticks from inline code but keeps the content', () => {
    expect(normalizeForSpeech('run `npm test` now')).toBe('run npm test now')
  })

  it('strips headings markers and gives the heading a spoken full stop', () => {
    // The heading is its own spoken sentence — without the terminator the
    // newline-collapse ran the heading straight into the body text.
    expect(normalizeForSpeech('# Summary\nAll good')).toBe('Summary. All good')
    expect(normalizeForSpeech('### Deep heading')).toBe('Deep heading.')
  })

  it('speaks link text and drops the URL', () => {
    expect(normalizeForSpeech('see [the docs](https://example.com/x) here')).toBe(
      'see the docs here',
    )
  })

  it('drops a fenced code block and leaves a spoken placeholder', () => {
    const input = 'Here is code:\n```js\nconst x = 1\nconsole.log(x)\n```\nDone.'
    const out = normalizeForSpeech(input)
    expect(out).toContain('code block omitted')
    expect(out).not.toContain('const x')
    expect(out).not.toContain('```')
    expect(out).toContain('Done.')
  })
})

describe('normalizeForSpeech — additional structures', () => {
  it('converts list bullets and numbers to prose pauses', () => {
    const out = normalizeForSpeech('Steps:\n- first\n- second\n1. third')
    expect(out).not.toMatch(/[-*+]\s/)
    expect(out).not.toMatch(/^\d+\./)
    expect(out).toContain('first')
    expect(out).toContain('second')
    expect(out).toContain('third')
  })

  it('strips blockquote markers', () => {
    expect(normalizeForSpeech('> quoted line')).toBe('quoted line')
  })

  it('turns tables into prose (no pipes or separator rows)', () => {
    const table = '| A | B |\n| --- | --- |\n| 1 | 2 |'
    const out = normalizeForSpeech(table)
    expect(out).not.toContain('|')
    expect(out).not.toContain('---')
    expect(out).toContain('A')
    expect(out).toContain('B')
  })

  it('converts arrows to the word "to"', () => {
    expect(normalizeForSpeech('build -> deploy')).toBe('build to deploy')
    expect(normalizeForSpeech('a => b')).toBe('a to b')
    expect(normalizeForSpeech('x → y')).toBe('x to y')
  })

  it('replaces bare and autolink URLs with "a link"', () => {
    expect(normalizeForSpeech('go to https://example.com now')).toBe('go to a link now')
    expect(normalizeForSpeech('go to <https://example.com>')).toBe('go to a link')
  })

  it('drops images to their alt text', () => {
    expect(normalizeForSpeech('![a cat](x.png) sits')).toBe('a cat sits')
  })

  it('collapses newlines and whitespace into sentence flow', () => {
    expect(normalizeForSpeech('Line one.\n\nLine two.')).toBe('Line one. Line two.')
    expect(normalizeForSpeech('a   b\nc')).toBe('a b c')
  })

  it('expands a minimal, safe set of abbreviations', () => {
    expect(normalizeForSpeech('use it, e.g. here')).toBe('use it, for example, here')
    expect(normalizeForSpeech('the tool, i.e. the interface')).toBe(
      'the tool, that is, the interface',
    )
    expect(normalizeForSpeech('cats, dogs, etc.')).toBe('cats, dogs, and so on')
  })

  it('collapses excessive punctuation', () => {
    expect(normalizeForSpeech('really?!?!')).toBe('really!')
    expect(normalizeForSpeech('wow!!!')).toBe('wow!')
  })
})

describe('normalizeForSpeech — emoji & pictographs', () => {
  it('strips emoji and collapses the resulting whitespace', () => {
    expect(normalizeForSpeech('done 🚀 shipping')).toBe('done shipping')
    expect(normalizeForSpeech('great 👍🏽 job')).toBe('great job')
    expect(normalizeForSpeech('🎉')).toBe('')
  })

  it('drops :shortcode: emoji forms', () => {
    expect(normalizeForSpeech('nice :rocket: work')).toBe('nice work')
  })

  // Digit-bodied shortcodes are real. A letter-only body left them in the
  // text AND glued them to the previous word ("Nice:100: work").
  it('drops a DIGIT-bodied :shortcode: without eating the space', () => {
    expect(normalizeForSpeech('Nice :100: work')).toBe('Nice work')
    expect(normalizeForSpeech('a :8ball: b')).toBe('a b')
    expect(normalizeForSpeech('a :1st_place_medal: b')).toBe('a b')
  })

  it('the digit-bodied form still cannot eat a timestamp colon', () => {
    expect(normalizeForSpeech('Ran at 14:30:46 ok')).toBe('Ran at 14:30:46 ok')
  })

  it('leaves ordinary colon usage alone', () => {
    expect(normalizeForSpeech('note: this is fine')).toBe('note: this is fine')
  })
})

describe('normalizeForSpeech — numbers, units & symbols', () => {
  it('speaks percent', () => {
    expect(normalizeForSpeech('up 20% today')).toBe('up 20 percent today')
  })

  it('speaks currency amounts', () => {
    expect(normalizeForSpeech('costs $5')).toBe('costs five dollars')
    expect(normalizeForSpeech('costs $5.50')).toBe('costs five dollars fifty')
    expect(normalizeForSpeech('just $1')).toBe('just one dollar')
  })

  it('speaks standalone & as "and"', () => {
    expect(normalizeForSpeech('cats & dogs')).toBe('cats and dogs')
    expect(normalizeForSpeech('R&D team')).toBe('R and D team')
  })

  it('speaks + between words as "plus" and = as "equals"', () => {
    expect(normalizeForSpeech('speed + power')).toBe('speed plus power')
    expect(normalizeForSpeech('x = y')).toBe('x equals y')
  })

  it('speaks × / x multipliers as "times"', () => {
    expect(normalizeForSpeech('12× faster')).toBe('twelve times faster')
    expect(normalizeForSpeech('a 12x speedup')).toBe('a twelve times speedup')
  })

  it('speaks temperature degrees', () => {
    expect(normalizeForSpeech('it is 30°C outside')).toBe(
      'it is 30 degrees outside',
    )
    expect(normalizeForSpeech('72°F')).toBe('72 degrees')
  })

  it('expands number + time/size unit suffixes', () => {
    expect(normalizeForSpeech('waited 2s')).toBe('waited two seconds')
    expect(normalizeForSpeech('took 500ms')).toBe('took five hundred milliseconds')
    expect(normalizeForSpeech('run 5m')).toBe('run five minutes')
    expect(normalizeForSpeech('run 5min')).toBe('run five minutes')
    expect(normalizeForSpeech('wait 2h')).toBe('wait two hours')
    expect(normalizeForSpeech('wait 2hr')).toBe('wait two hours')
    expect(normalizeForSpeech('in 3d')).toBe('in three days')
    expect(normalizeForSpeech('10kb file')).toBe('ten kilobytes file')
    expect(normalizeForSpeech('10KB file')).toBe('ten kilobytes file')
    expect(normalizeForSpeech('a 5MB image')).toBe('a five megabytes image')
    expect(normalizeForSpeech('a 2GB dump')).toBe('a two gigabytes dump')
    expect(normalizeForSpeech('1s ping')).toBe('one second ping')
  })

  it('expands the "k" thousands shorthand', () => {
    expect(normalizeForSpeech('100k users')).toBe('one hundred thousand users')
  })

  it('leaves number-glued-to-word identifiers alone', () => {
    expect(normalizeForSpeech('my5thing works')).toBe('my5thing works')
    expect(normalizeForSpeech('class5 room')).toBe('class5 room')
  })

  // Regression: unit-suffix lookbehind + case sensitivity. Corpus in
  // /tmp/claude-0/tts/corpus.json (1,679 samples of ALREADY-NORMALIZED
  // production output, not raw input): 146 samples already carry the
  // shipped mangle artifact this fix removes, 53 carry an unfixed decimal/
  // comma+unit token (see the "known gap" test below), and 61 samples
  // change under this fix. A decimal seconds value like "0.17s" was matched
  // by \b re-anchoring between the "." and the following digits, so "17s"
  // alone got read as "seventeen seconds" and split the decimal apart; and
  // the /i flag let a bare capital letter (money shorthand "5M", a memory
  // size "4G", a product name "4080S") match a single-letter unit
  // alternative it was never meant to.
  it('decimal seconds survive intact — no mid-decimal unit match', () => {
    expect(normalizeForSpeech('latency was 0.17s')).toBe('latency was 0.17s')
    expect(normalizeForSpeech('took 1.5s to load')).toBe('took 1.5s to load')
    expect(normalizeForSpeech('waited 2.25s')).toBe('waited 2.25s')
    expect(normalizeForSpeech('under 0.9s')).toBe('under 0.9s')
  })

  // KNOWN GAP (disclosed, not fixed in this hotfix — see the comment above
  // the unit-suffix regex in voice-normalize-text.ts): a decimal- or
  // comma-glued number+unit token is now left completely unexpanded (unit
  // unspoken) rather than mangled. Measured: samples carrying an unspoken
  // digit-adjacent unit go 65 → 122 across the corpus (61 samples change,
  // every one gaining an unspoken unit) — pinned here as the baseline a
  // future decimal-expansion pass should move.
  it('KNOWN GAP: decimal/comma-glued number+unit is left unexpanded, not mangled', () => {
    expect(normalizeForSpeech('free: 13.0 GB')).toBe('free: 13.0 GB')
    expect(normalizeForSpeech('weighs 89.5g')).toBe('weighs 89.5g')
    expect(normalizeForSpeech('ran for 27.5 s')).toBe('ran for 27.5 s')
    expect(normalizeForSpeech('paused 9.5 min')).toBe('paused 9.5 min')
  })

  // MINOR: comma leak — same defect class as the decimal lookbehind, closed
  // in the same lookbehind by also excluding `,`. Before this: "1,500s" →
  // "1,five hundred seconds", "12,000s" → "12,zero seconds", "1,024MB" →
  // "1,twenty-four megabytes". The lookbehind is adjacency-only so an
  // ordinary sentence comma ("wait, 5s") still expands correctly — only a
  // digit glued directly to the comma is blocked.
  it('comma-glued numbers are left unmangled; a sentence comma still expands', () => {
    expect(normalizeForSpeech('rate limited: 1,500s')).toBe('rate limited: 1,500s')
    expect(normalizeForSpeech('timeout after 12,000s')).toBe('timeout after 12,000s')
    expect(normalizeForSpeech('buffer is 1,024MB')).toBe('buffer is 1,024MB')
    expect(normalizeForSpeech('wait, 5s')).toBe('wait, five seconds')
  })

  it('whole-number seconds still expand: 90s → ninety seconds', () => {
    expect(normalizeForSpeech('done in 90s')).toBe('done in ninety seconds')
  })

  it('units unaffected by the case-sensitivity fix: 500ms, 5MB, 2GB', () => {
    expect(normalizeForSpeech('took 500ms')).toBe('took five hundred milliseconds')
    expect(normalizeForSpeech('a 5MB image')).toBe('a five megabytes image')
    expect(normalizeForSpeech('a 2GB dump')).toBe('a two gigabytes dump')
    expect(normalizeForSpeech('run 5m')).toBe('run five minutes')
  })

  it('bare capital M never reads as minutes (money shorthand, corpus)', () => {
    expect(normalizeForSpeech('Revenue was 5M this year')).toBe(
      'Revenue was 5M this year',
    )
    // Pre-existing quirk, not introduced or fixed here: the currency regex
    // consumes "$5" before the unit pass ever sees the dangling "M", so this
    // never read as "minutes" even on unpatched main — pin the ACTUAL output
    // instead of an assertion that can't fail in either direction.
    expect(normalizeForSpeech('raised $5M in the round')).toBe(
      'raised five dollarsM in the round',
    )
  })

  it('HTTP-status-shaped input adjacent to a capital letter is not read as a duration', () => {
    expect(normalizeForSpeech('a 503M error occurred')).toBe(
      'a 503M error occurred',
    )
    expect(normalizeForSpeech('status 503M')).toBe('status 503M')
  })

  // Corpus wins from the case-sensitivity split (22 samples improved fleet-
  // wide across both passes, 14 of them "G" memory sizes wrongly read via
  // pass 2 as GRAMS, plus an RTX "4080S" wrongly read as a duration).
  // Pass 1 has no "g" in its own UNIT_MAP, so these were already inert here
  // pre-fix; pinned to lock in the no-op and guard the composed pipeline
  // (see tts-normalize.test.ts for the pass-2 "grams"/"4080S" regression).
  it('single-letter units case-split: bare capitals stay untouched', () => {
    expect(normalizeForSpeech('done in 5S')).toBe('done in 5S')
    expect(normalizeForSpeech('wait 3H')).toBe('wait 3H')
    expect(normalizeForSpeech('ships in 10D')).toBe('ships in 10D')
    expect(normalizeForSpeech('bought a 4080S')).toBe('bought a 4080S')
  })
})

describe('normalizeForSpeech — abbreviations (phase 2)', () => {
  it('expands vs / approx / w/', () => {
    expect(normalizeForSpeech('cats vs dogs')).toBe('cats versus dogs')
    expect(normalizeForSpeech('cats vs. dogs')).toBe('cats versus dogs')
    expect(normalizeForSpeech('approx 10 items')).toBe('approximately 10 items')
    expect(normalizeForSpeech('tea w/ milk')).toBe('tea with milk')
  })
})

describe('normalizeForSpeech — acronyms', () => {
  it('spells curated initialisms letter-by-letter', () => {
    expect(normalizeForSpeech('the CI passed')).toBe('the C I passed')
    expect(normalizeForSpeech('open a PR')).toBe('open a P R')
    expect(normalizeForSpeech('call the API via HTTP')).toBe(
      'call the A P I via H T T P',
    )
    expect(normalizeForSpeech('GPU and CPU load')).toBe('G P U and C P U load')
    expect(normalizeForSpeech('parse the JSON')).toBe('parse the J S O N')
  })

  it('leaves word-style acronyms and unknown caps alone', () => {
    expect(normalizeForSpeech('NASA launch')).toBe('NASA launch')
    expect(normalizeForSpeech('the FBI report')).toBe('the FBI report')
  })

  it('does not touch caps inside a larger word', () => {
    expect(normalizeForSpeech('myAPIkey stays')).toBe('myAPIkey stays')
  })
})

describe('normalizeForSpeech — times & dates', () => {
  it('speaks clock times', () => {
    expect(normalizeForSpeech('meet at 12:45')).toBe('meet at twelve forty-five')
    expect(normalizeForSpeech('at 09:05')).toBe('at nine oh five')
    expect(normalizeForSpeech('at 14:00')).toBe("at fourteen o'clock")
  })

  it('speaks ISO dates', () => {
    expect(normalizeForSpeech('on 2026-07-01 we ship')).toBe(
      'on July first two thousand twenty-six we ship',
    )
    expect(normalizeForSpeech('2026-12-25')).toBe(
      'December twenty-fifth two thousand twenty-six',
    )
  })
})

describe('normalizeForSpeech — conservative, does not mangle real words', () => {
  it('leaves plain prose untouched', () => {
    expect(normalizeForSpeech('The quick brown fox jumps.')).toBe(
      'The quick brown fox jumps.',
    )
  })

  it('leaves lowercase day/word tokens and a symbol-free sentence alone', () => {
    expect(normalizeForSpeech('see you wednesday afternoon')).toBe(
      'see you wednesday afternoon',
    )
    expect(normalizeForSpeech('The report covers three main areas.')).toBe(
      'The report covers three main areas.',
    )
  })

  it('preserves an underscore inside an identifier-like word', () => {
    // A lone mid-word underscore is not emphasis; keep the token intact.
    expect(normalizeForSpeech('the my_var name')).toBe('the my_var name')
  })

  it('returns empty for empty/whitespace input', () => {
    expect(normalizeForSpeech('')).toBe('')
    expect(normalizeForSpeech('   \n  ')).toBe('')
  })
})

describe('normalizeForSpeech — backslash escapes & HTML entities (voice trash)', () => {
  it('strips a literal backslash-b (\\b) so it is never spoken as "backslash b"', () => {
    // The exact operator report: the regex/escape "\b" was read as "slash b".
    const out = normalizeForSpeech('the regex \\b word boundary')
    expect(out).toBe('the regex b word boundary')
    expect(out).not.toContain('\\')
  })

  it('unescapes MarkdownV2 punctuation escapes without leaving backslashes', () => {
    expect(normalizeForSpeech('done\\. next\\! wait\\-')).toBe('done. next! wait-')
    expect(normalizeForSpeech('a \\* b')).not.toContain('\\')
  })

  it('an escaped emphasis marker collapses to the inner word, not a backslash', () => {
    expect(normalizeForSpeech('Use \\*literal\\* here')).toBe('Use literal here')
  })

  it('drops a Windows-path-style backslash run (C:\\build)', () => {
    expect(normalizeForSpeech('path C:\\build\\out done')).toBe('path C:buildout done')
  })

  it('decodes HTML entities so &amp; / &lt; are not read as "amp" / "lt"', () => {
    expect(normalizeForSpeech('Tom &amp; Jerry')).toBe('Tom and Jerry')
    expect(normalizeForSpeech('5 &lt; 10 &gt; 3')).toBe('5 < 10 > 3')
    expect(normalizeForSpeech('it&#39;s here')).toBe("it's here")
  })

  it('produces clean plain speech for a rich mixed reply (end-to-end)', () => {
    const reply =
      '**Bold** and `code\\b` and a [label](https://example.com/x) ' +
      'with Tom &amp; Jerry and a regex \\b\\.'
    const out = normalizeForSpeech(reply)
    expect(out).not.toContain('\\')
    expect(out).not.toContain('`')
    expect(out).not.toContain('*')
    expect(out).not.toContain('&amp;')
    expect(out).not.toContain('example.com')
    expect(out).toContain('label')
    expect(out).toContain('Tom and Jerry')
  })

  it('is idempotent: a second pass finds no backslashes/entities to change', () => {
    const reply = 'a \\b and Tom &amp; Jerry \\. end'
    const once = normalizeForSpeech(reply)
    expect(normalizeForSpeech(once)).toBe(once)
  })
})

describe('normalizeForSpeech — review findings (fixpoint decode, metachar, nits)', () => {
  it('L2 parity: a double-encoded entity decodes to a fixpoint (depth-independent)', () => {
    // Single decode and double decode must land on the SAME spoken char so the
    // immediate voice-out and the lazy Listen tap never diverge.
    const single = normalizeForSpeech('&amp;amp;lt;')
    const doubled = normalizeForSpeech(normalizeForSpeech('&amp;amp;lt;'))
    expect(single).toBe('<')
    expect(doubled).toBe('<')
    expect(normalizeForSpeech('&amp;amp;amp;')).toBe('&')
  })

  it('L1: an entity that decodes to a line-leading metachar keeps a spoken form', () => {
    // &#35; → '#'. Naively re-fed to the heading stripper it would vanish; the
    // user escaped it on purpose, so it must survive as spoken "hash".
    expect(normalizeForSpeech('&#35; Heading')).toBe('hash Heading')
    expect(normalizeForSpeech('2 &#42; 3')).toBe('2 asterisk 3')
  })

  it('nit: a dangling trailing backslash is dropped, never spoken', () => {
    expect(normalizeForSpeech('ends here\\')).toBe('ends here')
    expect(normalizeForSpeech('ends here\\')).not.toContain('\\')
  })

  it('nit: &#92; decodes to a backslash which is then stripped (no trash)', () => {
    expect(normalizeForSpeech('X&#92;Y')).toBe('XY')
    expect(normalizeForSpeech('X&#92;Y')).not.toContain('\\')
  })

  it('fixpoint does not over-decode entity-less text (Q&A stays literal)', () => {
    expect(decodeHtmlEntities('Q&A test')).toBe('Q&A test')
  })
})

describe('normalizeForSpeech — list & heading pacing', () => {
  it('speaks a 4-bullet list as 4 separate sentences', () => {
    const out = normalizeForSpeech(
      'Here are the steps:\n' +
        '- Check the logs\n' +
        '- Restart the container\n' +
        '- Verify health\n' +
        '- Report back',
    )
    expect(out).toBe(
      'Here are the steps: Check the logs. Restart the container. ' +
        'Verify health. Report back.',
    )
    // Four sentence-terminated spoken units after the lead-in.
    const units = out
      .split(/(?<=[.:])\s+/)
      .filter((u) => u.trim().length > 0)
    expect(units).toEqual([
      'Here are the steps:',
      'Check the logs.',
      'Restart the container.',
      'Verify health.',
      'Report back.',
    ])
  })

  it('separates ordered-list items into sentences', () => {
    expect(normalizeForSpeech('1. first\n2. second\n3. third')).toBe(
      'first. second. third.',
    )
  })

  it('does not double punctuation when the item already ends in . ! or ?', () => {
    const out = normalizeForSpeech('- Done.\n- Really?\n- Ship it!')
    expect(out).toBe('Done. Really? Ship it!')
    expect(out).not.toContain('..')
    expect(out).not.toContain('. .')
    expect(out).not.toContain('?.')
    expect(out).not.toContain('!.')
  })

  it('terminates the line that introduces a list when it lacks punctuation', () => {
    expect(normalizeForSpeech('Steps\n- one\n- two')).toBe('Steps. one. two.')
  })

  it('does not chop a wrapped list item mid-clause', () => {
    expect(normalizeForSpeech('- a long item that\ncontinues here\n- second')).toBe(
      'a long item that continues here. second.',
    )
  })

  it('separates heading sections into sentences', () => {
    expect(normalizeForSpeech('# One\nbody one\n\n# Two\nbody two')).toBe(
      'One. body one. Two. body two',
    )
  })
})

describe('normalizeForSpeech — time guard (HH:MM:SS)', () => {
  it('leaves a full HH:MM:SS timestamp as digits rather than half-reading it', () => {
    expect(normalizeForSpeech('Done at 14:30:46 today')).toBe(
      'Done at 14:30:46 today',
    )
  })

  // `14:30:46` survives even an unguarded scan because `30` is not a legal
  // HH. These are the timestamps whose TAIL is itself a legal HH:MM — the
  // ones a missing lookbehind half-reads ("09:zero o'clock").
  it('leaves an on-the-hour timestamp alone (lookbehind guard)', () => {
    expect(normalizeForSpeech('t 09:00:00 z')).toBe('t 09:00:00 z')
    expect(normalizeForSpeech('t 12:00:15 z')).toBe('t 12:00:15 z')
    expect(normalizeForSpeech('t 01:02:03 y')).toBe('t 01:02:03 y')
  })

  it('still speaks a plain HH:MM clock time', () => {
    expect(normalizeForSpeech('Meeting at 14:30 today')).toBe(
      'Meeting at fourteen thirty today',
    )
    expect(normalizeForSpeech('at 9:05')).toBe("at nine oh five")
  })
})

describe('normalizeForSpeech — thousands separators', () => {
  it('speaks $1,000 as one thousand dollars (not "one dollar,000")', () => {
    expect(normalizeForSpeech('It costs $1,000 up front')).toBe(
      'It costs one thousand dollars up front',
    )
  })

  it('speaks a millions-scale amount', () => {
    expect(normalizeForSpeech('Budget $1,234,567 total')).toBe(
      'Budget one million two hundred thirty-four thousand five hundred ' +
        'sixty-seven dollars total',
    )
  })

  it('does not regress plain currency or ordinary comma prose', () => {
    expect(normalizeForSpeech('It costs $500')).toBe('It costs five hundred dollars')
    expect(normalizeForSpeech('$5.50 each')).toBe('five dollars fifty each')
    expect(normalizeForSpeech('a, b, 3')).toBe('a, b, 3')
    expect(normalizeForSpeech('We saw 12,500 requests')).toBe(
      'We saw 12,500 requests',
    )
  })

  // The thousands guard must not mistake an ordinary SENTENCE comma for a
  // partial digit group — that left a raw "$" unspoken.
  it('still speaks currency followed by a sentence comma', () => {
    expect(normalizeForSpeech('It costs $500, plus tax')).toBe(
      'It costs five hundred dollars, plus tax',
    )
    expect(normalizeForSpeech('We paid $1,000, then left')).toBe(
      'We paid one thousand dollars, then left',
    )
  })

  it('still bails on a genuinely malformed amount', () => {
    expect(normalizeForSpeech('$1,00 partial')).toBe('$1,00 partial')
    expect(normalizeForSpeech('$5.203 odd')).toBe('$5.203 odd')
  })
})

describe('normalizeForSpeech — file paths', () => {
  it('speaks an absolute path as its last segment', () => {
    expect(normalizeForSpeech('Check /var/log/syslog now')).toBe(
      'Check syslog now',
    )
  })

  it('handles ~/ and relative multi-segment paths', () => {
    expect(normalizeForSpeech('Edit ~/.config/nvim/init.lua please')).toBe(
      'Edit init.lua please',
    )
    expect(normalizeForSpeech('See src/telegram-plugin/gateway.ts')).toBe(
      'See gateway.ts',
    )
  })

  it('says "a path" when the final segment is unspeakable noise', () => {
    expect(normalizeForSpeech('Path /tmp/a1b2c3d4e5f6a7b8 there')).toBe(
      'Path a path there',
    )
  })

  it('leaves a single-slash word/word pair for the downstream slash pass', () => {
    expect(normalizeForSpeech('and/or maybe')).toBe('and/or maybe')
  })

  it('does not treat an all-numeric date as a path', () => {
    expect(normalizeForSpeech('the date 12/25/2026 works')).toBe(
      'the date 12/25/2026 works',
    )
  })

  // "Two or more slashes ⇒ path" is false in English. Without a path-ish
  // anchor the pass DELETES words from ordinary prose ("yes/no/maybe" →
  // "maybe"). Each of these must survive verbatim for the downstream
  // "word slash word" pass to speak.
  it('never swallows a multi-slash PROSE run (no path anchor)', () => {
    expect(normalizeForSpeech('yes/no/maybe')).toBe('yes/no/maybe')
    expect(normalizeForSpeech('read/write/exec perms')).toBe(
      'read/write/exec perms',
    )
    expect(normalizeForSpeech('he/she/they pronouns')).toBe(
      'he/she/they pronouns',
    )
    expect(normalizeForSpeech('a client/server/proxy split')).toBe(
      'a client/server/proxy split',
    )
    expect(normalizeForSpeech('reading input/output/error')).toBe(
      'reading input/output/error',
    )
    expect(normalizeForSpeech('tests in unit/integration/e2e are green')).toBe(
      'tests in unit/integration/e2e are green',
    )
  })
})

describe('normalizeForSpeech — extended acronym set', () => {
  it('spells the newly-added initialisms letter-by-letter', () => {
    expect(normalizeForSpeech('use HTTPS not HTTP')).toBe('use H T T P S not H T T P')
    expect(normalizeForSpeech('over SSH via DNS')).toBe('over S S H via D N S')
    expect(normalizeForSpeech('the CLI on AWS at UTC')).toBe(
      'the C L I on A W S at U T C',
    )
    expect(normalizeForSpeech('MCP PDF VM LLM YAML RAM USB ID OK')).toBe(
      'M C P P D F V M L L M Y A M L R A M U S B I D O K',
    )
  })

  it('still leaves word-style all-caps tokens alone', () => {
    expect(normalizeForSpeech('NASA ALWAYS SHOUTING')).toBe('NASA ALWAYS SHOUTING')
  })
})
