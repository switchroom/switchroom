import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

import { askHidden } from "../src/setup/prompt.js";

// A fake stdin standing in for a TTY. askHidden reads via raw-mode data
// events (never readline), so we drive it by emitting "data".
function makeFakeStdin(isTTY: boolean) {
  const s = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    setRawMode: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    setEncoding: ReturnType<typeof vi.fn>;
  };
  s.isTTY = isTTY;
  s.setRawMode = vi.fn();
  s.resume = vi.fn();
  s.pause = vi.fn();
  s.setEncoding = vi.fn();
  return s;
}

const origStdin = process.stdin;
const origWrite = process.stdout.write;

function installStdin(fake: EventEmitter & { isTTY: boolean }) {
  Object.defineProperty(process, "stdin", { value: fake, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
  process.stdout.write = origWrite;
  vi.restoreAllMocks();
});

describe("askHidden", () => {
  it("reads a secret in raw mode WITHOUT echoing it to the terminal", async () => {
    const fake = makeFakeStdin(true);
    installStdin(fake);

    const writes: string[] = [];
    process.stdout.write = ((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    const pending = askHidden("  Vault passphrase");
    // Let askHidden register its data listener before we feed input.
    await Promise.resolve();

    // Typed across multiple data events, including a paste-style chunk
    // that carries the terminating newline.
    fake.emit("data", "hun");
    fake.emit("data", "ter2\n");

    const result = await pending;
    expect(result).toBe("hunter2");

    // Raw mode was engaged (no-echo) and then released.
    expect(fake.setRawMode).toHaveBeenCalledWith(true);
    expect(fake.setRawMode).toHaveBeenCalledWith(false);

    // The secret must NEVER appear in anything written to stdout — only
    // the prompt label and the suppressed newline are echoed.
    const echoed = writes.join("");
    expect(echoed).not.toContain("hunter2");
    expect(echoed).not.toContain("hunter");
    expect(echoed).toContain("Vault passphrase");
  });

  it("handles backspace without echoing", async () => {
    const fake = makeFakeStdin(true);
    installStdin(fake);
    process.stdout.write = (() => true) as typeof process.stdout.write;

    const pending = askHidden("  Passphrase");
    await Promise.resolve();
    fake.emit("data", "abc");
    fake.emit("data", "\u007f"); // delete -> drops 'c'
    fake.emit("data", "\n");
    expect(await pending).toBe("ab");
  });

  it("returns the default in non-interactive mode (mirrors ask)", async () => {
    const fake = makeFakeStdin(false);
    installStdin(fake);
    expect(await askHidden("x", "fallback")).toBe("fallback");
  });

  it("throws in non-interactive mode with no default (mirrors ask)", async () => {
    const fake = makeFakeStdin(false);
    installStdin(fake);
    await expect(askHidden("x")).rejects.toThrow(/Non-interactive/);
  });
});
