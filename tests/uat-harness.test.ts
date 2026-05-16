/**
 * Unit tests for `telegram-plugin/uat/harness.ts` — covers the config
 * resolution + lifecycle ordering. Real-mtcute pieces are mocked.
 *
 * Issue: https://github.com/switchroom/switchroom/issues/866
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const driverConnect = vi.hoisted(() => vi.fn(async () => undefined));
const driverDisconnect = vi.hoisted(() => vi.fn(async () => undefined));
const driverResolveBot = vi.hoisted(() => vi.fn(async () => 555_000_001));
const driverGetMyUserId = vi.hoisted(() => vi.fn(async () => 8_248_703_757));
const driverSendText = vi.hoisted(() =>
  vi.fn(async () => ({ messageId: 42 })),
);
const driverObserveMessages = vi.hoisted(() => vi.fn());
const driverUnpinAll = vi.hoisted(() => vi.fn(async () => undefined));
const DriverCtor = vi.hoisted(() => vi.fn());

vi.mock("../telegram-plugin/uat/driver.js", () => ({
  Driver: DriverCtor.mockImplementation(() => ({
    connect: driverConnect,
    disconnect: driverDisconnect,
    sendText: driverSendText,
    resolveBotUserId: driverResolveBot,
    getMyUserId: driverGetMyUserId,
    observeMessages: driverObserveMessages,
    // Stubbed because spinUp() now calls unpinAllMessages during its
    // settle phase (see harness.ts). Without this stub the real call
    // throws TypeError ("not a function") and every spinUp test fails.
    unpinAllMessages: driverUnpinAll,
  })),
}));

let spinUp: typeof import("../telegram-plugin/uat/harness.js").spinUp;

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.TELEGRAM_API_ID = "33212815";
  process.env.TELEGRAM_API_HASH = "deadbeefdeadbeefdeadbeefdeadbeef";
  process.env.TELEGRAM_UAT_DRIVER_SESSION = "FAKE_SESSION_STRING";
  process.env.TELEGRAM_TEST_BOT_USERNAME = "meken_switchroom_test_bot";
  ({ spinUp } = await import("../telegram-plugin/uat/harness.js"));
});

afterEach(() => {
  delete process.env.TELEGRAM_API_ID;
  delete process.env.TELEGRAM_API_HASH;
  delete process.env.TELEGRAM_UAT_DRIVER_SESSION;
  delete process.env.TELEGRAM_TEST_BOT_USERNAME;
  vi.resetModules();
});

describe("spinUp: config resolution", () => {
  it("throws a clear pointer-to-docs error when TELEGRAM_API_ID is missing", async () => {
    // fails when: a refactor stops validating the env at spinUp() and
    // a scenario instead fails with "API ID invalid" 30 seconds later
    // from mtcute, masking the real cause.
    delete process.env.TELEGRAM_API_ID;
    await expect(spinUp({ agent: "test-harness", settleMs: 0 })).rejects.toThrow(
      /TELEGRAM_API_ID.*uat\/SETUP\.md/,
    );
  });

  it("throws when TELEGRAM_UAT_DRIVER_SESSION is empty (points at uat:login)", async () => {
    // fails when: the empty-session check is dropped — mtcute would
    // start the interactive phone-prompt flow inside the test runner,
    // which is impossible to satisfy and confusing to debug.
    process.env.TELEGRAM_UAT_DRIVER_SESSION = "";
    await expect(spinUp({ agent: "test-harness", settleMs: 0 })).rejects.toThrow(
      /uat:login/,
    );
  });

  it("accepts botUsername via SpinUpOptions, overriding the env var", async () => {
    // fails when: the option/env precedence flips — scenarios that
    // want to target a non-default bot (e.g. a per-scenario bot for
    // isolation) would silently hit the default test bot instead.
    process.env.TELEGRAM_TEST_BOT_USERNAME = "wrong_bot";
    await spinUp({ agent: "test-harness", botUsername: "right_bot", settleMs: 0 });
    expect(driverResolveBot).toHaveBeenCalledWith("right_bot");
  });
});

describe("spinUp: lifecycle ordering", () => {
  it("connects the driver BEFORE resolving the bot/driver ids", async () => {
    // fails when: a refactor parallelizes connect with the id
    // resolution — resolvePeer + getMe would error with "client not
    // connected" intermittently.
    await spinUp({ agent: "test-harness", settleMs: 0 });
    const connectOrder = driverConnect.mock.invocationCallOrder[0];
    const resolveOrder = driverResolveBot.mock.invocationCallOrder[0];
    const getMeOrder = driverGetMyUserId.mock.invocationCallOrder[0];
    expect(connectOrder).toBeLessThan(resolveOrder!);
    expect(connectOrder).toBeLessThan(getMeOrder!);
  });

  it("resolves bot + driver ids in parallel (Promise.all) so first-scenario startup stays snappy", async () => {
    // fails when: a refactor serializes the two — each MTProto
    // resolve costs ~200ms RTT, so serial vs parallel doubles
    // spin-up latency for every scenario.
    let resolveResolved = 0;
    let getMeResolved = 0;
    // Each fake call sleeps 100ms. Serial would take >=200ms, parallel
    // ~100ms — large gap to avoid flake under loaded test runners
    // (vitest workers, container CPU contention).
    const LAT = 100;
    driverResolveBot.mockImplementationOnce(
      () => new Promise((r) => setTimeout(() => { resolveResolved = Date.now(); r(555_000_001); }, LAT)),
    );
    driverGetMyUserId.mockImplementationOnce(
      () => new Promise((r) => setTimeout(() => { getMeResolved = Date.now(); r(8_248_703_757); }, LAT)),
    );
    const t0 = Date.now();
    await spinUp({ agent: "test-harness", settleMs: 0 });
    const total = Date.now() - t0;
    // Serial would take >=2*LAT (200ms); parallel ~LAT (100ms). Pick a
    // generous-but-discriminating upper bound at 1.5*LAT.
    expect(total).toBeLessThan(LAT * 1.5);
    // Both setTimeouts fire within a small window of each other when
    // dispatched in parallel; allow generous slack under load.
    expect(Math.abs(resolveResolved - getMeResolved)).toBeLessThan(LAT * 0.5);
  });

  it("returns a Scenario with sendDM bound to the resolved bot user_id", async () => {
    // fails when: sendDM bind drifts to a stale value (e.g. captures
    // a hoisted variable before resolveBotUserId completes) —
    // messages would route to chat_id 0 / NaN and Telegram returns
    // a PEER_ID_INVALID that's confusing to trace back to the bind
    // site.
    driverResolveBot.mockResolvedValueOnce(555_000_999);
    const sc = await spinUp({ agent: "test-harness", settleMs: 0 });
    await sc.sendDM("hello");
    expect(driverSendText).toHaveBeenCalledWith(555_000_999, "hello");
    expect(sc.botUserId).toBe(555_000_999);
  });

  it("tearDown disconnects the driver (the persistent test-harness agent is untouched)", async () => {
    // fails when: a refactor adds agent-side teardown here — Phase 2a
    // explicitly relies on the standard-runtime agent staying up
    // across scenarios. Killing it would force per-scenario boot cost
    // (~30s) we explicitly chose to avoid.
    const sc = await spinUp({ agent: "test-harness", settleMs: 0 });
    await sc.tearDown();
    expect(driverDisconnect).toHaveBeenCalledTimes(1);
  });

  it("tearDown is idempotent when the driver throws on disconnect", async () => {
    // fails when: errors propagate up — a scenario that already
    // failed its assertion would get its error shadowed by a
    // disconnect failure, hiding the real reason for the red test.
    driverDisconnect.mockRejectedValueOnce(new Error("boom"));
    const sc = await spinUp({ agent: "test-harness", settleMs: 0 });
    await expect(sc.tearDown()).resolves.toBeUndefined();
  });
});
