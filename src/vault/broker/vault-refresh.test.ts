/**
 * Regression tests for the stale-secret bug (#4736): the broker decrypted the
 * vault ONCE at unlock and served every `get` from memory, so an operator-side
 * `switchroom vault set <key>` wrote `vault.enc` and every agent kept reading
 * the OLD value indefinitely. SIGHUP swapped config only, and
 * `docker compose up -d` left a Running broker untouched — the sole recovery
 * was `docker restart switchroom-vault-broker`. Observed live on 2026-08-16:
 * `marko/postiz-db-url` was rewritten twice and marko kept serving the stale
 * DSN until the broker container was restarted.
 *
 * These drive `refreshVaultIfChanged` — the decision `VaultBroker` delegates to
 * on every get / list / put / preflight_access — against a REAL on-disk vault
 * (real scrypt, real AES-GCM, real tmp+rename writes), plus a call-site guard
 * pinning that the broker actually invokes it on those ops.
 *
 * Pre-fix, the broker had no refresh at all: cases 1-3 and 7 encode the
 * behaviour that was missing, and the call-site guard fails outright.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  refreshVaultIfChanged,
  readVaultStamp,
  sameVaultStamp,
  zeroSecrets,
  type VaultRefreshState,
} from "./vault-refresh.js";
import { createVault, setStringSecret, openVault } from "../vault.js";

const PASSPHRASE = "test-pass-phrase-for-lazy-reload";

/**
 * Every vault touch (createVault / setStringSecret / openVault) runs a real
 * scrypt derivation, so a single test spends seconds in the KDF. The runner's
 * 5s default is not enough — this is CPU, not a hang.
 */
const KDF_TIMEOUT_MS = 60_000;

let tmpDir: string;
let vaultPath: string;

/** The state the broker holds right after `unlockFromPassphrase`. */
function unlockedState(): VaultRefreshState {
  return {
    secrets: openVault(PASSPHRASE, vaultPath),
    passphrase: PASSPHRASE,
    loadedStamp: readVaultStamp(vaultPath),
    failedStamp: null,
  };
}

function valueOf(state: VaultRefreshState, key: string): string | undefined {
  const entry = state.secrets?.[key];
  if (entry === undefined) return undefined;
  return (entry as { value?: string }).value;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-refresh-"));
  vaultPath = path.join(tmpDir, "vault.enc");
  createVault(PASSPHRASE, vaultPath);
  setStringSecret(PASSPHRASE, vaultPath, "marko/postiz-db-url", "OLD_DSN");
}, KDF_TIMEOUT_MS);

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("refreshVaultIfChanged — out-of-band writes become visible", () => {
  it(
    "serves the NEW value after an operator-side `vault set` (the #4736 bug)",
    () => {
      const loaded = unlockedState();
      expect(valueOf(loaded, "marko/postiz-db-url")).toBe("OLD_DSN");

      // Out-of-band write — exactly what `switchroom vault set` does.
      setStringSecret(PASSPHRASE, vaultPath, "marko/postiz-db-url", "NEW_DSN");

      const next = refreshVaultIfChanged(loaded, { vaultPath });
      expect(valueOf(next, "marko/postiz-db-url")).toBe("NEW_DSN");
      // The stamp advanced, so the following read is a pure stat — no reopen.
      const currentStamp = readVaultStamp(vaultPath);
      expect(currentStamp).not.toBeNull();
      expect(sameVaultStamp(next.loadedStamp!, currentStamp!)).toBe(true);
      expect(next.failedStamp).toBeNull();
    },
    KDF_TIMEOUT_MS,
  );

  it(
    "picks up a key ADDED out of band (the `list`/`preflight_access` path)",
    () => {
      const loaded = unlockedState();
      expect(Object.keys(loaded.secrets!)).not.toContain("marko/new-key");

      setStringSecret(PASSPHRASE, vaultPath, "marko/new-key", "ADDED");

      const next = refreshVaultIfChanged(loaded, { vaultPath });
      expect(Object.keys(next.secrets!)).toContain("marko/new-key");
      expect(valueOf(next, "marko/postiz-db-url")).toBe("OLD_DSN");
    },
    KDF_TIMEOUT_MS,
  );

  it(
    "zeroes the superseded entries on swap, as lock() does",
    () => {
      const loaded = unlockedState();
      const supersededEntry = loaded.secrets!["marko/postiz-db-url"];

      setStringSecret(PASSPHRASE, vaultPath, "marko/postiz-db-url", "NEW_DSN");
      refreshVaultIfChanged(loaded, { vaultPath });

      expect((supersededEntry as { value: string }).value).toBe("");
    },
    KDF_TIMEOUT_MS,
  );

  it(
    "does NOT re-open while the file is untouched (stat-only hot path)",
    () => {
      const loaded = unlockedState();
      let opens = 0;
      const counting = (p: string, v: string) => {
        opens++;
        return openVault(p, v);
      };

      const a = refreshVaultIfChanged(loaded, { vaultPath, open: counting });
      const b = refreshVaultIfChanged(a, { vaultPath, open: counting });
      expect(opens).toBe(0);
      expect(b).toBe(loaded); // same object — a strict no-op
    },
    KDF_TIMEOUT_MS,
  );
});

