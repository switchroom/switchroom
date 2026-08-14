// The pre-follow-up suite: every case injects the seam and asserts the MIRROR.
// Production never calls the seam, so deleting the real spawn's argument is
// invisible here.
import assert from "node:assert/strict";
import { makeServer } from "./module.mjs";

const seen = [];
const server = makeServer({
  runReconcile: async (a) => {
    seen.push(a.env);
    return { exit_code: 0 };
  },
});
const res = await server.apply("/state/config/switchroom.yaml");
assert.equal(res.exit_code, 0);
assert.equal(seen.length, 1);
assert.equal(seen[0].SWITCHROOM_CONFIG, "/state/config/switchroom.yaml");
