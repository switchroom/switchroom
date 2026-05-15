import { describe, it, expect } from "vitest";
import { checkHindsightConsumer } from "../src/cli/doctor.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

// Pins the contract that the hindsight-consumer probe queries the broker
// CONTAINER (which can stat its own bound sockets) rather than the host
// `/var/lib/docker/volumes/.../sock` path. The latter lives under a
// root-only-traversable `/var/lib/docker` on common docker.io installs;
// `existsSync` from the operator UID returns false even when the socket
// is bound and healthy. See #1281 for the regression.

function configWithConsumer(): SwitchroomConfig {
  return {
    switchroom: { version: 1, agents_dir: "~/.switchroom/agents" },
    telegram: { bot_token: "test-token", forum_chat_id: "-100123" },
    agents: {},
    auth: {
      consumers: [
        { name: "hindsight", account: "me@example.com", uid: 11000 },
      ],
    },
  } as SwitchroomConfig;
}

function configWithoutConsumer(): SwitchroomConfig {
  return {
    switchroom: { version: 1, agents_dir: "~/.switchroom/agents" },
    telegram: { bot_token: "test-token", forum_chat_id: "-100123" },
    agents: {},
  } as SwitchroomConfig;
}

describe("checkHindsightConsumer", () => {
  it("warns when no auth.consumers[] entry named hindsight exists", () => {
    const result = checkHindsightConsumer(configWithoutConsumer());
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("no `auth.consumers[]` entry named `hindsight`");
    // Fix points the operator at switchroom.yaml, not at restart magic.
    expect(result.fix).toContain("auth:");
    expect(result.fix).toContain("consumers:");
  });

  it("reports ok when the consumer is declared AND the broker confirms the socket is bound", () => {
    const result = checkHindsightConsumer(configWithConsumer(), {
      socketProbe: () => "present",
    });
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("auth.consumers[hindsight]");
    expect(result.detail).toContain("me@example.com");
    expect(result.detail).toContain("uid 11000");
  });

  it("warns with a 'socket not bound' message when the broker says missing", () => {
    const result = checkHindsightConsumer(configWithConsumer(), {
      socketProbe: () => "missing",
    });
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("socket not bound");
    // The fix points at `switchroom apply`, not raw docker compose —
    // matches the operator-restart-marker discipline in CLAUDE.md.
    expect(result.fix).toContain("switchroom apply");
  });

  it("warns distinctly when the broker container itself is unreachable", () => {
    // This is the case the regression was about: probe couldn't reach
    // the broker, but historically it conflated that with "socket not
    // bound." Operator was told to `switchroom apply` when the real
    // issue might be docker / broker down. New behaviour routes the
    // operator to the auth-broker service health row first.
    const result = checkHindsightConsumer(configWithConsumer(), {
      socketProbe: () => "unreachable",
    });
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("couldn't query auth-broker container");
    expect(result.fix).toContain("service health");
  });

  it("queries the broker by consumer name, not by a hardcoded path", () => {
    // Structural pin: the probe receives the consumer name so a future
    // consumer (e.g. cron, custom MCP) can reuse the same probe shape.
    // If someone refactors this to a hardcoded "hindsight" string the
    // probe stops being reusable.
    let probedName: string | undefined;
    checkHindsightConsumer(configWithConsumer(), {
      socketProbe: (name) => {
        probedName = name;
        return "present";
      },
    });
    expect(probedName).toBe("hindsight");
  });
});
