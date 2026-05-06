/**
 * Schema-level deprecation + normalisation tests for
 * `experimental.tmux_supervisor` → `experimental.legacy_pty` (#725 PR-1).
 *
 * The Zod transform on ExperimentalSchema fires at parse time and
 * normalises every shape downstream code reads. This suite locks in:
 *   1. Forward shape: `legacy_pty` set is preserved as-is.
 *   2. Backward compat: deprecated `tmux_supervisor` migrates correctly.
 *   3. Deprecation warning fires exactly once per process (gate works).
 *   4. Default shape: `legacy_pty` defaults to `false` (tmux supervisor).
 *   5. Forward-only field: `tmux_supervisor` is removed from the parsed
 *      output so accidental new readers hard-fail at the type level.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ExperimentalSchema,
  _resetTmuxSupervisorDeprecationGate,
} from "../src/config/schema.js";

beforeEach(() => {
  _resetTmuxSupervisorDeprecationGate();
});

describe("ExperimentalSchema — Zod transform (#725 PR-1)", () => {
  it("undefined input passes through as undefined (no-op)", () => {
    const out = ExperimentalSchema.parse(undefined);
    expect(out).toBeUndefined();
  });

  it("empty object → legacy_pty: false (tmux is the default)", () => {
    const out = ExperimentalSchema.parse({});
    expect(out).toEqual({ legacy_pty: false });
  });

  it("legacy_pty: true is preserved as-is", () => {
    const out = ExperimentalSchema.parse({ legacy_pty: true });
    expect(out).toEqual({ legacy_pty: true });
  });

  it("legacy_pty: false is preserved as-is", () => {
    const out = ExperimentalSchema.parse({ legacy_pty: false });
    expect(out).toEqual({ legacy_pty: false });
  });

  it("deprecated tmux_supervisor: true → legacy_pty: false (and warns)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = ExperimentalSchema.parse({ tmux_supervisor: true });
    expect(out).toEqual({ legacy_pty: false });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain("DEPRECATED");
    warn.mockRestore();
  });

  it("deprecated tmux_supervisor: false → legacy_pty: true (and warns)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = ExperimentalSchema.parse({ tmux_supervisor: false });
    expect(out).toEqual({ legacy_pty: true });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("legacy_pty wins when both are set (no warning needed)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = ExperimentalSchema.parse({
      tmux_supervisor: true,
      legacy_pty: true,
    });
    expect(out).toEqual({ legacy_pty: true });
    // legacy_pty branch in the transform never warns — the user has
    // already migrated; the deprecated key is just leftover noise.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("deprecation warning fires only once per process across multiple parses", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ExperimentalSchema.parse({ tmux_supervisor: true });
    ExperimentalSchema.parse({ tmux_supervisor: false });
    ExperimentalSchema.parse({ tmux_supervisor: true });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("parsed output never contains tmux_supervisor (key is dropped)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = ExperimentalSchema.parse({ tmux_supervisor: true });
    expect(out).not.toHaveProperty("tmux_supervisor");
    warn.mockRestore();
  });

  // #725 PR-4 — legacy_autoaccept_expect rollback flag.
  it("legacy_autoaccept_expect: true is preserved as-is", () => {
    const out = ExperimentalSchema.parse({ legacy_autoaccept_expect: true });
    expect(out).toEqual({
      legacy_pty: false,
      legacy_autoaccept_expect: true,
    });
  });

  it("legacy_autoaccept_expect: false is preserved as-is", () => {
    const out = ExperimentalSchema.parse({ legacy_autoaccept_expect: false });
    expect(out).toEqual({
      legacy_pty: false,
      legacy_autoaccept_expect: false,
    });
  });

  it("omitted legacy_autoaccept_expect → undefined (treated as false at use site)", () => {
    const out = ExperimentalSchema.parse({});
    expect(out).toEqual({ legacy_pty: false });
    expect(out).not.toHaveProperty("legacy_autoaccept_expect");
  });
});
