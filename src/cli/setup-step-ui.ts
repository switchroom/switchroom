import chalk from "chalk";

/**
 * Shared step-header presentation helpers for the `switchroom setup` wizard.
 *
 * Extracted from setup.ts so a step implemented in its own module (e.g.
 * {@link ./setup-memory-backend.ts}) can render the same numbered header
 * without importing setup.ts — which would form an import cycle and, worse,
 * drag setup.ts's whole vault graph into a module that must stay vault-free so
 * its vitest test can load (see setup-recall-pool-provision.test.ts).
 */

export const STEP_PENDING = chalk.gray("○");
export const STEP_ACTIVE = chalk.blue("->");
export const STEP_DONE = chalk.green("OK");

export function stepHeader(num: number, title: string, status: string): void {
  stepHeaderTo((line) => console.log(line), num, title, status);
}

/** stepHeader with an injectable sink (tests capture output). */
export function stepHeaderTo(
  log: (line: string) => void,
  num: number,
  title: string,
  status: string,
): void {
  log(`\n${status} ${chalk.bold(`Step ${num}:`)} ${title}`);
}
