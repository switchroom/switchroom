/**
 * Type declarations for the PreToolUse hook module so TypeScript surfaces
 * (tool-activity-summary.ts's `describeToolUse`) can delegate to
 * `computeLabel` — the ONE status-vocabulary composer — without tsc
 * resolution errors. The runtime module is plain ESM (hooks are executed
 * directly by Claude Code, so they cannot be TS); main() is guarded behind
 * an is-main check, making the import side-effect-free.
 */
export function computeLabel(
  toolName: string,
  input: Record<string, unknown> | undefined | null,
): string | null
