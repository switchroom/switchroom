import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

export class PythonEnvError extends Error {
  readonly stderr?: string;
  constructor(message: string, stderr?: string) {
    super(message);
    this.name = "PythonEnvError";
    this.stderr = stderr;
  }
}

export interface PythonEnvOptions {
  skillName: string;
  requirementsPath: string;
  cacheRoot?: string;
  force?: boolean;
  pythonBin?: string;
}

export interface PythonEnv {
  skillName: string;
  venvDir: string;
  binDir: string;
  pythonBin: string;
  pipBin: string;
  rebuilt: boolean;
}

export function defaultPythonCacheRoot(): string {
  return join(homedir(), ".switchroom", "deps", "python");
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function ensurePythonEnv(opts: PythonEnvOptions): PythonEnv {
  const { skillName, requirementsPath, force = false } = opts;
  const cacheRoot = opts.cacheRoot ?? defaultPythonCacheRoot();
  const hostPython = opts.pythonBin ?? "python3";

  if (!existsSync(requirementsPath)) {
    throw new PythonEnvError(
      `requirements file not found: ${requirementsPath}`
    );
  }

  const venvDir = join(cacheRoot, skillName);
  const stampPath = join(venvDir, ".requirements.sha256");
  const binDir = join(venvDir, "bin");
  const pythonBin = join(binDir, "python");
  const pipBin = join(binDir, "pip");

  const targetHash = hashFile(requirementsPath);

  if (
    !force &&
    existsSync(stampPath) &&
    existsSync(pythonBin)
  ) {
    const existingHash = readFileSync(stampPath, "utf8").trim();
    if (existingHash === targetHash) {
      return {
        skillName,
        venvDir,
        binDir,
        pythonBin,
        pipBin,
        rebuilt: false,
      };
    }
  }

  if (existsSync(venvDir)) {
    rmSync(venvDir, { recursive: true, force: true });
  }
  mkdirSync(dirname(venvDir), { recursive: true });

  try {
    execFileSync(hostPython, ["-m", "venv", venvDir], { stdio: "pipe" });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    throw new PythonEnvError(
      `Failed to create venv for skill "${skillName}" with ${hostPython}: ${e.message}`,
      e.stderr?.toString()
    );
  }

  try {
    // Clear PIP_USER from the environment: when set in the parent shell
    // (a common pattern on Debian/Ubuntu hosts where the system python
    // forces PEP 668 user-site installs), pip-in-venv refuses with
    // "Can not perform a '--user' install. User site-packages are not
    // visible in this virtualenv." We deliberately install INTO the
    // venv, so override the inherited flag here.
    const childEnv = { ...process.env };
    delete childEnv.PIP_USER;
    delete childEnv.PIP_REQUIRE_VIRTUALENV;
    execFileSync(
      pipBin,
      ["install", "--disable-pip-version-check", "-r", requirementsPath],
      { stdio: "pipe", env: childEnv }
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    throw new PythonEnvError(
      `Failed to install requirements for skill "${skillName}": ${e.message}`,
      e.stderr?.toString()
    );
  }

  writeFileSync(stampPath, targetHash + "\n");

  return {
    skillName,
    venvDir,
    binDir,
    pythonBin,
    pipBin,
    rebuilt: true,
  };
}
