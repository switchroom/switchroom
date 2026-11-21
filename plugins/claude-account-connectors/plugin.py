"""Experimental native connector tools. Native results, never model prose."""
from __future__ import annotations

import fnmatch
import importlib.util
import json
from pathlib import Path
import re
import sys
import threading
import time

_REF = re.compile(r'^mcp__claude_ai_[A-Za-z0-9_-]{1,128}__[A-Za-z0-9_-]{1,128}$')
_LIMIT = 1024 * 1024


def canonical(value):
    encoded = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False)
    if len(encoded) > _LIMIT:
        raise ValueError('connector input exceeds limit')
    return encoded


def _refs(result):
    output = result.get('rawOutput') if isinstance(result, dict) else None
    if not isinstance(output, list):
        return []
    return sorted({row['tool_name'] for row in output
                   if isinstance(row, dict) and row.get('type') == 'tool_reference'
                   and isinstance(row.get('tool_name'), str) and _REF.fullmatch(row['tool_name'])})


def _capture_cancel_event():
    # Capture host identity before ACP moves work onto its own thread. Never
    # accept cancellation authority from tool arguments or another session.
    from tools.interrupt import acting_for_tid, is_thread_interrupted
    tids = (threading.get_ident(), acting_for_tid.get())

    class HostCancelEvent(threading.Event):
        def is_set(self):
            return super().is_set() or any(is_thread_interrupted(tid) for tid in tids)

    return HostCancelEvent()


class NativeGate:
    """One invocation's state. Only trusted transport callbacks reach this object."""
    def __init__(self, tool, arguments, authorize):
        self.tool = tool
        self.arguments = canonical(arguments)
        self.authorize = authorize
        self.session = None
        self.approved = None
        self.pending = {}
        self.finished = set()
        self.output = None
        self.discovery = []
        self.lock = threading.Lock()

    def bind(self, session):
        if not isinstance(session, str) or not session:
            raise ValueError('missing session')
        if self.session is None:
            self.session = session
        if self.session != session:
            raise ValueError('wrong connector session')

    @staticmethod
    def name(event):
        return (event.get('_meta') or {}).get('claudeCode', {}).get('toolName')

    def on_permission(self, session, params):
        with self.lock:
            self.bind(session)
            if params.get('sessionId') != session:
                raise ValueError('permission session mismatch')
            event = params.get('toolCall') or {}
            name, call_id = self.name(event), event.get('toolCallId')
            options = params.get('options') or []
            reject = next((o for o in options if o.get('kind') == 'reject_once'), None)
            if reject is None:
                raise ValueError('missing reject option')
            deny = {'optionId': reject['optionId'], 'kind': 'reject_once'}
            meta = (event.get('_meta') or {}).get('claudeCode', {})
            provenance = meta.get('mcpServer') or {}
            pending = self.pending.get(call_id)
            if (self.approved is not None or not self.tool or name != self.tool
                    or not self.authorize(name) or provenance.get('source') != 'claudeai'
                    or meta.get('parentToolUseId') or not isinstance(event.get('rawInput'), dict)
                    or canonical(event['rawInput']) != self.arguments
                    or pending is None or pending[0] != name
                    or canonical(pending[1]) != self.arguments):
                return deny
            allow = next((o for o in options if o.get('kind') == 'allow_once'), None)
            if allow is None:
                return deny
            self.approved = call_id  # Consume before sending any approval.
            return {'optionId': allow['optionId'], 'kind': 'allow_once'}

    def on_tool_event(self, session, event):
        with self.lock:
            self.bind(session)
            name, call_id = self.name(event), event.get('toolCallId')
            if not isinstance(call_id, str) or not call_id or not isinstance(name, str):
                raise ValueError('missing native event identity')
            if call_id in self.finished:
                raise ValueError('duplicate terminal event')
            if event.get('sessionUpdate') == 'tool_call':
                if call_id in self.pending or not isinstance(event.get('rawInput'), dict):
                    raise ValueError('duplicate call or missing input')
                self.pending[call_id] = (name, json.loads(canonical(event['rawInput'])))
            else:
                if call_id not in self.pending or self.pending[call_id][0] != name:
                    raise ValueError('uncorrelated native event')
                if 'rawInput' in event:
                    if not isinstance(event['rawInput'], dict):
                        raise ValueError('invalid native input')
                    self.pending[call_id] = (name, json.loads(canonical(event['rawInput'])))
            if call_id == self.approved and canonical(self.pending[call_id][1]) != self.arguments:
                raise ValueError('approved arguments changed')
            status = event.get('status')
            if status not in {'completed', 'failed'}:
                return
            self.finished.add(call_id)
            if name == 'ToolSearch':
                if status == 'completed' and 'rawOutput' in event:
                    self.discovery.append({'rawOutput': event['rawOutput']})
            elif status == 'completed' and call_id != self.approved:
                raise ValueError('native execution without host approval')
            elif call_id == self.approved:
                if 'rawOutput' not in event:
                    raise ValueError('missing native result')
                self.output = {'status': status, 'tool': name, 'tool_call_id': call_id,
                               'rawOutput': event['rawOutput'], 'retry': False}

    def result(self):
        if self.output is not None:
            return self.output
        if self.approved is not None:
            return {'status': 'unknown_outcome', 'retry': False}
        if self.tool is None and self.discovery:
            refs = sorted({name for result in self.discovery for name in _refs(result) if self.authorize(name)})
            return {'status': 'completed', 'references': refs, 'schemas_exported': False, 'retry': False}
        return {'status': 'no_execution', 'retry': False}


