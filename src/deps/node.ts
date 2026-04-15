import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

export class NodeEnvError extends Error {
  readonly stderr?: string;
  constructor(message: string, stderr?: string) {
    super(message);
    this.name = "NodeEnvError";
    this.stderr = stderr;
  }
}

export interface NodeEnvOptions {
  skillName: string;
  packageJsonPath: string;
  cacheRoot?: string;
  force?: boolean;
  installer?: "bun" | "npm";
}

export interface NodeEnv {
  skillName: string;
  dir: string;
  nodeModulesDir: string;
  binDir: string;
  rebuilt: boolean;
}

const ALL_LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
] as const;

const LOCKFILES_FOR: Record<"bun" | "npm", readonly string[]> = {
  bun: ["bun.lock", "bun.lockb"],
  npm: ["package-lock.json"],
};

export function defaultNodeCacheRoot(): string {
  return join(homedir(), ".switchroom", "deps", "node");
}

function hashDepInputs(packageJsonPath: string): string {
  const sourceDir = dirname(packageJsonPath);
  const hasher = createHash("sha256");
  hasher.update("package.json\n");
  hasher.update(readFileSync(packageJsonPath));
  // Hash ANY lockfile flavor so a lockfile change always invalidates the
  // cache, regardless of which installer is in use.
  for (const lockName of ALL_LOCKFILES) {
    const lockPath = join(sourceDir, lockName);
    if (existsSync(lockPath)) {
      hasher.update("\n");
      hasher.update(lockName);
      hasher.update("\n");
      hasher.update(readFileSync(lockPath));
    }
  }
  return hasher.digest("hex");
}

export function ensureNodeEnv(opts: NodeEnvOptions): NodeEnv {
  const { skillName, packageJsonPath, force = false } = opts;
  const cacheRoot = opts.cacheRoot ?? defaultNodeCacheRoot();
  const installer = opts.installer ?? "bun";

  if (!existsSync(packageJsonPath)) {
    throw new NodeEnvError(`package.json not found: ${packageJsonPath}`);
  }

  const sourceDir = dirname(packageJsonPath);
  const envDir = join(cacheRoot, skillName);
  const stampPath = join(envDir, ".package.sha256");
  const nodeModulesDir = join(envDir, "node_modules");
  const binDir = join(nodeModulesDir, ".bin");

  const targetHash = hashDepInputs(packageJsonPath);

  if (!force && existsSync(stampPath) && existsSync(nodeModulesDir)) {
    const existingHash = readFileSync(stampPath, "utf8").trim();
    if (existingHash === targetHash) {
      return {
        skillName,
        dir: envDir,
        nodeModulesDir,
        binDir,
        rebuilt: false,
      };
    }
  }

  if (existsSync(envDir)) {
    rmSync(envDir, { recursive: true, force: true });
  }
  mkdirSync(envDir, { recursive: true });

  copyFileSync(packageJsonPath, join(envDir, "package.json"));
  // Only copy lockfiles the target installer actually understands — bun
  // validates bun.lock syntax, so handing it an alien lockfile would
  // poison the install.
  let copiedLockfile = false;
  for (const lockName of LOCKFILES_FOR[installer]) {
    const lockPath = join(sourceDir, lockName);
    if (existsSync(lockPath)) {
      copyFileSync(lockPath, join(envDir, lockName));
      copiedLockfile = true;
    }
  }

  try {
    if (installer === "bun") {
      const args = copiedLockfile
        ? ["install", "--frozen-lockfile"]
        : ["install"];
      execFileSync("bun", args, { cwd: envDir, stdio: "pipe" });
    } else {
      const args = copiedLockfile ? ["ci"] : ["install"];
      execFileSync("npm", args, { cwd: envDir, stdio: "pipe" });
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    throw new NodeEnvError(
      `Failed to install node deps for skill "${skillName}" with ${installer}: ${e.message}`,
      e.stderr?.toString()
    );
  }

  writeFileSync(stampPath, targetHash + "\n");

  return {
    skillName,
    dir: envDir,
    nodeModulesDir,
    binDir,
    rebuilt: true,
  };
}
