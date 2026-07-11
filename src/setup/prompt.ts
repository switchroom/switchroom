import { createInterface } from "node:readline";

/**
 * Returns true if we're in interactive mode (stdin is a TTY).
 */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true;
}

function createReadlineInterface() {
  return createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

/**
 * Prompt the user with a question. Returns the answer string.
 * In non-interactive mode, returns the defaultValue or throws.
 */
export async function ask(
  question: string,
  defaultValue?: string,
): Promise<string> {
  if (!isInteractive()) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Non-interactive mode: no default for "${question}"`);
  }

  const rl = createReadlineInterface();
  return new Promise<string>((resolve) => {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

/**
 * Prompt for a secret (e.g. a vault passphrase) WITHOUT echoing input
 * to the terminal. Mirrors {@link ask}'s interactive/non-interactive
 * contract: in non-interactive mode it returns `defaultValue` or throws.
 *
 * On a TTY it reads in raw mode so keystrokes are never rendered — the
 * passphrase must never appear in the terminal or scrollback. This is
 * the no-echo replacement for `ask()` on secret prompts (2026-07-11
 * review, MEDIUM: `switchroom setup` echoed the vault passphrase in
 * cleartext because it prompted via the echoing `ask()`).
 *
 * Ctrl-C rejects (aborts the prompt); backspace/delete edit the buffer.
 */
export async function askHidden(
  question: string,
  defaultValue?: string,
): Promise<string> {
  if (!isInteractive()) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Non-interactive mode: no default for "${question}"`);
  }

  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(`${question}: `);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let input = "";
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };

    const onData = (chunk: string) => {
      // A single data event can carry several characters (fast typing or
      // a paste that includes the terminating newline), so iterate.
      for (const char of chunk) {
        if (char === "\n" || char === "\r" || char === "\u0004") {
          // Enter / EOF — accept. Emit the newline WE suppressed so the
          // cursor moves on, but never the typed characters themselves.
          cleanup();
          process.stdout.write("\n");
          resolve(input.trim() || defaultValue || "");
          return;
        } else if (char === "\u0003") {
          // Ctrl-C — abort the prompt.
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Aborted"));
          return;
        } else if (char === "\u007f" || char === "\b") {
          // Backspace / Delete.
          if (input.length > 0) input = input.slice(0, -1);
        } else {
          input += char;
        }
      }
    };

    stdin.on("data", onData);
  });
}

/**
 * Ask a yes/no question. Returns true for yes.
 * In non-interactive mode, returns the default.
 */
export async function askYesNo(
  question: string,
  defaultYes = true,
): Promise<boolean> {
  if (!isInteractive()) {
    return defaultYes;
  }

  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const rl = createReadlineInterface();
  return new Promise<boolean>((resolve) => {
    rl.question(`${question} ${hint} `, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      if (normalized === "") {
        resolve(defaultYes);
      } else {
        resolve(normalized === "y" || normalized === "yes");
      }
    });
  });
}

/**
 * Present numbered choices and return the selected value.
 * In non-interactive mode, returns the first choice.
 */
export async function askChoice(
  question: string,
  choices: string[],
): Promise<string> {
  if (!isInteractive()) {
    return choices[0];
  }

  console.log(`\n${question}`);
  for (let i = 0; i < choices.length; i++) {
    console.log(`  ${i + 1}) ${choices[i]}`);
  }

  const rl = createReadlineInterface();
  return new Promise<string>((resolve) => {
    rl.question(`Enter choice [1-${choices.length}]: `, (answer) => {
      rl.close();
      const idx = parseInt(answer.trim(), 10) - 1;
      if (idx >= 0 && idx < choices.length) {
        resolve(choices[idx]);
      } else {
        resolve(choices[0]);
      }
    });
  });
}

/**
 * Display a message and wait for the user to press Enter.
 * In non-interactive mode, just prints the message.
 */
export async function waitForAction(message: string): Promise<void> {
  if (!isInteractive()) {
    console.log(message);
    return;
  }

  const rl = createReadlineInterface();
  return new Promise<void>((resolve) => {
    rl.question(`${message}\n  Press Enter when ready...`, () => {
      rl.close();
      resolve();
    });
  });
}

/**
 * Simple spinner for polling operations.
 * Returns a stop function.
 */
export function spinner(message: string): { stop: (finalMsg?: string) => void } {
  if (!isInteractive()) {
    console.log(message);
    return { stop: () => {} };
  }

  const frames = ["|", "/", "-", "\\"];
  let i = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r  ${frames[i++ % frames.length]} ${message}`);
  }, 150);

  return {
    stop(finalMsg?: string) {
      clearInterval(interval);
      if (finalMsg) {
        process.stdout.write(`\r  ${finalMsg}\n`);
      } else {
        process.stdout.write("\r" + " ".repeat(message.length + 6) + "\r");
      }
    },
  };
}