describe("refreshVaultIfChanged — safety properties", () => {
  it(
    "is a strict no-op when the broker is LOCKED (never self-unlocks)",
    () => {
      const locked: VaultRefreshState = {
        secrets: null,
        passphrase: null,
        loadedStamp: null,
        failedStamp: null,
      };
      setStringSecret(PASSPHRASE, vaultPath, "marko/postiz-db-url", "NEW_DSN");

      const next = refreshVaultIfChanged(locked, { vaultPath, force: true });
      expect(next).toBe(locked);
      expect(next.secrets).toBeNull();
      expect(next.passphrase).toBeNull();
    },
    KDF_TIMEOUT_MS,
  );

  it(
    "is a no-op for seeded (no loadedStamp) state — test seams never hit disk",
    () => {
      const seeded: VaultRefreshState = {
        secrets: { "seeded/key": { kind: "string", value: "SEEDED" } },
        passphrase: PASSPHRASE,
        loadedStamp: null,
        failedStamp: null,
      };
      const next = refreshVaultIfChanged(seeded, { vaultPath, force: true });
      expect(next).toBe(seeded);
      expect(valueOf(next, "seeded/key")).toBe("SEEDED");
    },
    KDF_TIMEOUT_MS,
  );

  it(
    "keeps serving the loaded secrets when the vault is corrupt, then self-heals",
    () => {
      const loaded = unlockedState();
      const warnings: string[] = [];
      const warn = (m: string) => { warnings.push(m); };

      // Torn / partial write: the file changed but does not decrypt.
      fs.writeFileSync(vaultPath, "not-a-vault");

      const afterCorrupt = refreshVaultIfChanged(loaded, { vaultPath, warn });
      expect(valueOf(afterCorrupt, "marko/postiz-db-url")).toBe("OLD_DSN");
      expect(afterCorrupt.failedStamp).not.toBeNull();
      expect(warnings).toHaveLength(1);
      // Never logs a secret value.
      expect(warnings[0]).not.toContain("OLD_DSN");
      expect(warnings[0]).toContain(vaultPath);

      // A second read against the SAME bad file: no repeat warning and, more
      // importantly, no repeat scrypt derivation.
      let opens = 0;
      const counting = (p: string, v: string) => { opens++; return openVault(p, v); };
      const again = refreshVaultIfChanged(afterCorrupt, { vaultPath, warn, open: counting });
      expect(warnings).toHaveLength(1);
      expect(opens).toBe(0);
      expect(valueOf(again, "marko/postiz-db-url")).toBe("OLD_DSN");

      // The completing write lands a new inode → the next read self-heals.
      fs.rmSync(vaultPath);
      createVault(PASSPHRASE, vaultPath);
      setStringSecret(PASSPHRASE, vaultPath, "marko/postiz-db-url", "NEW_DSN");
      const healed = refreshVaultIfChanged(again, { vaultPath, warn });
      expect(valueOf(healed, "marko/postiz-db-url")).toBe("NEW_DSN");
      expect(healed.failedStamp).toBeNull();
    },
    KDF_TIMEOUT_MS,
  );

  it(
    "keeps serving when the vault file is unreadable / missing",
    () => {
      const loaded = unlockedState();
      fs.rmSync(vaultPath);
      const next = refreshVaultIfChanged(loaded, { vaultPath });
      expect(next).toBe(loaded);
      expect(valueOf(next, "marko/postiz-db-url")).toBe("OLD_DSN");
    },
    KDF_TIMEOUT_MS,
  );

  it(
    "force (the SIGHUP path) re-opens with the retained passphrase, unchanged file or not",
    () => {
      const loaded = unlockedState();
      let opens = 0;
      const counting = (p: string, v: string) => { opens++; return openVault(p, v); };

      const next = refreshVaultIfChanged(loaded, { vaultPath, force: true, open: counting });
      expect(opens).toBe(1);
      expect(valueOf(next, "marko/postiz-db-url")).toBe("OLD_DSN");
    },
    KDF_TIMEOUT_MS,
  );

  it("runs beforeOpen (layout-drift detection) before every re-open", () => {
    const loaded: VaultRefreshState = {
      secrets: { "k": { kind: "string", value: "v" } },
      passphrase: PASSPHRASE,
      loadedStamp: readVaultStamp(vaultPath),
      failedStamp: null,
    };
    const order: string[] = [];
    refreshVaultIfChanged(loaded, {
      vaultPath,
      force: true,
      beforeOpen: () => { order.push("beforeOpen"); },
      open: () => { order.push("open"); return {}; },
    });
    expect(order).toEqual(["beforeOpen", "open"]);
  });

  it("zeroSecrets blanks string and binary values", () => {
    const secrets = {
      a: { kind: "string" as const, value: "SECRET_A" },
      b: { kind: "binary" as const, value: "SECRET_B" },
    };
    zeroSecrets(secrets);
    expect(secrets.a.value).toBe("");
    expect(secrets.b.value).toBe("");
  });
});

