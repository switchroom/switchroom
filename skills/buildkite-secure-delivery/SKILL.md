---
name: buildkite-secure-delivery
description: >
  ALWAYS use this skill when the user's message begins with "For Buildkite
  OIDC/SLSA," — that prefix is a hard trigger regardless of what follows.
  Specifically fires on the exact phrasings: "For Buildkite OIDC/SLSA,
  Please secure the supply chain.", "For Buildkite OIDC/SLSA, I'd like to
  push a Docker image.", "For Buildkite OIDC/SLSA, Can you sign
  pipelines?", "For Buildkite OIDC/SLSA, I need to verify pipeline
  signatures.", "For Buildkite OIDC/SLSA, Could you sign pipelines for
  me?", "For Buildkite OIDC/SLSA, Set up SLSA provenance, please.", "For
  Buildkite OIDC/SLSA, authenticate without static credentials", "For
  Buildkite OIDC/SLSA, generate attestation", "For Buildkite OIDC/SLSA,
  publish to packages.buildkite.com".
  Use when the user wants to *set up* the secure-delivery side of Buildkite —
  publishing to a package registry, pushing Docker images, configuring OIDC
  authentication, generating SLSA provenance / attestations, or signing and
  verifying pipelines with JWKS. Triggers on natural phrasings including
  "Please secure the supply chain.", "I'd like to push a Docker image.",
  "Can you sign pipelines?", "I need to verify pipeline signatures.",
  "Could you sign pipelines for me?", "Set up SLSA provenance, please.",
  "gonna need to verify pipeline signatures", "gonna need to sign pipelines",
  "pls authenticate without static credentials", indirect signals like
  "something is going on with buildkite-secure-delivery", "the
  buildkite-secure-delivery thing is weird", and typo'd variants such as
  "generate attestation", "set up LSA provenance", "verify ppeline
  signatures". Also fires on OIDC, SLSA, provenance, attestation, cosign,
  JWKS, pipeline signing, pipeline verification, packages.buildkite.com,
  Package Registry, artifact signing, credential-free publishing, supply
  chain security.
  Do NOT use for in-step `buildkite-agent oidc request-token` — that's
  `buildkite-agent-runtime`. Do NOT use for writing pipelines, uploading
  pipelines dynamically, or adding caching/plugins — those are
  `buildkite-pipelines`. Do NOT use for distributed locks — that's
  `buildkite-agent-runtime`.
---

# Buildkite Secure Delivery

Secure delivery covers the end-to-end flow of publishing artifacts with zero static credentials and proving supply chain integrity. This skill teaches OIDC-based authentication, Package Registry publishing, SLSA provenance attestation, and pipeline signing with JWKS.

## Quick Start

Build, authenticate via OIDC, and push a Docker image — no static credentials:

```yaml
steps:
  - key: "docker-publish"
    label: ":docker: Build & Push"
    commands:
      - docker build --tag packages.buildkite.com/my-org/my-registry/my-app:latest .
      - buildkite-agent oidc request-token --audience "https://packages.buildkite.com/my-org/my-registry" --lifetime 300 | docker login packages.buildkite.com/my-org/my-registry --username buildkite --password-stdin
      - docker push packages.buildkite.com/my-org/my-registry/my-app:latest
    plugins:
      - generate-provenance-attestation#v1.1.0:
          artifacts: "my-app:latest"
          attestation_name: "docker-attestation.json"
```

This single step authenticates with a short-lived OIDC token (5 minutes), pushes the image, and generates a SLSA provenance attestation. No API keys or registry passwords stored anywhere.

> For `buildkite-agent oidc request-token` flag details, see the **buildkite-agent-runtime** skill.

## OIDC Authentication

Each job calls `buildkite-agent oidc request-token` to get a short-lived JWT (default 5 minutes) from the Buildkite backend. External services validate the JWT against Buildkite's OIDC provider (`https://agent.buildkite.com`) and grant access if claims match the trust policy.

### Token Claims

The `sub` claim encodes the full context: `organization:{org}:pipeline:{slug}:ref:{ref}:commit:{sha}:step:{key}`. Key claims for trust policies: `organization_slug`, `pipeline_slug`, `build_branch`, `step_key`, `runner_environment`.

### OIDC with Buildkite Package Registry

The `--audience` must exactly match the registry URL: `https://packages.buildkite.com/{org-slug}/{registry-slug}`. The username is always `buildkite`. The OIDC token acts as the password. See Quick Start for the full pattern.

### OIDC with Cloud Providers

OIDC tokens work with AWS (via `aws-assume-role-with-web-identity` plugin or `sts:AssumeRoleWithWebIdentity`), GCP (via Workload Identity Federation), and Azure (via federated credentials). Each provider validates the JWT against Buildkite's OIDC issuer and grants access based on claim conditions.

> For cloud provider OIDC setup including IAM trust policies, Workload Identity Pools, and Azure app registration, see `references/oidc-cloud-providers.md`.

### Scoping OIDC Policies

Always restrict trust policies to minimum scope. Scope `sub` to pipeline and branch (`organization:acme-inc:pipeline:deploy-prod:ref:refs/heads/main:*`), never to the entire org (`organization:acme-inc:*`). Use `pipeline_slug` and `build_branch` conditions. For production deployments, require `build_branch: main`.

## Package Registry

Buildkite Package Registry hosts packages across multiple ecosystems with OIDC-native authentication. Registries are scoped to an organization and accessed at `packages.buildkite.com/{org-slug}/{registry-slug}`.

### Supported Ecosystems

| Ecosystem | Auth method |
|-----------|-------------|
| Docker / OCI | `docker login` with OIDC token |
| npm | `.npmrc` with OIDC token |
| Helm (OCI) | `helm registry login` with OIDC token |
| Python, Ruby, Terraform, Debian, Alpine, RPM, Generic | `curl` with Bearer token header |

