/**
 * `switchroom webd` — install / status / uninstall the web service
 * container (dashboard + GitHub-webhook receiver). Phase 3 of the
 * webhook Docker-native migration.
 *
 * Replaces the `switchroom-web.service` systemd unit that ran the web
 * server straight off the shared source checkout
 * (`bun bin/switchroom.ts web`). That arrangement was fragile: any
 * other agent's worktree activity could delete the hoisted root
 * node_modules out from under the long-lived process, so the NEXT
 * restart crash-looped on ENOENT even though the code was unchanged.
 * Pinning the receiver to an image makes it immune to repo churn and
 * brings the last systemd holdout in line with the rest of the fleet
 * (vault-broker, kernel, hostd, agents are all containers).
 *
 * Like hostd, the daemon runs in a SEPARATE compose project
 * (`switchroom-web`) from the agent fleet (`switchroom`) so a
 * `compose -p switchroom up -d --remove-orphans` cycle of the agent
 * fleet cannot recreate this container mid-request. See
 * project_docker_first / RFC C §5.1 for the isolation rationale.
 *
 * Subcommands:
 *   install    — write ~/.switchroom/web/docker-compose.yml + start
 *   status     — show container state
 *   uninstall  — stop the container (leaves the sibling compose file
 *                on disk for re-install)
 *
 * Idempotent: `install` re-writes the compose template every time
 * (operator hand-edits get backed up to `docker-compose.yml.bak-<ts>`)
 * and re-runs `compose up -d`. Safe to call repeatedly.
 *
 * IMPORTANT — the systemd unit is NOT removed by `uninstall`. The
 * intended cutover is: container up on alt port → verify → stop
 * systemd unit → re-`install` container on 8080. If the container
 * misbehaves, re-enable the systemd unit and you're back on the
 * source-checkout server in seconds. Retiring the unit is a deliberate,
 * separate operator step once the container has soaked.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { withConfigError } from "./helpers.js";
import { resolveOperatorUid } from "./operator-uid.js";

/**
 * Image tag the install verb pins. Defaults to `:latest`. Override
 * via `--tag <X>` when standing up a specific version (recommended
 * for production deploys; `:latest` is the dev/operator default).
 */
const DEFAULT_IMAGE_TAG = "latest";

/**
 * Compose project name for the web service. MUST be distinct from
 * `switchroom` (the agent-fleet project) so a `compose -p switchroom
 * up -d --remove-orphans` cycle cannot recreate this container
 * mid-request. Same isolation contract as switchroom-hostd.
 */
const WEB_COMPOSE_PROJECT = "switchroom-web";

/**
 * Render the sibling compose file. Pure-string template.
 *
 * Three load-bearing differences from the hostd compose template, each
 * forced by what the web service is:
 *
 *   1. `network_mode: host`. The server MUST own host loopback
 *      127.0.0.1:8080 — two host-side consumers reach it there and
 *      that address cannot change:
 *        - cloudflared tunnel (hooks.switchroom.ai → 127.0.0.1:8080)
 *          for GitHub webhooks.
 *        - `tailscale serve` proxies the tailnet host →
 *          http://127.0.0.1:8080 for the dashboard (the CSRF origin
 *          gate trusts the Tailscale-User-Login header from loopback,
 *          PR #1380).
 *      Host networking makes the container's 127.0.0.1 the host
 *      loopback, so both keep working with zero Cloudflare/Tailscale
 *      reconfiguration. (A published-port mapping would NOT — the
 *      loopback trust in the CSRF gate keys on the request arriving on
 *      127.0.0.1, which only host-net preserves.)
 *
 *   2. `user: "<operatorUid>:<operatorUid>"`. The webhook.sock the
 *      receiver forwards to is peercred-gated by each agent's gateway
 *      to {agent's own uid, SWITCHROOM_WEBHOOK_RECEIVER_UID}, and the
 *      compose generator sets SWITCHROOM_WEBHOOK_RECEIVER_UID to the
 *      operator uid (src/agents/compose.ts). Run as any other uid and
 *      every forward gets 503'd. The operator uid also owns
 *      ~/.switchroom, so the file reads (config, webhook-secrets,
 *      edge-secret, web-token) work.
 *
 *   3. NO docker.sock, NO cap_add. This is the one internet-facing
 *      component, so it gets the minimal attack surface: the bind
 *      mounts it needs and nothing else. cap_drop ALL +
 *      no-new-privileges, like hostd, but without re-adding any cap
 *      (the web server never chowns sockets or shells out to docker).
 */
