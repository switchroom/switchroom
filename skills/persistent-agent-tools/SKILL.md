---
name: persistent-agent-tools
description: "Use when a tool must survive image updates. Classify scope, then pin it."
---

# Persistent agent tools

Agent containers are recreated on every image update. Anything installed by hand into the image
filesystem disappears. Decide where a dependency belongs, declare it with an exact pin, and
restore it only from that declaration.

This skill does not install OS packages, patch Hermes core, or start daemons inside an agent.

## When to use

- A CLI, library or binary is missing after an image update.
- Someone asks where a dependency should live.
- A skill needs a Python library, Node CLI or standalone binary.

Not for Hermes configuration, image rebuilds, or host and Compose services.

## Pick exactly one scope

| Scope | When | Desired state lives in |
|---|---|---|
| One-off | Disposable, used once | an exact `uvx` / `npx` invocation |
| Project | A repository needs it | that repository's manifest and lockfile |
| Profile | One agent or skill needs it | a per-profile tool lock in the overlay repository |
| Image | Native runtime, or shared by several agents | the image Dockerfile, pinned, then a normal image rollout |
| Service | A daemon, port, database or GPU | a separate sidecar or host service |

One profile needs it: profile lock. Several profiles plus a native runtime: image. A library
one profile uses stays profile-local. If none fit, stop and ask.

## Restore an existing declaration

If the deployment provides a reconciler for profile tool locks, call it by absolute path against
the deployed lock. Terminal `PATH` is not authoritative.

```bash
RECONCILER=/opt/example/bin/tool-reconciler   # deployment-specific path
LOCK="$HERMES_HOME/tooling/tools.lock.yaml"     # deployment-specific path
"$RECONCILER" verify "$LOCK"
```

If verify passes, stop. Do not reinstall a matching pin. If it reports something missing, run
its plan, review it, apply, then verify again.

If the reconciler, the lock or a file the lock references is absent, that is a deployment
defect. Report it. It is not permission to run `pip`, `uv tool install`, `npm -g` or any other
ad hoc installer.

## Add or change a declaration

1. **Classify** with the table above.
2. **Declare in source.** Add or update the lock in the overlay repository (or the project
   lockfile, or the Dockerfile). Exact versions, no `latest`, no secrets.
3. **Review and merge** the source change before touching any running agent.
4. **Deliver** the declared state to the owning profile through the deployment's normal path.
5. **Plan, apply, verify** as the agent's runtime user.
6. **Invoke** exposed executables directly. Domain skills call tools; they do not contain
   install recipes.
7. **Recreate and verify.** The pin must still be there after the agent is recreated.

Package-manager rules are in [`references/adapters.md`](references/adapters.md). For a manager not
listed there, find its official lock mechanism, then stop and request an adapter.

## Pitfalls

- `python3 /path/to/script` ignores a venv shebang. Run the executable.
- A handmade venv with no committed lock persists but is not reproducible.
- A deployed runtime lock is desired state delivered from source, not the source of truth. Do
  not hand-edit it.
- `apt`, `/usr`, `/usr/local` and image-owned paths do not survive recreation.
- Do not add remembered install commands to agent startup.

## Done means

The reconciler (or the project or image check) verifies the pin, exposed commands use their own
interpreter, files belong to the agent's runtime user, the declaration is merged, and a
recreated agent still has the same pinned result.
