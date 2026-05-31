/**
 * Resolve the agent's state directory from the environment.
 *
 * `TELEGRAM_STATE_DIR` points at `<agentDir>/telegram`; the agent dir is
 * its parent. Returns null when the env var is unset or blank so callers
 * can degrade gracefully (the gateway runs in non-agent contexts too —
 * tests, local dev).
 */
import { dirname } from "node:path";

export function resolveAgentDirFromEnv(): string | null {
  const state = process.env.TELEGRAM_STATE_DIR;
  if (!state || state.trim().length === 0) return null;
  return dirname(state);
}