export function renderWebComposeFile(opts: {
  hostHome: string;
  imageTag: string;
  /** Host operator UID — the container runs as this so its forwards to
   *  per-agent webhook.sock pass the gateway's peercred ACL, and so its
   *  reads of operator-owned ~/.switchroom files succeed. REQUIRED:
   *  without it the receiver can neither read its secrets nor forward. */
  operatorUid: number;
}): string {
  const { hostHome, imageTag, operatorUid } = opts;
  return `# AUTO-GENERATED by \`switchroom webd install\` — do not hand-edit.
# Edits land at \`switchroom webd install\` time; backed up to
# docker-compose.yml.bak-<ts> on overwrite.
#
# Separate compose project (\`switchroom-web\`) from the agent fleet
# (\`switchroom\`) so \`compose up -d --remove-orphans\` against the fleet
# cannot recreate this container mid-request. Same isolation contract
# as switchroom-hostd.

services:
  web:
    image: ghcr.io/switchroom/switchroom-web:${imageTag}
    container_name: switchroom-web
    restart: unless-stopped
    # The server MUST own host loopback 127.0.0.1:8080 — the cloudflared
    # tunnel (GitHub webhooks) and \`tailscale serve\` (dashboard) both
    # reach it there, and the dashboard CSRF gate trusts the
    # Tailscale-User-Login header only when the request arrives on
    # loopback (PR #1380). Host networking makes the container's
    # 127.0.0.1 the host loopback, so both keep working unchanged.
    network_mode: host
    # The webhook.sock forward is peercred-gated by each agent's gateway
    # to {agent uid, SWITCHROOM_WEBHOOK_RECEIVER_UID = operator uid}.
    # Run as any other uid → every forward is 503'd. Operator uid also
    # owns ~/.switchroom so config/secret reads work.
    user: "${operatorUid}:${operatorUid}"
    # tini (image ENTRYPOINT) forwards SIGTERM to the bun process on
    # \`docker stop\`; Bun.serve shuts its listener within the grace
    # window. 15s mirrors hostd.
    stop_grace_period: 15s
    cap_drop:
      - ALL
    # Deliberately NO cap_add — the web server never chowns sockets or
    # shells out to docker. Minimal surface for the one internet-facing
    # component.
    security_opt:
      - no-new-privileges:true
    volumes:
      # The receiver reads operator-owned files under ~/.switchroom:
      #   - webhook-secrets.json (per-source HMAC secrets)
      #   - webhook-edge-secret (Cloudflare edge lock, Phase 2)
      #   - web-token (dashboard auth)
      # and forwards verified events to per-agent webhook.sock at
      #   ~/.switchroom/agents/<agent>/telegram/webhook.sock
      # so it needs the whole tree read-write (the sock connect is a
      # write-side operation on the agent dir).
      - ${hostHome}/.switchroom:/host-home/.switchroom:rw
      # ~/.switchroom/switchroom.yaml is a symlink on many operator
      # setups (into a separate config repo). Mounting the file directly
      # forces docker to follow the symlink at mount time and bind the
      # underlying file. The dashboard only READS the config, so :ro.
      # Mirrors how the agent + hostd containers expose the config at
      # /state/config/switchroom.yaml.
      - ${hostHome}/.switchroom/switchroom.yaml:/state/config/switchroom.yaml:ro
      # No docker socket is mounted — the web server never touches docker.
    environment:
      # The CLI resolves homedir() for ~/.switchroom paths; pin it to
      # /host-home (bind-mounted to the operator's home) so the paths
      # the server reads/writes match the host paths the agent fleet
      # binds (~/.switchroom/agents/<agent>/telegram/webhook.sock, …).
      HOME: /host-home
      # Read the same config the agent fleet's compose generator did.
      SWITCHROOM_CONFIG: /state/config/switchroom.yaml
      # PATH must include /usr/local/bin for the switchroom shim.
      PATH: /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    # network_mode: host means no custom network is attached; the
    # container shares the host network namespace directly.

# Healthcheck deferred — the server has no /healthz endpoint yet and a
# probe that hits the dashboard route would need the web-token. For now,
# \`switchroom webd status\` is the operator surface and the server's
# stderr lands in \`docker logs switchroom-web\`.
`;
}

