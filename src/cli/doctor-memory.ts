/**
 * Memory-backend health checks for `switchroom doctor`.
 *
 * The existing hindsight checks (`checkHindsight`) confirm the backend is
 * *reachable and speaking MCP* — but the 2026-06-06 outage proved that's not
 * enough: the container was up and serving MCP while every memory write
 * silently failed. Two distinct failure modes hid behind a healthy-looking
 * port:
 *
 *   1. **shm exhaustion** — PostgreSQL needs ~533MB+ of shared memory for
 *      large query/sort segments; Docker's 64MB default made every write fail
 *      with `could not resize shared memory segment ... No space left on
 *      device`. (Now prevented at launch by --shm-size, #2190 — but a
 *      pre-#2190 container or a hand-rolled one can still hit it.)
 *   2. **OAuth quota exhaustion** — hindsight's fact-extraction `claude` calls
 *      hit the account's weekly limit (429), so retains were accepted but
 *      extracted 0 facts → nothing became recallable.
 *
 * Neither is visible over the MCP port. Both ARE visible in the container's
 * shm config and recent logs. These checks surface them so the next outage is
 * caught by `doctor`, not by a user noticing their agents went amnesiac.
 *
 * The pure classifiers below are unit-tested against real log/shm samples; the
 * docker wrapper is best-effort and silently skips when hindsight isn't a
 * local container (remote URL / no docker / inside an agent container).
 */
import { execFileSync } from "node:child_process";
import { EXPECTED_HINDSIGHT_TOOLS } from "../memory/hindsight-tools.js";
import {
  HINDSIGHT_DATA_VOLUME,
  HINDSIGHT_DEFAULT_WORKER_ID,
  listHindsightDataVolumeMounts,
} from "../setup/hindsight.js";

export interface CheckResult {
  name: string;
  status: "ok" | "warn" | "fail";
  detail?: string;
  fix?: string;
}

/** 1 GiB in bytes — the floor below which PostgreSQL's shared segments fail. */
export const MIN_HINDSIGHT_SHM_BYTES = 1024 * 1024 * 1024;

/** Pure: classify a container's ShmSize (bytes) into a health result. */
export function classifyShmSize(bytes: number): CheckResult {
  const mib = Math.round(bytes / 1024 / 1024);
  if (bytes < MIN_HINDSIGHT_SHM_BYTES) {
    return {
      name: "hindsight shm-size",
      status: "fail",
      detail:
        `${mib}MB — PostgreSQL needs ~533MB+ for shared segments; writes will ` +
        `fail with "No space left on device"`,
      fix:
        "Recreate hindsight with a larger shm. The launch path now sets " +
        "--shm-size=2g (#2190); pull a release that includes it and run " +
        "`switchroom memory --restart`, or recreate the container manually " +
        "preserving the `switchroom-hindsight-data` volume.",
    };
  }
  const gib = (bytes / 1024 / 1024 / 1024).toFixed(bytes % (1024 ** 3) === 0 ? 0 : 1);
  return { name: "hindsight shm-size", status: "ok", detail: `${gib}g` };
}

/**
 * Backlog thresholds for the consolidation queue. With the #2894 throttle
 * (MAX_SLOTS=1, ~7 consolidation ops/hour drained against a fleet retaining
 * every turn) the queue can build silently — the only prior signal was a 2h
 * queue-lag WARNING written to `docker logs` by `hindsight-maintenance.sh`.
 * A deep queue means retains are landing but not yet consolidated into recall.
 * WARN ≈ several hours of backlog; FAIL ≈ ~a day+, likely wedged.
 */
export const CONSOLIDATION_BACKLOG_WARN = 25;
export const CONSOLIDATION_BACKLOG_FAIL = 200;

