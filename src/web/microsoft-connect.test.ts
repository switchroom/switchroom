import { describe, expect, it } from "vitest";
import { startMicrosoftConnect, runMicrosoftConnectPoll } from "./microsoft-connect.js";
import { DEFAULT_MICROSOFT_CLIENT_ID } from "../auth/default-oauth-clients.js";
import type {
  MicrosoftDeviceCodeResponse,
  MicrosoftOAuthClientConfig,
  MicrosoftTokenResponse,
} from "../microsoft/oauth.js";

const PERSONAL_MSA_TID = "9188040d-6c67-4c5b-b112-36a304b66dad";
const DEVICE: MicrosoftDeviceCodeResponse = {
  device_code: "dc",
  user_code: "ABCD-EFGH",
  verification_uri: "https://microsoft.com/devicelogin",
  expires_in: 900,
  interval: 5,
};

function fakeIdToken(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}
function tokens(o: Partial<MicrosoftTokenResponse> = {}): MicrosoftTokenResponse {
  return { access_token: "at", refresh_token: "rt", expires_in: 3600, token_type: "Bearer", scope: "Mail.ReadWrite", ...o };
}

describe("startMicrosoftConnect (web)", () => {
  it("uses the shipped default client_id + scopes when there is no config", async () => {
    let seen: MicrosoftOAuthClientConfig | undefined;
    const res = await startMicrosoftConnect({ requestDeviceCode: async (cfg) => { seen = cfg; return DEVICE; } });
    expect(res.kind).toBe("started");
    if (res.kind === "started") {
      expect(res.source).toBe("default");
      expect(res.clientId).toBe(DEFAULT_MICROSOFT_CLIENT_ID);
      expect(res.scopes).toContain("offline_access");
      expect(res.device.user_code).toBe("ABCD-EFGH");
    }
    expect(seen?.client_id).toBe(DEFAULT_MICROSOFT_CLIENT_ID);
  });

  it("refuses a vaulted BYO client (web can't resolve vault refs)", async () => {
    const res = await startMicrosoftConnect({
      configClientId: "vault:microsoft-oauth-client-id",
      requestDeviceCode: async () => DEVICE,
    });
    expect(res.kind).toBe("byo-vault");
  });

  it("surfaces a device-code request failure as error", async () => {
    const res = await startMicrosoftConnect({ requestDeviceCode: async () => { throw new Error("boom"); } });
    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.message).toContain("boom");
  });
});

describe("runMicrosoftConnectPoll (web)", () => {
  const flow = { device: DEVICE, clientId: "c1", scopes: ["offline_access", "Mail.ReadWrite"] };

  it("connected: registers the account via the broker keyed by the authenticated email", async () => {
    const id_token = fakeIdToken({ tid: PERSONAL_MSA_TID, oid: "oid-1", preferred_username: "Lisa@Outlook.com" });
    const added: Array<{ label: string }> = [];
    const res = await runMicrosoftConnectPoll(flow, {
      pollDeviceToken: async () => tokens({ id_token }),
      addAccount: async (label) => { added.push({ label }); return {}; },
    });
    expect(res.state).toBe("connected");
    if (res.state === "connected") {
      expect(res.account).toBe("lisa@outlook.com");
      expect(res.accountType).toBe("personal");
    }
    expect(added).toEqual([{ label: "lisa@outlook.com" }]);
  });

  it("no-refresh-token: refuses to register an un-refreshable account", async () => {
    let added = false;
    const res = await runMicrosoftConnectPoll(flow, {
      pollDeviceToken: async () => tokens({ refresh_token: undefined }),
      addAccount: async () => { added = true; return {}; },
    });
    expect(res.state).toBe("no-refresh-token");
    expect(added).toBe(false);
  });

  it("failed: surfaces a poll error (e.g. work account rejected at /common)", async () => {
    const res = await runMicrosoftConnectPoll(flow, {
      pollDeviceToken: async () => { throw new Error("AADSTS9001023 work account"); },
      addAccount: async () => ({}),
    });
    expect(res.state).toBe("failed");
    if (res.state === "failed") expect(res.message).toContain("AADSTS9001023");
  });

  it("failed: no id_token → no resolvable account identity, not registered", async () => {
    let added = false;
    const res = await runMicrosoftConnectPoll(flow, {
      pollDeviceToken: async () => tokens({ id_token: undefined }),
      addAccount: async () => { added = true; return {}; },
    });
    expect(res.state).toBe("failed");
    if (res.state === "failed") expect(res.message).toContain("account identity");
    expect(added).toBe(false);
  });
});
