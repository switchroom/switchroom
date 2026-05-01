/**
 * BM25-lite search over an agent's workspace/ directory.
 *
 * Deliberately simple: pure in-memory, no embeddings, no SQLite. Indexes
 * `.md` files in the workspace root plus its `memory/` subdirectory and
 * returns ranked matches with short snippets. The goal is to give Claude
 * Code a fast "recall the file that mentioned X" primitive without
 * requiring a vector store.
 *
 * For semantic recall with embeddings, agents can still use Hindsight via
 * the auto-recall hook or direct MCP calls. This is the file-system tier.
 */

import type { Dirent } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_MEMORY_SEARCH_MAX_RESULTS = 6;
export const DEFAULT_MEMORY_SEARCH_SNIPPET_CHARS = 220;
export const MEMORY_SEARCH_MAX_INDEXED_CHARS = 2_000_000;
export const MEMORY_SEARCH_MAX_FILE_SIZE = 512 * 1024;

export type MemorySearchHit = {
  /** Workspace-relative path (e.g. `MEMORY.md` or `memory/2026-04-19.md`). */
  path: string;
  /** BM25-lite score. Higher is more relevant. */
  score: number;
  /** Contextual snippet around the best-matching span. */
  snippet: string;
  /** Line number (1-indexed) where the best match occurs. */
  line: number;
};

export type MemorySearchResult = {
  query: string;
  indexedFiles: number;
  totalMatches: number;
  hits: MemorySearchHit[];
};

type IndexedFile = {
  relPath: string;
  content: string;
  terms: string[];
  termFreq: Map<string, number>;
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length > 1 && t.length < 40);
}

async function listMarkdownFiles(workspaceDir: string, maxDepth = 3): Promise<string[]> {
  const results: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: workspaceDir, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    let entries: Dirent[];
    try {
      // withFileTypes + isSymbolicLink() lets us skip symlinks without
      // following them. Reading the .md target of a symlinked dir (e.g.
      // memory -> /etc) would otherwise let the index surface content
      // from outside the workspace via the `switchroom workspace search`
      // CLI verb (which is what consumes this index).
      entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
    } catch {
      continue;
    }
    for (const dirent of entries) {
      if (dirent.name.startsWith(".")) continue;
      if (dirent.isSymbolicLink()) continue;
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory() && depth < maxDepth) {
        queue.push({ dir: full, depth: depth + 1 });
      } else if (dirent.isFile() && /\.mdx?$/i.test(dirent.name)) {
        // File size is still checked here because withFileTypes doesn't
        // surface size; cheap stat when we know the file is regular.
        let info;
        try {
          info = await stat(full);
        } catch {
          continue;
        }
        if (info.size <= MEMORY_SEARCH_MAX_FILE_SIZE) results.push(full);
      }
    }
  }
  return results.sort();
}

async function loadIndex(workspaceDir: string): Promise<IndexedFile[]> {
  const abs = await listMarkdownFiles(workspaceDir);
  const out: IndexedFile[] = [];
  let totalChars = 0;
  for (const full of abs) {
    if (totalChars >= MEMORY_SEARCH_MAX_INDEXED_CHARS) break;
    let content: string;
    try {
      content = await readFile(full, "utf8");
    } catch {
      continue;
    }
    if (content.length === 0) continue;
    totalChars += content.length;
    const terms = tokenize(content);
    const freq = new Map<string, number>();
    for (const t of terms) {
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
    const relPath = path.relative(workspaceDir, full);
    out.push({ relPath, content, terms, termFreq: freq });
  }
  return out;
}

function buildSnippet(
  content: string,
  queryTerms: string[],
  maxChars: number,
): { snippet: string; line: number } {
  if (content.length === 0 || queryTerms.length === 0) {
    return { snippet: content.slice(0, maxChars), line: 1 };
  }
  const lower = content.toLowerCase();
  let bestIdx = -1;
  for (const term of queryTerms) {
    const idx = lower.indexOf(term);
    if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) {
      bestIdx = idx;
    }
  }
  if (bestIdx < 0) {
    return { snippet: content.slice(0, maxChars).trim(), line: 1 };
  }
  const half = Math.floor(maxChars / 2);
  const start = Math.max(0, bestIdx - half);
  const end = Math.min(content.length, start + maxChars);
  const slice = content.slice(start, end).trim();
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  const line = content.slice(0, bestIdx).split("\n").length;
  return { snippet: `${prefix}${slice}${suffix}`, line };
}

/**
 * BM25-lite score with saturation + length normalization.
 *
 * score = Σ_t idf(t) · ((k1+1) tf(t,d)) / (k1·(1-b+b·|d|/avgdl) + tf(t,d))
 *
 * Standard BM25 with k1=1.5, b=0.75. Deliberately simple: no field
 * boosting, no phrase matching, no proximity. "Lite" because it skips
 * index persistence (re-read every query) — fine for a workspace of a
 * few hundred files.
 */
