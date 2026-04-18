/**
 * Tests for the structured pin/unpin event logger — the module that
 * emits one JSON line per pin API interaction so operators can audit
 * the pin lifecycle without parsing free-form log text.
 *
 * Covers spec `docs/pinned-progress-card-reliability.md` §6.1 and T9.
 */

import { describe, it, expect } from "vitest";
import {
  logPinEvent,
  classifyPinError,
  errorMessage,
  type PinEvent,
} from "../pin-event-log.js";

describe("logPinEvent", () => {
  it("writes one JSON line prefixed with 'pin-event: '", () => {
    const lines: string[] = [];
    const ev: PinEvent = {
      event: "pin",
      chatId: "100",
      messageId: 42,
      turnKey: "100::1",
      outcome: "ok",
      durationMs: 123,
    };
    logPinEvent(ev, (line) => lines.push(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^pin-event: /);
    expect(lines[0].endsWith("\n")).toBe(true);
    const payload = JSON.parse(lines[0].replace(/^pin-event: /, "").trimEnd());
    expect(payload).toEqual(ev);
  });

  it("preserves all optional fields that are set", () => {
    const lines: string[] = [];
    logPinEvent(
      {
        event: "unpin-retry",
        chatId: "c",
        messageId: 7,
        turnKey: "c::2",
        outcome: "rate-limited",
        error: "Too Many Requests",
        durationMs: 1050,
      },
      (line) => lines.push(line),
    );
    const payload = JSON.parse(lines[0].replace(/^pin-event: /, "").trimEnd());
    expect(payload.error).toBe("Too Many Requests");
    expect(payload.outcome).toBe("rate-limited");
    expect(payload.event).toBe("unpin-retry");
  });

  it("omits undefined optional fields cleanly", () => {
    const lines: string[] = [];
    logPinEvent(
      {
        event: "sweep-pin",
        chatId: "c",
        outcome: "ok",
      },
      (line) => lines.push(line),
    );
    const raw = lines[0].replace(/^pin-event: /, "").trimEnd();
    expect(raw).not.toContain("undefined");
    const payload = JSON.parse(raw);
    expect(payload.error).toBeUndefined();
    expect(payload.messageId).toBeUndefined();
  });
});

describe("classifyPinError", () => {
  it("returns 'rate-limited' for Telegram 429", () => {
    expect(
      classifyPinError({ error_code: 429, description: "Too Many Requests: retry after 2" }),
    ).toBe("rate-limited");
  });

  it("returns 'forbidden' for Telegram 403", () => {
    expect(classifyPinError({ error_code: 403, description: "Forbidden: bot was kicked" })).toBe(
      "forbidden",
    );
  });

  it("falls back to message substring match when error_code is absent", () => {
    expect(classifyPinError(new Error("Bad Request: not enough rights to manage pins"))).toBe(
      "forbidden",
    );
    expect(classifyPinError(new Error("connect ETIMEDOUT 1.2.3.4:443"))).toBe("timeout");
  });

  it("returns 'fail' for any unrecognised error shape", () => {
    expect(classifyPinError(new Error("weird unexpected failure"))).toBe("fail");
    expect(classifyPinError("random string")).toBe("fail");
    expect(classifyPinError({})).toBe("fail");
  });

  it("returns 'fail' for null/undefined", () => {
    expect(classifyPinError(null)).toBe("fail");
    expect(classifyPinError(undefined)).toBe("fail");
  });
});

describe("errorMessage", () => {
  it("extracts message from Error instance", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("prefers description over message on grammy-shaped objects", () => {
    expect(errorMessage({ description: "Telegram says no", message: "generic" })).toBe(
      "Telegram says no",
    );
  });

  it("returns empty string for null", () => {
    expect(errorMessage(null)).toBe("");
  });

  it("stringifies unknown shapes", () => {
    expect(errorMessage(42)).toBe("42");
  });
});
