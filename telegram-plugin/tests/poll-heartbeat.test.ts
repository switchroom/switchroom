/**
 * Tests for telegram-plugin/gateway/poll-heartbeat.ts
 *
 * Tests the actual transformer behaviour — that the heartbeat is updated on
 * getUpdates success and error, NOT on other methods, and that the transformer
 * is transparent (returns the result unchanged, re-throws errors unchanged).
 */

import { describe, it, expect } from "vitest"
import { createGetUpdatesHeartbeat } from "../gateway/poll-heartbeat.js"

function makeTransformerCall(
  transformer: ReturnType<typeof createGetUpdatesHeartbeat>["transformer"],
  method: string,
  resolveWith?: unknown,
  rejectWith?: Error,
): Promise<unknown> {
  const prev = rejectWith
    ? () => Promise.reject(rejectWith)
    : () => Promise.resolve(resolveWith)
  return transformer(prev, method, {})
}

describe("createGetUpdatesHeartbeat", () => {
  it("initialises lastMs() to now", () => {
    let t = 1000
    const hb = createGetUpdatesHeartbeat({ now: () => t })
    expect(hb.lastMs()).toBe(1000)
  })

  it("updates lastMs() when getUpdates succeeds", async () => {
    let t = 1000
    const hb = createGetUpdatesHeartbeat({ now: () => t })
    t = 2000
    await makeTransformerCall(hb.transformer, "getUpdates", [])
    expect(hb.lastMs()).toBe(2000)
  })

  it("updates lastMs() when getUpdates errors (runner is still cycling)", async () => {
    // This is the load-bearing case from the 2026-06-30 incident:
    // a getUpdates TimeoutError means the runner loop is alive (it got a real
    // error). The heartbeat must be updated so we don't immediately stale
    // after the error. Only a completely frozen loop (no getUpdates response
    // at all) should trigger stall detection.
    let t = 1000
    const hb = createGetUpdatesHeartbeat({ now: () => t })
    t = 2000
    const err = new Error("TimeoutError")
    await expect(makeTransformerCall(hb.transformer, "getUpdates", undefined, err)).rejects.toThrow("TimeoutError")
    expect(hb.lastMs()).toBe(2000)
  })

  it("does NOT update lastMs() for getMe (or any other method)", async () => {
    let t = 1000
    const hb = createGetUpdatesHeartbeat({ now: () => t })
    t = 2000
    await makeTransformerCall(hb.transformer, "getMe", { ok: true })
    expect(hb.lastMs()).toBe(1000) // unchanged
  })

  it("does NOT update lastMs() for sendMessage", async () => {
    let t = 1000
    const hb = createGetUpdatesHeartbeat({ now: () => t })
    t = 2000
    await makeTransformerCall(hb.transformer, "sendMessage", { message_id: 1 })
    expect(hb.lastMs()).toBe(1000) // unchanged
  })

  it("passes the result through unchanged on success", async () => {
    const hb = createGetUpdatesHeartbeat()
    const updates = [{ update_id: 42 }]
    const result = await makeTransformerCall(hb.transformer, "getUpdates", updates)
    expect(result).toStrictEqual(updates)
  })

  it("re-throws the error unchanged", async () => {
    const hb = createGetUpdatesHeartbeat()
    const err = new Error("network failure")
    await expect(makeTransformerCall(hb.transformer, "getUpdates", undefined, err)).rejects.toBe(err)
  })

  it("resetToNow() updates lastMs() to current time", () => {
    let t = 1000
    const hb = createGetUpdatesHeartbeat({ now: () => t })
    t = 5000
    hb.resetToNow()
    expect(hb.lastMs()).toBe(5000)
  })

  it("multiple getUpdates calls accumulate latest timestamp", async () => {
    let t = 1000
    const hb = createGetUpdatesHeartbeat({ now: () => t })
    t = 2000
    await makeTransformerCall(hb.transformer, "getUpdates", [])
    t = 3000
    await makeTransformerCall(hb.transformer, "getUpdates", [])
    expect(hb.lastMs()).toBe(3000)
  })
})
