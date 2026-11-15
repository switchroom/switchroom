# Switchroom product reference

Switchroom is the public name of this repository's product. `hermes-fleet` is the working repository name. See [rfcs/switchroom-positioning.md](rfcs/switchroom-positioning.md).

ProductOS shapes copied into this repository. ProductOS is not a dependency to install.

| Doc | Role |
| --- | --- |
| [vision.md](vision.md) | Why the product exists, North Star, horizon |
| [principles.md](principles.md) | Built-well standards. A "no" is a redesign, not a follow-up |
| [invariants.md](invariants.md) | Lines we will not cross by construction |
| [product-spec.md](product-spec.md) | Outcomes, how it functions, job index |
| [jobs/](jobs/) | One Job Spec per job |
| [rfcs/](rfcs/) | Decision records and ship-coupled RFCs |

The operating contract is in [`AGENTS.md`](../AGENTS.md). A change ships only when it advances a named outcome, satisfies its Job Spec, passes every principle check, and crosses no invariant.

Humans own the anchors. Agents consume them.

Method source: [ProductOS](https://github.com/mekenthompson/ProductOS). Filled example: [switchroom/reference](https://github.com/switchroom/switchroom/tree/main/reference).
