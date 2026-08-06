import { describe, it, expect } from "vitest";
import { classifyConfigRepo, UNPUSHED_STALE_MS, type ConfigRepoFacts } from "./doctor-config-repo.js";

const base: ConfigRepoFacts = {
  configured: true,
  enabled: true,
  repoPath: "/home/op/.switchroom-config",
  isGitRepo: true,
  isPrivate: true,
  untrackedPersonalSkills: 0,
  unpushedCount: 0,
  oldestUnpushedAgeMs: null,
};

function row(rows: ReturnType<typeof classifyConfigRepo>, name: string) {
  return rows.find((r) => r.name === name);
}

describe("classifyConfigRepo", () => {
  it("emits no rows when config_repo is not configured", () => {
    expect(classifyConfigRepo({ ...base, configured: false })).toHaveLength(0);
  });

  it("FAILs and short-circuits when the path is not a git repo", () => {
    const rows = classifyConfigRepo({ ...base, isGitRepo: false });
    expect(rows).toHaveLength(1);
    expect(row(rows, "config repo present")?.status).toBe("fail");
  });

  it("FAILs when the remote is public", () => {
    const rows = classifyConfigRepo({ ...base, isPrivate: false });
    expect(row(rows, "config repo private")?.status).toBe("fail");
  });

  it("WARNs when visibility is unverifiable", () => {
    const rows = classifyConfigRepo({ ...base, isPrivate: null });
    expect(row(rows, "config repo private")?.status).toBe("warn");
  });

  it("WARNs on untracked personal skills (GAP A backstop) and clears when zero", () => {
    expect(row(classifyConfigRepo({ ...base, untrackedPersonalSkills: 84 }), "config repo personal skills tracked")?.status).toBe("warn");
    expect(row(classifyConfigRepo(base), "config repo personal skills tracked")?.status).toBe("ok");
  });

  it("FAILs on unpushed commits older than 24h, OK when recent", () => {
    const stale = classifyConfigRepo({ ...base, unpushedCount: 3, oldestUnpushedAgeMs: UNPUSHED_STALE_MS + 1 });
    expect(row(stale, "config repo unpushed")?.status).toBe("fail");
    const recent = classifyConfigRepo({ ...base, unpushedCount: 1, oldestUnpushedAgeMs: 60_000 });
    expect(row(recent, "config repo unpushed")?.status).toBe("ok");
  });

  it("WARNs when there is no upstream tracking ref", () => {
    const rows = classifyConfigRepo({ ...base, unpushedCount: null });
    expect(row(rows, "config repo unpushed")?.status).toBe("warn");
  });
});
