"""OpenAI-compatible Claude ACP client with a non-executing MCP tool bridge.

Hermes policy travels as ACP system metadata. Claude sees Hermes tools as actual MCP
tools, but the MCP server does not execute them. The parent launches the trusted MCP
server directly and consumes its private capture stream before Hermes receives a call.
"""
from __future__ import annotations

import contextlib
import asyncio
import base64
import binascii
import concurrent.futures
import hashlib
import json
import contextvars
import os
import queue
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Mapping
from pathlib import Path
from types import SimpleNamespace
from typing import Any

ACP_MARKER_BASE_URL = "acp://claude"
_DEFAULT_TIMEOUT_SECONDS = 900.0
_CANCEL_DRAIN_SECONDS = 2.0
_MAX_FRAME_CHARS = 1024 * 1024
_MAX_SCHEMA_BYTES = 1024 * 1024
_MAX_TOOLS = 128
_MAX_UPDATES = 4096
_MAX_RESPONSE_CHARS = 8 * 1024 * 1024
# Keep the encoded image URL under the same reactive recovery target used by
# core conversation_compression._IMAGE_SHRINK_TARGET_BYTES (4 MiB).
_MAX_IMAGE_URL_CHARS = 4 * 1024 * 1024
_IMAGE_MIME_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
_ASYNC_EXECUTOR = concurrent.futures.ThreadPoolExecutor(
    max_workers=4, thread_name_prefix="claude-acp"
)
_ASYNC_SUBMISSIONS = threading.BoundedSemaphore(4)
_TOOL_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_CONTEXT_HINT_SUFFIX_RE = re.compile(r"-(\d+m)$", re.I)
_ROLE_LABELS = {"user": "User", "assistant": "Assistant", "tool": "Tool", "context": "Context"}
_BRIDGE_PREFIX = "mcp__hermes_bridge__"
_CLAUDE_CODE_EXECUTABLE = "/opt/coding-clis/node_modules/.bin/claude"
_CLAUDE_CODE_PACKAGE = Path("/opt/coding-clis/node_modules/@anthropic-ai/claude-code/package.json")
_CLAUDE_SDK_TOOLS = Path("/opt/coding-clis/node_modules/@anthropic-ai/claude-code/sdk-tools.d.ts")
# Reviewed 2.1.326 (stable channel). Opus 5.5 remains the existing opus / opus[1m] slot.
# The adapter does not offer claude-opus-5-5. Do not add that API id as an alias.
_REVIEWED_CLAUDE_CODE_VERSION = "2.1.326"
_REVIEWED_CLAUDE_EXECUTABLE_SHA256 = "b6b3647d981130dc44fc670846ae97b6cde531ffb667cf9c4d17cfcafb38cb37"
_REVIEWED_SDK_TOOLS_SHA256 = "35fc52c913355aa14b2b94c59129bb34bfe83e1e30920c4e78d3199e86c75b8d"
_DISCOVERY_TOOLS = ("ToolSearch",)
# Claude.ai cloud connectors only hydrate when the full Claude Code preset is
# selected. Deny every native tool in the reviewed, pinned Claude Code release;
# ToolSearch remains available solely to lazily discover profile-authorized
# connectors. The runtime version guard below fails closed before a future
# Claude Code release can add an unreviewed native tool.
_NATIVE_TOOL_DENY = (
    "Agent",
    # Native tools added in 2.1.273 and still absent from the SDK tool-input union.
    "AppifactRepl",
    "FetchInboxMessage",
    "SubagentHandback",
    "Artifact",
    "AskUserQuestion",
    "Bash",
    "ClaudeDesign",
    "CronCreate",
    "CronDelete",
    "CronList",
    "DesignSync",
    "Edit",
    "EnterPlanMode",
    "EnterWorktree",
    "ExitPlanMode",
    "ExitWorktree",
    "FileEdit",
    "FileRead",
    "FileWrite",
    "Glob",
    "Grep",
    "ListAgents",
    "ListMcpResources",
    "Mcp",
    "Monitor",
    "NotebookEdit",
    "Projects",
    "ProposeGoal",
    "ProposeSkills",
    "PushNotification",
    "Read",
    "ReadMcpResource",
    "ReadMcpResourceDir",
    "ReadNotifications",
    "RefreshMcpTools",
    "RemoteTrigger",
    "REPL",
    "ReportFindings",
    "ScheduleWakeup",
    "SendFeedback",
    "SendMessage",
    "ShareOnboardingGuide",
    "ShowOnboardingRolePicker",
    "Skill",
    "Task",
    "TaskCreate",
    "TaskGet",
    "TaskList",
    "TaskOutput",
    "TaskStop",
    "TaskUpdate",
    "TodoWrite",
    "WebFetch",
    "WebSearch",
    "Workflow",
    "Write",
    # Present in the 2.1.296 executable. Denied, not approved.
    "AgentOutput",
    "ArtifactCheck",
    "ArtifactComments",
    "ArtifactData",
    "BashOutput",
    "Design",
    "EndConversation",
    "ExitPlanModeV2",
    "ListConnectors",
    "OfferChromeSetup",
    "PowerShell",
    "PublishPlugin",
    "SearchMcpRegistry",
    "SendFile",
    "SendUserFile",
    "SuggestConnectors",
    "WaitForMcpServers",
    # Present in the 2.1.316 executable. Denied, not approved.
    "SubscribePR",
    "SendToProject",
    "SendToProjectContext",
    # Present in the 2.1.319 executable. Denied, not approved.
    "ReadWidgetContext",
    "WrapUp",
    "CrossSessionMessage",
    # Named constants first present in the 2.1.325 executable (session-host
    # event names, not in the SDK union). Denied defensively, not approved.
    "PlaceHookTranscript",
    "ReadSessionRepo",
    "RunModFs",
    # New native tools in the 2.1.326 executable (session goal tools, not in the SDK
    # union) plus new session-host constants. Denied, not approved.
    "GetGoal",
    "SetGoal",
    "PauseGoal",
    "RunModFsRange",
    "WorkspaceDiffForRemote",
)
_CONNECTOR_PREFIX = "mcp__claude_ai_"
_CONNECTOR_WILDCARD = "mcp__claude_ai_*"
_SETTINGS_MAX_BYTES = 1_048_576


class BridgeCaptureError(RuntimeError):
    """Raised when the trusted MCP bridge capture channel fails."""


