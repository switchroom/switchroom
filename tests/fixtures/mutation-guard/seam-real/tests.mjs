// The post-follow-up suite: same seam assertions, PLUS one case that injects
// nothing and reads the variable out of the child's OWN environment. That is
// the assertion tests/host-control/config-propose-edit.test.ts:1439 added.
import assert from "node:assert/strict";
import { makeServer, childEnv } from "./module.mjs";

const seen = [];
const seamed = makeServer({
  runReconcile: async (a) => {
    seen.push(a.env);
    return { exit_code: 0 };
  },
});
await seamed.apply("/state/config/switchroom.yaml");
assert.equal(seen[0].SWITCHROOM_CONFIG, "/state/config/switchroom.yaml");

// No seam — the production path.
const real = makeServer();
await real.apply("/state/config/switchroom.yaml");
assert.deepEqual(childEnv(), { SWITCHROOM_CONFIG: "/state/config/switchroom.yaml" });
