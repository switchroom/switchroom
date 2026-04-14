import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
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

    return { topics: {} };
  } catch {
    return { topics: {} };
  }
}

export function saveTopicState(state: TopicState, statePath?: string): void {
  const path = statePath ?? defaultStatePath();
  const dir = dirname(path);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf-8");
}