/**
 * Pure: classify the consolidation-queue backlog into a doctor result so
 * `switchroom doctor` surfaces queue depth (and, when available, the oldest
 * pending op's age) instead of it hiding in docker logs.
 *
 * `queueDepth` is the count of pending/processing async operations across all
 * banks (summed from each bank's `/stats.pending_operations`). `oldestAgeSecs`
 * is the age of the oldest pending op when known, else `null` — the REST
 * `/stats` surface exposes depth but not per-op age, so precise age
 * measurement is deferred to the #2847 follow-up (the maintenance loop already
 * logs it). Never throws.
 */
export function classifyConsolidationBacklog(
  queueDepth: number,
  oldestAgeSecs: number | null = null,
): CheckResult {
  const ageStr =
    oldestAgeSecs !== null && oldestAgeSecs > 0
      ? `, oldest ${Math.round(oldestAgeSecs / 60)}m old`
      : "";
  const base = `${queueDepth} pending consolidation op(s)${ageStr}`;
  if (queueDepth >= CONSOLIDATION_BACKLOG_FAIL) {
    return {
      name: "hindsight consolidation backlog",
      status: "fail",
      detail:
        `${base} — queue is deep enough to be wedged; retains are landing but ` +
        `not consolidating into recall (drains ~7 ops/hr under the #2894 throttle)`,
      fix:
        "Check `docker logs switchroom-hindsight` for the queue-lag WARNING and " +
        "consolidation errors (quota/429/shm); restart with `switchroom memory " +
        "--restart` if the worker is stuck.",
    };
  }
  if (queueDepth >= CONSOLIDATION_BACKLOG_WARN) {
    return {
      name: "hindsight consolidation backlog",
      status: "warn",
      detail:
        `${base} — building faster than it drains (~7 ops/hr under the #2894 ` +
        `throttle); recall may lag recent turns until it catches up`,
    };
  }
  return {
    name: "hindsight consolidation backlog",
    status: "ok",
    detail: queueDepth > 0 ? base : "queue drained (0 pending)",
  };
}

/**
 * Pure: classify recent hindsight logs for fact-extraction health. Catches the
 * two silent-write failure modes by their log signatures.
 */