### Docker / OCI Publishing

The most common pattern -- build, authenticate via OIDC, push. Tag images with `${BUILDKITE_BUILD_NUMBER}` or git SHA for traceability. Avoid `latest` tags in production -- they are not immutable. See Quick Start for the full pipeline step.

> For npm, Helm, Python, Ruby, Terraform, and generic publishing patterns, see `references/package-publishing.md`.

## SLSA Provenance

SLSA provenance records what was built, when, by whom, and from which source. Add `generate-provenance-attestation` to build steps to create signed attestations, then use `publish-to-packages` to upload artifacts with attestations attached.

### Generating Attestations

```yaml
plugins:
  - generate-provenance-attestation#v1.1.0:
      artifacts: "my-library-*.gem"     # Glob pattern matching artifacts to attest
      attestation_name: "build-attestation.json"  # Output attestation filename
```

The attestation captures builder identity, source (repo, branch, commit), build metadata, and material digests (SHA-256).

### Publishing with Attestations

Use `publish-to-packages` with `artifacts` (glob pattern), `registry` (`{org-slug}/{registry-slug}`), and `attestations` (list of attestation files). The `generate-provenance-attestation` plugin satisfies SLSA Build Level 1. For Level 2, combine with Hosted Agents. For Level 3, add pipeline signing.

## Pipeline Signing (JWKS)

Pipeline signing ensures the steps an agent runs are exactly the steps uploaded. Uploading agents sign pipeline definitions with a private JWKS key; executing agents verify signatures with the public key before running jobs.

### Setup

Generate keys with `buildkite-agent tool keygen --alg EdDSA --key-id my-signing-key`. This creates `EdDSA-my-signing-key-private.json` (signing) and `EdDSA-my-signing-key-public.json` (verification). Store the private key securely.

Configure `buildkite-agent.cfg`:
- **Uploading agents**: set `signing-jwks-file` (private key) + `signing-jwks-key-id`
- **Executing agents**: set `verification-jwks-file` (public key)
- **Both roles**: set all three config keys

### Rollout

1. Deploy signing on uploading agents
2. Deploy verification in warn mode (`verification-failure-behavior=warn`)
3. Monitor and fix unsigned pipeline warnings in agent logs
4. Switch to block (remove `verification-failure-behavior=warn` -- default is `block`)

Steps defined in the Buildkite UI are not agent-signed. Sign them manually with `buildkite-agent tool sign --update`. For Kubernetes, mount JWKS keys as secrets and configure `signingJWKSVolume`/`verificationJWKSVolume`.

> For `buildkite-agent.cfg` configuration details, see the **buildkite-agent-infrastructure** skill.

## End-to-End Secure Publish Flow

A complete pipeline combines: (1) **Build & Attest** -- build image, generate provenance with `generate-provenance-attestation`; (2) **Publish** -- authenticate via OIDC, push image, attach attestation via `publish-to-packages` (using `depends_on`); (3) **Deploy** -- authenticate to cloud via OIDC (e.g., `aws-assume-role-with-web-identity`). See Quick Start for the single-step pattern.

> For a non-Docker example (Ruby gem secure publish flow), see `references/package-publishing.md`.

## Security Checklist

- [ ] All authentication uses OIDC tokens -- no static API keys or passwords
- [ ] OIDC `--audience` matches exact target service URL
- [ ] `--lifetime 300` (5 minutes) or less
- [ ] Trust policies scoped to `pipeline_slug` + `build_branch` + `organization_slug`
- [ ] Published artifacts include SLSA attestation
- [ ] Pipeline signing enabled with `verification-failure-behavior=block` in production
- [ ] Dynamically-retrieved secrets added to the log redactor

> For `buildkite-agent redactor add` syntax, see the **buildkite-agent-runtime** skill.
> For `secrets:` pipeline YAML syntax, see the **buildkite-pipelines** skill.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| OIDC `--audience` doesn't match registry URL exactly | Use `https://packages.buildkite.com/{org}/{registry}` with exact slugs |
| Using static API keys instead of OIDC | Replace `docker login -p $API_KEY` with the OIDC pipe pattern |
| `--lifetime` too long (e.g., 3600) | Set `--lifetime 300` (5 minutes) |
| Skipping `warn` phase during signing rollout | Deploy with `verification-failure-behavior=warn` first, then switch to `block` |
| OIDC trust policy too broad (`sub: organization:*`) | Scope to specific `pipeline_slug` and `build_branch` |
| Forgetting to sign Pipeline Settings steps | Run `buildkite-agent tool sign --update` for pipelines with UI steps |
| Unversioned plugins | Pin to exact version (`plugin#v1.2.0`) |

## Additional Resources

### Reference Files
- **`references/oidc-cloud-providers.md`** -- OIDC setup for AWS (IAM trust policies, session tags), GCP (Workload Identity Federation), and Azure (federated credentials)
- **`references/package-publishing.md`** -- Publishing patterns for npm, Helm, Python, Ruby, Terraform, and generic artifacts, plus installing from Package Registry

## Further Reading

- [OIDC with Buildkite Pipelines](https://buildkite.com/docs/pipelines/security/oidc.md) -- OIDC configuration and trust policies
- [SLSA Provenance](https://buildkite.com/docs/package-registries/security/slsa-provenance.md) -- attestation generation and verification
- [Signed Pipelines](https://buildkite.com/docs/agent/v3/signed-pipelines.md) -- JWKS key generation, agent configuration, and rollout
- [Package Registries Overview](https://buildkite.com/docs/package-registries.md) -- supported ecosystems and registry management
- [Buildkite Docs for LLMs](https://buildkite.com/docs/llms.txt)
