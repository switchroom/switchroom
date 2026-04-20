import type { Command } from "commander";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

import { withConfigError, getConfig } from "./helpers.js";
import { resolveAgentsDir } from "../config/loader.js";
import {
  buildDynamicBootstrapPrompt,
  buildStableBootstrapPrompt,
  resolveAgentWorkspaceDir,
  DEFAULT_BOOTSTRAP_MAX_CHARS,
  DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS,
  DEFAULT_DYNAMIC_TOTAL_MAX_CHARS,
} from "../agents/workspace.js";
import { BootstrapBudgetExceededError, type BootstrapPromptWarningMode } from "../agents/bootstrap-budget.js";
import {
  DEFAULT_MEMORY_SEARCH_MAX_RESULTS,
  getWorkspaceMemoryFile,
  searchWorkspaceMemory,
} from "../agents/memory-search.js";

/**
 * `switchroom workspace` commands — surface to inspect and edit the
 * OpenClaw-style bootstrap layer (AGENTS.md, USER.md, MEMORY.md, ...).
 *
 * Commands:
 * - `render <agent> --stable|--dynamic`: print the rendered Project
 *   Context block (used by start.sh for stable files, and by the
 *   UserPromptSubmit hook for dynamic files).
 * - `path <agent>`: print the workspace directory path.
 * - `edit <agent> [file]`: open a workspace file in $EDITOR (or `vi`).
 *
 * Exits 0 on every expected failure (missing agent, missing workspace
 * dir, etc.) so start.sh and hook scripts never block on workspace
 * config noise.
 */

/**
 * Returns true iff `target` is the resolved workspace dir itself, or a
 * path strictly inside it. Both arguments must already be absolute +
 * normalised (e.g. via `path.resolve`). Uses a trailing separator on the
 * prefix check so a sibling like `/.../workspace-evil` cannot masquerade
 * as `/.../workspace` via plain `startsWith`.
 */
export function isInsideWorkspace(
  resolvedWorkspace: string,
  target: string,
): boolean {
  if (target === resolvedWorkspace) return true;
  return target.startsWith(`${resolvedWorkspace}${sep}`);
}

