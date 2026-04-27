/**
 * Tests for the peercred FFI helper.
 *
 * The function returns null whenever bun:ffi isn't available (running
 * under node) or whenever we're not on Linux. Vitest runs under node, so
 * exercising the fallback path is the most we can do here without spawning
 * a real bun child. The goal is to lock in the contract: "no crash, no
 * throw, just null" — so the calling site can rely on falling back to
 * ss-parsing without defensive try/catch around getPeerCred itself.
 */

import { describe, expect, it } from "vitest";
import { getPeerCred } from "./peercred-ffi.js";

describe("peercred-ffi.getPeerCred", () => {
  it("returns null on non-Linux without throwing", () => {
    if (process.platform === "linux") return;
    expect(() => getPeerCred(0)).not.toThrow();
    expect(getPeerCred(0)).toBeNull();
  });

  it("returns null under node (no bun:ffi) without throwing", () => {
    // Vitest runs under node. If bun:ffi were available the real syscall
    // on fd=42 would EBADF and still return null, so the assertion holds
    // regardless of runtime — but the import-time fallback is what we
    // care about here.
    expect(() => getPeerCred(42)).not.toThrow();
    expect(getPeerCred(42)).toBeNull();
  });

  it("returns null for an obviously invalid fd", () => {
    // -1 is not a valid fd. getsockopt on it errors and we return null.
    expect(getPeerCred(-1)).toBeNull();
  });
});
