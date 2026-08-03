import { describe, it, expect, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";

import { createInboundPump } from "./pump.js";
import { buildAuthorizedSet } from "./auth-gate.js";
import type { NostrEventLike } from "./auth-gate.js";
import type { BuzzRuntimeConfig } from "./config.js";
import type { DedupStore } from "./dedup.js";
import type { InboundMessage } from "../../telegram-plugin/gateway/ipc-protocol.js";
import {
  summarizePipeline,
  formatStatsLine,
  createStatsReporter,
  type BuzzPipelineSummary,
  type StatsSample,
} from "./stats.js";

// ── helpers mirrored from pump.test.ts so the stats derive from a REAL pump ──

function memDedup(): DedupStore {
  const s = new Set<string>();
  return { has: (id) => s.has(id), record: (id) => { s.add(id); }, size: () => s.size, close: () => {} };
}

function sign(sk: Uint8Array, over: Partial<NostrEventLike> = {}): NostrEventLike {
  return finalizeEvent(
    {
      kind: over.kind ?? 9,
      created_at: over.created_at ?? Math.floor(Date.now() / 1000),
      tags: over.tags ?? [["h", "group-uuid"]],
      content: over.content ?? "hello",
    },
    sk,
  ) as NostrEventLike;
}

function makeConfig(over: Partial<BuzzRuntimeConfig> = {}): BuzzRuntimeConfig {
  return {
    enabled: true,
    agentName: "klanker",
    chatId: "555",
    relayUrl: "ws://relay",
    relayTagUrl: "ws://relay",
    relayHost: "",
    groupId: "group-uuid",
    authorized: over.authorized ?? new Set<string>(),
    nsecVaultKey: "buzz/klanker-nsec",
    pubkeyNames: {},
    mirror: "both",
    ...over,
  };
}

function harness(cfg: BuzzRuntimeConfig, opts: { injectOk?: boolean; dedup?: DedupStore } = {}) {
  const frames: InboundMessage[] = [];
  const pump = createInboundPump({
    config: cfg,
    dedup: opts.dedup ?? memDedup(),
    inject: (inbound) => { if (opts.injectOk === false) return false; frames.push(inbound); return true; },
    verify: verifyEvent,
    agentPubkey: null,
  });
  return { pump, frames };
}

describe("summarizePipeline — derives from real pump outcomes", () => {
  it("counts injected / dropped-by-kind / auth-failures / duplicate from actual events", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const strangerSk = generateSecretKey();
    const cfg = makeConfig({ authorized: buildAuthorizedSet(pk) });
    const { pump, frames } = harness(cfg);

    // 1 injected (kind:9, allowlisted)
    const ev = sign(sk);
    expect(pump.handleEvent(ev)).toBe("injected");
    // duplicate redelivery of the SAME id
    expect(pump.handleEvent(ev)).toBe("duplicate");
    // 1 dropped-by-kind (kind:1, allowlisted but unmapped)
    expect(pump.handleEvent(sign(sk, { kind: 1 }))).toBe("unmapped");
    // 2 auth failures: a stranger (not_allowlisted) and a tampered sig (bad_signature)
    expect(pump.handleEvent(sign(strangerSk))).toBe("rejected:not_allowlisted");
    const good = sign(sk);
    const tampered = JSON.parse(JSON.stringify({ ...good, content: good.content + " EVIL" }));
    expect(pump.handleEvent(tampered)).toBe("rejected:bad_signature");

    // exactly one turn was really injected
    expect(frames.length).toBe(1);

    const s = summarizePipeline(pump.stats, { ok: 3, failed: 1 });
    // received = every handleEvent call = 5
    expect(s.received).toBe(5);
    expect(s.injected).toBe(1);
    expect(s.duplicate).toBe(1);
    expect(s.droppedByKind).toBe(1);
    // authFailures = sum of the two distinct rejected:* buckets
    expect(s.authFailures).toBe(2);
    expect(s.queued).toBe(0);
    expect(s.injectFailed).toBe(0);
    expect(s.channelOff).toBe(0);
    // mirror counters passed through verbatim
    expect(s.mirrorOk).toBe(3);
    expect(s.mirrorFailed).toBe(1);
  });

  it("counts inject_failed and queued distinctly (retry queue absent vs present)", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);

    // No retry queue → a failed inject is inject_failed.
    const noRetry = harness(makeConfig({ authorized: buildAuthorizedSet(pk) }), { injectOk: false });
    expect(noRetry.pump.handleEvent(sign(sk))).toBe("inject_failed");
    const s1 = summarizePipeline(noRetry.pump.stats, { ok: 0, failed: 0 });
    expect(s1.injectFailed).toBe(1);
    expect(s1.queued).toBe(0);
    expect(s1.received).toBe(1);

    // With a retry queue → a failed inject is queued.
    const queued = new Set<string>();
    const pump = createInboundPump({
      config: makeConfig({ authorized: buildAuthorizedSet(pk) }),
      dedup: memDedup(),
      inject: () => false,
      retryQueue: { has: (id) => queued.has(id), enqueue: (id) => { queued.add(id); } },
      verify: verifyEvent,
      agentPubkey: null,
    });
    expect(pump.handleEvent(sign(sk))).toBe("queued");
    const s2 = summarizePipeline(pump.stats, { ok: 0, failed: 0 });
    expect(s2.queued).toBe(1);
    expect(s2.injectFailed).toBe(0);
  });

  it("an empty pump summarizes to all-zeros", () => {
    const empty = Object.create(null) as Record<string, number>;
    const s = summarizePipeline(empty, { ok: 0, failed: 0 });
    expect(s).toEqual<BuzzPipelineSummary>({
      received: 0,
      injected: 0,
      duplicate: 0,
      queued: 0,
      injectFailed: 0,
      droppedByKind: 0,
      channelOff: 0,
      authFailures: 0,
      mirrorOk: 0,
      mirrorFailed: 0,
    });
  });
});

