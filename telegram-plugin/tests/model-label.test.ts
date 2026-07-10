import { describe, it, expect } from 'vitest'
import { formatModelLabel, isModelSentinel } from '../model-label.js'

describe('isModelSentinel', () => {
  it('flags synthetic / placeholder values starting with "<"', () => {
    expect(isModelSentinel('<synthetic>')).toBe(true)
    expect(isModelSentinel('<compact>')).toBe(true)
  })

  it('flags empty / whitespace / non-string values', () => {
    expect(isModelSentinel('')).toBe(true)
    expect(isModelSentinel('   ')).toBe(true)
    expect(isModelSentinel(undefined)).toBe(true)
    expect(isModelSentinel(null)).toBe(true)
    expect(isModelSentinel(42)).toBe(true)
  })

  it('flags junk that is not shaped like a model id', () => {
    expect(isModelSentinel('not a model')).toBe(true) // whitespace
    expect(isModelSentinel('!!!')).toBe(true) // leading punctuation
  })

  it('accepts real resolved model ids', () => {
    expect(isModelSentinel('claude-opus-4-8')).toBe(false)
    expect(isModelSentinel('claude-haiku-4-5-20251001')).toBe(false)
    expect(isModelSentinel('sr-glm-5')).toBe(false)
    expect(isModelSentinel('sr-gpt-5.5')).toBe(false)
  })
})

describe('formatModelLabel', () => {
  it('renders the friendly short form for claude models', () => {
    expect(formatModelLabel('claude-opus-4-8')).toBe('opus 4.8')
    expect(formatModelLabel('claude-sonnet-5')).toBe('sonnet 5')
  })

  it('drops a trailing YYYYMMDD date stamp', () => {
    expect(formatModelLabel('claude-haiku-4-5-20251001')).toBe('haiku 4.5')
    expect(formatModelLabel('claude-opus-4-8-20260115')).toBe('opus 4.8')
  })

  it('shows sr-* ids verbatim', () => {
    expect(formatModelLabel('sr-glm-5')).toBe('sr-glm-5')
    expect(formatModelLabel('sr-gpt-5.5')).toBe('sr-gpt-5.5')
    expect(formatModelLabel('sr-gemini-2.5-pro')).toBe('sr-gemini-2.5-pro')
  })

  it('returns null for sentinels and absent values (caller omits the field)', () => {
    expect(formatModelLabel('<synthetic>')).toBeNull()
    expect(formatModelLabel('')).toBeNull()
    expect(formatModelLabel(null)).toBeNull()
    expect(formatModelLabel(undefined)).toBeNull()
    expect(formatModelLabel('has spaces')).toBeNull()
  })

  it('shows unknown but model-shaped ids verbatim', () => {
    expect(formatModelLabel('gpt-5')).toBe('gpt-5')
    expect(formatModelLabel('opus')).toBe('opus')
  })

  it('handles a claude id with only a family segment', () => {
    expect(formatModelLabel('claude-opus')).toBe('opus')
  })
})
