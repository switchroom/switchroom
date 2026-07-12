import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// The hook is a .ts that bundles to .mjs at build time; drive it through
// `bun` against source so the test doesn't depend on build order (mirrors
// hindsight-mental-model-pretool.test.ts). Skip cleanly if bun absent.
const bunOk = spawnSync("which", ["bun"], { encoding: "utf-8" }).status === 0;
const HOOK = join(process.cwd(), "src", "cli", "foreground-hog-pretool.ts");

function run(
  payload: unknown,
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bun", [HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf-8",
    timeout: 30000,
    env: { ...process.env, SWITCHROOM_FOREGROUND_HOG_GATE: "", ...env },
  });
  return {
    status: r.status ?? 1,
    stdout: (r.stdout ?? "").trim(),
    stderr: r.stderr ?? "",
  };
}

function bash(command: string, extra: Record<string, unknown> = {}) {
  return { tool_name: "Bash", tool_input: { command, ...extra } };
}

function expectDeny(command: string, patternFragment: string) {
  const r = run(bash(command));
  expect(r.status).toBe(0);
  expect(r.stdout, `expected DENY for: ${command}`).not.toBe("");
  const out = JSON.parse(r.stdout);
  expect(out.decision).toBe("block");
  // Instructive message: names the matched pattern AND the recovery.
  expect(out.reason).toContain(patternFragment);
  expect(out.reason).toContain("run_in_background: true");
  expect(out.reason).toContain("bounded alternative");
}

function expectAllow(command: string) {
  const r = run(bash(command));
  expect(r.status).toBe(0);
  expect(r.stdout, `expected ALLOW for: ${command}`).toBe("");
}

