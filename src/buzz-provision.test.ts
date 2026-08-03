/**
 * Outcome tests for the Buzz provisioning core. This suite imports ONLY
 * `buzz-provision.ts` (no vault/broker/bun:sqlite), so it runs cleanly under
 * vitest and is fully hermetic — it never touches the real vault, broker, or
 * `~/.switchroom`. The side effects are injected fakes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { getPublicKey, nip19 } from "nostr-tools";
import {
  runBuzzProvision,
  provisionBuzzIdentity,
  computeBuzzStatus,
  buzzNsecKey,
  buzzAddMemberCommand,
  type BuzzProvisionStore,
  type BuzzGrantOutcome,
} from "./buzz-provision.js";

/** In-memory store recording every write + grant. Never touches real state. */
function makeStore(
  seed: Record<string, string> = {},
  grantResult: BuzzGrantOutcome = { ok: true },
) {
  const keys = new Map<string, string>(Object.entries(seed));
  const grants: { agent: string; key: string }[] = [];
  const store: BuzzProvisionStore = {
    hasNsec: (key) => keys.has(key),
    writeNsec: (key, nsec) => {
      keys.set(key, nsec);
    },
    grantRead: async (agent, key) => {
      grants.push({ agent, key });
      return grantResult;
    },
  };
  return { store, keys, grants };
}

/** Capture io + global console into one buffer, so ANY print path is seen. */
function captureOutput() {
  const lines: string[] = [];
  const io = {
    log: (m: string) => lines.push(m),
    error: (m: string) => lines.push(m),
  };
  const logSpy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
    lines.push(String(m));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((m?: unknown) => {
    lines.push(String(m));
  });
  return { lines, io, restore: () => { logSpy.mockRestore(); errSpy.mockRestore(); } };
}

afterEach(() => vi.restoreAllMocks());

describe("provisionBuzzIdentity", () => {
  it("writes an nsec whose derived npub matches the returned npub", async () => {
    const { store, keys } = makeStore();
    const res = await provisionBuzzIdentity("klanker", store);
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;

    const nsec = keys.get(buzzNsecKey("klanker"));
    expect(nsec).toBeDefined();
    // The stored value is a real bech32 nsec that decodes and derives to the
    // exact npub the command reports.
    const decoded = nip19.decode(nsec!);
    expect(decoded.type).toBe("nsec");
    const derivedNpub = nip19.npubEncode(
      getPublicKey(decoded.data as Uint8Array),
    );
    expect(derivedNpub).toBe(res.npub);
    expect(res.npub.startsWith("npub1")).toBe(true);
  });

  it("refuses an existing key without --rotate, overwrites with --rotate", async () => {
    const key = buzzNsecKey("klanker");
    const { store, keys } = makeStore({ [key]: "nsec1preexisting" });

    const refused = await provisionBuzzIdentity("klanker", store);
    expect(refused.kind).toBe("exists");
    // The pre-existing value is untouched.
    expect(keys.get(key)).toBe("nsec1preexisting");

    const rotated = await provisionBuzzIdentity("klanker", store, { rotate: true });
    expect(rotated.kind).toBe("ok");
    if (rotated.kind === "ok") expect(rotated.rotated).toBe(true);
    // A fresh, valid nsec replaced the old placeholder.
    const now = keys.get(key)!;
    expect(now).not.toBe("nsec1preexisting");
    expect(nip19.decode(now).type).toBe("nsec");
  });

  it("grants read for the correct agent + key by default", async () => {
    const { store, grants } = makeStore();
    const res = await provisionBuzzIdentity("robby", store);
    expect(grants).toEqual([{ agent: "robby", key: "buzz/robby-nsec" }]);
    if (res.kind === "ok") expect(res.grant).toBe("granted");
  });

  it("skips the grant with noGrant", async () => {
    const { store, grants } = makeStore();
    const res = await provisionBuzzIdentity("robby", store, { noGrant: true });
    expect(grants).toEqual([]);
    if (res.kind === "ok") expect(res.grant).toBe("skipped");
  });

  it("surfaces a grant failure without dropping the write", async () => {
    const { store, keys } = makeStore({}, { ok: false, error: "broker unreachable" });
    const res = await provisionBuzzIdentity("robby", store);
    expect(keys.has("buzz/robby-nsec")).toBe(true); // nsec still stored
    if (res.kind === "ok") expect(res.grant).toEqual({ failed: "broker unreachable" });
  });
});

