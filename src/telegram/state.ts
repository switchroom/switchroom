import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  copyFileSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { resolveStatePath } from "../config/paths.js";

export interface TopicEntry {
  topic_id: number;
  topic_name: string;
  created_at: string;
}

export interface TopicState {
  topics: Record<string, TopicEntry>;
}

function defaultStatePath(): string {
  return resolveStatePath("topics.json");
}

export function loadTopicState(statePath?: string): TopicState {
  const path = statePath ?? defaultStatePath();

  if (!existsSync(path)) {
    return { topics: {} };
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);

    // Basic shape validation
    if (parsed && typeof parsed === "object" && parsed.topics && typeof parsed.topics === "object") {
      return parsed as TopicState;
    }

    // Shape is wrong — warn loudly and keep a backup so the operator can
    // recover the topic → thread id mapping. Silent fallback used to hide
    // state corruption until the agent couldn't find its topic.
    console.warn(
      `switchroom: topics state at ${path} is malformed; keeping a backup at ${path}.corrupt and starting fresh.`,
    );
    try { copyFileSync(path, `${path}.corrupt`); } catch {}
    return { topics: {} };
  } catch (err) {
    console.warn(
      `switchroom: failed to read topics state at ${path} (${(err as Error).message}); starting fresh.`,
    );
    return { topics: {} };
  }
}

export function saveTopicState(state: TopicState, statePath?: string): void {
  const path = statePath ?? defaultStatePath();
  const dir = dirname(path);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Atomic write: write to a temp file in the same directory, then rename.
  // A crash mid-write won't leave a truncated/empty topics.json that loses
  // every topic mapping.
  const absDir = resolve(dir);
  const tmp = resolve(absDir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
    renameSync(tmp, path);
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    throw err;
  }
}