function webdDir(): string {
  return join(homedir(), ".switchroom", "web");
}

function webdComposePath(): string {
  return join(webdDir(), "docker-compose.yml");
}

function backupExistingCompose(): string | null {
  const p = webdComposePath();
  if (!existsSync(p)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = `${p}.bak-${ts}`;
  copyFileSync(p, bak);
  return bak;
}

function runDocker(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

interface InstallOptions {
  tag?: string;
  dryRun?: boolean;
}

async function doInstall(opts: InstallOptions): Promise<void> {
  // The container MUST run as the operator uid (peercred gate + file
  // ownership). Refuse to write a compose file that would run as root
  // or with an unknown uid — a root-mode forward is silently 503'd by
  // every agent gateway, which is the exact silent-breakage class this
  // migration exists to kill.
  const operatorUid = resolveOperatorUid();
  if (operatorUid === undefined) {
    console.error(
      chalk.red(
        "Could not resolve the operator uid (no SUDO_UID and getuid() is 0 or unavailable).\n" +
          "The web container must run as the operator uid so its webhook forwards pass\n" +
          "each agent gateway's peercred ACL. Run `switchroom webd install` as the\n" +
          "operator user (not root), or under `sudo` from the operator's shell.",
      ),
    );
    process.exit(1);
  }

  const dir = webdDir();
  const composePath = webdComposePath();
  mkdirSync(dir, { recursive: true });

  const yaml = renderWebComposeFile({
    hostHome: homedir(),
    imageTag: opts.tag ?? DEFAULT_IMAGE_TAG,
    operatorUid,
  });

  if (opts.dryRun) {
    console.log(chalk.dim(`# Would write: ${composePath}`));
    console.log(yaml);
    console.log(chalk.dim(`# Would run: docker compose -p ${WEB_COMPOSE_PROJECT} -f ${composePath} up -d`));
    return;
  }

  const bak = backupExistingCompose();
  if (bak) console.log(chalk.dim(`  Backed up existing compose to ${bak}`));

  writeFileSync(composePath, yaml, "utf8");
  console.log(chalk.green(`  ✓ Wrote ${composePath}`));
  console.log(chalk.dim(`    running as uid ${operatorUid} (operator), network_mode: host`));

  // Pull, then up. We pull explicitly so a pull failure (network
  // glitch, GHCR throttle) surfaces before the up step rather than
  // mid-recreate. `docker compose pull` is idempotent and skips images
  // already at the requested digest.
  console.log(chalk.dim(`    Pulling ghcr.io/switchroom/switchroom-web:${opts.tag ?? DEFAULT_IMAGE_TAG}…`));
  const pull = runDocker(["compose", "-p", WEB_COMPOSE_PROJECT, "-f", composePath, "pull"]);
  if (!pull.ok) {
    console.error(chalk.red(`  pull failed:\n${pull.stderr}`));
    console.error(
      chalk.yellow(
        `  Hint: \`ghcr.io/switchroom/switchroom-web:${opts.tag ?? DEFAULT_IMAGE_TAG}\` may not be published yet.\n` +
          `  Check the docker-images workflow run and verify the tag at:\n` +
          `      https://github.com/switchroom/switchroom/pkgs/container/switchroom-web`,
      ),
    );
    process.exit(1);
  }

  console.log(chalk.dim(`    Bringing up web service…`));
  const up = runDocker(["compose", "-p", WEB_COMPOSE_PROJECT, "-f", composePath, "up", "-d"]);
  if (!up.ok) {
    console.error(chalk.red(`  up failed:\n${up.stderr}`));
    process.exit(1);
  }
  console.log(chalk.green(`  ✓ Web service running (project: ${WEB_COMPOSE_PROJECT})`));
  console.log(chalk.dim(`    Logs: docker logs switchroom-web --tail 50`));
  console.log(chalk.dim(`    Verify: switchroom webd status`));
  console.log(
    chalk.yellow(
      `    NOTE: the switchroom-web.service systemd unit (if still installed) also\n` +
        `    binds 127.0.0.1:8080. Stop it before this container can claim the port:\n` +
        `        systemctl --user stop switchroom-web.service\n` +
        `        systemctl --user disable switchroom-web.service`,
    ),
  );
}

function doStatus(): void {
  const composeYml = webdComposePath();

  console.log(chalk.bold("switchroom-web"));
  console.log("");

  if (!existsSync(composeYml)) {
    console.log(chalk.yellow("  compose:    not installed"));
    console.log(chalk.dim("              run `switchroom webd install` to set up."));
    return;
  }
  console.log(chalk.green(`  compose:    ${composeYml}`));

  const ps = runDocker([
    "compose",
    "-p",
    WEB_COMPOSE_PROJECT,
    "-f",
    composeYml,
    "ps",
    "--format",
    "{{.Name}} {{.Status}} {{.Image}}",
  ]);
  if (!ps.ok || !ps.stdout.trim()) {
    console.log(chalk.yellow("  container:  not running"));
  } else {
    console.log(chalk.green(`  container:  ${ps.stdout.trim()}`));
  }
}

function doUninstall(): void {
  const composeYml = webdComposePath();
  if (!existsSync(composeYml)) {
    console.log(chalk.yellow("  No web-service install detected (no compose file at this path)."));
    return;
  }
  console.log(chalk.dim(`  Stopping ${WEB_COMPOSE_PROJECT}…`));
  const down = runDocker(["compose", "-p", WEB_COMPOSE_PROJECT, "-f", composeYml, "down"]);
  if (!down.ok) {
    console.error(chalk.red(`  down failed:\n${down.stderr}`));
    process.exit(1);
  }
  console.log(chalk.green("  ✓ Web service stopped"));
  console.log(chalk.dim(`    Compose file left in place at ${composeYml}`));
  console.log(chalk.dim(`    To re-enable: switchroom webd install`));
  console.log(
    chalk.yellow(
      `    If you cut over from the systemd unit, re-enable it to restore the\n` +
        `    dashboard + webhook receiver:\n` +
        `        systemctl --user enable --now switchroom-web.service`,
    ),
  );
}

export function registerWebdCommand(program: Command): void {
  const webd = program
    .command("webd")
    .description(
      "Manage switchroom-web, the dashboard + GitHub-webhook receiver container",
    );

  webd
    .command("install")
    .description("Install or refresh the web container (writes ~/.switchroom/web/docker-compose.yml + docker compose up -d)")
    .option("--tag <tag>", "Image tag (default: latest)", DEFAULT_IMAGE_TAG)
    .option("--dry-run", "Print the compose file and the docker commands without writing or running anything")
    .action(
      withConfigError(async (opts: InstallOptions) => {
        await doInstall(opts);
      }),
    );

  webd
    .command("status")
    .description("Show web-service container state")
    .action(() => doStatus());

  webd
    .command("uninstall")
    .description("Stop the web container. Leaves the compose file in place for re-install.")
    .action(() => doUninstall());
}