/**
 * Call-site guard. The module above can be perfectly correct and the bug can
 * still be live if `server.ts` stops calling it on a read path — and no test
 * that constructs `VaultBroker` can run in CI (server.ts imports `bun:sqlite`
 * at module scope; the bun CI job only runs targets under `telegram-plugin/`
 * — see scripts/check-test-runner-coverage.mjs). So pin the call sites from
 * source: this fails if someone drops the refresh from any op that reads
 * `this.secrets`.
 */
describe("VaultBroker refreshes before every op that reads secrets", () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "server.ts"),
    "utf-8",
  );

  for (const op of ["list", "get", "put", "preflight_access"]) {
    it(`op:${op} calls _reloadSecretsIfVaultChanged`, () => {
      const idx = src.indexOf(`req.op === "${op}"`);
      expect(idx, `no \`req.op === "${op}"\` branch found in server.ts`).toBeGreaterThan(-1);
      // The refresh must be the first thing the branch does; 40 lines is
      // generous headroom for the branch's own preamble.
      const window = src.slice(idx).split("\n").slice(0, 40).join("\n");
      expect(window).toContain("this._reloadSecretsIfVaultChanged(");
    });
  }

  it("the SIGHUP reload() path forces a re-open", () => {
    const idx = src.indexOf("reload(config: SwitchroomConfig)");
    expect(idx).toBeGreaterThan(-1);
    const window = src.slice(idx).split("\n").slice(0, 15).join("\n");
    expect(window).toContain("this._reloadSecretsIfVaultChanged(true)");
  });
});
