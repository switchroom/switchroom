/**
 * Tests for promptPassphrase() in vault-broker.ts.
 *
 * Covers:
 *  1. Non-TTY (pipe) path — passphrase is read from stdin without masking.
 *  2. Non-TTY (pipe) path — empty input is rejected with a clear message.
 *  3. TTY path — raw-mode masking: characters accumulate silently, Enter resolves.
 *  4. TTY path — empty input (immediate Enter) is rejected.
 *  5. TTY path — Ctrl-C calls process.exit(130).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough, EventEmitter } from "node:stream";
import { promptPassphrase } from "../src/cli/vault-broker.js";

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a non-TTY stdin backed by a PassThrough stream so readline can
 * attach properly (it needs pause/resume/pipe etc).
 */
function makePipeStdin(): PassThrough & { isTTY: false } {
  const stream = new PassThrough() as PassThrough & { isTTY: false };
  (stream as any).isTTY = false;
  return stream;
}

/**
 * Build a TTY stdin backed by a PassThrough stream.
 * setRawMode is stubbed so raw-mode calls don't throw.
 */
function makeTTYStdin(): PassThrough & {
  isTTY: true;
  setRawMode: ReturnType<typeof vi.fn>;
} {
  const stream = new PassThrough() as ReturnType<typeof makeTTYStdin>;
  (stream as any).isTTY = true;
  stream.setRawMode = vi.fn();
  return stream;
}

// Silence stdout/stderr writes for all tests.
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ── Non-TTY (pipe) tests ─────────────────────────────────────────────────────

describe("promptPassphrase — non-TTY (pipe) path", () => {
  it("reads passphrase from piped stdin", async () => {
    const fakeStdin = makePipeStdin();
    vi.spyOn(process, "stdin", "get").mockReturnValue(fakeStdin as any);

    const promise = promptPassphrase();

    setImmediate(() => {
      fakeStdin.write("my-secret-passphrase\n");
      fakeStdin.end();
    });

    const result = await promise;
    expect(result).toBe("my-secret-passphrase");
  });

  it("trims trailing carriage-return from piped input", async () => {
    const fakeStdin = makePipeStdin();
    vi.spyOn(process, "stdin", "get").mockReturnValue(fakeStdin as any);

    const promise = promptPassphrase();
    setImmediate(() => {
      fakeStdin.write("trim-me\r\n");
      fakeStdin.end();
    });

    const result = await promise;
    // readline strips \n; trimEnd() in our code strips \r
    expect(result).toBe("trim-me");
  });

  it("rejects with clear message when pipe delivers empty input (no data)", async () => {
    const fakeStdin = makePipeStdin();
    vi.spyOn(process, "stdin", "get").mockReturnValue(fakeStdin as any);

    const promise = promptPassphrase();
    setImmediate(() => {
      fakeStdin.end(); // close without writing anything
    });

    await expect(promise).rejects.toThrow("Empty passphrase — aborting");
  });

  it("rejects when pipe delivers only whitespace", async () => {
    const fakeStdin = makePipeStdin();
    vi.spyOn(process, "stdin", "get").mockReturnValue(fakeStdin as any);

    const promise = promptPassphrase();
    setImmediate(() => {
      fakeStdin.write("   \n");
      fakeStdin.end();
    });

    await expect(promise).rejects.toThrow("Empty passphrase — aborting");
  });
});

// ── TTY (interactive, masked) tests ──────────────────────────────────────────

describe("promptPassphrase — TTY (masked) path", () => {
  it("accumulates characters silently and resolves on Enter", async () => {
    const fakeStdin = makeTTYStdin();
    vi.spyOn(process, "stdin", "get").mockReturnValue(fakeStdin as any);

    const promise = promptPassphrase();

    setImmediate(() => {
      // Type characters one by one, then press Enter
      fakeStdin.emit("data", Buffer.from("s"));
      fakeStdin.emit("data", Buffer.from("e"));
      fakeStdin.emit("data", Buffer.from("c"));
      fakeStdin.emit("data", Buffer.from("\r")); // Enter
    });

    const result = await promise;
    expect(result).toBe("sec");

    // Confirm the typed characters were NOT echoed to stdout
    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    // Only the prompt + trailing newline should appear; none of the typed chars
    expect(written).not.toContain("sec");
  });

  it("handles backspace (DEL 0x7f) by removing the last character", async () => {
    const fakeStdin = makeTTYStdin();
    vi.spyOn(process, "stdin", "get").mockReturnValue(fakeStdin as any);

    const promise = promptPassphrase();

    setImmediate(() => {
      fakeStdin.emit("data", Buffer.from("a"));
      fakeStdin.emit("data", Buffer.from("b"));
      fakeStdin.emit("data", Buffer.from("x")); // typo
      fakeStdin.emit("data", Buffer.from("\x7f")); // DEL / backspace
      fakeStdin.emit("data", Buffer.from("c"));
      fakeStdin.emit("data", Buffer.from("\n")); // Enter
    });

    const result = await promise;
    expect(result).toBe("abc");
  });

  it("handles \\b as backspace", async () => {
    const fakeStdin = makeTTYStdin();
    vi.spyOn(process, "stdin", "get").mockReturnValue(fakeStdin as any);

    const promise = promptPassphrase();

    setImmediate(() => {
      fakeStdin.emit("data", Buffer.from("z"));
      fakeStdin.emit("data", Buffer.from("\b")); // backspace
      fakeStdin.emit("data", Buffer.from("p"));
      fakeStdin.emit("data", Buffer.from("\r")); // Enter
    });

    const result = await promise;
    expect(result).toBe("p");
  });

  it("rejects with clear message when Enter is pressed with empty input", async () => {
    const fakeStdin = makeTTYStdin();
    vi.spyOn(process, "stdin", "get").mockReturnValue(fakeStdin as any);

    const promise = promptPassphrase();

    setImmediate(() => {
      fakeStdin.emit("data", Buffer.from("\r")); // Enter with nothing typed
    });

    await expect(promise).rejects.toThrow("Empty passphrase — aborting");
  });

  it("calls process.exit(130) on Ctrl-C", async () => {
    const fakeStdin = makeTTYStdin();
    vi.spyOn(process, "stdin", "get").mockReturnValue(fakeStdin as any);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);

    const _promise = promptPassphrase();

    setImmediate(() => {
      fakeStdin.emit("data", Buffer.from("\x03")); // Ctrl-C
    });

    // Give it a tick to run the handler
    await new Promise((r) => setTimeout(r, 50));

    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it("enables raw mode synchronously before any data arrives", async () => {
    const fakeStdin = makeTTYStdin();
    vi.spyOn(process, "stdin", "get").mockReturnValue(fakeStdin as any);

    // Start the prompt — setRawMode must be called synchronously during
    // the first microtask turn (before any "data" events fire).
    const promise = promptPassphrase();
    // promptPassphrase is async but the TTY branch doesn't await anything
    // before calling setRawMode. One microtask tick is enough.
    await Promise.resolve();

    expect(fakeStdin.setRawMode).toHaveBeenCalledWith(true);

    // Resolve the hanging promise by emitting each character separately
    // (the handler processes one char per event, so "pw\r" as one emit
    // would be treated as a 3-character sequence, not as Enter).
    fakeStdin.emit("data", Buffer.from("p"));
    fakeStdin.emit("data", Buffer.from("w"));
    fakeStdin.emit("data", Buffer.from("\r")); // Enter
    await promise;
  });
});
