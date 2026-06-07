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
import { deliverToOneDrive, type DeliveredFile } from "../delivery/onedrive.js";

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
  const agentName = deps.agentName ?? process.env.SWITCHROOM_AGENT_NAME ?? "agent";
  const sizeOf = deps.fileSize ?? ((p: string) => statSync(p).size);
  const read = deps.readFile ?? ((p: string) => new Uint8Array(readFileSync(p)));
  const getToken = deps.getAccessToken ?? brokerAccessToken;
  const deliver = deps.deliver ?? deliverToOneDrive;

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
