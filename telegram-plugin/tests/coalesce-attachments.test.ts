/**
 * Unit tests for the A2 multi-attachment helpers
 * (telegram-plugin/gateway/coalesce-attachments.ts).
 *
 * These pin the pure pieces of the multi-attachment fold-in that live
 * outside gateway.ts so they can be exercised without loadAccess()/IPC:
 *   1. resolveCoalesceMaxAttachments — the runtime cap default (10).
 *   2. splitCoalescedAttachments — primary + capped extras, arrival order.
 *   3. buildExtraAttachmentMeta — numbered meta fields starting at _2.
 *
 * A cap of 1 reproduces the historical single-attachment shape: primary
 * only, no extras, no numbered meta.
 */

import { describe, expect, it } from 'vitest'
import {
  splitCoalescedAttachments,
  buildExtraAttachmentMeta,
  resolveCoalesceMaxAttachments,
  DEFAULT_MAX_ATTACHMENTS,
  type ResolvedExtraAttachment,
} from '../gateway/coalesce-attachments.js'

describe('resolveCoalesceMaxAttachments (default 10 = full album)', () => {
  it('defaults to 10 when unset', () => {
    expect(resolveCoalesceMaxAttachments(undefined)).toBe(10)
    expect(DEFAULT_MAX_ATTACHMENTS).toBe(10)
  })
  it('honours an explicit operator cap', () => {
    expect(resolveCoalesceMaxAttachments(1)).toBe(1)
    expect(resolveCoalesceMaxAttachments(25)).toBe(25)
  })
  it('floors a 0 / negative cap at 1 (never strips the only attachment)', () => {
    expect(resolveCoalesceMaxAttachments(0)).toBe(1)
    expect(resolveCoalesceMaxAttachments(-5)).toBe(1)
  })
})

interface Entry {
  text: string
  att?: string
}

const has = (e: Entry): boolean => e.att != null

describe('splitCoalescedAttachments', () => {
  it('cap 1: keeps only the first attachment as primary, no extras', () => {
    const entries: Entry[] = [
      { text: 'a', att: 'photo-1' },
      { text: 'b', att: 'photo-2' },
    ]
    const { primary, extras } = splitCoalescedAttachments(entries, has, 1)
    expect(primary).toEqual({ text: 'a', att: 'photo-1' })
    expect(extras).toEqual([])
  })

  it('picks the FIRST attachment-bearing entry as primary even when text-only entries precede it', () => {
    const entries: Entry[] = [
      { text: 'look' },
      { text: 'at this', att: 'photo-1' },
      { text: 'and this', att: 'photo-2' },
    ]
    const { primary, extras } = splitCoalescedAttachments(entries, has, 3)
    expect(primary?.att).toBe('photo-1')
    expect(extras.map((e) => e.att)).toEqual(['photo-2'])
  })

  it('preserves arrival order of extras', () => {
    const entries: Entry[] = [
      { text: '1', att: 'a' },
      { text: '2', att: 'b' },
      { text: '3', att: 'c' },
    ]
    const { primary, extras } = splitCoalescedAttachments(entries, has, 5)
    expect(primary?.att).toBe('a')
    expect(extras.map((e) => e.att)).toEqual(['b', 'c'])
  })

  it('caps extras at maxAttachments (overflow dropped here; bypassed upstream)', () => {
    const entries: Entry[] = [
      { text: '1', att: 'a' },
      { text: '2', att: 'b' },
      { text: '3', att: 'c' },
      { text: '4', att: 'd' },
    ]
    const { primary, extras } = splitCoalescedAttachments(entries, has, 2)
    expect(primary?.att).toBe('a')
    expect(extras.map((e) => e.att)).toEqual(['b']) // total = cap of 2
  })

  it('returns undefined primary when no entry carries an attachment', () => {
    const entries: Entry[] = [{ text: 'just' }, { text: 'text' }]
    const { primary, extras } = splitCoalescedAttachments(entries, has, 3)
    expect(primary).toBeUndefined()
    expect(extras).toEqual([])
  })

  it('floors a cap of 0 / negative at 1 so the only attachment is never stripped', () => {
    const entries: Entry[] = [{ text: '1', att: 'a' }, { text: '2', att: 'b' }]
    expect(splitCoalescedAttachments(entries, has, 0).primary?.att).toBe('a')
    expect(splitCoalescedAttachments(entries, has, -5).primary?.att).toBe('a')
    expect(splitCoalescedAttachments(entries, has, 0).extras).toEqual([])
  })
})

describe('buildExtraAttachmentMeta', () => {
  it('returns an empty object for no extras (default single-attachment turn)', () => {
    expect(buildExtraAttachmentMeta([])).toEqual({})
  })

  it('numbers a single photo extra as _2', () => {
    const resolved: ResolvedExtraAttachment[] = [{ imagePath: '/inbox/p2.jpg' }]
    expect(buildExtraAttachmentMeta(resolved)).toEqual({ image_path_2: '/inbox/p2.jpg' })
  })

  it('numbers multiple extras incrementally from _2', () => {
    const resolved: ResolvedExtraAttachment[] = [
      { imagePath: '/inbox/p2.jpg' },
      { imagePath: '/inbox/p3.jpg' },
    ]
    expect(buildExtraAttachmentMeta(resolved)).toEqual({
      image_path_2: '/inbox/p2.jpg',
      image_path_3: '/inbox/p3.jpg',
    })
  })

  it('emits full attachment metadata fields for a document extra', () => {
    const resolved: ResolvedExtraAttachment[] = [
      {
        attachment: {
          kind: 'document',
          file_id: 'FID2',
          size: 1234,
          mime: 'application/pdf',
          name: 'spec.pdf',
        },
      },
    ]
    expect(buildExtraAttachmentMeta(resolved)).toEqual({
      attachment_kind_2: 'document',
      attachment_file_id_2: 'FID2',
      attachment_size_2: '1234',
      attachment_mime_2: 'application/pdf',
      attachment_name_2: 'spec.pdf',
    })
  })

  it('omits optional metadata fields that are absent', () => {
    const resolved: ResolvedExtraAttachment[] = [
      { attachment: { kind: 'voice', file_id: 'FID2' } },
    ]
    expect(buildExtraAttachmentMeta(resolved)).toEqual({
      attachment_kind_2: 'voice',
      attachment_file_id_2: 'FID2',
    })
  })

  it('handles a mix of photo and document extras with correct numbering', () => {
    const resolved: ResolvedExtraAttachment[] = [
      { imagePath: '/inbox/p2.jpg' },
      { attachment: { kind: 'document', file_id: 'FID3', mime: 'text/plain' } },
    ]
    expect(buildExtraAttachmentMeta(resolved)).toEqual({
      image_path_2: '/inbox/p2.jpg',
      attachment_kind_3: 'document',
      attachment_file_id_3: 'FID3',
      attachment_mime_3: 'text/plain',
    })
  })
})