export function classifyExtractionLogs(logs: string): CheckResult {
  const noSpace = /No space left on device|could not resize shared memory/i.test(logs);
  // What hindsight's OWN logs show when fact-extraction `claude` calls fail
  // (quota/429, auth, or model error): the provider logs an "error result" and
  // extraction yields 0 facts. The literal "429"/"weekly limit" string lives in
  // the headless-CLI result envelope, not hindsight's logs — so match the
  // provider error instead.
  const llmError = /Claude Code returned an error result|claude_code_llm[\s\S]{0,80}error|Fact extraction failed|Content extraction failed/i.test(logs);
  const quotaHint = /weekly limit|api_error_status["':\s]+429|\b429\b|hit your[\s\S]{0,24}limit/i.test(logs);
  const zeroFacts = (logs.match(/Extract facts:\s*0 facts/gi) ?? []).length;
  const okFacts = (logs.match(/Extract facts:\s*[1-9]\d* facts/gi) ?? []).length;

  if (noSpace) {
    return {
      name: "hindsight extraction",
      status: "fail",
      detail: "shared-memory exhaustion in recent logs — memory writes are failing",
      fix: "See the `hindsight shm-size` check — the container's /dev/shm is too small.",
    };
  }
  if (llmError && okFacts === 0) {
    return {
      name: "hindsight extraction",
      status: "fail",
      detail:
        "fact-extraction LLM calls are failing" +
        (quotaHint ? " (429 / weekly-limit detected)" : "") +
        " — retains are accepted but extract 0 facts, so nothing becomes recallable",
      fix:
        "Usually hindsight's `auth.consumers[hindsight].account` is quota-" +
        "exhausted or its OAuth broke. Repoint it to an account with quota in " +
        "switchroom.yaml, then `docker restart switchroom-auth-broker` and " +
        "`docker restart switchroom-hindsight` (single-file config mount needs " +
        "the broker restart to re-read). Confirm with a headless `claude` run " +
        "inside the container.",
    };
  }
  if (zeroFacts >= 3 && okFacts === 0) {
    return {
      name: "hindsight extraction",
      status: "warn",
      detail:
        `${zeroFacts} recent extractions produced 0 facts and none succeeded — ` +
        "fact extraction may be failing",
      fix: "Inspect `docker logs switchroom-hindsight` for the extraction error.",
    };
  }
  return {
    name: "hindsight extraction",
    status: "ok",
    detail: okFacts > 0
      ? `healthy (${okFacts} recent successful extractions)`
      : "no recent extraction activity to assess",
  };
}

/**
 * Pure: classify recent `switchroom-hindsight-autoheal` sidecar logs (#2910)
 * into a doctor result, so `switchroom doctor` can report that the host-side
 * autoheal loop restarted a wedged hindsight — or gave up after hitting its
 * restart cap — instead of it hiding in `docker logs`.
 *
 * The sidecar emits stable structured lines (`hindsight-autoheal event=<ev>
 * …`). We count `restart_issued` events and detect a `gave_up` event:
 *  - `gave_up` present  → FAIL: hit the sliding-window cap; hindsight is
 *    genuinely broken (loop-guarded, so it's NOT restart-looping — it backed
 *    off), needs an operator.
 *  - restarts > 0, no give-up → WARN: it healed a wedge, but a healthy
 *    hindsight shouldn't need restarting; worth a look.
 *  - no restarts → OK.
 *
 * `logs` is the sidecar's recent stdout. Never throws.
 */
export function classifyAutohealStatus(logs: string): CheckResult {
  const restarts = (logs.match(/event=restart_issued\b/g) ?? []).length;
  const gaveUp = /event=gave_up\b/.test(logs);
  const disabled = /event=disabled\b/.test(logs);

  if (disabled && restarts === 0) {
    return {
      name: "hindsight autoheal",
      status: "ok",
      detail: "disabled (SWITCHROOM_HINDSIGHT_AUTOHEAL=0)",
    };
  }
  if (gaveUp) {
    return {
      name: "hindsight autoheal",
      status: "fail",
      detail:
        `autoheal GAVE UP after ${restarts} restart(s) in its window — hindsight ` +
        `kept coming back unhealthy, so the loop backed off (it is NOT restart-` +
        `looping) and memory is likely down`,
      fix:
        "hindsight is genuinely wedged. Check `docker logs switchroom-hindsight` " +
        "for the root cause (shm/quota/crash), fix it, then `switchroom memory " +
        "--restart`. Autoheal resumes on its own after the cooldown.",
    };
  }
  if (restarts > 0) {
    return {
      name: "hindsight autoheal",
      status: "warn",
      detail:
        `hindsight was auto-restarted ${restarts} time(s) recently — the wedge was ` +
        `healed, but a healthy backend shouldn't need restarting`,
      fix: "Inspect `docker logs switchroom-hindsight` around the restart(s) for the underlying wedge.",
    };
  }
  return { name: "hindsight autoheal", status: "ok", detail: "no auto-restarts" };
}

/**
 * Pure: classify hindsight's boot-time LLM-connection verification from its
 * container logs (#3408). Hindsight's `MemoryEngine._initialize` verifies each
 * DISTINCT llm config (`default`/`retain`/`reflect`/`consolidation`) once at
 * boot and, on failure, logs a WARNING and KEEPS SERVING:
 *
 *   LLM connection verification failed for '<config>' config: <error>. Server
 *   will start but LLM-dependent operations may fail until the provider is
 *   available.
 *
 * That exact condition ran ~2h in the 2026-07-19 outage — the container was up
 * and answering MCP, but every default-config LLM op 400'd ("Invalid model
 * name") because the operator's LiteLLM `model_list` edit dropped the model the
 * hindsight env still pinned. The verification WARNING was the earliest clean
 * signal and it sat unread in `docker logs`. This classifier reads it back so
 * `switchroom doctor` turns it red — the same model-free "doctor reads a known
 * log line" mechanism as {@link classifyAutohealStatus} /
 * {@link classifyConsolidationBacklog}.
 *
 * State is per-config and LAST-WINS: a boot that failed then a later restart
 * that verified clean must clear the alarm, so we track the MOST RECENT event
 * (success or failure) for each config in log order. A config whose latest
 * event is a failure → FAIL; if any config failed we report FAIL naming them.
 * If the window shows only successes → OK. If NO verification event appears at
 * all (nothing verified in the window, or verification was skipped) → we return
 * `null` so the caller omits the row rather than showing a spurious "ok".
 *
 * Provider-agnostic: matches the shared `MemoryEngine` failure line (which
 * carries the config name) plus every provider's success line
 * (`LiteLLM`/`Anthropic`/`llama.cpp`/`codex` "… connection verified
 * successfully" and llama.cpp's "verification passed"). Provider success lines
 * don't name a config, so a success clears the `default` config (the one always
 * verified); a per-op failure still stands on its own named line. Never throws.
 */
export function classifyLlmVerification(logs: string): CheckResult | null {
  // Per-config latest outcome, in log (chronological) order. `true` = failed.
  const latestFailed = new Map<string, boolean>();
  const failDetail = new Map<string, string>();
  let sawAny = false;

  // Split once; scan line-by-line so ordering (last-wins) is deterministic.
  for (const line of logs.split("\n")) {
    // Failure line — names the config and carries the error tail.
    const fail = line.match(
      /LLM connection verification failed for '([^']+)' config:\s*(.*?)(?:\.\s*Server will start|$)/,
    );
    if (fail) {
      sawAny = true;
      const cfg = fail[1];
      latestFailed.set(cfg, true);
      failDetail.set(cfg, (fail[2] ?? "").trim());
      continue;
    }
    // Success lines — provider-specific, don't name a config. A successful
    // verification pass implies the `default` config verified (it's always in
    // the set). Clear it.
    if (
      /connection verified successfully/.test(line) ||
      /LLM verification passed/.test(line)
    ) {
      sawAny = true;
      latestFailed.set("default", false);
    }
  }

  if (!sawAny) return null;

  const failedConfigs = [...latestFailed.entries()]
    .filter(([, failed]) => failed)
    .map(([cfg]) => cfg);

  if (failedConfigs.length === 0) {
    return {
      name: "hindsight LLM verification",
      status: "ok",
      detail: "boot LLM connection verified",
    };
  }

  const named = failedConfigs
    .map((cfg) => {
      const err = failDetail.get(cfg);
      return err ? `'${cfg}' (${err})` : `'${cfg}'`;
    })
    .join(", ");
  return {
    name: "hindsight LLM verification",
    status: "fail",
    detail:
      `boot LLM connection verification FAILED for config(s): ${named} — ` +
      `hindsight is serving but every LLM-dependent op (retain/reflect/` +
      `consolidation extraction) for that config will fail silently until the ` +
      `provider is reachable`,
    fix:
      "Almost always a model-name drift: the pinned `hindsight.llm.*.model` no " +
      "longer exists in the LiteLLM proxy's model_list (run `switchroom doctor` " +
      "— the LiteLLM model-routing check names the exact missing model), or the " +
      "provider is down. Fix the model reference (or the proxy), then " +
      "`switchroom memory --restart` so hindsight re-verifies.",
  };
}

