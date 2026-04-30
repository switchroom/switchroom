/**
 * Issues file watcher — drives `IssuesCardHandle.refresh()` whenever
 * the agent's `issues.jsonl` changes. Phase 0.4 of #424.
 *
 * Strategy: poll-based. We stat the file every POLL_INTERVAL_MS (default
 * 2s). If mtime changed since last tick, re-read and refresh the card.
 * Inotify would be tighter but pulls in fs.watch's platform quirks
 * (NFS, missed events) for marginal benefit — issues.jsonl writes are
 * rare and a 2s lag is invisible to humans on Telegram.
 *
 * Pure logic + scheduling. The card surface and the file I/O are
 * passed in so tests can drive deterministically.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { readAll, ISSUES_FILE } from "../src/issues/index.js";
import type { IssueEvent } from "../src/issues/index.js";
import type { IssuesCardHandle } from "./issues-card.js";

export const DEFAULT_POLL_INTERVAL_MS = 2_000;

export interface IssuesWatcherOpts {
  stateDir: string;
  card: IssuesCardHandle;
  /** Polling interval. Defaults to 2s. */
  pollIntervalMs?: number;
  /** stderr-style logger. Defaults to noop. */
  log?: (msg: string) => void;
  /** Inject for tests. */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  /** Inject for tests. Defaults to fs.statSync(...).mtimeMs. */
  mtimeProvider?: (path: string) => number | null;
  /** Inject for tests. Defaults to readAll from src/issues. */
  readEvents?: (stateDir: string) => IssueEvent[];
}

export interface IssuesWatcherHandle {
  /** Stop polling. Idempotent. */
  stop(): void;
  /** Force one read+refresh cycle now (used at startup). */
  tick(): Promise<void>;
}

export function startIssuesWatcher(
  opts: IssuesWatcherOpts,
): IssuesWatcherHandle {
  const path = join(opts.stateDir, ISSUES_FILE);
  const log = opts.log ?? (() => {});
  const intervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const setIntervalFn = opts.setInterval ?? setInterval;
  const clearIntervalFn = opts.clearInterval ?? clearInterval;
  const mtimeProvider = opts.mtimeProvider ?? defaultMtimeProvider;
  const readEvents = opts.readEvents ?? defaultReadEvents;

  let lastMtime: number | null = null;
  let stopped = false;

  async function readAndRefresh(): Promise<void> {
    const events = readEvents(opts.stateDir);
    try {
      await opts.card.refresh(events);
    } catch (err) {
      log(`issues-watcher: refresh failed: ${(err as Error).message}`);
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    const mtime = mtimeProvider(path);
    if (mtime === lastMtime) return;
    lastMtime = mtime;
    await readAndRefresh();
  }

  // Run a tick immediately so a card pre-existing on disk shows up at
  // gateway boot. The interval handles subsequent updates.
  void tick().catch((err) => {
    log(`issues-watcher: initial tick failed: ${(err as Error).message}`);
  });

  const timer = setIntervalFn(() => {
    void tick().catch((err) => {
      log(`issues-watcher: tick failed: ${(err as Error).message}`);
    });
  }, intervalMs);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(timer);
    },
    tick,
  };
}

function defaultMtimeProvider(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function defaultReadEvents(stateDir: string): IssueEvent[] {
  return readAll(stateDir);
}
