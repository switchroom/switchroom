/**
 * Bootstrap / workspace shared types.
 *
 * These types are shared between the workspace discovery pipeline
 * (`workspace.ts`) and the size-budget enforcement pipeline
 * (`bootstrap-budget.ts`). They live in their own module so the budget logic
 * can be imported and tested independently of workspace I/O.
 *
 * Ported from OpenClaw
 * (https://github.com/openclaw/openclaw, src/agents/workspace.ts and
 * src/agents/pi-embedded-helpers/types.ts), which is the reference
 * implementation for OpenClaw-style AGENTS.md / MEMORY.md bootstrap injection.
 */

export const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
export const DEFAULT_SOUL_FILENAME = "SOUL.md";
export const DEFAULT_TOOLS_FILENAME = "TOOLS.md";
export const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
export const DEFAULT_USER_FILENAME = "USER.md";
export const DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md";
export const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
export const DEFAULT_MEMORY_FILENAME = "MEMORY.md";
export const DEFAULT_BRIEF_FILENAME = "BRIEF.md";

export type WorkspaceBootstrapFileName =
  | typeof DEFAULT_AGENTS_FILENAME
  | typeof DEFAULT_SOUL_FILENAME
  | typeof DEFAULT_TOOLS_FILENAME
  | typeof DEFAULT_IDENTITY_FILENAME
  | typeof DEFAULT_USER_FILENAME
  | typeof DEFAULT_HEARTBEAT_FILENAME
  | typeof DEFAULT_BOOTSTRAP_FILENAME
  | typeof DEFAULT_MEMORY_FILENAME
  | typeof DEFAULT_BRIEF_FILENAME;

/**
 * A file discovered in the workspace bootstrap pipeline. `content` is the raw
 * file contents (no trimming) when present. `missing` is true when the file
 * does not exist in the workspace.
 */
export type WorkspaceBootstrapFile = {
  name: WorkspaceBootstrapFileName;
  path: string;
  content?: string;
  missing: boolean;
};

/**
 * An arbitrary `{ path, content }` pair, used by the injection pipeline to
 * represent the already-truncated content that will be embedded into the
 * system prompt.
 */
export type EmbeddedContextFile = { path: string; content: string };