/**
 * Best-effort: inspect the local `switchroom-hindsight` container's shm + recent
 * logs. Returns [] (silently skipped) when hindsight isn't a local container —
 * a remote `memory.config.url`, no docker, or running inside an agent container.
 */

/**
 * Pure: classify containers mounting the live hindsight data volume.
 * More than one mount with anything besides the canonical name is the
 * 2026-07-19 dual-writer class (canary holdback left `restart=always` on
 * the renamed twin → corrupt PG checkpoint).
 */
export function classifyHindsightDataVolumeMounts(names: string[]): CheckResult {
  const uniq = [...new Set(names.filter(Boolean))];
  if (uniq.length === 0) {
    return {
      name: "hindsight data-volume exclusive",
      status: "ok",
      detail: "no container currently mounts the live data volume",
    };
  }
  const twins = uniq.filter((n) => n !== HINDSIGHT_DEFAULT_WORKER_ID);
  if (uniq.length === 1 && uniq[0] === HINDSIGHT_DEFAULT_WORKER_ID) {
    return {
      name: "hindsight data-volume exclusive",
      status: "ok",
      detail: `only ${HINDSIGHT_DEFAULT_WORKER_ID} mounts ${HINDSIGHT_DATA_VOLUME}`,
    };
  }
  if (twins.length > 0) {
    return {
      name: "hindsight data-volume exclusive",
      status: "fail",
      detail:
        `multiple containers mount ${HINDSIGHT_DATA_VOLUME}: [${uniq.join(", ")}] — ` +
        `dual postmasters corrupt the embedded PG checkpoint`,
      fix:
        "`switchroom memory --restart` (stopHindsight now disables restart + removes " +
        "every volume twin), or manually `docker update --restart=no <twin> && " +
        "docker rm -f <twin>` before starting the live container.",
    };
  }
  // >1 names but all equal canonical? weird but ok-ish
  return {
    name: "hindsight data-volume exclusive",
    status: "warn",
    detail: `unexpected volume mount set: [${uniq.join(", ")}]`,
  };
}