describe("runBuzzProvision — nsec is never printed", () => {
  it("prints the npub and enrollment command but NEVER the nsec", async () => {
    const { store, keys } = makeStore();
    const { lines, io, restore } = captureOutput();
    try {
      const { exitCode, result } = await runBuzzProvision(
        "klanker",
        store,
        {},
        io,
      );
      expect(exitCode).toBe(0);
      expect(result.kind).toBe("ok");

      const output = lines.join("\n");
      const nsec = keys.get(buzzNsecKey("klanker"))!;

      // The load-bearing assertion: the actual secret material never appears
      // in ANY captured output (io OR stray console). This fails the moment a
      // debug print of the nsec is added anywhere on the path.
      expect(output).not.toContain(nsec);
      expect(output).not.toMatch(/nsec1[0-9a-z]/);

      // ...while the public artifacts DO appear.
      if (result.kind === "ok") {
        expect(output).toContain(result.npub);
        expect(output).toContain(buzzAddMemberCommand(result.npub));
        expect(output).toContain("nsec_vault_key");
      }
    } finally {
      restore();
    }
  });

  it("exits non-zero and prints a refusal when the key exists", async () => {
    const { store } = makeStore({ [buzzNsecKey("klanker")]: "nsec1old" });
    const { lines, io, restore } = captureOutput();
    try {
      const { exitCode } = await runBuzzProvision("klanker", store, {}, io);
      expect(exitCode).toBe(1);
      const output = lines.join("\n");
      expect(output).toContain("already provisioned");
      expect(output).toContain("--rotate");
      // Even the refusal path must not echo the stored secret.
      expect(output).not.toContain("nsec1old");
    } finally {
      restore();
    }
  });
});

describe("computeBuzzStatus", () => {
  const agent = "klanker";
  const key = buzzNsecKey(agent);

  const composeWithBuzz = [
    "services:",
    "  agent-klanker:",
    "    image: switchroom/agent",
    "    environment:",
    '      SWITCHROOM_AGENT_NAME: "klanker"',
    `      BUZZ_NSEC_VAULT_KEY: "${key}"`,
    '      BUZZ_ENABLED: "1"',
    "  agent-other:",
    "    image: switchroom/agent",
  ].join("\n");

  const composeWithoutBuzz = [
    "services:",
    "  agent-klanker:",
    "    image: switchroom/agent",
    "    environment:",
    '      SWITCHROOM_AGENT_NAME: "klanker"',
    "  agent-other:",
    "    environment:",
    '      BUZZ_ENABLED: "1"', // BUZZ_ on a DIFFERENT agent must not count
  ].join("\n");

  it("all four green when everything is wired and live", () => {
    const r = computeBuzzStatus(agent, {
      vaultKeys: [key, "other/thing"],
      grants: [{ agent_slug: agent, key_allow: [key] }],
      composeYaml: composeWithBuzz,
      logTail: "buzz nostr: AUTH accepted; (re)subscribing\nbuzz nostr: EOSE (live)",
    });
    expect(r.vaultKey.status).toBe("green");
    expect(r.grant.status).toBe("green");
    expect(r.composeEnv.status).toBe("green");
    expect(r.sidecar.status).toBe("green");
  });

  it("all four red when nothing is wired", () => {
    const r = computeBuzzStatus(agent, {
      vaultKeys: ["unrelated/key"],
      grants: [{ agent_slug: "someone-else", key_allow: [key] }],
      composeYaml: composeWithoutBuzz,
      logTail: "buzz nostr: NIP-42 AUTH answered\nbuzz nostr: AUTH rejected: bad",
    });
    expect(r.vaultKey.status).toBe("red");
    expect(r.grant.status).toBe("red");
    // BUZZ_ exists in the file but only on agent-other — the klanker block has none.
    expect(r.composeEnv.status).toBe("red");
    expect(r.sidecar.status).toBe("red");
  });

  it("grant red when the right key is granted to the WRONG agent", () => {
    const r = computeBuzzStatus(agent, {
      vaultKeys: [key],
      grants: [{ agent_slug: "other", key_allow: [key] }],
      composeYaml: composeWithBuzz,
      logTail: "EOSE (live)",
    });
    expect(r.grant.status).toBe("red");
  });

  it("unknown when a source could not be read", () => {
    const r = computeBuzzStatus(agent, {
      vaultKeys: null,
      grants: null,
      composeYaml: null,
      logTail: null,
    });
    expect(r.vaultKey.status).toBe("unknown");
    expect(r.grant.status).toBe("unknown");
    expect(r.composeEnv.status).toBe("unknown");
    expect(r.sidecar.status).toBe("unknown");
  });

  it("sidecar green on AUTH accepted alone", () => {
    const r = computeBuzzStatus(agent, {
      vaultKeys: [key],
      grants: [{ agent_slug: agent, key_allow: [key] }],
      composeYaml: composeWithBuzz,
      logTail: "buzz nostr: AUTH accepted; (re)subscribing",
    });
    expect(r.sidecar.status).toBe("green");
  });
});
