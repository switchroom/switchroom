import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { ensurePythonEnv, PythonEnvError } from "../deps/python.js";
import { ensureNodeEnv, NodeEnvError } from "../deps/node.js";

function builtinSkillsRoot(): string {
  return resolve(import.meta.dirname, "../../skills");
}

export function registerDepsCommand(program: Command): void {
  const deps = program.command("deps").description("Manage cached per-skill dependency environments");

  deps
    .command("rebuild <skill>")
    .description(
      "Rebuild the Python venv and/or Node node_modules cache for a skill"
    )
    .option("-p, --python", "Rebuild only the Python env")
    .option("-n, --node", "Rebuild only the Node env")
    .action(async (skill: string, opts: { python?: boolean; node?: boolean }) => {
      const skillDir = join(builtinSkillsRoot(), skill);
      if (!existsSync(skillDir)) {
        console.error(chalk.red(`Unknown skill: ${skill} (no dir at ${skillDir})`));
        process.exit(1);
      }

      const requirementsPath = join(skillDir, "requirements.txt");
      const packageJsonPath = join(skillDir, "package.json");
      const wantPython =
        opts.python ?? (!opts.python && !opts.node && existsSync(requirementsPath));
      const wantNode =
        opts.node ?? (!opts.python && !opts.node && existsSync(packageJsonPath));

      let did = 0;

      if (wantPython) {
        if (!existsSync(requirementsPath)) {
          console.error(
            chalk.red(`Skill "${skill}" has no requirements.txt at ${requirementsPath}`)
          );
          process.exit(1);
        }
        try {
          console.log(chalk.gray(`Rebuilding Python env for ${skill}...`));
          const env = ensurePythonEnv({
            skillName: skill,
            requirementsPath,
            force: true,
          });
          console.log(
            chalk.green(`  ✓ Python env at ${env.venvDir} (python: ${env.pythonBin})`)
          );
          did++;
        } catch (err) {
          if (err instanceof PythonEnvError) {
            console.error(chalk.red(`  Python env failed: ${err.message}`));
            if (err.stderr) console.error(chalk.dim(err.stderr));
            process.exit(1);
          }
          throw err;
        }
      }

      if (wantNode) {
        if (!existsSync(packageJsonPath)) {
          console.error(
            chalk.red(`Skill "${skill}" has no package.json at ${packageJsonPath}`)
          );
          process.exit(1);
        }
        try {
          console.log(chalk.gray(`Rebuilding Node env for ${skill}...`));
          const env = ensureNodeEnv({
            skillName: skill,
            packageJsonPath,
            force: true,
          });
          console.log(
            chalk.green(`  ✓ Node env at ${env.dir} (node_modules: ${env.nodeModulesDir})`)
          );
          did++;
        } catch (err) {
          if (err instanceof NodeEnvError) {
            console.error(chalk.red(`  Node env failed: ${err.message}`));
            if (err.stderr) console.error(chalk.dim(err.stderr));
            process.exit(1);
          }
          throw err;
        }
      }

      if (did === 0) {
        console.error(
          chalk.yellow(
            `Skill "${skill}" has neither requirements.txt nor package.json — nothing to rebuild.`
          )
        );
        process.exit(1);
      }
    });
}