def assert_reviewed_claude_code_version(
    package_path: str | os.PathLike[str] = _CLAUDE_CODE_PACKAGE,
    executable: str | os.PathLike[str] = _CLAUDE_CODE_EXECUTABLE,
    sdk_tools_path: str | os.PathLike[str] = _CLAUDE_SDK_TOOLS,
    *,
    executable_sha256: str = _REVIEWED_CLAUDE_EXECUTABLE_SHA256,
    sdk_tools_sha256: str = _REVIEWED_SDK_TOOLS_SHA256,
    timeout: float = 5.0,
) -> str:
    """Fail closed when Claude Code's package or launched executable has drifted."""
    path = Path(package_path)
    try:
        if path.stat().st_size > 64 * 1024:
            raise ValueError("package metadata is too large")
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError("cannot verify the reviewed Claude Code version") from exc
    version = payload.get("version") if isinstance(payload, dict) else None
    if version != _REVIEWED_CLAUDE_CODE_VERSION:
        raise RuntimeError(
            f"Claude Code {version!r} is not the reviewed release "
            f"{_REVIEWED_CLAUDE_CODE_VERSION!r}; review the native tool deny set before upgrading"
        )
    artifacts = (
        (Path(executable), executable_sha256, 512 * 1024 * 1024),
        (Path(sdk_tools_path), sdk_tools_sha256, 4 * 1024 * 1024),
    )
    for artifact, expected_digest, max_bytes in artifacts:
        try:
            if artifact.stat().st_size > max_bytes:
                raise ValueError("reviewed artifact is too large")
            digest = hashlib.sha256()
            with artifact.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
        except (OSError, ValueError) as exc:
            raise RuntimeError("cannot verify a reviewed Claude Code artifact") from exc
        if digest.hexdigest() != expected_digest:
            raise RuntimeError(f"Claude Code artifact hash mismatch: {artifact}")
    expected_banner = f"{_REVIEWED_CLAUDE_CODE_VERSION} (Claude Code)"
    try:
        result = subprocess.run(
            [str(executable), "--version"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=min(5.0, max(0.01, timeout)),
            env=build_subprocess_env(),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("cannot verify the launched Claude Code executable") from exc
    if result.returncode or result.stdout.strip() != expected_banner:
        raise RuntimeError(
            f"launched Claude Code executable is not the reviewed release {expected_banner!r}"
        )
    return version


_BRIDGE_POLICY = (
    "Hermes owns all local side effects. Claude-native filesystem, shell, browser, "
    "delegation, and write tools are unavailable. Hermes-controlled tools are actual "
    "tools supplied by the MCP server named hermes_bridge. Use those tools when needed; "
    "the host application will validate, approve, execute, and audit each request. Do "
    "not emit XML or fabricated OpenAI tool-call markup. Authenticated account connectors "
    "retain their profile policy."
)
_REJECT_KINDS = {"reject_once", "reject_always", "deny", "denied", "reject", "rejected"}


def _content(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return str(value.get("text") or value.get("content") or "")
    if isinstance(value, list):
        parts = [_content(item) for item in value]
        return "\n".join(part for part in parts if part)
    return str(value or "")


def _acp_image_block(value: dict[str, Any]) -> dict[str, str]:
    """Convert an OpenAI image part to a validated ACP image block."""
    image_url = value.get("image_url")
    if isinstance(image_url, dict):
        url = image_url.get("url")
    elif isinstance(image_url, str):
        url = image_url
    else:
        url = value.get("image")
    if not isinstance(url, str) or not url.startswith("data:"):
        raise ValueError("only base64 data:image URLs are supported")
    if len(url) > _MAX_IMAGE_URL_CHARS:
        raise ValueError("image payload exceeds the 4 MiB image limit")
    header, separator, payload = url.partition(",")
    if not separator or not header.startswith("data:image/"):
        raise ValueError("only base64 data:image URLs are supported")
    parameters = header.split(";")
    if len(parameters) != 2 or parameters[1].lower() != "base64":
        raise ValueError("only base64 data:image URLs are supported")
    mime_type = parameters[0][len("data:"):].lower()
    if mime_type not in _IMAGE_MIME_TYPES:
        raise ValueError(f"unsupported image MIME type: {mime_type}")
    try:
        image_bytes = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("malformed base64 image payload") from exc
    if not image_bytes:
        raise ValueError("malformed base64 image payload")
    return {"type": "image", "mimeType": mime_type, "data": payload}


def _acp_content_blocks(value: Any) -> tuple[list[dict[str, str]], bool]:
    """Parse content parts without flattening image payloads into transcript text."""
    if not isinstance(value, list):
        text = _content(value)
        return ([{"type": "text", "text": text}] if text else []), False
    blocks: list[dict[str, str]] = []
    has_images = False
    for item in value:
        if isinstance(item, dict) and item.get("type") in {"image_url", "input_image"}:
            blocks.append(_acp_image_block(item))
            has_images = True
            continue
        if isinstance(item, dict) and str(item.get("type") or "").startswith("image"):
            raise ValueError(f"unsupported image input type: {item.get('type')}")
        text = _content(item)
        if text:
            blocks.append({"type": "text", "text": text})
    return blocks, has_images


def _tool_call_dict(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        call_id = value.get("id")
        call_type = value.get("type") or "function"
        function = value.get("function")
    else:
        call_id = getattr(value, "id", None)
        call_type = getattr(value, "type", "function")
        function = getattr(value, "function", None)
    if isinstance(function, dict):
        name = function.get("name")
        arguments = function.get("arguments")
    else:
        name = getattr(function, "name", None)
        arguments = getattr(function, "arguments", None)
    if not isinstance(call_id, str) or not call_id or not isinstance(name, str) or not name:
        return None
    if not isinstance(arguments, (str, dict)):
        arguments = str(arguments or "")
    return {
        "id": call_id,
        "type": str(call_type or "function"),
        "function": {"name": name, "arguments": arguments},
    }


def split_messages(
    messages: list[dict[str, Any]],
    *,
    tool_choice: Any = None,
) -> tuple[str, list[dict[str, str]]]:
    """Return trusted policy and ordered ACP prompt content blocks."""
    del tool_choice  # Enforcement happens structurally in select_bridge_tools and _create.
    policy: list[str] = []
    transcript: list[str | list[dict[str, str]]] = []
    has_images = False
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "").lower()
        content = message.get("content")
        content_blocks, message_has_images = _acp_content_blocks(content)
        if role in {"system", "developer"}:
            if message_has_images:
                raise ValueError("images are only supported in conversation messages")
            text = _content(content).strip()
            if text:
                policy.append(text)
            continue

        text = _content(content).strip()
        historical: dict[str, Any] = {}
        if text and not message_has_images:
            historical["content"] = text
        if role == "assistant":
            calls = [
                normalized
                for item in message.get("tool_calls") or []
                if (normalized := _tool_call_dict(item)) is not None
            ]
            if calls:
                historical["tool_calls"] = calls
        if role == "tool":
            tool_call_id = message.get("tool_call_id")
            name = message.get("name")
            if isinstance(tool_call_id, str) and tool_call_id:
                historical["tool_call_id"] = tool_call_id
            if isinstance(name, str) and name:
                historical["name"] = name
        if not historical and not message_has_images:
            continue
        if not message_has_images and set(historical) == {"content"}:
            rendered = historical["content"]
            transcript.append(f"{_ROLE_LABELS.get(role, 'Context')}:\n{rendered}")
            continue
        if not message_has_images:
            rendered = json.dumps(historical, ensure_ascii=True, separators=(",", ":"))
            transcript.append(f"{_ROLE_LABELS.get(role, 'Context')}:\n{rendered}")
            continue

        has_images = True
        blocks = [{"type": "text", "text": f"{_ROLE_LABELS.get(role, 'Context')}:\n"}]
        if historical:
            # Content remains in its original text/image order below. Keep only
            # the historical tool envelope here so image blocks are never JSON-flattened.
            blocks.append({
                "type": "text",
                "text": json.dumps(historical, ensure_ascii=True, separators=(",", ":")) + "\n",
            })
        blocks.extend(content_blocks)
        transcript.append(blocks)

    system = "\n\n".join([*policy, _BRIDGE_POLICY])
    if not has_images:
        return system, [{"type": "text", "text": "\n\n".join(
            section for section in transcript if isinstance(section, str)
        )}]
    prompt: list[dict[str, str]] = []
    for section in transcript:
        if prompt:
            prompt.append({"type": "text", "text": "\n\n"})
        if isinstance(section, str):
            prompt.append({"type": "text", "text": section})
        else:
            prompt.extend(section)
    return system, prompt


def build_subprocess_env(source: Mapping[str, str] | None = None) -> dict[str, str]:
    """Return a small runtime allowlist without inherited provider or fleet secrets."""
    source = os.environ if source is None else source
    allowed = (
        "HOME", "PATH", "LANG", "LC_ALL", "TERM", "TMPDIR", "USER", "LOGNAME", "SHELL",
        "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "CLAUDE_CONFIG_DIR",
    )
    environment = {key: source[key] for key in allowed if source.get(key)}
    # ACP otherwise resolves its bundled Agent SDK Claude binary. This image's
    # reviewed standalone CLI must be selected explicitly and cannot be
    # replaced by caller-controlled environment input.
    environment["CLAUDE_CODE_EXECUTABLE"] = _CLAUDE_CODE_EXECUTABLE
    return environment


def canonicalize_model_id(value: str) -> str:
    """Normalize trailing -1m / [1m] spellings the way claude-agent-acp 0.76.0 does."""
    return _CONTEXT_HINT_SUFFIX_RE.sub(
        lambda match: f"[{match.group(1).lower()}]",
        str(value or "").strip().lower(),
    )


def select_offered_model(offered: set[str], requested: str) -> str | None:
    """Return the adapter-offered spelling for requested, or None if unmatched.

    The same login can offer ``opus`` or ``opus[1m]``, and ``claude-fable-5[1m]``
    or ``claude-fable-5-1[1m]``, on different sessions. Those pairs never appear
    together. Prefer the exact offered spelling. If it is absent, accept the
    other spelling of that same pair. Do not map Fable onto Opus or any other
    model.
    """
    requested = str(requested or "").strip()
    if not requested:
        return None
    offered_values = sorted({str(item) for item in offered})
    if requested in offered_values:
        return requested
    canonical = canonicalize_model_id(requested)
    for value in offered_values:
        if canonicalize_model_id(value) == canonical:
            return value
    family = _spelling_family(requested)
    if family is None:
        return None
    matches = [value for value in offered_values if _spelling_family(value) == family]
    if len(matches) == 1:
        return matches[0]
    return None


def _spelling_family(value: str) -> str | None:
    """Return a closed family id for spellings one login has been seen to swap."""
    key = canonicalize_model_id(value)
    if key in {"opus", "opus[1m]"}:
        return "opus"
    if key in {"claude-fable-5[1m]", "claude-fable-5-1[1m]"}:
        return "fable"
    return None


def connector_tool_policy(config_dir: str | None = None) -> tuple[list[str], list[str]]:
    """Return profile allow/deny rules for claude.ai connectors. Never reads secrets."""
    root = config_dir if config_dir is not None else os.environ.get("CLAUDE_CONFIG_DIR")
    if not isinstance(root, str) or not root.strip():
        return [], []
    path = Path(root) / "settings.json"
    try:
        if not path.is_file() or path.stat().st_size > _SETTINGS_MAX_BYTES:
            return [], []
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError):
        return [], []
    permissions = payload.get("permissions") if isinstance(payload, dict) else None
    if not isinstance(permissions, dict):
        return [], []

    def rules_for(key: str, *, keep_wildcard: bool) -> list[str]:
        values = permissions.get(key)
        if not isinstance(values, list):
            return []
        seen: set[str] = set()
        rules: list[str] = []
        for item in values:
            if not isinstance(item, str) or not item.startswith(_CONNECTOR_PREFIX):
                continue
            if (item == _CONNECTOR_WILDCARD and not keep_wildcard) or item in seen:
                continue
            seen.add(item)
            rules.append(item)
        return rules

    return rules_for("allow", keep_wildcard=False), rules_for("deny", keep_wildcard=True)


def connector_allow_tools(config_dir: str | None = None) -> list[str]:
    """Return specific profile allow rules for claude.ai connectors."""
    return connector_tool_policy(config_dir)[0]


def claude_code_session_options(
    advertised_names: set[str],
    config_dir: str | None = None,
) -> dict[str, Any]:
    """Build Claude Code options: no native Bash/Write, connectors keep profile allow."""
    allowed: list[str] = []
    seen: set[str] = set()
    connector_allow, connector_deny = connector_tool_policy(config_dir)
    for name in (
        *[f"{_BRIDGE_PREFIX}{item}" for item in sorted(advertised_names)],
        *_DISCOVERY_TOOLS,
        *connector_allow,
    ):
        if name in seen:
            continue
        seen.add(name)
        allowed.append(name)
    return {
        "tools": {"type": "preset", "preset": "claude_code"},
        "allowedTools": allowed,
        # ACP >=0.77 honors this host opt-out, including inherited bypass mode.
        "allowDangerouslySkipPermissions": False,
        "disallowedTools": [*_NATIVE_TOOL_DENY, *connector_deny],
        "settingSources": ["user"],
        "settings": {"disableAllHooks": True},
    }


def permission_response(params: dict[str, Any]) -> dict[str, Any]:
    """Choose an adapter-offered reject option; otherwise fail closed."""
    for option in params.get("options") or []:
        if not isinstance(option, dict):
            continue
        option_id = str(option.get("optionId") or option.get("id") or "").strip()
        tokens = {
            str(option.get(key) or "").strip().lower()
            for key in ("name", "label", "kind", "optionId", "id")
        }
        if option_id and tokens & _REJECT_KINDS:
            return {"outcome": {"outcome": "selected", "optionId": option_id}}
    return {"outcome": {"outcome": "cancelled"}}


def _timeout(value: Any) -> float:
    """Scalar budgets bound the whole call; HTTP objects use their inference/read budget.

    Connect and pool budgets are not model-generation limits. When read is
    unspecified, an explicit total or write budget wins before the ACP default.
    """
    if isinstance(value, (int, float)):
        return max(0.01, float(value))
    for field in ("read", "timeout", "write"):
        seconds = getattr(value, field, None)
        if isinstance(seconds, (int, float)):
            return max(0.01, float(seconds))
    return _DEFAULT_TIMEOUT_SECONDS


def _mcp_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Validate OpenAI tool definitions before exposing them to the capture MCP."""
    if len(tools) > _MAX_TOOLS:
        raise ValueError(f"tool schema list exceeds {_MAX_TOOLS} entries")
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in tools:
        function = entry.get("function") if isinstance(entry, dict) else None
        if not isinstance(function, dict):
            raise TypeError("tool schema entry must contain a function mapping")
        name = function.get("name")
        parameters = function.get("parameters") or {"type": "object", "properties": {}}
        if not isinstance(name, str) or not _TOOL_NAME_RE.fullmatch(name):
            raise ValueError("tool name must contain 1-64 safe characters")
        if name in seen:
            raise ValueError(f"duplicate tool name: {name}")
        if not isinstance(parameters, dict):
            raise TypeError(f"tool schema for {name} must be a mapping")
        seen.add(name)
        result.append({
            "type": "function",
            "function": {
                "name": name,
                "description": str(function.get("description") or "Hermes tool")[:4096],
                "parameters": parameters,
            },
        })
    encoded = json.dumps(result, ensure_ascii=True, separators=(",", ":")).encode("utf-8")
    if len(encoded) > _MAX_SCHEMA_BYTES:
        raise ValueError("tool schema payload is too large")
    return result


def select_bridge_tools(
    tools: list[dict[str, Any]], tool_choice: Any
) -> tuple[list[dict[str, Any]], str | None]:
    """Return structurally exposed tools and the required name (`*` means any)."""
    validated = _mcp_tools(tools)
    if tool_choice in (None, "auto"):
        return validated, None
    if tool_choice == "none":
        return [], None
    if tool_choice == "required":
        if not validated:
            raise ValueError("tool_choice required but no tools were advertised")
        return validated, "*"
    if isinstance(tool_choice, dict):
        function = tool_choice.get("function")
        name = function.get("name") if isinstance(function, dict) else None
        if not isinstance(name, str) or not _TOOL_NAME_RE.fullmatch(name):
            raise ValueError("named tool_choice is invalid")
        selected = [entry for entry in validated if entry["function"]["name"] == name]
        if not selected:
            raise ValueError(f"named tool_choice '{name}' was not advertised")
        return selected, name
    raise ValueError(f"unsupported tool_choice: {tool_choice!r}")


def openai_tool_call(tool_call_id: str, name: str, arguments: dict[str, Any]) -> SimpleNamespace:
    return SimpleNamespace(
        id=tool_call_id,
        type="function",
        function=SimpleNamespace(
            name=name,
            arguments=json.dumps(arguments, ensure_ascii=True, separators=(",", ":")),
        ),
    )


class StreamChunks:
    """Iterator/context-manager shape accepted by Hermes streaming wrappers."""

    def __init__(self, chunks: list[Any]):
        self._chunks = chunks

    def __iter__(self):
        return iter(self._chunks)

    def __enter__(self):
        return self

    def __exit__(self, *_: object) -> bool:
        return False


def completion_to_stream_chunks(completion: Any) -> StreamChunks:
    """Return an OpenAI-shaped pseudo-stream, including indexed tool-call deltas."""
    choice = completion.choices[0]
    message = choice.message
    tool_call_deltas = None
    if message.tool_calls:
        tool_call_deltas = [
            SimpleNamespace(
                index=index,
                id=call.id,
                type="function",
                function=SimpleNamespace(
                    name=call.function.name,
                    arguments=call.function.arguments,
                ),
            )
            for index, call in enumerate(message.tool_calls)
        ]
    delta = SimpleNamespace(
        role="assistant",
        content=message.content or None,
        tool_calls=tool_call_deltas,
        reasoning=getattr(message, "reasoning", None),
        reasoning_content=getattr(message, "reasoning_content", None),
    )
    model = getattr(completion, "model", "claude-acp")
    data = SimpleNamespace(
        choices=[SimpleNamespace(index=0, delta=delta, finish_reason=choice.finish_reason)],
        model=model,
        usage=None,
    )
    usage = SimpleNamespace(choices=[], model=model, usage=completion.usage)
    return StreamChunks([data, usage])


class LiveStream:
    """Bounded producer stream; closing an abandoned stream cancels its owned call."""

    def __init__(self, complete, cancel, model, deadline):
        self._queue = queue.Queue(maxsize=64)
        self._stopped = threading.Event()
        self._cancel = cancel
        self._finished = threading.Event()
        self._completion = concurrent.futures.Future()
        self._error = None

        def put(value):
            while not self._stopped.is_set():
                if time.monotonic() >= deadline:
                    raise TimeoutError("ACP stream consumer exceeded request deadline")
                try:
                    self._queue.put(value, timeout=0.05)
                    return
                except queue.Full:
                    continue
            raise RuntimeError("ACP stream closed")

        emitted = [0, 0]

        def publish(text, reasoning):
            emitted[int(reasoning)] += len(text)
            delta = SimpleNamespace(role="assistant", content=None if reasoning else text,
                reasoning=text if reasoning else None, reasoning_content=text if reasoning else None,
                tool_calls=None)
            put(SimpleNamespace(choices=[SimpleNamespace(index=0, delta=delta, finish_reason=None)],
                model=model, usage=None))

        def run():
            try:
                completion = complete(publish)
                message = completion.choices[0].message
                message.content = (message.content or "")[emitted[0]:] or None
                message.reasoning = (message.reasoning or "")[emitted[1]:] or None
                message.reasoning_content = message.reasoning
                for chunk in completion_to_stream_chunks(completion):
                    put(chunk)
            except BaseException as exc:
                if not self._stopped.is_set():
                    self._error = exc
            finally:
                self._finished.set()
                self._completion.set_result(None)

        context = contextvars.copy_context()
        self._worker = threading.Thread(target=context.run, args=(run,), daemon=True)
        self._worker.start()

    def __iter__(self):
        return self

    def __aiter__(self):
        return self

    def __next__(self):
        while not self._stopped.is_set():
            try:
                item = self._queue.get(timeout=0.05)
            except queue.Empty:
                if self._finished.is_set():
                    # A final put can race the timed get returning Empty. Once
                    # finished is set the producer cannot append again.
                    if not self._queue.empty():
                        continue
                    if self._error is not None:
                        error, self._error = self._error, None
                        raise error
                    raise StopIteration
                continue
            if isinstance(item, BaseException):
                raise item
            return item
        raise StopIteration

    async def __anext__(self):
        try:
            while not self._stopped.is_set():
                try:
                    item = self._queue.get_nowait()
                except queue.Empty:
                    if self._finished.is_set():
                        if not self._queue.empty():
                            continue
                        if self._error is not None:
                            error, self._error = self._error, None
                            raise error
                        raise StopAsyncIteration
                    await asyncio.sleep(0.01)
                    continue
                if isinstance(item, BaseException):
                    raise item
                return item
            raise StopAsyncIteration
        except asyncio.CancelledError:
            try:
                await self.aclose()
            except BaseException:
                pass
            raise

    async def aclose(self):
        """Cancel and reap an abandoned async stream without blocking its event loop."""
        await asyncio.to_thread(self.close)

    def close(self):
        self._stopped.set()
        if not self._finished.is_set():
            self._cancel()
        self._worker.join(timeout=3)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
        return False


def _usage_value(usage: Mapping[str, Any], *names: str) -> int:
    for name in names:
        value = usage.get(name)
        if isinstance(value, (int, float)) and value >= 0:
            return int(value)
    return 0


def _completion_usage(prompt_result: Mapping[str, Any]) -> SimpleNamespace | None:
    usage: Any = prompt_result.get("usage")
    if not isinstance(usage, dict):
        meta = prompt_result.get("_meta")
        usage = meta.get("usage") if isinstance(meta, dict) else None
    if not isinstance(usage, dict):
        return None
    known = {
        "inputTokens", "input_tokens", "promptTokens", "prompt_tokens",
        "outputTokens", "output_tokens", "completionTokens", "completion_tokens",
        "totalTokens", "total_tokens", "cachedTokens", "cached_tokens",
        "cacheReadInputTokens",
    }
    if not known.intersection(usage):
        return None
    prompt_tokens = _usage_value(usage, "inputTokens", "input_tokens", "promptTokens", "prompt_tokens")
    completion_tokens = _usage_value(usage, "outputTokens", "output_tokens", "completionTokens", "completion_tokens")
    total_tokens = _usage_value(usage, "totalTokens", "total_tokens") or prompt_tokens + completion_tokens
    cached_tokens = _usage_value(usage, "cachedTokens", "cached_tokens", "cacheReadInputTokens")
    return SimpleNamespace(
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=total_tokens,
        prompt_tokens_details=SimpleNamespace(cached_tokens=cached_tokens),
    )


def _finish_reason(prompt_result: Mapping[str, Any], has_tool_calls: bool) -> str:
    if has_tool_calls:
        return "tool_calls"
    reason = str(prompt_result.get("stopReason") or prompt_result.get("stop_reason") or "end_turn").lower()
    if reason in {"max_tokens", "max_output_tokens", "length"}:
        return "length"
    if reason in {"refusal", "content_filter", "safety"}:
        return "content_filter"
    return "stop"


class ClaudeACPClient:
    # Hermes leaves this profile-local transport alone; _create() adapts itself
    # to the caller's sync or async context without core changes.
    HERMES_SKIP_TRANSPORT_WRAP = True
    HERMES_SKIP_ASYNC_WRAP = True

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        default_headers: dict[str, str] | None = None,
        acp_command: str | None = None,
        acp_args: list[str] | tuple[str, ...] | None = None,
        acp_cwd: str | None = None,
        command: str | None = None,
        args: list[str] | tuple[str, ...] | None = None,
        **_: Any,
    ):
        self.api_key = api_key or "claude-acp"
        self.base_url = base_url or ACP_MARKER_BASE_URL
        self.default_headers = dict(default_headers or {})
        self._command = acp_command or command or "claude-agent-acp"
        self._acp_args = list(acp_args if acp_args is not None else args if args is not None else ())
        self._args = self._acp_args
        self._cwd = str(Path(acp_cwd or os.getcwd()).resolve())
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))
        self._process: subprocess.Popen[str] | None = None
        self._active_session_id = ""
        self._lock = threading.RLock()
        self._io_lock = threading.Lock()
        self._request_lock = threading.Lock()
        self.is_closed = False
        self._cancelled = threading.Event()
        self._deadline = float("inf")

    def _send(self, proc: subprocess.Popen[str], message: dict[str, Any]) -> None:
        cancelled = self._cancelled
        # A blocked TextIOWrapper write must never hold the cancellation path.
        # Killing the owned process group releases the writer on every error path.
        deadline = time.monotonic() + 0.1 if message.get("method") == "session/cancel" else self._deadline
        done = threading.Event()
        errors: list[BaseException] = []

        def write() -> None:
            try:
                with self._io_lock:
                    if proc.stdin is None:
                        raise RuntimeError("Claude ACP stdin is unavailable")
                    proc.stdin.write(json.dumps(message, ensure_ascii=True, separators=(",", ":")) + "\n")
                    proc.stdin.flush()
            except BaseException as exc:
                errors.append(exc)
            finally:
                if cancelled.is_set() and proc.stdin:
                    with contextlib.suppress(Exception):
                        proc.stdin.close()
                done.set()

        if cancelled.is_set() or time.monotonic() >= deadline:
            raise TimeoutError("Claude ACP request cancelled or deadline exceeded")
        threading.Thread(target=write, daemon=True).start()
        while not done.wait(min(0.01, max(0, deadline - time.monotonic()))):
            if cancelled.is_set() or time.monotonic() >= deadline:
                raise TimeoutError("Claude ACP write cancelled or deadline exceeded")
        if errors:
            raise errors[0]

    def _notify_cancel(self, proc: subprocess.Popen[str], session_id: str) -> None:
        self._send(proc, {
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": {"sessionId": session_id},
        })

    def hermes_abort_request(self) -> None:
        """Thread-safe process cancellation for the core request lifecycle."""
        self.close()

    def close(self) -> None:
        with self._lock:
            self._cancelled.set()
            proc, self._process = self._process, None
            session_id, self._active_session_id = self._active_session_id, ""
            self.is_closed = True
        if proc is None:
            return
        leader_running = proc.poll() is None
        # The ACP process starts a new session and may leave descendants behind
        # after its leader exits. Signal the process group regardless of the
        # leader's state, then escalate so cleanup remains bounded.
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, signal.SIGTERM)
        if leader_running:
            with contextlib.suppress(Exception):
                proc.wait(timeout=2)
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, signal.SIGKILL)
        if proc.poll() is None:
            with contextlib.suppress(Exception):
                proc.wait(timeout=1)
        # Reader threads close their own wrappers. Never acquire a live reader's
        # TextIO lock here: even an inherited pipe must not block cancellation.
        if self._io_lock.acquire(blocking=False):
            try:
                if proc.stdin:
                    with contextlib.suppress(Exception):
                        proc.stdin.close()
            finally:
                self._io_lock.release()

    def _spawn(self) -> subprocess.Popen[str]:
        if self._cancelled.is_set():
            raise RuntimeError("Claude ACP request cancelled")
        proc = subprocess.Popen(
            [self._command, *self._acp_args],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            cwd=self._cwd,
            env=build_subprocess_env(),
            start_new_session=True,
        )
        if proc.stdin is None or proc.stdout is None:
            proc.kill()
            raise RuntimeError("Claude ACP process did not expose stdin/stdout pipes")
        with self._lock:
            self._process = proc
            cancelled = self._cancelled.is_set()
            self.is_closed = False
        if cancelled:
            self.close()
            raise RuntimeError("Claude ACP request cancelled")
        return proc

    def _create(
        self,
        *,
        model: str | None = None,
        messages: list[dict[str, Any]] | None = None,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: Any = None,
        timeout: Any = None,
        stream: bool = False,
        **_: Any,
    ) -> Any:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return self._create_sync(
                model=model, messages=messages, tools=tools, tool_choice=tool_choice,
                timeout=timeout, stream=stream,
            )
        return self._create_async(
            model=model, messages=messages, tools=tools, tool_choice=tool_choice,
            timeout=timeout, stream=stream,
        )

    async def _create_async(
        self,
        *,
        model: str | None = None,
        messages: list[dict[str, Any]] | None = None,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: Any = None,
        timeout: Any = None,
        stream: bool = False,
    ) -> Any:
        """Run the sync ACP transport on a bounded worker, preserving cancel ownership."""
        cancelled = threading.Event()
        context = contextvars.copy_context()
        deadline = time.monotonic() + _timeout(timeout)
        while not _ASYNC_SUBMISSIONS.acquire(blocking=False):
            if time.monotonic() >= deadline:
                raise TimeoutError("Claude ACP request deadline expired during admission")
            await asyncio.sleep(0.01)
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Claude ACP request deadline expired during admission")
            worker = _ASYNC_EXECUTOR.submit(
                context.run, self._create_sync,
                model=model, messages=messages, tools=tools, tool_choice=tool_choice,
                timeout=remaining, stream=stream, _cancel_event=cancelled,
            )
        except BaseException:
            _ASYNC_SUBMISSIONS.release()
            raise
        def release_admission(completed):
            try:
                value = completed.result()
            except BaseException:
                _ASYNC_SUBMISSIONS.release()
            else:
                if isinstance(value, LiveStream):
                    # Returning a stream transfers slot ownership to its producer;
                    # every producer exit (success/error/close/deadline) releases it.
                    value._completion.add_done_callback(lambda _: _ASYNC_SUBMISSIONS.release())
                else:
                    _ASYNC_SUBMISSIONS.release()

        worker.add_done_callback(release_admission)
        result = asyncio.wrap_future(worker)
        try:
            return await result
        except asyncio.CancelledError:
            cancelled.set()
            if worker.cancel():
                raise
            # The wrapper awaited above is cancelled with this task. Re-wrap
            # the still-running concurrent future so cleanup is observed without
            # giving the queued request permission to close another call.
            result = asyncio.wrap_future(worker)
            try:
                completed = await result
            except BaseException:
                pass
            else:
                if isinstance(completed, LiveStream):
                    await completed.aclose()
            raise

    def _create_sync(
        self,
        *,
        model: str | None = None,
        messages: list[dict[str, Any]] | None = None,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: Any = None,
        timeout: Any = None,
        stream: bool = False,
        _cancel_event: threading.Event | None = None,
    ) -> Any:
        bridge_tools, requirement = select_bridge_tools(tools or [], tool_choice)
        messages = messages or []
        prepared = split_messages(messages)
        cancelled = _cancel_event or threading.Event()
        deadline = time.monotonic() + _timeout(timeout)
        while True:
            if cancelled.is_set():
                raise RuntimeError("Claude ACP request cancelled while waiting for an active request")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Claude ACP request deadline exceeded waiting for active request")
            if self._request_lock.acquire(timeout=min(0.05, remaining)):
                break
        with self._lock:
            if cancelled.is_set():
                self._request_lock.release()
                raise RuntimeError("Claude ACP request cancelled while waiting for an active request")
            self._cancelled = cancelled
            self._deadline = deadline

        def cancel():
            with self._lock:
                if self._cancelled is cancelled:
                    self.close()

        def complete(publish=None):
            try:
                return self._complete(model, messages, bridge_tools, requirement, publish, prepared)
            finally:
                self._request_lock.release()

        if stream:
            return LiveStream(complete, cancel, model or "claude-acp", self._deadline)
        return complete()

    def _complete(self, model, messages, bridge_tools, requirement, publish, prepared=None):
        text, reasoning, tool_calls, prompt_result = self._run(
            messages or [], bridge_tools, requirement, model,
            max(0, self._deadline - time.monotonic()), publish, prepared,
        )
        if requirement and not tool_calls:
            label = "a tool" if requirement == "*" else f"tool '{requirement}'"
            raise RuntimeError(f"tool_choice required {label}, but Claude ACP returned no Hermes tool call")
        if requirement not in (None, "*") and any(
            call.function.name != requirement for call in tool_calls
        ):
            raise RuntimeError(f"Claude ACP returned a tool other than required tool '{requirement}'")
        message = SimpleNamespace(
            content=text if publish else text.strip(),
            tool_calls=tool_calls or None,
            reasoning=(reasoning if publish else reasoning.strip()) or None,
            reasoning_content=(reasoning if publish else reasoning.strip()) or None,
            reasoning_details=None,
        )
        completion = SimpleNamespace(
            choices=[SimpleNamespace(
                message=message,
                finish_reason=_finish_reason(prompt_result, bool(tool_calls)),
            )],
            model=model or "claude-acp",
            usage=_completion_usage(prompt_result),
            acp_stop_reason=prompt_result.get("stopReason") or prompt_result.get("stop_reason"),
        )
        return completion

    def _session_options(self, advertised_names: set[str]) -> dict[str, Any]:
        """Build session settings; trusted subclasses may narrowly restrict them."""
        return claude_code_session_options(advertised_names)

    def _new_native_controller(self):
        """Return a trusted internal native-tool controller, if configured."""
        return None

    def _run(
        self,
        messages: list[dict[str, Any]],
        bridge_tools: list[dict[str, Any]],
        requirement: str | None,
        model: str | None,
        timeout: float,
        publish=None,
        prepared: tuple[str, list[dict[str, str]]] | None = None,
    ) -> tuple[str, str, list[SimpleNamespace], dict[str, Any]]:
        del requirement  # The completion owns the shared absolute deadline.
        controller = self._new_native_controller()
        assert_reviewed_claude_code_version(timeout=max(0.01, self._deadline - time.monotonic()))
        schema_path = ""
        bridge_dir = ""
        bridge_socket = ""
        proc: subprocess.Popen[str] | None = None
        bridge_proc: subprocess.Popen[str] | None = None
        if bridge_tools:
            try:
                encoded = json.dumps(bridge_tools, ensure_ascii=True, separators=(",", ":"))
                if len(encoded.encode("utf-8")) > _MAX_SCHEMA_BYTES:
                    raise ValueError("tool schema payload is too large")
                with tempfile.NamedTemporaryFile(
                    mode="w", encoding="utf-8", prefix="hermes-claude-tools-", suffix=".json", delete=False
                ) as schema_file:
                    schema_file.write(encoded)
                    schema_path = schema_file.name
                os.chmod(schema_path, 0o600)
                bridge_dir = tempfile.mkdtemp(prefix="hermes-claude-bridge-")
                os.chmod(bridge_dir, 0o700)
                bridge_socket = str(Path(bridge_dir) / "mcp.sock")
            except Exception:
                if schema_path:
                    with contextlib.suppress(OSError):
                        os.unlink(schema_path)
                if bridge_dir:
                    with contextlib.suppress(OSError):
                        os.rmdir(bridge_dir)
                raise

        stopped = threading.Event()
        pumps = []

        def enqueue(sink, value):
            while not stopped.is_set() and not self._cancelled.is_set():
                try:
                    sink.put(value, timeout=0.05)
                    return True
                except queue.Full:
                    continue
            return False

        def start_pump(target, pipe):
            def run():
                try:
                    target()
                finally:
                    if pipe:
                        pipe.close()
            thread = threading.Thread(target=run, daemon=True, name="claude-acp-pump")
            pumps.append(thread)
            thread.start()

        inbox: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=256)
        session_id = ""
        prompt_active = False
        cancel_sent = False
        output: list[str] = []
        reasoning: list[str] = []
        captured_calls: list[SimpleNamespace] = []
        pending_bridge_calls: dict[str, tuple[str, dict[str, Any]]] = {}
        completed_call_ids: set[str] = set()
        bridge_captures: queue.Queue[dict[str, Any] | str] = queue.Queue(maxsize=_MAX_TOOLS + 1)
        updates_seen = 0
        response_chars = 0
        request_ids = iter(range(1, 1 << 30))
        advertised_names = {entry["function"]["name"] for entry in bridge_tools}

        def bridge_capture_matches(name: str, arguments: dict[str, Any]) -> bool:
            try:
                record = bridge_captures.get(timeout=max(0, min(1, self._deadline - time.monotonic())))
            except queue.Empty:
                return False
            if isinstance(record, str):
                raise BridgeCaptureError(record)
            return record.get("name") == name and record.get("arguments") == arguments

        try:
            if bridge_tools:
                bridge_proc = subprocess.Popen(
                    [
                        sys.executable,
                        str(Path(__file__).with_name("tool_bridge_mcp.py")),
                        "--server",
                        schema_path,
                        bridge_socket,
                    ],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    env=build_subprocess_env(),
                    start_new_session=True,
                )

                def bridge_capture_pump() -> None:
                    assert bridge_proc is not None
                    if bridge_proc.stdout is None:
                        return
                    while True:
                        line = bridge_proc.stdout.readline(_MAX_FRAME_CHARS + 1)
                        if not line:
                            return
                        if len(line) > _MAX_FRAME_CHARS:
                            enqueue(bridge_captures, "Hermes bridge capture frame is too large")
                            return
                        try:
                            record = json.loads(line)
                        except json.JSONDecodeError:
                            enqueue(bridge_captures, "Hermes bridge emitted malformed capture JSON")
                            return
                        if not isinstance(record, dict):
                            enqueue(bridge_captures, "Hermes bridge emitted a non-object capture")
                            return
                        if not enqueue(bridge_captures, record):
                            return

                start_pump(bridge_capture_pump, bridge_proc.stdout)
                def bridge_stderr_pump() -> None:
                    assert bridge_proc is not None
                    if bridge_proc.stderr is not None:
                        bridge_proc.stderr.read(_MAX_FRAME_CHARS)

                start_pump(bridge_stderr_pump, bridge_proc.stderr)
                bridge_deadline = min(self._deadline, time.monotonic() + 2)
                while not Path(bridge_socket).exists():
                    if bridge_proc.poll() is not None:
                        raise RuntimeError(f"Hermes bridge exited early with code {bridge_proc.returncode}")
                    if self._cancelled.is_set() or time.monotonic() >= bridge_deadline:
                        raise TimeoutError("Timed out waiting for Hermes bridge socket")
                    time.sleep(0.01)
            proc = self._spawn()

            def stdout_pump() -> None:
                assert proc is not None
                while True:
                    line = proc.stdout.readline(_MAX_FRAME_CHARS + 1) if proc.stdout else ""
                    if not line:
                        if not stopped.is_set() and not self._cancelled.is_set():
                            enqueue(inbox, {"_hermes_error": "Claude ACP closed its output stream"})
                        return
                    if len(line) > _MAX_FRAME_CHARS:
                        enqueue(inbox, {"_hermes_error": "Claude ACP response frame is too large"})
                        return
                    try:
                        value = json.loads(line)
                    except json.JSONDecodeError:
                        enqueue(inbox, {"_hermes_error": "Claude ACP emitted malformed JSON"})
                        return
                    if not isinstance(value, dict):
                        enqueue(inbox, {"_hermes_error": "Claude ACP emitted a non-object frame"})
                        return
                    if not enqueue(inbox, value):
                        return

            def stderr_pump() -> None:
                assert proc is not None
                if proc.stderr is None:
                    return
                while proc.stderr.readline(_MAX_FRAME_CHARS + 1):
                    pass

            start_pump(stdout_pump, proc.stdout)
            start_pump(stderr_pump, proc.stderr)

            def cancel_prompt() -> None:
                nonlocal cancel_sent
                assert proc is not None
                if session_id and not cancel_sent and proc.poll() is None:
                    self._notify_cancel(proc, session_id)
                    cancel_sent = True

            def request(method: str, params: dict[str, Any]) -> dict[str, Any]:
                nonlocal updates_seen, response_chars
                assert proc is not None
                request_id = next(request_ids)
                self._send(proc, {
                    "jsonrpc": "2.0", "id": request_id, "method": method, "params": params,
                })
                deadline = self._deadline
                captured_drain = False
                while True:
                    now = time.monotonic()
                    if self._cancelled.is_set():
                        raise RuntimeError("Claude ACP request cancelled")
                    if now >= deadline:
                        if captured_calls and captured_drain and now < self._deadline:
                            return {"stopReason": "cancelled"}
                        raise TimeoutError(f"Timed out waiting for Claude ACP response to {method}")
                    try:
                        message = inbox.get(timeout=min(0.05, max(0.001, deadline - now)))
                    except queue.Empty:
                        if proc.poll() is not None:
                            if method == "session/prompt" and captured_calls:
                                return {"stopReason": "cancelled"}
                            raise RuntimeError(f"Claude ACP exited early with code {proc.returncode}")
                        continue
                    internal_error = message.get("_hermes_error")
                    if internal_error:
                        raise RuntimeError(str(internal_error))

                    server_method = message.get("method")
                    if server_method == "session/request_permission":
                        raw_params = message.get("params")
                        permission_params = raw_params if isinstance(raw_params, dict) else {}
                        if permission_params.get("sessionId") != session_id:
                            raise RuntimeError("Claude ACP permission request does not match the active session")
                        if method != "session/prompt" or not prompt_active:
                            raise RuntimeError("Claude ACP permission request outside an active prompt")
                        response = permission_response(permission_params)
                        tool = permission_params.get("toolCall")
                        meta = tool.get("_meta") if isinstance(tool, dict) else None
                        claude_meta = meta.get("claudeCode") if isinstance(meta, dict) else None
                        tool_name = claude_meta.get("toolName") if isinstance(claude_meta, dict) else None
                        if controller is not None and isinstance(tool_name, str) and tool_name.startswith(_CONNECTOR_PREFIX):
                            try:
                                decision = controller.on_permission(session_id, json.loads(json.dumps(permission_params)))
                                options = permission_params.get("options")
                                matches = [option for option in options if isinstance(option, dict)] if isinstance(options, list) else []
                                selected = next((option for option in matches if (option.get("optionId") or option.get("id")) == decision.get("optionId") and option.get("kind") == decision.get("kind") and option.get("kind") in {"allow_once", "reject_once"}), None) if isinstance(decision, dict) else None
                                if selected is None:
                                    raise RuntimeError("Claude ACP controller selected an unoffered or unsafe permission option")
                                response = {"outcome": {"outcome": "selected", "optionId": selected.get("optionId") or selected.get("id")}}
                            except Exception:
                                with contextlib.suppress(Exception):
                                    self._send(proc, {"jsonrpc": "2.0", "id": message.get("id"), "result": {"outcome": {"outcome": "cancelled"}}})
                                raise
                        self._send(proc, {
                            "jsonrpc": "2.0",
                            "id": message.get("id"),
                            "result": response,
                        })
                        continue
                    if server_method and message.get("id") is not None and server_method != "session/update":
                        self._send(proc, {
                            "jsonrpc": "2.0",
                            "id": message.get("id"),
                            "error": {"code": -32601, "message": "Unsupported ACP client method"},
                        })
                        continue

                    if server_method == "session/update":
                        updates_seen += 1
                        if updates_seen > _MAX_UPDATES:
                            raise RuntimeError("Claude ACP emitted too many session updates")
                        raw_params = message.get("params")
                        if not isinstance(raw_params, dict):
                            raise RuntimeError("Claude ACP session update params must be an object")
                        if raw_params.get("sessionId") != session_id:
                            raise RuntimeError("Claude ACP session update does not match the active session")
                        update = raw_params.get("update")
                        if not isinstance(update, dict):
                            raise RuntimeError("Claude ACP session update must be an object")
                        update_type = update.get("sessionUpdate")
                        if update_type in {"tool_call", "tool_call_update"} and method != "session/prompt":
                            raise RuntimeError("Claude ACP emitted a tool event outside an active prompt")
                        if update_type in {"tool_call", "tool_call_update"} and controller is not None:
                            tool_call_id = update.get("toolCallId")
                            meta = update.get("_meta")
                            claude_meta = meta.get("claudeCode") if isinstance(meta, dict) else None
                            native_name = claude_meta.get("toolName") if isinstance(claude_meta, dict) else None
                            if not isinstance(tool_call_id, str) or not tool_call_id.strip():
                                raise RuntimeError("Claude ACP native tool event has no valid toolCallId")
                            if not isinstance(native_name, str) or not native_name.strip():
                                raise RuntimeError("Claude ACP native tool event has no valid tool name")
                            if "rawInput" in update and not isinstance(update["rawInput"], dict):
                                raise RuntimeError("Claude ACP native tool event rawInput must be an object")
                            event_size = len(json.dumps(update, ensure_ascii=True, separators=(",", ":")).encode("utf-8"))
                            response_chars += event_size
                            if response_chars > _MAX_RESPONSE_CHARS:
                                raise RuntimeError("Claude ACP response exceeded the size limit")
                            controller_update = json.loads(json.dumps(update))
                            try:
                                controller.on_tool_event(session_id, controller_update)
                            except Exception:
                                raise RuntimeError("Claude ACP native tool event controller failed") from None
                        if update_type == "agent_message_chunk":
                            chunk = _content(update.get("content"))
                            response_chars += len(chunk)
                            if response_chars > _MAX_RESPONSE_CHARS:
                                raise RuntimeError("Claude ACP response exceeded the size limit")
                            output.append(chunk)
                            if publish:
                                publish(chunk, False)
                        elif update_type == "agent_thought_chunk":
                            chunk = _content(update.get("content"))
                            response_chars += len(chunk)
                            if response_chars > _MAX_RESPONSE_CHARS:
                                raise RuntimeError("Claude ACP response exceeded the size limit")
                            reasoning.append(chunk)
                            if publish:
                                publish(chunk, True)
                        elif update_type in {"tool_call", "tool_call_update"}:
                            meta = update.get("_meta")
                            claude_meta = meta.get("claudeCode") if isinstance(meta, dict) else None
                            tool_name = claude_meta.get("toolName") if isinstance(claude_meta, dict) else None
                            if isinstance(tool_name, str) and tool_name.startswith(_BRIDGE_PREFIX):
                                name = tool_name[len(_BRIDGE_PREFIX):]
                                tool_call_id = update.get("toolCallId")
                                if not isinstance(tool_call_id, str) or not tool_call_id:
                                    raise RuntimeError("Hermes bridge tool event has no valid toolCallId")
                                if tool_call_id in completed_call_ids:
                                    raise RuntimeError(f"Duplicate Hermes bridge toolCallId: {tool_call_id}")
                                if name not in advertised_names:
                                    raise RuntimeError(f"Unadvertised Hermes bridge tool event: {name}")
                                if update_type == "tool_call":
                                    if tool_call_id in pending_bridge_calls:
                                        raise RuntimeError(f"Duplicate Hermes bridge toolCallId: {tool_call_id}")
                                    arguments = update.get("rawInput")
                                    if not isinstance(arguments, dict):
                                        raise RuntimeError("Hermes bridge tool arguments must be an object")
                                    pending_bridge_calls[tool_call_id] = (name, arguments)
                                else:
                                    pending = pending_bridge_calls.get(tool_call_id)
                                    if pending is None:
                                        raise RuntimeError("Hermes bridge update has no initial tool_call")
                                    if pending[0] != name:
                                        raise RuntimeError("Hermes bridge tool name changed during the call")
                                    if "rawInput" in update:
                                        arguments = update.get("rawInput")
                                        if not isinstance(arguments, dict):
                                            raise RuntimeError("Hermes bridge tool arguments must be an object")
                                        pending_bridge_calls[tool_call_id] = (name, arguments)
                                if update.get("status") == "completed":
                                    pending = pending_bridge_calls.pop(tool_call_id, None)
                                    if pending is None:
                                        raise RuntimeError("Completed Hermes bridge event has no captured input")
                                    completed_name, completed_arguments = pending
                                    if completed_name != name or not bridge_capture_matches(name, completed_arguments):
                                        raise RuntimeError("ACP tool event was not proven by the Hermes bridge capture")
                                    completed_call_ids.add(tool_call_id)
                                    if len(captured_calls) >= _MAX_TOOLS:
                                        raise RuntimeError("Claude ACP emitted too many tool calls")
                                    captured_calls.append(openai_tool_call(
                                        tool_call_id, completed_name, completed_arguments
                                    ))
                                    cancel_prompt()
                                    captured_drain = True
                                    deadline = min(deadline, time.monotonic() + _CANCEL_DRAIN_SECONDS)
                        continue

                    if message.get("id") != request_id:
                        continue
                    if "error" in message:
                        raise RuntimeError(f"Claude ACP {method} failed")
                    if "result" not in message:
                        raise RuntimeError(f"Claude ACP {method} returned no result")
                    result = message.get("result")
                    if not isinstance(result, dict):
                        raise TypeError(f"Claude ACP {method} returned a non-object result")
                    return result

            initialize_result = request("initialize", {
                "protocolVersion": 1,
                "clientCapabilities": {},
                "clientInfo": {"name": "hermes-agent", "title": "Hermes Agent", "version": "0.0.0"},
            })
            system, prompt = prepared if prepared is not None else split_messages(messages)
            if any(block.get("type") == "image" for block in prompt):
                capabilities = initialize_result.get("agentCapabilities")
                prompt_capabilities = capabilities.get("promptCapabilities") if isinstance(capabilities, dict) else None
                if not isinstance(prompt_capabilities, dict) or prompt_capabilities.get("image") is not True:
                    raise RuntimeError("Claude ACP adapter does not advertise image prompt support")
            bridge_config: dict[str, Any] = {}
            if bridge_tools:
                proxy_args = [
                    str(Path(__file__).with_name("tool_bridge_mcp.py")),
                    "--proxy",
                    bridge_socket,
                ]
                # ACP SDK 1.8 rejects an untyped stdio entry, and claude-agent-acp
                # 0.89 does not hydrate type=stdio on the top-level list. An
                # entry there fails session/new before the bridge can start.
                # Claude Code options.mcpServers is the path that registers it.
                bridge_config = {
                    "hermes_bridge": {
                        "type": "stdio",
                        "command": sys.executable,
                        "args": proxy_args,
                    }
                }
            options = self._session_options(advertised_names)
            options["mcpServers"] = bridge_config
            session = request("session/new", {
                "cwd": self._cwd,
                "mcpServers": [],
                "_meta": {
                    "systemPrompt": {"type": "preset", "preset": "claude_code", "append": system},
                    "claudeCode": {
                        "options": options,
                    },
                },
            })
            session_id = str(session.get("sessionId") or "").strip()
            if not session_id:
                raise RuntimeError("Claude ACP did not return a sessionId")
            with self._lock:
                self._active_session_id = session_id

            if model:
                options = [
                    item for item in session.get("configOptions") or []
                    if isinstance(item, dict) and "model" in {item.get("category"), item.get("id")}
                ]
                if options:
                    offered = {
                        str(item.get("value"))
                        for item in options[0].get("options") or []
                        if isinstance(item, dict) and item.get("value") is not None
                    }
                    selected = select_offered_model(offered, model)
                    if selected is None:
                        raise ValueError(f"Claude ACP model '{model}' was not offered by the adapter")
                    config_id = str(options[0].get("id") or "model")
                    ack = request("session/set_config_option", {
                        "sessionId": session_id,
                        "configId": config_id,
                        "value": selected,
                    })
                    for item in ack.get("configOptions") or []:
                        if isinstance(item, dict) and item.get("id") == config_id:
                            if item.get("currentValue") != selected:
                                raise RuntimeError(
                                    f"Claude ACP did not apply the requested model '{selected}'"
                                    f" (adapter reports {item.get('currentValue')!r})"
                                )
                            break
                    else:
                        raise RuntimeError(
                            f"Claude ACP did not acknowledge the requested model '{selected}'"
                        )
                else:
                    request("session/set_model", {"sessionId": session_id, "modelId": model})

            prompt_active = True
            prompt_result = request("session/prompt", {
                "sessionId": session_id,
                "prompt": prompt,
            })
            prompt_active = False
            return "".join(output), "".join(reasoning), captured_calls, prompt_result
        finally:
            stopped.set()
            if proc is not None and prompt_active and not cancel_sent:
                with contextlib.suppress(Exception):
                    if session_id:
                        self._notify_cancel(proc, session_id)
                        with contextlib.suppress(subprocess.TimeoutExpired):
                            proc.wait(timeout=0.1)
            with self._lock:
                self._active_session_id = ""
            self.close()
            if bridge_proc is not None:
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.killpg(bridge_proc.pid, signal.SIGTERM)
                with contextlib.suppress(Exception):
                    bridge_proc.wait(timeout=1)
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.killpg(bridge_proc.pid, signal.SIGKILL)
                if bridge_proc.poll() is None:
                    with contextlib.suppress(Exception):
                        bridge_proc.wait(timeout=1)
            for thread in pumps:
                thread.join(timeout=0.2)
            for path in (schema_path, bridge_socket):
                if path:
                    with contextlib.suppress(OSError):
                        os.unlink(path)
            if bridge_dir:
                with contextlib.suppress(OSError):
                    os.rmdir(bridge_dir)
