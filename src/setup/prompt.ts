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
