// Fixture: the #4670 shape, reduced.
//
// `reconcileEnv` is referenced TWICE — once positionally by the real spawn,
// once as the `env` field the injected seam receives. Nothing in the type
// system ties them, so a suite that only ever asserts the seam's copy stays
// green when the real spawn's argument is deleted. Verbatim the situation
// documented at src/host-control/server.ts:298-317.
let lastChildEnv = null;

export function spawnChild(args, extraEnv) {
  lastChildEnv = { ...(extraEnv ?? {}) };
  return { exit_code: 0 };
}

export function childEnv() {
  return lastChildEnv;
}

export function makeServer(opts = {}) {
  return {
    async apply(configPath) {
      const reconcileEnv = { SWITCHROOM_CONFIG: configPath };
      const runner =
        opts.runReconcile ??
        (async () => spawnChild(["apply", "--non-interactive"], reconcileEnv));
      return runner({ env: reconcileEnv });
    },
  };
}