export function registerWorkspaceCommand(program: Command): void {
  const cmd = program
    .command("workspace")
    .description("Manage the agent's bootstrap workspace (AGENTS.md, MEMORY.md, ...)");

  cmd
    .command("path <agent>")
    .description("Print the path to the agent's workspace directory")
    .action(
      withConfigError(async (agentName: string) => {
        const dir = resolveAgentWorkspaceDirOrExit(program, agentName);
        if (!dir) return;
        process.stdout.write(`${dir}\n`);
      }),
    );

  cmd
    .command("render <agent>")
    .description(
      "Render the agent's workspace bootstrap block to stdout " +
        "(used by start.sh and the UserPromptSubmit hook)",
    )
    .option("--stable", "Render only stable files (AGENTS/SOUL/USER/IDENTITY/TOOLS/BOOTSTRAP)")
    .option("--dynamic", "Render only dynamic files (MEMORY + today/yesterday daily + HEARTBEAT)")
    .option(
      "--warning-mode <mode>",
      "Truncation warning mode: off | once | always | error (default: off for start.sh use)",
      "off",
    )
    .option(
      "--max-per-file <n>",
      "Per-file char cap",
      String(DEFAULT_BOOTSTRAP_MAX_CHARS),
    )
    .option(
      "--max-total <n>",
      "Total char cap (defaults differ for stable vs dynamic)",
    )
    .action(
      withConfigError(
        async (
          agentName: string,
          opts: {
            stable?: boolean;
            dynamic?: boolean;
            warningMode: string;
            maxPerFile: string;
            maxTotal?: string;
          },
        ) => {
          const dir = resolveAgentWorkspaceDirOrExit(program, agentName);
          if (!dir) return;

          const stable = opts.stable ?? !opts.dynamic;
          const dynamic = opts.dynamic ?? false;
          if (stable && dynamic) {
            process.stderr.write(
              "workspace render: pass only one of --stable / --dynamic\n",
            );
            return;
          }

          const warningMode = normalizeWarningMode(opts.warningMode);
          const maxPerFile = safeParseInt(opts.maxPerFile, DEFAULT_BOOTSTRAP_MAX_CHARS);
          const defaultTotal = dynamic
            ? DEFAULT_DYNAMIC_TOTAL_MAX_CHARS
            : DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS;
          const maxTotal = opts.maxTotal
            ? safeParseInt(opts.maxTotal, defaultTotal)
            : defaultTotal;

          try {
            const result = dynamic
              ? await buildDynamicBootstrapPrompt({
                  workspaceDir: dir,
                  budget: {
                    bootstrapMaxChars: maxPerFile,
                    bootstrapTotalMaxChars: maxTotal,
                    warningMode,
                  },
                })
              : await buildStableBootstrapPrompt({
                  workspaceDir: dir,
                  budget: {
                    bootstrapMaxChars: maxPerFile,
                    bootstrapTotalMaxChars: maxTotal,
                    warningMode,
                  },
                });

            if (result.concatenated.length > 0) {
              process.stdout.write(result.concatenated);
              if (!result.concatenated.endsWith("\n")) {
                process.stdout.write("\n");
              }
            }

            if (result.warning.warningShown && result.warning.lines.length > 0) {
              process.stderr.write(
                `[workspace render] bootstrap truncation (${result.analysis.truncatedFiles.length} file(s)):\n`,
              );
              for (const line of result.warning.lines) {
                process.stderr.write(`  ${line}\n`);
              }
            }
          } catch (err) {
            if (err instanceof BootstrapBudgetExceededError) {
              process.stderr.write(`Error: ${err.message}\n`);
              process.exit(1);
            }
            throw err;
          }
        },
      ),
    );

  cmd
    .command("edit <agent> [file]")
    .description(
      "Open a workspace file in $EDITOR. File defaults to AGENTS.md; " +
        "pass a relative path to edit a nested file (e.g. memory/2026-04-19.md).",
    )
    .action(
      withConfigError(async (agentName: string, file?: string) => {
        const dir = resolveAgentWorkspaceDirOrExit(program, agentName);
        if (!dir) return;
        const resolvedWorkspace = resolve(dir);
        const target = resolve(resolvedWorkspace, file ?? "AGENTS.md");
        // Path traversal guard: require the resolved target to be INSIDE the
        // workspace dir, not just share a prefix with it. Without the
        // trailing separator a sibling like /.../workspace-evil would pass
        // the startsWith check (classic npm/tar 2021 bug pattern).
        if (!isInsideWorkspace(resolvedWorkspace, target)) {
          process.stderr.write(
            `workspace edit: refusing path traversal outside workspace dir (${target})\n`,
          );
          process.exit(1);
        }
        const editor = process.env["EDITOR"] ?? process.env["VISUAL"] ?? "vi";
        const child = spawnSync(editor, [target], { stdio: "inherit" });
        if (child.status !== 0 && child.status !== null) {
          process.exit(child.status);
        }
      }),
    );

  cmd
    .command("show <agent> [file]")
    .description("Print the contents of a single workspace file (default: AGENTS.md)")
    .action(
      withConfigError(async (agentName: string, file?: string) => {
        const dir = resolveAgentWorkspaceDirOrExit(program, agentName);
        if (!dir) return;
        try {
          const res = await getWorkspaceMemoryFile({
            workspaceDir: dir,
            relativePath: file ?? "AGENTS.md",
          });
          process.stdout.write(res.content);
          if (res.truncated) {
            process.stderr.write(
              `\n[workspace show] truncated at ${res.content.length}/${res.bytes} bytes.\n`,
            );
          }
        } catch (err) {
          process.stderr.write(
            `workspace show: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exit(1);
        }
      }),
    );

  cmd
    .command("search <agent> <query...>")
    .description(
      "BM25-lite search over the agent's workspace markdown files " +
        "(MEMORY.md, memory/*.md, AGENTS.md, ...). Returns ranked matches with snippets.",
    )
    .option(
      "-n, --max-results <n>",
      "Maximum results to return",
      String(DEFAULT_MEMORY_SEARCH_MAX_RESULTS),
    )
    .option("--json", "Output raw JSON")
    .action(
      withConfigError(
        async (
          agentName: string,
          queryParts: string[],
          opts: { maxResults: string; json?: boolean },
        ) => {
          const dir = resolveAgentWorkspaceDirOrExit(program, agentName);
          if (!dir) return;
          const query = queryParts.join(" ").trim();
          const maxResults = safeParseInt(opts.maxResults, DEFAULT_MEMORY_SEARCH_MAX_RESULTS);
          const result = await searchWorkspaceMemory({
            workspaceDir: dir,
            query,
            maxResults,
          });
          if (opts.json) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            return;
          }
          if (result.hits.length === 0) {
            process.stdout.write(
              `No matches for "${query}" in ${result.indexedFiles} file(s).\n`,
            );
            return;
          }
          process.stdout.write(
            `${result.hits.length} result(s) (of ${result.totalMatches} matches across ${result.indexedFiles} files):\n\n`,
          );
          for (const hit of result.hits) {
            process.stdout.write(
              `  ${hit.path}:${hit.line}  [score ${hit.score}]\n    ${hit.snippet.replace(/\n/g, " ")}\n\n`,
            );
          }
        },
      ),
    );

  cmd
    .command("commit <agent>")
    .description("Commit current workspace state as a git checkpoint")
    .option("-m, --message <message>", "Commit message (defaults to timestamp)")
    .action(
      withConfigError(async (agentName: string, opts: { message?: string }) => {
        const dir = resolveAgentWorkspaceDirOrExit(program, agentName);
        if (!dir) return;

        // Check if workspace is a git repo
        const gitDir = resolve(dir, ".git");
        if (!existsSync(gitDir)) {
          process.stdout.write(
            `Workspace is not a git repository. Re-run \`switchroom agent create ${agentName}\` ` +
            `or manually \`git init\` in ${dir} to enable versioning.\n`,
          );
          return;
        }

        // Check for changes
        const statusResult = spawnSync("git", ["status", "--short"], {
          cwd: dir,
          encoding: "utf-8",
        });
        if (statusResult.status !== 0) {
          process.stderr.write(
            `git status failed: ${statusResult.stderr || statusResult.stdout}\n`,
          );
          process.exit(1);
        }

        if (!statusResult.stdout.trim()) {
          process.stdout.write("No changes to commit.\n");
          return;
        }

        // Generate commit message
        const message = opts.message || `checkpoint: ${new Date().toISOString()}`;

        // Stage and commit
        const addResult = spawnSync("git", ["add", "-A"], {
          cwd: dir,
          encoding: "utf-8",
        });
        if (addResult.status !== 0) {
          process.stderr.write(
            `git add failed: ${addResult.stderr || addResult.stdout}\n`,
          );
          process.exit(1);
        }

        const commitResult = spawnSync("git", ["commit", "-m", message], {
          cwd: dir,
          encoding: "utf-8",
        });
        if (commitResult.status !== 0) {
          process.stderr.write(
            `git commit failed: ${commitResult.stderr || commitResult.stdout}\n`,
          );
          process.exit(1);
        }

        // Get commit SHA
        const shaResult = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
          cwd: dir,
          encoding: "utf-8",
        });
        const sha = shaResult.stdout.trim();

        process.stdout.write(`Committed workspace changes: ${sha}\n`);
        if (commitResult.stdout) {
          process.stdout.write(commitResult.stdout);
        }
      }),
    );

  cmd
    .command("status <agent>")
    .description("Show git status of the workspace")
    .action(
      withConfigError(async (agentName: string) => {
        const dir = resolveAgentWorkspaceDirOrExit(program, agentName);
        if (!dir) return;

        const gitDir = resolve(dir, ".git");
        if (!existsSync(gitDir)) {
          process.stdout.write(
            `Workspace is not a git repository.\n`,
          );
          return;
        }

        const child = spawnSync("git", ["status", "--short"], {
          cwd: dir,
          stdio: "inherit",
        });
        if (child.status !== 0 && child.status !== null) {
          process.exit(child.status);
        }
      }),
    );
}

function resolveAgentWorkspaceDirOrExit(
  program: Command,
  agentName: string,
): string | undefined {
  const config = getConfig(program);
  const agentConfig = config.agents[agentName];
  if (!agentConfig) {
    process.stderr.write(
      `workspace: agent "${agentName}" not defined in switchroom.yaml\n`,
    );
    return undefined;
  }
  const agentsDir = resolveAgentsDir(config);
  const agentDir = resolve(agentsDir, agentName);
  const dir = resolveAgentWorkspaceDir(agentDir);
  if (!existsSync(dir)) {
    process.stderr.write(
      `workspace: ${dir} does not exist yet. Run \`switchroom setup\` or \`switchroom agent scaffold ${agentName}\` to seed it.\n`,
    );
    return undefined;
  }
  return dir;
}

function normalizeWarningMode(value: string | undefined): BootstrapPromptWarningMode {
  switch ((value ?? "").toLowerCase()) {
    case "off":
      return "off";
    case "always":
      return "always";
    case "error":
      return "error";
    case "once":
    default:
      return "once";
  }
}

function safeParseInt(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}