/**
 * Pure: classify NetworkMode when LiteLLM routing is configured.
 * LiteLLM publishes on the host's 127.0.0.1:4010; a bridge-networked
 * hindsight answering /health is a silent retain outage.
 */
export function classifyHindsightNetworkMode(
  networkMode: string | null | undefined,
  litellmConfigured: boolean,
): CheckResult {
  if (!litellmConfigured) {
    return {
      name: "hindsight network mode",
      status: "ok",
      detail: networkMode ? `${networkMode} (LiteLLM not configured)` : "unknown (LiteLLM not configured)",
    };
  }
  const mode = (networkMode ?? "").trim() || "unknown";
  if (mode === "host") {
    return {
      name: "hindsight network mode",
      status: "ok",
      detail: "host — LiteLLM 127.0.0.1 reachable",
    };
  }
  return {
    name: "hindsight network mode",
    status: "fail",
    detail:
      `NetworkMode=${mode} while LiteLLM routing is configured — retains will die with ` +
      `"Connection error" to 127.0.0.1:4010 while /health stays green`,
    fix:
      "`switchroom memory --restart` so startHindsight recreates with --network host. " +
      "Do not `docker start` a bridge/mis-networked container.",
  };
}

/**
 * Pure: classify a Ronnie TCP probe of the LiteLLM base URL from the host.
 * `reachable=true` when connect succeeded; `false` when refused/timeout;
 * `null` when the probe was skipped.
 */
export function classifyLiteLlmReachability(
  reachable: boolean | null,
  endpoint: string,
): CheckResult | null {
  if (reachable === null) return null;
  if (reachable) {
    return {
      name: "hindsight LiteLLM reachability",
      status: "ok",
      detail: `TCP ok to ${endpoint}`,
    };
  }
  return {
    name: "hindsight LiteLLM reachability",
    status: "fail",
    detail: `cannot TCP-connect to ${endpoint} — hindsight LLM ops will fail`,
    fix:
      "Start/fix the LiteLLM proxy (host :4010), then `switchroom memory --restart` " +
      "if hindsight was started while it was down.",
  };
}

