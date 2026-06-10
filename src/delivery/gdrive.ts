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
 *   - POST /upload/drive/v3/files?uploadType=multipart — upload a small file
 *   - POST /upload/drive/v3/files?uploadType=resumable + PUT chunks — large file
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

/** Drive's single-request multipart upload is reliable up to ~5 MB; above
 *  that we switch to a resumable session. */
export const GDRIVE_MULTIPART_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Upload `bytes` as `filename` into folder `parentId`. Small files go in one
 * multipart request; files over the 5 MB cap use a resumable session (so the
 * "keep/edit, or > 50 MB" case the delivery guidance promises actually works).
 */
export async function uploadFile(
  deps: GDriveDeps,
  parentId: string,
  filename: string,
  bytes: Uint8Array,
  mimeType = "application/octet-stream",
): Promise<GFile> {
  if (bytes.byteLength <= GDRIVE_MULTIPART_MAX_BYTES) {
    return uploadMultipart(deps, parentId, filename, bytes, mimeType);
  }
  return uploadResumable(deps, parentId, filename, bytes, mimeType);
}

/** Single-request multipart upload (metadata + content). Small files only. */
export async function uploadMultipart(
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

/**
 * Resumable upload for files over the multipart cap. Two phases:
 *   1. POST metadata to `uploadType=resumable` → session URL in the `Location`
 *      response header.
 *   2. PUT the bytes in chunks to that URL with `Content-Range`; Drive replies
 *      308 (incomplete → keep going) until the final chunk returns 200/201 with
 *      the file resource.
 */
export async function uploadResumable(
  deps: GDriveDeps,
  parentId: string,
  filename: string,
  bytes: Uint8Array,
  mimeType = "application/octet-stream",
): Promise<GFile> {
  const f = deps.fetchImpl ?? fetch;

  // Phase 1: initiate the session.
  const init = await f(`${UPLOAD}/files?uploadType=resumable&fields=id,name,webViewLink`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deps.accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType,
    },
    body: JSON.stringify({ name: filename, parents: [parentId] }),
  });
  if (!init.ok) {
    throw new Error(`Drive resumable init failed: HTTP ${init.status} — ${await readBody(init)}`);
  }
  const sessionUrl = init.headers.get("location") ?? init.headers.get("Location");
  if (!sessionUrl) {
    throw new Error("Drive resumable init returned no session URL (Location header)");
  }

  // Phase 2: PUT chunks. 256 KiB multiple per Drive's rules.
  const CHUNK = 8 * 1024 * 1024; // 8 MiB
  const total = bytes.byteLength;
  let lastFile: GFile | null = null;
  for (let start = 0; start < total; start += CHUNK) {
    const end = Math.min(start + CHUNK, total);
    const chunk = bytes.subarray(start, end);
    const put = await f(sessionUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(chunk.byteLength),
        "Content-Range": `bytes ${start}-${end - 1}/${total}`,
      },
      body: chunk as unknown as BodyInit,
    });
    if (put.status === 200 || put.status === 201) {
      lastFile = (await put.json()) as GFile;
    } else if (put.status !== 308) {
      throw new Error(`Drive resumable chunk failed: HTTP ${put.status} — ${await readBody(put)}`);
    }
  }
  if (!lastFile) throw new Error("Drive resumable upload completed without a final file resource");
  return lastFile;
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
