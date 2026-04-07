import type { ClerkConfig } from "../config/schema.js";
import { openVault } from "./vault.js";
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
  secrets: Record<string, string>
): unknown {
  if (typeof value === "string" && isVaultReference(value)) {
    const key = parseVaultReference(value);
    const secret = secrets[key];
    if (secret === undefined) {
      throw new Error(`Vault secret not found: ${key}`);
    }
    return secret;
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
  config: ClerkConfig,
  passphrase: string
): ClerkConfig {
  const vaultPath = resolvePath(config.vault?.path ?? "~/.clerk/vault.enc");
  const secrets = openVault(passphrase, vaultPath);
  return resolveValue(config, secrets) as ClerkConfig;
}