export function checkHindsightContainerHealth(
  opts?: { exec?: (cmd: string, args: string[]) => string; containerName?: string },
): CheckResult[] {
  const name = opts?.containerName ?? "switchroom-hindsight";
  const exec =
    opts?.exec ??
    ((cmd: string, args: string[]) =>
      execFileSync(cmd, args, {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 8000,
        // Boot-window log fetches (verification below) can exceed the 1MB
        // default on a busy hindsight; a truncation throw would silently drop
        // the check. 16MB is ample for a bounded ~10-min boot window.
        maxBuffer: 16 * 1024 * 1024,
      }).toString());

  const results: CheckResult[] = [];

  let shmRaw: string;
  try {
    shmRaw = exec("docker", ["inspect", name, "--format", "{{.HostConfig.ShmSize}}"]).trim();
  } catch {
    return []; // not a local container / no docker — nothing to check here
  }
  const shmBytes = parseInt(shmRaw, 10);
  if (Number.isFinite(shmBytes) && shmBytes > 0) {
    results.push(classifyShmSize(shmBytes));
  }

  // Boot-time LLM-connection verification (#3408). Verification fires ONCE at
  // startup, which may be far outside the 10m extraction window — so we bound
  // the fetch to this container's own boot window: [StartedAt, StartedAt+10m].
  // That captures the verification lines regardless of how long ago hindsight
  // booted, while staying tightly bounded (never a full multi-day log dump).
  try {
    const startedAt = exec("docker", [
      "inspect",
      name,
      "--format",
      "{{.State.StartedAt}}",
    ]).trim();
    const startMs = Date.parse(startedAt);
    if (Number.isFinite(startMs)) {
      const untilIso = new Date(startMs + 10 * 60_000).toISOString();
      const bootLogs = exec("docker", [
        "logs",
        "--since",
        startedAt,
        "--until",
        untilIso,
        name,
      ]);
      const verifyRow = classifyLlmVerification(bootLogs);
      if (verifyRow) results.push(verifyRow);
    }
  } catch {
    // inspect/logs unavailable — skip the verification check rather than fail.
  }

  try {
    const logs = exec("docker", ["logs", "--since", "10m", name]);
    results.push(classifyExtractionLogs(logs));
  } catch {
    // logs unavailable — skip the extraction check rather than fail the run
  }

  // Autoheal sidecar status (#2910). Only surfaces when the sidecar exists
  // (its logs are readable) — a fleet without hostd/autoheal skips this line
  // rather than showing a spurious "ok".
  try {
    const autohealLogs = exec("docker", ["logs", "--since", "1h", "switchroom-hindsight-autoheal"]);
    results.push(classifyAutohealStatus(autohealLogs));
  } catch {
    // no autoheal sidecar (no hostd project / not deployed) — nothing to report
  }

  // Dual-writer footgun (2026-07-19): any second container mounting the live
  // data volume. Uses the same docker filter stopHindsight relies on.
  try {
    const mounts = listHindsightDataVolumeMounts(exec);
    results.push(classifyHindsightDataVolumeMounts(mounts));
  } catch {
    // docker unavailable mid-check — skip
  }

  // Network mode + LiteLLM reachability when hindsight is configured for it.
  try {
    const netMode = exec("docker", [
      "inspect", name, "--format", "{{.HostConfig.NetworkMode}}",
    ]).trim();
    // Detect LiteLLM routing via the retained per-op/base URL env on the
    // container (set by startHindsight when litellm is configured).
    const envBlob = exec("docker", [
      "inspect", name, "--format", "{{range .Config.Env}}{{println .}}{{end}}",
    ]);
    // Gate primarily on the retained per-op LLM base URLs (set whenever
    // hindsight.llm.{retain,reflect,consolidation}.base_url or startHindsight's
    // litellm path is active). ANTHROPIC_BASE_URL alone is common on ordinary
    // agent containers / residual env and is NOT a LiteLLM signal unless its
    // value looks like a litellm proxy path (host :4010 or /anthropic suffix).
    const perOpBasePresent =
      /HINDSIGHT_API_(RETAIN|REFLECT|CONSOLIDATION)_LLM_BASE_URL=/.test(envBlob);
    const anthropicBaseMatch = envBlob.match(/(?:^|\n)ANTHROPIC_BASE_URL=(\S+)/);
    const anthropicLooksLikeLiteLlm = (() => {
      const raw = anthropicBaseMatch?.[1]?.trim();
      if (!raw) return false;
      try {
        const u = new URL(raw.includes("://") ? raw : `http://${raw}`);
        const port = u.port || (u.protocol === "https:" ? "443" : "80");
        const path = (u.pathname || "").replace(/\/+$/, "");
        // Fleet LiteLLM default is :4010; pass-through is <root>/anthropic.
        if (port === "4010") return true;
        if (/\/anthropic$/i.test(path)) return true;
        if (/litellm/i.test(u.hostname || "")) return true;
        return false;
      } catch {
        return false;
      }
    })();
    const litellmConfigured = perOpBasePresent || anthropicLooksLikeLiteLlm;
    results.push(classifyHindsightNetworkMode(netMode, litellmConfigured));

    if (litellmConfigured) {
      // Prefer per-op retained base URL; only fall back to ANTHROPIC_BASE_URL
      // when it already looked like LiteLLM above. Default host LiteLLM.
      const m = envBlob.match(/HINDSIGHT_API_RETAIN_LLM_BASE_URL=(\S+)/)
        ?? envBlob.match(/HINDSIGHT_API_REFLECT_LLM_BASE_URL=(\S+)/)
        ?? envBlob.match(/HINDSIGHT_API_CONSOLIDATION_LLM_BASE_URL=(\S+)/)
        ?? (anthropicLooksLikeLiteLlm ? anthropicBaseMatch : null);
      let endpoint = "127.0.0.1:4010";
      if (m) {
        try {
          const u = new URL(m[1].includes("://") ? m[1] : `http://${m[1]}`);
          endpoint = `${u.hostname || "127.0.0.1"}:${u.port || "80"}`;
        } catch { /* keep default */ }
      }
      const [host, portStr] = endpoint.split(":");
      const port = Number(portStr) || 80;
      let reachable: boolean | null = null;
      try {
        // bash /dev/tcp is available in this fleet's environments; keep the
        // probe short. Nonzero exit → unreachable.
        exec("bash", ["-c", `echo > /dev/tcp/${host}/${port}`]);
        reachable = true;
      } catch {
        reachable = false;
      }
      const row = classifyLiteLlmReachability(reachable, endpoint);
      if (row) results.push(row);
    }
  } catch {
    // inspect failed — secondary to the shm probe's empty return above
  }

  return results;
}

