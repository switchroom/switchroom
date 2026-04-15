import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SwitchroomConfig } from "../config/schema.js";
import { openVault, type VaultEntry } from "./vault.js";
import { resolvePath } from "../config/loader.js";

export function isVaultReference(value: string): boolean {
  return value.startsWith("vault:");
}

export function parseVaultReference(value: string): string {
  if (!isVaultReference(value)) {
    throw new Error(`Not a vault reference: ${value}`);
  }
  return value.slice("vault:".length);
}

export interface ParsedVaultRef {
  key: string;
  filename?: string;
}

export function parseVaultReferenceDetailed(value: string): ParsedVaultRef {
  const body = parseVaultReference(value);
  const hashIdx = body.indexOf("#");
  if (hashIdx === -1) return { key: body };
  return { key: body.slice(0, hashIdx), filename: body.slice(hashIdx + 1) };
}

const materializedDirs = new Set<string>();
let cleanupRegistered = false;

function registerCleanupHook(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const cleanup = (): void => {
    for (const dir of materializedDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    materializedDirs.clear();
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
}

function materializationRoot(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return join(xdg, "switchroom", "vault", String(process.pid));
  const uid =
    typeof process.getuid === "function" ? String(process.getuid()) : "x";
  return join(tmpdir(), `switchroom-vault-${uid}-${process.pid}`);
}

export function materializeFilesEntry(
  key: string,
  files: Record<string, { encoding: "utf8" | "base64"; value: string }>
): string {
  const dir = join(materializationRoot(), key);
  // Wipe any pre-existing dir from a prior resolve in the same process.
  if (materializedDirs.has(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync's mode isn't reliably applied to existing intermediates on
  // all platforms; force it on the leaf.
  chmodSync(dir, 0o700);

  for (const [filename, { encoding, value }] of Object.entries(files)) {
    const filePath = join(dir, filename);
    const content =
      encoding === "base64" ? Buffer.from(value, "base64") : value;
    writeFileSync(filePath, content, { mode: 0o600 });
  }

  materializedDirs.add(dir);
  registerCleanupHook();
  return dir;
}

export function cleanupMaterializedSecrets(): void {
  for (const dir of materializedDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  materializedDirs.clear();
}

function resolveSingleReference(
  ref: ParsedVaultRef,
  secrets: Record<string, VaultEntry>
): string {
  const entry = secrets[ref.key];
  if (entry === undefined) {
    throw new Error(`Vault secret not found: ${ref.key}`);
  }

  // `vault:<key>#<filename>` — inline a specific file's contents as a string.
  if (ref.filename !== undefined) {
    if (entry.kind !== "files") {
      throw new Error(
        `Vault reference "vault:${ref.key}#${ref.filename}" expected kind="files", got kind="${entry.kind}".`
      );
    }
    const file = entry.files[ref.filename];
    if (!file) {
      throw new Error(
        `Vault secret "${ref.key}" has no file named "${ref.filename}". Available: ${Object.keys(entry.files).join(", ")}`
      );
    }
    return file.encoding === "base64"
      ? Buffer.from(file.value, "base64").toString("utf8")
      : file.value;
  }

  // `vault:<key>` — substitute based on entry kind.
  if (entry.kind === "string" || entry.kind === "binary") {
    return entry.value;
  }
  // kind === "files" — materialize to a temp dir and substitute the dir path.
  return materializeFilesEntry(ref.key, entry.files);
}

function resolveValue(
  value: unknown,
  secrets: Record<string, VaultEntry>
): unknown {
  if (typeof value === "string" && isVaultReference(value)) {
    const ref = parseVaultReferenceDetailed(value);
    return resolveSingleReference(ref, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, secrets));
  }
  if (value !== null && typeof value === "object") {
    const resolved: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      resolved[k] = resolveValue(v, secrets);
    }
    return resolved;
  }
  return value;
}

export function resolveVaultReferences(
  config: SwitchroomConfig,
  passphrase: string
): SwitchroomConfig {
  const vaultPath = resolvePath(config.vault?.path ?? "~/.switchroom/vault.enc");
  const secrets = openVault(passphrase, vaultPath);
  return resolveValue(config, secrets) as SwitchroomConfig;
}
