/**
 * `switchroom deliver-file <path>` — deliver a file the agent produced to the
 * user, in a place they can actually reach. Uploads into the user's
 * `Switchroom/<agent>/` folder on their connected cloud drive and prints a
 * shareable link.
 *
 * Why a CLI verb (not an MCP tool): the agent already has Bash + `switchroom`
 * on PATH, and a switchroom-owned write to the agent's OWN delivery folder is
 * pre-authorized by design — so it bypasses the per-write MCP approval gate
 * (which exists to stop agents scribbling over the user's *existing* docs).
 * The agent runs this, gets a link, and replies with it. See the
 * DELIVERY_GUIDANCE fleet-invariant block.
 *
 * Providers: OneDrive (Microsoft) ships first — its broker creds already carry
 * an access token. Google Drive is the identical-shape follow-up.
 */
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { Command } from "commander";

import { AuthBrokerClient } from "../auth/broker/client.js";
import { deliverToOneDrive, type DeliveredFile, type ShareLinkScope } from "../delivery/onedrive.js";

/**
 * Resolve the OneDrive share-link scope order from `SWITCHROOM_DELIVER_LINK_SCOPE`.
 * Default ["anonymous","organization"] (anyone-with-link first — the right UX
 * for opening from Telegram). Set "organization" to require the recipient be in
 * the tenant (personal accounts then degrade to a sign-in-required item link).
 */
export function resolveLinkScopes(env = process.env): ShareLinkScope[] {
  const raw = (env.SWITCHROOM_DELIVER_LINK_SCOPE ?? "").trim().toLowerCase();
  if (raw === "organization") return ["organization"];
  if (raw === "anonymous") return ["anonymous"];
  return ["anonymous", "organization"];
}

/**
 * Defense-in-depth: agent names are schema-constrained to
 * /^[a-z0-9][a-z0-9_-]{0,50}$/, so they can't contain `/` or `..`. Re-assert
 * it here so a future caller / misconfigured env can't smuggle a path segment
 * into the Switchroom/<agent> folder path. Falls back to "agent".
 */
export function safeAgentName(name: string | undefined): string {
  const n = (name ?? "").trim();
  return /^[a-z0-9][a-z0-9_-]{0,50}$/.test(n) ? n : "agent";
}

/** Injectable seams so the core is unit-testable without a broker or network. */
export interface DeliverFileDeps {
  agentName?: string;
  /** Resolve a provider access token. Defaults to the auth-broker. */
  getAccessToken?: (provider: "microsoft") => Promise<string>;
  /** The actual upload. Defaults to the OneDrive provider. */
  deliver?: (args: {
    accessToken: string;
    agentName: string;
    localPath: string;
    bytes: Uint8Array;
  }) => Promise<DeliveredFile>;
  readFile?: (p: string) => Uint8Array;
  fileSize?: (p: string) => number;
}

export interface DeliverFileResult {
  ok: boolean;
  link?: string;
  folderPath?: string;
  filename?: string;
  error?: string;
}

async function brokerAccessToken(provider: "microsoft"): Promise<string> {
  const client = new AuthBrokerClient();
  const data = await client.getCredentials(provider);
  const creds = data.credentials as { microsoftOauth?: { accessToken?: string } } | undefined;
  const token = creds?.microsoftOauth?.accessToken;
  if (!token) {
    throw new Error("broker returned no Microsoft access token (is an account connected + enabled for this agent?)");
  }
  return token;
}

/**
 * Pure-ish core: resolve token → read file → upload → return a result. No
 * process.exit / console here so it's testable; the CLI wrapper formats output.
 */
export async function runDeliverFile(
  localPath: string,
  deps: DeliverFileDeps = {},
): Promise<DeliverFileResult> {
  const agentName = safeAgentName(deps.agentName ?? process.env.SWITCHROOM_AGENT_NAME);
  const sizeOf = deps.fileSize ?? ((p: string) => statSync(p).size);
  const read = deps.readFile ?? ((p: string) => new Uint8Array(readFileSync(p)));
  const getToken = deps.getAccessToken ?? brokerAccessToken;
  const deliver =
    deps.deliver ??
    ((a) => deliverToOneDrive({ ...a, linkScopes: resolveLinkScopes() }));

  let size: number;
  try {
    size = sizeOf(localPath);
  } catch {
    return { ok: false, error: `file not found: ${localPath}` };
  }
  if (size === 0) {
    return { ok: false, error: `file is empty: ${localPath}` };
  }

  let accessToken: string;
  try {
    accessToken = await getToken("microsoft");
  } catch (err) {
    return {
      ok: false,
      error:
        `no connected drive for delivery — ${(err as Error).message}. ` +
        `Connect a Microsoft account from the dashboard, or send the file ` +
        `directly with the reply tool (files: ["${localPath}"]) for files under 50MB.`,
    };
  }

  try {
    const bytes = read(localPath);
    const out = await deliver({ accessToken, agentName, localPath, bytes });
    return { ok: true, link: out.link, folderPath: out.folderPath, filename: basename(localPath) };
  } catch (err) {
    return { ok: false, error: `upload failed: ${(err as Error).message}` };
  }
}

export function registerDeliverFileCommand(program: Command): void {
  program
    .command("deliver-file")
    .description(
      "Deliver a file you produced to the user: upload it to their Switchroom/<agent>/ folder on the connected drive and print a shareable link. Reply with that link — never a local container path.",
    )
    .argument("<path>", "absolute local path of the file to deliver")
    .action(async (path: string) => {
      const res = await runDeliverFile(path);
      if (res.ok) {
        process.stdout.write(
          `Delivered ${res.filename} to the user's drive → ${res.folderPath}/\n` +
            `Share link (reply with this): ${res.link}\n`,
        );
        return;
      }
      process.stderr.write(`deliver-file: ${res.error}\n`);
      process.exitCode = 1;
    });
}
