# Claude account connectors (experimental)

Optional Hermes tools using the existing Claude ACP subscription runtime, independent of the main model provider. Off in the bare image; the starter overlay (`examples/overlay-repo/`) turns it on when the agent has its own Claude login. Controlled read-only acceptance has demonstrated discovery, empty and nonempty exact arguments, altered/other/repeated-call rejection, and thread-scoped Stop through the Hermes tool registry. This is not blanket production or write qualification; installation acceptance and account-specific policy checks remain required.

- `claude_connector_search(query)` returns actual native `tool_reference` names filtered by existing profile authority. It does not export or invent JSON Schemas.
- `claude_connector_call(tool, arguments)` requests one exact native tool and JSON argument object. Claude Code owns schema validation. The host compares type-sensitive argument values and consumes a single permission budget before selecting the offered `allow_once` option.
- Only correlated terminal native results count. Assistant prose, XML and claims of success do not.
- `no_execution` means no verified operation; `unknown_outcome` means approval was issued but the result cannot be established. `retry: false` prohibits automatic replay. A native terminal error is `failed`.
- Every invocation uses additional ACP model inference. Worker usage and elapsed time are returned separately; they are not DirectSDK usage.

## Runtime and authority

Uses the sibling `model-providers/claude-acp/client.py`, its reviewed executable guard, subscription launcher, own-profile `CLAUDE_CONFIG_DIR`, bounded transport and process cleanup. No caller-selected credential paths, launchers or environment. DirectSDK and ordinary ACP provider behavior are unchanged.

The dedicated worker removes connector autoapprovals from `allowedTools` and supplies `permissions.ask: ["mcp__*"]`, preserving native and profile denies, user settings and disabled hooks/bypass. Ask takes precedence over allow per the Claude permission contract. A host controller rejects non-target, altered, repeated or uncorrelated permission requests and requires Claude.ai server provenance. Profile policy is re-read before an approval; unsupported rule syntax fails closed. Managed vendor denies remain enforced by Claude Code.

These guarantees require qualification on the pinned native runtime. Posthoc result rejection is not proof of before-effect enforcement. Tests use a deterministic wire peer, not a model or external connector service.

## Configuration after qualification

Install beside the Fleet ACP provider. Explicit plugin settings are `enabled: true`, `model` (default `sonnet`; also `haiku`, `opus`, `opus[1m]`) and `timeout` (1–180 seconds, default 90). Registration reads settings through Hermes `ctx.get_config`; it never accepts a callable backend in configuration. The `claude_account_connectors` toolset must be selected for the intended surface. Enabling the plugin does not create connector grants or log in an account.

## Verification

Run the canonical repository unittest suite, including `tests/test_claude_account_connectors.py`, then `python scripts/verify-public-tree.py`. Authenticated read-only acceptance must separately prove real discovery, exact read results, nonempty arguments, altered/repeated/other-connector rejection and cancellation. No send/post is necessary for read qualification; writes require separately authorized acceptance.
