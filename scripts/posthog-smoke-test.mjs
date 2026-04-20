import { PostHog } from "posthog-node";

const client = new PostHog(
  process.env.SWITCHROOM_POSTHOG_KEY ?? "phc_qKY87cKWZm6ZyCtk7LcRd2cU8Sg42u7Ywhui5stYCegd",
  {
    host: process.env.SWITCHROOM_POSTHOG_HOST ?? "https://us.i.posthog.com",
    flushAt: 1,
    flushInterval: 0,
  }
);

await client.captureImmediate({
  distinctId: "switchroom-install-smoke-test",
  event: "integration_verified",
  properties: {
    source: "install_smoke_test",
    project: "switchroom",
    node_version: process.version,
    platform: process.platform,
  },
});

await client.shutdown(5000);
console.log("Event sent to PostHog — check Activity in the dashboard.");