describe("formatStatsLine", () => {
  it("emits a single greppable line with every field", () => {
    const line = formatStatsLine({
      received: 5, injected: 1, duplicate: 1, queued: 0, injectFailed: 0,
      droppedByKind: 1, channelOff: 0, authFailures: 2, mirrorOk: 3, mirrorFailed: 1,
    });
    expect(line).toBe(
      "buzz stats: received=5 injected=1 duplicate=1 queued=0 inject_failed=0 " +
      "dropped_by_kind=1 channel_off=0 auth_failures=2 mirror_ok=3 mirror_failed=1",
    );
  });
});

describe("createStatsReporter", () => {
  function fakeTimers() {
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const setTimer = vi.fn((fn: () => void, ms: number) => {
      scheduled.push({ fn, ms });
      return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    });
    const clearTimer = vi.fn();
    // run the most-recently scheduled timer
    const runNext = () => {
      const next = scheduled.pop();
      if (next) next.fn();
    };
    return { setTimer, clearTimer, runNext, scheduled };
  }

  it("emits + persists a first beat immediately on start, then on each tick", () => {
    const { setTimer, runNext } = fakeTimers();
    const emitted: string[] = [];
    const persisted: StatsSample[] = [];
    let received = 0;
    const reporter = createStatsReporter({
      intervalMs: 60_000,
      setTimer,
      sample: () => ({
        summary: summarizePipeline({ injected: received } as Record<string, number>, { ok: 0, failed: 0 }),
        subscribed: true,
      }),
      emit: (l) => emitted.push(l),
      persist: (s) => persisted.push(s),
    });

    reporter.start();
    // immediate first beat
    expect(emitted.length).toBe(1);
    expect(persisted.length).toBe(1);
    expect(emitted[0]).toContain("injected=0");

    // pipeline advances, timer fires → a new (changed) line is emitted + persisted
    received = 2;
    runNext();
    expect(emitted.length).toBe(2);
    expect(emitted[1]).toContain("injected=2");
    expect(persisted.length).toBe(2);
    expect(persisted[1].summary.injected).toBe(2);
  });

  it("suppresses an unchanged log line but ALWAYS persists the heartbeat", () => {
    const { setTimer, runNext } = fakeTimers();
    const emitted: string[] = [];
    const persisted: StatsSample[] = [];
    const reporter = createStatsReporter({
      intervalMs: 60_000,
      setTimer,
      sample: () => ({
        summary: summarizePipeline(Object.create(null), { ok: 0, failed: 0 }),
        subscribed: true,
      }),
      emit: (l) => emitted.push(l),
      persist: (s) => persisted.push(s),
    });

    reporter.start();
    runNext(); // identical all-zero summary
    runNext();

    // one emit (first beat), but three heartbeat persists (liveness must keep beating)
    expect(emitted.length).toBe(1);
    expect(persisted.length).toBe(3);
  });

  it("a persist that throws never breaks the loop", () => {
    const { setTimer, runNext } = fakeTimers();
    const emitted: string[] = [];
    let n = 0;
    const reporter = createStatsReporter({
      intervalMs: 60_000,
      setTimer,
      sample: () => ({
        summary: summarizePipeline({ injected: n++ } as Record<string, number>, { ok: 0, failed: 0 }),
        subscribed: true,
      }),
      emit: (l) => emitted.push(l),
      persist: () => { throw new Error("disk full"); },
    });

    expect(() => { reporter.start(); runNext(); }).not.toThrow();
    expect(emitted.length).toBe(2);
  });

  it("stop() clears the pending timer and halts ticking", () => {
    const { setTimer, clearTimer } = fakeTimers();
    const emitted: string[] = [];
    const reporter = createStatsReporter({
      intervalMs: 60_000,
      setTimer,
      clearTimer,
      sample: () => ({ summary: summarizePipeline(Object.create(null), { ok: 0, failed: 0 }), subscribed: true }),
      emit: (l) => emitted.push(l),
    });
    reporter.start();
    reporter.stop();
    expect(clearTimer).toHaveBeenCalledTimes(1);
  });
});
