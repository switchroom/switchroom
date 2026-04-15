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

function resolveValue(
  value: unknown,
  secrets: Record<string, VaultEntry>
): unknown {
  if (typeof value === "string" && isVaultReference(value)) {
    const key = parseVaultReference(value);
    const entry = secrets[key];
    if (entry === undefined) {
      throw new Error(`Vault secret not found: ${key}`);
    }
    if (entry.kind === "string") {
      return entry.value;
    }
    if (entry.kind === "binary") {
      return entry.value;
    }
    throw new Error(
      `Vault secret "${key}" is kind="${entry.kind}"; materialization into config is not yet supported (Phase 9.1 step 2).`
    );
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
