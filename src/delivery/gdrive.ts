/**
 * Google Drive delivery provider — uploads a local file into the user's
 * `Switchroom/<agent>/` folder and returns a shareable link.
 *
 * Sibling to the OneDrive provider (`./onedrive.ts`), same shape — and the same
 * cred contract: the auth-broker keeps a FRESH access token on disk for Google
 * too (its background refresh-tick exchanges the refresh token), so the CLI
 * passes `googleOauth.accessToken` straight in; no token exchange here.
 *
 * All HTTP goes through an injectable `fetchImpl` (mockable; the `docs-get`
 * pattern) — never live-exercised in unit tests. A canary validates the real
 * upload.
 *
 * Drive v3 endpoints used:
 *   - GET  /drive/v3/files?q=...              — find a folder by name+parent
 *   - POST /drive/v3/files                    — create a folder
 *   - POST /upload/drive/v3/files?uploadType=multipart — upload a file
 *   - POST /drive/v3/files/<id>/permissions   — make it shareable
 *   - GET  /drive/v3/files/<id>?fields=webViewLink — the link
 */
import { basename } from "node:path";

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface GDriveDeps {
  accessToken: string;
  fetchImpl?: typeof fetch;
}

export interface GFile {
  id: string;
  name?: string;
  webViewLink?: string;
}

export interface DeliveredFile {
  itemId: string;
  link: string;
  folderPath: string;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

async function readBody(resp: Response): Promise<string> {
  try {
    const t = await resp.text();
    return t.length > 300 ? `${t.slice(0, 300)}…` : t;
  } catch {
    return "";
  }
}

/**
 * Find-or-create a folder named `name` under `parentId` ("root" for the drive
 * root). Idempotent: returns the first existing match, else creates one.
 */
export async function ensureFolder(
  deps: GDriveDeps,
  name: string,
  parentId: string,
): Promise<GFile> {
  const f = deps.fetchImpl ?? fetch;

  // Escape single quotes in the name for the Drive query language.
  const safeName = name.replace(/'/g, "\\'");
  const q = `name='${safeName}' and mimeType='${FOLDER_MIME}' and '${parentId}' in parents and trashed=false`;
  const listUrl = `${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`;
  const list = await f(listUrl, { headers: authHeaders(deps.accessToken) });
  if (!list.ok) {
    throw new Error(`Drive folder lookup failed: HTTP ${list.status} — ${await readBody(list)}`);
  }
  const found = (await list.json()) as { files?: GFile[] };
  if (found.files && found.files.length > 0) return found.files[0];

  const created = await f(`${DRIVE}/files?fields=id,name`, {
    method: "POST",
    headers: { ...authHeaders(deps.accessToken), "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  if (!created.ok) {
    throw new Error(`Drive folder create failed: HTTP ${created.status} — ${await readBody(created)}`);
  }
  return (await created.json()) as GFile;
}

/** Ensure `Switchroom/<agent>` under the drive root; returns its folder. */
export async function ensureSwitchroomFolder(
  deps: GDriveDeps,
  agentName: string,
): Promise<GFile> {
  const top = await ensureFolder(deps, "Switchroom", "root");
  return ensureFolder(deps, agentName, top.id);
}

/**
 * Upload `bytes` as `filename` into folder `parentId` via a multipart upload
 * (metadata + content in one request). Drive's simple/multipart upload handles
 * files up to 5 MB inline well; larger files would want a resumable session
 * (follow-up — the common delivery case is small).
 */
export async function uploadFile(
  deps: GDriveDeps,
  parentId: string,
  filename: string,
  bytes: Uint8Array,
  mimeType = "application/octet-stream",
): Promise<GFile> {
  const f = deps.fetchImpl ?? fetch;
  const boundary = "switchroom-deliver-boundary";
  const metadata = JSON.stringify({ name: filename, parents: [parentId] });
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);

  const resp = await f(`${UPLOAD}/files?uploadType=multipart&fields=id,name,webViewLink`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deps.accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body: body as unknown as BodyInit,
  });
  if (!resp.ok) {
    throw new Error(`Drive upload failed: HTTP ${resp.status} — ${await readBody(resp)}`);
  }
  return (await resp.json()) as GFile;
}

/** Drive sharing scope, attempted in order. */
export type GDriveShareScope = "anyone" | "domain";

/**
 * Make the file shareable and return its webViewLink. Tries each scope in
 * order (default `anyone` = anyone-with-link, the right UX for opening from
 * Telegram). SECURITY NOTE: `anyone` is anyone-with-link, no sign-in — a real
 * over-share if the link leaks. Operators tighten via the CLI's
 * SWITCHROOM_DELIVER_LINK_SCOPE knob.
 */
export async function createShareLink(
  deps: GDriveDeps,
  file: GFile,
  scopes: GDriveShareScope[] = ["anyone"],
): Promise<string> {
  const f = deps.fetchImpl ?? fetch;
  for (const type of scopes) {
    const resp = await f(`${DRIVE}/files/${file.id}/permissions`, {
      method: "POST",
      headers: { ...authHeaders(deps.accessToken), "Content-Type": "application/json" },
      body: JSON.stringify(type === "domain" ? { role: "reader", type: "domain" } : { role: "reader", type: "anyone" }),
    });
    if (resp.ok) break; // permission set — fall through to fetch the link
    // else try the next scope
  }
  // webViewLink may already be on the upload response; otherwise fetch it.
  if (file.webViewLink) return file.webViewLink;
  const meta = await f(`${DRIVE}/files/${file.id}?fields=webViewLink`, {
    headers: authHeaders(deps.accessToken),
  });
  if (meta.ok) {
    const j = (await meta.json()) as { webViewLink?: string };
    if (j.webViewLink) return j.webViewLink;
  }
  throw new Error("Drive: could not resolve a webViewLink for the uploaded file");
}

/** Full delivery: ensure folder → upload → shareable link. */
export async function deliverToGoogleDrive(args: {
  accessToken: string;
  agentName: string;
  localPath: string;
  bytes: Uint8Array;
  fetchImpl?: typeof fetch;
  linkScopes?: GDriveShareScope[];
}): Promise<DeliveredFile> {
  const deps: GDriveDeps = { accessToken: args.accessToken, fetchImpl: args.fetchImpl };
  const folder = await ensureSwitchroomFolder(deps, args.agentName);
  const filename = basename(args.localPath);
  const file = await uploadFile(deps, folder.id, filename, args.bytes);
  const link = await createShareLink(deps, file, args.linkScopes);
  return { itemId: file.id, link, folderPath: `Switchroom/${args.agentName}` };
}
