/**
 * OneDrive delivery provider — uploads a local file into the user's
 * `Switchroom/<agent>/` folder and returns a shareable link.
 *
 * One of the file-delivery providers (sibling to the Google Drive provider).
 * Used by `switchroom deliver-file` so an agent can hand a file to the user
 * in a place they can actually reach, instead of a local container path.
 *
 * All HTTP goes through an injectable `fetchImpl` (mockable in tests, à la
 * `src/drive/docs-get.ts`) — these functions are never exercised against the
 * real Graph API in unit tests; the request shapes are asserted instead, and
 * a live canary validates the real upload.
 *
 * Graph endpoints used (all under `/me/drive`):
 *   - GET    root:/<path>                — look up a folder by path
 *   - POST   root[:/<parent>:]/children  — create a folder
 *   - PUT    items/<id>:/<name>:/content — small (<=4MB) upload
 *   - POST   items/<id>/createUploadSession + PUT chunks — large upload
 *   - POST   items/<id>/createLink       — shareable link
 */
import { basename } from "node:path";

const GRAPH = "https://graph.microsoft.com/v1.0";

/** Graph caps a single inline PUT at 4 MB; larger files need an upload session. */
export const ONEDRIVE_INLINE_MAX_BYTES = 4 * 1024 * 1024;

export interface OneDriveDeps {
  accessToken: string;
  fetchImpl?: typeof fetch;
}

export interface DriveItem {
  id: string;
  name: string;
  webUrl?: string;
}

export interface DeliveredFile {
  /** The OneDrive item id. */
  itemId: string;
  /** A link the user can open. Prefers an anonymous share link; falls back to
   *  the item's own webUrl when org policy blocks anonymous sharing. */
  link: string;
  /** The `Switchroom/<agent>` folder the file landed in (for the reply text). */
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
 * Find-or-create a single child folder by name under `parentPath` (a Graph
 * path like "" for root, or "/Switchroom"). Idempotent: an existing folder is
 * returned, a missing one is created. A 409 conflict (created concurrently) is
 * treated as "exists" and re-fetched.
 */
export async function ensureFolder(
  deps: OneDriveDeps,
  parentPath: string,
  name: string,
): Promise<DriveItem> {
  const f = deps.fetchImpl ?? fetch;
  const childPath = `${parentPath}/${name}`;

  // 1. Look it up by path.
  const getUrl = `${GRAPH}/me/drive/root:${encodeURI(childPath)}`;
  const got = await f(getUrl, { headers: authHeaders(deps.accessToken) });
  if (got.ok) {
    return (await got.json()) as DriveItem;
  }
  if (got.status !== 404) {
    throw new Error(`OneDrive folder lookup failed: HTTP ${got.status} — ${await readBody(got)}`);
  }

  // 2. Create it under the parent. Root vs nested parent differ in URL shape.
  const createUrl =
    parentPath === ""
      ? `${GRAPH}/me/drive/root/children`
      : `${GRAPH}/me/drive/root:${encodeURI(parentPath)}:/children`;
  const created = await f(createUrl, {
    method: "POST",
    headers: { ...authHeaders(deps.accessToken), "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    }),
  });
  if (created.ok) {
    return (await created.json()) as DriveItem;
  }
  // Lost a create race — re-fetch the now-existing folder.
  if (created.status === 409) {
    const reget = await f(getUrl, { headers: authHeaders(deps.accessToken) });
    if (reget.ok) return (await reget.json()) as DriveItem;
  }
  throw new Error(`OneDrive folder create failed: HTTP ${created.status} — ${await readBody(created)}`);
}

/** Ensure `Switchroom/<agent>` exists; returns its DriveItem. */
export async function ensureSwitchroomFolder(
  deps: OneDriveDeps,
  agentName: string,
): Promise<DriveItem> {
  await ensureFolder(deps, "", "Switchroom");
  return ensureFolder(deps, "/Switchroom", agentName);
}

/**
 * Upload `bytes` as `filename` into the folder item `folderId`. Uses an inline
 * PUT for small files and an upload session for files over the 4 MB cap.
 */
export async function uploadFile(
  deps: OneDriveDeps,
  folderId: string,
  filename: string,
  bytes: Uint8Array,
): Promise<DriveItem> {
  const f = deps.fetchImpl ?? fetch;
  if (bytes.byteLength <= ONEDRIVE_INLINE_MAX_BYTES) {
    const url = `${GRAPH}/me/drive/items/${folderId}:/${encodeURIComponent(filename)}:/content`;
    const resp = await f(url, {
      method: "PUT",
      headers: { ...authHeaders(deps.accessToken), "Content-Type": "application/octet-stream" },
      body: bytes as unknown as BodyInit,
    });
    if (!resp.ok) {
      throw new Error(`OneDrive upload failed: HTTP ${resp.status} — ${await readBody(resp)}`);
    }
    return (await resp.json()) as DriveItem;
  }
  return uploadLargeFile(deps, folderId, filename, bytes);
}

/** Resumable upload for files over the inline cap. */
export async function uploadLargeFile(
  deps: OneDriveDeps,
  folderId: string,
  filename: string,
  bytes: Uint8Array,
): Promise<DriveItem> {
  const f = deps.fetchImpl ?? fetch;
  const sessUrl = `${GRAPH}/me/drive/items/${folderId}:/${encodeURIComponent(filename)}:/createUploadSession`;
  const sess = await f(sessUrl, {
    method: "POST",
    headers: { ...authHeaders(deps.accessToken), "Content-Type": "application/json" },
    body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }),
  });
  if (!sess.ok) {
    throw new Error(`OneDrive upload-session failed: HTTP ${sess.status} — ${await readBody(sess)}`);
  }
  const { uploadUrl } = (await sess.json()) as { uploadUrl: string };