describe("foreground-hog-pretool hook", () => {
  it("DENIES tail follow shapes with the instructive message", () => {
    if (!bunOk) return;
    expectDeny("tail -f /var/log/syslog", "tail -f/--follow");
    expectDeny("tail -F /var/log/syslog", "tail -f/--follow");
    expectDeny("tail --follow /var/log/syslog", "tail -f/--follow");
    expectDeny("tail --follow=name /var/log/syslog", "tail -f/--follow");
    expectDeny("tail -fn200 /var/log/syslog", "tail -f/--follow");
    // In a compound command / pipeline the follower still holds the turn.
    expectDeny("cd /var/log && tail -f syslog", "tail -f/--follow");
    expectDeny("tail -f app.log | grep ERROR", "tail -f/--follow");
  });

  it("DENIES watch as a command", () => {
    if (!bunOk) return;
    expectDeny("watch docker ps", "watch");
    expectDeny("watch -n 5 'kubectl get pods'", "watch");
  });

  it("DENIES sleep > 30s, bare and inside a compound command", () => {
    if (!bunOk) return;
    expectDeny("sleep 300", "sleep 300");
    expectDeny("sleep 31", "sleep 31");
    expectDeny("sleep 5m", "sleep 5m");
    expectDeny("sleep 1h", "sleep 1h");
    expectDeny("npm run build && sleep 300", "sleep 300");
    expectDeny("sleep 120; gh pr checks 42", "sleep 120");
  });

  it("DENIES sleep-in-a-loop regardless of per-tick duration", () => {
    if (!bunOk) return;
    expectDeny("while true; do gh pr checks 42; sleep 5; done", "loop");
    expectDeny("until curl -sf localhost:8080; do sleep 2; done", "loop");
    expectDeny("for i in 1 2 3; do date; sleep 10; done", "loop");
  });

  it("DENIES gh watch verbs", () => {
    if (!bunOk) return;
    expectDeny("gh pr checks 3141 --watch", "gh pr checks --watch");
    expectDeny("gh pr checks --watch 3141", "gh pr checks --watch");
    expectDeny("gh run watch 123456", "gh run watch");
  });

  it("DENIES unbounded log followers (docker/kubectl/journalctl)", () => {
    if (!bunOk) return;
    expectDeny("docker logs -f switchroom-overlord", "docker logs");
    expectDeny("docker logs --follow switchroom-overlord", "docker logs");
    expectDeny("kubectl logs -f pod/web-0", "kubectl logs");
    expectDeny("kubectl logs --follow deployment/api", "kubectl logs");
    expectDeny("journalctl -f", "journalctl -f");
    expectDeny("journalctl -xef -u nginx", "journalctl -f");
  });

  it("ALLOWS bounded near-misses (false positives are not acceptable)", () => {
    if (!bunOk) return;
    expectAllow("tail -n 100 /var/log/syslog");
    expectAllow("tail -n 200 app.log | grep ERROR");
    expectAllow("sleep 5");
    expectAllow("sleep 30"); // threshold is strictly > 30
    expectAllow("npm run build && sleep 10");
    // `watch`/followers as substrings of other words or as arguments,
    // never as the command itself.
    expectAllow("watchman version");
    expectAllow("git log --follow -- src/cli/foreground-hog-pretool.ts");
    expectAllow("cat stopwatch.ts");
    expectAllow("echo 'watch this: tail -f is banned'");
    expectAllow("gh pr checks 3141"); // no --watch → single bounded poll
    expectAllow("gh run view 123456");
    expectAllow("docker logs --tail 200 switchroom-overlord");
    expectAllow("kubectl logs --tail=100 pod/web-0");
    expectAllow("journalctl -u nginx -n 200");
    // Loop without a sleep, and a sleep after the loop closed.
    expectAllow("for f in *.ts; do wc -l $f; done");
    expectAllow("for f in *.ts; do wc -l $f; done && sleep 5");
  });

  it("ALLOWS generic build/test/deploy commands untouched", () => {
    if (!bunOk) return;
    expectAllow("npm test");
    expectAllow("npm run lint");
    expectAllow("cargo build --release");
    expectAllow("./node_modules/.bin/vitest run tests/foo.test.ts");
    expectAllow("docker build -t app . && docker push app");
    expectAllow("bun install");
  });

  it("ALLOWS shell-backgrounded segments (single & is not a turn hog)", () => {
    if (!bunOk) return;
    expectAllow("tail -f app.log &");
    expectAllow("sleep 300 & echo started");
    // fd-duplication redirects are not backgrounding and must not confuse
    // the splitter into false negatives for the surrounding foreground cmd.
    expectAllow("npm test 2>&1");
  });

  it("still DENIES a foreground hog that also uses fd redirects", () => {
    if (!bunOk) return;
    expectDeny("tail -f app.log 2>&1", "tail -f/--follow");
  });

  it("ALLOWS any matched shape when run_in_background is true", () => {
    if (!bunOk) return;
    for (const cmd of [
      "tail -f /var/log/syslog",
      "sleep 300",
      "gh run watch 123456",
      "while true; do date; sleep 5; done",
    ]) {
      const r = run(bash(cmd, { run_in_background: true }));
      expect(r.status).toBe(0);
      expect(r.stdout, `expected ALLOW (backgrounded) for: ${cmd}`).toBe("");
    }
  });

  it("kill-switch env disables the gate (default-on, escape hatch)", () => {
    if (!bunOk) return;
    for (const off of ["0", "false", "off", "no", " OFF ", "False"]) {
      const r = run(bash("tail -f /var/log/syslog"), {
        SWITCHROOM_FOREGROUND_HOG_GATE: off,
      });
      expect(r.status).toBe(0);
      expect(r.stdout, `expected ALLOW with kill-switch=${off}`).toBe("");
    }
    // Any other value (including junk) keeps the gate ON.
    for (const on of ["1", "true", "yes", "banana"]) {
      const r = run(bash("tail -f /var/log/syslog"), {
        SWITCHROOM_FOREGROUND_HOG_GATE: on,
      });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).decision).toBe("block");
    }
  });

  it("ALLOWS non-Bash tools untouched", () => {
    if (!bunOk) return;
    for (const tool of ["Read", "Write", "Task", "mcp__switchroom-telegram__reply"]) {
      const r = run({ tool_name: tool, tool_input: { command: "tail -f x" } });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
  });

  it("fails open on empty / non-JSON / unknown-shape stdin", () => {
    if (!bunOk) return;
    for (const bad of ["", "not-json", "{}", '{"tool_name":123}', '{"tool_name":"Bash"}', '{"tool_name":"Bash","tool_input":{"command":42}}']) {
      const r = run(bad);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
  });
});
