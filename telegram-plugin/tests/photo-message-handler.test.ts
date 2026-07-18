/**
 * Outcome pins for the photo inbound handler extracted from gateway.ts
 * (switchroom#2996 P6 cluster D). Unlike the metadata-only attachment handlers,
 * photo downloads the largest size from the Telegram CDN into the inbox and
 * returns the on-disk path as the coalesced image. The download closure is
 * driven here against a fake grammy ctx + fetch, pinning: caption-or-fallback
 * envelope, largest-size selection, inbox write, and token redaction on error.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handlePhotoMessage, type PhotoHandlerDeps } from '../gateway/photo-message-handler.js'

const TOKEN = '123:SECRET-TOKEN'
let inboxDir: string

function makeDeps(overrides: Partial<PhotoHandlerDeps> = {}) {
  const logs: string[] = []
  // capture the download closure passed to handleInboundCoalesced so the test
  // can invoke it and assert the returned path.
  let captured: { text: string; download?: () => Promise<string | undefined> } | undefined
  const handleInboundCoalesced = vi.fn(async (_ctx: any, text: string, download: any) => {
    captured = { text, download }
  })
  const deps: PhotoHandlerDeps = {
    handleInboundCoalesced,
    getToken: () => TOKEN,
    inboxDir,
    log: line => logs.push(line),
    ...overrides,
  }
  return { deps, handleInboundCoalesced, logs, getCaptured: () => captured }
}

function ctxWith(photo: unknown[], caption?: string, getFile?: any): any {
  return {
    message: { photo, caption },
    api: { getFile: getFile ?? vi.fn() },
    chat: { id: 42 },
  }
}

beforeEach(() => {
  inboxDir = mkdtempSync(join(tmpdir(), 'photo-inbox-'))
})
afterEach(() => {
  rmSync(inboxDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('handlePhotoMessage', () => {
  it('uses the caption as the envelope, falling back to (photo)', async () => {
    const { deps, handleInboundCoalesced } = makeDeps()
    await handlePhotoMessage(ctxWith([{ file_id: 'p1', file_unique_id: 'u1' }]), deps)
    expect(handleInboundCoalesced.mock.calls[0][1]).toBe('(photo)')

    const { deps: deps2, handleInboundCoalesced: h2 } = makeDeps()
    await handlePhotoMessage(ctxWith([{ file_id: 'p1', file_unique_id: 'u1' }], 'look'), deps2)
    expect(h2.mock.calls[0][1]).toBe('look')
  })

  it('downloads the largest size and writes it into the inbox', async () => {
    const getFile = vi.fn(async () => ({ file_path: 'photos/big.jpg' }))
    const ctx = ctxWith(
      [{ file_id: 'small', file_unique_id: 'us' }, { file_id: 'big', file_unique_id: 'ub' }],
      undefined,
      getFile,
    )
    const { deps, getCaptured } = makeDeps()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    )
    await handlePhotoMessage(ctx, deps)
    const dlPath = await getCaptured()!.download!()
    // Largest (last) size selected.
    expect(getFile).toHaveBeenCalledWith('big')
    // Token embedded in the CDN URL.
    expect(fetchSpy.mock.calls[0][0]).toContain(`/bot${TOKEN}/photos/big.jpg`)
    expect(dlPath).toBeDefined()
    expect(existsSync(dlPath!)).toBe(true)
    expect(Array.from(readFileSync(dlPath!))).toEqual([1, 2, 3])
  })

  it('returns undefined and logs HTTP status on a failed download', async () => {
    const getFile = vi.fn(async () => ({ file_path: 'photos/x.jpg' }))
    const { deps, getCaptured, logs } = makeDeps()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 502 }))
    await handlePhotoMessage(ctxWith([{ file_id: 'p', file_unique_id: 'u' }], undefined, getFile), deps)
    const dlPath = await getCaptured()!.download!()
    expect(dlPath).toBeUndefined()
    expect(logs.some(l => l.includes('HTTP 502'))).toBe(true)
  })

  it('redacts the bot token from a thrown error message', async () => {
    const getFile = vi.fn(async () => ({ file_path: 'photos/x.jpg' }))
    const { deps, getCaptured, logs } = makeDeps()
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(`connect failed to bot${TOKEN}/x`))
    await handlePhotoMessage(ctxWith([{ file_id: 'p', file_unique_id: 'u' }], undefined, getFile), deps)
    const dlPath = await getCaptured()!.download!()
    expect(dlPath).toBeUndefined()
    const line = logs.find(l => l.startsWith('telegram gateway: photo download failed:'))!
    expect(line).toContain('<REDACTED>')
    expect(line).not.toContain(TOKEN)
  })

  it('returns undefined when the file has no path', async () => {
    const getFile = vi.fn(async () => ({}))
    const { deps, getCaptured } = makeDeps()
    await handlePhotoMessage(ctxWith([{ file_id: 'p', file_unique_id: 'u' }], undefined, getFile), deps)
    expect(await getCaptured()!.download!()).toBeUndefined()
  })
})