  const CHUNK = 5 * 1024 * 1024; // 5 MiB, a multiple of 320 KiB per Graph rules
  const total = bytes.byteLength;
  let lastItem: DriveItem | null = null;
  for (let start = 0; start < total; start += CHUNK) {
    const end = Math.min(start + CHUNK, total);
    const chunk = bytes.subarray(start, end);
    const put = await f(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(chunk.byteLength),
        "Content-Range": `bytes ${start}-${end - 1}/${total}`,
      },
      body: chunk as unknown as BodyInit,
    });
    if (put.status === 200 || put.status === 201) {
      lastItem = (await put.json()) as DriveItem;
    } else if (put.status !== 202) {
      throw new Error(`OneDrive chunk upload failed: HTTP ${put.status} — ${await readBody(put)}`);
    }
  }
  if (!lastItem) throw new Error("OneDrive upload session completed without a final item");
  return lastItem;
}

/**
 * Create a shareable view link for an item. Prefers an anonymous link; if org
 * policy blocks it, falls back to an organization link, then to the item's own
 * webUrl. Returns the best available URL.
 */
export async function createShareLink(
  deps: OneDriveDeps,
  item: DriveItem,
): Promise<string> {
  const f = deps.fetchImpl ?? fetch;
  const url = `${GRAPH}/me/drive/items/${item.id}/createLink`;
  for (const scope of ["anonymous", "organization"] as const) {
    const resp = await f(url, {
      method: "POST",
      headers: { ...authHeaders(deps.accessToken), "Content-Type": "application/json" },
      body: JSON.stringify({ type: "view", scope }),
    });
    if (resp.ok) {
      const body = (await resp.json()) as { link?: { webUrl?: string } };
      if (body.link?.webUrl) return body.link.webUrl;
    }
    // 403 / policy → try the next scope.
  }
  // Last resort: the item's own URL (requires the user be signed in, but it's
  // reachable — far better than a container path).
  if (item.webUrl) return item.webUrl;
  throw new Error("OneDrive: could not create a share link and the item has no webUrl");
}

/**
 * Full delivery: ensure `Switchroom/<agent>`, upload the file, return a link.
 * `bytes` is the file content; `localPath` is used only for the filename.
 */
export async function deliverToOneDrive(args: {
  accessToken: string;
  agentName: string;
  localPath: string;
  bytes: Uint8Array;
  fetchImpl?: typeof fetch;
}): Promise<DeliveredFile> {
  const deps: OneDriveDeps = { accessToken: args.accessToken, fetchImpl: args.fetchImpl };
  const folder = await ensureSwitchroomFolder(deps, args.agentName);
  const filename = basename(args.localPath);
  const item = await uploadFile(deps, folder.id, filename, args.bytes);
  const link = await createShareLink(deps, item);
  return { itemId: item.id, link, folderPath: `Switchroom/${args.agentName}` };
}