/**
 * Pure: classify the result of a `GET <hindsight>/health` probe into a doctor
 * result. A memory outage (container down, crash-looping on a port collision,
 * or wedged) is otherwise SILENT — auto-recall failing produces no user-facing
 * error, so the fleet goes amnesiac unnoticed (the 2026-07 incident ran ~9h
 * before anyone noticed). A non-200 /health flips this red.
 *
 * `status` is the HTTP status code, or `null` when the request never completed
 * (connection refused / timeout — the crash-loop signature).
 */
export function classifyHindsightHealthProbe(
  status: number | null,
  port: number,
): CheckResult {
  if (status === 200) {
    return {
      name: "hindsight /health",
      status: "ok",
      detail: `200 at :${port} — memory backend live`,
    };
  }
  if (status === null) {
    return {
      name: "hindsight /health",
      status: "fail",
      detail:
        `no response on :${port} — the container is down or crash-looping ` +
        `(fleet memory is silently OFF: auto-recall/retain fail with no user error)`,
      fix:
        "Check `docker logs switchroom-hindsight` for `[Errno 98] address " +
        "already in use` (a foreign process on the port) and run " +
        "`switchroom memory --start` — the launcher now preflights the port " +
        "and reassigns instead of crash-looping.",
    };
  }
  return {
    name: "hindsight /health",
    status: "fail",
    detail: `HTTP ${status} at :${port} — memory backend unhealthy`,
    fix: "Inspect `docker logs switchroom-hindsight`; restart with `switchroom memory --restart`.",
  };
}

/**
 * Best-effort async wrapper: GET `<mcpUrl origin>/health` and classify it.
 * Derives the health URL from the MCP url (strips the `/mcp/` suffix). Fails
 * closed to a `fail` result (never throws) so a memory outage surfaces even
 * when the probe itself errors.
 */
