import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

interface VaultFile {
  salt: string;
  iv: string;
  data: string;
  tag: string;
}

interface VaultData {
  secrets: Record<string, string>;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32) as Buffer;
}

function encrypt(key: Buffer, plaintext: string): { iv: string; data: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    data: encrypted.toString("hex"),
    tag: tag.toString("hex"),
  };
}

function decrypt(key: Buffer, iv: string, data: string, tag: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(data, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export function createVault(passphrase: string, vaultPath: string): void {
  if (existsSync(vaultPath)) {
    throw new VaultError(`Vault file already exists: ${vaultPath}`);
  }

  const dir = dirname(vaultPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const salt = randomBytes(16);
  const key = deriveKey(passphrase, salt);
  const vaultData: VaultData = { secrets: {} };
  const { iv, data, tag } = encrypt(key, JSON.stringify(vaultData));

  const vaultFile: VaultFile = {
    salt: salt.toString("hex"),
    iv,
    data,
    tag,
  };

  writeFileSync(vaultPath, JSON.stringify(vaultFile, null, 2), "utf8");
}

export function openVault(passphrase: string, vaultPath: string): Record<string, string> {
  if (!existsSync(vaultPath)) {
    throw new VaultError(`Vault file not found: ${vaultPath}`);
  }

  let vaultFile: VaultFile;
  try {
    vaultFile = JSON.parse(readFileSync(vaultPath, "utf8"));
  } catch {
    throw new VaultError(`Failed to read vault file: ${vaultPath}`);
  }

  const salt = Buffer.from(vaultFile.salt, "hex");
  const key = deriveKey(passphrase, salt);

  let plaintext: string;
  try {
    plaintext = decrypt(key, vaultFile.iv, vaultFile.data, vaultFile.tag);
  } catch {
    throw new VaultError("Failed to decrypt vault. Wrong passphrase?");
  }

  let vaultData: VaultData;
  try {
    vaultData = JSON.parse(plaintext);
  } catch {
    throw new VaultError("Vault data is corrupted");
  }

  return vaultData.secrets;
}

export function saveVault(
  passphrase: string,
  vaultPath: string,
  secrets: Record<string, string>
): void {
  if (!existsSync(vaultPath)) {
    throw new VaultError(`Vault file not found: ${vaultPath}`);
  }

  let vaultFile: VaultFile;
  try {
    vaultFile = JSON.parse(readFileSync(vaultPath, "utf8"));
  } catch {
    throw new VaultError(`Failed to read vault file: ${vaultPath}`);
  }

  const salt = Buffer.from(vaultFile.salt, "hex");
  const key = deriveKey(passphrase, salt);

  const vaultData: VaultData = { secrets };
  const { iv, data, tag } = encrypt(key, JSON.stringify(vaultData));

  vaultFile.iv = iv;
  vaultFile.data = data;
  vaultFile.tag = tag;

  writeFileSync(vaultPath, JSON.stringify(vaultFile, null, 2), "utf8");
}

export function setSecret(
  passphrase: string,
  vaultPath: string,
  key: string,
  value: string
): void {
  const secrets = openVault(passphrase, vaultPath);
  secrets[key] = value;
  saveVault(passphrase, vaultPath, secrets);
}

export function getSecret(
  passphrase: string,
  vaultPath: string,
  key: string
): string | null {
  const secrets = openVault(passphrase, vaultPath);
  return secrets[key] ?? null;
}

export function listSecrets(passphrase: string, vaultPath: string): string[] {
  const secrets = openVault(passphrase, vaultPath);
  return Object.keys(secrets);
}

export function removeSecret(
  passphrase: string,
  vaultPath: string,
  key: string
): void {
  const secrets = openVault(passphrase, vaultPath);
  if (!(key in secrets)) {
    throw new VaultError(`Secret not found: ${key}`);
  }
  delete secrets[key];
  saveVault(passphrase, vaultPath, secrets);
}