def _load_acp():
    path = Path(__file__).resolve().parents[1] / 'model-providers/claude-acp/client.py'
    spec = importlib.util.spec_from_file_location('_fleet_connector_acp', path)
    if spec is None or spec.loader is None:
        raise RuntimeError('Claude ACP runtime unavailable')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NativeBackend:
    """Own-profile ACP transport, reused without changing the default provider."""
    def __init__(self, model='sonnet', timeout=90, *, acp=None):
        if model not in {'sonnet', 'haiku', 'opus', 'opus[1m]'}:
            raise ValueError('unsupported worker model')
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 1 <= timeout <= 180:
            raise ValueError('invalid worker deadline')
        self.acp = acp or _load_acp()
        self.model, self.timeout = model, timeout

    def authorized(self, name):
        if not isinstance(name, str) or not _REF.fullmatch(name):
            return False
        allow, deny = self.acp.connector_tool_policy()
        # Unknown policy syntax cannot confer authority. Native managed denies
        # still apply inside Claude Code; host grants never override them.
        if any('(' in rule or '?' in rule or '[' in rule for rule in allow + deny):
            return False
        if any(fnmatch.fnmatchcase(name, rule) for rule in deny):
            return False
        for rule in allow:
            pieces = rule.split('__')
            if len(pieces) != 3 or '*' in pieces[1]:
                continue
            if fnmatch.fnmatchcase(name, rule):
                return True
        return False

    def run(self, query=None, tool=None, arguments=None):
        if tool is not None and not self.authorized(tool):
            return {'status': 'denied', 'retry': False, 'reason': 'profile_policy'}
        gate = NativeGate(tool, arguments, self.authorized)
        base = self.acp.ClaudeACPClient
        class Worker(base):
            def _new_native_controller(self):
                return gate

            def _session_options(self, names):
                if names:
                    raise ValueError('connector worker must not advertise Hermes tools')
                options = super()._session_options(names)
                options['allowedTools'] = ['ToolSearch']
                options['settings'] = {'disableAllHooks': True, 'permissions': {
                    'ask': ['mcp__*'], 'defaultMode': 'default'}}
                options['env'] = {**options.get('env', {}), 'MCP_CONNECTION_NONBLOCKING': '0'}
                return options

            def _run(self, messages, bridge_tools, requirement, model, timeout, publish=None, prepared=None):
                policy = ('You are a native Claude Code connector worker. Use actual ToolSearch and native '
                          'account tools. No Hermes bridge exists here. Never fabricate tool calls or results. '
                          'The host independently approves operations; obey denials and do not retry.')
                return super()._run(messages, bridge_tools, requirement, model, timeout, publish,
                                    (policy, prepared[1]))
        client = Worker(acp_command='/usr/local/bin/hermes-claude-acp-subscription')
        payload = ({'search': query, 'instruction': 'Use ToolSearch only. Do not invoke connector operations.'}
                   if tool is None else {'tool': tool, 'arguments': arguments,
                   'instruction': 'Discover this exact tool with ToolSearch, then invoke it once with exactly these arguments. No other operation.'})
        started = time.monotonic()
        usage = None
        error = None
        try:
            cancel_event = _capture_cancel_event()
            response = client._create_sync(model=self.model,
                messages=[{'role': 'user', 'content': canonical(payload)}], tools=[], timeout=self.timeout,
                _cancel_event=cancel_event)
            raw_usage = response.usage
            usage = {key: getattr(raw_usage, key, None) for key in ('prompt_tokens', 'completion_tokens', 'total_tokens')}
        except Exception as exc:
            # Do not leak protocol payloads or credentials via exception messages.
            error = type(exc).__name__
        finally:
            client.close()
        result = gate.result()
        if error:
            # A transport/policy error invalidates any success collected earlier.
            result = {'status': 'unknown_outcome' if gate.approved is not None else 'no_execution',
                      'retry': False, 'error_type': error}
        result['worker'] = {'provider': 'claude-acp', 'model': self.model,
                            'elapsed_seconds': round(time.monotonic() - started, 3), 'usage': usage}
        return result


class ConnectorTools:
    def __init__(self, backend=None):
        self.backend = backend or NativeBackend()

    def claude_connector_search(self, query):
        if not isinstance(query, str) or not query.strip() or len(query) > 2000:
            return {'status': 'invalid_input', 'retry': False}
        return self.backend.run(query=query)

    def claude_connector_call(self, tool, arguments):
        if not isinstance(tool, str) or not _REF.fullmatch(tool) or not isinstance(arguments, dict):
            return {'status': 'invalid_input', 'retry': False}
        try:
            canonical(arguments)
        except (ValueError, TypeError, RecursionError):
            return {'status': 'invalid_input', 'retry': False}
        return self.backend.run(tool=tool, arguments=arguments)


def register(ctx):
    if ctx.get_config('enabled', False) is not True:
        return
    # Not 'model': Hermes reserves model/plugins/security/settings as roots for plugin-relative settings
    # keys, so ctx.get_config('model') raises ValueError and register() would never finish (HF-793).
    tools = ConnectorTools(NativeBackend(ctx.get_config('worker_model', 'sonnet'), ctx.get_config('timeout', 90)))
    def search(args, **kwargs):
        return json.dumps(tools.claude_connector_search((args or {}).get('query')))
    def call(args, **kwargs):
        args = args or {}
        return json.dumps(tools.claude_connector_call(args.get('tool'), args.get('arguments')))
    for name, handler, properties in [
        ('claude_connector_search', search, {'query': {'type': 'string', 'maxLength': 2000}}),
        ('claude_connector_call', call, {'tool': {'type': 'string'}, 'arguments': {'type': 'object'}}),
    ]:
        ctx.register_tool(name=name, toolset='claude_account_connectors',
            schema={'type': 'object', 'properties': properties, 'required': list(properties), 'additionalProperties': False},
            handler=handler)