export async function checkHindsightHealthEndpoint(
  mcpUrl: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<CheckResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 4000;
  const origin = mcpUrl.replace(/\/mcp\/?$/, "").replace(/\/$/, "");
  const healthUrl = `${origin}/health`;
  const port = (() => {
    const m = origin.match(/:(\d+)(?:$|\/)/);
    return m ? parseInt(m[1], 10) : 80;
  })();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(healthUrl, { signal: controller.signal });
    return classifyHindsightHealthProbe(res.status, port);
  } catch {
    return classifyHindsightHealthProbe(null, port);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An advertised hindsight tool as returned by tools/list — just the bits the
 * contract check needs.
 */
export interface AdvertisedTool {
  name: string;
  required: string[];
}

/**
 * Pure: diff the live server's advertised tools against the tools switchroom
 * actually uses (EXPECTED_HINDSIGHT_TOOLS). This is THE contract-drift detector
 * — it would have caught all 5 of the 2026-06-06..07 incidents the moment the
 * server changed (every mocked unit test stays green through an upstream
 * rename; only a live diff catches it).
 *
 * Returns one CheckResult per drift (so each surfaces as its own doctor line)
 * plus a single rollup `ok` line when the contract is clean. Two drift classes:
 *  - MISSING TOOL: switchroom calls a tool the server no longer advertises
 *    (renamed/removed) → every callsite silently no-ops (delete_memory,
 *    update_memory, query→source_query at the tool level).
 *  - REQUIRED-ARG DRIFT: the server now requires an arg switchroom doesn't
 *    track (the source_query rename, at the arg level).
 */
export function classifyToolContract(advertised: AdvertisedTool[]): CheckResult[] {
  const byName = new Map(advertised.map((t) => [t.name, t]));
  const results: CheckResult[] = [];

  for (const [tool, spec] of Object.entries(EXPECTED_HINDSIGHT_TOOLS)) {
    const real = byName.get(tool);
    if (real === undefined) {
      results.push({
        name: `hindsight contract: ${tool}`,
        status: "fail",
        detail:
          `switchroom calls \`${tool}\` but the server no longer advertises it ` +
          `(renamed/removed upstream) — every callsite silently no-ops`,
        fix:
          "Upstream hindsight changed its MCP tool contract. Update the callsite " +
          "+ EXPECTED_HINDSIGHT_TOOLS (src/memory/hindsight-tools.ts) to the new " +
          "name, refresh tests/fixtures/hindsight-tools-list.snapshot.json, or pin " +
          "the prior hindsight image.",
      });
      continue;
    }
    const missing = spec.required.filter((arg) => !real.required.includes(arg));
    const added = real.required.filter((arg) => !spec.required.includes(arg));
    if (added.length > 0) {
      results.push({
        name: `hindsight contract: ${tool}`,
        status: "fail",
        detail:
          `server now requires [${added.join(", ")}] on \`${tool}\` which ` +
          `switchroom does not track — calls may silently no-op`,
        fix:
          "Reconcile EXPECTED_HINDSIGHT_TOOLS + the callsite args with the new " +
          "server schema, then refresh the snapshot fixture.",
      });
    } else if (missing.length > 0) {
      // We think it's required but the server dropped it — informational, the
      // callsite still works (sending an unneeded arg the server may drop).
      results.push({
        name: `hindsight contract: ${tool}`,
        status: "warn",
        detail:
          `switchroom treats [${missing.join(", ")}] as required on \`${tool}\` ` +
          `but the server no longer does (loosened upstream) — harmless, but the ` +
          `fixture is stale`,
        fix: "Refresh EXPECTED_HINDSIGHT_TOOLS + the snapshot fixture.",
      });
    }
  }

  if (results.length === 0) {
    const used = Object.keys(EXPECTED_HINDSIGHT_TOOLS).length;
    results.push({
      name: "hindsight contract",
      status: "ok",
      detail: `${used} used tools present, required args satisfied (${advertised.length} advertised)`,
    });
  }
  return results;
}