function scoreBm25(
  queryTerms: string[],
  doc: IndexedFile,
  avgdl: number,
  idf: Map<string, number>,
): number {
  const k1 = 1.5;
  const b = 0.75;
  const dl = doc.terms.length || 1;
  let sum = 0;
  for (const t of queryTerms) {
    const tf = doc.termFreq.get(t) ?? 0;
    if (tf === 0) continue;
    const weight = idf.get(t) ?? 0;
    if (weight <= 0) continue;
    const denom = k1 * (1 - b + b * (dl / avgdl)) + tf;
    sum += (weight * ((k1 + 1) * tf)) / denom;
  }
  return sum;
}

function computeIdf(index: IndexedFile[], queryTerms: string[]): Map<string, number> {
  const n = Math.max(1, index.length);
  const idf = new Map<string, number>();
  for (const t of queryTerms) {
    let df = 0;
    for (const doc of index) {
      if (doc.termFreq.has(t)) df += 1;
    }
    if (df === 0) {
      idf.set(t, 0);
      continue;
    }
    // BM25 idf with +1 floor to avoid negatives on half-common terms.
    const value = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    idf.set(t, value);
  }
  return idf;
}

/**
 * Search the agent's workspace directory for markdown files matching a
 * free-text query. Returns ranked hits with snippets. Re-reads all files
 * every call (cheap at switchroom scale), so edits are reflected
 * immediately.
 */
export async function searchWorkspaceMemory(params: {
  workspaceDir: string;
  query: string;
  maxResults?: number;
  snippetChars?: number;
}): Promise<MemorySearchResult> {
  const maxResults = params.maxResults ?? DEFAULT_MEMORY_SEARCH_MAX_RESULTS;
  const snippetChars = params.snippetChars ?? DEFAULT_MEMORY_SEARCH_SNIPPET_CHARS;

  const queryTerms = Array.from(new Set(tokenize(params.query)));
  if (queryTerms.length === 0) {
    return { query: params.query, indexedFiles: 0, totalMatches: 0, hits: [] };
  }

  const index = await loadIndex(params.workspaceDir);
  if (index.length === 0) {
    return { query: params.query, indexedFiles: 0, totalMatches: 0, hits: [] };
  }
  const avgdl =
    index.reduce((sum, doc) => sum + doc.terms.length, 0) / Math.max(1, index.length);
  const idf = computeIdf(index, queryTerms);

  const scored: Array<{ doc: IndexedFile; score: number }> = [];
  for (const doc of index) {
    const score = scoreBm25(queryTerms, doc, avgdl, idf);
    if (score > 0) {
      scored.push({ doc, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  const hits: MemorySearchHit[] = scored.slice(0, maxResults).map(({ doc, score }) => {
    const { snippet, line } = buildSnippet(doc.content, queryTerms, snippetChars);
    return {
      path: doc.relPath,
      score: Number(score.toFixed(4)),
      snippet,
      line,
    };
  });

  return {
    query: params.query,
    indexedFiles: index.length,
    totalMatches: scored.length,
    hits,
  };
}

/**
 * Safely read a workspace file by workspace-relative path. Refuses path
 * traversal outside the workspace dir.
 */
export async function getWorkspaceMemoryFile(params: {
  workspaceDir: string;
  relativePath: string;
  maxBytes?: number;
}): Promise<{ path: string; content: string; truncated: boolean; bytes: number }> {
  const maxBytes = params.maxBytes ?? MEMORY_SEARCH_MAX_FILE_SIZE;
  const resolvedWorkspace = await realpath(path.resolve(params.workspaceDir));
  const lexicalTarget = path.resolve(resolvedWorkspace, params.relativePath);
  // path.resolve() does NOT follow symlinks, so a symlink inside the
  // workspace could point at /etc/passwd and pass the prefix check.
  // realpath() the target and re-check so containment survives links.
  let resolvedTarget: string;
  try {
    resolvedTarget = await realpath(lexicalTarget);
  } catch {
    // ENOENT or similar — fall back to the lexical path so the
    // subsequent stat() produces the idiomatic error message.
    resolvedTarget = lexicalTarget;
  }
  if (!resolvedTarget.startsWith(`${resolvedWorkspace}${path.sep}`) && resolvedTarget !== resolvedWorkspace) {
    throw new Error(
      `path traversal refused: "${params.relativePath}" resolves outside the workspace`,
    );
  }
  const info = await stat(resolvedTarget);
  if (!info.isFile()) {
    throw new Error(`not a file: ${params.relativePath}`);
  }
  const buf = await readFile(resolvedTarget);
  if (buf.length <= maxBytes) {
    return {
      path: params.relativePath,
      content: buf.toString("utf8"),
      truncated: false,
      bytes: buf.length,
    };
  }
  return {
    path: params.relativePath,
    content: buf.subarray(0, maxBytes).toString("utf8"),
    truncated: true,
    bytes: buf.length,
  };
}
